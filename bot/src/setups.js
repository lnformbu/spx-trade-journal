// Setups from the Saty training notes (pure functions: the live bot and scripts/replay.mjs use the same code).
//   trendScore  : is this a trend day, and which way (catches it early: 10m/3m ribbons, ORB hold, triggers, Golden Gate, 1h cloud, VIX)
//   pullback21  : "never chase, wait for the pullback": 3m bar pulls into the 21 EMA / 8-13 zone of a stacked ribbon and closes back
//   vomy        : Vomy / iVomy: a stacked ribbon breaks and HOLDS the 48 EMA (2 closes) = multi-EMA crossover reversal
import { ema, atr } from "./levels.js";

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const lastN = (a, n) => a.slice(Math.max(0, a.length - n));

// Wilder ATR(14) of intraday bars (tolerance for "touched the EMA" and "too extended")
export const barAtr = (bars) => (bars.length > 15 ? atr(lastN(bars, 80), 14) : null);

// Trend day score. Weights: 10m ribbon 2, 3m ribbon 1, ORB held 1, beyond the call/put trigger 1, Golden Gate (±38.2%) 1,
// 1h 20/21 cloud 1, VIX trending the other way 1, range used ≥ 50% of ATR 1 (max 9). Trend day = not choppy AND 6+ with the
// 10m ribbon and the trigger on that side.
export function trendScore({ closes3, orbh, orbl, lv, rib3, rib10, cloudH, vix, choppy, dtr }) {
  if (!closes3 || closes3.length < 3 || !lv) return null;
  const c0 = closes3[closes3.length - 1];
  const held = (f) => closes3.slice(-3).every(f);
  const sides = { bull: { score: 0, bits: [] }, bear: { score: 0, bits: [] } };
  const add = (dir, pts, txt) => { sides[dir].score += pts; sides[dir].bits.push(txt); };
  if (rib10 && rib10.state === "bullish") add("bull", 2, "10m ribbon bullish"); else if (rib10 && rib10.state === "bearish") add("bear", 2, "10m ribbon bearish");
  if (rib3 && rib3.state === "bullish") add("bull", 1, "3m ribbon bullish"); else if (rib3 && rib3.state === "bearish") add("bear", 1, "3m ribbon bearish");
  if (orbh != null && held((c) => c > orbh)) add("bull", 1, "holding above the opening range");
  if (orbl != null && held((c) => c < orbl)) add("bear", 1, "holding below the opening range");
  const trigUp = c0 > lv["+0.236"], trigDn = c0 < lv["-0.236"];
  if (trigUp) add("bull", 1, "above the call trigger"); if (trigDn) add("bear", 1, "below the put trigger");
  if (c0 >= lv["+0.382"]) add("bull", 1, "through the Golden Gate (+38.2%)"); if (c0 <= lv["-0.382"]) add("bear", 1, "through the Golden Gate (−38.2%)");
  if (cloudH === "up") add("bull", 1, "1h cloud up"); else if (cloudH === "down") add("bear", 1, "1h cloud down");
  if (vix === "falling") add("bull", 1, "VIX trending down"); else if (vix === "rising") add("bear", 1, "VIX trending up");
  const dir = sides.bull.score >= sides.bear.score ? "bull" : "bear", S = sides[dir];
  if (dtr != null && dtr >= 50 && S.score > 0) add(dir, 1, `${dtr}% of the daily ATR already used`);
  const trend = !choppy && S.score >= 6 && rib10 && rib10.state === (dir === "bull" ? "bullish" : "bearish") && (dir === "bull" ? trigUp : trigDn);
  return { dir, score: S.score, max: 9, bits: S.bits, trend: !!trend, other: sides[dir === "bull" ? "bear" : "bull"].score };
}

// 21 EMA pullback on 3m bars (bars should include earlier days so the EMAs are settled)
export function pullback21(bars, dir) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map((b) => b.close);
  const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21), e48 = ema(c, 48);
  const i = bars.length - 1, b = bars[i], A = barAtr(bars);
  if (!A) return null;
  const tol = A * 0.15, bull = dir === "bull";
  const stacked = bull ? e8[i] >= e21[i] && e13[i] >= e48[i] : e8[i] <= e21[i] && e13[i] <= e48[i];
  if (!stacked) return null;
  // came from extension: in the last 6 bars price was beyond the 8 EMA
  const came = bars.slice(-7, -1).some((x, k) => { const j = i - 6 + k; return bull ? x.high > e8[j] + tol : x.low < e8[j] - tol; });
  // touched the 21 EMA / 8-13 zone without losing the 48
  const touched = bull ? b.low <= e21[i] + tol && b.low >= e48[i] - tol : b.high >= e21[i] - tol && b.high <= e48[i] + tol;
  // closed back on the trend side of the 13 with a body in the trend direction
  const reclaimed = bull ? b.close >= e13[i] && b.close > b.open : b.close <= e13[i] && b.close < b.open;
  if (!came || !touched || !reclaimed) return null;
  if (Math.abs(b.close - e21[i]) > 2 * A) return null; // too extended: don't chase
  return {
    dir, bar: b, entry: bull ? b.high : b.low,
    // risk beyond the 21 EMA zone by half a 3m ATR (replay: 53% wins vs 47% with a stop just past the candle)
    stop: bull ? Math.min(b.low, e21[i]) - A * 0.5 : Math.max(b.high, e21[i]) + A * 0.5,
    ema8: r2(e8[i]), ema13: r2(e13[i]), ema21: r2(e21[i]), ema48: r2(e48[i]), atr3: r2(A),
  };
}

