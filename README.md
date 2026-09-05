# commandcode-usage

**Multi-account quota dashboard for Command Code** ([commandcode.ai](https://commandcode.ai)), fully deployed on Cloudflare (Worker + D1).
A card matrix shows each account's **5-hour rolling / weekly / monthly** quota progress bars, credit balances and billing-period usage stats, with single & refresh-all, behind a login gate.

English | [简体中文](README.zh-CN.md)

> Data comes from the undocumented `/alpha/*` endpoints of `api.commandcode.ai`. The parsing layer defensively tolerates field drift.

## Features

- **Multi-account card matrix**: keys are validated upstream before being stored, custom labels (auto-fill from username if empty), single & refresh-all, duplicate keys rejected
- **Three progress bars**:
  - 5-hour rolling & weekly windows — raw server data (used/cap/exceeded/resetAt)
  - Monthly quota — **derived**: cap from the plan mapping, used = cap − remaining, reset = billing period end; labeled "cap estimated from plan", falls back to balance-only for unknown plans
- **Credit balances**: monthly remaining / purchased / free
- **Details drawer** (per-card "Details" button): billing-period totals — requests, success rate, success/fail, tokens in/out, credits spent, average cost, period basis
- **Alert badges**: currently blocked by a window (authoritative `windowLimits.exceeded` field), balance below threshold, subscription cancels at period end, pending plan change
- **Login gate** (optional): admin password, constant-time comparison, session kept in sessionStorage and cleared on tab close
- **Color grading**: yellow at ≥50% used, yellow at ≥75%, red at ≥90%, otherwise green

## Quick Start

### One-command deploy (Cloudflare Worker + D1)

```bash
git clone https://github.com/MAXeaglet/commandcode-usage && cd commandcode-usage
./deploy.sh        # creates D1, backfills database_id, deploys
```

Or manually:

```bash
npx wrangler login
npx wrangler d1 create commandcode-usage   # paste the output database_id into wrangler.toml
npx wrangler deploy
```

The deployed `https://xxx.workers.dev` is the complete dashboard.
If `workers.dev` is unreachable in your region (DNS pollution), uncomment the `routes` section in `wrangler.toml`, bind a custom domain, and deploy again.

### (Recommended) Set an admin password

No password = anyone with the link can see your accounts. Set one and the page becomes a login gate:

```bash
npx wrangler secret put ADMIN_TOKEN
```

- The password lives only as a Worker secret (never in code, never in git)
- After login the password is kept in browser sessionStorage and cleared when the tab closes; "Logout" in the top-right
- Every `/api/*` route is checked server-side with constant-time comparison (timing-attack resistant)

### Let an AI agent deploy it for you

Paste the following into any terminal-capable AI agent (Claude Code, Codex, etc.):

```text
Please deploy commandcode-usage (a multi-account quota dashboard for Command Code, full stack on Cloudflare Worker + D1):

1. Clone https://github.com/MAXeaglet/commandcode-usage and cd into it
2. Run npx wrangler login to authorize with Cloudflare (a browser window opens; I will confirm with my Cloudflare account)
3. Run ./deploy.sh — it automatically creates the D1 database `commandcode-usage`, writes the database_id back into wrangler.toml, and deploys the Worker and the page
4. Ask me for an admin password (I will choose it myself; do not generate one for me), then run echo "the password I gave" | npx wrangler secret put ADMIN_TOKEN
5. When done, give me the workers.dev URL and explain: the first visit shows a login gate; enter the password to reach the dashboard and add Command Code accounts

Error handling:
- If ./deploy.sh fails because `wrangler d1 create` reports a name conflict, find the existing database's uuid via `npx wrangler d1 list`,
  put it into the database_id field of wrangler.toml manually, and run ./deploy.sh again
- If the workers.dev URL is unreachable in my region (DNS pollution), bind a custom domain per the commented `routes` section
  in wrangler.toml and redeploy
- Do not modify any source files beyond the wrangler commands above
```

### Local development

```bash
python3 mock_server.py 18090 &      # optional: offline upstream mock
npx wrangler dev                    # http://127.0.0.1:8787
```

`.dev.vars` (local env vars, gitignored) supports two keys:
leave `API_BASE` unset to hit the real upstream; point it at `http://127.0.0.1:18090` to use the local mock.
Set `ADMIN_TOKEN` to enable the login gate in local dev too. See `.dev.vars.example`.

## How It Works

Four upstream endpoints (all GET + `Authorization: Bearer <key>`):

| Endpoint | Data | Used for |
|----------|------|----------|
| `/alpha/whoami` | account identity, orgId | auto label, subscription query param |
| `/alpha/billing/credits` | monthly remaining / purchased / free credits + `windowLimits.fiveHour` / `.weekly` (used/cap/exceeded/resetAt) + `limited`/`exceeded`/`belowThreshold` | three progress bars, balances, alert badges |
| `/alpha/billing/subscriptions` | planId, status, billing period, cancelAtPeriodEnd, pendingPhase (`?orgId=` from whoami) | plan badge, monthly derivation, period countdown |
| `/alpha/usage/summary` | billing-period totals: requests, success rate, tokens in/out, credits spent, average cost, periodBasis | details drawer |

- **Multi-account**: accounts live in the D1 `accounts` table (api_key + label + cached usage + last error + a `detail` JSON column). Keys are validated upstream before insert; duplicates rejected. Schema changes are migrated at runtime by `ALTER TABLE` in the Worker.
- Keys are stored in plaintext in **your own** D1 (the price of a multi-account dashboard); they are only forwarded to commandcode.ai and to nobody else. Every API response masks them (`sk-…xxxx`).
- A rejected key (401/403) short-circuits at whoami — the remaining endpoints are not hit. A failed refresh keeps the previous cache and records `lastError`.
- **The monthly bar is derived**: the API has no monthly window object, so the cap comes from the plan mapping below (`used = cap − monthlyCredits`, reset = `currentPeriodEnd`). The UI labels it "cap estimated from plan".
- **Plan mapping** (reverse-engineered from the official CLI by the community, not officially documented; the monthly bar hides for unknown plans):

  | planId | Plan | Monthly credits |
  |--------|------|-----------------|
  | `individual-go` | Go | 10 |
  | `individual-goat` | GOAT | 70 |
  | `individual-pro` | Pro | 30 |
  | `individual-pro-v1` | Pro | 80 |
  | `individual-provider` | Provider | 15 |
  | `individual-max` | Max | 150 |
  | `individual-ultra` | Ultra | 300 |
  | `teams-pro` | Teams Pro | 40 |

- **Known limitation**: the API exposes no per-request logs (`/alpha/usage/{requests,logs,history,events,…}` all 404; `usage/summary` is aggregate-only and ignores query parameters), so the dashboard can only show billing-period aggregates.
- `windowLimits.limited` is a static "this account is subject to window limits" flag, not "currently blocked"; blocked state is read only from `windowLimits.exceeded`.
- Timestamps accept epoch ms/seconds and ISO strings; window fields accept camelCase/snake_case.
- "Refresh all" is bounded by the Worker subrequest limit (50 on the free plan, 4 upstream calls per account): beyond 12 accounts only the first 12 are refreshed and the page says so.

## API

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/login` | `{ password }` verifies the admin password (always passes when `ADMIN_TOKEN` is unset) |
| GET | `/api/accounts` | list accounts (masked keys, cached usage, detail) |
| POST | `/api/accounts` | `{ key, label? }` add an account (validated before insert) |
| PATCH | `/api/accounts/:id` | `{ label }` rename |
| DELETE | `/api/accounts/:id` | remove an account |
| POST | `/api/refresh` | `{ id? }` refresh one (with id) or all (without) |

With `ADMIN_TOKEN` set, everything except `/api/login` requires the `X-Admin-Token` header.

## Files

| File | Description |
|------|-------------|
| `public/index.html` | dashboard page (dependency-free single file: card matrix + three progress bars + details drawer + badges) |
| `worker.js` | Worker: account CRUD, upstream aggregation & defensive normalization, D1 access with runtime migration |
| `wrangler.toml` | Worker + static assets + D1 binding |
| `deploy.sh` | one-command deploy (create DB, backfill id, deploy; portable) |
| `mock_server.py` | offline upstream mock (shape picked by key: ok / exhausted / partial / snake_case / low-balance / cancel / garbage / 401) |

## Community

Shared & discussed on [LINUX DO](https://linux.do) — come say hi. 🙌

## License

MIT
