// Paper trading (RULES.md: Money, Session, Exits, Profit ladder, Protecting the day, Paper mode).
// Runs every minute right after the signal scan. No orders are ever sent: fills are simulated on live Schwab quotes.
//
// CHAMPION (the paper account, "paper:acct"): trades exactly what #signals posts: the signal's contract, entry, stop and target.
//   - A/A+ cards ("Entry on a 1m close above X"): bought when the ticker trades through X within 9 minutes, at that minute's ask
//   - other signals: bought right away at the ask of the quote the signal was built from
//   - managed with the profit ladder, the signal's stop, time stop, runner trail, 3:59 close; sold at the BID
// CHALLENGERS ("paper:challengers"): the same signals at the same moments, each with ONE style change (exits, delta, hours, sizing),
//   each on its own $2,000 book. After 20+ sessions, a challenger that clearly beats the champion takes over (runLearning).
// Hard limits every style keeps: max loss 15% of the account per trade, −30% stop at most, daily limits, one position, 3:59 close.
import { hhmm } from "./levels.js";
import { post } from "./signals.js";
import { chartShot } from "./shot.js";
import { decide, learn, famOf, kindFam, DEFAULT_MODEL, DEFAULT_PARAMS, FAM_NAMES, SCALP_V } from "./learn.js";

const FEE = 0.65;            // Schwab, per contract per side
export const GREEN_AT = 0.15, GREEN_FLOOR = 0.03;   // once +15%, the stop never sits below +3% (a green trade doesn't go red)
// paper account size: one 0DTE SPX contract costs ~$1,700-2,500, so $2,000 could never buy one under the 50% rule
const START = 25000;
// several positions at once (user 2026-11-16): up to MAX_OPEN, never two opposite sides of the same ticker; the 50% premium
// and 15% risk-per-trade limits are split between the slots, and all open risk counts against the day's 15% loss budget
const MAX_OPEN = 3;
const MAX_QTY = 3;   // never more than 3 contracts per trade (user 2026-11-16)
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const usd = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
// best families after every rule (replay): Vomy, 8 EMA ride, 10m checklist, ±1 ATR snap-back, 1m divergence, Golden Gate pullback/go, 21 EMA pullback
export const CORE = new Set(["vomy", "pb8", "ckl10", "atr1", "div1m", "ggpb", "ggo", "pb21"]);
// 11/17: "flip" (phase flip) is watch-only for the main account (11/13-16: 13% of its options green, avg -42%); the data collector still trades it
const TRADED = new Set(["atrhold", "star", "squeeze", "box", "div1m", "cbox1m", "cbox3m", "plan-trigger", "plan-scenario", "pb21", "vomy", "orb", "orb1m", "flip1m", "orrt", "pb8", "ggo", "ggpb", "atr1", "ckl10"]);
const EOD_FAMS = new Set(["eodplan", "eodshake", "eodfade", "maxpain", "lbinc", "lbshake"]);
// the signal fired against its context: trend, 10m phase, daily phase or VIX (11/13-16: 14% green, avg -36% vs +7% for the rest)
export const againstCtx = (ctx) => { const c = ctx || {}; return [c.trend === "against" && "trend", c.phase === "against" && "10m phase", c.phaseD === "against" && "daily phase", c.vix === false && "VIX"].filter(Boolean); };
const group = (sym) => (sym === "SPY" || sym === "$SPX" ? "SPX" : sym);   // SPY and SPX count as one market
const rootOf = (contract) => String((contract && contract.symbol) || "").split(" ")[0].replace(/^SPXW$/, "SPX");
// which option underlyings get paper traded: wrangler.toml PAPER_TICKERS (default "$SPX"; add e.g. ",TSLA" later)
const paperTicker = (env, contract) => String(env.PAPER_TICKERS || "$SPX").split(",").map((s) => s.trim().replace("$", "")).includes(rootOf(contract));

// ---- pullback hold score (user 11/18): a pullback inside a trade that is still working, or a real reversal? ----
// Six checks, 1 point each. In the "pullback-tolerant" style a SOFT exit (below) is overridden when the score is HOLD_MIN+:
// the trade is held with a structure stop just past the pullback's extreme instead. The −30% premium stop, the daily limits,
// the no-red stop, +100% lock, opposite signal and the 3:59 close are never overridden.
export const SOFT_EXITS = { struct1: "1m cloud against while red", struct3: "3m cloud against", ustop: "signal's SPX stop", time: "time stop", trail85: "tight trail (+60%, keep 85%)" };
export const HOLD_MIN = 4;
export function holdScore(pos, X, u, bull) {
  const why = [], tk = pos.under, L = Object.fromEntries((X.kl[tk] || []).map(([n, v]) => [n, v]));
  if (u == null) return { score: 0, why };
  if (X.tf10[tk] === (bull ? "bullish" : "bearish")) why.push("10m cloud with the trade");
  if (L.VWAP != null && (bull ? u >= L.VWAP : u <= L.VWAP)) why.push(bull ? "above VWAP" : "below VWAP");
  const best = pos.bestU ?? pos.uEntry, run = bull ? best - pos.uEntry : pos.uEntry - best, back = bull ? best - u : u - best, e21 = L["3m EMA 21"];
  if ((run > Math.abs(pos.uEntry) * 0.0004 && back <= 0.5 * run) || (e21 != null && (bull ? u >= e21 : u <= e21))) why.push("shallow pullback (holding half the move / 3m 21 EMA)");
  const F = X.flow;
  if (F && (bull ? F.calls >= F.puts && !F.putSpike : F.puts >= F.calls && !F.callSpike)) why.push(`0DTE ${bull ? "call" : "put"} flow still leads`);
  // smart money / dealer positioning (SPX board): room before the wall in the trade's way; negative GEX = moves extend
  const G = X.gx;
  if (G && tk === "$SPX") {
    const wall = bull ? G.callWall : G.putWall;
    if (wall == null || (bull ? wall - u : u - wall) > u * 0.001) why.push("room before the " + (bull ? "call" : "put") + " wall");
    if (G.gex != null && G.gex < 0) why.push("negative GEX (moves extend)");
  } else if (X.t.min < 780) why.push("before 1 PM");
  return { score: why.length, why };
}

// ---- swing structure (user 11/18: "3 min pullback but we are in an uptrend: HH, HL on the 1 and 3 min") ----
// From SPX 1m bars [t,o,h,l,c] grouped into `sec`-second bars: the last two confirmed pivot lows / highs.
export function swings(b1, sec) {
  const bars = [];
  for (const [t, , h, l, c] of b1 || []) {
    const k = Math.floor(t / sec), x = bars[bars.length - 1];
    if (x && x.k === k) { x.h = Math.max(x.h, h); x.l = Math.min(x.l, l); x.c = c; } else bars.push({ k, h, l, c });
  }
  const lows = [], highs = [];
  for (let i = 1; i < bars.length - 1; i++) {
    if (bars[i].l < bars[i - 1].l && bars[i].l <= bars[i + 1].l) lows.push(bars[i].l);
    if (bars[i].h > bars[i - 1].h && bars[i].h >= bars[i + 1].h) highs.push(bars[i].h);
  }
  const L = lows.slice(-2), H = highs.slice(-2);
  return { hl: L.length === 2 && L[1] > L[0], hh: H.length === 2 && H[1] > H[0], lh: H.length === 2 && H[1] < H[0], ll: L.length === 2 && L[1] < L[0],
    lastLow: L.length ? L[L.length - 1] : null, lastHigh: H.length ? H[H.length - 1] : null };
}
// trend structure intact for the trade's side: 3m higher low (lower high for puts) plus a 3m higher high, or 1m HH+HL
export function structureOk(b1, bull) {
  const s3 = swings(b1, 180), s1 = swings(b1, 60);
  const ok = bull ? s3.hl && (s3.hh || (s1.hh && s1.hl)) : s3.lh && (s3.ll || (s1.ll && s1.lh));
  return { ok, level: bull ? s3.lastLow : s3.lastHigh, s3, s1 };
}

// ---- trading styles ----
export const BASE_STYLE = { name: "Your rules", traits: [], delta: null, window: "rules", sizing: "full" };
export const TEMPLATES = [
  { id: "runner", name: "Runner: hold for bigger wins", apply: (c) => ({ ...c, params: { ...c.params, t1Pct: 1.0, keep1: 0.75, keep2: 0.7, stallMin: 25, timeStopMin: 15 } }) },
  // exits like the signal scorecard: hold to the signal's SPX target / stop (or 60 min); only a -30% safety stop on the option
  { id: "hold", name: "Hold to the signal's target (scorecard exits)", apply: (c) => ({ ...c, params: { ...c.params, stopPct: 0.3, t1Pct: 5, bePct: 9, lockPct: 9, trailFrom: 9, timeStopMin: 60, timeStopGain: 0, stallMin: 60, keep1: 0.7, keep2: 0.65 } }) },
  { id: "scalp", name: "Quick scalp: small fast wins", apply: (c) => ({ ...c, params: { ...c.params, t1Pct: 0.3, stopPct: 0.2, bePct: 0.15, lockPct: 0.25, lockTo: 0.1, timeStopMin: 6, keep1: 0.8, keep2: 0.75 } }) },
  { id: "d30", name: "Cheaper contracts (delta 0.30)", apply: (c) => ({ ...c, delta: 0.3 }) },
  { id: "d55", name: "At the money (delta 0.55)", apply: (c) => ({ ...c, delta: 0.55 }) },
  { id: "d70", name: "In the money (delta 0.70)", apply: (c) => ({ ...c, delta: 0.7 }) },
  { id: "allday", name: "Skip midday (A-grade only 11:30-1:30)", apply: (c) => ({ ...c, window: "nomidday" }) },
  { id: "morning", name: "Mornings only (9:33-11:30)", apply: (c) => ({ ...c, window: "morning" }) },
  { id: "edge", name: "Size down weaker setups", apply: (c) => ({ ...c, sizing: "edge" }) },
  // replay with every rule, one position at a time: core playbook 162 trades 57% +0.32R PF 1.84 vs all families +0.16R PF 1.35
  // user 11/18: pullbacks were being sold (1m cloud exits: +55% if held 30 min); hold through them when the hold score says the trade still works
  { id: "pbhold", name: "Pullback-tolerant (hold score overrides soft exits)", apply: (c) => ({ ...c, params: { ...c.params, pbTol: true } }) },
  { id: "core", name: "Core playbook only", apply: (c) => ({ ...c, fams: "core" }) },
];
export function championCfg(model) {
  const s = (model && model.style) || BASE_STYLE;
  return { id: "champion", ...BASE_STYLE, ...s, params: { ...DEFAULT_PARAMS, ...((model && model.params) || {}) } };
}
export function makeChallengers(champ, gen, date) {
  const books = {};
  const sig = (c) => JSON.stringify([c.params, c.delta, c.window, c.sizing, c.fams || null]);
  for (const tp of TEMPLATES) {
    const cfg = tp.apply({ ...champ, params: { ...champ.params } });
    if (sig(cfg) === sig(champ)) continue;
    books[tp.id] = { cfg: { ...cfg, id: tp.id, name: tp.name, traits: [...(champ.traits || []), tp.name] }, book: newBook() };
  }
  return { gen, since: date, books, hist: {} };
}
const newBook = () => ({ start: START, balance: START, open: null, pending: [], log: [], recent: [] });

