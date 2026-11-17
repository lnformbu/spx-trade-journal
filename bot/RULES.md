# SPX 0DTE scalping bot: rules

Paper trading only until you switch it to live yourself. All times Eastern.
Numbers marked *(start)* are starting values to tune from paper results. **NEW** marks additions from the review.
SPY is read to gauge SPX (it has volume and premarket); trades and levels are shown in SPX.

## Money (scales with the account)

| Rule | Setting | Example: $25,000 account |
|---|---|---|
| Account | paper account (your starting amount; example $25,000), follows the bot's own P/L (one 0DTE SPX contract costs ~$1,700-2,500) | $25,000 |
| Position size | **50% of the account ÷ 3 slots** in premium: contracts = account × 16.7% ÷ (price × 100), at least 1 | ~$4,150 (e.g. 6 × $7.00) |
| Max loss per trade | **15% of the account ÷ 3 slots** (premium stop at **−15%**: cut losers fast), including fees and slippage | $1,250 cap (3 × $7 contracts risk ~$420) |
| **Max contracts per trade** | **3** (user 2026-11-16) | |
| Daily loss lockout | **20% of the account**, realized + open risk; checked *before* each entry (daily profit stop +25%) | $5,000 |
| If one contract alone costs more than 50% or risks more than 15% | skip the trade | |
| Max trades per day | 20 | |
| Max consecutive losses | 4, then done for the day | |
| Max open positions | **3** at once, never calls and puts on SPX at the same time; each takes one slot: 50% ÷ 3 of the account in premium and 15% ÷ 3 risk, and all open risk counts against the day's 15% loss budget | ~$4,150 premium / $1,250 risk per position |
| Cooldown after a loss | **none** (training: removed 2026-11-16) | |
| **NEW** Same level after a stop-out | no second entry in the same direction at the same level that day | |
| Never | average down, add to a loser, widen a stop, re-enter out of revenge | |

## Instrument

- **SPX 0DTE** long calls and long puts (same-day expiry, cash-settled).
- **Price band $5-9** (wrangler.toml `CONTRACT_BAND`): an SPX alert contract priced outside it is swapped for the same-expiry strike whose ask is closest to $7, never past ±1 ATR. The post shows "💵 Price band" and the paper account buys that contract.
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

Add a line to your morning plan post: `Event: FOMC 2:00` or `Event: CPI 8:30` (several lines are fine; without am/pm, 1:00-7:59 means afternoon).

- Events during the session (e.g. FOMC 2:00): no new paper entries from 15 minutes before to 15 minutes after; an open position is closed 5 minutes before.
- Events before the open (e.g. CPI 8:30): only A+ setups until 9:45.

## Session

| Time | Behavior (see "Opening: both rules" below) |
|---|---|
| 4:00-9:30 | Track premarket, compute levels |
| 9:30-9:33 | Build the 3-minute opening range, no trades |
| **9:33-11:30** | Main window |
| 11:30-1:30 | **all setups traded** (training: user 2026-11-16), tagged **midday** in the log so they can be compared |
| 1:30-3:55 | Second window, including power hour |
| 3:55 | No new entries |
| 3:59 | Close everything (0DTE never held into the 4:00 settlement) |

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
| Trailing stop | **once the option is +20%**, the stop trails the best price keeping 60% of the gain (breakeven already at +15%) |
| Target 1 | **+40%** on the option or the signal's target level: **sell 1 of 3** (half when 2); the rest trails keeping 75-80% of the best gain, out after 15 min with no new high (let winners run) |
| Target 2 | the level after that (the 2 ATR extension if momentum continues): runner exit |
| Trailing stop | see the profit ladder below |
| Rejection | price reaches a level and gets rejected: exit, don't wait for the next one |
| Invalidated | the setup's reason is gone (e.g. ribbon flips against the trade) |
| Structure / flow exits | **3m 8/21 cloud turns against** the trade · **1m cloud against for 3+ min while red** · **0DTE volume flow spikes on the other side while red** (structure and flow, not a clock; user 11/16) |
| Time stop (backstop) | **only a losing trade**: still red after **15 minutes** and never +10%: exit (green trades are left to the trailing stop; 11/16 two green time-stops ran to +31% and +45%); 0DTE time decay works against a trade that doesn't move. Breakeven stop at +15%, at +25% the stop goes to +10%, trail keeps 75-80% of the best gain, runner out after 8 min with no new high |
| **NEW** Runner stall | runner makes no new high for 15 minutes: exit *(start)* |
| Time | 3:59 |

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

- **SPX only for now** (wrangler.toml `PAPER_TICKERS = "$SPX"`): SPX signals, and SPY signals whose contract is your posted SPX contract.
  Other tickers are added once the SPX results show it works.
- **It trades exactly what #signals posts:** every signal posted with a contract, using that signal's contract,
  entry, stop and target. Signals that had no contract line (divergences, compression breakouts, squeezes) now show a "Contract idea"
  (nearest expiry, delta about 0.40; your posted contract when your plan has one), and that is what gets bought.
- **Entry:** A/A+ cards ("Entry on a 1m close above/below X") are bought when the ticker trades through X within 9 minutes, at that minute's ask.
  All other signals are bought right away at the ask of the quote the signal was built from.
