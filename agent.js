import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FMP_KEY = process.env.FMP_API_KEY;
const KB_DIR = join(__dirname, 'output/knowledge-base');
const OUTPUT_DIR = join(__dirname, 'output');
mkdirSync(OUTPUT_DIR, { recursive: true });

const MODE = process.argv[2] || 'analyze'; // analyze | eod

// ─── Knowledge Base Loader ────────────────────────────────────────────────────
function loadKBFile(filename, maxChars = 20000) {
  const path = join(KB_DIR, filename);
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf-8');
  return content.length > maxChars ? content.slice(0, maxChars) + '\n[...truncated]' : content;
}

function loadLatestBriefings(count = 30) {
  const dir = join(KB_DIR, 'briefings');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).sort().reverse().slice(0, count);
  return files.map(f => readFileSync(join(dir, f), 'utf-8').slice(0, 4000)).join('\n\n---\n\n');
}

function searchBriefingsForTicker(ticker) {
  const dir = join(KB_DIR, 'briefings');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).sort().reverse();
  const matches = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf-8');
    if (content.toUpperCase().includes(ticker.toUpperCase())) {
      matches.push({ file: f, excerpt: content.slice(0, 3000) });
      if (matches.length >= 10) break;
    }
  }
  return matches;
}

function loadPortfolios() {
  const dir = join(KB_DIR, 'portfolios');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf-8').slice(0, 2500)).join('\n\n');
}

function loadDailyScrape() {
  const files = readdirSync(OUTPUT_DIR).filter(f => f.startsWith('sam-weiss-')).sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(OUTPUT_DIR, files[0]), 'utf-8')); } catch { return null; }
}

// ─── Learning System — Persistent Files ──────────────────────────────────────
const TRADES_LOG_FILE    = join(OUTPUT_DIR, 'trades-log.json');
const ACCURACY_FILE      = join(OUTPUT_DIR, 'signal-accuracy.json');
const WATCHLIST_FILE     = join(OUTPUT_DIR, 'watchlist-tomorrow.json');

const SIGNAL_KEYS = [
  'rsi_oversold', 'macro_tailwind', 'sector_leading', 'news_catalyst',
  'notable_mention', 'insider_buying', 'institutional_growing',
  'earnings_beater', 'contrarian_social', 'analyst_conviction',
];

function loadTradesLog() {
  if (!existsSync(TRADES_LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(TRADES_LOG_FILE, 'utf-8')); } catch { return { trades: [] }; }
}

function saveTradesLog(log) {
  writeFileSync(TRADES_LOG_FILE, JSON.stringify(log, null, 2));
}

function loadSignalAccuracy() {
  if (!existsSync(ACCURACY_FILE)) return { lastUpdated: null, totalTrades: 0, signals: {}, topCombinations: [] };
  try { return JSON.parse(readFileSync(ACCURACY_FILE, 'utf-8')); } catch { return { lastUpdated: null, totalTrades: 0, signals: {}, topCombinations: [] }; }
}

function loadTomorrowWatchlist() {
  if (!existsSync(WATCHLIST_FILE)) return [];
  try { return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf-8')).watchlist || []; } catch { return []; }
}

function recordTradeToLog(ticker, side, quantity, price, rationale, signals) {
  const log = loadTradesLog();
  const id = `${getDateStr(0)}-${ticker}-${side}-${Date.now()}`;
  log.trades.push({
    id,
    date: getDateStr(0),
    ticker,
    side,
    quantity,
    entryPrice: price,
    rationale,
    signals: signals || {},
    outcomes: { eod: null, '1d': null, '5d': null, '10d': null },
    open: true,
    closedDate: null,
    closedPrice: null,
  });
  saveTradesLog(log);
  return id;
}

async function updateTradeOutcomes() {
  const log = loadTradesLog();
  const today = getDateStr(0);
  const openTrades = log.trades.filter(t => t.open);
  if (!openTrades.length) return log;

  const tickers = [...new Set(openTrades.map(t => t.ticker))];
  const quotes = {};
  for (const ticker of tickers) {
    const q = await getQuote(ticker);
    if (q?.price) quotes[ticker] = q.price;
  }

  for (const trade of log.trades) {
    if (!trade.open) continue;
    const currentPrice = quotes[trade.ticker];
    if (!currentPrice || !trade.entryPrice) continue;

    const pnlPct = ((currentPrice - trade.entryPrice) / trade.entryPrice) * 100;
    const pnl = (currentPrice - trade.entryPrice) * trade.quantity;
    const daysHeld = Math.round((new Date(today) - new Date(trade.date)) / 86400000);

    const outcome = { price: currentPrice, pnlPct: +pnlPct.toFixed(2), pnl: +pnl.toFixed(2), recordedAt: new Date().toISOString() };

    if (!trade.outcomes.eod) trade.outcomes.eod = outcome;
    if (daysHeld >= 1  && !trade.outcomes['1d'])  trade.outcomes['1d']  = outcome;
    if (daysHeld >= 5  && !trade.outcomes['5d'])  trade.outcomes['5d']  = outcome;
    if (daysHeld >= 10 && !trade.outcomes['10d']) trade.outcomes['10d'] = outcome;
  }

  saveTradesLog(log);
  return log;
}

function computeSignalAccuracy(log) {
  const today = getDateStr(0);
  // Use 5-day outcome as the win/loss benchmark (enough time to escape noise)
  const scorableTrades = log.trades.filter(t => t.outcomes?.['5d']?.pnlPct !== null && t.outcomes?.['5d'] !== null);

  const signals = {};
  for (const key of SIGNAL_KEYS) {
    signals[key] = { fires: 0, wins: 0, losses: 0, winRate: null, avgReturn: null, returns: [] };
  }

  for (const trade of scorableTrades) {
    const pnlPct = trade.outcomes['5d']?.pnlPct;
    if (pnlPct === null || pnlPct === undefined) continue;
    const won = pnlPct > 0;

    for (const key of SIGNAL_KEYS) {
      if (trade.signals?.[key]) {
        signals[key].fires++;
        won ? signals[key].wins++ : signals[key].losses++;
        signals[key].returns.push(pnlPct);
      }
    }
  }

  // Compute rates
  for (const key of SIGNAL_KEYS) {
    const s = signals[key];
    if (s.fires > 0) {
      s.winRate = +(s.wins / s.fires).toFixed(3);
      s.avgReturn = +(s.returns.reduce((a, b) => a + b, 0) / s.returns.length).toFixed(2);
    }
    delete s.returns;
  }

  // Top 2-signal combinations
  const combos = {};
  for (const trade of scorableTrades) {
    const activeSignals = SIGNAL_KEYS.filter(k => trade.signals?.[k]);
    const pnlPct = trade.outcomes['5d']?.pnlPct;
    if (pnlPct === null || pnlPct === undefined) continue;
    const won = pnlPct > 0;

    for (let i = 0; i < activeSignals.length; i++) {
      for (let j = i + 1; j < activeSignals.length; j++) {
        const key = [activeSignals[i], activeSignals[j]].sort().join('+');
        if (!combos[key]) combos[key] = { fires: 0, wins: 0, returns: [] };
        combos[key].fires++;
        if (won) combos[key].wins++;
        combos[key].returns.push(pnlPct);
      }
    }
  }

  const topCombinations = Object.entries(combos)
    .filter(([, v]) => v.fires >= 3)
    .map(([key, v]) => ({
      signals: key.split('+'),
      fires: v.fires,
      winRate: +(v.wins / v.fires).toFixed(3),
      avgReturn: +(v.returns.reduce((a, b) => a + b, 0) / v.returns.length).toFixed(2),
    }))
    .sort((a, b) => b.winRate - a.winRate || b.avgReturn - a.avgReturn)
    .slice(0, 8);

  const accuracy = { lastUpdated: today, totalTrades: scorableTrades.length, signals, topCombinations };
  writeFileSync(ACCURACY_FILE, JSON.stringify(accuracy, null, 2));
  return accuracy;
}

function buildLearningsContext() {
  const accuracy = loadSignalAccuracy();
  const watchlist = loadTomorrowWatchlist();

  // Last 7 EOD reports (text excerpts)
  const eodFiles = readdirSync(OUTPUT_DIR).filter(f => f.startsWith('eod-report-')).sort().reverse().slice(0, 7);
  const recentEODs = eodFiles.map(f => {
    const content = readFileSync(join(OUTPUT_DIR, f), 'utf-8');
    return `### ${f.replace('eod-report-', '').replace('.md', '')}\n${content.slice(0, 1500)}`;
  }).join('\n\n');

  // Recent open trades
  const log = loadTradesLog();
  const recentTrades = log.trades.slice(-20).map(t => {
    const outcome5d = t.outcomes?.['5d'];
    const outcomeEOD = t.outcomes?.eod;
    const status = outcome5d
      ? `${outcome5d.pnlPct > 0 ? '✅' : '❌'} ${outcome5d.pnlPct > 0 ? '+' : ''}${outcome5d.pnlPct}% (5d)`
      : outcomeEOD
        ? `⏳ ${outcomeEOD.pnlPct > 0 ? '+' : ''}${outcomeEOD.pnlPct}% (EOD, still open)`
        : '⏳ pending';
    const activeSignals = SIGNAL_KEYS.filter(k => t.signals?.[k]).join(', ');
    return `${t.date}: ${t.side.toUpperCase()} ${t.quantity} ${t.ticker} @ $${t.entryPrice} → ${status} | Signals: [${activeSignals}]`;
  });

  let ctx = `═══════════════════════════════════════════════════════════════════════
LEARNING MEMORY — What This Agent Has Learned
═══════════════════════════════════════════════════════════════════════

`;

  if (accuracy.totalTrades > 0) {
    ctx += `### SIGNAL WIN RATES (from ${accuracy.totalTrades} completed trades, 5-day outcome)
`;
    const sorted = Object.entries(accuracy.signals)
      .filter(([, v]) => v.fires > 0)
      .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));

    for (const [key, v] of sorted) {
      const bar = '█'.repeat(Math.round((v.winRate || 0) * 10));
      ctx += `  ${key.padEnd(25)} ${bar.padEnd(10)} ${((v.winRate || 0) * 100).toFixed(0)}% win rate | avg return ${v.avgReturn > 0 ? '+' : ''}${v.avgReturn}% | ${v.fires} trades\n`;
    }

    if (accuracy.topCombinations.length) {
      ctx += `\n### BEST SIGNAL COMBINATIONS\n`;
      for (const c of accuracy.topCombinations) {
        ctx += `  [${c.signals.join(' + ')}] → ${(c.winRate * 100).toFixed(0)}% win rate | avg ${c.avgReturn > 0 ? '+' : ''}${c.avgReturn}% | ${c.fires} trades\n`;
      }
    }

    ctx += '\n';
  } else {
    ctx += `### SIGNAL WIN RATES\nNot enough completed trades yet (need at least 1 trade with 5-day outcome).\n\n`;
  }

  if (recentTrades.length) {
    ctx += `### RECENT TRADE OUTCOMES (last 20 trades)\n${recentTrades.join('\n')}\n\n`;
  }

  if (watchlist.length) {
    ctx += `### YESTERDAY'S WATCHLIST (carry forward — check these first)\n`;
    for (const w of watchlist) {
      ctx += `  ${w.ticker} — was $${w.priceAtEOD} | Entry trigger: ${w.entryTrigger} | Target: $${w.targetPrice} | Stop: $${w.stopLoss}\n  Reason: ${w.reason}\n\n`;
    }
  }

  if (recentEODs) {
    ctx += `### RECENT EOD LEARNINGS (last 7 days)\n${recentEODs}\n`;
  }

  ctx += `\nUSE THIS MEMORY TO:
- Weight higher-accuracy signals more heavily in your scoring
- Avoid signal combinations with poor track records
- Prioritize yesterday's watchlist tickers (you already did the research)
- Apply learnings from recent mistakes
- Adjust conviction thresholds based on what has actually worked`;

  return ctx;
}

