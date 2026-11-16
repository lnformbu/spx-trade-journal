# region imports
from AlgorithmImports import *
import math
import random
# endregion
# SPX bot core setups on REAL SPXW 0DTE option prices (QuantConnect cloud, free tier: backtests with their data are free).
#
# Ported 1:1 from the bot (files/bot/src/setups.js + signals.js):
#   ggo    Golden Gate go: 1m close crosses ±38.2% before noon, 3m ribbon stacked, room > 1 3m-ATR; stop past 3m 48 EMA -0.5 A3; target ±61.8%
#   ggpb   Golden Gate pullback: after the gate, 3m pullback to the 13 EMA holding the 48 (max 2 per side), target ±61.8%
#   ckl10  10m checklist pullback: armed by a 10m close beyond the trigger + 34/50 trend + <70% ATR used; pullback to 8/21 EMA; target midrange
#   atr1   ±1 ATR snap-back: first 3m close back inside after touching ±1 ATR, target ±61.8% (calls side = watch only in the bot)
#   bo1m   1m breakout scalp: 9:35-12:00, close beyond the last 20 candles + 8>21>48, stop past the 1m 21 EMA, target 2R, 30-min limit
# Each signal buys 1 SPXW contract expiring TODAY, strike nearest SPX (ATM), priced from the quotes (buy at the ask, sell at the bid), no orders placed.
# Exit when SPX hits the bot's stop or target, after 60 minutes (bo1m 30), or at 15:55: exactly the bot's scorecard rules.
# "paper" = the paper account would have taken it (no entries 9:30-10:00 except ggo, none after 14:00, bo1m / atr1 calls are watch only).
#
# GEX split: each trade tagged +GEX / -GEX (0DTE dealer gamma near SPX at entry, calls +, puts -).
#   Theory: +GEX dealers dampen moves (pullbacks / snap-backs should work better), -GEX they amplify (breakouts should).
# Take-profit test: each trade also scored as if sold at the bid the first minute it was up +10/20/30/50%.
# Flip test: when SPX hits a signal's stop (failed move / fakeout), buy the other side ATM; stop = back through the
#   original entry, target = 1R beyond the original stop, 30-minute limit. Scored with and without TP+20%.
# Phase split: 10m Saty Phase Oscillator zone at entry, read from the trade's side (squeeze / launch / with / late / extended / against / reversal).
# NULL control: every real signal also gets a coin-flip-direction twin (same moment, same exits, mirrored stop/target).
#   The real setups only have an edge if they beat their own null.
# Daily phase split (Saty Time Warp): the DAILY Phase Oscillator zone through yesterday, read from the trade's side.
# Daily 20 EMA split: trade with / against yesterday's SPX close vs its daily 20 EMA.
# Mag 7 split: AAPL MSFT NVDA AMZN GOOGL META TSLA vs today's open at entry: with (5+ of 7 the trade's way) / mixed / against.
# Output: a short summary at the end in the Console tab (and Logs tab), plus CORE / PAPER in the results statistics.

START = (2022, 6, 1)
END = (2026, 11, 13)
FIBS = [0.236, 0.382, 0.618, 1.0]
MAG7 = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"]
TPS = [0.10, 0.20, 0.30, 0.50]     # take-profit levels tested on the option price (sell at the bid once it reaches entry x 1.2 etc.)


def r2(x):
    return round(x * 100) / 100.0


def ema_next(prev, x, n):
    k = 2.0 / (n + 1)
    return x if prev is None else x * k + prev * (1 - k)


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def gamma_of(px, S, K, T, call):
    """Black-Scholes gamma from the option's mid price (implied vol by bisection); 0 when there is no time value."""
    intr = max(0.0, S - K) if call else max(0.0, K - S)
    if px <= intr + 0.02:
        return 0.0
    lo, hi = 0.01, 6.0
    for _ in range(40):
        v = (lo + hi) / 2
        sd = v * math.sqrt(T)
        d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
        val = S * ncdf(d1) - K * ncdf(d1 - sd) if call else K * ncdf(sd - d1) - S * ncdf(-d1)
        if val > px:
            hi = v
        else:
            lo = v
    sd = (lo + hi) / 2 * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi) / (S * sd)


