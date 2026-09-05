// commandcode-usage — Cloudflare Worker（页面由 public/ 静态托管，本文件处理 /api/*）
//
// 多账号额度面板：账号存 D1（api_key + 备注 + 缓存的用量数据），
// 页面列出所有账号，可单个/全部刷新，无需每次粘贴密钥。
//
// 端点（若设置了 secret ADMIN_TOKEN，均需带 x-admin-token 头）：
//   GET    /api/accounts        → 账号列表（密钥打码，含缓存用量）
//   POST   /api/accounts        { key, label? }   → 添加账号（先验证再入库）
//   PATCH  /api/accounts/:id    { label }         → 改备注
//   DELETE /api/accounts/:id                       → 删除账号
//   POST   /api/refresh         { id? }           → 刷新一个（id）或全部账号
//   POST   /api/login           { password }      → 校验管理密码（ADMIN_TOKEN）
//
// 上游（均为 GET + Bearer，未公开文档，字段已防御性兼容）：
//   /alpha/whoami                → { user:{id,name,userName}, org?:{id} }
//   /alpha/billing/credits       → { credits:{monthlyCredits,purchasedCredits,freeCredits,planId?},
//                                    windowLimits:{fiveHour:{used,cap,exceeded,resetAt}, weekly:{…}} }
//   /alpha/billing/subscriptions[?orgId=…] → { data:{planId,status,currentPeriodEnd} }
//   /alpha/usage/summary         → 计数汇总（不入库，仅校验用）
//
// 密钥明文存在你自己的 D1 里（这是多账号面板的代价与前提），
// 除了转发给 commandcode.ai 不发给任何第三方；接口返回一律打码。
// 开发时可用环境变量 API_BASE 指向本地 mock（.dev.vars）。

// 已知套餐的月度信用额（来自社区 CLI 的 planId 映射；未知套餐返回 null）
const KNOWN_PLANS = {
  'individual-go':       { name: 'Go',         monthlyCredits: 10 },
  'individual-goat':     { name: 'GOAT',       monthlyCredits: 70 },
  'individual-pro':      { name: 'Pro',        monthlyCredits: 30 },
  'individual-pro-v1':   { name: 'Pro',        monthlyCredits: 80 },
  'individual-provider': { name: 'Provider',   monthlyCredits: 15 },
  'individual-max':      { name: 'Max',        monthlyCredits: 150 },
  'individual-ultra':    { name: 'Ultra',      monthlyCredits: 300 },
  'teams-pro':           { name: 'Teams Pro',  monthlyCredits: 40 },
};

// 最长前缀优先：individual-pro-v1 应胜过 individual-pro
const PLAN_PREFIXES = Object.keys(KNOWN_PLANS).sort((a, b) => b.length - a.length);

function planInfo(planId) {
  if (!planId) return undefined;
  const norm = String(planId).toLowerCase().replace(/_/g, '-');
  const prefix = PLAN_PREFIXES.find(p => norm.startsWith(p));
  return prefix ? KNOWN_PLANS[prefix] : undefined;
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: JSON_HEADERS });
}

function isRecord(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function str(v) { return typeof v === 'string' ? v : null; }

// 毫秒时间戳兼容：数字（epoch ms 或秒）或 ISO 字符串
function toEpochMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v < 1e12 ? v * 1000 : v; // 秒级时间戳（10 位）转毫秒
  }
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

async function getJson(base, path, key) {
  const resp = await fetch(base + path, {
    headers: {
      'Authorization': 'Bearer ' + key,
      'Accept': 'application/json',
      'User-Agent': 'commandcode-usage/1.0',
    },
  });
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error('HTTP ' + resp.status);
    err.status = resp.status;
    err.body = text.slice(0, 300);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = new Error('non-JSON response');
    err.status = 502;
    err.body = text.slice(0, 200);
    throw err;
  }
}

// 窗口对象防御性归一：windowLimits.fiveHour 也可能叫 five_hour / rolling5h 等
function pickWindow(wl, names) {
  for (const n of names) {
    if (isRecord(wl[n])) return wl[n];
  }
  return undefined;
}