// ─── Circuit Breaker State ─────────────────────────────────────────────────────
const CIRCUIT = {
  dailyPnL: 0,
  tradesExecuted: [],
  portfolioValueAtOpen: null,
  MAX_LOSS_PCT: 5,
  MAX_POSITION_PCT: 5,
  tripped: false,
};

function checkCircuitBreaker(portfolioValue) {
  if (!CIRCUIT.portfolioValueAtOpen) CIRCUIT.portfolioValueAtOpen = portfolioValue;
  const lossPct = (CIRCUIT.dailyPnL / CIRCUIT.portfolioValueAtOpen) * 100;
  if (lossPct <= -CIRCUIT.MAX_LOSS_PCT) {
    CIRCUIT.tripped = true;
    return { blocked: true, reason: `Daily loss limit: ${lossPct.toFixed(2)}% (max -${CIRCUIT.MAX_LOSS_PCT}%)` };
  }
  return { blocked: false };
}

function checkPositionSize(tradeAmount, portfolioValue) {
  const pct = (tradeAmount / portfolioValue) * 100;
  if (pct > CIRCUIT.MAX_POSITION_PCT) {
    const maxAmount = portfolioValue * (CIRCUIT.MAX_POSITION_PCT / 100);
    return { blocked: true, pct, maxAmount, reason: `${pct.toFixed(1)}% exceeds ${CIRCUIT.MAX_POSITION_PCT}% max` };
  }
  return { blocked: false, pct };
}

// ─── Robinhood MCP Client ─────────────────────────────────────────────────────
const RH_MCP_URL    = 'https://agent.robinhood.com/mcp/trading';
const TOKEN_URL     = 'https://api.robinhood.com/oauth2/token/';
let rhSessionId     = null;
let rhToken         = process.env.ROBINHOOD_ACCESS_TOKEN || null;
let rhAccountNumber = null; // cached after first get_accounts call

async function refreshRobinhoodToken() {
  const clientId     = process.env.ROBINHOOD_CLIENT_ID;
  const refreshToken = process.env.ROBINHOOD_REFRESH_TOKEN;
  if (!clientId || !refreshToken) return false;

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
    });
    if (!res.ok) return false;

    const { access_token, refresh_token } = await res.json();
    rhToken = access_token;

    // Persist new tokens back to .env
    let env = readFileSync(join(__dirname, '.env'), 'utf-8');
    env = env.replace(/^ROBINHOOD_ACCESS_TOKEN=.*$/m,  `ROBINHOOD_ACCESS_TOKEN=${access_token}`);
    env = env.replace(/^ROBINHOOD_REFRESH_TOKEN=.*$/m, `ROBINHOOD_REFRESH_TOKEN=${refresh_token}`);
    writeFileSync(join(__dirname, '.env'), env);
    console.log('  🔄 Robinhood token refreshed');
    return true;
  } catch { return false; }
}

async function rhPost(method, params, retrying = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (rhToken) headers['Authorization'] = `Bearer ${rhToken}`;
  if (rhSessionId) headers['mcp-session-id'] = rhSessionId;

  const res = await fetch(RH_MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  if (res.status === 401) {
    if (!retrying) {
      const refreshed = await refreshRobinhoodToken();
      if (refreshed) { rhSessionId = null; return rhPost(method, params, true); }
    }
    return { error: 'Robinhood authentication required. Run: node robinhood-auth.js' };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const newSession = res.headers.get('mcp-session-id');
  if (newSession) rhSessionId = newSession;

  // Robinhood MCP uses SSE (text/event-stream) — parse "data: {...}" lines
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    const raw = await res.text();
    const line = raw.split('\n').find(l => l.startsWith('data: '));
    if (!line) return { error: 'Empty SSE response' };
    return JSON.parse(line.slice(6));
  }
  return res.json();
}

async function rhEnsureSession() {
  if (rhSessionId) return;
  const payload = await rhPost('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'investing-tool', version: '1.0' },
  });
  if (payload?.error) throw new Error(payload.error);
}

