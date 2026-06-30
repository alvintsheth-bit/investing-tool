// Quarterly universe refresh
// Sources: Wikipedia S&P 500 + NASDAQ 100 + S&P MidCap 400 (~900 candidates)
// Criteria: beta > 1.0 (1yr daily regression vs SPY), avg daily dollar vol > $50M, price > $10
// Seeds bypass all filters — always included (curated high-beta catalyst names)
// Sector cap: top 35 per sector by avg daily dollar vol
// Cost: $0 — Wikipedia (free) + Yahoo Finance public endpoint (free, no key)
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

// Normalize sector names to a common taxonomy across Wikipedia sources
// S&P 500/MidCap 400 use GICS ("Information Technology")
// NASDAQ 100 uses ICB ("Technology", "Telecommunications")
function normalizeSector(raw) {
  const map = {
    'Information Technology': 'Technology',
    'Telecommunications':     'Communication Services',
    'Basic Materials':        'Materials',
    'Consumer Services':      'Consumer Discretionary',
    'Industrial Goods':       'Industrials',
    'Industrial':             'Industrials',
  };
  return map[raw] || raw;
}

// High-beta names not reliably in any of the three indexes, or that need
// guaranteed inclusion regardless of computed beta. Always in — no filter applied.
const SEED_TICKERS = {
  'SOXL':  'Technology',             // 3x leveraged semi ETF
  'IONQ':  'Technology',             // quantum computing
  'MARA':  'Crypto',                 // bitcoin miner
  'RIOT':  'Crypto',                 // bitcoin miner
  'MSTR':  'Crypto',                 // bitcoin proxy
  'COIN':  'Financials',             // crypto exchange
  'HOOD':  'Financials',             // retail brokerage
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

// ─── Wikipedia parsers ────────────────────────────────────────────────────────

// Parses S&P 500 and MidCap 400 tables — both use GICS with ticker in <a rel="nofollow">
async function fetchGICSTable(url, label) {
  const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA } });
  if (!r.ok) throw new Error(`${label} Wikipedia returned ${r.status}`);
  const html = await r.text();

  const tableStart = html.indexOf('id="constituents"');
  if (tableStart === -1) throw new Error(`${label} constituents table not found`);
  const table = html.slice(tableStart, html.indexOf('</table>', tableStart));

  const results = [];
  for (const row of table.split('<tr>').slice(2)) {
    const tickerMatch = row.match(/<td[^>]*><a[^>]+rel="nofollow"[^>]*>([A-Z0-9.]+)<\/a>/);
    if (!tickerMatch) continue;
    const ticker = tickerMatch[1].replace('.', '-'); // BRK.B → BRK-B

    const cells = row.split('</td>');
    if (cells.length < 3) continue;
    const sector = normalizeSector(cells[2].replace(/<[^>]*>/g, '').trim());
    if (!sector) continue;

    results.push({ ticker, sector });
  }
  return results;
}

// NASDAQ 100 uses ICB sectors with ticker as plain text in first cell
async function fetchNASDAQ100() {
  const r = await fetch('https://en.wikipedia.org/wiki/Nasdaq-100', {
    headers: { 'User-Agent': YAHOO_UA }
  });
  if (!r.ok) throw new Error(`NASDAQ 100 Wikipedia returned ${r.status}`);
  const html = await r.text();

  const tableStart = html.indexOf('id="constituents"');
  if (tableStart === -1) throw new Error('NASDAQ 100 constituents table not found');
  const table = html.slice(tableStart, html.indexOf('</table>', tableStart));

  const results = [];
  for (const row of table.split('<tr>').slice(2)) {
    const cells = row.split('</td>');
    if (cells.length < 3) continue;
    const ticker = cells[0].replace(/<[^>]*>/g, '').trim();
    if (!ticker || !/^[A-Z]{1,5}$/.test(ticker)) continue;
    const sector = normalizeSector(cells[2].replace(/<[^>]*>/g, '').trim());
    if (!sector) continue;
    results.push({ ticker, sector });
  }
  return results;
}

