// Chart pictures for Discord (user 11/18): Cloudflare's headless browser opens the journal's own chart (?shot=1) and returns PNGs.
//   - default: 1-minute chart, last hour, sharp (2x pixels), with the trade's entry / stop / target drawn
//   - mode "lb": chart + SPX greek exposure + leaderboard side by side (LB shakeout / leaderboard / market-shift posts)
//   - mode "review": the trade's own time window (from / to), buy and sell marked (daily trade review)
//   - Free plan: Browser Rendering allows ~10 browser-minutes a day; one picture takes ~5-10 s. When the allowance is used up
//     (or anything fails) the post simply goes out without a picture. Pictures are never stored: memory -> Discord upload.
//   - The journal is password protected. No password is stored here: the bot writes a random short-lived pass ("shot:pass")
//     to the shared database, the browser sends it as a header, and the journal accepts it for GET requests until it expires.
import puppeteer from "@cloudflare/puppeteer";

const KEYS = ["tf", "dir", "e", "s", "t", "x", "et", "xt", "from", "to", "label", "mode", "mv", "hl", "bl", "xl"];

async function shoot(browser, base, tok, q) {
  const page = await browser.newPage();
  try {
    await page.setViewport(q.mode === "lb" ? { width: 1500, height: 680, deviceScaleFactor: 2 } : { width: 1100, height: 620, deviceScaleFactor: 2 });
    await page.setExtraHTTPHeaders({ "x-shot-key": tok });
    const qs = new URLSearchParams({ shot: "1", tf: "1m" });
    for (const k of KEYS) if (q[k] != null && q[k] !== "") qs.set(k, String(q[k]));
    await page.goto(base + "/?" + qs, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector('html[data-shot="ready"]', { timeout: 25000 });
    await new Promise((r) => setTimeout(r, 700));   // last paint (clouds, labels)
    return { name: "chart.png", data: await page.screenshot({ type: "png" }) };
  } finally { await page.close().catch(() => {}); }
}

// several pictures with ONE browser (the free plan allows only a few new browsers a minute); a failed one is null
export async function chartShots(env, deps, list) {
  if (!env.BROWSER || !env.JOURNAL_URL || !list.length) return list.map(() => null);
  const tok = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await deps.writeJSON(env, "shot:pass", { tok, exp: Date.now() + Math.max(60000, list.length * 45000) });
  // free plan allows only a few new browsers a minute: two in the same minute -> wait and try once more
  const browser = await puppeteer.launch(env.BROWSER).catch(async () => { await new Promise((r) => setTimeout(r, 8000)); return puppeteer.launch(env.BROWSER); });
  const base = env.JOURNAL_URL.replace(/\/$/, ""), out = [];
  try {
    for (const q of list) out.push(await shoot(browser, base, tok, q).catch((e) => { console.error("shot", e.message); return null; }));
  } finally {
    await browser.close().catch(() => {});
    await deps.writeJSON(env, "shot:pass", { tok: null, exp: 0 }).catch(() => {});
  }
  return out;
}

export async function chartShot(env, deps, q) {
  if (!env.BROWSER || !env.JOURNAL_URL) return null;
  const [f] = await chartShots(env, deps, [q]);
  if (!f) throw new Error("chart picture failed");
  return f;
}
