// One-time setup: creates the D1 database, creates the table, and loads
// ../trades.json and ../quotes.txt into it. Safe to re-run: it never
// overwrites data that's already in the cloud.
//
//   npm run setup          -> your Cloudflare account
//   npm run setup:local    -> local test database (for `npm run dev`)
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");

const local = process.argv.includes("--local");
const where = local ? "--local" : "--remote";
const root = path.join(__dirname, "..");
const tomlPath = path.join(root, "wrangler.toml");
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

const run = (cmd, opts = {}) => execSync("npx --yes wrangler@4.154.0 " + cmd, { cwd: root, encoding: "utf8", stdio: opts.quiet ? "pipe" : ["inherit", "pipe", "inherit"] });
let toml = fs.readFileSync(tomlPath, "utf8");
const dbName = toml.match(/database_name\s*=\s*"([^"]+)"/)[1];

// 1. create the database (cloud only) and save its id into wrangler.toml
if (!local && toml.includes(PLACEHOLDER)) {
  let id;
  try {
    const out = run(`d1 create ${dbName}`);
    id = (out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/) || [])[0];
  } catch (e) {
    // already exists from an earlier run: look it up
    const list = JSON.parse(run("d1 list --json", { quiet: true }));
    id = (list.find((d) => d.name === dbName) || {}).uuid;
  }
  if (!id) throw new Error("Couldn't find the database id. Run `npx wrangler d1 list` and paste it into wrangler.toml.");
  toml = toml.replace(PLACEHOLDER, id);
  fs.writeFileSync(tomlPath, toml);
  console.log(`database ${dbName} -> ${id}`);
}

// 2. table
run(`d1 execute ${dbName} ${where} --file schema.sql`);

// 3. load trades + verses, only if the cloud copy is still empty
const countOut = run(`d1 execute ${dbName} ${where} --json --command "SELECT COUNT(*) AS n FROM blobs WHERE key = 'data'"`, { quiet: true });
const n = JSON.parse(countOut)[0].results[0].n;
if (n > 0) {
  console.log("Journal data is already in the database — not overwriting it.");
} else {
  // no trades.json yet (new install) -> start with an empty journal
  let data = '{"trades":[]}';
  try { const t = fs.readFileSync(path.join(root, "..", "trades.json"), "utf8"); if (t.trim()) data = t; } catch (e) {}
  let quotes = "";
  try { quotes = fs.readFileSync(path.join(root, "..", "quotes.txt"), "utf8"); } catch (e) {}
  const sql = [];
  const add = (key, text) => {
    for (let i = 0, part = 0; i < text.length || part === 0; i += 80000, part++)
      sql.push(`INSERT INTO blobs (key, part, value) VALUES ('${key}', ${part}, '${text.slice(i, i + 80000).replace(/'/g, "''")}');`);
  };
  add("data", JSON.stringify(JSON.parse(data)));
  add("quotes", quotes);
  const seed = path.join(root, "seed.sql");
  fs.writeFileSync(seed, "DELETE FROM blobs;\n" + sql.join("\n") + "\n");
  try { run(`d1 execute ${dbName} ${where} --file seed.sql`); }
  finally { fs.unlinkSync(seed); }
  console.log(`Loaded ${JSON.parse(data).trades.length} trades and the verses.`);
}

console.log(local
  ? "\nLocal database ready. Start it with:  npm run dev"
  : "\nCloud database ready. Next:\n  npm run create\n  npm run password\n  npm run deploy");
