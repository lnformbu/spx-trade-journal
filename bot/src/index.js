/*
 * SPY bot, phase 1: no trading. Every minute on weekdays it
 *   - pulls SPY/SPX/VIX quotes and SPY candles from Schwab (the journal's connection, D1 key "schwab"),
 *   - computes the day's key levels and Pivot Ribbons,
 *   - reads your morning plan from Discord (or the plan pasted in the journal),
 *   - after the close, reviews the plan against what SPY did,
 * and saves it all to D1 ("bot:day:<date>") for the journal's Bot panel.
 *
 * Secrets: SCHWAB_APP_KEY, SCHWAB_APP_SECRET, DISCORD_BOT_TOKEN, BOT_ADMIN_KEY (npm run keys).
 */
import { et, hhmm, OPEN, CLOSE, dayLevels, aggregate, ribbon, intradayLevels, dailyDate, phaseOsc, modeLevels, cloud2021, compressionBox, volumeStack, avwap, dtrPct, chop, vwapCrosses } from "./levels.js";

import { etToMs } from "./time.js";
const oscOut = (o) => (o ? { ...o, _track: undefined, _osc: undefined } : null);
import { parsePlans, resolvePlan, reviewPlan } from "./plan.js";
import { runSignals, testWebhook, post } from "./signals.js";
import { runPaper, runLearning } from "./paper.js";
import { runSwing } from "./swing.js";
import { readChart } from "./vision.js";

// ---- keep-alive warnings in #signals: Schwab login about to expire, or the bot stopped ----
async function health(env, st, t, now) {
  const h = (await readJSON(env, "bot:health")) || {};
  const s = (await readJSON(env, "schwab")) || {};
  const left = s.refresh && s.loginAt ? s.loginAt + 7 * 864e5 - now : null;
  // reminder once a day (from 8:00 ET) when less than 36 hours are left
  if (left != null && left < 36 * 3600e3 && left > 0 && t.min >= 480 && h.remindDay !== t.date) {
    const hrs = Math.round(left / 3600e3);
    await post(env, { title: "🔑 Reconnect Schwab soon", color: 0xf0b429,
      description: `Schwab ends the bot's login in about ${hrs} hours. Open the journal and click **Reconnect Schwab** (bottom of the page) so signals keep coming.` }).catch(() => {});
    h.remindDay = t.date;
  }
  // bot stopped: say so once per problem (per day), and say when it recovers
  const err = (st.errors || []).find((e) => e.where === "schwab-login" || e.where === "run");
  if (err && h.downDay !== t.date && t.min >= OPEN - 30 && t.min <= CLOSE) {
    await post(env, { title: "⛔ Bot stopped", color: 0xf0556b,
      description: err.where === "schwab-login" ? "Schwab login expired. Open the journal and click **Reconnect Schwab**; the bot restarts by itself within a minute." : `Error: ${err.msg}` }).catch(() => {});
    h.downDay = t.date; h.down = true;
  } else if (!err && h.down) {
    await post(env, { title: "✅ Bot running again", color: 0x2ec26b, description: "Data is flowing; signals resume." }).catch(() => {});
    h.down = false;
  }
  await writeJSON(env, "bot:health", h);
}
import { runGreeks as greekJob } from "./greekjob.js";

const GREEKS_CRON = "*/5 13-21 * * MON-FRI";
// SPX greek exposure board: 0-3 day expirations, 40 strikes around spot; every 5 minutes
const SIGNALS_CRON = "* 13-21 * * MON-FRI";

