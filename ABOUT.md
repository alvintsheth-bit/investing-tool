# Personal Investing Agent — Full Technical Documentation

**Owner:** Alvin Tsheth (alvintsheth@gmail.com)
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
- **Executes** fractional-share, dollar-denominated market orders on Robinhood's Agentic Trading sub-account (account 674082664) — max 2 concurrent positions, 17.5% of balance per trade
- **Monitors** open positions at 8:00am, 9:30am, and 11:00am — exits on stop/target hits or thesis-break events (Haiku judges borderline cases)
- **Force-closes** all open positions at 12:45pm PT (15 min before 1pm PT market close) with pure code — no Claude call
- **Trains** a logistic regression model at EOD on all closed trades (features: 10 signal binaries + continuous values, L2 regularized, 80/20 blended with prior day's weights)
- **Reports** daily realized P&L vs QQQ benchmark + learnings — emailed at 1:30pm PT
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

DAILY  6:00 AM — agent.js scan (30 min before open, Claude Sonnet)
                 • Pre-flight: verify account balance, DRY_RUN status, holiday check
                 • Phase 1: VIX, Fear & Greed, sector pre-market moves (sets risk appetite)
                 • Phase 2: Discover pre-market gappers (>2% gap, RVOL >2x)
                 • Phase 3: Screen each — get_premarket_data (gap%, RVOL, ATR-14, stop/target)
                 •           news catalyst, Reddit overnight chatter, notable mentions
                 • Phase 4: Sam validation (briefing search + outlook on demand)
                 • Phase 5: Execute if P(win) > 0.55, log to trades-open.json
                 • Entry window: 6:00–10:00am PT only. No buys after 10am PT.
                 • Logs to output/logs/analyze.log

DAILY  6:30 AM — Market opens (NYSE/NASDAQ)

DAILY  8:00 AM — agent.js check (pure code + Haiku for judgment)
                 • Fetch current price for each open position
                 • Stop hit → market sell, log, remove from trades-open.json
                 • Target hit → market sell, log, done
                 • Thesis-break check (VIX spike >15%, negative news halt) → Haiku decides
                 • Logs to output/logs/check.log

DAILY  9:30 AM — agent.js check (same logic)

DAILY 11:00 AM — agent.js check (same logic)

DAILY 12:45 PM — agent.js force-close (pure code, no Claude)
                 • Hard market sell on every position still open — no exceptions
                 • Skipped on early-close days (Nov 27, Dec 24)
                 • Logs to output/logs/force-close.log

DAILY  1:00 PM — Market closes

DAILY  1:30 PM — agent.js eod (Claude Haiku)
                 • Retrain logistic regression on all closed trades (60-trade minimum)
                 • 80/20 blend new coefficients with yesterday's → signal-weights.json
                 • Walk-forward validation: this week vs last week accuracy
                 • Generate EOD report: P&L vs QQQ + learnings (2 sections only)
                 • Save tomorrow's watchlist (gap candidates to re-screen)
                 • Email to alvintsheth@gmail.com
                 • Logs to output/logs/eod.log
```

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          macOS launchd cron                         │
│  Sun 5am: kb-weekly  |  5:30am: scrape  |  6am: scan  |  8/9:30/11am: check  |  12:45pm: force-close  |  1:30pm: eod│
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
   │  Agentic loop — up to 30 tool iterations   │
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
**Max iterations:** 20 (analyze) / 12 (EOD) tool-use loops per session
**Max tokens per response:** 8,192

### How the Agentic Loop Works

```
1. Load learning memory (signal win rates, recent trades, yesterday's watchlist)
2. Build system prompt — injects 50-80k tokens of KB context
3. Send to Claude with 14 tools defined
4. Claude responds with tool_use blocks
5. Execute each tool (FMP, Yahoo Finance, Reddit, DuckDuckGo, Robinhood, etc.)
6. Return tool_result to Claude
7. Repeat until stop_reason === 'end_turn' or 30 iterations
8. Save final text response to output/recommendations-YYYY-MM-DD.md
```

### Context Injected at Prompt Time

Only factual, non-narrative data is pre-loaded. Sam's briefings, market outlook, and portfolio positions are deliberately excluded from the initial context to prevent recency bias — the agent cannot have absorbed Sam's current views before starting its own research.

| Content | Chars | Source |
|---------|-------|--------|
| Learning memory (signal win rates) | dynamic | signal-weights.json |
| Yesterday's watchlist + entry triggers | dynamic | watchlist-tomorrow.json |
| Today's trade alerts (what Sam bought/sold) | up to 2,000 | Daily scrape JSON |
| Today's watchlist (what Sam is monitoring) | up to 2,000 | Daily scrape JSON |
| NASDAQ correction/rally patterns | 3,000 | nasdaq-historical.md (historical data) |

**What is NOT pre-loaded (to prevent anchoring):**
- Sam's daily briefing narrative → available via `get_sam_market_outlook` tool on demand
- Recent briefings → available via `search_sam_weiss_briefings` tool on demand
- Market outlook → available via `get_sam_market_outlook` tool on demand
- Portfolio positions → available via `get_sam_market_outlook` tool on demand
- Strategy/investing-basics → available via `get_sam_market_outlook` tool on demand

The only Sam content pre-loaded is **factual actions** (trade alerts = what he bought/sold, watchlist = what he's monitoring). Narrative analysis and price-level commentary are tool-gated.

### Research Philosophy (Embedded in Prompt)
The agent is explicitly instructed:
1. Do independent market research first — macro, sectors, technicals, news, sentiment
2. Discover candidate stocks from web search and signals BEFORE reading Sam's view
3. Score candidates using 10 independent signals (Sam NOT included)
4. THEN consult Sam: his stance adjusts position size (full/standard/small) but not score
5. Execute if P(win) >0.55 — Sam's stance adjusts size (full/standard/small) but not the threshold

### Modes
- `node agent.js` — analyze + trade (6:00am)
- `node agent.js eod` — end-of-day report (1:30pm)

---

## 7. Signal Stack — 10 Day-Trading Signals

All 10 signals feed a logistic regression model. Until 60 trades of history exist, equal-weight scoring is used (P(win) = active signals / 10).

### Primary Signals (day-trade specific)

**`premarket_gap_up`** — Primary entry filter
Gap >2% pre-market on elevated volume. Computed from Yahoo Finance `preMarketPrice` vs FMP previous close.
Formula: `(preMarketPrice - prevClose) / prevClose * 100 > 2`

**`rvol_spike`** — Relative Volume
Pre-market volume >2× the 30-day daily average × 0.08 (pre-market is ~8% of daily session).
High RVOL = institutional activity, not retail noise.

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

### Sam Weiss (validation lens, not a signal)
`search_sam_weiss_briefings(ticker)` and `get_sam_market_outlook` are available after independent research. Sam's stance does NOT change P(win) — it informs position context.

---

## 8. Scoring System — Logistic Regression

### Model
P(win) = sigmoid(Σ coef_i × signal_i + intercept)

Trained daily at EOD using L2-regularized logistic regression in pure JavaScript (gradient descent, 500 epochs, lr=0.05, λ=0.01). No external ML libraries.

**Thresholds:**
| P(win) | Action |
|--------|--------|
| > 0.70 | Full position (high confidence) |
| > 0.55 | Standard position |
| 0.45–0.55 | Watch only — log for training data |
| < 0.45 | Avoid |

**Hard excludes (regardless of score):**
- Earnings today before close
- Past 10am PT entry window
- Already at 2 concurrent positions

**Fallback (< 60 trades):** Equal-weight — P(win) = active signal count / 10

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
- **ATR-14 stop/target levels** — computed at entry
- **Robinhood order result** — raw JSON confirmation (or DRY RUN output)

This creates a permanent, auditable record of every trading decision — enabling post-mortems and long-term signal calibration.

---

## 10. Circuit Breakers & Risk Management

All limits pull live account balance dynamically at the start of each run. Cannot be overridden by Claude.

### Position Size (17.5% of balance)
```
computePositionDollars(balance) = balance × 0.175
```
Dollar-denominated → fractional quantity = dollarAmount / price. Robinhood supports fractional NMS-listed stocks.

### Max Concurrent Positions (2)
`checkMaxConcurrent(openPositions)` — blocks new entries if 2 positions already open in `trades-open.json`.

### Daily Loss Limit (5% of balance)
```
dailyLoss% = sum(open position P&L) / currentBalance
if dailyLoss% < -5%: CIRCUIT.tripped = true — no new trades
```

### Weekly Drawdown Breaker (15%)
```
weeklyLoss% = (currentBalance - weekStartBalance) / weekStartBalance
if weeklyLoss% < -15%: CIRCUIT.tripped = true — MANUAL REVIEW REQUIRED
```

### Stop Loss: ATR-14 Based
```
stopDistancePct = clamp((ATR14 / price) × 0.75, 1.0%, 4.0%)
targetDistancePct = stopDistancePct × 1.5  (1.5:1 reward:risk)
```
Stop enforced by exit manager polling, NOT by broker-side stop orders (Robinhood only supports market orders for fractional shares). Effective stop = ±1 check interval (max 90 min gap).

### Hard Force-Close (12:45pm PT)
Pure code, no Claude, no exceptions. Market sell on every open position 15 minutes before 1pm PT close. Skipped on early-close days.

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
  "pnl": 15.60, "pnlPct": 1.56,
  "exitReason": "target hit",
  "signals": { "premarket_gap_up": true, "rvol_spike": true, ... },
  "pWin": 0.68
}
```

### Model Training (EOD)
```
Features: 10 signal binaries
Label: 1 if pnl > 0, else 0
Method: L2-regularized logistic regression, pure JS gradient descent
  - 500 epochs, lr=0.05, λ=0.01
  - Blend: 80% yesterday's weights + 20% today's new fit
  - Minimum 60 trades required (equal-weight fallback below)
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
https://www.reddit.com/r/{subreddit}/search.json?q={ticker}&sort=top&t=week&limit=5
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
1. **P&L Summary** — per trade: entry vs force-close price, P&L $ and %, vs QQQ benchmark
2. **Key Learnings** — which signals fired/missed, what to do differently tomorrow

### Gmail Configuration
```
GMAIL_USER=alvintsheth@gmail.com
GMAIL_APP_PASSWORD=twsbhpqkeyclwwrt  (Google App Password, not account password)
```
Uses `nodemailer` with Gmail SMTP (`smtp.gmail.com:587`). App password generated at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

## 17. Daily Automation (macOS launchd)

All 9 jobs are loaded and running:

```bash
launchctl list | grep investing-tool
# com.investing-tool.scrape      → 5:30 AM daily
# com.investing-tool.analyze     → 6:00 AM daily (scan mode)
# com.investing-tool.check-8am   → 8:00 AM daily (exit manager)
# com.investing-tool.check-930am → 9:30 AM daily (exit manager)
# com.investing-tool.check-11am  → 11:00 AM daily (exit manager)
# com.investing-tool.force-close → 12:45 PM daily (hard close all)
# com.investing-tool.eod         → 1:30 PM daily
# com.investing-tool.monitor     → 2:15 PM daily (health check)
# com.investing-tool.kb-weekly   → 5:00 AM every Sunday
```

All jobs exit immediately on weekends and US market holidays (hardcoded 2026 calendar).

### Plist Files
Located at `~/Library/LaunchAgents/`:
- `com.investing-tool.scrape.plist`
- `com.investing-tool.analyze.plist` (runs `agent.js scan`)
- `com.investing-tool.check-8am.plist`
- `com.investing-tool.check-930am.plist`
- `com.investing-tool.check-11am.plist`
- `com.investing-tool.force-close.plist` (runs `agent.js force-close`)
- `com.investing-tool.eod.plist`
- `com.investing-tool.monitor.plist`
- `com.investing-tool.kb-weekly.plist`

### Log Files
`output/logs/`:
- `scrape.log` — 5:30am scraper output
- `analyze.log` — 6:00am scan output
- `check.log` — 8am/9:30am/11am exit manager output (shared)
- `force-close.log` — 12:45pm force-close output
- `eod.log` — 1:30pm EOD report output
- `monitor.log` — 2:15pm health check output
- `kb-weekly.log` — Sunday KB update output

### To manually trigger any job
```bash
launchctl start com.investing-tool.scrape
launchctl start com.investing-tool.analyze
launchctl start com.investing-tool.check-8am
launchctl start com.investing-tool.force-close
launchctl start com.investing-tool.eod
launchctl start com.investing-tool.monitor
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
**Schedule:** 2:15pm PT daily (after EOD completes)
**Cost:** $0 — pure code, no Claude API calls

Runs 5 checks every trading day and sends a failure email if anything is wrong:

| Check | Pass condition | Failure means |
|-------|---------------|---------------|
| Scrape | `sam-weiss-{today}.json` exists | scraper crashed or never ran |
| Scan | `recommendations-{today}.md` exists | scan agent crashed |
| EOD | `eod-report-{today}.md` exists | EOD agent crashed |
| Positions cleared | `trades-open.json` has 0 entries | force-close failed to close something — **check Robinhood immediately** |
| Force-close log | `force-close.log` touched after 12:45pm | launchd job never fired |

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
├── agent.js                          # Main investing agent (~1200 lines)
├── monitor.js                        # Daily health checker (pure code, no Claude)
├── scraper.js                        # Daily morning scraper (194 lines)
├── scraper-knowledge-base.js         # Full KB + weekly updater (~800 lines)
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
│   │
│   ├── trades/                      # Per-trade rationale files
│   │   ├── 2026-06-14-NVDA-buy.md  # Entry data, signals, P(win), exit outcome
│   │   ├── 2026-06-14-NVDA-buy-DRY.json  # Dry-run order log (when DRY_RUN=true)
│   │   └── ...
│   │
│   ├── logs/
│   │   ├── scrape.log               # 5:30am scraper output
│   │   ├── analyze.log              # 6:00am scan output
│   │   ├── check.log                # 8am/9:30am/11am exit manager output
│   │   ├── force-close.log          # 12:45pm force-close output
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
npm run check         # 8am/9:30am/11am — exit manager
npm run force-close   # 12:45pm — hard close all positions
npm run eod           # 1:30pm — EOD report + email + model retrain
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
| Scheduling | macOS launchd (4 plist jobs) |
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
- Initial prompt: ~8,000 chars (trade alerts + watchlist + NASDAQ patterns + learning memory)
- No briefings, no outlook, no portfolio positions pre-loaded — all tool-gated
- Sam's content only enters context when the agent explicitly calls `get_sam_market_outlook` or `search_sam_weiss_briefings`

**Cost estimate per session (current):**
- Analyze run (Sonnet, 20 iter max): ~30k tokens → ~$0.45
- EOD run (Haiku, 12 iter max): ~15k tokens → ~$0.06
- **~$0.51/day total** for both runs
- **~$15/month**

**Why this is also architecturally better:** Briefings in the initial context = the agent has absorbed Sam's current narrative before its first thought. That's not independent research — it's anchored research. Tool-gating Sam's content enforces the "market first, Sam second" discipline at a structural level, not just as a prompt instruction.

*Last updated: June 2026*
*Built by Alvin Tsheth using Claude Code*
