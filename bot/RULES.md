# SPX 0DTE scalping bot: rules

Paper trading only until you switch it to live yourself. All times Eastern.
Numbers marked *(start)* are starting values to tune from paper results. **NEW** marks additions from the review.
SPY is read to gauge SPX (it has volume and premarket); trades and levels are shown in SPX.

## Money (scales with the account)

| Rule | Setting | Example: $2,000 account |
|---|---|---|
| Account | paper account (your starting amount; example $2,000), follows the bot's own P/L | $2,000 |
| Position size | **50% of the account** in premium: contracts = account × 50% ÷ (price × 100), at least 1 | ~$1,000 (e.g. 2 × $5.00) |
| Max loss per trade | **15% of the account** (premium stop at about −30%), including fees and slippage | $300 |
| Daily loss lockout | **15% of the account**, realized + open risk; checked *before* each entry | $300 (one full loss ends the day) |
| If one contract alone costs more than 50% or risks more than 15% | skip the trade | |
| Max trades per day | 4 | |
| Max consecutive losses | 2, then done for the day | |
| Max open positions | 1 | |
| **NEW** Cooldown after a loss | 15 minutes, no new entries *(start)* | |
| **NEW** Same level after a stop-out | no second entry in the same direction at the same level that day | |
| Never | average down, add to a loser, widen a stop, re-enter out of revenge | |

## Instrument

- **SPX 0DTE** long calls and long puts (same-day expiry, cash-settled).
- **Your posted contracts first:** the SPX call from `Upside:` for call trades, the SPX put from `Downside:` for put trades.
  With no post, the bot picks delta 0.45 to 0.60 (at-the-money or slightly in-the-money; one strike out-of-the-money also scored).
- Levels: daily ATR levels and PDH/PDL/PDC from SPX's own data; premarket, overnight, ORB and VWAP from SPY × the live SPX/SPY ratio.
- Liquidity *(start)*: bid/ask spread at most 5% of mid (SPX spreads are wider than SPY), open interest at least 200.
- For each candidate the bot estimates the option price at the target and at the stop from its delta, gamma and theta, then picks the best expected reward vs risk after spread and fees, not the cheapest. **NEW:** it compares those estimates with what the option actually did, so the estimates can be corrected over time.

## Key levels (recalculated every day)

