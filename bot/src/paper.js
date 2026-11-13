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
import { decide, learn, DEFAULT_MODEL, DEFAULT_PARAMS, FAM_NAMES } from "./learn.js";

const FEE = 0.65;            // Schwab, per contract per side
const START = 2000;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const usd = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
const TRADED = new Set(["star", "mom", "flip", "squeeze", "box", "div1m", "div3m", "cbox1m", "cbox3m", "plan-trigger"]);
const group = (sym) => (sym === "SPY" || sym === "$SPX" ? "SPX" : sym);   // SPY and SPX count as one market
const rootOf = (contract) => String((contract && contract.symbol) || "").split(" ")[0].replace(/^SPXW$/, "SPX");
// which option underlyings get paper traded: wrangler.toml PAPER_TICKERS (default "$SPX"; add e.g. ",TSLA" later)
const paperTicker = (env, contract) => String(env.PAPER_TICKERS || "$SPX").split(",").map((s) => s.trim().replace("$", "")).includes(rootOf(contract));

// ---- trading styles ----
export const BASE_STYLE = { name: "Your rules", traits: [], delta: null, window: "rules", sizing: "full" };
export const TEMPLATES = [
  { id: "runner", name: "Runner: hold for bigger wins", apply: (c) => ({ ...c, params: { ...c.params, t1Pct: 1.0, keep1: 0.75, keep2: 0.7, stallMin: 25, timeStopMin: 15 } }) },
  { id: "scalp", name: "Quick scalp: small fast wins", apply: (c) => ({ ...c, params: { ...c.params, t1Pct: 0.3, stopPct: 0.2, bePct: 0.15, lockPct: 0.25, lockTo: 0.1, timeStopMin: 6, keep1: 0.8, keep2: 0.75 } }) },
  { id: "d30", name: "Cheaper contracts (delta 0.30)", apply: (c) => ({ ...c, delta: 0.3 }) },
  { id: "d55", name: "At the money (delta 0.55)", apply: (c) => ({ ...c, delta: 0.55 }) },
  { id: "d70", name: "In the money (delta 0.70)", apply: (c) => ({ ...c, delta: 0.7 }) },
  { id: "allday", name: "Trade midday too", apply: (c) => ({ ...c, window: "all" }) },
  { id: "morning", name: "Mornings only (9:33-11:30)", apply: (c) => ({ ...c, window: "morning" }) },
  { id: "edge", name: "Size down weaker setups", apply: (c) => ({ ...c, sizing: "edge" }) },
];
export function championCfg(model) {
  const s = (model && model.style) || BASE_STYLE;
  return { id: "champion", ...BASE_STYLE, ...s, params: { ...DEFAULT_PARAMS, ...((model && model.params) || {}) } };
}
export function makeChallengers(champ, gen, date) {
  const books = {};
  const sig = (c) => JSON.stringify([c.params, c.delta, c.window, c.sizing]);
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
function gate(b, cfg, cand, t, now) {
  const d = b.day, sb = d.startBal;
  if (!TRADED.has(cand.fam)) return "not a tradable setup";
  if (t.min < 573) return "before 9:33 (opening range)";
  if (t.min >= 955) return "no new entries after 3:55";
  if (cfg.window === "morning" && t.min >= 690) return "this style trades mornings only";
  if (cfg.window !== "all" && t.min >= 690 && t.min < 810 && !(cand.fam === "star" && (cand.grade === "A+" || cand.score >= 90))) return "midday 11:30-1:30: A-grade (90+) only";
  if (d.done) return d.done;
  if (d.pnl <= -0.15 * sb) return (d.done = "daily loss limit (−15%) reached");
  if (d.pnl >= 0.15 * sb) return (d.done = "daily target (+15%) reached");
  if (d.best >= 0.10 * sb && d.pnl < d.best / 2) return (d.done = "profit lock: gave back half of the day's best");
  if (d.trades >= 4) return "4 trades today";
  if (d.consecLoss >= 2) return (d.done = "2 losses in a row");
  if (now - d.lastLossAt < 15 * 60000) return "15-minute cooldown after a loss";
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
  const P = { ...DEFAULT_PARAMS, ...cfg.params };
  P.stopPct = Math.min(0.3, P.stopPct || 0.3);
  if (!b.day || b.day.date !== t.date) freshDay(b, t);

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
    if (pnl < 0) { d.consecLoss++; d.lastLossAt = now; if (/stop/.test(why)) d.stopOuts.push({ sym: group(p.under), dir: p.dir, level: p.uEntry }); } else d.consecLoss = 0;
    const avgExit = p.exits.reduce((s, e) => s + e.qty * e.px, 0) / p.qty;
    const trade = { ...p, pnl, R: r2(pnl / p.risk), avgExit: r2(avgExit), exitWhy: why, closedAt: now, closedET: hhmm(t.min), balance: b.balance };
    delete trade.qtyOpen; delete trade.missed; delete trade.lastBid;
    b.open = null;
    log(b, t, pnl >= 0 ? "win" : "loss", p.label, `${why} · ${usd(pnl)}`);
    if (!champion) { b.recent = [{ date: t.date, et: p.et, label: p.label, signal: p.signal, pnl, R: trade.R, why }, ...(b.recent || [])].slice(0, 30); return; }
    X.closed.push(trade);
    X.shadow.push({ id: p.id, symbol: p.symbol, until: now + 30 * 60000 });
    X.messages.push({
      title: `📄 PAPER ${pnl >= 0 ? "WIN" : "LOSS"} ${usd(pnl)} · ${p.label}`,
      text: `Bought ${p.qty} @ ${usd(p.entry)} · sold ${p.exits.map((e) => `${e.qty} @ ${usd(e.px)} (${e.why})`).join(", ")}\n${r2(pnl / p.risk)}R · day ${usd(d.pnl)} · paper account ${usd(b.balance)}`,
      color: pnl >= 0 ? 0x2ec26b : 0xf0556b,
    });
  }

  function enter(p, k, underPx, how) {
    const ask = k.ask, bid = k.bid;
    const cost1 = ask * 100, riskPer = cost1 * P.stopPct + 2 * FEE;
    const share = cfg.sizing === "edge" && (p.est == null || p.est < 0.2) ? 0.25 : 0.5;
    let qty = Math.floor((share * b.balance) / cost1);
    if (qty < 1) { log(b, t, "skipped", p.title, `one ${k.label} costs ${usd(cost1)}, more than ${share * 100}% of the account`); return false; }
    qty = Math.min(qty, Math.floor((0.15 * b.balance) / riskPer), Math.floor((b.day.pnl + 0.15 * b.day.startBal) / riskPer));
    if (qty < 1) { log(b, t, "skipped", p.title, "one contract would risk more than the 15% limit left today"); return false; }
    b.open = {
      id: now + ":" + k.symbol, date: t.date, symbol: k.symbol, label: k.label, under: p.sym, delta: k.delta, dir: p.dir,
      qty, qtyOpen: qty, entry: ask, spreadPct: bid > 0 ? r3((ask - bid) / ((ask + bid) / 2)) : null,
      at: now, et: hhmm(t.min), stop: r2(ask * (1 - P.stopPct)), bestBid: bid || ask, bestAt: now, t1: null,
      uEntry: underPx ?? p.uEntry, uStop: p.uStop, uTarget: p.uTarget, risk: r2(qty * riskPer),
      fam: p.fam, kind: p.kind, grade: p.grade, score: p.score, ctx: p.ctx, signal: p.title, signalET: p.et, est: p.est,
      exits: [], realized: 0, path: [r3((bid || ask) / ask - 1)], params: { stopPct: P.stopPct, t1Pct: P.t1Pct }, style: cfg.name,
    };
    b.day.trades++;
    log(b, t, "bought", p.title, `${qty} × ${k.label} @ ${usd(ask)} (${how})`);
    if (champion) {
      const bull = p.dir === "bull", tk = p.sym.replace("$", "");
      X.messages.push({
        title: `📄 PAPER BUY ${qty} × ${k.label} @ ${usd(ask)}`,
        text: `From: ${p.title} (${p.et} ET) · ${how}\nStop ${usd(b.open.stop)} (−${Math.round(P.stopPct * 100)}%) or ${tk} ${bull ? "below" : "above"} ${r2(p.uStop)} · target 1 +${Math.round(P.t1Pct * 100)}% (${usd(ask * (1 + P.t1Pct))})${p.uTarget != null ? ` or ${tk} ${r2(p.uTarget)}` : ""}\nRisk ${usd(b.open.risk)} of ${usd(b.balance)} · style: ${cfg.name}${p.est != null ? ` · learned edge ${p.est}R` : ""}`,
        color: bull ? 0x2ec26b : 0xf0556b,
      });
    }
    return true;
  }

  // ---- manage the open position ----
  const pos = b.open;
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
      if (bestPct >= P.bePct) pos.stop = Math.max(pos.stop, E);
      if (bestPct >= P.lockPct) pos.stop = Math.max(pos.stop, E * (1 + P.lockTo));
      const uHit = pos.uTarget != null && u != null && (bull ? u >= pos.uTarget : u <= pos.uTarget);
      if (!pos.t1 && (pct >= P.t1Pct || (uHit && pct >= 0.15))) {
        pos.t1 = now;
        if (pos.qtyOpen >= 2) {
          sell(pos, Math.floor(pos.qtyOpen / 2), bid, uHit && pct < P.t1Pct ? "target 1 (signal's target level)" : `target 1 (+${Math.round(P.t1Pct * 100)}%)`);
          pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop2));
        } else pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop1));
        if (champion) X.messages.push({ title: `📄 PAPER target 1 · ${pos.label}`, text: `Option ${usd(bid)} (+${Math.round(pct * 100)}%). ${pos.qty >= 2 ? "Sold half; runner" : "Stop"} now ${usd(pos.stop)}, trailing.`, color: 0xffd700 });
      }
      if (pos.t1) pos.stop = Math.max(pos.stop, E + (pos.qty >= 2 ? P.keep2 : P.keep1) * (pos.bestBid - E));
      const opp = candidates.find((c) => group(c.sym) === group(pos.under) && c.dir !== pos.dir && decide(model, c).ok);
      let why = null;
      if (bid <= pos.stop) why = pos.stop > E ? (pos.t1 ? "trailing stop" : "locked-profit stop") : pos.stop === E ? "breakeven stop" : `premium stop (−${Math.round(P.stopPct * 100)}%)`;
      else if (u != null && pos.uStop != null && (bull ? u <= pos.uStop : u >= pos.uStop)) why = `signal's stop (${pos.under.replace("$", "")} ${r2(u)} through ${r2(pos.uStop)})`;
      else if (!pos.t1 && now - pos.at >= P.timeStopMin * 60000 && bestPct < P.timeStopGain) why = `time stop (no +${Math.round(P.timeStopGain * 100)}% in ${P.timeStopMin} min)`;
      else if (pos.t1 && now - pos.bestAt >= P.stallMin * 60000) why = `runner stalled ${P.stallMin} min`;
      else if (opp) why = "opposite signal: " + opp.title;
      else if (t.min >= 959) why = "3:59 close";
      if (why) sell(pos, pos.qtyOpen, bid, why);
    }
    if (b.open && b.open.missed >= 5) log(b, t, "warning", b.open.label, "no option quote for 5 minutes");
  }

  // ---- signals waiting for their entry level ----
  if (!b.open) {
    for (const p of b.pending) {
      if (p.done || b.open) continue;
      const bull = p.dir === "bull", u = px(p.sym);
      const g = gate(b, cfg, p, t, now);
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
    const g = gate(b, cfg, c, t, now);
    if (g) { log(b, t, "skipped", c.title, g); continue; }
    if (b.open) { log(b, t, "skipped", c.title, "a position is already open"); continue; }
    const d = decide(model, c);
    if (!d.ok) { log(b, t, "skipped", c.title, d.why); continue; }
    if (c.needTrigger) {
      if (b.pending.some((p) => group(p.sym) === group(c.sym) && p.dir === c.dir)) continue;
      b.pending.push({ ...c, at: now, est: d.est });
      log(b, t, "waiting", c.title, `buys when ${c.sym.replace("$", "")} ${c.dir === "bull" ? "breaks above" : "breaks below"} ${r2(c.uEntry)}${d.why ? " · " + d.why : ""}`);
    } else {
      const k = await contractFor(c);
      if (!k || !(k.ask > 0)) { log(b, t, "skipped", c.title, "no ask price for the contract"); continue; }
      if (enter({ ...c, est: d.est }, k, c.uEntry, `signal entry, ${c.sym.replace("$", "")} ${r2(c.uEntry)}`)) b.pending = b.pending.filter((p) => group(p.sym) !== group(c.sym));
    }
  }
  if (!champion) b.log = b.log.slice(-15);
}

