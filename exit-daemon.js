// exit-daemon.js — Continuous position monitor daemon
// Replaces: check-8am / check-930am / check-11am cron jobs
// Schedule: 6:25am PT daily via launchd, self-exits at market close (1pm PT)
// Fast loop (45s): stop/target checks — pure code, no Claude
// Slow loop (90min): Haiku thesis-break judgment
// Also: opening-range stop update (item 18), MFE/MAE tracking (item 31),
//        early-close force-close at 9:45am PT (item 24)

import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const client     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FMP_KEY    = process.env.FMP_API_KEY;
const DRY_RUN    = process.env.DRY_RUN !== 'false';

mkdirSync(join(OUTPUT_DIR, 'trades'), { recursive: true });

// ─── Market Calendar (mirrors agent.js) ──────────────────────────────────────
const US_MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-02',
  '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE_DATES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

// PT-aware date/day — avoids UTC vs local ambiguity in launchd environments
const today     = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const _ptDow    = new Date(today + 'T12:00:00');
const dayOfWeek = _ptDow.getDay();

if (dayOfWeek === 0 || dayOfWeek === 6 || US_MARKET_HOLIDAYS.has(today)) {
  console.log(`[exit-daemon] Market closed today (${today}) — exiting.`);
  process.exit(0);
}

// ─── PT Time Utilities ────────────────────────────────────────────────────────
function ptMinutes() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hour12: false });
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

const PT = {
  MARKET_OPEN:        6 * 60 + 30,  // 6:30am
  OR_5MIN:            6 * 60 + 35,  // 6:35am — first 5-min bar closes
  OR_10MIN:           6 * 60 + 40,  // 6:40am — second 5-min bar closes
  OR_CHECK:           6 * 60 + 45,  // 6:45am — all 3 first 5-min bars complete; ORB entry decision
  ENTRY_CUTOFF:      10 * 60,        // 10:00am
  EARLY_FORCE_CLOSE:  9 * 60 + 45,  // 9:45am (early-close days)
  FORCE_CLOSE:       12 * 60 + 45,  // 12:45pm
  MARKET_CLOSE:      13 * 60,        // 1:00pm
};

// ─── Trade State Machine (mirrors agent.js — no shared lib to keep daemon standalone) ──
const TRADE_STATES = {
  QUEUED:        'QUEUED',
  ORDER_PENDING: 'ORDER_PENDING',
  FILLED:        'FILLED',
  PROTECTED:     'PROTECTED',
  EXIT_PENDING:  'EXIT_PENDING',
  CLOSED:        'CLOSED',
};

function addStateHistory(pos, newState, meta = {}) {
  pos.state = newState;
  if (!pos.stateHistory) pos.stateHistory = [];
  pos.stateHistory.push({ state: newState, at: new Date().toISOString(), ...meta });
}

const forceCloseTime = EARLY_CLOSE_DATES.has(today) ? PT.EARLY_FORCE_CLOSE : PT.FORCE_CLOSE;
const marketCloseTime = EARLY_CLOSE_DATES.has(today) ? 10 * 60 : PT.MARKET_CLOSE;

// ─── Shared File State ────────────────────────────────────────────────────────
const OPEN_POSITIONS_FILE  = join(OUTPUT_DIR, 'trades-open.json');
const TRADES_LOG_FILE      = join(OUTPUT_DIR, 'trades-log.json');
const QUEUED_TRADES_FILE   = join(OUTPUT_DIR, 'queued-trades.json');
const ORB_LOG_FILE         = join(OUTPUT_DIR, `orb-log-${today}.json`);

function atomicWrite(path, data) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

function loadOpenPositions() {
  if (!existsSync(OPEN_POSITIONS_FILE)) return { date: today, positions: [] };
  try {
    const data = JSON.parse(readFileSync(OPEN_POSITIONS_FILE, 'utf-8'));
    if (data.date !== today) return { date: today, positions: [] };
    return data;
  } catch { return { date: today, positions: [] }; }
}

function saveOpenPositions(positions) {
  atomicWrite(OPEN_POSITIONS_FILE, { date: today, positions });
}

function removeOpenPosition(ticker) {
  const data = loadOpenPositions();
  saveOpenPositions(data.positions.filter(p => p.ticker !== ticker));
}

function recordClosedTrade(entry) {
  const log = existsSync(TRADES_LOG_FILE)
    ? JSON.parse(readFileSync(TRADES_LOG_FILE, 'utf-8'))
    : { trades: [] };
  if (entry.entryTime && entry.exitTime) {
    entry.timeInTradeMinutes = Math.round((new Date(entry.exitTime) - new Date(entry.entryTime)) / 60000);
  }
  log.trades.push(entry);
  atomicWrite(TRADES_LOG_FILE, log);
}

// ─── Yahoo Finance Quotes ─────────────────────────────────────────────────────
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const sleep    = ms => new Promise(r => setTimeout(r, ms));

