import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FMP_KEY   = process.env.FMP_API_KEY;
// DRY_RUN=true by default — set DRY_RUN=false in .env only after verifying full cycle runs cleanly
const DRY_RUN   = process.env.DRY_RUN !== 'false';

const OUTPUT_DIR = join(__dirname, 'output');
const KB_DIR     = join(__dirname, 'output/knowledge-base');
mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync(join(OUTPUT_DIR, 'trades'), { recursive: true });

const MODE = process.argv[2] || 'scan'; // scan | check | force-close | eod

// ─── Market Calendar ──────────────────────────────────────────────────────────
// NYSE/NASDAQ full closures 2026 (PT dates)
const US_MARKET_HOLIDAYS_2026 = new Set([
  '2026-01-01', // New Year's Day
  '2026-01-19', // MLK Day
  '2026-02-16', // Presidents' Day
  '2026-04-03', // Good Friday
  '2026-05-25', // Memorial Day
  '2026-07-03', // Independence Day (observed, Jul 4 is Sat)
  '2026-09-07', // Labor Day
  '2026-11-26', // Thanksgiving
  '2026-12-25', // Christmas Day
]);

// Early close days (1pm ET = 10am PT): skip force-close at 12:45pm PT for these
const EARLY_CLOSE_DATES = new Set(['2026-11-27', '2026-12-24']);

function getDateStr(daysFromNow = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

const today      = getDateStr(0);
const dayOfWeek  = new Date().getDay(); // 0=Sun, 6=Sat

if (dayOfWeek === 0 || dayOfWeek === 6 || US_MARKET_HOLIDAYS_2026.has(today)) {
  console.log(`[${MODE}] Market closed today (${today}) — skipping.`);
  process.exit(0);
}

// ─── Constants ────────────────────────────────────────────────────────────────
const SIGNAL_KEYS = [
  'premarket_gap_up',    // gap >2% pre-market on elevated volume
  'rvol_spike',          // relative volume >2x 30-day pre-market avg
  'gap_fill_low_prob',   // historical patterns suggest gap holds (momentum)
  'macro_tailwind',      // macro/VIX environment favorable for risk-on
  'sector_leading',      // sector ETF up strongly pre-market
  'news_catalyst',       // clear overnight/pre-market catalyst
  'notable_mention',     // Trump/CEO/Congress/major investor mention
  'insider_buying',      // recent Form 4 C-suite buy (context, not same-day)
  'contrarian_social',   // overnight chatter spike on bearish tone → fade
  'analyst_conviction',  // 2+ recent upgrades or significant PT raise
];

const OPEN_POSITIONS_FILE  = join(OUTPUT_DIR, 'trades-open.json');
const TRADES_LOG_FILE      = join(OUTPUT_DIR, 'trades-log.json');
const SIGNAL_WEIGHTS_FILE  = join(OUTPUT_DIR, 'signal-weights.json');
const WATCHLIST_FILE       = join(OUTPUT_DIR, 'watchlist-tomorrow.json');

// ─── Atomic File Write ────────────────────────────────────────────────────────
// Uses rename which is atomic on POSIX — prevents corruption from concurrent runs
function atomicWrite(path, data) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

// ─── Open Positions (same-day) ────────────────────────────────────────────────
function loadOpenPositions() {
  if (!existsSync(OPEN_POSITIONS_FILE)) return { date: today, positions: [] };
  try {
    const data = JSON.parse(readFileSync(OPEN_POSITIONS_FILE, 'utf-8'));
    // Reset if stale (from a previous day)
    if (data.date !== today) return { date: today, positions: [] };
    return data;
  } catch { return { date: today, positions: [] }; }
}

function saveOpenPositions(positions) {
  atomicWrite(OPEN_POSITIONS_FILE, { date: today, positions });
}

function addOpenPosition(pos) {
  const data = loadOpenPositions();
  data.positions = data.positions.filter(p => p.ticker !== pos.ticker);
  data.positions.push(pos);
  saveOpenPositions(data.positions);
}

function removeOpenPosition(ticker) {
  const data = loadOpenPositions();
  saveOpenPositions(data.positions.filter(p => p.ticker !== ticker));
}

// ─── Trades Log ───────────────────────────────────────────────────────────────
function loadTradesLog() {
  if (!existsSync(TRADES_LOG_FILE)) return { trades: [] };
  try { return JSON.parse(readFileSync(TRADES_LOG_FILE, 'utf-8')); } catch { return { trades: [] }; }
}

function recordClosedTrade(entry) {
  const log = loadTradesLog();
  log.trades.push(entry);
  atomicWrite(TRADES_LOG_FILE, log);
}

// ─── Logistic Regression (pure JS, no dependencies) ──────────────────────────
function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }

function trainModel(trades) {
  const MIN_TRADES = 60;
  const complete = trades.filter(t => t.pnl !== null && t.pnl !== undefined && t.signals);
  if (complete.length < MIN_TRADES) return null; // fall back to equal-weight

  const features = complete.map(t => SIGNAL_KEYS.map(k => (t.signals?.[k] ? 1 : 0)));
  const labels   = complete.map(t => (t.pnl > 0 ? 1 : 0));

  let weights = new Array(SIGNAL_KEYS.length).fill(0);
  let bias    = 0;
  const lr = 0.05, lambda = 0.01, epochs = 500;
  const n  = features.length;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const dW = new Array(SIGNAL_KEYS.length).fill(0);
    let db = 0;
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(features[i].reduce((s, f, j) => s + f * weights[j], 0) + bias);
      const err  = pred - labels[i];
      features[i].forEach((f, j) => { dW[j] += err * f; });
      db += err;
    }
    weights = weights.map((w, j) => w - lr * (dW[j] / n + lambda * w));
    bias   -= lr * (db / n);
  }

  return { weights, bias, trainedOn: complete.length, lastUpdated: today };
}

function predictWin(signals, modelData) {
  if (!modelData) {
    // Equal-weight fallback: count active signals / total
    const active = SIGNAL_KEYS.filter(k => signals[k]).length;
    return active / SIGNAL_KEYS.length;
  }
  const { weights, bias } = modelData;
  const z = SIGNAL_KEYS.reduce((s, k, j) => s + (signals[k] ? 1 : 0) * weights[j], 0) + bias;
  return sigmoid(z);
}

function loadSignalWeights() {
  if (!existsSync(SIGNAL_WEIGHTS_FILE)) return null;
  try { return JSON.parse(readFileSync(SIGNAL_WEIGHTS_FILE, 'utf-8')); } catch { return null; }
}

// ─── Knowledge Base Loaders ───────────────────────────────────────────────────
function loadKBFile(filename, maxChars = 20000) {
  const path = join(KB_DIR, filename);
  if (!existsSync(path)) return '';
  const content = readFileSync(path, 'utf-8');
  return content.length > maxChars ? content.slice(0, maxChars) + '\n[...truncated]' : content;
}

function loadLatestBriefings(count = 5) {
  const dir = join(KB_DIR, 'briefings');
  if (!existsSync(dir)) return '';
  const files = readdirSync(dir).sort().reverse().slice(0, count);
  return files.map(f => readFileSync(join(dir, f), 'utf-8').slice(0, 2000)).join('\n\n---\n\n');
}

function searchBriefingsForTicker(ticker) {
  const dir = join(KB_DIR, 'briefings');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).sort().reverse();
  const matches = [];
  for (const f of files) {
    const content = readFileSync(join(dir, f), 'utf-8');
    if (content.toUpperCase().includes(ticker.toUpperCase())) {
      matches.push({ file: f, excerpt: content.slice(0, 2000) });
      if (matches.length >= 8) break;
    }
  }
  return matches;
}

function loadPortfolios() {
  const dir = join(KB_DIR, 'portfolios');
  if (!existsSync(dir)) return '';
  return readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf-8').slice(0, 2000)).join('\n\n');
}

function loadDailyScrape() {
  const files = readdirSync(OUTPUT_DIR).filter(f => f.startsWith('sam-weiss-')).sort().reverse();
  if (!files.length) return null;
  try { return JSON.parse(readFileSync(join(OUTPUT_DIR, files[0]), 'utf-8')); } catch { return null; }
}

