# region imports
from AlgorithmImports import *
import math
# endregion
# Kill the Leaderboard on REAL SPXW 0DTE data (QuantConnect cloud, free tier).
# Ported from the bot (files/bot/src/greekjob.js + signals.js), same rules, same clock:
#   leaderboard  top-10 SPXW 0DTE contracts by today's volume, each with its own VWAP (volume-weighted traded price)
#   tax list     100k+ volume and last trade 20%+ above its VWAP (holders in profit = the premium to shake)
#   0DTE gamma   per strike within 60 pts of SPX: gamma x max(open interest, volume) x 100, calls +, puts -
#                (gamma from Black-Scholes on each contract's mid price; Schwab supplies its own in the live bot)
#   growing node the strike that gained the most gamma over the last 30 minutes
#   max pain     the SPX price where the top-10 holders' in-the-money value is smallest
#   pin          growing node, else max pain, else biggest gamma strike
#   kill dir     shake the biggest tax-list name (calls -> SPX down, puts -> up); empty board -> toward the pin
# Scored against the 4:00 settlement:
#   1. Which top-10 contracts got killed (expired worthless), split by volume, by ITM/OTM at 3:30 and by tax list
#   2. Can the gamma pin call the kills better than "OTM at 3:30 stays OTM"?
#   3. Pin error: how close each pin candidate came to the settlement vs simply "SPX at 3:40"
#   4. Kill direction hit rate (3:30 -> settlement)
#   5. Trades, 1 ATM contract bought at the ask: 3:30 in the kill direction, 3:40 toward the pin ("final 20");
#      exit = settlement value, or the 3:55 bid
START = (2022, 6, 1)
END = (2026, 11, 13)
BIG = 100000


def ncdf(x):
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(S, K, T, v, call):
    sd = v * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    d2 = d1 - sd
    return S * ncdf(d1) - K * ncdf(d2) if call else K * ncdf(-d2) - S * ncdf(-d1)


def gamma_of(px, S, K, T, call):
    intr = max(0.0, S - K) if call else max(0.0, K - S)
    if px <= intr + 0.02:
        return 0.0
    lo, hi = 0.01, 6.0
    for _ in range(40):
        v = (lo + hi) / 2
        if bs(S, K, T, v, call) > px:
            hi = v
        else:
            lo = v
    sd = (lo + hi) / 2 * math.sqrt(T)
    d1 = (math.log(S / K) + 0.5 * sd * sd) / sd
    return math.exp(-d1 * d1 / 2) / math.sqrt(2 * math.pi) / (S * sd)


def intrinsic(t, k, S):
    return max(0.0, S - k) if t == "C" else max(0.0, k - S)


