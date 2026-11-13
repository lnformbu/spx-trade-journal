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
  if (url.pathname === "/api/bot" && req.method === "GET") {
    const date = url.searchParams.get("date") || (await readBlob(env, "bot:latest"));
    const get = async (k) => { try { return JSON.parse((await readBlob(env, k)) || "null"); } catch (e) { return null; } };
    const state = date ? await get("bot:day:" + date) : null;
    const greeks = await get("greeks:spx");
    const sig = date ? await get("sig:day:" + date) : null;
    return json({
      ok: true, state, greeks,
      signals: sig ? (sig.alerts || []).slice(-25).reverse() : [],
      planStatus: sig ? sig.planSt || {} : {},
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
    if (!authorized(req, env)) {
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