def wilder_atr(bars, n=14):
    if len(bars) < n:
        return None
    trs = []
    for i, b in enumerate(bars):
        if i == 0:
            trs.append(b["h"] - b["l"])
        else:
            pc = bars[i - 1]["c"]
            trs.append(max(b["h"] - b["l"], abs(b["h"] - pc), abs(b["l"] - pc)))
    a = sum(trs[:n]) / n
    for tr in trs[n:]:
        a = (a * (n - 1) + tr) / n
    return a


class BarSeries:
    """Bars of one timeframe (regular hours, continuous across days) with running EMAs."""
    def __init__(self, lengths, keep=2500):
        self.lengths, self.keep = lengths, keep
        self.bars, self.e = [], {n: [] for n in lengths}

    def add(self, bar):
        self.bars.append(bar)
        for n in self.lengths:
            self.e[n].append(ema_next(self.e[n][-1] if self.e[n] else None, bar["c"], n))
        if len(self.bars) > self.keep + 500:
            cut = len(self.bars) - self.keep
            self.bars = self.bars[cut:]
            for n in self.lengths:
                self.e[n] = self.e[n][cut:]


class Agg:
    """Builds 3m / 10m bars from 1m bars, slots anchored at 9:30 like the bot. push() returns True when a bar just closed."""
    def __init__(self, size, series):
        self.size, self.series, self.cur = size, series, None

    def push(self, b):
        slot = b["m"] // self.size
        if self.cur is not None and (self.cur["d"] != b["d"] or self.cur["slot"] != slot):
            self.series.add(self.cur)          # a slot that missed its last minute
            self.cur = None
        if self.cur is None:
            self.cur = {"d": b["d"], "slot": slot, "m": slot * self.size, "o": b["o"], "h": b["h"], "l": b["l"], "c": b["c"]}
        else:
            self.cur["h"] = max(self.cur["h"], b["h"]); self.cur["l"] = min(self.cur["l"], b["l"]); self.cur["c"] = b["c"]
        if b["m"] % self.size == self.size - 1:
            self.series.add(self.cur)
            self.cur = None
            return True
        return False


def phase_zone(s, d):
    """Saty Phase Oscillator on the 10m bars (same math as the bot's levels.js) -> zone read from the trade's side."""
    bars = s.bars[-200:]
    if len(bars) < 40:
        return None
    k0 = len(s.bars) - len(bars)
    piv = s.e[21][k0:]
    at, a, sm = [], None, 0.0
    for i, b in enumerate(bars):
        tr = max(b["h"] - b["l"], abs(b["h"] - bars[i - 1]["c"]), abs(b["l"] - bars[i - 1]["c"])) if i else b["h"] - b["l"]
        if i < 14:
            sm += tr; a = sm / 14 if i == 13 else None
        else:
            a = (a * 13 + tr) / 14
        at.append(a)
    osc, prev = [], None
    for i, b in enumerate(bars):
        raw = (b["c"] - piv[i]) / (3 * at[i]) * 100 if at[i] else 0.0
        prev = raw if prev is None else raw * 0.5 + prev * 0.5
        osc.append(prev)
    # compression tracker (Bollinger 2 sd inside 2 ATR around the 21 EMA)
    comp_prev, track = None, 0
    for i in range(20, len(bars)):
        if at[i] is None:
            continue
        cl = [x["c"] for x in bars[i - 20:i + 1]]
        mu = sum(cl) / 21
        off = 2 * math.sqrt(sum((x - mu) ** 2 for x in cl) / 21)
        above = bars[i]["c"] >= piv[i]
        c = (piv[i] + off) - (piv[i] + 2 * at[i]) if above else (piv[i] - 2 * at[i]) - (piv[i] - off)
        ez = (piv[i] + off) - (piv[i] + 1.854 * at[i]) if above else (piv[i] - 1.854 * at[i]) - (piv[i] - off)
        expansion = comp_prev is not None and comp_prev <= c
        track = 0 if (expansion and ez > 0) else (1 if c <= 0 else 0)
        comp_prev = c
    v = osc[-1]
    if track == 1:
        return "squeeze"
    sv = v if d == "bull" else -v
    return "launch" if abs(v) <= 23.6 else "extended" if sv >= 100 else "late" if sv >= 61.8 else "with" if sv > 0 else "reversal" if sv <= -61.8 else "against"


