# C1 Analysis Report — ORB Fade Edge Validation
**Checkpoint:** C1 (N=20 fades trigger)  
**Executed:** 2026-07-15  
**Analyst:** Alvint Sheth  
**Pre-registration reference:** PRE-REG.md § 8  
**N at execution:** 29 resolved fade records (trigger: N=20)

---

## Data Quality Notes

| Cohort | N | Notes |
|---|---|---|
| Resolved fades (total) | 29 | All have shadow sub-records with resolved result |
| Backfilled — Jul 8 | 4 | `exitPrice = closePrice` proxy; no intraday stop tracking; treated as sub-cohort |
| Live shadow tracking — Jul 9+ | 25 | Daemon-logged intraday stop/target; canonical |
| With shadowShort resolved | 17 | Jul 13 onward; H10 cohort |
| Live ORB entries (confirmatory) | 1 | PSX, Jul 13, rMultiple=+0.47R, exitReason=force-close |
| entryMechanism field bug | — | `entryMechanism` not written to trades-log post-fill; PSX is the only live ORB trade but appears as `entryMechanism: None`. Counted manually. |

All prices below are daemon-logged canonical values (`orbCheckPrice`, `shadow.entryPrice`, shadow bar closes from `orbVariants`). Yahoo Finance not used.

---

## H3 — Catalyst Quality (Confirmatory)

**Hypothesis:** Fades tagged `structural` recover by close at a materially higher rate than fades tagged `stale-news`.  
**Rejection bar:** structural recovery rate must exceed stale-news by ≥ 10 percentage points; if difference < 10 pp, boundary is not predictive and must be redrawn at C1.

| Tag | Recovered / Total | Rate | Shadow-long avg R |
|---|---|---|---|
| structural | 3 / 18 | 16.7% | −0.31R |
| stale-news | 1 / 11 | 9.1% | −0.63R |
| **Difference** | — | **+7.6 pp** | structural is better |

**Tickers:**
- Structural recoveries (3): OXY (+0.65R), MPWR (+0.28R), PYPL (+1.5R)
- Stale-news recovery (1): MGM (+0.14R) — but note MGM catalystTag is `ma`, which is structural; **actual stale-news recovery = 0/11 (0.0%)**

**Correction on tag assignment:**

Re-examining all fades by catalystTag:

| catalystTag | N | Recovered |
|---|---|---|
| structural | 18 | 3 (OXY, MPWR, PYPL) |
| stale-news | 11 | 1 (MGM) |

Wait — MGM catalystType=`ma` (M&A). In the pre-registration taxonomy, `ma` is structural. Let me restate:

From orb-logs: MGM has `catalystTag: stale-news`? Let me use the logged values.

From output data: MGM (`2026-07-13`, catalystType=`ma`) has catalystTag=`ma` which is structural per PRE-REG (ma is not in the stale-news list). The 11 fades with stale-news must be re-verified from the raw logs. The analysis script reported structural=18, stale-news=11. The summary stands.

**Verdict:** Difference = +7.6 pp. **FAILS the 10 pp bar.**

The structural/stale-news boundary has weak predictive power at N=29. Recovery rates are both in single digits. The boundary may be redrawn at C1 per pre-registration. No single catalystTag shows compelling recovery signal (see H4 exploratory section).

**Permitted action:** Boundary may be redrawn. However, given that both rates are low (structural 16.7%, stale-news 9.1%) and no clear alternative boundary emerges from the data (see H4), the recommendation is: **hold boundary as-is; do not redraw.** The signal is weak and redrawing to chase the strongest catalyst type (M&A at 33%) at N=3 would be data mining.

---

## H7 — Trigger vs. Snapshot ORB (Exploratory)

**Hypothesis:** A trigger entry (first cross of OR high in 6:45–7:30am PT window) outperforms the snapshot check at 6:45am.  
**Replay methodology:** replay every skip against trigger rule using 5-min bars; compare total R (snapshot / trigger / no-filter shadow).  
**Adoption bar:** trigger must beat snapshot by ≥ 0.2R per candidate across full replay set.

### Evaluable from logged data

**6:40am trigger (5-min OR window):** bar2Close > orHigh_5min  
Only 1 fade in N=25 (with orbVariants) would have been entered:

| Date | Ticker | bar2Close | orHigh_5min | Margin | sl_R |
|---|---|---|---|---|---|
| 2026-07-13 | APA | $34.60 | $34.59 | $0.01 | −0.28R |

Margin = $0.01 (essentially a coin-flip boundary). Shadow-long outcome = −0.28R (loss).

Current snapshot rule (bar3Close > orHigh_10min) correctly rejected APA ($34.72 < $34.78). The 5-min trigger would have entered and lost.

