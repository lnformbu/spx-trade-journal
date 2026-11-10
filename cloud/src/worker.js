/*
 * Trade journal — Cloudflare Worker version of server.js.
 * Same API as the local server, so index.html works unchanged:
 *   GET/POST /api/data    trades + start date (was trades.json)
 *   GET/POST /api/quotes  daily verses       (was quotes.txt)
 *   POST /api/import-schwab   Schwab History CSV -> new trades (?dry=1 = preview only)
 * Everything else is the static page from public/.
 *
 * The whole site is behind a password (Worker secret JOURNAL_PASSWORD).
 * If no password is set, the site refuses to open rather than going public.
 */

// "../src/" resolves both from src/worker.js and from the deployed public/_worker.js
import { schwabToTrades, mergeImported } from "../src/schwab.js";

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
    const d = await readData(env);
    const { added, duplicates } = mergeImported(d.trades, result.trades);
    if (!dry && added.length) {
      d.trades = d.trades.concat(added);
      d.rev = (d.rev || 0) + 1;
      await writeBlob(env, "data", JSON.stringify(d));
    }
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