| Level | Source |
|---|---|
| **PDH / PDL / PDC** | Previous regular session (9:30-4:00) high, low, close |
| **PMH / PML** | SPY premarket high/low (4:00-9:30) |
| **ORBH / ORBL** | 3-minute opening range: high/low of 9:30-9:33 |
| **ATR Levels (Saty, Day mode)** | Pivot = PDC; daily ATR (14 *(start)*, to be matched to your chart); triggers ±23.6%, mid-range ±61.8%, full range ±100% (1 ATR); also ±38.2%, ±50%, ±78.6%; extensions ±161.8% and ±200% (2 ATR) |
| **VWAP** | Session VWAP from 9:30 |
| **EMA 21** | 10-minute EMA 21 as a moving support/resistance (the book's "dynamic level") |

When two levels sit within $0.15 of each other they count as one stronger level.

## Premarket read (before 9:30)

- Gap: open vs PDC, in ATR units.
- Premarket trend vs PDC and the ATR pivot; where price sits vs PMH/PML.
- Result is the **day bias hint**: bullish, bearish or neutral. It informs, it never forces a trade.

## **NEW** Your morning plan (read from your Discord plan channel, posted ~9:29)

| Post line | Bot use |
|---|---|
| `Upside: SPX 7620c \| SPY 760c` | **Call trigger** = SPY 760 (the SPY number is used; SPX is shown for reference) |
| `Downside: SPX 7520p \| SPY 750p` | **Put trigger** = SPY 750 |
| `VIX key level: 19` | VIX below = supports calls, above = supports puts |
| `If ... then ...` sentences | Scenarios: condition level, direction, ordered targets (PDC, HOD/LOD, PMH/PML, midrange, 10m ribbon / 21 / 200, ±1 ATR, plain prices) |
| "patience" / "no trade" wording | Patience day: A-grade setups only |

- Triggers and VIX are read with exact pattern matching; the if/then sentences by Cloudflare's free AI. The journal shows what was read each morning so you can correct it.
- **Flexible bias:** with your plan (above call trigger + VIX under key = bullish side active, and the mirror for puts) = normal score 80. **Against** your plan = A-grade only (90+ and 3:1). Between your triggers = your levels are the range edges.
- Your triggers and targets are added to the key levels and count as stacked confluence.
- No post by 9:33 = the bot trades its own rules only, tagged "no plan".

## **NEW** Plan review (after the close, in the journal)

Which trigger hit first and whether it held, how far each scenario got toward its targets, how your levels behaved,
what each idea would have made or lost, and every time the bot and your plan disagreed and who was right.
Over weeks: a scorecard of your calls (bias right %, triggers that held, scenarios that reached target 1 / 2).

## Your Saty setup (copied from your thinkorswim studies)

| Mode | Chart | Saty cloud | ATR Levels |
|---|---|---|---|
| Scalp | 1m + 3m, extended hours | 3m Pivot Ribbon Pro | Day levels (no separate scalp levels) |
| Day | 10m, extended hours | 10m Pivot Ribbon Pro | **daily**: PDC ± daily ATR (verified against your charts) |
| Swing | 1h, regular hours (bars from 9:30) | 1h Pivot Ribbon Pro | **monthly**: previous month close ± monthly ATR |

- **ATR Levels**: Wilder ATR 14 of the previous period, rounded to cents; trigger ±23.6%, levels ±38.2 / 50 / 61.8 / 78.6 / 100%, extensions to ±3 ATR. Trend label = close ≥ EMA 8 ≥ 21 ≥ 34 (bullish) or the reverse.
- **Pivot Ribbon Pro**: fast cloud EMA 8 vs 21, slow cloud EMA 13 vs 48; bullish = both up, bearish = both down, otherwise mixed.
  Long-term EMA 200 with 21-vs-200 bias; **conviction arrow** = EMA 13 crossing EMA 48; candle bias = close vs EMA 48.
- **Phase Oscillator**: ((close − EMA 21) ÷ (3 × ATR 14)) × 100, EMA 3, rounded as in the study.
  Crosses: leaving accumulation (−61.8) / extreme down (−100) = bullish; leaving distribution (+61.8) / extreme up (+100) = bearish.
  **Compression** = the study's tracker (Bollinger 21/2σ vs EMA 21 ± 2 ATR, expansion test at 1.854 ATR).
- **Compression Bangerz**: box = high/low of the first 3 compression candles; a close outside it = breakout.
- **Volume Stack**: buyers % = (close − low) ÷ (high − low) of the candle's volume.
- **Anchored VWAP** (hlc3) from the anchor in wrangler.toml (`AVWAP_ANCHOR`, now 2026-10-27 9:30) with ±1σ / ±2σ bands.
- **MTF 20/21 EMA clouds**: hourly and daily trend.
- **DTR**: today's range as % of the daily ATR; at 90%+ the day's move is mostly used (no chasing).

## Plans for any ticker

Post in the plan channel in the same format, one block per ticker (a heading line, then `Upside:` / `Downside:` / `If ...`).
Every post that day counts; a later post replaces an earlier one for the same ticker. An `SPX | SPY` block is read in SPY prices with your SPX strikes.

## Signals (#signals, 9:30-4:00 ET, every ticker every 2 minutes)

Tickers: SPY, SPX, TSLA, MU, META, AVGO, SPCX, MSTR, GOOGL, AAPL. Key levels per ticker: Day / Swing ATR levels, PDH/PDL/PDC, premarket, ORB, VWAP, anchored VWAP ±σ.

| Alert | When |
|---|---|
| 🐋 Whale | one contract trades $500k+ premium (SPX/SPY) / $250k+ (stocks) between checks; bought at ask / sold at bid; volume above open interest = new positions |
| 📈 Large move | ±1 / ±2 ATR from yesterday's close, or half an ATR in 15 minutes |
| 🚀 Momentum | fresh break of ORB / yesterday's high-low / ATR trigger or midrange, with VWAP side, 3m cloud and 2× volume agreeing |
| 🔄 Phase | 10m Phase Oscillator leaves accumulation / extreme down (bullish) or distribution / extreme up (bearish), with the nearest key level |
| 📉 VIX key | VIX 10m close crosses your plan's VIX key level (up = bearish for SPX, down = bullish) |
| ⚠️ Chop / ✅ trend back | Choppiness Index (10m) above 61.8 **and** the 10m cloud flipping (2+ in 6 bars) or 4+ VWAP crosses in the last hour; while choppy: no momentum alerts, only A+ |
| 📦 Compression breakout | 10m close outside the compression box (first 3 compression candles) |
| 🗜️ Squeeze fired | 10m compression ends with the 10m cloud pointing one way |
| 🗺️ Your plan | trigger crossed (with your posted contract's price), trigger failed, scenario set up, each target reached (Target 1 = bank half per the profit ladder) |
| ⭐ A / A+ | 3m Candlestick Bible pattern **at a key level** (mandatory), scored on: 3m cloud, 10m cloud, Phase Oscillator, VWAP, volume, Volume Stack (55%+ on the signal candle), hourly 20/21 cloud, room left (DTR under 90%), **VIX 10m moving the other way** (falling for calls, rising for puts), not choppy, options flow (net premium bought in 30 min: $1M SPX/SPY, $300k stocks), your plan. A ≥ 70, A+ ≥ 85; against your plan needs 95 |

Options flow counts prints of $100k+ (SPX/SPY) / $50k+ (stocks): calls bought or puts sold = bullish, puts bought or calls sold = bearish.
Limits: 4 large-move / momentum alerts per ticker per hour; each level alerts once a day. Schwab's API has no tick-by-tick options tape,
so flow is built from volume changes between checks.

## **NEW** Event days

You list scheduled events in the journal (FOMC, CPI, jobs report, big earnings like NVDA).

- 2:00 PM events (FOMC): no new entries 1:45-2:30; an open position is closed at 1:55.
- 8:30 AM events (CPI, jobs): normal rules, but the opening range counts only after 9:33 as usual.

## Session

| Time | Behavior |
|---|---|
| 4:00-9:30 | Track premarket, compute levels |
| 9:30-9:33 | Build the 3-minute opening range, no trades |
| **9:33-11:30** | Main window |
| 11:30-1:30 | A-grade setups only, tagged **midday** in the log so they can be compared |
| 1:30-3:00 | Second window |
| 3:00 | No new entries |
| 3:45 | Close everything |

## Direction (1-hour chart, completed candles only)

- **Bullish**: price above EMA 21 and EMA 50, Pivot Ribbon bullish (EMA 8 > 13 > 21) or just reclaimed with a completed bullish candle, price above the ATR pivot (or reclaimed it and held one candle).
- **Bearish**: the mirror image.
- **Neutral**: ribbon changed order 2+ times in the last 6 hourly candles, or signals conflict. Neutral = only the reversal setups (rejection, false break) are allowed.

## **NEW** Setup types (every trade is tagged with one)

| Type | Idea |
|---|---|
| Trend continuation | pullback into the ribbon (EMA 13 overlap) in the direction of the 1-hour bias |
| Level breakout | breaks a key level with the bias, retests or continues |
| Level rejection | tests a key level against the move, fails, reverses |
| False break | breaks a level, closes back inside; trade the opposite way |

Results are reported per type, so a type that doesn't work can be switched off on its own.

## Setup (10-minute chart)

- Pivot Ribbon Pro (EMAs 8, 13, 21, 48, 200) agrees with the 1-hour direction (continuation and breakout types).
- Price on the right side of VWAP (above for calls, below for puts), or just reclaimed/rejected it.
- Price is breaking or retesting a key level (ATR level, ORB, PDH/PDL, PMH/PML).
- **Room**: distance to the next key level against the trade is at least **2x** the stop distance.
- **Don't chase**: skip if price already covered more than half the way to the target.

## Confirmation (3-minute chart, completed candle)

| Pattern | Definition *(start)* |
|---|---|
| Engulfing | body covers the previous body and is at least 0.6x the average body of the last 10 candles |
| Pin bar | rejection wick at least 2x the body and at least 60% of the candle; closes in the outer third |
| **NEW** Morning / evening star | big candle, small candle (body under 30% of the first), then a candle closing past the middle of the first |
| **NEW** Inside bar | candle fully inside the previous one; counts when the next candle closes outside it (or breaks out and fails = false break) |
| False break | pokes through a key level, closes back on the other side |
| "Closes convincingly" | closes at least $0.10 beyond the level |

A pattern counts only **at a key level**. In the middle of a range it's ignored.

## Entry (1-minute chart)

- Calls: a completed 1-minute candle closes above the 3-minute confirmation candle's high.
- Puts: closes below its low.
- Skip if that close is so far past the trigger that the stop or reward/risk no longer works.
- Skip if quotes are older than 60 seconds or data is missing.
- **NEW** The setup expires if the 1-minute trigger doesn't come within 3 of the 3-minute candles (9 minutes).

## **NEW** Trade score (logged for every setup, taken or skipped)

| Part | Points |
|---|---|
| 1-hour direction agrees | 20 |
| 10-minute ribbon agrees | 15 |
| At a key level, more points for stacked levels | 25 |
| 3-minute confirmation quality | 15 |
| 1-minute trigger quality | 10 |
| VWAP agrees | 5 |
| Volume Stack agrees | 5 |
| Room to target beyond 2:1 | 5 |

- Minimum **80** to trade. **A-grade (midday) = 90+** and reward/risk at least 3:1.
- The score never overrides the hard rules: valid direction (or a reversal type), 3-minute confirmation, 1-minute trigger, levels available, risk within 15% of the account, reward/risk at least 2:1, no lockout, no open position.
- Saty Phase Oscillator (you have it in thinkorswim) is logged as extra information, not scored, until paper results show it helps.

## Exits (first one hit wins)

| Exit | Setting |
|---|---|
| Premium stop | about −30%, so a full loss = 15% of the account |
| Structure stop | SPY back through the retest level / confirmation swing |
| Target 1 | next key level, at least +60% on the option (2× the stop): **sell half** (1 of 2); the runner continues on the profit ladder below |
| Target 2 | the level after that (the 2 ATR extension if momentum continues): runner exit |
| Trailing stop | see the profit ladder below |
| Rejection | price reaches a level and gets rejected: exit, don't wait for the next one |
| Invalidated | the setup's reason is gone (e.g. ribbon flips against the trade) |
| **NEW** Scalp time stop | not at least +10% within 10 minutes: exit; 0DTE time decay works against a trade that doesn't move *(start)* |
| **NEW** Runner stall | runner makes no new high for 15 minutes: exit *(start)* |
| Time | 3:45 |

## **NEW** Profit ladder (stops only move up, never down)

| Option reaches | Stop moves to | Example: 2 contracts bought at $5.00 |
|---|---|---|
| entry | −30% | $3.50 (worst case −$300) |
| +25% | breakeven | $5.00: a trade that was up 25% can't become a loss |
| +50% | +20% | $6.00 (worst case +$200) |
| Target 1 (+60% or the next key level) | sell 1 contract; runner's stop to +30% | $6.50: whole trade finishes at worst +$450 |
| runner makes new highs | trailing stop: keeps **65%** of the runner's best gain, or sits under the last confirmed 1-minute swing low (calls) / high (puts), whichever is higher | runner peaks at $12.00: stop $9.55 |

- **Only 1 contract** (premium too high for 2): no split. At Target 1 the stop goes to +40% and the trail keeps **70%** of the best gain.
- Live mode: every step is also a real stop order at Schwab, moved up as the ladder climbs.

## **NEW** Protecting the day

- **Profit lock:** once the day is up **+10% of the account**, no new entries if the day falls below **half of its best P/L**.
- **Daily target:** at **+15% of the account** (the mirror of the loss limit), finish the open trade and stop for the day.

## Paper mode

- Buys fill at the **ask**, sells at the **bid** (conservative), plus Schwab fees.
- **NEW** Fills use the quote from the bot's next check (about a minute later), not the moment of the signal, so paper results include the delay real orders would have.
- Every decision is logged: trades taken **and** setups skipped, with the reason and score.
- Paper trades show in the journal, separate from real ones.

### How paper trading is built (src/paper.js)

- **It trades exactly what #signals posts:** every signal posted with a contract (any ticker), using that signal's contract,
  entry, stop and target. Signals that had no contract line (divergences, compression breakouts, squeezes) now show a "Contract idea"
  (nearest expiry, delta about 0.40; your posted contract when your plan has one), and that is what gets bought.
- **Entry:** A/A+ cards ("Entry on a 1m close above/below X") are bought when the ticker trades through X within 9 minutes, at that minute's ask.
  All other signals are bought right away at the ask of the quote the signal was built from.
- **Exits:** the profit ladder above, plus the signal's own stop level on the ticker and its target level (counts as target 1).
- One position at a time, so the first valid signal of the moment gets the trade; the rest are logged as skipped.
- Not modeled yet: the "ribbon flips against the trade" and "rejection at a level" exits (an opposite signal closes the trade instead).
- Every decision is in the journal's Bot view (Paper trading) and every entry/exit is posted to #signals as 📄 PAPER.

## **NEW** Self-training (src/learn.js, every day 4:10-4:30 PM)

| What it learns from | |
|---|---|
| Every scored signal | traded or not, so a switched-off setup keeps being measured and can come back |
| Paper trades | real option results, counted double |
| Each paper trade's option price path | followed for 30 minutes after the exit, so other exit settings can be replayed |

| What it changes | Rule |
|---|---|
| Setup families on/off | off after 15+ results from 3+ different days averaging below −0.15R (averages are shrunk toward 0 so a few results can't decide); back on above 0R |
| Context adjustments | time window, chop, gamma regime, with/against your plan, VIX agreement: each adds or subtracts expected R (8+ results needed, at most ±0.5R) |
| Minimum A/A+ score | 70 → 80 → 90 when lower score bands lose money; lowered again when they recover |
| Exit settings | stop (−20/−25/−30%), target 1 (+40/60/80/100%), time stop (10/15/20 min): fitted on the older 70% of trades, kept only if also better on the newest 30% (needs 20+ trades) |

- It can **never** change: the −30% maximum stop, 15% maximum loss, sizing, daily limits, entry window.
- Changes are posted to #signals (🧠 Bot learning) and listed in the journal; a weekly paper report posts on Fridays.
- In live mode, learned changes will need your approval before they apply.

## **NEW** Live mode (only after paper; switched on by you)

- Entries use limit orders at or just through the ask, raised in small steps a limited number of times, then cancelled.
- Every order is checked for an actual fill; nothing is assumed filled because it was sent.
- The -20% premium stop is also placed **at Schwab** as a real stop order, so the position is protected even if a bot check is late or Cloudflare has a problem.
- Each run first compares the bot's records with the real Schwab positions and orders; any mismatch stops new entries and is reported.
- Kill switch in the journal: cancels open orders, closes the position, blocks entries for the day.
- Schwab app Order Limit stays 0 until this point, so Schwab itself blocks real orders during paper.

## **NEW** Alerts

Optional free phone notifications (ntfy app): entries, exits, lockouts, errors, and a warning if the bot misses its checks.

## **NEW** Testing stages

1. **Levels check**: you compare the bot's levels, ribbon and VWAP with thinkorswim for a few days.
2. **Replay**: the same bot code runs over the past weeks of SPY 1-minute candles, which gives dozens of example trades in days instead of months. Past option prices aren't available, so replay estimates them; it tests the signals, not exact P/L.
3. **Paper**: at least 30 sessions with live quotes.
4. **Live**: 1 contract first, then 2, with every safety above on.

Rules are not tuned to the best past profit: changes are checked on days that weren't used to make them.

## **NEW** Weekly report (in the journal)

Win rate, average win and loss, profit factor, expected P/L per trade, worst day and drawdown, and results split by
time window, setup type, score band, delta, and exit reason, plus estimated vs actual slippage.

## Known limits

- The bot checks once a minute. Stops and entries can be up to about a minute late, so expect some slippage (live mode adds the broker stop as protection).
- It calculates the indicators itself from Schwab's candles; compare its levels with your thinkorswim chart before trusting them.
- Planned loss is not a guarantee: fast markets can blow through a stop.

## SPX greek exposure board (journal sidebar, every 5 minutes)

- Per strike, 0-3 day expirations, 40 strikes around spot: **GEX** (gamma × OI × 100 × spot² × 1%, calls +, puts −), **DEX** ($ delta),
  **Vanna** ($ delta per +1 IV point, Black-Scholes), **Charm** ($ delta change per day, Black-Scholes).
- **Call wall** (largest positive GEX), **put wall** (largest negative), **gamma flip** (where total GEX changes sign), **Eye of Sauron**
  (a negative-GEX node within ±1.5% of spot at least 2× the next one: magnet, then often a violent rejection; alert within 0.15%).
- Open interest is last night's. Schwab gives no SPX open interest, so the board uses SPY options mapped to SPX strikes until it does.
- Walls, flip, Eye and the 3 biggest nodes are key levels for SPX/SPY signals.

## Leaderboard (LB)

- Top 10 SPX 0DTE contracts by volume, each with its own VWAP (from volume changes between 5-minute snapshots).
- Holders 20%+ in profit vs VWAP = **shakeout candidate** (calls: a dip to shake them; puts: a pop). An LB shakeout on the setup's side adds ✓ to A/A+ checks.
- **Max pain for in-the-money LB holders** (volume-weighted), shown all day; alert at 3:50 for the last 10 minutes.

## Your scalp setups (SPX)

| Setup | Detection |
|---|---|
| 1m / 3m divergence | price higher high + Phase Oscillator lower high (bearish), or lower low + higher low (bullish); pivot = 2 bars each side, newest within 6 bars |
| 1m / 3m compression | compression box (first 3 compression candles) broken by a close |
| S/D reversal | Candlestick Bible pattern at a key level, including GEX levels; LB shakeout lining up adds a ✓ |
| Eye of Sauron | see the greek board |

## Training the bot (post in #spx-training; #spx-plan also works)

- **#spx-training** is read every 5 minutes (weekdays 4:00-16:20 ET), all recent posts; already-stored posts are skipped.
- A **chart on its own** is stored as "chart (needs details)"; **reply** to it with the setup text and/or `Result: ...` and the bot merges them.
- **Chart images are read** by Cloudflare's built-in vision model (Llama 4 Scout, free daily allowance; one image per 5-minute check):
  ticker, timeframe, chart date, direction, setup name, candle patterns, drawn levels with labels, indicator values, your annotations, and a summary.
  What you write always wins; the image only fills what the text didn't say. It reads labels and drawings well and judges candle patterns only roughly.
- Posts made outside market hours (or picked up more than 15 minutes later) are marked **late**: their market snapshot is from when the bot read them.


Start a message with **Setup:**, **Idea:**, **Lesson:** or **Trade:**; add the chart image if you like. Example:

```
Setup: SPX 7620c calls, bullish engulfing at PDC, 10m cloud green, VIX falling. Entry 10:42 #engulfing #pdc
```

Later, **reply to that message** with `Result: +65%` (or `win`, `loss`, `-30%`, `breakeven`), or edit the post to add it.
The bot reads the ticker, contract, direction, entry time, result and #tags, and stores a snapshot of the market at that moment
(clouds, Phase Oscillator, VIX, chop, DTR, nearest levels, VWAP side, your plan's side, gamma levels). Once there are enough
results, the weekly report compares winners with losers and suggests scoring changes; nothing changes without your OK.
The bot can't read the chart image itself; the words and #tags carry the setup.
