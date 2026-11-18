// Chart picture for SPX paper buys (user 11/18): Cloudflare's headless browser opens the journal's own chart (?shot=1),
// 1-minute chart, last hour, sharp (2x pixels), with the trade's entry / stop / target drawn, and returns a PNG for the Discord post.
//   - Free plan: Browser Rendering allows ~10 browser-minutes a day; one picture takes ~5-10 s. When the allowance is used up
//     (or anything fails) the post simply goes out without a picture.
//   - The journal is password protected. No password is stored here: the bot writes a random one-minute pass ("shot:pass")
//     to the shared database, the browser sends it as a header, and the journal accepts it for GET requests until it expires.
import puppeteer from "@cloudflare/puppeteer";

export async function chartShot(env, deps, q) {
  if (!env.BROWSER || !env.JOURNAL_URL) return null;
  const tok = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  await deps.writeJSON(env, "shot:pass", { tok, exp: Date.now() + 60000 });
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 620, deviceScaleFactor: 2 });
    await page.setExtraHTTPHeaders({ "x-shot-key": tok });
    const qs = new URLSearchParams({ shot: "1", tf: q.tf || "1m", dir: q.dir || "", e: String(q.e ?? ""), s: String(q.s ?? ""), t: String(q.t ?? ""), label: q.label || "" });
    await page.goto(env.JOURNAL_URL.replace(/\/$/, "") + "/?" + qs, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector('html[data-shot="ready"]', { timeout: 25000 });
    await new Promise((r) => setTimeout(r, 700));   // last paint (clouds, labels)
    const png = await page.screenshot({ type: "png" });
    return { name: "chart.png", data: png };
  } finally {
    await browser.close().catch(() => {});
    await deps.writeJSON(env, "shot:pass", { tok: null, exp: 0 }).catch(() => {});
  }
}
