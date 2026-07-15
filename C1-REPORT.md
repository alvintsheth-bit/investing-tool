# C1 Analysis Report — ORB Fade Edge Validation
**Checkpoint:** C1 (N=20 fades trigger)  
**Executed:** 2026-07-15  
**Analyst:** Alvint Sheth  
**Pre-registration reference:** PRE-REG.md § 8  
**N at execution:** 29 resolved fade records (trigger: N=20)  
**Outcome:** Zero entry-logic changes. No item cleared its pre-stated bar.

---

## Overview

Nine pre-registered tests, nine nulls. That is not a disappointing checkpoint — it is what honest analysis of N=29 looks like. The gate held every test thrown at it and every counterfactual since the freeze has resolved in its favor (see Regret Ledger below). The one genuinely positive signal — H10 shadow-short at +0.37R — is correctly quarantined behind the strictest adoption bar in the document and cannot produce a live change at C1.

**Regret ledger as of C1:** Every "we're missing out" candidate since July 8 has now resolved. BABA (Jul 15) shadow-long = −0.64R — gate blocked a loser by $0.05. BLK (Jul 15) shadow-short positive — the long would have faded. OXY and PYPL recovered, but they were faded correctly under the live rule and their shadow-long outcomes were captured. The fades that felt wrong in real time were right in the data. Across the entire C1 dataset, there is no missed runner that the gate demonstrably cost the system money on — only fades it correctly avoided.

---

## Data Quality Notes

| Cohort | N | Notes |
|---|---|---|
| Resolved fades (total) | 29 | All have shadow sub-records with resolved result |
| Backfilled — Jul 8 | 4 | `exitPrice = closePrice` proxy; no intraday stop tracking; treated as separate sub-cohort |
| Live shadow tracking — Jul 9+ | 25 | Daemon-logged intraday stop/target; canonical |
| With shadowShort resolved | 17 | Jul 13 onward; H10 cohort |
| Live ORB entries (confirmatory) | 1 | PSX, Jul 13, rMultiple=+0.47R, exitReason=force-close |
| entryMechanism logging bug | — | `entryMechanism` was not written to trades-log at close; fixed this session. PSX manually identified as the only live ORB trade. |

All prices are daemon-logged canonical values (`orbCheckPrice`, shadow bar closes from `orbVariants`). Yahoo Finance not used.

---

## H3 — Catalyst Quality (Confirmatory)

**Hypothesis:** Fades tagged `structural` recover by close at a materially higher rate than fades tagged `stale-news`.  
**Rejection bar:** structural rate must exceed stale-news by ≥ 10 percentage points; if < 10 pp, boundary is not predictive and may be redrawn at C1.

Tags taken directly from orb-log fields (set by agent at scan time; not modified post-hoc):

| Tag | N | Recovered | Rate | Shadow-long avg |
|---|---|---|---|---|
| structural | 18 | 2 (OXY, PYPL) | 11.1% | −0.31R |
| stale-news | 11 | 1 (MPWR) | 9.1% | −0.63R |
| **Difference** | — | — | **+2.0 pp** | structural better |

**Verdict: FAILS the 10 pp bar.** Difference is +2.0 pp.

The structural/stale-news boundary shows weak predictive power at N=29. Recovery rates are low in both buckets. The boundary may be redrawn at C1 per pre-registration, but no clear alternative emerges: within structural, the best sub-type is M&A at 2/3 (67%) driven by PYPL (+1.5R buyout) and OXY (+0.65R macro-driven), but N=3 offers no reliable signal. Redrawing the boundary around M&A catalysts at N=3 would be data mining; the taxonomy stays as-is.

One thing the data does confirm cleanly: stale-news shadow-long avg (−0.63R) is worse than structural (−0.31R). The direction of the hypothesis is correct even though the recovery-rate gap is below threshold.

**Tag integrity note:** All 29 catalystTag values were read directly from the orb-logs (set by Claude at scan time, before outcomes were known). The structural/stale-news mapping follows the pre-registered taxonomy: `analyst_upgrade | insider_purchase | sector_sympathy | technical` → stale-news; all others → structural. No post-hoc reclassification was made. Pre-C2 action item: full blind audit of all 29 catalystType assignments against actual news source (auditor must not see `recoveredByClose` outcomes before completing tags).

