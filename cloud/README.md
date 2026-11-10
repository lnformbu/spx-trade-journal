# `cloud/`: the free online version

> **💸 FREE:** runs on Cloudflare's free plan (Pages + D1). No credit card.

**Setting it up for the first time? Follow the step-by-step guide in the [main README](../README.md#-set-it-up-online-about-15-minutes-all-free).**
This page is a reference for later.

## Commands (run in this folder)

| Command | What it does |
|---|---|
| `npm run login` | Log in to Cloudflare (opens your browser) |
| `npm run setup` | Create the database; loads `../trades.json` and `../quotes.txt` if present. Never overwrites existing online data. |
| `npm run create` | Create the Pages site named in `wrangler.toml` |
| `npm run password` | Set the site password (then `npm run deploy` to apply it) |
| `npm run deploy` | Publish `../index.html` and the server code |
| `npm run verses` | Send `../quotes.txt` to the site (verses added on the site are copied into the file first) |

## Optional: automatic Schwab import (Windows)

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
| `src/worker.js` | Online server: password check, saves trades and verses, Schwab import |
| `src/schwab.js` | Turns a Schwab transactions CSV into journal trades |
| `scripts/` | The commands above |
| `wrangler.toml` | Your site name and database id (`setup` fills in the id) |
| `schema.sql` | Database table |
| `public/` | Built on deploy; don't edit |

## Good to know

- Wrangler (Cloudflare's tool) runs through `npx`, so nothing gets installed into the project.
- Cloudflare keeps **7 days of database history** if you ever need to undo something: `npx wrangler d1 time-travel --help`.
- The site refuses to open until a password is set, so it's never public by accident.
