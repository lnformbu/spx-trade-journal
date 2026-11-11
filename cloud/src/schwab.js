/*
 * Schwab "Transactions" CSV export -> journal trades.
 *
 * Expected columns (Schwab History -> Export):
 *   "Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
 * Option symbols look like:  SPXW 10/27/2026 7720.00 C
 *
 * Fills are paired per contract: everything from the first Buy to Open until the
 * position is flat again becomes ONE journal trade (average entry / average exit,
 * total contracts). Expired / exercised / cash-settled closes count as exits; Schwab books
 * expirations as "Journaled Shares" rows (no price) on the next business day.
 * Short trades (Sell to Open / Buy to Close) and stock trades are skipped.
 *
 * The Schwab Trader API sync (apiToFills) feeds the same pairing, so trades match CSV imports.
 */

const ROOT_TO_TICKER = { SPXW: "SPX", NDXP: "NDX", RUTW: "RUT", XSPW: "XSP" };
const pad = (n) => String(n).padStart(2, "0");

// RFC-4180-ish CSV parser (quoted fields, "" escapes, CRLF)
export function parseCsv(text) {
  const rows = [];
  let row = [], cur = "", q = false;
  text = String(text).replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

export function parseOptionSymbol(sym) {
  const m = String(sym || "").trim().match(/^([A-Z.$]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s+([\d.]+)\s+([CP])$/i);
  if (!m) return null;
  const root = m[1].toUpperCase();
  return {
    key: `${root} ${m[4]}-${pad(m[2])}-${pad(m[3])} ${+m[5]} ${m[6].toUpperCase()}`,
    ticker: ROOT_TO_TICKER[root] || root,
    exp: `${m[4]}-${pad(m[2])}-${pad(m[3])}`,
    strike: String(+m[5]),
    cp: m[6].toUpperCase(),
  };
}

// "$1,234.50" / "-$12.00" / "($12.00)" / "" -> number | null
function money(s) {
  s = String(s == null ? "" : s).trim();
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const n = parseFloat(s.replace(/[()$,\s-]/g, ""));
  return isNaN(n) ? null : (neg ? -n : n);
}
// "10/27/2026" or "10/27/2026 as of 10/24/2026" -> "2026-10-27"
function isoDate(s) {
  const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${pad(m[1])}-${pad(m[2])}` : "";
}
const r4 = (n) => Math.round(n * 10000) / 10000;

export function schwabToTrades(csvText) {
  const rows = parseCsv(csvText);
  const hi = rows.findIndex((r) => {
    const h = r.map((c) => c.trim().toLowerCase());
    return h.includes("action") && h.includes("symbol") && h.includes("price");
  });
  if (hi < 0) throw new Error("This doesn't look like a Schwab transactions export (no Action / Symbol / Price columns).");
  const head = rows[hi].map((c) => c.trim().toLowerCase());
  const col = (name) => head.findIndex((h) => h.startsWith(name));
  const C = { date: col("date"), action: col("action"), symbol: col("symbol"), desc: col("description"), qty: col("quantity"), price: col("price"), fees: col("fees"), amount: col("amount") };

  // Schwab lists newest first; replay oldest first, keeping same-day order
  const fills = rows.slice(hi + 1)
    .filter((r) => r.length > 2 && isoDate(r[C.date]))
    .reverse()
    .map((r, i) => ({
      i,
      date: isoDate(r[C.date]),
      action: String(r[C.action] || "").trim().toLowerCase(),
      desc: String(C.desc >= 0 ? r[C.desc] || "" : ""),
      sym: parseOptionSymbol(r[C.symbol]),
      qty: Math.abs(money(r[C.qty]) || 0),
      price: money(r[C.price]),
      fees: Math.abs(money(C.fees >= 0 ? r[C.fees] : "") || 0),
      amount: money(C.amount >= 0 ? r[C.amount] : ""),
    }));
  return pairFills(fills);
}

// OCC option symbol from the Schwab API: "SPXW  261027C07720000"
export function parseOccSymbol(sym) {
  const m = String(sym || "").trim().match(/^([A-Z.$]+)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
  if (!m) return null;
  const root = m[1].toUpperCase(), exp = `20${m[2]}-${m[3]}-${m[4]}`, strike = String(+m[6] / 1000), cp = m[5].toUpperCase();
  return { key: `${root} ${exp} ${strike} ${cp}`, ticker: ROOT_TO_TICKER[root] || root, exp, strike, cp };
}

// Trading day in New York time (the API gives UTC timestamps)
const nyDate = (ts) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));

// Schwab Trader API transactions (GET /trader/v1/accounts/{hash}/transactions) -> fills for pairFills.
// Each transaction has transferItems: the option leg(s) plus fee items (feeType set, cost = fee).
export function apiToFills(transactions) {
  const fills = [];
  const list = (transactions || []).filter((t) => t && t.status !== "CANCELED" && Array.isArray(t.transferItems))
    .sort((a, b) => String(a.time || a.tradeDate).localeCompare(String(b.time || b.tradeDate)) || (a.activityId || 0) - (b.activityId || 0));
  for (const t of list) {
    const items = t.transferItems;
    const fees = items.filter((x) => x.feeType).reduce((s, x) => s + Math.abs(+x.cost || 0), 0);
    const desc = [t.description, ...items.map((x) => x.instrument && x.instrument.description)].filter(Boolean).join(" ");
    let feesLeft = fees;
    for (const x of items) {
      const ins = x.instrument || {};
      if (x.feeType || ins.assetType === "CURRENCY") continue;
      const sym = ins.assetType === "OPTION" ? parseOccSymbol(ins.symbol) : null;
      if (sym) sym.key = (t.accountNumber || "") + " " + sym.key; // pair within one account
      const buy = x.cost ? x.cost < 0 : x.amount > 0;
      const eff = x.positionEffect;
      let action;
      if (t.type === "TRADE") {
        action = eff === "OPENING" ? (buy ? "buy to open" : "sell to open")
          : eff === "CLOSING" ? (buy ? "buy to close" : "sell to close")
          : buy ? "buy" : "sell";
      } else {
        // expiration / exercise / cash settlement: only a removal of a long position matters
        if (buy) continue;
        action = /expir/i.test(desc) ? "expired" : "removed";
      }
      fills.push({
        i: fills.length,
        date: nyDate(t.time || t.tradeDate),
        action, desc, sym,
        qty: Math.abs(+x.amount || 0),
        price: x.price != null && t.type === "TRADE" ? +x.price : null,
        fees: feesLeft,
        amount: t.type === "TRADE" ? null : (+t.netAmount || 0),
      });
      feesLeft = 0; // fees belong to the transaction, count them once
    }
  }
  return fills;
}

// Fills (oldest first) -> trades. Shared by the CSV import and the Schwab API sync.
export function pairFills(fills) {
  const txns = fills.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.i - b.i));
  const stats = { skippedShort: 0, skippedStock: 0, missingOpen: 0, open: 0 };
  const pos = new Map();
  const trades = [];

  for (const t of txns) {
    const isBuySell = /^(buy|sell)/.test(t.action);
    if (!t.sym) { if (isBuySell) stats.skippedStock++; continue; }
    if (t.action === "sell to open" || t.action === "buy to close") { stats.skippedShort++; continue; }

    let p = pos.get(t.sym.key);
    if (t.action === "buy to open" || t.action === "buy") {
      if (!p) { p = { ...t.sym, date: t.date, held: 0, buyQty: 0, buyCost: 0, sellQty: 0, sellSum: 0, fees: 0, how: "" }; pos.set(t.sym.key, p); }
      p.held += t.qty; p.buyQty += t.qty; p.buyCost += t.qty * (t.price || 0); p.fees += t.fees;
      continue;
    }
    // any other action on a contract we hold closes it: sell to close, expired, exercise, assigned, cash settlement
    if (!p || p.held <= 0 || !t.qty) { stats.missingOpen++; continue; }
    const q = Math.min(t.qty, p.held);
    let px = t.price;
    if (px == null) px = t.amount ? Math.abs(t.amount) / (t.qty * 100) : 0;
    // Schwab books expirations as "Journaled Shares ... REMOVAL OF OPTION DUE TO EXPIRATION", no price
    if (t.action !== "sell to close" && t.action !== "sell") p.how = /expir/i.test(t.desc + " " + t.action) ? "expired" : t.action;
    p.held -= q; p.sellQty += q; p.sellSum += q * px; p.fees += t.fees;
    if (p.held <= 0) {
      trades.push({
        date: p.date, ticker: p.ticker, strike: p.strike, cp: p.cp, exp: p.exp,
        entry: r4(p.buyCost / p.buyQty), exit: r4(p.sellSum / p.sellQty), qty: p.buyQty,
        fees: Math.round(p.fees * 100) / 100, how: p.how,
      });
      pos.delete(t.sym.key);
    }
  }
  stats.open = pos.size;
  return { trades, ...stats };
}

// Adds imported trades that aren't already in the journal.
// Re-importing the same file is a no-op; trades you logged by hand with the
// same date / contract / contracts / prices (within 1¢) count as already there.
export function mergeImported(existing, imported) {
  const ids = new Set(existing.map((t) => t.id));
  const used = new Set();
  const seen = {};
  const added = [];
  let duplicates = 0;
  for (const t of imported) {
    const base = `sch-${t.date}-${t.ticker}-${t.strike}${t.cp}-${t.entry}-${t.exit}-${t.qty}`;
    const id = base + "-" + (seen[base] = (seen[base] || 0) + 1);
    if (ids.has(id)) { duplicates++; continue; }
    const manual = existing.find((e) =>
      !String(e.id).startsWith("sch-") && !used.has(e.id) &&
      e.date === t.date && String(e.ticker).toUpperCase() === t.ticker &&
      String(+e.strike) === t.strike && e.cp === t.cp && (+e.qty || 1) === t.qty &&
      Math.abs(+e.entry - t.entry) < 0.011 && Math.abs(+e.exit - t.exit) < 0.011);
    if (manual) { used.add(manual.id); duplicates++; continue; }
    const note = ["Imported from Schwab", t.how ? t.how : "", t.fees ? `fees $${t.fees.toFixed(2)}` : ""].filter(Boolean).join(" · ");
    added.push({
      id, date: t.date, ticker: t.ticker, strike: t.strike, cp: t.cp, exp: t.exp,
      entry: t.entry, exit: t.exit, qty: t.qty, mult: 100, fees: t.fees, pattern: "", grade: "", notes: note,
    });
  }
  return { added, duplicates };
}
