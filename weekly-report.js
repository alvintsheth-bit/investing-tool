// weekly-report.js — Weekly P&L summary email
// Schedule: Sunday 5:30pm PT via launchd
// Cost: $0 — pure code, no Claude API calls
// Benchmarks: SPY (broad market), QQQ (Nasdaq-100/tech peers), IWM (small-cap/momentum)

import { config } from 'dotenv';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

config();

const __dirname  = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');
const YAHOO_UA   = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';

// ─── Week Date Range ──────────────────────────────────────────────────────────
// Runs Sunday — reports on the Mon-Fri week just completed
function getWeekDates() {
  const now    = new Date();
  const sunday = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const monday = new Date(sunday); monday.setDate(sunday.getDate() - 6);
  const friday = new Date(sunday); friday.setDate(sunday.getDate() - 2);
  const fmt    = d => d.toISOString().split('T')[0];
  return { monday: fmt(monday), friday: fmt(friday) };
}

// ─── Yahoo Finance ────────────────────────────────────────────────────────────
async function yahooWeeklyReturn(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=10d`;
    const r   = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const d   = await r.json();
    const result = d?.chart?.result?.[0];
    if (!result) return null;

    const timestamps = result.timestamp || [];
    const closes     = result.indicators?.quote?.[0]?.close || [];
    const { monday, friday } = getWeekDates();

    // Find Monday open (first bar on or after Monday) and Friday close (last bar on or before Friday)
    const bars = timestamps.map((t, i) => ({
      date: new Date(t * 1000).toISOString().split('T')[0],
      close: closes[i],
    })).filter(b => b.close != null);

    const weekBars = bars.filter(b => b.date >= monday && b.date <= friday);
    if (weekBars.length < 2) {
      // Fall back: last 5 bars
      const last5 = bars.slice(-5);
      if (last5.length < 2) return null;
      const open  = last5[0].close;
      const close = last5[last5.length - 1].close;
      return { pct: ((close - open) / open) * 100, open, close, days: last5.length };
    }

    const open  = weekBars[0].close;
    const close = weekBars[weekBars.length - 1].close;
    return { pct: ((close - open) / open) * 100, open, close, days: weekBars.length };
  } catch { return null; }
}

// ─── Yahoo Day Close ──────────────────────────────────────────────────────────
async function fetchDayStats(symbol, date) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=30d`;
    const r   = await fetch(url, { headers: { 'User-Agent': YAHOO_UA, Accept: 'application/json' } });
    if (!r.ok) return null;
    const d   = await r.json();
    const result = d?.chart?.result?.[0];
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

// ─── Load Local Data ──────────────────────────────────────────────────────────
function loadTradesLog() {
  const path = join(OUTPUT_DIR, 'trades-log.json');
  if (!existsSync(path)) return { trades: [] };
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { trades: [] }; }
}

function loadExpectancyLog() {
  const path = join(OUTPUT_DIR, 'expectancy-log.json');
  if (!existsSync(path)) return { entries: [] };
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return { entries: [] }; }
}

