# Personal Investing Agent — Full Technical Documentation

**Owner:** [OWNER]
**Built:** June 2026
**Status:** Fully operational — Robinhood auth ✅ | Gmail email ✅ | Daily cron ✅ | Self-learning ✅ | Day-trade mode ✅ | DRY_RUN=true (paper trading until cycle verified)

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

- **Scrapes** a paid financial advisory service daily at 5:30am for trade alerts, watchlist, and briefings. Rebuilds the full knowledge base every Sunday
- **Scans** pre-market gappers at 6:00am (30 min before open), scoring candidates using a logistic regression model trained on historical signal outcomes
- **Executes** fractional-share, dollar-denominated market orders on Robinhood's Agentic Trading sub-account — pilot mode: 1 position max, 10% sizing; full mode: 2 positions, 17.5%
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
                 • Scrapes last 10 briefings from advisory service
                 • Updates output/knowledge-base/briefings/
                 • Logs to output/logs/kb-weekly.log

DAILY  5:30 AM — scraper.js
                 • Authenticates to advisory service with Playwright
                 • Scrapes today's daily briefing, trade alerts, watchlist
                 • Saves output/advisor-YYYY-MM-DD.json
                 • Logs to output/logs/scrape.log

DAILY  5:55 AM — screener.js (pure code, no Claude — deterministic pre-filter)
                 • Builds universe: 83 curated large/liquid tickers + after-market-close earnings (yesterday) + yesterday watchlist
                 • Fetches Yahoo Finance 5-min intraday bars (includePrePost=true) for every ticker
                 • Computes real gap% (pre-market price vs prior close) from 5-min bar closes
                 • RVOL = null (Yahoo returns volume=0 for all pre-market bars — not computable here)
                 • Sorts by gap magnitude (|gap%|), saves top 10 to output/screener-YYYY-MM-DD.json
                 • Runs in ~30s, finishes before agent starts
                 • Logs to output/logs/screener.log

DAILY  6:00 AM — agent.js scan (30 min before open, Claude Sonnet, 20 iterations)
                 • Live market-day check via Yahoo Finance (fail closed if unavailable)
                 • Pre-flight: verify balance, reconcile vs Robinhood, save SOD balance
                 • Phase 1: VIX, Fear & Greed, sector pre-market moves (sets risk appetite)
                 • Phase 2: Earnings calendar — build hard exclude list for today
                 • Phase 3: Research screener candidates in ranked order — news catalyst,
                 •           Reddit chatter, notable mentions, insider activity, ATR stop/target
                 • Phase 4: Advisor validation per ticker (briefing search + outlook on demand)
                 • Phase 5: Execute if setup_score ≥ 0.45, log to trades-open.json
                 •           Shadow-log candidates scoring 0.35–0.45 via log_rejected_candidate
                 • Entry window: 6:00–10:00am PT only. LONG ONLY — no short positions.
                 • Scan report header shows screener input (e.g. "NVDA +3.2%, GE +2.1%")
                 • Logs to output/logs/analyze.log

DAILY  6:25 AM — exit-daemon.js (long-running daemon, runs until 1pm PT)
                 • Polls open positions every 45 seconds — pure code fast loop
                 • Stop/target hit → market sell immediately
                 • Updates opening-range stop after 6:45am PT (all 3 five-min bars complete)
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
                 • Email report to [OWNER_EMAIL]
                 • Logs to output/logs/eod.log

DAILY  2:15 PM — monitor.js (health check — no Claude, no cost)
                 • Verifies screener, scrape, recommendations, EOD report, daemon log all exist
                 • Checks trades-open.json is empty (positions cleared)
                 • Alerts [OWNER_EMAIL] if anything is wrong
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
   │  • Advisor validation (last)              │
   └──┬────────────────────────────┬───────────┘
      │                            │
  ┌───▼──────┐            ┌────────▼──────────┐
  │  Market  │            │  Robinhood MCP    │
  │  Data    │            │  HTTP transport   │
  │  Sources │            │  agent.robinhood  │
  │  (below) │            │  .com/mcp/trading │
  └──────────┘            │  Agentic account  │
                          │  [ACCOUNT_NUMBER] │
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
- Credentials: `ADVISOR_USERNAME` + `ADVISOR_PASSWORD` in `.env`