function freshDay(b, t) {
  b.day = { date: t.date, startBal: b.balance, pnl: 0, best: 0, trades: 0, consecLoss: 0, lastLossAt: 0, stopOuts: [], done: null, gw: 0, gl: 0 };
  b.log = [];
  b.pending = [];
}
const log = (b, t, action, title, why) => { b.log.push({ et: hhmm(t.min), action, title, why: why || "" }); b.log = b.log.slice(-80); };

// hard rules (every style) + the style's trading hours
function gate(b, cfg, cand, t, now, events = []) {
  const d = b.day, sb = d.startBal;
  // DATA COLLECTOR: every signal with a contract, 9:32-3:55, no risk / count / window rules (training + forward-test data)
  if (cfg.collect || cfg.test) return t.min < 572 ? "before 9:32" : t.min >= 955 ? "no new entries after 3:55" : null;
  if (cand.blocked) return cand.blocked;
  if (!TRADED.has(cand.fam)) return "not a tradable setup";
  if (t.min < 573) return "before 9:33 (opening range)";
  if (t.min >= 955) return "no new entries after 3:55";
  if (t.min < 600 && cand.fam !== "orb" && cand.fam !== "orb1m" && cand.fam !== "ggo" && !(cand.fam === "star" && cand.grade === "A+")) return "opening window (9:33-10:00): only ORB breaks and A+ cards";
  // PDF 16 check (replay): after 3:30 signals averaged −0.09R; only A/A+ cards held up (+0.13R, 49), the rest −0.17R (139)
  if (t.min >= 900 && !EOD_FAMS.has(cand.fam)) return "after 3:00: no new entries except EOD / leaderboard plays (11/13-16: 4% of 3-4 PM signals went green)";
  // QuantConnect 2025 on real SPXW 0DTE: core setups entered 2:00-4:00 lost 46% of the premium on average (29 trades, PF 0.47)
  if (t.min >= 840 && cand.fam !== "star") return "afternoon window (after 2:00): only A/A+ cards (0DTE decay)";
  // Kill the Leaderboard risk rule: EOD trades come out of the day's profits only
  if (t.min >= 930 && !(d.pnl > 0)) return "end of day: profits only (this book is not green today)";
  // event days (your plan's "Event:" line): no entries 15 min either side; a pre-market event = A+ only until 9:45
  const ev = events.find((e) => t.min >= e.min - 15 && t.min < e.min + 15);
  if (ev) return `${ev.name} at ${hhmm(ev.min)}: no entries 15 minutes either side`;
  const pre = events.find((e) => e.min < 570);
  if (pre && t.min < 585 && cand.grade !== "A+") return `${pre.name} day: A+ only until 9:45`;
  if (cfg.fams === "core" && !CORE.has(cand.fam)) return "this style trades the core playbook only";
  if (cfg.window === "morning" && t.min >= 690) return "this style trades mornings only";
  // midday 11:30-1:30 is traded too (user 2026-11-16: "take them, we are training"); only a style that asks for it skips midday
  if (cfg.window === "nomidday" && t.min >= 690 && t.min < 810 && !(cand.fam === "star" && (cand.grade === "A+" || cand.score >= 90))) return "midday 11:30-1:30: A-grade (90+) only";
  if (d.done) return d.done;
  const dp = d.pnl - (d.base || 0), best = Math.max(0, (d.best || 0) - (d.base || 0));   // P/L since today's budget (re)start
  if (dp <= -0.2 * sb) return (d.done = "daily loss limit (−20%) reached");
  if (dp >= 0.25 * sb) return (d.done = "daily target (+25%) reached");
  if (best >= 0.10 * sb && dp < best / 2) return (d.done = "profit lock: gave back half of the day's best");
  if (d.trades >= 20) return "20 trades today";
  if (d.consecLoss >= 4) return (d.done = "4 losses in a row");
  // no cooldown after a loss (user 2026-11-16, training: it blocked two +50-70% winners); the daily limit and 4-loss stop remain
  if (d.stopOuts.some((s) => s.sym === group(cand.sym) && s.dir === cand.dir && Math.abs(s.level - cand.uEntry) <= Math.abs(cand.uEntry) * 0.0008)) return "already stopped out at this level in this direction";
  return null;
}

async function quotes(schwab, token, syms) {
  if (!syms.length) return {};
  const q = await schwab(token, "/marketdata/v1/quotes?fields=quote&symbols=" + syms.map(encodeURIComponent).join(",")).catch(() => ({}));
  const out = {};
  for (const s of syms) {
    const x = q[s] && q[s].quote;
    if (x) out[s] = { bid: x.bidPrice, ask: x.askPrice, last: x.lastPrice, mark: x.mark ?? x.lastPrice };
  }
  return out;
}

