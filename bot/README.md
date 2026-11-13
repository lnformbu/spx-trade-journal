# `bot/`: the SPX/SPY signal bot (Cloudflare Worker, free plan)

> **No trading.** It reads market data, your plan and your training posts, posts signals to Discord, and scores itself.
> Paper trading comes later; real orders are not part of this code.

It shares the journal's database and Schwab connection (connect Schwab in the journal first, see [`../cloud`](../cloud)).

## What it does

| Job | Schedule (weekdays, New York time) |
|---|---|
| Levels, Saty clouds and Phase Oscillator (3m / 10m / 1h), VIX 10m, chop, your plan from Discord | every minute, 4:00-16:20 |
| Signals to Discord: whales, large moves, momentum, A/A+ setups, phase flips, squeezes, compression breakouts, divergences, Eye of Sauron, your plan triggers / targets | each ticker every 2 minutes, 9:30-16:00 |
| SPX greek exposure board (GEX / DEX / vanna / charm) + 0DTE leaderboard | every 5 minutes, 9:25-16:05 |
| Training posts (text + chart images read by Cloudflare's vision model) | every 5 minutes |
| Plan review, signal scorecard | after each signal / after the close |

The journal page shows all of it in the **Bot desk** and the **Bot** view. Full rules: [RULES.md](RULES.md).

## Set up

1. **Discord**: [discord.com/developers/applications](https://discord.com/developers/applications) → New Application → **Bot** tab:
   turn on **Message Content Intent**. OAuth2 → URL Generator → `bot` with View Channels, Read Message History,
   Send Messages, Embed Links → add it to your server.
2. Create three channels and give the bot **View Channel + Read Message History** in each (and **Send Messages + Embed Links** in the signals one):
   a plan channel, a signals channel, a training channel. Copy their IDs (Discord: Settings → Advanced → Developer Mode, right-click → Copy Channel ID).
3. Edit **`wrangler.toml`**: the three channel IDs, `AVWAP_ANCHOR`, and the journal's D1 `database_id` (same as `../cloud/wrangler.toml`).
4. In this folder:
   ```
   npm run deploy
   npm run keys
   ```
   `keys` asks for the Schwab Client ID and Secret (same app as the journal) and the Discord bot token, and creates a private admin key in `.admin-key` (never commit it).

## Post formats

- **Plan** (plan channel): a ticker heading, `Upside: SPX 7620c | SPY 760c`, `Downside: ...`, `VIX key level: 19`, then `If ...` sentences.
- **Training** (training channel): `Setup: SPX 7620c calls, engulfing at PDC #engulfing`, a chart image, or both; reply `Result: +65%` later.

## Files

| File | Purpose |
|---|---|
| `src/index.js` | Schedules, Schwab data, levels, plan reading, training capture, health alerts |
| `src/levels.js` | ATR Levels, Pivot Ribbon Pro, Phase Oscillator, compression, VWAP / anchored VWAP, chop, divergence |
| `src/plan.js` | Reads plan posts (any ticker) and reviews them after the close |
| `src/signals.js` | Signal scanner, Discord posts, signal scoring |
| `src/patterns.js` | Candlestick patterns at key levels |
| `src/greeks.js`, `src/greekjob.js` | Greek exposure board and leaderboard |
| `src/vision.js` | Reads chart screenshots |

## Limits

- Free Cloudflare plan: 50 data calls per run, so the scanner checks half the tickers each minute.
- Schwab's API has no SPX open interest (the board uses SPY options mapped to SPX strikes) and no options time & sales (flow is built from volume changes).
- Schwab ends the login every 7 days; the bot posts a reminder in the signals channel the day before.
