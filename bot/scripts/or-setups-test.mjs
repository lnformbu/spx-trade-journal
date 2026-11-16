// 15-minute opening range (9:30-9:45) setups on 3-minute SPX bars, from the user's chart:
//   1 SWEEP     a 3m bar wicks below the OR low (above the OR high), then a 3m engulfing bar closes back inside -> long (short)
//   2 HAMMER    a 3m bar tags the OR low (high) with a lower (upper) wick >= 2x its body and closes back inside -> long (short)
//   3 RETEST    a 3m close above the OR high (below the OR low), later a bar tags the OR edge and closes back outside -> long (short)
// Stop: 2 points past the sweep / wick extreme (retest: 1.5 points inside the OR edge). Targets: 1R, 2R or the opposite OR edge.
// One trade per setup per side per day, entries 9:45-12:00, 60-minute limit. SPX points as R.
//   node scripts/or-setups-test.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => {
  const [h, ...ls] = fs.readFileSync(path.join(here, "..", "..", "data", f), "utf8").trim().split(/\r?\n/);
  const k = h.split(",");
  return ls.map((l) => { const v = l.split(","); const o = Object.fromEntries(k.map((x, i) => [x, v[i]])); return { d: o.date, m: +o.time.slice(0, 2) * 60 + +o.time.slice(3, 5), o: +o.open, h: +o.high, l: +o.low, c: +o.close }; });
};
const agg = (bars, n) => { const out = []; for (const b of bars) { const slot = Math.floor((b.m - 570) / n), x = out.at(-1);
  if (!x || x.d !== b.d || x.slot !== slot) out.push({ ...b, slot, m: 570 + slot * n }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; } } return out; };
const byDay = (bars) => { const m = new Map(); for (const b of bars) (m.get(b.d) || m.set(b.d, []).get(b.d)).push(b); return m; };

function run(bars, tf, V) {
  const res = [];
  for (const [d, day] of byDay(bars)) {
    const rth = day.filter((b) => b.m >= 570 && b.m < 960);
    const orb = rth.filter((b) => b.m < 585);
    if (orb.length < 15 / tf) continue;
    const H = Math.max(...orb.map((b) => b.h)), L = Math.min(...orb.map((b) => b.l));
    const after = rth.filter((b) => b.m >= 585);
    const done = new Set(); let pos = null, brokeUp = false, brokeDn = false;
    for (let i = 1; i < after.length; i++) {
      const b = after[i], p = after[i - 1];
      if (pos) {
        const up = pos.dir > 0; let x = null;
        if (up ? b.l <= pos.stop : b.h >= pos.stop) x = pos.stop;
        else if (up ? b.h >= pos.tgt : b.l <= pos.tgt) x = pos.tgt;
        else if (b.m + tf - pos.m >= 60 || b.m + tf >= 955) x = b.c;
        if (x != null) { res.push({ setup: pos.setup, R: ((x - pos.entry) * pos.dir) / pos.risk }); pos = null; }
        continue;
      }
      if (b.m + tf > 720) { if (p.c > H) brokeUp = true; if (p.c < L) brokeDn = true; continue; }
      const body = Math.abs(b.c - b.o), lw = Math.min(b.o, b.c) - b.l, uw = b.h - Math.max(b.o, b.c);
      const cands = [];
      if (V.setup === "sweep") {
        // previous bar (or this one) took out the OR low, this bar engulfs the previous body and closes back above the OR low
        if (Math.min(p.l, b.l) < L && b.c > L && b.c > b.o && b.c >= Math.max(p.o, p.c) && b.o <= Math.min(p.o, p.c)) cands.push([1, Math.min(p.l, b.l) - 2]);
        if (Math.max(p.h, b.h) > H && b.c < H && b.c < b.o && b.c <= Math.min(p.o, p.c) && b.o >= Math.max(p.o, p.c)) cands.push([-1, Math.max(p.h, b.h) + 2]);
      }
      if (V.setup === "hammer") {
        if (b.l <= L + V.tol && b.c > L && lw >= 2 * Math.max(body, 0.25)) cands.push([1, b.l - 2]);
        if (b.h >= H - V.tol && b.c < H && uw >= 2 * Math.max(body, 0.25)) cands.push([-1, b.h + 2]);
      }
      if (V.setup === "retest") {
        if (brokeUp && b.l <= H + V.tol && b.c > H && b.c > b.o) cands.push([1, H - 1.5]);
        if (brokeDn && b.h >= L - V.tol && b.c < L && b.c < b.o) cands.push([-1, L + 1.5]);
      }
      if (p.c > H) brokeUp = true; if (p.c < L) brokeDn = true;
      for (const [dir, stop] of cands) {
        if (done.has(dir)) continue;
        const risk = (b.c - stop) * dir;
        if (risk <= 0.5 || risk > 25) continue;
        const tgt = V.tgt === "edge" ? (dir > 0 ? (V.setup === "retest" ? b.c + (H - L) : H) : (V.setup === "retest" ? b.c - (H - L) : L)) : b.c + dir * risk * V.tgt;
        if ((tgt - b.c) * dir <= 0) continue;
        done.add(dir); pos = { setup: V.setup, dir, entry: b.c, stop, risk, tgt, m: b.m + tf }; break;
      }
    }
  }
  const n = res.length, w = res.filter((r) => r.R > 0).length, R = res.reduce((s, r) => s + r.R, 0);
  return { n, win: n ? Math.round((w / n) * 100) : 0, avgR: n ? +(R / n).toFixed(2) : 0, totR: +R.toFixed(1) };
}
const sets = [["3m bars, Oct-Nov (~32 days)", agg(read("spx_1m.csv"), 3), 3], ["5m bars, Mar-Nov (~180 days, rougher)", read("spx_5m.csv"), 5]];
for (const [label, bars, tf] of sets) {
  console.log(`\n=== ${label} ===`);
  for (const setup of ["sweep", "hammer", "retest"]) for (const tgt of [1, 2, "edge"]) {
    const r = run(bars, tf, { setup, tgt, tol: 1.5 });
    console.log(`${setup.padEnd(7)} target ${String(tgt === "edge" ? "OR edge/range" : tgt + "R").padEnd(14)} n${String(r.n).padStart(4)} win${String(r.win).padStart(3)}% avgR ${r.avgR.toFixed(2).padStart(5)} totR ${r.totR}`);
  }
}
