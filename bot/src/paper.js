// Paper trading (RULES.md: Money, Instrument, Session, Exits, Profit ladder, Protecting the day, Paper mode).
// Runs every minute right after the signal scan. No orders are ever sent: fills are simulated on live Schwab quotes.
//
//   signal (SPX or SPY) -> queued -> next minute's check: still valid? learning says yes? -> buy at the ASK
//   open position: profit ladder, structure stop, time stop, runner trail, 3:45 close -> sell at the BID
//   every decision (taken, skipped and why) is logged; closed trades feed the nightly learning run (learn.js)
import { hhmm } from "./levels.js";
import { post } from "./signals.js";
import { decide, learn, DEFAULT_MODEL, DEFAULT_PARAMS, FAM_NAMES } from "./learn.js";

const FEE = 0.65;            // Schwab, per contract per side
const START = 2000;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const usd = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
const TRADED = new Set(["star", "mom", "flip", "squeeze", "box", "div1m", "div3m", "cbox1m", "cbox3m", "plan-trigger"]);

function freshDay(acct, t) {
  acct.day = { date: t.date, startBal: acct.balance, pnl: 0, best: 0, trades: 0, consecLoss: 0, lastLossAt: 0, stopOuts: [], done: null };
  acct.log = [];
  acct.pending = [];
}
const log = (acct, t, action, title, why) => { acct.log.push({ et: hhmm(t.min), action, title, why: why || "" }); acct.log = acct.log.slice(-80); };

// hard rules that apply before the learned model is even asked
function gate(acct, cand, t, now) {
  const d = acct.day, sb = d.startBal;
  if (!TRADED.has(cand.fam)) return "not a tradable setup";
  if (t.min < 573) return "before 9:33 (opening range)";
  if (t.min >= 900) return "no new entries after 3:00";
  if (t.min >= 690 && t.min < 810 && !(cand.fam === "star" && (cand.grade === "A+" || cand.score >= 90))) return "midday 11:30-1:30: A-grade (90+) only";
  if (d.done) return d.done;
  if (d.pnl <= -0.15 * sb) return (d.done = "daily loss limit (−15%) reached");
  if (d.pnl >= 0.15 * sb) return (d.done = "daily target (+15%) reached");
  if (d.best >= 0.10 * sb && d.pnl < d.best / 2) return (d.done = "profit lock: gave back half of the day's best");
  if (d.trades >= 4) return "4 trades today";
  if (d.consecLoss >= 2) return (d.done = "2 losses in a row");
  if (now - d.lastLossAt < 15 * 60000) return "15-minute cooldown after a loss";
  if (d.stopOuts.some((s) => s.dir === cand.dir && Math.abs(s.level - cand.uEntry) <= cand.uEntry * 0.0008)) return "already stopped out at this level in this direction";
  return null;
}

async function quotes(schwab, token, syms) {
  if (!syms.length) return {};
  const q = await schwab(token, "/marketdata/v1/quotes?fields=quote&symbols=" + syms.map(encodeURIComponent).join(",")).catch(() => ({}));
  const out = {};
  for (const s of syms) {
    const x = q[s] && q[s].quote;
    if (x) out[s] = { bid: x.bidPrice, ask: x.askPrice, mark: x.mark ?? x.lastPrice, delta: x.delta };
  }
  return out;
}
const spxSymbol = (date, type, strike) => `SPXW  ${date.slice(2).replace(/-/g, "")}${type === "CALL" ? "C" : "P"}${String(Math.round(strike * 1000)).padStart(8, "0")}`;