### Daily Scraper (`scraper.js`) — 5:30am
Scrapes 4 pages each morning, saves timestamped JSON:
1. Latest daily briefing (homepage)
2. Current trade alerts (`/trades/`)
3. Watchlist — stocks the advisor is monitoring (`/trade-watch/`)
4. All 9 portfolio pages (named after Game of Thrones houses)

Output: `output/advisor-YYYY-MM-DD.json`

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
| `strategy.md` | 42KB | Advisor's 4-Part Investment Framework: buy corrections, hedge rallies, sell covered calls, hold long-term. All 6 strategy tabs. |
| `investing-basics.md` | 299KB | All 6 chapters with all slides: The Basics, Inherent Leverage, Risk Management, Brokerage, Practical Application, Advanced |
| `market-outlook.md` | 44KB | Near-term, intermediate-term, long-term forecasts. All collapsible sections expanded. |
| `market-understanding.md` | 14KB | "Understanding the Market" slide deck |
| `nasdaq-historical.md` | 28KB | Correction/rally data tables 2007–2025: %, duration, context |
| `trade-history.md` | 77KB | Complete history of all trades the advisor has ever made |
| `trade-watchlist.md` | 2KB | Current watchlist |
| `portfolio-overview.md` | 24KB | Aggregate portfolio performance |
| `portfolios/` | 9 files | 9 portfolio pages |
| `articles/` | 12 files | Long-form strategy articles, stress tests, monthly outlooks |

### Dynamic Content (updated daily/weekly)

| File | Source | Contents |
|------|--------|----------|
| `briefings/YYYY-MM-DD-*.md` | Weekly cron (Sundays 5am) | 535+ daily briefings with comments, 18+ months |
| `output/advisor-YYYY-MM-DD.json` | Daily cron (6am) | Today's briefing, trade alerts, watchlist, portfolio snapshot |

---

## 6. The Investing Agent (agent.js)

**File:** `agent.js`
**Model:** `claude-sonnet-4-6` (analyze) / `claude-haiku-4-5-20251001` (EOD)
**Max iterations:** 20 (analyze) / 10 (EOD) tool-use loops per session
**Max tokens per response:** 8,192

**Edge hypothesis:** Liquid stocks that gap ≥2% pre-market on a clear overnight catalyst (news, earnings surprise, notable mention) and whose gap is confirmed by RVOL >2× (checked pre-open via `get_premarket_data` in Phase 3, before market open) tend to trend directionally through the first 90 minutes of the session — the edge is in identifying which catalyst types produce sustained intraday moves vs. gaps that fade within the opening 30 minutes.

Note on RVOL timing: RVOL is `null` at screener time (5:55am) because Yahoo Finance returns zero volume for pre-market bars. It becomes available when the agent calls `get_premarket_data` during Phase 3 (~6:00am), sourced from FMP `preMarketVolume` vs `averageVolume`. Entry decisions are made with RVOL confirmed — not before it's available.

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

Only factual, non-narrative data is pre-loaded. All advisor content is deliberately excluded from the initial context — the agent cannot have absorbed any of the advisor's current views before starting its own research.

| Content | Chars | Source |
|---------|-------|--------|
| Learning memory (signal win rates) | dynamic | signal-weights.json |
| Yesterday's watchlist + entry triggers | dynamic | watchlist-tomorrow.json |
| Screener candidates (top 10 by gap%) | dynamic | screener-YYYY-MM-DD.json |
| NASDAQ correction/rally patterns | 3,000 | nasdaq-historical.md (historical data) |

**What is NOT pre-loaded (to prevent anchoring):**
- Advisor's daily briefing narrative → available via `get_advisor_market_outlook` tool on demand
- Recent briefings → available via `search_advisor_briefings` tool on demand
- Market outlook → available via `get_advisor_market_outlook` tool on demand
- Portfolio positions → available via `get_advisor_market_outlook` tool on demand
- Strategy/investing-basics → available via `get_advisor_market_outlook` tool on demand
- Today's trade alerts (what advisor bought/sold) → not pre-loaded; agent discovers candidates independently first
- Today's watchlist (what advisor is monitoring) → not pre-loaded; prevents advisor's picks from anchoring tomorrow's watchlist