// One minute of one book (the champion or a challenger).
async function stepBook(b, cfg, X) {
  const { candidates, Q, px, now, t, model, champion } = X;
  const loud = champion || !!cfg.test, tag = cfg.test ? "🧪 TEST " : "";   // test mode (11/18): its trades post to Discord too
  const P = { ...DEFAULT_PARAMS, ...cfg.params };
  P.stopPct = Math.min(0.3, P.stopPct || 0.3);
  if (!b.day || b.day.date !== t.date) freshDay(b, t);
  b.positions = b.positions || (b.open ? [b.open] : []);
  const SLOTS = cfg.collect ? 12 : MAX_OPEN;
  const openRisk = () => b.positions.reduce((s, x) => s + (x.risk || 0), 0);
  // main account: never both sides of a ticker; data collector: at most 3 open per ticker (SPX always keeps room)
  const conflict = (sym, dir) => (cfg.collect
    ? (b.positions.filter((x) => group(x.under) === group(sym)).length >= 3 ? b.positions.find((x) => group(x.under) === group(sym)) : null)
    : b.positions.find((x) => group(x.under) === group(sym) && x.dir !== dir));

  // the contract this style buys for a signal: the signal's own, or (delta styles, SPX) the SPX 0DTE contract nearest its delta
  async function contractFor(c) {
    if (!cfg.delta || rootOf(c.contract) !== "SPX") return { ...c.contract, fromSignal: true };
    const list = await X.chain(c.dir);
    const o = list.filter((o) => o.ask > 0 && o.bid > 0 && o.delta != null && (o.ask - o.bid) / ((o.ask + o.bid) / 2) <= 0.08)
      .sort((a, z) => Math.abs(Math.abs(a.delta) - cfg.delta) - Math.abs(Math.abs(z.delta) - cfg.delta))[0];
    return o ? { symbol: o.symbol, label: `SPX ${o.strikePrice}${o.putCall === "CALL" ? "c" : "p"} 0DTE`, bid: o.bid, ask: o.ask, delta: o.delta } : null;
  }

  function sell(p, qty, price, why) {
    if (qty <= 0) return;
    p.realized += qty * (price - p.entry) * 100 - qty * FEE;
    p.qtyOpen -= qty;
    p.exits.push({ et: hhmm(t.min), at: now, qty, px: price, why });
    if (p.qtyOpen > 0) return;
    const pnl = r2(p.realized - p.qty * FEE);
    const d = b.day;
    b.balance = r2(b.balance + pnl);
    d.pnl = r2(d.pnl + pnl); d.best = Math.max(d.best, d.pnl);
    if (pnl > 0) d.gw = r2(d.gw + pnl); else d.gl = r2(d.gl - pnl);
    if (p.manual) {} // your trades: their P/L counts in the account, not in the bot's losing-streak / stop-out rules
    else if (pnl < 0) { d.consecLoss++; d.lastLossAt = now; if (/stop/.test(why)) d.stopOuts.push({ sym: group(p.under), dir: p.dir, level: p.uEntry }); } else d.consecLoss = 0;
    const avgExit = p.exits.reduce((s, e) => s + e.qty * e.px, 0) / p.qty;
    const trade = { ...p, pnl, R: r2(pnl / p.risk), avgExit: r2(avgExit), exitWhy: why, closedAt: now, closedET: hhmm(t.min), balance: b.balance };
    delete trade.qtyOpen; delete trade.missed; delete trade.lastBid;
    b.positions = b.positions.filter((x) => x !== p);
    b.open = b.positions[0] || null;
    log(b, t, pnl >= 0 ? "win" : "loss", p.label, `${why} · ${usd(pnl)}`);
    if (cfg.collect) X.dataClosed.push({ ...trade, blocked: p.blocked || null });
    // exit audit (11/18): follow the sold option for 60 minutes -> nightly learning compares "sold" with "held"
    if ((champion || cfg.collect) && p.under === "$SPX") X.audit.push({ id: p.id, book: champion ? "acct" : "data", symbol: p.symbol, fam: p.fam, dir: p.dir, entry: p.entry,
      rule: p.rule || null, hs: p.hs ? p.hs.score : null, hsWhy: p.hs ? p.hs.why : [], exitPct: r3(price / p.entry - 1), bestPct: r3(p.bestBid / p.entry - 1),
      date: t.date, at: now, until: now + 60 * 60000, after: [], best: r3(price / p.entry - 1) });
    if (!champion) {
      b.recent = [{ date: t.date, et: p.et, label: p.label, signal: p.signal, pnl, R: trade.R, why }, ...(b.recent || [])].slice(0, 30);
      if (cfg.test) X.messages.push({ title: `${tag}${pnl >= 0 ? "WIN" : "LOSS"} ${usd(pnl)} · ${p.label}`,
        text: `Bought ${p.qty} @ ${usd(p.entry)} · sold ${p.exits.map((e) => `${e.qty} @ ${usd(e.px)} (${e.why})`).join(", ")}${p.overrides ? `
Held through: ${p.overrides.map((o) => `${o.et} ${SOFT_EXITS[o.rule]} (score ${o.score}/6)`).join(", ")}` : ""}
Test book ${usd(b.balance)} · paper only`,
        color: pnl >= 0 ? 0x2ec26b : 0xf0556b });
      return;
    }
    X.closed.push(trade);
    X.shadow.push({ id: p.id, symbol: p.symbol, until: now + 30 * 60000 });
    X.messages.push({ manual: !!p.manual,
      title: `📄 PAPER ${pnl >= 0 ? "WIN" : "LOSS"} ${usd(pnl)} · ${p.label}`,
      text: `Bought ${p.qty} @ ${usd(p.entry)} · sold ${p.exits.map((e) => `${e.qty} @ ${usd(e.px)} (${e.why})`).join(", ")}\n${r2(pnl / p.risk)}R · day ${usd(d.pnl)} · paper account ${usd(b.balance)}`,
      color: pnl >= 0 ? 0x2ec26b : 0xf0556b,
    });
  }

  function enter(p, k, underPx, how) {
    const ask = k.ask, bid = k.bid;
    const cost1 = ask * 100, riskPer = cost1 * P.stopPct + 2 * FEE;
    const share = (cfg.sizing === "edge" && (p.est == null || p.est < 0.2) ? 0.25 : 0.5) / MAX_OPEN;
    const one = cfg.collect || cfg.test;
    let qty = one ? 1 : Math.floor((share * b.balance) / cost1);
    if (!one && qty < 1) { log(b, t, "skipped", p.title, `one ${k.label} costs ${usd(cost1)}, more than ${Math.round(share * 1000) / 10}% of the account (one of ${MAX_OPEN} slots)`); return false; }
    if (!one) qty = Math.min(qty, Math.floor((0.15 * b.balance / MAX_OPEN) / riskPer), Math.floor((b.day.pnl - (b.day.base || 0) + 0.2 * b.day.startBal - openRisk()) / riskPer));
    if (qty < 1) { log(b, t, "skipped", p.title, "one contract would risk more than the daily loss limit left (open positions included)"); return false; }
    qty = Math.min(qty, MAX_QTY);
    const ag = one ? [] : againstCtx(p.ctx);
    if (ag.length && qty > 1) { qty = 1; how += ` · 1 contract: fired against the ${ag.join(" + ")}`; }
    // new families trade small until the nightly learning has seen enough (20+ results, +0.10R or better)
    const fs = (X.model && X.model.fams && X.model.fams[p.fam]) || null;
    if (!cfg.collect && p.fam === "atrhold" && qty > 1 && !(fs && fs.n >= 20 && fs.r >= 0.1)) { qty = 1; how += " · 1 contract: Scalp ATR retest is new (proving itself)"; }
    // you called for patience in today's plan: smaller (1 contract) except A+ cards; trades still play out
    if (!cfg.collect && X.patience && qty > 1 && !(p.fam === "star" && p.grade === "A+")) { qty = 1; how += " · 1 contract: your plan says be patient today"; }
    const pos = {
      id: now + ":" + k.symbol, date: t.date, symbol: k.symbol, label: k.label, under: p.sym, delta: k.delta, dir: p.dir,
      qty, qtyOpen: qty, entry: ask, spreadPct: bid > 0 ? r3((ask - bid) / ((ask + bid) / 2)) : null,
      at: now, et: hhmm(t.min), stop: r2((bid > 0 ? (ask + bid) / 2 : ask) * (1 - P.stopPct)), bestBid: bid || ask, bestAt: now, t1: null,   // premium stop from the mid (11/18)
      uEntry: underPx ?? p.uEntry, uStop: p.uStop, uTarget: p.uTarget, risk: r2(qty * riskPer), bestU: underPx ?? p.uEntry, rib0: X.tf10[p.sym] || null, tf3up: X.tf3 && X.tf3[p.sym] ? X.tf3[p.sym].up : null,
      fam: p.fam, kind: p.kind, grade: p.grade, score: p.score, ctx: p.ctx, signal: p.title, signalET: p.et, est: p.est, blocked: p.blocked || null,
      exits: [], realized: 0, path: [r3((bid || ask) / ask - 1)], params: { stopPct: P.stopPct, t1Pct: P.t1Pct }, style: cfg.name,
    };
    b.positions.push(pos);
    b.open = b.positions[0];
    b.day.trades++;
    log(b, t, "bought", p.title, `${qty} × ${k.label} @ ${usd(ask)} (${how})`);
    if (loud) {
      const bull = p.dir === "bull", tk = p.sym.replace("$", "");
      X.messages.push({
        // chart picture with the SPX buy (user 11/18): the journal chart with entry / stop / target drawn
        shot: p.sym === "$SPX" ? { dir: p.dir, e: r2(underPx ?? p.uEntry), s: p.uStop != null ? r2(p.uStop) : "", t: p.uTarget != null ? r2(p.uTarget) : "", label: `${tag}BUY ${qty} × ${k.label} @ ${usd(ask)}` } : null,
        title: `${tag || "📄 PAPER "}BUY ${qty} × ${k.label} @ ${usd(ask)}`,
        text: `From: ${p.title} (${p.et} ET) · ${how}${p.why ? `\n**Why taken:** ${p.why}` : ""}\nStop ${usd(pos.stop)} (−${Math.round(P.stopPct * 100)}%) or ${tk} ${bull ? "below" : "above"} ${r2(p.uStop)} · target 1 +${Math.round(P.t1Pct * 100)}% (${usd(ask * (1 + P.t1Pct))})${p.uTarget != null ? ` or ${tk} ${r2(p.uTarget)}` : ""}\nRisk ${usd(pos.risk)} of ${usd(b.balance)} · open positions ${b.positions.length}/${MAX_OPEN} · style: ${cfg.name}${p.est != null ? ` · learned edge ${p.est}R` : ""}`,
        color: bull ? 0x2ec26b : 0xf0556b,
      });
    }
    return true;
  }

  // ---- manage the open positions ----
  for (const pos of [...b.positions]) {
  if (pos && pos.date !== t.date) sell(pos, pos.qtyOpen, pos.lastBid || 0, "carried past the session (closed at last price)");
  else if (pos) {
    const q = Q[pos.symbol], u = px(pos.under);
    if (!q || !(q.bid >= 0)) pos.missed = (pos.missed || 0) + 1;
    else {
      const bid = q.bid, E = pos.entry, bull = pos.dir === "bull";
      pos.lastBid = bid; pos.missed = 0;
      pos.path.push(r3(bid / E - 1));
      if (bid > pos.bestBid) { pos.bestBid = bid; pos.bestAt = now; }
      const pct = bid / E - 1, bestPct = pos.bestBid / E - 1;
      const hs = holdScore(pos, X, u, bull);
      // premium stop on the MID (11/18: a 0DTE spread put the bid 20% under the ask the minute it was bought -> instant stop-out)
      const mk = q.mark > 0 ? q.mark : q.ask > 0 && bid > 0 ? (q.ask + bid) / 2 : bid;
      // STRUCTURE MODE (your "bot manages exits" trades + the pullback-tolerant styles): while SPX keeps its 3m HH/HL (LH/LL for puts)
      // the pullback is held: soft exits are skipped, the premium stop widens to −35% (on the mid), and the exit is SPX breaking the
      // last 3m higher low (lower high) by ~2 points.
      const sm = ((pos.manual && pos.botManaged) || !!P.pbTol) && pos.under === "$SPX" && (X.spx1m || []).length >= 20;
      const SO = sm ? structureOk(X.spx1m, bull) : null, intact = !!(SO && SO.ok && SO.level != null);
      if (intact) {
        const lv = r2(bull ? SO.level - Math.abs(u || SO.level) * 0.0003 : SO.level + Math.abs(u || SO.level) * 0.0003);
        if (pos.hlStop == null || (bull ? lv > pos.hlStop : lv < pos.hlStop)) {
          const first = pos.hlStop == null; pos.hlStop = lv;
          log(b, t, "note", pos.label, `${first ? "structure mode" : "structure stop raised"}: 3m ${bull ? "higher highs / higher lows" : "lower highs / lower lows"} intact, exit if SPX ${bull ? "breaks" : "reclaims"} ${lv}`);
        }
      }
      pos.hs = hs;
      const tolMode = !!P.pbTol && (!pos.manual || pos.botManaged), offR = (X.model && X.model.exitStats && X.model.exitStats.off) || {};
      const mayHold = (rule) => tolMode && !offR[rule] && hs.score >= HOLD_MIN && pct > -P.stopPct;
      // you moved the stop yourself (chart / ticket): the automatic profit locks below stop ratcheting it until you hand it back (✕)
      const yourStop = pos.manualStop ? pos.stop : null;
      if (bestPct >= P.bePct) pos.stop = Math.max(pos.stop, E);
      // user rule (11/17): once a trade has been green (+15%), it must not turn red. Pullbacks are fine down to +3% over entry
      // (covers fees and the bid slipping between checks); below that it is sold, still green. Every style, your trades too.
      if (bestPct >= GREEN_AT) pos.stop = Math.max(pos.stop, r2(E * (1 + GREEN_FLOOR) + (2 * FEE) / 100));
      if (bestPct >= (P.trailFrom ?? 9)) pos.stop = Math.max(pos.stop, E + (P.trailKeep ?? 0.6) * (pos.bestBid - E));   // trailing from +20%
      if (bestPct >= P.lockPct) pos.stop = Math.max(pos.stop, E * (1 + P.lockTo));
      const uHit = pos.uTarget != null && u != null && (bull ? u >= pos.uTarget : u <= pos.uTarget);
      if (!pos.t1 && (!pos.manual || pos.botManaged) && (pct >= P.t1Pct || (uHit && pct >= 0.15))) {
        pos.t1 = now;
        if (pos.qtyOpen >= 2) {
          sell(pos, Math.floor(pos.qtyOpen / 2), bid, uHit && pct < P.t1Pct ? "target 1 (signal's target level)" : `target 1 (+${Math.round(P.t1Pct * 100)}%)`);
          pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop2));
        } else pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop1));
        if (loud) X.messages.push({ manual: !!pos.manual, title: `${tag || "📄 PAPER "}target 1 · ${pos.label}`, text: `Option ${usd(bid)} (+${Math.round(pct * 100)}%). ${pos.qty >= 2 ? "Sold half; runner" : "Stop"} now ${usd(pos.stop)}, trailing.`, color: 0xffd700 });
      }
      if (pos.t1) pos.stop = Math.max(pos.stop, E + (pos.qty >= 2 ? P.keep2 : P.keep1) * (pos.bestBid - E));
      // user rule (11/17): once the option has been up 60%+, tight trailing stop: keep 85% of the best gain (every style, manual trades too)
      if (bestPct >= 0.6) {
        if (mayHold("trail85")) { if (!pos.trail85held) { pos.trail85held = true; log(b, t, "note", pos.label, `holding the +60% tight trail loose (hold score ${hs.score}/6: ${hs.why.join(", ")})`); } }
        else pos.stop = Math.max(pos.stop, r2(E + 0.85 * (pos.bestBid - E)));
      }
      // user rule (11/17): once it has doubled (+100%), it never gives that back: the stop sits at +100% at least
      if (bestPct >= 1) pos.stop = Math.max(pos.stop, r2(E * 2));
      if (yourStop != null) pos.stop = yourStop;
      const opp = cfg.collect ? null : candidates.find((c) => !c.blocked && group(c.sym) === group(pos.under) && c.dir !== pos.dir && decide(model, c).ok);
      // rejected at a level: the ticker reached a key level beyond the entry, then gave back half the move while the option is green
      if (u != null) {
        const nb = bull ? Math.max(pos.bestU ?? u, u) : Math.min(pos.bestU ?? u, u);
        // pullback extreme since the last new high (low for puts); a new high ends the pullback and clears the structure stop
        if (nb !== pos.bestU || pos.pbX == null) { pos.pbX = u; if (nb !== pos.bestU && pos.sStop != null) { pos.sStop = null; log(b, t, "note", pos.label, "trade resumed (new high): structure stop cleared"); } }
        else pos.pbX = bull ? Math.min(pos.pbX, u) : Math.max(pos.pbX, u);
        pos.bestU = nb;
      }
      const tol = Math.abs(pos.uEntry) * 0.0004, run = bull ? pos.bestU - pos.uEntry : pos.uEntry - pos.bestU;
      const lvl = run > tol ? (X.kl[pos.under] || []).filter(([, v]) => (bull ? v > pos.uEntry + tol && pos.bestU >= v - tol : v < pos.uEntry - tol && pos.bestU <= v + tol))
        .sort((a, z) => (bull ? z[1] - a[1] : a[1] - z[1]))[0] : null;
      const rejected = lvl && u != null && (bull ? pos.bestU - u : u - pos.bestU) >= 0.5 * run && pct > 0;
      // invalidated: the 10m Saty cloud flipped against the trade since the entry
      const cloud = X.tf10[pos.under], flipped = cloud && cloud === (bull ? "bearish" : "bullish") && pos.rib0 !== cloud;
      const evSoon = X.events.find((e) => e.min >= 570 && t.min >= e.min - 5 && t.min < e.min);
      // MARKET STRUCTURE + FLOW exits (user 11/16: lose on structure and flow, not on a clock):
      //  3m 8/21 cloud turned against the trade after the entry  -> the scalp's structure is broken
      //  1m 8/21 cloud against for 3+ minutes while the option is red
      //  0DTE volume flow spiking on the other side (put volume for a call trade) while the option is red
      const s3 = (X.tf3 || {})[pos.under], s1 = (X.tf1 || {})[pos.under], heldMin = (now - pos.at) / 60000;
      const grace = heldMin >= (pos.manual ? 5 : 2), red = pct <= -0.05;
      const struct3 = grace && s3 && s3.up !== bull && (pos.tf3up === bull || s3.run * 3 < heldMin);
      const struct1 = grace && s1 && s1.up !== bull && Math.min(s1.run, Math.floor(heldMin)) >= 3 && red;
      const F = X.flow, flowAgainst = grace && F && red && (bull ? F.putSpike && F.puts > F.calls : F.callSpike && F.calls > F.puts);
      let why = null, rule = null;
      const yS = pos.userStop, yT = pos.userTarget;
      if (u != null && yS != null && (bull ? u <= yS : u >= yS)) why = `your stop (${pos.under.replace("$", "")} ${r2(u)} through ${yS})`;
      else if (u != null && yT != null && (bull ? u >= yT : u <= yT)) why = `your target (${pos.under.replace("$", "")} ${yT} reached)`;
      else if (bid <= pos.stop && pos.manualStop) why = `your option stop ($${pos.stop})`;
      else if (pos.stop < E ? mk <= pos.stop && !(intact && mk / E - 1 > -0.35) : bid <= pos.stop) why = pos.stop > E ? (bestPct >= 1 && pos.stop <= r2(E * 2) ? `+100% lock (was up +${Math.round(bestPct * 100)}%, kept the double)` : bestPct >= 0.6 ? `tight trailing stop (was up +${Math.round(bestPct * 100)}%)` : bestPct >= GREEN_AT && pos.stop <= r2(E * (1 + GREEN_FLOOR) + (2 * FEE) / 100) ? `no-red stop (was up +${Math.round(bestPct * 100)}%, kept it green)` : pos.t1 || pos.bestBid / E - 1 >= (P.trailFrom ?? 9) ? "trailing stop" : "locked-profit stop") : pos.stop === E ? "breakeven stop" : `premium stop (−${Math.round((1 - mk / E) * 100)}% on the mid)`;
      else if (u != null && pos.uStop != null && (bull ? u <= pos.uStop : u >= pos.uStop)) rule = "ustop", why = `signal's stop (${pos.under.replace("$", "")} ${r2(u)} through ${r2(pos.uStop)})`;
      else if (rejected) why = `rejected at ${lvl[0]} ${lvl[1]}`;
      else if (flipped) why = "10m Saty cloud flipped against the trade";
      else if (struct3) rule = "struct3", why = "structure: the 3m cloud turned against the trade";
      else if (struct1) rule = "struct1", why = "structure: 1m cloud against the trade for 3+ min while red";
      else if (flowAgainst) why = `flow: 0DTE ${bull ? "put" : "call"} volume spiking against the trade while red`;
      else if (evSoon) why = `closing before ${evSoon.name} at ${hhmm(evSoon.min)}`;
      else if (!pos.t1 && now - pos.at >= P.timeStopMin * 60000 && bestPct < P.timeStopGain && pct <= 0) rule = "time", why = `time stop (still red after ${P.timeStopMin} min)`;   // only a LOSING trade is timed out (11/16: two green time-stops ran to +31% / +45%)
      else if (pos.t1 && now - pos.bestAt >= P.stallMin * 60000) why = `runner stalled ${P.stallMin} min`;
      else if (opp) why = "opposite signal: " + opp.title;
      else if (t.min >= 959) why = "3:59 close";
      if (why && !rule) rule = /premium stop/.test(why) ? "premium" : /no-red/.test(why) ? "nored" : /tight trailing/.test(why) ? "trail85" : /\+100% lock/.test(why) ? "lock100"
        : /trailing|locked-profit/.test(why) ? "trail" : /breakeven/.test(why) ? "breakeven" : /rejected/.test(why) ? "rejected" : /10m Saty/.test(why) ? "flip10"
        : /^flow/.test(why) ? "flow" : /^opposite/.test(why) ? "opposite" : /3:59/.test(why) ? "close" : /^your /.test(why) ? "yours" : /target/.test(why) ? "target" : "other";
      if (why && intact && rule in SOFT_EXITS) { why = null; rule = null; }   // structure mode: a pullback inside HH/HL is held
      if (!why && pos.hlStop != null && u != null && (bull ? u <= pos.hlStop : u >= pos.hlStop)) {
        rule = "hlbreak"; why = `structure: SPX ${bull ? "broke the 3m higher low" : "reclaimed the 3m lower high"} (${pos.hlStop})`;
      }
      // PULLBACK-TOLERANT: a soft exit while the hold score is high -> hold, with a structure stop just past the pullback extreme
      if (why && rule in SOFT_EXITS && rule !== "trail85" && mayHold(rule) && u != null) {
        if (pos.sStop == null) {
          const buf = Math.abs(u) * 0.0004, xp = pos.pbX ?? u;
          pos.sStop = r2(bull ? Math.min(xp, u) - buf : Math.max(xp, u) + buf);
          pos.overrides = [...(pos.overrides || []), { et: hhmm(t.min), rule, score: hs.score, sStop: pos.sStop }];
          log(b, t, "note", pos.label, `held through "${SOFT_EXITS[rule]}" (hold score ${hs.score}/6: ${hs.why.join(", ")}); structure stop ${pos.under.replace("$", "")} ${pos.sStop}`);
        }
        why = null; rule = null;
      }
      if (!why && pos.sStop != null && u != null && (bull ? u <= pos.sStop : u >= pos.sStop)) { rule = "sstop"; why = `structure stop (pullback ${bull ? "low" : "high"} ${pos.sStop} broke)`; }
      else if (!why && pos.sStop != null && hs.score < HOLD_MIN - 1) { rule = "hsdrop"; why = `pullback hold ended (hold score fell to ${hs.score}/6)`; }
      pos.rule = rule;
      if (why && pos.manual && !pos.botManaged && why !== "3:59 close" && !/^your /.test(why) && !(bid <= pos.stop && pos.stop > E)) why = null;   // you manage your own trade; profit-protect stops still apply
      if (why) sell(pos, pos.qtyOpen, bid, why);
    }
    if (b.positions.includes(pos) && pos.missed >= 5) log(b, t, "warning", pos.label, "no option quote for 5 minutes");
  }
  }

  // ---- your orders from the journal's trade ticket: limit orders at the bid / ask you clicked ----
  // buy fills when the ask comes down to the limit (or a trade prints below it); sell fills when the bid reaches it (or a trade prints above)
  if (champion && X.orders) {
    const F = X.fills;
    for (const o of X.orders) {
      if (F[o.id] && F[o.id].status !== "working") continue;
      const done = (status, extra = {}) => { F[o.id] = { status, at: now, et: hhmm(t.min), ...extra }; };
      if (o.cancel) { done("canceled"); continue; }
      if (o.date !== t.date || t.min >= 960) { done("expired"); continue; }
      if (o.modify) {   // you moved a stop / target on the chart or in the ticket
        const p = b.positions.find((x) => x.id === o.modify);
        if (!p) { done("rejected", { why: "position already closed" }); continue; }
        if (o.userStop !== undefined) p.userStop = o.userStop;
        if (o.userTarget !== undefined) p.userTarget = o.userTarget;
        if (o.stop != null && o.stop > 0) { p.stop = r2(o.stop); p.manualStop = true; }
        // your SPX stop takes over: the option stop becomes a −50% disaster stop and the automatic profit locks pause
        else if (o.userStop != null) { p.stop = r2(p.entry * 0.5); p.manualStop = true; }
        // ✕ (both cleared): back to the bot's stops; its profit locks re-apply from the trade's best price on the next check
        if (o.userStop === null && o.userTarget === null && o.stop == null) { p.manualStop = false; p.stop = Math.max(p.stop, r2(p.entry * (1 - 0.15))); }
        log(b, t, "note", p.label, `YOU moved: ${o.userStop !== undefined ? "stop " + (o.userStop ?? "cleared") + " " : ""}${o.userTarget !== undefined ? "target " + (o.userTarget ?? "cleared") + " " : ""}${o.stop != null ? "option stop $" + o.stop : ""}`.trim());
        done("applied"); continue;
      }
      if (!F[o.id]) F[o.id] = { status: "working", at: now, et: hhmm(t.min) };
      const q = Q[o.symbol], L = +o.limit;
      if (!q || !(L > 0)) continue;
      if (o.side === "buy") {
        const slip = o.at_ === "ask" ? Math.max(0.2, L * 0.03) : 0;
        // a resting buy at the bid fills while the market still bids your price (sellers hit the bid on SPX 0DTE all day);
        // before (11/17) it waited for the ASK to fall to it, so it only filled after the option had already dropped
        // your price is the best bid (the market bid hasn't moved above it): you're first in line -> filled at your price.
        // If the bid moved up past your price you're behind it and it waits (true limit).
        const joined = o.at_ === "bid" && q.bid > 0 && q.ask > 0 && L >= q.bid && L < q.ask;
        const fill = q.ask > 0 && q.ask <= L + slip ? q.ask : joined || (q.last > 0 && q.last <= L) ? L : null;
        if (fill == null) continue;
        if (b.positions.filter((x) => x.manual).length >= 3) { done("rejected", { why: "3 of your positions are already open" }); continue; }
        const qty = Math.max(1, Math.min(MAX_QTY, Math.floor(+o.qty) || 1)), bull = o.putCall === "CALL", u = X.px(o.under);
        const pos = {
          id: now + ":" + o.symbol, date: t.date, symbol: o.symbol, label: o.label || o.symbol, under: o.under, delta: o.delta ?? null, dir: bull ? "bull" : "bear",
          qty, qtyOpen: qty, entry: fill, spreadPct: q.bid > 0 ? r3((q.ask - q.bid) / ((q.ask + q.bid) / 2)) : null,
          at: now, et: hhmm(t.min), stop: r2((q.bid > 0 && q.ask > 0 ? Math.min(fill, (q.ask + q.bid) / 2) : fill) * (1 - P.stopPct)), bestBid: q.bid || fill, bestAt: now, t1: null,
          uEntry: u, uStop: null, uTarget: null, risk: r2(qty * (fill * 100 * P.stopPct + 2 * FEE)), bestU: u, rib0: X.tf10[o.under] || null, tf3up: X.tf3 && X.tf3[o.under] ? X.tf3[o.under].up : null,
          fam: "manual", kind: "manual", srcFam: o.fam || null, grade: null, score: null, ctx: null, signal: o.alert || "your trade (ticket)", signalET: o.alertET || null,
          manual: true, botManaged: !!o.botManage, orderId: o.id,
          exits: [], realized: 0, path: [r3((q.bid || fill) / fill - 1)], params: { stopPct: P.stopPct, t1Pct: P.t1Pct }, style: "You (trade ticket)",
        };
        b.positions.push(pos); b.open = b.positions[0]; b.day.trades++;
        log(b, t, "bought", pos.signal, `YOU: ${qty} × ${pos.label} @ ${usd(fill)} (limit ${usd(L)}${o.botManage ? ", bot manages the exits" : ", you manage the exits"})`);
        X.messages.push({ manual: true, title: `📄 PAPER BUY (you) ${qty} × ${pos.label} @ ${usd(fill)}`, text: `From the journal's trade ticket${o.alert ? ` · alert: ${o.alert}` : ""}
${o.botManage ? "The bot manages the exits (its stops, targets and structure exits)." : "You manage the exits (the bot only closes it at 3:59)."} · paper account ${usd(b.balance)}`, color: bull ? 0x2ec26b : 0xf0556b });
        done("filled", { px: fill, qty });
      } else {
        const ps = b.positions.filter((x) => x.symbol === o.symbol).sort((a, z) => (z.manual ? 1 : 0) - (a.manual ? 1 : 0));
        if (!ps.length) { done("rejected", { why: "no open paper position in this contract" }); continue; }
        const slip = o.at_ === "bid" ? Math.max(0.2, L * 0.03) : 0;
        // a resting sell at the ask: your price is the best offer (the ask hasn't dropped below it) -> filled at your price
        const joined = o.at_ === "ask" && q.ask > 0 && q.bid > 0 && L <= q.ask && L > q.bid;
        const fill = q.bid > 0 && q.bid >= L - slip ? q.bid : joined || q.last >= L ? L : null;
        if (fill == null) continue;
        let left = Math.max(1, Math.floor(+o.qty) || 1), sold = 0;
        for (const p of ps) { if (left <= 0) break; const n = Math.min(left, p.qtyOpen); sell(p, n, fill, p.manual ? "your sell (ticket)" : "you sold the bot's trade (ticket)"); left -= n; sold += n; }
        done("filled", { px: fill, qty: sold });
      }
    }
  }

  // ---- signals waiting for their entry level ----
  if (b.positions.length < SLOTS) {
    for (const p of b.pending) {
      if (p.done || b.positions.length >= SLOTS) continue;
      if (conflict(p.sym, p.dir)) continue;   // keeps waiting while the opposite side is open
      const bull = p.dir === "bull", u = px(p.sym);
      const g = gate(b, cfg, p, t, now, X.events);
      if (g) { p.done = true; log(b, t, "skipped", p.title, g); continue; }
      if (now - p.at > 9 * 60000) { p.done = true; log(b, t, "dropped", p.title, `entry ${r2(p.uEntry)} not reached within 9 minutes`); continue; }
      if (u == null) continue;
      if (bull ? u <= p.uStop : u >= p.uStop) { p.done = true; log(b, t, "dropped", p.title, "price hit the stop before the entry"); continue; }
      if (!(bull ? u >= p.uEntry : u <= p.uEntry)) continue;
      p.done = true;
      let k = await contractFor(p);
      if (k && k.fromSignal) { const q = Q[k.symbol]; k = q && q.ask > 0 ? { ...k, ask: q.ask, bid: q.bid } : null; }
      if (!k || !(k.ask > 0)) { log(b, t, "skipped", p.title, "no quote for the contract"); continue; }
      enter(p, k, u, `${p.sym.replace("$", "")} ${r2(u)} through the entry ${r2(p.uEntry)}`);
    }
  }
  b.pending = b.pending.filter((p) => !p.done && now - p.at < 10 * 60000);

  // ---- this minute's new signals ----
  for (const c of candidates) {
    const g = gate(b, cfg, c, t, now, X.events);
    if (g) { log(b, t, "skipped", c.title, g); continue; }
    if (b.positions.length >= SLOTS) { log(b, t, "skipped", c.title, `${SLOTS} positions already open`); continue; }
    if (conflict(c.sym, c.dir)) { log(b, t, "skipped", c.title, `opposite side already open (${conflict(c.sym, c.dir).label})`); continue; }
    const d = cfg.collect || cfg.test ? { ok: true, est: null, why: "" } : decide(model, c);
    if (!d.ok) { log(b, t, "skipped", c.title, d.why); continue; }
    if (c.needTrigger) {
      if (b.pending.some((p) => group(p.sym) === group(c.sym) && p.dir === c.dir)) continue;
      b.pending.push({ ...c, at: now, est: d.est });
      log(b, t, "waiting", c.title, `buys when ${c.sym.replace("$", "")} ${c.dir === "bull" ? "breaks above" : "breaks below"} ${r2(c.uEntry)}${d.why ? " · " + d.why : ""}`);
    } else {
      const k = await contractFor(c);
      if (!k || !(k.ask > 0)) { log(b, t, "skipped", c.title, "no ask price for the contract"); continue; }
      if (enter({ ...c, est: d.est }, k, c.uEntry, `signal entry, ${c.sym.replace("$", "")} ${r2(c.uEntry)}`)) b.pending = b.pending.filter((p) => !(group(p.sym) === group(c.sym) && p.dir === c.dir));
    }
  }
  b.open = b.positions[0] || null;   // first position, for older readers (journal card, challenger table)
  if (!champion) b.log = b.log.slice(-15);
}

