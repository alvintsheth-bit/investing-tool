import { chromium } from 'playwright';
import { config } from 'dotenv';
import { writeFileSync, mkdirSync } from 'fs';

config();

const BASE_URL = 'https://sam-weiss.com';
const OUTPUT_DIR = './output';

mkdirSync(OUTPUT_DIR, { recursive: true });
mkdirSync('./screenshots', { recursive: true });

async function login(page) {
  await page.goto(`${BASE_URL}/login/`);
  await page.waitForLoadState('networkidle');

  // Try common WordPress field selectors
  const usernameSelectors = ['#user_login', '#username', 'input[name="log"]', 'input[name="username"]', 'input[type="email"]'];
  const passwordSelectors = ['#user_pass', '#password', 'input[name="pwd"]', 'input[name="password"]', 'input[type="password"]'];

  let filled = false;
  for (const sel of usernameSelectors) {
    if (await page.locator(sel).count() > 0) {
      await page.fill(sel, process.env.SAM_WEISS_USERNAME);
      filled = true;
      break;
    }
  }
  if (!filled) throw new Error('Could not find username field');

  for (const sel of passwordSelectors) {
    if (await page.locator(sel).count() > 0) {
      await page.fill(sel, process.env.SAM_WEISS_PASSWORD);
      break;
    }
  }

  // Submit
  const submitSelectors = ['#wp-submit', 'input[type="submit"]', 'button[type="submit"]', '.login-submit button'];
  for (const sel of submitSelectors) {
    if (await page.locator(sel).count() > 0) {
      await page.click(sel);
      break;
    }
  }

  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: './screenshots/after-login.png' });

  const url = page.url();
  if (url.includes('login') || url.includes('wp-login')) {
    throw new Error(`Login may have failed — still on: ${url}`);
  }
  console.log(`Logged in. Current URL: ${url}`);
}

async function scrapeDailyBriefing(page) {
  console.log('Scraping Daily Briefing...');
  await page.goto(`${BASE_URL}/daily-briefing/`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: './screenshots/daily-briefing.png' });

  const content = await page.evaluate(() => {
    const article = document.querySelector('article, .entry-content, .post-content, main');
    return article ? article.innerText : document.body.innerText;
  });

  return { page: 'daily-briefing', content, url: page.url(), scrapedAt: new Date().toISOString() };
}

async function scrapePortfolios(page) {
  console.log('Scraping Portfolios...');
  const portfolios = [];

  const portfolioNames = ['targaryen', 'baratheon', 'lannister', 'tyrell', 'arryn', 'tarly', 'stark', 'frey', 'hightower'];

  for (const name of portfolioNames) {
    try {
      await page.goto(`${BASE_URL}/portfolios/${name}/`);
      await page.waitForLoadState('networkidle');

      const content = await page.evaluate(() => {
        const el = document.querySelector('article, .entry-content, .post-content, main');
        return el ? el.innerText : document.body.innerText;
      });

      // Skip if redirected to login/paywall
      if (page.url().includes('login') || content.includes('please login') || content.includes('subscribe')) {
        console.log(`  ${name}: paywalled`);
        continue;
      }

      portfolios.push({ name, content, url: page.url(), scrapedAt: new Date().toISOString() });
      console.log(`  ${name}: scraped`);
    } catch (e) {
      console.log(`  ${name}: error - ${e.message}`);
    }
  }

  // Also try the main portfolios page
  await page.goto(`${BASE_URL}/portfolios/`);
  await page.waitForLoadState('networkidle');
  const mainContent = await page.evaluate(() => {
    const el = document.querySelector('article, .entry-content, .post-content, main');
    return el ? el.innerText : document.body.innerText;
  });
  portfolios.push({ name: 'overview', content: mainContent, url: page.url(), scrapedAt: new Date().toISOString() });

  return portfolios;
}

async function scrapeTradeAlerts(page) {
  console.log('Scraping Trade Alerts / Samwise Portal...');
  const alerts = [];

  const alertUrls = [
    '/samwise-portal/',
    '/trade-alerts/',
    '/alerts/',
    '/strategy/',
  ];

  for (const path of alertUrls) {
    try {
      await page.goto(`${BASE_URL}${path}`);
      await page.waitForLoadState('networkidle');

      const content = await page.evaluate(() => {
        const el = document.querySelector('article, .entry-content, .post-content, main');
        return el ? el.innerText : document.body.innerText;
      });

      if (!page.url().includes('login')) {
        alerts.push({ path, content, url: page.url(), scrapedAt: new Date().toISOString() });
        console.log(`  ${path}: scraped`);
      }
    } catch (e) {
      console.log(`  ${path}: error - ${e.message}`);
    }
  }

  return alerts;
}

async function scrapeArticles(page) {
  console.log('Scraping recent Articles...');
  await page.goto(`${BASE_URL}/articles/`);
  await page.waitForLoadState('networkidle');

  // Get links to recent articles
  const articleLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links
      .map(a => ({ text: a.innerText.trim(), href: a.href }))
      .filter(l => l.href.includes('/articles/') && l.text.length > 10)
      .slice(0, 5);
  });

  const articles = [];
  for (const link of articleLinks) {
    try {
      await page.goto(link.href);
      await page.waitForLoadState('networkidle');
      const content = await page.evaluate(() => {
        const el = document.querySelector('article, .entry-content, .post-content');
        return el ? el.innerText : '';
      });
      if (content) articles.push({ title: link.text, url: link.href, content, scrapedAt: new Date().toISOString() });
    } catch (e) {
      console.log(`  Article error: ${e.message}`);
    }
  }

  return articles;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await login(page);

    const [briefing, portfolios, alerts, articles] = await Promise.all([
      scrapeDailyBriefing(page),
      scrapePortfolios(page),
      scrapeTradeAlerts(page),
      scrapeArticles(page),
    ]).catch(async () => {
      // If parallel fails (same page context), run sequentially
      const b = await scrapeDailyBriefing(page);
      const p = await scrapePortfolios(page);
      const a = await scrapeTradeAlerts(page);
      const ar = await scrapeArticles(page);
      return [b, p, a, ar];
    });

    const output = {
      scrapedAt: new Date().toISOString(),
      dailyBriefing: briefing,
      portfolios,
      tradeAlerts: alerts,
      articles,
    };

    const outPath = `${OUTPUT_DIR}/sam-weiss-${new Date().toISOString().split('T')[0]}.json`;
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nSaved to ${outPath}`);

  } finally {
    await browser.close();
  }
}

run().catch(console.error);
