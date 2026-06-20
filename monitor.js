import { config } from 'dotenv';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');

// ─── Market Calendar (mirrors agent.js) ──────────────────────────────────────
const US_MARKET_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03',
  '2026-05-25', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-04-02',
  '2027-05-31', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);

// PT-aware date/day — avoids UTC vs local ambiguity in launchd environments
const today     = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());
const _ptDow    = new Date(today + 'T12:00:00');
const dayOfWeek = _ptDow.getDay();

if (dayOfWeek === 0 || dayOfWeek === 6 || US_MARKET_HOLIDAYS.has(today)) {
  console.log(`[monitor] Market closed today (${today}) — skipping.`);
  process.exit(0);
}

// ─── Email ────────────────────────────────────────────────────────────────────
async function sendEmail(subject, body) {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 587, secure: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
  });
  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to:   process.env.GMAIL_USER,
    subject,
    text: body,
  });
}

// ─── Checks ───────────────────────────────────────────────────────────────────

function fileExists(path) {
  return existsSync(path);
}

function fileTouchedAfter(path, hourPT) {
  if (!existsSync(path)) return false;
  const mtime = statSync(path).mtimeMs;
  // Convert PT hour to UTC (PT = UTC-7 summer, UTC-8 winter)
  // Use a conservative UTC offset — we only care about "was it touched today?"
  const todayStart = new Date(`${today}T00:00:00-07:00`).getTime();
  const threshold  = todayStart + hourPT * 60 * 60 * 1000;
  return mtime >= threshold;
}

function loadOpenPositions() {
  const path = join(OUTPUT_DIR, 'trades-open.json');
  if (!existsSync(path)) return { date: null, positions: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch { return { date: null, positions: [] }; }
}

// ─── Run Checks ───────────────────────────────────────────────────────────────
async function main() {
  console.log(`[monitor] Running health checks for ${today}…`);

  const failures = [];
  const results  = [];

  // 1. Screener produced today's candidates file
  const screenerFile = join(OUTPUT_DIR, `screener-${today}.json`);
  if (fileExists(screenerFile)) {
    try {
      const s = JSON.parse(readFileSync(screenerFile, 'utf-8'));
      const n = s?.candidates?.length ?? 0;
      results.push(`✅ Screener     screener file present (${n} candidate(s) from ${s?.universeSize ?? '?'} stocks)`);
    } catch {
      results.push('✅ Screener     screener file present (unreadable)');
    }
  } else {
    failures.push('❌ Screener     screener-' + today + '.json MISSING — screener may have crashed');
    results.push('❌ Screener     screener file MISSING');
  }

  // 2. Scrape produced today's data file
  const scrapeFile = join(OUTPUT_DIR, `sam-weiss-${today}.json`);
  if (fileExists(scrapeFile)) {
    results.push('✅ Scrape       sam-weiss file present');
  } else {
    failures.push('❌ Scrape       sam-weiss-' + today + '.json MISSING');
    results.push('❌ Scrape       sam-weiss file MISSING');
  }

  // 3. Scan (6am) produced today's recommendations file
  const scanFile = join(OUTPUT_DIR, `recommendations-${today}.md`);
  if (fileExists(scanFile)) {
    results.push('✅ Scan (6am)   recommendations file present');
  } else {
    failures.push('❌ Scan (6am)   recommendations-' + today + '.md MISSING — agent may have crashed');
    results.push('❌ Scan (6am)   recommendations file MISSING');
  }

  // 4. EOD report produced
  const eodFile = join(OUTPUT_DIR, `eod-report-${today}.md`);
  if (fileExists(eodFile)) {
    results.push('✅ EOD (1:30pm) report file present');
  } else {
    failures.push('❌ EOD (1:30pm) eod-report-' + today + '.md MISSING — EOD agent may have crashed');
    results.push('❌ EOD (1:30pm) report file MISSING');
  }

  // 5. Open positions cleared (force-close worked)
  const openData = loadOpenPositions();
  const isStaleDate = openData.date && openData.date !== today;
  const openCount   = isStaleDate ? 0 : (openData.positions?.length ?? 0);

  if (openCount === 0) {
    results.push('✅ Positions    trades-open.json clear (0 open)');
  } else {
    const tickers = openData.positions.map(p => p.ticker).join(', ');
    failures.push(
      `❌ Positions    ${openCount} position(s) still OPEN after force-close: ${tickers}` +
      ' — check Robinhood immediately'
    );
    results.push(`❌ Positions    ${openCount} still open: ${tickers}`);
  }

  // 6. Exit-daemon: verify it STARTED (~6:25am) AND ran through end of session (~12:30pm+)
  // A log touched only at 6:25am but not again means the daemon crashed before the session ended.
  const daemonLog = join(OUTPUT_DIR, 'logs', 'exit-daemon.log');
  const daemonStarted = fileTouchedAfter(daemonLog, 6.4);
  const daemonRanFull = fileTouchedAfter(daemonLog, 12.5); // still polling at 12:30pm
  if (!daemonStarted) {
    failures.push('❌ Exit-daemon  exit-daemon.log NOT updated today — daemon may not have fired');
    results.push('❌ Exit-daemon  did not start today');
  } else if (!daemonRanFull) {
    failures.push('❌ Exit-daemon  log last updated before 12:30pm — daemon may have crashed mid-session; positions may have been unmonitored');
    results.push('❌ Exit-daemon  started but may have crashed mid-session');
  } else {
    results.push('✅ Exit-daemon  started ~6:25am and ran through end of session');
  }

  // 7. Force-close log touched after 12:45pm (failsafe ran)
  const fcLog = join(OUTPUT_DIR, 'logs', 'force-close.log');
  if (fileTouchedAfter(fcLog, 12.75)) {
    results.push('✅ Force-close  log updated after 12:45pm');
  } else {
    failures.push('❌ Force-close  log NOT updated today — launchd job may not have fired');
    results.push('❌ Force-close  log not updated today');
  }

  // ─── Report ─────────────────────────────────────────────────────────────────
  const summary = results.join('\n');
  console.log('\n' + summary);

  if (failures.length > 0) {
    const subject = `🚨 Investing Agent — ${failures.length} failure(s) on ${today}`;
    const body = [
      `Health check ran at ${new Date().toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles' })} PT`,
      '',
      'FAILURES:',
      failures.join('\n'),
      '',
      'ALL CHECKS:',
      summary,
      '',
      'Action: check output/logs/ for error details.',
    ].join('\n');
    await sendEmail(subject, body);
    console.log(`[monitor] ⚠️  Alert email sent — ${failures.length} failure(s)`);
    process.exit(1);
  } else {
    console.log('[monitor] ✅ All checks passed — no alert needed');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('[monitor] Fatal error:', err.message);
  process.exit(1);
});
