// Sends ../quotes.txt (the verse list you edit in VS Code) to the online journal.
// Verses that were added on the website ("+ Add verse") but aren't in the file yet are
// first appended to quotes.txt, so nothing is lost and the file stays the master copy.
//
//   npm run verses              -> online journal
//   npm run verses -- --replace -> online journal = exactly quotes.txt (drops website-only verses)
//   npm run verses -- --local   -> local test database
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const file = process.env.VERSES_FILE || path.join(root, "..", "quotes.txt"); // VERSES_FILE: for testing
const where = process.argv.includes("--local") ? "--local" : "--remote";
const dbName = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").match(/database_name\s*=\s*"([^"]+)"/)[1];
const wrangler = (cmd, quiet) => execSync("npx --yes wrangler@4.154.0 " + cmd, { cwd: root, encoding: "utf8", stdio: quiet ? "pipe" : ["inherit", "pipe", "inherit"] });
const lines = (text) => String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

// 1. what's online now
const out = JSON.parse(wrangler(`d1 execute ${dbName} ${where} --json --command "SELECT value FROM blobs WHERE key = 'quotes' ORDER BY part"`, true));
const online = lines(out[0].results.map((r) => r.value).join(""));

// 2. pull website-only verses into the file (skipped with --replace: the file wins as-is)
const replace = process.argv.includes("--replace");
let text = fs.readFileSync(file, "utf8");
const inFile = new Set(lines(text));
const extras = online.filter((l) => !inFile.has(l));
if (extras.length && replace) {
  console.log(`--replace: ${extras.length} verse(s) on the website that aren't in quotes.txt will be removed`);
} else if (extras.length) {
  text = text.replace(/\s*$/, "\n") + extras.join("\n") + "\n";
  fs.writeFileSync(file, text);
  console.log(`Copied ${extras.length} verse(s) added on the website into quotes.txt`);
}

// 3. upload the file (split into parts: D1 caps one SQL statement at 100 KB)
const sql = ["DELETE FROM blobs WHERE key = 'quotes';"];
for (let i = 0, part = 0; i < text.length || part === 0; i += 80000, part++)
  sql.push(`INSERT INTO blobs (key, part, value) VALUES ('quotes', ${part}, '${text.slice(i, i + 80000).replace(/'/g, "''")}');`);
const tmp = path.join(root, "verses.sql");
fs.writeFileSync(tmp, sql.join("\n") + "\n");
try { wrangler(`d1 execute ${dbName} ${where} --file verses.sql`, true); }
finally { fs.unlinkSync(tmp); }

console.log(`Online journal now has ${lines(text).length} verses (was ${online.length}). Refresh the page to see them.`);
