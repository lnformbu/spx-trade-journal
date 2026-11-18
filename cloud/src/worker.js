/*
 * Trade journal — Cloudflare Worker version of server.js.
 * Same API as the local server, so index.html works unchanged:
 *   GET/POST /api/data    trades + start date (was trades.json)
 *   GET/POST /api/quotes  daily verses       (was quotes.txt)
 *   POST /api/import-schwab   Schwab History CSV -> new trades (?dry=1 = preview only)
 *   GET  /schwab/login, /schwab/callback   connect your Schwab account (Schwab Trader API, OAuth)
 *   GET  /api/schwab/status, POST /api/schwab/sync, POST /api/schwab/disconnect
 * Everything else is the static page from public/.
 *
 * The whole site is behind a password (Worker secret JOURNAL_PASSWORD).
 * If no password is set, the site refuses to open rather than going public.
 *
 * Schwab sync needs the secrets SCHWAB_APP_KEY and SCHWAB_APP_SECRET (npm run schwab:keys).
 * You log in on Schwab's own page; only the tokens Schwab hands back are stored (D1 key "schwab").
 * Schwab expires that login after 7 days, so the page asks you to reconnect once a week.
 */

// "../src/" resolves both from src/worker.js and from the deployed public/_worker.js
import { schwabToTrades, mergeImported, apiToFills, pairFills } from "../src/schwab.js";

const CHUNK = 90000; // D1 caps one SQL statement at 100 KB

