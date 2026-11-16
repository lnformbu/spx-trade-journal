// 1-minute scalping test on the data pool (run scripts/pull-history.mjs first). Entries AND exits on 1-minute candles only.
//
//   node scripts/scalp-test.mjs [cost=0.6]
//
// Each signal is decided on a closed 1m candle and filled at the NEXT candle's open. Stop / target are checked inside each
// later candle (if both are touched in the same candle, the stop counts: conservative). One trade at a time, 3-minute
// cool-down after an exit, nothing after 15:50, everything closed by 15:55, 30-minute limit.
// cost = SPX points lost per round trip to the option's bid/ask + slippage (0DTE ATM ~ 0.5 delta: 0.6 pt ≈ $0.30 a contract).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { dayLevels } from "../src/levels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "..", "data");
const COST = +(process.argv[2] || 0.6);
const read = (f) => { const [h, ...l] = fs.readFileSync(path.join(DATA, f), "utf8").trim().split(/\r?\n/); const H = h.split(","); return l.map((x) => Object.fromEntries(x.split(",").map((v, i) => [H[i], isNaN(+v) || v === "" ? v : +v]))); };
const spx = read("spx_1m.csv"), spy = read("spy_1m.csv"), dailyRows = read("spx_daily.csv");
const daily = dailyRows.map((r) => ({ ...r, datetime: Date.parse(r.date + "T05:00:00Z") }));
const spyVol = new Map(spy.map((r) => [r.date + " " + r.time, r]));
const days = [...new Set(spx.map((r) => r.date))].sort();
const min = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const emaArr = (xs, n) => { const k = 2 / (n + 1), o = []; let e = xs[0]; for (const x of xs) { e = x * k + e * (1 - k); o.push(e); } return o; };

// one continuous series (EMAs warm up across days); per-day VWAP from SPY volume
const bars = spx.map((r) => ({ ...r, m: min(r.time) }));
const C = bars.map((b) => b.close), e8 = emaArr(C, 8), e21 = emaArr(C, 21), e48 = emaArr(C, 48);
let pv = 0, vv = 0, day = null;
for (const b of bars) {
  if (b.date !== day) { day = b.date; pv = 0; vv = 0; }
  const s = spyVol.get(b.date + " " + b.time), v = s ? s.volume || 0 : 0;
  pv += ((b.high + b.low + b.close) / 3) * v; vv += v; b.vwap = vv ? pv / vv : b.close;
}
const idxByDay = {};
bars.forEach((b, i) => (idxByDay[b.date] = idxByDay[b.date] || []).push(i));