// ─── Yahoo data fetch ─────────────────────────────────────────────────────────

async function getYahooData(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) { await sleep(5000); return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp ?? [];
    const closes     = result.indicators?.quote?.[0]?.close  ?? [];
    const volumes    = result.indicators?.quote?.[0]?.volume ?? [];

    const byDate = {};
    for (let i = 0; i < timestamps.length; i++) {
      const c = closes[i], v = volumes[i];
      if (c == null || v == null || c <= 0) continue;
      const date = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
      byDate[date] = { close: c, volume: v };
    }

    const days = Object.values(byDate);
    if (days.length < 50) return null;

    const price        = result.meta?.regularMarketPrice ?? days.at(-1).close;
    const avgDollarVol = days.reduce((s, d) => s + d.close * d.volume, 0) / days.length;

    return { symbol, price, avgDollarVol, byDate };
  } catch { return null; }
}

// ─── Beta computation ─────────────────────────────────────────────────────────
// Beta = cov(stock_daily_returns, spy_daily_returns) / var(spy_daily_returns)
// Only uses dates present in both datasets — handles trading halts cleanly

function computeBeta(stockByDate, spyByDate) {
  const dates = Object.keys(stockByDate).filter(d => spyByDate[d]).sort();
  if (dates.length < 50) return null;

  const rStock = [], rSpy = [];
  for (let i = 1; i < dates.length; i++) {
    const prev = dates[i - 1], curr = dates[i];
    rStock.push((stockByDate[curr].close - stockByDate[prev].close) / stockByDate[prev].close);
    rSpy.push((spyByDate[curr].close   - spyByDate[prev].close)   / spyByDate[prev].close);
  }

  const n      = rStock.length;
  const meanS  = rStock.reduce((s, v) => s + v, 0) / n;
  const meanSpy = rSpy.reduce((s, v) => s + v, 0) / n;

  let cov = 0, varSpy = 0;
  for (let i = 0; i < n; i++) {
    cov    += (rStock[i] - meanS)   * (rSpy[i] - meanSpy);
    varSpy += (rSpy[i]   - meanSpy) ** 2;
  }

  if (varSpy === 0) return null;
  return (cov / n) / (varSpy / n);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const startedAt = new Date().toISOString();
  log(`Starting — ${startedAt}`);

  // 1. Fetch all three index constituent lists in parallel
  const [sp500, ndx100, midcap400] = await Promise.allSettled([
    fetchGICSTable('https://en.wikipedia.org/wiki/List_of_S%26P_500_companies',  'S&P 500'),
    fetchNASDAQ100(),
    fetchGICSTable('https://en.wikipedia.org/wiki/List_of_S%26P_400_companies',  'MidCap 400'),
  ]);

  const sources = [
    { label: 'S&P 500',    data: sp500.status    === 'fulfilled' ? sp500.value    : [] },
    { label: 'NASDAQ 100', data: ndx100.status   === 'fulfilled' ? ndx100.value   : [] },
    { label: 'MidCap 400', data: midcap400.status === 'fulfilled' ? midcap400.value : [] },
  ];
  for (const s of sources) {
    if (s.data.length) log(`${s.label}: ${s.data.length} entries`);
    else log(`${s.label}: FAILED — using seed list only for this source`);
  }

  // 2. Build sector map — first source wins for any given ticker
  const sectorMap = {};
  for (const { data } of sources)
    for (const { ticker, sector } of data)
      if (!sectorMap[ticker]) sectorMap[ticker] = sector;

  // Seeds fill remaining gaps (names not in any index)
  for (const [ticker, sector] of Object.entries(SEED_TICKERS))
    if (!sectorMap[ticker]) sectorMap[ticker] = sector;

  const allTickers = Object.keys(sectorMap);
  const seedSet    = new Set(Object.keys(SEED_TICKERS));
  log(`Total candidates: ${allTickers.length} (deduplicated across all sources)`);

  // 3. Fetch SPY baseline first
  log('Fetching SPY for beta computation...');
  const spyData = await getYahooData('SPY');
  if (!spyData) { log('Fatal: could not fetch SPY data'); process.exit(1); }
  log(`SPY: ${Object.keys(spyData.byDate).length} trading days`);

  // 4. Fetch Yahoo data for all candidates
  const yahooData = {};
  let done = 0;
  for (const ticker of allTickers) {
    const d = await getYahooData(ticker);
    if (d) yahooData[ticker] = d;
    done++;
    if (done % 100 === 0) log(`  ${done}/${allTickers.length} fetched...`);
    await sleep(150);
  }
  log(`Yahoo data: ${Object.keys(yahooData).length}/${allTickers.length} succeeded`);

  // 5. Filter non-seeds: beta > 1.0, dollar vol > $50M, price > $10
  const MIN_BETA       = 1.0;
  const MIN_DOLLAR_VOL = 50_000_000;
  const MIN_PRICE      = 10;

  const passing = [];
  const filtered = { noData: 0, price: 0, vol: 0, beta: 0 };

  for (const ticker of allTickers) {
    if (seedSet.has(ticker)) {
      // Seeds always pass — bypass all filters
      const d = yahooData[ticker];
      passing.push({ ticker, beta: null, avgDollarVol: d?.avgDollarVol ?? 0, price: d?.price ?? 0 });
      continue;
    }

    const d = yahooData[ticker];
    if (!d)                               { filtered.noData++; continue; }
    if (d.price < MIN_PRICE)              { filtered.price++;  continue; }
    if (d.avgDollarVol < MIN_DOLLAR_VOL) { filtered.vol++;    continue; }

    const beta = computeBeta(d.byDate, spyData.byDate);
    if (beta === null || beta < MIN_BETA) { filtered.beta++;   continue; }

    passing.push({ ticker, beta: +beta.toFixed(2), avgDollarVol: d.avgDollarVol, price: d.price });
  }

  log(`Passing: ${passing.length} tickers`);
  log(`Filtered — no data: ${filtered.noData}, price<$${MIN_PRICE}: ${filtered.price}, vol<$${MIN_DOLLAR_VOL/1e6}M: ${filtered.vol}, beta<${MIN_BETA}: ${filtered.beta}`);

  // 6. Group by sector, sort by dollar vol DESC, cap at 35 per sector
  const SECTOR_CAP = 35;
  const bySector   = {};
  for (const item of passing) {
    const sector = sectorMap[item.ticker] || 'Other';
    if (!bySector[sector]) bySector[sector] = [];
    bySector[sector].push(item);
  }

  const finalTickers  = [];
  const finalBySector = {};
  for (const [sector, items] of Object.entries(bySector)) {
    items.sort((a, b) => b.avgDollarVol - a.avgDollarVol);
    const selected = items.slice(0, SECTOR_CAP).map(i => i.ticker);
    finalBySector[sector] = selected;
    finalTickers.push(...selected);

    const betas = items.slice(0, SECTOR_CAP).filter(i => i.beta != null).map(i => i.beta);
    const betaStr = betas.length ? ` (β ${Math.min(...betas).toFixed(1)}–${Math.max(...betas).toFixed(1)})` : '';
    log(`  ${sector.padEnd(28)} ${selected.length} tickers${betaStr}`);
  }

  log(`Final universe: ${finalTickers.length} tickers across ${Object.keys(finalBySector).length} sectors`);

  // 7. Write output/universe.json
  writeFileSync(join(OUTPUT_DIR, 'universe.json'), JSON.stringify({
    generatedAt:  startedAt,
    refreshDate:  startedAt.split('T')[0],
    criteria:     { minBeta: MIN_BETA, minDollarVolM: MIN_DOLLAR_VOL / 1e6, minPrice: MIN_PRICE, sectorCap: SECTOR_CAP },
    sources:      sources.map(s => ({ name: s.label, count: s.data.length })),
    universeSize: finalTickers.length,
    bySector:     finalBySector,
    tickers:      finalTickers,
  }, null, 2));

  log(`Saved output/universe.json`);
}

main().catch(e => { log(`Fatal: ${e.message}`); process.exit(1); });
