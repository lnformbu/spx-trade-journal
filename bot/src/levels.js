// Pure calculations: no network, no storage. Candles are Schwab's {open,high,low,close,volume,datetime(ms)}.

const ET = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short",
});
// New York date ("2026-11-12"), minute of the day (9:30 = 570) and weekday for a timestamp.
export function et(ms) {
  const p = Object.fromEntries(ET.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, min: +p.hour * 60 + +p.minute, wd: p.weekday };
}
export const hhmm = (min) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;

export const OPEN = 570, CLOSE = 960; // 9:30, 16:00
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);

// Exponential average seeded with the first value (thinkorswim's ExpAverage).
export function ema(values, n) {
  const k = 2 / (n + 1);
  let e = null;
  return values.map((v) => (e = e === null ? v : v * k + e * (1 - k)));
}

// Wilder ATR (TradingView ta.atr / thinkorswim ATR): SMA of the first n true ranges, then smoothed.
export function atr(daily, n = 14) {
  const tr = daily.map((c, i) => (i ? Math.max(c.high - c.low, Math.abs(c.high - daily[i - 1].close), Math.abs(c.low - daily[i - 1].close)) : c.high - c.low));
  if (tr.length < n) return null;
  let a = tr.slice(0, n).reduce((s, x) => s + x, 0) / n;
  for (let i = n; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}

// Daily candles carry a midnight timestamp; take the date that midnight belongs to.
export const dailyDate = (c) => new Date(c.datetime + 12 * 3600e3).toISOString().slice(0, 10);

// ---- Saty ATR Levels (from the thinkorswim study) ----
// Scalp = 4-hour bars, Day = daily, Multiday = weekly, Swing = monthly. Pivot = previous period close,
// ATR = Wilder 14 of the previous period, rounded to cents. Levels = pivot ± ATR × fib, up to ±3 ATR.
export const ATR_FIBS = [0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.236, 1.382, 1.5, 1.618, 1.786, 2, 2.236, 2.618, 3];
function levelSet(prevClose, a) {
  const lv = {};
  for (const f of ATR_FIBS) { lv["+" + f] = r2(prevClose + a * f); lv["-" + f] = r2(prevClose - a * f); }
  return lv;
}
// periods = completed bars of the mode's timeframe (oldest first), the last one being the "previous period"
export function modeLevels(periods) {
  if (periods.length < 15) return null;
  const prev = periods[periods.length - 1];
  const a = r2(atr(periods, 14));
  return { prevClose: r2(prev.close), atr: a, atrLevels: levelSet(prev.close, a) };
}
// Day mode from daily candles + yesterday's high/low/close
export function dayLevels(daily, today) {
  const done = daily.filter((c) => dailyDate(c) < today);
  const prev = done[done.length - 1];
  if (!prev) return null;
  const m = modeLevels(done);
  if (!m) return null;
  return { prevDate: dailyDate(prev), pdh: r2(prev.high), pdl: r2(prev.low), pdc: r2(prev.close), atr: m.atr, atrLevels: m.atrLevels };
}
// DTR: today's range as % of the daily ATR ("86% used")
// (ATR here includes today, like your DTR study: (yesterday's ATR × 13 + today's true range) ÷ 14)
export function dtrPct(hod, lod, a, pdc) {
  if (hod == null || lod == null || !a) return null;
  const tr = pdc != null ? Math.max(hod - lod, Math.abs(hod - pdc), Math.abs(lod - pdc)) : hod - lod;
  return Math.round(((hod - lod) / ((a * 13 + tr) / 14)) * 100);
}

// Groups candles into bars of `size` minutes, aligned to the clock in New York time.
// offset shifts the alignment (e.g. -30 so regular-hours hourly bars start at 9:30).
export function aggregate(candles, size, offset = 0) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const t = et(c.datetime);
    const slot = Math.floor((t.min + offset) / size);
    const key = t.date + "|" + slot;
    if (!cur || cur.key !== key) {
      cur = { key, date: t.date, min: slot * size - offset, datetime: c.datetime, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      out.push(cur);
    } else {
      cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume;
    }
  }
  return out;
}

