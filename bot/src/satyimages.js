// Reads Saty's chart pictures (notes channel) in the background and builds a library of what he draws and says: setups, entries,
// exits, levels. FREE-TIER SAFE (user: free services only):
//   - Cloudflare's free vision allowance is small (10,000 "neurons" a day, shared with the bot's plan reading), so this reads at most
//     DAILY_MAX pictures a day, a few per minute-run (also keeps each run under the free 50-subrequest limit), after the close only.
//   - The first AI error that mentions a limit / quota / neurons stops the day immediately.
//   - It never changes trading by itself: it only fills "saty:insights" (read it at /saty/insights).
// The queue ("saty:queue") is loaded once from the exported chat (POST /saty/queue); Discord picture links expire within ~1 day, so the pictures are copied (downsized) into the database first (POST /saty/img).
import { readChart, readChartData } from "./vision.js";

export const DAILY_MAX = 40;     // pictures per night (~3,000 of the 10,000 free neurons; the rest stays for the bot's other AI use)
const PER_RUN = 4;               // pictures per one-minute run
const KEEP = 4000;               // insight records kept

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9+\- ]+/g, " ").replace(/\s+/g, " ").trim();

export async function runSatyImages(env, deps, { t, now = Date.now() }) {
  const { readJSON, writeJSON } = deps;
  if (!env.AI) return { skipped: "no AI binding" };
  const q = await readJSON(env, "saty:queue");
  if (!q || !q.items || !q.items.length) return { skipped: "queue empty" };
  const ins = (await readJSON(env, "saty:insights")) || { items: [], agg: {}, days: {} };
  const day = (ins.days[t.date] = ins.days[t.date] || { used: 0, stopped: null });
  if (day.stopped) return { skipped: "stopped today: " + day.stopped };
  if (day.used >= DAILY_MAX) return { skipped: "daily budget used" };
  let n = 0, done = [];
  while (n < PER_RUN && day.used < DAILY_MAX && q.next < q.items.length) {
    const it = q.items[q.next++];
    n++;
    try {
      let v;
      if (it.k) { const b = await deps.readBlob(env, "saty:img:" + it.k); if (!b) throw new Error("stored picture missing"); v = await readChartData(env, "data:image/jpeg;base64," + b); }
      else v = await readChart(env, it.u);
      day.used++;
      const d = v.data || {};
      const rec = { d: it.d, c: String(it.c || "").slice(0, 120), setup: d.setup || null, dir: d.direction || null, tf: d.timeframe || null,
        ann: String(d.annotations || "").slice(0, 300), sum: String(d.summary || v.raw || "").slice(0, 300), ind: (d.indicators || []).slice(0, 6) };
      ins.items.push(rec);
      const key = norm(rec.setup);
      if (key) ins.agg[key] = (ins.agg[key] || 0) + 1;
      done.push(rec.setup || "chart");
    } catch (e) {
      const m = String(e.message || e);
      if (/limit|quota|neuron|capacity|exceed|too many|429|4006|3036/i.test(m)) { day.stopped = m.slice(0, 160); break; }
      // a dead link / oversized picture: skip it and move on (counted so a bad batch can't loop forever)
      day.used++;
    }
  }
  ins.items = ins.items.slice(-KEEP);
  ins.updated = now;
  await writeJSON(env, "saty:queue", q);
  await writeJSON(env, "saty:insights", ins);
  return { read: done.length, used: day.used, next: q.next, of: q.items.length, stopped: day.stopped };
}

// compact summary for the journal / reports
export function satyDigest(ins) {
  if (!ins) return null;
  const top = Object.entries(ins.agg || {}).sort((a, b) => b[1] - a[1]).slice(0, 15);
  return { pictures: (ins.items || []).length, setups: top, updated: ins.updated || null, days: ins.days };
}
