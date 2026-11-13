// Self-training: after every close the bot re-scores what worked and adjusts what it trades and how it exits.
//
// Data it learns from:
//   - the scorecard ("bot:stats"): every SPX/SPY signal, graded in R on the underlying, whether traded or not
//     (so a setup that was switched off keeps being measured and can be switched back on)
//   - paper trades ("paper:trades"): real option results (counted double), plus each trade's option price path,
//     followed for 30 minutes after the exit so other exit settings can be replayed
//
// What it changes (paper only; every change is posted to #signals and listed in the journal):
//   1. setup families on/off: off when 15+ results average worse than -0.15R (shrunk toward 0, so a few results can't decide)
//   2. context adjustments: time window, chop, gamma regime, with/against your plan, VIX agreement
//   3. minimum A/A+ score: raised when a score band loses money, lowered again when it recovers
//   4. exit settings (stop, target 1, time stop): walk-forward test, older 70% of trades to fit, newest 30% to check;
//      a change is kept only if it is better on both
// Hard limits it can never change: stop at most -30% (max loss 15% of the account), sizing, daily limits, entry window.

export const DEFAULT_PARAMS = {
  stopPct: 0.30,      // premium stop
  t1Pct: 0.60,        // target 1 (sell half)
  bePct: 0.25,        // stop to breakeven
  lockPct: 0.50,      // at +50% ...
  lockTo: 0.20,       // ... stop to +20%
  runnerStop2: 0.30,  // 2+ contracts: runner stop after target 1
  runnerStop1: 0.40,  // 1 contract: stop after target 1
  keep2: 0.65,        // trail keeps 65% of the best gain (70% with 1 contract)
  keep1: 0.70,
  timeStopMin: 10,    // no +10% within 10 minutes: out
  timeStopGain: 0.10,
  stallMin: 15,       // runner makes no new high for 15 minutes: out
};
export const DEFAULT_MODEL = { v: 0, updated: null, lastRun: null, fams: {}, feats: {}, minScore: 70, threshold: -0.15, params: { ...DEFAULT_PARAMS }, changes: [] };

const PRIOR = 10;      // results worth of "0R" every average starts from
const MIN_N = 15;      // results needed before a family can be switched off ...
const MIN_DAYS = 3;    // ... from at least 3 different days (one bad day can't switch a setup off)
const OFF_R = -0.15;
const ON_R = 0;        // a switched-off family comes back above this
const r2 = (x) => Math.round(x * 100) / 100;

export const FAM_NAMES = {
  star: "A/A+ setups", mom: "Momentum", flip: "Phase flip", squeeze: "Squeeze", box: "10m compression breakout",
  div1m: "1m divergence", div3m: "3m divergence", cbox1m: "1m compression breakout", cbox3m: "3m compression breakout",
  "plan-trigger": "Your plan triggers",
};
export const famOf = (key) => {
  const [p, a, b] = String(key).split(":");
  if (p === "div" || p === "cbox") return p + a;
  if (p === "plan") return /^scn/.test(b || "") ? "plan-scenario" : "plan-trigger";
  return p;
};
export const windowOf = (etStr) => {
  const [h, m] = String(etStr || "0:0").split(":").map(Number), mm = h * 60 + m;
  return mm < 630 ? "open" : mm < 690 ? "morning" : mm < 810 ? "midday" : mm < 900 ? "afternoon" : "late";
};
// context features of a signal / candidate / trade
export function features(x) {
  const c = x.ctx || {};
  return {
    grade: x.kind === "star" || x.fam === "star" ? x.grade || "A" : null,
    win: windowOf(x.et),
    chop: c.chop == null ? null : c.chop ? "choppy" : "trending",
    gex: c.gex || null,
    plan: c.plan || null,
    vix: c.vix == null ? null : c.vix ? "agrees" : "disagrees",
  };
}
const shrunk = (sum, n) => sum / (n + PRIOR);

// Should the paper bot take this candidate? Returns { ok, est, why }.
export function decide(model, cand) {
  const m = model || DEFAULT_MODEL;
  const F = m.fams[cand.fam];
  if (F && F.off) return { ok: false, est: F.r, why: `${FAM_NAMES[cand.fam] || cand.fam} is switched off by learning (${F.n} results, avg ${F.r}R)` };
  if (cand.fam === "star" && cand.score != null && cand.score < m.minScore) return { ok: false, why: `score ${cand.score} under the learned minimum ${m.minScore}` };
  let est = F ? F.r : 0;
  const parts = [];
  for (const [k, v] of Object.entries(features(cand))) {
    const adj = v != null && m.feats[k + "=" + v];
    if (adj) { est += adj.adj; if (Math.abs(adj.adj) >= 0.05) parts.push(`${k} ${v} ${adj.adj > 0 ? "+" : ""}${adj.adj}R`); }
  }
  est = r2(est);
  if (est < m.threshold) return { ok: false, est, why: `expected ${est}R is under ${m.threshold}R (${parts.join(", ") || "history"})` };
  return { ok: true, est, why: parts.join(", ") };
}

