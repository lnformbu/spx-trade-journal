# Online version (Cloudflare, free)

Runs the journal 24/7 on Cloudflare's free plan: **Pages** for the site, **D1** for the data.
No credit card needed. The whole site is behind a password.

## One-time setup

You need [Node.js](https://nodejs.org) (LTS) and a free [Cloudflare](https://dash.cloudflare.com/sign-up) account.

1. **Pick a site name.** Open `wrangler.toml` and change `name = "my-spx-journal"`.
   Your site will be `https://<name>.pages.dev`, so the name must be unique across Cloudflare.
2. Open a terminal **in this `cloud` folder** and run, one at a time:

| # | Command | What happens |
|---|---|---|
| 1 | `npm run login` | Browser opens → log in to Cloudflare → **Allow** |
| 2 | `npm run setup` | Creates the database; loads `../trades.json` and `../quotes.txt` if you have them |
| 3 | `npm run create` | Creates the Pages site |
| 4 | `npm run password` | Choose the site password |
| 5 | `npm run deploy` | Publishes it |

Open `https://<name>.pages.dev`, sign in with **any username** and your password.

`setup` is safe to repeat — it never overwrites data that's already online.

## Everyday commands (run in this folder)

| To… | Run |
|---|---|
| Publish changes to `../index.html` | `npm run deploy` |
| Change the password | `npm run password` then `npm run deploy` (Pages only applies secrets on deploy) |
| Send `../quotes.txt` to the site | `npm run verses` (verses added on the site are copied into the file first) |

## Schwab import

In the app: **Import from Schwab** → pick a Schwab *Accounts → History → Export* CSV.

Optional, Windows: a watcher that imports any Schwab export that lands in your Downloads folder.

```
npm run schwab:setup     # saves your site password on this PC (in %APPDATA%, not in this folder)
npm run schwab:check -- path\to\export.csv   # preview what would be imported, saves nothing
npm run schwab:install   # start it now and at every login
```

## Files

| File | Purpose |
|---|---|
| `src/worker.js` | The online server: password check, saves trades and verses, Schwab import endpoint |
| `src/schwab.js` | Turns a Schwab transactions CSV into journal trades |
| `scripts/` | setup / create / password / deploy / verses / Schwab watcher |
| `wrangler.toml` | Site name and database id (`setup` fills in the id) |
| `schema.sql` | Database table |
| `public/` | Built on deploy — don't edit |

## Notes

- Wrangler (Cloudflare's CLI) runs through `npx`, so nothing is installed into the project folder.
- Cloudflare keeps 7 days of database history: `npx wrangler d1 time-travel --help`.
- Free plan limits change over time — check https://www.cloudflare.com/plans/.
