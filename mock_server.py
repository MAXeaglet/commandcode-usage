#!/usr/bin/env python3
"""Mock of the commandcode.ai /alpha endpoints for offline testing.

Serves different situations per path prefix:
  /ok            — full normal shape (whoami/credits/subscriptions/usage)
  /exhausted     — five-hour window exceeded
  /partial       — credits ok, subscriptions & usage fail (resilience path)
  /snake         — snake_case field variants
  /garbage       — HTML body (bad JSON path) on credits
  (any request without Authorization) — 401

Run: python3 mock_server.py [port]   (default 18090)
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

NOW_MS = int(time.time() * 1000)

WHOAMI = {
    "user": {"id": "u_123", "name": "Max", "userName": "maxeagle"},
    "org": {"id": "org_9"},
}

def credits(shape="ok"):
    if shape == "exhausted":
        five = {"used": 5.0, "cap": 5.0, "exceeded": True,
                "resetAt": NOW_MS + 42 * 60 * 1000}
        limited, exceeded = True, "fiveHour"
    elif shape == "snake":
        five = {"used": 1.2, "cap": 5.0, "exceeded": False,
                "reset_at": NOW_MS + 3600 * 1000}
        limited, exceeded = False, None
    else:
        five = {"used": 1.23, "cap": 5.0, "exceeded": False,
                "resetAt": NOW_MS + 3600 * 1000}
        limited, exceeded = False, None
    weekly = {"used": 12.5, "cap": 40.0, "exceeded": False,
              "resetAt": NOW_MS + 3 * 86400 * 1000}
    monthly, below = (0.5, True) if shape == "lowbal" else (18.5, False)
    return {
        "credits": {"monthlyCredits": monthly, "purchasedCredits": 0,
                    "freeCredits": 2.0, "planId": "individual-goat",
                    "belowThreshold": below, "creditThreshold": 1.0},
        "windowLimits": {"limited": limited, "exceeded": exceeded,
                         "fiveHour": five, "weekly": weekly},
    }


def subscriptions(shape="ok"):
    return {
        "success": True,
        "data": {
            "planId": "individual-goat",
            "status": "active",
            "currentPeriodStart": NOW_MS - 18 * 86400 * 1000,
            "currentPeriodEnd": NOW_MS + 12 * 86400 * 1000,
            "cancelAtPeriodEnd": shape == "cancel",
            "pendingPhase": None,
        },
    }


USAGE = {
    "totalCount": 1883, "totalCost": 6.0011675234,
    "averageCost": 0.0031870247070631963, "successRate": 100,
    "completedCount": 1883, "failedCount": 0,
    "totalTokensIn": 487_592_979, "totalTokensOut": 1_210_434,
    "totalTokens": 488_803_413,
    "totalCredits": 6.001167523399999, "totalFreeCredits": 0,
    "totalMonthlyCredits": 6.001167523399999, "totalPurchasedCredits": 0,
    "periodBasis": "billing-period",
}


# 密钥里带 shape 名即选中该形态（方便联调）：sk-exhausted-… / sk-snake-… 等
def shape_for_key(auth):
    key = auth or ""
    for s in ("exhausted", "partial", "snake", "garbage", "badkey", "cancel", "lowbal"):
        if s in key.lower():
            return s
    return "ok"


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if not self.headers.get("Authorization"):
            self._send(401, {"error": "unauthorized"})
            return
        shape = "badkey" if "badkey" in (self.headers.get("Authorization") or "").lower() \
            else shape_for_key(self.headers.get("Authorization"))
        path = self.path.split("?")[0]

        if path == "/alpha/whoami":
            if shape == "badkey":
                self._send(401, {"error": "unauthorized"})
                return
            self._send(200, WHOAMI)
        elif path == "/alpha/billing/credits":
            if shape == "garbage":
                body = b"<html>login page</html>"
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._send(200, credits(shape))
        elif path == "/alpha/billing/subscriptions":
            if shape == "partial":
                self._send(500, {"error": "internal"})
                return
            self._send(200, subscriptions(shape))
        elif path == "/alpha/usage/summary":
            if shape == "partial":
                self._send(500, {"error": "internal"})
                return
            self._send(200, USAGE)
        else:
            self._send(404, {"error": "not found"})

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18090
    print(f"mock listening on 127.0.0.1:{port} "
          f"(shape by key: sk-exhausted-… / sk-partial-… / sk-snake-… / sk-garbage-… / "
          f"sk-badkey-… / sk-cancel-… / sk-lowbal-… / 其他=正常)", flush=True)
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