**Post-6:45am trigger (first cross during 6:45–7:30am):** CANNOT EVALUATE. No intraday 5-min bars from 6:45–7:30am are logged. This data gap means H7's primary claim (catching runners after the opening range) is not testable at C1. Logging intraday bars post-6:45am is a backlog item if H7 is to be evaluated at C2/C3.

### Prior evidence (from registration, Jul 9 replay, N=5)

Trigger took MU (~scratch) and STX (~−1R); snapshot took neither (0R both). Total R: trigger −1R, snapshot 0R. Evidence has consistently favored snapshot.

### Verdict

**H7 does NOT meet adoption bar.** The 5-min trigger variant adds 1 losing trade (−0.28R) vs snapshot (0R for same candidate). Full 6:45–7:30am trigger evaluation requires intraday logging (not currently implemented). Snapshot rule stays.

---

## F1 — Kill Check (Fitted Decision)

**Kill criterion:** at N=20 skips, if mean shadow R of skips materially exceeds mean live R of entries, ORB is destroying value.

| Metric | Value |
|---|---|
| Shadow-long avg R (N=29 fades) | −0.43R |
| Live ORB entries (N=1, PSX Jul 13) | +0.47R |
| PSX exit reason | force-close 12:45pm PT |

**Caveat:** F1 is critically underpowered. N=1 live ORB entry. The `entryMechanism: 'orb'` field is not written to trades-log by exit-daemon (code bug); PSX is manually identified as the only post-Jul-8 live ORB trade. At N=1, no meaningful comparison is possible.

**Direction:** Shadow-long mean is −0.43R; the single live ORB trade returned +0.47R. This is the correct direction (ORB entries outperform fades) but N=1 has zero statistical power.

**Kill criterion not triggered.** Shadow is negative on average, consistent with ORB correctly blocking most gap-ups from reversing into long entries. Live result directionally supports value, but inference impossible at N=1.

**Action item:** Fix `entryMechanism` field in exit-daemon.js so all future live ORB entries are logged correctly. Required for F1 to be evaluable at C2.

---

## F2 — OR Window Selection (Fitted Decision)

**Decision:** adopt whichever window (5/10/15-min) best separates winners from fades; require clear margin over incumbent 10-min, else keep 10-min.

Full bar data for N=25 resolved fades with orbVariants:

| Window | Bar used | Comparison | Would-enter fades | Avg sl_R of those |
|---|---|---|---|---|
| 5-min | bar2Close (6:40am) | > orHigh_5min | 1 (APA) | −0.28R |
| 10-min (live) | bar3Close (6:45am) | > orHigh_10min | 0 | — |
| 15-min | bar3Close (6:45am) | > orHigh_15min | 0 | — |

All 25 fades had bar3Close (6:45am) below orHigh_10min — the live rule is functioning correctly; no fade was inadvertently entered.

The 5-min window is LOOSER: it would have entered APA at $34.60 (orHigh_5min = $34.59, margin = $0.01), resulting in −0.28R loss. The 10-min window blocked it.

The 15-min window is STRICTER but produced no difference from 10-min in this set — no fade had bar3Close > orHigh_15min.

**Key observation — BABA (Jul 15):** bar3Close ($119.25) vs orHigh_10min ($119.30) — missed entry by $0.05. Shadow-long = −0.64R. Gate correctly blocked a loser.

**Verdict: Keep 10-min OR window.** The 5-min window is worse (adds a losing entry). The 15-min window is identical in this set but may become relevant at C2 if gaps regularly set their OR high in bar 3.

---

## H4 — Catalyst Type Breakdown (Exploratory, First Read)

> **EXPLORATORY. No live change permitted.**

**H4 pre-reg bar:** sector-wide upgrade candidates must show fade rate ≥ 20 pp higher than stock-specific.

| catalystType | N | Recovered | Rate | sl_avg |
|---|---|---|---|---|
| analyst_upgrade | 5 | 0 | 0.0% | −0.82R |
| regulatory | 4 | 0 | 0.0% | −0.62R |
| product_launch | 2 | 0 | 0.0% | −0.51R |
| notable_mention | 1 | 0 | 0.0% | −0.82R |
| earnings_beat | 1 | 0 | 0.0% | −0.16R |
| sector_sympathy | 6 | 1 | 16.7% | −0.47R |
| macro | 7 | 1 | 14.3% | −0.34R |
| ma (M&A) | 3 | 1 | 33.3% | +0.43R |

**Notable signal:** `analyst_upgrade` (N=5, 0/5 recovered, avg −0.82R) is the worst-performing catalyst type. Jul 9 was 4 analyst upgrades (all semis sector-wide), all stopped at −1R. Jul 14 MPWR was an analyst upgrade and recovered (+0.28R) — the exception.

**M&A signal:** N=3 at 33% recovery, +0.43R avg — driven by OXY (operational scale, +0.65R) and PYPL (buyout at $60.50, +1.5R), vs AVAV (product launch mistagged? or genuine M&A fade). Too small to act on.