async function yahooChart(symbol, range = '1d', interval = '5m') {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`;
    const r   = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) return null;
    const d = await r.json();
    return d?.chart?.result?.[0] || null;
  } catch { return null; }
}

async function getCurrentPrice(ticker) {
  try {
    const result = await yahooChart(ticker, '1d', '1d');
    if (!result) return null;
    return result.meta?.regularMarketPrice || result.meta?.preMarketPrice || null;
  } catch { return null; }
}

// ─── Opening Range (item 18) ──────────────────────────────────────────────────
// Fetches the first 15 minutes (3 × 5-min bars) after market open
async function getOpeningRange(ticker) {
  try {
    const result = await yahooChart(ticker, '1d', '5m');
    if (!result?.indicators?.quote?.[0]) return null;
    const timestamps = result.timestamp || [];
    const q      = result.indicators.quote[0];
    const highs  = q.high   || [];
    const lows   = q.low    || [];
    const closes = q.close  || [];
    const mktOpenUtcMs = new Date(`${today}T13:30:00Z`).getTime();
    const firstBars = timestamps
      .map((t, i) => ({ ms: t * 1000, h: highs[i], l: lows[i], c: closes[i] }))
      .filter(b => b.ms >= mktOpenUtcMs && b.h != null && b.l != null)
      .slice(0, 3);
    if (!firstBars.length) return null;

    const [b1, b2, b3] = firstBars;

    // Bug fix: the confirmation bar (b3, 6:40–6:45am) cannot be part of the range
    // its own price is tested against. orHigh (live decision) uses only bars whose
    // close time precedes the 6:45am check — i.e., b1 and b2.
    const orHigh_5min  = b1 ? b1.h : null;
    const orHigh_10min = b2 ? Math.max(b1.h, b2.h) : orHigh_5min;
    const orHigh_15min = b3 ? Math.max(b1.h, b2.h, b3.h) : orHigh_10min; // includes confirmation bar

    return {
      orHigh:   orHigh_10min,  // live decision: bars closed before confirmation
      orLow:    Math.min(...firstBars.map(b => b.l)),
      barsUsed: firstBars.length,
      // Empirical variants — logged on every candidate, not used for decisions until N=20
      variants: {
        orHigh_5min,
        orHigh_10min,
        orHigh_15min,
        bar1Close: b1?.c ?? null,
        bar2Close: b2?.c ?? null,
        bar3Close: b3?.c ?? null,
        liveDefinition: 'orHigh_10min',
      },
    };
  } catch { return null; }
}

// ─── Robinhood MCP (minimal client for sells only) ────────────────────────────
const RH_MCP_URL = 'https://agent.robinhood.com/mcp/trading';
const TOKEN_URL  = 'https://api.robinhood.com/oauth2/token/';
let rhSessionId     = null;
let rhToken         = process.env.ROBINHOOD_ACCESS_TOKEN || null;
let rhAccountNumber = null;

async function refreshRobinhoodToken() {
  const clientId = process.env.ROBINHOOD_CLIENT_ID;
  const refresh  = process.env.ROBINHOOD_REFRESH_TOKEN;
  if (!clientId || !refresh) return false;
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refresh }),
    });
    if (!res.ok) return false;
    const { access_token, refresh_token } = await res.json();
    rhToken = access_token;
    let env = readFileSync(join(__dirname, '.env'), 'utf-8');
    env = env.replace(/^ROBINHOOD_ACCESS_TOKEN=.*$/m,  `ROBINHOOD_ACCESS_TOKEN=${access_token}`)
             .replace(/^ROBINHOOD_REFRESH_TOKEN=.*$/m, `ROBINHOOD_REFRESH_TOKEN=${refresh_token}`);
    writeFileSync(join(__dirname, '.env'), env);
    return true;
  } catch { return false; }
}

async function rhPost(method, params, retrying = false) {
  const headers = { 'Content-Type': 'application/json' };
  if (rhToken)     headers['Authorization']   = `Bearer ${rhToken}`;
  if (rhSessionId) headers['mcp-session-id'] = rhSessionId;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000); // 20s timeout
  let res;
  try {
    res = await fetch(RH_MCP_URL, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      signal: controller.signal,
    });
  } finally { clearTimeout(timer); }
  if (res.status === 401 && !retrying) {
    if (await refreshRobinhoodToken()) { rhSessionId = null; return rhPost(method, params, true); }
    return { error: 'Robinhood auth required' };
  }
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const newSession = res.headers.get('mcp-session-id');
  if (newSession) rhSessionId = newSession;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    const raw  = await res.text();
    const line = raw.split('\n').find(l => l.startsWith('data: '));
    if (!line) return { error: 'Empty SSE' };
    return JSON.parse(line.slice(6));
  }
  return res.json();
}

async function rhMCP(toolName, args = {}) {
  try {
    if (!rhSessionId) {
      await rhPost('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'exit-daemon', version: '1.0' } });
    }
    const payload = await rhPost('tools/call', { name: toolName, arguments: args });
    if (payload?.error) return { error: payload.error.message || JSON.stringify(payload.error) };
    const text = payload?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : payload?.result || payload;
  } catch (e) { return { error: e.message }; }
}

async function getRHAccountNumber() {
  if (rhAccountNumber) return rhAccountNumber;
  const payload  = await rhMCP('get_accounts', {});
  const accounts = payload?.data?.accounts || [];
  const acct     = accounts.find(a => a.agentic_allowed) || accounts.find(a => a.is_default) || accounts[0];
  rhAccountNumber = acct?.account_number || null;
  return rhAccountNumber;
}

// ─── Fill Confirmation ────────────────────────────────────────────────────────
// Called for ORDER_PENDING positions after market open. Polls Robinhood portfolio,
// extracts actual fill price, re-anchors stop/target to fill, transitions to PROTECTED.
async function confirmFill(pos, openData) {
  if (DRY_RUN) return false; // dry-run orders never reach Robinhood
  console.log(`  [${pos.ticker}] ORDER_PENDING — polling Robinhood for fill confirmation...`);
  const acct = await getRHAccountNumber();
  if (!acct) { console.warn(`  [${pos.ticker}] confirmFill: could not get account number`); return false; }

  try {
    const ordersResult = await rhMCP('get_equity_orders', {
      account_number: acct,
      symbol:         pos.ticker,
      placed_agent:   'agentic',
      state:          'filled',
    });
    const buyOrder = (ordersResult?.data?.orders || []).find(o => o.side === 'buy');
    if (!buyOrder) {
      console.log(`  [${pos.ticker}] no agentic filled buy order yet — still awaiting fill`);
      return false;
    }

    const fillPrice = parseFloat(buyOrder.average_price ?? 0);
    if (!fillPrice || fillPrice <= 0) return false;

    // Re-anchor stop/target to actual fill price using ATR%
    const atrPct     = pos.atr14 ? parseFloat(pos.atr14) / fillPrice : 0.025;
    const stopPrice  = parseFloat((fillPrice * (1 - atrPct)).toFixed(2));
    const targetPrice = parseFloat((fillPrice * (1 + atrPct * 1.5)).toFixed(2));
    const slippage   = +((fillPrice - pos.decisionPrice) / pos.decisionPrice * 100).toFixed(2);

    addStateHistory(pos, TRADE_STATES.FILLED,    { fillPrice, slippage, note: 'confirmed from Robinhood portfolio' });
    addStateHistory(pos, TRADE_STATES.PROTECTED, { stopPrice, targetPrice, anchoredToFill: true });

    pos.entryPrice   = fillPrice;
    pos.stopPrice    = stopPrice;
    pos.targetPrice  = targetPrice;
    pos.slippagePct  = slippage;

    const livePos = openData.positions.find(p => p.ticker === pos.ticker);
    if (livePos) Object.assign(livePos, pos);
    saveOpenPositions(openData.positions);

    console.log(`  ✅ [${pos.ticker}] Fill confirmed @ $${fillPrice} (slippage ${slippage > 0 ? '+' : ''}${slippage}%) — stop $${stopPrice} | target $${targetPrice}`);
    return true;
  } catch (e) {
    console.warn(`  [${pos.ticker}] confirmFill error: ${e.message}`);
    return false;
  }
}

// ─── Market Sell (DRY_RUN safe) ───────────────────────────────────────────────
async function executeSell(ticker, currentPrice, dollarAmount, fractionalQty, reason) {
  if (DRY_RUN) {
    const dryPath = join(OUTPUT_DIR, 'trades', `${today}-${ticker}-sell-daemon-DRY.json`);
    writeFileSync(dryPath, JSON.stringify({ ticker, side: 'sell', currentPrice, dollarAmount, fractionalQty, reason, timestamp: new Date().toISOString() }, null, 2));
    console.log(`  🔷 [DRY] SELL ${ticker} @ $${currentPrice} — ${reason}`);
    return { dryRun: true };
  }
  const acct = await getRHAccountNumber();
  if (!acct) return { error: 'No account number' };
  console.log(`  📤 SELL ${ticker} @ $${currentPrice} — ${reason}`);
  return rhMCP('place_equity_order', {
    account_number: acct, symbol: ticker, side: 'sell', type: 'market',
    quantity: String(fractionalQty), time_in_force: 'gfd',
  });
}

// ─── Queued Trades (ORB entry) ────────────────────────────────────────────────
function loadQueuedTrades() {
  if (!existsSync(QUEUED_TRADES_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(QUEUED_TRADES_FILE, 'utf-8'));
    if (data.date !== today) return [];
    return data.trades || [];
  } catch { return []; }
}

// Write full ORB log atomically (price marks + entry decisions)
let orbLog = { date: today, queued: [], marks: {}, entries: [] };
function saveOrbLog() { atomicWrite(ORB_LOG_FILE, orbLog); }

// Log price for all queued candidates at a given minute mark (5, 10, 15)
async function logOrbPrices(queuedTrades, mark) {
  console.log(`[exit-daemon] ${6 + Math.floor((30 + mark) / 60)}:${String((30 + mark) % 60).padStart(2,'0')}am: logging ${mark}-min ORB prices for ${queuedTrades.length} queued candidate(s)...`);
  if (!orbLog.queued.length) {
    orbLog.queued = queuedTrades.map(t => ({
      ticker:       t.ticker,
      decisionPrice: t.decisionPrice,
      stopPrice:    t.stopPrice,
      targetPrice:  t.targetPrice,
      setupScore:   t.setupScore,
      catalystType: t.catalystType || null,
    }));
  }
  if (!orbLog.marks[mark]) orbLog.marks[mark] = {};
  for (const candidate of queuedTrades) {
    const price = await getCurrentPrice(candidate.ticker);
    orbLog.marks[mark][candidate.ticker] = { price, gapFromDecision: price ? +((price - candidate.decisionPrice) / candidate.decisionPrice * 100).toFixed(2) : null };
    console.log(`  [${candidate.ticker}] ${mark}-min price: $${price?.toFixed(2) ?? 'unavailable'} (decision: $${candidate.decisionPrice})`);
    await sleep(300);
  }
  saveOrbLog();
}

// At 12:45pm: update every orb-log entry with whether price recovered above OR high by close.
// This is the measurement that turns "stale-news vs structural" from an argument into data.
async function logOrbRecovery() {
  if (!orbLog.entries.length) return;
  console.log('[exit-daemon] 12:45pm: logging recoveredByClose for all ORB candidates...');
  for (const entry of orbLog.entries) {
    const price = await getCurrentPrice(entry.ticker);
    entry.closePrice       = price ?? null;
    entry.recoveredByClose = price != null && entry.orHigh != null ? price > entry.orHigh : null;
    console.log(`  [${entry.ticker}] close $${price?.toFixed(2) ?? 'n/a'} | OR high $${entry.orHigh?.toFixed(2) ?? 'n/a'} | recovered: ${entry.recoveredByClose}`);
    await sleep(300);
  }
  saveOrbLog();
  console.log('[exit-daemon] ORB recovery log complete.');
}

// Market buy (mirrors executeSell, DRY_RUN safe)
async function executeBuy(ticker, dollarAmount, fractionalQty) {
  if (DRY_RUN) {
    const dryPath = join(OUTPUT_DIR, 'trades', `${today}-${ticker}-buy-orb-DRY.json`);
    writeFileSync(dryPath, JSON.stringify({ ticker, side: 'buy', dollarAmount, fractionalQty, timestamp: new Date().toISOString(), note: 'ORB DRY_RUN' }, null, 2));
    console.log(`  🔷 [DRY ORB] BUY ${ticker} @ market`);
    return { dryRun: true };
  }
  const acct = await getRHAccountNumber();
  if (!acct) return { error: 'No account number' };
  console.log(`  📥 [ORB] BUY ${ticker} — placing market order`);
  return rhMCP('place_equity_order', {
    account_number: acct, symbol: ticker, side: 'buy', type: 'market',
    quantity: String(fractionalQty), time_in_force: 'gfd',
  });
}

// Map agent's 13-value catalystType enum to coarse tag for gap-fade analysis.
// "stale-news" = news fully priced in overnight; "structural" = ongoing institutional catalyst.
// This mapping is a hypothesis — recoveredByClose will tell us if it predicts recovery.
const STALE_NEWS_CATALYSTS = new Set(['analyst_upgrade', 'insider_purchase', 'sector_sympathy', 'technical']);
function gapFadeCatalystTag(catalystType) {
  if (!catalystType) return 'unknown';
  return STALE_NEWS_CATALYSTS.has(catalystType) ? 'stale-news' : 'structural';
}

// Submit ORB entry for a single queued candidate. Returns true if position was entered.
async function submitOrbEntry(candidate, openPositions) {
  const { ticker, dollarAmount, fractionalQty, setupScore } = candidate;
  const catalystType = candidate.catalystType || null;
  const catalystTag  = gapFadeCatalystTag(catalystType);

  // Confirm current price above OR high (gap held)
  const or = await getOpeningRange(ticker);
  const price = await getCurrentPrice(ticker);
  const orHigh = or?.orHigh ?? null;

  const entry = { ticker, decisionPrice: candidate.decisionPrice, orHigh, currentPrice: price, barsUsed: or?.barsUsed ?? 0, catalystType, catalystTag, orbVariants: or?.variants ?? null, at: new Date().toISOString() };

  if (!orHigh || !price) {
    entry.decision = 'skip'; entry.reason = 'OR or price unavailable';
    console.log(`  [${ticker}] ORB skip — no price/OR data`);
    orbLog.entries.push(entry); saveOrbLog();
    return false;
  }

  if (price <= orHigh) {
    entry.decision = 'fade'; entry.reason = `price $${price.toFixed(2)} ≤ OR high $${orHigh.toFixed(2)} — gap faded`;
    console.log(`  [${ticker}] ORB FADE — price $${price.toFixed(2)} ≤ OR high $${orHigh.toFixed(2)} — sitting out`);
    orbLog.entries.push(entry); saveOrbLog();
    return false;
  }

  entry.decision = 'enter'; entry.reason = `price $${price.toFixed(2)} > OR high $${orHigh.toFixed(2)} — gap held`;
  console.log(`  [${ticker}] ORB ENTRY — price $${price.toFixed(2)} > OR high $${orHigh.toFixed(2)} — buying`);

  const orderResult = await executeBuy(ticker, dollarAmount, fractionalQty);
  if (orderResult?.error) {
    entry.decision = 'error'; entry.reason = orderResult.error;
    orbLog.entries.push(entry); saveOrbLog();
    return false;
  }

  // Confirm fill (market is open, should fill within seconds)
  await sleep(3000);
  let fillPrice = price; // fallback
  let slippage  = 0;
  if (!DRY_RUN) {
    const acct = await getRHAccountNumber();
    const ordersResult = await rhMCP('get_equity_orders', { account_number: acct, symbol: ticker, placed_agent: 'agentic', state: 'filled' });
    const buyOrder = (ordersResult?.data?.orders || []).find(o => o.side === 'buy');
    if (buyOrder?.average_price) {
      fillPrice = parseFloat(buyOrder.average_price);
      slippage  = +((fillPrice - candidate.decisionPrice) / candidate.decisionPrice * 100).toFixed(2);
    }
  } else {
    fillPrice = price; // DRY: use current price as fill
  }

  // Anchor stop/target to confirmed fill price
  const atrPct      = candidate.atr14 ? parseFloat(candidate.atr14) / candidate.decisionPrice : 0.025;
  const stopPrice   = parseFloat((fillPrice * (1 - atrPct)).toFixed(2));
  const targetPrice = parseFloat((fillPrice * (1 + atrPct * 1.5)).toFixed(2));

  // Build position record and write to trades-open.json
  const posRecord = {
    ...candidate,
    state:       TRADE_STATES.PROTECTED,
    entryPrice:  fillPrice,
    slippagePct: slippage,
    stopPrice, targetPrice,
    currentPnl: 0, maxFavorableExcursion: 0, maxAdverseExcursion: 0,
    stateHistory: [
      ...(candidate.stateHistory || []),
      { state: 'FILLED',     at: new Date().toISOString(), fillPrice, slippage, note: 'ORB fill' },
      { state: 'PROTECTED',  at: new Date().toISOString(), stopPrice, targetPrice, anchoredToFill: true },
    ],
  };

  const openData  = loadOpenPositions();
  openData.positions.push(posRecord);
  atomicWrite(OPEN_POSITIONS_FILE, openData);

  entry.fillPrice = fillPrice; entry.slippage = slippage; entry.stopPrice = stopPrice; entry.targetPrice = targetPrice;
  orbLog.entries.push(entry); saveOrbLog();

  console.log(`  ✅ [${ticker}] ORB fill @ $${fillPrice} (slippage ${slippage > 0 ? '+' : ''}${slippage}%) | stop $${stopPrice} | target $${targetPrice}`);
  return true;
}

// ─── News + VIX for Haiku thesis-break check ─────────────────────────────────
async function getNewsHeadlines(ticker) {
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(ticker + ' stock news today')}`, {
      headers: { 'User-Agent': YAHOO_UA, Accept: 'text/html' },
    });
    const html = await r.text();
    const titles = [...html.matchAll(/<a[^>]+class="result__a"[^>]*>([^<]+)<\/a>/g)].slice(0, 4).map(m => m[1].trim());
    return titles.join(' | ');
  } catch { return '(news unavailable)'; }
}