- **Exits:** the profit ladder above, plus the signal's own stop level on the ticker and its target level (counts as target 1).
- One position at a time, so the first valid signal of the moment gets the trade; the rest are logged as skipped.
- Also exits on: **rejected at a level** (the ticker reached a key level beyond the entry, then gave back half the move while the option is green),
  **10m Saty cloud flipped** against the trade since the entry, and an opposite signal on SPX/SPY.
- **Contracts follow price:** when a signal uses your posted contract and price has moved so far that its delta is outside 0.30-0.65,
  the post switches to the same-expiry strike nearest delta 0.45 (marked ↪️ Adjusted) and the paper trade buys that one.
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
| Exit settings | stop (−10/−15/−20%), target 1 (+30/40/60/80%), time stop (4/6/10 min), scalp-centred: fitted on the older 70% of trades, kept only if also better on the newest 30% (needs 20+ trades) |

- It can **never** change: the −30% maximum stop, 15% maximum loss, sizing, daily limits, entry window.
- Changes are posted to #signals (🧠 Bot learning) and listed in the journal; a weekly paper report posts on Fridays.
- In live mode, learned changes will need your approval before they apply.

## **NEW** Style challengers (the bot finds its own trading style)

Your rules are the **champion** and trade the paper account. Alongside, **challengers** trade the same SPX signals at the same moments,
each with one change and its own $25,000 paper book (silent: no Discord posts, shown in the journal):

| Challenger | Change |
|---|---|
| Runner | target 1 at +100%, trail keeps 70-75%, runner allowed 25 min without a new high |
| Quick scalp | −20% stop, target 1 at +30%, breakeven at +15%, 6-minute time stop |
| Delta 0.30 / 0.55 / 0.70 | buys the SPX 0DTE contract nearest that delta instead of the posted one |
| Skip midday | A-grade only 11:30-1:30 (the old rule), to compare with trading midday |
| Mornings only | entries 9:33-11:30 only |
| Size down weaker setups | 25% of the account instead of 50% when the learned edge is under +0.2R |

- **Takeover (automatic, paper only):** checked every night. Over the same 20+ sessions a challenger needs 15+ trades, more P/L than the champion
  by a clear margin (at least $50 or 10%), a profit factor at least as good, and a worst drawdown no more than 1.25× the champion's (or $200).
  The best qualifying one becomes the champion, 🏆 is posted to #signals, and a new set of challengers is built around the new style.
- After a takeover, SPX "Contract idea" lines in #signals use the champion's delta, so the posts and the paper trades stay the same.
- Every style keeps the hard limits: 15% max loss per trade, −30% stop at most, daily loss limit and lockouts, one position, 3:59 close.
- Live mode: a new style is never applied to real money without your approval.

## **NEW** More ways the bot learns

| Source | How |
|---|---|
| **Replay** (`node scripts/replay.mjs <bot url> 45` on your computer) | Runs the SPX signal rules over the last ~45 sessions of 1-minute data and scores each signal like the live scorecard. Learning uses them at half weight. No past options flow, LB, VIX, gamma or plans, and no option prices (results are in R on SPX). Re-run it every few weeks. |
| **Your #spx-training posts with a result** | "Result: +65%" = +65 ÷ 30 = +2.2R (win = +1R, loss = −1R, BE = 0). Counted at 1.5× weight; the market snapshot from when you posted adds context (only if posted within 15 minutes of the trade). |
| **Your reactions on #signals** | ✅ 👍 🔥 = good call, ❌ 👎 = bad. Each setup type gets up to ±0.3R from your votes. Needs the bot's **Read Message History** permission in #signals. |

## **NEW** SPX focus and the VIX rule

