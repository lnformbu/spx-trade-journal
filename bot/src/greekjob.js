// Every 5 minutes, 9:25-16:05 ET: SPX greek exposure board + 0DTE leaderboard (LB).
//   board  : GEX / DEX / vanna / charm per strike, call wall, put wall, gamma flip, "Eye of Sauron" (huge negative-GEX node)
//   LB     : top 10 SPX 0DTE contracts by volume, each with its own VWAP (built from the 5-minute volume snapshots),
//            holders in profit vs VWAP -> shakeout candidates; max-pain spot for in-the-money LB holders (power hour / last 10 min)
import { et, hhmm, OPEN, CLOSE } from "./levels.js";
import { exposures } from "./greeks.js";

const r2 = (x) => Math.round(x * 100) / 100;

function legsOf(chain, only0dte, today) {
  const out = [];
  for (const [map, type] of [[chain.callExpDateMap, "C"], [chain.putExpDateMap, "P"]]) {
    for (const exp in map || {}) {
      if (only0dte && exp.split(":")[0] !== today) continue;
      for (const k in map[exp]) for (const o of map[exp][k]) out.push({ ...o, type, exp: exp.split(":")[0] });
    }
  }
  return out;
}

export async function runGreeks(env, deps, { force = false } = {}) {
  const { schwabToken, schwab, readJSON, writeJSON } = deps;
  const now = Date.now(), t = et(now);
  if (!force && (t.min < OPEN - 5 || t.min > CLOSE + 5)) return { skipped: "market closed" };
  const token = await schwabToken(env);
  const to = new Date(now + 3 * 864e5).toISOString().slice(0, 10);
  const chain = await schwab(token, `/marketdata/v1/chains?symbol=%24SPX&strikeCount=40&fromDate=${t.date}&toDate=${to}`);
  const spot = chain.underlyingPrice;
  const legs = legsOf(chain, false, t.date);
  const spxOI = legs.reduce((s, o) => s + (o.openInterest || 0), 0);

  // ---- board: SPX open interest if Schwab has it, otherwise SPY options mapped onto SPX strikes ----
  let g;
  if (spxOI > 0) {
    g = exposures(chain, spot, now);
    g.source = "SPX options";
  } else {
    const spy = await schwab(token, `/marketdata/v1/chains?symbol=SPY&strikeCount=40&fromDate=${t.date}&toDate=${to}`);
    const ratio = spot / spy.underlyingPrice;
    const e = exposures(spy, spy.underlyingPrice, now);
    const by = new Map();
    for (const r of e.strikes) {
      const k = Math.round((r.strike * ratio) / 5) * 5;
      const x = by.get(k) || { strike: k, gex: 0, dex: 0, vanna: 0, charm: 0, callOI: 0, putOI: 0 };
      for (const f of ["gex", "dex", "vanna", "charm", "callOI", "putOI"]) x[f] += r[f];
      by.set(k, x);
    }
    g = {
      ...e, spot, strikes: [...by.values()].sort((a, b) => a.strike - b.strike),
      flip: e.flip && r2(e.flip * ratio), callWall: e.callWall && Math.round((e.callWall * ratio) / 5) * 5, putWall: e.putWall && Math.round((e.putWall * ratio) / 5) * 5,
      source: "SPY options mapped to SPX strikes (Schwab gives no SPX open interest)", ratio: r2(ratio),
    };
  }
  // Eye of Sauron: the biggest negative-GEX node within ±1.5% of spot, at least 2x the next one
  const near = g.strikes.filter((r) => Math.abs(r.strike - spot) / spot <= 0.015 && r.gex < 0).sort((a, b) => a.gex - b.gex);
  g.eye = near.length && (near.length === 1 || near[0].gex <= 2 * near[1].gex) ? { strike: near[0].strike, gex: near[0].gex } : null;

  // ---- leaderboard: SPX 0DTE contracts, contract VWAP from volume changes between snapshots ----
  const lbKey = "lb:spx:" + t.date;
  const lb = (await readJSON(env, lbKey)) || { c: {} };
  for (const o of legsOf(chain, true, t.date)) {
    const vol = o.totalVolume || 0;
    const px = o.last || o.mark;
    if (!vol || !(px > 0)) continue;
    const c = lb.c[o.symbol] || (lb.c[o.symbol] = { k: o.strikePrice, t: o.type, vol: 0, pv: 0, vw: 0 });
    const dv = vol - c.vol;
    if (dv > 0) { c.pv += dv * px; c.vw += dv; }
    c.vol = vol; c.last = px; c.bid = o.bid; c.ask = o.ask;
  }
  lb.at = now;
  await writeJSON(env, lbKey, lb);
  const top = Object.values(lb.c).sort((a, b) => b.vol - a.vol).slice(0, 10).map((c) => {
    const vwap = c.vw ? c.pv / c.vw : c.last;
    const pnl = vwap ? c.last / vwap - 1 : 0;
    const itm = c.t === "C" ? spot > c.k : spot < c.k;
    return { label: `${c.k}${c.t}`, strike: c.k, type: c.t, vol: c.vol, last: r2(c.last), vwap: r2(vwap), pnlPct: Math.round(pnl * 100), itm,
      // holders well in profit on a top contract: a shakeout against them is likely before continuation or reversal
      shakeout: pnl >= 0.2 ? (c.t === "C" ? "dip to shake call holders" : "pop to shake put holders") : null };
  });
  // max pain for in-the-money LB holders (volume-weighted intrinsic value), searched ±1% around spot
  const lo = Math.floor((spot * 0.99) / 5) * 5, hi = Math.ceil((spot * 1.01) / 5) * 5;
  let best = null;
  for (let S = lo; top.length && S <= hi; S += 1) {
    const pain = top.reduce((s, c) => s + c.vol * Math.max(0, c.type === "C" ? S - c.strike : c.strike - S), 0);
    if (!best || pain < best.pain) best = { S, pain };
  }
  const zone = best ? (() => {
    const ok = [];
    for (let S = lo; S <= hi; S += 1) {
      const pain = top.reduce((s, c) => s + c.vol * Math.max(0, c.type === "C" ? S - c.strike : c.strike - S), 0);
      if (pain <= best.pain * 1.1 + 1) ok.push(S);
    }
    return { low: Math.min(...ok), high: Math.max(...ok) };
  })() : null;
  g.lb = { top, maxPain: best && best.S, maxPainZone: zone, at: hhmm(t.min) };

  g.date = t.date; g.et = hhmm(t.min);
  g.expiries = Object.keys(chain.callExpDateMap || {}).map((x) => x.split(":")[0]);
  await writeJSON(env, "greeks:spx", g);
  return g;
}