// ─── Learnings Context ────────────────────────────────────────────────────────
function buildLearningsContext() {
  const weights = loadSignalWeights();
  const watchlist = loadTomorrowWatchlist();
  const log = loadTradesLog();
  const recentTrades = log.trades.slice(-15).map(t => {
    const status = t.pnl !== null ? `${t.pnl > 0 ? '✅' : '❌'} ${t.pnl > 0 ? '+' : ''}$${t.pnl?.toFixed(2)} (${t.pnlPct?.toFixed(1)}%)` : '⏳ open';
    const active = SIGNAL_KEYS.filter(k => t.signals?.[k]).join(', ');
    return `${t.date}: ${t.side?.toUpperCase()} ${t.ticker} @ $${t.entryPrice} → closed @ $${t.exitPrice ?? '?'} | ${status} | Signals: [${active}]`;
  });

  let ctx = `═══════════════════════════════════════════════════════════════
LEARNING MEMORY
═══════════════════════════════════════════════════════════════
`;

  if (weights) {
    ctx += `\n### SIGNAL MODEL (trained on ${weights.trainedOn} trades, updated ${weights.lastUpdated})\n`;
    const coeffs = SIGNAL_KEYS.map((k, j) => ({ key: k, coef: weights.weights[j] }))
      .sort((a, b) => b.coef - a.coef);
    for (const { key, coef } of coeffs) {
      ctx += `  ${key.padEnd(25)} coef: ${coef >= 0 ? '+' : ''}${coef.toFixed(3)}\n`;
    }
    if (weights.validation) {
      ctx += `  Walk-forward: this week ${(weights.validation.thisWeekAccuracy * 100).toFixed(0)}% | last week ${(weights.validation.lastWeekAccuracy * 100).toFixed(0)}%\n`;
    }
  } else {
    ctx += `\n### SIGNAL MODEL\nNot yet trained (need 60+ completed trades). Using equal-weight P(win) scoring.\n`;
  }

  if (recentTrades.length) {
    ctx += `\n### RECENT TRADES (last 15)\n${recentTrades.join('\n')}\n`;
  }

  if (watchlist.length) {
    ctx += `\n### YESTERDAY'S WATCHLIST\n`;
    for (const w of watchlist) {
      ctx += `  ${w.ticker} — was $${w.priceAtEOD} | Trigger: ${w.entryTrigger} | Target: $${w.targetPrice} | Stop: $${w.stopLoss}\n`;
    }
  }
  return ctx;
}

function loadTomorrowWatchlist() {
  if (!existsSync(WATCHLIST_FILE)) return [];
  try { return JSON.parse(readFileSync(WATCHLIST_FILE, 'utf-8')).watchlist || []; } catch { return []; }
}

// ─── Circuit Breakers ─────────────────────────────────────────────────────────
const CIRCUIT = { tripped: false, tradesExecuted: [], weekStartBalance: null };

function checkCircuitBreaker(currentBalance, dailyPnl, weekStartBalance) {
  const dailyLossPct  = (dailyPnl / currentBalance) * 100;
  const weeklyLossPct = weekStartBalance ? ((currentBalance - weekStartBalance) / weekStartBalance) * 100 : 0;

  if (dailyLossPct <= -5) {
    CIRCUIT.tripped = true;
    return { blocked: true, reason: `Daily loss ${dailyLossPct.toFixed(2)}% exceeds -5% limit` };
  }
  if (weeklyLossPct <= -15) {
    CIRCUIT.tripped = true;
    return { blocked: true, reason: `Weekly drawdown ${weeklyLossPct.toFixed(2)}% exceeds -15% limit — manual review required` };
  }
  return { blocked: false };
}

function computePositionDollars(balance) {
  // 15-20% of balance, target midpoint 17.5%
  return Math.round(balance * 0.175);
}

function checkMaxConcurrent(openPositions) {
  if (openPositions.length >= 2) {
    return { blocked: true, reason: `Already at max 2 concurrent positions: ${openPositions.map(p => p.ticker).join(', ')}` };
  }
  return { blocked: false };
}

// ─── Robinhood MCP Client ─────────────────────────────────────────────────────
const RH_MCP_URL = 'https://agent.robinhood.com/mcp/trading';
const TOKEN_URL  = 'https://api.robinhood.com/oauth2/token/';
let rhSessionId  = null;
let rhToken      = process.env.ROBINHOOD_ACCESS_TOKEN || null;
let rhAccountNumber = null;

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
  if (rhToken)    headers['Authorization']   = `Bearer ${rhToken}`;
  if (rhSessionId) headers['mcp-session-id'] = rhSessionId;

  const res = await fetch(RH_MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });

  if (res.status === 401 && !retrying) {
    const refreshed = await refreshRobinhoodToken();
    if (refreshed) { rhSessionId = null; return rhPost(method, params, true); }
    return { error: 'Robinhood authentication required. Run: node robinhood-auth.js' };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };

  const newSession = res.headers.get('mcp-session-id');
  if (newSession) rhSessionId = newSession;

  const ct = res.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    const raw  = await res.text();
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
    clientInfo: { name: 'investing-tool', version: '2.0' },
  });
  if (payload?.error) throw new Error(payload.error);
}

async function rhGetAccountNumber() {
  if (rhAccountNumber) return rhAccountNumber;
  await rhEnsureSession();
  const payload  = await rhPost('tools/call', { name: 'get_accounts', arguments: {} });
  const text     = payload?.result?.content?.[0]?.text;
  if (!text) return null;
  const data     = JSON.parse(text);
  const accounts = data?.data?.accounts || [];
  const agenticAcct = accounts.find(a => a.agentic_allowed === true);
  const defaultAcct = accounts.find(a => a.is_default) || accounts[0];
  const acct        = agenticAcct || defaultAcct;
  if (agenticAcct) console.log(`  🤖 Using agentic account: ${acct.account_number}`);
  else console.log(`  ⚠️  No agentic account found — using ${acct?.account_number}`);
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
  } catch (e) { return { error: e.message }; }
}

// Execute a market sell — DRY_RUN safe
async function executeMarketOrder(ticker, side, dollarAmount, entryPrice, reason) {
  const fractionalQty = (dollarAmount / entryPrice).toFixed(4);
  const label = `${side.toUpperCase()} $${dollarAmount} (${fractionalQty} shares) ${ticker} — ${reason}`;

  if (DRY_RUN) {
    const dryPath = join(OUTPUT_DIR, 'trades', `${today}-${ticker}-${side}-DRY.json`);
    writeFileSync(dryPath, JSON.stringify({ ticker, side, dollarAmount, fractionalQty, entryPrice, reason, timestamp: new Date().toISOString() }, null, 2));
    console.log(`  🔷 DRY RUN: ${label}`);
    return { dryRun: true, ticker, side, dollarAmount, fractionalQty };
  }

  const acctNum = await rhGetAccountNumber();
  if (!acctNum) return { error: 'Could not get account number' };

  console.log(`  📤 ${label}`);
  const result = await rhMCP('place_equity_order', {
    account_number: acctNum,
    symbol: ticker,
    side,
    type: 'market',
    quantity: String(fractionalQty),
    time_in_force: 'gfd',
  });
  return result;
}