def rib_state(s):
    i = len(s.bars) - 1
    fast_up, slow_up = s.e[8][i] >= s.e[21][i], s.e[13][i] >= s.e[48][i]
    return "bull" if fast_up and slow_up else "bear" if not fast_up and not slow_up else "mixed"


def gg_pullback(s, d, fib):
    bars = s.bars
    if len(bars) < 60 or fib is None:
        return None
    i, b = len(bars) - 1, bars[-1]
    A = wilder_atr(bars[-80:])
    if not A:
        return None
    e8, e13, e21, e48 = s.e[8][i], s.e[13][i], s.e[21][i], s.e[48][i]
    tol, bull = A * 0.15, d == "bull"
    stacked = (e8 >= e21 and e13 >= e48) if bull else (e8 <= e21 and e13 <= e48)
    touch = (b["l"] <= e13 + tol and b["l"] >= e48 - tol) if bull else (b["h"] >= e13 - tol and b["h"] <= e48 + tol)
    reclaimed = (b["c"] >= e13 and b["c"] > b["o"]) if bull else (b["c"] <= e13 and b["c"] < b["o"])
    room = (fib - b["c"] > A) if bull else (b["c"] - fib > A)
    if not (stacked and touch and reclaimed and room):
        return None
    stop = min(b["l"], e48) - A * 0.5 if bull else max(b["h"], e48) + A * 0.5
    return b["c"], stop


def atr_snap(bars, lv, A, d):
    if len(bars) < 3:
        return None
    bull = d == "bull"
    full, tg = lv["-1.0" if bull else "+1.0"], lv["-0.618" if bull else "+0.618"]
    i0 = next((k for k, b in enumerate(bars) if (b["l"] <= full if bull else b["h"] >= full)), -1)
    i = len(bars) - 1
    if i0 < 0 or i <= i0:
        return None
    inside = (lambda b: b["c"] > full) if bull else (lambda b: b["c"] < full)
    if not inside(bars[i]):
        return None
    for k in range(i0 + 1, i):
        if inside(bars[k]):
            return None
    ext = bars[i0:i + 1]
    stop = min(b["l"] for b in ext) - A * 0.05 if bull else max(b["h"] for b in ext) + A * 0.05
    entry = bars[i]["c"]
    if (tg <= entry) if bull else (tg >= entry):
        return None
    return entry, stop, tg


def checklist10(s, start, lv, A, d):
    bars = s.bars
    if len(bars) < 60 or start is None or start < 0:
        return None
    bull = d == "bull"
    sgn = 1 if bull else -1
    trig, mid = lv["+0.236" if bull else "-0.236"], lv["+0.618" if bull else "-0.618"]
    e8, e21, e34, e50 = s.e[8], s.e[21], s.e[34], s.e[50]
    last = len(bars) - 1
    hi, lo, armed, n = -1e18, 1e18, False, 0
    for i in range(start, last + 1):
        b, m = bars[i], bars[i]["m"]
        hi, lo = max(hi, b["h"]), min(lo, b["l"])
        if m < 580 or m >= 900:
            continue
        trend = (b["c"] > max(e34[i], e50[i])) if bull else (b["c"] < min(e34[i], e50[i]))
        if not armed:
            if ((b["c"] > trig) if bull else (b["c"] < trig)) and trend and (hi - lo) / A < 0.7:
                armed = True
            continue
        if (b["h"] >= mid) if bull else (b["l"] <= mid):
            return None
        t21 = (b["l"] <= e21[i] * 1.0003 and b["c"] > e21[i]) if bull else (b["h"] >= e21[i] * 0.9997 and b["c"] < e21[i])
        t8 = (b["l"] <= e8[i] and b["c"] > e8[i]) if bull else (b["h"] >= e8[i] and b["c"] < e8[i])
        if not (t21 or t8) or not trend:
            continue
        n += 1
        if n > 2:
            return None
        if i == last:
            stop = min(e34[i], e50[i]) - A * 0.05 if bull else max(e34[i], e50[i]) + A * 0.05
            if (b["c"] - stop) * sgn <= 0:
                return None
            return b["c"], stop, mid
    return None