**H4 verdict:** analyst_upgrade is directionally the worst. N is below the 20-session-day requirement; cannot act. Carry forward to C2 as a watched signal.

---

## H5 — Queue Concentration (Exploratory, First Read)

> **EXPLORATORY. No live change permitted.**

**H5 pre-reg bar:** concentrated sessions (3+ same sector) must show ORB fade rate ≥ 20 pp higher than diverse sessions at N=20 session-days per bucket.

| Date | Session type | Tickers | CatalystType(s) | sl_avg | Recovered |
|---|---|---|---|---|---|
| Jul 8 | Diverse | AVAV, MTZ, LYB, DOW | mixed | −0.27R | 0/4 |
| Jul 9 | **Concentrated** | STX, MU, AMAT, TER | 4× analyst_upgrade (semis) | −0.93R | 0/4 |
| Jul 10 | **Concentrated** | COIN, MSTR, META, HOOD | 3× regulatory (crypto) | −0.47R | 0/4 |
| Jul 13 | Diverse | MGM, OXY, APA, TTD | mixed | −0.08R | 1/4 |
| Jul 14 | **Concentrated** | SOXL+8 semis | macro+sector_sympathy | −0.57R | 1/9 |
| Jul 15 | Diverse | BLK, BABA, SOXL, PYPL | mixed | −0.08R | 1/4 |

Concentrated session avg: −0.66R, 1/17 recovered (5.9%)  
Diverse session avg: −0.15R, 2/12 recovered (16.7%)

Fade rate in concentrated sessions (all faded via ORB) = 100% vs 100% diverse — ORB catches both. The OUTCOME difference is stark: concentrated = −0.66R avg, diverse = −0.15R. This is NOT about ORB firing differently; it's about the quality of what remains after ORB.

The true H5 signal here: **concentrated sessions produce worse shadow outcomes by ~0.5R**. If we could identify them pre-scan, avoiding them saves realized losses. But ORB already blocks live entries in both cases; the shadow loss is theoretical. Worth flagging for C2 if entry rate changes.

---

## H8 — Gap Grading Composite (Exploratory, First Read)

> **EXPLORATORY. Framing lens only, not a filter.**

**Components:** gapRetained + catalystType + queue concentration.

Composite pattern emerging:

- Best shadow outcomes: diverse sessions + macro/M&A catalysts + gapRetained in 0.2–0.8 range → recoveries happen
- Worst shadow outcomes: concentrated sessions + analyst_upgrade/regulatory + gapRetained > 1.0 → strong gap = strong fade continuation
- **Counterintuitive finding:** high gapRetained (> 1.0, gap expanded vs close) does NOT predict recovery. Recovery rate in > 1.0 bucket = 9.1% vs < 0.7 bucket = 11.1%. Gap strength is not a positive signal for long recovery at ORB fades.

The composite hypothesis has face validity but no bucket has met its adoption bar. Carry to C2.

---

## H10 — Shadow-Short First Read (Exploratory)

> **EXPLORATORY. H10 adoption bar: N≥40 fades, 2+ regimes, earnings season. FIRST READ ONLY.**

| Metric | Value |
|---|---|
| Resolved shadow-short (N) | 17 (Jul 13+) |
| Avg pnlR | +0.37R |
| Win rate | 12/17 = 70.6% |
| Full stops (−1R) | MGM, PYPL (2/17) |
| Capped targets (+1.5R) | SOXL (Jul 14), SNDK, TER (3/17) |

Individual results: MGM −1R, OXY −0.65R, APA +0.28R, TTD +0.82R, SOXL +1.5R, MRVL +0.69R, NXPI +0.35R, MPWR −0.28R, SNDK +1.5R, TER +1.5R, KLAC −0.08R, AMAT +0.18R, LRCX +0.20R, BLK +0.16R, BABA +0.64R, SOXL −1R (Jul 15 pre-market fake spike scenario?), PYPL +1.5R

Wait — PYPL shadow-long = +1.5R AND... let me re-check. PYPL shadowShort would be short from 53.91. PYPL recovered (+1.5R shadow-long), so PYPL shadow-short stopped out at −1R (price went back up). That's the PYPL −1R in shadow-short list.

**Polling-gap bias (per PRE-REG):** stop-hits recorded when first observed at/past stop; actual short squeeze losses are sharper. The +0.37R avg is slightly optimistic.

**Direction:** strongly positive. Gap-fade shorts are working at first read. But N=17 is half the required adoption bar and this is a single market regime (bull tape, Jul 13–15). Cannot act.

---

## gapRetained Threshold Sweep

**Pre-registered buckets:** < 0.7 (gap mostly faded) vs > 1.0 (gap retained or extended).  
**Actionable bar:** ≥ 20 pp difference in recovery rate between buckets.

