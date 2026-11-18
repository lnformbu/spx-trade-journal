// Every minute, 9:25-16:05 ET (was 5 minutes until 11/18; flow spikes and the history rows stay on 5-minute steps): SPX greek exposure board + 0DTE leaderboard (LB).
//   board  : GEX / DEX / vanna / charm per strike, call wall, put wall, gamma flip, "Eye of Sauron" (huge negative-GEX node)
//   LB     : top 10 SPX 0DTE contracts by volume, each with its own VWAP (built from the 5-minute volume snapshots),
//            holders in profit vs VWAP -> shakeout candidates; max-pain spot for in-the-money LB holders (power hour / last 10 min)
import { et, hhmm, OPEN, CLOSE } from "./levels.js";
import { exposures } from "./greeks.js";
import { lbChange } from "./lbpost.js";

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
  // PDF 12: volume flow, 0DTE call vs put contracts traded since the last snapshot (~5 min) vs the day's usual pace
  const firstSnap = !Object.keys(lb.c).length;
  let dCall = 0, dPut = 0;
  // Kill the Leaderboard: 0DTE gamma per strike (calls +, puts −), sized by max(open interest, today's volume)
  const g0 = {};
  for (const o of legsOf(chain, true, t.date)) {
    const vol = o.totalVolume || 0;
    const px = o.last || o.mark;
    if (!vol || !(px > 0)) continue;
    const c = lb.c[o.symbol] || (lb.c[o.symbol] = { k: o.strikePrice, t: o.type, vol: 0, pv: 0, vw: 0 });
    const dv = vol - c.vol;
    if (dv > 0) { c.pv += dv * px; c.vw += dv; }
    if (dv > 0) { if (o.type === "C") dCall += dv; else dPut += dv; }
    c.vol = vol; c.last = px; c.bid = o.bid; c.ask = o.ask;
    if (o.gamma != null && Math.abs(o.strikePrice - spot) <= 60) g0[o.strikePrice] = (g0[o.strikePrice] || 0) + (o.type === "C" ? 1 : -1) * o.gamma * Math.max(o.openInterest || 0, vol) * 100;
  }
  // the board refreshes every minute, but flow spikes compare 5-minute buckets (same as before): add up the
  // per-minute volume and close a bucket once 5 minutes have passed since the last one
  lb.acc = { c: ((lb.acc && lb.acc.c) || 0) + dCall, p: ((lb.acc && lb.acc.p) || 0) + dPut };
  if (firstSnap) { lb.flowAt = now; lb.acc = { c: 0, p: 0 }; }   // the first snapshot holds the whole morning's volume, not a bucket
  if (!firstSnap && now - (lb.flowAt || 0) >= 4.5 * 60000) {
    dCall = lb.acc.c; dPut = lb.acc.p; lb.acc = { c: 0, p: 0 }; lb.flowAt = now;
    lb.flowHist = [...(lb.flowHist || []), { at: now, c: dCall, p: dPut }].slice(-90);
    const h = lb.flowHist.slice(0, -1), avgC = h.length ? h.reduce((x, y) => x + y.c, 0) / h.length : null, avgP = h.length ? h.reduce((x, y) => x + y.p, 0) / h.length : null;
    lb.flow = { calls: dCall, puts: dPut, callSpike: avgC != null && h.length >= 3 && dCall > 1.8 * avgC, putSpike: avgP != null && h.length >= 3 && dPut > 1.8 * avgP, at: hhmm(t.min) };
  }
  lb.gHist = [...(lb.gHist || []), { at: now, m: Object.fromEntries(Object.entries(g0).map(([k, v]) => [k, Math.round(v)])) }].slice(-45);   // ~45 minutes at 1 per minute (the 25-40 min look-back needs it)
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
  // tax list (VWAP winners): 100k+ volume and last well above the contract's own VWAP → the premium that needs shaking
  const tax = top.filter((c) => c.vol >= 100000 && c.pnlPct >= 20);
  // gamma nodes now, and the strike GAINING gamma over ~30 minutes while others lose it (the likely kill / pin)
  const nowG = lb.gHist.at(-1).m, past = lb.gHist.find((h) => now - h.at >= 25 * 60000 && now - h.at <= 40 * 60000) || lb.gHist[0];
  const nodes = Object.entries(nowG).map(([k, v]) => ({ strike: +k, g: v, d: past && past !== lb.gHist.at(-1) ? v - (past.m[k] || 0) : 0 }));
  const pos = nodes.filter((x) => x.g > 0).sort((a, b) => b.g - a.g), neg = nodes.filter((x) => x.g < 0).sort((a, b) => a.g - b.g);
  const growing = [...nodes].filter((x) => x.d > 0).sort((a, b) => b.d - a.d)[0] || null;
  const gamma0 = { maxStrike: [...nodes].sort((a, b) => Math.abs(b.g) - Math.abs(a.g))[0]?.strike ?? null, growing: growing && growing.strike,
    posNodes: pos.slice(0, 5).map((x) => x.strike), negNodes: neg.slice(0, 3).map((x) => x.strike), window: past ? Math.round((now - past.at) / 60000) : 0 };
  g.lb = { top, maxPain: best && best.S, maxPainZone: zone, at: hhmm(t.min), flow: lb.flow || null, tax, gamma0 };

  g.date = t.date; g.et = hhmm(t.min);
  g.expiries = Object.keys(chain.callExpDateMap || {}).map((x) => x.split(":")[0]);
  await writeJSON(env, "greeks:spx", g);
  // leaderboard change -> copy channel with the chart + GEX + leaderboard picture (user 11/18)
  if (!force) await lbChange(env, deps, g, t, now).catch((e) => console.error("lb change post", e));
  // ---- SPY board (SPY's own options, SPY strikes) for the journal's SPX / SPY switch ----
  try {
    const sc = await schwab(token, `/marketdata/v1/chains?symbol=SPY&strikeCount=40&fromDate=${t.date}&toDate=${to}`);
    const sp = sc.underlyingPrice, e = exposures(sc, sp, now);
    const nr = e.strikes.filter((r) => Math.abs(r.strike - sp) / sp <= 0.015 && r.gex < 0).sort((a, b) => a.gex - b.gex);
    await writeJSON(env, "greeks:spy", { ...e, spot: sp, source: "SPY options", eye: nr.length && (nr.length === 1 || nr[0].gex <= 2 * nr[1].gex) ? { strike: nr[0].strike, gex: nr[0].gex } : null, date: t.date, et: hhmm(t.min) });
  } catch (err) { console.error("greeks spy", err); }

  // ---- history (data pool): one board row + the top-10 leaderboard contracts every 5 minutes in market hours,
  // kept forever per day in "hist:day:<date>"; GET /export?kind=board|lb|eod returns it as CSV ----
  if (t.min >= OPEN && t.min <= CLOSE && t.min % 5 === 0) {   // data pool stays at 5-minute rows
    const hk = "hist:day:" + t.date, H = (await readJSON(env, hk)) || { board: [], lb: [] }, at = hhmm(t.min);
    if (!H.board.some((x) => x.at === at)) {
      H.board.push({ at, spot: r2(spot), src: spxOI > 0 ? "SPX" : "SPY", flip: g.flip ?? null, callWall: g.callWall ?? null, putWall: g.putWall ?? null,
        eye: g.eye ? g.eye.strike : null, maxPain: g.lb.maxPain ?? null, mpLo: zone ? zone.low : null, mpHi: zone ? zone.high : null,
        g0Max: gamma0.maxStrike, g0Grow: gamma0.growing, posNodes: gamma0.posNodes.join(" "), negNodes: gamma0.negNodes.join(" "),
        flowC: lb.flow ? lb.flow.calls : null, flowP: lb.flow ? lb.flow.puts : null, callSpike: lb.flow ? lb.flow.callSpike : null, putSpike: lb.flow ? lb.flow.putSpike : null,
        tax: tax.map((c) => c.label).join(" ") });
      for (const c of top) H.lb.push({ at, label: c.label, strike: c.strike, type: c.type, vol: c.vol, last: c.last, vwap: c.vwap, pnlPct: c.pnlPct, itm: c.itm });
      await writeJSON(env, hk, H);
    }
  }
  return g;
}
