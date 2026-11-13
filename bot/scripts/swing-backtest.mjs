// usage: node scripts/swing-backtest.mjs SPY https://<your-bot>.workers.dev   (caches daily data as d_<SYM>.json in the current folder)
// Swing backtest (PDF 5 swing examples + PDF 8/9 squeeze): SPY daily, monthly (Swing) ATR levels, daily Pivot Ribbon, Phase Oscillator squeeze.
import fs from "fs";
const B = new URL("../src/", import.meta.url).href;
const { ema, ribbon, phaseOsc, modeLevels, dailyDate } = await import(B + "levels.js");
const KEY = fs.readFileSync(new URL("../.admin-key", import.meta.url), "utf8").trim();
const BOT = (process.argv[3] || process.env.BOT_URL || "").replace(/\/$/, "");
const get = async (q) => { const r = await fetch(BOT + "/history?" + new URLSearchParams(q), { headers: { "x-bot-key": KEY } }); const j = await r.json(); return Array.isArray(j) ? j : j.candles || []; };
const sym = process.argv[2] || "SPY";
const d = fs.existsSync(`d_${sym}.json`) ? JSON.parse(fs.readFileSync(`d_${sym}.json`)) : await get({ symbol: sym, periodType: "year", period: "10", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
fs.writeFileSync(`d_${sym}.json`, JSON.stringify(d));
const vix = fs.existsSync("d_VIX.json") ? JSON.parse(fs.readFileSync("d_VIX.json")) : await get({ symbol: "$VIX", periodType: "year", period: "10", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
fs.writeFileSync("d_VIX.json", JSON.stringify(vix));
const vixBy = Object.fromEntries(vix.map((c) => [dailyDate(c), c.close]));
const days = d.map((c) => ({ ...c, date: dailyDate(c), month: dailyDate(c).slice(0, 7) }));
// monthly candles
const months = []; for (const c of days) { const m = months.at(-1); if (!m || m.month !== c.month) months.push({ month: c.month, open: c.open, high: c.high, low: c.low, close: c.close, datetime: c.datetime }); else { m.high = Math.max(m.high, c.high); m.low = Math.min(m.low, c.low); m.close = c.close; } }
const closes = days.map((c) => c.close), e8 = ema(closes, 8), e13 = ema(closes, 13), e21 = ema(closes, 21), e48 = ema(closes, 48);
const osc = []; for (let i = 0; i < days.length; i++) osc.push(i > 60 ? phaseOsc(days.slice(Math.max(0, i - 300), i + 1)) : null);
const trades = [];
function simulate(name, i, dir, lv) {
  // enter next day's open; target 1 = midrange (±61.8% monthly), then +1 ATR; stop = daily close beyond the 21 EMA; max 20 days
  if (i + 1 >= days.length) return;
  const up = dir === "bull", entry = days[i + 1].open;
  const t1 = lv[up ? "+0.618" : "-0.618"], t2 = lv[up ? "+1" : "-1"];
  if (up ? entry >= t1 : entry <= t1) return; // already past target 1: don't chase
  let exit = null, why = "", half = false, realized = 0;
  for (let j = i + 1; j < Math.min(days.length, i + 21); j++) {
    const c = days[j];
    if (!half && (up ? c.high >= t1 : c.low <= t1)) { half = true; realized += 0.5 * ((up ? t1 - entry : entry - t1) / entry); }
    if (half && (up ? c.high >= t2 : c.low <= t2)) { exit = t2; why = "target 2 (±1 ATR)"; break; }
    if (up ? c.close < e21[j] : c.close > e21[j]) { exit = c.close; why = half ? "21 EMA lost after target 1" : "stop: close beyond the 21 EMA"; break; }
    if (j === Math.min(days.length, i + 21) - 1) { exit = c.close; why = "20-day time exit"; }
  }
  if (exit == null) return;
  const rest = (up ? exit - entry : entry - exit) / entry;
  const pct = (half ? realized + 0.5 * rest : rest) * 100;
  trades.push({ name, date: days[i].date, dir, entry, pct, why, vix: vixBy[days[i].date] });
}
let last = {};
for (let i = 260; i < days.length - 1; i++) {
  const m = days[i].month, prior = months.filter((x) => x.month < m);
  const L = modeLevels(prior); if (!L) continue; const lv = L.atrLevels;
  const c = days[i], p = days[i - 1];
  const bullStack = e8[i] > e13[i] && e13[i] > e21[i] && e21[i] > e48[i], bearStack = e8[i] < e13[i] && e13[i] < e21[i] && e21[i] < e48[i];
  const cool = (k) => !last[k] || i - last[k] > 5;
  if (bullStack && c.close > e8[i] && cool("base")) { simulate("BASELINE: any day ribbon stacked up (calls)", i, "bull", lv); last.base = i; }
  // S1: trigger break with the ribbon
  if (bullStack && c.close > e8[i] && p.close <= lv["+0.236"] && c.close > lv["+0.236"] && cool("s1b")) { simulate("Trigger break (monthly call trigger)", i, "bull", lv); last.s1b = i; }
  if (bearStack && c.close < e8[i] && p.close >= lv["-0.236"] && c.close < lv["-0.236"] && cool("s1s")) { simulate("Trigger break (monthly put trigger)", i, "bear", lv); last.s1s = i; }
  // S2: daily 21 EMA pullback that holds
  if (bullStack && c.low <= e21[i] * 1.002 && c.close > e21[i] && c.close > c.open && cool("s2b")) { simulate("Daily 21 EMA pullback (calls)", i, "bull", lv); last.s2b = i; }
  if (bearStack && c.high >= e21[i] * 0.998 && c.close < e21[i] && c.close < c.open && cool("s2s")) { simulate("Daily 21 EMA pullback (puts)", i, "bear", lv); last.s2s = i; }
  // S3: squeeze fires with the ribbon, near the 21 EMA (within 1.5 daily ATR)
  const o = osc[i]; const atrD = Math.abs(lv["+1"] - lv["-1"]) / 2 / 4; // rough daily ATR from the monthly ATR (~1/4)
  if (o && o.squeezeFired && Math.abs(c.close - e21[i]) < 1.5 * atrD) {
    if (e8[i] > e21[i] && c.close > e21[i] && cool("s3b")) { simulate("Squeeze fire (calls)", i, "bull", lv); last.s3b = i; }
    if (e8[i] < e21[i] && c.close < e21[i] && cool("s3s")) { simulate("Squeeze fire (puts)", i, "bear", lv); last.s3s = i; }
  }
}
const sum = (name, list) => {
  if (!list.length) return console.log(name.padEnd(44), "none");
  const w = list.filter((t) => t.pct > 0), gw = w.reduce((s, t) => s + t.pct, 0), gl = -list.filter((t) => t.pct <= 0).reduce((s, t) => s + t.pct, 0);
  console.log(name.padEnd(44), `${String(list.length).padStart(3)} trades · win ${String(Math.round((w.length / list.length) * 100)).padStart(3)}% · avg ${(list.reduce((s, t) => s + t.pct, 0) / list.length).toFixed(2).padStart(5)}% · PF ${gl ? (gw / gl).toFixed(2) : "∞"}`);
};
console.log(`${sym} daily ${days[0].date} → ${days.at(-1).date}`);
for (const n of [...new Set(trades.map((t) => t.name))]) sum(n, trades.filter((t) => t.name === n));
console.log("--- by VIX (Saty: under 20 = swing-friendly)");
for (const n of [...new Set(trades.map((t) => t.name))]) { sum(n + " · VIX<20", trades.filter((t) => t.name === n && t.vix < 20)); sum(n + " · VIX≥20", trades.filter((t) => t.name === n && t.vix >= 20)); }
console.log("--- split halves (older / newer) for consistency");
const mid = days[Math.floor(days.length / 2)].date;
for (const n of [...new Set(trades.map((t) => t.name))]) { sum(n + " · older", trades.filter((t) => t.name === n && t.date < mid)); sum(n + " · newer", trades.filter((t) => t.name === n && t.date >= mid)); }
fs.writeFileSync(`swing_${sym}.json`, JSON.stringify(trades));