function loadSODBalance() {
  const path = join(OUTPUT_DIR, 'sod-balance.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')).balance; } catch { return null; }
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendEmail(subject, html, text) {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) { console.log('  ⚠️  Email skipped — GMAIL credentials not set'); return; }
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: user, to: user, subject, html, text });
  console.log(`  📧 Weekly report sent → ${user}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { monday, friday } = getWeekDates();
  console.log(`[weekly-report] Week of ${monday} → ${friday}`);

  const DRY_RUN = process.env.DRY_RUN !== 'false';

  // ── Load this week's closed trades ─────────────────────────────────────────
  const log          = loadTradesLog();
  const weekTrades   = log.trades.filter(t => t.date >= monday && t.date <= friday && t.pnl !== null && t.pnl !== undefined);
  const liveOnly     = weekTrades.filter(t => t.isLive === true);
  const displayTrades = DRY_RUN ? weekTrades : liveOnly;

  // ── Load this week's expectancy entries ────────────────────────────────────
  const expLog     = loadExpectancyLog();
  const weekExp    = expLog.entries.filter(e => e.date >= monday && e.date <= friday);

  // ── P&L calculations ───────────────────────────────────────────────────────
  const totalPnl   = displayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins       = displayTrades.filter(t => t.pnl > 0);
  const losses     = displayTrades.filter(t => t.pnl <= 0);
  const winRate    = displayTrades.length ? (wins.length / displayTrades.length) * 100 : 0;
  const avgWin     = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss    = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const expectancy = displayTrades.length ? totalPnl / displayTrades.length : 0;
  const grossWins  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossWins / grossLoss : null;

  const bestTrade  = displayTrades.length ? displayTrades.reduce((a, b) => (b.pnl > a.pnl ? b : a), displayTrades[0]) : null;
  const worstTrade = displayTrades.length ? displayTrades.reduce((a, b) => (b.pnl < a.pnl ? b : a), displayTrades[0]) : null;

  // Capital base for % return (use SOD balance of the week; fall back to rough estimate)
  const sodBalance = loadSODBalance() || null;

  // ── Signal breakdown ───────────────────────────────────────────────────────
  const SIGNAL_KEYS = [
    'premarket_gap_up', 'rvol_spike', 'gap_likely_holds', 'macro_tailwind',
    'sector_leading', 'news_catalyst', 'notable_mention', 'insider_buying',
    'contrarian_social', 'analyst_conviction',
  ];
  const signalStats = {};
  for (const key of SIGNAL_KEYS) {
    const fired = displayTrades.filter(t => t.signals?.[key]);
    const firedWins = fired.filter(t => t.pnl > 0);
    signalStats[key] = { fired: fired.length, wins: firedWins.length };
  }

  // ── Setup score bands ──────────────────────────────────────────────────────
  const bands = [
    { label: '0.55–0.65', min: 0.55, max: 0.65 },
    { label: '0.65–0.75', min: 0.65, max: 0.75 },
    { label: '0.75+',     min: 0.75, max: 1.00 },
  ];
  const bandStats = bands.map(b => {
    const bt    = displayTrades.filter(t => (t.setupScore || 0) >= b.min && (t.setupScore || 0) < b.max);
    const bwins = bt.filter(t => t.pnl > 0);
    return { ...b, count: bt.length, wins: bwins.length, pnl: bt.reduce((s, t) => s + t.pnl, 0) };
  });

  // ── Benchmarks ─────────────────────────────────────────────────────────────
  console.log('[weekly-report] Fetching benchmarks (SPY, QQQ, IWM)...');
  const [spy, qqq, iwm] = await Promise.all([
    yahooWeeklyReturn('SPY'),
    yahooWeeklyReturn('QQQ'),
    yahooWeeklyReturn('IWM'),
  ]);

  // Alpha vs SPY (the primary "did you beat the market" benchmark)
  const agentPct  = sodBalance && totalPnl ? (totalPnl / sodBalance) * 100 : null;
  const alphaSPY  = agentPct !== null && spy  ? agentPct - spy.pct  : null;
  const alphaQQQ  = agentPct !== null && qqq  ? agentPct - qqq.pct  : null;
  const alphaIWM  = agentPct !== null && iwm  ? agentPct - iwm.pct  : null;

  // What you'd have made on the same capital if you'd just bought each index
  const spyDollar = sodBalance && spy  ? (spy.pct  / 100) * sodBalance : null;
  const qqqDollar = sodBalance && qqq  ? (qqq.pct  / 100) * sodBalance : null;
  const iwmDollar = sodBalance && iwm  ? (iwm.pct  / 100) * sodBalance : null;

  // ── Format helpers ─────────────────────────────────────────────────────────
  const fmt$  = n => n >= 0 ? `+$${n.toFixed(2)}` : `-$${Math.abs(n).toFixed(2)}`;
  const fmtPct = n => n >= 0 ? `+${n.toFixed(2)}%` : `${n.toFixed(2)}%`;
  const na    = v => v !== null && v !== undefined ? v : 'n/a';

  // ── Build report text ──────────────────────────────────────────────────────
  const modeTag = DRY_RUN ? ' [DRY RUN — no real money]' : ' [LIVE]';
  const lines   = [
    `📊 Weekly P&L Report — ${monday} to ${friday}${modeTag}`,
    '',
    '━━━ PERFORMANCE ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    displayTrades.length
      ? [
          `  Agent:  ${fmt$(totalPnl)}${agentPct !== null ? ` (${fmtPct(agentPct)} of capital)` : ''}`,
          `  SPY:    ${spy  ? fmtPct(spy.pct)  : 'n/a'}${spyDollar !== null ? `  →  buy-and-hold would have made ${fmt$(spyDollar)}` : ''}`,
          `  QQQ:    ${qqq  ? fmtPct(qqq.pct)  : 'n/a'}${qqqDollar !== null ? `  →  ${fmt$(qqqDollar)}` : ''}`,
          `  IWM:    ${iwm  ? fmtPct(iwm.pct)  : 'n/a'}${iwmDollar !== null ? `  →  ${fmt$(iwmDollar)}` : ''}`,
          '',
          `  vs SPY: ${alphaSPY !== null ? fmtPct(alphaSPY) + ' alpha' : 'n/a (no capital baseline)'}`,
          `  vs QQQ: ${alphaQQQ !== null ? fmtPct(alphaQQQ) : 'n/a'}`,
          `  vs IWM: ${alphaIWM !== null ? fmtPct(alphaIWM) : 'n/a'}`,
        ].join('\n')
      : [
          `  Agent:  no trades this week`,
          `  SPY:    ${spy  ? fmtPct(spy.pct)  : 'n/a'}`,
          `  QQQ:    ${qqq  ? fmtPct(qqq.pct)  : 'n/a'}`,
          `  IWM:    ${iwm  ? fmtPct(iwm.pct)  : 'n/a'}`,
        ].join('\n'),
    '',
    '━━━ TRADES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `  Total:         ${displayTrades.length} trades  (${wins.length}W / ${losses.length}L)`,
    `  Win rate:      ${displayTrades.length ? winRate.toFixed(0) + '%' : 'n/a'}`,
    `  Avg win:       ${wins.length   ? fmt$(avgWin)  : 'n/a'}`,
    `  Avg loss:      ${losses.length ? fmt$(avgLoss) : 'n/a'}`,
    `  Expectancy:    ${displayTrades.length ? fmt$(expectancy) + '/trade' : 'n/a'}`,
    `  Profit factor: ${profitFactor !== null ? profitFactor.toFixed(2) : 'n/a'}`,
    '',
    bestTrade  ? `  Best:   ${bestTrade.ticker.padEnd(6)} ${fmt$(bestTrade.pnl).padEnd(10)} (${bestTrade.exitReason || '?'})` : '',
    worstTrade && worstTrade !== bestTrade ? `  Worst:  ${worstTrade.ticker.padEnd(6)} ${fmt$(worstTrade.pnl).padEnd(10)} (${worstTrade.exitReason || '?'})` : '',
  ].filter(l => l !== undefined);

  if (displayTrades.length > 0) {
    lines.push('');
    lines.push('━━━ SIGNAL PERFORMANCE ━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const [key, s] of Object.entries(signalStats)) {
      if (s.fired === 0) continue;
      const wr = ((s.wins / s.fired) * 100).toFixed(0);
      lines.push(`  ${key.padEnd(22)} ${s.fired} trades  ${wr}% win rate`);
    }

    lines.push('');
    lines.push('━━━ SETUP SCORE BANDS ━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    for (const b of bandStats) {
      if (b.count === 0) continue;
      const wr = ((b.wins / b.count) * 100).toFixed(0);
      lines.push(`  ${b.label.padEnd(10)} ${b.count} trades  ${wr}% win rate  ${fmt$(b.pnl)}`);
    }
  }

  lines.push('');
  lines.push(`Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT`);

  const reportText = lines.join('\n');
  console.log('\n' + reportText);

  // ── Email ──────────────────────────────────────────────────────────────────
  const pnlStr  = displayTrades.length ? fmt$(totalPnl) : 'no trades';
  const subject = `📊 Weekly Report ${monday} | ${pnlStr} | ${wins.length}W/${losses.length}L | SPY ${spy ? fmtPct(spy.pct) : '?'}`;

  // Fetch EOD close + day high for each trade (historical)
  const dayStats = await Promise.all(
    displayTrades.map(t => fetchDayStats(t.ticker, t.date))
  );

  const tradeRows = displayTrades.map((t, i) => {
    const slip      = t.slippagePct != null ? `${t.slippagePct >= 0 ? '+' : ''}${t.slippagePct.toFixed(2)}%` : '—';
    const dec       = t.decisionPrice ? `$${t.decisionPrice.toFixed(2)}` : '—';
    const pnlColor  = t.pnl >= 0 ? '#1a7f37' : '#cf222e';
    const r         = t.rMultiple != null ? `${t.rMultiple.toFixed(2)}R` : '—';
    const stats     = dayStats[i];
    const qty       = t.dollarAmount && t.entryPrice ? t.dollarAmount / t.entryPrice : null;
    const leftAmt   = stats?.high && qty ? (stats.high - t.exitPrice) * qty : null;
    const eodCell   = stats?.close ? `$${stats.close.toFixed(2)}` : '—';
    const highCell  = stats?.high  ? `$${stats.high.toFixed(2)}`  : '—';
    const leftColor = leftAmt == null ? '#555' : leftAmt > 0 ? '#cf222e' : '#1a7f37';
    const leftCell  = leftAmt != null
      ? `<span style="color:${leftColor};">${leftAmt >= 0 ? '+' : ''}$${leftAmt.toFixed(2)}</span>`
      : '—';
    return `<tr style="border-bottom:1px solid #eee;">
      <td style="padding:5px 8px;color:#555;">${t.date}</td>
      <td style="padding:5px 8px;font-weight:bold;">${t.ticker}</td>
      <td style="padding:5px 8px;">${dec}</td>
      <td style="padding:5px 8px;">$${t.entryPrice.toFixed(2)}</td>
      <td style="padding:5px 8px;color:${t.slippagePct > 1 ? '#cf222e' : '#555'};">${slip}</td>
      <td style="padding:5px 8px;">$${t.exitPrice.toFixed(2)}</td>
      <td style="padding:5px 8px;color:#555;">${highCell}</td>
      <td style="padding:5px 8px;">${eodCell}</td>
      <td style="padding:5px 8px;">${leftCell}</td>
      <td style="padding:5px 8px;font-weight:bold;color:${pnlColor};">${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPct.toFixed(1)}%)</td>
      <td style="padding:5px 8px;color:#555;">${r}</td>
    </tr>`;
  }).join('');

  const html = `<html><body style="font-family:monospace;max-width:800px;margin:auto;padding:24px;background:#fff;">