function normalizeWindow(raw) {
  if (!isRecord(raw)) return undefined;
  const used = num(raw.used) ?? num(raw.usage) ?? num(raw.usedCredits) ?? num(raw.used_credits);
  const cap = num(raw.cap) ?? num(raw.limit) ?? num(raw.capCredits);
  const exceeded = raw.exceeded === true || raw.exceeded === 'true' ||
    (used != null && cap != null && cap > 0 && used >= cap);
  return {
    used: used ?? 0,
    cap: cap ?? 0,
    exceeded,
    resetAt: toEpochMs(raw.resetAt ?? raw.reset_at ?? raw.resetsAt) ?? 0,
  };
}

async function fetchReport(base, key) {
  const failures = [];
  const report = {};

  // 1. whoami → 账户身份（+ orgId 供订阅端点）
  let orgId;
  try {
    const who = await getJson(base, '/alpha/whoami', key);
    const user = isRecord(who.user) ? who.user : (isRecord(who.data) && isRecord(who.data.user) ? who.data.user : undefined);
    if (user) {
      report.account = {
        id: str(user.id) ?? '',
        name: str(user.name) ?? '',
        userName: str(user.userName) ?? str(user.username) ?? '',
      };
    }
    const org = isRecord(who.org) ? who.org : undefined;
    orgId = org ? str(org.id) : undefined;
  } catch (e) {
    // 401/403 在 whoami 就暴露 = 密钥无效，无需继续打其余端点
    if (e.status === 401 || e.status === 403) {
      const err = new Error('密钥被拒（HTTP ' + e.status + '）——请确认密钥有效，从 commandcode.ai/settings 获取。');
      err.status = e.status;
      throw err;
    }
    failures.push('whoami: ' + e.message);
  }

  // 2. billing/credits → 余额 + 5h/周窗口（面板的核心数据）
  try {
    const cr = await getJson(base, '/alpha/billing/credits', key);
    const credits = isRecord(cr.credits) ? cr.credits :
      (isRecord(cr.data) && isRecord(cr.data.credits) ? cr.data.credits : undefined);
    const wl = isRecord(cr.windowLimits) ? cr.windowLimits :
      (isRecord(cr.data) && isRecord(cr.data.windowLimits) ? cr.data.windowLimits : undefined);

    if (credits || wl) {
      report.credits = {
        monthlyCredits: num(credits?.monthlyCredits) ?? num(credits?.monthly_credits) ?? null,
        purchasedCredits: num(credits?.purchasedCredits) ?? num(credits?.purchased_credits) ?? null,
        freeCredits: num(credits?.freeCredits) ?? num(credits?.free_credits) ?? null,
        // 账号整体限流状态：exceeded 直接指出是哪个窗口在拦（"fiveHour"/"weekly"）
        limited: wl?.limited === true,
        exceeded: str(wl?.exceeded) ?? '',
        belowThreshold: credits?.belowThreshold === true,
        creditThreshold: num(credits?.creditThreshold) ?? null,
        fiveHour: normalizeWindow(pickWindow(wl || {}, ['fiveHour', 'five_hour', 'rolling5h', '5h'])),
        weekly: normalizeWindow(pickWindow(wl || {}, ['weekly', 'week'])),
      };
      // credits 响应可能带 planId，作订阅端点失败时的兜底
      if (credits) report._planIdFallback = str(credits.planId) ?? str(credits.plan_id);
    }
  } catch (e) {
    failures.push('billing/credits: ' + e.message);
  }

  // 3. billing/subscriptions → 套餐与账期
  try {
    const sub = await getJson(base, orgId
      ? '/alpha/billing/subscriptions?orgId=' + encodeURIComponent(orgId)
      : '/alpha/billing/subscriptions', key);
    const data = isRecord(sub.data) ? sub.data : (isRecord(sub.subscription) ? sub.subscription : undefined);
    const planId = str(data?.planId) ?? str(data?.plan_id) ?? report._planIdFallback;
    if (data || planId) {
      const info = planInfo(planId);
      report.plan = {
        planId: planId ?? '',
        name: info?.name ?? planId ?? '',
        status: str(data?.status) ?? '',
        monthlyCredits: info ? info.monthlyCredits : null,
        currentPeriodEnd: toEpochMs(data?.currentPeriodEnd ?? data?.current_period_end) ?? 0,
        cancelAtPeriodEnd: data?.cancelAtPeriodEnd === true,
        currentPeriodStart: toEpochMs(data?.currentPeriodStart ?? data?.current_period_start) ?? 0,
        pendingPhase: data?.pendingPhase ?? null,
      };
    }
  } catch (e) {
    const planId = report._planIdFallback;
    if (planId) {
      const info = planInfo(planId);
      report.plan = {
        planId, name: info?.name ?? planId, status: '',
        monthlyCredits: info ? info.monthlyCredits : null, currentPeriodEnd: 0,
        cancelAtPeriodEnd: false, currentPeriodStart: 0, pendingPhase: null,
      };
    }
    failures.push('billing/subscriptions: ' + e.message);
  }
  delete report._planIdFallback;

  // usage/summary → 累计统计（按 periodBasis 口径，通常是账期内）
  try {
    const us = await getJson(base, '/alpha/usage/summary', key);
    const u = isRecord(us.data) ? us.data : us;
    if (isRecord(u)) {
      report.usage = {
        totalCount: num(u.totalCount) ?? 0,
        totalCost: num(u.totalCost) ?? 0,
        averageCost: num(u.averageCost) ?? null,
        successRate: num(u.successRate) ?? 0,
        completedCount: num(u.completedCount) ?? 0,
        failedCount: num(u.failedCount) ?? 0,
        totalTokensIn: num(u.totalTokensIn) ?? 0,
        totalTokensOut: num(u.totalTokensOut) ?? 0,
        totalCredits: num(u.totalCredits) ?? 0,
        periodBasis: str(u.periodBasis) ?? '',
      };
    }
  } catch (e) {
    failures.push('usage/summary: ' + e.message);
  }

  if (failures.length) report.failures = failures;

  // 一个数据端点都没有成功 = 整体失败
  if (!report.account && !report.credits && !report.plan) {
    const err = new Error('所有 commandcode.ai 端点均无法访问：' + failures.join('; '));
    err.status = 502;
    throw err;
  }
  return report;
}