// ─── FMP & Yahoo Data ─────────────────────────────────────────────────────────
async function fmp(path) {
  if (!FMP_KEY) return null;
  try {
    const sep = path.includes('?') ? '&' : '?';
    const url = `https://financialmodelingprep.com/stable/${path}${sep}apikey=${FMP_KEY}`;
    const r   = await fetch(url);
    if (!r.ok) return null;
    const text = await r.text();
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
}

const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const sleep    = ms => new Promise(r => setTimeout(r, ms));

async function yahooChart(symbol, range = '5d', interval = '1d') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`;
    const r   = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) return null;
    const d   = await r.json();
    return d?.chart?.result?.[0] || null;
  } catch { return null; }
}

async function yahooQuote(symbol) {
  const result = await yahooChart(symbol);
  if (!result) return null;
  const meta  = result.meta;
  const price = meta.regularMarketPrice;
  const prev  = meta.chartPreviousClose;
  return {
    symbol:        meta.symbol,
    price,
    changePercent: prev ? ((price - prev) / prev * 100) : null,
    yearHigh:      meta.fiftyTwoWeekHigh,
    yearLow:       meta.fiftyTwoWeekLow,
    volume:        meta.regularMarketVolume,
    dayHigh:       meta.regularMarketDayHigh,
    dayLow:        meta.regularMarketDayLow,
    preMarketPrice:  meta.preMarketPrice || null,
    preMarketVolume: meta.preMarketVolume || null,
  };
}

async function yahooQuotesBatch(symbols) {
  const results = [];
  for (const sym of symbols) {
    results.push(await yahooQuote(sym));
    await sleep(80);
  }
  return results;
}

function computeRSI(prices, period = 14) {
  if (!prices || prices.length < period + 1) return null;
  const changes = prices.slice(1).map((p, i) => p - prices[i]);
  let avgGain = changes.slice(0, period).reduce((s, c) => s + (c > 0 ? c : 0), 0) / period;
  let avgLoss = changes.slice(0, period).reduce((s, c) => s + (c < 0 ? -c : 0), 0) / period;
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + (changes[i] > 0 ? changes[i] : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (changes[i] < 0 ? -changes[i] : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(1));
}

// ATR-14 from OHLCV bars (newest first from FMP)
function computeATR14(bars) {
  if (!bars || bars.length < 15) return null;
  const reversed = bars.slice(0, 15).reverse(); // oldest → newest
  const trs = reversed.slice(1).map((bar, i) => {
    const prev = reversed[i].close ?? reversed[i].price;
    return Math.max(
      (bar.high ?? bar.price) - (bar.low ?? bar.price),
      Math.abs((bar.high ?? bar.price) - prev),
      Math.abs((bar.low ?? bar.price) - prev),
    );
  });
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

// Compute pre-market gap% and RVOL for a ticker
async function getPreMarketData(ticker) {
  const [q, hist] = await Promise.all([
    yahooQuote(ticker),
    fmp(`historical-price-eod/light?symbol=${ticker}&limit=35`),
  ]);

  const histArr = Array.isArray(hist) ? hist : [];
  const closes  = histArr.map(h => h.price).reverse(); // oldest → newest

  const rsi14  = computeRSI(closes);
  const atr14  = computeATR14(histArr); // histArr is newest-first, function handles it

  // Pre-market gap: (preMarketPrice - previousClose) / previousClose
  const prePrice = q?.preMarketPrice;
  const prevClose = histArr[0]?.price || null; // newest bar = yesterday's close
  const gapPct = (prePrice && prevClose) ? ((prePrice - prevClose) / prevClose * 100) : null;

  // RVOL approximation: preMarketVolume / (avg30dayVolume * 0.08)
  // Pre-market is typically ~5-10% of regular session volume
  const recent30vol = histArr.slice(0, 30).map(h => h.volume).filter(Boolean);
  const avg30vol    = recent30vol.length ? recent30vol.reduce((a, b) => a + b, 0) / recent30vol.length : null;
  const preMktVol   = q?.preMarketVolume || null;
  const rvol        = (preMktVol && avg30vol) ? (preMktVol / (avg30vol * 0.08)) : null;

  // ATR-based stop distance: clamp(ATR/price * 0.75, 1%, 4%)
  const stopDistancePct = atr14 && q?.price
    ? Math.min(4.0, Math.max(1.0, (atr14 / q.price) * 0.75 * 100))
    : 2.5;

  return {
    ticker,
    price:          q?.price,
    preMarketPrice: prePrice,
    prevClose,
    gapPct:         gapPct?.toFixed(2),
    gapUp:          gapPct !== null && gapPct > 2,
    preMarketVolume: preMktVol,
    avg30DayVolume: avg30vol ? Math.round(avg30vol) : null,
    rvol:           rvol?.toFixed(2),
    rvolHigh:       rvol !== null && rvol > 2,
    rsi14,
    atr14:          atr14?.toFixed(2),
    stopDistancePct: stopDistancePct.toFixed(2),
    targetDistancePct: (stopDistancePct * 1.5).toFixed(2), // 1.5:1 reward:risk
    ma50:  histArr[0]?.priceAvg50 ?? null,
    ma200: histArr[0]?.priceAvg200 ?? null,
    // Gap-fill probability: rough heuristic from gap size
    gapFillProb: gapPct === null ? null
      : gapPct > 5 ? 'low'
      : gapPct > 2 ? 'medium'
      : 'high',
  };
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
  const hist   = toArr(histArr);
  const closes = hist.map(h => h.price).reverse();
  const rsi14  = computeRSI(closes);
  const atr14  = computeATR14(hist);
  const recent20 = hist.slice(0, 20).map(h => h.volume).filter(Boolean);
  const avgVol20  = recent20.length ? Math.round(recent20.reduce((a, b) => a + b, 0) / recent20.length) : null;
  return {
    ticker, price: q?.price,
    change1D: q?.changePercentage ?? q?.changesPercentage,
    yearHigh: q?.yearHigh, yearLow: q?.yearLow,
    pctFromHigh: q?.price && q?.yearHigh ? ((q.price - q.yearHigh) / q.yearHigh * 100).toFixed(1) : null,
    pctFromLow:  q?.price && q?.yearLow  ? ((q.price - q.yearLow)  / q.yearLow  * 100).toFixed(1) : null,
    ma50: q?.priceAvg50, ma200: q?.priceAvg200,
    volume: q?.volume, avgVolume: avgVol20,
    volumeVsAvg: avgVol20 && q?.volume ? ((q.volume / avgVol20 - 1) * 100).toFixed(0) + '%' : null,
    marketCap: q?.marketCap, peRatio: m?.peRatioTTM?.toFixed(1) ?? null,
    beta: f?.beta, sector: f?.sector, industry: f?.industry,
    rsi14, atr14: atr14?.toFixed(2),
  };
}

// ─── SEC EDGAR Insider Data ───────────────────────────────────────────────────
async function getInsiderActivitySEC(ticker) {
  try {
    // Step 1: resolve company CIK from SEC ticker file
    const tickerMap = await fetch('https://www.sec.gov/files/company_tickers.json', {
      headers: { 'User-Agent': 'investing-tool/2.0 alvintsheth@gmail.com' },
    }).then(r => r.json()).catch(() => null);

    if (!tickerMap) return { ticker, error: 'SEC ticker map unavailable' };

    const entry = Object.values(tickerMap).find(e => e.ticker?.toUpperCase() === ticker.toUpperCase());
    if (!entry) return { ticker, error: 'CIK not found in SEC database' };

    const cik = String(entry.cik_str).padStart(10, '0');

    // Step 2: fetch recent Form 4 filings via EDGAR full-text search
    const since = getDateStr(-90);
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${ticker}%22&forms=4&dateRange=custom&startdt=${since}&enddt=${today}`;
    const searchRes = await fetch(searchUrl, {
      headers: { 'User-Agent': 'investing-tool/2.0 alvintsheth@gmail.com' },
    }).then(r => r.json()).catch(() => null);

    const hits = searchRes?.hits?.hits?.slice(0, 8) || [];
    const filings = hits.map(h => ({
      date:          h._source?.file_date,
      filerName:     h._source?.display_names?.[0]?.name || 'Unknown',
      formType:      h._source?.form_type,
      accessionUrl:  `https://www.sec.gov/Archives/edgar/data/${entry.cik_str}/${h._id?.replace(/-/g, '')}/`,
    }));

    return { ticker, cik, recentForm4Filings: filings, source: 'SEC EDGAR direct' };
  } catch (e) {
    return { ticker, error: e.message };
  }
}

