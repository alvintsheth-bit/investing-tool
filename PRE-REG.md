# Pre-Registration: Day Trading Agent Edge Validation

**Author:** Alvint Sheth  
**Registered:** July 10, 2026 (first commit timestamp; git history is the proof of predating)  
**System version:** Frozen as of commit 450de60 (ORB entry regime, slippage gate re-anchored in ffc70bd/26dfdf8)  
**Repo:** investing-tool

---

## 1. Purpose and Binding Rules

This document commits to hypotheses, checkpoints, and decision criteria **before** the data that will test them exists. Its job is to prevent motivated reasoning at the moment results arrive, and to make "tuning" and "calibration" formally distinguishable: calibration is scheduled here in advance; tuning is anything else.

**Amendment protocol.** This document may only be amended:
- (a) to fix factual errors or fill the [VERIFY] placeholders below,
- (b) to add logging-only instrumentation (never gates or scoring),
- (c) at a named checkpoint, with dated rationale added to the Changelog,
- (d) in response to a Class 1 safety event (Section 11).

Any change to live entry, scoring, or exit logic outside (c) and (d) voids the current evidential clock (Section 2) and must be recorded in the Changelog with the reset acknowledged.

---

## 2. Evidential Clock and Regime Definitions

- **Live trade (confirmatory):** `isLive: true` AND `entryMechanism: 'orb'`. The clock started **July 8, 2026**. Live trade count as of registration: **0**.
- **Pre-ORB trades:** identified by absence of `entryMechanism`. **6 trades** under the open-fill regime: ARM (Jun 24, ~0%), MU (Jun 25, +17.1%), META (Jul 1, +2.7%), RIVN (Jul 2, +3.7%), KLAC (Jul 6, -2.1%), STT (Jul 7, +0.6%). These are **excluded from all confirmatory analysis** and used only as context.
- **Fade record:** an ORB-skipped candidate with a shadow sub-record (`isShadow: true`) tracking paper stop/target from `orbCheckPrice`. Count at registration: **12** (July 8: 4, July 9: 4, July 10: 4). Resolved at registration (N=9): 4 stop-hits at -1R (AVAV backfill, AMAT, TER, MSTR), 3 force-closes negative (MTZ -0.35R, MU -0.73R, META -0.21R), 2 force-closes positive (LYB +0.12R, DOW +0.15R); average pnlR **-0.65R**. Supports H6 (ORB blocking real losses). Jul 10 COIN/HOOD/META unresolved as of registration.
- **Shadow outcomes are never included in live expectancy.** They inform threshold and filter calibration only (no slippage reality in paper fills).

Any change to entry logic resets the live-trade clock to zero. That reset cost must be weighed explicitly in every checkpoint decision.

---

## 3. Baseline Snapshot at Registration

| Item | Value |
|---|---|
| Account capital | $1,150 (Robinhood agentic sub-account) |
| Position size | $125 fixed, fractional market orders |
| Max concurrent positions | 4 (ceiling, not quota; $500 max deployed) |
| Daily circuit breaker | -1.5% of SOD balance (~$17) |
| Weekly circuit breaker | -5% of week-start balance (~$57) |
| Consecutive-loss pause | 3 losses, manual review to resume |
| Entry mechanism | ORB snapshot: price > 10-min OR high (bars 1+2) at 6:45am PT |
| Stop/target | ATR14 x 0.75 clamped 1-4%; target 1.5x stop; OR-low tightening; force-close 12:45pm PT |
| Score threshold | >= 0.45 (bootstrap value, lowered from 0.55; see Fitted Decision F4) |
| API cost | ~$11/month (Sonnet 4.6 scan, Haiku 4.5 EOD; frozen through N=60) |
| Bounded worst case | ~$17/day, ~$57/week capital; total experiment cost ~$11-12/month in direct agent costs |

**Primary metric:** expectancy per live trade in R, net of execution slippage (`execSlippage`), with 95% confidence interval. Reported alongside: win rate, profit factor, avg win R, avg loss R, trades/day distribution.