class SpxCore0DTE(QCAlgorithm):
    def initialize(self):
        self.set_start_date(*START)
        self.set_end_date(*END)
        self.set_cash(100000)
        self.spx = self.add_index("SPX", Resolution.MINUTE).symbol
        opt = self.add_index_option(self.spx, "SPXW", Resolution.MINUTE)
        opt.set_filter(lambda u: u.include_weeklys().strikes(-30, 30).expiration(0, 0))
        self.spxw = opt.symbol
        self.m7 = [self.add_equity(t, Resolution.MINUTE).symbol for t in MAG7]
        self.m7open, self.m7last = {}, {}
        self.s1, self.s3, self.s10 = BarSeries([8, 21, 48]), BarSeries([8, 13, 21, 48]), BarSeries([8, 21, 34, 50])
        self.a3, self.a10 = Agg(3, self.s3), Agg(10, self.s10)
        self.day, self.lv, self.A, self.d20, self.dser = None, None, None, None, BarSeries([21])
        self.trades, self.flips, self.nulls, self.open, self.no_chain, self.unclosed = [], [], [], [], 0, 0
        self.rng = random.Random(11)       # coin-flip control (fixed seed = repeatable)
        # warm the EMAs with the 10 days before the start
        for x in self.history[TradeBar](self.spx, timedelta(days=14), Resolution.MINUTE):
            m = x.time.hour * 60 + x.time.minute
            if 570 <= m < 960:
                b = {"d": x.time.date(), "m": m, "o": float(x.open), "h": float(x.high), "l": float(x.low), "c": float(x.close)}
                self.s1.add(b); self.a3.push(b); self.a10.push(b)

    def new_day(self, d):
        if self.open:                      # half day (1:00 close): the contract settled before an exit; left out of the stats
            self.unclosed += len(self.open)
            self.open = []
        if self.day is None or d.month != self.day.month:   # progress line in the Console once a month
            self.debug("progress %s: %d signals so far, %d with no 0DTE quote" % (d.strftime("%Y-%m"), len(self.trades), self.no_chain))
        self.day, self.today, self.fired, self.gg_arm, self.bo_until = d, [], set(), {}, -1
        self.m7open, self.m7last = {}, {}
        rows = [{"h": float(x.high), "l": float(x.low), "c": float(x.close)}
                for x in self.history[TradeBar](self.spx, 300, Resolution.DAILY) if x.time.date() < d]
        if len(rows) < 30:
            self.lv = None
            return
        pdc, A = rows[-1]["c"], r2(wilder_atr(rows))
        e20 = None                         # daily 20 EMA regime at yesterday's close (idea from spx-xsp-option-trade-bot)
        for r in rows:
            e20 = ema_next(e20, r["c"], 20)
        self.d20 = "bull" if pdc > e20 else "bear"
        self.dser = BarSeries([21])        # daily bars through yesterday, for the daily Phase Oscillator (Saty "Time Warp")
        for r in rows:
            self.dser.add(r)
        self.A, self.lv = A, {}
        for f in FIBS:
            self.lv["+%s" % f] = r2(pdc + A * f)
            self.lv["-%s" % f] = r2(pdc - A * f)

    def on_data(self, data: Slice):
        if self.spx not in data.bars:
            return
        x = data.bars[self.spx]
        m = x.time.hour * 60 + x.time.minute
        if m < 570 or m >= 960:
            return
        d = x.time.date()
        if d != self.day:
            self.new_day(d)
        b = {"d": d, "m": m, "o": float(x.open), "h": float(x.high), "l": float(x.low), "c": float(x.close)}
        self.s1.add(b); self.today.append(b)
        for sym in self.m7:                # Mag 7: today's open and latest price
            if sym in data.bars:
                eb = data.bars[sym]
                self.m7open.setdefault(sym, float(eb.open))
                self.m7last[sym] = float(eb.close)
        done3, done10 = self.a3.push(b), self.a10.push(b)
        if self.lv is None:
            return
        now_m = m + 1                      # the bot's clock: the minute this candle closed
        self.manage(b, now_m, data)
        if now_m < 950:
            self.signals(b, now_m, done3, done10, data)

    # ---------------- signals ----------------
    def signals(self, b, now_m, done3, done10, data):
        lv, A, rth, s3 = self.lv, self.A, self.today, self.s3
        c0, c3 = b["c"], rth[max(0, len(rth) - 4)]["c"]
        hod, lod = max(x["h"] for x in rth), min(x["l"] for x in rth)
        # Golden Gate: arm the pullback; GO before noon with the 3m ribbon stacked
        for k, fk, up in (("+0.382", "+0.618", True), ("-0.382", "-0.618", False)):
            g = lv[k]
            if not ((c3 < g and c0 >= g) if up else (c3 > g and c0 <= g)):
                continue
            dg = "bull" if up else "bear"
            self.gg_arm.setdefault(dg, {"n": 0})
            if ("ggo" + k) in self.fired or now_m >= 720 or len(s3.bars) < 21:
                continue
            A3 = wilder_atr(s3.bars[-80:])
            e48 = s3.e[48][-1]
            if rib_state(s3) == dg and A3 and ((lv[fk] - c0 > A3) if up else (c0 - lv[fk] > A3)):
                self.fired.add("ggo" + k)
                self.enter("ggo", dg, c0, e48 - A3 * 0.5 if up else e48 + A3 * 0.5, lv[fk], now_m, data, 60)
        if done3:
            for dg, arm in self.gg_arm.items():
                if arm["n"] >= 2:
                    continue
                up = dg == "bull"
                fib = lv["+0.618" if up else "-0.618"]
                if (hod >= fib) if up else (lod <= fib):
                    continue
                gp = gg_pullback(s3, dg, fib)
                if gp:
                    arm["n"] += 1
                    self.enter("ggpb", dg, c0, gp[1], fib, now_m, data, 60)
            if now_m < 930:
                today3 = [x for x in s3.bars[-140:] if x["d"] == self.day]
                for dg in ("bull", "bear"):
                    if ("atr1" + dg) in self.fired:
                        continue
                    sn = atr_snap(today3, lv, A, dg)
                    if sn:
                        self.fired.add("atr1" + dg)
                        self.enter("atr1", dg, c0, sn[1], sn[2], now_m, data, 60)
        if done10:
            bars10 = self.s10.bars
            start = next((i for i in range(len(bars10) - 1, -1, -1) if bars10[i]["d"] != self.day), -1) + 1
            for dg in ("bull", "bear"):
                ck = checklist10(self.s10, start, lv, A, dg)
                if ck:
                    self.enter("ckl10", dg, c0, ck[1], ck[2], now_m, data, 60)
        # 1m breakout scalp (morning)
        s1 = self.s1
        if 575 <= now_m < 720 and now_m >= self.bo_until and len(s1.bars) >= 80:
            i = len(s1.bars) - 1
            w = s1.bars[i - 20:i]
            e8, e21, e48 = s1.e[8][i], s1.e[21][i], s1.e[48][i]
            sig = None
            if c0 > max(x["h"] for x in w) and e8 > e21 > e48:
                sig = ("bull", min(e21, b["l"]) - 1)
            elif c0 < min(x["l"] for x in w) and e8 < e21 < e48:
                sig = ("bear", max(e21, b["h"]) + 1)
            if sig:
                risk = abs(c0 - sig[1])
                if 1.5 <= risk <= 15:
                    self.bo_until = now_m + 10
                    tgt = c0 + 2 * risk if sig[0] == "bull" else c0 - 2 * risk
                    self.enter("bo1m", sig[0], c0, sig[1], tgt, now_m, data, 30)

    # ---------------- trades ----------------
    def enter(self, fam, d, entry, stop, target, now_m, data, limit, flip_of=None, null=False):
        up = d == "bull"
        risk = (entry - stop) if up else (stop - entry)
        if risk <= 0 or ((target - entry) if up else (entry - target)) <= 0:
            return
        chain = data.option_chains.get(self.spxw)
        if chain is None:
            self.no_chain += 1
            return
        right = OptionRight.CALL if up else OptionRight.PUT
        cs = [c for c in chain if c.right == right and c.expiry.date() == self.day and c.ask_price > 0 and c.bid_price > 0]
        if not cs:
            self.no_chain += 1
            return
        c = min(cs, key=lambda x: abs(x.strike - entry))
        # dealer gamma regime (0DTE, strikes within 60 pts): sum of gamma x open interest x 100, calls +, puts -
        T = max(960 - now_m, 2) / 525600.0
        gex = 0.0
        for o in chain:
            if o.expiry.date() != self.day or abs(float(o.strike) - entry) > 60 or o.bid_price <= 0:
                continue
            mid = float(o.bid_price + o.ask_price) / 2
            iscall = o.right == OptionRight.CALL
            gex += (1 if iscall else -1) * gamma_of(mid, entry, float(o.strike), T, iscall) * float(o.open_interest) * 100
        fill = float(c.ask_price)          # priced from the quote (buy at the ask), no order: no account balance to run out
        paper = now_m < 840 and (now_m >= 600 or fam == "ggo") and fam != "bo1m" and not (fam == "atr1" and up)
        tr = {"date": str(self.day), "et": "%d:%02d" % (now_m // 60, now_m % 60), "fam": fam, "dir": d, "paper": paper,
              "spx_entry": r2(entry), "stop": r2(stop), "target": r2(target), "risk": r2(risk), "strike": float(c.strike),
              "sym": c.symbol, "opt_in": fill, "spread_in": r2(float(c.ask_price - c.bid_price)), "max_bid": float(c.bid_price),
              "m": now_m, "limit": limit, "gex": "+" if gex >= 0 else "-", "phase": phase_zone(self.s10, d), "phaseD": phase_zone(self.dser, d), "mag7": self.mag7_side(d), "d20": "with" if self.d20 == d else "against", "tp": {}, "flip": flip_of is not None}
        tr["null"] = null
        if flip_of is not None:
            tr["paper"] = flip_of["paper"]
        self.open.append(tr)
        # RANDOM-DIRECTION CONTROL: same moment, same contract type, same exits, but the side is a coin flip
        # (mirrored stop / target when it lands on the other side). If this makes as much as the real signal,
        # the setup isn't calling direction, it's just catching moves.
        if flip_of is None and not null:
            nd = "bull" if self.rng.random() < 0.5 else "bear"
            if nd == d:
                self.enter(fam, nd, entry, stop, target, now_m, data, limit, null=True)
            else:
                self.enter(fam, nd, entry, 2 * entry - stop, 2 * entry - target, now_m, data, limit, null=True)

    def mag7_side(self, d):
        """'with' = 5+ of the Mag 7 above (calls) / below (puts) today's open, 'against' = 5+ the other way, else 'mixed'."""
        ks = [k for k in self.m7last if self.m7open.get(k)]
        if len(ks) < 5:
            return None
        up = sum(1 for k in ks if self.m7last[k] > self.m7open[k])
        mine = up if d == "bull" else len(ks) - up
        return "with" if mine >= 5 else "against" if len(ks) - mine >= 5 else "mixed"

    def manage(self, b, now_m, data):
        for tr in list(self.open):
            up = tr["dir"] == "bull"
            sec = self.securities[tr["sym"]]
            bid = float(sec.bid_price)
            tr["max_bid"] = max(tr["max_bid"], bid)
            for L in TPS:                      # first minute the bid reached +L: that variant sells there
                if L not in tr["tp"] and tr["opt_in"] > 0 and bid >= tr["opt_in"] * (1 + L):
                    tr["tp"][L] = bid
            why, px = None, b["c"]
            if (b["l"] <= tr["stop"]) if up else (b["h"] >= tr["stop"]):
                why, px = "stop", tr["stop"]
            elif (b["h"] >= tr["target"]) if up else (b["l"] <= tr["target"]):
                why, px = "target", tr["target"]
            elif now_m - tr["m"] >= tr["limit"]:
                why = "time"
            elif now_m >= 955:
                why = "3:55"
            if not why:
                continue
            out = float(sec.bid_price)         # sell at the bid
            tr.update({"exit": why, "et_out": "%d:%02d" % (now_m // 60, now_m % 60), "spx_R": r2(((px - tr["spx_entry"]) if up else (tr["spx_entry"] - px)) / tr["risk"]),
                       "opt_out": out, "opt_pct": round((out / tr["opt_in"] - 1) * 100, 1) if tr["opt_in"] > 0 else None,
                       "pnl": round((out - tr["opt_in"]) * 100, 2), "best_pct": round((tr["max_bid"] / tr["opt_in"] - 1) * 100, 1) if tr["opt_in"] > 0 else None})
            self.open.remove(tr)
            (self.nulls if tr.get("null") else self.flips if tr["flip"] else self.trades).append(tr)
            # FLIP: the signal failed (SPX hit its stop) = possible fakeout -> buy the other side right away.
            # Flip stop = back through the original entry (fakeout thesis wrong), target = 1R past the original stop, 30 min max.
            if why == "stop" and not tr["flip"] and not tr.get("null") and now_m < 940:
                r = tr["risk"]
                self.enter(tr["fam"], "bear" if up else "bull", tr["stop"], tr["spx_entry"],
                           tr["stop"] - r if up else tr["stop"] + r, now_m, data, 30, flip_of=tr)

    # ---------------- report ----------------
    def on_end_of_algorithm(self):
        def stats(ts):
            n = len(ts)
            if not n:
                return "n 0"
            w = [t for t in ts if t["pnl"] > 0]
            gw, gl = sum(t["pnl"] for t in w), -sum(t["pnl"] for t in ts if t["pnl"] < 0)
            return "n%d w%d%% opt%+.0f%% $%+.0f avg%+.0f PF%.2f R%+.2f" % (
                n, round(len(w) / n * 100), sum(t["opt_pct"] or 0 for t in ts) / n, gw - gl, (gw - gl) / n, gw / gl if gl else 99,
                sum(t["spx_R"] for t in ts) / n)
        core = [t for t in self.trades if t["fam"] != "bo1m"]
        out = ["=== SPX core on real SPXW 0DTE, 1 ATM, ask in / bid out, before fees ===",
               "CORE (no bo1m) " + stats(core), "PAPER " + stats([t for t in core if t["paper"]])]
        for fam in ("ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            ts = [t for t in self.trades if t["fam"] == fam]
            side = lambda d: " ".join(stats([t for t in ts if t["dir"] == d]).split(" ")[i] for i in (0, 1, 3, 5)) if any(t["dir"] == d for t in ts) else "n0"
            out.append("%s %s | bull %s | bear %s" % (fam, stats(ts), side("bull"), side("bear")))
        for fam in ("ALL core", "ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            ts = core if fam == "ALL core" else [t for t in self.trades if t["fam"] == fam]
            out.append("GEX %s | +GEX %s | -GEX %s" % (fam, stats([t for t in ts if t["gex"] == "+"]), stats([t for t in ts if t["gex"] == "-"])))
        def tpv(ts, L):                    # the same trades with a +L take-profit
            return [dict(t, pnl=round((t["tp"][L] - t["opt_in"]) * 100, 2), opt_pct=L * 100) if L in t["tp"] else t for t in ts]
        ncore = [t for t in self.nulls if t["fam"] != "bo1m"]
        out.append("NULL coin-flip side, core %s | TP+20%% %s   <- the real signals must beat this" % (stats(ncore), stats(tpv(ncore, 0.20))))
        for fam in ("ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            out.append("NULL %s %s" % (fam, stats([t for t in self.nulls if t["fam"] == fam])))
        n = len(core)
        if n:
            out.append("CORE reached at any point: " + " ".join("+%d%% %d%%" % (L * 100, round(sum(1 for t in core if L in t["tp"]) / n * 100)) for L in TPS)
                       + " | green at all %d%%" % round(sum(1 for t in core if t["max_bid"] > t["opt_in"]) / n * 100))
        for L in TPS:
            out.append("TP+%d%% CORE %s | PAPER %s" % (L * 100, stats(tpv(core, L)), stats(tpv([t for t in core if t["paper"]], L))))
        for fam in ("ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            out.append("TP+20%% %s %s" % (fam, stats(tpv([t for t in self.trades if t["fam"] == fam], 0.20))))
        fcore = [t for t in self.flips if t["fam"] != "bo1m"]
        out.append("FLIP after a stop (core) %s | with TP+20%% %s" % (stats(fcore), stats(tpv(fcore, 0.20))))
        for fam in ("ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            out.append("FLIP %s %s | TP+20%% %s" % (fam, stats([t for t in self.flips if t["fam"] == fam]), stats(tpv([t for t in self.flips if t["fam"] == fam], 0.20))))
        out.append("CORE + FLIPS, both TP+20%% %s" % stats(tpv(core, 0.20) + tpv(fcore, 0.20)))
        for z in ("with", "against"):
            out.append("DAILY20 %-7s core %s | TP+20%% %s" % (z, stats([t for t in core if t.get("d20") == z]), stats(tpv([t for t in core if t.get("d20") == z], 0.20))))
        for z in ("with", "mixed", "against"):
            out.append("MAG7 %-7s core %s | TP+20%% %s" % (z, stats([t for t in core if t.get("mag7") == z]), stats(tpv([t for t in core if t.get("mag7") == z], 0.20))))
        for z in ("squeeze", "launch", "with", "late", "extended", "against", "reversal"):
            out.append("DAILY PHASE %-8s core %s | TP+20%% %s" % (z, stats([t for t in core if t.get("phaseD") == z]), stats(tpv([t for t in core if t.get("phaseD") == z], 0.20))))
        for z in ("squeeze", "launch", "with", "late", "extended", "against", "reversal"):
            out.append("PHASE %-8s core %s | TP+20%% %s" % (z, stats([t for t in core if t.get("phase") == z]), stats(tpv([t for t in core if t.get("phase") == z], 0.20))))
        for lab, lo, hi in (("9:30-10", 570, 600), ("10-12", 600, 720), ("12-14", 720, 840), ("14-16", 840, 960)):
            out.append("core %s " % lab + stats([t for t in core if lo <= t["m"] < hi]))
        for y in sorted(set(t["date"][:4] for t in self.trades)):
            out.append("%s CORE %s | PAPER %s" % (y, stats([t for t in core if t["date"][:4] == y]),
                                                  stats([t for t in core if t["paper"] and t["date"][:4] == y])))
        out.append("skipped (no 0DTE quote) %d, half-day leftovers %d" % (self.no_chain, self.unclosed))
        for line in out:
            self.debug(line)               # Console tab (not counted in the 10 KB log limit)
            self.log(line)                 # Logs tab, if today's log allowance is left
        for k, line in (("CORE", out[1]), ("PAPER", out[2])):
            try:
                self.set_summary_statistic(k, line)
            except Exception:
                pass
