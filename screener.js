import { config } from 'dotenv';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const LOG_FILE   = join(OUTPUT_DIR, 'logs', 'screener.log');
const YAHOO_UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const FMP_KEY    = process.env.FMP_API_KEY;
const today      = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

function log(msg) {
  const line = `[screener] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─── Market Calendar ──────────────────────────────────────────────────────────
const US_MARKET_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-06-19',
  '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-02',
  '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

const _ptDow    = new Date(today + 'T12:00:00');
const dayOfWeek = _ptDow.getDay();
if (dayOfWeek === 0 || dayOfWeek === 6 || US_MARKET_HOLIDAYS.has(today)) {
  log(`Market closed today (${today}) — skipping.`);
  process.exit(0);
}

// ─── Fixed Universe ───────────────────────────────────────────────────────────
// Liquid, volatile, catalyst-rich stocks. Long-only — no short candidates.
const CORE_UNIVERSE = [
  // Mega-cap tech & AI
  'NVDA', 'TSLA', 'AAPL', 'META', 'MSFT', 'AMZN', 'GOOGL', 'AMD', 'PLTR', 'COIN',
  'MSTR', 'ARM', 'SMCI', 'AVGO', 'CRM', 'NFLX', 'UBER', 'HOOD', 'SNOW', 'CRWD',
  'DDOG', 'NET', 'SHOP', 'SQ', 'PYPL', 'RBLX', 'IONQ',
  // Semiconductors
  'INTC', 'QCOM', 'MU', 'AMAT', 'LRCX', 'TSM', 'MRVL', 'SOXL', 'KLAC',
  // Financials
  'JPM', 'GS', 'BAC', 'MS', 'C', 'WFC', 'MA',
  // Industrials
  'GE', 'CAT', 'DE', 'URI', 'BA',
  // Energy
  'XOM', 'CVX', 'OXY',
  // Healthcare / Biotech
  'LLY', 'MRNA', 'BNTX',
  // Consumer
  'NKE', 'SBUX', 'HD', 'TGT',
  // Materials
  'FCX', 'NUE', 'CLF', 'AA',
  // China ADRs (high volatility)
  'BABA', 'PDD', 'NIO', 'XPEV', 'LI',
  // Bitcoin miners / crypto adjacent
  'MARA', 'RIOT',
  // High-beta / momentum
  'GME', 'RDDT', 'SNAP', 'CELH', 'HIMS', 'PINS', 'LYFT', 'RIVN',
  'APP', 'AFRM', 'UPST', 'SOFI', 'SPOT', 'DUOL',
];
// Universe criteria: major-exchange listed, ~$10B+ market cap, $50M+ avg daily dollar volume,
// no OTC, no recent IPOs. Any future additions should meet this bar.

// ─── Data Fetching ────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function yahoo5MinBars(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
                `?interval=5m&range=2d&includePrePost=true`;
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) { await sleep(2000); return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const q = result.indicators?.quote?.[0] || {};
    return timestamps.map((ts, i) => ({
      ts,
      close:  q.close?.[i]  ?? null,
      volume: q.volume?.[i] ?? 0,
    })).filter(b => b.close !== null);
  } catch { return null; }
}

async function fmpEarnings() {
  if (!FMP_KEY) return [];
  try {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
    const r = await fetch(
      `https://financialmodelingprep.com/stable/earnings-calendar?from=${yesterday}&to=${today}&apikey=${FMP_KEY}`
    );
    if (!r.ok) return [];
    const data = await r.json();
    if (!Array.isArray(data)) return [];
    // After-market-close (AMC) yesterday only: reported after yesterday's close, pre-market
    // gap reflects reaction. Phase 2 in the scan hard-excludes earnings-day names from trading
    // — these enter the screener for next-day watching, not same-day execution.
    // Before-market-open (BMO) today excluded: Phase 2 blocks them anyway; wastes screener slots.
    return data
      .filter(e => e.time === 'amc' && e.date === yesterday)
      .map(e => e.symbol)
      .filter(Boolean);
  } catch { return []; }
}

function loadYesterdayWatchlist() {
  const path = join(OUTPUT_DIR, 'watchlist-tomorrow.json');
  if (!existsSync(path)) return [];
  try { return JSON.parse(readFileSync(path, 'utf-8')).watchlist?.map(w => w.ticker) || []; }
  catch { return []; }
}