// candidates = this minute's new signals that were posted with a contract (from runSignals)
export async function runPaper(env, deps, { candidates = [], events = [], kl = {}, tf10 = {}, tf1 = {}, tf3 = {}, flow = null, spx1m = [], now = Date.now(), t }) {
  const { schwabToken, schwab, readJSON, writeJSON } = deps;
  // the main account and the challengers trade PAPER_TICKERS (SPX); the data collector takes every ticker's signals (1 contract)
  const allCands = candidates.filter((c) => c.contract && c.contract.symbol);
  candidates = allCands.filter((c) => paperTicker(env, c.contract));
  const acct = (await readJSON(env, "paper:acct")) || newBook();
  const model = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  // one-time switch of the champion to scalp exits (the learned params were the old swing defaults)
  if ((model.scalpV || 0) < SCALP_V) {
    model.params = { ...(model.params || {}), ...DEFAULT_PARAMS };
    model.scalpV = SCALP_V;
    model.changes = [...(model.changes || []), { date: t.date, what: "exits: stop -15%, trailing stop from +20% (keeps 60%), bank 1 of 3 at +40%, structure / flow exits (3m cloud against, 1m cloud against 3+ min while red, opposite 0DTE flow spike while red), backstop: still red after 15 min, max 3 contracts" }].slice(-50);
    await writeJSON(env, "paper:model", model);
  }
  const champ = championCfg(model);
  let ch = await readJSON(env, "paper:challengers");
  if (!ch) ch = makeChallengers(champ, 1, t.date);
  // a challenger template added after this generation started gets its own fresh book
  for (const tp of TEMPLATES) if (!ch.books[tp.id]) { const cfg = tp.apply({ ...champ, params: { ...champ.params } }); ch.books[tp.id] = { cfg: { ...cfg, id: tp.id, name: tp.name, traits: [...(champ.traits || []), tp.name] }, book: newBook() }; }
  // the "allday" challenger now tests the opposite: skipping midday (the champion trades it)
  if (ch.books.allday && ch.books.allday.cfg.window === "all") { ch.books.allday.cfg.window = "nomidday"; ch.books.allday.cfg.name = "Skip midday (A-grade only 11:30-1:30)"; }
  acct.shadow = acct.shadow || [];
  // one-time "reset today's loss budget" (admin /paper/reset-day): start the day's 15% budget again from the current balance
  const rs = await readJSON(env, "paper:reset");
  if (rs && rs.date === t.date && !rs.done && acct.day && acct.day.date === t.date) {
    const d = acct.day;
    d.base = d.pnl; d.best = d.pnl; d.startBal = acct.balance; d.consecLoss = 0; d.lastLossAt = 0; d.done = null; d.stopOuts = [];
    log(acct, t, "reset", "Daily loss budget", `restarted from ${usd(acct.balance)} (earlier loss ${usd(d.pnl)} came from the old sizing)`);
    await writeJSON(env, "paper:reset", { ...rs, done: true, at: now });
  }
  const token = await schwabToken(env);

  // one quote call for every book's open contract, the tickers, waiting contracts and the champion's after-exit shadows
  const data = (await readJSON(env, "paper:data")) || newBook();
  const dataCfg = { ...champ, id: "data", name: "Data collector (every signal, 1 contract)", collect: true, window: "all" };
  // TEST MODE (user 11/18): switched on for one day from the journal (or /paper/test?on=1). Its own book, pullback-tolerant exits,
  // 1 contract on every SPX signal 9:32-3:55, every buy and sell posted to Discord with "🧪 TEST". Never touches the main account
  // or the challenger contest; off by itself the next day.
  const tm = await readJSON(env, "paper:test"), testOn = !!(tm && tm.on && tm.date === t.date);
  const testBook = testOn ? (await readJSON(env, "paper:testbook")) || newBook() : null;
  const testCfg = { ...champ, id: "test", name: "Test mode (pullback-tolerant, every SPX signal, 1 contract)", test: true, params: { ...champ.params, pbTol: true } };
  const books = [acct, ...Object.values(ch.books).map((x) => x.book), data, ...(testBook ? [testBook] : [])];
  // one-time move to the new size: a book that never traded at the old $2,000 start starts over at START
  for (const b of books) if (b.start !== START && b.balance === b.start && !b.open && !(b.positions || []).length && !(b.recent || []).length) {
    b.start = START; b.balance = START; if (b.day) b.day.startBal = START;
  }
  const dayState = await readJSON(env, "bot:day:" + t.date), patience = !!(dayState && dayState.plan && dayState.plan.parsed && dayState.plan.parsed.patience);
  const ordersAll = ((await readJSON(env, "paper:orders")) || { items: [] }).items || [];
  const orders = ordersAll.filter((o) => o.date === t.date), fills = (await readJSON(env, "paper:fills")) || {};
  const syms = [...new Set([
    ...orders.filter((o) => !(fills[o.id] && fills[o.id].status !== "working")).flatMap((o) => [o.symbol, o.under]),
    ...books.flatMap((b) => [...(b.positions || (b.open ? [b.open] : [])).flatMap((x) => [x.symbol, x.under]), ...(b.pending || []).flatMap((p) => [p.sym, p.contract.symbol])]),
    ...acct.shadow.map((s) => s.symbol),
  ])];
  const audit = (await readJSON(env, "paper:audit")) || { open: [] };
  for (const a of audit.open) if (!syms.includes(a.symbol)) syms.push(a.symbol);
  const Q = await quotes(schwab, token, syms);
  const gq = await readJSON(env, "greeks:spx");
  const gx = gq && gq.date === t.date ? { callWall: gq.callWall, putWall: gq.putWall, flip: gq.flip, gex: gq.totals && gq.totals.gex } : null;
  const chains = {};
  const X = {
    env, candidates, events, kl, tf10, tf1, tf3, flow, spx1m, gx, Q, model, now, t, patience, closed: [], dataClosed: [], messages: [], shadow: acct.shadow, audit: [],
    px: (sym) => (Q[sym] ? Q[sym].last ?? Q[sym].mark : null),
    // SPX 0DTE chain for the delta styles, fetched at most once per side per minute
    chain: (dir) => (chains[dir] = chains[dir] || (async () => {
      const type = dir === "bull" ? "CALL" : "PUT", map = type === "CALL" ? "callExpDateMap" : "putExpDateMap";
      const c = await schwab(token, `/marketdata/v1/chains?symbol=%24SPX&contractType=${type}&strikeCount=30&fromDate=${t.date}&toDate=${t.date}`).catch(() => ({}));
      const out = [];
      for (const e in c[map] || {}) for (const k in c[map][e]) out.push(...c[map][e][k]);
      return out;
    })()),
  };

  // champion's after-exit shadows (learning replays other exit settings on them)
  if (acct.shadow.length) {
    const tr = (await readJSON(env, "paper:trades")) || { items: [] };
    for (const s of acct.shadow) {
      const q = Q[s.symbol], x = tr.items.find((i) => i.id === s.id);
      if (q && x && q.bid > 0) x.path.push(r3(q.bid / x.entry - 1));
      if (now - s.until > 0 || t.min >= 960 || !x) s.done = true;
    }
    acct.shadow = X.shadow = acct.shadow.filter((s) => !s.done);
    await writeJSON(env, "paper:trades", tr);
  }

  await stepBook(acct, champ, { ...X, champion: true, orders, fills });
  { const keep = new Set(ordersAll.map((o) => o.id)); for (const k of Object.keys(fills)) if (!keep.has(k)) delete fills[k]; await writeJSON(env, "paper:fills", fills); }
  for (const x of Object.values(ch.books)) {
    try { await stepBook(x.book, x.cfg, { ...X, champion: false }); } catch (e) { console.error("challenger", x.cfg.id, e); }
  }
  try { await stepBook(data, dataCfg, { ...X, candidates: allCands, champion: false }); } catch (e) { console.error("data collector", e); }
  if (testBook) {
    try { await stepBook(testBook, testCfg, { ...X, candidates: candidates.filter((c) => c.sym === "$SPX"), champion: false }); } catch (e) { console.error("test book", e); }
    testBook.updatedAt = now;
    await writeJSON(env, "paper:testbook", testBook);
  }
  // exit audit: one sample a minute of each sold option's bid for 60 minutes after the exit; finished ones go to "paper:auditlog"
  {
    for (const a of audit.open) {
      const q = Q[a.symbol], m = Math.round((now - a.at) / 60000);
      if (q && q.bid >= 0 && (!a.after.length || a.after.at(-1)[0] < m)) { const v = r3(q.bid / a.entry - 1); a.after.push([m, v]); a.best = Math.max(a.best, v); }
      if (now >= a.until || t.min >= 960) a.done = true;
    }
    const done = audit.open.filter((a) => a.done);
    audit.open = [...audit.open.filter((a) => !a.done), ...X.audit];
    if (done.length) { const lg = (await readJSON(env, "paper:auditlog")) || { items: [] }; lg.items.push(...done.map(({ done: _d, until: _u, ...a }) => a)); lg.items = lg.items.slice(-3000); await writeJSON(env, "paper:auditlog", lg); }
    if (done.length || X.audit.length || audit.open.length) await writeJSON(env, "paper:audit", audit);
  }
  // per-session results for the champion-vs-challenger comparison
  const rec = (id, b) => { const h = (ch.hist[id] = ch.hist[id] || {}); h[t.date] = { pnl: b.day.pnl, trades: b.day.trades, gw: b.day.gw, gl: b.day.gl }; };
  rec("champion", acct);
  for (const [id, x] of Object.entries(ch.books)) rec(id, x.book);

  acct.updatedAt = now;
  await writeJSON(env, "paper:acct", acct);
  await writeJSON(env, "paper:challengers", ch);
  data.updatedAt = now;
  await writeJSON(env, "paper:data", data);
  if (X.dataClosed.length) {
    const dt = (await readJSON(env, "paper:datatrades")) || { items: [] };
    dt.items.push(...X.dataClosed);
    dt.items = dt.items.slice(-4000);
    await writeJSON(env, "paper:datatrades", dt);
  }
  if (X.closed.length) {
    const tr = (await readJSON(env, "paper:trades")) || { items: [] };
    tr.items.push(...X.closed);
    tr.items = tr.items.slice(-2000);
    await writeJSON(env, "paper:trades", tr);
  }
  // user 11/18: your own ticket trades (buy, target 1, win/loss) stay off Discord; they still show in the journal
  for (const m of X.messages.filter((x) => !x.manual)) {
    const file = m.shot ? await chartShot(env, deps, m.shot).catch((e) => { console.error("chart shot", e); return null; }) : null;
    await post(env, { title: m.title, description: m.text, color: m.color, footer: { text: `${hhmm(t.min)} ET · paper trade (no real order)` } }, null, file).catch(() => {});
  }
  return { balance: acct.balance, open: (acct.positions || []).map((x) => x.label).join(", ") || null, pending: acct.pending.length, closed: X.closed.length, challengers: Object.keys(ch.books).length };
}