Advisor's data enters only via explicit tool calls in Phase 4, after the agent has independently scored each candidate. This ensures tomorrow's watchlist is driven by gap%/sector signals — not by what the advisor is watching.

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
2. Discover candidate stocks from web search and signals BEFORE reading advisor's view
3. Score candidates using 10 independent signals (advisor NOT included)
4. THEN consult advisor: stance adjusts position size (full/standard/small) but not score
5. Execute if setup_score ≥0.45 — advisor's stance provides context; model-driven sizing only after 200 live trades

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

### STEP 0.5 — Pre-Market Screener (5:55am, pure code — runs before agent)

```
screener.js (launchd job):
  Builds universe:
    • 83 core tickers (hand-curated: major-exchange listed, ~$10B+ market cap,
      $50M+ avg daily dollar volume, β ≥ ~1.5 preferred, no OTC, no recent IPOs.
      Buckets: mega-cap tech/AI, semis, financials, industrials, energy,
      healthcare/biotech, consumer, materials, China ADRs, Bitcoin miners, high-beta/momentum.
      Last rebalanced June 2026: cut 14 low-beta/thin names (PANW, RGTI, V, HON,
      RTX, UNH, ABBV, MCD, WMT, BIDU, JD, ACHR, ACMR, SPCX); added 15 high-beta
      catalysts (MARA, RIOT, AFRM, UPST, SOFI, RDDT, RIVN, SNAP, CELH, HIMS,
      PINS, LYFT, APP, SPOT, DUOL).)
    • + after-market-close earnings from yesterday (FMP) — reported after yesterday's close,
        pre-market gap reflects overnight reaction. Phase 2 hard-excludes these
        from same-day trading; they surface for next-day watching only.
        BMO reporters are excluded — Phase 2 blocks them same-day anyway.
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

### STEP 5 — Phase 4: Advisor Validation (only for candidates that passed Step 4)

```
For each candidate that cleared gap + RVOL filters:
  search_advisor_briefings(ticker) → advisor's historical stance on this ticker
  get_advisor_market_outlook()     → macro framework (called at most once per session)

Advisor's view provides context only — it does NOT change setup_score.
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

Gate 7: Already at max concurrent positions (1 pilot / 2 steady-state)?
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
                  ├── Fill received → compute slippage = (fill - decision) / decision
                  │   ├── slippage > 50% of stop distance → SLIPPAGE GATE:
                  │   │     immediately exit position, record as closed, return blocked
                  │   │     (thesis already compromised before first bar)
                  │   ├── slippage > 2% → log warning
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
Email report to [OWNER_EMAIL]
```

---

### STEP 12 — Health Monitor (2:15pm PT)

```
For each check:
  advisor-{today}.json exists?           → ✅ / ❌ scraper failure
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

**`rvol_spike`** — Relative Volume (HARD GATE)
Pre-market volume >2× the 30-day daily average × 0.08 (pre-market is ~8% of daily session).
High RVOL = institutional activity, not retail noise.
**This signal must be `true` to trade — not just a scoring signal. If `false`, the trade is blocked in code regardless of setup_score.**

**`gap_likely_holds`** — Gap sustainability
Fires `true` when gap >5%: historically the gap holds intraday (momentum continues).
Gap 2-5%: medium probability — signal fires `false`.
Gap <2%: high fill probability — signal fires `false`, avoid.
Derived from NASDAQ historical patterns in `output/knowledge-base/nasdaq-historical.md`.

### Context Signals

**`macro_tailwind`** — VIX/F&G sets risk appetite. Low VIX (<18), rising F&G = favorable. High VIX = tighten stops.

**`sector_leading`** — Sector ETF up pre-market. Stock in leading sector = momentum support.

**`news_catalyst`** — Overnight/pre-market catalyst only (earnings, contract, regulatory, product). Pre-market window is the signal; intraday news is too late.

**`notable_mention`** — Executive order, CEO shoutout, Congressional disclosure, major investor move. Checked via DuckDuckGo (5 queries per ticker).

**`insider_buying`** — Recent Form 4 C-suite buy from SEC EDGAR direct API (`data.sec.gov`). Supportive context only — filing lag means this is not a same-day signal.

**`contrarian_social`** — Overnight Reddit/StockTwits post count >15 with bearish sentiment on fundamentally strong setup. Reddit searched with `t=day` filter to capture overnight chatter.

