# Pre-Registration: ORB Entry Strategy — Hypothesis Registry & Kill/Scale Criteria

**Registered:** 2026-07-10  
**Author:** Alvint Sheth  
**Strategy live since:** 2026-07-08 (ORB entry mechanism)  
**Entry mechanism change date:** 2026-07-08 — all trades before this date used open-fill entry and are a separate regime. Field `entryMechanism: 'orb'` distinguishes post-change trades.

---

## Purpose

This document is written before evidence accumulates at meaningful N. Its job is to prevent motivated reasoning: kill/scale thresholds and hypothesis rejection criteria are committed here so they cannot be adjusted post-hoc to match observed data. Any amendment to this document after N=20 live trades requires an explicit note explaining what changed and why.

---

## Kill / Scale Criteria

These numbers are fixed. They do not move because the first 30 trades looked good or bad.

| Checkpoint | Condition | Action |
|---|---|---|
| N=20 fades | Shadow stop-hit rate > 70% | Confirms ORB is blocking real losers — continue live |
| N=20 fades | Shadow stop-hit rate < 30% | ORB may be blocking winners — investigate OR window |
| N=60 live trades | Net expectancy ≤ 0R or 95% CI includes zero | **HALT** — rebuild screener or entry logic before continuing |
| N=60 live trades | Net expectancy > 0R and 95% CI mostly above zero | Continue to N=150 |
| N=150 live trades | Expectancy ≥ +0.15R (pre-chosen bar) | **SCALE** — increase position size 5–10× |
| N=150 live trades | Expectancy < +0.15R | Remain at current size, extend data collection to N=300 |

**Pace clause:** If fewer than 1 live trade per 5 trading sessions over any 20-session window, the strategy is not generating enough data to be meaningful. At that point, review the screener's candidate quality before waiting further — not the exit logic.

---

## Hypotheses

Each hypothesis has a pre-specified rejection criterion. If that criterion is met, the hypothesis is rejected regardless of how the rest of the data looks.

### H1 — ORB filter improves net expectancy vs. unfiltered open-fill entry
**Claim:** Entering only when price > 10-min OR high at 6:45am produces better expectancy than entering at the open on any gap-up candidate.  
**Rejection criterion:** At N=60 live trades, expectancy is not statistically distinguishable from zero.  
**Current evidence:** Shadow tally through N=12 fades: 5 confirmed stop-hits (-1R each), 3 force-closed (avg ~-0.03R), 0 target-hits. Shadow P&L is consistently negative, confirming the filter blocked real losses.

### H2 — Stale-news catalysts (analyst_upgrade, insider_purchase, sector_sympathy, technical) have higher fade rates than structural catalysts
**Claim:** `catalystTag: 'stale-news'` setups fail the ORB check more often than `catalystTag: 'structural'` setups.  
**Rejection criterion:** At N=20 per tag, fade rates are within 10 percentage points of each other.  
**Current evidence:** N=2 days. Jul 9: all 4 analyst_upgrade → all faded. Jul 10: 3 regulatory + 1 product_launch (all structural) → all faded. Structural also fading — too early to distinguish. Tag the data, don't act on it yet.

### H3 — Gap retention ratio (gapRetained = effectiveGapPct / originalGapPct) predicts ORB pass/fail
**Claim:** Candidates with gapRetained < 0.7 at 6:45am will fade more reliably than candidates with gapRetained > 1.0.  
**Rejection criterion:** At N=20 per bucket, pass rates are not statistically different.  
**Current evidence:** Logged but not wired. HOOD on Jul 10 had gapRetained = -0.78 (full reversal) and faded catastrophically. MTZ on Jul 8 had gapRetained ~1.0 and was the closest to passing. Directionally consistent. N too small.