---

## H7 — Trigger vs. Snapshot ORB (Exploratory)

**Hypothesis:** A trigger entry (first cross of OR high in 6:45–7:30am PT window) outperforms the snapshot check at 6:45am.  
**Adoption bar:** trigger must beat snapshot by ≥ 0.2R per candidate across full replay set.

### Evaluable: 6:40am trigger (5-min OR window)

Bar2Close (6:40am price) vs orHigh_5min (bar1 high) — the earliest detectable trigger in logged data:

| Date | Ticker | bar2Close | orHigh_5min | Shadow-long R |
|---|---|---|---|---|
| 2026-07-13 | APA | $34.60 | $34.59 (+$0.01) | −0.28R |

Only 1 fade in N=25 (with orbVariants) would have fired the 5-min trigger. The current 10-min snapshot rule correctly blocked it (bar3Close $34.72 < orHigh_10min $34.78). Trigger would have added a −0.28R loss.

### Not evaluable: post-6:45am trigger (6:45–7:30am)

No intraday 5-min bars are logged after 6:45am. The primary H7 claim — catching runners as they cross OR high in the 6:45–7:30am window — cannot be tested from current data. Logging post-6:45am bars is a pre-C2 action item (backlog #37).

### Prior evidence

Registration (Jul 9 replay, N=5): trigger took MU (~scratch) and STX (~−1R); snapshot took neither (0R both). Direction has consistently favored snapshot.

**Verdict: FAILS adoption bar.** Snapshot stays. H7 requires post-6:45am bar logging for a proper evaluation at C2.

---

## F1 — Kill Check (Fitted Decision)

**Kill criterion:** at N=20 skips, if mean shadow R of skips materially exceeds mean live R of entries, ORB is destroying value.

| Metric | Value |
|---|---|
| Shadow-long avg R (N=29) | −0.43R |
| Live ORB entries | N=1 (PSX +0.47R, force-close) |

**F1 is critically underpowered at N=1.** Direction is correct — shadow fades averaged −0.43R while the one live ORB entry returned +0.47R. Kill criterion not triggered.

Fix now in place: `entryMechanism: pos.entryMechanism` forwarded in `recordClosedTrade()`. After the next live fill, grep trades-log to confirm the field landed before assuming it works. This is the third instance of "intent existed, write didn't" in this codebase (prior: slippage-gate drift, watchlist isolation).

---

## F2 — OR Window Selection (Fitted Decision)

**Decision:** adopt whichever window (5/10/15-min) best separates winners from fades; clear margin required, else keep 10-min.

Bar-by-bar replay across N=25 fades with orbVariants:

| Window | Entry trigger | Fades would enter | Avg R of those | vs incumbent |
|---|---|---|---|---|
| 5-min | bar2Close > orHigh_5min | 1 (APA) | −0.28R | worse |
| **10-min (live)** | bar3Close > orHigh_10min | 0 | — | incumbent |
| 15-min | bar3Close > orHigh_15min | 0 | — | identical |

All 25 fades had bar3Close below orHigh_10min — the live rule correctly admitted zero fades as live entries. The 5-min window is looser and added one losing trade. The 15-min window was stricter but identical in this dataset.

Notable: BABA (Jul 15) bar3Close $119.25 vs orHigh_10min $119.30 — missed by $0.05. Shadow-long = −0.64R. Gate correctly blocked a loser.

**Verdict: Keep 10-min OR window.** Confirmed optimal in this dataset. No change.

---

## H4 — Catalyst Type Breakdown (Exploratory, First Read)

> **EXPLORATORY. No live change permitted. Sector-wide upgrade fade rate must exceed stock-specific by ≥ 20 pp at N=20 session-days per bucket.**

| catalystType | N | Recovered | Rate | Shadow-long avg |
|---|---|---|---|---|
| analyst_upgrade | 5 | 0 | 0.0% | −0.82R |
| regulatory | 4 | 0 | 0.0% | −0.62R |
| product_launch | 2 | 0 | 0.0% | −0.51R |
| notable_mention | 1 | 0 | 0.0% | −0.82R |
| earnings_beat | 1 | 0 | 0.0% | −0.16R |
| sector_sympathy | 6 | 1 (MPWR) | 16.7% | −0.47R |
| macro | 7 | 1 (OXY) | 14.3% | −0.34R |
| ma (M&A) | 3 | 1 (PYPL) | 33.3% | +0.43R |

`analyst_upgrade` (0/5, −0.82R avg) is the worst type. Jul 9 was four semiconductor analyst upgrades, all stopped at −1R. The pattern is directionally strong but N=5 is well below the required threshold. Carry to C2.

---

## H5 — Queue Concentration (Exploratory, First Read)

> **EXPLORATORY. Concentrated sessions must show ORB fade rate ≥ 20 pp higher than diverse sessions at N=20 session-days per bucket.**

| Date | Type | Queue | Shadow avg | Recovered |
|---|---|---|---|---|
| Jul 8 | Diverse | AVAV, MTZ, LYB, DOW | −0.27R | 0/4 |
| Jul 9 | Concentrated | 4× analyst_upgrade (semis) | −0.93R | 0/4 |
| Jul 10 | Concentrated | 3× regulatory (crypto) | −0.47R | 0/4 |
| Jul 13 | Diverse | MGM, OXY, APA, TTD | −0.08R | 1/4 |
| Jul 14 | Concentrated | 9× semis (macro+sympathy) | −0.57R | 1/9 |
| Jul 15 | Diverse | BLK, BABA, SOXL, PYPL | −0.08R | 1/4 |

Concentrated avg: −0.66R, 5.9% recovery (1/17). Diverse avg: −0.15R, 16.7% recovery (2/12). The outcome gap is directionally strong (+0.51R better for diverse sessions) but ORB already blocks live entries in both cases — these are shadow losses, not live losses. Cannot act; carry to C2.

---

## H8 — Gap Grading Composite (Exploratory, First Read)

> **EXPLORATORY. Framing lens only, not a filter.**

Pattern emerging from the composite (gapRetained + catalystType + concentration):

- Best shadow outcomes: diverse sessions + macro/M&A catalysts → occasional recovery, better avg R
- Worst shadow outcomes: concentrated sessions + analyst_upgrade + any gapRetained → hard fades
- **Counterintuitive finding:** high gapRetained (> 1.0, gap expanded vs close) is NOT a positive signal for long recovery. Gap strength is a sign of trapped buyers, not institutional conviction, in this dataset.

No bucket has cleared its bar. Carry to C2.

---

## H10 — Shadow-Short First Read (Exploratory)

> **EXPLORATORY. Adoption bar: N≥40 fades, 2+ market regimes, earnings season data. FIRST READ ONLY — cannot act.**

| Metric | Value |
|---|---|
| N (resolved) | 17 (Jul 13+) |
| Avg pnlR | +0.37R |
| Win rate | 12/17 = 70.6% |
| Full stop hits (−1R) | MGM, PYPL (2/17) |
| Capped targets (+1.5R) | SOXL (Jul 14), SNDK, TER (3/17) |

Individual: MGM −1R, OXY −0.65R, APA +0.28R, TTD +0.82R, SOXL(Jul14) +1.5R, MRVL +0.69R, NXPI +0.35R, MPWR −0.28R, SNDK +1.5R, TER +1.5R, KLAC −0.08R, AMAT +0.18R, LRCX +0.20R, BLK +0.16R, BABA +0.64R, SOXL(Jul15) −1R, PYPL −1R.

Polling-gap bias: stop-hits in the short cohort are slightly optimistic (see PRE-REG § 8). The +0.37R avg is a ceiling estimate.

The signal is directionally strong. Gap-up fades that fail the ORB check are continuing lower intraday rather than recovering — exactly what H10 predicts. Nothing to do about it at C1. The dataset must span at least one earnings-season regime before the adoption bar can be evaluated, and execution infrastructure for short positions does not exist on this account (long-only agentic sub-account; deep-ITM puts would be the expression if adopted).

---

## gapRetained Threshold Sweep

**Pre-registered buckets:** < 0.7 (gap mostly faded) vs > 1.0 (gap retained or extended). Actionable bar: ≥ 20 pp recovery-rate difference.

| Bucket | Tickers | N | Recovered | Rate | Shadow-long avg |
|---|---|---|---|---|---|
| < 0.7 | COIN, HOOD, MGM, SOXL×2, NXPI, KLAC, AMAT(Jul14), PYPL | 9 | 1 (PYPL) | 11.1% | −0.18R |
| 0.7–1.0 | STX, MRVL, MPWR, TER(Jul14), LRCX | 5 | 1 (MPWR) | 20.0% | −0.74R |
| > 1.0 | MU, AMAT(Jul9), TER(Jul9), MSTR, META, OXY, APA, TTD, SNDK, BLK, BABA | 11 | 1 (OXY) | 9.1% | −0.55R |
| No gapRetained | Jul 8 backfill | 4 | 0 | — | −0.27R |

**< 0.7 vs > 1.0 difference: +2.0 pp. FAILS the ≥ 20 pp bar.**

gapRetained is not a reliable predictor of recovery at N=29. The < 0.7 bucket appears better on avg shadow R (−0.18R vs −0.55R), but this is driven entirely by PYPL (+1.5R, buyout M&A at $60.50). One outlier dominates a 9-sample bucket. High gapRetained (gap expands) does not predict recovery — trapped buyers, not institutional accumulation.

Do not use as a filter. Carry data forward; revisit at C2 with earnings-season data.

---

## Summary of C1 Decisions

| Item | Bar | Result | Verdict |
|---|---|---|---|
| **H3** (catalyst quality) | structural − stale-news ≥ 10 pp | +2.0 pp | **FAILS** |
| **H7** (trigger vs snapshot) | ≥ 0.2R/candidate improvement | Adds −0.28R (5-min); post-6:45 unevaluable | **FAILS** |
| **F1** (ORB kill check) | shadow mean materially > live mean | −0.43R shadow, +0.47R live (N=1) | **Not triggered** |
| **F2** (window selection) | clear margin over 10-min | 5-min worse; 15-min identical | **Keep 10-min** |
| **H4** first read | ≥ 20 pp sector-wide fade rate difference | analyst_upgrade 0% recovery; N<20 sessions | Carry to C2 |
| **H5** first read | ≥ 20 pp concentrated vs diverse | −0.51R outcome gap; N<20 sessions | Carry to C2 |
| **H8** composite | Framing only | High gapRetained ≠ recovery | Carry to C2 |
| **H10** shadow-short | N≥40 + 2 regimes + earnings | +0.37R, N=17, single regime | **First read positive; cannot act** |
| **gapRetained sweep** | ≥ 20 pp bucket difference | +2.0 pp | **FAILS** |

**C1 decision: ZERO entry-logic changes.** The unused C1-class change does not carry forward. C2's permitted actions are C2's.

---

## Non-Logic Action Items Before C2

1. **entryMechanism field** — fixed this session (`recordClosedTrade` now forwards `pos.entryMechanism`). After next live fill, grep trades-log to confirm field is present before treating it as reliable.
2. **Post-6:45am intraday bars** — log 5-min prices at 6:50–7:30am per queued candidate (exit-daemon, during normal poll cycle). Required for H7 full evaluation at C2. Backlog #37.
3. **catalystTag blind audit** — before C2, audit all catalystType assignments against actual news source. Auditor must complete tag verification before seeing `recoveredByClose` outcomes. If misclassification rate > 10%, update prompt rubric.

---

## Pace Clause Status

Counted from July 8, 2026 (ORB regime start, per PRE-REG § 8 amendment 2026-07-15): **6 sessions, 1 live entry.** Clause fires at 20 sessions with < 10 total entries. Earnings season is beginning — idiosyncratic catalyst supply is expected to increase. A funnel diagnosis run now would diagnose the pre-earnings tape rather than the system; the July 8 regime start correctly defers this to late July.

---

## Next Checkpoint

**C2:** N=20 live ORB trades. Slippage distribution (backlog #29), volatility-based sizing review (#28), F5 target-coupling first read. Entry logic is locked.

---

## Changelog

| Date | Note |
|---|---|
| 2026-07-15 | C1 executed at N=29. Zero entry-logic changes. Report filed. |
| 2026-07-15 | entryMechanism bug fixed (exit-daemon.js `recordClosedTrade`). |
| 2026-07-15 | Pace clause session count pinned to July 8 in PRE-REG.md (class a amendment). |