// ---- champion vs challengers ----
export function summarizeHist(h, dates) {
  let pnl = 0, trades = 0, gw = 0, gl = 0, eq = 0, peak = 0, dd = 0;
  for (const d of dates) {
    const x = h && h[d];
    if (!x) continue;
    pnl += x.pnl; trades += x.trades; gw += x.gw || 0; gl += x.gl || 0;
    eq += x.pnl; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
  }
  return { sessions: dates.length, pnl: r2(pnl), trades, pf: gl ? r2(gw / gl) : gw ? 99 : 0, dd: r2(dd) };
}
// A challenger takes over when, over the same 20+ sessions: 15+ trades, more P/L by a clear margin, profit factor at least as good,
// and a drawdown no worse than 1.25× the champion's (or $200).
export function pickWinner(ch) {
  const dates = Object.keys(ch.hist.champion || {}).sort();
  if (dates.length < 20) return null;
  const C = summarizeHist(ch.hist.champion, dates);
  let best = null;
  for (const [id, x] of Object.entries(ch.books)) {
    const S = summarizeHist(ch.hist[id], dates);
    const ok = S.trades >= 15 && S.pnl > C.pnl + Math.max(50, Math.abs(C.pnl) * 0.1) && S.pf >= C.pf && S.dd <= Math.max(C.dd * 1.25, 200);
    if (ok && (!best || S.pnl > best.S.pnl)) best = { id, cfg: x.cfg, S, C };
  }
  return best;
}