async function getVIXChange() {
  if (!FMP_KEY) return null;
  try {
    const r = await fetch(`https://financialmodelingprep.com/stable/quote?symbol=%5EVIX&apikey=${FMP_KEY}`);
    const d = await r.json();
    return d?.[0]?.changePercentage ?? null;
  } catch { return null; }
}

// ─── Close Position and Record ────────────────────────────────────────────────
async function closePosition(pos, currentPrice, exitReason) {
  const pnl    = (currentPrice - pos.entryPrice) * pos.fractionalQty;
  const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

  // Item 35: transition to EXIT_PENDING and persist before executing sell
  addStateHistory(pos, TRADE_STATES.EXIT_PENDING, { reason: exitReason, priceAtDecision: currentPrice });
  const openData = loadOpenPositions();
  const livePos  = openData.positions.find(p => p.ticker === pos.ticker);
  if (livePos) { Object.assign(livePos, { state: pos.state, stateHistory: pos.stateHistory }); saveOpenPositions(openData.positions); }

  const result = await executeSell(pos.ticker, currentPrice, pos.dollarAmount, pos.fractionalQty, exitReason);
  if (result?.error) {
    console.error(`  ❌ [${pos.ticker}] Sell failed: ${result.error} — position remains EXIT_PENDING`);
    return false;
  }

  // Item 35: CLOSED
  addStateHistory(pos, TRADE_STATES.CLOSED, { exitPrice: currentPrice, pnl: +pnl.toFixed(2) });

  const stopDistPct = pos.stopPrice ? Math.abs((pos.entryPrice - pos.stopPrice) / pos.entryPrice) : null;
  recordClosedTrade({
    ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
    decisionPrice: pos.decisionPrice || null,
    slippagePct: pos.slippagePct || null,
    entryPrice: pos.entryPrice, exitPrice: currentPrice,
    pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
    rMultiple: stopDistPct ? +(pnlPct / 100 / stopDistPct).toFixed(3) : null,
    signals: pos.signals, setupScore: pos.setupScore, rationale: pos.rationale, catalystType: pos.catalystType || null, regime: pos.regime || null,
    maxFavorableExcursion: pos.maxFavorableExcursion ?? 0,
    maxAdverseExcursion:   pos.maxAdverseExcursion   ?? 0,
    exitReason, entryTime: pos.entryTime, exitTime: new Date().toISOString(), date: today,
    isLive: !DRY_RUN,
    state: TRADE_STATES.CLOSED, stateHistory: pos.stateHistory,
  });

  removeOpenPosition(pos.ticker);

  // Update trade rationale .md file with exit outcome + state transitions
  const slug   = `${today}-${pos.ticker}-${pos.side}`;
  const mdPath = join(OUTPUT_DIR, 'trades', `${slug}.md`);
  if (existsSync(mdPath)) {
    const exitAt = new Date().toISOString();
    let md = readFileSync(mdPath, 'utf-8');
    md = md.replace('| Exit Price | — |',   `| Exit Price | $${currentPrice} |`)
           .replace('| Exit Time | — |',    `| Exit Time | ${exitAt} |`)
           .replace('| P&L | — |',          `| P&L | ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) |`)
           .replace('| Exit Reason | — |',  `| Exit Reason | ${exitReason} |`)
           .replace('| EXIT_PENDING | — | — |', `| EXIT_PENDING | ${exitAt} | ${exitReason} |`)
           .replace('| CLOSED | — | — |',   `| CLOSED | ${exitAt} | exit_price=$${currentPrice}, pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} |`);
    writeFileSync(mdPath, md);
  }

  console.log(`  ✅ [${pos.ticker}] Closed @ $${currentPrice} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(1)}%) — ${exitReason}`);
  return true;
}