**Explicitly NOT the Phase 1 metric:** account dollars vs SPY. At $500 deployed for ~90 minutes/day, dollars-vs-SPY comparisons are structurally unfair in a bull tape and could kill a real edge for the wrong reason. Dollars-vs-benchmark becomes the test only after scaling (Section 9).

---

## 4. Confirmatory Hypotheses (primary; tested at N=60)

These three, and only these three, receive confirmatory status. Everything else in this document is exploratory.

- **H1 (core edge):** Live ORB entries with setup_score >= 0.45 have positive net expectancy per trade (R > 0, net of execSlippage).
- **H2 (ORB adds value):** ORB-skipped candidates underperform ORB entries. Test: mean shadow R of skips < mean live R of entries. (H2 failing in the extreme direction triggers Fitted Decision F1's kill criterion.)
- **H3 (catalyst quality):** Fades tagged `structural` recover by close (`recoveredByClose: true`) at a materially higher rate than fades tagged `stale-news`. Evidence at registration: July 8 dented this (4 structural fades, 0 recoveries); STT (July 7) supports it. N=2 days. Judged at N=20 fades. **Rejection bar:** structural recovery rate must exceed stale-news recovery rate by ≥ 10 percentage points at N=20 per tag; if difference < 10 pp (or structural rate is lower), the boundary is not predictive and must be redrawn at C1.

---

## 5. Exploratory Hypotheses (logged evidence only; no live changes before checkpoints)

- **H4 (sector-wide upgrades):** Candidates whose catalyst is a sector-wide analyst call underperform stock-specific catalysts (lower ORB pass rate, lower R). Proposed July 9 at N=2 days; parked. **Rejection bar:** sector-wide upgrade candidates must show fade rate ≥ 20 percentage points higher than stock-specific catalyst candidates at N=20 per bucket; else the distinction is not actionable.
- **H5 (queue concentration):** Sessions where 3+ queued candidates share a sector produce lower ORB pass rates and worse outcomes (the move is macro, not idiosyncratic). Instrumentation: `queueSectorConcentration` flag (logging-only addition, permitted). **Rejection bar:** concentrated sessions (3+ same-sector) must show ORB fade rate ≥ 20 percentage points higher than diverse sessions at N=20 session-days per bucket; else no scoring change is warranted.
- **H6 (rotation-day standdown):** On broad sector-rotation days, the correct trade count is zero. Subsumes H5; only actionable if H5 confirms strongly.
- **H7 (trigger vs snapshot ORB):** A trigger entry (enter on first cross of the OR high in a 6:45-7:30am PT window, same ATR stop/target from trigger price, same force-close) outperforms the snapshot check net of false breakouts. **Replay methodology:** at N=20 fades, replay every skip and every entry against the trigger rule using 5-min bars; compare total R across the three arms (snapshot / trigger / no-filter shadow). Evidence at registration: July 9 replay favored snapshot (trigger takes MU ~scratch and STX ~-1R; snapshot took neither). Adoption bar: trigger must beat snapshot by >= 0.2R per candidate across the full replay set, else snapshot stays.
- **H8 (gap grading composite):** Institutional commitment is measurable post-open via the existing instrumentation: RVOL (pending Robinhood scanner probe), `gapRetained`, catalyst specificity (H4), and sector breadth (H5). These jointly predict ORB pass and subsequent R better than any single filter. This is the framing lens for the N=20 analysis, not a filter to wire.
- **H9 (6:35 early-entry rule):** If the 6:35am price >= 6:30am open price (first bar is green), enter at 6:35am instead of waiting for the 6:45am ORB snapshot. Claims to capture real runners earlier. **Initial replay evidence (N=5, Jul 8-10, daemon-logged prices):** AVAV -1R (stop 7:10am), MTZ +1.05R (force-close EOD), TER -1R (stop 7:15am), MSTR -1R (stop 7:15am), META -0.21R (force-close). Total: -2.16R, 1W/4L. Evidence is against this hypothesis at N=5. Adoption bar at C1: replay across all N=20 shadow candidates must show expectancy > 0R and beat snapshot by >= 0.2R per candidate, else do not implement.
- **H10 (gap-fade short):** Shorting ORB-failed candidates at 6:45am PT (the exact moment of the fade decision, at `orbCheckPrice`) has positive expectancy. Claim: a gap that fails the ORB filter continues to fade intraday rather than recover. **Dataset:** `shadowShort` sub-records logged in parallel with shadow-long records from Jul 12 onwards; instrumentation-only, never wired to live orders. **Adoption bar:** positive shadow-short expectancy over N=40+ resolved fades spanning at least two market regimes, one of which must include earnings-season data, AND a resolved execution path confirmed. **Expression note:** short stock is unavailable via the current MCP surface (long-only agentic account, sub-$2k); executable expression if adopted = deep-ITM single-leg puts, liquidity-permitting. First read at C1 (N=20), full evaluation at a separate N=40 checkpoint.

Permitted logging-only additions in support: `floatSize` per candidate (FMP), `queueSectorConcentration`, extended screener list (top 25, analysis-only; agent still reads top 10), RVOL as a logged field if the scanner probe succeeds.

---

## 6. Known Fitted Decisions and Falsification Tests

Decisions already in live logic that were derived from small samples. Named here so they are defended by evidence or removed, never defended by authorship.

- **F1: ORB adoption itself.** Fitted to July 6-8 (~1.5 correlated bad days). A priori defensible ("wait for price discovery") but unvalidated. **Kill criterion:** at N=20 skips, if mean shadow R of skips materially exceeds mean live R of entries (skips are systematically winners), ORB is destroying value; remove or replace at that checkpoint.
- **F2: 10-min OR window.** Chosen as the only bug-free window (confirmation bar excluded), not validated as optimal. Variants (bar1 / 2-bar / 5 / 10 / 15-min) logged on every candidate. **Decision at N=20 fades:** adopt whichever window best separates winners from fades in the logged data; require a clear margin over the incumbent, else keep 10-min.
- **F3: stale-news vs structural boundary.** Drawn around STT (N=1); July 8 evidence runs against it. At N=20 fades, the boundary may be re-drawn entirely, not merely accepted/rejected as drawn.
- **F4: 0.45 score threshold.** Lowered from 0.55 explicitly to generate trades (fitted to impatience, acknowledged). Calibration path: shadow log of the 0.35-0.45 band plus live band performance. Reviewed at N=60; also reviewable under the pace clause (Section 8).
- **F5: target-coupling.** OR-tightened stops drag the 1.5x target down with them (STT exited +$0.78 on a move that ran to ~$179 territory). Never examined. Review at N=20 live trades using MFE data: are winners consistently blowing through tightened targets?

---

## 7. Multiple-Comparisons Protocol

At N=60, the pivot tables (13 catalyst types x regime buckets x 10 signals x score bands) contain hundreds of cells over 60 trades. **Several cells will look spectacular by chance.**

Rule: only H1-H3 are confirmatory at N=60. Every other pattern the tables surface is exploratory by definition: it becomes a named hypothesis for the *next* 60 trades, never a conclusion from the last 60. No live change may be justified solely by a pivot-table cell discovered after the data existed.

---

## 8. Checkpoints and Decision Rules

| Checkpoint | Trigger | Analysis | Permitted actions |
|---|---|---|---|
| **C1: Fades** | N=20 fade records (~1-2 weeks at current rate) | H3, H7 replay, F1 kill check, F2 window selection, H4/H5/H8 first read, `gapRetained` threshold sweep vs `recoveredByClose` and shadow R using pre-specified buckets: **< 0.7** (gap mostly faded) vs **> 1.0** (gap fully retained or extended); bucket must show ≥ 20 pp difference in recovery rate to be actionable | At most **one** entry-logic change, only if it clears its pre-stated bar; clock reset acknowledged in Changelog |
| **C2: Early live** | N=20 live trades | Slippage distribution calibration (backlog #29), volatility-based sizing review (#28), F5 target-coupling read | Sizing/exit refinements only if MFE/slippage data clearly support; entry logic untouched |
| **C3: Primary** | N=60 live trades | H1 confirmatory test (expectancy + 95% CI), out-of-sample harness, F4 threshold review, advisor verdict (Section 12), catalyst x regime pivots (exploratory only) | Continue / halt-and-overhaul / stop per Section 9 |
| **C4: Scale** | N=150 live trades | Expectancy stability, regime coverage review | Scale per Section 9 |
| **Pace clause** | 20 sessions with < 10 total live entries | Funnel diagnosis (screener output -> scorecard -> queue -> orb-log): where does the funnel choke, and what do shadows say about the choke point | Documented calibration review; may loosen score threshold or ORB strictness using shadow evidence; counts as the one C1-class change |
| **Weekly** | Every week | Read weekly report; trades/day distribution; spot-check 2-3 catalystType tags against actual news (label quality protects the N=60 dataset) | None (read-only) |

Expected pace: at 1-2 live entries/day average, C3 arrives in roughly 6-10 weeks. Earnings season (starting ~mid-July) is expected to raise idiosyncratic-catalyst supply; the AMC-yesterday reporter class is confirmed tradeable (commit 450de60) and must not be excluded without a deliberate, documented decision.

**C1 methodology notes (locked):**
- **Source of truth for prices:** Daemon-logged prices (`orbCheckPrice`, shadow `entryPrice`, `exitPrice`) are canonical. Yahoo Finance re-fetched bars are used only as fallback and must be flagged with a discrepancy note. Re-fetched Yahoo bars shift slightly vs. live (consolidated vs. real-time); thresholds tuned on re-fetched bars will not reproduce against live daemon behavior.
- **Backfilled shadow records:** Jul 8 shadows were backfilled on 2026-07-10 from `closePrice` (shadow code did not exist during that session). These use `closePrice` as `exitPrice` proxy, not intraday stop tracking. Marked with `note: 'backfilled — closePrice proxy'` in the orb-log. Do not compare stop-hit rate between backfilled and live shadows; treat them as two sub-cohorts.
- **Regime separation:** Trades with `entryMechanism: 'orb'` (post-Jul-8) are a different system from pre-Jul-8 open-fill trades. Never compute combined expectancy across both regimes.
- **Shadow vs. live:** Shadow pnlR and live pnlR are never averaged together. Shadow data calibrates the filter; live data measures the edge.
- **Shadow-short cohort:** `shadowShort` pnlR is never averaged with shadow-long pnlR or live pnlR. It is its own cohort, tracked separately to evaluate H10. A positive shadow-short average does not imply anything about the shadow-long or live expectancy.
- **Polling-gap bias (shadow shorts):** The 45-second loop records -1R when price is first observed at or past the stop, but a short whose stop is breached *between* polls lost more than -1R in reality (upside squeezes are sharper and more violent than downside bleeds, so this gap is asymmetric — shorts are affected more than longs). The shadow-short dataset is therefore slightly optimistic about losses. At the N=40 H10 evaluation, treat the stop-hit rate and average loss as lower bounds, not point estimates.
- **N counting:** N for kill/scale criteria counts live ORB-filled trades only. Shadow fades are not live trades.

---

## 9. Kill / Continue / Scale Criteria

**At C3 (N=60 live trades):**
- **Stop or overhaul** if net expectancy is negative, or the 95% CI comfortably includes zero with no positive skew story in the R distribution. "Overhaul" means a redesign with a fresh pre-registration, not incremental tuning.
- **Continue to C4** if net expectancy is positive and the CI sits mostly above zero.
- The advisor subscription decision (Section 12) is made at C3 regardless of the edge verdict.

**At C4 (N=150 live trades):**
- **Scale** if net expectancy > +0.15R with the 95% CI excluding zero.
- Scaling discipline: step-wise, 2x per step ($125 -> $250 -> $500 per position), each step verified over ~30 trades before the next. Circuit-breaker percentages stay constant so dollar risk scales with size. No 10x jumps.
- **Regime caveat:** a pass at C3/C4 validates "this edge existed in this tape," not "this edge exists." A regime shift (VIX regime change, trend-to-chop transition per the logged regime fields) pauses scaling and requires re-verification over ~30 trades at current size before resuming.

**Standing kill condition (any time):** two weekly circuit-breaker trips within any 6-week window halts live trading pending a full review with fresh pre-registration.

---

## 10. What Does NOT Trigger Action (anti-tuning list)

Explicit non-triggers, named because each has already produced the itch once:
- A missed runner (the STT / MTZ / MU feeling). Prev-close-anchored charts overstate the capturable move; the shadow log already measures the true counterfactual.
- A loser that got through a filter (the AVAV feeling).
- A red day or red week inside breaker limits.
- A zero-trade day or streak (the filter declining bad bets is the system working; shadows still accumulate data; the pace clause is the scheduled response).
- Any pattern spotted in fewer than the checkpoint's N.
- Any pivot-table cell (Section 7).

---

## 11. Intervention Protocol

**Class 1 (act immediately):** monitor alert emails (daemon not started, force-close failed, positions open after close: check Robinhood directly); reconciliation mismatch; circuit-breaker trips (review before reset, never same-day reflex reset); auth/token failures; data-source breakage; buy-then-instant-sell patterns in logs. Plumbing fixes never violate the freeze.

**Class 2 (review, don't tweak):** 3-consecutive-loss pause. Read-only review: correlated? (`sharedSector`, `marketDrivenDay`) System behaved as designed? If yes, resume. Variance is not malfunction.

**Class 3 (checkpoints):** the only venue for logic changes, per Section 8.

---

## 12. Advisor Subscription Verdict

The advisory service is independent of this agent and treated as such — its cost is excluded from the agent's cost calculus entirely. It influences no measurable decision (no context pre-load, no veto, no score effect).

`advisorStance` **consciously not implemented** (decision locked 2026-07-10): the advisor will not have per-trade views on the short-duration gap-and-run names this system trades. Logging a field that is structurally null produces noise, not signal. This section is closed; no verdict required at C3.

---

## 13. Model Policy

Scan stays on Sonnet 4.6 and EOD on Haiku 4.5 through C3. Rationale: the LLM sits only in research/classification (screening, entry, exits, sizing are code); dataset continuity across N=60 matters more than marginal classification gains; the binding constraints are data quality and N, not reasoning depth. If weekly label spot-checks reveal catalystType misclassification, the fix is a tighter rubric with examples in the prompt, not a model upgrade. Revisit at the signal-ablation milestone (100+ trades).

---

## 14. Changelog

| Date | Change | Class | Rationale |
|---|---|---|---|
| 2026-07-09 | Document registered | — | Baseline |
| 2026-07-10 | Pre-ORB count corrected to 6 (ARM, MU, META, RIVN, KLAC, STT); H9 added to Section 5 with N=5 replay evidence (-2.16R); C1 methodology notes added to Section 8 (daemon-logged prices canonical, backfill tagging); Jul 8 shadow backfill completed in orb-log | (a), (b) | Factual correction; logging-only instrumentation; backfill restores instrumentation integrity |
| 2026-07-10 | Registration date corrected to Jul 10 (git timestamp authoritative); fade count updated 8→12 with N=9 resolved tally (-0.65R avg); rejection bars added to H3 (≥10 pp), H4 (≥20 pp), H5 (≥20 pp); gapRetained buckets pre-specified (<0.7, >1.0) in C1; advisorStance consciously not implemented — cancel-at-C3 locked | (a) | Factual corrections; pre-specifying numeric bars before C1 data exists |
| 2026-07-12 | H10 (gap-fade short) registered in Section 5; shadow-short cohort separation rule added to C1 methodology; `shadowShort` sub-record added to orb-log entries (exit-daemon.js) — logging-only, no live logic changes | (b) | Instrumentation addition; pre-registered before any H10 data exists |
