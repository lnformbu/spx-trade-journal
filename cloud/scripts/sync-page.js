// Builds public/: the journal page (../index.html) plus the server code as _worker.js,
// so the cloud site always matches the local one.
const fs = require("fs"), path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "public");
fs.mkdirSync(outDir, { recursive: true });

const src = path.join(root, "..", "index.html");
const html = fs.readFileSync(src, "utf8").replace(
  "Saved to trades.json in this folder. Keep the server window open while using the app.",
  "Saved to your Cloudflare journal. Use Export backup now and then to keep a copy."
);
fs.writeFileSync(path.join(outDir, "index.html"), html);
fs.copyFileSync(path.join(root, "src", "worker.js"), path.join(outDir, "_worker.js"));
console.log("page copied from " + src);
