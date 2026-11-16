// ORB test: opening-range breaks on SPX at the open, 1-minute and 3-minute closes (data/spx_1m.csv, ~32 days),
// plus a longer check on 5-minute bars (data/spx_5m.csv, ~8 months). Scored in SPX points as R. One trade per day per side.
//   node scripts/orb-test.mjs
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
const byDay = (bars) => { const m = new Map(); for (const b of bars) (m.get(b.d) || m.set(b.d, []).get(b.d)).push(b); return m; };

// V: { orMin: range length in minutes, tf: break bar minutes, closes: how many closes beyond, until: last entry minute,
//      stop: "or" (other side of range) | "mid" (range middle) | "bar" (break bar's far end), tgtR, filt: none|vwap|prev }
function run(m1, V) {
  const days = byDay(m1), res = [];
  let prevClose = null;
  for (const [d, bars] of days) {
    const rth = bars.filter((b) => b.m >= 570 && b.m < 960);
    if (rth.length < (V.minBars || 300)) { prevClose = rth.at(-1)?.c ?? prevClose; continue; }
    const orBars = rth.filter((b) => b.m < 570 + V.orMin);
    const orh = Math.max(...orBars.map((b) => b.h)), orl = Math.min(...orBars.map((b) => b.l)), size = orh - orl;
    const tfb = agg(rth, V.tf).filter((b) => b.m >= 570 + V.orMin);
    let pv = 0, vv = 0;   // running VWAP proxy (no volume on the index: typical-price average)
    const done = new Set();
    let pos = null, cnt = { up: 0, dn: 0 };
    for (let i = 0; i < tfb.length; i++) {
      const b = tfb[i];
      if (pos) {
        const up = pos.dir > 0;
        let exit = null;
        if (up ? b.l <= pos.stop : b.h >= pos.stop) exit = pos.stop;
        else if (up ? b.h >= pos.tgt : b.l <= pos.tgt) exit = pos.tgt;
        else if (b.m + V.tf >= 955 || b.m + V.tf - pos.m >= 60) exit = b.c;
        if (exit != null) { res.push({ d, dir: pos.dir, R: ((exit - pos.entry) * pos.dir) / pos.risk }); pos = null; }
        continue;
      }
      cnt.up = b.c > orh ? cnt.up + 1 : 0;
      cnt.dn = b.c < orl ? cnt.dn + 1 : 0;
      if (b.m + V.tf > V.until) continue;
      const vw = (() => { const xs = rth.filter((x) => x.m < b.m + V.tf); return xs.reduce((s, x) => s + (x.h + x.l + x.c) / 3, 0) / xs.length; })();
      for (const [dir, n] of [[1, cnt.up], [-1, cnt.dn]]) {
        if (n !== V.closes || done.has(dir)) continue;
        if (V.filt === "vwap" && (dir > 0 ? b.c < vw : b.c > vw)) continue;
        if (V.filt === "prev" && prevClose != null && (dir > 0 ? b.c < prevClose : b.c > prevClose)) continue;
        const stop = V.stop === "or" ? (dir > 0 ? orl : orh) : V.stop === "mid" ? (orh + orl) / 2 : dir > 0 ? b.l - 0.5 : b.h + 0.5;
        const risk = (b.c - stop) * dir;
        if (risk <= 0.5 || risk > 30) continue;
        done.add(dir);
        pos = { dir, entry: b.c, stop, risk, tgt: b.c + dir * risk * V.tgtR, m: b.m + V.tf };
        break;
      }
    }
    prevClose = rth.at(-1).c;
  }
  const n = res.length, w = res.filter((r) => r.R > 0).length, R = res.reduce((s, r) => s + r.R, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, avgR: n ? +(R / n).toFixed(2) : 0, totR: +R.toFixed(1) };
}

const m1 = read("spx_1m.csv");
const m5 = read("spx_5m.csv");
const out = [];
for (const orMin of [3, 5, 15])
  for (const tf of [1, 3])
    for (const closes of [1, 2])
      for (const stop of ["or", "mid", "bar"])
        for (const tgtR of [1, 1.5, 2])
          for (const filt of ["none", "vwap", "prev"])
            for (const until of [630, 690]) {
              if (tf > orMin) continue;
              const V = { orMin, tf, closes, stop, tgtR, filt, until };
              out.push({ name: `OR${orMin} ${tf}m x${closes} stop:${stop} ${tgtR}R ${filt} to${until === 630 ? "10:30" : "11:30"}`, V, ...run(m1, V) });
            }
const ok = out.filter((r) => r.n >= 15);
console.log(`=== 1m data (Oct-Nov, ~32 days): top 15 by avg R (n >= 15) ===`);
ok.sort((a, b) => b.avgR - a.avgR).slice(0, 15).forEach((r) => console.log(r.name.padEnd(48), `n${String(r.n).padStart(3)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`));
console.log(`--- the bot's current rule: OR3 3m x2, stop past the break bars ---`);
ok.filter((r) => r.name.startsWith("OR3 3m x2 stop:bar")).sort((a, b) => b.avgR - a.avgR).slice(0, 3).forEach((r) => console.log(r.name.padEnd(48), `n${r.n} win${r.win}% avgR ${r.avgR}`));
// longer check of the best 1m-data variants that also work on 5-minute bars (OR15 / OR5 with 5m closes)
console.log(`\n=== 5m data (Mar-Nov, ~180 days), same rules with 5-minute closes ===`);
const m5as1 = m5;   // 5m bars fed as "1m" rows: tf=1 means one 5-minute bar
const res5 = [];
for (const orMin of [5, 15]) for (const closes of [1, 2]) for (const stop of ["or", "mid", "bar"]) for (const tgtR of [1, 1.5, 2]) for (const filt of ["none", "vwap", "prev"]) for (const until of [630, 690]) {
  const V = { orMin, tf: 1, closes, stop, tgtR, filt, until, minBars: 60 };
  const r = run(m5as1.map((b) => b), V);
  res5.push({ name: `OR${orMin} 5m x${closes} stop:${stop} ${tgtR}R ${filt} to${until === 630 ? "10:30" : "11:30"}`, ...r });
}
res5.filter((r) => r.n >= 30).sort((a, b) => b.avgR - a.avgR).slice(0, 12).forEach((r) => console.log(r.name.padEnd(48), `n${String(r.n).padStart(3)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`));
