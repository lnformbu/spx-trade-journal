// Real end-of-day SPX GEX from Cboe's free delayed option chain (no key; user 11/18: "free platforms for real GEX at the end of the day").
//   https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json  (redirects to cdn-api.cboe.com) - every SPX / SPXW option with
//   open interest and IV, about 14 MB. Gamma is recomputed from each row's IV (Cboe's own gamma is rounded to 4 decimals, which wrecks
//   far strikes), through the same exposures() as the live board, so the numbers are directly comparable.
// Open interest is the OCC figure from the night before, so a snapshot taken after the close describes TOMORROW's positioning.
// Runs: after the close (16:15 ET, that day's expiries dropped) and before the open (8:45 ET, today's expiry included).
// Saved: "gex:cboe:<date>:<eod|pre>" (one per run, kept) and "gex:cboe:last". Compared with the live board's flip / walls.
import { et, hhmm } from "./levels.js";
import { exposures } from "./greeks.js";

const URL = "https://cdn.cboe.com/api/global/delayed_quotes/options/_SPX.json";

export async function runCboeGex(env, deps, { kind, force = false } = {}) {
  const { readJSON, writeJSON } = deps;
  const now = Date.now(), t = et(now);
  kind = kind || (t.min >= 960 ? "eod" : "pre");
  const key = `gex:cboe:${t.date}:${kind}`;
  if (!force && (await readJSON(env, key))) return { skipped: "already saved " + key };
  const res = await fetch(URL, { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, redirect: "follow" });
  if (!res.ok) throw new Error("cboe " + res.status);
  const j = await res.json(), d = j.data;
  const spot = d.current_price || d.close;
  const callExpDateMap = {}, putExpDateMap = {};
  let used = 0;
  for (const o of d.options) {
    const m = /^SPXW?(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(o.option);
    if (!m || !(o.open_interest > 0) || !(o.iv > 0.01)) continue;
    const exp = `20${m[1]}-${m[2]}-${m[3]}`, K = +m[5] / 1000;
    if (kind === "eod" && exp <= t.date) continue;                       // after the close today's contracts are gone
    if (Math.abs(K - spot) / spot > 0.1) continue;                       // ±10% of spot is where the gamma is
    if ((Date.parse(exp + "T12:00:00Z") - now) / 864e5 > 45) continue;   // next 45 days
    const map = m[4] === "C" ? callExpDateMap : putExpDateMap, e = (map[exp + ":0"] = map[exp + ":0"] || {});
    (e[K] = e[K] || []).push({ strikePrice: K, openInterest: o.open_interest, volatility: o.iv * 100 });
    used++;
  }
  const g = exposures({ callExpDateMap, putExpDateMap }, spot, now);
  // top strikes by size near spot: the levels that matter
  const near = g.strikes.filter((r) => Math.abs(r.strike - spot) / spot <= 0.04);
  const top = (f) => [...near].sort((a, b) => f(b) - f(a)).slice(0, 5).map((r) => ({ strike: r.strike, gex: r.gex }));
  const live = await readJSON(env, "greeks:spx");
  const out = {
    date: t.date, kind, et: hhmm(t.min), cboeAt: j.timestamp, spot, rows: used, totals: g.totals, flip: g.flip, callWall: g.callWall, putWall: g.putWall,
    topPos: top((r) => r.gex), topNeg: top((r) => -r.gex), strikes: near.map((r) => ({ strike: r.strike, gex: r.gex, callOI: r.callOI, putOI: r.putOI })),
    liveBoard: live ? { source: live.source, flip: live.flip, callWall: live.callWall, putWall: live.putWall, gex: live.totals && live.totals.gex, at: live.et } : null,
  };
  await writeJSON(env, key, out);
  await writeJSON(env, "gex:cboe:last", out);
  return { ...out, strikes: undefined };
}
