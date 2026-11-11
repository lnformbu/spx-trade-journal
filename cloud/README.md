# `cloud/`: the free online version

> **FREE:** runs on Cloudflare's free plan (Pages + D1). No credit card.

**Setting it up for the first time? Follow the step-by-step guide in the [main README](../README.md#set-it-up-online-about-15-minutes-all-free).**
This page is a reference for later.

## Commands (run in this folder)

| Command | What it does |
|---|---|
| `npm run login` | Log in to Cloudflare (opens your browser) |
| `npm run setup` | Create the database; loads `../trades.json` and `../quotes.txt` if present. Never overwrites existing online data. |
| `npm run create` | Create the Pages site named in `wrangler.toml` |
| `npm run password` | Set the site password (then `npm run deploy` to apply it) |
| `npm run deploy` | Publish `../index.html` and the server code |
| `npm run schwab:keys` | Save your Schwab app key and secret (see below) |
| `npm run verses` | Send `../quotes.txt` to the site (verses added on the site are copied into the file first) |

## Optional: Schwab account sync (free Schwab Trader API)

Pulls your trades straight from Schwab every time you open the journal (at most every 10 minutes), or when you click **Sync now**.

1. On [developer.schwab.com](https://developer.schwab.com): **Dashboard → Create App**, product **Accounts and Trading Production**,
   callback URL `https://<your-site>.pages.dev/schwab/callback`. Wait until the app says **Ready For Use** (Schwab reviews it first).
2. Here: `npm run schwab:keys`, then paste the **App Key** and the **Secret**. It deploys by itself.
3. In the journal: **Connect Schwab** (bottom of the page), then log in on Schwab's own page.

Schwab ends the login after **7 days**; click **Reconnect Schwab** when the journal asks.
Your Schwab password is never stored, only the login tokens Schwab hands back. The keys are Cloudflare secrets, not files.

## Optional: import Schwab export files automatically (Windows)

Imports any Schwab *History → Export* file that lands in your Downloads folder.

| Command | What it does |
|---|---|
| `npm run schwab:setup` | Save your site password on this PC (in `%APPDATA%`, not in this folder) |
| `npm run schwab:check -- path\to\export.csv` | Preview what a file would import; saves nothing |
| `npm run schwab:install` | Start the watcher now and at every login |
| `npm run schwab:uninstall` | Stop and remove it |

## Files

| File | Purpose |
|---|---|
| `src/worker.js` | Online server: password check, saves trades and verses, Schwab import and account sync |
| `src/schwab.js` | Turns Schwab transactions (CSV export or Trader API) into journal trades |
| `scripts/` | The commands above |
| `wrangler.toml` | Your site name and database id (`setup` fills in the id) |
| `schema.sql` | Database table |
| `public/` | Built on deploy; don't edit |

## Good to know

- Wrangler (Cloudflare's tool) runs through `npx`, so nothing gets installed into the project.
- Cloudflare keeps **7 days of database history** if you ever need to undo something: `npx wrangler d1 time-travel --help`.
- The site refuses to open until a password is set, so it's never public by accident.