// candidates = this minute's new signals that were posted with a contract (from runSignals)
export async function runPaper(env, deps, { candidates = [], now = Date.now(), t }) {
  const { schwabToken, schwab, readJSON, writeJSON } = deps;
  candidates = candidates.filter((c) => TRADED.has(c.fam) && paperTicker(env, c.contract));
  const acct = (await readJSON(env, "paper:acct")) || newBook();
  const model = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  const champ = championCfg(model);
  let ch = await readJSON(env, "paper:challengers");
  if (!ch) ch = makeChallengers(champ, 1, t.date);
  acct.shadow = acct.shadow || [];
  const token = await schwabToken(env);

  // one quote call for every book's open contract, the tickers, waiting contracts and the champion's after-exit shadows
  const books = [acct, ...Object.values(ch.books).map((x) => x.book)];
  const syms = [...new Set([
    ...books.flatMap((b) => [...(b.open ? [b.open.symbol, b.open.under] : []), ...(b.pending || []).flatMap((p) => [p.sym, p.contract.symbol])]),
    ...acct.shadow.map((s) => s.symbol),
  ])];
  const Q = await quotes(schwab, token, syms);
  const chains = {};
  const X = {
    env, candidates, Q, model, now, t, closed: [], messages: [], shadow: acct.shadow,
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

  await stepBook(acct, champ, { ...X, champion: true });
  for (const x of Object.values(ch.books)) {
    try { await stepBook(x.book, x.cfg, { ...X, champion: false }); } catch (e) { console.error("challenger", x.cfg.id, e); }
  }
  // per-session results for the champion-vs-challenger comparison
  const rec = (id, b) => { const h = (ch.hist[id] = ch.hist[id] || {}); h[t.date] = { pnl: b.day.pnl, trades: b.day.trades, gw: b.day.gw, gl: b.day.gl }; };
  rec("champion", acct);
  for (const [id, x] of Object.entries(ch.books)) rec(id, x.book);

  acct.updatedAt = now;
  await writeJSON(env, "paper:acct", acct);
  await writeJSON(env, "paper:challengers", ch);
  if (X.closed.length) {
    const tr = (await readJSON(env, "paper:trades")) || { items: [] };
    tr.items.push(...X.closed);
    tr.items = tr.items.slice(-2000);
    await writeJSON(env, "paper:trades", tr);
  }
  for (const m of X.messages) await post(env, { title: m.title, description: m.text, color: m.color, footer: { text: `${hhmm(t.min)} ET · paper trade (no real order)` } }).catch(() => {});
  return { balance: acct.balance, open: acct.open && acct.open.label, pending: acct.pending.length, closed: X.closed.length, challengers: Object.keys(ch.books).length };
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
export async function runLearning(env, deps, { force = false, report = false, now = Date.now(), t }) {
  const { readJSON, writeJSON } = deps;
  const prev = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  if (!force && prev.lastRun === t.date) return { skipped: "already trained today" };
  const stats = (await readJSON(env, "bot:stats")) || { items: [] };
  const trades = (await readJSON(env, "paper:trades")) || { items: [] };
  const { model, changes } = learn(prev, stats.items, trades.items, t.date);

  // a winning challenger takes over the paper account (its style becomes the champion; a new set of challengers starts)
  const ch = await readJSON(env, "paper:challengers");
  const win = ch && pickWinner(ch);
  if (win) {
    model.style = { name: [...(win.cfg.traits || [])].join(" + ") || win.cfg.name, traits: win.cfg.traits || [], delta: win.cfg.delta, window: win.cfg.window, sizing: win.cfg.sizing };
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
  if (t.wd === "Fri" || report) {
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
  return { v: model.v, changes, samples: model.samples, promoted: win ? win.cfg.name : null };
}
