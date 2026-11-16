// 1-minute scalp: the fast cloud (8/21 EMA) flips from a DOWNTREND to an uptrend (and the mirror for puts).
// "Downtrend before" = the 8 EMA was under the 21 for at least `prior` minutes. SPX points as R, data/spx_1m.csv (~32 days).
//   node scripts/flip1m-test.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [h, ...ls] = fs.readFileSync(path.join(here, "..", "..", "data", "spx_1m.csv"), "utf8").trim().split(/\r?\n/);
const k = h.split(",");
const bars = ls.map((l) => { const v = l.split(","); const o = Object.fromEntries(k.map((x, i) => [x, v[i]])); return { d: o.date, m: +o.time.slice(0, 2) * 60 + +o.time.slice(3, 5), h: +o.high, l: +o.low, c: +o.close }; });
const ema = (xs, n) => { const a = 2 / (n + 1); let e = null; return xs.map((x) => (e = e == null ? x : x * a + e * (1 - a))); };
const c = bars.map((b) => b.c), E = Object.fromEntries([8, 21, 48].map((n) => [n, ema(c, n)]));
// 3-minute 8/21 state carried to each minute (last completed 3m bar)
const s3 = []; { let cur = null; const out = []; bars.forEach((b, i) => { const slot = b.d + ":" + Math.floor((b.m - 570) / 3); if (!cur || cur.slot !== slot) { cur = { slot, c: b.c }; out.push(cur); } else cur.c = b.c; s3[i] = out.length - 2; });
  const c3 = out.map((x) => x.c), e8 = ema(c3, 8), e21 = ema(c3, 21); for (let i = 0; i < bars.length; i++) s3[i] = s3[i] >= 0 ? e8[s3[i]] > e21[s3[i]] : null; }

function run(V) {
  const res = [];
  let pos = null, below = 0, above = 0, armed = null;
  for (let i = 60; i < bars.length; i++) {
    const b = bars[i], up = E[8][i] > E[21][i];
    if (pos) {
      const L = pos.dir > 0;
      let x = null;
      if (L ? b.l <= pos.stop : b.h >= pos.stop) x = pos.stop;
      else if (L ? b.h >= pos.tgt : b.l <= pos.tgt) x = pos.tgt;
      else if (b.m - pos.m >= V.maxMin || b.m >= 955 || bars[i + 1]?.d !== b.d) x = b.c;
      if (x != null) { res.push({ R: ((x - pos.entry) * pos.dir) / pos.risk }); pos = null; }
    }
    let flipUp = up && below >= V.prior, flipDn = !up && above >= V.prior;
    if (flipUp) armed = { dir: 1, at: i }; else if (flipDn) armed = { dir: -1, at: i };
    if (V.k && armed && i - armed.at <= V.k && (armed.dir > 0) === up && s3[i] === up) { flipUp = armed.dir > 0; flipDn = armed.dir < 0; }
    if (armed && (i - armed.at > (V.k || 0) || (armed.dir > 0) !== up)) armed = null;
    below = up ? 0 : below + 1; above = up ? above + 1 : 0;
    if (pos || b.m < V.from || b.m > V.to) continue;
    for (const [dir, f] of [[1, flipUp], [-1, flipDn]]) {
      if (!f || (V.side && V.side !== dir)) continue;
      if (V.e48 && (dir > 0 ? b.c < E[48][i] : b.c > E[48][i])) continue;
      if (V.m3 && s3[i] !== (dir > 0)) continue;
      const lo = Math.min(...bars.slice(i - 4, i + 1).map((x) => x.l)), hi = Math.max(...bars.slice(i - 4, i + 1).map((x) => x.h));
      const stop = dir > 0 ? lo - 0.25 : hi + 0.25, risk = (b.c - stop) * dir;
      if (risk < 0.75 || risk > 12) continue;
      pos = { dir, entry: b.c, stop, risk, tgt: b.c + dir * risk * V.R, m: b.m };
    }
  }
  const n = res.length, w = res.filter((r) => r.R > 0).length, R = res.reduce((s, r) => s + r.R, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, avgR: n ? +(R / n).toFixed(2) : 0, totR: +R.toFixed(1) };
}
if (process.env.CONFIRM) {
  console.log("=== 3m confirmation window (1m flip arms, entry when the 3m cloud agrees within K minutes), down>=5m, 2R ===");
  for (const k of [0, 3, 6, 9, 12]) for (const win of [[585, 840], [575, 955]]) {
    const r = run({ side: 0, prior: 5, e48: false, m3: true, R: 2, maxMin: 30, from: win[0], to: win[1], k });
    console.log(`K=${String(k).padStart(2)} ${win[1] === 840 ? "9:45-2" : "all day"}`.padEnd(16), `n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`);
  }
  process.exit(0);
}
const rows = [];
for (const side of [1, 0]) for (const prior of [5, 15, 30]) for (const e48 of [false, true]) for (const m3 of [false, true])
  for (const R of [1, 1.5, 2]) for (const win of [[575, 955], [585, 840], [575, 690]])
    rows.push({ name: `${side ? "calls only" : "both sides"} down>=${prior}m${e48 ? " +48" : ""}${m3 ? " +3m agrees" : ""} ${R}R ${win[1] === 955 ? "all day" : win[1] === 840 ? "9:45-2" : "9:35-11:30"}`,
      ...run({ side: side || 0, prior, e48, m3, R, maxMin: 30, from: win[0], to: win[1] }) });
const ok = rows.filter((r) => r.n >= 25);
console.log("=== 1m cloud flip, ~32 days: top 15 by avg R (n >= 25) ===");
ok.sort((a, b) => b.avgR - a.avgR).slice(0, 15).forEach((r) => console.log(r.name.padEnd(52), `n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`));
console.log("--- plain 1m flip (no filters), for comparison ---");
ok.filter((r) => /^(calls only|both sides) down>=5m \d/.test(r.name) && r.name.endsWith("all day")).forEach((r) => console.log(r.name.padEnd(52), `n${r.n} win${r.win}% avgR ${r.avgR}`));