// After the close: the nightly learning run, the champion-vs-challenger check, and a weekly report on Fridays.
export async function runLearning(env, deps, { force = false, report = false, quiet = false, now = Date.now(), t }) {
  const { readJSON, writeJSON } = deps;
  const prev = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  if (!force && prev.lastRun === t.date) return { skipped: "already trained today" };
  const stats = (await readJSON(env, "bot:stats")) || { items: [] };
  const trades = (await readJSON(env, "paper:trades")) || { items: [] };
  const dataTrades = (await readJSON(env, "paper:datatrades")) || { items: [] };
  const fbRes = await collectFeedback(env, readJSON, writeJSON, t).catch((e) => ({ err: e.message, items: [] }));
  const replayData = (await readJSON(env, "bot:replay")) || { items: [] };
  const lib = (await readJSON(env, "lib:setups")) || { items: [] };
  // PDF 16 Highlander log: does the top of the SPX 0DTE leaderboard expire worthless unless it traded 100k+? (not testable from
  // history, so every close is recorded in "lb:hist" and the rule gets judged once there are enough days)
  try {
    const lbDay = await readJSON(env, "lb:spx:" + t.date);
    const hist = (await readJSON(env, "lb:hist")) || { items: [] };
    if (lbDay && lbDay.c && t.min >= 960 && !hist.items.some((x) => x.date === t.date) && deps.schwab && deps.schwabToken) {
      const q = await deps.schwab(await deps.schwabToken(env), "/marketdata/v1/quotes?fields=quote&symbols=%24SPX");
      const close = q && q.$SPX && q.$SPX.quote && q.$SPX.quote.lastPrice;
      if (close) {
        const top = Object.values(lbDay.c).sort((a, b) => b.vol - a.vol).slice(0, 3)
          .map((c) => ({ k: c.k, t: c.t, vol: c.vol, itm: c.t === "C" ? close > c.k : close < c.k }));
        // Kill the Leaderboard plan vs the close: pin error, inside the walls, did the shaken name die
        const plan = await readJSON(env, "eod:plan:" + t.date);
        const eod = plan ? { ...plan, close, pinErr: plan.pin != null ? Math.round((close - plan.pin) * 100) / 100 : null,
          insideWalls: plan.walls && plan.walls[0] && plan.walls[1] ? close >= plan.walls[0] && close <= plan.walls[1] : null,
          killWorked: plan.killDir && plan.spx ? (plan.killDir === "bull" ? close > plan.spx : close < plan.spx) : null,
          gexWorked: plan.gexDir && plan.spx ? (plan.gexDir === "bull" ? close > plan.spx : close < plan.spx) : null,
          taxDied: (plan.tax || []).map((c) => ({ label: c.label, vol: c.vol, died: c.type === "C" ? close <= c.strike : close >= c.strike })) } : null;
        hist.items.push({ date: t.date, close, top, eod });
        await writeJSON(env, "lb:hist", { items: hist.items.slice(-400) });
      }
    }
  } catch (e) { console.error("lb hist", e); }
  const { model, changes } = learn(prev, stats.items, [...trades.items, ...dataTrades.items.map((x) => ({ ...x, data: true }))], t.date, {
    replay: replayData.items, training: lib.items.filter((x) => x.result), feedback: fbRes.items || [],
  });

  // exit audit (11/18): for every exit rule, "sold" vs "held 30 / 60 more minutes", split by the hold score at the exit.
  // A soft exit loses its override when holding with a high score has LOST money over 30+ cases; it gets marked "proven" when holding won.
  try {
    const lg = (await readJSON(env, "paper:auditlog")) || { items: [] };
    const at = (a, m) => { let v = null; for (const [k, x] of a.after) { if (k <= m) v = x; else break; } return v; };
    const R = {};
    for (const a of lg.items) {
      if (!a.rule) continue;
      const h30 = at(a, 30), h60 = at(a, 60); if (h30 == null) continue;
      const k = a.rule + (a.hs != null && a.hs >= HOLD_MIN ? ":high" : ":low");
      const x = (R[k] = R[k] || { n: 0, exit: 0, h30: 0, h60: 0, best: 0, win30: 0 });
      x.n++; x.exit += a.exitPct; x.h30 += h30; x.h60 += h60 ?? h30; x.best += a.best; if (h30 > a.exitPct) x.win30++;
    }
    for (const x of Object.values(R)) { for (const f of ["exit", "h30", "h60", "best"]) x[f] = r3(x[f] / x.n); x.edge = r3(x.h30 - x.exit); x.win30 = r2(x.win30 / x.n); }
    const before = (prev.exitStats && prev.exitStats.off) || {}, off = {}, proven = {};
    for (const r of Object.keys(SOFT_EXITS)) {
      const x = R[r + ":high"];
      if (x && x.n >= 30 && x.edge < 0) off[r] = true;
      if (x && x.n >= 30 && x.edge >= 0.05) proven[r] = true;
      if (!!off[r] !== !!before[r]) changes.push(off[r] ? `Pullback hold: stop overriding "${SOFT_EXITS[r]}" (holding lost ${Math.round(-x.edge * 100)}% over ${x.n} cases)` : `Pullback hold: "${SOFT_EXITS[r]}" may be overridden again`);
    }
    model.exitStats = { at: t.date, n: lg.items.length, rules: R, off, proven };
  } catch (e) { console.error("exit audit", e); }

  // a winning challenger takes over the paper account (its style becomes the champion; a new set of challengers starts)
  const ch = await readJSON(env, "paper:challengers");
  const win = ch && pickWinner(ch);
  if (win) {
    model.style = { name: [...(win.cfg.traits || [])].join(" + ") || win.cfg.name, traits: win.cfg.traits || [], delta: win.cfg.delta, window: win.cfg.window, sizing: win.cfg.sizing, fams: win.cfg.fams || null };
    model.params = { ...win.cfg.params };
    const text = `🏆 New trading style takes over: ${model.style.name}. Over ${win.C.sessions} sessions: ${usd(win.S.pnl)} vs ${usd(win.C.pnl)} (your rules), `
      + `profit factor ${win.S.pf} vs ${win.C.pf}, ${win.S.trades} trades, worst drawdown ${usd(win.S.dd)} vs ${usd(win.C.dd)}.`;
    changes.push(text);
    model.v = (model.v || 0) + 1; model.updated = t.date;
    model.changes = [{ date: t.date, v: model.v, text }, ...(model.changes || [])].slice(0, 60);
    await writeJSON(env, "paper:challengers", makeChallengers(championCfg(model), (ch.gen || 1) + 1, t.date));
    await post(env, { title: "🏆 Paper account: new trading style", description: text + "\nA new set of challengers starts tomorrow. Paper only: nothing changes for real money without you.", color: 0xffd700 }).catch(() => {});
  }
  await writeJSON(env, "paper:model", model);
  if (changes.length && !(win && changes.length === 1)) await post(env, { title: `🧠 Bot learning v${model.v}: ${changes.length} change${changes.length > 1 ? "s" : ""}`, description: changes.join("\n").slice(0, 3900), color: 0x3b82f6, footer: { text: `from ${model.samples.signals} scored signals + ${model.samples.trades} paper trades · paper only` } }).catch(() => {});
  if (!quiet && (t.wd === "Fri" || report)) {
    const acct = (await readJSON(env, "paper:acct")) || newBook();
    const wk = trades.items.filter((x) => now - x.closedAt < 7 * 864e5);
    const w = wk.filter((x) => x.pnl > 0), l = wk.filter((x) => x.pnl <= 0);
    const gw = w.reduce((s, x) => s + x.pnl, 0), gl = -l.reduce((s, x) => s + x.pnl, 0);
    const fam = {};
    for (const x of wk) { const f = (fam[x.fam] = fam[x.fam] || { n: 0, pnl: 0, w: 0 }); f.n++; f.pnl += x.pnl; if (x.pnl > 0) f.w++; }
    const c2 = (await readJSON(env, "paper:challengers")) || { books: {}, hist: {} };
    const dates = Object.keys(c2.hist.champion || {}).sort();
    const board = [["champion", (model.style && model.style.name) || "Your rules"], ...Object.entries(c2.books).map(([id, x]) => [id, x.cfg.name])]
      .map(([id, name]) => [name, summarizeHist(c2.hist[id], dates)]).sort((a, b) => b[1].pnl - a[1].pnl)
      .map(([name, S]) => `${name}: ${usd(S.pnl)} · ${S.trades} trades · PF ${S.pf}`).join("\n");
    await post(env, {
      title: `📒 Weekly paper report · account ${usd(acct.balance)} (started ${usd(acct.start || START)})`,
      description: (wk.length
        ? `${wk.length} trades · win ${Math.round((w.length / wk.length) * 100)}% · P/L ${usd(gw - gl)} · profit factor ${gl ? (gw / gl).toFixed(2) : "∞"}\n`
          + `Avg win ${usd(w.length ? gw / w.length : 0)} · avg loss ${usd(l.length ? -gl / l.length : 0)}\n\n`
          + Object.entries(fam).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, f]) => `${FAM_NAMES[k] || k}: ${f.n} trades, ${f.w} wins, ${usd(f.pnl)}`).join("\n")
        : "No paper trades this week.")
        + `\n\nSwitched off: ${Object.entries(model.fams).filter(([, f]) => f.off).map(([k]) => FAM_NAMES[k] || k).join(", ") || "none"} · min A/A+ score ${model.minScore}`
        + (dates.length ? `\n\n**Styles (${dates.length} session${dates.length > 1 ? "s" : ""}; a challenger needs 20+ to take over):**\n${board}` : ""),
      color: 0x3b82f6,
    }).catch(() => {});
  }
  // ---- daily recap ----
  if (!quiet) try {
    const day = t.date;
    const tr = trades.items.filter((x) => x.date === day);
    const sg = stats.items.filter((x) => x.date === day && x.R != null);
    const sw = sg.filter((x) => x.R > 0), sumR = sg.reduce((s, x) => s + x.R, 0);
    const byFam = {};
    for (const x of sg) { const f = (byFam[x.fam || x.kind] = byFam[x.fam || x.kind] || { n: 0, R: 0 }); f.n++; f.R += x.R; }
    const famLines = Object.entries(byFam).sort((a, b) => b[1].R - a[1].R).map(([k, f]) => `${FAM_NAMES[k] || k}: ${f.n} · ${f.R >= 0 ? "+" : ""}${r2(f.R)}R`);
    const rv = ((await readJSON(env, "bot:reviews")) || { days: {} }).days[day];
    const acct = (await readJSON(env, "paper:acct")) || newBook();
    const c2 = (await readJSON(env, "paper:challengers")) || { books: {}, hist: {} };
    const lead = Object.entries(c2.books).map(([id, x]) => [x.cfg.name, (c2.hist[id] || {})[day]]).filter(([, h]) => h && h.trades).sort((a, b) => b[1].pnl - a[1].pnl)[0];
    const champDay = (c2.hist.champion || {})[day];
    const fbToday = (fbRes.items || []).filter((x) => x.date === day);
    await post(env, {
      title: `🗓️ Daily recap ${day.slice(5)} · paper ${usd(acct.day && acct.day.date === day ? acct.day.pnl : 0)} · account ${usd(acct.balance)}`,
      description: [
        `**Paper trades:** ${tr.length ? tr.map((x) => `${x.et} ${x.label} ×${x.qty} ${usd(x.pnl)} (${x.exitWhy})`).join("\n") : "none"}`,
        lead ? `**Best challenger today:** ${lead[0]} ${usd(lead[1].pnl)} (your style: ${usd(champDay ? champDay.pnl : 0)})` : null,
        `**Signals scored:** ${sg.length} · ${sg.length ? Math.round((sw.length / sg.length) * 100) : 0}% won · ${sumR >= 0 ? "+" : ""}${r2(sumR)}R${famLines.length ? "\n" + famLines.slice(0, 6).join("\n") : ""}`,
        rv ? `**Your plan:** ${rv.ok} checks right, ${rv.no} wrong${rv.side ? ` · ${rv.side}` : ""}` : "**Your plan:** no review today",
        `**Your reactions:** ${fbToday.filter((x) => x.v > 0).length} ✅ · ${fbToday.filter((x) => x.v < 0).length} ❌${fbRes.err ? ` (couldn't read reactions: ${fbRes.err}; the bot needs Read Message History in #signals)` : ""}`,
        changes.length ? `**Learned today:** ${changes.length} change${changes.length > 1 ? "s" : ""} (see 🧠 post)` : "**Learned today:** no changes",
      ].filter(Boolean).join("\n\n").slice(0, 3900),
      color: 0x8b5cf6,
    });
  } catch (e) { console.error("recap", e); }
  return { v: model.v, changes, samples: model.samples, promoted: win ? win.cfg.name : null, feedback: { added: fbRes.added, err: fbRes.err } };
}

