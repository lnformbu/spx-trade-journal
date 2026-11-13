# SPX Trade Journal

> ## 100% FREE — no subscription, no credit card, no ads.
> **Runs on Cloudflare's free plan. You pay $0, forever.**

A trade journal for options traders, built for **SPX 0DTE**. Put it online in about 15 minutes and use it from your phone or computer, 24/7, behind your own password.

---

## What it does

- **Log a trade in one line:** type `7550c 6.20 6.80 x2` and press **Enter** (SPX and 0DTE are the defaults)
- **Import from Schwab:** export your history from Schwab and click one button. Buys and sells are matched into trades, expired options count as $0, and duplicates are skipped.
- **See where you stand:** win rate, profit factor, average win vs. loss, P/L **after fees**, and an equity curve
- **Streaks:** current and longest green-day / red-day streaks
- **Loss discipline:** set a max loss per trade, see every trade that broke it, and what you'd have made if you'd stuck to it
- **Calendar** with daily, weekly and monthly P/L
- **Filters:** this year, last 30 days, SPX only, and more
- **A Bible verse** for each trading day (King James Version)
- **Schwab auto-sync** (online version): connect your Schwab account once and new trades come in by themselves
- **Optional signal bot** ([`bot/`](bot/README.md)): live levels, your Discord morning plan, signals to Discord, an **SPX greek exposure board** and a **0DTE leaderboard** in the journal's Bot desk, and a scorecard of how its signals did. It does not place real trades: it **paper trades** SPX 0DTE from its own signals and **trains itself** after every close (switches losing setups off, tunes exits with a walk-forward test).

Your trades stay private: they live in **your own** Cloudflare account, never in this repository.

---

## What it costs: **nothing**

| | Cost |
|---|---|
| Cloudflare account | **FREE** (no credit card needed) |
| Hosting the site (Cloudflare Pages) | **FREE** |
| Storing your trades (Cloudflare D1 database) | **FREE** |
| Your web address (`your-name.pages.dev`) | **FREE** |
| Node.js (needed for setup) | **FREE** |

