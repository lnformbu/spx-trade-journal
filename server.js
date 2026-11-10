/*
 * 90-Day Pattern Desk — local server
 * Saves every trade to trades.json in THIS folder. No browser storage, no exports.
 * Run:  node server.js    then open  http://localhost:4949
 */
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 4949;
const DATA_FILE = path.join(__dirname, "trades.json");
const HTML_FILE = path.join(__dirname, "index.html");
const QUOTES_FILE = path.join(__dirname, "quotes.txt");

// ---- data helpers ----
function readData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const d = JSON.parse(raw);
    if (!d.trades) d.trades = [];
    if (!d.start) d.start = todayISO();
    return d;
  } catch (e) {
    return { start: todayISO(), trades: [] };
  }
}
function writeData(d) {
  // atomic-ish write: temp then rename, so a crash mid-write can't corrupt the file
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function todayISO() {
  const x = new Date();
  return x.getFullYear() + "-" + String(x.getMonth() + 1).padStart(2, "0") + "-" + String(x.getDate()).padStart(2, "0");
}

// ensure file exists on first run
if (!fs.existsSync(DATA_FILE)) writeData({ start: todayISO(), trades: [] });

// ---- request body reader ----
function body(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); } catch (e) { resolve({}); }
    });
  });
}

function log(msg) {
  console.log("[" + new Date().toISOString() + "] " + msg);
}

async function handle(req, res) {
  const url = req.url.split("?")[0];

  // GET all data
  if (req.method === "GET" && url === "/api/data") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(readData()));
  }

  // POST full data (used for save, config, delete — client sends the whole set)
  if (req.method === "POST" && url === "/api/data") {
    const incoming = await body(req);
    const d = readData();
    if (Array.isArray(incoming.trades)) d.trades = incoming.trades;
    if (incoming.start) d.start = incoming.start;
    if (typeof incoming.startBal === "number") d.startBal = incoming.startBal;
    if (incoming.settings && typeof incoming.settings === "object") d.settings = incoming.settings;
    writeData(d);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, count: d.trades.length }));
  }

  // daily quotes: one per line in quotes.txt, # lines are comments
  if (req.method === "GET" && url === "/api/quotes") {
    let lines = [];
    try {
      lines = fs.readFileSync(QUOTES_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    } catch (e) {}
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ quotes: lines }));
  }

  // add quotes: { text } — each non-empty line is appended to quotes.txt
  if (req.method === "POST" && url === "/api/quotes") {
    const incoming = await body(req);
    const lines = String(incoming.text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    if (!lines.length) { res.writeHead(400); return res.end("empty"); }
    let cur = "";
    try { cur = fs.readFileSync(QUOTES_FILE, "utf8"); } catch (e) {}
    fs.writeFileSync(QUOTES_FILE, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, added: lines.length }));
  }

  // serve the app
  if (req.method === "GET" && (url === "/" || url === "/index.html")) {
    fs.readFile(HTML_FILE, (err, buf) => {
      if (err) { res.writeHead(500); return res.end("index.html missing"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buf);
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
}

// one bad request (e.g. a failed disk write) returns an error instead of taking the server down
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    log("request failed: " + req.method + " " + req.url + " — " + (err && err.stack || err));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "server error" }));
  });
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log("Port " + PORT + " is already in use — the server is probably already running. Open http://localhost:" + PORT);
    process.exit(2);
  }
  log("server error: " + (err && err.stack || err));
  process.exit(1);
});

// anything unexpected: log it and exit so keep-running.cmd restarts a clean process
process.on("uncaughtException", (err) => { log("crash: " + (err && err.stack || err)); process.exit(1); });
process.on("unhandledRejection", (err) => { log("crash: " + (err && err.stack || err)); process.exit(1); });

server.listen(PORT, () => {
  console.log("\n  90-Day Pattern Desk is running.");
  console.log("  Open this in your browser:  http://localhost:" + PORT);
  console.log("  Your trades are saved in:   " + DATA_FILE);
  console.log("  Leave this window open while you use the app. Ctrl+C to stop.\n");
});
