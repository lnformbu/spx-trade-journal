// Cloud-flip test: trend-reversal entries when the Pivot Ribbon cloud flips, on SPX 3-minute (from data/spx_1m.csv)
// and 5-minute (data/spx_5m.csv, longer history) bars. Scored in SPX points as R (risk = entry to stop).
//   node scripts/cloudflip-test.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(here, "..", "..", "data");
const read = (f) => {
  const [h, ...ls] = fs.readFileSync(path.join(DATA, f), "utf8").trim().split(/\r?\n/);
  const k = h.split(",");
  return ls.map((l) => { const v = l.split(","); const o = Object.fromEntries(k.map((x, i) => [x, v[i]])); return { d: o.date, m: +o.time.slice(0, 2) * 60 + +o.time.slice(3, 5), o: +o.open, h: +o.high, l: +o.low, c: +o.close }; });
};
const agg = (bars, n) => {
  const out = [];
  for (const b of bars) {
    const slot = Math.floor((b.m - 570) / n), x = out.at(-1);
    if (!x || x.d !== b.d || x.slot !== slot) out.push({ ...b, slot, m: 570 + slot * n });
    else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; }
  }
  return out;
};
const ema = (xs, n) => { const k = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * k + e * (1 - k))); };

function run(bars, tf, V) {
  const c = bars.map((b) => b.c);
  const E = Object.fromEntries([8, 13, 21, 48].map((n) => [n, ema(c, n)]));
  // 1-hour 20/21 cloud from the same bars (hourly closes, carried forward)
  const hb = agg(bars, 60), hc = hb.map((b) => b.c), h20 = ema(hc, 20), h21 = ema(hc, 21);
  const hUpAt = new Map(); hb.forEach((b, i) => hUpAt.set(b.d + ":" + b.slot, i > 0 ? h20[i - 1] > h21[i - 1] : null)); // last COMPLETED hour
  const res = [];
  let pos = null;
  for (let i = 50; i < bars.length; i++) {
    const b = bars[i];
    if (pos) {
      const up = pos.dir > 0;
      let exit = null;
      if (up ? b.l <= pos.stop : b.h >= pos.stop) exit = pos.stop;
      else if (V.tgtR && (up ? b.h >= pos.tgt : b.l <= pos.tgt)) exit = pos.tgt;
      else if (V.exitFlip && (up ? E[8][i] < E[21][i] : E[8][i] > E[21][i])) exit = b.c;
      else if (b.d !== bars[i + 1]?.d || b.m + tf >= 955) exit = b.c;
      if (exit != null) { res.push({ ...pos, R: ((exit - pos.entry) * pos.dir) / pos.risk }); pos = null; }
      continue;
    }
    if (b.m + tf < V.from || b.m + tf > V.to) continue;
    const fastUp = E[8][i] > E[21][i], fastUpPrev = E[8][i - 1] > E[21][i - 1];
    const slowUp = E[13][i] > E[48][i], slowUpPrev = E[13][i - 1] > E[48][i - 1];
    let dir = 0;
    if (V.kind === "fast") dir = fastUp && !fastUpPrev ? 1 : !fastUp && fastUpPrev ? -1 : 0;
    if (V.kind === "slow") dir = slowUp && !slowUpPrev ? 1 : !slowUp && slowUpPrev ? -1 : 0;
    if (V.kind === "both") dir = (fastUp && slowUp && !(fastUpPrev && slowUpPrev)) ? 1 : (!fastUp && !slowUp && (fastUpPrev || slowUpPrev)) ? -1 : 0;
    if (!dir) continue;
    if (V.above48 && (dir > 0 ? b.c < E[48][i] : b.c > E[48][i])) continue;
    if (V.hourly) { const hu = hUpAt.get(b.d + ":" + Math.floor((b.m - 570) / 60)); if (hu == null || hu !== dir > 0) continue; }
    const lo = Math.min(...bars.slice(i - 4, i + 1).map((x) => x.l)), hi = Math.max(...bars.slice(i - 4, i + 1).map((x) => x.h));
    const stop = dir > 0 ? lo - 0.5 : hi + 0.5, risk = (b.c - stop) * dir;
    if (risk <= 0.5 || risk > 25) continue;
    pos = { d: b.d, m: b.m, dir, entry: b.c, stop, risk, tgt: V.tgtR ? b.c + dir * risk * V.tgtR : null };
  }
  const n = res.length, w = res.filter((r) => r.R > 0).length, R = res.reduce((s, r) => s + r.R, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, avgR: n ? +(R / n).toFixed(2) : 0, totR: +R.toFixed(1), days: new Set(res.map((r) => r.d)).size };
}

const sets = { "3m (Oct-Nov, 32 days)": agg(read("spx_1m.csv"), 3), "5m (Mar-Nov, ~180 days)": read("spx_5m.csv").map((b) => ({ ...b })) };
const variants = [];
for (const kind of ["fast", "slow", "both"])
  for (const filt of [[], ["hourly"], ["above48"], ["hourly", "above48"]])
    for (const ex of [{ tgtR: 1 }, { tgtR: 2 }, { exitFlip: true }, { tgtR: 2, exitFlip: true }])
      for (const win of [[575, 955], [585, 840]])
        variants.push({ kind, ...Object.fromEntries(filt.map((f) => [f, true])), ...ex, from: win[0], to: win[1],
          name: `${kind}${filt.length ? "+" + filt.join("+") : ""} ${ex.exitFlip && ex.tgtR ? "2R/flip" : ex.exitFlip ? "exit on flip" : ex.tgtR + "R"} ${win[1] === 840 ? "9:45-2pm" : "all day"}` });

for (const [label, bars] of Object.entries(sets)) {
  const tf = label.startsWith("3m") ? 3 : 5;
  const rows = variants.map((V) => ({ name: V.name, ...run(bars, tf, V) })).filter((r) => r.n >= 15);
  console.log(`\n=== ${label}: top 12 by avg R (n >= 15) ===`);
  rows.sort((a, b) => b.avgR - a.avgR).slice(0, 12).forEach((r) => console.log(r.name.padEnd(44), `n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${String(r.totR).padStart(6)}`));
  console.log(`--- top 6 by win rate ---`);
  rows.sort((a, b) => b.win - a.win || b.avgR - a.avgR).slice(0, 6).forEach((r) => console.log(r.name.padEnd(44), `n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)}`));
  if (process.env.SHOW) { const r = variants.find((v) => v.name === process.env.SHOW); if (r) console.log("SHOW", process.env.SHOW, run(bars, tf, r)); }
}