// ---- Saty Pivot Ribbon Pro ----
// fast cloud = EMA 8 vs 21, slow cloud = EMA 13 vs 48 (pullback overlap), long-term = EMA 200 with 21-vs-200 bias,
// conviction arrow = EMA 13 crossing EMA 48, candle bias = close vs EMA 48. ATR-levels trend label = 8 / 21 / 34.
export function ribbon(bars) {
  const closes = bars.map((b) => b.close);
  const L = [8, 13, 21, 34, 48, 200];
  const e = Object.fromEntries(L.map((n) => [n, ema(closes, n)]));
  const at = (i) => Object.fromEntries(L.map((n) => [n, r2(e[n][i])]));
  const last = bars.length - 1;
  if (last < 1) return null;
  const state = (i) => {
    const v = at(i);
    const fastUp = v[8] >= v[21], slowUp = v[13] >= v[48];
    return fastUp && slowUp ? "bullish" : !fastUp && !slowUp ? "bearish" : "mixed";
  };
  let flips = 0;
  for (let i = Math.max(1, last - 5); i <= last; i++) if (state(i) !== state(i - 1)) flips++;
  const gap = (i) => Math.abs(at(i)[8] - at(i)[21]);
  const v = at(last), p = at(last - 1), c = closes[last];
  const conv = v[13] >= v[48] && p[13] < p[48] ? "bullish conviction" : v[13] < v[48] && p[13] >= p[48] ? "bearish conviction" : null;
  return {
    ema: v, state: state(last), flips, conviction: conv,
    fastCloud: v[8] >= v[21] ? "up" : "down", slowCloud: v[13] >= v[48] ? "up" : "down",
    longTerm: v[21] >= v[200] ? "bullish" : "bearish",
    trendLabel: c >= v[8] && v[8] >= v[21] && v[21] >= v[34] ? "bullish" : c <= v[8] && v[8] <= v[21] && v[21] <= v[34] ? "bearish" : "neutral",
    candleBias: c >= v[48] ? "above 48" : "below 48",
    expanding: last >= 2 && gap(last) > gap(last - 1) && gap(last - 1) > gap(last - 2),
    close: r2(c), barTime: bars[last] ? hhmm(et(bars[last].datetime).min) : null,
  };
}

// 20/21 EMA cloud (hourly / daily trend in your MTF cloud study)
export function cloud2021(bars) {
  if (bars.length < 21) return null;
  const c = bars.map((b) => b.close);
  return ema(c, 20).at(-1) > ema(c, 21).at(-1) ? "up" : "down";
}

// Wilder ATR as a series, rounded like the study
function atrSeries(bars, n = 14) {
  const out = [];
  let a = null, sum = 0;
  bars.forEach((c, i) => {
    const tr = i ? Math.max(c.high - c.low, Math.abs(c.high - bars[i - 1].close), Math.abs(c.low - bars[i - 1].close)) : c.high - c.low;
    if (i < n) { sum += tr; a = i === n - 1 ? sum / n : null; }
    else a = (a * (n - 1) + tr) / n;
    out.push(a == null ? null : r2(a));
  });
  return out;
}
const stdev = (xs) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };

// Compression tracker exactly as in the study: 1 = compressing
function compressionTracker(closes, pivot, at) {
  const comp = [], track = [];
  for (let i = 0; i < closes.length; i++) {
    if (at[i] == null || i < 20) { comp.push(null); track.push(0); continue; }
    const off = 2 * stdev(closes.slice(i - 20, i + 1));
    const up = pivot[i] + off, dn = pivot[i] - off, above = closes[i] >= pivot[i];
    const c = above ? up - (pivot[i] + 2 * at[i]) : (pivot[i] - 2 * at[i]) - dn;
    const ez = above ? up - (pivot[i] + 1.854 * at[i]) : (pivot[i] - 1.854 * at[i]) - dn;
    const expansion = comp[i - 1] != null && comp[i - 1] <= c;
    comp.push(c);
    track.push(expansion && ez > 0 ? 0 : c <= 0 ? 1 : 0);
  }
  return track;
}

