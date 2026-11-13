// Candlestick Trading Bible patterns on completed bars ({open,high,low,close}), newest last.
// Returns patterns found on the LAST bar (or ending on it), each with a direction.
// A pattern only matters at a key level: atLevel() says which level the signal bar touched.

const body = (b) => Math.abs(b.close - b.open);
const range = (b) => b.high - b.low || 1e-9;
const bull = (b) => b.close > b.open;
const bear = (b) => b.close < b.open;

export function patterns(bars) {
  const out = [];
  const n = bars.length;
  if (n < 4) return out;
  const c = bars[n - 1], p = bars[n - 2], pp = bars[n - 3];
  const avgBody = bars.slice(-11, -1).reduce((s, b) => s + body(b), 0) / Math.min(10, n - 1) || 1e-9;

  // engulfing: body covers the previous body, opposite colour, a real body (0.6x average)
  if (bull(c) && bear(p) && c.close >= p.open && c.open <= p.close && body(c) >= 0.6 * avgBody) out.push({ name: "bullish engulfing", dir: "bull", bar: c });
  if (bear(c) && bull(p) && c.close <= p.open && c.open >= p.close && body(c) >= 0.6 * avgBody) out.push({ name: "bearish engulfing", dir: "bear", bar: c });

  // pin bar / hammer / shooting star: wick >= 2x body and >= 60% of the range, close in the outer third
  const lowerWick = Math.min(c.open, c.close) - c.low, upperWick = c.high - Math.max(c.open, c.close);
  if (lowerWick >= 2 * body(c) && lowerWick >= 0.6 * range(c) && c.close >= c.low + range(c) * 2 / 3) out.push({ name: "bullish pin bar", dir: "bull", bar: c });
  if (upperWick >= 2 * body(c) && upperWick >= 0.6 * range(c) && c.close <= c.high - range(c) * 2 / 3) out.push({ name: "bearish pin bar", dir: "bear", bar: c });

  // morning / evening star: big candle, small candle (body < 30% of the first), close past the first's midpoint
  if (bear(pp) && body(pp) >= avgBody && body(p) < 0.3 * body(pp) && bull(c) && c.close > (pp.open + pp.close) / 2) out.push({ name: "morning star", dir: "bull", bar: c });
  if (bull(pp) && body(pp) >= avgBody && body(p) < 0.3 * body(pp) && bear(c) && c.close < (pp.open + pp.close) / 2) out.push({ name: "evening star", dir: "bear", bar: c });

  // inside bar (p inside pp): breakout = close beyond the mother bar; false break = poke out and close back inside
  if (p.high <= pp.high && p.low >= pp.low) {
    if (c.close > pp.high) out.push({ name: "inside-bar breakout", dir: "bull", bar: c });
    else if (c.close < pp.low) out.push({ name: "inside-bar breakdown", dir: "bear", bar: c });
    else if (c.low < pp.low && c.close > pp.low) out.push({ name: "inside-bar false break (down)", dir: "bull", bar: c });
    else if (c.high > pp.high && c.close < pp.high) out.push({ name: "inside-bar false break (up)", dir: "bear", bar: c });
  }
  return out;
}

// Which key level the signal bar interacted with: pierced it or came within `tol` of it.
// For bull signals we look at the bar's low (support / reclaim), for bear at its high.
export function atLevel(pat, levels, tol) {
  const b = pat.bar;
  let best = null;
  for (const [name, v] of levels) {
    if (v == null) continue;
    const touch = pat.dir === "bull" ? b.low <= v + tol && b.close >= v - tol : b.high >= v - tol && b.close <= v + tol;
    if (!touch) continue;
    const d = Math.abs((pat.dir === "bull" ? b.low : b.high) - v);
    if (!best || d < best.d) best = { name, v, d };
  }
  // false break of a level: wick through it, close back on the other side
  return best;
}
