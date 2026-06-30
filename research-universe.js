// One-off research script — validate existing 78 + score candidates for addition
// Run: node research-universe.js
// Output: universe-research-YYYY-MM-DD.md

import { config } from 'dotenv';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const FMP_KEY   = process.env.FMP_API_KEY;
if (!FMP_KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }

const sleep  = ms => new Promise(r => setTimeout(r, ms));
const YAHOO_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ─── Current universe (from screener.js) ─────────────────────────────────────
const CURRENT_78 = [
  'NVDA','TSLA','AAPL','META','MSFT','AMZN','GOOGL','AMD','PLTR','COIN',
  'MSTR','ARM','SMCI','AVGO','CRM','NFLX','UBER','HOOD','SNOW','CRWD',
  'PANW','DDOG','NET','SHOP','SQ','PYPL','RBLX','IONQ','RGTI','SPCX',
  'INTC','QCOM','MU','AMAT','LRCX','TSM','MRVL','SOXL','KLAC',
  'JPM','GS','BAC','MS','C','WFC','V','MA',
  'GE','CAT','DE','HON','RTX','URI','BA',
  'XOM','CVX','OXY',
  'LLY','UNH','ABBV','MRNA','BNTX',
  'NKE','SBUX','MCD','HD','TGT','WMT',
  'FCX','NUE','CLF','AA',
  'BABA','BIDU','JD','PDD','NIO','XPEV','LI',
  'GME','ACHR','ACMR',
];

// ─── Candidates — comprehensive S&P 500 + NASDAQ 100 + high-beta names ────────
// Excludes anything already in CURRENT_78
const CANDIDATES = [
  // NASDAQ 100 not in universe
  'ABNB','ADBE','ADP','ALGN','ANSS','APP','ASML','CDNS','CMCSA','CSCO',
  'CTSH','DLTR','EA','EBAY','FAST','FSLR','FTNT','GEHC','HUBS','IDXX',
  'ILMN','INTU','KDP','LULU','MAR','MDLZ','MNST','NOW','ODFL','ON',
  'ORLY','PAYX','PCAR','ROST','SNPS','TEAM','TTWO','VRSK','VRTX','WDAY',
  'WBD','ZS',

  // S&P 500 high-beta / news-driven not in universe
  'AXON','CELH','COST','DIS','DXCM','F','GM','HAL','HIMS','ISRG',
  'LMT','LYFT','NOC','OKTA','PINS','RDDT','REGN','RIVN','SNAP','SOFI',
  'SPOT','UPST','BIIB','GILD','BILL','AFRM','DUOL','EBAY',

  // Bitcoin miners / crypto adjacent
  'MARA','RIOT','CLSK','HUT','CIFR',

  // Biotech (gap on FDA/clinical/trial events)
  'ALNY','SRPT','EXAS','BMRN','IONS','INSM','RARE','RGEN','KRYS',
  'ARVN','KYMR','PCVX','DNLI','IMVT','NKTR','RCKT',

  // EV / space / next-gen
  'LCID','RKLB','JOBY','RIVN',

  // High-beta momentum / AI micro-caps
  'HIMS','CAVA','BROS','RXRX','SOUN','LUNR','ORCL',
];

// ─── Thresholds ───────────────────────────────────────────────────────────────
// Beta not available from Yahoo chart endpoint — filter on dollar volume + price only.
// Beta from prior FMP run annotated manually in the report where known.
const MIN_DOLLAR_VOL = 100_000_000; // $100M avg daily dollar volume
const MIN_PRICE      = 5;

