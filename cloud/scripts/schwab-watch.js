// Watches your Downloads folder for Schwab History exports and sends each one to the
// online journal. Imported files are moved to Downloads\schwab-imported.
//
//   npm run schwab:setup            save the journal password on this PC (asked once)
//   npm run schwab:check -- <file>  preview what a file would import — saves nothing
//   npm run schwab:watch            start watching (install-schwab-watcher.ps1 runs this at login)
//
// The password is kept in %APPDATA%\spx-journal\watcher.json — on this PC only, not in OneDrive.
const fs = require("fs"), os = require("os"), path = require("path"), readline = require("readline");
const { execFile } = require("child_process");

// the site is https://<name>.pages.dev, with <name> from wrangler.toml (or "site" in watcher.json)
const PAGES_NAME = fs.readFileSync(path.join(__dirname, "..", "wrangler.toml"), "utf8").match(/^name\s*=\s*"([^"]+)"/m)[1];
const SITE = (readConfigEarly() || {}).site || `https://${PAGES_NAME}.pages.dev`;
function readConfigEarly() { try { return JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || os.homedir(), "spx-journal", "watcher.json"), "utf8")); } catch (e) { return null; } }
const CONFIG = path.join(process.env.APPDATA || os.homedir(), "spx-journal", "watcher.json");
const DOWNLOADS = path.join(os.homedir(), "Downloads");
const DONE_DIR = path.join(DOWNLOADS, "schwab-imported");

const log = (m) => console.log(`[${new Date().toLocaleString()}] ${m}`);
const readConfig = () => { try { return JSON.parse(fs.readFileSync(CONFIG, "utf8")); } catch (e) { return null; } };
const authHeader = (pw) => "Basic " + Buffer.from("watcher:" + pw).toString("base64");

function notify(title, msg) {
  // Windows balloon/toast without extra installs
  const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; ` +
    `$n.Icon=[System.Drawing.SystemIcons]::Information; $n.Visible=$true; ` +
    `$n.ShowBalloonTip(6000,'${title.replace(/'/g, "''")}','${msg.replace(/'/g, "''")}','Info'); Start-Sleep 7; $n.Dispose()`;
  execFile("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], () => {});
}

async function send(file, pw, dry) {
  const res = await fetch(`${SITE}/api/import-schwab${dry ? "?dry=1" : ""}`, {
    method: "POST",
    headers: { Authorization: authHeader(pw), "Content-Type": "text/csv" },
    body: fs.readFileSync(file, "utf8"),
  });
  if (res.status === 401) throw new Error("wrong password — run  npm run schwab:setup");
  if (res.status === 503) throw new Error("the journal has no password yet — run  npm run password  then  npm run deploy");
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.error || `server said ${res.status}`);
  return out;
}

const looksLikeSchwab = (file) => {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 2000).toLowerCase();
    return head.includes("action") && head.includes("symbol") && head.includes("price");
  } catch (e) { return false; }
};

function summary(r) {
  const parts = [`${r.added} new trade${r.added === 1 ? "" : "s"}`];
  if (r.duplicates) parts.push(`${r.duplicates} already in journal`);
  if (r.open) parts.push(`${r.open} still open`);
  if (r.skippedShort) parts.push(`${r.skippedShort} short fills skipped`);
  if (r.skippedStock) parts.push(`${r.skippedStock} stock fills skipped`);
  if (r.missingOpen) parts.push(`${r.missingOpen} closes without their opening buy (export a longer date range)`);
  return parts.join(", ");
}

async function setup() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // hide the typed password
  rl._writeToOutput = (s) => { if (rl.stdoutMuted) rl.output.write(s.includes("\n") ? "\n" : "*"); else rl.output.write(s); };
  const pw = await new Promise((done) => { rl.question("Journal password: ", done); rl.stdoutMuted = true; });
  rl.close();
  const r = await fetch(`${SITE}/api/data`, { headers: { Authorization: authHeader(pw) } });
  if (r.status !== 200) { console.log(r.status === 401 ? "\nThat password didn't work — try again." : `\nThe journal answered ${r.status}.`); process.exit(1); }
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ password: pw }), { mode: 0o600 });
  console.log(`\nSaved. Password works. Stored in ${CONFIG}`);
}

async function check(file) {
  const cfg = readConfig();
  if (!cfg) { console.log("Run  npm run schwab:setup  first."); process.exit(1); }
  const r = await send(path.resolve(file), cfg.password, true);
  console.log("Preview only — nothing saved.\n" + summary(r) + "\n");
  for (const t of r.trades) {
    const pl = (t.exit - t.entry) * t.qty * 100;
    console.log(`${t.date}  ${t.ticker} ${t.strike}${t.cp}  ${t.entry} -> ${t.exit}  x${t.qty}  ${pl >= 0 ? "+" : "-"}$${Math.abs(pl).toFixed(2)}   ${t.notes}`);
  }
}

async function watch() {
  const cfg = readConfig();
  if (!cfg) { log("No password saved — run  npm run schwab:setup  once."); process.exit(1); }
  fs.mkdirSync(DONE_DIR, { recursive: true });
  const busy = new Set(), retries = new Map();

  const handle = async (name) => {
    const file = path.join(DOWNLOADS, name);
    if (!/\.csv$/i.test(name) || busy.has(file)) return;
    busy.add(file);
    try {
      // wait until the browser has finished writing the file
      let size = -1;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (!fs.existsSync(file)) return;
        const s = fs.statSync(file).size;
        if (s > 0 && s === size) break;
        size = s;
      }
      if (!looksLikeSchwab(file)) return;
      const r = await send(file, cfg.password, false);
      const dest = path.join(DONE_DIR, name.replace(/\.csv$/i, "") + "-" + Date.now() + ".csv");
      fs.renameSync(file, dest);
      log(`${name}: ${summary(r)}`);
      notify("SPX Journal", `Schwab import: ${summary(r)}`);
    } catch (e) {
      // network hiccup: try again a few times; a wrong password or bad file won't fix itself
      const n = (retries.get(file) || 0) + 1;
      const transient = !/password|doesn't look like/i.test(e.message);
      if (transient && n <= 5) {
        retries.set(file, n);
        log(`${name}: ${e.message} — retrying in 2 minutes (${n}/5)`);
        setTimeout(() => handle(name), 2 * 60 * 1000);
      } else {
        retries.delete(file);
        log(`${name}: FAILED — ${e.message}`);
        notify("SPX Journal", `Schwab import failed: ${e.message}`);
      }
    } finally {
      busy.delete(file);
    }
  };

  // anything exported while the watcher wasn't running (re-importing is harmless)
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const n of fs.readdirSync(DOWNLOADS)) {
    try { if (/\.csv$/i.test(n) && fs.statSync(path.join(DOWNLOADS, n)).mtimeMs > dayAgo) handle(n); } catch (e) {}
  }
  fs.watch(DOWNLOADS, (ev, name) => { if (name) handle(name); });
  log(`Watching ${DOWNLOADS} for Schwab exports → ${SITE}`);
}

const [cmd, arg] = process.argv.slice(2);
const run = { setup, check: () => (arg ? check(arg) : Promise.reject(new Error("which file? e.g. npm run schwab:check -- Downloads\\file.csv"))), watch }[cmd];
if (!run) console.log("usage: schwab-watch.js setup | check <file> | watch");
else run().catch((e) => { console.error(e.message); process.exit(1); });