async function getStockNews(ticker) {
  const [newsSearch, catalystSearch] = await Promise.all([
    webSearch(`${ticker} stock news today ${today}`, 5),
    webSearch(`${ticker} earnings analyst upgrade downgrade catalyst 2026`, 5),
  ]);
  return [
    ...(newsSearch.results || []).map(r => ({ ...r, source: 'news' })),
    ...(catalystSearch.results || []).map(r => ({ ...r, source: 'catalyst' })),
  ].slice(0, 10);
}

async function getMacroIndicators() {
  let treasuryYields = null;
  try {
    const ym  = `${new Date().getFullYear()}${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const r   = await fetch(`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=${ym}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const xml = await r.text();
    const entries = xml.match(/<m:properties>[\s\S]*?<\/m:properties>/g) || [];
    if (entries.length) {
      const last = entries[entries.length - 1];
      const get  = tag => { const m = last.match(new RegExp(`<d:${tag}[^>]*>([^<]*)<`)); return m?.[1] || null; };
      treasuryYields = { date: get('NEW_DATE')?.slice(0, 10), '2yr': get('BC_2YEAR'), '10yr': get('BC_10YEAR'), '30yr': get('BC_30YEAR') };
    }
  } catch {}
  const macroSearch = await webSearch('Federal Reserve rate CPI inflation FOMC 2026', 4);
  return { treasuryYields, macroSearchResults: macroSearch.results || [] };
}

async function getFearGreedAndVIX() {
  const results = {};
  try {
    const r = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const d = await r.json();
    results.fearGreed = { score: d?.fear_and_greed?.score, rating: d?.fear_and_greed?.rating, previousClose: d?.fear_and_greed?.previous_close };
  } catch {}
  try {
    const vixArr = await fmp('quote?symbol=%5EVIX');
    const vix    = Array.isArray(vixArr) ? vixArr[0] : null;
    if (vix) results.vix = { price: vix.price, change: vix.changePercentage ?? vix.changesPercentage };
  } catch {}
  try {
    const [spy, qqq, iwm] = await yahooQuotesBatch(['SPY', 'QQQ', 'IWM']);
    results.indices = [spy, qqq, iwm].filter(Boolean).map(q => ({ ticker: q.symbol, price: q.price, change: q.changePercent?.toFixed(2), preMarketPrice: q.preMarketPrice }));
  } catch {}
  return results;
}

async function getEarningsCalendar() {
  const search = await webSearch(`earnings calendar today ${today} results expected`, 6);
  return { results: search.results || [], note: 'Check these — avoid buying stock with earnings today before close.' };
}

async function getSectorRotation() {
  const SECTOR_ETFS = { Technology: 'XLK', Financials: 'XLF', Energy: 'XLE', Healthcare: 'XLV', Industrials: 'XLI', Communication: 'XLC', RealEstate: 'XLRE', Utilities: 'XLU', ConsumerStaples: 'XLP', ConsumerDisc: 'XLY', Materials: 'XLB' };
  const etfSymbols = Object.values(SECTOR_ETFS);
  const yahooQuotes = await yahooQuotesBatch(etfSymbols);
  const quoteMap = {};
  yahooQuotes.filter(Boolean).forEach(q => { quoteMap[q.symbol] = q; });
  const sectors = Object.entries(SECTOR_ETFS).map(([sector, sym]) => {
    const q = quoteMap[sym];
    if (!q) return null;
    return { sector, ticker: sym, price: q.price, change1D: q.changePercent?.toFixed(2), preMarketChange: q.preMarketPrice ? ((q.preMarketPrice - q.price) / q.price * 100).toFixed(2) : null };
  }).filter(Boolean).sort((a, b) => parseFloat(b.change1D) - parseFloat(a.change1D));
  return { date: today, leadingSectors: sectors.slice(0, 4), laggingSectors: sectors.slice(-4), all: sectors };
}

async function getRedditSentiment(ticker) {
  const results = [];
  for (const sub of ['wallstreetbets', 'stocks', 'investing']) {
    try {
      const r = await fetch(`https://www.reddit.com/r/${sub}/search.json?q=${ticker}&sort=top&t=day&limit=5`, { headers: { 'User-Agent': 'investing-tool/2.0' } });
      const d = await r.json();
      const posts = (d?.data?.children || []).map(p => ({ title: p.data.title, score: p.data.score, comments: p.data.num_comments, created: new Date(p.data.created_utc * 1000).toISOString() }));
      if (posts.length) results.push({ subreddit: sub, posts });
    } catch {}
  }
  try {
    const r = await fetch(`https://api.stocktwits.com/api/2/streams/symbol/${ticker}.json`);
    const d = await r.json();
    const messages = (d?.messages || []).slice(0, 8).map(m => ({ text: m.body, sentiment: m.entities?.sentiment?.basic || 'Neutral', time: m.created_at }));
    if (messages.length) results.push({ subreddit: 'StockTwits', posts: messages });
  } catch {}
  // Overnight chatter volume: count total posts in last 24h across subs
  const totalPosts = results.reduce((n, s) => n + s.posts.length, 0);
  return { ticker, sources: results, overnightPostCount: totalPosts, highChatter: totalPosts > 15 };
}

// ─── Web Search ───────────────────────────────────────────────────────────────
async function webSearch(query, maxResults = 8) {
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', Accept: 'text/html' },
    });
    const html    = await r.text();
    const results = [];
    const regex   = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([^<]+)<\/a>/g;
    let m;
    while ((m = regex.exec(html)) !== null && results.length < maxResults) {
      let href = m[1];
      if (href.startsWith('//duckduckgo.com/l/?uddg=')) {
        try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {}
      }
      results.push({ title: m[2].trim(), url: href, snippet: m[3].replace(/<[^>]+>/g, '').trim() });
    }
    return { query, results };
  } catch (e) { return { query, error: e.message, results: [] }; }
}