// Confluence for a 21 EMA pullback (1 point each): trend mode on, other 21 EMAs stacked at the touch (10m / 1h / daily),
// a quiet pullback (SPY 3m volume on the dip under 80% of the push before it), VIX moving the other way,
// Golden Gate already crossed that way, 1h cloud agreeing.
export function pbConfluence({ dir, trendOn, stack, spyVol3, ggCrossed, cloudH, vix }) {
  const bits = [];
  if (trendOn) bits.push("trend mode");
  if (stack && stack.length) bits.push("stacked 21s (" + stack.join(", ") + ")");
  if (spyVol3 && spyVol3.length >= 12) {
    const v = spyVol3.slice(-12), dip = (v[9] + v[10] + v[11]) / 3, push = v.slice(0, 9).reduce((s, x) => s + x, 0) / 9;
    if (push > 0 && dip < push * 0.8) bits.push(`quiet pullback (volume ${Math.round((dip / push) * 100)}% of the push)`);
  }
  if (vix && vix === (dir === "bull" ? "falling" : "rising")) bits.push(`VIX ${vix}`);
  if (ggCrossed) bits.push("Golden Gate crossed");
  if (cloudH && cloudH === (dir === "bull" ? "up" : "down")) bits.push("1h cloud " + cloudH);
  return { score: bits.length, bits };
}

// Vomy (bearish) / iVomy (bullish) on 3m bars: a stacked ribbon in the last 30 bars, then 2 closes through the 48 EMA
export function vomy(bars) {
  if (!bars || bars.length < 80) return null;
  const c = bars.map((b) => b.close);
  const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21), e48 = ema(c, 48);
  const i = bars.length - 1, b = bars[i];
  const stackedRun = (up) => {
    let run = 0, best = 0;
    for (let j = i - 32; j <= i - 3; j++) {
      const s = up ? e8[j] > e13[j] && e13[j] > e21[j] && e21[j] > e48[j] : e8[j] < e13[j] && e13[j] < e21[j] && e21[j] < e48[j];
      run = s ? run + 1 : 0; best = Math.max(best, run);
    }
    return best >= 6;
  };
  // bearish Vomy: was stacked up, now 2 closes below the 48 after a close above it
  if (c[i] < e48[i] && c[i - 1] < e48[i - 1] && c[i - 2] >= e48[i - 2] && stackedRun(true)) {
    return { dir: "bear", bar: b, entry: b.low, stop: Math.max(e13[i], b.high), ema13: r2(e13[i]), ema48: r2(e48[i]) };
  }
  if (c[i] > e48[i] && c[i - 1] > e48[i - 1] && c[i - 2] <= e48[i - 2] && stackedRun(false)) {
    return { dir: "bull", bar: b, entry: b.high, stop: Math.min(e13[i], b.low), ema13: r2(e13[i]), ema48: r2(e48[i]) };
  }
  return null;
}

// Vomy early entry (training notes #3): the ribbon was stacked, price broke the 13 EMA, now RETESTS the 13 and gets rejected.
// Bearish: bar reaches up to the 13, closes back below it and red. Risk = a close beyond the 13.
export function vomyRetest13(bars) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map((b) => b.close);
  const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21), e48 = ema(c, 48);
  const i = bars.length - 1, b = bars[i], A = barAtr(bars);
  if (!A) return null;
  const tol = A * 0.15;
  const wasStacked = (up) => {
    let run = 0, best = 0;
    for (let j = i - 30; j <= i - 2; j++) {
      const s = up ? e8[j] > e13[j] && e13[j] > e21[j] && e21[j] > e48[j] : e8[j] < e13[j] && e13[j] < e21[j] && e21[j] < e48[j];
      run = s ? run + 1 : 0; best = Math.max(best, run);
    }
    return best >= 6;
  };
  const brokeBelow = c.slice(i - 8, i).some((x, k) => x < e13[i - 8 + k]), brokeAbove = c.slice(i - 8, i).some((x, k) => x > e13[i - 8 + k]);
  if (wasStacked(true) && brokeBelow && b.high >= e13[i] - tol && b.close < e13[i] && b.close < b.open) {
    return { dir: "bear", bar: b, entry: b.low, stop: Math.max(b.high, e13[i]) + tol, ema13: r2(e13[i]), ema48: r2(e48[i]) };
  }
  if (wasStacked(false) && brokeAbove && b.low <= e13[i] + tol && b.close > e13[i] && b.close > b.open) {
    return { dir: "bull", bar: b, entry: b.high, stop: Math.min(b.low, e13[i]) - tol, ema13: r2(e13[i]), ema48: r2(e48[i]) };
  }
  return null;
}

