// Swing alerts (PDF 5 swing examples + PDF 8/9 squeeze), checked once a day after the close on SPY daily candles.
// Backtest (SPY, 10 years, scripts in the repo notes): vs a baseline of +0.08%/trade (PF 1.10) for "any day the ribbon is stacked":
//   monthly call-trigger break +0.32% (PF 1.43, both halves positive) · daily 21 EMA pullback +0.22% (PF 1.33) · squeeze fire +0.51% (PF 1.92)
//   every PUT swing lost (PF 0.2-0.6), so swings are CALLS ONLY.
// Rules: enter next day's open · target 1 = monthly midrange (+61.8%, sell half) · target 2 = +1 monthly ATR ·
//        stop = a daily close below the 21 EMA · time exit after 20 trading days · contract idea: SPY ~30-45 DTE, delta ~0.70.
import { ema, phaseOsc, modeLevels, dailyDate } from "./levels.js";
import { post } from "./signals.js";

const r2 = (x) => Math.round(x * 100) / 100;

export async function runSwing(env, deps, { t, now = Date.now() }) {
  const { schwabToken, schwab, history, readJSON, writeJSON } = deps;
  const book = (await readJSON(env, "swing:book")) || { open: [], closed: [], lastRun: null };
  if (book.lastRun === t.date) return { skipped: "already ran today" };
  const token = await schwabToken(env);
  const d = (await history(token, { symbol: "SPY", periodType: "year", period: "2", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" }))
    .map((c) => ({ ...c, date: dailyDate(c), month: dailyDate(c).slice(0, 7) }));
  // today's daily candle often isn't published until later: build it from the quote (open / high / low / last)
  if (d.length && d.at(-1).date !== t.date) {
    const q = await schwab(token, "/marketdata/v1/quotes?fields=quote&symbols=SPY").catch(() => ({}));
    const x = q.SPY && q.SPY.quote;
    if (x && x.openPrice && x.highPrice) d.push({ open: x.openPrice, high: x.highPrice, low: x.lowPrice, close: x.closePrice && t.min < 570 ? x.closePrice : x.lastPrice, volume: x.totalVolume, datetime: now, date: t.date, month: t.date.slice(0, 7) });
  }
  const i = d.length - 1;
  if (i < 300 || d[i].date !== t.date) return { skipped: "no daily candle for today yet" };
  const closes = d.map((c) => c.close), e8 = ema(closes, 8), e13 = ema(closes, 13), e21 = ema(closes, 21), e48 = ema(closes, 48);
  const months = [];
  for (const c of d) { const m = months.at(-1); if (!m || m.month !== c.month) months.push({ month: c.month, open: c.open, high: c.high, low: c.low, close: c.close, datetime: c.datetime }); else { m.high = Math.max(m.high, c.high); m.low = Math.min(m.low, c.low); m.close = c.close; } }
  const L = modeLevels(months.filter((x) => x.month < d[i].month));
  if (!L) return { skipped: "no monthly levels" };
  const lv = L.atrLevels, c = d[i], p = d[i - 1];
  const messages = [];

  // ---- manage open swings with today's daily candle ----
  for (const s of book.open) {
    if (s.entry == null) { s.entry = c.open; s.entryDate = c.date; }   // filled at this morning's open
    s.days = (s.days || 0) + 1;
    if (!s.half && c.high >= s.t1) { s.half = true; s.realized = 0.5 * ((s.t1 - s.entry) / s.entry); }
    let exit = null, why = "";
    if (s.half && c.high >= s.t2) { exit = s.t2; why = "target 2 (+1 monthly ATR)"; }
    else if (c.close < e21[i]) { exit = c.close; why = s.half ? "closed below the 21 EMA after target 1" : "stop: daily close below the 21 EMA"; }
    else if (s.days >= 20) { exit = c.close; why = "20-day time exit"; }
    if (exit != null) {
      const rest = (exit - s.entry) / s.entry, pct = r2(((s.half ? s.realized + 0.5 * rest : rest)) * 100);
      Object.assign(s, { exit, exitDate: c.date, why, pct, done: true });
      messages.push({ title: `🧭 SWING ${pct >= 0 ? "WIN" : "LOSS"} ${pct >= 0 ? "+" : ""}${pct}% (SPY) · ${s.setup}`, text: `Entry ${r2(s.entry)} (${s.entryDate}) → exit ${r2(exit)} (${c.date}): ${why}.`, color: pct >= 0 ? 0x2ec26b : 0xf0556b });
    } else if (s.half && !s.halfPosted) {
      s.halfPosted = true;
      messages.push({ title: `🧭 SWING target 1 · ${s.setup}`, text: `SPY reached the monthly midrange ${r2(s.t1)}: sell half, hold the rest for ${r2(s.t2)} while it closes above the 21 EMA (${r2(e21[i])}).`, color: 0xffd700 });
    }
  }
  book.closed.push(...book.open.filter((s) => s.done));
  book.closed = book.closed.slice(-300);
  book.open = book.open.filter((s) => !s.done);

  // ---- new swing setups on today's close (calls only) ----
  const bullStack = e8[i] > e13[i] && e13[i] > e21[i] && e21[i] > e48[i];
  const recent = (name) => book.open.some((s) => s.setup === name) || book.closed.some((s) => s.setup === name && Date.parse(t.date) - Date.parse(s.date) < 7 * 864e5);
  const found = [];
  if (bullStack && c.close > e8[i] && p.close <= lv["+0.236"] && c.close > lv["+0.236"]) found.push(["Monthly call-trigger break", `closed above the monthly call trigger ${r2(lv["+0.236"])} with the daily ribbon stacked up`, "+0.32%/trade, PF 1.43"]);
  if (bullStack && c.low <= e21[i] * 1.002 && c.close > e21[i] && c.close > c.open) found.push(["Daily 21 EMA pullback", `pulled back to the daily 21 EMA ${r2(e21[i])} in a stacked ribbon and closed green above it`, "+0.22%/trade, PF 1.33 (best with VIX < 20)"]);
  const o = phaseOsc(d.slice(-300)), atrD = (lv["+1"] - lv["-1"]) / 8;
  if (o && o.squeezeFired && e8[i] > e21[i] && c.close > e21[i] && Math.abs(c.close - e21[i]) < 1.5 * atrD) found.push(["Daily squeeze fire", `the daily compression just fired up with price near the 21 EMA ${r2(e21[i])}`, "+0.51%/trade, PF 1.92 (weaker in recent years)"]);
  for (const [setup, why, bt] of found) {
    if (recent(setup)) continue;
    if (c.close >= lv["+0.618"]) continue; // already past target 1: don't chase
    // contract idea: SPY 30-45 DTE call nearest delta 0.70 (John Carter / Saty swing note)
    let idea = null;
    try {
      const from = new Date(now + 30 * 864e5).toISOString().slice(0, 10), to = new Date(now + 45 * 864e5).toISOString().slice(0, 10);
      const ch = await schwab(token, `/marketdata/v1/chains?symbol=SPY&contractType=CALL&strikeCount=20&fromDate=${from}&toDate=${to}`);
      const list = []; for (const e in ch.callExpDateMap || {}) for (const k in ch.callExpDateMap[e]) list.push(...ch.callExpDateMap[e][k].map((x) => ({ ...x, exp: e.split(":")[0] })));
      const best = list.filter((x) => x.delta != null && x.ask > 0).sort((a, b) => Math.abs(a.delta - 0.7) - Math.abs(b.delta - 0.7))[0];
      if (best) idea = `SPY ${best.strikePrice}c ${best.exp.slice(5)} ~ $${r2(best.mark)} (Δ ${best.delta.toFixed(2)})`;
    } catch (e) {}
    book.open.push({ setup, date: t.date, entry: null, t1: lv["+0.618"], t2: lv["+1"], stopRef: "daily close below the 21 EMA", idea });
    messages.push({
      title: `🧭 SWING ALERT (calls) · ${setup}`,
      text: `SPY ${r2(c.close)}: ${why}.\n**Plan:** buy at tomorrow's open · target 1 ${r2(lv["+0.618"])} (monthly midrange, sell half) · target 2 ${r2(lv["+1"])} (+1 monthly ATR) · stop: a daily close below the 21 EMA (now ${r2(e21[i])}) · out after 20 trading days.`
        + `${idea ? `\nContract idea: ${idea}` : ""}\nBacktest (SPY, 10 yrs): ${bt}. Swing puts are not used (all lost in the backtest).`,
      color: 0x3b82f6,
    });
  }
  book.lastRun = t.date;
  await writeJSON(env, "swing:book", book);
  for (const m of messages) await post(env, { title: m.title, description: m.text, color: m.color, footer: { text: "swing (days to weeks) · paper-tracked, no real order" } }).catch(() => {});
  return { open: book.open.length, posted: messages.length };
}
