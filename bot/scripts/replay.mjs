// Replay: runs the bot's SPX signal rules over the past weeks of 1-minute data, scores every signal the same way the live
// scorecard does (target before stop, A/A+ must trigger within 9 minutes, 60-minute limit), and saves the results to the bot
// ("bot:replay"). The nightly learning run uses them at half weight, so it starts with hundreds of examples.
//
//   node scripts/replay.mjs https://<your-bot>.workers.dev [days=45]
//
// Runs on your computer (too heavy for a free Worker); data comes through the bot's Schwab login with your admin key (.admin-key).
// Limits: no options flow, LB, VIX, gamma or your plan in the past, so those checks are left out of A/A+ scores (scaled like live).
// Option prices are not replayed (Schwab has no past option prices): results are in R on SPX, not dollars.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { et, OPEN, CLOSE, dayLevels, aggregate, intradayLevels, ribbon, phaseOsc, cloud2021, compressionBox, chop, vwapCrosses, divergence, dtrPct } from "../src/levels.js";
import { patterns, atLevel } from "../src/patterns.js";
import { resolveTracks } from "../src/signals.js";
import { famOf } from "../src/learn.js";
import { LEVEL_NAMES } from "../src/plan.js";
import { trendScore, pullback21, vomy, vomyRetest13, pbConfluence, orbBreak } from "../src/setups.js";
import { ema } from "../src/levels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOT = (process.argv[2] || "").replace(/\/$/, "");
const DAYS = +(process.argv[3] || 45);
if (!/^https:\/\//.test(BOT)) { console.error("usage: node scripts/replay.mjs https://<your-bot>.workers.dev [days]"); process.exit(1); }
const KEY = fs.readFileSync(path.join(here, "..", ".admin-key"), "utf8").trim();
const r2 = (x) => Math.round(x * 100) / 100;
const get = async (q) => {
  const r = await fetch(BOT + "/history?" + new URLSearchParams(q), { headers: { "x-bot-key": KEY } });
  if (!r.ok) throw new Error("history " + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : j.candles || [];
};

const now = Date.now();
const daily = await get({ symbol: "$SPX", periodType: "year", period: "1", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
let m1 = [];
for (let end = now; end > now - DAYS * 864e5; end -= 9 * 864e5) {
  const part = await get({ symbol: "$SPX", frequencyType: "minute", frequency: "1", startDate: String(end - 9 * 864e5), endDate: String(end), needExtendedHoursData: "false" });
  m1.push(...part);
}
// SPY 1m (volume for the "quiet pullback" check; SPX has no volume)
let spy = [];
for (let end = now; end > now - DAYS * 864e5; end -= 9 * 864e5) spy.push(...await get({ symbol: "SPY", frequencyType: "minute", frequency: "1", startDate: String(end - 9 * 864e5), endDate: String(end), needExtendedHoursData: "false" }));
spy = [...new Map(spy.map((c) => [c.datetime, c])).values()].sort((a, b) => a.datetime - b.datetime);
m1 = [...new Map(m1.map((c) => [c.datetime, c])).values()].sort((a, b) => a.datetime - b.datetime).map((c) => ({ ...c, t: et(c.datetime) }));
const today = et(now).date;
const days = [...new Set(m1.map((c) => c.t.date))].filter((d) => d < today);
console.log(`${m1.length} one-minute bars, ${days.length} past sessions (${days[0]} to ${days[days.length - 1]})`);

const out = [];
const side = (r) => (r && r.state === "bullish" ? "bull" : r && r.state === "bearish" ? "bear" : null);
for (const date of days) {
  const D = dayLevels(daily, date);
  if (!D) continue;
  const lv = D.atrLevels;
  const dCloses = daily.filter((c) => new Date(c.datetime + 12 * 3600e3).toISOString().slice(0, 10) < date).map((c) => c.close);
  const ema21d = dCloses.length > 21 ? ema(dCloses, 21).at(-1) : null;
  const rows = m1.filter((c) => c.t.date === date);
  const before = m1.filter((c) => c.t.date < date).slice(-40 * 390);
  const fired = new Set();
  const found = [];
  let T10 = null, trendDir = null, trendOk = 0, vomy10 = null;
  for (let min = OPEN + 3; min < CLOSE - 5; min++) {
    const nowMs = rows.find((c) => c.t.min === min)?.datetime;
    if (!nowMs) continue;
    const done = rows.filter((c) => c.datetime < nowMs);
    const rth = done.filter((c) => c.t.min >= OPEN);
    if (rth.length < 5) continue;
    const c0 = rth[rth.length - 1].close, c3 = rth[Math.max(0, rth.length - 4)].close;
    const intra = intradayLevels(done, date, null);
    const b3 = aggregate(done, 3).filter((b) => b.datetime + 180000 <= nowMs);
    const rib3 = b3.length >= 21 ? ribbon(b3) : null, osc3 = phaseOsc(b3);
    // 10m / 1h context, refreshed every 10 minutes (as live)
    if (!T10 || min % 10 === 0) {
      const all = [...before, ...done];
      const b10x = aggregate(all, 10).filter((b) => b.datetime + 600000 <= nowMs).slice(-600);
      const o = phaseOsc(b10x);
      T10 = { b10: b10x, rib10: ribbon(b10x), osc10: o, box10: o ? compressionBox(b10x, o._track) : null, ch: chop(b10x),
        cloudH: cloud2021(aggregate(all, 60).filter((b) => b.datetime + 3600000 <= nowMs)),
        ema21h: (() => { const r = ribbon(aggregate(all, 60).filter((b) => b.datetime + 3600000 <= nowMs)); return r ? r.ema[21] : null; })() };
    }
    const { b10, rib10, osc10, box10, cloudH } = T10;
    const ch = T10.ch, crosses = rth.length > 20 ? vwapCrosses(rth, 60) : 0;
    const choppy = ch != null && ch > 61.8 && ((rib10 && rib10.flips >= 2) || crosses >= 4);
    const vwap = intra.vwap, dtr = dtrPct(intra.hod, intra.lod, D.atr, D.pdc);
    const keyLevels = [["ORB high", intra.orbh], ["ORB low", intra.orbl], ["yesterday's high", D.pdh], ["yesterday's low", D.pdl], ["PDC", D.pdc], ["VWAP", vwap],
      ...Object.entries(lv).filter(([k]) => Math.abs(+k) <= 2).map(([k, v]) => [LEVEL_NAMES[k] || `ATR ${k}`, v])];
    const et0 = `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
    // 3m bars including earlier days (settled EMAs), trend day state
    const b3all = aggregate([...before.slice(-1170), ...done], 3).filter((b) => b.datetime + 180000 <= nowMs);
    const rib3a = b3all.length >= 21 ? ribbon(b3all) : null;
    const ts = trendScore({ closes3: aggregate(rth, 3).filter((b) => b.datetime + 180000 <= nowMs).map((b) => b.close), orbh: intra.orbh, orbl: intra.orbl, lv, rib3: rib3a, rib10, cloudH, vix: null, choppy, dtr });
    if (ts && ts.trend && min >= 585) { trendDir = ts.dir; trendOk = nowMs; }
    else if (trendDir && ts && (ts.score <= 3 || nowMs - trendOk > 60 * 60000 || (rib10 && rib10.state === (trendDir === "bull" ? "bearish" : "bullish")))) trendDir = null;
    const add = (key, kind, track, extra = {}) => {
      if (fired.has(key)) return; fired.add(key);
      const trend = trendDir ? (trendDir === track.dir ? "with" : "against") : "none";
      found.push({ key, kind, track: { ...track, at: nowMs }, et: et0, ctx: { chop: choppy, gex: null, vix: null, plan: "none", trend }, ...extra });
    };
    // 21 EMA pullback and Vomy (src/setups.js, same as live)
    {
      const pbDir = trendDir || (!choppy && side(rib10) && side(rib10) === side(rib3a) ? side(rib10) : null);
      let pb = pbDir ? pullback21(b3all, pbDir) : null;
      if (pb && cloudH !== (pb.dir === "bull" ? "up" : "down")) pb = null; // 1h cloud must agree (as live)
      if (pb) {
        const up = pb.dir === "bull";
        const ggCrossed = rth.some((c) => (up ? c.high >= lv["+0.382"] : c.low <= lv["-0.382"]));
        const fib = lv[up ? "+0.618" : "-0.618"], fibHit = up ? intra.hod >= fib : intra.lod <= fib;
        const next = Object.values(lv).filter((v) => (up ? v > pb.entry : v < pb.entry)).sort((x, y) => (up ? x - y : y - x))[0];
        const stack = [["10m", rib10 && rib10.ema[21]], ["1h", T10.ema21h], ["daily", ema21d]].filter(([, v]) => v != null && Math.abs(v - pb.ema21) <= D.atr * 0.08).map(([n]) => n);
        const spyVol3 = aggregate(spy.filter((c) => c.datetime >= nowMs - 60 * 60000 && c.datetime < nowMs), 3).map((b) => b.volume);
        const cf = pbConfluence({ dir: pb.dir, trendOn: !!trendDir && trendDir === pb.dir, stack, spyVol3, ggCrossed, cloudH, vix: null });
        add(`pb21:${pb.bar.datetime}:${pb.dir}`, "setup", { dir: pb.dir, entry: pb.entry, stop: pb.stop, target: (ggCrossed && !fibHit ? fib : next) ?? null, needTrigger: true }, { conf: cf.bits.map((b) => b.split(" (")[0]) });
      }
      // VOMY_TEST=1: compare B (10m Vomy), C (3m 13-retest), D (10m Vomy then 3m 13-retest); not saved as families otherwise
      if (process.env.VOMY_TEST) {
        const nextLv = (up, px) => Object.values(lv).filter((v) => (up ? v > px : v < px)).sort((x, y) => (up ? x - y : y - x))[0] ?? null;
        if (min % 10 === 0) {
          const v10 = vomy(T10.b10);
          if (v10) { vomy10 = { dir: v10.dir, at: nowMs }; add(`vomyB:${v10.bar.datetime}:${v10.dir}`, "setup", { dir: v10.dir, entry: v10.entry, stop: v10.stop, target: nextLv(v10.dir === "bull", v10.entry), needTrigger: true }); }
        }
        const rt = vomyRetest13(b3all);
        if (rt) {
          add(`vomyC:${rt.bar.datetime}:${rt.dir}`, "setup", { dir: rt.dir, entry: rt.entry, stop: rt.stop, target: nextLv(rt.dir === "bull", rt.entry), needTrigger: true });
          if (vomy10 && vomy10.dir === rt.dir && nowMs - vomy10.at <= 40 * 60000)
            add(`vomyD:${rt.bar.datetime}:${rt.dir}`, "setup", { dir: rt.dir, entry: rt.entry, stop: rt.stop, target: nextLv(rt.dir === "bull", rt.entry), needTrigger: true });
        }
      }
      // ORB break-and-hold (as live, before 10:30)
      if (min < 630) {
        const ob = orbBreak(aggregate(rth, 3).filter((b) => b.datetime + 180000 <= nowMs), intra.orbh, intra.orbl, rib10);
        if (ob) { const up = ob.dir === "bull"; const nx = Object.values(lv).filter((v) => (up ? v > ob.entry : v < ob.entry)).sort((x, y) => (up ? x - y : y - x))[0];
          add(`orb:${date}:${ob.dir}`, "setup", { dir: ob.dir, entry: ob.entry, stop: ob.stop, target: nx ?? null, needTrigger: true }); }
      }
      if (min % 10 === 0 && !process.env.VOMY_TEST) { const v10 = vomy(T10.b10); if (v10) vomy10 = { dir: v10.dir, at: nowMs }; }
      const rtD = vomy10 && nowMs - vomy10.at <= 40 * 60000 && !process.env.VOMY_TEST ? vomyRetest13(b3all) : null;
      if (rtD && rtD.dir === vomy10.dir) { const up = rtD.dir === "bull"; const nx = Object.values(lv).filter((v) => (up ? v > rtD.entry : v < rtD.entry)).sort((x, y) => (up ? x - y : y - x))[0];
        add(`vomy:${rtD.bar.datetime}:${rtD.dir}`, "setup", { dir: rtD.dir, entry: rtD.entry, stop: rtD.stop, target: nx ?? null, needTrigger: true }); }
      const vm = process.env.VOMY_TEST ? vomy(b3all) : null;
      if (vm) {
        const up = vm.dir === "bull";
        const next = Object.values(lv).filter((v) => (up ? v > vm.entry : v < vm.entry)).sort((x, y) => (up ? x - y : y - x))[0];
        add(`vomy:${vm.bar.datetime}:${vm.dir}`, "setup", { dir: vm.dir, entry: vm.entry, stop: vm.stop, target: next ?? null, needTrigger: true });
      }
    }

    // momentum (not on choppy days)
    if (!choppy) for (const [name, lvl, dir] of [["ORB high", intra.orbh, "bull"], ["ORB low", intra.orbl, "bear"], ["yesterday's high", D.pdh, "bull"], ["yesterday's low", D.pdl, "bear"],
      ["ATR call trigger", lv["+0.236"], "bull"], ["ATR put trigger", lv["-0.236"], "bear"], ["ATR upper midrange", lv["+0.618"], "bull"], ["ATR lower midrange", lv["-0.618"], "bear"]]) {
      if (lvl == null) continue;
      const broke = dir === "bull" ? c3 <= lvl && c0 > lvl : c3 >= lvl && c0 < lvl;
      if (!broke || side(rib3) !== dir || !(vwap == null || (dir === "bull" ? c0 > vwap : c0 < vwap))) continue;
      const next = Object.values(lv).filter((v) => (dir === "bull" ? v > c0 : v < c0)).sort((x, y) => (dir === "bull" ? x - y : y - x))[0];
      add(`mom:$SPX:${name}`, "momentum", { dir, entry: c0, stop: lvl, target: next ?? null });
    }
    // 10m phase flip, squeeze, compression breakout (only on a fresh 10m close)
    if (min % 10 === 0 && osc10) {
      if (osc10.cross) { const dir = osc10.flip.startsWith("oversold") ? "bull" : "bear"; add(`flip:$SPX:${dir}:${Math.floor(nowMs / 600000)}`, "phase", { dir, entry: c0, stop: dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: dir === "bull" ? c0 + D.atr * 0.3 : c0 - D.atr * 0.3 }); }
      if (osc10.squeezeFired && side(rib10)) { const dir = side(rib10); add(`squeeze:$SPX:${Math.floor(nowMs / 600000)}`, "phase", { dir, entry: c0, stop: dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: dir === "bull" ? c0 + D.atr * 0.3 : c0 - D.atr * 0.3 }); }
      const lc = b10.at(-1), pc = b10.at(-2);
      if (box10 && lc && pc) {
        const up = pc.close <= box10.high && lc.close > box10.high, dn = pc.close >= box10.low && lc.close < box10.low;
        if (up || dn) add(`box:$SPX:${box10.from}:${up ? "bull" : "bear"}`, "phase", { dir: up ? "bull" : "bear", entry: lc.close, stop: box10.mid, target: null });
      }
    }
    // SPX 1m / 3m divergence and compression breakouts
    const b1 = done.filter((c) => c.t.min >= OPEN - 60);
    for (const [tf, bars, o] of [["1m", b1, phaseOsc(b1)], ["3m", b3, osc3]]) {
      if (!o) continue;
      const dv = divergence(bars, o._osc);
      if (dv && (tf !== "1m" || side(rib3a) === dv.dir)) add(`div:${tf}:${dv.at}`, "setup", { dir: dv.dir, entry: c0, stop: dv.dir === "bull" ? c0 - D.atr * 0.15 : c0 + D.atr * 0.15, target: null });
      const bx = compressionBox(bars, o._track), lc = bars.at(-1), pc = bars.at(-2);
      if (bx && lc && pc && ((pc.close <= bx.high && lc.close > bx.high) || (pc.close >= bx.low && lc.close < bx.low)) && (tf !== "1m" || side(rib3a) === (lc.close > bx.high ? "bull" : "bear"))) {
        const up = lc.close > bx.high;
        add(`cbox:${tf}:${bx.from}:${up}`, "setup", { dir: up ? "bull" : "bear", entry: lc.close, stop: bx.mid, target: null });
      }
    }
    // A / A+: candle pattern at a key level + the checks that exist in past data
    const bars3 = aggregate(rth, 3).filter((b) => b.datetime + 180000 <= nowMs);
    for (const pat of patterns(bars3)) {
      const at = atLevel(pat, keyLevels, D.atr * 0.05);
      if (!at) continue;
      const dir = pat.dir;
      const checks = [[true, 20], [true, 20], [side(rib3) === dir, 10], [side(rib10) === dir, 10],
        [osc10 ? (osc10.flip ? osc10.flip.startsWith("oversold") === (dir === "bull") : dir === "bull" ? osc10.value < 61.8 : osc10.value > -61.8) : null, 10],
        [vwap != null && (dir === "bull" ? c0 > vwap : c0 < vwap), 10], [cloudH ? cloudH === (dir === "bull" ? "up" : "down") : null, 10],
        [dtr == null ? null : dtr < 90, 10], [!choppy, 10]];
      const got = checks.reduce((s, [ok, p]) => s + (ok ? p : 0), 0), possible = checks.reduce((s, [ok, p]) => s + (ok === null ? 0 : p), 0);
      const score = Math.round((got / possible) * 100);
      const grade = score >= 85 ? "A+" : score >= 70 && !choppy ? "A" : null;
      if (!grade) continue;
      const next = Object.values(lv).filter((v) => (dir === "bull" ? v > c0 : v < c0)).sort((x, y) => (dir === "bull" ? x - y : y - x))[0];
      add(`star:$SPX:${pat.bar.datetime}:${dir}`, "star", { dir, entry: dir === "bull" ? pat.bar.high : pat.bar.low, stop: dir === "bull" ? pat.bar.low : pat.bar.high, target: next ?? null, needTrigger: true }, { grade, score });
    }
  }
  // score each signal on the bars after it (same rules as the live scorecard, cut at 60 minutes)
  const rthAll = rows.filter((c) => c.t.min >= OPEN && c.t.min < CLOSE);
  for (const f of found) {
    if (!(Math.abs(f.track.entry - f.track.stop) > 0)) continue;
    const end = Math.min(f.track.at + 61 * 60000, rthAll.at(-1).datetime + 60000);
    const slice = rthAll.filter((c) => c.datetime < end);
    const res = resolveTracks({ track: [{ ...f.track, sym: "$SPX" }] }, "$SPX", slice, end + 60 * 60000 + 1, { min: et(end).min })[0];
    if (!res || res.R == null) continue;
    out.push({ conf: f.conf, date, sym: "$SPX", kind: f.kind, key: f.key, fam: famOf(f.key), grade: f.grade || null, score: f.score ?? null, et: f.et, dir: f.track.dir, ctx: f.ctx, R: res.R, outcome: res.outcome, replay: true });
  }
  process.stdout.write(`${date}: ${found.length} signals\n`);
}

const byFam = {};
for (const x of out) { const f = (byFam[x.fam] = byFam[x.fam] || { n: 0, R: 0, w: 0 }); f.n++; f.R += x.R; if (x.R > 0) f.w++; }
console.log("\nfamily        results  win%   avg R");
for (const [k, f] of Object.entries(byFam).sort((a, b) => b[1].R / b[1].n - a[1].R / a[1].n)) console.log(k.padEnd(14), String(f.n).padStart(6), String(Math.round((f.w / f.n) * 100)).padStart(5) + "%", (f.R / f.n).toFixed(2).padStart(7));
const byTrend = {};
for (const x of out) { const k = x.ctx.trend; const f = (byTrend[k] = byTrend[k] || { n: 0, R: 0, w: 0 }); f.n++; f.R += x.R; if (x.R > 0) f.w++; }
console.log("\nvs trend day   results  win%   avg R");
for (const [k, f] of Object.entries(byTrend)) console.log(k.padEnd(14), String(f.n).padStart(6), String(Math.round((f.w / f.n) * 100)).padStart(5) + "%", (f.R / f.n).toFixed(2).padStart(7));
const trendDays = new Set(out.filter((x) => x.ctx.trend !== "none").map((x) => x.date)).size;
console.log(`trend days detected: ${trendDays} of ${days.length}`);
// keep a local copy (git-ignored), then upload with retries
const body = JSON.stringify({ from: days[0], to: days[days.length - 1], items: out });
fs.writeFileSync(path.join(here, "..", ".replay.json"), body);
if (process.env.NO_SAVE) process.exit(0);
for (let i = 1; i <= 4; i++) {
  try {
    const r = await fetch(BOT + "/replay/save", { method: "POST", headers: { "x-bot-key": KEY, "Content-Type": "application/json" }, body });
    console.log("\nsaved:", await r.text());
    break;
  } catch (e) {
    console.log(`upload try ${i} failed (${e.message}); retrying`);
    await new Promise((res) => setTimeout(res, 3000 * i));
  }
}
