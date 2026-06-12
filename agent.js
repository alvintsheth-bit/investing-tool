import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';

config();

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FMP_KEY = process.env.FMP_API_KEY;
const POLYGON_KEY = process.env.POLYGON_API_KEY;
mkdirSync('./output', { recursive: true });

// ─── Load latest scrape ───────────────────────────────────────────────────────
function loadLatestScrape() {
  const files = readdirSync('./output').filter(f => f.startsWith('sam-weiss-')).sort().reverse();
  if (!files.length) throw new Error('No scrape data found. Run: npm run scrape');
  const data = JSON.parse(readFileSync(`./output/${files[0]}`));
  console.log(`Loaded scrape from ${files[0]}`);
  return data;
}

// ─── Market Data Tools ────────────────────────────────────────────────────────
async function getQuote(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_KEY}`);
  const data = await r.json();
  return data[0] || null;
}

async function get52WeekHighLow(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/${ticker}?apikey=${FMP_KEY}`);
  const data = await r.json();
  const q = data[0];
  if (!q) return null;
  return { ticker, price: q.price, yearHigh: q.yearHigh, yearLow: q.yearLow, pctFromHigh: ((q.price - q.yearHigh) / q.yearHigh * 100).toFixed(1), pctFromLow: ((q.price - q.yearLow) / q.yearLow * 100).toFixed(1) };
}

async function getAnalystRatings(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v3/analyst-stock-recommendations/${ticker}?limit=5&apikey=${FMP_KEY}`);
  return r.json();
}

async function getInsiderTrades(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v4/insider-trading?symbol=${ticker}&limit=10&apikey=${FMP_KEY}`);
  return r.json();
}

async function getInstitutionalHolders(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v3/institutional-holder/${ticker}?apikey=${FMP_KEY}`);
  return r.json();
}

async function getFundamentals(ticker) {
  if (!FMP_KEY) return null;
  const r = await fetch(`https://financialmodelingprep.com/api/v3/profile/${ticker}?apikey=${FMP_KEY}`);
  const data = await r.json();
  return data[0] || null;
}