// ---- Saty Phase Oscillator ----
export function phaseOsc(bars) {
  if (bars.length < 30) return null;
  const closes = bars.map((b) => b.close);
  const pivot = ema(closes, 21);
  const at = atrSeries(bars, 14);
  const raw = closes.map((c, i) => (at[i] ? r2(((c - pivot[i]) / (3 * at[i])) * 100) : 0));
  const osc = ema(raw, 3).map(r2);
  const track = compressionTracker(closes, pivot, at);
  const n = bars.length - 1, o = osc[n], p = osc[n - 1];
  const cross = p <= -100 && o > -100 ? "leaving extreme down" : p <= -61.8 && o > -61.8 ? "leaving accumulation"
    : p >= 100 && o < 100 ? "leaving extreme up" : p >= 61.8 && o < 61.8 ? "leaving distribution" : null;
  return {
    value: o, prev: p, cross,
    flip: cross ? (cross.includes("down") || cross.includes("accumulation") ? "oversold flip up" : "overbought flip down") : null,
    zone: o >= 100 ? "extended up" : o >= 61.8 ? "distribution" : o > 23.6 ? "mark up" : o >= -23.6 ? "launch box" : o > -61.8 ? "mark down" : o > -100 ? "accumulation" : "extended down",
    compression: track[n] === 1, squeezeFired: track[n - 1] === 1 && track[n] === 0,
    _track: track, _osc: osc,
  };
}

// ---- Saty Compression Bangerz: box = high/low of the first 3 compression candles of the current run ----
export function compressionBox(bars, track, len = 3) {
  let box = null, run = null;
  for (let i = 0; i < bars.length; i++) {
    if (track[i] === 1 && track[i - 1] !== 1) run = { start: i, high: bars[i].high, low: bars[i].low, n: 1 };
    else if (track[i] === 1 && run && run.n < len) { run.high = Math.max(run.high, bars[i].high); run.low = Math.min(run.low, bars[i].low); run.n++; }
    if (run && (run.n === len || (track[i] === 0 && track[i - 1] === 1))) box = { high: r2(run.high), low: r2(run.low), mid: r2((run.high + run.low) / 2), from: run.start };
    if (track[i] === 0 && track[i - 1] === 1) run = null;
  }
  return box;
}

// ---- Choppiness Index (14): 100 × log10(sum of true ranges ÷ (highest high − lowest low)) ÷ log10(14). Above 61.8 = choppy ----
export function chop(bars, n = 14) {
  if (bars.length < n + 1) return null;
  const w = bars.slice(-n);
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = bars[i], p = bars[i - 1];
    sum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const range = Math.max(...w.map((b) => b.high)) - Math.min(...w.map((b) => b.low));
  return range > 0 ? r2((100 * Math.log10(sum / range)) / Math.log10(n)) : null;
}
// how often the 1-minute closes crossed VWAP in the last `mins` minutes (VWAP recomputed bar by bar)
export function vwapCrosses(rth, mins = 60) {
  let pv = 0, v = 0, prevSide = null, crosses = 0;
  const from = rth.length - mins;
  rth.forEach((c, i) => {
    pv += ((c.high + c.low + c.close) / 3) * c.volume; v += c.volume;
    if (!v) return;
    const side = c.close >= pv / v;
    if (i >= from && prevSide !== null && side !== prevSide) crosses++;
    prevSide = side;
  });
  return crosses;
}