// ---- training: "Setup:" / "Idea:" / "Lesson:" posts (and "Result:" replies) in the plan channel ----
const TRAINING = /^\s*\**\s*(setup|idea|lesson|trade|result)\b/i;
function parseSetup(raw) {
  const t = raw.replace(/\*/g, "");
  const kind = (t.match(TRAINING) || [, "setup"])[1].toLowerCase();
  const tick = (t.match(/\b(SPX|SPY|TSLA|MU|META|AVGO|SPCX|MSTR|GOOGL|AAPL|QQQ|NVDA)\b/i) || [])[1];
  const contract = (t.match(/\b(\d{2,4}(?:\.\d)?)\s*([cp])\b/i) || []);
  const dir = /\b(calls?|long|bull(?:ish)?|upside)\b/i.test(t) ? "bull" : /\b(puts?|short|bear(?:ish)?|downside)\b/i.test(t) ? "bear" : contract[2] ? (contract[2].toLowerCase() === "c" ? "bull" : "bear") : null;
  const res = t.match(/result\s*[:\-]\s*([+\-−]?\d+(?:\.\d+)?\s*%|win|loss|lost|won|be|breakeven|scratch)/i);
  const tm = t.match(/\b(?:time|entry|entered)\s*[:@]?\s*(\d{1,2}:\d{2})/i);
  const tags = [...t.matchAll(/#(\w+)/g)].map((m) => m[1].toLowerCase());
  return { kind, ticker: tick ? tick.toUpperCase() : null, contract: contract[1] ? contract[1] + contract[2].toUpperCase() : null, dir,
    result: res ? res[1].replace("−", "-").toLowerCase() : null, time: tm ? tm[1] : null, tags };
}
// what the market looked like (SPY/SPX side), so winners and losers can be compared later
function snapshot(st, g) {
  const L = st.levels || {}, price = st.quote && st.quote.spy;
  const flat = Object.entries(L).filter(([k, v]) => typeof v === "number" && k !== "atr" && k !== "last" && k !== "open");
  Object.entries(L.atrLevels || {}).forEach(([k, v]) => { if (Math.abs(+k) <= 1) flat.push(["ATR " + k, v]); });
  const above = flat.filter(([, v]) => v > price).sort((a, b) => a[1] - b[1])[0], below = flat.filter(([, v]) => v <= price).sort((a, b) => b[1] - a[1])[0];
  const o = (x) => x && { v: x.value, zone: x.zone, comp: x.compression, cross: x.cross };
  return {
    at: Date.now(), spx: st.quote && st.quote.spx, spy: price, vix: st.vix10 && st.vix10.last, vixDir: st.vix10 ? (st.vix10.last < st.vix10.prev ? "falling" : "rising") : null,
    cloud: { m3: st.r3 && st.r3.state, m10: st.r10 && st.r10.state, h1: st.r1h && st.r1h.state }, conviction10: st.r10 && st.r10.conviction,
    osc: { m3: o(st.osc3), m10: o(st.osc10), h1: o(st.osc1h) }, choppy: st.choppy, chop10: st.chop10, dtr: st.dtr, vwapSide: L.vwap && price ? (price >= L.vwap ? "above" : "below") : null,
    nearestAbove: above && { name: above[0], dist: Math.round((above[1] - price) * 100) / 100 }, nearestBelow: below && { name: below[0], dist: Math.round((price - below[1]) * 100) / 100 },
    planSide: st.plan && st.plan.parsed && price != null ? (price > st.plan.parsed.callTrigger ? "calls" : price < st.plan.parsed.putTrigger ? "puts" : "range") : null,
    gamma: g && g.date === st.date ? { flip: g.flip, callWall: g.callWall, putWall: g.putWall, eye: g.eye && g.eye.strike, aboveFlip: st.quote && st.quote.spx > g.flip } : null,
  };
}
async function captureSetups(env, st, posts) {
  const lib = (await readJSON(env, "lib:setups")) || { items: [] };
  const g = await readJSON(env, "greeks:spx");
  let changed = false;
  for (const p of posts) {
    const parsed = parseSetup(p.raw);
    const target = p.replyTo && lib.items.find((x) => x.id === p.replyTo);
    if (target) {
      if (target.replies && target.replies.includes(p.id)) continue;
      // merge what the reply adds (setup details, result, tags); keep what's already known
      for (const k of ["ticker", "contract", "dir", "result", "time"]) if (parsed[k] && !(k !== "result" && target[k])) target[k] = parsed[k];
      if (parsed.result) target.resultAt = p.at;
      target.tags = [...new Set([...(target.tags || []), ...(parsed.tags || [])])];
      if (TRAINING.test(p.raw) && target.kind === "chart") target.kind = parsed.kind;
      target.notes = [...(target.notes || []), p.raw].slice(-10);
      target.images = [...(target.images || []), ...(p.images || [])];
      target.replies = [...(target.replies || []), p.id];
      changed = true;
      continue;
    }
    const have = lib.items.find((x) => x.id === p.id);
    if (have) { if (have.raw !== p.raw) { Object.assign(have, parsed, { raw: p.raw, editedAt: p.at }); changed = true; } continue; }
    const chartOnly = p.training && !TRAINING.test(p.raw) && p.images && p.images.length;
    if (!TRAINING.test(p.raw) && !chartOnly) continue;
    if (chartOnly) parsed.kind = p.raw.trim() ? "chart" : "chart (needs details)";
    const lagMin = Math.round((Date.now() - p.postedAt) / 60000);
    lib.items.push({ id: p.id, date: et(p.postedAt).date, postedAt: p.postedAt, raw: p.raw, images: p.images, ...parsed,
      context: { ...snapshot(st, g), lagMin, late: lagMin > 15 || et(p.postedAt).min < OPEN || et(p.postedAt).min >= CLOSE || ["Sat", "Sun"].includes(et(p.postedAt).wd) } });
    changed = true;
  }
  // read one chart image per run with the vision model (keeps within the free allowance and run limits)
  const todo = lib.items.find((x) => x.images && x.images.length && !x.vision && (x.visionTries || 0) < 2);
  if (todo) {
    try {
      const v = await readChart(env, todo.images[0]);
      todo.vision = v.data || { summary: v.raw };
      const d = v.data || {};
      // fill what the text didn't say (text always wins)
      if (!todo.ticker && d.ticker) todo.ticker = String(d.ticker).toUpperCase().replace("$", "");
      if (!todo.dir && (d.direction === "bull" || d.direction === "bear")) todo.dir = d.direction;
      const extra = [d.setup, ...(d.candle_patterns || [])].filter(Boolean).map((x) => String(x).toLowerCase().replace(/[^a-z0-9]+/g, "-"));
      todo.tags = [...new Set([...(todo.tags || []), ...extra])];
      if (todo.kind === "chart (needs details)") todo.kind = "chart (read from image)";
    } catch (e) {
      todo.visionTries = (todo.visionTries || 0) + 1;
      todo.visionError = e.message;
    }
    changed = true;
  }
  if (changed) { lib.items = lib.items.slice(-1000); await writeJSON(env, "lib:setups", lib); }
}

const SCHWAB = "https://api.schwabapi.com";
const CHUNK = 90000;

// ---- D1 blobs (same table as the journal) ----
async function readBlob(env, key) {
  const { results } = await env.DB.prepare("SELECT value FROM blobs WHERE key = ? ORDER BY part").bind(key).all();
  return results.length ? results.map((r) => r.value).join("") : null;
}
async function writeBlob(env, key, text) {
  const stmts = [env.DB.prepare("DELETE FROM blobs WHERE key = ?").bind(key)];
  for (let i = 0, part = 0; i < text.length || part === 0; i += CHUNK, part++) {
    stmts.push(env.DB.prepare("INSERT INTO blobs (key, part, value) VALUES (?, ?, ?)").bind(key, part, text.slice(i, i + CHUNK)));
  }
  await env.DB.batch(stmts);
}
const readJSON = async (env, key) => { try { return JSON.parse((await readBlob(env, key)) || "null"); } catch (e) { return null; } };
const writeJSON = (env, key, v) => writeBlob(env, key, JSON.stringify(v));

// ---- Schwab: borrow the journal's login; refresh the access token when needed ----
async function schwabToken(env) {
  const s = (await readJSON(env, "schwab")) || {};
  if (!s.refresh) throw Object.assign(new Error("Schwab isn't connected. Connect it in the journal."), { login: true });
  if (s.access && s.accessExp > Date.now() + 90000) return s.access;
  const r = await fetch(SCHWAB + "/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(env.SCHWAB_APP_KEY + ":" + env.SCHWAB_APP_SECRET), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: s.refresh }),
  });
  const t = await r.json().catch(() => ({}));
  if (!r.ok || !t.access_token) throw Object.assign(new Error("Schwab login expired. Reconnect Schwab in the journal."), { login: true });
  // re-read so a sync the journal just saved isn't overwritten
  const cur = (await readJSON(env, "schwab")) || s;
  cur.access = t.access_token;
  cur.accessExp = Date.now() + (t.expires_in || 1800) * 1000;
  if (t.refresh_token) cur.refresh = t.refresh_token;
  await writeJSON(env, "schwab", cur);
  return cur.access;
}
async function schwab(token, path) {
  const r = await fetch(SCHWAB + path, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Schwab ${r.status} on ${path.split("?")[0]}`);
  return r.json();
}
const history = (token, q) => schwab(token, "/marketdata/v1/pricehistory?" + new URLSearchParams({ symbol: "SPY", needExtendedHoursData: "true", ...q }))
  .then((j) => j.candles || []);

// only bars whose period has ended
const completed = (bars, size, now) => bars.filter((b) => b.datetime + size * 60000 <= now);

// ---- Discord: all of today's plan posts in your plan channel (oldest first) ----
async function discordPosts(env, today, channel = env.DISCORD_CHANNEL_ID, allDates = false) {
  if (!env.DISCORD_BOT_TOKEN || !channel) return null;
  const r = await fetch(`https://discord.com/api/v10/channels/${channel}/messages?limit=50`, {
    headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (spx-bot, 1.0)" },
  });
  if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(`Discord ${r.status}: ${b.message || ""}${r.status === 403 ? " (bot can't see the channel)" : r.status === 401 ? " (bad bot token)" : ""}`); }
  const msgs = await r.json();
  // every message from today: plans (Upside:/Downside:) and training posts (Setup: / Idea: / Lesson: / Result:)
  return msgs
    .filter((m) => allDates || et(Date.parse(m.timestamp)).date === today)
    .map((m) => ({
      id: m.id, source: "discord", raw: m.content || "", at: Date.parse(m.edited_timestamp || m.timestamp), postedAt: Date.parse(m.timestamp),
      author: m.author && m.author.username, images: (m.attachments || []).filter((a) => /image/.test(a.content_type || "")).map((a) => a.url),
      replyTo: m.message_reference && m.message_reference.message_id,
    }))
    .sort((a, b) => a.at - b.at);
}
// Today's plan per ticker: later posts override earlier ones for the same ticker; a plan pasted in the journal counts as a post.
export function plansByTicker(posts, refs) {
  const out = {};
  for (const p of posts) for (const [sym, plan] of Object.entries(parsePlans(p.raw, refs))) out[sym] = { source: p.source, at: p.at, raw: p.raw, author: p.author, plan };
  return out;
}

