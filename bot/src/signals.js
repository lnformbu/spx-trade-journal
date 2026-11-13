// Signal scanner, 9:30-16:00 ET (own cron; half the tickers each minute = every ticker every 2 minutes):
//   (whale prints are not posted; they feed the options-flow check)
//   📈 large moves   ±1/±2 ATR from yesterday's close, or half an ATR in 15 minutes
//   🚀 momentum      fresh key-level break with VWAP, 3m Saty cloud and volume agreeing
//   🗺️ your plan     trigger crossed / failed, scenario set up, targets reached (any ticker you post a plan for)
//   ⭐ A / A+        Candlestick Bible pattern at a Saty level + 3m/10m Saty cloud + Phase Oscillator + VWAP + volume + options flow + your plan
// Posts to #signals (bot login, or a webhook if SIGNALS_WEBHOOK is set).
import { et, hhmm, OPEN, CLOSE, dayLevels, aggregate, ema, intradayLevels, ribbon, phaseOsc, modeLevels, cloud2021, compressionBox, volumeStack, avwap, dtrPct, dailyDate, chop, vwapCrosses, divergence } from "./levels.js";
import { etToMs } from "./time.js";
import { resolvePlan, LEVEL_NAMES } from "./plan.js";
import { patterns, atLevel } from "./patterns.js";
import { famOf } from "./learn.js";

export const TICKERS = ["SPY", "$SPX", "TSLA", "MU", "META", "AVGO", "SPCX", "MSTR", "GOOGL", "AAPL"];
const show = (s) => s.replace("$", "");
const big = (s) => s === "SPY" || s === "$SPX";
const WHALE_MIN = (s) => (big(s) ? 500000 : 250000);
const FLOW_MIN = (s) => (big(s) ? 100000 : 50000);        // prints that count toward options flow
const FLOW_STRONG = (s) => (big(s) ? 1000000 : 300000);   // net premium bought in 30 min that counts as "flow agrees"
const MAX_PER_TICKER_HOUR = 4;
const r2 = (x) => Math.round(x * 100) / 100;
const money = (x) => (Math.abs(x) >= 1e6 ? "$" + (x / 1e6).toFixed(2) + "M" : "$" + Math.round(x / 1000) + "k");
const COLORS = { whale: 0x8b5cf6, big: 0xf0b429, bull: 0x2ec26b, bear: 0xf0556b, plan: 0x3b82f6, star: 0xffd700 };
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function post(env, embed) {
  if (env.SIGNALS_WEBHOOK) {
    return fetch(env.SIGNALS_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "Signals", embeds: [embed] }) });
  }
  return fetch(`https://discord.com/api/v10/channels/${env.SIGNALS_CHANNEL_ID}/messages`, {
    method: "POST",
    headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "Content-Type": "application/json", "User-Agent": "DiscordBot (spx-bot, 1.0)" },
    body: JSON.stringify({ embeds: [embed] }),
  });
}

