import { chromium } from 'playwright';
import { config } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const URL_TO_DEBUG = process.argv[2] || 'https://sam-weiss.com/samwise/samwise-strategies/';

const browser = await chromium.launch({ headless: false }); // visible so you can see
const page = await browser.newPage();

// Login
await page.goto('https://sam-weiss.com/login/');
await page.waitForLoadState('networkidle');
for (const sel of ['#user_login', '#username', 'input[name="log"]']) {
  if (await page.locator(sel).count() > 0) { await page.fill(sel, process.env.SAM_WEISS_USERNAME); break; }
}
for (const sel of ['#user_pass', '#password', 'input[name="pwd"]']) {
  if (await page.locator(sel).count() > 0) { await page.fill(sel, process.env.SAM_WEISS_PASSWORD); break; }
}
for (const sel of ['#wp-submit', 'input[type="submit"]', 'button[type="submit"]']) {
  if (await page.locator(sel).count() > 0) { await page.click(sel); break; }
}
await page.waitForLoadState('networkidle');
console.log(`Logged in → ${page.url()}`);

// Navigate to target
await page.goto(URL_TO_DEBUG, { waitUntil: 'networkidle', timeout: 30000 });
console.log(`\nPage: ${page.url()}\n`);

// Report all elements with meaningful text
const report = await page.evaluate(() => {
  const candidates = [
    '#wpadminbar', 'nav', 'header', 'main', 'article',
    '.entry-content', '.post-content', '.page-content',
    '#content', '#primary', '.site-content',
    '.elementor', '.elementor-section', '.elementor-widget-text-editor',
    '.wp-block', '.wp-block-group', '.container',
    '[class*="content"]', '[class*="entry"]', '[class*="post"]',
    '[class*="page"]', '[class*="strategy"]', '[class*="samwise"]',
  ];

  return candidates.map(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const text = el.innerText.trim().slice(0, 100).replace(/\n/g, ' ');
    return { sel, chars: el.innerText.trim().length, preview: text };
  }).filter(Boolean).filter(r => r.chars > 50);
});

console.log('Available selectors and char counts:');
report.sort((a, b) => b.chars - a.chars).forEach(r => {
  console.log(`  ${r.chars.toLocaleString()} chars  ${r.sel.padEnd(40)} "${r.preview.slice(0, 60)}..."`);
});

await page.screenshot({ path: './screenshots/debug-strategy.png', fullPage: false });
console.log('\nScreenshot saved to ./screenshots/debug-strategy.png');

// Keep browser open 5 seconds so you can see it
await page.waitForTimeout(5000);
await browser.close();