// your posted contract first; otherwise SPX 0DTE with delta 0.45-0.60 and a spread of at most 5% of mid
async function pickContract(schwab, token, date, dir, planStrike) {
  const type = dir === "bull" ? "CALL" : "PUT";
  if (planStrike) {
    const sym = spxSymbol(date, type, planStrike);
    const q = (await quotes(schwab, token, [sym]))[sym];
    if (q && q.ask > 0 && q.bid > 0) return { symbol: sym, strike: planStrike, type, ...q, posted: true };
  }
  const chain = await schwab(token, `/marketdata/v1/chains?symbol=%24SPX&contractType=${type}&strikeCount=24&fromDate=${date}&toDate=${date}`).catch(() => ({}));
  const list = [];
  for (const exp in chain[type === "CALL" ? "callExpDateMap" : "putExpDateMap"] || {}) for (const k in chain[type === "CALL" ? "callExpDateMap" : "putExpDateMap"][exp]) for (const o of chain[type === "CALL" ? "callExpDateMap" : "putExpDateMap"][exp][k]) list.push(o);
  const ok = list.filter((o) => o.ask > 0 && o.bid > 0 && o.delta != null && (o.ask - o.bid) / ((o.ask + o.bid) / 2) <= 0.05);
  const inBand = ok.filter((o) => Math.abs(o.delta) >= 0.45 && Math.abs(o.delta) <= 0.6);
  const o = (inBand.length ? inBand : ok.filter((o) => Math.abs(o.delta) >= 0.35 && Math.abs(o.delta) <= 0.7))
    .sort((a, b) => Math.abs(Math.abs(a.delta) - 0.5) - Math.abs(Math.abs(b.delta) - 0.5))[0];
  return o ? { symbol: o.symbol, strike: o.strikePrice, type, bid: o.bid, ask: o.ask, mark: o.mark, delta: o.delta, posted: false } : null;
}