class SpxLeaderboard0DTE(QCAlgorithm):
    def initialize(self):
        self.set_start_date(*START)
        self.set_end_date(*END)
        self.set_cash(100000)
        self.spx = self.add_index("SPX", Resolution.MINUTE).symbol
        opt = self.add_index_option(self.spx, "SPXW", Resolution.MINUTE)
        opt.set_filter(lambda u: u.include_weeklys().strikes(-30, 30).expiration(0, 0))
        self.spxw = opt.symbol
        self.day, self.days = None, []
        self.cur = None

    # ---------------- per day ----------------
    def new_day(self, d):
        self.day = d
        self.cur = {"date": str(d), "c": {}, "g": {}, "snaps": [900, 910, 930, 940], "plan": None, "p40": None,
                    "trades": [], "spot": {}}

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
        S, now_m, D = float(x.close), m + 1, self.cur
        chain = data.option_chains.get(self.spxw)
        quotes = {}
        if chain is not None:
            for c in chain:
                if c.expiry.date() != d:
                    continue
                t = "C" if c.right == OptionRight.CALL else "P"
                k = float(c.strike)
                rec = D["c"].setdefault(c.symbol, {"k": k, "t": t, "vol": 0.0, "pv": 0.0, "last": None})
                tb = data.bars.get(c.symbol)
                if tb is not None and tb.volume > 0:
                    rec["vol"] += float(tb.volume)
                    rec["pv"] += float(tb.volume) * float(tb.close)
                    rec["last"] = float(tb.close)
                rec["bid"], rec["ask"], rec["oi"] = float(c.bid_price), float(c.ask_price), float(c.open_interest)
                quotes[c.symbol] = rec
        if not quotes:
            return
        # gamma snapshots (first minute at/after each target that has quotes)
        while D["snaps"] and now_m >= D["snaps"][0]:
            tgt = D["snaps"].pop(0)
            D["g"][tgt] = self.gamma_map(quotes, S, now_m)
            D["spot"][tgt] = S
            if tgt == 930:
                self.plan(D, S, now_m)
            elif tgt == 940:
                self.final20(D, S, now_m)
        if now_m >= 955 and "bid55" not in D:
            D["bid55"] = True
            for tr in D["trades"]:
                r = D["c"].get(tr["sym"])
                tr["bid55"] = r["bid"] if r else None
        if m == 959:
            self.settle(D, S)

    def gamma_map(self, quotes, S, now_m):
        T = max(960 - now_m, 2) / 525600.0
        g = {}
        for r in quotes.values():
            if abs(r["k"] - S) > 60 or not (r["bid"] > 0 or r["ask"] > 0):
                continue
            mid = (r["bid"] + r["ask"]) / 2 if r["bid"] > 0 else r["ask"] / 2
            gm = gamma_of(mid, S, r["k"], T, r["t"] == "C") if mid > 0 else 0.0
            g[r["k"]] = g.get(r["k"], 0.0) + (1 if r["t"] == "C" else -1) * gm * max(r["oi"], r["vol"]) * 100
        return g

    def nodes(self, D, now_t, past_t):
        now_g, past = D["g"].get(now_t, {}), D["g"].get(past_t, {})
        ns = [{"k": k, "g": v, "d": v - past.get(k, 0.0)} for k, v in now_g.items()]
        grow = sorted([n for n in ns if n["d"] > 0], key=lambda n: -n["d"])
        big = sorted(ns, key=lambda n: -abs(n["g"]))
        pos = sorted([n for n in ns if n["g"] > 0], key=lambda n: -n["g"])
        return (grow[0]["k"] if grow else None), (big[0]["k"] if big else None), (pos[0]["k"] if pos else None)

    def atm(self, D, S, t):
        cs = [r for r in D["c"].values() if r["t"] == t and r["ask"] > 0]
        return min(cs, key=lambda r: abs(r["k"] - S)) if cs else None

    def buy(self, D, kind, d, S, now_m):
        r = self.atm(D, S, "C" if d == "bull" else "P")
        if r is None:
            return
        sym = next(s for s, v in D["c"].items() if v is r)
        D["trades"].append({"kind": kind, "dir": d, "sym": sym, "k": r["k"], "t": r["t"], "ask": r["ask"], "m": now_m})

    def plan(self, D, S, now_m):
        top = sorted([r for r in D["c"].values() if r["vol"] > 0], key=lambda r: -r["vol"])[:10]
        for r in top:
            vw = r["pv"] / r["vol"] if r["vol"] else None
            r["pnl"] = (r["last"] / vw - 1) if vw and r["last"] else 0.0
        tax = [r for r in top if r["vol"] >= BIG and r["pnl"] >= 0.2]
        lo, hi = int(math.floor(S * 0.99 / 5) * 5), int(math.ceil(S * 1.01 / 5) * 5)
        best = None
        for s in range(lo, hi + 1):
            pain = sum(r["vol"] * intrinsic(r["t"], r["k"], s) for r in top)
            if best is None or pain < best[1]:
                best = (s, pain)
        grow, big, pos = self.nodes(D, 930, 900)
        mp = best[0] if best else None
        pin = grow if grow is not None else mp if mp is not None else big
        victim = tax[0] if tax else None
        kd = ("bear" if victim["t"] == "C" else "bull") if victim else (("bull" if pin > S else "bear") if pin is not None and pin != S else None)
        D["plan"] = {"S": S, "top": [dict(r) for r in top], "tax": len(tax), "mp": mp, "grow": grow, "big": big, "pos": pos,
                     "pin": pin, "kd": kd, "victim": bool(victim)}
        if kd:
            self.buy(D, "kill 3:30", kd, S, now_m)

    def final20(self, D, S, now_m):
        grow, big, pos = self.nodes(D, 940, 910)
        mp = D["plan"]["mp"] if D["plan"] else None
        pin = grow if grow is not None else mp if mp is not None else big
        D["p40"] = {"S": S, "grow": grow, "big": big, "pos": pos, "mp": mp, "pin": pin}
        if pin is not None and abs(pin - S) >= 2:
            self.buy(D, "pin 3:40", "bull" if pin > S else "bear", S, now_m)

    def settle(self, D, S):
        if not D["plan"] or not D["p40"]:
            return
        for tr in D["trades"]:
            tr["settle"] = intrinsic(tr["t"], tr["k"], S)
        D["settle"] = S
        self.days.append(D)

    # ---------------- report ----------------
    def on_end_of_algorithm(self):
        def L(line):
            self.debug(line)               # Console tab (not counted in the 10 KB log limit)
            self.log(line)
        days = self.days
        L("=== Kill the Leaderboard on real SPXW 0DTE, %d full days ===" % len(days))
        # 1. fates of the top-10 at 3:30
        rows = []
        for D in days:
            P, St = D["plan"], D["settle"]
            for r in P["top"]:
                rows.append({"vol": r["vol"], "killed": intrinsic(r["t"], r["k"], St) == 0,
                             "itm330": intrinsic(r["t"], r["k"], P["S"]) > 0, "tax": r["vol"] >= BIG and r["pnl"] >= 0.2,
                             "pin_otm": P["pin"] is not None and intrinsic(r["t"], r["k"], P["pin"]) == 0})

        def fate(lab, rs):
            n = len(rs)
            if n:
                L("%-34s n %5d | killed %3d%% | finished ITM %3d%%" % (lab, n, round(sum(r["killed"] for r in rs) / n * 100),
                                                                     round(sum(not r["killed"] for r in rs) / n * 100)))
        L("-- 1. Top-10 contracts by volume at 3:30: who got killed at 4:00 --")
        fate("all top-10", rows)
        fate("100k+ volume", [r for r in rows if r["vol"] >= BIG])
        fate("50k-100k volume", [r for r in rows if 50000 <= r["vol"] < BIG])
        fate("under 50k volume", [r for r in rows if r["vol"] < 50000])
        fate("in the money at 3:30", [r for r in rows if r["itm330"]])
        fate("out of the money at 3:30", [r for r in rows if not r["itm330"]])
        fate("tax list (100k+, +20% vs VWAP)", [r for r in rows if r["tax"]])
        fate("ITM at 3:30, OTM vs the gamma pin", [r for r in rows if r["itm330"] and r["pin_otm"]])
        fate("ITM at 3:30, ITM vs the gamma pin", [r for r in rows if r["itm330"] and not r["pin_otm"]])
        # 2. calling the kills
        n = len(rows)
        if n:
            a_pin = sum(r["pin_otm"] == r["killed"] for r in rows) / n
            a_spot = sum((not r["itm330"]) == r["killed"] for r in rows) / n
            L("-- 2. Calling each top-10 contract dead or alive --")
            L("gamma pin (OTM vs the pin = killed): %d%% right | baseline (OTM at 3:30 = killed): %d%% right" % (round(a_pin * 100), round(a_spot * 100)))
            flip = [r for r in rows if r["pin_otm"] != (not r["itm330"])]
            if flip:
                L("where the two disagree (n %d): the pin was right %d%%" % (len(flip), round(sum(r["pin_otm"] == r["killed"] for r in flip) / len(flip) * 100)))
        # 3. pin error at 3:40
        L("-- 3. Pin: average distance from the 4:00 settlement (points) | within 5 pts --")
        for lab, f in (("SPX at 3:40 (do-nothing baseline)", lambda D: D["p40"]["S"]), ("bot's pin at 3:40", lambda D: D["p40"]["pin"]),
                       ("growing gamma node 3:40", lambda D: D["p40"]["grow"]), ("max pain (top-10) 3:30", lambda D: D["p40"]["mp"]),
                       ("biggest gamma strike 3:40", lambda D: D["p40"]["big"]), ("biggest positive-gamma node 3:40", lambda D: D["p40"]["pos"]),
                       ("SPX at 3:30", lambda D: D["plan"]["S"])):
            e = [abs(D["settle"] - f(D)) for D in days if f(D) is not None]
            if e:
                L("%-34s n %4d | avg %5.1f | median %5.1f | within 5: %3d%%" % (lab, len(e), sum(e) / len(e), sorted(e)[len(e) // 2], round(sum(x <= 5 for x in e) / len(e) * 100)))
        # 4. kill direction
        L("-- 4. Kill direction (SPX 3:30 -> settlement moved that way) --")
        for lab, ds in (("all days with a call", [D for D in days if D["plan"]["kd"]]),
                        ("tax-list days (shake the victim)", [D for D in days if D["plan"]["kd"] and D["plan"]["victim"]]),
                        ("empty board (toward the pin)", [D for D in days if D["plan"]["kd"] and not D["plan"]["victim"]])):
            if ds:
                ok = sum((D["settle"] - D["plan"]["S"]) * (1 if D["plan"]["kd"] == "bull" else -1) > 0 for D in ds)
                L("%-34s n %4d | right %3d%%" % (lab, len(ds), round(ok / len(ds) * 100)))
        # 5. trades
        L("-- 5. Trades: 1 ATM 0DTE bought at the ask, before fees --")

        def tstats(lab, ts, key):
            ts = [t for t in ts if t.get(key) is not None]
            if not ts:
                return
            pnl = [(t[key] - t["ask"]) * 100 for t in ts]
            gw, gl = sum(p for p in pnl if p > 0), -sum(p for p in pnl if p < 0)
            L("%-34s n %4d | win %3d%% | P/L $%+.0f (avg $%+.0f) | PF %.2f | avg cost $%.0f" % (
                lab, len(ts), round(sum(p > 0 for p in pnl) / len(ts) * 100), gw - gl, (gw - gl) / len(ts), gw / gl if gl else 99,
                sum(t["ask"] for t in ts) / len(ts) * 100))
        alltr = [t for D in days for t in D["trades"]]
        for kind in ("kill 3:30", "pin 3:40"):
            ts = [t for t in alltr if t["kind"] == kind]
            tstats(kind + " -> hold to settle", ts, "settle")
            tstats(kind + " -> sell 3:55 bid", ts, "bid55")
            if kind == "kill 3:30":
                vic = set(id(t) for D in days if D["plan"]["victim"] for t in D["trades"])
                tstats("   tax-list days only, settle", [t for t in ts if id(t) in vic], "settle")
                tstats("   empty-board days, settle", [t for t in ts if id(t) not in vic], "settle")
        L("tax list populated on %d of %d days" % (sum(1 for D in days if D["plan"]["victim"]), len(days)))