// ─── Yahoo v8/chart — confirmed working (same as screener) ───────────────────
// Returns price + 30-day avg daily volume. Beta not available; filter on $ vol only.
async function getYahooProfile(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=35d`;
    const r = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (r.status === 429) { await sleep(3000); return null; }
    if (!r.ok) return null;
    const d = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;
    const meta    = result.meta;
    const closes  = result.indicators?.quote?.[0]?.close?.filter(Boolean) || [];
    const volumes = result.indicators?.quote?.[0]?.volume?.filter(Boolean) || [];
    const price   = meta.regularMarketPrice ?? closes.at(-1) ?? 0;
    const volAvg  = volumes.length ? volumes.reduce((s,v) => s+v, 0) / volumes.length : 0;
    return {
      symbol:    symbol,
      price,
      beta:      null,  // not available from chart endpoint
      volAvg,
      dollarVol: volAvg * price,
      exchange:  meta.exchangeName ?? '',
      sector:    '',
    };
  } catch { return null; }
}

function fmt(n) {
  if (n >= 1_000_000_000) return `$${(n/1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `$${(n/1_000_000).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

function passesFilters(p) {
  return p.price >= MIN_PRICE && p.dollarVol >= MIN_DOLLAR_VOL;
}

function statusIcon(p) {
  if (!p) return '❓';
  const issues = [];
  if (p.price < MIN_PRICE)          issues.push(`price $${p.price.toFixed(2)} < $${MIN_PRICE}`);
  if (p.dollarVol < MIN_DOLLAR_VOL) issues.push(`vol ${fmt(p.dollarVol)} < ${fmt(MIN_DOLLAR_VOL)}`);
  return issues.length === 0 ? '✅' : `⚠️  ${issues.join(', ')}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
  console.log(`Fetching profiles for ${CURRENT_78.length} current + ${CANDIDATES.length} candidates...`);

  const allSymbols = [...new Set([...CURRENT_78, ...CANDIDATES.filter(s => !CURRENT_78.includes(s))])];
  const profiles   = {};

  for (const sym of allSymbols) {
    process.stdout.write(`  ${sym.padEnd(6)} `);
    const p = await getYahooProfile(sym);
    profiles[sym] = p;
    console.log(p ? `$${p.price.toFixed(2).padStart(8)}  vol=${fmt(p.dollarVol)}` : 'FAILED');
    await sleep(120);
  }

  // ─── Current 78: flag weak ones ─────────────────────────────────────────────
  const current78Results = CURRENT_78.map(sym => ({ sym, p: profiles[sym] }));
  const weakCurrent = current78Results.filter(({ p }) => !p || !passesFilters(p));
  const strongCurrent = current78Results.filter(({ p }) => p && passesFilters(p));

  // ─── Candidates: rank by dollar volume ───────────────────────────────────────
  const candidateResults = CANDIDATES
    .filter(s => !CURRENT_78.includes(s))
    .map(sym => ({ sym, p: profiles[sym] }))
    .sort((a, b) => (b.p?.dollarVol ?? 0) - (a.p?.dollarVol ?? 0));

  const strongCandidates = candidateResults.filter(({ p }) => p && passesFilters(p));
  const weakCandidates   = candidateResults.filter(({ p }) => !p || !passesFilters(p));

  // ─── Build report ────────────────────────────────────────────────────────────
  const lines = [
    `# Universe Research — ${today}`,
    `> Criteria: price ≥ $${MIN_PRICE} | avg daily dollar vol ≥ ${fmt(MIN_DOLLAR_VOL)} | (beta from prior FMP run where available)`,
    '',
    `## Current 78 — Flagged (${weakCurrent.length} below criteria)`,
    '',
    '| Ticker | Price | Avg $ Vol | Issue |',
    '|--------|-------|-----------|-------|',
    ...weakCurrent.map(({ sym, p }) =>
      p
        ? `| ${sym} | $${p.price.toFixed(2)} | ${fmt(p.dollarVol)} | ${statusIcon(p).replace('⚠️  ','')} |`
        : `| ${sym} | — | — | no data |`
    ),
    '',
    `## Current 78 — Passing (${strongCurrent.length})`,
    '',
    '| Ticker | Price | Beta | Avg $ Vol | Sector |',
    '|--------|-------|------|-----------|--------|',
    ...strongCurrent
      .sort((a, b) => (b.p?.dollarVol ?? 0) - (a.p?.dollarVol ?? 0))
      .map(({ sym, p }) =>
        `| ${sym} | $${p.price.toFixed(2)} | ${p.beta?.toFixed(2)} | ${fmt(p.dollarVol)} | ${p.sector} |`
      ),
    '',
    `## Candidates — Passes Criteria (${strongCandidates.length} — recommended to add)`,
    '',
    '| Ticker | Price | Beta | Avg $ Vol | Sector |',
    '|--------|-------|------|-----------|--------|',
    ...strongCandidates.map(({ sym, p }) =>
      `| ${sym} | $${p.price.toFixed(2)} | ${p.beta?.toFixed(2)} | ${fmt(p.dollarVol)} | ${p.sector} |`
    ),
    '',
    `## Candidates — Below Criteria (${weakCandidates.length} — do not add yet)`,
    '',
    '| Ticker | Price | Beta | Avg $ Vol | Issue |',
    '|--------|-------|------|-----------|-------|',
    ...weakCandidates.map(({ sym, p }) =>
      p
        ? `| ${sym} | $${p.price.toFixed(2)} | ${p.beta?.toFixed(2) ?? 'n/a'} | ${fmt(p.dollarVol)} | ${statusIcon(p).replace('⚠️  ','')} |`
        : `| ${sym} | — | — | — | no data |`
    ),
    '',
    '## Summary',
    `- Current universe: ${CURRENT_78.length} tickers, ${weakCurrent.length} flagged for review`,
    `- Recommended additions: ${strongCandidates.length} candidates pass all criteria`,
    `- Rejected candidates: ${weakCandidates.length} below criteria`,
  ];

  const outPath = join(__dirname, `universe-research-${today}.md`);
  writeFileSync(outPath, lines.join('\n'));
  console.log(`\n✅ Report saved → ${outPath}`);
  console.log(`\nQuick summary:`);
  console.log(`  Flagged in current 78:  ${weakCurrent.length} — ${weakCurrent.map(x=>x.sym).join(', ')}`);
  console.log(`  Recommended additions:  ${strongCandidates.length} — ${strongCandidates.map(x=>x.sym).join(', ')}`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