**`analyst_conviction`** — 2+ recent analyst upgrades or significant price target raise in the last 30 days.

### Advisor (validation lens, not a signal)
`search_advisor_briefings(ticker)` and `get_advisor_market_outlook` are available after independent research. Advisor's stance does NOT change setup_score — it informs position context.

---

## 8. Scoring System — Logistic Regression

### Model
setup_score = sigmoid(Σ coef_i × signal_i + intercept)

Trained daily at EOD using L2-regularized logistic regression in pure JavaScript (gradient descent, 500 epochs, lr=0.05, λ=0.01). No external ML libraries. `setup_score` is a model output used as an entry threshold — it is NOT a calibrated win probability.

**Thresholds:**
| setup_score | Action |
|-------------|--------|
| ≥ 0.45 | Enter trade (pilot: 1 position / 10% sizing) |
| 0.35–0.45 | Shadow-log only via `log_rejected_candidate` |
| < 0.35 | Avoid |

Model-driven variable sizing (based on score confidence) is reserved until 200 live trades are logged (`isLive: true` field). Before that, all qualifying trades use flat pilot sizing.

**Hard excludes (regardless of score):**
- Earnings today before close
- `premarket_gap_up = false` (code gate — no exceptions)
- `rvol_spike = false` (code gate — no exceptions)
- Past 10am PT entry window
- Already at max concurrent positions (pilot: 1, full: 2)
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
- **Advisor alignment** — explicit stance and framework guidance
- **Technical snapshot** — RSI, 52W position, MA50/200, volume
- **All 10 signal verdicts** — ✅ or ❌ for each signal
- **Stop/target levels** — ATR-14 at entry; opening-range stop updated after 6:45am PT if OR low is tighter (never loosens); immediate exit if price already below new OR stop when check fires
- **Fill price confirmation** — live mode polls broker post-order for actual fill; slippage always logged, warning at >2%
- **Slippage gate (implemented)** — if fill slippage exceeds 50% of the stop distance, the position is immediately exited and recorded as closed. Rationale: a fill that eats more than half the stop means the thesis is already compromised before the first bar prints.
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
PILOT_MODE=true  → 1 position max, 10% of buying_power per trade
PILOT_MODE=false → 2 positions max, 17.5% of buying_power per trade
```
Sized from **settled buying power** (not total equity) to avoid good-faith-violation risk from unsettled T+1 proceeds. Pre-flight logs a warning if buying_power < 90% of equity. Dollar-denominated → fractional quantity = dollarAmount / price.

### Max Concurrent Positions
`checkMaxConcurrent(openPositions)` — blocks new entries if at/above limit (1 in pilot, 2 in full).

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
Called at scan start and again before every trade execution.

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
  "catalystType": "earnings_beat",
  "regime": {
    "vixLevel": 16.4,
    "vixBucket": "elevated",
    "fearGreedScore": 58,
    "fearGreedBucket": "greed",
    "spyVs50dma": "above",
    "qqqVs50dma": "above"
  },
  "exitReason": "target hit",
  "signals": { "premarket_gap_up": true, "rvol_spike": true, ... },
  "setupScore": 0.68,
  "isLive": false,
  "maxFavorableExcursion": 1.8,
  "maxAdverseExcursion": -0.4,
  "timeInTradeMinutes": 43
}
```
`timeInTradeMinutes` — minutes from entry fill to exit. Tests whether the edge hypothesis holds in the first 90 minutes: do winners resolve quickly, do slow trades fail more often, is there a "stale thesis" threshold?

`rMultiple` = pnlPct / stopDistPct — measures outcome in units of risk taken. A +1R trade recovered the full stop distance in profit; -1R is a full stop-out. Training samples are weighted by |rMultiple| so high-R trades drive model updates more than marginal wins/losses.

`catalystType` — one of 13 enum values: `earnings_beat | earnings_miss | guidance_raise | analyst_upgrade | fda_news | ma | insider_purchase | macro | sector_sympathy | notable_mention | product_launch | regulatory | technical`. Required on every trade. Enables catalyst-type P&L breakdown once enough trades accumulate.