// ---------- entries: return { dir, stop } on bar i (decided on its close) or null ----------
const ENTRIES = {
  // trend pullback: 8 > 21 (rising) and above VWAP; a candle dips to the 21 EMA and closes back up (green)
  "EMA 8/21 pullback": (i) => {
    const b = bars[i];
    for (const up of [true, false]) {
      const trend = up ? e8[i] > e21[i] && e21[i] > e21[i - 5] && b.close > b.vwap : e8[i] < e21[i] && e21[i] < e21[i - 5] && b.close < b.vwap;
      if (!trend) continue;
      const came = [...Array(10).keys()].some((k) => (up ? bars[i - 1 - k].low > e8[i - 1 - k] + 1 : bars[i - 1 - k].high < e8[i - 1 - k] - 1));
      const tag = up ? b.low <= e21[i] + 0.5 && b.close > e21[i] && b.close > b.open : b.high >= e21[i] - 0.5 && b.close < e21[i] && b.close < b.open;
      if (came && tag) return { dir: up ? 1 : -1, stop: up ? Math.min(b.low, e48[i]) - 1 : Math.max(b.high, e48[i]) + 1 };
    }
    return null;
  },
  // VWAP reclaim / loss: 10 closes on one side, then a close back through VWAP with a body that way
  "VWAP reclaim": (i) => {
    const b = bars[i];
    for (const up of [true, false]) {
      const before = [...Array(10).keys()].every((k) => (up ? bars[i - 1 - k].close < bars[i - 1 - k].vwap : bars[i - 1 - k].close > bars[i - 1 - k].vwap));
      const thru = up ? b.close > b.vwap && b.close > b.open : b.close < b.vwap && b.close < b.open;
      if (before && thru) {
        const w = bars.slice(i - 10, i + 1);
        return { dir: up ? 1 : -1, stop: up ? Math.min(...w.map((x) => x.low)) - 1 : Math.max(...w.map((x) => x.high)) + 1 };
      }
    }
    return null;
  },
  // momentum breakout: close above the last 20 candles' high with 8 > 21 > 48 (mirror for puts); stop past the 21 EMA
  "20-bar breakout": (i) => {
    const b = bars[i], w = bars.slice(i - 20, i);
    if (b.close > Math.max(...w.map((x) => x.high)) && e8[i] > e21[i] && e21[i] > e48[i]) return { dir: 1, stop: Math.min(e21[i], b.low) - 1 };
    if (b.close < Math.min(...w.map((x) => x.low)) && e8[i] < e21[i] && e21[i] < e48[i]) return { dir: -1, stop: Math.max(e21[i], b.high) + 1 };
    return null;
  },
};
// level bounce: a candle tags a key level (within `tol` points) coming from the other side, rejects it with a wick and closes back
const levelBounce = (tol) => (i, L) => {
  const b = bars[i], rng = b.high - b.low;
  if (!(rng > 0)) return null;
  for (const v of L) {
    const sup = [1, 2, 3, 4, 5].every((k) => bars[i - k].close > v + 0.5);
    const res = [1, 2, 3, 4, 5].every((k) => bars[i - k].close < v - 0.5);
    if (sup && b.low <= v + tol && b.close > v && b.close > b.open && (Math.min(b.open, b.close) - b.low) / rng >= 0.4) return { dir: 1, stop: b.low - 1, level: v };
    if (res && b.high >= v - tol && b.close < v && b.close < b.open && (b.high - Math.max(b.open, b.close)) / rng >= 0.4) return { dir: -1, stop: b.high + 1, level: v };
  }
  return null;
};
for (const tol of [0, 2, 5]) ENTRIES[`Level bounce ±${tol}pt`] = levelBounce(tol);

// ---------- exits ----------
const EXITS = ["1R target", "2R target", "½ at 1R, trail rest"];

