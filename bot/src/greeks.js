// SPX greek exposure by strike (like the "Spot" greek-exposure boards), from Schwab's option chain.
// Open interest is last night's (Schwab/OCC update it once a day), so this is the start-of-day positioning,
// re-priced through the day with the live spot, IV and time.
//
// Conventions (per strike, summed over the expirations fetched):
//   GEX   = gamma × OI × 100 × spot² × 1%      calls +, puts −   ($ of hedging per 1% move)
//   DEX   = delta × OI × 100 × spot            (put delta is negative)  ($ delta)
//   Vanna = vanna × OI × 100 × spot × 1 vol pt  calls +, puts −   ($ delta change per +1 IV point)
//   Charm = charm × OI × 100 × spot ÷ 365       (put charm uses the put formula)  ($ delta change per day)
const R = 0.04, Q = 0.013; // rates and SPX dividend yield (approximate; they barely matter for short-dated options)
const SQ2PI = Math.sqrt(2 * Math.PI);
const pdf = (x) => Math.exp(-0.5 * x * x) / SQ2PI;
function cdf(x) { // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function bs(S, K, T, s, isCall) {
  const sq = Math.sqrt(T), d1 = (Math.log(S / K) + (R - Q + (s * s) / 2) * T) / (s * sq), d2 = d1 - s * sq;
  const eq = Math.exp(-Q * T), n1 = pdf(d1);
  const gamma = (eq * n1) / (S * s * sq);
  const delta = isCall ? eq * cdf(d1) : -eq * cdf(-d1);
  const vanna = (-eq * n1 * d2) / s;
  const common = (n1 * (2 * (R - Q) * T - d2 * s * sq)) / (2 * T * s * sq);
  const charm = isCall ? Q * eq * cdf(d1) - eq * common : -Q * eq * cdf(-d1) - eq * common;
  return { gamma, delta, vanna, charm };
}

// chain = Schwab /marketdata/v1/chains response; nowMs for time to expiry (16:00 ET close)
export function exposures(chain, spot, nowMs) {
  const rows = new Map();
  const legs = [];
  for (const [map, isCall] of [[chain.callExpDateMap, true], [chain.putExpDateMap, false]]) {
    for (const exp in map || {}) {
      const expDate = exp.split(":")[0];
      // years to 16:00 New York on the expiry date (at least 15 minutes)
      const close = Date.parse(expDate + "T21:00:00Z") - (isDST(expDate) ? 3600e3 : 0);
      const T = Math.max((close - nowMs) / (365 * 864e5), 15 / (365 * 24 * 60));
      for (const k in map[exp]) for (const o of map[exp][k]) {
        const oi = o.openInterest || 0;
        const iv = (o.volatility || 0) / 100;
        if (!oi || !(iv > 0.01) || iv > 5) continue;
        legs.push({ K: o.strikePrice, T, iv, oi, isCall });
      }
    }
  }
  const agg = (S) => {
    const by = new Map();
    for (const l of legs) {
      const g = bs(S, l.K, l.T, l.iv, l.isCall);
      const r = by.get(l.K) || { strike: l.K, gex: 0, dex: 0, vanna: 0, charm: 0, callOI: 0, putOI: 0 };
      const sign = l.isCall ? 1 : -1;
      r.gex += sign * g.gamma * l.oi * 100 * S * S * 0.01;
      r.dex += g.delta * l.oi * 100 * S;
      r.vanna += sign * g.vanna * l.oi * 100 * S * 0.01;
      r.charm += (g.charm * l.oi * 100 * S) / 365;
      if (l.isCall) r.callOI += l.oi; else r.putOI += l.oi;
      by.set(l.K, r);
    }
    return by;
  };
  const by = agg(spot);
  const strikes = [...by.values()].sort((a, b) => a.strike - b.strike);
  const sum = (f) => strikes.reduce((s, r) => s + r[f], 0);
  // gamma flip: where total GEX changes sign as spot moves (searched ±4% around spot)
  let flip = null, prev = null;
  for (let i = -40; i <= 40; i++) {
    const S = spot * (1 + i * 0.001);
    let g = 0;
    for (const l of legs) g += (l.isCall ? 1 : -1) * bs(S, l.K, l.T, l.iv, l.isCall).gamma * l.oi * 100 * S * S * 0.01;
    if (prev && Math.sign(prev.g) !== Math.sign(g)) {
      const x = prev.S + ((S - prev.S) * Math.abs(prev.g)) / (Math.abs(prev.g) + Math.abs(g));
      if (!flip || Math.abs(x - spot) < Math.abs(flip - spot)) flip = x;
    }
    prev = { S, g };
  }
  const callWall = strikes.reduce((b, r) => (!b || r.gex > b.gex ? r : b), null);
  const putWall = strikes.reduce((b, r) => (!b || r.gex < b.gex ? r : b), null);
  const round = (x) => Math.round(x);
  return {
    at: nowMs, spot,
    totals: { gex: round(sum("gex")), dex: round(sum("dex")), vanna: round(sum("vanna")), charm: round(sum("charm")) },
    flip: flip && Math.round(flip * 100) / 100,
    callWall: callWall && callWall.strike, putWall: putWall && putWall.strike,
    strikes: strikes.map((r) => ({ strike: r.strike, gex: round(r.gex), dex: round(r.dex), vanna: round(r.vanna), charm: round(r.charm), callOI: r.callOI, putOI: r.putOI })),
  };
}
// US daylight time: second Sunday of March to first Sunday of November
function isDST(date) {
  const [y, m, d] = date.split("-").map(Number);
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  const firstSun = (mm) => { const wd = new Date(Date.UTC(y, mm - 1, 1)).getUTCDay(); return 1 + ((7 - wd) % 7); };
  return m === 3 ? d >= firstSun(3) + 7 : d < firstSun(11);
}