// ---- storage helpers ----
async function readBlob(env, key) {
  const { results } = await env.DB.prepare("SELECT value FROM blobs WHERE key = ? ORDER BY part").bind(key).all();
  return results.length ? results.map((r) => r.value).join("") : null;
}
async function writeBlob(env, key, text) {
  // delete + insert in one batch, so a failed save never leaves half a file
  const stmts = [env.DB.prepare("DELETE FROM blobs WHERE key = ?").bind(key)];
  for (let i = 0, part = 0; i < text.length || part === 0; i += CHUNK, part++) {
    stmts.push(env.DB.prepare("INSERT INTO blobs (key, part, value) VALUES (?, ?, ?)").bind(key, part, text.slice(i, i + CHUNK)));
  }
  await env.DB.batch(stmts);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
async function readData(env) {
  try {
    const d = JSON.parse((await readBlob(env, "data")) || "{}");
    if (!d.trades) d.trades = [];
    if (!d.start) d.start = todayISO();
    if (!d.rev) d.rev = 0;
    return d;
  } catch (e) {
    return { start: todayISO(), trades: [] };
  }
}
const quoteLines = (text) =>
  String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

// ---- password (HTTP Basic auth; the browser asks once and remembers) ----
function authorized(req, env) {
  const header = req.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  let pass = "";
  try { pass = atob(header.slice(6)).split(":").slice(1).join(":"); } catch (e) { return false; }
  const want = env.JOURNAL_PASSWORD;
  if (pass.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= pass.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

// The bot's chart pictures (bot/src/shot.js): its headless browser sends a random one-minute pass the bot wrote to the shared
// database. Read-only (GET) requests only; the pass is cleared as soon as the picture is taken.
async function shotPass(req, env) {
  const k = req.headers.get("x-shot-key");
  if (!k || k.length < 32 || req.method !== "GET") return false;
  try {
    const p = JSON.parse((await readBlob(env, "shot:pass")) || "null");
    if (!p || !p.tok || !(p.exp > Date.now()) || p.tok.length !== k.length) return false;
    let diff = 0;
    for (let i = 0; i < k.length; i++) diff |= k.charCodeAt(i) ^ p.tok.charCodeAt(i);
    return diff === 0;
  } catch (e) { return false; }
}

// Adds trades not already in the journal; re-reads just before writing so a
// concurrent save or sync isn't overwritten.
async function addTrades(env, trades, dry) {
  let d = await readData(env);
  let { added, duplicates } = mergeImported(d.trades, trades);
  if (!dry && added.length) {
    d = await readData(env);
    ({ added, duplicates } = mergeImported(d.trades, trades));
    if (added.length) {
      d.trades = d.trades.concat(added);
      d.rev = (d.rev || 0) + 1;
      await writeBlob(env, "data", JSON.stringify(d));
    }
  }
  return { added, duplicates };
}

// ---- Schwab Trader API ----
const SCHWAB = "https://api.schwabapi.com";
const DAY = 864e5;
const LOGIN_DAYS = 7; // Schwab refresh tokens last 7 days

const schwabReady = (env) => !!(env.SCHWAB_APP_KEY && env.SCHWAB_APP_SECRET);
async function schwabState(env) {
  try { return JSON.parse((await readBlob(env, "schwab")) || "{}"); } catch (e) { return {}; }
}
const saveSchwab = (env, s) => writeBlob(env, "schwab", JSON.stringify(s));
// Every deploy also gets its own address (<hash>.<site>.pages.dev); Schwab only accepts the
// callback registered on the app, so the connection always runs on the main address.
const mainOrigin = (url) => url.origin.replace(/^https:\/\/[0-9a-f]{8}\.(?=[^.]+\.pages\.dev$)/, "https://");
const callbackUrl = (url) => mainOrigin(url) + "/schwab/callback";

async function schwabToken(env, params) {
  const r = await fetch(SCHWAB + "/v1/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(env.SCHWAB_APP_KEY + ":" + env.SCHWAB_APP_SECRET),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.access_token) {
    const err = new Error(body.error_description || body.error || `Schwab login failed (${r.status})`);
    err.login = r.status === 400 || r.status === 401;
    throw err;
  }
  return body;
}

async function schwabAccess(env, s) {
  if (s.access && s.accessExp > Date.now() + 60000) return s.access;
  const t = await schwabToken(env, { grant_type: "refresh_token", refresh_token: s.refresh });
  s.access = t.access_token;
  s.accessExp = Date.now() + (t.expires_in || 1800) * 1000;
  if (t.refresh_token) s.refresh = t.refresh_token; // the 7-day clock still runs from login
  return s.access;
}

async function schwabGet(token, path) {
  const r = await fetch(SCHWAB + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (r.status === 401) { const e = new Error("Schwab connection expired. Reconnect."); e.login = true; throw e; }
  if (!r.ok) throw new Error(`Schwab returned ${r.status} for ${path.split("?")[0].replace(/accounts\/[^/]+\//, "accounts/…/")}`);
  return r.json();
}

function schwabStatus(env, s) {
  const expiresAt = s.refresh ? s.loginAt + LOGIN_DAYS * DAY : null;
  return {
    configured: schwabReady(env),
    connected: !!s.refresh && expiresAt > Date.now(),
    expiresAt, lastSync: s.lastSync || null, last: s.last || null,
  };
}

async function schwabSync(env) {
  const s = await schwabState(env);
  const st = schwabStatus(env, s);
  if (!st.configured) return { ok: false, error: "Schwab app keys aren't set yet" };
  if (!st.connected) return { ok: false, needLogin: true, error: "Connect your Schwab account first" };
  try {
    const token = await schwabAccess(env, s);
    const end = Date.now();
    // first sync: up to a year back (the API's limit); after that, a 10-day overlap
    // so trades opened before the last sync still pair up. Duplicates are skipped.
    const start = s.lastSync ? Math.max(s.lastSync - 10 * DAY, end - 360 * DAY) : end - 360 * DAY;
    const accounts = await schwabGet(token, "/trader/v1/accounts/accountNumbers");
    let txns = [];
    for (const a of accounts || []) {
      for (const type of ["TRADE", "RECEIVE_AND_DELIVER"]) {
        const q = new URLSearchParams({ startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), types: type });
        const list = await schwabGet(token, `/trader/v1/accounts/${a.hashValue}/transactions?${q}`);
        if (Array.isArray(list)) txns = txns.concat(list.map((t) => ({ ...t, accountNumber: t.accountNumber || a.accountNumber })));
      }
    }
    const result = pairFills(apiToFills(txns));
    const { added, duplicates } = await addTrades(env, result.trades);
    s.lastSync = end;
    s.last = { at: end, added: added.length, duplicates, open: result.open, missingOpen: result.missingOpen };
    delete s.lastError;
    await saveSchwab(env, s);
    return { ok: true, ...s.last };
  } catch (e) {
    if (e.login) { delete s.refresh; delete s.access; }
    s.lastError = e.message;
    await saveSchwab(env, s);
    return { ok: false, needLogin: !!e.login, error: e.message };
  }
}

async function handle(req, env) {
  const url = new URL(req.url);

  if (url.pathname === "/api/data") {
    if (req.method === "GET") return json(await readData(env));
    if (req.method === "POST") {
      const incoming = await req.json().catch(() => ({}));
      const d = await readData(env);
      // the page sends back the revision it loaded; if trades were imported since, refuse
      // rather than overwrite them with the page's older copy
      if (incoming.rev !== undefined && incoming.rev !== (d.rev || 0)) {
        return json({ ok: false, conflict: true, rev: d.rev || 0 }, 409);
      }
      if (Array.isArray(incoming.trades)) d.trades = incoming.trades;
      if (incoming.start) d.start = incoming.start;
      if (typeof incoming.startBal === "number") d.startBal = incoming.startBal;
      if (incoming.settings && typeof incoming.settings === "object") d.settings = incoming.settings;
      d.rev = (d.rev || 0) + 1;
      await writeBlob(env, "data", JSON.stringify(d));
      return json({ ok: true, count: d.trades.length, rev: d.rev });
    }
  }

  // Schwab transactions CSV in the body. ?dry=1 shows what would be added without saving.
  if (url.pathname === "/api/import-schwab" && req.method === "POST") {
    let result;
    try { result = schwabToTrades(await req.text()); }
    catch (e) { return json({ ok: false, error: e.message }, 400); }
    const dry = url.searchParams.get("dry") === "1";
    const { added, duplicates } = await addTrades(env, result.trades, dry);
    return json({
      ok: true, dry, added: added.length, duplicates, open: result.open,
      skippedShort: result.skippedShort, skippedStock: result.skippedStock, missingOpen: result.missingOpen,
      ...(dry ? { trades: added } : {}),
    });
  }

  if (url.pathname === "/api/quotes") {
    if (req.method === "GET") return json({ quotes: quoteLines(await readBlob(env, "quotes")) });
    if (req.method === "POST") {
      const incoming = await req.json().catch(() => ({}));
      const lines = quoteLines(incoming.text);
      if (!lines.length) return new Response("empty", { status: 400 });
      const cur = (await readBlob(env, "quotes")) || "";
      await writeBlob(env, "quotes", cur + (cur && !cur.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
      return json({ ok: true, added: lines.length });
    }
  }

  // ---- Schwab account connection ----
  if (url.pathname === "/schwab/login") {
    if (!schwabReady(env)) return new Response("Schwab isn't set up yet: run  npm run schwab:keys  (in the cloud folder).", { status: 503 });
    if (mainOrigin(url) !== url.origin) return Response.redirect(mainOrigin(url) + "/schwab/login", 302);
    const s = await schwabState(env);
    s.pending = { state: crypto.randomUUID(), at: Date.now() };
    await saveSchwab(env, s);
    const q = new URLSearchParams({ client_id: env.SCHWAB_APP_KEY, redirect_uri: callbackUrl(url), state: s.pending.state });
    return Response.redirect(SCHWAB + "/v1/oauth/authorize?" + q, 302);
  }
  if (url.pathname === "/schwab/callback") {
    const s = await schwabState(env);
    const p = s.pending;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    // only accept a callback for a login started from this journal in the last 15 minutes
    if (!code || !p || Date.now() - p.at > 15 * 60000 || (state && state !== p.state)) {
      return Response.redirect(url.origin + "/?schwab=failed", 302);
    }
    try {
      const t = await schwabToken(env, { grant_type: "authorization_code", code, redirect_uri: callbackUrl(url) });
      Object.assign(s, { refresh: t.refresh_token, loginAt: Date.now(), access: t.access_token, accessExp: Date.now() + (t.expires_in || 1800) * 1000 });
      delete s.pending; delete s.lastError;
      await saveSchwab(env, s);
      return Response.redirect(url.origin + "/?schwab=connected", 302);
    } catch (e) {
      delete s.pending; s.lastError = e.message;
      await saveSchwab(env, s);
      return Response.redirect(url.origin + "/?schwab=failed", 302);
    }
  }
  if (url.pathname === "/api/schwab/status" && req.method === "GET") {
    const s = await schwabState(env);
    return json({ ...schwabStatus(env, s), error: s.lastError || null });
  }
  if (url.pathname === "/api/schwab/sync" && req.method === "POST") return json(await schwabSync(env));
  if (url.pathname === "/api/schwab/disconnect" && req.method === "POST") {
    const s = await schwabState(env);
    await saveSchwab(env, { lastSync: s.lastSync, last: s.last });
    return json({ ok: true });
  }

  // ---- bot panel: the bot worker (../bot) writes bot:day:<date>; the journal only reads it ----
  // SPX candles for the Bot desk chart, any timeframe: 1m (also builds 3m), 10m, 30m (builds 1h), D (2y), Dlong (3y, ATR levels),
  // W (5y), M (20y: swing / position / long-term levels). Rows: [unix seconds, open, high, low, close]
  if (url.pathname === "/api/bot/candles" && req.method === "GET") {
    const tf = url.searchParams.get("tf") || "1m", now = Date.now();
    const Q = {
      "1m": { frequencyType: "minute", frequency: "1", startDate: String(now - 5 * DAY), endDate: String(now) },
      // Scalp ATR levels like a 10-day 1m thinkorswim chart: the 4h periods are built only from these 10 trading days (~15 calendar days)
      "1m10": { frequencyType: "minute", frequency: "1", startDate: String(now - 15 * DAY), endDate: String(now) },
      "10m": { frequencyType: "minute", frequency: "10", startDate: String(now - 20 * DAY), endDate: String(now) },
      "30m": { frequencyType: "minute", frequency: "30", startDate: String(now - 90 * DAY), endDate: String(now) },
      D: { periodType: "year", period: "2", frequencyType: "daily", frequency: "1" },
      Dlong: { periodType: "year", period: "3", frequencyType: "daily", frequency: "1" },
      W: { periodType: "year", period: "5", frequencyType: "weekly", frequency: "1" },
      M: { periodType: "year", period: "20", frequencyType: "monthly", frequency: "1" },
    }[tf];
    // 1meth: SPX 1m with EXTENDED hours (scalp charts). SPX has no prices outside 9:30-4:00, so those minutes come from /ES futures
    // converted to SPX: ES - basis, basis = ES - SPX at the last regular-hours minute before (the futures premium).
    if (tf === "1meth") {
      const s = await schwabState(env);
      if (!s.refresh) return json({ ok: false, error: "Schwab not connected" });
      try {
        const before = s.access, tok = await schwabAccess(env, s);
        if (s.access !== before) await saveSchwab(env, s);
        const q = { frequencyType: "minute", frequency: "1", startDate: String(now - 5 * DAY), endDate: String(now) };
        const [spx, es] = await Promise.all([
          schwabGet(tok, "/marketdata/v1/pricehistory?" + new URLSearchParams({ symbol: "$SPX", needExtendedHoursData: "false", ...q })),
          schwabGet(tok, "/marketdata/v1/pricehistory?" + new URLSearchParams({ symbol: "/ES", needExtendedHoursData: "true", ...q })),
        ]);
        const r2 = (x) => Math.round(x * 100) / 100, S = spx.candles || [], E = es.candles || [];
        const esAt = new Map(E.map((c) => [c.datetime, c.close])), spxT = new Set(S.map((c) => c.datetime));
        const basisPts = S.filter((c) => esAt.has(c.datetime)).map((c) => [c.datetime, esAt.get(c.datetime) - c.close]);
        const rows = S.map((c) => [Math.round(c.datetime / 1000), r2(c.open), r2(c.high), r2(c.low), r2(c.close)]);
        let k = -1;
        for (const c of E) {
          if (spxT.has(c.datetime)) continue;
          while (k + 1 < basisPts.length && basisPts[k + 1][0] <= c.datetime) k++;
          const b = k >= 0 ? basisPts[k][1] : null;
          if (b == null) continue;   // before the first regular-hours minute in the window
          rows.push([Math.round(c.datetime / 1000), r2(c.open - b), r2(c.high - b), r2(c.low - b), r2(c.close - b), 1]);
        }
        rows.sort((a, b) => a[0] - b[0]);
        return json({ ok: true, tf, bars: rows, basis: basisPts.length ? r2(basisPts.at(-1)[1]) : null });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    if (!Q) return json({ ok: false, error: "tf must be 1m, 1meth, 10m, 30m, D, Dlong, W or M" }, 400);
    const s = await schwabState(env);
    if (!s.refresh) return json({ ok: false, error: "Schwab not connected" });
    try {
      const before = s.access, tok = await schwabAccess(env, s);
      if (s.access !== before) await saveSchwab(env, s);
      const sym = ["$SPX", "SPY", "$VIX"].includes(url.searchParams.get("sym")) ? url.searchParams.get("sym") : "$SPX";   // chart ticker
      const r = await schwabGet(tok, "/marketdata/v1/pricehistory?" + new URLSearchParams({ symbol: sym, needExtendedHoursData: "false", ...Q }));
      const r2 = (x) => Math.round(x * 100) / 100;
      return json({ ok: true, tf, bars: (r.candles || []).map((c) => [Math.round(c.datetime / 1000), r2(c.open), r2(c.high), r2(c.low), r2(c.close)]) });
    } catch (e) { return json({ ok: false, error: e.message }); }
  }
  // levels you draw on the chart: the bot reads them as key levels (D1 "bot:mylevels")
  if (url.pathname === "/api/bot/mylevels") {
    let cur = { items: [] };
    try { cur = JSON.parse((await readBlob(env, "bot:mylevels")) || '{"items":[]}'); } catch (e) {}
    const TFS = ["1m", "3m", "10m", "1h", "4h", "D", "W"], ROLES = ["auto", "support", "resistance"];
    const tfOf = (v) => (TFS.includes(v) ? v : null), roleOf = (v) => (ROLES.includes(v) ? v : "auto");
    if (req.method === "GET") {
      // touch results of your lines (the bot writes D1 "lines:log"): per line, and per timeframe group / role / GEX regime
      let log = [];
      try { log = (JSON.parse((await readBlob(env, "lines:log")) || "null") || {}).items || []; } catch (e) {}
      const grp = (tf) => (tf === "1m" || tf === "3m" ? "scalp" : tf === "10m" ? "day" : tf === "1h" || tf === "4h" ? "swing" : tf === "D" || tf === "W" ? "daily" : "unknown");
      const perLine = {}, perGroup = {};
      for (const x of log) {
        const a = (perLine[x.lineAt] = perLine[x.lineAt] || { held: 0, broke: 0, chop: 0, last: null }); a[x.result]++; a.last = { date: x.date, et: x.et, result: x.result, acting: x.acting };
        const k = `${grp(x.tf)}|${x.acting}|${(x.ctx && x.ctx.gex) || "?"}`, b = (perGroup[k] = perGroup[k] || { held: 0, broke: 0, chop: 0 }); b[x.result]++;
      }
      return json({ ok: true, items: cur.items || [], stats: perLine, groups: perGroup, touches: log.slice(-30).reverse() });
    }
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (b.clear === true) cur.items = [];
      else if (b.remove != null) cur.items = (cur.items || []).filter((x) => x.at !== b.remove);
      // edit a line: new label, new price (level) or new points (trendline)
      else if (b.update != null) cur.items = (cur.items || []).map((x) => {
        if (x.at !== b.update) return x;
        const y = { ...x }, r2 = (v) => Math.round(+v * 100) / 100;
        if (b.label != null) y.label = String(b.label).slice(0, 40);
        if (b.role != null) y.role = roleOf(b.role);
        if (!x.type && isFinite(+b.price)) y.price = r2(b.price);
        if (["trend", "box", "circle"].includes(x.type) && [b.t1, b.p1, b.t2, b.p2].every((v) => isFinite(+v)) && +b.t1 !== +b.t2) {
          const pts = [[+b.t1, r2(b.p1)], [+b.t2, r2(b.p2)]].sort((p, q) => p[0] - q[0]);
          [y.t1, y.p1] = pts[0]; [y.t2, y.p2] = pts[1];
        }
        return y;
      });
      // trendline: two points (unix seconds, price); grp "intra" (minute / hour charts) or "daily" (D / W charts)
      else if (["trend", "box", "circle"].includes(b.type) && [b.t1, b.p1, b.t2, b.p2].every((v) => isFinite(+v)) && +b.t2 !== +b.t1)
        cur.items = [...(cur.items || []), { type: b.type, grp: b.grp === "daily" ? "daily" : "intra", tf: tfOf(b.tf), role: roleOf(b.role), t1: +b.t1, p1: Math.round(+b.p1 * 100) / 100, t2: +b.t2, p2: Math.round(+b.p2 * 100) / 100, label: String(b.label || "trendline").slice(0, 40), at: Date.now() }].slice(-40);
      else if (isFinite(+b.price)) cur.items = [...(cur.items || []), { price: Math.round(+b.price * 100) / 100, label: String(b.label || "level").slice(0, 40), tf: tfOf(b.tf), role: roleOf(b.role), at: Date.now() }].slice(-40);
      await writeBlob(env, "bot:mylevels", JSON.stringify(cur));
      return json({ ok: true, items: cur.items });
    }
  }
  // ---- trade ticket (PAPER account only): SPX 0DTE chain, your orders, the paper positions; the bot fills orders every 30 s ----
  if (url.pathname === "/api/bot/chain" && req.method === "GET") {
    const s = await schwabState(env);
    if (!s.refresh) return json({ ok: false, error: "Schwab not connected" });
    try {
      const before = s.access, tok = await schwabAccess(env, s);
      if (s.access !== before) await saveSchwab(env, s);
      const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const c = await schwabGet(tok, `/marketdata/v1/chains?symbol=%24SPX&contractType=ALL&strikeCount=24&fromDate=${d}&toDate=${d}`);
      const rows = [];
      for (const m of ["callExpDateMap", "putExpDateMap"]) for (const e in c[m] || {}) for (const k in c[m][e]) for (const o of c[m][e][k])
        if (o.daysToExpiration === 0 || String(e).startsWith(d)) rows.push({ symbol: o.symbol, strike: o.strikePrice, putCall: o.putCall, bid: o.bid, ask: o.ask, last: o.last, delta: o.delta, vol: o.totalVolume, oi: o.openInterest });
      return json({ ok: true, date: d, under: c.underlyingPrice ?? (c.underlying && c.underlying.last) ?? null, rows });
    } catch (e) { return json({ ok: false, error: e.message }); }
  }
  if (url.pathname === "/api/bot/ticket" && req.method === "GET") {
    const get = async (k) => { try { return JSON.parse((await readBlob(env, k)) || "null"); } catch (e) { return null; } };
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const orders = ((await get("paper:orders")) || { items: [] }).items.filter((o) => o.date === d), fills = (await get("paper:fills")) || {};
    const acct = await get("paper:acct"), sig = await get("sig:day:" + d);
    const alerts = ((sig && sig.alerts) || []).filter((a) => a.contract && a.contract.symbol).slice(-30).reverse();
    // live bid / ask for the alerts' contracts and the open positions (one Schwab quotes call)
    const quotes = {};
    const want = String(url.searchParams.get("sym") || "");   // the contract typed in the ticket
    const syms = [...new Set([...(/^(SPXW?|SPY)\s+\d{6}[CP]\d{8}$/.test(want) ? [want] : []), ...((acct && acct.positions) || []).map((p) => p.symbol), ...alerts.map((a) => a.contract.symbol)])].slice(0, 60);
    if (syms.length) try {
      const s = await schwabState(env);
      if (s.refresh) {
        const before = s.access, tok = await schwabAccess(env, s);
        if (s.access !== before) await saveSchwab(env, s);
        const q = await schwabGet(tok, "/marketdata/v1/quotes?fields=quote&symbols=" + syms.map(encodeURIComponent).join(","));
        for (const k of syms) { const x = q[k] && q[k].quote; if (x) quotes[k] = { bid: x.bidPrice, ask: x.askPrice, last: x.lastPrice }; }
      }
    } catch (e) {}
    return json({
      quotes,
      ok: true, date: d,
      orders: orders.map((o) => ({ ...o, fill: fills[o.id] || { status: "sent" } })).reverse(),
      positions: ((acct && acct.positions) || []).map((p) => ({ id: p.id, symbol: p.symbol, label: p.label, qty: p.qtyOpen, entry: p.entry, bid: p.lastBid ?? null, manual: !!p.manual, botManaged: !!p.botManaged, signal: p.signal, et: p.et, at: p.at, stop: p.stop,
        under: p.under, dir: p.dir, delta: p.delta ?? null, uEntry: p.uEntry ?? null, uStop: p.uStop ?? null, uTarget: p.uTarget ?? null, userStop: p.userStop ?? null, userTarget: p.userTarget ?? null, manualStop: !!p.manualStop, t1: !!p.t1 })),
      balance: acct ? acct.balance : null, dayPnl: acct && acct.day && acct.day.date === d ? acct.day.pnl : 0,
      alerts: alerts.map((a) => ({ et: a.et, title: a.title, sym: a.sym, dir: a.dir || null, fam: a.fam || null, contract: a.contract })),
    });
  }
  if (url.pathname === "/api/bot/order" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const d = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    let cur = { items: [] };
    try { cur = JSON.parse((await readBlob(env, "paper:orders")) || '{"items":[]}'); } catch (e) {}
    cur.items = (cur.items || []).filter((o) => o.date >= d);   // a new day starts clean
    if (b.cancel) { cur.items = cur.items.map((o) => (o.id === b.cancel ? { ...o, cancel: true } : o)); }
    else if (b.modify) {
      // move a position's stop / target (from the chart or the ticket): SPX levels, or the option (premium) stop
      const lv = (v, lo, hi) => (v === null ? null : v === undefined ? undefined : +v >= lo && +v <= hi ? Math.round(+v * 100) / 100 : NaN);
      const m = { userStop: lv(b.userStop, 100, 50000), userTarget: lv(b.userTarget, 100, 50000), stop: lv(b.stop, 0.01, 1000) };
      if (Object.values(m).some((v) => Number.isNaN(v))) return json({ ok: false, error: "bad price" }, 400);
      cur.items.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), date: d, at: Date.now(), modify: String(b.modify).slice(0, 80), ...m });
      cur.items = cur.items.slice(-200);
    }
    else {
      const sym = String(b.symbol || "");
      if (!/^(SPXW?|SPY)\s+\d{6}[CP]\d{8}$/.test(sym)) return json({ ok: false, error: "only SPX / SPY option contracts" }, 400);
      if (!["buy", "sell"].includes(b.side)) return json({ ok: false, error: "side must be buy or sell" }, 400);
      const qty = Math.floor(+b.qty), limit = Math.round(+b.limit * 100) / 100;
      if (!(qty >= 1 && qty <= 3)) return json({ ok: false, error: "1 to 3 contracts" }, 400);
      if (!(limit > 0 && limit < 1000)) return json({ ok: false, error: "bad limit price" }, 400);
      const pc = /\d{6}C/.test(sym) ? "CALL" : "PUT";
      cur.items.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), date: d, at: Date.now(), side: b.side, at_: ["bid", "ask", "limit"].includes(b.at) ? b.at : "ask",
        symbol: sym, label: String(b.label || sym).slice(0, 40), under: sym.startsWith("SPY") ? "SPY" : "$SPX", putCall: pc, qty, limit,
        delta: isFinite(+b.delta) ? +b.delta : null, alert: b.alert ? String(b.alert).slice(0, 160) : null, alertET: b.alertET || null, fam: b.fam || null, botManage: !!b.botManage });
      cur.items = cur.items.slice(-200);
    }
    await writeBlob(env, "paper:orders", JSON.stringify(cur));
    // fill it now: ask the bot (service binding) for an immediate paper pass instead of waiting for the next ~10 s check
    let fast = null;
    if (env.BOT) try { const r = await Promise.race([env.BOT.fetch("https://bot/paper/fast", { method: "POST" }), new Promise((res) => setTimeout(() => res(null), 9000))]); fast = r ? await r.json().catch(() => null) : null; } catch (e) {}
    return json({ ok: true, fast });
  }
  // live SPX price for the Bot desk chart (polled every 5 s while the Bot tab is open in market hours)
  if (url.pathname === "/api/bot/live" && req.method === "GET") {
    const s = await schwabState(env);
    if (!s.refresh) return json({ ok: false, error: "Schwab not connected" });
    try {
      const before = s.access, tok = await schwabAccess(env, s);
      if (s.access !== before) await saveSchwab(env, s);
      const lsym = ["$SPX", "SPY", "$VIX"].includes(url.searchParams.get("sym")) ? url.searchParams.get("sym") : "$SPX";
      const q0 = await schwabGet(tok, "/marketdata/v1/quotes?symbols=" + encodeURIComponent(lsym === "$SPX" ? "$SPX,/ES" : lsym) + "&fields=quote");
      const q = lsym === "$SPX" ? q0 : { $SPX: q0[lsym] };   // the reply below reads $SPX: the chart's ticker
      const esKey = Object.keys(q || {}).find((k) => k.startsWith("/ES"));   // Schwab answers with the front month, e.g. /ESZ26
      const x = q && q.$SPX && q.$SPX.quote, f = esKey && q[esKey].quote;
      return json({ ok: !!x, last: x ? x.lastPrice : null, at: x ? x.tradeTime || x.quoteTime || Date.now() : null, es: f ? f.lastPrice : null });
    } catch (e) { return json({ ok: false, error: e.message }); }
  }
  if (url.pathname === "/api/bot" && req.method === "GET") {
    const date = url.searchParams.get("date") || (await readBlob(env, "bot:latest"));
    const get = async (k) => { try { return JSON.parse((await readBlob(env, k)) || "null"); } catch (e) { return null; } };
    const state = date ? await get("bot:day:" + date) : null;
    const greeks = await get("greeks:spx"), greeksSpy = await get("greeks:spy");
    const sig = date ? await get("sig:day:" + date) : null;
    const tm = await get("paper:test"), tb = tm && tm.on && tm.date === date ? await get("paper:testbook") : null;
    return json({
      ok: true, state, greeks, greeksSpy,
      test: { on: !!(tm && tm.on && tm.date === new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date())),
        balance: tb ? tb.balance : null, open: tb ? (tb.positions || []).map((x) => x.label) : [], log: tb ? (tb.log || []).slice(-12) : [] },
      signals: sig ? (sig.alerts || []).slice(-25).reverse() : [],
      planStatus: sig ? sig.planSt || {} : {},
      // the Bot desk chart: today's SPX 1m bars and the SPX trade signals (time, side, price, title)
      // marks: SPX trade signals (side + price) and the leaderboard / EOD plays (shakeout watch has no side: shown as a dot)
      chart: sig ? { bars: sig.spx1m || [], marks: (sig.alerts || []).filter((a) => a.sym === "$SPX" && ((a.dir && a.px != null) || /LB SHAKEOUT|EOD|FINAL 20|max pain/i.test(a.title || "")))
        .map((a) => ({ at: a.at, dir: a.dir || null, px: a.px ?? null, title: a.title })) } : null,
    });
  }
  // the bot's scorecard: scored signals, daily plan reviews, training posts
  if (url.pathname === "/api/bot/stats" && req.method === "GET") {
    const get = async (k) => { try { return JSON.parse((await readBlob(env, k)) || "null"); } catch (e) { return null; } };
    const stats = await get("bot:stats"), reviews = await get("bot:reviews"), lib = await get("lib:setups");
    const pAcct = await get("paper:acct"), pTrades = await get("paper:trades"), pModel = await get("paper:model"), pCh = await get("paper:challengers"), pSw = await get("swing:book");
    return json({
      swing: pSw ? { open: pSw.open, closed: (pSw.closed || []).slice(-60) } : null,
      paper: { acct: pAcct, model: pModel,
        challengers: pCh ? { gen: pCh.gen, since: pCh.since, hist: pCh.hist, books: Object.fromEntries(Object.entries(pCh.books).map(([id, x]) => [id, { name: x.cfg.name, balance: x.book.balance, open: x.book.open && x.book.open.label, recent: (x.book.recent || []).slice(0, 5) }])) } : null, trades: pTrades ? pTrades.items.slice(-400).map(({ path, ctx, params, ...x }) => x) : [] },
      ok: true, items: stats ? stats.items : [], reviews: reviews ? reviews.days : {},
      library: lib ? lib.items.map(({ context, raw, images, ...x }) => ({ ...x, text: String(raw || "").slice(0, 200) })) : [],
    });
  }
  // 🧪 test mode for today (bot/src/paper.js): a separate pullback-tolerant book takes every SPX signal, 1 contract, posts to Discord
  if (url.pathname === "/api/bot/test" && req.method === "POST") {
    const { on } = await req.json().catch(() => ({}));
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    await writeBlob(env, "paper:test", JSON.stringify({ on: !!on, date: today, at: Date.now() }));
    return json({ ok: true, on: !!on, date: today });
  }
  // today's plan pasted in the journal (used instead of the Discord post)
  if (url.pathname === "/api/bot/plan" && req.method === "POST") {
    const { text } = await req.json().catch(() => ({}));
    if (!text || !String(text).trim()) return json({ ok: false, error: "empty" }, 400);
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
    await writeBlob(env, "bot:plan-raw:" + today, JSON.stringify({ text: String(text).slice(0, 8000), at: Date.now() }));
    return json({ ok: true });
  }

  if (url.pathname.startsWith("/api/")) return new Response("Not found", { status: 404 });
  return env.ASSETS.fetch(req);
}

export default {
  async fetch(req, env) {
    if (!env.JOURNAL_PASSWORD) {
      return new Response("Journal is locked: set a password first with  npm run password  then  npm run deploy  (in the cloud folder)", { status: 503 });
    }
    if (!authorized(req, env) && !(await shotPass(req, env))) {
      return new Response("Password required", { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Trade journal", charset="UTF-8"' } });
    }
    try {
      return await handle(req, env);
    } catch (err) {
      console.error(err);
      return json({ ok: false, error: "server error" }, 500);
    }
  },
};
