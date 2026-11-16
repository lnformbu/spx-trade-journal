// Data pool: pulls the bot's recorded history into CSV files on this computer (options/files/data/). Safe to run any time;
// each run adds the new days and keeps everything already in the files (the bot itself only keeps the most recent items).
//
//   node scripts/pull-history.mjs https://<your-bot>.workers.dev
//
//   board.csv     every 5 minutes in market hours: SPX spot, gamma flip, call/put walls, Eye of Sauron, max pain (+zone),
//                 biggest / growing 0DTE gamma strike, positive / negative gamma nodes, 0DTE call/put volume flow, tax list
//   lb.csv        every 5 minutes: the top-10 SPX 0DTE contracts (volume, last, own VWAP, % vs VWAP, in the money)
//   eod.csv       each day at the close: top-3 contracts ITM or not, the EOD plan (kill direction, pin, walls) vs the close
//   signals.csv   every scored signal (entry, stop, target, outcome, R, context)
//   paper.csv     every paper trade
//   spx_1m.csv / spy_1m.csv   1-minute candles (regular hours), spx_daily.csv   daily candles (3 years)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const BOT = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https:\/\//.test(BOT)) { console.error("usage: node scripts/pull-history.mjs https://<your-bot>.workers.dev"); process.exit(1); }
const KEY = fs.readFileSync(path.join(here, "..", ".admin-key"), "utf8").trim();
const DATA = path.join(here, "..", "..", "data");
fs.mkdirSync(DATA, { recursive: true });
const ny = (ms) => new Date(ms).toLocaleString("en-CA", { timeZone: "America/New_York", hour12: false }).replace(",", "");
const today = ny(Date.now()).slice(0, 10);

// --- tiny CSV reader/writer (quoted fields, no line breaks inside fields) ---
const parseLine = (s) => {
  const out = []; let cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
};
const readCSV = (file) => {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const h = parseLine(lines[0]);
  return lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [h[i], v])));
};
const cell = (v) => { if (v == null) return ""; const s = typeof v === "object" ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const writeCSV = (file, rows) => {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n");
};
const get = async (p, q) => {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(BOT + p + "?" + new URLSearchParams(q), { headers: { "x-bot-key": KEY } });
      if (!r.ok) throw new Error(p + " " + r.status);
      return p === "/export" ? await r.text() : await r.json();
    } catch (e) { if (i >= 4) throw e; await new Promise((res) => setTimeout(res, 2000 * i)); }
  }
};
// keep every old row before `from`, replace from `from` on with what the bot has now
const merge = (file, fresh, from) => {
  const old = readCSV(file).filter((r) => r.date < from);
  const rows = [...old, ...fresh];
  if (rows.length) writeCSV(file, rows);
  return { old: old.length, added: fresh.length };
};
const lastDate = (file, fallback) => { const r = readCSV(file); return r.length ? r.reduce((m, x) => (x.date > m ? x.date : m), "") : fallback; };

// --- bot records ---
for (const kind of ["board", "lb", "eod", "signals", "paper"]) {
  const file = path.join(DATA, kind + ".csv");
  const from = lastDate(file, "2026-11-01");
  const text = await get("/export", { kind, from, to: today });
  const lines = text.split(/\r?\n/).filter(Boolean);
  const h = lines.length ? parseLine(lines[0]) : [];
  const fresh = lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [h[i], v])));
  const m = merge(file, fresh, from);
  console.log(`${kind}.csv: ${m.old} kept + ${m.added} from ${from}`);
}

// --- candles ---
const candles = async (symbol, file, extra = {}) => {
  const from = lastDate(file, ny(Date.now() - 45 * 864e5).slice(0, 10));
  const start = new Date(from + "T00:00:00-05:00").getTime();
  let all = [];
  for (let s = start; s < Date.now(); s += 9 * 864e5) {
    const j = await get("/history", { symbol, frequencyType: "minute", frequency: "1", startDate: String(s), endDate: String(Math.min(Date.now(), s + 9 * 864e5)), needExtendedHoursData: "false", ...extra });
    all.push(...(Array.isArray(j) ? j : j.candles || []));
  }
  all = [...new Map(all.map((c) => [c.datetime, c])).values()].sort((a, b) => a.datetime - b.datetime);
  const fresh = all.map((c) => { const s = ny(c.datetime); return { date: s.slice(0, 10), time: s.slice(11, 16), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; })
    .filter((r) => r.date >= from && r.time >= "09:30" && r.time < "16:00");
  const m = merge(file, fresh, from);
  console.log(`${path.basename(file)}: ${m.old} kept + ${m.added} bars from ${from}`);
};
await candles("$SPX", path.join(DATA, "spx_1m.csv"));
await candles("SPY", path.join(DATA, "spy_1m.csv"));
const d = await get("/history", { symbol: "$SPX", periodType: "year", period: "3", frequencyType: "daily", frequency: "1", needExtendedHoursData: "false" });
const daily = (Array.isArray(d) ? d : d.candles || []).map((c) => ({ date: new Date(c.datetime + 12 * 3600e3).toISOString().slice(0, 10), open: c.open, high: c.high, low: c.low, close: c.close }));
const keepD = readCSV(path.join(DATA, "spx_daily.csv")).filter((r) => r.date < (daily[0] && daily[0].date));
writeCSV(path.join(DATA, "spx_daily.csv"), [...keepD, ...daily]);
console.log(`spx_daily.csv: ${keepD.length + daily.length} days`);
console.log("data folder:", DATA);
