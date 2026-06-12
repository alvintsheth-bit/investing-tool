# Personal Investing Agent — Full Technical Documentation

**Owner:** Alvin Tsheth (alvintsheth@gmail.com)
**Built:** June 2026
**Status:** Fully operational — Robinhood auth ✅ | Gmail email ✅ | Daily cron ✅ | Self-learning ✅

---

## Table of Contents

1. [What This Is](#1-what-this-is)
2. [How It Works — Daily Flow](#2-how-it-works--daily-flow)
3. [Architecture Overview](#3-architecture-overview)
4. [Web Scraping Layer](#4-web-scraping-layer)
5. [Knowledge Base](#5-knowledge-base)
6. [The Investing Agent (agent.js)](#6-the-investing-agent-agentjs)
7. [Signal Stack — All 11 Signals](#7-signal-stack--all-11-signals)
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
18. [File Structure](#18-file-structure)
19. [Environment Variables](#19-environment-variables)
20. [How to Run](#20-how-to-run)
21. [Technology Stack](#21-technology-stack)
22. [APIs & Services Used](#22-apis--services-used)
23. [Why Credits Deplete Fast](#23-why-credits-deplete-fast)

---

## 1. What This Is

A fully automated, personal stock research and trading agent that runs daily without any human intervention. It:

- **Scrapes** sam-weiss.com (a paid subscription investing newsletter) daily at 6am, and rebuilds its knowledge base every Sunday — pulling briefings, trade alerts, watchlist, portfolio positions, and 18+ months of historical briefings
- **Researches** every relevant stock across 11 independent signal sources before ever consulting Sam Weiss — doing its own independent analysis first
- **Uses Sam Weiss as a validation layer** — after independent research, Sam's stance adjusts position sizing but does NOT contribute to the 1-10 score. This prevents over-anchoring to one viewpoint
- **Scores** each stock 1-10 based on 10 independent signals — a score of ≥7 triggers a trade
- **Executes** stock trades autonomously on Robinhood's dedicated Agentic Trading sub-account (account 674082664, `agentic_allowed: true`) with built-in circuit breakers
- **Documents** every executed trade in a permanent rationale file — recording all signal verdicts, technical data, market context, Sam's stance, and 5-day outcome tracking
- **Self-learns** by computing signal win rates from trade outcomes, then injecting those accuracy statistics into the next morning's prompt
- **Reports** end-of-day P&L, learnings, and tomorrow's watchlist — emailed via Gmail (nodemailer) at 4pm

The reasoning engine is Claude Opus 4.8, running in an agentic loop (up to 30 tool-use iterations per session).

---

## 2. How It Works — Daily Flow

```
SUNDAY 5:00 AM — scraper-knowledge-base.js weekly
                 • Scrapes last 10 briefings from sam-weiss.com
                 • Updates output/knowledge-base/briefings/
                 • Logs to output/logs/kb-weekly.log

DAILY  6:00 AM — scraper.js
                 • Authenticates to sam-weiss.com with Playwright
                 • Scrapes today's daily briefing, trade alerts, watchlist
                 • Saves output/sam-weiss-YYYY-MM-DD.json
                 • Logs to output/logs/scrape.log

DAILY  9:30 AM — agent.js (market open)
                 • Loads learning memory (signal win rates + recent trades)
                 • Loads today's scrape + 30 most recent briefings + full KB
                 • Phase 1: Independent market research (macro, sectors, VIX, F&G)
                 • Phase 2: Web search for candidate discovery (before Sam)
                 • Phase 3: Deep research per ticker (all 11 signals)
                 • Phase 4: Scoring, Sam validation, position sizing
                 • Phase 5: Execute trades ≥7 score via Robinhood MCP
                 • Writes output/recommendations-YYYY-MM-DD.md
                 • Writes output/trades/YYYY-MM-DD-TICKER-buy.md per trade
                 • Logs to output/logs/analyze.log

DAILY  4:00 PM — agent.js eod
                 • Fetches current prices for all trades from today
                 • Computes P&L, compares vs QQQ benchmark
                 • Recomputes signal accuracy from completed 5-day outcomes
                 • Generates EOD report with learnings + tomorrow's watchlist
                 • Saves output/watchlist-tomorrow.json
                 • Writes output/eod-report-YYYY-MM-DD.md
                 • Sends email to alvintsheth@gmail.com via Gmail (nodemailer)
                 • Logs to output/logs/eod.log
```

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          macOS launchd cron                         │
│  Sun 5am: kb-weekly  |  6am: scrape  |  9:30am: analyze  |  4pm eod│
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
   │  Claude Opus 4.8 (claude-opus-4-8)         │
   │  Agentic loop — up to 30 tool iterations   │
   │                                            │
   │  MEMORY INPUT:                             │
   │  • signal-accuracy.json (win rates)        │
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
                          │  signal-accuracy  │
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

**File:** `scraper.js` — daily 6am scraper
**File:** `scraper-knowledge-base.js` — full KB scraper + weekly updater

### Technology
- **Playwright** (headless Chromium) for authenticated browsing
- Human-like delays (`humanDelay()`: 800-2500ms between actions) to avoid bot detection
- Authenticated session: logs in once, reuses across all pages
- `networkidle` wait strategy + 300ms buffer after page load
- Credentials: `SAM_WEISS_USERNAME` + `SAM_WEISS_PASSWORD` in `.env`

### Daily Scraper (`scraper.js`) — 6am
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
**Model:** `claude-opus-4-8` (most capable reasoning)
**Max iterations:** 30 tool-use loops per session
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

| Content | Chars | Source |
|---------|-------|--------|
| Learning memory (signal win rates) | dynamic | signal-accuracy.json |
| Yesterday's watchlist | dynamic | watchlist-tomorrow.json |
| Recent trade history | dynamic | trades-log.json |
| Today's daily briefing | up to 8,000 | Daily scrape JSON |
| Today's trade alerts | up to 3,000 | Daily scrape JSON |
| Current watchlist | up to 3,000 | Daily scrape JSON |
| Current market outlook | 6,000 | market-outlook.md |
| Last 30 daily briefings | up to 20,000 | briefings/ newest-first |
| Sam's strategy framework | 5,000 | strategy.md |
| Investing principles | 4,000 | investing-basics.md |
| NASDAQ correction patterns | 4,000 | nasdaq-historical.md |
| All 9 portfolio positions | 6,000 | portfolios/ |
| Portfolio overview | 3,000 | portfolio-overview.md |
| Trade history | 3,000 | trade-history.md |

**Sam Weiss is loaded at the BOTTOM of the prompt, labeled "VALIDATION LAYER."** The agent researches independently first, then consults Sam. This prevents anchoring.

### Research Philosophy (Embedded in Prompt)
The agent is explicitly instructed:
1. Do independent market research first — macro, sectors, technicals, news, sentiment
2. Discover candidate stocks from web search and signals BEFORE reading Sam's view
3. Score candidates using 10 independent signals (Sam NOT included)
4. THEN consult Sam: his stance adjusts position size (full/standard/small) but not score
5. Execute if score ≥7 regardless of Sam's stance (with smaller size if Sam is silent/bearish)

### Modes
- `node agent.js` — analyze + trade (9:30am)
- `node agent.js eod` — end-of-day report (4pm)

---

## 7. Signal Stack — All 11 Signals

### Signal 1 — Sam Weiss Context (Validation Lens — NOT scored)
**Tools:** `search_sam_weiss_briefings` + pre-loaded context
**Role:** Adjusts position sizing after independent scoring is complete.

Sam's framework teaches the agent:
- **4-Part Framework**: Buy corrections → Hedge rallies → Sell covered calls → Hold long
- **2-Year Rule**: Never make decisions on short time horizons
- **NASDAQ Patterns**: Corrections end <20 sessions 90%+ of the time. Every correction → 8-15% rally
- **RSI Discipline**: Daily RSI >70 = overbought. RSI <30 = oversold/buy
- **Segment Analysis**: Position within correction/rally determines sizing and urgency

Sam modifier: bullish = full position (5%), silent = standard (3%), bearish = small (2%)

### Signal 2 — Technical Analysis
**Tool:** `get_market_data`
**Sources:** FMP `stable/quote`, `stable/profile`, `stable/historical-price-eod/light` (RSI computed)

Data returned:
- **Price + 1D change** — direction vs market
- **RSI-14** — computed from 60 days of closing prices using Wilder's smoothing method
- **52-week high/low** — position within yearly range
- **% from 52W high/low** — how extended vs. how discounted
- **MA50/MA200** — from FMP quote directly
- **Volume vs 20-day average** — computed from historical; >150% = institutional conviction
- **P/E ratio** — from `stable/key-metrics-ttm`
- **Beta** — from `stable/profile`

**Score +1 if:** RSI < 50 and momentum turning up, or RSI < 30 (oversold)

### Signal 3 — Macro Environment
**Tool:** `get_macro_indicators`
**Sources:** US Treasury XML (yield curve), DuckDuckGo web search for CPI/Fed context

Data returned:
- Treasury yields (3mo, 1yr, 2yr, 5yr, 10yr, 30yr) — from `home.treasury.gov` XML (free, live)
- Macro web search results: Fed funds rate, CPI, FOMC calendar, PCE

**Interpretation:**
- Fed cutting rates: bullish growth/tech, bullish REIT
- Fed hiking: bearish growth, bullish banks
- CPI falling: growth/tech benefits (lower discount rate)
- Inverted yield curve: recession risk
- Steepening yield curve: risk-on, financials benefit

**Score +1 if:** macro is a tailwind for this stock's sector

### Signal 4 — Fear & Greed Index + VIX + Market Indices
**Tool:** `get_fear_greed_vix`
**Sources:** CNN Fear & Greed API (free), FMP stable/quote for VIX, Yahoo Finance for SPY/QQQ/IWM

- CNN Fear & Greed score (0-100) and trend (1-week, 1-month)
- VIX level and 1D change (from FMP — works as index symbol)
- SPY, QQQ, IWM price and 1D change (from Yahoo Finance chart API)

**Interpretation:**
- F&G < 25: Extreme fear = capitulation, buying opportunity
- F&G > 75: Extreme greed = crowded long, take profits
- VIX > 30: Peak fear, often a buy signal
- VIX < 15: Complacency

### Signal 5 — Sector Rotation
**Tool:** `get_sector_rotation`
**Source:** Yahoo Finance chart API (ETF quotes — FMP free tier doesn't support ETFs)

All 11 S&P 500 sectors via ETFs (XLK, XLF, XLE, XLV, XLI, XLC, XLRE, XLU, XLP, XLY, XLB). Fetched sequentially with 80ms delay to respect Yahoo rate limits. Sorted by 1D performance.

**Score +1 if:** stock's sector leading today with multi-day momentum

### Signal 6 — Recent News & Catalysts
**Tool:** `get_news`
**Source:** DuckDuckGo web search (FMP news requires paid tier; DuckDuckGo is free)

Runs 2 searches per ticker: general news + earnings/analyst catalyst search. Returns up to 10 results.

**Score +1 if:** clear positive catalyst in last 48-72 hours (product launch, contract, regulatory, partnership)

### Signal 7 — Notable Mentions (HIGH SIGNAL when triggered)
**Tool:** `get_notable_mentions`
**Source:** DuckDuckGo HTML search — 5 parallel queries per ticker

Queries:
1. `{TICKER} Trump tariff trade deal executive order 2025 2026`
2. `{TICKER} Jensen Huang Elon Musk CEO mention 2025 2026`
3. `{TICKER} Nancy Pelosi Congress trade disclosure 2025`
4. `{TICKER} Warren Buffett Berkshire Ackman Cathie Wood position`
5. `{TICKER} analyst upgrade downgrade price target {year}`

**Why each source matters:**
- **Trump/White House**: Executive orders and tariff decisions move stocks 10%+ overnight. NVDA benefited from AI chip carveouts.
- **Jensen Huang (NVIDIA CEO)**: Most influential tech CEO for AI-adjacent stocks. A shoutout = stock moves.
- **Elon Musk**: SpaceX/Tesla ecosystem. DOGE = government contractor risk signal.
- **Congressional trades**: STOCK Act requires 45-day disclosure. Pelosi's track record is famous.
- **Buffett/Ackman/Cathie Wood**: Berkshire 13F = deep fundamental conviction. ARK = high-beta disruptive.

**Score +1 if:** concrete, recent mention that directly impacts the stock

### Signal 8 — Insider & Institutional Activity
**Tool:** `get_insider_activity`
**Source:** DuckDuckGo web search for SEC Form 4 filings (FMP insider data requires paid tier)

Returns web search results for recent Form 4 filings and institutional moves. Agent interprets context from results.

**Interpretation:**
- C-suite or board buying their OWN stock = very bullish (they know the trajectory)
- Multiple insiders buying same quarter = extremely high conviction
- Options exercise ≠ insider buying (compensation, not conviction)
- Vanguard/BlackRock growing = passive index addition
- Citadel/Point72/Bridgewater growing = active high-conviction bet

**Score +1 for insider buying, +1 for institutional accumulation (separately)**

### Signal 9 — Earnings History & Calendar
**Tools:** `get_earnings_info` + `get_earnings_calendar`
**Source:** DuckDuckGo web search (FMP earnings data requires paid tier)

Returns web search results for recent earnings reports, EPS surprises, and upcoming earnings calendar.

**Rules:**
- Earnings in < 5 days: **-2 score penalty** — binary event, avoid new positions
- 3+ consecutive beats: +1 score (management consistently outperforms)
- Post-earnings selloff on strong beat: potential accumulation opportunity

### Signal 10 — Reddit & StockTwits Sentiment
**Tool:** `get_reddit_sentiment`
**Sources:** Reddit JSON API (r/wallstreetbets, r/stocks, r/investing), StockTwits public API

**This is a CONTRARIAN signal:**
- Extreme Reddit bullishness = crowded trade, retail FOMO = often near local top
- Extreme Reddit bearishness on fundamentally sound stock = contrarian buy
- StockTwits > 80% bullish = sentiment overbought
- StockTwits < 20% bullish at peak fear = contrarian accumulation zone

**Score +1 if:** bears dominating on a fundamentally strong stock

### Signal 11 — Web Search
**Tool:** `web_search`
**Source:** DuckDuckGo HTML scraper

Used for ad-hoc research not captured by other tools: breaking macro, sector-specific news, geopolitical events, company-specific catalysts.

---

## 8. Scoring System

Each stock scored 1-10 on 10 independent signals. Sam Weiss is NOT scored — he adjusts position size only.

### Points

| Signal | +1 if… |
|--------|--------|
| Technical (rsi_oversold) | RSI < 50 turning up, or RSI < 30 |
| Macro (macro_tailwind) | Rate/inflation environment tailwind for sector |
| Sector rotation (sector_leading) | Sector leading today with multi-day momentum |
| News/catalyst (news_catalyst) | Clear positive catalyst in last 48-72 hours |
| Notable mention (notable_mention) | Trump order, CEO shoutout, congressional buy, major investor |
| Insider buying (insider_buying) | C-suite buying own stock |
| Institutional (institutional_growing) | Active funds growing position |
| Earnings quality (earnings_beater) | Beat EPS 3+ of last 4 quarters |
| Contrarian social (contrarian_social) | Bears dominating a fundamentally strong stock |
| Analyst conviction (analyst_conviction) | 2+ upgrades or significant price target raise |

### Deductions

| Condition | Points |
|-----------|--------|
| Earnings in < 5 days | -2 |
| RSI > 70 (overbought) | -1 |
| Macro headwind for sector | -1 |
| Heavy insider selling | -1 |
| Extreme Reddit bullishness (crowded) | -1 |

### Sam Weiss Modifier (position size only)

| Sam Stance | Position Size |
|-----------|---------------|
| Bullish (explicit buy call) | Full (5% of portfolio) |
| Silent (no mention) | Standard (3%) |
| Bearish (avoid / has sold) | Small (2%) |

### Decision Thresholds

| Score | Action |
|-------|--------|
| ≥8 | Execute full position (Sam-adjusted) |
| 7 | Execute standard position |
| 5-6 | Watchlist for tomorrow |
| < 5 | Avoid |

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
      "rsi_oversold": false,
      "macro_tailwind": true,
      "sector_leading": true,
      "news_catalyst": false,
      "notable_mention": true,
      "insider_buying": false,
      "institutional_growing": false,
      "earnings_beater": false,
      "contrarian_social": false,
      "analyst_conviction": false
    },
    "outcome": null,
    "exitPrice": null,
    "return5d": null
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
- **5-day outcome table** — filled in at EOD D+1, D+3, D+5
- **Robinhood order result** — raw JSON confirmation

This creates a permanent, auditable record of every trading decision — enabling post-mortems and long-term signal calibration.

---

## 10. Circuit Breakers & Risk Management

Enforced in `agent.js` via the `CIRCUIT` state object. Cannot be overridden by Claude.

### Position Size Limit (5% per trade)
```
checkPositionSize(tradeAmount, portfolioValue):
  if (tradeAmount / portfolioValue > 5%):
    auto-reduce quantity to maximum allowed
    if 1 share > 5% of portfolio: reject trade entirely
```

### Daily Loss Limit (5% of portfolio)
```
checkCircuitBreaker(portfolioValue):
  dailyLoss% = (dailyPnL / portfolioValueAtOpen) × 100
  if dailyLoss% < -5%:
    CIRCUIT.tripped = true
    ALL subsequent place_trade calls return blocked=true
```

### Robinhood Account
- Account number: 674082664
- Type: Agentic trading sub-account (`agentic_allowed: true`)
- All orders: market orders (GFD — good for day)
- Assets: stocks only (no ETFs, no options, no crypto)

---

## 11. Self-Learning System

The agent tracks its own accuracy and injects learnings into the next morning's prompt.

### How It Works

**At trade execution (`place_trade`):**
```json
{
  "id": "NVDA-buy-2026-06-12T09:45:32Z",
  "signals": { "rsi_oversold": false, "macro_tailwind": true, ... },
  "entryPrice": 205.19,
  "outcome": null  ← filled at EOD +5
}
```

**At EOD (`agent.js eod`):**
1. `updateTradeOutcomes()` — fetches current prices for all open trades, computes unrealized P&L
2. For trades > 5 trading days old: marks outcome as win (return > 0) or loss (return < 0)
3. `computeSignalAccuracy(log)` — for each signal key, counts fires/wins/losses, computes win rate

**Signal accuracy file (`output/signal-accuracy.json`):**
```json
{
  "signals": {
    "rsi_oversold": { "fires": 14, "wins": 10, "losses": 4, "winRate": 0.714, "avgReturn": 0.034 },
    "macro_tailwind": { "fires": 22, "wins": 16, "losses": 6, "winRate": 0.727, "avgReturn": 0.041 },
    "notable_mention": { "fires": 5, "wins": 3, "losses": 2, "winRate": 0.600, "avgReturn": 0.022 }
  }
}
```

**Next morning's prompt begins with:**
```
📊 LEARNING MEMORY — Signal Accuracy (past 90 days)
rsi_oversold:   71.4% win rate (14 fires, avg +3.4%)  ← USE THIS SIGNAL
macro_tailwind: 72.7% win rate (22 fires, avg +4.1%)  ← USE THIS SIGNAL
notable_mention: 60.0% win rate (5 fires, avg +2.2%)
```

The agent naturally up-weights high-accuracy signals and down-weights low-accuracy ones.

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
1. **P&L Summary** — per trade: entry vs close, P&L $ and %, vs QQQ benchmark
2. **Signal Accuracy Review** — which signals worked, win rates updated
3. **Key Learnings** — what to do differently, signal combination insights
4. **Tomorrow's Watchlist** — specific entry triggers, targets, stop levels for each
5. **Open Positions Review** — thesis still valid? Add or trim?
6. **Strategy Alignment Score** — 1-10 vs Sam's 4-part framework

### Gmail Configuration
```
GMAIL_USER=alvintsheth@gmail.com
GMAIL_APP_PASSWORD=REDACTED_APP_PASSWORD  (Google App Password, not account password)
```
Uses `nodemailer` with Gmail SMTP (`smtp.gmail.com:587`). App password generated at myaccount.google.com → Security → 2-Step Verification → App passwords.

---

## 17. Daily Automation (macOS launchd)

All 4 jobs are loaded and running:

```bash
launchctl list | grep investing-tool
# com.investing-tool.scrape      → 6:00 AM daily
# com.investing-tool.analyze     → 9:30 AM daily  
# com.investing-tool.eod         → 4:00 PM daily
# com.investing-tool.kb-weekly   → 5:00 AM every Sunday
```

### Plist Files
Located at `~/Library/LaunchAgents/`:
- `com.investing-tool.scrape.plist`
- `com.investing-tool.analyze.plist`
- `com.investing-tool.eod.plist`
- `com.investing-tool.kb-weekly.plist`

### Log Files
`output/logs/`:
- `scrape.log` — 6am scraper output
- `analyze.log` — 9:30am agent output
- `eod.log` — 4pm EOD report output
- `kb-weekly.log` — Sunday KB update output

### To manually trigger any job
```bash
launchctl start com.investing-tool.scrape
launchctl start com.investing-tool.analyze
launchctl start com.investing-tool.eod
launchctl start com.investing-tool.kb-weekly
```

### Node.js Path
The nvm-managed Node is hardcoded in all plists:
```
/Users/alvintsheth/.nvm/versions/node/v22.22.3/bin/node
```

---

## 18. File Structure

```
investing-tool/
├── agent.js                          # Main investing agent (~1200 lines)
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
│   ├── trades-log.json              # Machine-readable trade history (learning system)
│   ├── signal-accuracy.json         # Signal win rates (self-learning)
│   ├── watchlist-tomorrow.json      # Tomorrow's watchlist from EOD
│   │
│   ├── trades/                      # Per-trade rationale files
│   │   ├── 2026-06-12-NVDA-buy.md  # Full thesis, signals, context, 5-day outcomes
│   │   └── ...
│   │
│   ├── logs/
│   │   ├── scrape.log               # 6am scraper output
│   │   ├── analyze.log              # 9:30am agent output
│   │   ├── eod.log                  # 4pm EOD output
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

## 19. Environment Variables

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
```

---

## 20. How to Run

### Prerequisites
```bash
cd investing-tool
npm install
npx playwright install chromium
```

### Daily Usage (these run automatically via cron — manual override below)
```bash
npm run scrape        # 6am — scrape today's sam-weiss.com data
npm run analyze       # 9:30am — analyze + execute trades
node agent.js eod     # 4pm — EOD report + email
npm run run           # scrape + analyze back-to-back
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

## 21. Technology Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js v22.22.3, ESM modules |
| AI reasoning | Claude Opus 4.8 (`claude-opus-4-8`) |
| AI client | @anthropic-ai/sdk ^0.24.0 |
| Web scraping | Playwright ^1.44.0 (headless Chromium) |
| Config | dotenv ^16.4.5 |
| HTTP | Node.js native `fetch` (built-in since Node 18) |
| Email | nodemailer ^8.0.11 + Gmail SMTP |
| Scheduling | macOS launchd (4 plist jobs) |
| Trade execution | Robinhood Agentic Trading MCP (HTTP transport) |

### Why Claude Opus 4.8?
Financial decisions require multi-step reasoning across 11 signals with conflicting indicators. Haiku is too weak. Sonnet is borderline. Opus gives the best signal synthesis quality — especially for understanding nuanced market context and applying Sam's qualitative framework to quantitative signals.

### Why Node.js ESM?
Started with Playwright (Node ecosystem) + Anthropic SDK. Node's native `fetch` handles all HTTP. ESM is the modern standard.

### Why Playwright over Cheerio/Puppeteer?
Sam's site is WordPress with JavaScript-rendered dropdowns, tabs, and slides. Static parsers can't handle this. Playwright's `networkidle` + `page.evaluate()` handles all interactive elements.

---

## 22. APIs & Services Used

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

## 23. Why Credits Deplete Fast

The agent uses **Claude Opus 4.8**, Anthropic's most capable (and most expensive) model:
- Input: **$15 per million tokens**
- Output: **$75 per million tokens**

### Why Each Run Is Expensive

**The prompt is massive.** At each session start, the system message injects:
- 30 daily briefings × ~4,000 chars each = ~120,000 chars
- Strategy, basics, outlook, portfolios, trade history = ~30,000 chars more
- Total context: **50,000–80,000 tokens per session start**

**Tool results expand context.** Each tool call adds its result to the conversation. With 30 iterations, and tool results of 1,000-5,000 tokens each, the total context by iteration 20 can be **150,000+ tokens**.

**Cost estimate per session:**
- Session input tokens: ~150,000 tokens × $15/MTok = **$2.25**
- Session output tokens: ~30,000 tokens × $75/MTok = **$2.25**
- **~$4-5 per agent run** (analyze or eod)
- Two runs daily × 30 days = **~$240–300/month**

### How to Reduce Cost (without reducing quality)
1. **Reduce briefings loaded**: Change `loadLatestBriefings(30)` to `loadLatestBriefings(10)` — briefings are the biggest input token consumer
2. **Reduce max iterations**: Change `maxIter` from 30 to 15 — most sessions complete in 10-12
3. **Use Sonnet for EOD**: EOD is less research-intensive; swap to `claude-sonnet-4-6` for the 4pm run
4. **Cache stable KB files**: Strategy/basics/outlook don't change daily — only load them 1x/week

*Last updated: June 2026*
*Built by Alvin Tsheth using Claude Code*