async function rhGetAccountNumber() {
  if (rhAccountNumber) return rhAccountNumber;
  await rhEnsureSession();
  const payload = await rhPost('tools/call', { name: 'get_accounts', arguments: {} });
  const text = payload?.result?.content?.[0]?.text;
  if (!text) return null;
  const data = JSON.parse(text);
  const accounts = data?.data?.accounts || [];

  // Prefer the dedicated agentic account (agentic_allowed: true)
  // Fall back to default account if no agentic account exists yet
  const agenticAcct = accounts.find(a => a.agentic_allowed === true);
  const defaultAcct = accounts.find(a => a.is_default) || accounts[0];
  const acct = agenticAcct || defaultAcct;

  if (agenticAcct) {
    console.log(`  🤖 Using agentic account: ${acct.account_number}`);
  } else {
    console.log(`  ⚠️  No agentic account found — using main account ${acct?.account_number} (trades may be blocked)`);
    console.log(`     Set up agentic account at robinhood.com to enable autonomous trading`);
  }

  rhAccountNumber = acct?.account_number || null;
  return rhAccountNumber;
}

async function rhMCP(toolName, args = {}) {
  try {
    await rhEnsureSession();
    const payload = await rhPost('tools/call', { name: toolName, arguments: args });
    if (payload?.error) return { error: payload.error.message || JSON.stringify(payload.error) };
    const text = payload?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : payload?.result || payload;
  } catch (e) {
    return { error: e.message };
  }
}

// ─── FMP Market Data ──────────────────────────────────────────────────────────
function getDateStr(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

// FMP stable API (post-Aug 2025 free tier uses /stable/ not /api/v3/)
async function fmp(path) {
  if (!FMP_KEY) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://financialmodelingprep.com/stable/${path}${sep}apikey=${FMP_KEY}`;
    const r = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

// Yahoo Finance chart API — for ETFs and indices not available on FMP free tier
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function yahooQuote(symbol) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
      { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } }
    );
    if (r.status === 429) return null;
    const d = await r.json();
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prev = meta.chartPreviousClose;
    const changePercent = prev ? ((price - prev) / prev * 100) : null;
    return {
      symbol: meta.symbol,
      price,
      changePercent,
      yearHigh: meta.fiftyTwoWeekHigh,
      yearLow: meta.fiftyTwoWeekLow,
      volume: meta.regularMarketVolume,
      dayHigh: meta.regularMarketDayHigh,
      dayLow: meta.regularMarketDayLow,
    };
  } catch { return null; }
}

async function yahooQuotesBatch(symbols) {
  const results = [];
  for (const sym of symbols) {
    const q = await yahooQuote(sym);
    results.push(q);
    await sleep(80); // avoid 429 rate limit
  }
  return results;
}

// Compute RSI-14 from array of closing prices (oldest→newest)
function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = changes.slice(0, period).reduce((s, c) => s + (c > 0 ? c : 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + (c < 0 ? -c : 0), 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + (changes[i] > 0 ? changes[i] : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (changes[i] < 0 ? -changes[i] : 0)) / period;
  }
  if (avgLoss === 0) return '100.0';
  return (100 - 100 / (1 + avgGain / avgLoss)).toFixed(1);
}

async function getQuote(ticker) {
  const d = await fmp(`quote?symbol=${ticker}`);
  return Array.isArray(d) ? d[0] || null : null;
}

async function getFullMarketData(ticker) {
  const [quoteArr, profileArr, histArr, metricsArr] = await Promise.all([
    fmp(`quote?symbol=${ticker}`),
    fmp(`profile?symbol=${ticker}`),
    fmp(`historical-price-eod/light?symbol=${ticker}&limit=35`),
    fmp(`key-metrics-ttm?symbol=${ticker}`),
  ]);

  const toArr = v => Array.isArray(v) ? v : [];
  const q = toArr(quoteArr)[0] || null;
  const f = toArr(profileArr)[0] || null;
  const m = toArr(metricsArr)[0] || null;

  // Compute RSI from historical — FMP returns newest-first, reverse for computation
  const hist = toArr(histArr);
  const closes = hist.map(h => h.price).reverse();
  const rsi14 = computeRSI(closes);

  // Volume spike: compare today's to 20-day average
  const recent20 = hist.slice(0, 20).map(h => h.volume).filter(Boolean);
  const avgVol20 = recent20.length ? Math.round(recent20.reduce((a, b) => a + b, 0) / recent20.length) : null;

  return {
    ticker,
    price: q?.price,
    change1D: q?.changePercentage ?? q?.changesPercentage,
    yearHigh: q?.yearHigh,
    yearLow: q?.yearLow,
    pctFromHigh: q?.price && q?.yearHigh ? ((q.price - q.yearHigh) / q.yearHigh * 100).toFixed(1) : null,
    pctFromLow: q?.price && q?.yearLow ? ((q.price - q.yearLow) / q.yearLow * 100).toFixed(1) : null,
    ma50: q?.priceAvg50,
    ma200: q?.priceAvg200,
    volume: q?.volume,
    avgVolume: avgVol20,
    volumeVsAvg: avgVol20 && q?.volume ? ((q.volume / avgVol20 - 1) * 100).toFixed(0) + '%' : null,
    marketCap: q?.marketCap,
    peRatio: m?.peRatioTTM?.toFixed(1) ?? null,
    beta: f?.beta,
    sector: f?.sector,
    industry: f?.industry,
    rsi14,
    analystConsensus: [],
    nextEarnings: null,
    note: 'Use web_search for analyst ratings, earnings dates, insider trades, and news — FMP free tier does not include these.',
  };
}

async function getInsiderActivity(ticker) {
  // FMP insider/institutional endpoints require paid tier — use web_search in agent instead
  const news = await webSearch(`${ticker} insider trading SEC Form 4 buying selling 2026`, 6);
  return {
    ticker,
    recentInsiderTrades: [],
    topInstitutionalHolders: [],
    insiderSearchResults: news.results || [],
    note: 'FMP insider/institutional data requires paid tier. Results above are from web search of SEC Form 4 filings.',
  };
}

async function getStockNews(ticker) {
  // FMP news requires paid tier — use DuckDuckGo instead
  const [newsSearch, catalystSearch] = await Promise.all([
    webSearch(`${ticker} stock news today ${new Date().toISOString().slice(0, 7)}`, 5),
    webSearch(`${ticker} earnings revenue analyst upgrade downgrade 2026`, 5),
  ]);
  return [
    ...(newsSearch.results || []).map(r => ({ title: r.title, snippet: r.snippet, source: 'web', url: r.url })),
    ...(catalystSearch.results || []).map(r => ({ title: r.title, snippet: r.snippet, source: 'web', url: r.url })),
  ].slice(0, 10);
}

async function getEarningsSurprises(ticker) {
  // FMP earnings surprises require paid tier — use web_search
  const search = await webSearch(`${ticker} earnings results beat miss EPS surprise last 4 quarters`, 5);
  return {
    surprises: [],
    searchResults: search.results || [],
    note: 'FMP earnings surprise data requires paid tier. Use search results above for context.',
  };
}

