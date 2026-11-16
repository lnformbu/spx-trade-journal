// Early-reversal test: a 1m 8/21 cloud flip after a trend the other way, confirmed WITHOUT waiting for the 3m cloud.
// Confirmations tested: 1m compression-box breakout, VWAP reclaim, Phase Oscillator out of an extreme, 48 EMA reclaim,
// and a long prior trend. SPX points as R (stop past the 5-bar low/high, 2R target, 30-min limit). data/spx_1m.csv.
//   node scripts/reversal-test.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { phaseOsc } from "../src/levels.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const [h, ...ls] = fs.readFileSync(path.join(here, "..", "..", "data", "spx_1m.csv"), "utf8").trim().split(/\r?\n/);
const k = h.split(",");
const bars = ls.map((l) => { const v = l.split(","); const o = Object.fromEntries(k.map((x, i) => [x, v[i]])); return { d: o.date, m: +o.time.slice(0, 2) * 60 + +o.time.slice(3, 5), high: +o.high, low: +o.low, close: +o.close }; });
const ema = (xs, n) => { const a = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * a + e * (1 - a))); };
const c = bars.map((b) => b.close), E8 = ema(c, 8), E21 = ema(c, 21), E48 = ema(c, 48);
const po = phaseOsc(bars), osc = po._osc, track = po._track;
// session VWAP proxy (index has no volume): running mean of typical price
const vw = []; { let s = 0, n = 0, d = null; bars.forEach((b, i) => { if (b.d !== d) { s = 0; n = 0; d = b.d; } s += (b.high + b.low + b.close) / 3; n++; vw[i] = s / n; }); }
// compression box: high/low of the first 3 bars of the latest compression run; usable until 30 bars after the run ends
const box = []; { let run = null, cur = null, endAt = -1; for (let i = 0; i < bars.length; i++) {
  if (track[i] === 1 && track[i - 1] !== 1) run = { hi: bars[i].high, lo: bars[i].low, n: 1 };
  else if (track[i] === 1 && run && run.n < 3) { run.hi = Math.max(run.hi, bars[i].high); run.lo = Math.min(run.lo, bars[i].low); run.n++; }
  if (run && run.n >= 3) cur = { hi: run.hi, lo: run.lo };
  if (track[i] === 0 && track[i - 1] === 1) { endAt = i; run = null; }
  if (bars[i].d !== bars[i - 1]?.d) { cur = null; endAt = -1; }
  box[i] = cur && (track[i] === 1 || i - endAt <= 30) ? cur : null; } }

function run(V) {
  const res = []; let pos = null, armed = null;
  for (let i = 60; i < bars.length; i++) {
    const b = bars[i], up = E8[i] > E21[i];
    if (pos) {
      const L = pos.dir > 0; let x = null;
      if (L ? b.low <= pos.stop : b.high >= pos.stop) x = pos.stop;
      else if (L ? b.high >= pos.tgt : b.low <= pos.tgt) x = pos.tgt;
      else if (b.m - pos.m >= 30 || b.m >= 955 || bars[i + 1]?.d !== b.d) x = b.close;
      if (x != null) { res.push(((x - pos.entry) * pos.dir) / pos.risk); pos = null; }
    }
    if (bars[i - 1].d !== b.d) { armed = null; continue; }
    const flipped = up !== (E8[i - 1] > E21[i - 1]);
    if (flipped) { let n = 0; for (let j = i - 1; j > 0 && (E8[j] > E21[j]) !== up && bars[j].d === b.d; j--) n++; armed = n >= V.prior ? { dir: up ? 1 : -1, at: i, prior: n, oscMin: Math.min(...osc.slice(i - n, i)), oscMax: Math.max(...osc.slice(i - n, i)) } : null; }
    if (!armed || i - armed.at > V.k || (armed.dir > 0) !== up) { if (armed && (i - armed.at > V.k || (armed.dir > 0) !== up)) armed = null; continue; }
    if (pos || b.m < V.from || b.m > V.to) continue;
    const dir = armed.dir, L = dir > 0;
    let ok = true;
    if (V.conf.includes("box")) { const bx = box[i] || box[i - 1]; ok = ok && !!bx && (L ? b.close > bx.hi : b.close < bx.lo); }
    if (V.conf.includes("vwap")) ok = ok && (L ? b.close > vw[i] && bars[i - 1].close <= vw[i - 1] + 9e9 && Math.min(...bars.slice(armed.at - 10, armed.at).map((x) => x.close - vw[i])) < 0 : b.close < vw[i] && Math.max(...bars.slice(armed.at - 10, armed.at).map((x) => x.close - vw[i])) > 0);
    if (V.conf.includes("osc")) ok = ok && (L ? armed.oscMin <= -61.8 : armed.oscMax >= 61.8);
    if (V.conf.includes("e48")) ok = ok && (L ? b.close > E48[i] : b.close < E48[i]);
    if (!ok) continue;
    const lo = Math.min(...bars.slice(i - 4, i + 1).map((x) => x.low)), hi = Math.max(...bars.slice(i - 4, i + 1).map((x) => x.high));
    const stop = L ? lo - 0.25 : hi + 0.25, risk = (b.close - stop) * dir;
    if (risk < 0.75 || risk > 15) continue;
    pos = { dir, entry: b.close, stop, risk, tgt: b.close + dir * risk * 2, m: b.m };
    armed = null;
  }
  const n = res.length, w = res.filter((r) => r > 0).length, R = res.reduce((s, r) => s + r, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, avgR: n ? +(R / n).toFixed(2) : 0, totR: +R.toFixed(1) };
}
const rows = [];
for (const conf of [[], ["box"], ["vwap"], ["osc"], ["e48"], ["box", "osc"], ["vwap", "osc"], ["box", "vwap"], ["e48", "osc"]])
  for (const prior of [10, 20, 30]) for (const kk of [0, 5, 10]) for (const win of [[585, 840], [575, 955]])
    rows.push({ name: `${conf.join("+") || "plain flip"} prior>=${prior}m within ${kk}m ${win[1] === 840 ? "9:45-2" : "all day"}`, ...run({ conf, prior, k: kk, from: win[0], to: win[1] }) });
const ok = rows.filter((r) => r.n >= 20);
console.log("=== early reversal (no 3m wait), 1m SPX ~32 days: top 15 by avg R (n >= 20) ===");
ok.sort((a, b) => b.avgR - a.avgR).slice(0, 15).forEach((r) => console.log(r.name.padEnd(46), `n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`));
console.log("--- plain flips for comparison ---");
ok.filter((r) => r.name.startsWith("plain flip") && r.name.includes("9:45-2")).slice(0, 6).forEach((r) => console.log(r.name.padEnd(46), `n${r.n} win${r.win}% avgR ${r.avgR}`));