`regime` — market regime snapshot at entry time. Populated from Phase 1 `get_fear_greed_vix` output. Used to slice edge by regime after 100+ trades (e.g., "do gap plays work in extreme fear vs greed environments?"). Fields: vixLevel, vixBucket, fearGreedScore, fearGreedBucket, spyVs50dma, qqqVs50dma.

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
`rhGetAccountNumber()` calls `get_accounts` and prefers `agentic_allowed: true` accounts (agentic sub-account) over the default account.

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
**Email:** `[OWNER_EMAIL]` via nodemailer + Gmail App Password

### Report Contents
1. **P&L Summary** — per trade: entry vs exit price, P&L $ and %, vs SPY/QQQ/IWM same-day benchmarks
2. **Key Learnings** — which signals fired/missed, what to do differently tomorrow

Benchmark returns (SPY, QQQ, IWM daily % change) are fetched from Yahoo Finance at runtime and appear in both the email subject line and the report body so you can immediately see whether you beat the market that day.

### Expectancy Metrics (`expectancy-log.json`)
Each EOD run appends: win rate, avg win $, avg loss $, expectancy ($/trade), profit factor. Tracked over time to detect model drift.

### Gmail Configuration
```
GMAIL_USER=[OWNER_EMAIL]
GMAIL_APP_PASSWORD=[16-char Google App Password]  (not your account password)
```
Uses `nodemailer` with Gmail SMTP (`smtp.gmail.com:587`). App password generated at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

## 16b. Weekly P&L Report (`weekly-report.js`)

**Schedule:** Sundays 5:30pm PT via launchd
**File:** `weekly-report.js`
**Cost:** $0 — pure code, no Claude API calls
**Output:** Email to `[OWNER_EMAIL]`; logs to `output/logs/weekly-report.log`

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

All 8 jobs are loaded and running:

```bash
launchctl list | grep investing-tool
# com.investing-tool.scrape         → 5:30 AM daily
# com.investing-tool.analyze        → 6:00 AM daily (scan mode)
# com.investing-tool.exit-daemon    → 6:25 AM daily (continuous monitor, exits ~1pm)
# com.investing-tool.force-close    → 12:45 PM daily (failsafe — daemon handles primary exits)
# com.investing-tool.eod            → 1:30 PM daily
# com.investing-tool.monitor        → 2:15 PM daily (health check)
# com.investing-tool.kb-weekly      → 5:00 AM every Sunday
# com.investing-tool.weekly-report  → 5:30 PM every Sunday
```

All jobs except `weekly-report` perform a market-day check at startup (weekends exit immediately; holidays checked against hardcoded 2026 calendar + live Yahoo Finance QQQ status).

### Plist Files
Located at `~/Library/LaunchAgents/`:
- `com.investing-tool.scrape.plist`
- `com.investing-tool.analyze.plist` (runs `agent.js scan`)
- `com.investing-tool.exit-daemon.plist` (runs `exit-daemon.js`, long-running 6:25am–1pm)
- `com.investing-tool.force-close.plist` (runs `agent.js force-close` — failsafe)
- `com.investing-tool.eod.plist`
- `com.investing-tool.monitor.plist`
- `com.investing-tool.kb-weekly.plist`
- `com.investing-tool.weekly-report.plist` (runs `weekly-report.js` — Sunday 5:30pm PT)

### Log Files
`output/logs/`:
- `scrape.log` — 5:30am scraper output
- `analyze.log` — 6:00am scan output
- `exit-daemon.log` — 6:25am daemon output (continuous, appended through 1pm)
- `force-close.log` — 12:45pm force-close failsafe output
- `eod.log` — 1:30pm EOD report output
- `monitor.log` — 2:15pm health check output
- `kb-weekly.log` — Sunday KB update output
- `weekly-report.log` — Sunday 5:30pm weekly P&L summary output

### To manually trigger any job
```bash
launchctl start com.investing-tool.scrape
launchctl start com.investing-tool.analyze
launchctl start com.investing-tool.exit-daemon
launchctl start com.investing-tool.force-close
launchctl start com.investing-tool.eod
launchctl start com.investing-tool.monitor
launchctl start com.investing-tool.kb-weekly
```

### Node.js Path
The nvm-managed Node is hardcoded in all plists:
```
/Users/[user]/.nvm/versions/node/v22.22.3/bin/node
```

---

## 18. Health Monitor