async function getMacroIndicators() {
  // US Treasury publishes yield curve XML daily (free, no auth)
  let treasuryYields = null;
  try {
    const now = new Date();
    const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
    const r = await fetch(
      `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const xml = await r.text();
    // Extract the last entry (most recent trading day)
    const entries = xml.match(/<m:properties>[\s\S]*?<\/m:properties>/g) || [];
    if (entries.length) {
      const last = entries[entries.length - 1];
      const get = (tag) => { const m = last.match(new RegExp(`<d:${tag}[^>]*>([^<]*)<`)); return m?.[1] || null; };
      treasuryYields = {
        date: get('NEW_DATE')?.slice(0, 10),
        '3mo': get('BC_3MONTH'),
        '1yr': get('BC_1YEAR'),
        '2yr': get('BC_2YEAR'),
        '5yr': get('BC_5YEAR'),
        '10yr': get('BC_10YEAR'),
        '30yr': get('BC_30YEAR'),
      };
    }
  } catch {}

  // Web search for current CPI/Fed rate context
  const macroSearch = await webSearch('Federal Reserve interest rate CPI inflation FOMC 2026', 5);

  return {
    treasuryYields,
    macroSearchResults: macroSearch.results || [],
    note: 'Treasury yields from US Treasury (live). Use web_search for FOMC decisions, CPI prints, and macro events.',
  };
}

async function getFearGreedAndVIX() {
  const results = {};
  try {
    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    results.fearGreed = {
      score: d?.fear_and_greed?.score,
      rating: d?.fear_and_greed?.rating,
      previousClose: d?.fear_and_greed?.previous_close,
      oneWeekAgo: d?.fear_and_greed?.one_week_ago,
      oneMonthAgo: d?.fear_and_greed?.one_month_ago,
    };
  } catch {}
  // VIX from FMP (works as index), indices from Yahoo Finance (ETFs/indices unavailable on FMP free)
  try {
    const vixArr = await fmp('quote?symbol=%5EVIX');
    const vix = Array.isArray(vixArr) ? vixArr[0] : null;
    if (vix) results.vix = { price: vix.price, change: vix.changePercentage ?? vix.changesPercentage };
  } catch {}
  try {
    const [spy, qqq, iwm] = await yahooQuotesBatch(['SPY', 'QQQ', 'IWM']);
    results.indices = [spy, qqq, iwm].filter(Boolean).map(q => ({
      ticker: q.symbol, price: q.price, change: q.changePercent?.toFixed(2), yearHigh: q.yearHigh, yearLow: q.yearLow,
    }));
  } catch {}
  return results;
}

async function getEarningsCalendar() {
  const search = await webSearch('earnings calendar this week next week 2026 results expected', 6);
  return { results: search.results || [], note: 'FMP earnings calendar requires paid tier. Using web search.' };
}

async function getSectorRotation() {
  const SECTOR_ETFS = {
    Technology: 'XLK', Financials: 'XLF', Energy: 'XLE', Healthcare: 'XLV',
    Industrials: 'XLI', Communication: 'XLC', RealEstate: 'XLRE',
    Utilities: 'XLU', ConsumerStaples: 'XLP', ConsumerDisc: 'XLY', Materials: 'XLB',
  };
  // Yahoo Finance for ETF quotes (FMP free tier doesn't support ETF symbols)
  const etfSymbols = Object.values(SECTOR_ETFS);
  const yahooQuotes = await yahooQuotesBatch(etfSymbols);
  const quoteMap = {};
  yahooQuotes.filter(Boolean).forEach(q => { quoteMap[q.symbol] = q; });

  const quoteResults = Object.entries(SECTOR_ETFS).map(([sector, sym]) => {
      const q = quoteMap[sym];
      if (!q) return null;
      return {
        sector,
        ticker: sym,
        price: q.price,
        change1D: q.changePercent?.toFixed(2),
        pctFromHigh: q.yearHigh ? ((q.price - q.yearHigh) / q.yearHigh * 100).toFixed(1) : null,
      };
    });
  const sectors = quoteResults.filter(Boolean).sort((a, b) => parseFloat(b.change1D) - parseFloat(a.change1D));
  return { date: getDateStr(0), leadingSectors: sectors.slice(0, 4), laggingSectors: sectors.slice(-4), all: sectors };
}

async function getRedditSentiment(ticker) {
  const results = [];
  for (const sub of ['wallstreetbets', 'stocks', 'investing']) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${ticker}&sort=top&t=week&limit=5`, { headers: { 'User-Agent': 'investing-tool/1.0' } });
      const d = await r.json();
      const posts = (d?.data?.children || []).map(p => ({ title: p.data.title, score: p.data.score, comments: p.data.num_comments }));
      if (posts.length) results.push({ subreddit: sub, posts });
    } catch {}
  }
  try {
    const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
    const d = await r.json();
    const messages = (d?.messages || []).slice(0, 8).map(m => ({ text: m.body, sentiment: m.entities?.sentiment?.basic || 'Neutral' }));
    if (messages.length) results.push({ subreddit: 'StockTwits', posts: messages });
  } catch {}
  return { ticker, sources: results };
}

// ─── Web Search (DuckDuckGo HTML scrape) ─────────────────────────────────────
async function webSearch(query, maxResults = 8) {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    const html = await r.text();
    const results = [];
    const regex = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = regex.exec(html)) !== null && results.length < maxResults) {
      let href = m[1];
      if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
        try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {}
      }
      results.push({ title: m[2].trim(), url: href, snippet: m[3].replace(/<[^>]+>/g, '').trim() });
    }
    if (results.length === 0) {
      const re2 = /class="result__a"[^>]*>([^<]+)<\/a>|class="result__snippet"[^>]*>([^<]+)<\/a>/g;
      const titles = [], snippets = [];
      let m2;
      while ((m2 = re2.exec(html)) !== null) {
        if (m2[1]) titles.push(m2[1].trim());
        if (m2[2]) snippets.push(m2[2].replace(/<[^>]+>/g, '').trim());
      }
      for (let i = 0; i < Math.min(maxResults, titles.length); i++) {
        results.push({ title: titles[i], snippet: snippets[i] || '' });
      }
    }
    return { query, results };
  } catch (e) {
    return { query, error: e.message, results: [] };
  }
}

// ─── Notable Mentions: Politicians, CEOs, Influential Investors ───────────────
async function getNotableMentions(ticker) {
  const searches = await Promise.all([
    webSearch(`${ticker} stock Trump tariff trade deal executive order 2025 2026`),
    webSearch(`${ticker} Jensen Huang Elon Musk CEO mention 2025 2026`),
    webSearch(`${ticker} Nancy Pelosi Congress trade disclosure 2025`),
    webSearch(`${ticker} Warren Buffett Berkshire Ackman Cathie Wood position`),
    webSearch(`${ticker} analyst upgrade downgrade price target ${new Date().getFullYear()}`),
  ]);
  return {
    ticker,
    politicalMentions: searches[0].results,
    influentialCEOs: searches[1].results,
    congressionalTrades: searches[2].results,
    majorInvestors: searches[3].results,
    analystMoves: searches[4].results,
  };
}