async function getNotableMentions(ticker) {
  const searches = await Promise.all([
    webSearch(`${ticker} Trump White House executive order tariff trade deal 2026`),
    webSearch(`${ticker} Jensen Huang Elon Musk CEO mention 2026`),
    webSearch(`${ticker} Congress Pelosi insider disclosure ${today.slice(0, 7)}`),
    webSearch(`${ticker} Buffett Ackman Cathie Wood position 2026`),
    webSearch(`${ticker} analyst upgrade downgrade price target ${today.slice(0, 7)}`),
  ]);
  return {
    ticker,
    politicalMentions:  searches[0].results,
    influentialCEOs:    searches[1].results,
    congressionalTrades: searches[2].results,
    majorInvestors:     searches[3].results,
    analystMoves:       searches[4].results,
  };
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────
const tools = [
  {
    name: 'get_premarket_data',
    description: 'Get pre-market gap%, RVOL, ATR-14, RSI, stop/target distances for a ticker. PRIMARY screening tool — call for every candidate. Gappers >2% with RVOL >2x are the primary entry candidates.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_market_data',
    description: 'Get full market data: price, RSI-14, 52W range, volume, ATR-14, P/E, beta, sector',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_fear_greed_vix',
    description: 'Get CNN Fear & Greed Index, VIX level and change, SPY/QQQ/IWM pre-market prices. Call once at session start.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_macro_indicators',
    description: 'Get treasury yields, Fed/CPI macro context. Call once at session start.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_sector_rotation',
    description: 'Get all 11 S&P sectors ranked by today\'s performance including pre-market move.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_earnings_calendar',
    description: 'Get today\'s earnings announcements. HARD RULE: do not buy any stock reporting earnings today before market close.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_news',
    description: 'Get recent news for a ticker. Focus on OVERNIGHT and PRE-MARKET news only — same-day catalyst is the signal.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_insider_activity',
    description: 'Get recent Form 4 insider filings from SEC EDGAR for context. Insider buying is supportive context, not a same-day signal (filing lag).',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_reddit_sentiment',
    description: 'Get overnight Reddit/StockTwits chatter. High overnight post count (>15) on bearish tone = contrarian signal. Extreme bullish chatter = crowded, avoid.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_notable_mentions',
    description: 'Search for recent influential mentions: Trump/White House orders, CEO shoutouts, Congressional trades, major investors, analyst upgrades/downgrades.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'search_sam_weiss_briefings',
    description: 'Search Sam\'s historical briefings for a ticker. Use AFTER forming your own thesis.',
    input_schema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
  },
  {
    name: 'get_sam_market_outlook',
    description: 'Load Sam\'s current macro framework, strategy, and portfolio positions on demand. Call in Phase 3 only — research first.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'web_search',
    description: 'General DuckDuckGo web search for ad-hoc research.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_portfolio',
    description: 'Get Robinhood portfolio: equity value, buying power, open positions.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'place_trade',
    description: 'Execute a day trade on Robinhood. Dollar-denominated sizing (15-20% of balance). Fractional shares supported. Hard rules: no entries if >2 open positions, no entries after 10am PT, no earnings-day stocks. All positions auto-closed at 12:45pm PT by force-close job.',
    input_schema: {
      type: 'object',
      properties: {
        ticker:        { type: 'string' },
        side:          { type: 'string', enum: ['buy', 'sell'] },
        pWin:          { type: 'number', description: 'Model P(win) score 0-1. Must be >0.55 to trade.' },
        rationale:     { type: 'string', description: 'Why this stock today — specific pre-market data, catalyst, signal confluence.' },
        signals: {
          type: 'object',
          properties: {
            premarket_gap_up:   { type: 'boolean' },
            rvol_spike:         { type: 'boolean' },
            gap_fill_low_prob:  { type: 'boolean' },
            macro_tailwind:     { type: 'boolean' },
            sector_leading:     { type: 'boolean' },
            news_catalyst:      { type: 'boolean' },
            notable_mention:    { type: 'boolean' },
            insider_buying:     { type: 'boolean' },
            contrarian_social:  { type: 'boolean' },
            analyst_conviction: { type: 'boolean' },
          },
        },
        targetPrice:   { type: 'number', description: 'Intraday price target (1.5× ATR stop distance from entry)' },
        stopPrice:     { type: 'number', description: 'ATR-based stop loss price' },
        atr14:         { type: 'number', description: 'ATR-14 at time of trade' },
        marketContext: { type: 'string', description: 'VIX, Fear & Greed, sector context at entry' },
        samAlignment:  { type: 'string', description: 'Sam\'s stance on this ticker (if checked)' },
      },
      required: ['ticker', 'side', 'pWin', 'rationale', 'signals'],
    },
  },
  {
    name: 'save_tomorrow_watchlist',
    description: 'Save stocks to watch tomorrow morning for pre-market gap scan.',
    input_schema: {
      type: 'object',
      properties: {
        watchlist: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ticker:       { type: 'string' },
              priceAtEOD:   { type: 'number' },
              entryTrigger: { type: 'string', description: 'Pre-market gap % or price level that triggers entry' },
              targetPrice:  { type: 'number' },
              stopLoss:     { type: 'number' },
              reason:       { type: 'string' },
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
    case 'get_premarket_data': return getPreMarketData(input.ticker);
    case 'get_market_data':    return getFullMarketData(input.ticker);
    case 'get_fear_greed_vix': return getFearGreedAndVIX();
    case 'get_macro_indicators': return getMacroIndicators();
    case 'get_sector_rotation':  return getSectorRotation();
    case 'get_earnings_calendar': return getEarningsCalendar();
    case 'get_news':           return getStockNews(input.ticker);
    case 'get_insider_activity': return getInsiderActivitySEC(input.ticker);
    case 'get_reddit_sentiment': return getRedditSentiment(input.ticker);
    case 'get_notable_mentions': return getNotableMentions(input.ticker);
    case 'search_sam_weiss_briefings': {
      const matches = searchBriefingsForTicker(input.ticker);
      return { ticker: input.ticker, matchCount: matches.length, matches };
    }
    case 'get_sam_market_outlook':
      return {
        marketOutlook: loadKBFile('market-outlook.md', 5000),
        strategy:      loadKBFile('strategy.md', 3000),
        portfolioPositions: loadPortfolios().slice(0, 3000),
        latestBriefing: loadLatestBriefings(1).slice(0, 3000),
      };
    case 'web_search': return webSearch(input.query, 8);
    case 'get_portfolio': {
      const acct = await rhGetAccountNumber();
      if (!acct) return { error: 'Robinhood auth required — run: node robinhood-auth.js' };
      const [portResult, posResult] = await Promise.all([
        rhMCP('get_portfolio', { account_number: acct }),
        rhMCP('get_equity_positions', { account_number: acct }),
      ]);
      if (portResult.error) return { error: portResult.error };
      const port   = portResult?.data || portResult;
      const equity = parseFloat(port?.equity_value || port?.total_value || 0);
      return {
        accountNumber: acct, totalValue: port?.total_value, equityValue: port?.equity_value,
        cash: port?.cash, buyingPower: port?.buying_power?.buying_power,
        positions: posResult?.data?.positions || [],
        equityNumeric: equity,
      };
    }
    case 'place_trade': {
      if (CIRCUIT.tripped) return { blocked: true, reason: 'Circuit breaker tripped.' };

      const { ticker, side, pWin, rationale, signals, targetPrice, stopPrice, atr14, marketContext, samAlignment } = input;

      // Hard exclude: P(win) too low
      if (pWin < 0.55) return { blocked: true, reason: `P(win) ${pWin.toFixed(2)} < 0.55 threshold` };

      // Hard exclude: no entries after 10am PT (17:00 UTC in PDT)
      if (new Date().getUTCHours() >= 17) return { blocked: true, reason: 'Entry window closed — past 10am PT' };

      // Check concurrent position limit
      const openData = loadOpenPositions();
      const concurrentCheck = checkMaxConcurrent(openData.positions);
      if (concurrentCheck.blocked) return concurrentCheck;

      // Get portfolio balance
      const acct      = await rhGetAccountNumber();
      const portResult = acct ? await rhMCP('get_portfolio', { account_number: acct }) : null;
      const port       = portResult?.data || portResult || {};
      const balance    = parseFloat(port?.equity_value || port?.total_value || 0);

      if (!balance) return { error: 'Could not read account balance — pre-flight failed' };

      // Circuit breaker check
      const dailyPnl = openData.positions.reduce((s, p) => s + (p.currentPnl || 0), 0);
      const cbCheck  = checkCircuitBreaker(balance, dailyPnl, CIRCUIT.weekStartBalance || balance);
      if (cbCheck.blocked) return cbCheck;

      // Dollar-denominated position size
      const dollarAmount = computePositionDollars(balance);
      const quote        = await getQuote(ticker);
      const entryPrice   = quote?.price;
      if (!entryPrice) return { error: `Could not get price for ${ticker}` };

      const fractionalQty = (dollarAmount / entryPrice).toFixed(4);
      console.log(`\n  📈 ${DRY_RUN ? '[DRY] ' : ''}${side.toUpperCase()} $${dollarAmount} (${fractionalQty} shares) ${ticker} | P(win)=${pWin.toFixed(2)} | stop=$${stopPrice} | target=$${targetPrice}`);

      const orderResult = await executeMarketOrder(ticker, side, dollarAmount, entryPrice, rationale.slice(0, 80));
      if (orderResult.error) { console.log(`  ❌ Failed: ${orderResult.error}`); return orderResult; }

      // Record open position for exit manager
      const posRecord = {
        ticker, side, entryPrice, dollarAmount: parseFloat(dollarAmount),
        fractionalQty: parseFloat(fractionalQty),
        stopPrice:   stopPrice   || entryPrice * (1 - 0.025),
        targetPrice: targetPrice || entryPrice * (1 + 0.0375),
        atr14: atr14 || null,
        signals: signals || {},
        pWin, rationale, marketContext, samAlignment,
        entryTime: new Date().toISOString(),
        currentPnl: 0,
      };
      addOpenPosition(posRecord);

      // Write trade rationale file
      const slug = `${today}-${ticker}-${side}`;
      const md = [
        `# Trade Record — ${side.toUpperCase()} $${dollarAmount} ${ticker}`,
        `**Date/Time:** ${posRecord.entryTime}`,
        `**P(win):** ${pWin.toFixed(3)} | **Mode:** ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`,
        '',
        '## Decision Rationale', rationale,
        '',
        '## Position',
        `| | |`, `|---|---|`,
        `| Entry Price | $${entryPrice} |`,
        `| Dollar Amount | $${dollarAmount} |`,
        `| Fractional Qty | ${fractionalQty} shares |`,
        `| Stop Price | $${stopPrice ?? 'ATR-computed'} |`,
        `| Target Price | $${targetPrice ?? 'ATR-computed'} |`,
        `| ATR-14 | $${atr14 ?? 'n/a'} |`,
        '',
        '## Signals',
        signals ? Object.entries(signals).map(([k, v]) => `- ${v ? '✅' : '❌'} ${k}`).join('\n') : 'Not recorded',
        '',
        '## Market Context', marketContext || 'Not recorded',
        '',
        '## Sam Alignment', samAlignment || 'Not checked',
        '',
        '## EOD Outcome',
        '| | |', '|---|---|',
        '| Exit Price | — |',
        '| Exit Time | — |',
        '| P&L | — |',
        '| Exit Reason | — |',
        '',
        '## Robinhood Order', '```json', JSON.stringify(orderResult, null, 2), '```',
      ].join('\n');
      writeFileSync(join(OUTPUT_DIR, 'trades', `${slug}.md`), md);

      CIRCUIT.tradesExecuted.push({ ticker, side, dollarAmount, entryPrice, pWin });
      console.log(`  ✅ Recorded → output/trades/${slug}.md`);
      return { success: true, ticker, side, dollarAmount, entryPrice, fractionalQty, stopPrice, targetPrice, dryRun: DRY_RUN };
    }
    case 'save_tomorrow_watchlist': {
      const { watchlist } = input;
      atomicWrite(WATCHLIST_FILE, { date: today, watchlist });
      console.log(`  📋 Saved ${watchlist.length} tickers to tomorrow's watchlist`);
      return { success: true, savedCount: watchlist.length };
    }
    default: return { error: `Unknown tool: ${name}` };
  }
}

// ─── Pre-flight Checks ────────────────────────────────────────────────────────
async function preflightChecks() {
  console.log('\n🔍 Pre-flight checks...');

  if (DRY_RUN) {
    console.log('  🔷 DRY_RUN=true — orders will be logged but NOT submitted to Robinhood');
    console.log('     Set DRY_RUN=false in .env to go live');
  } else {
    console.log('  🚨 DRY_RUN=false — LIVE TRADING MODE');
  }

  // Check account balance
  let balance = 0;
  try {
    const acct = await rhGetAccountNumber();
    if (acct) {
      const portResult = await rhMCP('get_portfolio', { account_number: acct });
      const port = portResult?.data || portResult || {};
      balance = parseFloat(port?.equity_value || port?.total_value || 0);
      if (balance > 0) {
        console.log(`  ✅ Account balance: $${balance.toFixed(2)}`);
        console.log(`  ✅ Position size target: $${computePositionDollars(balance)} (17.5% of balance)`);
        CIRCUIT.weekStartBalance = CIRCUIT.weekStartBalance || balance;
      } else {
        console.log('  ⚠️  Balance is $0 or unreadable — proceeding in research-only mode');
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not reach Robinhood MCP: ${e.message}`);
  }

  // Check early-close date
  if (EARLY_CLOSE_DATES.has(today)) {
    console.log(`  ⚠️  Early-close day (${today}) — market closes at 1pm ET / 10am PT`);
  }

  console.log('  ✅ Pre-flight complete\n');
  return balance;
}

// ─── Scan Prompt ──────────────────────────────────────────────────────────────
function buildScanPrompt(balance, openPositions, weights) {
  const dailyScrape   = loadDailyScrape();
  const todayTrades   = dailyScrape?.pages?.find(p => p.label === 'trades')?.content || '';
  const todayWatchlist = dailyScrape?.pages?.find(p => p.label === 'trade-watch')?.content || loadKBFile('trade-watchlist.md', 1500);
  const nasdaqRef     = loadKBFile('nasdaq-historical.md', 2000);
  const positionSize  = balance ? `$${computePositionDollars(balance)}` : '17.5% of balance';

  return `You are a personal day-trading agent for Alvin. Today is ${today}. This is a DAY TRADE session — all positions must be CLOSED by 12:45pm PT (force-close job fires then, no exceptions).
${DRY_RUN ? '\n⚠️  DRY RUN MODE — orders will be logged but not submitted. Research and score candidates as if live.\n' : ''}
${buildLearningsContext()}

═══════════════════════════════════════════════════════════════
DAY TRADING RULES
═══════════════════════════════════════════════════════════════

ENTRY WINDOW: 6:00am–10:00am PT only. No new buys after 10am PT.
POSITION SIZE: ${positionSize} per trade (17.5% of balance, fractional shares OK)
MAX CONCURRENT: 2 positions (currently open: ${openPositions.length})
FORCE-CLOSE: 12:45pm PT — exit manager closes all positions automatically
STOP LOSS: ATR-based (premarket_data.stopDistancePct from entry)
TARGET: 1.5× stop distance (premarket_data.targetDistancePct)

HARD EXCLUDES (never trade):
  ✗ Earnings today before close
  ✗ P(win) < 0.55
  ✗ Already at 2 open positions

SIGNAL SCORING (P(win) via logistic model or equal-weight fallback):
  premarket_gap_up    +++ gap >2% pre-market on elevated volume — PRIMARY signal
  rvol_spike          +++ relative volume >2x 30-day pre-market avg
  gap_fill_low_prob   ++  gap >5% historically holds momentum
  news_catalyst       ++  clear overnight/pre-market catalyst (not rumors)
  sector_leading      +   sector ETF moving strongly pre-market
  macro_tailwind      +   VIX low/falling, broad market green pre-market
  notable_mention     +   executive order, CEO shoutout, Congressional trade
  insider_buying      +   recent Form 4 C-suite buy (context signal only)
  contrarian_social   +   high overnight bearish chatter on fundamentally strong setup
  analyst_conviction  +   2+ recent upgrades or material PT raise

TRADE IF: P(win) > 0.55 → standard | P(win) > 0.70 → full size (same $, higher confidence)
WATCH ONLY: P(win) 0.45–0.55 → log to watchlist for tomorrow
AVOID: P(win) < 0.45

═══════════════════════════════════════════════════════════════
RESEARCH PHASES
═══════════════════════════════════════════════════════════════

Phase 1 — Market context (call ONCE each):
  get_fear_greed_vix → sets today's risk appetite
  get_sector_rotation → which sectors are gapping pre-market

Phase 2 — Candidate discovery (before Sam):
  get_earnings_calendar → hard exclude list
  web_search for "pre-market gappers today ${today} volume"
  web_search for "top stock movers today ${today} pre-market"
  Yesterday's watchlist tickers are candidates — check them first

Phase 3 — Screen each candidate:
  get_premarket_data [ticker] → gap%, RVOL, ATR stop/target — do this FIRST
  Skip if gap <2% or RVOL <1.5
  get_news [ticker] → overnight catalyst?
  get_reddit_sentiment [ticker] → overnight chatter signal
  get_notable_mentions [ticker] → if there's a notable angle
  get_insider_activity [ticker] → SEC Form 4 context

Phase 4 — Sam validation (only after independent scoring):
  search_sam_weiss_briefings [ticker] → Sam's historical stance
  get_sam_market_outlook → macro framework if needed

Phase 5 — Execute:
  place_trade → only if P(win) > 0.55 AND earnings check passed
  save_tomorrow_watchlist → tickers scoring 0.45–0.55

═══════════════════════════════════════════════════════════════
SAM'S ACTIONS TODAY
═══════════════════════════════════════════════════════════════

### TRADE ALERTS (what Sam executed)
${todayTrades.slice(0, 1500) || '(none scraped)'}

### WATCHLIST (what Sam is monitoring)
${todayWatchlist.slice(0, 1000) || '(none scraped)'}

═══════════════════════════════════════════════════════════════
NASDAQ CORRECTION/RALLY REFERENCE
═══════════════════════════════════════════════════════════════

${nasdaqRef}`;
}

// ─── EOD Prompt ───────────────────────────────────────────────────────────────
function buildEODPrompt(closedTrades, openPositions) {
  const qqqYahoo = null; // fetched at runtime

  return `You are generating the EOD report for Alvin's day-trading account. Today is ${today}.

## Closed Trades Today
${closedTrades.length ? closedTrades.map(t =>
  `${t.ticker}: ${t.side?.toUpperCase()} $${t.dollarAmount} @ $${t.entryPrice} → exit $${t.exitPrice ?? '?'} | P&L: ${t.pnl !== null ? (t.pnl >= 0 ? '+' : '') + '$' + t.pnl?.toFixed(2) + ' (' + t.pnlPct?.toFixed(1) + '%)' : 'pending'} | Exit: ${t.exitReason || 'unknown'}`
).join('\n') : '(no trades today)'}

## Still Open (should have been force-closed at 12:45pm PT)
${openPositions.length ? openPositions.map(p => `${p.ticker}: entry $${p.entryPrice}, stop $${p.stopPrice}, target $${p.targetPrice}`).join('\n') : '(none)'}

## Tools Available
- get_fear_greed_vix → get today's final market close data for QQQ benchmark
- get_market_data [ticker] → get closing price for any open position
- save_tomorrow_watchlist → save tomorrow's gap candidates

## EOD Report Format (two sections only):

### Section 1: P&L
Per-trade breakdown vs QQQ's same-day return (6:30am–1pm PT equivalent).
Total realized P&L. Win/loss count. Best and worst trade.

### Section 2: Learnings
What worked, what didn't. Which signals were present on winning vs losing trades.
What to adjust for tomorrow. Specific tickers/setups to watch in tomorrow's pre-market scan.

Keep it concise — max 500 words total. Details live in log files.`;
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendEODEmail(reportText, closedTrades) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('  ⚠️  Email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set'); return; }

  const totalPnl   = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnlStr     = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  const wins       = closedTrades.filter(t => t.pnl > 0).length;
  const subject    = `📈 EOD ${today} | ${pnlStr} | ${wins}W/${closedTrades.length - wins}L`;

  const html = `<html><body style="font-family:monospace;max-width:800px;margin:auto;padding:24px;">
<h2>📈 Day Trade EOD — ${today}</h2>
<p><strong>${pnlStr}</strong> | ${wins}W / ${closedTrades.length - wins}L | ${DRY_RUN ? '🔷 DRY RUN' : '🚨 LIVE'}</p>
<pre style="white-space:pre-wrap;line-height:1.5;">${reportText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`;

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: user, to: 'alvintsheth@gmail.com', subject, html, text: reportText });
  console.log(`  📧 EOD email sent → alvintsheth@gmail.com`);
}

// ─── Scan Mode (6am PT — Claude Sonnet) ──────────────────────────────────────
async function runScan() {
  console.log(`\n🚀 Day trade scan starting — ${today}${DRY_RUN ? ' [DRY RUN]' : ' [LIVE]'}\n`);

  const balance = await preflightChecks();
  const openData = loadOpenPositions();

  if (openData.positions.length >= 2) {
    console.log(`Already at max positions: ${openData.positions.map(p => p.ticker).join(', ')} — no new entries.`);
  }

  const weights   = loadSignalWeights();
  const messages  = [{ role: 'user', content: buildScanPrompt(balance, openData.positions, weights) }];
  let response;
  let iterations  = 0;
  let inputTokens = 0, outputTokens = 0;

  while (iterations < 20) {
    iterations++;
    response = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8192, tools, messages,
    });
    inputTokens  += response.usage?.input_tokens  || 0;
    outputTokens += response.usage?.output_tokens || 0;
    console.log(`[Iter ${iterations}] stop: ${response.stop_reason}, blocks: ${response.content.length}`);

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const results = [];
      for (const tu of response.content.filter(b => b.type === 'tool_use')) {
        console.log(`  → ${tu.name}(${JSON.stringify(tu.input).slice(0, 100)})`);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(await executeTool(tu.name, tu.input)) });
      }
      messages.push({ role: 'user', content: results });
    }
  }

  const costUsd = (inputTokens * 3.0 + outputTokens * 15.0) / 1_000_000;
  console.log(`\n[Scan] Tokens — input: ${inputTokens.toLocaleString()} | output: ${outputTokens.toLocaleString()} | est. cost: $${costUsd.toFixed(4)}`);

  const finalText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const outPath   = join(OUTPUT_DIR, `recommendations-${today}.md`);
  const header    = CIRCUIT.tradesExecuted.length
    ? `# Scan Report — ${today}\n\n## Trades\n${CIRCUIT.tradesExecuted.map(t => `- ${t.side.toUpperCase()} $${t.dollarAmount} ${t.ticker} @ $${t.entryPrice} | P(win)=${t.pWin?.toFixed(2)}`).join('\n')}\n\n`
    : `# Scan Report — ${today}\n\n`;
  writeFileSync(outPath, header + finalText);
  console.log(`\n✅ Scan report: ${outPath}`);
}

// ─── Check Mode (8am, 9:30am, 11am — pure code + Haiku for judgment) ─────────
async function runCheck() {
  const openData = loadOpenPositions();
  if (!openData.positions.length) { console.log(`[check] No open positions — nothing to monitor.`); return; }

  console.log(`\n[check] Monitoring ${openData.positions.length} open position(s)...`);
  const nowUtc      = new Date().getUTCHours() * 60 + new Date().getUTCMinutes();
  const pastDeadline = nowUtc >= (17 * 60); // 10am PT = 17:00 UTC

  let inputTokens = 0, outputTokens = 0;

  for (const pos of [...openData.positions]) {
    const quote  = await getQuote(pos.ticker);
    if (!quote?.price) { console.log(`  [${pos.ticker}] No quote — skipping`); continue; }

    const currentPrice = quote.price;
    const pnl          = (currentPrice - pos.entryPrice) * pos.fractionalQty;
    const pnlPct       = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    console.log(`  [${pos.ticker}] price=$${currentPrice} | stop=$${pos.stopPrice} | target=$${pos.targetPrice} | P&L=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%)`);

    // Update current P&L for circuit breaker tracking
    pos.currentPnl = pnl;

    let exitReason = null;

    if (currentPrice <= pos.stopPrice) {
      exitReason = `stop-loss hit ($${currentPrice} ≤ $${pos.stopPrice})`;
    } else if (currentPrice >= pos.targetPrice) {
      exitReason = `target hit ($${currentPrice} ≥ $${pos.targetPrice})`;
    } else if (pastDeadline) {
      exitReason = 'past 10am PT — no new entries, checking thesis only';
    }

    // Thesis-break check for Haiku judgment
    if (!exitReason) {
      const [news, sentiment] = await Promise.all([
        getStockNews(pos.ticker),
        getFearGreedAndVIX(),
      ]);
      const vixChange = sentiment?.vix?.change;
      const newsHeadlines = news.slice(0, 3).map(n => n.title).join(' | ');
      const vixSpike = vixChange && parseFloat(vixChange) > 15;

      if (vixSpike || newsHeadlines.toLowerCase().includes('halt') || newsHeadlines.toLowerCase().includes('investigation')) {
        // Ask Haiku for judgment
        console.log(`  [${pos.ticker}] Thesis-break indicators detected — asking Haiku`);
        const judgment = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Open position: ${pos.ticker} bought at $${pos.entryPrice}. Original thesis: ${pos.rationale?.slice(0, 200)}. Stop: $${pos.stopPrice}. Current price: $${currentPrice}. Recent news: "${newsHeadlines}". VIX change: ${vixChange}%. Should we exit NOW or hold to stop? Answer: "exit" or "hold" — one sentence reason.`,
          }],
        });
        inputTokens  += judgment.usage?.input_tokens  || 0;
        outputTokens += judgment.usage?.output_tokens || 0;
        const verdict = judgment.content[0]?.text?.toLowerCase() || '';
        if (verdict.startsWith('exit')) exitReason = `Haiku judgment: ${verdict.slice(0, 100)}`;
        console.log(`  [${pos.ticker}] Haiku: ${verdict.slice(0, 100)}`);
      }
    }

    if (exitReason) {
      console.log(`  [${pos.ticker}] Exiting — ${exitReason}`);
      const result = await executeMarketOrder(pos.ticker, 'sell', pos.dollarAmount, currentPrice, exitReason);
      if (!result.error) {
        recordClosedTrade({
          ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
          entryPrice: pos.entryPrice, exitPrice: currentPrice,
          pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
          signals: pos.signals, pWin: pos.pWin, rationale: pos.rationale,
          exitReason, entryTime: pos.entryTime, exitTime: new Date().toISOString(), date: today,
        });
        removeOpenPosition(pos.ticker);

        // Update trade rationale file with exit data
        const slug    = `${today}-${pos.ticker}-${pos.side}`;
        const mdPath  = join(OUTPUT_DIR, 'trades', `${slug}.md`);
        if (existsSync(mdPath)) {
          let md = readFileSync(mdPath, 'utf-8');
          md = md.replace('| Exit Price | — |', `| Exit Price | $${currentPrice} |`)
                 .replace('| Exit Time | — |', `| Exit Time | ${new Date().toISOString()} |`)
                 .replace('| P&L | — |', `| P&L | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) |`)
                 .replace('| Exit Reason | — |', `| Exit Reason | ${exitReason} |`);
          writeFileSync(mdPath, md);
        }
      }
    }
  }

  if (inputTokens > 0) {
    const costUsd = (inputTokens * 0.80 + outputTokens * 4.0) / 1_000_000;
    console.log(`[check] Haiku tokens — input: ${inputTokens} | output: ${outputTokens} | est: $${costUsd.toFixed(4)}`);
  }
  console.log('[check] Done.\n');
}

// ─── Force-Close Mode (12:45pm PT — pure code, no Claude) ────────────────────
async function runForceClose() {
  // Skip on early-close days where market already closed
  if (EARLY_CLOSE_DATES.has(today)) {
    console.log(`[force-close] Early-close day — market closed at 10am PT, skipping (positions should already be flat).`);
    return;
  }

  const openData = loadOpenPositions();
  if (!openData.positions.length) { console.log('[force-close] No open positions — nothing to close.'); return; }

  console.log(`\n🔴 FORCE-CLOSE at 12:45pm PT — closing ${openData.positions.length} position(s)${DRY_RUN ? ' [DRY RUN]' : ''}...`);

  for (const pos of [...openData.positions]) {
    const quote = await getQuote(pos.ticker);
    const currentPrice = quote?.price || pos.entryPrice;
    const pnl    = (currentPrice - pos.entryPrice) * pos.fractionalQty;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    console.log(`  [${pos.ticker}] Closing @ $${currentPrice} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    const result = await executeMarketOrder(pos.ticker, 'sell', pos.dollarAmount, currentPrice, 'force-close 12:45pm PT');

    if (!result.error) {
      recordClosedTrade({
        ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
        entryPrice: pos.entryPrice, exitPrice: currentPrice,
        pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
        signals: pos.signals, pWin: pos.pWin, rationale: pos.rationale,
        exitReason: 'force-close 12:45pm PT', entryTime: pos.entryTime,
        exitTime: new Date().toISOString(), date: today,
      });

      const slug   = `${today}-${pos.ticker}-${pos.side}`;
      const mdPath = join(OUTPUT_DIR, 'trades', `${slug}.md`);
      if (existsSync(mdPath)) {
        let md = readFileSync(mdPath, 'utf-8');
        md = md.replace('| Exit Price | — |', `| Exit Price | $${currentPrice} |`)
               .replace('| Exit Time | — |', `| Exit Time | ${new Date().toISOString()} |`)
               .replace('| P&L | — |', `| P&L | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) |`)
               .replace('| Exit Reason | — |', `| Exit Reason | force-close 12:45pm PT |`);
        writeFileSync(mdPath, md);
      }
    }
    removeOpenPosition(pos.ticker);
  }
  console.log('[force-close] All positions closed.\n');
}

// ─── EOD Mode (1:30pm PT — Claude Haiku + model training) ────────────────────
async function runEOD() {
  console.log(`\n📊 EOD report — ${today}\n`);

  const log          = loadTradesLog();
  const closedToday  = log.trades.filter(t => t.date === today && t.exitPrice !== null && t.exitPrice !== undefined);
  const openData     = loadOpenPositions();

  // Retrain logistic regression model
  const allComplete = log.trades.filter(t => t.pnl !== null && t.pnl !== undefined);
  const model = trainModel(allComplete);
  if (model) {
    // 80/20 blend with previous weights
    const prev = loadSignalWeights();
    if (prev?.weights) {
      model.weights = model.weights.map((w, j) => 0.8 * prev.weights[j] + 0.2 * w);
      model.bias    = 0.8 * prev.bias + 0.2 * model.bias;
    }
    // Walk-forward validation: this week vs last week accuracy
    const thisWeek = allComplete.filter(t => t.date >= getDateStr(-5));
    const lastWeek = allComplete.filter(t => t.date >= getDateStr(-12) && t.date < getDateStr(-5));
    const accuracy  = (trades) => {
      if (!trades.length) return null;
      const wins = trades.filter(t => (t.pnl > 0) === (predictWin(t.signals, model) > 0.5)).length;
      return wins / trades.length;
    };
    model.validation = {
      thisWeekAccuracy: accuracy(thisWeek),
      lastWeekAccuracy: accuracy(lastWeek),
      thisWeekN: thisWeek.length,
      lastWeekN: lastWeek.length,
    };
    atomicWrite(SIGNAL_WEIGHTS_FILE, model);
    console.log(`  📐 Model retrained on ${model.trainedOn} trades. Walk-forward: this week=${(model.validation.thisWeekAccuracy * 100 || 0).toFixed(0)}%`);
  } else {
    console.log(`  ℹ️  Not enough data to train model (${allComplete.length}/${60} trades) — using equal-weight fallback`);
  }

  // Claude Haiku generates EOD report
  const eodTools  = tools.filter(t => ['get_fear_greed_vix', 'get_market_data', 'save_tomorrow_watchlist'].includes(t.name));
  const messages  = [{ role: 'user', content: buildEODPrompt(closedToday, openData.positions) }];
  let response;
  let iterations  = 0;
  let inputTokens = 0, outputTokens = 0;

  while (iterations < 10) {
    iterations++;
    response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 4000, tools: eodTools, messages,
    });
    inputTokens  += response.usage?.input_tokens  || 0;
    outputTokens += response.usage?.output_tokens || 0;
    console.log(`  [EOD iter ${iterations}] stop: ${response.stop_reason}`);

    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason === 'end_turn') break;

    if (response.stop_reason === 'tool_use') {
      const results = [];
      for (const tu of response.content.filter(b => b.type === 'tool_use')) {
        console.log(`  [EOD] → ${tu.name}(${JSON.stringify(tu.input).slice(0, 80)})`);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(await executeTool(tu.name, tu.input)) });
      }
      messages.push({ role: 'user', content: results });
    }
  }

  const costUsd = (inputTokens * 0.80 + outputTokens * 4.0) / 1_000_000;
  console.log(`\n[EOD] Tokens — input: ${inputTokens.toLocaleString()} | output: ${outputTokens.toLocaleString()} | est. cost: $${costUsd.toFixed(4)}`);

  const reportText = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const reportPath = join(OUTPUT_DIR, `eod-report-${today}.md`);
  writeFileSync(reportPath, `# EOD Report — ${today}\n\n${reportText}`);
  console.log(`EOD report: ${reportPath}`);

  await sendEODEmail(reportText, closedToday);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (MODE === 'scan')        return runScan();
  if (MODE === 'check')       return runCheck();
  if (MODE === 'force-close') return runForceClose();
  if (MODE === 'eod')         return runEOD();
  console.error(`Unknown mode: ${MODE}. Use: scan | check | force-close | eod`);
  process.exit(1);
}

main().catch(console.error);
