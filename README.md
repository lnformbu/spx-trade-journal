# SPX Trade Journal

A free, self-hosted options trade journal built for SPX 0DTE traders.

- **Fast entry:** type `7550c 6.20 6.80 x2` and press Enter; SPX and 0DTE are the defaults
- **Schwab import:** pick a Schwab *History → Export* CSV; buys and sells are paired into trades, expirations become $0 exits, and duplicates are skipped
- **Stats:** win rate, profit factor, average win vs. loss, P/L after fees
- **Streaks:** current and longest green/red-day streaks, plus how many streaks of each length you've had
- **Loss discipline:** set a max loss per trade, see every trade that broke it and what P/L would have been if losses had stopped at the limit
- **Equity curve, breakdowns** by ticker / call-put / weekday / expiry, and a **calendar** with weekly and monthly totals
- **Filters:** period, ticker, after fees
- **A daily Bible verse** (KJV) each trading day
- Keyboard-friendly, screen-reader labels, colorblind palette

Your trades are never in this repository — `trades.json` and CSV files are git-ignored.

## Run it on your PC

Needs [Node.js](https://nodejs.org) (LTS). No other installs.

```
node server.js
```

Open http://localhost:4949. Trades are saved to `trades.json` in this folder.
On Windows you can double-click `run.bat` instead. `install-autostart.ps1` makes it start at login (optional).

## Put it online for free (Cloudflare)

Runs 24/7 on Cloudflare's free plan (Pages + D1 database), password-protected, works on your phone.
See **[cloud/README.md](cloud/README.md)**.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app (one page) |
| `server.js` | Local server: serves the page, saves `trades.json` and `quotes.txt` |
| `quotes.txt` | Verse list, one per line: `• Book 1:2 — “text”` or `text ~ Book 1:2` |
| `cloud/` | Cloudflare version of the server, Schwab importer, setup scripts |
| `run.bat`, `run.sh` | Start the local server |
| `install-autostart.ps1`, `keep-running.cmd`, `start-hidden.vbs` | Optional: keep the local server running (Windows) |

## Your data

- **Local:** `trades.json` in this folder.
- **Online:** your Cloudflare D1 database. Use **Export backup** in the app now and then.