// candidates = this minute's new SPX/SPY signals from runSignals; spx = live SPX
export async function runPaper(env, deps, { candidates = [], spx, plan = {}, now = Date.now(), t }) {
  const { schwabToken, schwab, readJSON, writeJSON } = deps;
  const acct = (await readJSON(env, "paper:acct")) || { start: START, balance: START, open: null, pending: [], shadow: [], log: [] };
  const model = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  const P = { ...DEFAULT_PARAMS, ...(model.params || {}), stopPct: Math.min(0.3, (model.params || {}).stopPct || 0.3) };
  if (!acct.day || acct.day.date !== t.date) freshDay(acct, t);
  acct.shadow = acct.shadow || [];
  const token = await schwabToken(env);
  const closed = [];
  const messages = [];

  // one quote call for the open position and the "after the exit" shadows
  const syms = [...new Set([...(acct.open ? [acct.open.symbol] : []), ...acct.shadow.map((s) => s.symbol)])];
  const Q = await quotes(schwab, token, syms);

  // shadows: keep recording the option for 30 minutes after an exit (learning replays other exit settings on it)
  if (acct.shadow.length) {
    const tr = (await readJSON(env, "paper:trades")) || { items: [] };
    for (const s of acct.shadow) {
      const q = Q[s.symbol], x = tr.items.find((i) => i.id === s.id);
      if (q && x && q.bid > 0) x.path.push(r3(q.bid / x.entry - 1));
      if (now - s.until > 0 || t.min >= 960 || !x) s.done = true;
    }
    acct.shadow = acct.shadow.filter((s) => !s.done);
    await writeJSON(env, "paper:trades", tr);
  }

  // ---- manage the open position ----
  const pos = acct.open;
  if (pos && pos.date !== t.date) {
    sell(pos, pos.qtyOpen, pos.lastBid || 0, "carried past the session (closed at last price)", now, t);
  } else if (pos) {
    const q = Q[pos.symbol];
    if (!q || !(q.bid >= 0)) pos.missed = (pos.missed || 0) + 1;
    else {
      const bid = q.bid, E = pos.entry, bull = pos.dir === "bull";
      pos.lastBid = bid; pos.missed = 0;
      pos.path.push(r3(bid / E - 1));
      if (bid > pos.bestBid) { pos.bestBid = bid; pos.bestAt = now; }
      const pct = bid / E - 1, bestPct = pos.bestBid / E - 1;
      // profit ladder (stops only move up)
      if (bestPct >= P.bePct) pos.stop = Math.max(pos.stop, E);
      if (bestPct >= P.lockPct) pos.stop = Math.max(pos.stop, E * (1 + P.lockTo));
      const uHit = pos.uTarget != null && spx != null && (bull ? spx >= pos.uTarget : spx <= pos.uTarget);
      if (!pos.t1 && (pct >= P.t1Pct || (uHit && pct >= 0.15))) {
        pos.t1 = now;
        if (pos.qtyOpen >= 2) {
          sell(pos, Math.floor(pos.qtyOpen / 2), bid, uHit && pct < P.t1Pct ? "target 1 (SPX level)" : `target 1 (+${Math.round(P.t1Pct * 100)}%)`, now, t);
          pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop2));
        } else pos.stop = Math.max(pos.stop, E * (1 + P.runnerStop1));
        messages.push({ title: `📄 PAPER target 1 · ${pos.label}`, text: `Option ${usd(bid)} (+${Math.round(pct * 100)}%). ${pos.qty >= 2 ? "Sold half; runner" : "Stop"} now ${usd(pos.stop)}, trailing.`, color: 0xffd700 });
      }
      if (pos.t1) pos.stop = Math.max(pos.stop, E + (pos.qty >= 2 ? P.keep2 : P.keep1) * (pos.bestBid - E));
      const opp = candidates.find((c) => c.dir !== pos.dir && decide(model, c).ok);
      let why = null;
      if (bid <= pos.stop) why = pos.stop > E ? (pos.t1 ? "trailing stop" : "locked-profit stop") : pos.stop === E ? "breakeven stop" : `premium stop (−${Math.round(P.stopPct * 100)}%)`;
      else if (spx != null && pos.uStop != null && (bull ? spx <= pos.uStop : spx >= pos.uStop)) why = `structure stop (SPX ${r2(spx)} through ${r2(pos.uStop)})`;
      else if (!pos.t1 && now - pos.at >= P.timeStopMin * 60000 && bestPct < P.timeStopGain) why = `time stop (no +${Math.round(P.timeStopGain * 100)}% in ${P.timeStopMin} min)`;
      else if (pos.t1 && now - pos.bestAt >= P.stallMin * 60000) why = `runner stalled ${P.stallMin} min`;
      else if (opp) why = "opposite signal: " + opp.title;
      else if (t.min >= 945) why = "3:45 close";
      if (why) sell(pos, pos.qtyOpen, bid, why, now, t);
    }
    if (pos.missed >= 5) log(acct, t, "warning", pos.label, "no option quote for 5 minutes");
  }
  function sell(p, qty, px, why, now, t) {
    if (qty <= 0) return;
    p.realized += qty * (px - p.entry) * 100 - qty * FEE;
    p.qtyOpen -= qty;
    p.exits.push({ et: hhmm(t.min), at: now, qty, px, why });
    if (p.qtyOpen > 0) return;
    const pnl = r2(p.realized - p.qty * FEE);
    const d = acct.day;
    acct.balance = r2(acct.balance + pnl);
    d.pnl = r2(d.pnl + pnl); d.best = Math.max(d.best, d.pnl);
    if (pnl < 0) { d.consecLoss++; d.lastLossAt = now; if (/stop/.test(why)) d.stopOuts.push({ dir: p.dir, level: p.uEntry }); } else d.consecLoss = 0;
    const avgExit = p.exits.reduce((s, e) => s + e.qty * e.px, 0) / p.qty;
    const trade = { ...p, pnl, R: r2(pnl / p.risk), avgExit: r2(avgExit), exitWhy: why, closedAt: now, closedET: hhmm(t.min), balance: acct.balance };
    delete trade.qtyOpen; delete trade.missed; delete trade.lastBid;
    closed.push(trade);
    acct.open = null;
    acct.shadow.push({ id: p.id, symbol: p.symbol, until: now + 30 * 60000 });
    log(acct, t, pnl >= 0 ? "win" : "loss", p.label, `${why} · ${usd(pnl)}`);
    messages.push({
      title: `📄 PAPER ${pnl >= 0 ? "WIN" : "LOSS"} ${usd(pnl)} · ${p.label}`,
      text: `Bought ${p.qty} @ ${usd(p.entry)} · sold ${p.exits.map((e) => `${e.qty} @ ${usd(e.px)} (${e.why})`).join(", ")}\n${r2(pnl / p.risk)}R · day ${usd(d.pnl)} · paper account ${usd(acct.balance)}`,
      color: pnl >= 0 ? 0x2ec26b : 0xf0556b,
    });
  }

  // ---- pending entries from earlier minutes: fill now (the delay a real order would have) ----
  if (!acct.open) {
    for (const p of acct.pending) {
      if (p.done) continue;
      const age = now - p.at, bull = p.dir === "bull";
      const g = gate(acct, p, t, now);
      if (g) { p.done = true; log(acct, t, "skipped", p.title, g); continue; }
      if (spx == null) continue;
      if (bull ? spx <= p.uStop : spx >= p.uStop) { p.done = true; log(acct, t, "dropped", p.title, "price went through the stop before entry"); continue; }
      if (p.needTrigger) {
        const hit = bull ? spx >= p.uEntry : spx <= p.uEntry;
        if (!hit) { if (age > 9 * 60000) { p.done = true; log(acct, t, "dropped", p.title, "not triggered within 9 minutes"); } continue; }
      } else if (age < 40000) continue;
      if (age > 12 * 60000) { p.done = true; log(acct, t, "dropped", p.title, "too old"); continue; }
      if (p.uTarget != null && Math.abs(spx - p.uEntry) > Math.abs(p.uTarget - p.uEntry) / 2 && (bull ? spx > p.uEntry : spx < p.uEntry)) { p.done = true; log(acct, t, "dropped", p.title, "don't chase: over half way to the target"); continue; }
      p.done = true;
      const planStrike = bull ? plan.call : plan.put;
      const c = await pickContract(schwab, token, t.date, p.dir, planStrike);
      if (!c) { log(acct, t, "skipped", p.title, "no SPX 0DTE contract with delta 0.45-0.60 and a tight spread"); continue; }
      const cost1 = c.ask * 100, riskPer = cost1 * P.stopPct + 2 * FEE;
      let qty = Math.floor((0.5 * acct.balance) / cost1);
      if (qty < 1) { log(acct, t, "skipped", p.title, `one ${c.strike}${c.type[0].toLowerCase()} costs ${usd(cost1)}, more than 50% of the account`); continue; }
      qty = Math.min(qty, Math.floor((0.15 * acct.balance) / riskPer));
      const room = acct.day.pnl + 0.15 * acct.day.startBal;
      qty = Math.min(qty, Math.floor(room / riskPer));
      if (qty < 1) { log(acct, t, "skipped", p.title, "one contract would risk more than the 15% limit left today"); continue; }
      const label = `SPX ${c.strike}${c.type === "CALL" ? "c" : "p"}`;
      acct.open = {
        id: now + ":" + c.symbol, date: t.date, symbol: c.symbol, label, posted: c.posted, delta: c.delta, dir: p.dir,
        qty, qtyOpen: qty, entry: c.ask, spreadPct: r3((c.ask - c.bid) / ((c.ask + c.bid) / 2)),
        at: now, et: hhmm(t.min), stop: r2(c.ask * (1 - P.stopPct)), bestBid: c.bid, bestAt: now, t1: null,
        uEntry: r2(spx), uStop: p.uStop, uTarget: p.uTarget, risk: r2(qty * riskPer),
        fam: p.fam, kind: p.kind, grade: p.grade, score: p.score, ctx: p.ctx, signal: p.title, signalET: p.et, est: p.est,
        exits: [], realized: 0, path: [r3(c.bid / c.ask - 1)], params: { stopPct: P.stopPct, t1Pct: P.t1Pct },
      };
      acct.day.trades++;
      log(acct, t, "bought", p.title, `${qty} × ${label} @ ${usd(c.ask)}${c.posted ? " (your posted contract)" : ` (Δ ${Math.abs(c.delta).toFixed(2)})`}`);
      messages.push({
        title: `📄 PAPER BUY ${qty} × ${label} 0DTE @ ${usd(c.ask)}`,
        text: `From: ${p.title} (${p.et} ET)\nStop ${usd(acct.open.stop)} (−${Math.round(P.stopPct * 100)}%) · target 1 +${Math.round(P.t1Pct * 100)}% (${usd(c.ask * (1 + P.t1Pct))}) · SPX invalid ${bull ? "below" : "above"} ${r2(p.uStop)}\nRisk ${usd(acct.open.risk)} of ${usd(acct.balance)}${p.est != null ? ` · learned edge ${p.est}R` : ""}`,
        color: bull ? 0x2ec26b : 0xf0556b,
      });
      break; // one position at a time
    }
  }
  acct.pending = acct.pending.filter((p) => !p.done && now - p.at < 12 * 60000);

  // ---- this minute's new signals: check the rules and the learned model, then queue for the next check ----
  for (const c of candidates) {
    if (!TRADED.has(c.fam)) continue;
    const g = gate(acct, c, t, now);
    if (g) { log(acct, t, "skipped", c.title, g); continue; }
    if (acct.open) { log(acct, t, "skipped", c.title, "a position is already open"); continue; }
    if (acct.pending.some((p) => p.dir === c.dir)) continue;
    const d = decide(model, c);
    if (!d.ok) { log(acct, t, "skipped", c.title, d.why); continue; }
    acct.pending.push({ ...c, at: now, est: d.est });
    log(acct, t, "queued", c.title, `fills at the next check${c.needTrigger ? " once SPX " + (c.dir === "bull" ? "breaks above " : "breaks below ") + r2(c.uEntry) : ""}${d.why ? " · " + d.why : ""}`);
  }

  acct.updatedAt = now;
  await writeJSON(env, "paper:acct", acct);
  if (closed.length) {
    const tr = (await readJSON(env, "paper:trades")) || { items: [] };
    tr.items.push(...closed);
    tr.items = tr.items.slice(-2000);
    await writeJSON(env, "paper:trades", tr);
  }
  for (const m of messages) await post(env, { title: m.title, description: m.text, color: m.color, footer: { text: `${hhmm(t.min)} ET · paper trade (no real order)` } }).catch(() => {});
  return { balance: acct.balance, open: acct.open && acct.open.label, pending: acct.pending.length, closed: closed.length };
}