// ─── Pre-Market Detection ─────────────────────────────────────────────────────
// Pre-market: 4:00am–9:30am ET = 8:00–13:30 UTC (during EDT, UTC-4)
function isPreMarketBar(unixTs) {
  const d   = new Date(unixTs * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min >= 8 * 60 && min < 13 * 60 + 30;
}

// Regular session: 9:30am–4:00pm ET = 13:30–20:00 UTC (during EDT)
function isRegularBar(unixTs) {
  const d   = new Date(unixTs * 1000);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return min >= 13 * 60 + 30 && min < 20 * 60;
}

function barDate(unixTs) {
  return new Date(unixTs * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// ─── Screen One Ticker ────────────────────────────────────────────────────────
async function screenTicker(ticker) {
  const bars = await yahoo5MinBars(ticker);
  if (!bars || bars.length < 3) return null;

  // Yesterday's regular session bars → previous close + day volume
  const yesterdayRegular = bars.filter(b => isRegularBar(b.ts) && barDate(b.ts) < today);
  if (!yesterdayRegular.length) return null;
  const prevClose = yesterdayRegular.at(-1).close;

  // Quality filters: skip penny stocks and thin names
  if (!prevClose || prevClose < 5) return null; // price floor
  const yesterdayDollarVol = yesterdayRegular.reduce((s, b) => s + (b.volume || 0) * (b.close || 0), 0);
  if (yesterdayDollarVol < 10_000_000) return null; // <$10M daily dollar volume → too thin

  // Today's pre-market bars → current price + pre-market volume
  const preMarketBars = bars.filter(b => isPreMarketBar(b.ts) && barDate(b.ts) === today);
  if (!preMarketBars.length) return null;

  const preMarketPrice  = preMarketBars.at(-1).close;

  if (!prevClose || !preMarketPrice) return null;

  const gapPct = (preMarketPrice - prevClose) / prevClose * 100;

  // Only surface stocks actually moving (>0.5% either direction)
  if (Math.abs(gapPct) < 0.5) return null;

  // Note: Yahoo returns volume=0 for all pre-market bars — RVOL not computable here.
  // Agent computes RVOL from regular session volume via getPreMarketData after open.

  return {
    ticker,
    gapPct:         +gapPct.toFixed(2),
    rvol:           null, // not available from Yahoo 5-min pre-market bars
    preMarketPrice: +preMarketPrice.toFixed(2),
    prevClose:      +prevClose.toFixed(2),
    preMarketBars:  preMarketBars.length,
    score:          Math.abs(gapPct), // rank by gap magnitude
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  log(`Started — ${today}`);

  // Build universe
  const earningsTickers  = await fmpEarnings();
  const watchlistTickers = loadYesterdayWatchlist();
  const universe = [...new Set([...CORE_UNIVERSE, ...earningsTickers, ...watchlistTickers])];
  log(`Universe: ${universe.length} tickers (${CORE_UNIVERSE.length} core + ${earningsTickers.length} earnings + ${watchlistTickers.length} watchlist)`);

  // Screen all tickers
  const results = [];
  for (const ticker of universe) {
    const result = await screenTicker(ticker);
    if (result) results.push(result);
    await sleep(120); // ~120ms between Yahoo calls to avoid 429
  }

  log(`Screened ${universe.length} tickers → ${results.length} with pre-market activity`);

  // Sort by score (gap magnitude × RVOL), take top 10
  results.sort((a, b) => b.score - a.score);
  const candidates = results.slice(0, 10);

  // Log top candidates
  if (candidates.length) {
    log(`Top candidates:`);
    for (const c of candidates) {
      log(`  ${c.ticker.padEnd(6)} gap=${c.gapPct > 0 ? '+' : ''}${c.gapPct}%  RVOL=${c.rvol ?? 'n/a'}x  pre=$${c.preMarketPrice}  bars=${c.preMarketBars}`);
    }
  } else {
    log(`No candidates with pre-market activity found`);
  }

  // Save output
  const output = {
    date:         today,
    generatedAt:  new Date().toISOString(),
    universeSize: universe.length,
    screened:     results.length,
    candidates,
  };

  writeFileSync(join(OUTPUT_DIR, `screener-${today}.json`), JSON.stringify(output, null, 2));
  log(`Saved screener-${today}.json — ${candidates.length} candidate(s) for agent`);
}

main().catch(err => {
  log(`Fatal error: ${err.message}`);
  process.exit(1);
});