**Script:** `monitor.js`
**Schedule:** 2:15pm PT daily (after EOD completes)
**Cost:** $0 — pure code, no Claude API calls

Runs 7 checks every trading day and sends a failure email if anything is wrong:

| Check | Pass condition | Failure means |
|-------|---------------|---------------|
| Screener | `screener-{today}.json` exists | screener crashed — agent had no candidates |
| Scrape | `advisor-{today}.json` exists | scraper crashed or never ran |
| Scan | `recommendations-{today}.md` exists | scan agent crashed |
| EOD | `eod-report-{today}.md` exists | EOD agent crashed |
| Positions cleared | `trades-open.json` has 0 entries | force-close failed to close something — **check Robinhood immediately** |
| Exit-daemon log | `exit-daemon.log` touched after 6:25am | daemon never started — positions had no monitor |
| Force-close log | `force-close.log` touched after 12:45pm | failsafe job never fired |

On failure: email subject is `🚨 Investing Agent — N failure(s) on YYYY-MM-DD` with details on which checks failed and what to look at.

On success: no email sent (silence = green).

```bash
# Manually trigger
node monitor.js
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
├── ABOUT.md                          # Full documentation (contains owner details — do not share)
├── ABOUT-sanitized.md                # Sanitized version for sharing / LLM feedback
│
├── node_modules/                     # Dependencies
│
├── output/
│   ├── advisor-YYYY-MM-DD.json      # Daily scrape (6am)
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
│       ├── strategy.md              # 42KB — advisor's 4-part framework
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
│       │
│       ├── articles/                # 12 long-form articles
│       │
│       └── stocks/                  # Individual stock pages (limited)
│
└── screenshots/                     # Debug screenshots (gitignored)
```

---

## 20. Environment Variables

**File:** `.env` (gitignored — NEVER commit this file)