// Replays one option price path (premium % change per minute from entry) with exit settings P.
export function replay(path, P, two) {
  let stop = -P.stopPct, best = 0, bestAt = 0, t1 = false, realized = 0, open = 1;
  for (let i = 0; i < path.length; i++) {
    const pct = path[i];
    if (pct > best) { best = pct; bestAt = i; }
    if (best >= P.bePct) stop = Math.max(stop, 0);
    if (best >= P.lockPct) stop = Math.max(stop, P.lockTo);
    if (!t1 && pct >= P.t1Pct) {
      t1 = true;
      if (two) { realized += 0.5 * pct; open = 0.5; stop = Math.max(stop, P.runnerStop2); } else stop = Math.max(stop, P.runnerStop1);
    }
    if (t1) stop = Math.max(stop, (two ? P.keep2 : P.keep1) * best);
    if (pct <= stop) return realized + open * pct;
    if (!t1 && i >= P.timeStopMin && best < P.timeStopGain) return realized + open * pct;
    if (t1 && i - bestAt >= P.stallMin) return realized + open * pct;
  }
  return realized + open * (path.length ? path[path.length - 1] : 0);
}
const avgReplay = (trades, P) => trades.reduce((s, x) => s + replay(x.path, P, x.qty >= 2), 0) / (trades.length || 1);

