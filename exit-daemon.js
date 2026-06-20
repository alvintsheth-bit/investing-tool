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
  OR_CHECK:           6 * 60 + 45,  // 6:45am — all 3 first 5-min bars complete at 6:45am
  ENTRY_CUTOFF:      10 * 60,        // 10:00am
  EARLY_FORCE_CLOSE:  9 * 60 + 45,  // 9:45am (early-close days)
  FORCE_CLOSE:       12 * 60 + 45,  // 12:45pm
  MARKET_CLOSE:      13 * 60,        // 1:00pm
};

// ─── Trade State Machine (mirrors agent.js — no shared lib to keep daemon standalone) ──
const TRADE_STATES = {
  PROTECTED:    'PROTECTED',
  EXIT_PENDING: 'EXIT_PENDING',
  CLOSED:       'CLOSED',
};

function addStateHistory(pos, newState, meta = {}) {
  pos.state = newState;
  if (!pos.stateHistory) pos.stateHistory = [];
  pos.stateHistory.push({ state: newState, at: new Date().toISOString(), ...meta });
}

const forceCloseTime = EARLY_CLOSE_DATES.has(today) ? PT.EARLY_FORCE_CLOSE : PT.FORCE_CLOSE;
const marketCloseTime = EARLY_CLOSE_DATES.has(today) ? 10 * 60 : PT.MARKET_CLOSE;

// ─── Shared File State ────────────────────────────────────────────────────────
const OPEN_POSITIONS_FILE = join(OUTPUT_DIR, 'trades-open.json');
const TRADES_LOG_FILE     = join(OUTPUT_DIR, 'trades-log.json');

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
    const highs = result.indicators.quote[0].high || [];
    const lows  = result.indicators.quote[0].low  || [];
    // Market open: 9:30am ET = 6:30am PT. Approximate UTC:
    const mktOpenUtcMs = new Date(`${today}T13:30:00Z`).getTime();
    const firstBars = timestamps
      .map((t, i) => ({ ms: t * 1000, h: highs[i], l: lows[i] }))
      .filter(b => b.ms >= mktOpenUtcMs && b.h != null && b.l != null)
      .slice(0, 3); // first 15 min
    if (!firstBars.length) return null;
    return {
      orHigh: Math.max(...firstBars.map(b => b.h)),
      orLow:  Math.min(...firstBars.map(b => b.l)),
      barsUsed: firstBars.length,
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
  const res = await fetch(RH_MCP_URL, {
    method: 'POST', headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
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
    entryPrice: pos.entryPrice, exitPrice: currentPrice,
    pnl: +pnl.toFixed(2), pnlPct: +pnlPct.toFixed(2),
    rMultiple: stopDistPct ? +(pnlPct / 100 / stopDistPct).toFixed(3) : null,
    signals: pos.signals, setupScore: pos.setupScore, rationale: pos.rationale,
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

    const openData = loadOpenPositions();
    if (!openData.positions.length) {
      if (ptNow >= PT.MARKET_CLOSE - 5) break; // no positions + near close → done
      await sleep(60_000);
      continue;
    }

    // ── Item 37: Opening range update — runs once at 6:45am PT ──────────────
    // All 3 first five-minute bars are complete at 6:45am (6:30, 6:35, 6:40 bars close by 6:45)
    if (!openingRangeComputed && ptNow >= PT.OR_CHECK) {
      console.log('[exit-daemon] 6:45am: computing opening ranges (3 completed 5-min bars)...');
      const positionsToSave = [...openData.positions];
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
