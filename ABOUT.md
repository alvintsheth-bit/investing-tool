# Personal Investing Agent — Full Technical Documentation

**Owner:** Alvint Sheth (alvintsheth@gmail.com)
**Built:** June 2026
**Status:** Fully operational — Robinhood auth ✅ | Gmail email ✅ | Daily cron ✅ | Self-learning ✅ | Day-trade mode ✅ | DRY_RUN=false (live trading — cycle verified Jun 25 2026)

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [How It Works — Daily Flow](#2-how-it-works--daily-flow)
3. [Architecture Overview](#3-architecture-overview)
4. [Web Scraping Layer](#4-web-scraping-layer)
5. [Knowledge Base](#5-knowledge-base)
6. [The Investing Agent (agent.js)](#6-the-investing-agent-agentjs)
6b. [Full Decision Tree — If/Then/Else](#6b-full-decision-tree--ifthenelse)
7. [Signal Stack — 10 Day-Trading Signals](#7-signal-stack--10-day-trading-signals)
8. [Scoring System](#8-scoring-system)
9. [Trade Execution & Rationale Logging](#9-trade-execution--rationale-logging)
10. [Circuit Breakers & Risk Management](#10-circuit-breakers--risk-management)
11. [Self-Learning System](#11-self-learning-system)
12. [Market Data Sources](#12-market-data-sources)
13. [Sentiment Layer — Reddit & StockTwits](#13-sentiment-layer--reddit--stocktwits)
14. [Web Search & Notable Mentions](#14-web-search--notable-mentions)
15. [Robinhood MCP — Trade Execution](#15-robinhood-mcp--trade-execution)
16. [EOD Report & Gmail Delivery](#16-eod-report--gmail-delivery)
17. [Daily Automation (macOS launchd)](#17-daily-automation-macos-launchd)
18. [Health Monitor](#18-health-monitor)
19. [File Structure](#19-file-structure)
20. [Environment Variables](#20-environment-variables)
21. [How to Run](#21-how-to-run)
22. [Technology Stack](#22-technology-stack)
23. [APIs & Services Used](#23-apis--services-used)
24. [Why Credits Deplete Fast](#24-why-credits-deplete-fast)

---

## 1. What This Is

A fully automated personal **day-trading** agent that runs a complete intraday cycle — scan, monitor, force-close, report — without human intervention. It:

- **Scrapes** sam-weiss.com daily at 5:30am for trade alerts, watchlist, and briefings. Rebuilds the full knowledge base every Sunday
- **Scans** pre-market gappers at 6:00am (30 min before open), scoring candidates using a logistic regression model trained on historical signal outcomes
- **Executes** fractional-share, dollar-denominated market orders on Robinhood's Agentic Trading sub-account (account 674082664) — up to 4 concurrent positions, $125 fixed per trade ($500 max deployed)
- **Monitors** open positions continuously via exit-daemon (45-second poll loop, 6:25am–1pm PT) — exits on stop/target hits or thesis-break events (Haiku judges borderline cases)
- **Force-closes** all open positions at 12:45pm PT (failsafe only — daemon handles primary exits; early-close days: 9:45am)
- **Trains** a logistic regression model at EOD on all closed trades (features: 10 signal binaries + continuous values, L2 regularized, 80/20 blended with prior day's weights)
- **Reports** daily realized P&L vs SPY/QQQ/IWM benchmarks + learnings — emailed at 1:30pm PT; weekly P&L summary emailed Sundays 5:30pm PT
- **DRY_RUN mode** (default `true`) logs all intended orders without submitting — set `DRY_RUN=false` in `.env` to go live

The reasoning engine is Claude Sonnet 4.6 (scan) and Claude Haiku 4.5 (EOD + judgment calls), running in agentic loops (up to 20 and 10 iterations respectively).

---

## 2. How It Works — Daily Flow

```
SUNDAY 5:00 AM — scraper-knowledge-base.js weekly
                 • Scrapes last 10 briefings from sam-weiss.com
                 • Updates output/knowledge-base/briefings/
                 • Logs to output/logs/kb-weekly.log

DAILY  5:30 AM — scraper.js
                 • Authenticates to sam-weiss.com with Playwright
                 • Scrapes today's daily briefing, trade alerts, watchlist
                 • Saves output/sam-weiss-YYYY-MM-DD.json
                 • Logs to output/logs/scrape.log

DAILY  5:40 AM — screener.js (pure code, no Claude — deterministic pre-filter)
                 • Builds universe: 580 tickers (S&P 500 from Wikipedia + NASDAQ 100 + curated high-beta seeds)
                 • Fetches Yahoo Finance 5-min intraday bars (includePrePost=true) for every ticker
                 • Computes real gap% (pre-market price vs prior close) from 5-min bar closes
                 • RVOL = null (Yahoo returns volume=0 for all pre-market bars — not computable here)
                 • Sorts by gap magnitude (|gap%|), saves top 10 to output/screener-YYYY-MM-DD.json
                 • Runs in ~2 min (580 tickers vs prior 83), finishes before agent starts
                 • Logs to output/logs/screener.log

DAILY  6:00 AM — agent.js scan (30 min before open, Claude Sonnet, 20 iterations)
                 • Live market-day check via Yahoo Finance (fail closed if unavailable)
                 • Pre-flight: verify balance, reconcile vs Robinhood, save SOD balance
                 • Phase 1: VIX, Fear & Greed, sector pre-market moves (sets risk appetite)
                 • Phase 2: Earnings calendar — build hard exclude list for today
                 • Phase 3: Research screener candidates in ranked order — news catalyst,
                 •           Reddit chatter, notable mentions, insider activity, ATR stop/target
                 • Phase 4: Sam validation per ticker (briefing search + outlook on demand)
                 • Phase 5: Execute if setup_score ≥ 0.45 — in LIVE mode, place_trade queues
                 •           candidates to queued-trades.json (no immediate order submission)
                 •           Shadow-log candidates scoring 0.35–0.45 via log_rejected_candidate
                 • Research window: 6:00–6:30am PT. ORB entry at 6:45am via exit-daemon.
                 • Scan report header shows screener input (e.g. "NVDA +3.2%, GE +2.1%")
                 • Logs to output/logs/analyze.log

DAILY  6:25 AM — exit-daemon.js (long-running daemon, runs until 1pm PT)
                 • Polls open positions every 45 seconds — pure code fast loop
                 • Stop/target hit → market sell immediately
                 • 6:35am: logs 5-min price mark for all queued ORB candidates
                 • 6:40am: logs 10-min price mark for all queued ORB candidates
                 • 6:45am: ORB entry decision — for each queued candidate, fetches 10-min OR high
                 •   (max of bars 1+2 only — bar3 excluded, it is the confirmation bar being tested).
                 •   If current price > OR high → gap held → market buy submitted immediately.
                 •   If current price ≤ OR high → gap faded → candidate skipped (no entry).
                 •   All decisions logged to orb-log-YYYY-MM-DD.json with OR variants + gap retention.
                 • 6:45am also: tightens stop to OR low for existing PROTECTED positions
                 • Haiku thesis-break check every 90 min (VIX spike, halt news)
                 • Tracks MFE/MAE per position on every poll
                 • Quote unavailable 5× in a row → force-close for safety
                 • Early-close days: force-close at 9:45am PT instead of 12:45pm
                 • Logs to output/logs/exit-daemon.log

DAILY  6:30 AM — Market opens (NYSE/NASDAQ)

DAILY 12:45 PM — agent.js force-close (pure code, no Claude — failsafe only)
                 • Hard market sell on any position still open (daemon should have handled)
                 • Early-close days: daemon closes at 9:45am; force-close verifies nothing left
                 • Logs to output/logs/force-close.log

DAILY  1:00 PM — Market closes

DAILY  1:30 PM — agent.js eod (Claude Haiku, 10 iterations)
                 • Retrain logistic regression on all closed trades (100-trade min)
                 • 80/20 blend new coefficients with yesterday's → signal-weights.json
                 • Walk-forward validation: this week vs last week accuracy
                 • Generate EOD report: P&L vs QQQ + learnings (2 sections only)
                 • Compute expectancy, profit factor, win rate → expectancy-log.json
                 • Update rejected candidates with EOD prices (shadow P&L tracking)
                 • Save tomorrow's watchlist (gap candidates to re-screen)
                 • Email to alvintsheth@gmail.com
                 • Logs to output/logs/eod.log

DAILY  2:15 PM — monitor.js (health check — no Claude, no cost)
                 • Verifies screener, scrape, recommendations, EOD report, daemon log all exist
                 • Checks trades-open.json is empty (positions cleared)
                 • Alerts alvintsheth@gmail.com if anything is wrong
```

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          macOS launchd (7 jobs)                      │
│  Sun 5am: kb-weekly  |  5:30am: scrape  |  6am: scan  |  6:25am: exit-daemon  |  12:45pm: force-close  |  1:30pm: eod  |  2:15pm: monitor  |  Sun 5:30pm: weekly-report│
└──────────────┬──────────────────────────────────────────────────────┘
               │
   ┌───────────▼────────────┐
   │      scraper.js        │  Playwright (headless Chromium)
   │ scraper-knowledge-     │  Authenticated session, human delays
   │   base.js weekly       │  Daily briefing + trade alerts + watchlist
   └───────────┬────────────┘
               │ JSON + markdown
   ┌───────────▼────────────┐
   │    Knowledge Base      │  535 briefings + all static pages (~9MB)
   │  output/knowledge-base/│  Strategy, investing basics, market outlook,
   │    briefings/ (535+)   │  NASDAQ history, 9 portfolios, trade history
   └───────────┬────────────┘
               │ loaded as context (50-80k tokens)
   ┌───────────▼────────────────────────────────┐
   │            agent.js                        │
   │  Claude Sonnet 4.6 (analyze) / Haiku (EOD) │
   │  Scan: up to 20 iterations (Sonnet)         │
│  EOD:  up to 10 iterations (Haiku)          │
   │                                            │
   │  MEMORY INPUT:                             │
   │  • signal-weights.json (win rates)         │
   │  • watchlist-tomorrow.json (yesterday)     │
   │  • trades-log.json (recent history)        │
   │                                            │
   │  RESEARCH (independent first):             │
   │  • Macro + VIX + Fear & Greed             │
   │  • Sector rotation (11 ETFs)              │
   │  • Web search for candidates              │
   │  • 10 signals per ticker                  │
   │  • Sam Weiss validation (last)            │
   └──┬────────────────────────────┬───────────┘
      │                            │
  ┌───▼──────┐            ┌────────▼──────────┐
  │  Market  │            │  Robinhood MCP    │
  │  Data    │            │  HTTP transport   │
  │  Sources │            │  agent.robinhood  │
  │  (below) │            │  .com/mcp/trading │
  └──────────┘            │  Agentic account  │
                          │  674082664        │
                          └──────────────────┘
                                   │
                          ┌────────▼──────────┐
                          │  output/trades/   │
                          │  Per-trade .md    │
                          │  rationale files  │
                          │                   │
                          │  output/          │
                          │  signal-weights   │
                          │  trades-log       │
                          │  watchlist-tmrw   │
                          └───────────────────┘
                                   │
                          ┌────────▼──────────┐
                          │  Gmail (nodemailer)│
                          │  App password auth │
                          │  EOD report email  │
                          └───────────────────┘
```

---

## 4. Web Scraping Layer

**File:** `scraper.js` — daily 5:30am scraper
**File:** `scraper-knowledge-base.js` — full KB scraper + weekly updater

### Technology
- **Playwright** (headless Chromium) for authenticated browsing
- Human-like delays (`humanDelay()`: 800-2500ms between actions) to avoid bot detection
- Authenticated session: logs in once, reuses across all pages
- `networkidle` wait strategy + 300ms buffer after page load
- Credentials: `SAM_WEISS_USERNAME` + `SAM_WEISS_PASSWORD` in `.env`

### Daily Scraper (`scraper.js`) — 5:30am
Scrapes 4 pages each morning, saves timestamped JSON:
1. Latest daily briefing (homepage)
2. Current trade alerts (`/trades/`)
3. Watchlist — stocks Sam is monitoring (`/trade-watch/`)
4. All 9 portfolio pages (Targaryen, Baratheon, Lannister, Tyrell, Arryn, Tarly, Stark, Frey, Hightower)

Output: `output/sam-weiss-YYYY-MM-DD.json`

### Weekly KB Updater (`scraper-knowledge-base.js weekly`) — Sundays 5am
Pulls the last 10 briefings and saves them to `output/knowledge-base/briefings/`. Keeps the knowledge base current without re-scraping the entire 535-briefing archive weekly.

### Full Knowledge Base Scraper (`scraper-knowledge-base.js full`) — run once
Scraped the entire site on first run. Handles complex interactive pages:

| Mode | Pages Scraped | Technique |
|------|--------------|-----------|
| `briefings` | 52 pages × ~10 posts = 535 posts | Pagination with URL fallback |
| `strategy` | 6 tabs | Click each tab by href |
| `basics` | 6 chapters × 4-5 slides | READ MORE click + URL guessing (`slug-2/`, `-3/`) |
| `outlook` | Collapsible dropdowns | DOM manipulation (summary/button clicks) |
| `portfolios` | Overview + 9 individual pages | Dropdown expansion |
| `articles` | 12 long-form articles | Standard pagination |

### Key Scraping Decisions
- **Never use `body` or `main`** — WordPress admin bar lives there, pollutes content
- **Only use**: `.entry-content`, `.post-content`, `.page-content`, `article`, `.site-content`
- **URL guessing for slides**: `/investing-basics/risk-management/` → `/investing-basics/risk-management-2/` → `-3/`
- **Comment filtering**: skip links matching `/^\d+\s+comments?$/i` and `text.length < 10`

---

## 5. Knowledge Base

**Location:** `output/knowledge-base/`
**Total size:** ~9MB
**Total files:** 574+

### Static Content (scraped once, rarely changes)

| File | Size | Contents |
|------|------|----------|
| `strategy.md` | 42KB | Sam's 4-Part Investment Framework: buy corrections, hedge rallies, sell covered calls, hold long-term. All 6 strategy tabs. |
| `investing-basics.md` | 299KB | All 6 chapters with all slides: The Basics, Inherent Leverage, Risk Management, Brokerage, Practical Application, Advanced |
| `market-outlook.md` | 44KB | Near-term, intermediate-term, long-term forecasts. All collapsible sections expanded. |
| `market-understanding.md` | 14KB | "Understanding the Market" slide deck |
| `nasdaq-historical.md` | 28KB | Correction/rally data tables 2007–2025: %, duration, context |
| `trade-history.md` | 77KB | Complete history of all trades Sam has ever made |
| `trade-watchlist.md` | 2KB | Current watchlist |
| `portfolio-overview.md` | 24KB | Aggregate portfolio performance |
| `portfolios/` | 9 files | Targaryen, Baratheon, Lannister, Tyrell, Arryn, Tarly, Stark, Frey, Hightower |
| `articles/` | 12 files | Long-form strategy articles, stress tests, monthly outlooks |

### Dynamic Content (updated daily/weekly)

| File | Source | Contents |
|------|--------|----------|
| `briefings/YYYY-MM-DD-*.md` | Weekly cron (Sundays 5am) | 535+ daily briefings with comments, 18+ months |
| `output/sam-weiss-YYYY-MM-DD.json` | Daily cron (6am) | Today's briefing, trade alerts, watchlist, portfolio snapshot |

---

## 6. The Investing Agent (agent.js)

**File:** `agent.js`
**Model:** `claude-sonnet-4-6` (analyze) / `claude-haiku-4-5-20251001` (EOD)
**Max iterations:** 20 (analyze) / 10 (EOD) tool-use loops per session
**Max tokens per response:** 8,192

**Edge hypothesis:** Liquid stocks that gap ≥2% pre-market on a clear overnight catalyst (news, earnings surprise, notable mention) and whose gap is confirmed by RVOL >2× (checked pre-open via `get_premarket_data` in Phase 3, before market open) tend to trend directionally through the first 90 minutes of the session — the edge is in identifying which catalyst types produce sustained intraday moves vs. gaps that fade within the opening 30 minutes.

Note on RVOL timing: RVOL is `null` at screener time (5:40am) because Yahoo Finance returns zero volume for pre-market bars. It becomes available when the agent calls `get_premarket_data` during Phase 3 (~6:00am), sourced from FMP `preMarketVolume` vs `averageVolume`. Entry decisions are made with RVOL confirmed — not before it's available.

### How the Agentic Loop Works

```
1. Load learning memory (signal win rates, recent trades, yesterday's watchlist)
2. Build system prompt — injects 50-80k tokens of KB context
3. Send to Claude with 14 tools defined
4. Claude responds with tool_use blocks
5. Execute each tool (FMP, Yahoo Finance, Reddit, DuckDuckGo, Robinhood, etc.)
6. Return tool_result to Claude
7. Repeat until stop_reason === 'end_turn' or iteration limit (20 scan / 10 EOD)
8. Save final text response to output/recommendations-YYYY-MM-DD.md
```

### Context Injected at Prompt Time

Only factual, non-narrative data is pre-loaded. All Sam content is deliberately excluded from the initial context — the agent cannot have absorbed any of Sam's current views before starting its own research.

| Content | Chars | Source |
|---------|-------|--------|
| Learning memory (signal win rates) | dynamic | signal-weights.json |
| Yesterday's watchlist + entry triggers | dynamic | watchlist-tomorrow.json |
| Screener candidates (top 10 by gap%) | dynamic | screener-YYYY-MM-DD.json |
| NASDAQ correction/rally patterns | 3,000 | nasdaq-historical.md (historical data) |

**What is NOT pre-loaded (to prevent anchoring):**
- Sam's daily briefing narrative → available via `get_sam_market_outlook` tool on demand
- Recent briefings → available via `search_sam_weiss_briefings` tool on demand
- Market outlook → available via `get_sam_market_outlook` tool on demand
- Portfolio positions → available via `get_sam_market_outlook` tool on demand
- Strategy/investing-basics → available via `get_sam_market_outlook` tool on demand
- Today's trade alerts (what Sam bought/sold) → not pre-loaded; agent discovers candidates independently first
- Today's watchlist (what Sam is monitoring) → not pre-loaded; prevents Sam's picks from anchoring tomorrow's watchlist

Sam's data enters only via explicit tool calls in Phase 4, after the agent has independently scored each candidate. This ensures tomorrow's watchlist is driven by gap%/sector signals — not by what Sam is watching.

### API Resilience — 5xx Retry

All `client.messages.create` calls (scan loop, Haiku check judgment, EOD loop) are wrapped in `callWithRetry()`:
- Retries up to 3 times on HTTP 500 (Internal Server Error) or 529 (Overloaded)
- Exponential backoff: 5s → 15s → 45s
- Non-retryable errors (4xx, auth failures) are thrown immediately
- Logged to console: `⚠️  API 500 — retrying in 5s (attempt 1/3)...`

This prevents the scan from failing mid-run due to transient Anthropic server errors.

### Research Philosophy (Embedded in Prompt)
The agent is explicitly instructed:
1. Do independent market research first — macro, sectors, technicals, news, sentiment
2. Discover candidate stocks from web search and signals BEFORE reading Sam's view
3. Score candidates using 10 independent signals (Sam NOT included)
4. THEN consult Sam: his stance adjusts position size (full/standard/small) but not score
5. Execute if setup_score ≥0.45 — Sam's stance provides context; model-driven sizing only after 200 live trades

### Modes
- `node agent.js` — analyze + trade (6:00am)
- `node agent.js eod` — end-of-day report (1:30pm)

---

## 6b. Full Decision Tree — If/Then/Else

Every scan session follows this exact branching logic, derived from the code.

---

### STEP 0 — Market Day Gate (before any Claude call)

```
isMarketDay()?
├── NO  (weekend, holiday, or QQQ shows market closed)
│   └── EXIT silently — no scan, no email, no cost
└── YES → continue to pre-flight
```

---

### STEP 0.5 — Pre-Market Screener (5:40am, pure code — runs before agent)

```
screener.js (launchd job):
  Builds universe:
    • 580 tickers from output/universe.json (S&P 500 from Wikipedia + NASDAQ 100 +
      curated high-beta seeds: China ADRs, Bitcoin miners, momentum names).
      Refreshed monthly by universe-refresh.js (1st of month, 5am PT).
      [Previously: 83 hand-curated tickers — superseded July 2026]
    • + after-market-close earnings from yesterday (FMP) — reported after yesterday's close,
        pre-market gap reflects the overnight reaction. These ARE eligible for same-day trading
        (today is the day after their report; the catalyst resolved last night, no event risk
        during the hold). Phase 2 hard-excludes only TODAY's reporters (earnings during the hold
        = unresolved event risk). catalystType: earnings_beat / earnings_miss / guidance_raise
        are valid enum values for AMC-yesterday setups. THIS IS THE RICHEST CATALYST CLASS —
        do not add exclusion logic here without explicit deliberate decision.
        BMO today reporters are excluded — Phase 2 blocks them (event resolves mid-hold).
    • + yesterday's watchlist (candidates that scored 0.35–0.45 the prior session)

  Quality filter per ticker (screenTicker):
    ├── prevClose < $5 → skip
    ├── yesterday dollar volume < $10M → skip (too thin for liquid entry/exit)
    ├── no pre-market bars today → skip
    └── |gap%| < 0.5% → skip (not moving)

  For survivors:
    • gapPct = (lastPreMarketClose - prevClose) / prevClose × 100
    • rvol = null (Yahoo returns volume=0 for all pre-market bars)
    • score = |gapPct|

  Sort by |gapPct|, take top 10
  Save → output/screener-YYYY-MM-DD.json

Agent reads this file at 6:00am and injects candidates into the scan prompt.
If file is missing → agent proceeds with no candidates (screener crashed).
```

---

### STEP 1 — Pre-Flight Checks

```
Can reach Robinhood MCP?
├── NO  → research-only mode (balance = $0, trade execution disabled)
└── YES → read portfolio equity + buying power
          ├── balance = $0 or unreadable → research-only mode
          └── balance readable
              ├── Save SOD balance (once per day, used as circuit breaker baseline)
              └── Reconcile trades-open.json vs Robinhood positions
                  ├── MISMATCH → send alert email + process.exit(1) — SCAN ABORTED
                  └── OK → continue

Early-close day (hardcoded 2026 calendar)?
├── YES → note it (daemon closes at 9:45am; force-close at 9:45am)
└── NO  → standard close (12:45pm)
```

---

### STEP 2 — Phase 1: Market Context (called once, sets session risk appetite)

```
get_fear_greed_vix()   → F&G score + VIX level → high VIX = tighten stops
get_sector_rotation()  → which sector ETFs are moving pre-market
get_earnings_calendar() → hard exclude list for today
```

---

### STEP 3 — Phase 2: Earnings Exclusions

```
get_earnings_calendar() → build hard exclude list for today
→ any ticker reporting today is removed from the screener candidate list
```

---

### STEP 4 — Phase 3: Research Screener Candidates (repeat per ticker)

Candidates come from the screener file injected at prompt time — ranked by |gap%|.
No gap or RVOL threshold gates here; all screener candidates are researched.

```
For each candidate (in ranked order):
  Is ticker on earnings calendar today?
  ├── YES → HARD SKIP — never trade on earnings day
  └── NO  → research this ticker:
               ├── get_premarket_data(ticker)    → confirm gap, get RVOL from live data
               ├── get_news(ticker)              → news_catalyst signal
               ├── get_reddit_sentiment(ticker)  → contrarian_social signal
               ├── get_notable_mentions(ticker)  → notable_mention signal
               └── get_insider_activity(ticker)  → insider_buying signal
```

---

### STEP 5 — Phase 4: Sam Validation (only for candidates that passed Step 4)

```
For each candidate that cleared gap + RVOL filters:
  search_sam_weiss_briefings(ticker) → Sam's historical stance on this ticker
  get_sam_market_outlook()           → macro framework (called at most once per session)

Sam's view provides context only — it does NOT change setup_score.
```

---

### STEP 6 — Scoring

```
setup_score =
  IF 100+ completed trades exist:
    sigmoid(Σ coef_i × signal_i + bias)   ← logistic regression model
  ELSE:
    active_signals / 10                    ← equal-weight fallback

setup_score → one of three buckets:
  ≥ 0.45           → attempt trade execution (Step 7)
                      ⚠️  TEMPORARY — lowered from 0.55 to bootstrap trade history.
                      Will return to 0.55+ once logistic regression trains on 100+ real trades.
  0.35 – 0.45      → log_rejected_candidate (shadow log) + save_tomorrow_watchlist
  < 0.35           → ignore — no logging
```

---

### STEP 7 — Trade Execution Gates (when agent calls place_trade)

Each gate runs in sequence. First failure blocks the trade immediately.

```
Gate 1: Persistent circuit breaker (circuit-breaker.json)?
├── TRIPPED → blocked: "Circuit breaker — reset with: node agent.js reset-circuit"
└── clear → continue

Gate 2: Session circuit breaker (tripped this run)?
├── TRIPPED → blocked
└── clear → continue

Gate 3: setup_score ≥ 0.45?
├── NO  → blocked: "score X < 0.45 threshold"
└── YES → continue

Gate 4: Current time before 10:00am PT (17:00 UTC)?
├── NO  → blocked: "Entry window closed — past 10am PT"
└── YES → continue

Gate 5: 3 consecutive losses in trades-log.json?
├── YES → blocked: "3 consecutive losses — paused for manual review"
└── NO  → continue

Gate 6: Reconcile positions (second check, immediately before order)?
├── MISMATCH → alert email + blocked: "Reconciliation mismatch"
└── OK → continue

Gate 7: Already at max concurrent positions (4)?
├── YES → blocked: "Already at max positions"
└── NO  → continue

Gate 8: Circuit breaker thresholds (using live broker equity)?
├── daily loss ≤ -1.5% of SOD balance
│   → trip circuit, flatten ALL positions, alert email, blocked (persistent)
├── weekly loss ≤ -5% of week-start balance
│   → trip circuit, flatten ALL positions, alert email, blocked (persistent)
└── within limits → continue

Gate 9: Balance readable (equity > 0)?
├── NO  → blocked: "Could not read account balance"
└── YES → ALL GATES PASSED — execute order
```

---

### STEP 8 — Order Execution

```
DRY_RUN = true (default)?
├── YES → log intended order, use decision price as fill, write trade markdown
│         state: CANDIDATE → FILLED (synthetic) → PROTECTED
│         trades-open.json updated, no Robinhood call made
└── NO  (live) → submit market order to Robinhood
                  │   (fractional shares require market orders — limit orders not supported)
                  ├── ORDER_SUBMITTED → poll for fill confirmation
                  ├── Fill received → compute execSlippage = (fill - orbCheckPrice) / orbCheckPrice
                  │             and  decisionSlippage = (fill - decisionPrice) / decisionPrice (logged only)
                  │   ├── execSlippage > 50% of stop distance → SLIPPAGE GATE:
                  │   │     immediately exit position, record as closed, return blocked
                  │   │     (orbCheckPrice = 6:45am price daemon observed — decisionPrice excluded
                  │   │      because ORB already adjudicated thesis drift; gate measures exec quality only)
                  │   ├── execSlippage > 2% → log warning
                  │   └── record fill price
                  └── state: CANDIDATE → ORDER_SUBMITTED → ORDER_PENDING → FILLED → PROTECTED
                      trades-open.json updated with fill price, stop, target
```

---

### STEP 9 — Exit Daemon (6:25am–1:00pm PT, 45-second poll loop)

```
Every 45 seconds, for each open position:

Can get quote?
├── NO (5th consecutive failure) → force-close for safety
└── YES → price = current quote

price ≤ stopPrice?
├── YES → market sell — exit reason: "stop hit"
└── NO  → check target

price ≥ targetPrice?
├── YES → market sell — exit reason: "target hit"
└── NO  → hold

After 6:45am PT (all 3 opening-range bars complete):
  OR_low = min(bar1_low, bar2_low, bar3_low)
  OR_low > current_stopPrice (tighter)?
  ├── YES → update stopPrice = OR_low (stop only ever tightens, never loosens)
  └── NO  → keep ATR stop

Every 90 minutes: Haiku thesis-break check
  (triggers only if VIX spike >5% OR news headline contains halt/fraud/SEC/downgrade)
  ├── Haiku says "exit" → market sell — exit reason: "Haiku judgment: [reason]"
  └── Haiku says "hold" → continue

12:45pm PT hit (9:45am on early-close days)?
└── force-close: market sell all remaining open positions
```

---

### STEP 10 — Force-Close Failsafe (12:45pm PT, pure code)

```
Open positions in trades-open.json?
├── NONE → exit cleanly — daemon handled everything
└── ANY  → market sell each remaining position
           → record closed trade with exit reason "force-close 12:45pm PT"
           → update trade markdown with exit price + P&L

Early-close day?
├── YES → daemon already closed at 9:45am; force-close verifies nothing remains
└── NO  → standard 12:45pm failsafe
```

---

### STEP 11 — EOD (1:30pm PT)

```
Retrain logistic regression on all closed trades (if ≥ 100)
├── < 100 trades → skip retraining, keep equal-weight fallback
└── ≥ 100 trades → fit new coefficients, 80/20 blend with yesterday's weights
                   walk-forward validate: this week vs last week accuracy
                   save signal-weights.json

Generate EOD report (Haiku):
  get_fear_greed_vix()       → today's closing sentiment
  get_market_data(ticker)    → closing prices for any open positions (should be none)
  save_tomorrow_watchlist()  → gap candidates for tomorrow's pre-market scan

Update rejected-candidates.json with EOD prices (shadow P&L)
Append to expectancy-log.json (win rate, expectancy, profit factor)
Email report to alvintsheth@gmail.com
```

---

### STEP 12 — Health Monitor (2:15pm PT)

```
For each check:
  sam-weiss-{today}.json exists?         → ✅ / ❌ scraper failure
  recommendations-{today}.md exists?    → ✅ / ❌ scan agent crashed
  eod-report-{today}.md exists?         → ✅ / ❌ EOD agent crashed
  trades-open.json has 0 positions?     → ✅ / ❌ force-close failed (CHECK ROBINHOOD)
  exit-daemon.log touched after 6:25am? → ✅ / ❌ daemon never started
  force-close.log touched after 12:45pm?→ ✅ / ❌ failsafe job never fired

Any failures?
├── YES → send alert email: "🚨 Investing Agent — N failure(s) on YYYY-MM-DD"
└── NO  → silence (no email = all green)
```

---

## 7. Signal Stack — 10 Day-Trading Signals

All 10 signals feed a logistic regression model. Until 100 trades of history exist, equal-weight scoring is used (setup_score = active signals / 10).

### Primary Signals (day-trade specific) — **HARD GATES**

**`premarket_gap_up`** — Primary entry filter (HARD GATE)
Gap >2% pre-market on elevated volume. Computed from Yahoo Finance `preMarketPrice` vs FMP previous close.
Formula: `(preMarketPrice - prevClose) / prevClose * 100 > 2`
**This signal must be `true` to trade — not just a scoring signal. If `false`, the trade is blocked in code regardless of setup_score.**

**`rvol_spike`** — Relative Volume (scoring signal, NOT a hard gate)
Pre-market volume >2× the 30-day daily average × 0.08 (pre-market is ~8% of daily session).
High RVOL = institutional activity, not retail noise.
**Not a hard code gate** — Yahoo Finance's `preMarketVolume` field returns null at 6am PT, making `rvolHigh` unreliable as a binary block. Null data ≠ confirmed low RVOL. Kept as a heavily-weighted scoring signal; agent notes RVOL status in rationale. Only hard-blocks if RVOL is explicitly confirmed <1× via FMP data.

**`gap_likely_holds`** — Gap sustainability
Fires `true` when gap >5%: historically the gap holds intraday (momentum continues).
Gap 2-5%: medium probability — signal fires `false`.
Gap <2%: high fill probability — signal fires `false`, avoid.
Derived from NASDAQ historical patterns in `output/knowledge-base/nasdaq-historical.md`.

### Context Signals

**`macro_tailwind`** — VIX/F&G sets risk appetite. Low VIX (<18), rising F&G = favorable. High VIX = tighten stops.

**`sector_leading`** — Sector ETF up pre-market. Stock in leading sector = momentum support.

**`news_catalyst`** — Fundamental/event-driven catalyst only: earnings beat/miss, guidance raise/lower, FDA approval/rejection, product launch, M&A, regulatory event, macro event. Analyst upgrades/PT raises do NOT qualify — use `analyst_conviction` instead. These two signals must be independent; never both true for the same catalyst event.

**`notable_mention`** — Executive order, CEO shoutout, Congressional disclosure, major investor move. Checked via DuckDuckGo (5 queries per ticker).

**`insider_buying`** — Recent Form 4 C-suite buy from SEC EDGAR direct API (`data.sec.gov`). Supportive context only — filing lag means this is not a same-day signal.

**`contrarian_social`** — Overnight Reddit/StockTwits post count >15 with bearish sentiment on fundamentally strong setup. Reddit searched with `t=day` filter to capture overnight chatter.

**`analyst_conviction`** — 2+ analyst upgrades or material PT raise (>20%). Analyst-driven gaps only. Cannot be true simultaneously with `news_catalyst` for the same catalyst event — e.g. a pure analyst upgrade day scores `analyst_conviction=true`, `news_catalyst=false`.

### Sam Weiss (validation lens, not a signal)
`search_sam_weiss_briefings(ticker)` and `get_sam_market_outlook` are available after independent research. Sam's stance does NOT change setup_score — it informs position context.

---

## 8. Scoring System — Logistic Regression

### Model
setup_score = sigmoid(Σ coef_i × signal_i + intercept)

Trained daily at EOD using L2-regularized logistic regression in pure JavaScript (gradient descent, 500 epochs, lr=0.05, λ=0.01). No external ML libraries. `setup_score` is a model output used as an entry threshold — it is NOT a calibrated win probability.

**Thresholds:**
| setup_score | Action |
|-------------|--------|
| ≥ 0.45 | Enter trade ($125 fixed, up to 4 concurrent) |
| 0.35–0.45 | Shadow-log only via `log_rejected_candidate` |
| < 0.35 | Avoid |

Model-driven variable sizing (based on score confidence) is reserved until 200 live trades are logged (`isLive: true` field). Before that, all qualifying trades use flat $125 sizing.

**Hard excludes (regardless of score):**
- Earnings today before close
- `premarket_gap_up = false` (code gate — no exceptions)
- `rvol_spike = false` when RVOL explicitly confirmed <1× (scoring penalty + agent caution; null/unavailable data is NOT a block)
- Past 10am PT entry window
- Already at max concurrent positions (4)
- 3 consecutive losses (paused for manual review)
- Broker reconciliation mismatch

**Fallback (< 100 trades):** Equal-weight — setup_score = active signal count / 10

**Variance filter:** `trainModel()` computes variance per feature before training. Features with variance < 0.04 are **excluded from gradient updates** (weight stays at 0) — not just warned. Features that are nearly always true (like `premarket_gap_up` on screener output) can't be informative and risk destabilising coefficients. Excluded features are logged and reported in `signal-weights.json` as `excludedFeatures`.

### Walk-Forward Validation
At EOD, coefficients from this week are compared against last week on held-out trades. Accuracy reported in EOD email. New coefficients are 80/20 blended with prior day's to prevent overfitting.

**Model storage:** `output/signal-weights.json`
```json
{
  "weights": [0.82, 0.61, 0.44, ...],
  "bias": -0.18,
  "trainedOn": 87,
  "lastUpdated": "2026-06-14",
  "validation": {
    "thisWeekAccuracy": 0.64,
    "lastWeekAccuracy": 0.61
  }
}
```
---

## 9. Trade Execution & Rationale Logging

Every executed trade produces two permanent records:

### 1. trades-log.json (machine-readable, learning system)
```json
{
  "trades": [{
    "id": "NVDA-buy-2026-06-12T09:45:32Z",
    "ticker": "NVDA",
    "side": "buy",
    "quantity": 1,
    "entryPrice": 205.19,
    "signals": {
      "premarket_gap_up": true,
      "rvol_spike": true,
      "gap_likely_holds": true,
      "macro_tailwind": true,
      "sector_leading": true,
      "news_catalyst": false,
      "notable_mention": true,
      "insider_buying": false,
      "contrarian_social": false,
      "analyst_conviction": false
    },
    "pnl": null,
    "exitPrice": null,
    "exitTime": null
  }]
}
```

### 2. output/trades/YYYY-MM-DD-TICKER-buy.md (human-readable audit log)
Each trade gets a dedicated markdown file documenting:
- **Full thesis** — exactly why this stock NOW, with specific data points
- **Position parameters** — entry, target, stop loss, expected max gain/loss
- **Catalyst timeline** — when the thesis should play out
- **Market context** — VIX, Fear & Greed, sector performance at time of trade
- **Sam Weiss alignment** — his explicit stance and framework guidance
- **Technical snapshot** — RSI, 52W position, MA50/200, volume
- **All 10 signal verdicts** — ✅ or ❌ for each signal
- **Stop/target levels** — ATR-14 at entry; opening-range stop updated after 6:45am PT if OR low is tighter (never loosens); immediate exit if price already below new OR stop when check fires
- **Fill price confirmation** — live mode polls broker post-order for actual fill; slippage always logged, warning at >2%
- **Slippage gate (item 36, implemented)** — `execSlippage = (fill - orbCheckPrice) / orbCheckPrice`. If execSlippage exceeds 50% of the stop distance, the position is immediately exited and recorded as closed. Reference is `orbCheckPrice` (6:45am price), not `decisionPrice` (5:40am) — ORB already adjudicated the 5:40am→6:45am drift. A separate `decisionSlippage` field is logged for analysis but never gated on.
- **Order state machine** — every trade tracks explicit states with timestamps:
  `CANDIDATE → ORDER_SUBMITTED → ORDER_PENDING → FILLED → PROTECTED → EXIT_PENDING → CLOSED`
  Stop/target only enforced once `PROTECTED`. Entry slippage computed at `FILLED` state from confirmed fill price.
- **Robinhood order result** — raw JSON confirmation (or DRY RUN output)

This creates a permanent, auditable record of every trading decision — enabling post-mortems and long-term signal calibration.

---

## 10. Circuit Breakers & Risk Management

All limits pull live account balance dynamically at the start of each run. Cannot be overridden by Claude.

### Position Size (Pilot Mode, default)
```
MAX_POSITIONS=4, POSITION_DOLLARS=125 → up to 4 concurrent, $125 fixed per trade ($500 max deployed)
```
Sized from **settled buying power** (not total equity) to avoid good-faith-violation risk from unsettled T+1 proceeds. Pre-flight logs a warning if buying_power < 90% of equity. Dollar-denominated → fractional quantity = dollarAmount / price.

### Max Concurrent Positions
`checkMaxConcurrent(openPositions)` — blocks new entries if at/above MAX_POSITIONS (4). Each trade also records `sector`, `sharedSector` (true if another open position is in the same GICS sector), and `marketDrivenDay` (true if |SPY change| > 1.5%) for correlation analysis at N=60.

**ORB mode fix v1 (July 2026 — superseded):** Initially fixed `checkMaxConcurrent` to also count `queued-trades.json` entries toward MAX_POSITIONS so the agent wouldn't queue all 10 screener candidates. This created a new bug: on days where all queued trades fail ORB (gap fades), the agent blocks backup candidates and the system exits with 0 trades instead of trying the next-best scorer.

**ORB mode fix v2 (July 8 2026):** `checkMaxConcurrent` now only counts confirmed open positions (`trades-open.json`). The agent queues every candidate that passes the score threshold (≥0.45) regardless of how many are already queued. Exit-daemon enforces MAX_POSITIONS at actual entry time (6:45am ORB check) — it enters candidates in score order and stops when MAX_POSITIONS confirmed entries are reached. This means on a day where the top 4 all fade, the #5 candidate still gets an ORB entry attempt. Observed July 8 2026: AVAV/MTZ/LYB/DOW all queued, all faded → BABA (0.47, +8.3%) was blocked and never queued → 0 trades. With v2, BABA would have been queued and gotten an ORB shot.

### Daily Loss Limit (1.5% of SOD balance)
```
sodBalance      = balance saved at first scan of the day (sod-balance.json)
brokerEquity    = get_portfolio equity_value (authoritative source)
dailyLoss%      = (brokerEquity - sodBalance) / sodBalance
cross-check     = local (realized + unrealized) / sodBalance — warns if >2% discrepancy
if dailyLoss% ≤ -1.5%:
  → save circuit-breaker.json (tripped=true, does NOT auto-clear)
  → flatten ALL open positions (market sell)
  → send alert email
  → block all new trades
  → manual reset required: node agent.js reset-circuit
```
Uses broker-reported equity as the authoritative P&L source. Local trade log is cross-checked but not controlling. Persistent state survives process restarts — next day's scan still blocks until manually reset.

### Weekly Drawdown Breaker (5%)
```
weeklyLoss% = (currentBalance - weekStartBalance) / weekStartBalance
if weeklyLoss% ≤ -5%: CIRCUIT.tripped = true — MANUAL REVIEW REQUIRED
```

### Consecutive-Loss Pause
```
checkConsecutiveLosses() — reads last 3 completed trades from trades-log.json
if all 3 are losses: block new entries with reason "3 consecutive losses — paused for manual review"
```
Applies in both DRY_RUN and live mode.

### Broker Reconciliation
```
reconcilePositions(acct) — compares trades-open.json vs get_equity_positions
on mismatch: send alert email + halt all trading
```
Called at scan start and again before every trade execution. `ORDER_PENDING` positions are excluded from the comparison — they haven't filled yet so Robinhood shows nothing; comparing them would generate false-positive mismatch alerts every cycle.

### Stop Loss: ATR-14 + Opening Range
```
Initial stop:
  stopDistancePct = clamp((ATR14 / price) × 0.75, 1.0%, 4.0%)
  targetDistancePct = stopDistancePct × 1.5  (1.5:1 reward:risk)

Opening range update (after 6:45am PT — all 3 bars complete):
  OR low = min of first 3 five-minute bars after open
  if OR low > ATR stop price (tighter stop): update stop to OR low
```
Stop enforced by exit-daemon polling every 45 seconds — no 90-minute gap risk. Robinhood only supports market orders for fractional shares; no broker-side stop orders.

### Hard Force-Close (failsafe)
- **Primary:** exit-daemon force-closes at 12:45pm PT (9:45am on early-close days)
- **Failsafe:** `agent.js force-close` at 12:45pm verifies daemon closed everything; closes any remainder
- Pure code, no Claude, no exceptions.

### Robinhood Account
- Account number: 674082664
- Type: Agentic trading sub-account (`agentic_allowed: true`)
- All orders: market orders (GFD — good for day)
- Fractional shares: supported (dollar-denominated)
- No limit/stop orders available for fractional positions

---

## 11. Self-Learning System — Logistic Regression

Every closed trade becomes a training sample. The model is retrained daily at EOD.

### Training Data (`trades-log.json`)
Each closed trade has:
```json
{
  "ticker": "NVDA", "date": "2026-06-14",
  "entryPrice": 205.19, "exitPrice": 208.40,
  "decisionPrice": 205.00, "slippagePct": 0.09,
  "pnl": 15.60, "pnlPct": 1.56,
  "rMultiple": 0.62,
  "exitReason": "target hit",
  "signals": { "premarket_gap_up": true, "rvol_spike": true, ... },
  "setupScore": 0.68,
  "catalystType": "earnings_beat",
  "regime": {
    "vixLevel": 16.4,
    "vixBucket": "elevated",
    "fearGreedScore": 58,
    "fearGreedBucket": "greed",
    "spyVs50dma": "above",
    "qqqVs50dma": "above"
  },
  "isLive": false,
  "maxFavorableExcursion": 1.8,
  "maxAdverseExcursion": -0.4,
  "timeInTradeMinutes": 43
}
```
`timeInTradeMinutes` — minutes from entry fill to exit. Tests whether the edge hypothesis holds in the first 90 minutes: do winners resolve quickly, do slow trades fail more often, is there a "stale thesis" threshold?

`rMultiple` = pnlPct / stopDistPct — measures outcome in units of risk taken. A +1R trade recovered the full stop distance in profit; -1R is a full stop-out. This is more informative than binary win/loss for model training and expectancy tracking.

`catalystType` — classifies the primary driver of the gap. Used to slice edge by catalyst type after 100+ trades (e.g., "do earnings_beat gaps outperform analyst_upgrade gaps in our universe?"). 13 enum values: `earnings_beat | earnings_miss | guidance_raise | analyst_upgrade | fda_news | ma | insider_purchase | macro | sector_sympathy | notable_mention | product_launch | regulatory | technical`.

`regime` — market regime snapshot at entry time. Populated from Phase 1 `get_fear_greed_vix` output. Used to slice edge by regime after 100+ trades (e.g., "do gap plays work in extreme fear vs greed environments?"). Fields: vixLevel, vixBucket, fearGreedScore, fearGreedBucket, spyVs50dma, qqqVs50dma.
```

### Shadow Logging (`rejected-candidates.json`)
Candidates scoring 0.35–0.45 (below entry threshold) are logged via `log_rejected_candidate`. At EOD, their actual closing price is filled in for shadow P&L tracking — enables calibrating the threshold over time.

### Model Training (EOD)
```
Features: 10 signal binaries
Label: 1 if pnl > 0, else 0
Method: L2-regularized logistic regression, pure JS gradient descent
  - 500 epochs, lr=0.05, λ=0.01
  - Blend: 80% yesterday's weights + 20% today's new fit
  - Minimum 100 trades required (equal-weight fallback below)
```

### Model Output (`signal-weights.json`)
```json
{
  "weights": [0.82, 0.61, 0.44, 0.38, 0.31, 0.29, 0.19, 0.12, 0.08, 0.04],
  "bias": -0.18,
  "trainedOn": 87,
  "lastUpdated": "2026-06-14",
  "validation": { "thisWeekAccuracy": 0.64, "lastWeekAccuracy": 0.61 }
}
```

### Morning Prompt Context
```
SIGNAL MODEL (trained on 87 trades, updated 2026-06-14)
  premarket_gap_up          coef: +0.820
  rvol_spike                coef: +0.610
  gap_likely_holds          coef: +0.440
  ...
  Walk-forward: this week 64% | last week 61%
```

### Tomorrow's Watchlist
At EOD, the agent saves `output/watchlist-tomorrow.json` with specific entry triggers, targets, and stop levels. Next morning, these load into the prompt so the agent picks up exactly where it left off.

---

## 12. Market Data Sources

FMP's post-August 2025 free tier only supports single-stock stable endpoints. ETFs, multi-symbol queries, technical indicators, news, earnings, and insider data all require a paid subscription. This agent works around those limitations:

| Data | Source | Notes |
|------|--------|-------|
| Stock price, 52W H/L, MA50/MA200 | FMP `stable/quote?symbol=X` | Free, single symbol |
| Historical prices | FMP `stable/historical-price-eod/light?symbol=X` | Free, full history |
| RSI-14 | Computed from historical closes | Wilder's smoothing method |
| Volume vs avg | Computed from 20-day historical average | |
| Company profile (sector, beta) | FMP `stable/profile?symbol=X` | Free |
| P/E, EV/EBITDA | FMP `stable/key-metrics-ttm?symbol=X` | Free |
| VIX | FMP `stable/quote?symbol=%5EVIX` | Works as index |
| SPY, QQQ, IWM | Yahoo Finance chart API | `v8/finance/chart/{sym}` |
| Sector ETFs (XLK, XLF, etc.) | Yahoo Finance chart API | Sequential w/ 80ms delay |
| Treasury yields | US Treasury XML (free) | `home.treasury.gov` daily |
| CPI, Fed rate | DuckDuckGo web search | In-agent tool call |
| CNN Fear & Greed | CNN dataviz API (free) | Score 0-100 |
| Stock news | DuckDuckGo web search | 2 queries per ticker |
| Earnings data | DuckDuckGo web search | Agent interprets results |
| Insider trades | DuckDuckGo (SEC Form 4) | Agent interprets results |
| Analyst ratings | DuckDuckGo web search | Agent interprets results |
| Social sentiment | Reddit JSON + StockTwits API | Both free, no key |
| Notable mentions | DuckDuckGo (5 parallel queries) | Per ticker |

---

## 13. Sentiment Layer — Reddit & StockTwits

### Reddit (no API key required)
```
https://www.reddit.com/r/{subreddit}/search.json?q={ticker}&sort=top&t=day&limit=5
```
Subreddits: r/wallstreetbets, r/stocks, r/investing

### StockTwits (no API key required)
```
https://api.stocktwits.com/api/2/streams/symbol/{ticker}.json
```
Returns recent messages with explicit Bullish/Bearish/Neutral labels.

Both are **contrarian signals** — extreme bullishness = crowded trade, extreme bearishness on strong fundamentals = contrarian buy.

---

## 14. Web Search & Notable Mentions

### DuckDuckGo Search
Fetches `https://html.duckduckgo.com/html/?q={query}` and parses HTML for titles, URLs, snippets. No API key. Uses a two-pass regex parser with fallback for edge cases.

### Notable Mentions — 5 Parallel Queries Per Ticker
1. `{TICKER} Trump tariff trade deal executive order` — policy moves
2. `{TICKER} Jensen Huang Elon Musk CEO mention` — tech influencer shoutouts
3. `{TICKER} Nancy Pelosi Congress trade disclosure` — STOCK Act filings
4. `{TICKER} Warren Buffett Berkshire Ackman Cathie Wood` — major investor positions
5. `{TICKER} analyst upgrade downgrade price target` — street conviction changes

---

## 15. Robinhood MCP — Trade Execution

### Connection
```
URL: https://agent.robinhood.com/mcp/trading
Protocol: HTTP transport, JSON-RPC 2.0
Auth: OAuth 2.0 with PKCE (S256), tokens in .env
```

### Authentication
One-time setup via `node robinhood-auth.js`:
1. Register OAuth client (reuses `ROBINHOOD_CLIENT_ID` from `.env` if present)
2. Generate PKCE verifier + SHA256 challenge
3. Open browser to Robinhood OAuth page
4. Listen on localhost:8765 for callback
5. Exchange authorization code for access + refresh tokens
6. Save to `.env`: `ROBINHOOD_ACCESS_TOKEN`, `ROBINHOOD_REFRESH_TOKEN`

Token auto-refreshes when expired (259-hour lifetime).

### SSE Parsing
Robinhood MCP returns `text/event-stream` format, not JSON. The `rhPost()` function detects `content-type: event-stream` and parses `data: {json}` lines.

### Account Selection
`rhGetAccountNumber()` calls `get_accounts` and prefers `agentic_allowed: true` accounts (sub-account 674082664) over the default account.

### MCP Tools Used
| Tool | Purpose |
|------|---------|
| `get_accounts` | Get account list, find agentic account |
| `get_portfolio` | Portfolio equity, buying power |
| `get_equity_positions` | Current holdings with unrealized P&L |
| `place_equity_order` | Execute market order: symbol, side, quantity, GFD |
| `get_equity_quotes` | Real-time quotes (for EOD price lookups) |

---

## 16. EOD Report & Gmail Delivery

**Command:** `node agent.js eod`
**Output:** `output/eod-report-YYYY-MM-DD.md`
**Email:** `alvintsheth@gmail.com` via nodemailer + Gmail App Password

### Report Contents
1. **P&L Summary** — per trade: entry vs exit price, P&L $ and %, vs SPY/QQQ/IWM same-day benchmarks
2. **Key Learnings** — which signals fired/missed, what to do differently tomorrow

Benchmark returns (SPY, QQQ, IWM daily % change) are fetched from Yahoo Finance at runtime and appear in both the email subject line and the report body so you can immediately see whether you beat the market that day.

### Expectancy Metrics (`expectancy-log.json`)
Each EOD run appends: win rate, avg win $, avg loss $, expectancy ($/trade), profit factor. Tracked over time to detect model drift.

### Gmail Configuration
```
GMAIL_USER=alvintsheth@gmail.com
GMAIL_APP_PASSWORD=[16-char Google App Password]  (not your account password)
```
Uses `nodemailer` with Gmail SMTP (`smtp.gmail.com:587`). App password generated at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

## 16b. Weekly P&L Report (`weekly-report.js`)

**Schedule:** Sundays 5:30pm PT via launchd
**File:** `weekly-report.js`
**Cost:** $0 — pure code, no Claude API calls
**Output:** Email to `alvintsheth@gmail.com`; logs to `output/logs/weekly-report.log`

Runs every Sunday evening and summarizes the Mon–Fri week just completed.

### Report Sections

1. **Performance vs Benchmarks**
   - Agent total P&L $ and % of capital
   - SPY (broad market), QQQ (Nasdaq-100/tech peers), IWM (Russell 2000 / small-cap momentum)
   - Alpha vs each benchmark (agent % − benchmark %)
   - Dollar equivalent: "buy-and-hold SPY with the same capital would have made $X"

2. **Trade Statistics**
   - Total trades, W/L split, win rate, avg win, avg loss, expectancy $/trade, profit factor

3. **Signal Performance** — for each of the 10 signals: how many trades fired it, win rate

4. **Setup Score Bands** — 0.45–0.55, 0.55–0.65, 0.65+: trade count, win rate, total P&L per band

### Data Sources
- `output/trades-log.json` — closed trades for the week (filtered by date range Mon–Fri)
- `output/expectancy-log.json` — daily expectancy metrics
- `output/sod-balance.json` — capital base for % return calculation
- Yahoo Finance (v8 chart API, no key required) — SPY, QQQ, IWM weekly returns

### To Activate Plist
```bash
launchctl load ~/Library/LaunchAgents/com.investing-tool.weekly-report.plist
```

### To Run Manually
```bash
npm run weekly-report
```

---

## 17. Daily Automation (macOS launchd)

All 10 jobs are loaded and running:

```bash
launchctl list | grep investing-tool
# com.investing-tool.scrape            → 5:30 AM daily
# com.investing-tool.analyze           → 6:00 AM daily (scan mode)
# com.investing-tool.exit-daemon       → 6:25 AM daily (continuous monitor, exits ~1pm)
# com.investing-tool.force-close       → 12:45 PM daily (failsafe — daemon handles primary exits)
# com.investing-tool.eod               → 1:30 PM daily
# com.investing-tool.monitor           → 2:15 PM daily (EOD health check)
# com.investing-tool.monitor-early     → 6:15 AM daily (early health check — emails during trading window)
# com.investing-tool.kb-weekly         → 5:00 AM every Sunday
# com.investing-tool.weekly-report     → 5:30 PM every Sunday
# com.investing-tool.universe-refresh  → 5:00 AM monthly (1st of every month)
```

All jobs except `weekly-report` perform a market-day check at startup (weekends exit immediately; holidays checked against hardcoded 2026 calendar + live Yahoo Finance QQQ status).

### Plist Files
Located at `~/Library/LaunchAgents/`:
- `com.investing-tool.scrape.plist`
- `com.investing-tool.analyze.plist` (runs `agent.js scan`)
- `com.investing-tool.exit-daemon.plist` (runs `exit-daemon.js`, long-running 6:25am–1pm)
- `com.investing-tool.force-close.plist` (runs `agent.js force-close` — failsafe)
- `com.investing-tool.eod.plist`
- `com.investing-tool.monitor.plist` (EOD — 2:15pm)
- `com.investing-tool.monitor-early.plist` (early — 6:15am, passes `--early` flag)
- `com.investing-tool.kb-weekly.plist`
- `com.investing-tool.weekly-report.plist` (runs `weekly-report.js` — Sunday 5:30pm PT)
- `com.investing-tool.universe-refresh.plist` (runs `universe-refresh.js` — monthly, 1st of each month)

### Log Files
`output/logs/`:
- `scrape.log` — 5:30am scraper output
- `analyze.log` — 6:00am scan output
- `exit-daemon.log` — 6:25am daemon output (continuous, appended through 1pm)
- `force-close.log` — 12:45pm force-close failsafe output
- `eod.log` — 1:30pm EOD report output
- `monitor.log` — both 6:15am and 2:15pm health check output (appended)
- `kb-weekly.log` — Sunday KB update output
- `weekly-report.log` — Sunday 5:30pm weekly P&L summary output
- `universe-refresh.log` — monthly universe refresh output

### To manually trigger any job
```bash
launchctl start com.investing-tool.scrape
launchctl start com.investing-tool.analyze
launchctl start com.investing-tool.exit-daemon
launchctl start com.investing-tool.force-close
launchctl start com.investing-tool.eod
launchctl start com.investing-tool.monitor
launchctl start com.investing-tool.monitor-early
launchctl start com.investing-tool.kb-weekly
```

### Node.js Path
The nvm-managed Node is hardcoded in all plists:
```
/Users/alvintsheth/.nvm/versions/node/v22.22.3/bin/node
```

---

## 18. Health Monitor

**Script:** `monitor.js`
**Schedule:** 6:15am PT (early check) AND 2:15pm PT (EOD check)
**Cost:** $0 — pure code, no Claude API calls

Two runs per day — early fires while the trading window is still open so you can intervene:

### 6:15am Early Check (`--early` flag)
Runs 4 checks immediately after the scan completes:

| Check | Pass condition | Failure means |
|-------|---------------|---------------|
| Screener | `screener-{today}.json` exists | screener crashed — agent had no candidates |
| Scrape | `sam-weiss-{today}.json` exists | scraper crashed or never ran |
| Scan | `recommendations-{today}.md` exists | scan agent crashed |
| Silent failure | if gap-up (≥2%) candidates existed: ≥1 trade placed OR ≥1 shadow log entry exists | **agent had qualifying setups but placed zero trades AND logged nothing** — likely internal error (balance bug, hard gate mis-fire, API error). Check `output/logs/analyze.log` immediately — trading window is still open |

The silent failure check is the key new guard: it catches the class of bugs (e.g. `equity_value="0"` truthy string, rvol gate mis-fire) where the agent runs and produces a recommendations file but silently blocks every trade without logging why. It only alerts if candidates had `gapPct ≥ 2%` — all-negative gaps (e.g. sector washout days) correctly produce no alert.

### 2:15pm EOD Check
Runs all 8 checks (the 4 above + 4 EOD-only):

| Check | Pass condition | Failure means |
|-------|---------------|---------------|
| Screener | `screener-{today}.json` exists | screener crashed — agent had no candidates |
| Scrape | `sam-weiss-{today}.json` exists | scraper crashed or never ran |
| Scan | `recommendations-{today}.md` exists | scan agent crashed |
| EOD | `eod-report-{today}.md` exists | EOD agent crashed |
| Positions cleared | `trades-open.json` has 0 entries | force-close failed to close something — **check Robinhood immediately** |
| Exit-daemon log | `exit-daemon.log` touched 6:25am AND 12:30pm+ | daemon crashed mid-session — positions may have been unmonitored |
| Force-close log | `force-close.log` touched after 12:45pm | failsafe job never fired |
| Silent failure | same as early check | agent had qualifying setups but placed nothing |

On failure: email subject is `🚨 Investing Agent [6:15am Early Check] — N failure(s)` or `[EOD Check]`.

On success: no email sent (silence = green).

```bash
# Manually trigger
node monitor.js --early    # early check (checks 1-4 + silent failure)
node monitor.js            # EOD check (all 8 checks)
launchctl start com.investing-tool.monitor-early
launchctl start com.investing-tool.monitor
```

---

## 19. File Structure

```
investing-tool/
├── agent.js                          # Main investing agent + EOD + force-close
├── exit-daemon.js                    # Long-running exit monitor (6:25am–1pm, 45s poll)
├── monitor.js                        # Daily health checker (pure code, no Claude)
├── scraper.js                        # Daily morning scraper
├── scraper-knowledge-base.js         # Full KB + weekly updater
├── robinhood-auth.js                 # One-time OAuth PKCE flow
├── debug-page.js                     # Dev utility for inspecting scraped pages
├── package.json                      # Node.js project config (ESM)
├── .env                              # API keys and credentials (gitignored)
├── .gitignore                        # Excludes .env, node_modules, output/, screenshots/
├── ABOUT.md                          # This document
│
├── node_modules/                     # Dependencies
│
├── output/
│   ├── sam-weiss-YYYY-MM-DD.json    # Daily scrape (6am)
│   ├── recommendations-YYYY-MM-DD.md # Agent's analysis + trade decisions
│   ├── eod-report-YYYY-MM-DD.md     # EOD P&L + learnings
│   ├── trades-log.json              # All closed trades (used for model training)
│   ├── trades-open.json             # Today's open positions (reset daily)
│   ├── signal-weights.json          # Logistic regression model coefficients
│   ├── watchlist-tomorrow.json      # Tomorrow's pre-market gap candidates
│   ├── sod-balance.json             # Start-of-day balance (circuit breaker baseline)
│   ├── circuit-breaker.json         # Persistent trip state — cleared by: node agent.js reset-circuit
│   ├── expectancy-log.json          # Daily expectancy/profit-factor history
│   ├── rejected-candidates.json     # Shadow log: 0.35–0.45 score candidates + EOD prices
│   │
│   ├── trades/                      # Per-trade rationale files
│   │   ├── 2026-06-14-NVDA-buy.md  # Entry data, signals, setup_score, exit outcome
│   │   ├── 2026-06-14-NVDA-buy-DRY.json  # Dry-run order log (when DRY_RUN=true)
│   │   └── ...
│   │
│   ├── logs/
│   │   ├── scrape.log               # 5:30am scraper output
│   │   ├── analyze.log              # 6:00am scan output
│   │   ├── exit-daemon.log          # 6:25am–1pm daemon output (continuous)
│   │   ├── force-close.log          # 12:45pm failsafe output
│   │   ├── eod.log                  # 1:30pm EOD output
│   │   ├── monitor.log              # 2:15pm health check output
│   │   └── kb-weekly.log            # Sunday KB update
│   │
│   └── knowledge-base/
│       ├── strategy.md              # 42KB — Sam's 4-part framework
│       ├── investing-basics.md      # 299KB — 6 chapters all slides
│       ├── market-outlook.md        # 44KB — near/intermediate/long-term
│       ├── market-understanding.md  # 14KB
│       ├── nasdaq-historical.md     # 28KB — correction/rally data 2007-2025
│       ├── portfolio-overview.md    # 24KB
│       ├── trade-history.md         # 77KB — all historical trades
│       ├── trade-watchlist.md       # 2KB — current watchlist
│       ├── manifest.json            # KB scrape manifest
│       │
│       ├── briefings/               # 535+ files, updated weekly
│       │   └── YYYY-MM-DD-slug.md   # Full briefing + reader comments
│       │
│       ├── portfolios/              # 9 portfolio pages
│       │   ├── targaryen.md
│       │   ├── baratheon.md
│       │   ├── lannister.md
│       │   ├── tyrell.md
│       │   ├── arryn.md
│       │   ├── tarly.md
│       │   ├── stark.md
│       │   ├── frey.md
│       │   └── hightower.md
│       │
│       ├── articles/                # 12 long-form articles
│       │   └── 001-*.md ... 012-*.md
│       │
│       └── stocks/                  # Individual stock pages (limited)
│           ├── NVDA.md
│           └── AAPL.md
│
└── screenshots/                     # Debug screenshots (gitignored)
```

---

## 20. Environment Variables

**File:** `.env` (gitignored — NEVER commit this file)

```bash
# Sam Weiss subscription credentials
SAM_WEISS_USERNAME=alvintsheth@gmail.com
SAM_WEISS_PASSWORD=[password]

# Financial Modeling Prep — free stable tier
FMP_API_KEY=[key]

# Anthropic Claude API
ANTHROPIC_API_KEY=[key]  # Rotate at console.anthropic.com if exposed

# Gmail (nodemailer App Password)
GMAIL_USER=alvintsheth@gmail.com
GMAIL_APP_PASSWORD=[app password]

# Robinhood OAuth (generated by robinhood-auth.js)
ROBINHOOD_CLIENT_ID=[client id]
ROBINHOOD_ACCESS_TOKEN=[JWT, valid ~259h, auto-refreshes]
ROBINHOOD_REFRESH_TOKEN=[refresh token]

# Safety: DRY_RUN=true logs orders without submitting. Set false to go live.
DRY_RUN=true
```

---

## 21. How to Run

### Prerequisites
```bash
cd investing-tool
npm install
npx playwright install chromium
```

### Daily Usage (these run automatically via cron — manual override below)
```bash
npm run scrape        # 5:30am — scrape today's sam-weiss.com data
npm run scan          # 6:00am — day trade scan + execute (alias: npm run analyze)
npm run exit-daemon   # 6:25am — start exit monitor (runs until ~1pm)
npm run force-close   # 12:45pm — failsafe close all positions
node agent.js reset-circuit  # manual: clear circuit breaker (does not require market day)
npm run eod           # 1:30pm — EOD report + email + model retrain
npm run monitor       # 2:15pm — health check
npm run run           # scrape + scan back-to-back
```

### Knowledge Base
```bash
npm run scrape:kb        # Full scrape (first time, ~30-60 min)
npm run scrape:weekly    # Latest 10 briefings (runs automatically Sundays 5am)
```

### One-Time Setup (already done)
```bash
node robinhood-auth.js   # Authenticate Robinhood MCP
```

---

## 22. Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js v22.22.3, ESM modules |
| AI reasoning (analyze) | Claude Sonnet 4.6 (`claude-sonnet-4-6`) |
| AI reasoning (EOD) | Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) |
| AI client | @anthropic-ai/sdk ^0.24.0 |
| Web scraping | Playwright ^1.44.0 (headless Chromium) |
| Config | dotenv ^16.4.5 |
| HTTP | Node.js native `fetch` (built-in since Node 18) |
| Email | nodemailer ^8.0.11 + Gmail SMTP |
| Scheduling | macOS launchd (10 jobs: scrape, scan, exit-daemon, force-close, eod, monitor, monitor-early, kb-weekly, weekly-report, universe-refresh) |
| Trade execution | Robinhood Agentic Trading MCP (HTTP transport) |

### Model Selection by Task
- **Analyze run (6:00am):** `claude-sonnet-4-6` — structured tool-use + multi-signal scoring. Sonnet is excellent for this: the task is well-defined (call tools in phases, apply scoring rubric, write report). Opus' extra reasoning depth adds cost without meaningfully better decisions.
- **EOD run (1:30pm):** `claude-haiku-4-5-20251001` — purely formulaic: fetch prices, compute P&L, write watchlist. Haiku handles this well and is 18× cheaper than Opus.

### Why Node.js ESM?
Started with Playwright (Node ecosystem) + Anthropic SDK. Node's native `fetch` handles all HTTP. ESM is the modern standard.

### Why Playwright over Cheerio/Puppeteer?
Sam's site is WordPress with JavaScript-rendered dropdowns, tabs, and slides. Static parsers can't handle this. Playwright's `networkidle` + `page.evaluate()` handles all interactive elements.

---

## 23. APIs & Services Used

| Service | Cost | Auth | Purpose |
|---------|------|------|---------|
| sam-weiss.com | Paid subscription | Username/password (Playwright) | Primary investing intelligence, 535+ briefings |
| Financial Modeling Prep (stable tier) | Free | API key | Stock quotes, profiles, historical prices, key metrics |
| Yahoo Finance chart API | Free | None (User-Agent) | ETF quotes (QQQ, SPY, IWM, sector ETFs) |
| US Treasury | Free | None | Daily yield curve XML |
| Anthropic Claude API | Pay per token | API key | AI reasoning engine |
| Robinhood MCP | Robinhood account | OAuth2 PKCE | Trade execution on agentic sub-account |
| Gmail / SMTP | Google account | App password | EOD report email delivery |
| CNN Fear & Greed | Free | None | Market sentiment index |
| Reddit JSON API | Free | None (User-Agent) | Social sentiment (WSB, r/stocks, r/investing) |
| StockTwits API | Free | None | Sentiment labels (Bullish/Bearish/Neutral) |
| DuckDuckGo HTML | Free | None | Web search, news, notable mentions, earnings, insider data |

---

## 24. Why Credits Deplete Fast

The agent uses **Claude Sonnet 4.6** (analyze) and **Claude Haiku 4.5** (EOD) — tiered by task complexity:

### Why Each Run Is Expensive

**Current architecture (optimized):**
- Initial prompt: ~5,000 chars (NASDAQ patterns + learning memory only — no Sam content pre-loaded)
- No briefings, no outlook, no portfolio positions, no trade alerts, no watchlist pre-loaded — all tool-gated
- Sam's content only enters context when the agent explicitly calls `get_sam_market_outlook` or `search_sam_weiss_briefings` in Phase 4

**Cost estimate per session (current):**
- Analyze run (Sonnet, 20 iter max): ~30k tokens → ~$0.45
- EOD run (Haiku, 10 iter max): ~15k tokens → ~$0.06
- **~$0.51/day total** for both runs
- **~$15/month**

**Why this is also architecturally better:** Briefings in the initial context = the agent has absorbed Sam's current narrative before its first thought. That's not independent research — it's anchored research. Tool-gating Sam's content enforces the "market first, Sam second" discipline at a structural level, not just as a prompt instruction.

---

## 25. Improvement Backlog (stacked by priority)

Items are stacked: P1 = do now, P2 = after first 20 live trades, P3 = after first profitable month, P4 = if/when scaling.

### P1 — Reliability / Safety (do in next 2 weeks)

| # | Item | Why |
|---|------|-----|
| 1 | **Broker state reconciliation at startup** | If agent.js crashes between ORDER_SUBMITTED and FILLED, `trades-open.json` can show a phantom position. On next run, compare local state to Robinhood portfolio and alert/resolve divergence. |
| 2 | **Remove dead `runCheck()` function** | 100 lines of dead code in agent.js — no plist calls it, exit-daemon replaced it. Confuses future debugging. Low risk to remove. |
| 3 | **Fix `runCheck()` UTC/PT timezone bug (before re-enabling)** | If check mode is ever re-enabled, line 1660 computes PT time from UTC with a hardcoded offset that's wrong in winter (PST vs PDT). Use `Intl.DateTimeFormat` like the rest of the codebase. |

### P2 — Operations (after 20 live trades)

| # | Item | Why |
|---|------|-----|
| 4 | **Live market calendar from Polygon API** | Hardcoded holidays through 2027 require manual update. Polygon free tier has a market status/upcoming holidays endpoint. Fetch weekly, cache to `output/market-calendar.json`, fall back to hardcoded list if fetch fails. |
| 5 | **Scan no-output alert** | If scan runs but Claude produces no trade and no recommendations file (tool_use loop exhausted), monitor doesn't distinguish "correct no-trade day" from "agent confused and produced nothing." |
| 6 | **Deduplicate `TRADE_STATES`** | Defined in agent.js AND exit-daemon.js. Adding a state requires two edits. Extract to a shared constant or write exit-daemon to import from agent.js. |
| 7 | **Deduplicate `transitionState` / `addStateHistory`** | Same function, different name, one in each file. Same problem as above. |
| 19 | **Expected-value gate in place_trade** | Replace raw `setup_score ≥ 0.45` threshold with `EV = P(win) × avg_win_R + P(loss) × avg_loss_R > 0.1R`. P(win) stays as logistic regression sigmoid output. avg_win_R and avg_loss_R come from running trade history. Falls back to score ≥ 0.45 until ≥ 15 wins and ≥ 10 losses exist. Deferred because: (1) we have zero trades — gate won't activate for weeks anyway, (2) we don't know what our actual avg_win_R looks like yet — the threshold should be calibrated from real data not assumed, (3) ChatGPT said stop making architectural changes. Implement after 30-40 paper trades when R distribution is visible. Log both `setup_score` and `expectedR` on each trade once active. |
| 15 | **Evaluate 6:31am analyze job timing** | Gemini: pre-bell market orders queue for open execution, hitting the widest spreads of the day. Strong-catalyst setups establish direction in the first 60 seconds — too early to delay pre-data. Revisit after 50 paper trades: if gap-and-crap (open at high, immediate reversal) appears repeatedly in `timeInTradeMinutes` data, delay the analyze job to 6:31am PT. |
| 16 | **Signal ablation study at trade #100** | ChatGPT: after 100 trades, 2-3 signals will matter, 5-6 will do nothing, 1-2 may be harmful. Goal is elimination, not accumulation. Run ablation: compare model performance with each signal removed one at a time. Candidates likely to survive: RVOL, catalyst quality, sector strength. Candidates likely to drop: contrarian_social, insider_buying, analyst_conviction. |
| 17 | **Catalyst × Regime pivot table at trade #100** | ChatGPT: produce two cross-tab reports — (1) Catalyst Type × Avg R and (2) Regime Bucket × Avg R. This is where real edge discovery happens. Without regime tagging we could never answer "do earnings_beat gaps outperform in low-VIX environments?" The data is now being collected; the analysis is deferred until the sample is meaningful. |
| 22 | **Evaluate trailing stop vs fixed 1.5× ATR target** | Current exit takes profits at a fixed 1.5× ATR above entry (e.g. ~3.9% for ARM). This caps upside on strong moves — if a stock runs 10%, you exit at 3.9% and miss the rest. Trailing stop alternative: raise the stop as price rises, only exit on reversal. Captures more upside on gap-and-go days but risks giving back gains on a quick reversal. Trigger: 30-50 paper trades. Check whether winners consistently blow through the 1.5× target (suggesting targets are too tight) or barely reach it (suggesting they're appropriate). Don't guess — let the data decide. |
| 23 | **Migrate screener + FMP calls to Robinhood MCP tools** | Probe (July 2026) confirmed multiple replacements. **Done:** `get_equity_orders` with `placed_agent='agentic'` replaces `get_equity_positions` in `confirmFill()`. **Scanner verdict (CLOSED Jul 12 2026):** `FILTER_TYPE_GAP` fails with DXFeed 400 every morning at 5:40am PT across 5 probe days (Jul 8–12). `DAILY_GAINERS` + RVOL scan returns 0–5 results, all outside the 580-ticker universe. RH scanner has no pre-market data — Yahoo 580-ticker loop stays as the screener. Probe plist unloaded. **Remaining open:** `get_earnings_calendar` can replace `fmpEarnings()` (low risk); `get_equity_fundamentals` can replace FMP profile/TTM (no beta field); `get_equity_historicals` `bounds='extended'` returns pre-market 5-min bars. None are urgent — pursue at N=60+ when reducing external API dependencies has clear ROI. |
| 21 | ~~**Expand screener universe beyond 83 fixed tickers**~~ | **Done (Jun 30 2026).** Implemented `universe-refresh.js` — monthly script (1st of each month, 5am PT) that fetches S&P 500 + NASDAQ 100 + S&P MidCap 400 from Wikipedia (~900 candidates), fetches 1yr daily data from Yahoo, computes beta vs SPY via linear regression, filters on beta > 1.0 + avg daily dollar vol > $50M + price > $10, caps at 35 per GICS sector. Writes `output/universe.json` (200 tickers, 12 sectors on first run). Seeds (China ADRs, leveraged ETFs, crypto miners, small high-beta names) bypass filters. `screener.js` reads `universe.json` at startup, falls back to old 83-name list if missing. Cost: $0 — Wikipedia + Yahoo Finance only. Key new sectors: Health Care (18 biotech/diagnostic names), Industrials (35 incl. airlines), Consumer Discretionary (35 incl. cruise lines). |

| 24 | **Out-of-sample validation harness** | Add a strict train/test split to nightly `trainModel()`: hold out the most recent 20% of closed trades, never expose them to training, track live performance against the holdout. If live results track the backtest, edge is probably real. If they diverge, you're overfitting. This is the difference between a model that compounds and one that quietly fails. Trigger: 60+ closed trades (need enough for a meaningful holdout set). |
| 25 | **Expectancy with confidence intervals** | Track `avgR` and `winRate` with a 95% CI that shrinks as N grows. At N=10 the CI is enormous — "1W/0L" tells you nothing. At N=60 the CI starts to be informative. Display in weekly report: `Edge: +0.8R ± 1.2R (N=24, 95% CI)`. This reframes every good day from a dopamine hit to a data point, and tells you honestly when you know something vs. when you don't. Trigger: implement now for display, meaningful at 30+ trades. |
| 26 | **Trades-per-day distribution tracking** | Log how many trades the agent takes each session (0, 1, 2, 3, 4). A healthy multi-ticker system should show a spread — mostly 1-2, occasional 3-4, some zeros. Pinned at 4 every day means the 4th pick is marginal. Pinned at 0-1 means selection criteria are too tight and multi-ticker isn't actually accelerating reps. Cheap to add to the weekly report. Trigger: implement now. |
| 27 | **Fractional-Kelly sizing tied to measured edge** | Once expectancy is measured (item 25), size as a fraction of Kelly: `f = (p × b - q) / b` where p=win rate, q=loss rate, b=avg win/loss ratio. Quarter-Kelly is standard (avoids ruin while capturing most growth). Requires measured edge — do NOT apply Kelly to an unmeasured edge. Trigger: 60+ trades with stable expectancy CI. |
| 28 | **Volatility-based position sizing** | Size inversely proportional to ATR: higher-ATR stocks get smaller positions so each trade contributes equal risk. Replaces the flat $125 with `risk_dollars / (ATR × some_multiplier)`. Improves risk-adjusted returns without changing edge. Trigger: 20+ trades to validate that the base edge is real first. |
| 29 | **Realistic backtest cost modeling** | The logistic regression trains on historical trades. If those trades assumed mid-price fills and ignored slippage, the model is training on optimistic data. Bake a slippage assumption (e.g. 0.5% adverse on entry, 0.3% on exit) into `recordClosedTrade` P&L so the model trains on realistic net-of-cost outcomes. Trigger: 20+ live fills to calibrate realistic slippage distribution. |
| 30 | **Signal decay / feature stability monitoring** | Track each signal's hit rate over rolling 30-trade windows. If `news_catalyst` was predictive in months 1-2 and trends toward random in month 3, the edge may be getting crowded. Plot per-signal P&L contribution over time. Trigger: 100+ trades for the rolling window to be meaningful. |
| 32 | **Gap-fade entry filter — ORB entry at 6:45am** | ✅ Implemented + refined July 2026. Agent queues qualifying candidates (≥0.45 score, no MAX_POSITIONS cap at queue time). Exit-daemon: (1) logs 5-min price at 6:35am, (2) logs 10-min price at 6:40am, (3) at 6:45am checks price vs 10-min OR high (bars 1+2 only — bar3 excluded, it is the confirmation bar). Gap held → buy; gap faded → skip. (4) At 12:45pm, every entry gets `recoveredByClose`, `catalystType`, `catalystTag`, `effectiveGapPct`, `gapRetained` (effective/original gap ratio). OR variants (5-min, 10-min, 15-min highs + bar closes) logged on every candidate for empirical window selection at N=20. Live decision uses 10-min OR (only valid choice — 15-min includes bar3's own spike in its threshold). |
| 33 | **Daily candidate scorecard** | ✅ Implemented July 2026. `log_daily_candidates` tool writes `candidates-YYYY-MM-DD.json` at end of each session with rank, screenerRank, gapPct, compositeScore, signal breakdown, and action for all evaluated candidates. Enables signal correlation analysis at N=60. |
| 34 | **`entryMechanism` + `isShadow` fields on all trades** | ✅ Done July 2026. Every posRecord now carries `entryMechanism: 'orb'` and `isShadow: false`. Pre-July-8 trades have neither field — the absence distinguishes the regime. Required so N=60+ analysis never silently mixes open-fill entries (pre-July-8) with ORB entries (post-July-8), which are structurally different systems. |
| 35 | **Shadow intraday tracking for ORB fades** | ✅ Done July 2026. When ORB check (6:45am) determines a candidate has faded, exit-daemon creates a `shadow` sub-record on the ORB log entry: paper entry at orbCheckPrice, ATR-based stop/target, `isShadow: true`. Fast loop polls shadow positions every 45s alongside live ones. Results: `stop-hit` / `target-hit` / `force-closed` with pnlR, all in the orb-log JSON. Answers "if ORB hadn't filtered it, what would have happened?" Triples effective sample rate for filter calibration at N=20. Shadow results never touch live P&L or expectancy calculations. |
| 36 | **Post-hoc pre-market RVOL as logged field on orb-log candidates** | Pre-market RVOL is permanently unavailable at 5:40am screener time (Yahoo returns zero pre-market volume; RH scanner probe closed Jul 12 — no pre-market data). However, `get_equity_historicals` with `bounds='extended'` may return pre-market 5-min bars when called at EOD time (1:30pm PT), after the session has closed. If it does: sum pre-market bar volumes (4am–9:30am ET), divide by 20-day avg volume (from FMP profile), write `premarketRvol` on each orb-log entry. This gives RVOL as a retroactive analysis field for C3: "did high-RVOL candidates outperform?" — without ever gating on it live. **Required first step:** Quick probe at EOD to verify `get_equity_historicals` extended bounds actually returns pre-market bars at EOD time (the original Jul 2 probe returned 0 bars; unclear if that was a timing or parameter issue). If bars are returned, implement in `runEOD()` in agent.js. If not, RVOL analysis at C3 is simply absent and the H1 RVOL note in PRE-REG.md stands. |
| 31 | **Signal ensemble — second uncorrelated edge** | Momentum (gap-up) and mean-reversion profit in opposite regimes. Once the momentum edge is validated, adding a mean-reversion signal (e.g. large gap-down on a stock with strong fundamentals) creates an edge that fires in different conditions. Requires the first edge proven first — stacking two unproven edges just creates noise. Trigger: 100+ trades, momentum edge validated via holdout. |

### P3 — Tech Debt / Refactor (after first profitable month)

| # | Item | Why |
|---|------|-----|
| 8 | **Split agent.js (1966 lines) into modules** | Current file handles: scan prompts, EOD prompts, tool definitions, tool execution, Yahoo/FMP fetching, Robinhood orders, logistic regression, email, circuit breaker, state machine. Each "item" was bolted on rather than placed in the right module. Split into `lib/broker.js`, `lib/market-data.js`, `lib/positions.js`, mode files. |
| 9 | **Deduplicate market calendar** | Still 3 copies of the holiday set across agent.js, exit-daemon.js, monitor.js. A shared `lib/calendar.js` eliminates the update problem. |
| 10 | **Add 2028 market holidays** | 2027 holidays added; 2028 NYSE calendar typically confirmed by Oct 2027. |

### P4 — Nice-to-Have (if/when scaling capital)

| # | Item | Why |
|---|------|-----|
| 11 | ~~**Slippage threshold (Item 36)**~~ | **Done.** Slippage gate implemented: exit immediately if fill slippage > 50% of stop distance. Remaining future work: auto-calibrate the 50% threshold from observed live fills. |
| 12 | **SMS/push as secondary alert channel** | Gmail is the single alerting channel. If credentials expire or Gmail throttles, alerts are silent. Twilio SMS or Apple push as fallback. |
| 13 | **Monthly/quarterly/annual P&L report** | weekly-report.js is built; monthly/quarterly/annual deferred until there's enough data (need 3+ months). |
| 14 | **Sierra-style observability patterns** | Structured event emission, tiered health check severity (critical vs warning vs info), human escalation protocol. Only relevant if scaling to larger capital or multiple strategies. |
| 18 | **Switch ML target from classification to R-multiple regression** | ChatGPT: the current binary win/loss label means a 70%-win-rate trade averaging +0.1R looks better than a 55%-win-rate trade averaging +1.2R. The thing worth predicting is expected R, not win probability. Partially mitigated by rMultiple sample weighting (implemented). Full fix: switch `trainModel()` to linear regression predicting expected R. Deferred until 200+ trades — need enough distribution across R outcomes to fit a regression meaningfully. |
| 20 | **Upgrade `trainModel()` to `ml-random-forest` (npm: `ml`)** | Current logistic regression can't capture interaction effects between signals (e.g. gap_up AND news_catalyst together outperforming either alone). `ml-random-forest` is pure Node.js (no Python, no subprocess), replaces the ~50-line gradient descent loop in `trainModel()`, and stays within the existing EOD training flow. Training is retroactive — all historical trades in `trades-log.json` are used, so no data is lost by waiting. Not worth doing until MIN_TRADES=100 is hit — logistic regression is adequate for cold start and the model doesn't influence decisions before then anyway. Trigger: 100 closed trades. |

---

## 26. Architecture Archive — What Was Removed and Why

Design decisions that were changed, and the reasoning behind each removal. Kept here so the same mistakes aren't made twice.

### Web search candidate discovery (removed June 2026)

**What it was:** Phase 2 of the scan prompt told the agent to run `web_search("pre-market gappers today YYYY-MM-DD volume")` and `web_search("top stock movers today YYYY-MM-DD pre-market")` to discover which stocks to research.

**Why it was removed:** Three compounding problems:
1. DuckDuckGo results are article-based and often hours stale by 6am PT. The "top gappers" article from 5am may already be outdated.
2. The agent had no fixed universe — it researched whatever the LLM decided looked interesting from search snippets. Different tickers every day, no consistency.
3. The real discovery question ("what is moving right now?") is a data question, not a search question. Yahoo 5-min intraday bars answer it deterministically.

**What replaced it:** `screener.js` — runs at 5:40am, screens a 580-ticker universe (S&P 500 + NASDAQ 100 + curated seeds) plus overnight earnings plus yesterday's watchlist using real 5-min bar data. Outputs a ranked JSON file the agent reads directly.

---

### Sam Weiss watchlist and trade alerts in scan prompt (removed June 2026)

**What it was:** The scan prompt injected Sam's current watchlist (what he's monitoring) and trade alerts (what he bought/sold that day) directly into the system prompt context before the agent began research.

**Why it was removed:** The agent could see Sam's watchlist from token 0, before running any independent research. This anchored candidate discovery — tickers Sam was watching naturally appeared on tomorrow's watchlist regardless of independent signal quality. The intent was always for Sam to be a Phase 4 validation layer; pre-loading his watchlist undermined that at a structural level.

**What replaced it:** Sam's data enters only via explicit tool calls in Phase 4 (`search_sam_weiss_briefings`, `get_sam_market_outlook`) after the agent has independently scored each screener candidate.

---

### Sam macro stance as session veto (fixed June 2026)

**What it was:** The prompt said "Sam validation" but didn't prevent the agent from using Sam's macro positioning (e.g., "Sam is buying QQQ puts") as a reason to stand down for the entire session — even when individual setups had valid scores.

**Why it was wrong:** Sam runs long-dated options positions (months to years). His portfolio hedges reflect multi-month macro views, not intraday momentum. An agent standing down because "Sam is hedging" is conflating time horizons. A stock gapping 3% on a product launch is a valid day trade regardless of Sam's QQQ puts.

**What was added:** Explicit hard rules in the prompt: Sam's macro stance cannot block a trade, cannot veto a session, and cannot change `setup_score`. His view on a specific ticker is context only.

---

### Short selling (removed June 2026)

**What it was:** The scan prompt allowed the agent to identify short setups (e.g., "XLE short — gap down >2%") and add them to the watchlist.

**Why it was removed:** Robinhood retail accounts don't support shorting stock. The agent was producing short setups that could never execute, wasting research iterations on them. The system is long-only.

**What replaced it:** "LONG ONLY — no short positions under any circumstances" added to the hard rules section of the scan prompt.

---

### Stop/target anchored to pre-market price instead of fill (fixed June 2026)

**What it was:** `place_trade()` accepted `stopPrice` and `targetPrice` from the agent, which the LLM calculated during Phase 3 research based on the pre-market price it saw. In DRY_RUN mode, these values were used directly. In live mode, a re-anchoring step existed but used `|rawStop - decisionPrice| / decisionPrice` as the stop distance — wrong when the research price had moved by the time of execution.

**Why it was wrong:** If the pre-market price moved between the agent's research phase and order execution (common on volatile days), the stop could end up on the wrong side of the fill. ARM trade (Jun 24): pre-market ~$379, stop calculated at $369.53, actual fill at $366.39 — stop was above entry, triggered immediately on first daemon poll. P&L showed $0 because DRY_RUN fill = decision price, masking the problem.

**What was fixed:** DRY_RUN branch now re-anchors stop/target from the fill price using `atr14` as a percentage of `decisionPrice`. Live branch now uses `atr14 / decisionPrice` as the stop distance instead of the raw distance between pre-market stop and execution price. Both branches produce stop/target correctly anchored to where the fill actually landed.

---

### FMP quote used as decision price (fixed June 2026)

**What it was:** `place_trade()` called `getQuote(ticker)` (FMP `quote` endpoint) to get the current price for share count and stop/target calculation.

**Why it was wrong:** FMP's `quote` endpoint at 6am PT returns the previous day's close price for large overnight gaps — it doesn't reflect pre-market activity. MU trade (Jun 25): FMP returned $1,048 (previous close) instead of the actual pre-market price of ~$1,242. In DRY_RUN this produced an unrealistic entry price, incorrect share count, and P&L that didn't reflect reality. In live trading, stop/target would be anchored to the wrong price before the fill re-anchor corrected them.

**What replaced it:** `screener.js` already fetches true pre-market 5-minute bar prices from Yahoo at 5:40am and stores `preMarketPrice` per candidate. `place_trade()` now reads the screener file first and uses `preMarketPrice` as the decision price. FMP `quote` is only called as a fallback when the ticker isn't in the screener output.

---

### ORDER_PENDING stuck state — exit-daemon never confirmed fills (fixed July 2026)

**What it was:** In DRY_RUN mode, agent.js immediately synthetic-fills the position (sets `state: FILLED → PROTECTED`) before writing to `trades-open.json`. In live mode, the order is placed at ~6:01am PT but fills at market open (6:30am PT). The agent writes `state: ORDER_PENDING` to `trades-open.json` and then polls Robinhood for up to 3 attempts in the seconds immediately after order submission — before the market is open. Those 3 polls always returned no position (order not yet filled), and the agent gave up and left the state as `ORDER_PENDING`. exit-daemon had no logic to retry fill confirmation post-open; it simply logged "Waiting for PROTECTED state" and skipped stop/target management entirely.

**Why it was wrong:** The first live trade (META, July 1 2026) filled at $607.76 at market open. exit-daemon logged "Waiting for PROTECTED state (current: ORDER_PENDING)" every 45 seconds for hours with no stop/target protection active. If META had dropped 10% intraday, the daemon would have force-closed at 12:45pm with no stop ever triggered.

**What was fixed:** exit-daemon now checks `ORDER_PENDING` positions in each poll cycle after `PT.MARKET_OPEN` (6:30am PT). `confirmFill()` calls `get_equity_positions` (not `get_portfolio` which returns account summary, not positions), finds the broker position by symbol, reads `average_buy_price`, re-anchors stop/target using `atr14/decisionPrice` as stop distance, and transitions the position from `ORDER_PENDING → FILLED → PROTECTED` in one step. A 20-second `AbortController` timeout was added to all Robinhood MCP `fetch` calls to prevent silent hangs. The fix also corrects the MCP tool: `get_portfolio` returns `{data: {equity_value, cash, ...}}` — individual positions require `get_equity_positions` which returns `{data: {positions: [{symbol, average_buy_price, quantity}]}}`.

---

### Immediate market-open entry → ORB entry at 6:45am (changed July 2026)

**What it was:** `place_trade()` submitted a market order at ~6:01am PT (pre-market). Market orders placed pre-open queue and execute at 6:30am open. The agent completed all research and placed all orders before the market opened.

**Why it was wrong:** Pre-market gaps on thin volume frequently fade at the open as institutions sell into retail buying. On analyst-upgrade days especially, stocks gap 2-4% pre-market on light order flow, then reverse -2% to -4% in the first 15 minutes of trading as the news cycle has been fully digested by institutions overnight. Observed July 6 2026: KLAC, LRCX, SNDK, AMAT all gapped pre-market then closed red. KLAC filled at $245.37 vs $250.52 decision price (-2.06%) — slippage exceeded the stop distance before exit-daemon could act.

**The mechanism:** If a gap is genuine (institutions adding, not just retail momentum), price holds above the first 15 minutes' high (opening range high) at 6:45am PT. If the gap is being faded (institutions selling into retail), price is already at or below the opening range high. This is a reliable institutional-grade filter used by professional traders.

**What replaced it:** ORB (Opening Range Breakout) entry architecture:
1. Agent queues all candidates scoring ≥0.45 to `queued-trades.json` at 6am — no orders, no MAX_POSITIONS cap at queue time
2. Exit-daemon logs 5-min price (6:35am) and 10-min price (6:40am) for each queued candidate
3. At 6:45am: fetch 10-min OR high (max of bars 1+2 only). If current price > OR high → gap held → buy. If ≤ → gap faded → skip. Exit-daemon enforces MAX_POSITIONS at this entry step, not at queue time.
4. All decisions written to `orb-log-YYYY-MM-DD.json` with: `catalystType`, `catalystTag`, `prevClose`, `originalGapPct`, `effectiveGapPct`, `gapRetained`, `orbVariants` (5-min/10-min/15-min OR highs + bar closes)
5. At 12:45pm: every entry gets `recoveredByClose = price > orHigh`

**Catalyst tagging:** `catalystType` (agent's 13-value enum) → `catalystTag` (`stale-news` or `structural`). `analyst_upgrade | insider_purchase | sector_sympathy | technical` → stale-news. All others → structural. Hypothesis to be validated at N=20 by `recoveredByClose`.

**Gap retention metric (July 8 2026):** `gapRetained = effectiveGapPct / originalGapPct` — measures whether institutional flow expanded or contracted the gap after open. July 8 data: MTZ ratio 1.80 (gap expanded, M&A buyers adding), AVAV ratio 0.46 (gap halved, distribution). Strongest separating signal found so far. Logged but **not wired to any live decision** — deferred to N=20.

**Decision price root cause (July 8 2026):** The decision price is set at 5:40am on thin pre-market volume, 50 minutes before real institutional flow. All ORB filtering is downstream compensation for this stale anchor. The deeper question — whether the thesis should re-anchor to the opening auction price once real volume exists — is an open design investigation, not yet resolved.

**ORB confirmation-bar bug (July 8 2026):** Original `getOpeningRange()` used all 3 bars (6:30, 6:35, 6:40), making `orHigh = max(bar1, bar2, bar3)`. At 6:45am we compare bar3's close against a threshold bar3's own spike set — structurally unpassable. Fixed: `orHigh` now uses bars 1+2 only. Bar3 is the confirmation bar and cannot be part of the range it's tested against. This is a correctness fix, not a window-tuning decision.

**Implementation bug v1 (July 2026):** `checkMaxConcurrent()` only read `trades-open.json`. Gate was effectively 0 at 6am with ORB — fixed to also count `queued-trades.json`.

**Implementation bug v2 (July 8 2026):** Counting queued trades toward MAX_POSITIONS blocked backup candidates when all queued trades faded. Observed: AVAV/MTZ/LYB/DOW all queued → all faded → BABA (0.47, +8.3%) blocked at queue time → 0 trades. Fixed: agent queues all ≥0.45 scorers, exit-daemon enforces MAX_POSITIONS at actual entry.

**RH pre-market scanner probe (Jul 8–12 2026, CLOSED):** 5 consecutive mornings at 5:40am PT. `FILTER_TYPE_GAP` fails with DXFeed API 400 every day. `DAILY_GAINERS` + RVOL > 1.5x returns 0–5 tickers total, none in the 580-ticker universe. RH scanner has no pre-market data at 5:40am. Verdict: scanner cannot replace Yahoo pre-market gap detection. Probe plist (`com.investing-tool.rh-probe.plist`) unloaded Jul 12 2026. Yahoo 580-ticker loop stays as the screener indefinitely.

**Key learning:** Bugs in gating logic are easy to miss when the code path that validates the gate (checking open positions) is correct — but the underlying assumption (positions exist at gate-check time) changed with the new architecture. Whenever execution timing changes, re-examine every gate that reads state files.

---

*Last updated: July 8 2026*
*Built by Alvint Sheth using Claude Code*
