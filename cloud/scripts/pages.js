// Runs the Cloudflare Pages commands for the site named in wrangler.toml.
//   node scripts/pages.js create | password | deploy | dev
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const name = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").match(/^name\s*=\s*"([^"]+)"/m)[1];
const wrangler = "npx --yes wrangler@4.154.0 ";

const commands = {
  // --force: create a classic Pages project (gives <name>.pages.dev) instead of delegating to Workers
  create: `pages project create ${name} --production-branch main --force`,
  password: `pages secret put JOURNAL_PASSWORD --project-name ${name}`,
  deploy: `pages deploy public --project-name ${name} --branch main --commit-dirty=true`,
  dev: `pages dev public`,
};
const which = process.argv[2];
if (!commands[which]) { console.error("usage: node scripts/pages.js " + Object.keys(commands).join("|")); process.exit(1); }

if (which === "deploy" || which === "dev") require("./sync-page.js");
execSync(wrangler + commands[which] + process.argv.slice(3).map((a) => " " + a).join(""), { cwd: root, stdio: "inherit" });
if (which === "deploy") console.log(`\nYour journal: https://${name}.pages.dev`);