// ---- one run ----
async function run(env, { force = false } = {}) {
  const now = Date.now();
  const t = et(now);
  const today = t.date;
  if (!force) {
    if (t.wd === "Sat" || t.wd === "Sun") return { skipped: "weekend" };
    if (t.min < 240 || t.min > 16 * 60 + 20) return { skipped: "outside 4:00-16:20" };
    if (t.min < OPEN - 10 && t.min % 5) return { skipped: "premarket: every 5 minutes" };
  }
  const key = "bot:day:" + today;
  const st = (await readJSON(env, key)) || { date: today };
  if (st.review && !force) return { skipped: "day reviewed" };
  st.errors = [];
  delete st.scalp; // Scalp (4h) levels were dropped
  const fail = (where, e) => st.errors.push({ where, msg: String(e && e.message || e), at: now });

  try {
    const token = await schwabToken(env);

    // daily candles once a day -> PDH/PDL/PDC, ATR levels
    let daily = await readJSON(env, "bot:daily");
    if (!daily || daily.date !== today) {
      const candles = await history(token, { periodType: "year", period: "1", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
      daily = { date: today, candles: candles.map(({ open, high, low, close, datetime }) => ({ open, high, low, close, datetime })) };
      await writeJSON(env, "bot:daily", daily);
    }
    st.day = dayLevels(daily.candles, today);
    // SPX's own daily data for its ATR levels and PDH/PDL/PDC
    let dailySPX = await readJSON(env, "bot:dailySPX");
    if (!dailySPX || dailySPX.date !== today) {
      const candles = await history(token, { symbol: "$SPX", periodType: "year", period: "1", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
      dailySPX = { date: today, candles: candles.map(({ open, high, low, close, datetime }) => ({ open, high, low, close, datetime })) };
      await writeJSON(env, "bot:dailySPX", dailySPX);
    }
    st.spxDay = dayLevels(dailySPX.candles, today);
    // daily 20/21 EMA cloud
    st.cloudD = cloud2021(daily.candles.filter((c) => dailyDate(c) < today));
    // Swing mode ATR levels: monthly bars (previous month close, monthly ATR)
    let monthly = await readJSON(env, "bot:monthly");
    if (!monthly || monthly.date !== today) {
      const candles = await history(token, { periodType: "year", period: "5", frequencyType: "monthly", frequency: "1", needExtendedHoursData: "false" });
      monthly = { date: today, candles: candles.map(({ open, high, low, close, datetime }) => ({ open, high, low, close, datetime })) };
      await writeJSON(env, "bot:monthly", monthly);
    }
    st.swing = modeLevels(monthly.candles.filter((c) => dailyDate(c).slice(0, 7) < today.slice(0, 7)));

    // quotes
    const q = await schwab(token, "/marketdata/v1/quotes?symbols=SPY,%24SPX,%24VIX&fields=quote");
    const qq = (s) => q[s] && q[s].quote;
    st.quote = { spy: qq("SPY")?.lastPrice ?? null, spx: qq("$SPX")?.lastPrice ?? null, vix: qq("$VIX")?.lastPrice ?? null, at: now };
    if (t.min >= OPEN && t.min <= CLOSE && st.quote.vix) {
      const v = st.vix || { first: st.quote.vix, high: st.quote.vix, low: st.quote.vix };
      st.vix = { ...v, last: st.quote.vix, high: Math.max(v.high, st.quote.vix), low: Math.min(v.low, st.quote.vix) };
    }
    // SPX/SPY ratio: live during the session; before the open, yesterday's closes; after the close, the last session ratio
    if (t.min >= OPEN && t.min < CLOSE && st.quote.spx && st.quote.spy) st.ratioRTH = st.quote.spx / st.quote.spy;
    st.ratio = st.ratioRTH || (st.spxDay && st.day ? st.spxDay.pdc / st.day.pdc : null);
    if (st.ratio) st.ratio = Math.round(st.ratio * 10000) / 10000;

    // 10-minute bars: ribbon + overnight high/low (refresh when a new bar closes)
    if (force || !st.r10 || t.min % 10 === 1) {
      const b10 = completed(await history(token, { frequencyType: "minute", frequency: "10", startDate: String(now - 40 * 864e5), endDate: String(now) }), 10, now);
      st.r10 = ribbon(b10);
      const o10 = phaseOsc(b10);
      st.osc10 = oscOut(o10);
      st.box10 = o10 ? compressionBox(b10, o10._track) : null;
      st.chop10 = chop(b10);
      // VIX on 10m (inverse of SPX)
      const v10 = completed(await history(token, { symbol: "$VIX", frequencyType: "minute", frequency: "10", startDate: String(now - 10 * 864e5), endDate: String(now) }), 10, now);
      st.vix10 = v10.length > 1 ? { rib: ribbon(v10), osc: oscOut(phaseOsc(v10)), last: v10.at(-1).close, prev: v10.at(-2).close } : null;
      // anchored VWAP (anchor in wrangler.toml, e.g. "2026-10-27 09:30")
      const [ad, at] = String(env.AVWAP_ANCHOR || "").split(" ");
      st.avwap = ad ? { anchor: env.AVWAP_ANCHOR, ...(avwap(b10, etToMs(ad, at || "09:30")) || {}) } : null;
      const prev = st.day && st.day.prevDate;
      const night = b10.filter((b) => { const x = et(b.datetime); return (x.date === prev && x.min >= CLOSE) || (x.date === today && x.min < OPEN); });
      st.night = night.length ? { onh: Math.max(...night.map((b) => b.high)), onl: Math.min(...night.map((b) => b.low)) } : null;
    }
    // 1-hour bars from 30-minute ones (EMA 21/50 + ribbon); refresh every half hour
    if (force || !st.r1h || t.min % 30 === 1) {
      // swing mode: 1h bars, regular hours only, aligned to 9:30 like thinkorswim
      const b30 = (await history(token, { frequencyType: "minute", frequency: "30", startDate: String(now - 60 * 864e5), endDate: String(now), needExtendedHoursData: "false" }))
        .filter((b) => { const x = et(b.datetime).min; return x >= OPEN && x < CLOSE; });
      const h1 = completed(aggregate(b30.map((b) => ({ ...b, datetime: b.datetime - 1800000 })), 60).map((b) => ({ ...b, datetime: b.datetime + 1800000 })), 60, now);
      st.r1h = ribbon(h1);
      st.osc1h = oscOut(phaseOsc(h1));
      // extended-hours 30m bars -> hourly 20/21 cloud
      const e30 = completed(await history(token, { frequencyType: "minute", frequency: "30", startDate: String(now - 60 * 864e5), endDate: String(now) }), 30, now);
      st.cloudH = cloud2021(completed(aggregate(e30, 60), 60, now));
    }
    // 1-minute bars today: premarket, ORB, VWAP, high/low of day
    const startToday = now - (t.min + 1) * 60000;
    const m1 = await history(token, { frequencyType: "minute", frequency: "1", startDate: String(startToday), endDate: String(now) });
    st.intra = intradayLevels(m1, today, null);
    // scalp mode: 3m bars with extended hours (today from midnight)
    const b3 = completed(aggregate(m1, 3), 3, now);
    st.r3 = b3.length >= 21 ? ribbon(b3) : null;
    const o3 = phaseOsc(b3);
    st.osc3 = oscOut(o3);
    st.box3 = o3 ? compressionBox(b3, o3._track) : null;
    st.vstack3 = b3.length ? volumeStack(b3[b3.length - 1]) : null;
    const rth = m1.filter((c) => { const x = et(c.datetime); return x.date === today && x.min >= OPEN && x.min < CLOSE; });
    st.rthBars = rth.length;
    st.vwapX = rth.length > 20 ? vwapCrosses(rth, 60) : 0;
    st.choppy = st.chop10 != null && st.chop10 > 61.8 && ((st.r10 && st.r10.flips >= 2) || st.vwapX >= 4);
    st.dtr = st.day ? dtrPct(st.intra.hod, st.intra.lod, st.day.atr, st.day.pdc) : null;

    // all levels in one flat object (what the plan reader and the panel use)
    st.levels = {
      ...(st.day ? { pdh: st.day.pdh, pdl: st.day.pdl, pdc: st.day.pdc, atr: st.day.atr, atrLevels: st.day.atrLevels } : {}),
      ...st.intra, ...(st.night || {}),
      ema10m21: st.r10 && st.r10.ema[21], ema10m200: st.r10 && st.r10.ema[200], ema1h200: st.r1h && st.r1h.ema[200],
      ...(st.avwap && st.avwap.vwap ? { avwap: st.avwap.vwap, avwapUp1: st.avwap.up1, avwapDn1: st.avwap.dn1, avwapUp2: st.avwap.up2, avwapDn2: st.avwap.dn2 } : {}),
    };

    // the same levels in SPX: daily ones from SPX itself, the rest converted from SPY
    if (st.ratio) {
      const conv = (v) => (v == null ? null : Math.round(v * st.ratio * 100) / 100);
      st.levelsSPX = Object.fromEntries(Object.entries(st.levels).filter(([k]) => k !== "atrLevels" && k !== "atr").map(([k, v]) => [k, conv(v)]));
      st.levelsSPX.last = st.quote.spx;
      if (st.spxDay) Object.assign(st.levelsSPX, { pdh: st.spxDay.pdh, pdl: st.spxDay.pdl, pdc: st.spxDay.pdc, atr: st.spxDay.atr, atrLevels: st.spxDay.atrLevels });
    }

    // plan: pasted in the journal wins over Discord; read Discord 9:15-10:30 until found
    // plans: every post in the plan channel today (every minute 9:15-9:45, every 5 minutes 8:00-15:30) + a pasted one
    const pk = "bot:plans:" + today;
    let plans = (await readJSON(env, pk)) || { posts: [] };
    if (force || (t.min >= 540 && t.min <= 585) || (t.min >= 240 && t.min <= 930 && t.min % 5 === 0)) {
      try {
        const d = await discordPosts(env, today);
        if (d) {
          plans = { posts: d.filter((p) => /Upside:|Downside:/i.test(p.raw)), at: now };
          await writeJSON(env, pk, plans);
          st.trainingPosts = d.filter((p) => TRAINING.test(p.raw) || (p.replyTo && /result/i.test(p.raw)));
        }
      } catch (e) { fail("discord", e); }
    }
    const pasted = await readJSON(env, "bot:plan-raw:" + today);
    const posts = [...plans.posts, ...(pasted ? [{ source: "journal", raw: pasted.text, at: pasted.at }] : [])].sort((a, b) => a.at - b.at);
    const spy = plansByTicker(posts, { SPY: st.levels.pdc }).SPY;
    st.plan = spy ? { source: spy.source, raw: spy.raw, at: spy.at, author: spy.author, parsed: resolvePlan(spy.plan, st.levels, st.ratio) } : null;
    st.planTickers = Object.keys(plansByTicker(posts, {}));

    // #spx-training: every 5 minutes, all recent posts (already-stored ones are skipped)
    if (env.TRAINING_CHANNEL_ID && (force || t.min % 5 === 0)) {
      try {
        const tp = await discordPosts(env, today, env.TRAINING_CHANNEL_ID, true);
        if (tp) st.trainingPosts = [...(st.trainingPosts || []), ...tp.filter((p) => TRAINING.test(p.raw) || p.replyTo || (p.images && p.images.length)).map((p) => ({ ...p, training: true }))];
      } catch (e) { fail("training channel", e); }
    }
    // training posts -> setup library with a snapshot of the market at that moment
    if (st.trainingPosts) {
      try { await captureSetups(env, st, st.trainingPosts); } catch (e) { fail("library", e); }
      delete st.trainingPosts;
    }

    // after the close: review once
    if (t.min >= CLOSE + 5 && rth.length > 300 && st.plan) {
      st.review = reviewPlan(st.plan.parsed, rth, st.levels, st.vix);
      if (st.review) {
        const rv = (await readJSON(env, "bot:reviews")) || { days: {} };
        const c = st.review.checks;
        rv.days[today] = { ok: c.filter((x) => x.ok === true).length, no: c.filter((x) => x.ok === false).length, info: c.filter((x) => x.ok == null).length,
          call: st.review.call || null, put: st.review.put || null, side: st.review.side,
          scenarios: st.review.scenarios.map((x) => ({ dir: x.dir, active: x.active, reached: x.reached.length, targets: x.reached.length + x.missed.length })) };
        await writeJSON(env, "bot:reviews", rv);
      }
    }
  } catch (e) {
    fail(e.login ? "schwab-login" : "run", e);
  }
  try { if (!force) await health(env, st, t, now); } catch (e) {}
  st.updatedAt = now;
  st.updatedET = hhmm(t.min);
  await writeJSON(env, key, st);
  await writeBlob(env, "bot:latest", today);
  return st;
}

const deps = { schwabToken, schwab, history, readJSON, writeJSON, plansByTicker };

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === SIGNALS_CRON) ctx.waitUntil(runSignals(env, deps)
      .then((r) => r && r.paper ? runPaper(env, deps, { ...r.paper, t: et(Date.now()) }) : null)
      .catch((e) => console.error("signals/paper", e)));
    else if (event.cron === GREEKS_CRON) ctx.waitUntil(greekJob(env, deps).catch((e) => console.error("greeks", e)));
    else {
      ctx.waitUntil(run(env));
      // nightly learning run, 4:10-4:30 PM ET (once per day)
      const t = et(Date.now());
      if (t.min >= 970 && t.min <= 990) ctx.waitUntil(runLearning(env, deps, { t }).catch((e) => console.error("learning", e)));
      // daily swing scan (calls only), after the close
      if (t.min >= 975 && t.min <= 995) ctx.waitUntil(runSwing(env, deps, { t }).catch((e) => console.error("swing", e)));
    }
  },
  // private: only with the admin key (for checks and testing)
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!env.BOT_ADMIN_KEY || req.headers.get("x-bot-key") !== env.BOT_ADMIN_KEY) return new Response("Not found", { status: 404 });
    const json = (o) => new Response(JSON.stringify(o, null, 1), { headers: { "Content-Type": "application/json" } });
    if (url.pathname === "/run") return json(await run(env, { force: true }));
    if (url.pathname === "/cron-test") { const which = url.searchParams.get("job"); try { const r = which === "signals" ? await runSignals(env, deps) : which === "greeks" ? await greekJob(env, deps) : await run(env); return json({ ok: true, skipped: r && r.skipped, errors: r && r.errors, keys: r && Object.keys(r).slice(0, 12) }); } catch (e) { return json({ ok: false, error: e.message, stack: String(e.stack).slice(0, 600) }); } }
    if (url.pathname === "/signals") return json(await runSignals(env, deps, { force: true, dry: url.searchParams.get("send") !== "1", half: +(url.searchParams.get("half") || 0) }));
    if (url.pathname === "/signals/test") return json(await testWebhook(env));
    // replay support (scripts/replay.mjs runs on your computer): past candles through the bot's Schwab login, and saving the results
    if (url.pathname === "/history") return json(await history(await schwabToken(env), Object.fromEntries(url.searchParams)));
    if (url.pathname === "/replay/save" && req.method === "POST") { const body = await req.json(); await writeJSON(env, "bot:replay", { at: Date.now(), ...body }); return json({ ok: true, items: (body.items || []).length }); }
    // learning updates (e.g. what a training PDF added) posted to #signals
    if (url.pathname === "/announce" && req.method === "POST") { const b = await req.json(); const r = await post(env, { title: String(b.title || "📚 Learning update").slice(0, 250), description: String(b.text || "").slice(0, 3900), color: 0x8b5cf6, footer: { text: "bot learning update" } }); return json({ ok: r.ok }); }
    if (url.pathname === "/swing") return json(url.searchParams.get("run") ? await runSwing(env, deps, { t: et(Date.now()) }) : await readJSON(env, "swing:book"));
    if (url.pathname === "/paper") return json({ acct: await readJSON(env, "paper:acct"), model: await readJSON(env, "paper:model"), trades: ((await readJSON(env, "paper:trades")) || { items: [] }).items.slice(-20) });
    if (url.pathname === "/paper/learn") return json(await runLearning(env, deps, { force: true, report: url.searchParams.get("report") === "1", quiet: url.searchParams.get("quiet") === "1", t: et(Date.now()) }));
    if (url.pathname === "/library") return json(await readJSON(env, "lib:setups"));
    if (url.pathname === "/vision-test") {
      const lib = await readJSON(env, "lib:setups");
      const img = url.searchParams.get("url") || (lib && lib.items.filter((x) => x.images && x.images.length).at(-1)?.images[0]);
      try { return json(await readChart(env, img)); } catch (e) { return json({ error: e.message, img }); }
    }
    if (url.pathname === "/stats") return json({ stats: await readJSON(env, "bot:stats"), reviews: await readJSON(env, "bot:reviews") });
    if (url.pathname === "/parse-setup") return json(parseSetup(url.searchParams.get("text") || ""));
    if (url.pathname === "/chainpeek") {
      const token = await schwabToken(env);
      const c = await schwab(token, `/marketdata/v1/chains?symbol=${encodeURIComponent(url.searchParams.get("symbol") || "$SPX")}&strikeCount=4&fromDate=${et(Date.now()).date}&toDate=${new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10)}`);
      const m = c.callExpDateMap || {};
      const out = {};
      for (const e of Object.keys(m)) { const k = Object.keys(m[e])[1] || Object.keys(m[e])[0]; out[e] = m[e][k][0]; }
      return json({ underlyingPrice: c.underlyingPrice, volatility: c.volatility, sample: out });
    }
    if (url.pathname === "/greeks") { const g = await greekJob(env, deps, { force: true }); return json({ ...g, strikes: g.strikes && g.strikes.filter((r) => Math.abs(r.strike - g.spot) < 40) }); }
    if (url.pathname === "/signals/today") return json(await readJSON(env, "sig:day:" + et(Date.now()).date));
    if (url.pathname === "/state") return json(await readJSON(env, "bot:day:" + (url.searchParams.get("date") || et(Date.now()).date)));
    if (url.pathname === "/osc") {
      // Phase Oscillator on SPY at a given time, to compare with thinkorswim: ?tf=10|60&rth=1&until=<ms>
      const token = await schwabToken(env);
      const tf = +(url.searchParams.get("tf") || 10), rth = url.searchParams.get("rth") === "1";
      const until = +(url.searchParams.get("until") || Date.now());
      let bars = await history(token, { symbol: url.searchParams.get("symbol") || "SPY", frequencyType: "minute", frequency: tf >= 30 ? "30" : String(tf), startDate: String(until - 40 * 864e5), endDate: String(until), needExtendedHoursData: rth ? "false" : "true" });
      if (rth) bars = bars.filter((b) => { const x = et(b.datetime).min; return x >= OPEN && x < CLOSE; });
      if (tf === 60) bars = aggregate(bars.map((b) => (rth ? { ...b, datetime: b.datetime - 30 * 60000 } : b)), 60).map((b) => (rth ? { ...b, datetime: b.datetime + 30 * 60000 } : b));
      bars = bars.filter((b) => b.datetime + tf * 60000 <= until);
      const lb = bars.at(-1) || {};
      return json({ bars: bars.length, last: bars.length ? et(lb.datetime) : null, ohlc: [lb.open, lb.high, lb.low, lb.close], osc: phaseOsc(bars), ribbon: ribbon(bars, [8, 13, 21, 200]) });
    }
    if (url.pathname === "/quote") {
      const token = await schwabToken(env);
      return json(await schwab(token, "/marketdata/v1/quotes?fields=quote,reference&symbols=" + encodeURIComponent(url.searchParams.get("symbols") || "SPY")));
    }
    if (url.pathname === "/discord") {
      const chId = url.searchParams.get("ch") === "training" ? env.TRAINING_CHANNEL_ID : url.searchParams.get("ch") === "signals" ? env.SIGNALS_CHANNEL_ID : env.DISCORD_CHANNEL_ID;
      const r = await fetch(`https://discord.com/api/v10/channels/${chId}/messages?limit=10`, {
        headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (spx-bot, 1.0)" },
      });
      const msgs = await r.json();
      if (url.searchParams.get("perms")) {
        const H = { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } };
        const get = async (p) => (await fetch("https://discord.com/api/v10" + p, H)).json();
        const me = await get("/users/@me");
        const ch = await get(`/channels/${chId}`);
        const member = await get(`/guilds/${ch.guild_id}/members/${me.id}`);
        const roles = await get(`/guilds/${ch.guild_id}/roles`);
        const name = (id) => (roles.find((r) => r.id === id) || {}).name || id;
        const bits = (p) => ({ view: !!(BigInt(p) & 1024n), history: !!(BigInt(p) & 65536n), admin: !!(BigInt(p) & 8n) });
        return json({
          bot: me.username, botId: me.id, channel: ch.name, botRoles: (member.roles || []).map(name), memberError: member.message,
          rolePerms: roles.filter((r) => r.name === "@everyone" || (member.roles || []).includes(r.id)).map((r) => ({ role: r.name, ...bits(r.permissions) })),
          overwrites: (ch.permission_overwrites || []).map((o) => ({ who: o.type === 1 ? (o.id === me.id ? "THE BOT" : "member " + o.id) : name(o.id), allow: bits(o.allow), deny: bits(o.deny) })),
        });
      }
      if (url.searchParams.get("channel")) {
        const c = await (await fetch(`https://discord.com/api/v10/channels/${chId}`, { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN } })).json();
        return json({ name: c.name, type: c.type, last_message_id: c.last_message_id, guild: c.guild_id, count: Array.isArray(msgs) ? msgs.length : msgs });
      }
      return json(Array.isArray(msgs) ? msgs.map((m) => ({ at: m.timestamp, et: et(Date.parse(m.timestamp)), author: m.author && m.author.username, len: (m.content || "").length, start: (m.content || "").slice(0, 60), embeds: (m.embeds || []).length, attachments: (m.attachments || []).length })) : msgs);
    }
    if (url.pathname === "/atr") {
      // ATR levels as they were on given dates, to compare with thinkorswim
      const daily = await readJSON(env, "bot:daily");
      const dates = (url.searchParams.get("dates") || "").split(",").filter(Boolean);
      return json(dates.map((d) => ({ date: d, ...dayLevels(daily ? daily.candles : [], d) })));
    }
    return new Response("Not found", { status: 404 });
  },
};