A journal uses a tiny fraction of the free limits (100,000 requests a day, 5 GB of storage).
**The only way to pay is to click "Upgrade" in Cloudflare yourself. You never need to.**
*(Free-plan limits can change; check [cloudflare.com/plans](https://www.cloudflare.com/plans/).)*

---

## Set it up online (about 15 minutes, all free)

### Step 1: Get the free tools

1. **Create a free Cloudflare account:** go to [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up). Email and password only, **no card**.
2. **Install Node.js (free):** go to [nodejs.org](https://nodejs.org), download the **LTS** version, and run the installer (click *Next* through it).
3. **Download this project:** at the top of this GitHub page, click the green **Code** button, then **Download ZIP**. Unzip it somewhere easy, like your Desktop.

### Step 2: Choose your web address

Open the `cloud` folder, then open **`wrangler.toml`** in Notepad (or any text editor). Change this line:

```toml
name = "my-spx-journal"
```

to a name of your own, for example `name = "jane-spx-journal"`.
Your journal will live at **`https://jane-spx-journal.pages.dev`**.
Use lowercase letters, numbers and dashes only. It has to be unique, so add something personal. Save the file.

### Step 3: Open a terminal in the `cloud` folder

- **Windows:** open the `cloud` folder, click the address bar at the top, type `cmd`, press **Enter**.
- **Mac:** right-click the `cloud` folder, then **New Terminal at Folder**.

### Step 4: Run these 5 commands, one at a time

Copy each line, paste it into the terminal, press **Enter**, and wait for it to finish before the next.

| # | Paste this | What happens |
|---|---|---|
| 1 | `npm run login` | Your browser opens. Log in to Cloudflare and click **Allow**. |
| 2 | `npm run setup` | Creates your free database |
| 3 | `npm run create` | Creates your free website |
| 4 | `npm run password` | Type a password for your journal, then press **Enter** (it shows as stars) |
| 5 | `npm run deploy` | Publishes it and prints your link |

**Done!** Open `https://<your-name>.pages.dev`, type **any username** and the password from step 4, and bookmark it.

> **On your phone:** open the link, then use *Share → Add to Home Screen*. It opens like an app.

---

## Using it

| To… | Do this |
|---|---|
| Log a trade fast | Type in **Quick type**, e.g. `7550c 6.20 6.80 x2`, press **Enter** |
| Log a trade by hand | Pick ticker, Call/Put, strike, entry, exit, then **Log trade** |
| Import from Schwab | In Schwab: **Accounts → History → Export**. In the journal: **Import from Schwab**, then pick the file. Re-importing the same file is safe. |
| Fix or delete a trade | Click the day on the calendar, then **Edit** or **Delete** (Delete has **Undo**) |
| Set your max loss | Type it in the **Loss discipline** panel and click **Save** |
| See only part of your history | Use the filter bar: period, ticker, **After fees** |
| Add a Bible verse | Click **+ Add verse** |
| Back up your trades | Bottom of the page: **Export backup** (do it monthly) |

Keyboard: **/** jumps to Quick type · **Enter** saves · **Esc** cancels an edit.

---

## Later changes (run in the `cloud` folder)

| To… | Run |
|---|---|
| Change your password | `npm run password` then `npm run deploy` |
| Update the site after editing `index.html` | `npm run deploy` |
| Load your own verse list from `quotes.txt` | `npm run verses` |

Your trades are never touched by these commands.

---

## Problems?

| You see | Fix |
|---|---|
| `npm` is not recognized | Install Node.js (Step 1), then close and reopen the terminal |
| `ENOENT … package.json` | The terminal isn't in the `cloud` folder; redo Step 3 |
| "Project name already taken" / name errors | Pick a more unique name in `wrangler.toml` (Step 2), then run `npm run create` again |
| Page says **"Journal is locked"** | Run `npm run password` then `npm run deploy` |
| Password box keeps coming back | Wrong password: close the browser and retry, or set a new one |
| Site won't load right after deploying | Wait 2 minutes and refresh, or try a private window |
| "Not logged in" | `npm run login` |

---

## Prefer to run it only on your computer?

Also free, with no account at all. In the main folder, run `node server.js` (or double-click `run.bat` on Windows) and open http://localhost:4949.
Trades are saved to `trades.json` in that folder. This version only works while your computer is on.

---

## Reading the SPX greek board and trading the leaderboard (LB)

The Bot desk's sidebar shows the **SPX greek exposure board** and the **0DTE leaderboard**. They're confluence tools: they tell you
where price is likely to be pulled, pinned or pushed, and where crowded 0DTE holders are likely to get squeezed. They are not signals on their own.
**This is education, not financial advice. Paper-test anything here before risking money.**

### The greek board

Each bar is one SPX strike; **green = positive, red = negative**; the blue line is spot. Tabs switch between GEX, DEX, Vanna and Charm.
The board assumes the usual dealer positioning (customers buy calls and puts, dealers are on the other side), so calls count +, puts −.

| What you see | What it usually means | How to use it |
|---|---|---|
| **Above the gamma flip** (net GEX positive) | Dealers are long gamma: they sell rallies and buy dips, so moves get **dampened** and price tends to pin to big green strikes | Favor fades at walls and scalps back toward VWAP; take profits faster |
| **Below the gamma flip** (net GEX negative) | Dealers are short gamma: they chase price, so moves **accelerate** and ranges widen | Favor breakouts and continuation; give targets more room; size down |
| **Call wall** (biggest green strike above) | Typical **resistance** and upside target; first touches often stall | Take profit into it; a clean break and hold can squeeze higher |
| **Put wall** (biggest red strike) | Typical **support** and downside magnet | Take profit into it; losing it in negative gamma can speed the drop |
| **Big nodes near spot** | Magnets, strongest into the close as 0DTE options decay (pinning) | Expect price to drift toward them after 2-3 PM |
| **👁 Eye of Sauron** (one red node much bigger than the rest, near spot) | Pulls price in like a magnet, then often throws it away violently | Don't fade the approach; wait for the touch and a reversal candle, then trade the move **away** |
| **DEX** | Where dollar delta is concentrated | Moving through a big DEX cluster forces re-hedging (fuel for the move) |
| **Vanna** | How dealer hedges change when implied volatility moves | VIX falling + positive vanna = hedges get bought back, a tailwind for rallies; VIX rising = headwind (check the VIX 10m chip) |
| **Charm** | How hedges change as time passes (biggest in the afternoon for 0DTE) | Large charm near spot strengthens the pull toward a pin in the last hours |

Limits: open interest is last night's (positions opened today aren't in it), and Schwab gives no SPX open interest, so the board
is built from SPY options mapped onto SPX strikes until it does (the board says which). It updates every 5 minutes.

### The leaderboard (LB)

The 10 most-traded SPX 0DTE contracts today. **VWAP** is the average price today's buyers paid; **vs VWAP** shows whether those holders are in profit.
A contract **20%+ above its VWAP** gets a **shakeout** tag: lots of holders are sitting on profit, and the market often moves against
them (to shake them out) before continuing or reversing. Calls in profit → watch for a **dip**; puts in profit → watch for a **pop**.

**Trading an LB shakeout, step by step:**

1. **Regime:** is SPX above or below the gamma flip? (Shakeouts are shallower above it, deeper below.)
2. **Who's crowded:** which top LB contracts are in profit, and on which side.
3. **Where the shakeout should stop:** the nearest level against them where several things stack: a big GEX node or the put/call wall,
   VWAP, a Saty ATR level (trigger / midrange), the 10m EMA 21, an anchored VWAP band.
4. **Wait for the shakeout into that level and a reversal candle** on 1m/3m (engulfing, pin bar, false break). The bot's ⭐ A/A+ alerts check
   this and show **"LB shakeout ✓"** when it lines up.
5. **Enter in the crowd's original direction** (continuation). Stop just beyond the shakeout's extreme. Targets: the next big node,
   then the call wall (for calls) or put wall (for puts). Use the profit ladder: bank half at target 1, trail the rest.
6. **If the shakeout breaks the level** and closes beyond it (especially below the flip), it can turn into a **reversal**:
   only trade the other way after a confirming candle and the cloud turning.

**Power hour and the last 10 minutes:** the LB shows a **max-pain zone**: the SPX range that pays the in-the-money LB holders the least.
From about 3:30, price is often drawn toward it, together with big nodes and charm. The bot posts the zone at 3:50.
Avoid holding a 0DTE position against that pull into the close.

**Example (made-up numbers):** SPX 7,592, above the flip at 7,580. The LB's top contract is the 7,590C, +35% vs its VWAP (call holders in profit).
The nearest support stack is 7,585: a green GEX node, VWAP and the ATR call trigger. SPX dips to 7,584, prints a bullish engulfing on 3m,
and the bot posts ⭐ A+ with "LB shakeout ✓". Entry on the 1m break of the engulfing high, stop below 7,583, targets the 7,600 node and then the 7,620 call wall.

---

## What's in this repository

| File | What it is |
|---|---|
| `index.html` | The whole app (one page) |
| `cloud/` | The free online version: server code, Schwab importer, setup commands ([details](cloud/README.md)) |
| `bot/` | Optional signal bot: levels, Discord plan reading, signals, greek board, leaderboard, scorecard ([details](bot/README.md), [rules](bot/RULES.md)) |
| `server.js`, `run.bat`, `run.sh` | Run it on your own computer instead |
| `quotes.txt` | The daily verse list (King James Version, public domain) |

**Your data is never in here:** `trades.json` and CSV files are git-ignored.