// After the close: the nightly learning run (and a weekly report on Fridays).
export async function runLearning(env, deps, { force = false, report = false, now = Date.now(), t }) {
  const { readJSON, writeJSON } = deps;
  const prev = (await readJSON(env, "paper:model")) || DEFAULT_MODEL;
  if (!force && prev.lastRun === t.date) return { skipped: "already trained today" };
  const stats = (await readJSON(env, "bot:stats")) || { items: [] };
  const trades = (await readJSON(env, "paper:trades")) || { items: [] };
  const { model, changes } = learn(prev, stats.items, trades.items, t.date);
  await writeJSON(env, "paper:model", model);
  if (changes.length) await post(env, { title: `🧠 Bot learning v${model.v}: ${changes.length} change${changes.length > 1 ? "s" : ""}`, description: changes.join("\n").slice(0, 3900), color: 0x3b82f6, footer: { text: `from ${model.samples.signals} scored signals + ${model.samples.trades} paper trades · paper only` } }).catch(() => {});
  if (t.wd === "Fri" || report) {
    const acct = (await readJSON(env, "paper:acct")) || { balance: START, start: START };
    const wk = trades.items.filter((x) => now - x.closedAt < 7 * 864e5);
    const w = wk.filter((x) => x.pnl > 0), l = wk.filter((x) => x.pnl <= 0);
    const gw = w.reduce((s, x) => s + x.pnl, 0), gl = -l.reduce((s, x) => s + x.pnl, 0);
    const fam = {};
    for (const x of wk) { const f = (fam[x.fam] = fam[x.fam] || { n: 0, pnl: 0, w: 0 }); f.n++; f.pnl += x.pnl; if (x.pnl > 0) f.w++; }
    await post(env, {
      title: `📒 Weekly paper report · account ${usd(acct.balance)} (started ${usd(acct.start || START)})`,
      description: wk.length
        ? `${wk.length} trades · win ${Math.round((w.length / wk.length) * 100)}% · P/L ${usd(gw - gl)} · profit factor ${gl ? (gw / gl).toFixed(2) : "∞"}\n`
          + `Avg win ${usd(w.length ? gw / w.length : 0)} · avg loss ${usd(l.length ? -gl / l.length : 0)}\n\n`
          + Object.entries(fam).sort((a, b) => b[1].pnl - a[1].pnl).map(([k, f]) => `${FAM_NAMES[k] || k}: ${f.n} trades, ${f.w} wins, ${usd(f.pnl)}`).join("\n")
          + `\n\nSwitched off: ${Object.entries(model.fams).filter(([, f]) => f.off).map(([k]) => FAM_NAMES[k] || k).join(", ") || "none"} · min A/A+ score ${model.minScore}`
        : "No paper trades this week.",
      color: 0x3b82f6,
    }).catch(() => {});
  }
  return { v: model.v, changes, samples: model.samples };
}