<h2 style="margin-bottom:4px;">📊 Weekly P&L — ${monday} to ${friday}</h2>
<p style="color:#888;margin-top:0;">${DRY_RUN ? '🔷 DRY RUN — paper trading' : '🚨 LIVE'}</p>
${displayTrades.length ? `
<table style="width:100%;border-collapse:collapse;margin:16px 0;font-size:13px;">
  <thead><tr style="background:#f6f8fa;text-align:left;">
    <th style="padding:5px 8px;">Date</th>
    <th style="padding:5px 8px;">Ticker</th>
    <th style="padding:5px 8px;">Decision $</th>
    <th style="padding:5px 8px;">Fill $</th>
    <th style="padding:5px 8px;">Slippage</th>
    <th style="padding:5px 8px;">Exit $</th>
    <th style="padding:5px 8px;">Day High</th>
    <th style="padding:5px 8px;">EOD $</th>
    <th style="padding:5px 8px;">Left on table</th>
    <th style="padding:5px 8px;">P&amp;L</th>
    <th style="padding:5px 8px;">R-Multiple</th>
  </thead>
  <tbody>${tradeRows}</tbody>
</table>` : '<p style="color:#888;">No trades this week.</p>'}
<pre style="white-space:pre-wrap;line-height:1.6;font-size:13px;">${reportText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
</body></html>`;

  await sendEmail(subject, html, reportText);
}

main().catch(err => {
  console.error('[weekly-report] Fatal:', err.message);
  process.exit(1);
});