// ─── General Web Search ───────────────────────────────────────────────────────
async function generalWebSearch(query) {
  return webSearch(query, 8);
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────
const tools = [
  {
    name: 'get_market_data',
    description: 'Get comprehensive market data for a ticker: price, 52-week range, RSI-14, volume vs average, P/E, beta, sector, analyst ratings, next earnings date, DCF price target',
    input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'Stock ticker e.g. NVDA, AAPL, QQQ' } }, required: ['ticker'] },
  },
  {
    name: 'get_news',
    description: 'Get the latest 8 news articles for a stock ticker from financial news sources',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_earnings_info',
    description: 'Get earnings surprise history (last 4 quarters) showing if company beats/misses EPS estimates',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_insider_activity',
    description: 'Get recent insider buying/selling and top institutional (hedge fund) holders for a ticker',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_macro_indicators',
    description: 'Get macro environment: upcoming Fed meetings, CPI/PCE releases, treasury yield curve, economic indicators. Call once at start.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_fear_greed_vix',
    description: 'Get CNN Fear & Greed Index score/rating, VIX level, and SPY/QQQ/IWM daily moves — the overall market sentiment picture',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_earnings_calendar',
    description: 'Get all earnings announcements in the next 14 days — use to avoid buying stocks right before earnings (high risk), or to identify post-earnings opportunities',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_sector_rotation',
    description: 'Get today\'s % performance across all 11 S&P sectors to identify rotation: which sectors are leading/lagging and where smart money is flowing',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_reddit_sentiment',
    description: 'Get Reddit (r/wallstreetbets, r/stocks, r/investing) and StockTwits sentiment for a ticker. High WSB activity = contrarian signal. Useful for identifying crowded trades.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'search_sam_weiss_briefings',
    description: 'Search through all 518 historical Sam Weiss daily briefings for mentions of a specific ticker or topic. Returns up to 10 matching briefings with excerpts. Use to understand Sam\'s historical view on a stock.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string', description: 'Ticker or keyword to search briefings for' } }, required: ['ticker'] },
  },
  {
    name: 'get_notable_mentions',
    description: 'Search web for recent influential mentions of a ticker: (1) Trump/White House executive orders, tariffs, trade deals mentioning the company; (2) Jensen Huang, Elon Musk, or other big tech CEO shoutouts; (3) Congressional trades (Pelosi, Senate disclosures); (4) Major investors (Buffett, Ackman, Cathie Wood positions); (5) Analyst upgrades/downgrades with price targets. HIGH SIGNAL — insider-adjacent intelligence.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'web_search',
    description: 'General DuckDuckGo web search. Use for: recent macro news ("Fed pivot news today"), specific catalyst research ("NVDA Blackwell demand update"), sector-specific news ("semiconductor tariff exemption"), or any ad-hoc research question.',
    input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] },
  },
  {
    name: 'get_portfolio',
    description: 'Get current Robinhood portfolio: total equity, buying power, and all open positions with P&L',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'place_trade',
    description: 'Execute a stock trade on Robinhood. Circuit breakers enforce 5% max position size and 5% daily loss limit. Pass ALL context fields — they are written to a permanent trade record used for self-learning and auditing.',
    input_schema: {
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        quantity: { type: 'number', description: 'Number of shares. Will auto-adjust if position size limit exceeded.' },
        rationale: { type: 'string', description: 'Full thesis: why this stock NOW — specific data points that drove the decision. Be explicit.' },
        score: { type: 'number', description: 'Final conviction score 1-10' },
        targetPrice: { type: 'number', description: 'Price target for exit (take profit)' },
        stopLoss: { type: 'number', description: 'Stop loss price — invalidation level' },
        catalystTimeline: { type: 'string', description: 'When do you expect the thesis to play out? e.g. "next 3-5 sessions", "post-FOMC next week"' },
        samAlignment: { type: 'string', description: 'Sam Weiss stance on this ticker — bullish/bearish/silent, and what his framework says' },
        marketContext: { type: 'string', description: 'Macro and market conditions at time of trade: VIX, Fear & Greed, sector performance, key macro events' },
        technicalSnapshot: {
          type: 'object',
          description: 'Key technical data at time of trade',
          properties: {
            price:        { type: 'number' },
            rsi14:        { type: 'number' },
            pctFromHigh:  { type: 'string' },
            pctFromLow:   { type: 'string' },
            ma50:         { type: 'number' },
            ma200:        { type: 'number' },
            volumeVsAvg:  { type: 'string' },
          },
        },
        signals: {
          type: 'object',
          description: 'Which signals were active (true) for this trade — learning system tracks accuracy over 5 days',
          properties: {
            rsi_oversold:         { type: 'boolean' },
            macro_tailwind:       { type: 'boolean' },
            sector_leading:       { type: 'boolean' },
            news_catalyst:        { type: 'boolean' },
            notable_mention:      { type: 'boolean' },
            insider_buying:       { type: 'boolean' },
            institutional_growing:{ type: 'boolean' },
            earnings_beater:      { type: 'boolean' },
            contrarian_social:    { type: 'boolean' },
            analyst_conviction:   { type: 'boolean' },
          },
        },
      },
      required: ['ticker', 'side', 'quantity', 'rationale', 'score'],
    },
  },
  {
    name: 'save_tomorrow_watchlist',
    description: 'Save tomorrow\'s watchlist at the end of EOD analysis. Call this ONCE at the end of EOD with all stocks you want to carry forward for tomorrow\'s session.',
    input_schema: {
      type: 'object',
      properties: {
        watchlist: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ticker:         { type: 'string' },
              priceAtEOD:     { type: 'number' },
              entryTrigger:   { type: 'string', description: 'Specific price or technical condition that triggers a buy tomorrow' },
              targetPrice:    { type: 'number' },
              stopLoss:       { type: 'number' },
              reason:         { type: 'string', description: 'Why this stock, which signals are aligned' },
              signalsToWatch: { type: 'array', items: { type: 'string' } },
            },
            required: ['ticker', 'reason'],
          },
        },
      },
      required: ['watchlist'],
    },
  },
];