// ---- Divergence: price makes a higher high while the Phase Oscillator makes a lower high (bearish), or the reverse.
// Pivots = a high/low with 2 lower highs / higher lows on each side; the newer pivot must be within the last 6 bars.
export function divergence(bars, osc) {
  if (!osc || bars.length < 20) return null;
  const n = bars.length, piv = (i, f, cmp) => [1, 2].every((d) => cmp(f(bars[i]), f(bars[i - d])) && cmp(f(bars[i]), f(bars[i + d])));
  const highs = [], lows = [];
  for (let i = Math.max(2, n - 40); i < n - 2; i++) {
    if (piv(i, (b) => b.high, (a, b) => a > b)) highs.push(i);
    if (piv(i, (b) => b.low, (a, b) => a < b)) lows.push(i);
  }
  const h2 = highs.at(-1), h1 = highs.at(-2), l2 = lows.at(-1), l1 = lows.at(-2);
  if (h2 != null && h1 != null && n - 1 - h2 <= 6 && bars[h2].high > bars[h1].high && osc[h2] < osc[h1])
    return { dir: "bear", text: `higher high ${bars[h2].high} vs ${bars[h1].high}, oscillator lower ${osc[h2]} vs ${osc[h1]}`, at: bars[h2].datetime };
  if (l2 != null && l1 != null && n - 1 - l2 <= 6 && bars[l2].low < bars[l1].low && osc[l2] > osc[l1])
    return { dir: "bull", text: `lower low ${bars[l2].low} vs ${bars[l1].low}, oscillator higher ${osc[l2]} vs ${osc[l1]}`, at: bars[l2].datetime };
  return null;
}

// ---- Saty Volume Stack: buyers vs sellers from where the candle closed in its range ----
export function volumeStack(b) {
  const r = b.high - b.low;
  if (!r || !b.volume) return null;
  const buy = Math.round(((b.close - b.low) / r) * 1000) / 10;
  return { buy, sell: Math.round((100 - buy) * 10) / 10, winner: buy >= 50 ? "buyers" : "sellers" };
}

// ---- Anchored VWAP (hlc3) with ±1σ / ±2σ bands ----
export function avwap(bars, anchorMs) {
  let pv = 0, v = 0, pv2 = 0;
  for (const b of bars) {
    if (b.datetime < anchorMs) continue;
    const p = (b.high + b.low + b.close) / 3;
    pv += p * b.volume; v += b.volume; pv2 += p * p * b.volume;
  }
  if (!v) return null;
  const m = pv / v, sd = Math.sqrt(Math.max(pv2 / v - m * m, 0));
  return { vwap: r2(m), up1: r2(m + sd), dn1: r2(m - sd), up2: r2(m + 2 * sd), dn2: r2(m - 2 * sd) };
}

// Levels built from today's 1-minute candles (extended hours) plus the previous session's evening.
export function intradayLevels(min1, today, prevDate) {
  const rows = min1.map((c) => ({ ...c, t: et(c.datetime) }));
  const hiLo = (list) => (list.length ? { high: r2(Math.max(...list.map((c) => c.high))), low: r2(Math.min(...list.map((c) => c.low))) } : null);
  const pre = rows.filter((c) => c.t.date === today && c.t.min >= 240 && c.t.min < OPEN);
  const night = rows.filter((c) => (c.t.date === prevDate && c.t.min >= CLOSE) || (c.t.date === today && c.t.min < OPEN));
  const rth = rows.filter((c) => c.t.date === today && c.t.min >= OPEN && c.t.min < CLOSE);
  const orb = rth.filter((c) => c.t.min < OPEN + 3);
  let pv = 0, vol = 0;
  for (const c of rth) { pv += ((c.high + c.low + c.close) / 3) * c.volume; vol += c.volume; }
  const pm = hiLo(pre), on = hiLo(night), day = hiLo(rth), or = orb.length === 3 ? hiLo(orb) : null;
  return {
    pmh: pm && pm.high, pml: pm && pm.low,
    onh: on && on.high, onl: on && on.low,
    orbh: or && or.high, orbl: or && or.low,
    hod: day && day.high, lod: day && day.low,
    open: rth.length ? r2(rth[0].open) : null,
    vwap: vol ? r2(pv / vol) : null,
    last: rows.length ? r2(rows[rows.length - 1].close) : null,
  };
}