// ─── Main Daemon Loop ─────────────────────────────────────────────────────────
async function main() {
  console.log(`\n[exit-daemon] Started — ${today}${DRY_RUN ? ' [DRY RUN]' : ' [LIVE]'}`);
  console.log(`[exit-daemon] Force-close at ${Math.floor(forceCloseTime/60)}:${String(forceCloseTime%60).padStart(2,'0')}am PT | Market close at ${Math.floor(marketCloseTime/60)}:${String(marketCloseTime%60).padStart(2,'0')}pm PT`);
  if (EARLY_CLOSE_DATES.has(today)) console.log('[exit-daemon] ⚠️  Early-close day');

  let lastHaikuCheckMs = 0;
  let openingRangeComputed = false;
  let orb5MinLogged      = false;
  let orb10MinLogged     = false;
  let orbRecoveryLogged  = false;
  let consecutiveQuoteFailures = {};  // ticker → count

  while (true) {
    const ptNow = ptMinutes();
    const nowMs = Date.now();

    // Exit daemon once market is fully closed and positions cleared
    if (ptNow >= marketCloseTime) {
      const remaining = loadOpenPositions().positions;
      if (remaining.length) {
        console.log(`[exit-daemon] Market closed with ${remaining.length} position(s) open — force-closing`);
        for (const pos of [...remaining]) {
          const price = await getCurrentPrice(pos.ticker) || pos.entryPrice;
          await closePosition(pos, price, 'market-close-daemon');
        }
      }
      console.log('[exit-daemon] Market closed — exiting.');
      break;
    }

    const openData    = loadOpenPositions();
    const queuedTrades = loadQueuedTrades();
    if (!openData.positions.length && !queuedTrades.length) {
      if (ptNow >= PT.MARKET_CLOSE - 5) break; // no positions + near close → done
      await sleep(60_000);
      continue;
    }

    // ── 6:35am: log first 5-min price mark for queued candidates ────────────
    if (!orb5MinLogged && ptNow >= PT.OR_5MIN && queuedTrades.length) {
      orb5MinLogged = true;
      await logOrbPrices(queuedTrades, 5);
    }

    // ── 6:40am: log second 5-min price mark for queued candidates ───────────
    if (!orb10MinLogged && ptNow >= PT.OR_10MIN && queuedTrades.length) {
      orb10MinLogged = true;
      await logOrbPrices(queuedTrades, 10);
    }

    // ── 6:45am: ORB entry decisions + opening range stop update ─────────────
    // All 3 first five-minute bars are complete at 6:45am (6:30, 6:35, 6:40 bars close by 6:45)
    if (!openingRangeComputed && ptNow >= PT.OR_CHECK) {
      console.log('[exit-daemon] 6:45am: ORB entry decisions + opening range stop updates...');

      // ── ORB entry: process queued candidates ────────────────────────────
      if (queuedTrades.length) {
        console.log(`[exit-daemon] Processing ${queuedTrades.length} queued candidate(s) for ORB entry...`);
        // Sort by setupScore descending (highest conviction first)
        const sorted = [...queuedTrades].sort((a, b) => (b.setupScore || 0) - (a.setupScore || 0));
        for (const candidate of sorted) {
          const currentOpen = loadOpenPositions();
          const maxPos = parseInt(process.env.MAX_POSITIONS || '4');
          if (currentOpen.positions.length >= maxPos) {
            console.log(`  [${candidate.ticker}] MAX_POSITIONS (${maxPos}) reached — skipping remaining ORB candidates`);
            break;
          }
          await submitOrbEntry(candidate, currentOpen.positions);
          await sleep(500);
        }
      }

      // ── OR stop update: tighten stop for existing PROTECTED positions ────
      const freshOpen = loadOpenPositions();
      const positionsToSave = [...freshOpen.positions];
      const immediateExits = [];

      for (const pos of positionsToSave) {
        // Only apply OR stop to PROTECTED positions
        if (pos.state && pos.state !== TRADE_STATES.PROTECTED) continue;
        const or = await getOpeningRange(pos.ticker);
        if (!or || or.barsUsed < 1) { console.log(`  [${pos.ticker}] OR: no bars yet — skipping`); continue; }
        const orStop = or.orLow;
        // Only tighten, never loosen: OR stop must be HIGHER than current ATR stop
        if (orStop > pos.stopPrice) {
          const oldStop = pos.stopPrice;
          pos.stopPrice = +orStop.toFixed(2);
          const stopDist = Math.abs((pos.entryPrice - orStop) / pos.entryPrice);
          pos.targetPrice = +(pos.entryPrice * (1 + stopDist * 1.5)).toFixed(2);
          console.log(`  [${pos.ticker}] OR stop tightened: $${oldStop} → $${pos.stopPrice} (${or.barsUsed} bars) | new target: $${pos.targetPrice}`);

          // Item 37: if current price already below new OR stop, exit immediately
          const price = await getCurrentPrice(pos.ticker);
          if (price && price <= pos.stopPrice) {
            console.log(`  [${pos.ticker}] Price $${price.toFixed(2)} ≤ OR stop $${pos.stopPrice} — immediate exit (don't wait for next poll)`);
            immediateExits.push({ pos, price });
          }
        } else {
          console.log(`  [${pos.ticker}] OR low $${orStop.toFixed(2)} ≤ current stop $${pos.stopPrice} — no change (would loosen)`);
        }
      }
      saveOpenPositions(positionsToSave);
      openingRangeComputed = true;

      // Process any immediate exits triggered by OR stop crossing
      for (const { pos, price } of immediateExits) {
        await closePosition(pos, price, `or-stop-immediate ($${price.toFixed(2)} ≤ OR low $${pos.stopPrice})`);
      }
    }

    // ── ORB recovery log (at force-close time, before closing positions) ─────
    if (!orbRecoveryLogged && ptNow >= forceCloseTime && orbLog.entries.length) {
      orbRecoveryLogged = true;
      await logOrbRecovery();
    }

    // ── Force-close time ──────────────────────────────────────────────────────
    if (ptNow >= forceCloseTime) {
      console.log(`\n[exit-daemon] 🔴 Force-close time (${Math.floor(forceCloseTime/60)}:${String(forceCloseTime%60).padStart(2,'0')}pm PT) — closing all positions`);
      for (const pos of [...openData.positions]) {
        const price = await getCurrentPrice(pos.ticker) || pos.entryPrice;
        await closePosition(pos, price, `force-close ${Math.floor(forceCloseTime/60)}:${String(forceCloseTime%60).padStart(2,'0')}pm PT`);
        await sleep(500);
      }
      console.log('[exit-daemon] All positions force-closed.');
      break;
    }

    // ── Fast loop: stop/target check ─────────────────────────────────────────
    const updatedPositions = [...openData.positions];
    for (const pos of updatedPositions) {
      // Item 35: stop/target only valid once PROTECTED. If no state field (legacy records), treat as PROTECTED.
      if (pos.state === TRADE_STATES.QUEUED) {
        console.log(`  [${pos.ticker}] QUEUED — awaiting ORB decision at 6:45am`);
        continue;
      }
      if (pos.state === TRADE_STATES.ORDER_PENDING) {
        if (ptNow >= PT.MARKET_OPEN) {
          await confirmFill(pos, openData);
        } else {
          console.log(`  [${pos.ticker}] ORDER_PENDING — market not yet open, waiting`);
        }
        continue;
      }
      if (pos.state && pos.state !== TRADE_STATES.PROTECTED) {
        console.log(`  [${pos.ticker}] Waiting for PROTECTED state (current: ${pos.state}) — skipping stop/target`);
        continue;
      }

      const price = await getCurrentPrice(pos.ticker);

      if (price == null) {
        consecutiveQuoteFailures[pos.ticker] = (consecutiveQuoteFailures[pos.ticker] || 0) + 1;
        const fails = consecutiveQuoteFailures[pos.ticker];
        console.warn(`  [${pos.ticker}] Quote unavailable (fail #${fails})`);
        if (fails >= 5) {
          console.warn(`  [${pos.ticker}] 5 consecutive quote failures — force-closing for safety`);
          await closePosition(pos, pos.entryPrice, 'quote-unavailable-5-consecutive-fails');
        }
        continue;
      }
      consecutiveQuoteFailures[pos.ticker] = 0;

      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;

      // Update MFE/MAE (item 31)
      pos.maxFavorableExcursion = Math.max(pos.maxFavorableExcursion || 0, pnlPct);
      pos.maxAdverseExcursion   = Math.min(pos.maxAdverseExcursion   || 0, pnlPct);
      pos.currentPnl = (price - pos.entryPrice) * pos.fractionalQty;

      // Stop/target check
      let exitReason = null;
      if (price <= pos.stopPrice) {
        exitReason = `stop-loss hit ($${price.toFixed(2)} ≤ $${pos.stopPrice})`;
      } else if (price >= pos.targetPrice) {
        exitReason = `target hit ($${price.toFixed(2)} ≥ $${pos.targetPrice})`;
      }

      if (exitReason) {
        await closePosition(pos, price, exitReason);
      } else {
        console.log(`  [${pos.ticker}] $${price.toFixed(2)} | stop=$${pos.stopPrice} | target=$${pos.targetPrice} | ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`);
      }

      await sleep(300); // small gap between ticker polls
    }

    // Save updated MFE/MAE and currentPnl
    const stillOpen = loadOpenPositions().positions; // re-read (some may have been closed above)
    for (const pos of stillOpen) {
      const updated = updatedPositions.find(p => p.ticker === pos.ticker);
      if (updated) {
        pos.maxFavorableExcursion = updated.maxFavorableExcursion;
        pos.maxAdverseExcursion   = updated.maxAdverseExcursion;
        pos.currentPnl            = updated.currentPnl;
      }
    }
    if (stillOpen.length > 0) saveOpenPositions(stillOpen);

    // ── Slow loop: Haiku thesis-break check every 90 min ─────────────────────
    if (nowMs - lastHaikuCheckMs >= 90 * 60 * 1000) {
      lastHaikuCheckMs = nowMs;
      const openNow = loadOpenPositions().positions;
      for (const pos of openNow) {
        const price = await getCurrentPrice(pos.ticker);
        if (!price) continue;
        const [newsHdl, vixChg] = await Promise.all([getNewsHeadlines(pos.ticker), getVIXChange()]);
        const vixSpike = vixChg && parseFloat(vixChg) > 15;
        const newsLower = newsHdl.toLowerCase();
        const hasRisk = vixSpike || newsLower.includes('halt') || newsLower.includes('investigation') || newsLower.includes('fraud');
        if (!hasRisk) continue;
        console.log(`  [${pos.ticker}] Thesis-break indicators — asking Haiku`);
        try {
          const judgment = await client.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 150,
            messages: [{ role: 'user', content: `Open position: ${pos.ticker} bought @ $${pos.entryPrice}. Original thesis: ${pos.rationale?.slice(0, 200)}. Stop: $${pos.stopPrice}. Current: $${price}. News: "${newsHdl.slice(0, 200)}". VIX change: ${vixChg}%. Should we exit NOW or hold to stop? Reply with "exit" or "hold" plus one sentence.` }],
          });
          const verdict = judgment.content[0]?.text?.toLowerCase() || '';
          console.log(`  [${pos.ticker}] Haiku: ${verdict.slice(0, 120)}`);
          if (verdict.startsWith('exit')) {
            await closePosition(pos, price, `haiku-thesis-break: ${verdict.slice(5, 80)}`);
          }
        } catch (e) { console.warn(`  [${pos.ticker}] Haiku call failed: ${e.message}`); }
      }
    }

    await sleep(45_000); // 45-second poll interval
  }

  console.log('[exit-daemon] Done.\n');
}

main().catch(e => { console.error('[exit-daemon] Fatal:', e.message); process.exit(1); });