// ─── Tool Executor ─────────────────────────────────────────────────────────────
async function executeTool(name, input) {
  switch (name) {
    case 'get_market_data':       return getFullMarketData(input.ticker);
    case 'get_news':              return getStockNews(input.ticker);
    case 'get_earnings_info':     return getEarningsSurprises(input.ticker);
    case 'get_insider_activity':  return getInsiderActivity(input.ticker);
    case 'get_macro_indicators':  return getMacroIndicators();
    case 'get_fear_greed_vix':    return getFearGreedAndVIX();
    case 'get_earnings_calendar': return getEarningsCalendar();
    case 'get_sector_rotation':   return getSectorRotation();
    case 'get_reddit_sentiment':  return getRedditSentiment(input.ticker);
    case 'search_sam_weiss_briefings': {
      const matches = searchBriefingsForTicker(input.ticker);
      return { ticker: input.ticker, matchCount: matches.length, matches };
    }
    case 'get_notable_mentions':   return getNotableMentions(input.ticker);
    case 'web_search':             return generalWebSearch(input.query);
    case 'get_portfolio': {
      const acct = await rhGetAccountNumber();
      if (!acct) return { error: 'Could not get Robinhood account. Run: node robinhood-auth.js' };

      const [portResult, posResult] = await Promise.all([
        rhMCP('get_portfolio', { account_number: acct }),
        rhMCP('get_equity_positions', { account_number: acct }),
      ]);

      if (portResult.error) return { error: portResult.error };

      const port = portResult?.data || portResult;
      const equity = parseFloat(port?.equity_value || port?.total_value || 0);
      if (equity) CIRCUIT.portfolioValueAtOpen = CIRCUIT.portfolioValueAtOpen || equity;

      return {
        accountNumber: acct,
        totalValue:   port?.total_value,
        equityValue:  port?.equity_value,
        cash:         port?.cash,
        buyingPower:  port?.buying_power?.buying_power,
        positions:    posResult?.data?.positions || [],
      };
    }
    case 'place_trade': {
      if (CIRCUIT.tripped) return { blocked: true, reason: 'Circuit breaker tripped — daily loss limit reached.' };
      const { ticker, side, quantity, rationale, signals, score } = input;
      console.log(`\n  📈 TRADE: ${side.toUpperCase()} ${quantity} ${ticker} (score: ${score || '?'}/10) — ${rationale}`);

      const portfolio = await rhMCP('get_portfolio');
      let adjustedQty = quantity;
      let entryPrice = null;

      const portfolioEquity = parseFloat(portfolio.equityValue || portfolio.totalValue || 0);
      if (!portfolio.error && portfolioEquity) {
        const cbCheck = checkCircuitBreaker(portfolioEquity);
        if (cbCheck.blocked) { console.log(`  ⛔ ${cbCheck.reason}`); return { blocked: true, reason: cbCheck.reason }; }

        const quote = await getQuote(ticker);
        entryPrice = quote?.price || null;
        if (entryPrice) {
          const sizeCheck = checkPositionSize(entryPrice * quantity, portfolioEquity);
          if (sizeCheck.blocked) {
            adjustedQty = Math.floor(sizeCheck.maxAmount / entryPrice);
            if (adjustedQty < 1) return { blocked: true, reason: `${sizeCheck.reason} — too large for minimum 1 share` };
            console.log(`  ⚡ Adjusted: ${quantity} → ${adjustedQty} shares (${sizeCheck.reason})`);
          }
        }
      }

      const acctNum = await rhGetAccountNumber();
      if (!acctNum) return { error: 'Could not get Robinhood account number.' };
      const result = await rhMCP('place_equity_order', {
        account_number: acctNum,
        symbol: ticker,
        side,
        type: 'market',
        quantity: adjustedQty,
        time_in_force: 'gfd',
      });
      if (result.error) { console.log(`  ❌ Failed: ${result.error}`); return result; }

      const { targetPrice, stopLoss, catalystTimeline, samAlignment, marketContext, technicalSnapshot } = input;
      const timestamp = new Date().toISOString();

      // Write detailed trade rationale file
      const tradesDir = join(OUTPUT_DIR, 'trades');
      mkdirSync(tradesDir, { recursive: true });
      const tradeSlug = `${getDateStr(0)}-${ticker}-${side}`;
      const activeSignals = signals ? Object.entries(signals).filter(([,v]) => v).map(([k]) => k) : [];
      const rationale_md = [
        `# Trade Record — ${side.toUpperCase()} ${adjustedQty} ${ticker}`,
        `**Date/Time:** ${timestamp}`,
        `**Score:** ${score}/10`,
        '',
        '## Decision Rationale',
        rationale,
        '',
        '## Position Parameters',
        `| | |`,
        `|---|---|`,
        `| Entry Price | $${entryPrice ?? 'market'} |`,
        `| Target Price | ${targetPrice ? '$' + targetPrice : 'not set'} |`,
        `| Stop Loss | ${stopLoss ? '$' + stopLoss : 'not set'} |`,
        `| Quantity | ${adjustedQty} shares |`,
        `| Max Gain | ${targetPrice && entryPrice ? (((targetPrice - entryPrice) / entryPrice) * 100).toFixed(1) + '%' : 'n/a'} |`,
        `| Max Loss | ${stopLoss && entryPrice ? (((stopLoss - entryPrice) / entryPrice) * 100).toFixed(1) + '%' : 'n/a'} |`,
        '',
        '## Catalyst Timeline',
        catalystTimeline || 'Not specified',
        '',
        '## Market Context at Entry',
        marketContext || 'Not recorded',
        '',
        '## Sam Weiss Alignment',
        samAlignment || 'Not checked',
        '',
        '## Technical Snapshot',
        technicalSnapshot ? [
          `- Price: $${technicalSnapshot.price}`,
          `- RSI-14: ${technicalSnapshot.rsi14}`,
          `- % from 52W High: ${technicalSnapshot.pctFromHigh}`,
          `- % from 52W Low: ${technicalSnapshot.pctFromLow}`,
          `- MA50: $${technicalSnapshot.ma50} | MA200: $${technicalSnapshot.ma200}`,
          `- Volume vs Avg: ${technicalSnapshot.volumeVsAvg}`,
        ].join('\n') : 'Not recorded',
        '',
        '## Active Signals',
        activeSignals.length ? activeSignals.map(s => `- ✅ ${s}`).join('\n') : 'None recorded',
        '',
        '## All Signal Verdicts',
        signals ? Object.entries(signals).map(([k, v]) => `- ${v ? '✅' : '❌'} ${k}`).join('\n') : 'Not recorded',
        '',
        '## 5-Day Outcome (filled at EOD +5)',
        '| Day | Price | P&L | Notes |',
        '|-----|-------|-----|-------|',
        '| D+1 | — | — | |',
        '| D+3 | — | — | |',
        '| D+5 | — | — | |',
        '',
        '## Robinhood Order Result',
        '```json',
        JSON.stringify(result, null, 2),
        '```',
      ].join('\n');

      writeFileSync(join(tradesDir, `${tradeSlug}.md`), rationale_md);

      // Record to learning log with full signal state
      const tradeId = recordTradeToLog(ticker, side, adjustedQty, entryPrice, rationale, signals);
      const record = { ticker, side, quantity: adjustedQty, entryPrice, targetPrice, stopLoss, rationale, score, signals, tradeId, timestamp, result };
      CIRCUIT.tradesExecuted.push(record);
      console.log(`  ✅ ${side.toUpperCase()} ${adjustedQty} ${ticker} @ $${entryPrice} [logged: ${tradeId}] → output/trades/${tradeSlug}.md`);
      return { success: true, ...record };
    }
    case 'save_tomorrow_watchlist': {
      const { watchlist } = input;
      writeFileSync(WATCHLIST_FILE, JSON.stringify({ date: getDateStr(0), watchlist }, null, 2));
      console.log(`  📋 Saved ${watchlist.length} tickers to tomorrow's watchlist`);
      return { success: true, savedCount: watchlist.length, tickers: watchlist.map(w => w.ticker) };
    }
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── System Prompt ────────────────────────────────────────────────────────────
function buildPrompt() {
  const dailyScrape = loadDailyScrape();
  const today = getDateStr(0);

  const todayBriefing = dailyScrape?.pages?.find(p => p.label === 'daily-briefing-latest')?.content
    || loadLatestBriefings(1).slice(0, 6000);
  const todayTrades = dailyScrape?.pages?.find(p => p.label === 'trades')?.content || '';
  const todayWatchlist = dailyScrape?.pages?.find(p => p.label === 'trade-watch')?.content
    || loadKBFile('trade-watchlist.md', 2000);

  return `You are a personal investing agent for Alvint. Today is ${today}.

Your job: do independent, broad market research first — then validate findings against Sam Weiss's fundamentals. Never anchor to Sam's view before you've done your own analysis.

${buildLearningsContext()}

═══════════════════════════════════════════════════════════════════════
RESEARCH PHILOSOPHY — READ THIS FIRST
═══════════════════════════════════════════════════════════════════════

You have two sources of intelligence:

1. **INDEPENDENT MARKET RESEARCH** — macro, technicals, sector rotation, news, notable
   mentions, insider activity, earnings, sentiment, web search. These are objective,
   real-time signals from the market itself.

2. **SAM WEISS INTELLIGENCE** — a professional investor's framework, daily briefings,
   and 18+ months of market analysis. Loaded at the END of this prompt.

THE CORRECT ORDER:
  → Research the market independently (Phases 1-3)
  → Form your own thesis on the best opportunities
  → THEN cross-check: does Sam agree or disagree?
  → His agreement strengthens conviction. His disagreement is a flag, not a veto.
  → A stock that looks great on 8/10 independent signals beats a Sam-mentioned
    stock with only 3/10 independent signals every time.

WHAT TO AVOID:
  ✗ Starting with "Sam likes NVDA, so let me research NVDA"
  ✗ Treating Sam's watchlist as the ticker list — he is one signal, not the thesis
  ✗ Anchoring price targets to Sam's cited levels without independent verification
  ✗ Skipping sectors Sam doesn't cover (energy, financials, industrials can all trade)

═══════════════════════════════════════════════════════════════════════
TOOLS AVAILABLE
═══════════════════════════════════════════════════════════════════════

  get_portfolio              → current holdings, buying power, P&L
  get_fear_greed_vix         → Fear & Greed score, VIX, SPY/QQQ/IWM
  get_macro_indicators       → Fed, CPI, PCE, treasury yields, economic calendar
  get_sector_rotation        → 11 S&P sectors ranked by 1D performance
  get_earnings_calendar      → earnings in next 14 days (avoid these!)
  get_market_data            → price, RSI-14, 52W high/low, volume, P/E, beta, analyst ratings
  get_news                   → 8 recent financial news articles per ticker
  get_notable_mentions       → Trump/White House, CEO shoutouts, Congressional trades,
                               major investor positions, analyst upgrades
  get_insider_activity       → C-suite buying/selling + institutional holders
  get_earnings_info          → earnings surprise history (beat/miss last 4 quarters)
  get_reddit_sentiment       → r/wallstreetbets, r/stocks, r/investing + StockTwits
  search_sam_weiss_briefings → search 535 historical briefings for Sam's view on a ticker
  web_search                 → DuckDuckGo search for any catalyst or macro news
  place_trade                → execute buy/sell on Robinhood (circuit breakers enforced)

═══════════════════════════════════════════════════════════════════════
EXECUTION ORDER — MARKET FIRST, SAM SECOND
═══════════════════════════════════════════════════════════════════════

PHASE 1 — INDEPENDENT MARKET CONTEXT
  1. get_portfolio           → current positions + buying power
  2. get_fear_greed_vix      → overall market temperature (VIX, F&G index, SPY/QQQ)
  3. get_macro_indicators    → Fed stance, CPI trend, yield curve, upcoming events
  4. get_sector_rotation     → which of 11 sectors are leading/lagging today
  5. get_earnings_calendar   → who's reporting in 14 days — these are off-limits

PHASE 2 — INDEPENDENT TICKER DISCOVERY (no Sam yet)
  From Phase 1 data, identify candidates independently:
  - Sector ETF leaders: what are the top individual stocks IN the leading sectors?
  - web_search "top gaining stocks today sector" for the leading sectors
  - web_search "stocks making new 52 week highs today" for momentum
  - web_search "analyst upgrades today stocks" for fresh institutional conviction
  - web_search "insider buying this week stocks" for smart money
  - web_search "Trump executive order stocks benefiting today" for political catalysts
  - web_search "earnings beat stocks this week" for momentum plays
  Build a candidate list of 8-15 tickers from MARKET signals before consulting Sam at all.

PHASE 3 — DEEP SIGNAL RESEARCH (per candidate)
  For each candidate from Phase 2:
  a. get_market_data        → RSI, 52W range, volume vs avg, P/E, beta
  b. get_news               → recent catalysts and headlines
  c. get_notable_mentions   → Trump, Jensen, Elon, Pelosi, Buffett, analyst moves
  d. get_insider_activity   → C-suite buying? Hedge funds accumulating?
  e. get_earnings_info      → consistent beater?
  f. get_reddit_sentiment   → crowded or contrarian?

PHASE 4 — SAM WEISS VALIDATION (cross-check your thesis)
  Now — and only now — bring in Sam's intelligence:
  g. search_sam_weiss_briefings for each high-scoring candidate
  Results mean:
  - Sam bullish on a stock you found independently → STRONG CONFIRMATION (+conviction)
  - Sam bearish on a stock you found independently → INVESTIGATE WHY (flag, not veto)
  - Sam bullish on something not in your list → add it, but score it on its own merits
  - Sam silent → proceed on your independent signals alone

PHASE 5 — SCORE & EXECUTE
  Score each ticker 1-10 (see scoring system below).
  For score ≥7: place_trade with the signals object filled in.
  For score 5-6: note in output as tomorrow's watchlist.

═══════════════════════════════════════════════════════════════════════
SCORING SYSTEM (out of 10) — ALL INDEPENDENT SIGNALS
═══════════════════════════════════════════════════════════════════════

Each signal is worth +1 if bullish. Sam's view does NOT add a point — it adjusts
your confidence in signals already scored, not the score itself.

  +1  RSI <50 and trending up (room to run without being overbought)
  +1  Macro tailwind (rate/inflation environment favors this sector)
  +1  Sector leading today with multi-day momentum (not a one-day bounce)
  +1  Clear news catalyst in last 48-72 hrs (product, contract, approval, deal)
  +1  Notable mention: Trump order, CEO shoutout, congressional buy, major investor
  +1  Insider buying (C-suite or board, not options exercise)
  +1  Institutional accumulation (active funds, not passive index)
  +1  Consistent earnings beater (3+ of last 4 quarters)
  +1  Contrarian social: bears dominating a fundamentally strong stock
  +1  Strong analyst conviction: 2+ recent upgrades or significant PT raise

Deductions:
  -2  Earnings in next 5 days (binary event risk)
  -1  RSI >70 (overbought — bad risk/reward)
  -1  Macro headwind for this sector
  -1  Heavy recent insider selling
  -1  Extreme Reddit bullishness (crowded trade)

Sam modifier (not scored, but adjusts position size):
  Sam bullish + score ≥7 → full position (up to 5% portfolio)
  Sam silent  + score ≥7 → standard position (up to 3%)
  Sam bearish + score ≥7 → smaller position (up to 2%) + extra scrutiny

Threshold: ≥7 = execute | 5-6 = watchlist | <5 = avoid

═══════════════════════════════════════════════════════════════════════
TRADING RULES (ENFORCED BY CIRCUIT BREAKERS)
═══════════════════════════════════════════════════════════════════════

- Max 5% of portfolio per trade (auto-adjusted)
- Stop all trading if daily loss exceeds 5%
- Stocks only — no options, no ETFs
- Market orders during market hours only
- Always call get_portfolio before sizing trades
- Check earnings calendar — no trades with earnings in <5 days

═══════════════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════════════

## MARKET OVERVIEW
- Fear & Greed: [score/rating/trend]
- VIX: [level] — [interpretation]
- SPY/QQQ/IWM: [% changes + context]
- Fed stance, CPI trend, yield curve signal

## SECTOR ROTATION
| Sector | ETF | 1D % | vs 52W High | Trend | Signal |

## INDEPENDENT CANDIDATE LIST (from Phase 2 web research)
List all tickers surfaced before Sam was consulted, with source.

## SIGNAL SUMMARY TABLE
| Ticker | Price | RSI | 52W% | Macro | Sector | News | Mention | Insider | Earnings | Reddit | Sam? | Score |

## TRADES EXECUTED
| Ticker | Side | Qty | Price | Score | Key signals |

## TOP RECOMMENDATIONS (Score ≥5)
**[TICKER]** — BUY/WATCH | Score: [x/10] | Sam: [agrees/disagrees/silent]
- Independent thesis: [why this stock, from market signals alone]
- Technical: RSI [x], [x]% from 52W high, volume [vs avg]
- Macro fit: [tailwind/headwind and why]
- Sector: [leading/lagging]
- News catalyst: [specific headline or "none"]
- Notable mention: [who said what, or "none"]
- Insider: [buying/selling/neutral]
- Earnings: [next date] + [beat track record]
- Reddit/Social: [sentiment + contrarian reading]
- Sam validation: [what Sam says about this stock, or "not mentioned"]
- Entry: [specific price or trigger]
- Position size: [% — full/standard/small based on Sam modifier]
- Invalidation: [what would make this thesis wrong]

## WATCHLIST (Score 5-6)

## EARNINGS RISK CALENDAR

## MACRO ALERTS (next Fed/CPI/PCE dates)

═══════════════════════════════════════════════════════════════════════
SAM WEISS INTELLIGENCE — VALIDATION LAYER (consult after Phase 3)
═══════════════════════════════════════════════════════════════════════

Sam Weiss is a professional investor whose analysis informs your risk sizing and
thesis validation — not your ticker selection. His framework:
  • Buy during corrections, hedge during rallies, sell covered calls, hold long-term
  • 2-year rule: always prepared to hold 2 years
  • NASDAQ corrections: end <20 sessions 90%+ of the time, post-correction rally 8-15%
  • RSI >70 = overbought, <30 = oversold
  • Quality over speculation: buy companies that survive any 2-year downturn

### TODAY'S DAILY BRIEFING (Sam)
${todayBriefing.slice(0, 5000)}

### TODAY'S TRADE ALERTS
${todayTrades.slice(0, 2000)}

### TODAY'S WATCHLIST
${todayWatchlist.slice(0, 2000)}

### MARKET OUTLOOK (Sam's Near/Intermediate/Long-Term View)
${loadKBFile('market-outlook.md', 4000)}

### LAST 14 DAYS OF BRIEFINGS
${loadLatestBriefings(5).slice(0, 6000)}

### PORTFOLIO POSITIONS (what Sam currently holds)
${loadPortfolios().slice(0, 4000)}

### NASDAQ CORRECTION/RALLY PATTERNS (2007-2025)
${loadKBFile('nasdaq-historical.md', 3000)}`;
}

// ─── Email Delivery ───────────────────────────────────────────────────────────
async function sendEODEmail(reportText, today) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.log('  ⚠️  Email skipped — set GMAIL_USER and GMAIL_APP_PASSWORD in .env');
    return;
  }

  const accuracy = loadSignalAccuracy();
  const todayTrades = loadTradesLog().trades.filter(t => t.date === today);

  // Build a short subject line with P&L
  const totalPnl = todayTrades.reduce((sum, t) => sum + (t.outcomes?.eod?.pnl || 0), 0);
  const pnlStr = totalPnl >= 0 ? `+$${totalPnl.toFixed(0)}` : `-$${Math.abs(totalPnl).toFixed(0)}`;
  const tradeCount = todayTrades.length;
  const subject = `📈 EOD Report ${today} | ${pnlStr} | ${tradeCount} trade${tradeCount !== 1 ? 's' : ''}`;

  // HTML version of the report
  const html = `
<html><body style="font-family: monospace; max-width: 900px; margin: auto; padding: 24px;">
<h1 style="border-bottom: 2px solid #333;">📈 Investing Agent — EOD Report</h1>
<p style="color: #666;">${today}</p>

<div style="background: #f5f5f5; padding: 12px; border-radius: 6px; margin: 16px 0;">
  <strong>Daily P&L: ${pnlStr}</strong> | Trades: ${tradeCount}
  ${accuracy.totalTrades > 0 ? `| Best signal: ${Object.entries(accuracy.signals).sort((a,b) => (b[1].winRate||0)-(a[1].winRate||0))[0]?.[0]?.replace(/_/g,' ')} (${((Object.entries(accuracy.signals).sort((a,b)=>(b[1].winRate||0)-(a[1].winRate||0))[0]?.[1]?.winRate||0)*100).toFixed(0)}% win rate)` : ''}
</div>

<pre style="white-space: pre-wrap; line-height: 1.5;">${reportText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>

<hr>
<p style="color: #999; font-size: 12px;">Generated by your personal investing agent • ${new Date().toISOString()}</p>
</body></html>`;

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });

  try {
    await transporter.sendMail({
      from: `Investing Agent <${user}>`,
      to: user,
      subject,
      text: reportText,
      html,
    });
    console.log(`  ✉️  EOD email sent to ${user}`);
  } catch (e) {
    console.error(`  ❌ Email failed: ${e.message}`);
  }
}

