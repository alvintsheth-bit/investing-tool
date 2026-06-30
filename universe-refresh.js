// Quarterly universe refresh
// Sources: Wikipedia S&P 500 list + high-beta seed tickers
// Criteria: avg daily dollar vol > $30M, price > $5, top 30 per sector
// Output: output/universe.json
// Run: node universe-refresh.js
// Scheduled: Jul 1, Oct 1, Jan 2, Apr 1 at 5am PT via launchd

import { config } from 'dotenv';
import { writeFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();
const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const LOG_FILE   = join(OUTPUT_DIR, 'logs', 'universe-refresh.log');
const YAHOO_UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

function log(msg) {
  const line = `[universe-refresh] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// High-beta names not in S&P 500 — always include regardless of index membership
// These are the gap-prone catalyst stocks the S&P 500 screen would miss
const SEED_TICKERS = {
  'SOXL':  'Semiconductors',
  'IONQ':  'Technology',
  'MARA':  'Crypto',
  'RIOT':  'Crypto',
  'MSTR':  'Crypto',
  'COIN':  'Financials',
  'HOOD':  'Financials',
  'RBLX':  'Communication Services',
  'SNAP':  'Communication Services',
  'RDDT':  'Communication Services',
  'PINS':  'Communication Services',
  'HIMS':  'Health Care',
  'CELH':  'Consumer Staples',
  'UPST':  'Financials',
  'AFRM':  'Financials',
  'SOFI':  'Financials',
  'DUOL':  'Technology',
  'APP':   'Technology',
  'LYFT':  'Industrials',
  'RIVN':  'Consumer Discretionary',
  'NIO':   'Consumer Discretionary',
  'XPEV':  'Consumer Discretionary',
  'LI':    'Consumer Discretionary',
  'BABA':  'Consumer Discretionary',
  'PDD':   'Consumer Discretionary',
  'BIDU':  'Communication Services',
  'JD':    'Consumer Discretionary',
  'GME':   'Consumer Discretionary',
  'PLTR':  'Technology',
  'SMCI':  'Technology',
  'ARM':   'Technology',
};

// Parse Wikipedia S&P 500 constituent table → [{ticker, sector}]
async function fetchSP500() {
  const r = await fetch('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies', {
    headers: { 'User-Agent': YAHOO_UA }
  });
  if (!r.ok) throw new Error(`Wikipedia returned ${r.status}`);
  const html = await r.text();

  const tableStart = html.indexOf('id="constituents"');
  if (tableStart === -1) throw new Error('constituents table not found on Wikipedia page');
  const tableEnd = html.indexOf('</table>', tableStart);
  const table = html.slice(tableStart, tableEnd);

  // Split into rows, skip header
  const rows = table.split('<tr>').slice(2);
  const results = [];

  for (const row of rows) {
    // Ticker: first <td> contains <a rel="nofollow" ...>TICKER</a>
    const tickerMatch = row.match(/<td><a[^>]+rel="nofollow"[^>]*>([A-Z0-9.]+)<\/a>/);
    if (!tickerMatch) continue;
    const ticker = tickerMatch[1].replace('.', '-'); // BRK.B → BRK-B for Yahoo

    // Sector: third <td> — plain text, no inner link
    const cells = row.split('</td>');
    if (cells.length < 3) continue;
    const sectorRaw = cells[2].replace(/<[^>]*>/g, '').trim();
    if (!sectorRaw) continue;

    results.push({ ticker, sector: sectorRaw });
  }

  return results;
}

// Fetch 1-year daily stats from Yahoo Finance
async function getYahooStats(symbol) {
  try {
    const encoded = encodeURIComponent(symbol);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1y`;
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) { await sleep(5000); return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;

    const closes  = result.indicators?.quote?.[0]?.close  ?? [];
    const volumes = result.indicators?.quote?.[0]?.volume ?? [];
    const validPairs = closes
      .map((c, i) => ({ c, v: volumes[i] }))
      .filter(p => p.c != null && p.v != null && p.c > 0 && p.v > 0);

    if (validPairs.length < 50) return null;

    const price        = result.meta?.regularMarketPrice ?? validPairs.at(-1).c;
    const avgDollarVol = validPairs.reduce((s, p) => s + p.c * p.v, 0) / validPairs.length;

    return { symbol, price, avgDollarVol };
  } catch { return null; }
}

async function main() {
  const startedAt = new Date().toISOString();
  log(`Starting — ${startedAt}`);

  // 1. Build sector map from Wikipedia + seeds
  let sp500 = [];
  try {
    sp500 = await fetchSP500();
    log(`Wikipedia: ${sp500.length} S&P 500 entries`);
  } catch (e) {
    log(`Wikipedia failed (${e.message}) — using seed list only`);
  }

  const sectorMap = {}; // ticker → sector
  for (const { ticker, sector } of sp500) sectorMap[ticker] = sector;
  for (const [ticker, sector] of Object.entries(SEED_TICKERS)) {
    if (!sectorMap[ticker]) sectorMap[ticker] = sector; // seeds fill gaps only
  }

  const allTickers = Object.keys(sectorMap);
  log(`Total candidates: ${allTickers.length}`);

  // 2. Fetch Yahoo stats for all candidates
  const stats = {};
  let done = 0;
  for (const ticker of allTickers) {
    const s = await getYahooStats(ticker);
    if (s) stats[ticker] = s;
    done++;
    if (done % 100 === 0) log(`  ${done}/${allTickers.length} fetched...`);
    await sleep(150);
  }
  log(`Yahoo stats: ${Object.keys(stats).length}/${allTickers.length} succeeded`);

  // 3. Filter by quality thresholds
  const MIN_DOLLAR_VOL = 30_000_000; // $30M avg daily dollar volume
  const MIN_PRICE      = 5;

  const passing = allTickers.filter(t => {
    const s = stats[t];
    return s && s.price >= MIN_PRICE && s.avgDollarVol >= MIN_DOLLAR_VOL;
  });
  log(`Passing filters: ${passing.length} tickers`);

  // 4. Group by sector, sort by dollar vol DESC, cap at 30 per sector
  const SECTOR_CAP = 30;
  const bySector = {};
  for (const ticker of passing) {
    const sector = sectorMap[ticker] || 'Other';
    if (!bySector[sector]) bySector[sector] = [];
    bySector[sector].push({ ticker, avgDollarVol: stats[ticker].avgDollarVol });
  }

  const finalTickers = [];
  const finalBySector = {};
  for (const [sector, names] of Object.entries(bySector)) {
    names.sort((a, b) => b.avgDollarVol - a.avgDollarVol);
    const selected = names.slice(0, SECTOR_CAP).map(n => n.ticker);
    finalBySector[sector] = selected;
    finalTickers.push(...selected);
    log(`  ${sector.padEnd(30)} ${selected.length} tickers`);
  }

  log(`Final universe: ${finalTickers.length} tickers across ${Object.keys(finalBySector).length} sectors`);

  // 5. Write output/universe.json
  const output = {
    generatedAt:  startedAt,
    refreshDate:  startedAt.split('T')[0],
    universeSize: finalTickers.length,
    bySector:     finalBySector,
    tickers:      finalTickers,
  };

  writeFileSync(join(OUTPUT_DIR, 'universe.json'), JSON.stringify(output, null, 2));
  log(`Saved output/universe.json (${finalTickers.length} tickers)`);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
