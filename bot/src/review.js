// Daily bot trade review (user 11/18) -> #spx-training (TRAINING_CHANNEL_ID), one THREAD per day so the channel stays clean.
// Every bot paper trade of the day (main account; your own ticket trades are left out) gets a post with the chart picture of the
// trade (its own time window, BUY / SOLD marked) and:
//   winners: what it did well     losers: what went wrong and how it would have traded it better
// The reasons come from the trade's own data: context at entry (trend / 10m + daily phase / VIX / flow), the option's path
// (best gain, how fast it failed), the exit rule, the spread, the time of day, the family's record and the exit audit
// (what the option did in the 60 minutes after the bot sold).
// Runs once after the close (~4:40 PM ET from the minute cron); admin GET /review?date=YYYY-MM-DD[&force=1] runs it now.
import { chartShots } from "./shot.js";
import { FAM_NAMES } from "./learn.js";

const r2 = (x) => Math.round(x * 100) / 100;
const pc = (x) => (x >= 0 ? "+" : "") + Math.round(x * 100) + "%";
const usd = (x) => (x < 0 ? "−$" : "$") + Math.abs(x).toFixed(2);
const API = "https://discord.com/api/v10";

async function send(env, channel, body, file) {
  const headers = { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (spx-bot, 1.0)" };
  let r;
  if (file) {
    const fd = new FormData();
    const embeds = (body.embeds || []).map((e, i) => (i === 0 ? { ...e, image: { url: "attachment://" + file.name } } : e));
    fd.append("payload_json", JSON.stringify({ ...body, embeds, attachments: [{ id: 0, filename: file.name }] }));
    fd.append("files[0]", new Blob([file.data], { type: "image/png" }), file.name);
    r = await fetch(`${API}/channels/${channel}/messages`, { method: "POST", headers, body: fd });
    if (r.ok) return r;
    console.error("review picture refused", r.status, await r.text().catch(() => ""));
  }
  return fetch(`${API}/channels/${channel}/messages`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

// SPX close at (or just before) a time, from the day's 1m bars [t,o,h,l,c]
const spxAt = (bars, ms) => { let v = null; for (const b of bars || []) { if (b[0] * 1000 <= ms) v = b[4]; else break; } return v; };

export function analyze(x, audit, model) {
  const win = x.pnl > 0, E = x.entry, best = (x.bestBid || E) / E - 1, exitPct = (x.avgExit || E) / E - 1;
  const heldMin = Math.max(0, Math.round(((x.closedAt || x.at) - x.at) / 60000)), c = x.ctx || {};
  const fam = FAM_NAMES[x.fam] || x.fam, F = model && model.fams && model.fams[x.fam];
  const withCtx = [c.trend === "with" && "trend", c.phase === "with" && "10m phase", c.phaseD === "with" && "daily phase", c.vix === true && "VIX", c.mag7 === "with" && "Mag 7"].filter(Boolean);
  const against = [c.trend === "against" && "trend", c.phase === "against" && "10m phase", c.phaseD === "against" && "daily phase", c.vix === false && "VIX"].filter(Boolean);
  const after = audit && audit.after && audit.after.length ? audit : null;
  const at = (m) => { if (!after) return null; let v = null; for (const [k, p] of after.after) { if (k <= m) v = p; else break; } return v; };
  const h30 = at(30), aBest = after ? after.best : null;
  const mins = (x.et || "0:0").split(":").map(Number), tmin = mins[0] * 60 + mins[1];
  const good = [], better = [];
  if (win) {
    if (withCtx.length) good.push(`Entered with the ${withCtx.join(", ")} on its side.`);
    if (c.flow && /call|put|with/.test(String(c.flow))) good.push(`0DTE flow agreed (${c.flow}).`);
    good.push(`Banked ${pc(exitPct)} of a ${pc(best)} peak (${best > 0 ? Math.round((exitPct / best) * 100) : 100}% of the move) in ${heldMin} min.`);
    if ((x.exits || []).length > 1) good.push(`Scaled out: ${x.exits.map((e) => `${e.qty} @ ${usd(e.px)}`).join(", ")}.`);
    if (h30 != null && h30 < exitPct - 0.05) good.push(`Good exit: 30 min later the option was at ${pc(h30)}.`);
    if (tmin < 690) good.push("Morning trade, when this playbook works best.");
    if (h30 != null && h30 > exitPct + 0.2) better.push(`Left money on the table: 30 min after the exit it was ${pc(h30)} (best ${pc(aBest)}). The ${x.exitWhy} exit came early; structure mode holds while SPX keeps its 3m higher lows.`);
    if (best >= 0.6 && exitPct < best * 0.6) better.push(`It gave back a lot: peak ${pc(best)}, sold ${pc(exitPct)}. Bank more at the first target when it runs that fast.`);
    else if (best >= 0.12 && exitPct < best * 0.4) better.push(`It gave back most of the move: peak ${pc(best)}, sold ${pc(exitPct)} (the no-red stop only saved the fees). Bank 1 contract at +12-15% on fast scalps, or trail tighter once green.`);
  } else {
    if (against.length) better.push(`It fired AGAINST the ${against.join(", ")}. Skip these, or take 1 contract only.`);
    if (best < 0.03) better.push(`It never worked (best ${pc(best)}): the entry was the problem, not the exit. Wait for the 1m close through the level or a retest before buying.`);
    else if (best >= 0.15) better.push(`It was up ${pc(best)} first and still lost. Bank part at +15-20% or move the stop to entry sooner on this setup.`);
    if (heldMin <= 3 && /premium/.test(x.exitWhy || "")) better.push(`Stopped out in ${heldMin} min: the entry chased${x.spreadPct > 0.06 ? ` and the spread was wide (${Math.round(x.spreadPct * 100)}%)` : ""}. Use a limit near the mid, or wait for a pullback.`);
    else if (x.spreadPct > 0.08) better.push(`Wide spread (${Math.round(x.spreadPct * 100)}%): the bid started deep in the red. Limit near the mid, or a closer strike.`);
    if (h30 != null && h30 > exitPct + 0.15) better.push(`The exit was too early: 30 min later the option was ${pc(h30)} (best ${pc(aBest)}). That was a pullback inside the move; holding with the structure stop would have turned it around.`);
    else if (h30 != null && h30 < exitPct - 0.05) good.push(`The stop did its job: 30 min later the option was ${pc(h30)}, so holding would have lost more.`);
    if (tmin >= 840) better.push("Taken after 2 PM: 0DTE decay is fastest late in the day, so the odds are lower.");
    if (c.chop) better.push("Choppy conditions at entry (CHOP guard): breakouts fail more often.");
    if (withCtx.length && !against.length) good.push(`The context was right (${withCtx.join(", ")}); the setup just didn't follow through.`);
  }
  if (F && F.n >= 5) (F.r >= 0.1 ? good : F.r < 0 ? better : good).push(`${fam} record so far: ${F.r >= 0 ? "+" : ""}${F.r}R, ${Math.round(F.win * 100)}% winners over ${F.n} scored.`);
  if (!good.length) good.push(win ? "Followed the plan and got paid." : "Small, controlled loss: the risk rules worked.");
  if (!better.length) better.push(win ? "Nothing major: clean trade." : "Hard to improve from the data; keep logging these.");
  return { win, good, better, heldMin, best, exitPct, h30 };
}

export async function runReview(env, deps, { date, force = false, dry = false } = {}) {
  const { readJSON, writeJSON } = deps;
  if (dry) {   // preview: the review text only, nothing posted
    const tr = (((await readJSON(env, "paper:trades")) || {}).items || []).filter((x) => x.date === date && !x.manual).sort((a, b) => a.at - b.at);
    const au = (((await readJSON(env, "paper:auditlog")) || {}).items || []).filter((a) => a.book === "acct"), md = (await readJSON(env, "paper:model")) || {};
    return tr.map((x) => ({ trade: `${x.et}-${x.closedET} ${x.qty}x ${x.label} ${usd(x.pnl)} (${x.exitWhy})`, signal: x.signal, ...analyze(x, au.find((a) => a.id === x.id), md) }));
  }
  if (!env.TRAINING_CHANNEL_ID || !env.DISCORD_BOT_TOKEN) return { skipped: "no training channel / bot token" };
  const key = "review:" + date, S = (await readJSON(env, key)) || {};
  if (!force && (S.state === "done" || (S.state === "running" && Date.now() - S.at < 15 * 60000))) return { skipped: S.state };
  await writeJSON(env, key, { state: "running", at: Date.now() });
  const trades = (((await readJSON(env, "paper:trades")) || {}).items || []).filter((x) => x.date === date && !x.manual).sort((a, b) => a.at - b.at);
  if (!trades.length) { await writeJSON(env, key, { state: "done", at: Date.now(), n: 0 }); return { skipped: "no bot trades on " + date }; }
  const audit = (((await readJSON(env, "paper:auditlog")) || {}).items || []).filter((a) => a.book === "acct");
  const model = (await readJSON(env, "paper:model")) || {}, sig = (await readJSON(env, "sig:day:" + date)) || {}, bars = sig.spx1m || [];
  const wins = trades.filter((x) => x.pnl > 0), pnl = trades.reduce((s, x) => s + x.pnl, 0);

  // parent message + the day's thread
  const head = await send(env, env.TRAINING_CHANNEL_ID, { embeds: [{
    title: `📚 Bot trade review · ${date}`,
    description: `${trades.length} bot trade${trades.length > 1 ? "s" : ""} · ${wins.length} won · ${trades.length - wins.length} lost · ${usd(pnl)}\nEach trade with its chart in the thread below. Winners: what it did well. Losers: how it would have traded it better.`,
    color: pnl >= 0 ? 0x2ec26b : 0xf0556b }] });
  if (!head.ok) { const e = await head.text().catch(() => ""); await writeJSON(env, key, { state: "error", at: Date.now(), err: e.slice(0, 300) }); return { error: "parent post " + head.status + " " + e.slice(0, 200) }; }
  const parent = await head.json();
  let target = env.TRAINING_CHANNEL_ID, thread = null;
  const th = await fetch(`${API}/channels/${env.TRAINING_CHANNEL_ID}/messages/${parent.id}/threads`, {
    method: "POST", headers: { Authorization: "Bot " + env.DISCORD_BOT_TOKEN, "User-Agent": "DiscordBot (spx-bot, 1.0)", "Content-Type": "application/json" },
    body: JSON.stringify({ name: `Bot trade review ${date}`, auto_archive_duration: 1440 }) });
  if (th.ok) { thread = await th.json(); target = thread.id; } else console.error("thread", th.status, await th.text().catch(() => ""));

  // pictures: one browser for all of them; each = the trade's own window with BUY / SOLD marked
  const shots = await chartShots(env, deps, trades.map((x) => {
    const end = x.closedAt || x.at, span = Math.max(end - x.at, 10 * 60000);
    return { mode: "review", dir: x.dir, e: x.uEntry != null ? r2(x.uEntry) : "", x: spxAt(bars, end) ?? "",
      et: Math.round(x.at / 1000), xt: Math.round(end / 1000), from: Math.round((x.at - Math.max(20 * 60000, span * 0.6)) / 1000), to: Math.round((end + Math.max(15 * 60000, span * 0.4)) / 1000),
      bl: `BUY ${x.label} @ ${usd(x.entry)}`, xl: `SOLD @ ${usd(x.avgExit)} ${pc((x.avgExit || x.entry) / x.entry - 1)}`,
      label: `${x.pnl > 0 ? "WIN" : "LOSS"} ${usd(x.pnl)} · ${x.label}` };
  })).catch(() => trades.map(() => null));

  let posted = 0, pics = 0;
  for (let i = 0; i < trades.length; i++) {
    const x = trades[i], A = analyze(x, audit.find((a) => a.id === x.id), model);
    const embed = {
      title: `${A.win ? "✅ WIN" : "❌ LOSS"} ${usd(x.pnl)} · ${x.qty} × ${x.label} · ${x.et}-${x.closedET} ET`,
      description: [
        `**Signal:** ${String(x.signal || FAM_NAMES[x.fam] || x.fam).slice(0, 180)}`,
        `**Trade:** bought @ ${usd(x.entry)} · sold @ ${usd(x.avgExit)} (${x.exitWhy}) · best ${pc(A.best)} · held ${A.heldMin} min${x.R != null ? ` · ${x.R}R` : ""}`,
        `\n**${A.win ? "What it did well" : "What it did right"}:**\n` + A.good.map((s) => "• " + s).join("\n"),
        `\n**${A.win ? "Could be better" : "How it would have traded it better"}:**\n` + A.better.map((s) => "• " + s).join("\n"),
      ].join("\n").slice(0, 4000),
      color: A.win ? 0x2ec26b : 0xf0556b, footer: { text: `bot trade review · ${date} · paper trade` },
    };
    const r = await send(env, target, { embeds: [embed] }, shots[i]);
    if (r.ok) { posted++; if (shots[i]) pics++; }
  }
  await writeJSON(env, key, { state: "done", at: Date.now(), n: trades.length, posted, pics, thread: thread && thread.id });
  return { trades: trades.length, posted, pictures: pics, thread: thread ? thread.id : null, threadError: thread ? null : th.status };
}