// ─── EOD Report ────────────────────────────────────────────────────────────────
async function generateEODReport() {
  const today = getDateStr(0);
  console.log('  Updating trade outcomes from market close prices...');
  const log = await updateTradeOutcomes();
  const accuracy = computeSignalAccuracy(log);

  const portfolio = await rhMCP('get_portfolio');
  const [fearGreed, sectors] = await Promise.all([getFearGreedAndVIX(), getSectorRotation()]);

  // All trades executed today (from this session + trades-log)
  const todayTrades = log.trades.filter(t => t.date === today);

  // All open positions
  const openTrades = log.trades.filter(t => t.open);

  const eodTools = tools.filter(t => ['get_market_data', 'get_news', 'get_fear_greed_vix', 'get_sector_rotation', 'save_tomorrow_watchlist'].includes(t.name));

  const prompt = `You are generating the end-of-day investing report for ${today}.

## TODAY'S TRADES
${JSON.stringify(todayTrades, null, 2)}

## ALL OPEN POSITIONS (across all days)
${JSON.stringify(openTrades, null, 2)}

## SIGNAL ACCURACY (from all completed 5-day outcomes)
${JSON.stringify(accuracy, null, 2)}

## PORTFOLIO AT CLOSE
${JSON.stringify(portfolio, null, 2)}

## MARKET CLOSE
- Fear & Greed: ${JSON.stringify(fearGreed.fearGreed)}
- VIX: ${JSON.stringify(fearGreed.vix)}
- Indices: ${JSON.stringify(fearGreed.indices)}
- Leading sectors: ${JSON.stringify(sectors?.leadingSectors)}
- Lagging sectors: ${JSON.stringify(sectors?.laggingSectors)}

## SAM WEISS CONTEXT
${loadLatestBriefings(3).slice(0, 4000)}

## INSTRUCTIONS

Generate a thorough EOD report with these exact sections:

### 1. P&L SUMMARY
- Per trade today: ticker, entry price, close price (use get_market_data), P&L $, P&L %
- Daily total P&L vs QQQ benchmark (QQQ close via get_market_data)
- Running portfolio P&L across all open positions

### 2. SIGNAL ACCURACY REVIEW — TODAY
For each signal that was active in today's trades:
- Did RSI oversold lead to a positive move today?
- Did the notable mention signal pay off?
- Which signals fired correctly vs incorrectly today?
- Compare to historical win rates from the accuracy data above

### 3. KEY LEARNINGS
- What worked today and why?
- What failed and why?
- What would you do differently tomorrow?
- Any pattern from the cumulative signal accuracy that should change how we score tomorrow?
- How did today's market behavior compare to Sam's framework and macro forecast?

### 4. OPEN POSITIONS REVIEW
For each open position:
- Get current price via get_market_data
- Is the original thesis still valid?
- RSI now vs when we bought
- Add more, hold, or trim?
- Stop loss level

### 5. TOMORROW'S WATCHLIST
Use get_news and get_market_data to research 3-6 candidates.
Then call save_tomorrow_watchlist with the structured data.
Each entry needs: ticker, priceAtEOD, entryTrigger, targetPrice, stopLoss, reason, signalsToWatch

### 6. STRATEGY ALIGNMENT SCORE
Rate today 1-10: alignment with Sam's 4-part framework.
- Were we buying corrections or chasing rallies?
- Did we respect the 2-year time horizon mindset?
- Did circuit breakers protect us?`;

  const messages = [{ role: 'user', content: prompt }];
  let response;
  let iterations = 0;

  while (iterations < 12) {
    iterations++;
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 6000,
      tools: eodTools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const tu of response.content.filter(b => b.type === 'tool_use')) {
        console.log(`  [EOD] → ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
        const result = await executeTool(tu.name, tu.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  const reportText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const reportPath = join(OUTPUT_DIR, `eod-report-${today}.md`);
  writeFileSync(reportPath, `# EOD Report — ${today}\n\n${reportText}`);
  console.log(`\nEOD report: ${reportPath}`);

  await sendEODEmail(reportText, today);
  return reportText;
}

// ─── Main Agentic Loop ────────────────────────────────────────────────────────
async function run() {
  if (MODE === 'eod') {
    console.log('\nGenerating EOD report...\n');
    const report = await generateEODReport();
    console.log(report);
    return;
  }

  console.log('\n🚀 Starting investing agent...\n');
  const messages = [{ role: 'user', content: buildPrompt() }];
  let response;
  let iterations = 0;

  while (iterations < 20) {
    iterations++;
    response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      tools,
      messages,
    });

    console.log(`[Iter ${iterations}] stop: ${response.stop_reason}, blocks: ${response.content.length}`);
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 100)})`);
        const result = await executeTool(tu.name, tu.input);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  }

  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const today = getDateStr(0);
  const outPath = join(OUTPUT_DIR, `recommendations-${today}.md`);

  const header = CIRCUIT.tradesExecuted.length
    ? `# Investing Report — ${today}\n\n## Trades Executed\n${CIRCUIT.tradesExecuted.map(t => `- ${t.side.toUpperCase()} ${t.quantity} ${t.ticker}: ${t.rationale}`).join('\n')}\n\n`
    : `# Investing Report — ${today}\n\n`;

  writeFileSync(outPath, header + finalText);
  console.log(`\n✅ Report: ${outPath}`);
  console.log('─'.repeat(80));
  console.log(finalText);
}

run().catch(console.error);