- **SPX first:** SPY is only a gauge for SPX. SPY's own setups are not posted (SPX has the same scan); your plan alerts still track SPY prices and show SPX.
- **VIX moves opposite SPX:** VIX falling on 10m supports SPX calls, VIX rising supports SPX puts.
  - VIX **trending against** the trade (its 10m cloud points the wrong way AND the last 10m bar kept going that way): **not posted, not paper traded**.
  - VIX only **ticking against** (one 10m bar, cloud not turned): posted and traded, marked "⚠ ticking against"; learning tracks how these do.
  - VIX **mixed** (no clear 10m direction): posted, marked "not confirming yet".
  - Your plan alerts always post (they're yours), but a plan trigger with VIX against isn't paper traded.
- Every trade signal ends with **Why:** in plain words (what the setup means) plus ✓ / ✗ for VIX, the 10m cloud, trend vs chop and your plan.
  Paper buys repeat it as **Why taken**.
- The Bot desk opens with a one-line lean: **Lean CALLS** when VIX is falling and the SPX 10m cloud is bullish, **Lean PUTS** for the mirror, otherwise **No clear lean**.

## **NEW** Posts and alerts

- **Scorecard (journal):** each signal shows its contract, the option price when it triggered (ask) and when it was scored (bid, up to ~2 min late) and the option %; the score (R) stays on SPX so signals are comparable whatever strike was used.
- **A/A+ cards** read top-down: what to buy · entry / stop / target · the candle and level · ✓ what agrees · ✗ what doesn't.
- **🏁 LB shakeout watch:** a top-5 leaderboard contract 20%+ above its VWAP, with the level stack to watch and step-by-step notes. It's a heads-up, not an entry (not paper traded).
- **🎯 LB max pain** (3:50) now says which side to favor and to stay flat against the pull.
- **🗓️ Daily recap** (about 4:10 PM): paper trades, best challenger, signals scored by type, your plan review, your reactions, what was learned.
- Paper trades (📄 buys, target 1, exits), 🏆 takeovers, 🧠 learning, 🗓️ recaps and warnings all post to #signals; turn on Discord notifications for that channel on your phone.
- **Optional** extra phone push (free ntfy app), off unless set up with `node scripts/keys.cjs ntfy`.

## **NEW** From the Saty training notes (SPX, 3-minute focus)

| Piece | What the bot does | Replay (last ~20 sessions, R on SPX) |
|---|---|---|
| **3m first** (you scalp the 3m) | 1m divergence / compression signals only when the 3m ribbon agrees | 1m divergence +0.06R → **+0.43R**; 1m compression +0.08R → **+0.18R** |
| **Trend mode** | 10m ribbon (2 pts), 3m ribbon, holding beyond the ORB, beyond the call/put trigger, through the Golden Gate, 1h cloud, VIX trending the other way, 50%+ of ATR used (max 9). 6+ with the 10m ribbon and the trigger on that side, not choppy, from 9:45. Lasts 60 minutes unless re-confirmed. | Right 72-79% over the **next 30-60 min**, only ~50% to the close, so it is a trend *window*, not a whole-day call. Signals with it +0.11R, against it +0.06R. |
| **Never fight trend mode** | Signals against an active trend mode are posted but not paper traded (except a confirmed Vomy) | |
| **🎯 21 EMA pullback** | Stacked 3m ribbon, price came from beyond the 8, a 3m bar dips into the 21 / 8-13 zone without losing the 48 and closes back past the 13. Entry: 1m close past that bar; stop: half a 3m ATR beyond the 21 zone; target: Golden Fib if the Gate was crossed, else the next ATR level. **The 1h cloud must agree.** Confluence shown: trend mode, stacked 21s (10m / 1h / daily), quiet pullback (SPY volume), VIX, Golden Gate. | Without the 1h filter −0.04R; **with it +0.06R, 57% wins**. The quiet-pullback (low volume) read did *not* help (shown, not required). |
| **🤮 Vomy / 🐬 iVomy** (Saty's way) | The **10m** confirms it (ribbon stacked 6+ bars, then 2 closes through the 48) → heads-up post. Within 40 min, a **3m** bar retests the 13 EMA and is rejected → the trade (stop: a close back through the 13). | Tested 4 versions: 3m only −0.08R (115), 10m only −0.03R (19), 3m 13-retest only +0.01R (439), **10m confirm + 3m 13 retest +0.72R, 75% wins (20)**: small sample, watching it |
| **🚪 Opening range break** | Two 3m closes beyond the 9:30-9:33 range with the 10m ribbon agreeing (first time today, before 10:30) | 11 trades, 64% wins, −0.04R: flat so far |
| **🌉 Golden Gate** | Heads-up when SPX crosses ±38.2% ATR (about 60% reach ±61.8%); pullback entries then target the Golden Fib | |
| **🌅 Opening read** (9:40) | Open vs the trigger box (at the call trigger → often back to PDC, sometimes the put trigger), auto VIX pivot (Day ATR level nearest VIX, rounded to 0.5: VIX above = bearish SPX), trend check | |
| **🗡️ Highlander** (3:45) | Top 2 leaderboard contracts: under 100k volume they usually die into the close → favor the side that kills them; 100k+ often finish in the money | |
| **Key levels** | 3m, 10m, 1h and daily 21 EMAs added (A/A+ cards can fire at them) | |

**Opening: both rules.** 9:30-9:33 the opening range forms (no trades). 9:33-10:00 is the **opening window**: only ORB breaks and A+ cards are traded; everything else posts as ⏳ watch-only (Saty: don't trade the first 10 minutes). From 10:00 normal rules. Replay: the window skipped 55 signals worth −11.6R (avg +0.112R → +0.124R per signal; a plain no-trades-before-9:40 rule only reached +0.113R).

Not built (from the notes): TTM Squeeze (Bollinger inside Keltner) as a separate indicator: the Phase Oscillator compression already plays that role; the Monday-buy/Thursday-sell calendar test was run separately (not a bot strategy).

## **NEW** PDF 5 ("Putting it all together"): chart study and what was built

| Chart | Entry / exit and why | Built? (replay) |
|---|---|---|
| SPY day mode | Opened at the put trigger → tested the call trigger → back to the previous close (trigger box). Then reclaimed the call trigger with the ribbon stacked; pullbacks only reached the **8/9 EMA**; rode to **+1 ATR**. Entry: the 8 EMA test; exit: full range; stop: losing the ribbon. | **🏄 8 EMA ride** in trend mode: 212 trades, 51% wins, **+0.51R** (+0.10R even without the 3 best days). Built. |
| NVDA 10m calls | Blasted through the call trigger, **retested it** as support → entry; exit +1 ATR. 10:45 retest of the midrange → second entry; out at +1 ATR, no holding into consolidation. | **Level break-and-retest** as its own trade: 215 trades, **−0.10R** (−0.43R against the trend). Not built. |
| CAR 10m puts | Lost the put trigger, retested it from below until 10:00 → puts; exit at midrange or −1 ATR (~1.5 h). | Same retest rule: not built. |
| Swing / Position (daily, weekly) | Ribbon green + price above it + hits the call trigger, often with a squeeze; profit at midrange / +1 ATR; exit at consolidation; re-enter at the next trigger hold. | **🧭 Swing alerts (calls only)**, below. |

### 🧭 Swing alerts (SPY, days to weeks, calls only)

Checked once a day after the close. Entry at the next open; target 1 = monthly midrange (sell half), target 2 = +1 monthly ATR;
stop = a daily close below the 21 EMA; time exit after 20 trading days; contract idea SPY 30-45 DTE, delta ~0.70.

| Setup | SPY 10-year backtest |
|---|---|
| Baseline: buy any day the daily ribbon is stacked | 174 trades, +0.08%, PF 1.10 |
| Monthly call-trigger break (ribbon stacked) | 63 trades, 54% wins, **+0.32%**, PF 1.43 (both halves positive) |
| Daily 21 EMA pullback | 63 trades, +0.22%, PF 1.33 (PF 1.52 with VIX < 20) |
| Daily squeeze fire near the 21 EMA | 34 trades, +0.51%, PF 1.92 (weaker in recent years) |
| Any put swing | all lost (PF 0.2-0.6): not used |

## **NEW** PDF 6 (Vomy): chart study and what was built

Saty's annotated SPY 10m chart: (1) clear trending ribbon, price makes "fins" into resistance (double top); (2) the 8 curls into the 13, the 13 flattens;
(3) first entry = the **13 EMA retest** holding as resistance (risk: a close back above it); (4) the 48 acts as support first; (5) consolidation in the ribbon,
8-13 tests also work; (6) **break and hold of the 48 confirms**; (7) exits at ATR levels, puts also gain from VIX rising. "Ultimate scenario": squeeze, momentum turning, RSI extreme.

| Tested | Result |
|---|---|
| Entry versions | 3m only −0.08R · 10m only −0.03R · 3m 13-retest +0.01R · **10m confirm + 3m 13-retest +0.72R** (live) |
| + momentum turning with the trade (Phase Oscillator) | helps in both samples (retests +0.02 vs −0.12R; live version +0.82 vs +0.32R) → **required** |
| + squeeze in the last 15 bars | mild plus (+0.02 vs −0.05R) → shown as confluence |
| + RSI overbought / oversold | no help (−0.04 vs +0.03R) → not used |
| + fins at a key level | **hurt** (−0.08 vs +0.10R) → not used |

Live Vomy now: 16 trades, 75% wins, **+0.82R** in the replay (small sample).

## **NEW** Kill the Leaderboard (your EOD framework + Saty's EOD cards)

Data the 5-minute options job now adds: **tax list** (0DTE leaderboard names with 100k+ volume and last ≥ 20% above their own VWAP),
**0DTE gamma per strike** (calls +, puts −, sized by max(open interest, volume)) with an hour of history → the **strike gaining gamma**
over the last ~30 minutes, positive-gamma nodes, negative nodes; plus the existing call/put walls, max pain and Eye of Sauron.

Posts in #signals:
- **3:30 🎯 EOD PLAN**: board populated (tax list + which holders get shaken → kill direction) or empty (pin on the growing node);
  walls = the range (don't plan beyond them); likely pin (growing gamma → max pain → max-gamma strike); the fakeout to watch; risk rules.
- **3:30-3:45 🔁 EOD FAKEOUT FADE**: SPX ran opposite the kill into a positive-gamma node / key level and the 1m candle rejects it → fade toward the pin (ITM/ATM).
- **3:40 🗡️ FINAL 20**: the real shake: pin, distance, top contracts (100k+ often finish ITM, under 100k usually die), trade the path with ATM/ITM. Replaces the old 3:45 Highlander note.
Risk (on every EOD post): profits only, size for zero (premium = max loss, no stop), limit orders, targets in advance (½ at +100% or ⅔ at +50%, ¼ at +200%, runner for the cash-settle).

Not backtested (no history of option volume or 0DTE gamma), so: the fakeout fade is **watch-only** for now, every day's plan is saved
("eod:plan") and scored at 4:10 against the close (pin error, inside the walls, kill direction right, did the shaken names die) in "lb:hist".
Paper account: after 3:30 a style only enters if its day is green (profits only), still A/A+ cards only.

## **NEW** Data pool (CSV history, recorded every 5 minutes in market hours)
The bot keeps a permanent record per day in its database (`hist:day:<date>`), and `scripts/pull-history.mjs` (or double-click
`files/pull-data.cmd`) copies everything into CSV files in `files/data/`, adding new days and keeping all old rows:

| File | What | When |
|---|---|---|
| board.csv | SPX spot, gamma flip, call/put walls, Eye of Sauron, max pain + zone, biggest / growing 0DTE gamma strike, positive / negative gamma nodes, 0DTE call/put volume, tax list | every 5 min, 9:30-4:00 |
| lb.csv | top-10 SPX 0DTE contracts: volume, last, own VWAP, % vs VWAP, ITM | every 5 min |
| eod.csv | top-3 contracts at the close (ITM or not), EOD plan (kill direction, pin, walls) vs the close | daily |
| signals.csv / paper.csv | every scored signal / paper trade | as they finish |
| spx_1m.csv, spy_1m.csv, spx_daily.csv | 1-minute candles (Schwab only keeps ~48 days, so the pool is the only long record), 3 years daily | each pull |

Run the pull at least once every ~6 weeks (the 1-minute candles expire after that); daily is best. Online: `GET /export?kind=board|lb|eod|signals|paper&from=&to=` (admin key).

## **NEW** Levels are zones, not exact prices
* Your thesis levels count anywhere within **±5 SPX points** (7730 resistance → a rejection at 7728 counts). Per level or for the
  whole post: add `"zone": 3` to the level (or the thesis) to change it.
* Take-profits on **your** levels sit in front of them by 40% of the zone (7730 → TP 7728). The bot's own levels stay exact:
  replay (2,322 trades) with TPs 0.01 ATR in front was slightly worse (all 0.191 → 0.187R, core 0.473 → 0.458R), because most
  ATR levels get tagged anyway and the earlier exit gives up a little each time.
* The bot's own levels already count within 0.05 ATR (~3 points) for the ⭐ cards; the EOD fakeout fade now uses its zone too.
* Tested on 1-minute bounces at the bot's ATR / PDH / PDL / ORB levels (32 sessions): exact ±0 gross +0.02R, ±2 −0.02R, ±5 +0.02R.
  Wider zones did not make bounces better; they only found more of them (1.4 → 14.6 a day). So the zone is for **not missing a
  real reaction at a hand-picked level, and not missing a take-profit by a point**; it does not make a level worth trading by itself.

## **NEW** 1-minute scalping test (`scripts/scalp-test.mjs`, entries and exits on 1m only)
Signal on a closed 1m candle, fill at the next open, stop/target inside the candle (both touched = stop), one trade at a time,
30-min limit, cost 0.6 SPX pt per round trip (option spread + slippage). 32 sessions, 10/1-11/13:

| Entry | Best exit | Trades/day | Net R | PF |
|---|---|---|---|---|
| EMA 8/21 pullback | 2R | 6.3 | −0.00 | 1.00 |
| VWAP reclaim | 1R | 2.0 | −0.05 | 0.89 |
| **20-bar breakout (8>21>48)** | **2R** | 8.7 | **+0.06** | 1.12 |
| Level bounce (±0 / ±2 / ±5) | ½ at 1R + trail | 1.4-14.6 | −0.09 to −0.20 | 0.68-0.84 |

* Costs decide 1m scalps: before costs the pullback made +0.14R and the breakout +0.17R; the 0.6 pt spread takes most of it,
  because 1m stops are only 3-7 points. Tight-stop scalps (level bounces, ~3 pt risk) lose after costs.
* **The one that held up: 20-bar breakout before noon, 2R target**: 99 trades, +0.24R net, PF 1.55, both halves positive
  (+0.32 / +0.16), still +0.18R at 1.0 pt cost, 19 of 31 days green. After noon it fails (12-2 +0.02R, 2-3:50 −0.09R).
* Verdict: a plain 1m scalp is not better than the core playbook (+0.32R, PF 1.84). The morning breakout is worth forward-testing;
  the time cut was found in this same sample, so it needs new days before it trades.
* **Built (watch only):** ⚡ SPX 1m BREAKOUT SCALP, 9:35-12:00, family `bo1m`: entry at the signal close, stop past the 1m 21 EMA
  (1.5-15 pts), target 2R, out within 30 min, 10-minute pause after each one. Live rule on the same data: 152 trades, +0.24R net.
  It posts in #signals and gets scored; the paper account trades it only after 15+ scored results over 3+ new days stay positive.

## **NEW** Take-profit ladder and trade follow-ups (SPX)

Every SPX trade signal now carries a **Take profits** line:
- **TP1** = the signal's own target (or the first real level ahead): **sell ½ and move the stop to entry** (risk-free).
- **TP2** = the next level in the trade's path: **sell ¼**.
- **Runner** = the level after that; trail the last ¼ under the 3m 21 EMA.
Levels used: Day ATR levels, your weekly thesis levels, quarterly (Position) levels, daily 21 / weekly 21 / daily 200 EMA, high/low of day,
at least ½R away and spaced apart (falls back to 2R / 3R when nothing is in range).

The bot then **replies under the original signal** as the trade plays out:
▶️ TRIGGERED (for entry-on-a-close signals, with the ladder) · 💰 TP1 HIT (sell half, stop to entry) · 💰 TP2 HIT (sell a quarter) ·
🏁 RUNNER TARGET HIT / RUNNER OUT (close below the 3m 21 EMA) · 🛑 STOP HIT · ↩️ BACK TO ENTRY after TP1 · ⏳ NOT WORKING (no TP1 in 60 min) · ⏰ 3:55 CLOSE.
Watch-only signals get the ladder for reference but no follow-ups. The paper account keeps its own (learned) exits.

## **NEW** Your weekly bigger-picture thesis (#spx-training)

Your weekly post (daily chart, Position/quarterly ATR levels, weekly 21 and daily 200 EMA) is saved as the bot's thesis ("bot:thesis").
- The bot now computes the same bigger-picture levels you use: quarterly (Position) ATR levels, daily 200 EMA, weekly 21 EMA (checked against your
  thinkorswim chart: Q pivot 7651.54, Q put trigger 7510, Q Golden Gate 7423, D21 7603.6, W21 7552.71, D200 7366.7).
- Your levels (e.g. 7500 support, 7300-7400 demand, 7760 / ATH supply) are key levels for alerts and for the paper trader's "rejected at a level" exit.
- Every SPX signal says when it runs into one of these levels before its target ("⚠ runs into your 7500 support first").
- The 9:40 opening read lists your scenarios for the week.
- Swing (monthly) levels now use 10 years of monthly data, so they match thinkorswim more closely.

## **NEW** PDFs 1-4 (ATR Levels, ATR day-trading checklist, Pivot Ribbon, Phase Oscillator)

| PDF | Claim tested | Result | Built |
|---|---|---|---|
| 1 ATR Levels | Opening inside the trigger box = range-bound day | only 26% stay inside (range 0.82 vs 0.98 ATR) | no |
| 1 | Range label: 70% / 90% of ATR used = little room left | ranges kept extending ~0.4-0.5 ATR more | no (as a stop rule) |
| 1 | Trigger-break template (½ at midrange, rest at ±1 ATR) | +0.14R (99); with the 10m 34/50 trend −0.03R | no |
| 1 | **±1 ATR snap-back** (touch ±1 ATR, first close back inside, target the midrange) | SPY 5m 34 trades +0.69R; SPX 3m-10m +0.85..+1.00R; SPX replay 9 +0.56R. Fading +1 ATR (puts) strong, bouncing off −1 ATR (calls) weak | 🪃 **SNAP-BACK**: puts traded (allowed against trend mode), calls watch-only |
| 2 Day-trade checklist | 10m close past the trigger + 34/50 trend + < 70% ATR used, then the 8/21 EMA pullback; stop past 34/50, target midrange | SPY 10m 106 trades 57% **+0.29R** (+0.23R without the 70% rule), SPX 10m 14 +1.42R, SPX replay 12 trades 75% +1.02R; on 3m only +0.12R | ✅ **10m CHECKLIST** (10m chart, as Saty trades it) |
| 2 | "0-3 trades a day" | the first 3 signals of a day were the worst (−0.07R); quality matters, not order | core playbook ⭐ instead |
| 3 Pivot Ribbon | Daily conviction arrow (13/48 cross) | next 20 days +1.83% (82% up) vs +1.07% any day, but as a swing with the bot's management PF 0.76 (9) | no |
| 3 | 10m conviction arrows | no edge (next 60 min ≈ flat), as Saty warns | no |
| 4 Phase Oscillator | Divergence from past ±61.8 = reversal, inside = pullback | 3m: inside −0.21R (46) vs past +0.02R (29); 1m: inside +0.19R vs past ~+1.1R (8) | 3m divergences inside ±61.8 watch-only, zone shown in the post |

## **NEW** Whole-system review (replay, every rule applied, Oct-Nov 2026, 33 days)

| Version | Result |
|---|---|
| All tradable families, no filters | 1,801 signals, 49% wins, +0.16R, PF 1.32 |
| With every current rule | 1,334 signals, 50%, **+0.22R**, PF 1.46 |
| One position at a time (30-min hold) | 8.8 trades/day, +0.16R, PF 1.35, 18 of 33 days green, +47R total, worst day −5R, max drawdown −12R |
| **Core playbook only**, one at a time | 4.9 trades/day, 57% wins, **+0.32R, PF 1.84** (first half +0.54R, second half +0.12R) |

Core playbook (⭐ in Discord): Vomy, 8 EMA ride, 10m checklist, ±1 ATR snap-back (puts), 1m divergence, Golden Gate pullback/go, 21 EMA pullback.
Still losing after every rule → no longer paper traded (watch only): momentum breaks (−0.36R, 55), 3m divergences (−0.30R, 8).
A "Core playbook only" challenger now paper-trades next to the current style and takes over automatically if it wins over 20+ sessions.
Caveats: R is measured on SPX moves, not option P&L (fills, spread and theta cost extra); 33 days is a short sample and the second half was weaker.
Live orders stay off until you switch them on after paper results.

## **NEW** PDF 7 (Golden Gate): chart study and what was built

Charts: QQQ 3m bull day: call trigger hit, pullback to the ribbon (entry), Golden Gate crossed, rejected at 50%, pulled back and **held the 48** (no Vomy),
consolidated, then a bull flag into the Golden Fib. IWM 3m bear day: fast break through the gate with no pullback (hard to enter), Golden Fib hit,
later a second gate cross, pullback to the ribbon, Golden Fib again. TSLA examples show the same pattern on every mode (day/multiday/swing/position);
on swings Saty uses the gate to **stay in** a trade (trim on the way), not as an entry. Checklist: gate hit, ribbon stacked, entry at the ribbon, profit at the Golden Fib.

| Tested (stop past the 3m 48 EMA, target the Golden Fib) | SPY 5m, 140 days | SPX 3m, 35 days |
|---|---|---|
| Buy the cross, any ribbon | 97 trades, 67% wins, +0.10R | 26, 77%, +0.32R |
| **Buy the cross, ribbon stacked, before noon** | 62 trades, ~81% wins, **+0.29R** | 16, ~75%, +0.20R |
| Buy the cross after noon | −0.13R | −0.02R |
| **Pullback to the 13 EMA holding the 48, after the gate** | 91 trades, 57% wins, **+0.17R** (morning and afternoon) | 28, 57%, +0.17R |
| Deeper pullback to the 21 only | 34 trades, +0.18R (mixed by time) | 7 trades |

**Built:** 🌉 GOLDEN GATE GO (cross before noon with the 3m ribbon stacked; allowed in the 9:33-10:00 window) and 🌉 GOLDEN GATE PULLBACK
(after the gate, max 2 per side per day, until the Golden Fib is reached). Both paper-traded; learning switches them off if they fail live.
When the ribbon is not stacked, or after noon, the gate post is a heads-up only.

## **NEW** PDFs 8 and 9 (TTM Squeeze, Mastering the Squeeze)

Saty's favorite swing setup. Rules from the PDFs: build in the red dots (5+ best), the first green dot confirms direction, momentum hints the way,
price within ±1 ATR of the 21 EMA, EMAs stacked, trim at +1 ATR from the 21 and take profit at +2 ATR (Keltner 21), 30-60 DTE delta 0.7 contracts,
fewer fake-outs at 30m and above. PDF 9 is mostly a TOS scanner walkthrough (S&P 500 weeklys, beta > 1, squeeze on, near the 21, volume > 1M).

| Tested | Result |
|---|---|
| SPY daily TTM squeeze, 9 years, calls above the 21 with momentum up | 19 trades, PF 1.57, both halves positive; the bot's current Saty-compression swing rule is better (PF 1.92) → kept |
| + within 1 ATR / 5+ red dots / stacked EMAs (daily) | only 1-3 trades in 9 years on SPY: can't judge, not added |
| Squeeze puts (daily) | lose again → swings stay calls only |
| Keltner exits (+1/+2 ATR from the 21) vs monthly levels | no better → monthly levels kept |
| "Beyond ±2 ATR from the 21 reverts" (SPY daily) | barely: next 5 days +0.10% after +2 ATR vs +0.26% any day → not a trade |
| Intraday TTM 10m / 15m / 30m (SPY 5m) | 10m 5+ red dots +0.16R vs under 5 −0.06R; 30m no better intraday |
| 5+ bar filter on the bot's own 10m Saty compression (replay) | **hurt**: −0.27R (15) vs +0.05R (33) for all → rejected, bar count only shown in the post |

Nothing new was switched on from PDFs 8/9; the existing swing squeeze rule already matches the best version found.

## **NEW** PDF 10 (Sanity checking strikes and expirations)

AMD example: premarket rejection at the call trigger under a bearish ribbon; entries at the previous-close rejection, the put trigger, or the
premarket-low break; strikes at the next ATR level (95 = midrange "pretty safe"). SPY example: a target past −1 ATR (380 with −1 ATR at 392) is
not realistic, since going past ±1 ATR is rare (our data: ~16% of days). Rolling a winner beats buying far OTM. ITM/ATM safer, OTM only if sanity-checked.

**Built:** every contract idea is checked against the trade's target and ±1 ATR. If the delta pick's strike is past either, the bot uses the
nearest strike inside the limit (same expiry) and says so ("✔️ Strike check"). Swings already use ITM delta ~0.70.

## **NEW** PDF 11 (Scalping SPX / day trading SPY with Time Warp)

Setups: SPX 1m chart with 3m ribbon (our 3m focus), SPY 3m with 10m ribbon (his "bread and butter"); don't chase, buy the 21 EMA / 8-13 in trend;
don't buy the first bounce after a deep extension, wait for the 13 to be recovered; stops: ribbon, 21 EMA, VWAP, ATR level, premarket low;
VIX > 20 = scalp/day trade, < 20 = swing; beginners: SPY 10m with 2-4 DTE.

| Tested | Result |
|---|---|
| "Open at the put trigger → back to the previous close, if not the call trigger" (SPY daily, 10 yrs) | previous close reached 72%, but the put Golden Gate also 74%: a range day, not a direction |
| Which comes first (SPY 5m, 44 trigger opens) | **Golden Gate first ~70%** (31 of 44): continuation, not reversion |

**Built:** the 🌅 opening read now says a trigger open usually continues to that side's Golden Gate first; the previous close is the
magnet only after the trigger is lost. The rest (3m/10m pairing, pullback entries, stop choices) is already how the bot works.

## **NEW** PDF 12 (Options volume leaderboard)

TOS scanner for 0DTE contracts sorted by volume. Saty's read: calls spiking at support = bounce (premium holds), calls spiking at resistance = exits
(premium falls), puts the mirror. Sanity-check the strike with an ATR level, enter well, scale out at levels.
Can't be backtested (no history of intraday option volume), so it is **measured live**: the 5-minute leaderboard job now records 0DTE call vs put
volume since the last snapshot vs the day's pace (spike = 1.8x). Every SPX signal gets a `flow` context (with / against / quiet), the post shows
"0DTE call volume spiking ✓/✗", and the nightly learning compares winners and losers by it.

## **NEW** PDF 13 (SPY day trade plan, multi-timeframe thesis, market pivots)

Plan = setup/thesis, trigger, entry (no chasing), exits (scale out, no diamond hands), stop (technical preferred): every bot post already has
these. Strikes no more than 1 main ATR level away (the PDF 10 check). Timeframes: 3m scalp, 10m intraday trend, 1h broader trend, daily most important.

| Tested | Result |
|---|---|
| VIX market pivot (nearest .5 to the VIX ATR level closest to the open), 36 days | SPX went the pivot's way to the close only 37-44% → **no edge**, shown as info only |
| Losing the call trigger from above (SPY 5m, 48 days) | previous close reached 63%, put trigger only 29% |
| Trading that (puts on the lost trigger, target previous close) | 44 trades −0.13R (calls mirror −0.12R) → **rejected** |

## **NEW** PDF 15 (Tips and the Trend Mantra)

Play the trend, no bias · trends reach the midrange if not the full ATR · no trading the first 10 minutes · no chop ("Chopzilla") · wait for
price above/below the EMAs · never chase, wait for the pullback · never play against the trend with momentum · VIX < 20 swing, > 20 scalp.
The trigger-box tip (trigger open → previous close) is the PDF 11 claim our data contradicts (Golden Gate first ~70%).

| Checked in the replay | Result |
|---|---|
| Choppy vs trending market | 12 signals −0.63R vs 2,370 +0.15R → chop flag confirmed |
| With vs against trend mode | +0.29R (1,122) vs +0.04R (368) → "never against the trend" confirmed (not paper traded) |
| Opening window | already built (9:33-10:00 watch only except ORB, A+, Golden Gate go) |

## **NEW** PDF 16 (The Highlander, end-of-day SPX)

Morph's EOD play: at ~3:45 check the top 2-3 leaderboard contracts; under 100k volume they usually expire worthless ("one contract to kill them all"),
100k+ often closes ITM. Check ATR levels / key levels, structure vs Phase Oscillator (divergence), reversal candle at the level, enter ITM/ATM on the
retrace, take profit at the next ATR level. Saty: "a squeeze on 1m/3m EOD helps tremendously"; chop day = good EOD, trend day = choppy EOD.

| Checked | Result |
|---|---|
| All replay signals after 3:30 | 188 signals, −0.09R (vs +0.15R all day) |
| A/A+ cards after 3:30 | 49, 57% wins, **+0.13R** |
| Everything else after 3:30 | 139, **−0.17R** (squeeze −0.52R on 7, 1m compression −0.25R on 20) → the "EOD squeeze" claim did not hold |
| Top contract dies unless 100k (needs leaderboard history) | only 2 days stored → **now logged every close** ("lb:hist"), judged later |

**Built:** after 3:30 only A/A+ cards are paper traded; other signals still post with "watch only". The 3:45 Highlander heads-up stays.
Every close the bot records the top 3 leaderboard contracts, their volume and whether they finished ITM.

## **NEW** PDF 14 (Tezak: probabilities of reaching Saty ATR levels)

The PDF is only a title page linking a video, so the probabilities were measured on our own data instead (Day-mode levels: previous close ± ATR14 × fib).

SPY daily, 10 years (2,483 days):

| Level | Touched up / down | Goes on to the next level |
|---|---|---|
| Trigger 23.6% | 66% / 58% | 79% reach the Golden Gate |
| Golden Gate 38.2% | 52% / 46% | 67% reach the Golden Fib 61.8% |
| Golden Fib 61.8% | 35% / 31% | 45-55% reach the full ATR |
| Full ATR | 16% / 17% | 52-62% reach 123.6% |

Both triggers are touched on the same day 26% of the time (chop days).

SPY 5m, Apr-Nov 2026 (138 days), after the first touch the same day:

| Move | Overall | By time of the first touch |
|---|---|---|
| Trigger → Golden Gate | 70% | 9:30-10:30 ~75-100% · 10:30-12:00 59% |
| Golden Gate → Golden Fib | 61% | **before 10:00 76%** · 10:00-12:00 ~67% · **after 12:00 only 20-25%** |
| Golden Fib → full ATR | 33% | before 10:30 40-47% · later ~18% |
| Golden Gate → back to the opposite trigger | 16% | morning ~23% · afternoon 0% |

**Built:** the 🌉 Golden Gate post now gives the odds for the time of day it fired. After 12:00 it is marked "late, low odds" with "don't buy for the Golden Fib". The Golden Fib is the main profit target, because it continues to the full ATR only about 1 time in 3.

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

## Data collector (training + forward-test data)

A separate paper book (D1 `paper:data`, trades in `paper:datatrades`) takes **every** SPX signal that has a contract, from 9:32 to
3:55, with **1 contract**, including watch-only setups, VIX-against signals and opening/afternoon-window ones (they are marked
`blocked` with the reason). No daily loss limit, trade count, cooldown or learning filter; up to 12 open at once; calls and puts
may be open together. Same exits as the main account. Its trades feed the nightly learning at weight 1 (main paper trades weight 2)
and the exit tuning, and export with `/export?kind=data` (pulled into `data/data.csv` by `scripts/pull-history.mjs`): a real
option-price record of every setup for backtesting. Silent: no Discord posts.
