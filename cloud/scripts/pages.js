// Runs the Cloudflare Pages commands for the site named in wrangler.toml.
//   node scripts/pages.js create | password | keys | deploy | dev
const fs = require("fs"), path = require("path"), { execSync } = require("child_process");

const root = path.join(__dirname, "..");
const name = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8").match(/^name\s*=\s*"([^"]+)"/m)[1];
const wrangler = "npx --yes wrangler@4.154.0 ";

const commands = {
  // --force: create a classic Pages project (gives <name>.pages.dev) instead of delegating to Workers
  create: `pages project create ${name} --production-branch main --force`,
  password: `pages secret put JOURNAL_PASSWORD --project-name ${name}`,
  // Schwab developer portal -> your app -> App Key and Secret; secrets only apply after a deploy
  keys: [`pages secret put SCHWAB_APP_KEY --project-name ${name}`, `pages secret put SCHWAB_APP_SECRET --project-name ${name}`, "deploy"],
  deploy: `pages deploy public --project-name ${name} --branch main --commit-dirty=true`,
  dev: `pages dev public`,
};
const which = process.argv[2];
if (!commands[which]) { console.error("usage: node scripts/pages.js " + Object.keys(commands).join("|")); process.exit(1); }

function run(cmd, extra = "") {
  if (cmd === "deploy" || cmd === "dev") require("./sync-page.js");
  if (cmd === "keys") {
    console.log("Paste the App Key, then the Secret, from developer.schwab.com -> Dashboard -> your app.");
    console.log(`Callback URL registered there must be: https://${name}.pages.dev/schwab/callback\n`);
  }
  [].concat(commands[cmd]).forEach((c) => {
    if (commands[c]) return run(c);
    execSync(wrangler + c + extra, { cwd: root, stdio: "inherit" });
  });
  if (cmd === "deploy") console.log(`\nYour journal: https://${name}.pages.dev`);
}
run(which, process.argv.slice(3).map((a) => " " + a).join(""));