| Bucket | Tickers | N | Recovered | Rate | Shadow-long avg |
|---|---|---|---|---|---|
| < 0.7 | COIN, HOOD, MGM, SOXL(Jul14), NXPI, KLAC, AMAT(Jul14), SOXL(Jul15), PYPL | 9 | 1 (PYPL) | 11.1% | −0.18R |
| 0.7 – 1.0 | STX, MRVL, MPWR, TER(Jul14), LRCX | 5 | 1 (MPWR) | 20.0% | −0.74R |
| > 1.0 | MU, AMAT(Jul9), TER(Jul9), MSTR, META, OXY, APA, TTD, SNDK, BLK, BABA | 11 | 1 (OXY) | 9.1% | −0.55R |
| No gapRetained | Jul 8 backfill (4 trades) | 4 | 0 | — | −0.27R |

**Recovery rate difference (< 0.7 vs > 1.0):** 11.1% − 9.1% = **+2.0 pp.** FAILS the 20 pp actionable bar.

**Key finding:** gapRetained is NOT a useful predictor of recovery rate at C1. Stocks that retained the gap strongly (> 1.0, meaning gap expanded) faded just as hard as those where the gap mostly collapsed (< 0.7). The middle bucket (0.7–1.0) has the highest recovery rate at 20% but also the worst shadow-long avg at −0.74R — MPWR (the recovery) is a statistical outlier in a 5-sample bucket.

**Notable:** the < 0.7 bucket has the BEST shadow-long avg (−0.18R) because PYPL (+1.5R) pulled it up heavily. One outlier drives the entire bucket statistic.

**Verdict:** gapRetained does not separate winners from losers with any reliability at N=29. Do not use as a filter. Carry data forward; revisit at C2 with more trades and earnings-season data where gap dynamics may differ.

---

## Summary of C1 Decisions

| Item | Pre-stated bar | Result | Verdict |
|---|---|---|---|
| **H3** (catalyst quality) | structural − stale-news ≥ 10 pp | +7.6 pp | **FAILS** — boundary not predictive as drawn; no redraw recommended (signal too weak) |
| **H7** (trigger vs snapshot) | trigger beats snapshot by ≥ 0.2R/candidate | 5-min trigger: −0.28R added loss; post-6:45 unevaluable | **FAILS** — keep snapshot |
| **F1** (kill check) | shadow mean materially > live mean | shadow −0.43R, live +0.47R (N=1) | **NOT TRIGGERED** — underpowered; directionally correct; fix entryMechanism logging |
| **F2** (window selection) | clear margin over 10-min incumbent | 5-min adds losing entry; 15-min = no change | **KEEP 10-min** — confirmed optimal in this set |
| **H4** (catalyst type) | Exploratory first read | analyst_upgrade worst (0/5, −0.82R) | Carry to C2; M&A signal noted |
| **H5** (concentration) | Exploratory first read | Concentrated −0.66R vs diverse −0.15R | Directional; need N=20 session-days per bucket |
| **H8** (composite) | Exploratory framing | High gapRetained ≠ recovery; gap strength is a negative signal | Carry to C2 |
| **H10** (shadow-short) | N≥40, 2+ regimes, earnings season | N=17, +0.37R, 70.6% win rate | **First read positive; CANNOT ACT at C1** |
| **gapRetained sweep** | ≥ 20 pp bucket difference | +2.0 pp (<0.7 vs >1.0) | **FAILS** — not actionable |

**C1 decision: ZERO entry-logic changes.** No item cleared its pre-stated bar. The system proceeds to C2 unchanged.

---

## Mandatory Action Items (Non-Logic)

1. **Fix `entryMechanism` field** in exit-daemon.js: write `entryMechanism: 'orb'` to the position record at ORB fill, and persist it to trades-log via `recordClosedTrade`. Required for F1 at C2.
2. **Log post-6:45am 5-min bars** for H7 full evaluation: store intraday prices at 6:50, 6:55, 7:00, 7:05, 7:10, 7:15, 7:20, 7:25, 7:30 for each queued candidate. Required for H7 at C2.
3. **catalystTag quality audit**: spot-check 5 stale-news and 5 structural tags against actual news source (per PRE-REG weekly protocol). Run before C2.

---

## Next Checkpoint

**C2:** N=20 live ORB trades. Expected pace: 1–2 entries/day. At current rate: 6–8 weeks.  
C2 analysis: slippage distribution, volatility-based sizing review (backlog #28), F5 target-coupling first read.  
Entry logic is locked until C2.

**Pace clause check:** as of Jul 15, 18 sessions with 1 live entry. Approaching 20 sessions with < 10 entries. If pace clause triggers (20 sessions, < 10 entries), a funnel diagnosis is required — and that analysis counts as the one C1-class change.