// ---- D1 账号表 ----

const SCHEMA = `CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  user_name TEXT NOT NULL DEFAULT '',
  plan_id TEXT NOT NULL DEFAULT '',
  plan_name TEXT NOT NULL DEFAULT '',
  monthly_left REAL,
  purchased REAL,
  free REAL,
  five_hour_used REAL,
  five_hour_cap REAL,
  five_hour_exceeded INTEGER NOT NULL DEFAULT 0,
  five_hour_reset INTEGER NOT NULL DEFAULT 0,
  weekly_used REAL,
  weekly_cap REAL,
  weekly_exceeded INTEGER NOT NULL DEFAULT 0,
  weekly_reset INTEGER NOT NULL DEFAULT 0,
  last_checked INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  detail TEXT
)`;

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(SCHEMA),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_accounts_key ON accounts(api_key)'),
  ]);
  // 老库迁移：detail 列存扩展统计 JSON（usage 汇总 / 限流 / 预警 / 订阅附加字段）
  try {
    await db.prepare('ALTER TABLE accounts ADD COLUMN detail TEXT').run();
  } catch (e) { /* 列已存在 */ }
  schemaReady = true;
}

// 从聚合报告提取长尾字段，序列化进 detail 列
function buildDetail(report) {
  const c = report.credits || {};
  const p = report.plan || {};
  return JSON.stringify({
    usage: report.usage || null,
    limited: c.limited ?? null,
    exceeded: c.exceeded || null,
    belowThreshold: c.belowThreshold ?? null,
    creditThreshold: c.creditThreshold ?? null,
    cancelAtPeriodEnd: p.cancelAtPeriodEnd ?? null,
    currentPeriodStart: p.currentPeriodStart ?? null,
    pendingPhase: p.pendingPhase ?? null,
  });
}

