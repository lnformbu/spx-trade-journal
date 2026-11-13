// Reads the morning plan post and reviews it after the close. Pure functions.
//
// Fixed lines (exact match):   Upside: SPX 7620c | SPY 760c   Downside: SPX 7520p | SPY 750p   VIX key level: 19
// "If ..." sentences become scenarios: direction + condition level + ordered targets, using the words you
// already write (PDC, pre-market high, overnight supply, midrange, -1 ATR, call/put trigger, 10m 21 ...).

import { et, hhmm, OPEN, CLOSE } from "./levels.js";

const NUM = "(\\d+(?:\\.\\d+)?)";

// phrase -> level name; checked in this order, earlier matches win where phrases overlap
const REFS = [
  [/yesterday[’']?s?\s+(?:HOD|high)|\bPDH\b|prior[- ]day high/gi, "pdh"],
  [/yesterday[’']?s?\s+(?:LOD|low)|\bPDL\b|prior[- ]day low/gi, "pdl"],
  [/\bPDC\b|prior[- ]day close|previous (?:day[’']?s? )?close|yesterday[’']?s? close/gi, "pdc"],
  [/pre-?market\s+(?:highs?|resistance|supply)/gi, "pmh"],
  [/pre-?market\s+(?:lows?|support|demand)/gi, "pml"],
  [/overnight\s+(?:highs?|resistance|supply)/gi, "onh"],
  [/overnight\s+(?:lows?|support|demand)/gi, "onl"],
  [/opening range high|\bORB ?high\b/gi, "orbh"],
  [/opening range low|\bORB ?low\b/gi, "orbl"],
  [/mid-?range/gi, "mid"],
  [/-\s?1\s?ATR|minus 1 ATR/gi, "-1"],
  [/\+\s?1\s?ATR|full ATR/gi, "+1"],
  [/\b1\s?ATR\b/gi, "1atr"],
  [/(?:call|long) trigger/gi, "+0.236"],
  [/(?:put|short) trigger/gi, "-0.236"],
  [/\bVWAP\b/gi, "vwap"],
  [/hourly 200|1h 200/gi, "ema1h200"],
  [/10m (?:EMA )?200|10 ?min(?:ute)? (?:EMA )?200/gi, "ema10m200"],
  [/10m (?:21|ribbon|trend|cloud)|10 ?min(?:ute)? (?:21|ribbon|trend|cloud)/gi, "ema10m21"],
  [/\b(?:and|&) (?:the )?200\b/gi, "ema10m200"],
  [/\bHOD\b|high of (?:the )?day/gi, "hod"],
  [/\bLOD\b|low of (?:the )?day/gi, "lod"],
];
export const LEVEL_NAMES = {
  pdh: "yesterday's high", pdl: "yesterday's low", pdc: "PDC", pmh: "premarket high", pml: "premarket low",
  onh: "overnight high", onl: "overnight low", orbh: "ORB high", orbl: "ORB low", vwap: "VWAP", hod: "today's high", lod: "today's low",
  ema1h200: "1h EMA 200", ema10m21: "10m EMA 21", ema10m200: "10m EMA 200",
  "+0.236": "call trigger (ATR)", "-0.236": "put trigger (ATR)", "+0.618": "upper midrange", "-0.618": "lower midrange",
  "+1": "+1 ATR", "-1": "-1 ATR",
};

const BEAR = /remains? resistance|find(?:s|ing)? resistance|break(?:s|ing)?\s+(?:\w+\s+)?lows?|break(?:s|ing)? below|\blos(?:e|es|ing)\b|\bunder\b|\bbelow\b|weakness|continuation down|\bdown toward|\breject/gi;
const BULL = /recover|reclaim|break(?:s|ing)? above|holds? above|\bover\b|\babove\b|continuation up|\bhigher\b|squeeze/gi;
const count = (re, s) => (s.match(re) || []).length;

// Finds level words and prices in order of appearance.
// Prices in the plan's own ticker are {px}; SPX numbers inside an SPY plan are {spx} (converted later).
function tokens(text, ref, ticker = "SPY") {
  const found = [];
  const taken = [];
  const free = (a, b) => !taken.some(([x, y]) => a < y && b > x);
  const add = (i, len, t) => { if (free(i, i + len)) { taken.push([i, i + len]); found.push({ i, ...t }); } };
  for (const [re, key] of REFS) for (const m of text.matchAll(re)) add(m.index, m[0].length, { ref: key, text: m[0] });
  for (const m of text.matchAll(new RegExp(ticker + "\\s*\\$?" + NUM, "gi"))) add(m.index, m[0].length, { px: +m[1], text: m[0] });
  if (ticker === "SPY") {
    for (const m of text.matchAll(new RegExp("(?:SPX\\s*)?\\b([5-9]\\d{3}(?:\\.\\d+)?)\\b", "gi"))) add(m.index, m[0].length, { spx: +m[1], text: m[0] });
  }
  if (ref) {
    // bare numbers close to the current price, e.g. "toward 750"
    for (const m of text.matchAll(/\b(\d{2,4}(?:\.\d{1,2})?)\b/g)) {
      const v = +m[1];
      if (v !== 200 && Math.abs(v - ref) / ref < 0.08) add(m.index, m[0].length, { px: v, text: m[0] });
    }
  }
  return found.sort((a, b) => a.i - b.i);
}

// A ticker heading on its own line: "SPX | SPY", "TSLA", "**MU**"
const HEADER = /^\s*\**\s*\$?[A-Z]{1,5}(?:\s*[|/&,]\s*\$?[A-Z]{1,5})*\s*\**\s*:?\s*$/;
const NOT_TICKERS = /^(VIX|ATR|PDC|PDH|PDL|HOD|LOD|ORB|VWAP|IF|ETH|RTH|EOD|CPI|PCE|GDP|FOMC)$/;

// A post can hold plans for several tickers; each block starts with a heading or an "Upside:" line.
// Returns { SPY: plan, $SPX: plan, TSLA: plan, ... }. An "SPX | SPY" block is one plan in SPY prices (plus SPX strikes).
// refs = current price per symbol, to recognise bare numbers.
export function parsePlans(raw, refs = {}) {
  const text = String(raw || "").replace(/\r/g, "");
  const vixAll = (text.match(/VIX key level[^\n]*/i) || [""])[0];
  const blocks = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (HEADER.test(line) && !NOT_TICKERS.test(line.replace(/[^A-Z]/g, ""))) {
      cur = { tickers: line.replace(/[*:$]/g, "").split(/[|/&,]/).map((x) => x.trim().toUpperCase()).filter(Boolean), lines: [] };
      blocks.push(cur);
      continue;
    }
    if (/^[\s•*\-–]*Upside:/i.test(line) && cur && cur.lines.some((l) => /Upside:/i.test(l))) { cur = { tickers: null, lines: [] }; blocks.push(cur); }
    if (!cur) { cur = { tickers: null, lines: [] }; blocks.push(cur); }
    cur.lines.push(line);
  }
  const out = {};
  for (const b of blocks) {
    let body = b.lines.join("\n");
    if (!/Upside:|Downside:/i.test(body)) continue;
    const tickers = b.tickers || [...((body.match(/Upside:[^\n]*/i) || [""])[0]).matchAll(/\b([A-Z]{2,5})\s*\$?\d/g)].map((m) => m[1]);
    const main = tickers.includes("SPY") ? "SPY" : tickers.find((x) => !NOT_TICKERS.test(x));
    if (!main) continue;
    const sym = main === "SPX" ? "$SPX" : main;
    if (!/VIX key level/i.test(body) && vixAll) body += "\n" + vixAll;
    const p = parsePlan(body, refs[sym], main);
    p.tickers = tickers;
    p.symbol = sym;
    out[sym] = p;
  }
  return out;
}

export function parsePlan(raw, ref, ticker = "SPY") {
  const text = String(raw || "").replace(/\r/g, "");
  const grab = (re) => { const m = text.match(re); return m ? +m[1] : null; };
  const vixLine = (text.match(/VIX key level[^\n]*/i) || [""])[0];
  const vixNums = [...vixLine.matchAll(/\b(\d{1,2}(?:\.\d+)?)\b/g)].map((m) => +m[1]);
  const plan = {
    ticker,
    callTrigger: grab(new RegExp("Upside:[^\\n]*?" + ticker + "\\s*\\$?" + NUM + "\\s*c", "i")),
    putTrigger: grab(new RegExp("Downside:[^\\n]*?" + ticker + "\\s*\\$?" + NUM + "\\s*p", "i")),
    spxCall: grab(new RegExp("Upside:[^\\n]*?SPX\\s*" + NUM + "\\s*c", "i")),
    spxPut: grab(new RegExp("Downside:[^\\n]*?SPX\\s*" + NUM + "\\s*p", "i")),
    vixKey: vixNums.length ? vixNums[0] : null,
    vixAlso: vixNums.slice(1),
    patience: /patience|\bno trade\b|sit on (?:my |our )?hands|stay (?:out|flat)|\bchop(?:py)?\b/i.test(text),
    notes: [], scenarios: [],
  };
  ref = ref || (plan.callTrigger && plan.putTrigger ? (plan.callTrigger + plan.putTrigger) / 2 : null);
  for (const line of text.split("\n").map((l) => l.replace(/^[\s•*\-–]+/, "").trim()).filter(Boolean)) {
    if (/^(?:@everyone\.?|Upside:|Downside:|VIX key level)/i.test(line) || HEADER.test(line)) continue;
    // a line can hold several "If ..." sentences
    const parts = line.split(/(?=\bIf\b)/).map((s) => s.trim()).filter(Boolean);
    for (const s of parts) {
      if (!/^if\b/i.test(s)) { plan.notes.push(s); continue; }
      const cut = s.search(/,\s*(?:then\s+)?(?:(?:we |i )?(?:can )?look|looking|i[’']?m looking|expect|target|we can|we have|next)|\s(?:look|looking) for\b|\s+on the way to\b/i);
      const cond = cut > 0 ? s.slice(0, cut) : s;
      const then = cut > 0 ? s.slice(cut) : "";
      // "holds" (trend / support holds) is bullish unless it's resistance holding
      const holds = /\bholds?\b/i.test(cond) && !/resistance/i.test(cond) ? 1 : 0;
      const bull = count(BULL, cond) + holds + count(/continuation up|\bhigher\b|\bup\b/gi, then);
      const bear = count(BEAR, cond) + count(/continuation down|\bdown\b|\blower\b|weakness|\bbelow\b/gi, then);
      const dir = bull > bear ? "bull" : bear > bull ? "bear" : null;
      const ct = tokens(cond, ref, ticker), tt = tokens(then, ref, ticker);
      plan.scenarios.push({ text: s, dir, condition: ct.map(strip), targets: tt.map(strip) });
    }
  }
  return plan;
}
const strip = ({ i, ...t }) => t;

// Puts prices on every condition/target using today's levels. ratio = SPX/SPY.
export function resolvePlan(plan, lv, ratio) {
  const price = (t, dir) => {
    if (t.px) return t.px;
    if (t.spx) return ratio ? Math.round((t.spx / ratio) * 100) / 100 : null;
    let key = t.ref;
    if (key === "mid") key = dir === "bear" ? "-0.618" : "+0.618";
    if (key === "1atr") key = dir === "bear" ? "-1" : "+1";
    if (key in (lv.atrLevels || {})) return lv.atrLevels[key];
    return lv[key] ?? null;
  };
  const label = (t, dir) => t.px ? (plan.ticker || "SPY") + " " + t.px : t.spx ? "SPX " + t.spx
    : LEVEL_NAMES[t.ref === "mid" ? (dir === "bear" ? "-0.618" : "+0.618") : t.ref === "1atr" ? (dir === "bear" ? "-1" : "+1") : t.ref] || t.text;
  for (const s of plan.scenarios) {
    for (const list of [s.condition, s.targets]) for (const t of list) { t.price = price(t, s.dir); t.label = label(t, s.dir); }
    s.level = (s.condition.find((t) => t.price != null) || {}).price
      ?? (s.dir === "bull" ? plan.callTrigger : s.dir === "bear" ? plan.putTrigger : null);
  }
  return plan;
}

// After the close: what happened to each part of the plan. rth = today's 1-minute candles 9:30-16:00.
export function reviewPlan(plan, rth, lv, vix) {
  if (!rth.length) return null;
  const close = rth[rth.length - 1].close;
  const time = (c) => hhmm(et(c.datetime).min);
  const out = { close, checks: [], scenarios: [] };
  const say = (ok, text) => out.checks.push({ ok, text });

  const trigger = (level, dir, name) => {
    if (level == null) return null;
    const hitAt = rth.findIndex((c) => (dir === "bull" ? c.high >= level : c.low <= level));
    if (hitAt < 0) { say(null, `${name} ${level} never traded.`); return { hit: false }; }
    const after = rth.slice(hitAt);
    const best = dir === "bull" ? Math.max(...after.map((c) => c.high)) : Math.min(...after.map((c) => c.low));
    const held = dir === "bull" ? close > level : close < level;
    const move = Math.round(Math.abs(best - level) * 100) / 100;
    const res = { hit: true, at: time(rth[hitAt]), held, best, move };
    if (held) say(true, `${name} ${level} broke at ${res.at} and held: ran $${move} past it, closed ${close}.`);
    else say(false, `${name} ${level} broke at ${res.at} but failed: best $${move} past it, closed back at ${close}.`);
    return res;
  };
  out.call = trigger(plan.callTrigger, "bull", "Call trigger");
  out.put = trigger(plan.putTrigger, "bear", "Put trigger");
  if (out.call && out.put && out.call.hit && out.put.hit) {
    say(null, `Both triggers traded (call ${out.call.at}, put ${out.put.at}): a two-sided day, ${out.call.at < out.put.at ? "calls" : "puts"} first.`);
  }

  // which side of the plan the day ended on
  const side = plan.callTrigger != null && close > plan.callTrigger ? "bull" : plan.putTrigger != null && close < plan.putTrigger ? "bear" : "range";
  out.side = side;
  if (vix && plan.vixKey != null && vix.last != null) {
    const vixSays = vix.last < plan.vixKey ? "bull" : "bear";
    if (side === "range") say(null, `VIX closed ${vix.last} vs your key ${plan.vixKey}; SPY ended between your triggers.`);
    else say(vixSays === side, `VIX key ${plan.vixKey}: VIX closed ${vix.last} (${vixSays === "bull" ? "below" : "above"}), SPY closed ${side === "bull" ? "above your call trigger" : "below your put trigger"}: ${vixSays === side ? "they agreed" : "the VIX read was wrong today"}.`);
  }
  if (plan.patience) {
    const range = Math.max(...rth.map((c) => c.high)) - Math.min(...rth.map((c) => c.low));
    const big = lv.atr && range > lv.atr * 0.8;
    say(!big, `You called for patience. Day range $${Math.round(range * 100) / 100}${lv.atr ? ` (${Math.round((range / lv.atr) * 100)}% of ATR)` : ""}: ${big ? "it turned into a big move day" : "patience was right"}.`);
  }

  for (const s of plan.scenarios) {
    const r = { text: s.text, dir: s.dir, level: s.level, active: null, reached: [], missed: [] };
    if (s.dir && s.level != null) {
      const i = rth.findIndex((c) => (s.dir === "bull" ? c.close > s.level : c.close < s.level));
      if (i >= 0) {
        r.active = time(rth[i]);
        const after = rth.slice(i);
        for (const t of s.targets) {
          if (t.price == null) { r.missed.push({ label: t.label, why: "no price" }); continue; }
          const j = after.findIndex((c) => (s.dir === "bull" ? c.high >= t.price : c.low <= t.price));
          if (j >= 0) r.reached.push({ label: t.label, price: t.price, at: time(after[j]) });
          else r.missed.push({ label: t.label, price: t.price });
        }
      }
    }
    const short = s.text.length > 70 ? s.text.slice(0, 67) + "…" : s.text;
    if (!s.dir || s.level == null) say(null, `Couldn't check "${short}" (no clear direction or level).`);
    else if (!r.active) say(null, `"${short}": never set up (no 1-min close ${s.dir === "bull" ? "above" : "below"} ${s.level}).`);
    else if (r.reached.length) say(true, `"${short}": set up ${r.active}, reached ${r.reached.map((t) => `${t.label} (${t.at})`).join(", ")}${r.missed.length ? `; missed ${r.missed.map((t) => t.label).join(", ")}` : ""}.`);
    else if (s.targets.length) say(false, `"${short}": set up ${r.active} but reached none of its targets (${s.targets.map((t) => t.label).join(", ")}).`);
    out.scenarios.push(r);
  }
  return out;
}