// ─── Macro Indicators ─────────────────────────────────────────────────────────
async function getMacroIndicators() {
  if (!FMP_KEY) return null;
  const [calendar, treasury, fedFunds] = await Promise.all([
    // Upcoming economic events (Fed meetings, CPI releases)
    fetch(`https://financialmodelingprep.com/api/v3/economic_calendar?from=${getDateStr(0)}&to=${getDateStr(30)}&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => []),
    // Treasury yield curve
    fetch(`https://financialmodelingprep.com/api/v4/treasury?from=${getDateStr(7)}&to=${getDateStr(0)}&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => []),
    // Key economic indicators: CPI, Fed funds rate, unemployment
    fetch(`https://financialmodelingprep.com/api/v4/economic?name=CPI,federalFundsRate,unemploymentRate&apikey=${FMP_KEY}`).then(r => r.json()).catch(() => []),
  ]);

  return {
    upcomingEvents: (calendar || []).filter(e =>
      ['Fed', 'CPI', 'PCE', 'Employment', 'GDP', 'Inflation'].some(k => e.event?.includes(k))
    ).slice(0, 10),
    treasuryYields: (treasury || []).slice(0, 3),
    economicIndicators: (fedFunds || []).slice(0, 10),
  };
}

function getDateStr(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

// ─── Reddit Sentiment ─────────────────────────────────────────────────────────
async function getRedditSentiment(ticker) {
  const subreddits = ['wallstreetbets', 'stocks', 'investing'];
  const results = [];

  for (const sub of subreddits) {
    try {
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${ticker}&sort=top&t=week&limit=5`;
      const r = await fetch(url, { headers: { 'User-Agent': 'investing-tool/1.0' } });
      const data = await r.json();
      const posts = (data?.data?.children || []).map(p => ({
        title: p.data.title,
        score: p.data.score,
        comments: p.data.num_comments,
        sentiment: p.data.title.toLowerCase(),
      }));
      if (posts.length) results.push({ subreddit: sub, posts });
    } catch {}
  }

  // Also check StockTwits (public API, no key needed)
  try {
    const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
    const data = await r.json();
    const messages = (data?.messages || []).slice(0, 5).map(m => ({
      text: m.body,
      sentiment: m.entities?.sentiment?.basic || 'Neutral',
      likes: m.likes?.total || 0,
    }));
    if (messages.length) results.push({ subreddit: 'StockTwits', posts: messages });
  } catch {}

  return { ticker, sources: results };
}

// ─── Sector Rotation ──────────────────────────────────────────────────────────
const SECTOR_ETFS = {
  Technology: 'XLK', Financials: 'XLF', Energy: 'XLE', Healthcare: 'XLV',
  Industrials: 'XLI', Communication: 'XLC', RealEstate: 'XLRE',
  Utilities: 'XLU', ConsumerStaples: 'XLP', ConsumerDisc: 'XLY', Materials: 'XLB',
};

async function getSectorRotation() {
  if (!FMP_KEY) return null;
  const tickers = Object.values(SECTOR_ETFS).join(',');
  const r = await fetch(`https://financialmodelingprep.com/api/v3/quote/${tickers}?apikey=${FMP_KEY}`);
  const quotes = await r.json();

  const sectors = quotes.map(q => {
    const name = Object.keys(SECTOR_ETFS).find(k => SECTOR_ETFS[k] === q.symbol);
    return {
      sector: name,
      ticker: q.symbol,
      price: q.price,
      change1D: q.changesPercentage?.toFixed(2),
      change1M: null, // would need historical endpoint
      yearHigh: q.yearHigh,
      yearLow: q.yearLow,
      pctFromHigh: ((q.price - q.yearHigh) / q.yearHigh * 100).toFixed(1),
    };
  });

  // Sort by 1-day performance to show rotation
  sectors.sort((a, b) => parseFloat(b.change1D) - parseFloat(a.change1D));

  return {
    date: new Date().toISOString().split('T')[0],
    leadingSectors: sectors.slice(0, 4),
    laggingSectors: sectors.slice(-4),
    all: sectors,
  };
}

// ─── Tool definitions for Claude ─────────────────────────────────────────────
const tools = [
  {
    name: 'get_market_data',
    description: 'Get current price, 52-week high/low, analyst ratings, insider trades, and fundamentals for a stock ticker',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker symbol e.g. AAPL, NVDA, QQQ' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for recent news, influential mentions, or any research topic',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_insider_activity',
    description: 'Get recent insider buying/selling and institutional (hedge fund) 13F activity for a ticker',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_macro_indicators',
    description: 'Get current macro environment: upcoming Fed meetings, CPI releases, treasury yield curve, and key economic indicators (inflation, unemployment, fed funds rate). Call this once at the start of analysis.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'get_reddit_sentiment',
    description: 'Get Reddit (r/wallstreetbets, r/stocks, r/investing) and StockTwits sentiment for a ticker over the past week — post scores, comment counts, and bullish/bearish tone.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string', description: 'Stock ticker e.g. NVDA, AAPL' },
      },
      required: ['ticker'],
    },
  },
  {
    name: 'get_sector_rotation',
    description: 'Get today\'s sector performance across all 11 S&P sectors (XLK, XLF, XLE etc.) to identify which sectors are leading or lagging — useful for understanding macro rotation and which sectors to favor.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ─── Tool executor ────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  if (name === 'get_market_data') {
    const [price52, analyst, fundamentals] = await Promise.all([
      get52WeekHighLow(input.ticker),
      getAnalystRatings(input.ticker),
      getFundamentals(input.ticker),
    ]);
    return { ticker: input.ticker, price52, analyst: analyst?.slice(0, 3), fundamentals };
  }

  if (name === 'web_search') {
    // Use DuckDuckGo instant answer API (no key needed) + return query for Claude to reason about
    try {
      const encoded = encodeURIComponent(input.query);
      const r = await fetch(`https://api.duckduckgo.com/?q=${encoded}&format=json&no_redirect=1`);
      const data = await r.json();
      return {
        query: input.query,
        abstract: data.Abstract || '',
        relatedTopics: (data.RelatedTopics || []).slice(0, 5).map(t => t.Text || '').filter(Boolean),
        note: 'Search results from DuckDuckGo. Use your training knowledge to supplement.',
      };
    } catch {
      return { query: input.query, note: 'Search unavailable, use training knowledge' };
    }
  }

  if (name === 'get_insider_activity') {
    const [insider, institutional] = await Promise.all([
      getInsiderTrades(input.ticker),
      getInstitutionalHolders(input.ticker),
    ]);
    return {
      ticker: input.ticker,
      recentInsiderTrades: (insider || []).slice(0, 5),
      topInstitutionalHolders: (institutional || []).slice(0, 5),
    };
  }

  if (name === 'get_macro_indicators') {
    return getMacroIndicators();
  }

  if (name === 'get_reddit_sentiment') {
    return getRedditSentiment(input.ticker);
  }

  if (name === 'get_sector_rotation') {
    return getSectorRotation();
  }

  return { error: `Unknown tool: ${name}` };
}

// ─── Build the analysis prompt ────────────────────────────────────────────────
function buildPrompt(scrape) {
  const getContent = (label) => scrape.pages.find(p => p.label === label)?.content || '';
  const portfolioSummary = scrape.portfolios.map(p => `[${p.label}]\n${p.content?.slice(0, 1500)}`).join('\n\n');

  return `You are a personal investing analyst assistant. Your job is to analyze all available data and generate ranked stock and options recommendations.

## TODAY'S MARKET DATA FROM SAM WEISS (${scrape.scrapedAt})

### Daily Briefing (Latest Post)
${getContent('daily-briefing-latest')}

### Current Market Outlook
${getContent('market-outlook')}

### Recent Trades (Sam Weiss Model Portfolios)
${getContent('trades')?.slice(0, 3000)}

### Trade Watch (Watchlist)
${getContent('trade-watch')}

### NASDAQ Tables / Market Structure
${getContent('nasdaq-tables')?.slice(0, 2000)}

### Model Portfolio Positions
${portfolioSummary?.slice(0, 4000)}

## YOUR RESEARCH PROCESS

**Step 1 — Macro environment first (always)**
Call get_macro_indicators and get_sector_rotation before looking at individual stocks.
- What is the Fed doing? Is CPI trending up or down?
- Which sectors are leading today? Does that match Sam Weiss's outlook?
- Is the yield curve signaling risk-on or risk-off?

**Step 2 — Extract tickers from Sam Weiss data**
Pull every stock ticker mentioned in the daily briefing, trades, watchlist, and portfolios.

**Step 3 — Research each ticker across ALL signals**

For every ticker, run these in parallel where possible:

1. **Sam Weiss Signal** — What is he saying/holding/trading on this stock specifically?

2. **Sector Rotation Fit** — Does this stock's sector align with today's leading sectors?

3. **Macro Tailwind/Headwind** — Does the current macro environment (rates, CPI, Fed policy) help or hurt this stock?

4. **Influential Mentions** — Has the President, Jensen Huang, Elon Musk, or other major figures recently mentioned this stock or sector? Use web_search.

5. **Insider Buying** — Officers or board members buying? Use get_insider_activity.

6. **Hedge Fund Activity** — Major funds building positions? Use get_insider_activity.

7. **52-Week High/Low** — Near 52W low = opportunity, breaking to new high = momentum. Use get_market_data.

8. **Analyst Ratings** — Recent buy/sell/hold consensus. Use get_market_data.

9. **Reddit/Social Sentiment** — Retail sentiment on r/wallstreetbets, r/stocks, StockTwits. Use get_reddit_sentiment. Contrarian signal if WSB is extremely one-sided.

## OUTPUT FORMAT

### MACRO SNAPSHOT
- Fed stance + next meeting date
- CPI trend + direction
- Yield curve signal (risk-on / risk-off)
- Leading sectors today vs. Sam Weiss's outlook alignment

### SECTOR ROTATION TABLE
| Sector | ETF | 1D Change | Position vs 52W High | Signal |

### SIGNAL SUMMARY TABLE
| Ticker | SW Signal | Sector Fit | Macro | 52W | Analyst | Insider | Reddit | Influential | Score /10 |

### TOP RECOMMENDATIONS (Ranked by conviction)
For each:
- **[TICKER]** — BUY / SELL / WATCH
- Conviction: HIGH / MEDIUM / LOW
- Rationale: 3-4 sentences synthesizing ALL signals including macro + sector context
- Entry: price range or trigger condition
- Position size: % of portfolio (respecting 5% max per trade rule)
- Risk: key downside scenario

### WATCHLIST
Tickers with 1-2 signals firing but not enough confluence yet.

### MACRO ALERTS
Any upcoming Fed meetings, CPI prints, or economic events in the next 30 days that could move positions.`;
}

// ─── Main agentic loop ────────────────────────────────────────────────────────
async function run() {
  const scrape = loadLatestScrape();
  const systemPrompt = buildPrompt(scrape);

  console.log('\nStarting analysis agent...\n');

  const messages = [{ role: 'user', content: systemPrompt }];
  let response;
  let iterations = 0;
  const MAX_ITERATIONS = 20;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8192,
      tools,
      messages,
    });

    console.log(`[Iter ${iterations}] stop_reason: ${response.stop_reason}, content blocks: ${response.content.length}`);

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const toolUse of toolUses) {
        console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input)})`);
        const result = await executeTool(toolUse.name, toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: 'user', content: toolResults });
    }
  }

  // Extract final text
  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');

  const outPath = `./output/recommendations-${new Date().toISOString().split('T')[0]}.md`;
  writeFileSync(outPath, finalText);
  console.log(`\nReport saved to ${outPath}\n`);
  console.log('─'.repeat(80));
  console.log(finalText);
}

run().catch(console.error);