function parseDetail(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function maskKey(key) {
  if (!key) return '';
  return key.length <= 8 ? key.slice(0, 2) + '…' : key.slice(0, 3) + '…' + key.slice(-4);
}

// 数据库行 → 面板 JSON（去掉明文密钥）
function toAccount(row) {
  return {
    id: row.id,
    label: row.label || '',
    maskedKey: maskKey(row.api_key),
    userName: row.user_name || '',
    plan: row.plan_id || row.plan_name ? {
      planId: row.plan_id,
      name: row.plan_name || row.plan_id,
      monthlyCredits: null, // 月度总额度只取决于套餐，展示层不再需要
    } : null,
    credits: {
      monthlyCredits: row.monthly_left,
      purchasedCredits: row.purchased,
      freeCredits: row.free,
      fiveHour: row.five_hour_cap != null ? {
        used: row.five_hour_used, cap: row.five_hour_cap,
        exceeded: !!row.five_hour_exceeded, resetAt: row.five_hour_reset,
      } : null,
      weekly: row.weekly_cap != null ? {
        used: row.weekly_used, cap: row.weekly_cap,
        exceeded: !!row.weekly_exceeded, resetAt: row.weekly_reset,
      } : null,
    },
    lastChecked: row.last_checked || 0,
    lastError: row.last_error || '',
    detail: parseDetail(row.detail),
  };
}

// 拉取上游并回写一行的缓存字段
async function refreshAccount(db, base, row) {
  let upd, error = '';
  try {
    upd = await fetchReport(base, row.api_key);
  } catch (e) {
    // 密钥失效等：保留旧缓存，记录错误
    error = e.message || String(e);
    await db.prepare('UPDATE accounts SET last_error = ?, last_checked = ? WHERE id = ?')
      .bind(error, Date.now(), row.id).run();
    const fresh = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(row.id).first();
    return toAccount(fresh);
  }
  const c = upd.credits || {};
  const fh = c.fiveHour || {}, wk = c.weekly || {};
  await db.prepare(
    `UPDATE accounts SET
       user_name = ?, plan_id = ?, plan_name = ?,
       monthly_left = ?, purchased = ?, free = ?,
       five_hour_used = ?, five_hour_cap = ?, five_hour_exceeded = ?, five_hour_reset = ?,
       weekly_used = ?, weekly_cap = ?, weekly_exceeded = ?, weekly_reset = ?,
       last_checked = ?, last_error = '', detail = ?
     WHERE id = ?`
  ).bind(
    upd.account?.userName || row.user_name,
    upd.plan?.planId || '', upd.plan?.name || '',
    c.monthlyCredits ?? null, c.purchasedCredits ?? null, c.freeCredits ?? null,
    fh.used ?? null, fh.cap ?? null, fh.exceeded ? 1 : 0, fh.resetAt ?? 0,
    wk.used ?? null, wk.cap ?? null, wk.exceeded ? 1 : 0, wk.resetAt ?? 0,
    Date.now(), buildDetail(upd), row.id,
  ).run();
  const fresh = await db.prepare('SELECT * FROM accounts WHERE id = ?').bind(row.id).first();
  return toAccount(fresh);
}

// ---- 路由 ----

function adminOk(env, request) {
  if (!env.ADMIN_TOKEN) return true; // 未设置令牌 = 公开面板
  return safeEqual(request.headers.get('x-admin-token') || '', env.ADMIN_TOKEN);
}

// 常数时间比较，避免时序侧信道逐位猜密码
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readBody(request) {
  try { return await request.json(); } catch (e) { return {}; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const base = env.API_BASE || 'https://api.commandcode.ai';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: JSON_HEADERS });
    }

    // POST /api/login  { password }  → 校验管理密码
    if (path === '/api/login' && request.method === 'POST') {
      if (!env.ADMIN_TOKEN) return json({ ok: true }); // 未设密码 = 面板公开
      const body = await readBody(request);
      const password = String(body.password || '');
      if (safeEqual(password, env.ADMIN_TOKEN)) return json({ ok: true });
      return json({ error: '密码不对' }, 401);
    }

    if (path.startsWith('/api/')) {
      if (!adminOk(env, request)) {
        return json({ error: 'admin-required', message: '需要访问令牌' }, 401);
      }
      if (!env.DB) return json({ error: 'D1 未绑定：请先运行 ./deploy.sh 或按 README 配置 wrangler.toml' }, 500);
      await ensureSchema(env.DB);
    } else if (path !== '/favicon.ico') {
      // 静态资源由 wrangler assets 接管；其余未知路径 404
      return new Response('Not Found', { status: 404 });
    }

    // GET /api/accounts
    if (path === '/api/accounts' && request.method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM accounts ORDER BY id ASC').all();
      return json({ accounts: (results || []).map(toAccount) });
    }

    // POST /api/accounts  { key, label? }
    if (path === '/api/accounts' && request.method === 'POST') {
      const body = await readBody(request);
      const key = String(body.key || '').trim();
      const label = String(body.label || '').trim().slice(0, 60);
      if (!key) return json({ error: 'missing key' }, 400);
      // HTTP 头仅接受 ASCII；含中文/全角的输入直接拒绝并提示
      if (!/^[\x21-\x7e]+$/.test(key)) {
        return json({ error: '密钥格式不对：检测到中文或全角字符。密钥应是纯 ASCII 字符串，请重新复制粘贴。' }, 400);
      }
      const dup = await env.DB.prepare('SELECT * FROM accounts WHERE api_key = ?').bind(key).first();
      if (dup) return json({ error: '该密钥已存在（' + (dup.label || maskKey(key)) + '）', account: toAccount(dup) }, 409);

      // 先验证再入库：无效密钥直接 400
      let report;
      try {
        report = await fetchReport(base, key);
      } catch (e) {
        return json({ error: e.message || '验证失败' }, e.status === 401 || e.status === 403 ? 400 : 502);
      }
      const c = report.credits || {};
      const fh = c.fiveHour || {}, wk = c.weekly || {};
      const finalLabel = label || report.account?.userName || maskKey(key);
      await env.DB.prepare(
        `INSERT INTO accounts
         (api_key, label, user_name, plan_id, plan_name, monthly_left, purchased, free,
          five_hour_used, five_hour_cap, five_hour_exceeded, five_hour_reset,
          weekly_used, weekly_cap, weekly_exceeded, weekly_reset, last_checked, created_at, detail)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        key, finalLabel, report.account?.userName || '',
        report.plan?.planId || '', report.plan?.name || '',
        c.monthlyCredits ?? null, c.purchasedCredits ?? null, c.freeCredits ?? null,
        fh.used ?? null, fh.cap ?? null, fh.exceeded ? 1 : 0, fh.resetAt ?? 0,
        wk.used ?? null, wk.cap ?? null, wk.exceeded ? 1 : 0, wk.resetAt ?? 0,
        Date.now(), Date.now(), buildDetail(report),
      ).run();
      const row = await env.DB.prepare('SELECT * FROM accounts WHERE api_key = ?').bind(key).first();
      return json({ account: toAccount(row) }, 201);
    }

    // PATCH /api/accounts/:id  { label }
    let m = path.match(/^\/api\/accounts\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
      if (!row) return json({ error: '账号不存在' }, 404);

      if (request.method === 'PATCH') {
        const body = await readBody(request);
        const label = String(body.label || '').trim().slice(0, 60);
        if (!label) return json({ error: 'label 不能为空' }, 400);
        await env.DB.prepare('UPDATE accounts SET label = ? WHERE id = ?').bind(label, id).run();
        const fresh = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first();
        return json({ account: toAccount(fresh) });
      }

      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
        return json({ ok: true });
      }

      return json({ error: 'method not allowed' }, 405);
    }

    // POST /api/refresh  { id? }  —— 刷新一个或全部
    if (path === '/api/refresh' && request.method === 'POST') {
      const body = await readBody(request);
      if (body.id != null) {
        const row = await env.DB.prepare('SELECT * FROM accounts WHERE id = ?').bind(Number(body.id)).first();
        if (!row) return json({ error: '账号不存在' }, 404);
        return json({ accounts: [await refreshAccount(env.DB, base, row)] });
      }
      const { results } = await env.DB.prepare('SELECT * FROM accounts ORDER BY id ASC').all();
      const rows = results || [];
      // Worker 每请求子请求数有上限（免费版 50），每账号 4 个上游调用 → 最多并发 12 个
      const batch = rows.slice(0, 12);
      const accounts = await Promise.all(batch.map(r => refreshAccount(env.DB, base, r)));
      return json({ accounts, skipped: rows.length - batch.length });
    }

    // favicon：空白 204，省一个静态文件（浏览器标签页图标）
    if (path === '/favicon.ico') return new Response(null, { status: 204, headers: JSON_HEADERS });

    return json({ error: 'not found' }, 404);
  },
};