const run = (name, exit) => {
  const fn = ENTRIES[name], trades = [];
  for (const date of days) {
    const ix = idxByDay[date];
    if (!ix || ix[0] < 60) continue;
    const D = dayLevels(daily, date);
    const L = D ? [D.pdc, D.pdh, D.pdl, ...Object.entries(D.atrLevels).filter(([k]) => Math.abs(+k) <= 1 && k !== "0").map(([, v]) => v)] : [];
    const orb = ix.slice(0, 5).map((i) => bars[i]);
    if (orb.length === 5) L.push(Math.max(...orb.map((x) => x.high)), Math.min(...orb.map((x) => x.low)));
    let freeAt = 0;
    for (const i of ix) {
      const b = bars[i];
      if (b.m < 575 || b.m >= 950 || i < freeAt || i + 1 > ix[ix.length - 1]) continue;
      const s = fn(i, L);
      if (!s) continue;
      const entry = bars[i + 1].open, risk = s.dir * (entry - s.stop);
      if (!(risk >= 1.5) || risk > 15) continue;            // too tight to survive the spread / too wide for a scalp
      let stop = s.stop, got = 0, left = 1, half = false, j = i + 1, exitWhy = "time";
      const r = (px) => (s.dir * (px - entry)) / risk;
      for (; j <= ix[ix.length - 1]; j++) {
        const c = bars[j];
        const adv = s.dir > 0 ? c.low <= stop : c.high >= stop;
        const tgt = (k) => (s.dir > 0 ? c.high >= entry + k * risk : c.low <= entry - k * risk);
        if (adv) { got += left * r(stop); left = 0; exitWhy = half ? "breakeven" : "stop"; break; }
        if (exit === "1R target" && tgt(1)) { got += 1; left = 0; exitWhy = "target"; break; }
        if (exit === "2R target" && tgt(2)) { got += 2; left = 0; exitWhy = "target"; break; }
        if (exit === "½ at 1R, trail rest") {
          if (!half && tgt(1)) { half = true; got += 0.5; left = 0.5; stop = entry; }
          if (half && (s.dir > 0 ? c.close < e8[j] : c.close > e8[j])) { got += left * r(c.close); left = 0; exitWhy = "trail"; break; }
        }
        if (j - i >= 30 || c.m >= 955) { got += left * r(c.close); left = 0; break; }
      }
      freeAt = j + 3;
      trades.push({ date, m: b.m, dir: s.dir, risk, R: got, net: got - COST / risk, pts: got * risk - COST, exitWhy });
    }
  }
  return trades;
};
const sum = (t) => {
  const n = t.length, w = t.filter((x) => x.net > 0).length, gw = t.filter((x) => x.net > 0).reduce((s, x) => s + x.net, 0), gl = -t.filter((x) => x.net < 0).reduce((s, x) => s + x.net, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, gross: n ? t.reduce((s, x) => s + x.R, 0) / n : 0, net: n ? t.reduce((s, x) => s + x.net, 0) / n : 0, pf: gl ? gw / gl : gw ? 99 : 0, pts: t.reduce((s, x) => s + x.pts, 0), risk: n ? t.reduce((s, x) => s + x.risk, 0) / n : 0 };
};
const f2 = (x) => (x >= 0 ? "+" : "") + x.toFixed(2);
console.log(`${bars.length} one-minute SPX candles, ${days.length} sessions (${days[0]} to ${days.at(-1)}); cost ${COST} SPX pt per round trip\n`);
console.log("entry                 exit                   trades/day  win%  gross R   net R    PF   net SPX pts  avg risk   1st half  2nd half");
const all = [];
for (const name of Object.keys(ENTRIES)) for (const exit of EXITS) {
  const t = run(name, exit), S = sum(t), half = Math.floor(days.length / 2), a = sum(t.filter((x) => x.date < days[half])), b = sum(t.filter((x) => x.date >= days[half]));
  all.push({ name, exit, t, S });
  console.log(name.padEnd(21), exit.padEnd(22), (S.n / days.length).toFixed(1).padStart(10), String(S.win).padStart(5) + "%", f2(S.gross).padStart(8), f2(S.net).padStart(7), S.pf.toFixed(2).padStart(6), f2(S.pts).padStart(12), S.risk.toFixed(1).padStart(9), f2(a.net).padStart(10), f2(b.net).padStart(9));
}
// best combo by net R with enough trades: time of day + direction breakdown
const best = all.filter((x) => x.S.n >= 30).sort((a, b) => b.S.net - a.S.net)[0];
if (best) {
  console.log(`\nbest: ${best.name} / ${best.exit}`);
  for (const [lab, lo, hi] of [["9:35-10:30", 575, 630], ["10:30-12:00", 630, 720], ["12:00-14:00", 720, 840], ["14:00-15:50", 840, 950]]) {
    const S = sum(best.t.filter((x) => x.m >= lo && x.m < hi));
    console.log("  " + lab.padEnd(12), String(S.n).padStart(4), "trades", String(S.win).padStart(4) + "%", "net", f2(S.net), "R  PF", S.pf.toFixed(2));
  }
  for (const d of [1, -1]) { const S = sum(best.t.filter((x) => x.dir === d)); console.log("  " + (d > 0 ? "calls" : "puts").padEnd(12), String(S.n).padStart(4), "trades", String(S.win).padStart(4) + "%", "net", f2(S.net), "R  PF", S.pf.toFixed(2)); }
}
fs.writeFileSync(path.join(DATA, "scalp_results.csv"), "entry,exit,date,minute,dir,risk_pts,R_gross,R_net,pts_net,exit_why\n" +
  all.flatMap((x) => x.t.map((t) => [x.name, x.exit, t.date, t.m, t.dir, t.risk.toFixed(2), t.R.toFixed(3), t.net.toFixed(3), t.pts.toFixed(2), t.exitWhy].join(","))).join("\n") + "\n");
console.log("\nevery trade: data/scalp_results.csv");
