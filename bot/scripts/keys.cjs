// Stores the bot's secrets on Cloudflare (never in files):
//   SCHWAB_APP_KEY / SCHWAB_APP_SECRET  - same Client ID / Client Secret as the journal
//   DISCORD_BOT_TOKEN                   - Discord developer portal -> your app -> Bot -> Reset Token
//   BOT_ADMIN_KEY                       - made up here; lets the setup tools check the bot (saved in .admin-key)
const { execSync } = require("child_process");
const crypto = require("crypto"), fs = require("fs"), path = require("path");

const root = path.join(__dirname, "..");
const w = "npx --yes wrangler@4.154.0 secret put ";
const ask = (name, what) => {
  console.log(`\n>>> Paste ${what}, then press Enter (nothing shows while you paste):`);
  execSync(w + name, { cwd: root, stdio: "inherit" });
};
const only = process.argv[2];
if (!only || only === "schwab") {
  ask("SCHWAB_APP_KEY", "the Schwab Client ID");
  ask("SCHWAB_APP_SECRET", "the Schwab Client Secret");
}
if (!only || only === "discord") ask("DISCORD_BOT_TOKEN", "the Discord bot token");
if (!only || only === "webhook") ask("SIGNALS_WEBHOOK", "the #signals webhook URL");
if (!only || only === "admin") {
  const key = crypto.randomBytes(24).toString("hex");
  execSync(w + "BOT_ADMIN_KEY", { cwd: root, input: key, stdio: ["pipe", "inherit", "inherit"] });
  fs.writeFileSync(path.join(root, ".admin-key"), key);
  console.log("Admin key saved.");
}
console.log("\nDone. The bot picks up new keys within a minute.");