function contracts(chain) {
  const out = [];
  for (const map of [chain.callExpDateMap, chain.putExpDateMap]) {
    for (const exp in map || {}) for (const k in map[exp]) for (const o of map[exp][k]) out.push({ ...o, exp: exp.split(":")[0] });
  }
  return out;
}
const fmtC = (o) => `${o.strikePrice}${o.putCall === "CALL" ? "c" : "p"} ${o.exp.slice(5)} ~ $${r2(o.mark)}`;
// contract idea: nearest expiry, delta closest to 0.40 in the trade's direction
function idea(list, dir) {
  const side = list.filter((o) => o.putCall === (dir === "bull" ? "CALL" : "PUT") && o.mark > 0 && o.delta != null);
  if (!side.length) return null;
  const exp = side.map((o) => o.exp).sort()[0];
  const best = side.filter((o) => o.exp === exp).sort((a, b) => Math.abs(Math.abs(a.delta) - 0.4) - Math.abs(Math.abs(b.delta) - 0.4))[0];
  return best ? `${fmtC(best)} (Δ ${Math.abs(best.delta).toFixed(2)})` : null;
}
// your posted contract (nearest expiry with that strike)
function posted(list, strike, type) {
  return list.filter((o) => o.putCall === type && Math.abs(o.strikePrice - strike) < 0.01).sort((a, b) => (a.exp < b.exp ? -1 : 1))[0] || null;
}
// SPX 0DTE contract quote, for SPX|SPY plans (strikes are SPX, prices tracked on SPY)
async function spxContract(schwab, token, date, strike, type) {
  const sym = `SPXW  ${date.slice(2).replace(/-/g, "")}${type === "CALL" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
  const q = await schwab(token, "/marketdata/v1/quotes?fields=quote&symbols=" + encodeURIComponent(sym)).catch(() => ({}));
  const x = q[sym] && q[sym].quote;
  return x ? `SPX ${strike}${type === "CALL" ? "c" : "p"} 0DTE ~ $${r2(x.mark ?? x.lastPrice)}` : `SPX ${strike}${type === "CALL" ? "c" : "p"}`;
}

// A signal wins when price reaches its target before its stop (no target = 2R). A bar touching both counts as the stop.
// A+/A setups must first trigger (1m beyond the signal candle) within 9 minutes. Still open after 60 minutes or at 15:55 = closed at the last price.
export function resolveTracks(st, sym, rth, now, t) {
  const out = [];
  for (const tr of (st.track || []).filter((x) => x.sym === sym && !x.done)) {
    const risk = Math.abs(tr.entry - tr.stop);
    if (!(risk > 0)) { tr.done = true; continue; }
    const bull = tr.dir === "bull";
    const target = tr.target != null && (bull ? tr.target > tr.entry : tr.target < tr.entry) ? tr.target : bull ? tr.entry + 2 * risk : tr.entry - 2 * risk;
    let entered = tr.needTrigger ? null : tr.at, res = null, mfe = 0, mae = 0;
    for (const c of rth) {
      if (c.datetime + 60000 <= tr.at) continue;
      if (!entered) {
        if (c.datetime > tr.at + 9 * 60000) { res = { outcome: "not triggered", R: null }; break; }
        if (bull ? c.high >= tr.entry : c.low <= tr.entry) entered = c.datetime; else continue;
      }
      mfe = Math.max(mfe, bull ? c.high - tr.entry : tr.entry - c.low);
      mae = Math.max(mae, bull ? tr.entry - c.low : c.high - tr.entry);
      if (bull ? c.low <= tr.stop : c.high >= tr.stop) { res = { outcome: "stop", R: -1 }; break; }
      if (bull ? c.high >= target : c.low <= target) { res = { outcome: "target", R: Math.abs(target - tr.entry) / risk }; break; }
    }
    const last = rth[rth.length - 1];
    if (!res && entered && last && (now - tr.at > 60 * 60000 || t.min >= CLOSE - 5)) res = { outcome: "time", R: ((bull ? 1 : -1) * (last.close - tr.entry)) / risk };
    if (!res && !entered && now - tr.at > 10 * 60000) res = { outcome: "not triggered", R: null };
    if (res) {
      tr.done = true;
      out.push({ ...tr, target, outcome: res.outcome, R: res.R == null ? null : r2(res.R), mfeR: r2(mfe / risk), maeR: r2(mae / risk) });
    }
  }
  st.track = (st.track || []).filter((x) => !x.done);
  return out;
}

export async function runSignals(env, deps, { force = false, dry = false, half = null } = {}) {
  const { schwabToken, schwab, history, readJSON, writeJSON, plansByTicker } = deps;
  const now = Date.now();
  const t = et(now);
  if (!force && (t.wd === "Sat" || t.wd === "Sun" || t.min < OPEN || t.min > CLOSE)) return { skipped: "market closed" };
  const key = "sig:day:" + t.date;
  const st = (await readJSON(env, key)) || { date: t.date, alerts: [], fired: {}, vol: {}, daily: {}, flow: {}, planSt: {} };
  st.flow = st.flow || {}; st.planSt = st.planSt || {};
  const minuteNo = Math.floor(now / 60000);
  // half the tickers per run (Cloudflare's free plan allows 50 data calls per run)
  const group = TICKERS.filter((_, i) => i % 2 === (half ?? minuteNo % 2));
  const token = await schwabToken(env);
  const quotes = await schwab(token, "/marketdata/v1/quotes?fields=quote&symbols=" + [...new Set([...group, "SPY", "$SPX"])].map(encodeURIComponent).join(","));
  const ratio = quotes.SPY && quotes.$SPX ? quotes.$SPX.quote.lastPrice / quotes.SPY.quote.lastPrice : null;

  // today's plans from the plan channel (+ a plan pasted in the journal)
  const pl = (await readJSON(env, "bot:plans:" + t.date)) || { posts: [] };
  const pasted = await readJSON(env, "bot:plan-raw:" + t.date);
  const posts = [...pl.posts, ...(pasted ? [{ source: "journal", raw: pasted.text, at: pasted.at }] : [])].sort((a, b) => a.at - b.at);
  const refs = Object.fromEntries(Object.entries(quotes).map(([s, v]) => [s, v.quote && v.quote.lastPrice]));
  const plans = plansByTicker(posts, refs);

  const found = [];
  const errors = [];
  const resolved = [];

  // ---- VIX on 10m (inverse of SPX): cloud, oscillator, last two 10m closes; refreshed every 10 minutes ----
  try {
    if (!st.vix10 || t.min % 10 < 2 || force) {
      const v5 = await history(token, { symbol: "$VIX", frequencyType: "minute", frequency: "5", startDate: String(now - 5 * 864e5), endDate: String(now) });
      const v10 = aggregate(v5, 10).filter((b) => b.datetime + 600000 <= now);
      const o = phaseOsc(v10);
      st.vix10 = v10.length > 1 ? { rib: ribbon(v10), osc: o && { ...o, _track: undefined, _osc: undefined }, last: v10.at(-1).close, prev: v10.at(-2).close, at: now } : st.vix10;
    }
    const vkey = plans.SPY && plans.SPY.plan.vixKey;
    const V = st.vix10;
    if (V && vkey != null && ((V.prev <= vkey && V.last > vkey) || (V.prev >= vkey && V.last < vkey))) {
      const up = V.last > vkey;
      found.push({
        kind: "plan", sym: "$VIX", key: `vixkey:${vkey}:${up}:${Math.floor(now / 600000)}`, once: true, color: up ? COLORS.bear : COLORS.bull,
        title: `📉 VIX crossed your key ${vkey} ${up ? "↑ (bearish for SPX)" : "↓ (bullish for SPX)"}`,
        text: `VIX 10m close ${V.last} (was ${V.prev}). VIX 10m cloud ${V.rib ? V.rib.state : "—"}, phase ${V.osc ? V.osc.value : "—"}.`,
      });
    }
  } catch (e) { errors.push("VIX: " + e.message); }
  // VIX agrees with a direction when it moves the other way (inverse of the market)
  const vixAgrees = (dir) => {
    const V = st.vix10;
    if (!V) return null;
    const falling = (V.rib && V.rib.state === "bearish") || V.last < V.prev;
    const rising = (V.rib && V.rib.state === "bullish") || V.last > V.prev;
    return dir === "bull" ? falling && !(V.rib && V.rib.state === "bullish") : rising && !(V.rib && V.rib.state === "bearish");
  };
  st.chop = st.chop || {};
  const G = await readJSON(env, "greeks:spx");
  const GX = G && G.date === t.date ? G : null;

  for (const sym of group) {
    try {
      const q = quotes[sym] && quotes[sym].quote;
      if (!q) continue;
      const price = q.lastPrice;
      if (!st.daily[sym]) {
        const d = await history(token, { symbol: sym, periodType: "year", period: "1", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
        const dl = dayLevels(d, t.date);
        const mo = await history(token, { symbol: sym, periodType: "year", period: "5", frequencyType: "monthly", frequency: "1", needExtendedHoursData: "false" });
        st.daily[sym] = dl && {
          ...dl,
          cloudD: cloud2021(d.filter((c) => dailyDate(c) < t.date)),
          swing: modeLevels(mo.filter((c) => dailyDate(c).slice(0, 7) < t.date.slice(0, 7))),
        };
      }
      const D = st.daily[sym];
      if (!D) continue;
      const lv = D.atrLevels;

      // ---- options chain: whales + options flow ----
      const toDate = big(sym) ? t.date : isoDay(now + 8 * 864e5);
      const chain = await schwab(token, `/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}&strikeCount=16&fromDate=${t.date}&toDate=${toDate}`);
      const list = contracts(chain);
      const prev = st.vol[sym];
      const cur = {};
      const flow = (st.flow[sym] || []).filter((f) => now - f.at < 60 * 60000);
      for (const o of list) {
        cur[o.symbol] = o.totalVolume;
        if (!prev || prev[o.symbol] == null) continue;
        const dv = o.totalVolume - prev[o.symbol];
        const px = o.last || o.mark;
        const prem = dv * px * 100;
        if (dv <= 0 || prem < FLOW_MIN(sym)) continue;
        const spread = o.ask - o.bid;
        const atAsk = spread > 0 && px >= o.ask - spread * 0.25, atBid = spread > 0 && px <= o.bid + spread * 0.25;
        // bought calls / sold puts = bullish; bought puts / sold calls = bearish
        const dir = atAsk ? (o.putCall === "CALL" ? "bull" : "bear") : atBid ? (o.putCall === "CALL" ? "bear" : "bull") : null;
        if (dir) flow.push({ at: now, dir, prem: Math.round(prem) });
        // whale prints are no longer posted; their premium is already in the options-flow total above (A/A+ scores use it)
      }
      st.vol[sym] = cur;
      st.flow[sym] = flow;
      const net30 = flow.filter((f) => now - f.at < 30 * 60000).reduce((s, f) => s + (f.dir === "bull" ? f.prem : -f.prem), 0);

      // ---- 1-minute bars today ----
      const m1 = await history(token, { symbol: sym, frequencyType: "minute", frequency: "1", startDate: String(now - (t.min + 1) * 60000), endDate: String(now) });
      const done = m1.filter((c) => c.datetime + 60000 <= now);
      const rows = done.map((c) => ({ ...c, t: et(c.datetime) })).filter((c) => c.t.date === t.date);
      const rth = rows.filter((c) => c.t.min >= OPEN && c.t.min < CLOSE);
      const intra = intradayLevels(done, t.date, null);
      const L = { pdh: D.pdh, pdl: D.pdl, pdc: D.pdc, atr: D.atr, atrLevels: lv, ...intra };
      const c0 = rth.length ? rth[rth.length - 1].close : price;
      const c3 = rth.length ? rth[Math.max(0, rth.length - 4)].close : price;
      if (!dry) resolved.push(...resolveTracks(st, sym, rth, now, t));

      // ---- large moves ----
      for (const [k, name] of [["+1", "+1 ATR"], ["-1", "−1 ATR"], ["+2", "+2 ATR"], ["-2", "−2 ATR"]]) {
        if (k[0] === "+" ? price >= lv[k] : price <= lv[k]) found.push({
          kind: "big", sym, key: `big:${sym}:${k}`, once: true, color: COLORS.big,
          title: `📈 LARGE MOVE ${show(sym)} hit ${name}`,
          text: `${show(sym)} ${r2(price)} reached ${name} (${lv[k]}) from yesterday's close ${D.pdc}. Daily ATR $${D.atr}.`,
        });
      }
      if (rth.length > 15) {
        const a = rth[rth.length - 16].close;
        if (Math.abs(c0 - a) >= D.atr * 0.5) found.push({
          kind: "big", sym, key: `fast:${sym}`, cooldown: 30, color: COLORS.big,
          title: `📈 FAST MOVE ${show(sym)} ${c0 > a ? "up" : "down"} ${r2(Math.abs(c0 - a))} in 15 min`,
          text: `${show(sym)} ${r2(a)} → ${r2(c0)}: ${Math.round((Math.abs(c0 - a) / D.atr) * 100)}% of the daily ATR in 15 minutes.`,
        });
      }

      // ---- shared context: Saty cloud (8/13/21/200) on 3m (scalp, ETH) and 10m (day, ETH), Phase Oscillator, VWAP, volume ----
      const side = (r) => (r && r.state === "bullish" ? "bull" : r && r.state === "bearish" ? "bear" : null);
      const b3 = aggregate(rows, 3).filter((b) => b.datetime + 180000 <= now);
      const rib3 = b3.length >= 21 ? ribbon(b3) : null;
      const osc3 = phaseOsc(b3);
      const box3 = osc3 ? compressionBox(b3, osc3._track) : null;
      // 10m: from 5-minute bars over 5 days, refreshed every 10 minutes
      st.tf10 = st.tf10 || {};
      if (!st.tf10[sym] || t.min % 10 < 2 || force) {
        // 5-minute bars back to the anchored-VWAP date (at least 5 days): 10m cloud/oscillator/box, AVWAP, hourly 20/21
        const [ad, atm] = String(env.AVWAP_ANCHOR || "").split(" ");
        const anchor = ad ? etToMs(ad, atm || "09:30") : null;
        const m5 = await history(token, { symbol: sym, frequencyType: "minute", frequency: "5", startDate: String(Math.min(anchor || now, now - 5 * 864e5)), endDate: String(now) });
        const b10 = aggregate(m5, 10).filter((b) => b.datetime + 600000 <= now);
        const o10 = phaseOsc(b10);
        st.tf10[sym] = {
          rib: ribbon(b10), osc: o10 && { ...o10, _track: undefined, _osc: undefined }, box: o10 ? compressionBox(b10, o10._track) : null,
          lastClose: b10.length ? b10[b10.length - 1].close : null, prevClose: b10.length > 1 ? b10[b10.length - 2].close : null,
          avwap: anchor ? avwap(m5, anchor) : null,
          cloudH: cloud2021(aggregate(m5, 60).filter((b) => b.datetime + 3600000 <= now)),
          chop: chop(b10),
        };
      }
      const T10 = st.tf10[sym];
      const rib10 = T10.rib, osc10 = T10.osc, AV = T10.avwap, SW = D.swing;
      const dtr = dtrPct(intra.hod, intra.lod, D.atr, D.pdc);

      // ---- choppy-day guard: Choppiness Index > 61.8 on 10m AND (cloud flipping or 4+ VWAP crosses in the last hour) ----
      const crosses = rth.length > 20 ? vwapCrosses(rth, 60) : 0;
      const choppy = T10.chop != null && T10.chop > 61.8 && ((rib10 && rib10.flips >= 2) || crosses >= 4);
      const was = st.chop[sym];
      if (rth.length > 30 && choppy !== !!(was && was.on) && !(was && now - was.at < 30 * 60000)) {
        st.chop[sym] = { on: choppy, at: now };
        found.push({
          kind: "chop", sym, key: `chop:${sym}:${choppy}:${Math.floor(now / 1800000)}`, once: true, color: choppy ? COLORS.big : COLORS.bull,
          title: choppy ? `⚠️ CHOP ${show(sym)}: choppy conditions` : `✅ ${show(sym)}: trend back (chop cleared)`,
          text: choppy
            ? `Choppiness ${T10.chop} (10m), 10m cloud flips ${rib10 ? rib10.flips : "—"} in 6 bars, ${crosses} VWAP crosses in the last hour. Only A+ setups until it clears; no momentum alerts.`
            : `Choppiness ${T10.chop}, ${crosses} VWAP crosses in the last hour. Normal alerts resume.`,
        });
      }
      let scalpDir = side(rib3), vwap = intra.vwap, surge = null;
      if (rth.length >= 10) {
        const last5 = rth.slice(-5).reduce((s, c) => s + c.volume, 0);
        const before = rth.slice(0, -5);
        const avg5 = before.length ? (before.reduce((s, c) => s + c.volume, 0) / before.length) * 5 : 0;
        surge = sym === "$SPX" || !avg5 ? null : last5 / avg5;
      }
      const keyLevels = [
        ["ORB high", intra.orbh], ["ORB low", intra.orbl], ["yesterday's high", D.pdh], ["yesterday's low", D.pdl], ["PDC", D.pdc],
        ["premarket high", intra.pmh], ["premarket low", intra.pml], ["VWAP", vwap],
        ...Object.entries(lv).filter(([k]) => Math.abs(+k) <= 2).map(([k, v]) => [LEVEL_NAMES[k] || `ATR ${k[0] === "+" ? "+" : "−"}${(+k.slice(1) * 100).toFixed(1)}%`, v]),
        ...(AV ? [["anchored VWAP", AV.vwap], ["AVWAP +1σ", AV.up1], ["AVWAP −1σ", AV.dn1], ["AVWAP +2σ", AV.up2], ["AVWAP −2σ", AV.dn2]] : []),
        ...(SW ? [["Swing call trigger", SW.atrLevels["+0.236"]], ["Swing put trigger", SW.atrLevels["-0.236"]]] : []),
      ];
      // SPX gamma levels (call wall, put wall, flip, Eye of Sauron, biggest nodes); SPY gets them divided by the SPX/SPY ratio
      const gconv = sym === "$SPX" ? 1 : sym === "SPY" && ratio ? 1 / ratio : null;
      if (GX && gconv) {
        const add = (name, v) => v != null && keyLevels.push([name, r2(v * gconv)]);
        add("GEX call wall " + GX.callWall, GX.callWall); add("GEX put wall " + GX.putWall, GX.putWall); add("gamma flip", GX.flip);
        if (GX.eye) add("Eye of Sauron " + GX.eye.strike, GX.eye.strike);
        [...GX.strikes].sort((a, b) => Math.abs(b.gex) - Math.abs(a.gex)).slice(0, 3).forEach((r) => add(`GEX node ${r.strike}`, r.strike));
      }

      // ---- momentum (not on choppy days) ----
      if (rth.length >= 10 && !choppy) {
        const levels = [
          ["ORB high", intra.orbh, "bull"], ["ORB low", intra.orbl, "bear"], ["yesterday's high", D.pdh, "bull"], ["yesterday's low", D.pdl, "bear"],
          ["ATR call trigger", lv["+0.236"], "bull"], ["ATR put trigger", lv["-0.236"], "bear"], ["ATR upper midrange", lv["+0.618"], "bull"], ["ATR lower midrange", lv["-0.618"], "bear"],
        ];
        for (const [name, lvl, dir] of levels) {
          if (lvl == null) continue;
          const broke = dir === "bull" ? c3 <= lvl && c0 > lvl : c3 >= lvl && c0 < lvl;
          if (!broke || scalpDir !== dir || !(vwap == null || (dir === "bull" ? c0 > vwap : c0 < vwap)) || !(surge == null || surge >= 2)) continue;
          const next = Object.values(lv).filter((v) => (dir === "bull" ? v > c0 : v < c0)).sort((x, y) => (dir === "bull" ? x - y : y - x))[0];
          found.push({
            kind: "momentum", sym, key: `mom:${sym}:${name}`, once: true, color: COLORS[dir],
            track: { dir, entry: c0, stop: lvl, target: next ?? null },
            title: `🚀 MOMENTUM ${show(sym)} ${dir === "bull" ? "CALLS" : "PUTS"}: broke ${name}`,
            text: `${show(sym)} ${r2(c0)} broke ${name} ${r2(lvl)}${surge ? ` on ${surge.toFixed(1)}× volume` : ""}, ${dir === "bull" ? "above" : "below"} VWAP ${vwap ?? "—"}, 3m cloud ${dir === "bull" ? "bullish" : "bearish"}, 10m cloud ${rib10 ? rib10.state : "—"}, 10m phase ${osc10 ? osc10.value : "—"}.`
              + `\nNext ATR level ${next ?? "—"} · invalid back ${dir === "bull" ? "below" : "above"} ${r2(lvl)}${idea(list, dir) ? `\nContract idea: ${show(sym)} ${idea(list, dir)}` : ""}`,
          });
        }
      }

      // ---- Phase Oscillator flip out of oversold/overbought (10m, day mode) near a key level; squeeze firing ----
      const near = (tol) => keyLevels.filter(([, v]) => v != null && Math.abs(v - c0) <= tol).sort((a, b) => Math.abs(a[1] - c0) - Math.abs(b[1] - c0))[0];
      if (osc10 && osc10.cross) {
        const dir = osc10.flip.startsWith("oversold") ? "bull" : "bear";
        const lvlNear = near(D.atr * 0.1);
        found.push({
          kind: "phase", sym, key: `flip:${sym}:${dir}:${Math.floor(now / 600000)}`, once: true, color: COLORS[dir],
          track: { dir, entry: c0, stop: dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: dir === "bull" ? c0 + D.atr * 0.3 : c0 - D.atr * 0.3 },
          title: `🔄 PHASE ${show(sym)}: ${osc10.cross} (10m)`,
          text: `Phase Oscillator ${osc10.prev} → ${osc10.value}${lvlNear ? `, at ${lvlNear[0]} ${r2(lvlNear[1])}` : ""}. 10m cloud ${rib10 ? rib10.state : "—"}, 3m cloud ${rib3 ? rib3.state : "—"}.`
            + `\n${show(sym)} ${r2(c0)} · wait for a 3m candle confirmation${idea(list, dir) ? `\nContract idea: ${show(sym)} ${idea(list, dir)}` : ""}`,
        });
      }
      if (osc10 && osc10.squeezeFired && side(rib10)) {
        const dir = side(rib10);
        found.push({
          kind: "phase", sym, key: `squeeze:${sym}:${Math.floor(now / 600000)}`, once: true, color: COLORS[dir],
          track: { dir, entry: c0, stop: dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: dir === "bull" ? c0 + D.atr * 0.3 : c0 - D.atr * 0.3 },
          title: `🗜️ SQUEEZE FIRED ${show(sym)} ${dir === "bull" ? "UP" : "DOWN"} (10m)`,
          text: `Compression just ended with the 10m cloud ${rib10.state}; phase ${osc10.value}. ${show(sym)} ${r2(c0)}, VWAP ${vwap ?? "—"}.`,
        });
      }

      // ---- Compression Bangerz: 10m close breaks out of the compression box ----
      const B = T10.box;
      if (B && T10.lastClose != null && T10.prevClose != null) {
        const up = T10.prevClose <= B.high && T10.lastClose > B.high, dn = T10.prevClose >= B.low && T10.lastClose < B.low;
        if (up || dn) {
          const dir = up ? "bull" : "bear";
          found.push({
            kind: "phase", sym, key: `box:${sym}:${B.from}:${dir}`, once: true, color: COLORS[dir],
            title: `📦 COMPRESSION BREAKOUT ${show(sym)} ${up ? "UP" : "DOWN"} (10m)`,
            track: { dir, entry: T10.lastClose, stop: B.mid, target: null },
            text: `10m closed ${T10.lastClose} ${up ? "above" : "below"} the compression box ${B.low}–${B.high} (mid ${B.mid}). 10m cloud ${rib10 ? rib10.state : "—"}, phase ${osc10 ? osc10.value : "—"}.${idea(list, dir) ? `
Contract idea: ${show(sym)} ${idea(list, dir)}` : ""}`,
          });
        }
      }

      // ---- SPX scalp setups (your list): 1m/3m divergence, 1m/3m compression breakouts, Eye of Sauron, LB max pain ----
      if (sym === "$SPX") {
        const b1 = rows.filter((c) => c.t.min >= OPEN - 60);
        const o1 = phaseOsc(b1), o3 = osc3;
        for (const [tf, bars, o] of [["1m", b1, o1], ["3m", b3, o3]]) {
          if (!o) continue;
          const dv = divergence(bars, o._osc);
          if (dv) found.push({
            kind: "setup", sym, key: `div:${tf}:${dv.at}`, once: true, color: COLORS[dv.dir],
            track: { dir: dv.dir, entry: c0, stop: dv.dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: null },
            title: `📐 SPX ${tf} ${dv.dir === "bull" ? "BULLISH" : "BEARISH"} DIVERGENCE`,
            text: `${dv.text}. SPX ${r2(c0)}. Look for a ${tf === "1m" ? "1m" : "3m"} candle confirmation at a level.`,
          });
          const bx = compressionBox(bars, o._track);
          const lc = bars.at(-1), pc = bars.at(-2);
          if (bx && lc && pc && ((pc.close <= bx.high && lc.close > bx.high) || (pc.close >= bx.low && lc.close < bx.low))) {
            const up = lc.close > bx.high;
            found.push({
              kind: "setup", sym, key: `cbox:${tf}:${bx.from}:${up}`, once: true, color: up ? COLORS.bull : COLORS.bear,
              track: { dir: up ? "bull" : "bear", entry: lc.close, stop: bx.mid, target: null },
              title: `📦 SPX ${tf} COMPRESSION BREAKOUT ${up ? "UP" : "DOWN"}`,
              text: `${tf} closed ${r2(lc.close)} ${up ? "above" : "below"} the compression box ${bx.low}–${bx.high}.`,
            });
          }
        }
        if (GX && GX.eye && Math.abs(c0 - GX.eye.strike) / c0 <= 0.0015) found.push({
          kind: "setup", sym, key: `eye:${GX.eye.strike}`, cooldown: 30, color: COLORS.big,
          title: `👁️ EYE OF SAURON ${GX.eye.strike} nearby`,
          text: `Big negative-gamma node ${GX.eye.strike} (GEX ${money(GX.eye.gex)}), SPX ${r2(c0)}: magnet first, then often a violent rejection. Wait for the reaction candle.`,
        });
        if (GX && GX.lb && GX.lb.maxPainZone && t.min >= 950 && t.min <= 955) found.push({
          kind: "setup", sym, key: `maxpain:${t.date}`, once: true, color: COLORS.star,
          title: `🎯 LB max pain into the close: ${GX.lb.maxPainZone.low}–${GX.lb.maxPainZone.high}`,
          text: `Spot range that pays the leaderboard's in-the-money holders the least (best ${GX.lb.maxPain}). SPX ${r2(c0)}.`,
        });
      }

      // ---- your plan for this ticker (an SPX|SPY plan is tracked on SPY prices, under SPX) ----
      const P = plans[sym] && resolvePlan(plans[sym].plan, L, ratio);
      const ps = (st.planSt[sym] = st.planSt[sym] || {});
      let planSide = null;
      if (P && rth.length) {
        const spxPlan = sym === "SPY" && (P.spxCall || P.spxPut);
        const name = spxPlan ? "SPX" : show(sym);
        const asSpx = (v) => (spxPlan && ratio ? ` (SPX ~${Math.round(v * ratio)})` : "");
        const contract = async (dir) => {
          if (spxPlan) return spxContract(schwab, token, t.date, dir === "bull" ? P.spxCall : P.spxPut, dir === "bull" ? "CALL" : "PUT");
          const o = posted(list, dir === "bull" ? P.callTrigger : P.putTrigger, dir === "bull" ? "CALL" : "PUT");
          return o ? `${name} ${fmtC(o)}` : null;
        };
        planSide = P.callTrigger != null && c0 > P.callTrigger ? "bull" : P.putTrigger != null && c0 < P.putTrigger ? "bear" : null;
        for (const [dir, trig] of [["bull", P.callTrigger], ["bear", P.putTrigger]]) {
          if (trig == null) continue;
          const crossed = dir === "bull" ? c3 <= trig && c0 > trig : c3 >= trig && c0 < trig;
          if (crossed && !ps[dir]) {
            ps[dir] = { at: now, trig };
            const c = await contract(dir);
            found.push({
              kind: "plan", sym, key: `plan:${sym}:${dir}`, once: true, color: COLORS[dir],
              track: { dir, entry: c0, stop: dir === "bull" ? trig * 0.9985 : trig * 1.0015, target: null },
              title: `🗺️ ${name} crossed your ${dir === "bull" ? "CALL" : "PUT"} trigger ${trig}${asSpx(trig)}`,
              text: `${show(sym)} ${r2(c0)}, ${dir === "bull" ? "above" : "below"} your trigger. VWAP ${vwap ?? "—"}, 3m cloud ${rib3 ? rib3.state : "—"}, 10m cloud ${rib10 ? rib10.state : "—"}, options flow ${money(net30)} net ${net30 >= 0 ? "bullish" : "bearish"} (30 min).${c ? `\nYour contract: ${c}` : ""}`,
            });
          }
          const back = dir === "bull" ? c0 < trig * 0.9985 : c0 > trig * 1.0015;
          if (ps[dir] && !ps[dir].failed && back) {
            ps[dir].failed = now;
            found.push({
              kind: "plan", sym, key: `planfail:${sym}:${dir}`, once: true, color: COLORS.big,
              title: `⚠️ ${name} ${dir === "bull" ? "call" : "put"} trigger ${trig} FAILED`,
              text: `${show(sym)} back ${dir === "bull" ? "below" : "above"} ${trig} at ${r2(c0)}. Protect open trades from this trigger.`,
            });
          }
        }
        P.scenarios.forEach((s, i) => {
          if (!s.dir || s.level == null) return;
          const sk = `scn${i}`;
          const beyond = s.dir === "bull" ? c0 > s.level : c0 < s.level;
          if (beyond && !ps[sk]) {
            ps[sk] = { at: now, hit: [] };
            found.push({
              kind: "plan", sym, key: `plan:${sym}:${sk}`, once: true, color: COLORS[s.dir],
              title: `🗺️ ${name} scenario set up: ${s.dir === "bull" ? "▲" : "▼"} ${s.dir === "bull" ? "above" : "below"} ${s.level}${asSpx(s.level)}`,
              text: `"${s.text.slice(0, 180)}"\nTargets: ${s.targets.map((x) => `${x.label} ${x.price ?? "?"}`).join(" › ") || "—"}`,
            });
          }
          if (ps[sk]) s.targets.forEach((x, j) => {
            if (x.price == null || ps[sk].hit.includes(j)) return;
            const hit = s.dir === "bull" ? price >= x.price : price <= x.price;
            if (!hit) return;
            ps[sk].hit.push(j);
            found.push({
              kind: "plan", sym, key: `plantgt:${sym}:${sk}:${j}`, once: true, color: COLORS.star,
              title: `🎯 ${name} target ${j + 1} reached: ${x.label} ${x.price}${asSpx(x.price)}`,
              text: j === 0 ? "Target 1: bank half, move the runner's stop to +30% and let it trail." : `Target ${j + 1}: tighten the runner's trail or take it.`,
            });
          });
        });
      }

      // ---- ⭐ confluence: Candlestick Bible pattern at a Saty level + everything else ----
      const bars3 = aggregate(rth, 3).filter((b) => b.datetime + 180000 <= now);
      for (const pat of patterns(bars3)) {
        const at = atLevel(pat, keyLevels, D.atr * 0.05);
        if (!at) continue;
        const dir = pat.dir;
        const checks = [
          ["Candlestick: " + pat.name + " (3m)", true, 20],
          [`Saty/key level: ${at.name} ${r2(at.v)}`, true, 20],
          [`3m Saty cloud ${rib3 ? rib3.state : "—"} (scalp)`, side(rib3) === dir, 10],
          [`10m Saty cloud ${rib10 ? rib10.state : "—"} (day)`, side(rib10) === dir, 10],
          [`Phase Oscillator 10m ${osc10 ? osc10.value + " " + osc10.zone : "—"}${osc10 && osc10.compression ? ", in compression" : ""}`,
            osc10 ? (osc10.flip ? osc10.flip.startsWith("oversold") === (dir === "bull") : dir === "bull" ? osc10.value < 61.8 : osc10.value > -61.8) : null, 10],
          [`VWAP ${vwap ?? "—"}: price ${c0 > (vwap ?? c0) ? "above" : "below"}`, vwap != null && (dir === "bull" ? c0 > vwap : c0 < vwap), 10],
          [`Volume ${surge ? surge.toFixed(1) + "× normal" : "n/a"}`, surge == null ? null : surge >= 1.5, 10],
          ...(() => { const vs = volumeStack(pat.bar); return vs ? [[`Volume Stack: ${vs.buy}% buyers / ${vs.sell}% sellers`, dir === "bull" ? vs.buy >= 55 : vs.sell >= 55, 10]] : []; })(),
          [`Hourly 20/21 cloud ${T10.cloudH || "—"} · daily ${D.cloudD || "—"}`, T10.cloudH ? T10.cloudH === (dir === "bull" ? "up" : "down") : null, 10],
          [`Room left: ${dtr ?? "—"}% of the daily ATR used`, dtr == null ? null : dtr < 90, 10],
          [`VIX 10m ${st.vix10 ? st.vix10.last + " (" + (st.vix10.last < st.vix10.prev ? "falling" : "rising") + "), cloud " + (st.vix10.rib ? st.vix10.rib.state : "—") : "—"}`, vixAgrees(dir), 10],
          ...(GX && GX.lb && (sym === "$SPX" || sym === "SPY") ? (() => {
            const sh = GX.lb.top.slice(0, 5).filter((c) => c.shakeout && (dir === "bull" ? c.type === "C" : c.type === "P"));
            return [[`LB shakeout: ${sh.length ? sh.map((c) => `${c.label} +${c.pnlPct}% vs VWAP`).join(", ") : "none on this side"}`, sh.length ? true : null, 10]];
          })() : []),
          [`Chop: ${choppy ? "⚠ choppy" : "trending"} (CHOP ${T10.chop ?? "—"}, ${crosses} VWAP crosses/hr)`, !choppy, 10],
          [`Options flow (30 min): ${money(net30)} net ${net30 >= 0 ? "bullish" : "bearish"}`, dir === "bull" ? net30 >= FLOW_STRONG(sym) : -net30 >= FLOW_STRONG(sym), 20],
          [P ? `Your plan: ${planSide ? (planSide === "bull" ? "call side active" : "put side active") : "between your triggers"}` : "Your plan: none for " + show(sym), P ? planSide === dir : null, 10],
        ];
        let score = checks.reduce((s, [, ok, pts]) => s + (ok ? pts : 0), 0);
        // volume unknown (SPX) or no plan: scale the score instead of punishing it
        const possible = checks.reduce((s, [, ok, pts]) => s + (ok === null ? 0 : pts), 0);
        score = Math.round((score / possible) * 100);
        const against = P && planSide && planSide !== dir;
        const grade = score >= 85 && !(against && score < 95) ? "A+" : score >= 70 && !against && !choppy ? "A" : null;
        if (!grade) continue;
        const stop = dir === "bull" ? pat.bar.low : pat.bar.high;
        const next = Object.values(lv).filter((v) => (dir === "bull" ? v > c0 : v < c0)).sort((x, y) => (dir === "bull" ? x - y : y - x))[0];
        const c = P && (dir === "bull" ? P.callTrigger : P.putTrigger) != null
          ? (sym === "SPY" && (P.spxCall || P.spxPut) ? await spxContract(schwab, token, t.date, dir === "bull" ? P.spxCall : P.spxPut, dir === "bull" ? "CALL" : "PUT")
            : (posted(list, dir === "bull" ? P.callTrigger : P.putTrigger, dir === "bull" ? "CALL" : "PUT") && `${show(sym)} ${fmtC(posted(list, dir === "bull" ? P.callTrigger : P.putTrigger, dir === "bull" ? "CALL" : "PUT"))}`))
          : (idea(list, dir) && `${show(sym)} ${idea(list, dir)}`);
        found.push({
          kind: "star", sym, key: `star:${sym}:${pat.bar.datetime}:${dir}`, once: true, color: grade === "A+" ? COLORS.star : COLORS[dir],
          grade, score, track: { dir, entry: dir === "bull" ? pat.bar.high : pat.bar.low, stop, target: next ?? null, needTrigger: true },
          title: `${grade === "A+" ? "⭐ A+" : "✅ A"} ${show(sym)} ${dir === "bull" ? "CALLS" : "PUTS"} · score ${score}`,
          text: checks.map(([txt, ok]) => `${ok === true ? "✓" : ok === false ? "✗" : "·"} ${txt}`).join("\n")
            + `\n**Entry** on a 1m close ${dir === "bull" ? "above" : "below"} ${r2(dir === "bull" ? pat.bar.high : pat.bar.low)} · **stop** beyond ${r2(stop)} · **target** ${next ?? "—"}`
            + (c ? `\nContract: ${c}` : ""),
        });
      }
      // market context of every signal from this ticker (the learning run compares winners and losers by it)
      const gexSide = GX && GX.flip != null && (sym === "$SPX" || (sym === "SPY" && ratio)) ? ((sym === "SPY" ? c0 * ratio : c0) >= GX.flip ? "positive" : "negative") : null;
      for (const f of found) if (f.sym === sym && !f.ctx) f.ctx = {
        chop: choppy, gex: gexSide, vix: f.track ? vixAgrees(f.track.dir) : null,
        plan: P ? (planSide && f.track ? (planSide === f.track.dir ? "with" : "against") : "between") : "none",
      };
    } catch (e) {
      errors.push(`${show(sym)}: ${e.message}`);
    }
  }

  // dedupe, cooldowns, per-ticker hourly cap (whales, plan and A+ alerts are never capped)
  const sent = [];
  const candidates = [];
  for (const a of found) {
    const last = st.fired[a.key];
    if (last && (a.once || now - last < (a.cooldown || 10) * 60000)) continue;
    const lastHour = st.alerts.filter((x) => x.sym === a.sym && (x.kind === "big" || x.kind === "momentum") && now - x.at < 3600e3).length;
    if (lastHour >= MAX_PER_TICKER_HOUR && (a.kind === "big" || a.kind === "momentum")) continue;
    st.fired[a.key] = now;
    const alert = { at: now, et: hhmm(t.min), kind: a.kind, sym: a.sym, title: a.title, text: a.text };
    st.alerts.push(alert);
    if (!dry && a.track && a.track.entry != null && a.track.stop != null && a.track.entry !== a.track.stop) {
      (st.track = st.track || []).push({ ...a.track, key: a.key, sym: a.sym, kind: a.kind, grade: a.grade || null, score: a.score ?? null, ctx: a.ctx || null, title: a.title, at: now, et: hhmm(t.min) });
    }
    // SPX/SPY signals with a stop are paper-trade candidates (SPY prices converted to SPX)
    if (!dry && a.track && a.track.stop != null && (a.sym === "$SPX" || (a.sym === "SPY" && ratio))) {
      const k = a.sym === "SPY" ? ratio : 1, cv = (v) => (v == null ? null : Math.round(v * k * 100) / 100);
      candidates.push({ key: a.key, fam: famOf(a.key), kind: a.kind, grade: a.grade || null, score: a.score ?? null, ctx: a.ctx || null, title: a.title, et: hhmm(t.min), sym: a.sym,
        dir: a.track.dir, uEntry: cv(a.track.entry), uStop: cv(a.track.stop), uTarget: cv(a.track.target), needTrigger: !!a.track.needTrigger });
    }
    sent.push(alert);
    if (!dry) {
      const r = await post(env, { title: a.title, description: a.text, color: a.color, footer: { text: `${hhmm(t.min)} ET · paper-test signal` } })
        .catch((e) => ({ ok: false, status: e.message }));
      if (!r.ok) errors.push("discord post: " + r.status);
    }
  }
  // finished signals go to the bot scorecard (journal: Bot view)
  if (resolved.length) {
    const stats = (await readJSON(env, "bot:stats")) || { items: [] };
    for (const r of resolved) stats.items.push({ date: t.date, sym: r.sym, kind: r.kind, grade: r.grade, title: r.title, dir: r.dir, et: r.et, at: r.at,
      entry: r2(r.entry), stop: r2(r.stop), target: r2(r.target), outcome: r.outcome, R: r.R, mfeR: r.mfeR, maeR: r.maeR, key: r.key, fam: famOf(r.key), score: r.score ?? null, ctx: r.ctx || null });
    stats.items = stats.items.slice(-3000);
    await writeJSON(env, "bot:stats", stats);
  }
  st.errors = errors;
  st.updatedAt = now;
  if (!dry) await writeJSON(env, key, st);
  const planOf = (s) => plans[s] && plans[s].plan;
  const paper = { candidates, spx: quotes.$SPX && quotes.$SPX.quote ? quotes.$SPX.quote.lastPrice : null,
    plan: { call: (planOf("SPY") || {}).spxCall || (planOf("$SPX") || {}).spxCall || null, put: (planOf("SPY") || {}).spxPut || (planOf("$SPX") || {}).spxPut || null } };
  return { group, plans: Object.keys(plans), sent, errors, found: found.length, paper };
}

export async function testWebhook(env) {
  const r = await post(env, { title: "✅ Signals connected", description: "Large moves, momentum, your plans and A/A+ setups for SPY, SPX, TSLA, MU, META, AVGO, SPCX, MSTR, GOOGL, AAPL will post here during market hours (9:30-4:00 ET).", color: COLORS.bull });
  return { ok: r.ok, status: r.status, detail: r.ok ? undefined : (await r.json().catch(() => ({}))).message };
}
