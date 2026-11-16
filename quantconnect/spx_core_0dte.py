# region imports
from AlgorithmImports import *
# endregion
# SPX bot core setups on REAL SPXW 0DTE option prices (QuantConnect cloud, free tier: backtests with their data are free).
#
# Ported 1:1 from the bot (files/bot/src/setups.js + signals.js):
#   ggo    Golden Gate go: 1m close crosses ±38.2% before noon, 3m ribbon stacked, room > 1 3m-ATR; stop past 3m 48 EMA -0.5 A3; target ±61.8%
#   ggpb   Golden Gate pullback: after the gate, 3m pullback to the 13 EMA holding the 48 (max 2 per side), target ±61.8%
#   ckl10  10m checklist pullback: armed by a 10m close beyond the trigger + 34/50 trend + <70% ATR used; pullback to 8/21 EMA; target midrange
#   atr1   ±1 ATR snap-back: first 3m close back inside after touching ±1 ATR, target ±61.8% (calls side = watch only in the bot)
#   bo1m   1m breakout scalp: 9:35-12:00, close beyond the last 20 candles + 8>21>48, stop past the 1m 21 EMA, target 2R, 30-min limit
# Each signal buys 1 SPXW contract expiring TODAY, strike nearest SPX (ATM), market order (fills at the ask, sells at the bid).
# Exit when SPX hits the bot's stop or target, after 60 minutes (bo1m 30), or at 15:55: exactly the bot's scorecard rules.
# "paper" = the paper account would have taken it (no entries 9:30-10:00 except ggo, none after 14:00, bo1m / atr1 calls are watch only).
#
# Output: a summary in the log at the end, and every trade in the Object Store as "spx_core_0dte_trades.csv".

START = (2023, 1, 1)
END = (2024, 12, 31)
FIBS = [0.236, 0.382, 0.618, 1.0]


def r2(x):
    return round(x * 100) / 100.0


def ema_next(prev, x, n):
    k = 2.0 / (n + 1)
    return x if prev is None else x * k + prev * (1 - k)


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


class Series:
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
        self.s1, self.s3, self.s10 = Series([8, 21, 48]), Series([8, 13, 21, 48]), Series([8, 21, 34, 50])
        self.a3, self.a10 = Agg(3, self.s3), Agg(10, self.s10)
        self.day, self.lv, self.A = None, None, None
        self.trades, self.open, self.no_chain, self.unclosed = [], [], 0, 0
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
        self.day, self.today, self.fired, self.gg_arm, self.bo_until = d, [], set(), {}, -1
        rows = [{"h": float(x.high), "l": float(x.low), "c": float(x.close)}
                for x in self.history[TradeBar](self.spx, 300, Resolution.DAILY) if x.time.date() < d]
        if len(rows) < 30:
            self.lv = None
            return
        pdc, A = rows[-1]["c"], r2(wilder_atr(rows))
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
        done3, done10 = self.a3.push(b), self.a10.push(b)
        if self.lv is None:
            return
        now_m = m + 1                      # the bot's clock: the minute this candle closed
        self.manage(b, now_m)
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
    def enter(self, fam, d, entry, stop, target, now_m, data, limit):
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
        t = self.market_order(c.symbol, 1, tag=fam)
        fill = float(t.average_fill_price) if t.average_fill_price else float(c.ask_price)
        paper = now_m < 840 and (now_m >= 600 or fam == "ggo") and fam != "bo1m" and not (fam == "atr1" and up)
        tr = {"date": str(self.day), "et": "%d:%02d" % (now_m // 60, now_m % 60), "fam": fam, "dir": d, "paper": paper,
              "spx_entry": r2(entry), "stop": r2(stop), "target": r2(target), "risk": r2(risk), "strike": float(c.strike),
              "sym": c.symbol, "opt_in": fill, "spread_in": r2(float(c.ask_price - c.bid_price)), "max_bid": float(c.bid_price),
              "m": now_m, "limit": limit}
        self.open.append(tr)

    def manage(self, b, now_m):
        for tr in list(self.open):
            up = tr["dir"] == "bull"
            sec = self.securities[tr["sym"]]
            tr["max_bid"] = max(tr["max_bid"], float(sec.bid_price))
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
            t = self.market_order(tr["sym"], -1, tag=tr["fam"] + " " + why)
            out = float(t.average_fill_price) if t.average_fill_price else float(sec.bid_price)
            tr.update({"exit": why, "et_out": "%d:%02d" % (now_m // 60, now_m % 60), "spx_R": r2(((px - tr["spx_entry"]) if up else (tr["spx_entry"] - px)) / tr["risk"]),
                       "opt_out": out, "opt_pct": round((out / tr["opt_in"] - 1) * 100, 1) if tr["opt_in"] > 0 else None,
                       "pnl": round((out - tr["opt_in"]) * 100, 2), "best_pct": round((tr["max_bid"] / tr["opt_in"] - 1) * 100, 1) if tr["opt_in"] > 0 else None})
            self.open.remove(tr)
            self.trades.append(tr)

    # ---------------- report ----------------
    def on_end_of_algorithm(self):
        def stats(ts):
            n = len(ts)
            if not n:
                return "n 0"
            w = [t for t in ts if t["pnl"] > 0]
            gw, gl = sum(t["pnl"] for t in w), -sum(t["pnl"] for t in ts if t["pnl"] < 0)
            return "n %d | win %d%% | avg option %+.1f%% | P/L $%+.0f (avg $%+.0f) | PF %.2f | SPX avg R %+.2f | days %d" % (
                n, round(len(w) / n * 100), sum(t["opt_pct"] or 0 for t in ts) / n, gw - gl, (gw - gl) / n, gw / gl if gl else 99,
                sum(t["spx_R"] for t in ts) / n, len(set(t["date"] for t in ts)))
        self.log("=== SPX core setups on real SPXW 0DTE, 1 ATM contract per signal, before fees ===")
        self.log("ALL      " + stats(self.trades))
        self.log("PAPER    " + stats([t for t in self.trades if t["paper"]]))
        for fam in ("ggo", "ggpb", "ckl10", "atr1", "bo1m"):
            ts = [t for t in self.trades if t["fam"] == fam]
            self.log("%-6s   " % fam + stats(ts))
            for d in ("bull", "bear"):
                self.log("   %-5s " % d + stats([t for t in ts if t["dir"] == d]))
        for lab, lo, hi in (("9:30-10", 570, 600), ("10-12", 600, 720), ("12-14", 720, 840), ("14-16", 840, 960)):
            self.log("time %-8s" % lab + stats([t for t in self.trades if lo <= t["m"] < hi]))
        self.log("signals skipped (no 0DTE quote): %d · left out (settled on a half day): %d" % (self.no_chain, self.unclosed))
        cols = ["date", "et", "fam", "dir", "paper", "spx_entry", "stop", "target", "risk", "strike", "opt_in", "spread_in",
                "exit", "et_out", "spx_R", "opt_out", "opt_pct", "best_pct", "pnl"]
        csv = ",".join(cols) + "\n" + "\n".join(",".join(str(t.get(c, "")) for c in cols) for t in self.trades)
        try:
            self.object_store.save("spx_core_0dte_trades.csv", csv)
            self.log("every trade saved to the Object Store: spx_core_0dte_trades.csv (%d rows)" % len(self.trades))
        except Exception as e:
            self.log("Object Store save failed (%s); the summary above is complete" % e)
