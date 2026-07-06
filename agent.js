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
const US_MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-02',
  '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// Early-close days: market closes at 1pm ET / 10am PT
const EARLY_CLOSE_DATES = new Set(['2026-11-27', '2026-12-24', '2027-11-26']);

function getDateStr(daysFromNow = 0) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

// PT-aware date/day — avoids UTC vs local ambiguity in launchd environments
function getPTDateParts() {
  const ptStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  const d = new Date(ptStr + 'T12:00:00'); // noon to avoid DST edge
  return { dateStr: ptStr, dow: d.getDay() };
}

const { dateStr: today, dow: dayOfWeek } = getPTDateParts();

// ─── Position Config ──────────────────────────────────────────────────────────
// Up to 4 concurrent positions, $125 fixed per trade.
// Max deployed: $500. Daily stop at -1.5% SOD (~$17) comfortably exceeds worst-case
// 4 simultaneous stops (~$8 total at 1R each).
const PILOT_MODE       = process.env.PILOT_MODE !== 'false'; // kept for prompt text
const MAX_POSITIONS    = 4;
const POSITION_DOLLARS = 125;
const POSITION_PCT     = POSITION_DOLLARS / 1150; // approx, kept for log lines

const SOD_BALANCE_FILE = join(OUTPUT_DIR, 'sod-balance.json');

// ─── Constants ────────────────────────────────────────────────────────────────
const SIGNAL_KEYS = [
  'premarket_gap_up',    // gap >2% pre-market on elevated volume
  'rvol_spike',          // relative volume >2x 30-day pre-market avg
  'gap_likely_holds',    // gap >5%: historically holds momentum intraday (true = bullish)
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
const CIRCUIT_BREAKER_FILE = join(OUTPUT_DIR, 'circuit-breaker.json');

// ─── Trade State Machine (item 35) ───────────────────────────────────────────
const TRADE_STATES = {
  CANDIDATE:       'CANDIDATE',       // score passed, pre-checks not yet run
  ORDER_SUBMITTED: 'ORDER_SUBMITTED', // order sent to broker
  ORDER_PENDING:   'ORDER_PENDING',   // waiting for fill confirmation
  PARTIALLY_FILLED:'PARTIALLY_FILLED',// partial fill observed
  FILLED:          'FILLED',          // confirmed average fill price known
  PROTECTED:       'PROTECTED',       // stop/target set from fill price, daemon monitoring
  EXIT_PENDING:    'EXIT_PENDING',    // sell order submitted
  CLOSED:          'CLOSED',          // position fully exited
};

function transitionState(posRecord, newState, meta = {}) {
  posRecord.state = newState;
  if (!posRecord.stateHistory) posRecord.stateHistory = [];
  posRecord.stateHistory.push({ state: newState, at: new Date().toISOString(), ...meta });
  const note = meta.fillPrice ? ` @ $${meta.fillPrice}` : meta.stopPrice ? ` stop=$${meta.stopPrice}` : '';
  console.log(`  [${posRecord.ticker || '?'}] ▶ ${newState}${note}`);
}

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
  if (entry.entryTime && entry.exitTime) {
    entry.timeInTradeMinutes = Math.round((new Date(entry.exitTime) - new Date(entry.entryTime)) / 60000);
  }
  log.trades.push(entry);
  atomicWrite(TRADES_LOG_FILE, log);
}

// ─── Logistic Regression (pure JS, no dependencies) ──────────────────────────
function sigmoid(x) { return 1 / (1 + Math.exp(-Math.max(-500, Math.min(500, x)))); }