// ORB break-and-hold (opening window): the first time two 3m closes in a row hold beyond the 9:30-9:33 range, with the 10m ribbon agreeing.
// bars = today's completed 3m RTH bars (bar 0 = the opening range). Entry: 1m break of the 2nd bar; stop: under/over both bars.
export function orbBreak(bars, orbh, orbl, rib10) {
  if (!bars || bars.length < 3 || orbh == null || orbl == null) return null;
  const i = bars.length - 1, b = bars[i], p = bars[i - 1];
  const before = bars.slice(1, i - 1);
  if (p.close > orbh && b.close > orbh && !before.some((x) => x.close > orbh) && rib10 && rib10.state === "bullish") {
    return { dir: "bull", bar: b, entry: b.high, stop: Math.min(p.low, b.low), orbh, orbl };
  }
  if (p.close < orbl && b.close < orbl && !before.some((x) => x.close < orbl) && rib10 && rib10.state === "bearish") {
    return { dir: "bear", bar: b, entry: b.low, stop: Math.max(p.high, b.high), orbh, orbl };
  }
  return null;
}

// ATR level break-and-retest (PDF 5: NVDA call-trigger retest, CAR put-trigger retest, midrange retest; SPY 8-EMA ride):
// within the last 20 3m bars a close went through level L and no close has come back through it since; now a 3m bar
// tags L (within tol) and closes back on the break side with a body in that direction. Entry: 1m break of that bar;
// stop: just beyond L; target: the next major level (Golden Gate / midrange / ±1 ATR).
export function levelRetest(bars, levels, tolAbs) {
  if (!bars || bars.length < 5) return null;
  const i = bars.length - 1, b = bars[i];
  for (const [name, L] of levels) {
    if (L == null) continue;
    for (const dir of ["bull", "bear"]) {
      const up = dir === "bull";
      const beyond = (c) => (up ? c > L : c < L);
      // the break: first close through L within the last 20 bars, after a close on the other side
      let k = -1;
      for (let j = Math.max(1, i - 20); j < i; j++) if (beyond(bars[j].close) && !beyond(bars[j - 1].close)) k = j;
      if (k < 0) continue;
      if (bars.slice(k, i).some((x) => !beyond(x.close))) continue;          // came back through: no retest, it failed
      if (i - k < 2) continue;                                                 // need at least one bar away first
      const tagged = up ? b.low <= L + tolAbs : b.high >= L - tolAbs;
      const held = up ? b.close > L && b.close > b.open : b.close < L && b.close < b.open;
      if (tagged && held) return { dir, name, level: L, bar: b, entry: up ? b.high : b.low, stop: up ? Math.min(b.low, L) - tolAbs : Math.max(b.high, L) + tolAbs };
    }
  }
  return null;
}

// 8 EMA ride (PDF 5, chart 1: in a strong trend price tests the top of the ribbon and never reaches the 21)
export function pullback8(bars, dir) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map((b) => b.close);
  const e8 = ema(c, 8), e13 = ema(c, 13), e21 = ema(c, 21), e48 = ema(c, 48);
  const i = bars.length - 1, b = bars[i], A = barAtr(bars);
  if (!A) return null;
  const tol = A * 0.15, up = dir === "bull";
  const stacked = up ? e8[i] > e13[i] && e13[i] > e21[i] && e21[i] > e48[i] : e8[i] < e13[i] && e13[i] < e21[i] && e21[i] < e48[i];
  if (!stacked) return null;
  const touched = up ? b.low <= e8[i] + tol && b.low > e21[i] : b.high >= e8[i] - tol && b.high < e21[i];
  const held = up ? b.close > e8[i] && b.close > b.open : b.close < e8[i] && b.close < b.open;
  const came = bars.slice(-7, -1).some((x, k) => { const j = i - 6 + k; return up ? x.low > e8[j] + tol : x.high < e8[j] - tol; });
  if (!touched || !held || !came) return null;
  return { dir, bar: b, entry: up ? b.high : b.low, stop: up ? Math.min(b.low, e13[i]) - tol : Math.max(b.high, e13[i]) + tol, ema8: r2(e8[i]) };
}

// "Psych" pivot: the Day-mode ATR level nearest to price, rounded to the nearest step (VIX 0.5, SPX 5)
export function marketPivot(price, atrLevels, step) {
  if (price == null || !atrLevels) return null;
  const lvl = Object.values(atrLevels).sort((a, b) => Math.abs(a - price) - Math.abs(b - price))[0];
  return lvl == null ? null : Math.round(lvl / step) * step;
}