```bash
# Financial advisory service credentials
ADVISOR_USERNAME=[email]
ADVISOR_PASSWORD=[password]

# Financial Modeling Prep — free stable tier
FMP_API_KEY=[key]

# Anthropic Claude API
ANTHROPIC_API_KEY=[key]  # Rotate at console.anthropic.com if exposed

# Gmail (nodemailer App Password)
GMAIL_USER=[owner email]
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
npm run scrape        # 5:30am — scrape today's advisor data
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
| Scheduling | macOS launchd (8 jobs: scrape, scan, exit-daemon, force-close, eod, monitor, kb-weekly, weekly-report) |
| Trade execution | Robinhood Agentic Trading MCP (HTTP transport) |

### Model Selection by Task
- **Analyze run (6:00am):** `claude-sonnet-4-6` — structured tool-use + multi-signal scoring. Sonnet is excellent for this: the task is well-defined (call tools in phases, apply scoring rubric, write report). Opus' extra reasoning depth adds cost without meaningfully better decisions.
- **EOD run (1:30pm):** `claude-haiku-4-5-20251001` — purely formulaic: fetch prices, compute P&L, write watchlist. Haiku handles this well and is 18× cheaper than Opus.

### Why Node.js ESM?
Started with Playwright (Node ecosystem) + Anthropic SDK. Node's native `fetch` handles all HTTP. ESM is the modern standard.

### Why Playwright over Cheerio/Puppeteer?
The advisory site is WordPress with JavaScript-rendered dropdowns, tabs, and slides. Static parsers can't handle this. Playwright's `networkidle` + `page.evaluate()` handles all interactive elements.

---

## 23. APIs & Services Used

| Service | Cost | Auth | Purpose |
|---------|------|------|---------|
| Financial advisory service | Paid subscription | Username/password (Playwright) | Primary investing intelligence, 535+ briefings |
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
- Initial prompt: ~5,000 chars (NASDAQ patterns + learning memory only — no advisor content pre-loaded)
- No briefings, no outlook, no portfolio positions, no trade alerts, no watchlist pre-loaded — all tool-gated
- Advisor's content only enters context when the agent explicitly calls `get_advisor_market_outlook` or `search_advisor_briefings` in Phase 4

**Cost estimate per session (current):**
- Analyze run (Sonnet, 20 iter max): ~30k tokens → ~$0.45
- EOD run (Haiku, 10 iter max): ~15k tokens → ~$0.06
- **~$0.51/day total** for both runs
- **~$15/month**

**Why this is also architecturally better:** Briefings in the initial context = the agent has absorbed the advisor's current narrative before its first thought. That's not independent research — it's anchored research. Tool-gating the advisor's content enforces the "market first, advisor second" discipline at a structural level, not just as a prompt instruction.

---

## 25. Improvement Backlog (stacked by priority)

Items are stacked: P1 = do now, P2 = after first 20 live trades, P3 = after first profitable month, P4 = if/when scaling.

### P1 — Reliability / Safety (do in next 2 weeks)

| # | Item | Why |
|---|------|-----|
| 1 | **Broker state reconciliation at startup** | If agent.js crashes between ORDER_SUBMITTED and FILLED, `trades-open.json` can show a phantom position. On next run, compare local state to Robinhood portfolio and alert/resolve divergence. |
| 2 | **Remove dead `runCheck()` function** | 100 lines of dead code in agent.js — no plist calls it, exit-daemon replaced it. Confuses future debugging. Low risk to remove. |
| 3 | **Fix `runCheck()` UTC/PT timezone bug (before re-enabling)** | If check mode is ever re-enabled, the PT time computation uses a hardcoded offset that's wrong in winter (PST vs PDT). Use `Intl.DateTimeFormat` like the rest of the codebase. |

### P2 — Operations (after 20 live trades)

| # | Item | Why |
|---|------|-----|
| 4 | **Live market calendar from Polygon API** | Hardcoded holidays through 2027 require manual update. Polygon free tier has a market status/upcoming holidays endpoint. Fetch weekly, cache to `output/market-calendar.json`, fall back to hardcoded list if fetch fails. |
| 5 | **Scan no-output alert** | If scan runs but Claude produces no trade and no recommendations file (tool_use loop exhausted), monitor doesn't distinguish "correct no-trade day" from "agent confused and produced nothing." |
| 6 | **Deduplicate `TRADE_STATES`** | Defined in agent.js AND exit-daemon.js. Adding a state requires two edits. Extract to a shared constant or write exit-daemon to import from agent.js. |
| 7 | **Deduplicate `transitionState` / `addStateHistory`** | Same function, different name, one in each file. Same problem as above. |
| 19 | **Expected-value gate in place_trade** | Replace raw `setup_score ≥ 0.45` threshold with `EV = P(win) × avg_win_R + P(loss) × avg_loss_R > 0.1R`. P(win) stays as logistic regression sigmoid output. avg_win_R and avg_loss_R come from running trade history. Falls back to score ≥ 0.45 until ≥ 15 wins and ≥ 10 losses exist. Deferred because: (1) zero trades — gate won't activate for weeks, (2) actual avg_win_R unknown until data exists — threshold should be calibrated from real numbers not assumed, (3) stop adding features. Implement after 30-40 paper trades when R distribution is visible. |
| 15 | **Evaluate 6:31am analyze job timing** | Gemini: pre-bell market orders queue for open execution, hitting the widest spreads of the day. Strong-catalyst setups establish direction in the first 60 seconds — too early to delay pre-data. Revisit after 50 paper trades: if gap-and-crap (open at high, immediate reversal) appears repeatedly in `timeInTradeMinutes` data, delay the analyze job to 6:31am PT. |
| 16 | **Signal ablation study at trade #100** | ChatGPT: after 100 trades, 2-3 signals will matter, 5-6 will do nothing, 1-2 may be harmful. Goal is elimination, not accumulation. Run ablation: compare model performance with each signal removed one at a time. Candidates likely to survive: RVOL, catalyst quality, sector strength. Candidates likely to drop: contrarian_social, insider_buying, analyst_conviction. |
| 17 | **Catalyst × Regime pivot table at trade #100** | ChatGPT: produce two cross-tab reports — (1) Catalyst Type × Avg R and (2) Regime Bucket × Avg R. This is where real edge discovery happens. The data is now being collected; the analysis is deferred until the sample is meaningful. |

### P3 — Tech Debt / Refactor (after first profitable month)

| # | Item | Why |
|---|------|-----|
| 8 | **Split agent.js (~2000 lines) into modules** | Current file handles: scan prompts, EOD prompts, tool definitions, tool execution, Yahoo/FMP fetching, Robinhood orders, logistic regression, email, circuit breaker, state machine. Split into `lib/broker.js`, `lib/market-data.js`, `lib/positions.js`, mode files. |
| 9 | **Deduplicate market calendar** | 3 copies of the holiday set across agent.js, exit-daemon.js, monitor.js. A shared `lib/calendar.js` eliminates the update problem. |
| 10 | **Add 2028 market holidays** | 2027 holidays added; 2028 NYSE calendar typically confirmed by Oct 2027. |

### P4 — Nice-to-Have (if/when scaling capital)

| # | Item | Why |
|---|------|-----|
| 11 | ~~**Slippage threshold**~~ | **Done.** Slippage gate implemented: exit immediately if fill slippage > 50% of stop distance. Future work: auto-calibrate the 50% threshold from observed live fills. |
| 12 | **SMS/push as secondary alert channel** | Gmail is the single alerting channel. If credentials expire or Gmail throttles, alerts are silent. Twilio SMS or Apple push as fallback. |
| 13 | **Monthly/quarterly/annual P&L report** | weekly-report.js is built; monthly/quarterly/annual deferred until there's enough data (need 3+ months). |
| 14 | **Sierra-style observability patterns** | Structured event emission, tiered health check severity (critical vs warning vs info), human escalation protocol. Only relevant if scaling to larger capital or multiple strategies. |
| 18 | **Switch ML target from classification to R-multiple regression** | ChatGPT: the current binary win/loss label means a 70%-win-rate trade averaging +0.1R looks better than a 55%-win-rate trade averaging +1.2R. The thing worth predicting is expected R, not win probability. Partially mitigated by rMultiple sample weighting (implemented). Full fix: switch `trainModel()` to linear regression predicting expected R. Deferred until 200+ trades. |

---

## 26. Architecture Archive — What Was Removed and Why

Design decisions that were changed, and the reasoning behind each removal. Kept here so the same mistakes aren't made twice.

### Web search candidate discovery (removed June 2026)

**What it was:** Phase 2 of the scan prompt told the agent to run `web_search("pre-market gappers today YYYY-MM-DD volume")` to discover which stocks to research.

**Why it was removed:** Three compounding problems:
1. DuckDuckGo results are article-based and often hours stale by 6am PT.
2. The agent had no fixed universe — it researched whatever the LLM decided looked interesting from search snippets. Different tickers every day, no consistency.
3. The real discovery question ("what is moving right now?") is a data question, not a search question. Yahoo 5-min intraday bars answer it deterministically.

**What replaced it:** `screener.js` — runs at 5:55am, screens a fixed 83-ticker universe plus overnight earnings plus yesterday's watchlist using real 5-min bar data. Outputs a ranked JSON file the agent reads directly.

---

### Advisor watchlist and trade alerts in scan prompt (removed June 2026)

**What it was:** The scan prompt injected the advisor's current watchlist and trade alerts directly into the system prompt context before the agent began research.

**Why it was removed:** The agent could see the advisor's watchlist from token 0, before running any independent research. This anchored candidate discovery — tickers the advisor was watching naturally appeared on tomorrow's watchlist regardless of independent signal quality.

**What replaced it:** Advisor data enters only via explicit tool calls in Phase 4 after the agent has independently scored each screener candidate.

---

### Advisor macro stance as session veto (fixed June 2026)

**What it was:** The prompt said "advisor validation" but didn't prevent the agent from using the advisor's macro positioning as a reason to stand down for the entire session — even when individual setups had valid scores.

**Why it was wrong:** The advisor runs long-dated options positions (months to years). His portfolio hedges reflect multi-month macro views, not intraday momentum. An agent standing down because "the advisor is hedging" is conflating time horizons.

**What was added:** Explicit hard rules: advisor's macro stance cannot block a trade, cannot veto a session, and cannot change `setup_score`. His view on a specific ticker is context only.

---

### Short selling (removed June 2026)

**What it was:** The scan prompt allowed the agent to identify short setups.

**Why it was removed:** Robinhood retail accounts don't support shorting stock. The agent was producing short setups that could never execute, wasting research iterations on them.

**What replaced it:** "LONG ONLY — no short positions under any circumstances" added to the hard rules section of the scan prompt.

---

*Last updated: June 2026*
*Built using Claude Code*
