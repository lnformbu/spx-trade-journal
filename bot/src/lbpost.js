// Leaderboard change posts for the copy channel (user 11/18): whenever the SPX 0DTE leaderboard changes, post what changed with the
// chart + greek exposure + leaderboard picture. Runs from the greek job (every minute).
//   change = a new #1, a contract entering the top 5, or the holders of a top-3 contract flipping in/out of profit (vs its VWAP).
//   Compared with the LAST POSTED board, so a change held back by the limits still goes out next time.
//   Limits: 9:40-3:55 ET, at most one post every 10 minutes and 20 a day (also keeps the pictures inside the free browser allowance).
import { chartShot } from "./shot.js";
import { postCopy } from "./signals.js";

const big = (v) => (Math.abs(v) >= 1e9 ? (v / 1e9).toFixed(1) + "B" : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(0) + "M" : Math.round(v / 1e3) + "k");
const name = (l) => { const m = String(l).match(/^(\d+(?:\.\d+)?)([CP])$/); return m ? `${m[2] === "C" ? "CALL" : "PUT"} ${m[1]}` : l; };

export async function lbChange(env, deps, g, t, now, { force = false } = {}) {
  const top = ((g && g.lb && g.lb.top) || []).slice(0, 5);
  if (!top.length) return { skipped: "no leaderboard yet" };
  const key = "lbpost:" + t.date, S = (await deps.readJSON(env, key)) || { n: 0, at: 0, last: null };
  const cur = top.map((c) => ({ l: c.label, up: c.pnlPct >= 0 })), prev = S.last;
  const changes = [], hl = new Set();
  if (prev) {
    if (!prev[0] || prev[0].l !== cur[0].l) { changes.push(`**New #1:** ${name(cur[0].l)}${prev[0] ? ` (was ${name(prev[0].l)})` : ""}`); hl.add(cur[0].l); }
    const was = new Set(prev.map((x) => x.l));
    cur.forEach((x, i) => { if (!was.has(x.l)) { changes.push(`**${name(x.l)}** entered the top 5 (#${i + 1})`); hl.add(x.l); } });
    cur.slice(0, 3).forEach((x) => { const p = prev.find((y) => y.l === x.l); if (p && p.up !== x.up) { changes.push(`**${name(x.l)}** holders now ${x.up ? "IN PROFIT (above VWAP)" : "UNDER WATER (below VWAP)"}`); hl.add(x.l); } });
  }
  if (!force) {
    if (!prev) { S.last = cur; await deps.writeJSON(env, key, S); return { skipped: "first board of the day (baseline)" }; }
    if (!changes.length) return { skipped: "no change" };
    if (t.min < 580 || t.min > 955) return { skipped: "outside 9:40-3:55" };
    if (now - S.at < 10 * 60000) return { skipped: "posted less than 10 min ago" };
    if (S.n >= 20) return { skipped: "20 posts today" };
  }
  if (!changes.length) changes.push(force ? "Test post: the current leaderboard and greek exposure" : "Leaderboard update");
  const lines = top.map((c, i) => `${i + 1}. ${c.type === "C" ? "🟢" : "🔴"} **${name(c.label)}** · vol ${big(c.vol)} · last $${c.last} vs VWAP $${c.vwap} (${c.pnlPct >= 0 ? "+" : ""}${c.pnlPct}%)${c.shakeout ? ` · ⚠ ${c.shakeout}` : ""}`);
  const T = g.totals || {};
  const gex = [`Net GEX ${T.gex != null ? (T.gex >= 0 ? "+" : "−") + big(Math.abs(T.gex)) : "—"}`, g.callWall ? `call wall ${g.callWall}` : null, g.putWall ? `put wall ${g.putWall}` : null,
    g.flip ? `gamma flip ${g.flip}` : null, g.eye ? `👁 eye ${g.eye.strike}` : null, g.lb.maxPainZone ? `max pain ${g.lb.maxPainZone.low}-${g.lb.maxPainZone.high}` : null].filter(Boolean).join(" · ");
  const embed = {
    title: `🏁 SPX LEADERBOARD ${force ? "(TEST)" : "CHANGE"} · ${g.et || ""} ET · SPX ${g.spot != null ? (+g.spot).toFixed(2) : "—"}`,
    description: (changes.join("\n") + "\n\n**Top 5 (SPX 0DTE by volume):**\n" + lines.join("\n") + "\n\n**Greek exposure:** " + gex).slice(0, 4000),
    color: 0xf59e0b, footer: { text: `${g.et || ""} ET · SPX bot · leaderboard watch` },
  };
  const pic = await chartShot(env, deps, { mode: "lb", hl: [...hl].join(",") || top[0].label, label: force ? "LEADERBOARD (TEST)" : "LEADERBOARD CHANGE" }).catch((e) => { console.error("lb picture", e); return null; });
  const r = await postCopy(env, embed, pic);
  S.last = cur; S.at = now; S.n++;
  await deps.writeJSON(env, key, S);
  return { posted: !!(r && r.ok), status: r && r.status, picture: !!pic, changes };
}