function trainModel(trades) {
  const MIN_TRADES = 100;
  const complete = trades.filter(t => t.pnl !== null && t.pnl !== undefined && t.signals);
  if (complete.length < MIN_TRADES) return null; // fall back to equal-weight

  const features = complete.map(t => SIGNAL_KEYS.map(k => (t.signals?.[k] ? 1 : 0)));
  const labels   = complete.map(t => (t.pnl > 0 ? 1 : 0));
  // Weight each sample by |rMultiple| so high-R trades matter more than marginal wins/losses.
  // A +4R win contributes 4× more to gradient than a +1R win with identical binary label.
  const sampleWeights = complete.map(t => Math.max(0.2, Math.abs(t.rMultiple ?? 1)));
  const totalWeight   = sampleWeights.reduce((a, b) => a + b, 0);
  const n = features.length;

  // Compute variance per feature before training. Near-zero-variance features (e.g.
  // premarket_gap_up, which is true on nearly every screener output) are excluded from
  // gradient updates — they can't be informative and risk destabilising coefficients.
  const featureVariance = SIGNAL_KEYS.map((_, j) => {
    const vals = features.map(f => f[j]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    return vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  });
  const activeIdx = SIGNAL_KEYS.map((_, j) => j).filter(j => featureVariance[j] >= 0.04);
  const excluded  = SIGNAL_KEYS.filter((_, j) => featureVariance[j] < 0.04);
  if (excluded.length > 0) {
    console.warn(`  ⚠️  Excluding near-zero-variance features from training (weight zeroed): ${excluded.join(', ')}`);
  }

  let weights = new Array(SIGNAL_KEYS.length).fill(0);
  let bias    = 0;
  const lr = 0.05, lambda = 0.01, epochs = 500;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const dW = new Array(SIGNAL_KEYS.length).fill(0);
    let db = 0;
    for (let i = 0; i < n; i++) {
      const pred = sigmoid(activeIdx.reduce((s, j) => s + features[i][j] * weights[j], 0) + bias);
      const w    = sampleWeights[i];
      const err  = pred - labels[i];
      activeIdx.forEach(j => { dW[j] += w * err * features[i][j]; });
      db += w * err;
    }
    activeIdx.forEach(j => { weights[j] = weights[j] - lr * (dW[j] / totalWeight + lambda * weights[j]); });
    bias -= lr * (db / totalWeight);
  }
  // Weights for excluded features remain 0 — they don't contribute to setup_score

  return { weights, bias, trainedOn: complete.length, lastUpdated: today, excludedFeatures: excluded };
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
    ctx += `\n### SIGNAL MODEL\nNot yet trained (need 60+ completed trades). Using equal-weight setup_score scoring.\n`;
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

// ─── Circuit Breakers (item 17) ───────────────────────────────────────────────
const CIRCUIT = { tripped: false, tradesExecuted: [], weekStartBalance: null };

function loadSODBalance() {
  if (!existsSync(SOD_BALANCE_FILE)) return null;
  try {
    const d = JSON.parse(readFileSync(SOD_BALANCE_FILE, 'utf-8'));
    return d.date === today ? d.balance : null;
  } catch { return null; }
}

function saveSODBalance(balance) {
  atomicWrite(SOD_BALANCE_FILE, { date: today, balance });
}

// ─── Persistent Circuit Breaker State (item 38) ───────────────────────────────
// Does NOT auto-clear — requires: node agent.js reset-circuit
function loadCircuitBreakerState() {
  if (!existsSync(CIRCUIT_BREAKER_FILE)) return { tripped: false };
  try { return JSON.parse(readFileSync(CIRCUIT_BREAKER_FILE, 'utf-8')); } catch { return { tripped: false }; }
}
function saveCircuitBreakerState(state) { atomicWrite(CIRCUIT_BREAKER_FILE, state); }

// Realized P&L from trades closed today + unrealized from open positions
function computeDailyPnl(openPositions) {
  const log = loadTradesLog();
  const realized = log.trades
    .filter(t => t.date === today && t.pnl !== null)
    .reduce((s, t) => s + (t.pnl || 0), 0);
  const unrealized = openPositions.reduce((s, p) => s + (p.currentPnl || 0), 0);
  return realized + unrealized;
}

// Item 17: formula uses SOD balance as denominator; limits tightened to 1.5% / 5%
function checkCircuitBreaker(currentBalance, totalDailyPnl, weekStartBalance) {
  const sodBalance    = loadSODBalance() || currentBalance;
  const dailyLossPct  = (totalDailyPnl / sodBalance) * 100;
  const weeklyLossPct = weekStartBalance ? ((currentBalance - weekStartBalance) / weekStartBalance) * 100 : 0;

  if (dailyLossPct <= -1.5) {
    CIRCUIT.tripped = true;
    return { blocked: true, reason: `Daily loss ${dailyLossPct.toFixed(2)}% exceeds -1.5% limit (realized + unrealized vs SOD balance)` };
  }
  if (weeklyLossPct <= -5) {
    CIRCUIT.tripped = true;
    return { blocked: true, reason: `Weekly drawdown ${weeklyLossPct.toFixed(2)}% exceeds -5% limit — manual review required` };
  }
  return { blocked: false };
}

function computePositionDollars(_balance) {
  return POSITION_DOLLARS; // fixed $125 per position
}

function checkMaxConcurrent(openPositions) {
  if (openPositions.length >= MAX_POSITIONS) {
    return { blocked: true, reason: `Already at max ${MAX_POSITIONS} position(s): ${openPositions.map(p => p.ticker).join(', ')}` };
  }
  return { blocked: false };
}

// Item 21: pause if last 3 completed trades are all losses
function checkConsecutiveLosses() {
  const log = loadTradesLog();
  const recent = log.trades.filter(t => t.pnl !== null).slice(-3);
  if (recent.length >= 3 && recent.every(t => t.pnl < 0)) {
    return { blocked: true, reason: '3 consecutive losses — paused for manual review before next entry' };
  }
  return { blocked: false };
}

// Item 22: reconcile local trades-open.json against Robinhood reported positions
async function reconcilePositions(acct) {
  if (!acct) return { ok: true, skipped: true };
  const local = loadOpenPositions().positions;
  try {
    const result = await rhMCP('get_equity_positions', { account_number: acct });
    const brokerPos = (result?.data?.positions || []).filter(p => parseFloat(p.quantity) > 0);
    const brokerTickers = new Set(brokerPos.map(p => p.symbol));
    const localTickers  = new Set(local.map(p => p.ticker));
    const inLocalOnly   = local.filter(p => p.state !== 'ORDER_PENDING' && !brokerTickers.has(p.ticker));
    const inBrokerOnly  = brokerPos.filter(p => !localTickers.has(p.symbol));
    if (inLocalOnly.length || inBrokerOnly.length) {
      const msg = [
        'POSITION MISMATCH',
        `Local: [${[...localTickers].join(', ') || 'none'}]`,
        `Broker: [${[...brokerTickers].join(', ') || 'none'}]`,
        inLocalOnly.length  ? `Local-only: ${inLocalOnly.map(p => p.ticker).join(', ')}` : '',
        inBrokerOnly.length ? `Broker-only: ${inBrokerOnly.map(p => p.symbol).join(', ')}` : '',
      ].filter(Boolean).join(' | ');
      console.warn(`  ⚠️  ${msg}`);
      return { ok: false, mismatch: msg };
    }
    console.log(`  ✅ Reconciliation OK — ${local.length} position(s) match broker`);
    return { ok: true };
  } catch (e) {
    console.warn(`  ⚠️  Reconciliation failed: ${e.message} — proceeding cautiously`);
    return { ok: false, error: e.message };
  }
}

// Item 28: count live (non-DRY) trades to guard model-driven sizing
function computeLiveTradeCount() {
  return loadTradesLog().trades.filter(t => t.isLive === true).length;
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

// Item 23: live market-day check via Yahoo Finance — fail closed if unavailable
// Calendar-only check — no network, safe to use for safety-critical operations
function calendarTradingDay() {
  if (dayOfWeek === 0 || dayOfWeek === 6) return false;
  if (US_MARKET_HOLIDAYS.has(today)) return false;
  return true;
}

// Yahoo-enhanced check — use for scan only (non-safety-critical, pre-market timing)
async function isMarketDay() {
  if (!calendarTradingDay()) return false;
  // Calendar says trading day. Use Yahoo only to catch unexpected emergency closures.
  // Fail OPEN — undefined/network errors are not grounds to skip a calendar trading day.
  try {
    const result = await yahooChart('QQQ', '5d', '1d');
    if (!result) {
      console.warn('[market-check] Yahoo Finance unavailable — proceeding (calendar trading day)');
      return true;
    }
    const state = result.meta?.marketState;
    if (state === 'CLOSED') {
      console.warn('[market-check] QQQ marketState="CLOSED" on weekday — emergency closure?');
      return false;
    }
    if (state) console.log(`[market-check] QQQ marketState="${state}"`);
    else console.warn('[market-check] QQQ marketState undefined — proceeding (calendar trading day)');
    return true;
  } catch (e) {
    console.warn(`[market-check] Yahoo error: ${e.message} — proceeding (calendar trading day)`);
    return true;
  }
}

async function sendAlertEmail(subject, body) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return;
  try {
    const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    await transporter.sendMail({ from: user, to: user, subject: `🚨 ${subject}`, text: body });
    console.log(`  📧 Alert sent: ${subject}`);
  } catch (e) { console.warn(`  ⚠️  Alert email failed: ${e.message}`); }
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
  // Robinhood fractional share orders require market type — limit orders are not
  // supported for fractional quantities. Slippage risk is managed post-fill via
  // the slippage gate in place_trade (exits immediately if fill > 50% of stop).
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

async function fetchDayStats(symbol, date) {
  try {
    const result = await yahooChart(symbol, '30d', '1d');
    if (!result) return null;
    const timestamps = result.timestamp || [];
    const quotes     = result.indicators?.quote?.[0] || {};
    const closes = quotes.close || [];
    const highs  = quotes.high  || [];
    for (let i = 0; i < timestamps.length; i++) {
      if (new Date(timestamps[i] * 1000).toISOString().split('T')[0] === date && closes[i] != null)
        return { close: closes[i], high: highs[i] ?? null };
    }
    return null;
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

// Opening range from first 15 min of session (used by exit-daemon; stub available here for reference)
async function getOpeningRange(ticker) {
  try {
    const result = await yahooChart(ticker, '1d', '5m');
    if (!result?.indicators?.quote?.[0]) return null;
    const timestamps = result.timestamp || [];
    const highs = result.indicators.quote[0].high || [];
    const lows  = result.indicators.quote[0].low  || [];
    const mktOpenUtcMs = new Date(`${today}T13:30:00Z`).getTime(); // 6:30am PT ≈ 13:30 UTC
    const firstBars = timestamps
      .map((t, i) => ({ ms: t * 1000, h: highs[i], l: lows[i] }))
      .filter(b => b.ms >= mktOpenUtcMs && b.h != null && b.l != null)
      .slice(0, 3);
    if (!firstBars.length) return null;
    return { orHigh: Math.max(...firstBars.map(b => b.h)), orLow: Math.min(...firstBars.map(b => b.l)), barsUsed: firstBars.length };
  } catch { return null; }
}

// Compute pre-market gap% and RVOL for a ticker
async function getPreMarketData(ticker) {
  const [q, hist, profileArr] = await Promise.all([
    yahooQuote(ticker),
    fmp(`historical-price-eod/light?symbol=${ticker}&limit=35`),
    fmp(`profile?symbol=${ticker}`),
  ]);
  const profile = Array.isArray(profileArr) ? profileArr[0] : null;

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
    gapFillProb: gapPct === null ? null : gapPct > 5 ? 'low' : gapPct > 2 ? 'medium' : 'high',
    // true = gap >5% → historically holds intraday (item 16 note: renamed from gap_fill_low_prob)
    gapFillLowProb: gapPct !== null && gapPct > 5,
    // Item 26: execution/liquidity fields (opening range populated by exit-daemon post-open)
    sharesFloat:       profile?.floatShares ?? null,
    sharesOutstanding: profile?.sharesOutstanding ?? null,
    openingRangeHigh: null, // updated by exit-daemon after 6:35am PT
    openingRangeLow:  null,
    vwap:             null, // updated by exit-daemon from intraday bars
  };
}

async function getQuote(ticker) {
  const d = await fmp(`quote?symbol=${ticker}`);
  if (Array.isArray(d) && d[0]) return d[0];
  // FMP down or rate-limited — fall back to Yahoo so place_trade isn't blocked
  return yahooQuote(ticker);
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
  // Primary: FMP earnings calendar for today — structured data, single call, not rate-limited.
  // Fallback: DuckDuckGo web search if FMP returns nothing (free tier gap or network issue).
  try {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];
    const data = await fmp(`earnings-calendar?from=${today}&to=${tomorrow}`);
    if (Array.isArray(data) && data.length > 0) {
      const todayEarnings = data.filter(e => e.date === today);
      if (todayEarnings.length > 0) {
        return {
          source: 'FMP',
          earningsToday: todayEarnings.map(e => ({ ticker: e.symbol, time: e.time, eps: e.epsEstimated, revenue: e.revenueEstimated })),
          note: 'HARD EXCLUDE any ticker with earnings today before close — do not trade regardless of setup score.',
        };
      }
      return { source: 'FMP', earningsToday: [], note: 'No earnings today per FMP — proceed normally.' };
    }
  } catch {}
  // Fallback to web search if FMP fails
  const search = await webSearch(`earnings calendar today ${today} results expected`, 6);
  return { source: 'DuckDuckGo-fallback', results: search.results || [], note: 'FMP earnings unavailable — treat this list with caution. When in doubt, skip any stock with earnings rumor.' };
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
        setupScore:    { type: 'number', description: 'Signal confluence score 0-1. Equal-weight until 100+ trades; model-driven direction after 100; size variation only after 200 live trades. Must be >0.45 to trade.' },
        rationale:     { type: 'string', description: 'Why this stock today — specific pre-market data, catalyst, signal confluence.' },
        signals: {
          type: 'object',
          properties: {
            premarket_gap_up:   { type: 'boolean' },
            rvol_spike:         { type: 'boolean' },
            gap_likely_holds:   { type: 'boolean' },
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
        catalystType:  { type: 'string', enum: ['earnings_beat','earnings_miss','guidance_raise','analyst_upgrade','fda_news','ma','insider_purchase','macro','sector_sympathy','notable_mention','product_launch','regulatory','technical'], description: 'Primary catalyst driving the gap. Used for edge validation over time.' },
        sector:        { type: 'string', description: 'GICS sector of the ticker (e.g. "Technology", "Consumer Discretionary"). Required for sector concentration guard — max 2 concurrent positions per sector.' },
        regime: {
          type: 'object',
          description: 'Market regime snapshot at entry — populated from Phase 1 get_fear_greed_vix output. Used to slice edge by regime after 100+ trades.',
          properties: {
            vixLevel:        { type: 'number', description: 'VIX spot price at time of entry' },
            vixBucket:       { type: 'string', enum: ['low','elevated','high','extreme'], description: '<15=low, 15-20=elevated, 20-30=high, >30=extreme' },
            fearGreedScore:  { type: 'number', description: 'CNN Fear & Greed score 0-100' },
            fearGreedBucket: { type: 'string', enum: ['extreme_fear','fear','neutral','greed','extreme_greed'] },
            spyVs50dma:      { type: 'string', enum: ['above','below'], description: 'SPY relative to its 50-day MA' },
            qqqVs50dma:      { type: 'string', enum: ['above','below'], description: 'QQQ relative to its 50-day MA' },
            spyChangePct:    { type: 'number', description: 'SPY % change today (from get_fear_greed_vix indices). Used to flag market-driven days where |change| > 1.5%.' },
          },
        },
      },
      required: ['ticker', 'side', 'setupScore', 'rationale', 'signals', 'catalystType'],
    },
  },
  {
    name: 'log_rejected_candidate',
    description: 'Log a candidate that passed gap/RVOL filters but scored below the trade threshold. Used for shadow P&L tracking to evaluate what was missed.',
    input_schema: {
      type: 'object',
      properties: {
        ticker:     { type: 'string' },
        setupScore: { type: 'number', description: 'Score at time of rejection' },
        gapPct:     { type: 'number' },
        rvol:       { type: 'number' },
        signals:    { type: 'object' },
        reason:     { type: 'string', description: 'Why rejected — score too low, earnings risk, RVOL insufficient, etc.' },
      },
      required: ['ticker', 'setupScore', 'reason'],
    },
  },
  {
    name: 'log_daily_candidates',
    description: 'Log all screener candidates evaluated today with ranks, signal breakdowns, and composite scores. Call once at the end of the session after all trades and shadow logs are done.',
    input_schema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rank:           { type: 'number', description: 'Agent rank by composite score (1 = highest score)' },
              screenerRank:   { type: 'number', description: 'Screener rank by gap% (1 = largest gap)' },
              ticker:         { type: 'string' },
              gapPct:         { type: 'number' },
              compositeScore: { type: 'number' },
              signals:        { type: 'object' },
              action:         { type: 'string', description: 'traded | shadow_logged | skipped | hard_excluded' },
              reason:         { type: 'string' },
            },
            required: ['rank', 'ticker', 'compositeScore', 'action'],
          },
        },
      },
      required: ['candidates'],
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
      const equity = parseFloat(port?.total_value || port?.cash || port?.equity_value || 0);
      return {
        accountNumber: acct, totalValue: port?.total_value, equityValue: port?.equity_value,
        cash: port?.cash, buyingPower: port?.buying_power?.buying_power,
        positions: posResult?.data?.positions || [],
        equityNumeric: equity,
      };
    }
    case 'place_trade': {
      // ── Item 38: persistent circuit breaker check (does not auto-clear) ──────
      const cbPersist = loadCircuitBreakerState();
      if (cbPersist.tripped) return { blocked: true, reason: `Circuit breaker: ${cbPersist.reason} — reset with: node agent.js reset-circuit` };
      if (CIRCUIT.tripped) return { blocked: true, reason: 'Circuit breaker tripped this session.' };

      const { ticker, side, setupScore, rationale, signals, targetPrice: rawTarget, stopPrice: rawStop, atr14, marketContext, samAlignment, catalystType, sector, regime } = input;

      // ── Item 35: initialize position record with state machine ────────────────
      const posRecord = { ticker, side, state: TRADE_STATES.CANDIDATE, stateHistory: [] };
      transitionState(posRecord, TRADE_STATES.CANDIDATE, { setupScore });

      // Hard excludes
      if (setupScore < 0.45) return { blocked: true, reason: `setup_score ${setupScore.toFixed(2)} < 0.45 threshold` };
      if (!signals?.premarket_gap_up) return { blocked: true, reason: 'Hard gate: premarket_gap_up must be true — gap must exceed 2% pre-market before entry' };
      // rvol_spike is NOT a hard code gate — Yahoo preMarketVolume returns null at 6am PT,
      // making rvolHigh unreliable as a binary block. Kept as a heavily-weighted scoring signal.
      if (new Date().getUTCHours() >= 17) return { blocked: true, reason: 'Entry window closed — past 10am PT' };

      const lossCheck = checkConsecutiveLosses();
      if (lossCheck.blocked) return lossCheck;

      const acct = await rhGetAccountNumber();
      const reconcile = await reconcilePositions(acct);
      if (!reconcile.ok && reconcile.mismatch) {
        await sendAlertEmail('Position Mismatch — Trading Halted', reconcile.mismatch);
        return { blocked: true, reason: `Reconciliation mismatch: ${reconcile.mismatch}` };
      }

      const openData = loadOpenPositions();
      const concurrentCheck = checkMaxConcurrent(openData.positions);
      if (concurrentCheck.blocked) return concurrentCheck;

      // Sector correlation tag: flag when another concurrent position shares this sector.
      // Not a block — just marks the trade so sector-clustered days can be discounted at N=60.
      const sharedSector = sector
        ? openData.positions.some(p => p.sector === sector)
        : false;

      // ── Get portfolio once — used for both circuit breaker and sizing ─────────
      const portResult = acct ? await rhMCP('get_portfolio', { account_number: acct }) : null;
      const port       = portResult?.data || portResult || {};
      let equity       = parseFloat(
        port?.total_value || port?.cash || port?.equity_value ||
        port?.equity || port?.market_value || 0
      );
      if (!equity && DRY_RUN) {
        equity = loadSODBalance() || 1150;
        console.log(`  ℹ️  DRY_RUN: portfolio $0 — using $${equity} for paper sizing`);
      }
      if (!equity) return { error: 'Could not read account balance — pre-flight failed' };

      // ── Item 34: use settled buying power for position sizing ─────────────────
      const rawBP       = parseFloat(port?.buying_power?.buying_power || port?.buying_power || 0);
      const availableCash = rawBP > 0 ? rawBP : equity;
      if (rawBP > 0 && equity > 0) {
        const unsettledPct = ((equity - rawBP) / equity) * 100;
        if (unsettledPct > 10) {
          console.warn(`  ⚠️  [item34] Settled cash: buying_power=$${rawBP.toFixed(2)} vs equity=$${equity.toFixed(2)} (${unsettledPct.toFixed(1)}% unsettled — good-faith-violation risk if <$2 cash buffer)`);
        } else {
          console.log(`  💰 buying_power=$${rawBP.toFixed(2)} | equity=$${equity.toFixed(2)}`);
        }
      }

      // ── Item 38: circuit breaker — broker equity as source of truth ───────────
      const sodBalance    = loadSODBalance() || equity;
      const dailyBrokerPct = ((equity - sodBalance) / sodBalance) * 100;
      const localPnl      = computeDailyPnl(openData.positions);
      const localDailyPct = sodBalance ? (localPnl / sodBalance) * 100 : 0;
      if (Math.abs(dailyBrokerPct - localDailyPct) > 2) {
        console.warn(`  ⚠️  P&L source discrepancy: broker=${dailyBrokerPct.toFixed(2)}% vs local=${localDailyPct.toFixed(2)}% — using broker equity as truth`);
      }
      console.log(`  📊 Daily P&L: ${dailyBrokerPct >= 0 ? '+' : ''}${dailyBrokerPct.toFixed(2)}% (broker) | SOD=$${sodBalance.toFixed(2)} | now=$${equity.toFixed(2)}`);

      if (dailyBrokerPct <= -1.5) {
        const tripReason = `Daily loss ${dailyBrokerPct.toFixed(2)}% of SOD balance ($${sodBalance.toFixed(2)})`;
        saveCircuitBreakerState({ tripped: true, reason: tripReason, trippedAt: new Date().toISOString(), equity, sodBalance });
        CIRCUIT.tripped = true;
        await flattenAllPositions('circuit-breaker-daily-loss');
        await sendAlertEmail('🔴 Circuit Breaker Tripped', `${tripReason}\n\nAll positions flattened. Cannot-autoclear — run: node agent.js reset-circuit`);
        return { blocked: true, reason: tripReason };
      }
      const weeklyLossPct = CIRCUIT.weekStartBalance ? ((equity - CIRCUIT.weekStartBalance) / CIRCUIT.weekStartBalance) * 100 : 0;
      if (weeklyLossPct <= -5) {
        const tripReason = `Weekly drawdown ${weeklyLossPct.toFixed(2)}%`;
        saveCircuitBreakerState({ tripped: true, reason: tripReason, trippedAt: new Date().toISOString(), equity });
        CIRCUIT.tripped = true;
        await flattenAllPositions('circuit-breaker-weekly-drawdown');
        await sendAlertEmail('🔴 Weekly Drawdown Limit', `${tripReason}\n\nAll positions flattened. Run: node agent.js reset-circuit`);
        return { blocked: true, reason: tripReason };
      }

      // ── Sizing from buying power (item 34), price from screener → FMP fallback ──
      // Screener fetches true 5-min Yahoo pre-market bars at 5:55am — always use that
      // as the decision price. FMP quote at 6am can return stale previous-day close
      // on large overnight gaps (e.g. earnings). FMP is fallback only.
      const dollarAmount = computePositionDollars(availableCash);
      const screenerCandidate = loadScreenerCandidates()?.candidates?.find(c => c.ticker === ticker);
      const screenerPrice = screenerCandidate?.preMarketPrice ?? null;
      const quote = screenerPrice ? null : await getQuote(ticker);
      const decisionPrice = screenerPrice || quote?.price;
      if (screenerPrice) console.log(`  📡 Using screener pre-mkt price $${screenerPrice} for ${ticker}`);
      else console.log(`  📡 Screener price unavailable — using FMP quote $${quote?.price} for ${ticker}`);
      if (!decisionPrice) return { error: `Could not get current price for ${ticker}` };

      const fractionalQty = (dollarAmount / decisionPrice).toFixed(4);
      console.log(`\n  📈 ${DRY_RUN ? '[DRY] ' : ''}${side.toUpperCase()} $${dollarAmount} (${fractionalQty} sh) ${ticker} | score=${setupScore.toFixed(2)}`);

      // Fill in full position fields (stop/target initially from ATR/agent input)
      Object.assign(posRecord, {
        decisionPrice,
        dollarAmount:  parseFloat(dollarAmount),
        fractionalQty: parseFloat(fractionalQty),
        stopPrice:     rawStop  || parseFloat((decisionPrice * (1 - 0.025)).toFixed(2)),
        targetPrice:   rawTarget || parseFloat((decisionPrice * (1 + 0.0375)).toFixed(2)),
        atr14:  atr14  || null,
        signals: signals || {},
        setupScore, rationale, marketContext, samAlignment, catalystType: catalystType || null,
        sector: sector || null,
        sharedSector: sharedSector,
        marketDrivenDay: Math.abs(parseFloat(regime?.spyChangePct ?? 0)) > 1.5,
        regime: regime || null,
        entryTime:  new Date().toISOString(),
        entryPrice: decisionPrice, // updated to confirmed fill below
        slippagePct: 0,
        currentPnl: 0, maxFavorableExcursion: 0, maxAdverseExcursion: 0,
        isLive: !DRY_RUN,
      });

      // ── Item 35: ORDER_SUBMITTED ──────────────────────────────────────────────
      transitionState(posRecord, TRADE_STATES.ORDER_SUBMITTED, { decisionPrice, dollarAmount });

      const orderResult = await executeMarketOrder(ticker, side, dollarAmount, decisionPrice, rationale.slice(0, 80));
      if (orderResult.error) { console.log(`  ❌ Failed: ${orderResult.error}`); return orderResult; }

      // ── Item 35: fill confirmation → FILLED → PROTECTED ──────────────────────
      let entryPrice  = decisionPrice;
      let slippagePct = 0;

      if (DRY_RUN) {
        // Simulate immediate fill at decision price, then re-anchor stop/target to fill
        transitionState(posRecord, TRADE_STATES.FILLED, { fillPrice: decisionPrice, note: 'DRY_RUN — decision price used as fill' });
        const dryAtrPct = atr14 ? (parseFloat(atr14) / decisionPrice) : 0.025;
        posRecord.stopPrice   = parseFloat((decisionPrice * (1 - dryAtrPct)).toFixed(2));
        posRecord.targetPrice = parseFloat((decisionPrice * (1 + dryAtrPct * 1.5)).toFixed(2));
        transitionState(posRecord, TRADE_STATES.PROTECTED, { stopPrice: posRecord.stopPrice, targetPrice: posRecord.targetPrice });
      } else {
        // Live: poll broker for confirmed average fill price (up to 3 attempts)
        transitionState(posRecord, TRADE_STATES.ORDER_PENDING);
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(2500);
          const positions = await rhMCP('get_equity_positions', { account_number: acct });
          const filled = (positions?.data?.positions || []).find(p => p.symbol === ticker);
          if (filled?.average_buy_price) {
            entryPrice  = parseFloat(filled.average_buy_price);
            slippagePct = Math.abs((entryPrice - decisionPrice) / decisionPrice * 100);
            transitionState(posRecord, TRADE_STATES.FILLED, { fillPrice: entryPrice, slippagePct: +slippagePct.toFixed(3) });
            // Recompute stop/target from confirmed fill price — use atr14 as % of decision price
            // so the same ATR distance is preserved regardless of slippage between research and fill
            const stopDist = atr14 ? (parseFloat(atr14) / decisionPrice) : (rawStop ? Math.abs((rawStop - decisionPrice) / decisionPrice) : 0.025);
            posRecord.entryPrice  = entryPrice;
            posRecord.slippagePct = +slippagePct.toFixed(3);
            posRecord.stopPrice   = parseFloat((entryPrice * (1 - stopDist)).toFixed(2));
            posRecord.targetPrice = parseFloat((entryPrice * (1 + stopDist * 1.5)).toFixed(2));
            transitionState(posRecord, TRADE_STATES.PROTECTED, { stopPrice: posRecord.stopPrice, targetPrice: posRecord.targetPrice });

            // Slippage gate: if fill ate >50% of the stop distance, the thesis is already
            // compromised before the first bar. Immediately exit rather than hold a position
            // whose stop is effectively already hit.
            if (stopDist > 0 && (slippagePct / 100) > stopDist * 0.5) {
              console.warn(`  🚫 Slippage gate: ${slippagePct.toFixed(2)}% slippage > 50% of stop distance (${(stopDist*100).toFixed(2)}%) — immediate exit`);
              await executeMarketOrder(ticker, 'sell', dollarAmount, entryPrice, 'slippage-exceeded-half-stop');
              recordClosedTrade({
                ticker, side, dollarAmount,
                entryPrice, exitPrice: entryPrice,
                pnl: 0, pnlPct: 0, rMultiple: 0,
                maxFavorableExcursion: 0, maxAdverseExcursion: -(slippagePct),
                signals, setupScore, rationale, catalystType: catalystType || null, regime: regime || null,
                exitReason: `slippage-exceeded-half-stop (${slippagePct.toFixed(2)}% > ${(stopDist*50).toFixed(2)}% limit)`,
                entryTime: posRecord.entryTime, exitTime: new Date().toISOString(),
                date: today, isLive: true,
                state: TRADE_STATES.CLOSED, stateHistory: posRecord.stateHistory,
              });
              return { blocked: true, reason: `Slippage gate: ${slippagePct.toFixed(2)}% fill slippage exceeded half the stop distance — position immediately closed` };
            }
            if (slippagePct > 2) console.warn(`  ⚠️  Entry slippage ${slippagePct.toFixed(2)}%: decision $${decisionPrice} → fill $${entryPrice}`);
            break;
          }
        }
        if (posRecord.state !== TRADE_STATES.PROTECTED) {
          console.warn(`  ⚠️  [${ticker}] Fill not confirmed after 3 attempts — position in ORDER_PENDING; daemon will monitor once confirmed`);
          posRecord.entryPrice = decisionPrice;
        }
      }

      posRecord.entryPrice  = entryPrice;
      posRecord.slippagePct = +slippagePct.toFixed(3);
      addOpenPosition(posRecord);

      // Write trade rationale file with state history
      const slug = `${today}-${ticker}-${side}`;
      const stateTable = (posRecord.stateHistory || []).map(s =>
        `| ${s.state} | ${s.at} | ${Object.entries(s).filter(([k]) => !['state','at'].includes(k)).map(([k,v]) => `${k}=${v}`).join(', ')} |`
      ).join('\n');
      const md = [
        `# Trade Record — ${side.toUpperCase()} $${dollarAmount} ${ticker}`,
        `**Date/Time:** ${posRecord.entryTime}`,
        `**Setup Score:** ${setupScore.toFixed(3)} | **Mode:** ${DRY_RUN ? 'DRY RUN' : 'LIVE'}${slippagePct > 0 ? ` | **Entry Slippage:** ${slippagePct.toFixed(2)}%` : ''}`,
        `**Final State:** ${posRecord.state}`,
        '',
        '## Decision Rationale', rationale,
        '',
        '## Position',
        `| | |`, `|---|---|`,
        `| Decision Price | $${decisionPrice} |`,
        `| Fill Price | $${entryPrice} |`,
        `| Entry Slippage | ${slippagePct.toFixed(3)}% |`,
        `| Dollar Amount | $${dollarAmount} |`,
        `| Fractional Qty | ${fractionalQty} shares |`,
        `| Stop Price | $${posRecord.stopPrice} |`,
        `| Target Price | $${posRecord.targetPrice} |`,
        `| ATR-14 | $${atr14 ?? 'n/a'} |`,
        '',
        '## State History',
        '| State | Time | Notes |',
        '|-------|------|-------|',
        stateTable,
        '| EXIT_PENDING | — | — |',
        '| CLOSED | — | — |',
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

      CIRCUIT.tradesExecuted.push({ ticker, side, dollarAmount, entryPrice, setupScore });
      console.log(`  ✅ [${posRecord.state}] Recorded → output/trades/${slug}.md`);
      return { success: true, ticker, side, dollarAmount, entryPrice, decisionPrice, slippagePct: +slippagePct.toFixed(3), fractionalQty, stopPrice: posRecord.stopPrice, targetPrice: posRecord.targetPrice, state: posRecord.state, dryRun: DRY_RUN };
    }
    case 'log_rejected_candidate': {
      const { ticker, setupScore, gapPct, rvol, signals, reason } = input;
      const rejPath = join(OUTPUT_DIR, 'rejected-candidates.json');
      const data = existsSync(rejPath) ? JSON.parse(readFileSync(rejPath, 'utf-8')) : { candidates: [] };
      data.candidates.push({ date: today, ticker, setupScore, gapPct, rvol, signals, reason, subsequentPrice: null });
      atomicWrite(rejPath, data);
      console.log(`  📝 Shadow-logged rejected candidate: ${ticker} (score=${setupScore?.toFixed(2)}, ${reason})`);
      return { logged: true, ticker };
    }
    case 'log_daily_candidates': {
      const { candidates } = input;
      const outPath = join(OUTPUT_DIR, `candidates-${today}.json`);
      atomicWrite(outPath, { date: today, generatedAt: new Date().toISOString(), candidates });
      console.log(`  📊 Logged ${candidates.length} daily candidates to candidates-${today}.json`);
      return { logged: true, count: candidates.length };
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

// ─── Flatten All Positions (item 38 — circuit breaker triggered) ──────────────
async function flattenAllPositions(reason) {
  const openData = loadOpenPositions();
  if (!openData.positions.length) { console.log(`  [flatten] No positions to flatten.`); return; }
  console.log(`  [flatten] Flattening ${openData.positions.length} position(s): ${reason}`);
  for (const pos of [...openData.positions]) {
    const quote = await getQuote(pos.ticker);
    const currentPrice = quote?.price || pos.entryPrice;
    const pnl    = (currentPrice - pos.entryPrice) * pos.fractionalQty;
    const pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const result = await executeMarketOrder(pos.ticker, 'sell', pos.dollarAmount, currentPrice, reason);
    if (!result.error) {
      const closedHistory = [...(pos.stateHistory || []),
        { state: TRADE_STATES.EXIT_PENDING, at: new Date().toISOString(), reason },
        { state: TRADE_STATES.CLOSED,       at: new Date().toISOString(), exitPrice: currentPrice, pnl: +pnl.toFixed(2) },
      ];
      const stopDistPct = pos.stopPrice ? Math.abs((pos.entryPrice - pos.stopPrice) / pos.entryPrice) : null;
      recordClosedTrade({
        ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
        entryPrice: pos.entryPrice, exitPrice: currentPrice,
        pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
        rMultiple: stopDistPct ? +(pnlPct / 100 / stopDistPct).toFixed(3) : null,
        maxFavorableExcursion: pos.maxFavorableExcursion ?? 0,
        maxAdverseExcursion:   pos.maxAdverseExcursion   ?? 0,
        signals: pos.signals, setupScore: pos.setupScore, rationale: pos.rationale, catalystType: pos.catalystType || null, regime: pos.regime || null,
        exitReason: reason, entryTime: pos.entryTime, exitTime: new Date().toISOString(),
        date: today, isLive: !DRY_RUN,
        state: TRADE_STATES.CLOSED, stateHistory: closedHistory,
      });
      removeOpenPosition(pos.ticker);
      console.log(`  [${pos.ticker}] Flattened @ $${currentPrice} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
    } else {
      console.error(`  [${pos.ticker}] Flatten FAILED: ${result.error} — CHECK ROBINHOOD MANUALLY`);
    }
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

  console.log(`  ${PILOT_MODE ? '🧪 PILOT MODE' : '🚀 STEADY-STATE'} — max ${MAX_POSITIONS} position(s), ${(POSITION_PCT*100).toFixed(0)}% sizing`);

  // Check account balance + save SOD balance
  let balance = 0;
  let acct = null;
  try {
    acct = await rhGetAccountNumber();
    if (acct) {
      const portResult = await rhMCP('get_portfolio', { account_number: acct });
      const port = portResult?.data || portResult || {};
      if (DRY_RUN) console.log('  🔍 [DRY_RUN] portfolio fields:', Object.keys(port).join(', ') || '(empty)');
      balance = parseFloat(
        port?.total_value || port?.cash || port?.equity_value ||
        port?.equity || port?.market_value || 0
      );
      const prefBP = parseFloat(port?.buying_power?.buying_power || port?.buying_power || 0);
      if (balance > 0) {
        console.log(`  ✅ Account equity: $${balance.toFixed(2)}`);
        if (prefBP > 0) {
          const unsettledPct = ((balance - prefBP) / balance) * 100;
          const sizeBase = prefBP > 0 ? prefBP : balance;
          console.log(`  ✅ Buying power (settled cash): $${prefBP.toFixed(2)}${unsettledPct > 10 ? ` ⚠️  ${unsettledPct.toFixed(1)}% unsettled — GFV risk` : ''}`);
          console.log(`  ✅ Position size: $${computePositionDollars(sizeBase)} (${(POSITION_PCT*100).toFixed(0)}% of buying power)`);
        } else {
          console.log(`  ✅ Position size: $${computePositionDollars(balance)} (${(POSITION_PCT*100).toFixed(0)}% of equity — buying_power not reported)`);
        }
        CIRCUIT.weekStartBalance = CIRCUIT.weekStartBalance || balance;
        // Item 17: save SOD balance once per day
        if (!loadSODBalance()) {
          saveSODBalance(balance);
          console.log(`  ✅ SOD balance saved: $${balance.toFixed(2)}`);
        }
      } else if (DRY_RUN) {
        const savedSOD = loadSODBalance();
        balance = savedSOD || 1150;
        console.log(`  ℹ️  DRY_RUN: portfolio returned $0 — using ${savedSOD ? 'saved SOD' : 'fallback'} balance $${balance} for paper sizing`);
      } else {
        console.log('  ⚠️  Balance is $0 or unreadable — proceeding in research-only mode');
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not reach Robinhood MCP: ${e.message}`);
  }

  // Item 22: reconcile positions at scan start
  if (acct) {
    const reconcile = await reconcilePositions(acct);
    if (!reconcile.ok && reconcile.mismatch) {
      await sendAlertEmail('Position Mismatch Detected', `Scan aborted: ${reconcile.mismatch}`);
      console.error('  🚨 Position mismatch — aborting scan to prevent stale-state trades');
      process.exit(1);
    }
  }

  // Check early-close date
  if (EARLY_CLOSE_DATES.has(today)) {
    console.log(`  ⚠️  Early-close day (${today}) — market closes at 1pm ET / 10am PT`);
  }

  console.log('  ✅ Pre-flight complete\n');
  return balance;
}

// ─── Scan Prompt ──────────────────────────────────────────────────────────────
function loadScreenerCandidates() {
  const path = join(OUTPUT_DIR, `screener-${today}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

function buildScanPrompt(balance, openPositions, weights) {
  const nasdaqRef     = loadKBFile('nasdaq-historical.md', 2000);
  const positionSize  = balance ? `$${computePositionDollars(balance)}` : '17.5% of balance';
  const screener      = loadScreenerCandidates();

  const liveTradeCount = computeLiveTradeCount();
  const modelStatusNote = liveTradeCount < 200
    ? `Using equal-weight scoring (need ${200 - liveTradeCount} more live trades for model-driven sizing). Size is FIXED at ${positionSize} regardless of score.`
    : `Model-driven sizing active (${liveTradeCount} live trades).`;

  const screenerBlock = screener?.candidates?.length
    ? `═══════════════════════════════════════════════════════════════
PRE-SCREENED CANDIDATES — ${today} (ranked by gap × RVOL)
═══════════════════════════════════════════════════════════════
Screened ${screener.universeSize} liquid stocks at 5:55am. These ${screener.candidates.length} had pre-market activity:

${screener.candidates.map((c, i) =>
  `${i + 1}. ${c.ticker.padEnd(6)} gap=${c.gapPct > 0 ? '+' : ''}${c.gapPct}%  RVOL=${c.rvol ?? 'n/a'}x  pre-mkt=$${c.preMarketPrice}  prev close=$${c.prevClose}`
).join('\n')}

Research these IN ORDER (#1 first). Do NOT invent additional tickers.`
    : `═══════════════════════════════════════════════════════════════
PRE-SCREENED CANDIDATES — ${today}
═══════════════════════════════════════════════════════════════
⚠️  Screener file not found — falling back to yesterday's watchlist as candidates.
Research yesterday's watchlist tickers and use get_premarket_data to check for any gaps.`;

  return `You are a personal day-trading agent for Alvint. Today is ${today}. DAY TRADE session — all positions CLOSED by 12:45pm PT (exit-daemon + force-close failsafe).
LONG ONLY — no short positions under any circumstances.
${DRY_RUN ? '\n⚠️  DRY RUN MODE — orders logged but NOT submitted to Robinhood. Research and score as if live.\n' : ''}

MULTI-POSITION MODE — up to ${MAX_POSITIONS} concurrent positions, ${positionSize} each.
Research ALL screener candidates. Trade every one that qualifies (score ≥ 0.45) — do NOT stop after the first.
Rank by setup_score descending. Apply sector diversity rule (max 2 per sector). place_trade returns
blocked=true with reason when limits are reached — that is the gate, not you stopping early.

${buildLearningsContext()}

${screenerBlock}

═══════════════════════════════════════════════════════════════
DAY TRADING RULES
═══════════════════════════════════════════════════════════════

ENTRY WINDOW: 6:00am–10:00am PT only. No new buys after 10am PT.
POSITION SIZE: ${positionSize} per trade (fixed — ${modelStatusNote})
MAX CONCURRENT: ${MAX_POSITIONS} position(s) (currently open: ${openPositions.length})
FORCE-CLOSE: 12:45pm PT — exit-daemon closes on stop/target; force-close fires as failsafe
STOP LOSS: ATR-14 based pre-market; exit-daemon updates to opening-range stop after 6:35am
TARGET: 1.5× stop distance from CONFIRMED FILL PRICE (not pre-market quote)

ORDER QUEUING NOTE: Orders placed before 6:30am are pre-market queues — they execute at
market open. Slippage of 0.5-1% is normal; >2% is logged as a warning.

HARD EXCLUDES (never trade):
  ✗ Earnings today before close
  ✗ setup_score < 0.45
  ✗ premarket_gap_up = false (gap must be confirmed >2% before entry — no exceptions)
  ⚠️ rvol_spike = false → strong caution, lower score — but NOT a hard block (Yahoo preMarketVolume
     is unreliable at 6am PT; null data ≠ confirmed low RVOL. Only hard-block if RVOL is
     explicitly confirmed <1x via FMP data. Note data-unavailable cases in rationale.)
  ✗ Already at ${MAX_POSITIONS} open position(s)
  ✗ 3 consecutive losses (manual review required)

SIGNAL SCORING (setup_score — equal-weight until 60+ completed trades):
  premarket_gap_up    +++ gap >2% pre-market on elevated volume — PRIMARY signal
  rvol_spike          +++ relative volume >2x 30-day pre-market avg
  gap_likely_holds    ++  gap >5%: true = gap holds momentum intraday (not filled)
  news_catalyst       ++  clear overnight/pre-market catalyst (not rumors)
  sector_leading      +   sector ETF moving strongly pre-market
  macro_tailwind      +   VIX low/falling, broad market green pre-market
  notable_mention     +   executive order, CEO shoutout, Congressional trade
  insider_buying      +   recent Form 4 C-suite buy (context signal only)
  contrarian_social   +   high overnight bearish chatter on fundamentally strong setup
  analyst_conviction  +   2+ recent upgrades or material PT raise

TRADE IF: setup_score ≥ 0.45 (TEMPORARY threshold to bootstrap trade history — will rise to 0.55+ once model trains on 60+ real trades)
SIZE: fixed at ${positionSize} — no score-based size variation until 200+ live trades
SHADOW LOG: setup_score 0.35–0.45 → call log_rejected_candidate (shadow P&L tracking)
WATCH ONLY: setup_score 0.35–0.45 → save_tomorrow_watchlist
AVOID: setup_score < 0.35

═══════════════════════════════════════════════════════════════
RESEARCH PHASES
═══════════════════════════════════════════════════════════════

Phase 1 — Market context (call ONCE each):
  get_fear_greed_vix → sets today's risk appetite
  get_sector_rotation → which sectors are gapping pre-market

Phase 2 — Earnings exclusions:
  get_earnings_calendar → build hard exclude list (earnings today = never trade, skip immediately)

Phase 3 — Research each screener candidate (work through the ranked list above):
  get_premarket_data [ticker] → ATR-14, RSI, stop/target levels (gap% already known from screener)
  get_news [ticker] → what is the overnight catalyst?
  get_reddit_sentiment [ticker] → overnight chatter signal
  get_notable_mentions [ticker] → executive order, CEO mention, Congressional trade
  get_insider_activity [ticker] → SEC Form 4 context

Phase 4 — Sam validation (only after independent scoring):
  search_sam_weiss_briefings [ticker] → Sam's historical stance on this specific ticker
  get_sam_market_outlook → macro framework if needed

  SAM'S ROLE IS CONTEXT ONLY — HARD RULES:
  ✗ Sam's macro stance (hedging, reducing exposure, bearish outlook) CANNOT block a trade
  ✗ Sam's portfolio positioning CANNOT be used as a session-level veto
  ✗ Sam's view CANNOT change setup_score
  ✓ Sam's view on a specific ticker can increase or decrease your narrative confidence
  ✓ If Sam explicitly says "avoid this ticker" that is worth noting in rationale — nothing more
  Sam runs long-dated options positions (months to years). His hedges say nothing about
  whether a stock is gapping 3% this morning with a real catalyst. Keep them separate.

Phase 5 — Execute (work through ALL candidates):
  For each qualifying candidate (score ≥ 0.45, premarket_gap_up=true, earnings cleared):
    call place_trade — one call per ticker, highest score first.
    place_trade will return blocked=true if MAX_POSITIONS or sector limit is reached — that ends trading.
    Do NOT self-censor after the first trade. Let the gate in place_trade stop you.
  Required fields in every place_trade call:
    catalystType — earnings_beat | earnings_miss | guidance_raise | analyst_upgrade | fda_news |
      ma | insider_purchase | macro | sector_sympathy | notable_mention | product_launch | regulatory | technical
    sector — GICS sector string (e.g. "Technology", "Consumer Discretionary")
    regime — { vixLevel, vixBucket, fearGreedScore, fearGreedBucket, spyVs50dma, qqqVs50dma, spyChangePct }
      spyChangePct: SPY % change from get_fear_greed_vix indices (used to flag market-driven days)
    rvol_spike: include if confirmed >2x — null/unavailable is NOT a blocker, note in rationale
  save_tomorrow_watchlist → tickers scoring 0.35–0.45 that did not trade
  log_daily_candidates → call ONCE at end of session with ALL evaluated candidates (traded + shadow-logged + skipped).
    rank = your ordering by composite score (1 = highest). screenerRank = screener ordering by gap% (1 = largest gap).
    action: "traded" | "shadow_logged" | "skipped" | "hard_excluded"

═══════════════════════════════════════════════════════════════
NASDAQ CORRECTION/RALLY REFERENCE
═══════════════════════════════════════════════════════════════

${nasdaqRef}`;
}

// ─── EOD Prompt ───────────────────────────────────────────────────────────────
function buildEODPrompt(closedTrades, openPositions, benchmarks = {}) {
  const fmtBench = (q) => q ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent?.toFixed(2)}%` : 'n/a';
  const benchLine = `SPY ${fmtBench(benchmarks.spy)} | QQQ ${fmtBench(benchmarks.qqq)} | IWM ${fmtBench(benchmarks.iwm)}`;

  return `You are generating the EOD report for Alvint's day-trading account. Today is ${today}.

## Market Benchmarks (today's close)
${benchLine}

## Closed Trades Today
Note: positions are DOLLAR-DENOMINATED ($${POSITION_DOLLARS} fixed size = fractional shares, NOT whole shares). Use the P&L figures provided — do not recalculate from prices.
${closedTrades.length ? closedTrades.map(t => {
  const qty = (t.dollarAmount / t.entryPrice).toFixed(4);
  const pnl = t.pnl !== null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl?.toFixed(2)} (${t.pnlPct?.toFixed(1)}%)` : 'pending';
  return `${t.ticker}: ${t.side?.toUpperCase()} ${qty} fractional shares ($${t.dollarAmount} notional) | fill $${t.entryPrice} → exit $${t.exitPrice ?? '?'} | P&L: ${pnl} | R: ${t.rMultiple ?? '?'} | Exit: ${t.exitReason || 'unknown'}`;
}).join('\n') : '(no trades today)'}

## Still Open (should have been force-closed at 12:45pm PT)
${openPositions.length ? openPositions.map(p => `${p.ticker}: entry $${p.entryPrice}, stop $${p.stopPrice}, target $${p.targetPrice}`).join('\n') : '(none)'}

## Tools Available
- get_fear_greed_vix → get today's fear/greed and VIX data
- get_market_data [ticker] → get closing price for any open position
- save_tomorrow_watchlist → save tomorrow's gap candidates

## EOD Report Format (two sections only):

### Section 1: P&L
Per-trade breakdown. Total realized P&L vs SPY/QQQ/IWM same-day moves (benchmarks given above).
Win/loss count. Best and worst trade.

### Section 2: Learnings
What worked, what didn't. Which signals were present on winning vs losing trades.
What to adjust for tomorrow. Specific tickers/setups to watch in tomorrow's pre-market scan.

Keep it concise — max 500 words total. Details live in log files.`;
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendEODEmail(reportText, closedTrades, benchmarks = {}) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('  ⚠️  Email skipped — GMAIL_USER/GMAIL_APP_PASSWORD not set'); return; }

  const totalPnl   = closedTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const pnlStr     = totalPnl >= 0 ? `+$${totalPnl.toFixed(2)}` : `-$${Math.abs(totalPnl).toFixed(2)}`;
  const wins       = closedTrades.filter(t => t.pnl > 0).length;

  const fmtB = q => q?.changePercent != null ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : 'n/a';
  const benchStr = `SPY ${fmtB(benchmarks.spy)} | QQQ ${fmtB(benchmarks.qqq)} | IWM ${fmtB(benchmarks.iwm)}`;
  const subject  = `📈 EOD ${today} | ${pnlStr} | ${wins}W/${closedTrades.length - wins}L | ${benchStr}`;

  // Fetch EOD close + day high for each trade in parallel
  const dayStats = await Promise.all(
    closedTrades.map(t => fetchDayStats(t.ticker, t.date || today))
  );

  const tradeRows = closedTrades.map((t, i) => {
    const slip     = t.slippagePct != null ? `${t.slippagePct >= 0 ? '+' : ''}${t.slippagePct.toFixed(2)}%` : '—';
    const dec      = t.decisionPrice ? `$${t.decisionPrice.toFixed(2)}` : '—';
    const pnlColor = t.pnl >= 0 ? '#1a7f37' : '#cf222e';
    const pnlCell  = `<span style="color:${pnlColor};font-weight:bold;">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%)</span>`;
    const r        = t.rMultiple != null ? `${t.rMultiple.toFixed(2)}R` : '—';
    const stats    = dayStats[i];
    const qty      = t.dollarAmount && t.entryPrice ? t.dollarAmount / t.entryPrice : null;
    // Left on table uses day high — the true maximum achievable
    const leftAmt  = stats?.high && qty ? (stats.high - t.exitPrice) * qty : null;
    const eodCell  = stats?.close ? `$${stats.close.toFixed(2)}` : '—';
    const highCell = stats?.high  ? `$${stats.high.toFixed(2)}`  : '—';
    const leftColor = leftAmt == null ? '#555' : leftAmt > 0 ? '#cf222e' : '#1a7f37';
    const leftCell  = leftAmt != null
      ? `<span style="color:${leftColor};">${leftAmt >= 0 ? '+' : ''}$${leftAmt.toFixed(2)}</span>`
      : '—';
    return `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:6px 10px;font-weight:bold;">${t.ticker}</td>
      <td style="padding:6px 10px;">${dec}</td>
      <td style="padding:6px 10px;">$${t.entryPrice.toFixed(2)}</td>
      <td style="padding:6px 10px;color:${t.slippagePct > 1 ? '#cf222e' : '#555'};">${slip}</td>
      <td style="padding:6px 10px;">$${t.exitPrice.toFixed(2)}</td>
      <td style="padding:6px 10px;color:#555;">${highCell}</td>
      <td style="padding:6px 10px;">${eodCell}</td>
      <td style="padding:6px 10px;">${leftCell}</td>
      <td style="padding:6px 10px;">${pnlCell}</td>
      <td style="padding:6px 10px;color:#555;">${r}</td>
    </tr>`;
  }).join('');

  const html = `<html><body style="font-family:monospace;max-width:800px;margin:auto;padding:24px;">
<h2>📈 Day Trade EOD — ${today}</h2>
<p><strong>${pnlStr}</strong> | ${wins}W / ${closedTrades.length - wins}L | ${DRY_RUN ? '🔷 DRY RUN' : '🚨 LIVE'}</p>
<p style="color:#555;font-size:13px;">Market: ${benchStr}</p>
${closedTrades.length ? `
<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
  <thead><tr style="background:#f6f8fa;text-align:left;">
    <th style="padding:6px 10px;">Ticker</th>
    <th style="padding:6px 10px;">Decision $</th>
    <th style="padding:6px 10px;">Fill $</th>
    <th style="padding:6px 10px;">Slippage</th>
    <th style="padding:6px 10px;">Exit $</th>
    <th style="padding:6px 10px;">Day High</th>
    <th style="padding:6px 10px;">EOD $</th>
    <th style="padding:6px 10px;">Left on table</th>
    <th style="padding:6px 10px;">P&amp;L</th>
    <th style="padding:6px 10px;">R-Multiple</th>
  </thead>
  <tbody>${tradeRows}</tbody>
</table>` : ''}
<pre style="white-space:pre-wrap;line-height:1.5;">${reportText.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
</body></html>`;

  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: user, to: 'alvintsheth@gmail.com', subject, html, text: reportText });
  console.log(`  📧 EOD email sent → alvintsheth@gmail.com`);
}

// ─── API retry helper (5xx / overloaded) ─────────────────────────────────────
async function callWithRetry(fn, { retries = 3, baseDelay = 5000 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err.status === 500 || err.status === 529;
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelay * Math.pow(3, attempt);
      console.log(`  ⚠️  API ${err.status} — retrying in ${delay / 1000}s (attempt ${attempt + 1}/${retries})...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
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
    response = await callWithRetry(() => client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 8192, tools, messages,
    }));
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

  const finalText  = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const outPath    = join(OUTPUT_DIR, `recommendations-${today}.md`);
  const screener   = loadScreenerCandidates();
  const screenerSummary = screener?.candidates?.length
    ? `Screener: ${screener.candidates.length} gap-up candidates from ${screener.universeSize} stocks` +
      (screener.gapDownCount ? ` (${screener.gapDownCount} gap-downs excluded)` : '') + ' — ' +
      screener.candidates.slice(0, 3).map(c => `${c.ticker} +${c.gapPct}%`).join(', ')
    : `Screener: no gap-up candidates (${screener?.gapDownCount ?? 0} gap-downs excluded — long-only)`;
  const header = CIRCUIT.tradesExecuted.length
    ? `# Scan Report — ${today}\n_${screenerSummary}_\n\n## Trades\n${CIRCUIT.tradesExecuted.map(t => `- ${t.side.toUpperCase()} $${t.dollarAmount} ${t.ticker} @ $${t.entryPrice} | score=${t.setupScore?.toFixed(2)}`).join('\n')}\n\n`
    : `# Scan Report — ${today}\n_${screenerSummary}_\n\n`;
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
        const judgment = await callWithRetry(() => client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Open position: ${pos.ticker} bought at $${pos.entryPrice}. Original thesis: ${pos.rationale?.slice(0, 200)}. Stop: $${pos.stopPrice}. Current price: $${currentPrice}. Recent news: "${newsHeadlines}". VIX change: ${vixChange}%. Should we exit NOW or hold to stop? Answer: "exit" or "hold" — one sentence reason.`,
          }],
        }));
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
        const _sdPct = pos.stopPrice ? Math.abs((pos.entryPrice - pos.stopPrice) / pos.entryPrice) : null;
        recordClosedTrade({
          ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
          entryPrice: pos.entryPrice, exitPrice: currentPrice,
          pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
          rMultiple: _sdPct ? +(pnlPct / 100 / _sdPct).toFixed(3) : null,
          maxFavorableExcursion: pos.maxFavorableExcursion ?? 0,
          maxAdverseExcursion:   pos.maxAdverseExcursion   ?? 0,
          signals: pos.signals, setupScore: pos.setupScore, rationale: pos.rationale, catalystType: pos.catalystType || null, regime: pos.regime || null,
          exitReason, entryTime: pos.entryTime, exitTime: new Date().toISOString(), date: today,
          state: TRADE_STATES.CLOSED, isLive: !DRY_RUN,
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
  if (EARLY_CLOSE_DATES.has(today)) {
    // Item 24: early-close day — exit-daemon force-closed at 9:45am PT
    // This job fires at 12:45pm; by now all positions should be flat
    const earlyCheck = loadOpenPositions();
    if (!earlyCheck.positions.length) {
      console.log('[force-close] Early-close day — all positions already closed by exit-daemon at 9:45am PT. ✅');
      return;
    }
    console.log(`[force-close] Early-close day — ${earlyCheck.positions.length} position(s) still open (daemon may have missed them). Closing now.`);
    // Fall through to close them
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
      const _fcSdPct = pos.stopPrice ? Math.abs((pos.entryPrice - pos.stopPrice) / pos.entryPrice) : null;
      recordClosedTrade({
        ticker: pos.ticker, side: pos.side, dollarAmount: pos.dollarAmount,
        entryPrice: pos.entryPrice, exitPrice: currentPrice,
        pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)),
        rMultiple: _fcSdPct ? +(pnlPct / 100 / _fcSdPct).toFixed(3) : null,
        maxFavorableExcursion: pos.maxFavorableExcursion ?? 0,
        maxAdverseExcursion:   pos.maxAdverseExcursion   ?? 0,
        signals: pos.signals, setupScore: pos.setupScore, rationale: pos.rationale, catalystType: pos.catalystType || null, regime: pos.regime || null,
        state: TRADE_STATES.CLOSED, isLive: !DRY_RUN,
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

  // Fetch benchmark returns (pure code — no Claude tokens)
  console.log('  [EOD] Fetching benchmarks (SPY, QQQ, IWM)...');
  const [spyQ, qqqQ, iwmQ] = await yahooQuotesBatch(['SPY', 'QQQ', 'IWM']);
  const benchmarks = { spy: spyQ, qqq: qqqQ, iwm: iwmQ };
  const fmtB = q => q?.changePercent != null ? `${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}%` : 'n/a';
  console.log(`  [EOD] Benchmarks — SPY ${fmtB(spyQ)} | QQQ ${fmtB(qqqQ)} | IWM ${fmtB(iwmQ)}`);

  // Claude Haiku generates EOD report
  const eodTools  = tools.filter(t => ['get_fear_greed_vix', 'get_market_data', 'save_tomorrow_watchlist'].includes(t.name));
  const messages  = [{ role: 'user', content: buildEODPrompt(closedToday, openData.positions, benchmarks) }];
  let response;
  let iterations  = 0;
  let inputTokens = 0, outputTokens = 0;

  while (iterations < 10) {
    iterations++;
    response = await callWithRetry(() => client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 4000, tools: eodTools, messages,
    }));
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

  // Item 32: compute and log expectancy/profit-factor metrics
  if (closedToday.length > 0) {
    const wins = closedToday.filter(t => t.pnl > 0);
    const losses = closedToday.filter(t => t.pnl <= 0);
    const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const avgWin   = wins.length   ? totalWins / wins.length   : 0;
    const avgLoss  = losses.length ? totalLoss / losses.length : 0;
    const winRate  = wins.length / closedToday.length;
    const expectancy    = winRate * avgWin - (1 - winRate) * avgLoss;
    const profitFactor  = totalLoss > 0 ? totalWins / totalLoss : null;
    const metricsPath   = join(OUTPUT_DIR, 'expectancy-log.json');
    const metricsData   = existsSync(metricsPath) ? JSON.parse(readFileSync(metricsPath, 'utf-8')) : { entries: [] };
    metricsData.entries.push({
      date: today, tradeCount: closedToday.length,
      winRate: +winRate.toFixed(3), avgWin: +avgWin.toFixed(2), avgLoss: +avgLoss.toFixed(2),
      expectancy: +expectancy.toFixed(2), profitFactor: profitFactor ? +profitFactor.toFixed(2) : null,
      totalPnl: +(closedToday.reduce((s, t) => s + t.pnl, 0)).toFixed(2),
    });
    atomicWrite(metricsPath, metricsData);
    console.log(`  📊 Expectancy: $${expectancy.toFixed(2)} | Win rate: ${(winRate*100).toFixed(0)}% | Profit factor: ${profitFactor?.toFixed(2) ?? 'n/a'}`);
  }

  // Item 29: update rejected candidates with EOD prices for shadow P&L tracking
  const rejPath = join(OUTPUT_DIR, 'rejected-candidates.json');
  if (existsSync(rejPath)) {
    try {
      const rejected = JSON.parse(readFileSync(rejPath, 'utf-8'));
      const todayRejected = rejected.candidates.filter(c => c.date === today && c.subsequentPrice === null);
      for (const cand of todayRejected) {
        const q = await yahooQuote(cand.ticker);
        if (q?.price) cand.subsequentPrice = q.price;
        await sleep(200);
      }
      if (todayRejected.length) {
        atomicWrite(rejPath, rejected);
        console.log(`  📝 Updated ${todayRejected.length} rejected candidate(s) with EOD prices`);
      }
    } catch (e) { console.warn(`  ⚠️  Could not update rejected candidates: ${e.message}`); }
  }

  await sendEODEmail(reportText, closedToday, benchmarks);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Item 38: manual circuit breaker reset — does NOT require a market day check
  if (MODE === 'reset-circuit') {
    const state = loadCircuitBreakerState();
    if (!state.tripped) {
      console.log('[reset-circuit] Circuit breaker is NOT currently tripped — nothing to reset.');
      return;
    }
    saveCircuitBreakerState({ tripped: false, resetAt: new Date().toISOString(), previousTrip: state });
    console.log(`[reset-circuit] ✅ Circuit breaker reset. Previous trip: ${state.reason} (at ${state.trippedAt})`);
    console.log('[reset-circuit] Trading will resume on next scan run.');
    return;
  }

  // scan uses Yahoo-backed check (can fail open on calendar trading days)
  // force-close, check, eod use calendar-only check — never blocked by API issues
  const isScan = MODE === 'scan';
  const trading = isScan ? await isMarketDay() : calendarTradingDay();
  if (!trading) {
    console.log(`[${MODE}] Not a trading day (${today}) — skipping.`);
    process.exit(0);
  }

  if (MODE === 'scan')        return runScan();
  if (MODE === 'check')       return runCheck();
  if (MODE === 'force-close') return runForceClose();
  if (MODE === 'eod')         return runEOD();
  console.error(`Unknown mode: ${MODE}. Use: scan | check | force-close | eod | reset-circuit`);
  process.exit(1);
}

main().catch(console.error);