// Your ✅ / ❌ (also 👍 🔥 / 👎) on the last 5 days' signal posts -> "bot:feedback" (reactions by the bot itself don't count)
async function collectFeedback(env, readJSON, writeJSON, t) {
  const byMid = {}, noMid = [];   // older posts (before message ids were saved) are matched by title and time
  for (let i = 0; i < 5; i++) {
    const d = new Date(Date.parse(t.date + "T12:00:00Z") - i * 864e5).toISOString().slice(0, 10);
    const s = await readJSON(env, "sig:day:" + d);
    for (const a of (s && s.alerts) || []) { const x = { ...a, date: d }; if (a.mid) byMid[a.mid] = x; else noMid.push(x); }
  }
  const fb = (await readJSON(env, "bot:feedback")) || { items: [] };
  if ((!Object.keys(byMid).length && !noMid.length) || !env.DISCORD_BOT_TOKEN) return { added: 0, items: fb.items };
  let before = null, added = 0, err = null;
  const oldest = Math.min(...[...Object.values(byMid), ...noMid].map((a) => a.at));
  for (let page = 0; page < 5; page++) {
    const r = await fetch(`https://discord.com/api/v10/channels/${env.SIGNALS_CHANNEL_ID}/messages?limit=100${before ? "&before=" + before : ""}`,
      { headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (spx-bot, 1.0)" } });
    if (!r.ok) { err = r.status; break; }
    const msgs = await r.json();
    if (!Array.isArray(msgs) || !msgs.length) break;
    for (const m of msgs) {
      const title = m.embeds && m.embeds[0] && m.embeds[0].title, ts = Date.parse(m.timestamp);
      // your REPLY to an alert (11/18): its words are a vote on that alert's setup, like a ✅ / ❌
      const ra = m.message_reference && byMid[m.message_reference.message_id];
      if (ra && m.author && !m.author.bot && m.content && !fb.items.some((x) => x.mid === m.id)) {
        const { replyVote } = await import("./review.js");
        const famR = ra.key ? famOf(ra.key) : kindFam(ra);
        fb.items.push({ mid: m.id, date: ra.date, key: ra.key || null, fam: famR, v: replyVote(m.content), title: ra.title, src: "reply", text: String(m.content).slice(0, 400) }); added++;
        continue;
      }
      const a = byMid[m.id] || noMid.find((x) => x.title === title && Math.abs(x.at - ts) < 3 * 60000);
      if (!a || !m.reactions) continue;
      const cnt = (names) => m.reactions.filter((x) => names.includes(x.emoji && x.emoji.name)).reduce((s, x) => s + x.count - (x.me ? 1 : 0), 0);
      const up = cnt(["✅", "👍", "🔥"]), down = cnt(["❌", "👎"]);
      const v = up > down ? 1 : down > up ? -1 : 0;
      const i = fb.items.findIndex((x) => x.mid === m.id);
      if (!v) { if (i >= 0) fb.items.splice(i, 1); continue; }
      const fam = a.key ? famOf(a.key) : /EYE OF SAURON/.test(a.title) ? "eye" : /max pain/i.test(a.title) ? "maxpain" : /LB SHAKEOUT/.test(a.title) ? "lbshake" : kindFam(a);
      const rec = { mid: m.id, date: a.date, key: a.key || null, fam, v, title: a.title };
      if (i >= 0) fb.items[i] = rec; else { fb.items.push(rec); added++; }
    }
    before = msgs[msgs.length - 1].id;
    if (Date.parse(msgs[msgs.length - 1].timestamp) < oldest) break;
  }
  fb.items = fb.items.slice(-3000);
  await writeJSON(env, "bot:feedback", fb);
  return { added, err, items: fb.items };
}
