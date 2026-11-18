// Training from YOUR lines (levels + trendlines drawn on the journal chart).
// Every line remembers the chart timeframe you drew it on; that timeframe sets how close counts as a touch, how far price must
// travel to call it HELD (bounced back to the side it came from) or BROKE (went through), and how long before it's a chop.
// Each touch is logged with its context (GEX regime, ribbons, time of day) in D1 "lines:log"; the stats by timeframe / role /
// GEX regime go into the touch alerts and the journal, and the data collector trades the bounce so the learning scores them.

import { hhmm } from "./levels.js";

// [touch zone, resolve distance, timeout minutes] in SPX points per chart timeframe
const TF = { "1m": [2, 5, 30], "3m": [2.5, 6, 45], "10m": [3.5, 9, 90], "1h": [5, 14, 180], "4h": [6, 18, 240], D: [8, 25, 390], W: [12, 35, 390] };
export const tfTol = (tf) => TF[tf] || TF["3m"];
export const tfGroup = (tf) => (tf === "1m" || tf === "3m" ? "scalp (1m/3m)" : tf === "10m" ? "day (10m)" : tf === "1h" || tf === "4h" ? "swing (1h/4h)" : tf === "D" || tf === "W" ? "daily (D/W)" : "unknown");

export function lineValue(x, nowMs) {
  if (x.type === "trend") return x.t2 !== x.t1 ? x.p1 + ((x.p2 - x.p1) * (nowMs / 1000 - x.t1)) / (x.t2 - x.t1) : null;
  if (x.type === "box") return nowMs / 1000 >= Math.min(x.t1, x.t2) ? (+x.p1 + +x.p2) / 2 : null;   // a zone, active from where you drew it
  if (x.type === "circle") return null;   // circles are notes only
  return isFinite(+x.price) ? +x.price : null;
}
// the price band a drawing covers: a line is a single price, a box is its zone
export function lineBand(x, nowMs) {
  const v = lineValue(x, nowMs);
  if (v == null) return null;
  return x.type === "box" ? { lo: Math.min(+x.p1, +x.p2), hi: Math.max(+x.p1, +x.p2), v } : { lo: v, hi: v, v };
}

// stats from the log: { held, broke, chop } for lines like this one (same timeframe group, role it acted as, GEX regime)
export function lineStats(log, { tf, acting, gex } = {}) {
  const r = { held: 0, broke: 0, chop: 0, n: 0 };
  for (const x of log) {
    if (tf && tfGroup(x.tf) !== tfGroup(tf)) continue;
    if (acting && x.acting !== acting) continue;
    if (gex && x.ctx && x.ctx.gex && x.ctx.gex !== gex) continue;
    r[x.result] = (r[x.result] || 0) + 1; r.n++;
  }
  return r;
}

// one minute: touches start / resolve. bar = the last completed 1m bar {high, low, close}.
export function trackLines({ items, st, bar, now, t, ctx }) {
  st.lineSt = st.lineSt || {};
  const started = [], outcomes = [];
  const live = new Set();
  for (const x of items) {
    const B = lineBand(x, now);
    if (!B || !isFinite(B.v)) continue;
    const { lo, hi, v } = B;
    live.add(String(x.at));
    const [tol, R, maxMin] = tfTol(x.tf);
    const S = (st.lineSt[x.at] = st.lineSt[x.at] || {});
    const c = bar.close;
    if (!S.touch) {
      if (c > hi + tol) S.side = "above"; else if (c < lo - tol) S.side = "below";
      const inZone = bar.low <= hi + tol && bar.high >= lo - tol;
      if (inZone && S.side && !(S.cool > now)) {
        const acting = S.side === "above" ? "support" : "resistance";
        S.touch = { at: now, et: hhmm(t.min), from: S.side, acting, v0: Math.round(v * 100) / 100, hold: 0, brk: 0, ctx };
        started.push({ item: x, v: acting === "support" ? hi : lo, lo, hi, acting, tol, R });
      }
      continue;
    }
    const T = S.touch, up = T.from === "above";
    // hold = distance back out of the side it came from; brk = distance through the far side (a line: lo = hi)
    const holdNow = up ? bar.high - hi : lo - bar.low, brkNow = up ? lo - bar.low : bar.high - hi;
    T.hold = Math.max(T.hold, holdNow); T.brk = Math.max(T.brk, brkNow);
    const mins = (now - T.at) / 60000;
    let result = null;
    if (T.brk >= R && (up ? c < lo : c > hi)) result = "broke";
    else if (T.hold >= R && (up ? c > hi : c < lo)) result = "held";
    else if (mins >= maxMin) result = "chop";
    if (!result) continue;
    outcomes.push({
      date: t.date, et: T.et, lineAt: x.at, label: x.label || "", kind: x.type === "trend" ? "trendline" : x.type === "box" ? "zone" : "level", tf: x.tf || null,
      role: x.role || "auto", acting: T.acting, v: T.v0, result, mins: Math.round(mins), hold: Math.round(T.hold * 100) / 100, brk: Math.round(T.brk * 100) / 100, ctx: T.ctx,
    });
    S.touch = null; S.cool = now + 10 * 60000; S.side = c > hi ? "above" : c < lo ? "below" : S.side;
  }
  for (const k of Object.keys(st.lineSt)) if (!live.has(k)) delete st.lineSt[k];   // deleted lines
  return { started, outcomes };
}