// The nightly training run. Returns { model, changes }.
export function learn(prev, statsItems, trades, today) {
  const m = JSON.parse(JSON.stringify(prev || DEFAULT_MODEL));
  m.params = { ...DEFAULT_PARAMS, ...m.params };
  const changes = [];
  // samples: SPX/SPY signals graded in R (last 1500), paper trades in R of their dollar risk (counted twice)
  const sig = (statsItems || []).filter((x) => x.R != null && (x.sym === "SPY" || x.sym === "$SPX")).slice(-1500)
    .map((x) => ({ date: x.date, fam: x.fam || famOf(x.key || "") || kindFam(x), kind: x.kind, grade: x.grade, score: x.score, et: x.et, ctx: x.ctx, R: Math.max(-1.5, Math.min(4, x.R)), w: 1 }));
  const pt = (trades || []).filter((x) => x.R != null).map((x) => ({ ...x, R: Math.max(-1.5, Math.min(4, x.R)), w: 2 }));
  const all = [...sig, ...pt].filter((x) => x.fam);
  const tot = all.reduce((s, x) => s + x.w, 0), sumAll = all.reduce((s, x) => s + x.R * x.w, 0);
  const base = shrunk(sumAll, tot);

  // 1. families
  const byFam = {};
  for (const x of all) { const f = (byFam[x.fam] = byFam[x.fam] || { n: 0, sum: 0, wins: 0, trades: 0, days: new Set() }); f.days.add(x.date); f.n += x.w; f.sum += x.R * x.w; if (x.R > 0) f.wins += x.w; if (x.w === 2) f.trades++; }
  for (const [fam, f] of Object.entries(byFam)) {
    const r = r2(shrunk(f.sum, f.n)), was = m.fams[fam] && m.fams[fam].off;
    const off = was ? !(r > ON_R) : f.n >= MIN_N && f.days.size >= MIN_DAYS && r < OFF_R;
    if (off !== !!was) changes.push(`${off ? "⛔ Switched OFF" : "✅ Switched back ON"}: ${FAM_NAMES[fam] || fam} (${f.n} results, avg ${r}R, win ${Math.round((f.wins / f.n) * 100)}%)`);
    m.fams[fam] = { n: f.n, days: f.days.size, r, win: r2(f.wins / f.n), trades: f.trades, off };
  }

  // 2. context adjustments (difference from the overall average, shrunk; only with 8+ results)
  const feats = {};
  for (const x of all) for (const [k, v] of Object.entries(features(x))) {
    if (v == null) continue;
    const f = (feats[k + "=" + v] = feats[k + "=" + v] || { n: 0, sum: 0 }); f.n += x.w; f.sum += x.R * x.w;
  }
  const newFeats = {};
  for (const [k, f] of Object.entries(feats)) {
    if (f.n < 8) continue;
    const adj = r2(Math.max(-0.5, Math.min(0.5, shrunk(f.sum, f.n) - base)));
    newFeats[k] = { n: f.n, adj };
    const old = m.feats[k] ? m.feats[k].adj : 0;
    if (Math.abs(adj - old) >= 0.15) changes.push(`📊 ${k.replace("=", ": ")} now ${adj > 0 ? "+" : ""}${adj}R (was ${old > 0 ? "+" : ""}${old}R, ${f.n} results)`);
  }
  m.feats = newFeats;

  // 3. minimum A/A+ score
  const band = (lo, hi) => { const b = all.filter((x) => x.fam === "star" && x.score != null && x.score >= lo && x.score < hi); const n = b.reduce((s, x) => s + x.w, 0); return { n, r: shrunk(b.reduce((s, x) => s + x.R * x.w, 0), n) }; };
  const b70 = band(70, 80), b80 = band(80, 90);
  const days = new Set(all.map((x) => x.date)).size;
  const minScore = days < MIN_DAYS ? m.minScore : b70.n >= MIN_N && b70.r < OFF_R ? (b80.n >= MIN_N && b80.r < OFF_R ? 90 : 80) : 70;
  if (minScore !== m.minScore) changes.push(`🎚️ Minimum A/A+ score ${m.minScore} → ${minScore} (70-79: ${b70.n} results ${r2(b70.r)}R; 80-89: ${b80.n} results ${r2(b80.r)}R)`);
  m.minScore = minScore;

  // 4. exit settings, walk-forward, from paper trades with a price path
  const withPath = (trades || []).filter((x) => Array.isArray(x.path) && x.path.length >= 3).sort((a, b) => a.at - b.at).slice(-200);
  if (withPath.length >= 20) {
    const cut = Math.floor(withPath.length * 0.7), fit = withPath.slice(0, cut), check = withPath.slice(cut);
    const cur = m.params;
    let best = cur, bestFit = avgReplay(fit, cur);
    for (const stopPct of [0.2, 0.25, 0.3]) for (const t1Pct of [0.4, 0.6, 0.8, 1.0]) for (const timeStopMin of [10, 15, 20]) {
      const P = { ...cur, stopPct, t1Pct, timeStopMin };
      const s = avgReplay(fit, P);
      if (s > bestFit) { bestFit = s; best = P; }
    }
    const curFit = avgReplay(fit, cur), curChk = avgReplay(check, cur), newChk = avgReplay(check, best);
    if (best !== cur && bestFit - curFit >= 0.02 && newChk - curChk >= 0.02) {
      changes.push(`🎯 Exits: stop −${Math.round(cur.stopPct * 100)}% → −${Math.round(best.stopPct * 100)}%, target 1 +${Math.round(cur.t1Pct * 100)}% → +${Math.round(best.t1Pct * 100)}%, time stop ${cur.timeStopMin} → ${best.timeStopMin} min `
        + `(fit ${Math.round(curFit * 100)}% → ${Math.round(bestFit * 100)}% avg per trade; check on newer trades ${Math.round(curChk * 100)}% → ${Math.round(newChk * 100)}%)`);
      m.params = { ...best, stopPct: Math.min(0.3, best.stopPct) };
    }
  }

  m.base = r2(base);
  m.samples = { signals: sig.length, trades: pt.length };
  m.lastRun = today;
  if (changes.length) {
    m.v = (m.v || 0) + 1;
    m.updated = today;
    m.changes = [...changes.map((text) => ({ date: today, v: m.v, text })), ...(m.changes || [])].slice(0, 60);
  }
  return { model: m, changes };
}
// older scorecard rows have no family: derive it from the kind and title
function kindFam(x) {
  if (x.kind === "star") return "star";
  if (x.kind === "momentum") return "mom";
  if (x.kind === "phase") return /SQUEEZE/.test(x.title) ? "squeeze" : /COMPRESSION/.test(x.title) ? "box" : "flip";
  if (x.kind === "setup") { const tf = /\b1m\b/.test(x.title) ? "1m" : "3m"; return /DIVERGENCE/.test(x.title) ? "div" + tf : /COMPRESSION/.test(x.title) ? "cbox" + tf : null; }
  if (x.kind === "plan") return "plan-trigger";
  return null;
}