### H4 — 10-min OR (bars 1+2 only, bar3 excluded) is the correct confirmation window
**Claim:** Using bars 1+2 only avoids the contamination problem (bar3 cannot be above a threshold that includes bar3's own high).  
**Status:** Correctness fix, not a tunable hypothesis. 15-min OR is structurally invalid for live use. All OR variants (5/10/15-min + bar closes) are logged for empirical window selection at N=20.

### H5 — |gap%|-sort crowding-out: sector-wave days fill the candidate queue with correlated names, starving the screener of idiosyncratic setups
**Claim:** On days when 3+ candidates share a sector, the top-10 ranking by |gap%| systematically selects the sector-wave names over quieter idiosyncratic gaps. The fix is not in the exit logic but in the ranking function or a sector-concentration flag.  
**Rejection criterion:** At N=20 sessions, days with 3+ same-sector candidates do not show higher fade rates than diverse-sector days.  
**Current evidence:** Three sessions, three sector-clustered queues (semis/Goldman, semis/macro, crypto-fintech/regulatory). All produced 0 live entries. Directionally consistent with hypothesis. Not actionable at N=3.  
**Freeze-compatible instrumentation:** Screener to log `queueSectorConcentration` flag and extended top-25 candidate list (analysis only; agent still reads top 10). Added to screener backlog.

### H6 — Shadow P&L is systematically negative: ORB blocks real losses, not noise
**Claim:** The fade dataset, when tracked to resolution, will show predominantly negative R-multiples. If shadows were winners, ORB would be costing us money.  
**Rejection criterion:** At N=20 shadow resolutions, average pnlR > 0R.  
**Current evidence (N=11 resolved through Jul 10):**

| Date | Ticker | Result | pnlR | Note |
|------|--------|--------|------|------|
| Jul 8 | AVAV | stop-hit | -1R | backfilled — closePrice proxy |
| Jul 8 | MTZ | force-closed | -0.35R | backfilled — closePrice proxy |
| Jul 8 | LYB | force-closed | +0.12R | backfilled — closePrice proxy |
| Jul 8 | DOW | force-closed | +0.15R | backfilled — closePrice proxy |
| Jul 9 | AMAT | stop-hit | -1R | live shadow |
| Jul 9 | TER | stop-hit | -1R | live shadow |
| Jul 9 | STX | stop-hit | -1R | live shadow |
| Jul 9 | MU | force-closed | -0.73R | live shadow |
| Jul 10 | MSTR | stop-hit | -1R | live shadow |
| Jul 10 | COIN | pending | — | — |
| Jul 10 | META | pending | — | — |
| Jul 10 | HOOD | pending | — | — |

Average resolved pnlR (N=9): **-0.65R**. Strongly supporting H6.

### H7 — Decision price (5:40am) is unreliable as entry reference on sector-rotation days
**Claim:** The pre-market price on macro/sector-wave days is inflated by thin-volume enthusiasm and does not represent institutional pricing. ORB's 6:45am check is the correct reference.  
**Status:** Root-cause observation, not an actionable hypothesis. ORB already addresses this structurally. The open-fill regime (pre-Jul-8) was vulnerable to this; ORB regime is not.

### H8 — AMC-yesterday earnings gaps are the richest idiosyncratic catalyst class
**Claim:** Day-after-AMC-earnings gaps (where the catalyst resolved after yesterday's close) are the setup type this strategy was designed for — stock-specific, non-correlated with the sector, high information content. These are eligible for trading under current rules.  
**Status:** Confirmed tradeable (code verified 2026-07-09). Not an ORB-fail hypothesis — an opportunity identification. Q2 earnings season (~Jul 15+) is the first real test window.

### H9 — 6:35am early-entry rule (if 6:35am price ≥ open price, enter at 6:35am)
**Claim:** Entering 10 minutes earlier on the "green first bar" signal captures the real runners before the ORB check.  
**Rejection criterion:** Replay on N=20 shadow candidates shows expectancy ≤ 0R.  
**Initial evidence (N=5 replay, Jul 8–10):**

| Ticker | Entry | Result | pnlR |
|--------|-------|--------|------|
| AVAV | $166.99 | stop-hit 7:10am | -1R |
| MTZ | $373.00 | force-closed EOD | +1.05R |
| TER | $382.00 | stop-hit 7:15am | -1R |
| MSTR | $98.95 | stop-hit 7:15am | -1R |
| META | $670.86 | force-closed ~8am | -0.21R |

**Replay P&L: -2.16R across 5 trades. 1W / 4L.** Evidence is against this hypothesis at N=5. Do not implement. Continue logging.

---

## C1 Checkpoint Methodology Notes

These rules govern how the N=20 and N=60 analyses are run. Locked here to prevent replay-bias.

1. **Source of truth for prices:** Daemon-logged prices (`orbCheckPrice`, shadow `entryPrice`, `exitPrice`) are canonical. Yahoo Finance re-fetched bars are used only as fallback and must be flagged with a discrepancy note. Reason: re-fetched Yahoo bars shift slightly vs. live (consolidated vs. real-time); thresholds tuned on re-fetched bars will not reproduce against live daemon behavior.

2. **Backfilled shadow records:** Jul 8 shadows were backfilled from `closePrice` (shadow code did not exist during that session). These use `closePrice` as `exitPrice` proxy, not intraday stop logic. Marked with `note: 'backfilled — closePrice proxy'` in the orb-log. Do not mix stop-hit determination from backfill with live shadow stop-hits when computing stop-hit rates.

3. **Regime separation:** Trades with `entryMechanism: 'orb'` (post-Jul-8) are a different system from pre-Jul-8 open-fill trades. Never compute combined expectancy across both regimes.

4. **Shadow vs. live:** Shadow pnlR (from fade entries) and live pnlR (from filled entries) are never averaged together. Shadow data calibrates the filter; live data measures the edge.

5. **N counting:** N for kill/scale criteria counts live ORB-filled trades only. Shadow fades are not live trades. A day with 0 entries contributes 0 to N regardless of how many shadows are logged.

---

## Amendment Log

| Date | Amendment | Reason |
|------|-----------|--------|
| 2026-07-10 | Initial commit | Pre-reg doc created; H1–H9 registered; C1 methodology locked |
