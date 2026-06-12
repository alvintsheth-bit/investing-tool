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

  const submitSelectors = ['#wp-submit', 'input[type="submit"]', 'button[type="submit"]', '.login-submit button'];
  for (const sel of submitSelectors) {
    if (await page.locator(sel).count() > 0) {
      await page.click(sel);
      break;
    }
  }

  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: './screenshots/after-login.png' });
  console.log(`Logged in. URL: ${page.url()}`);
}

async function discoverLinks(page) {
  console.log('\nDiscovering site structure...');
  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  const links = await page.evaluate((base) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.innerText.trim().replace(/\s+/g, ' '), href: a.href }))
      .filter(l => l.href.startsWith(base) && l.text.length > 0)
      .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i); // dedupe
  }, BASE_URL);

  console.log('Navigation links found:');
  links.forEach(l => console.log(`  ${l.text}: ${l.href}`));
  return links;
}

async function scrapePage(page, url, label) {
  console.log(`\nScraping ${label}...`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.screenshot({ path: `./screenshots/${label.replace(/\//g, '-')}.png` });

    const result = await page.evaluate(() => {
      // Try to get main content
      const selectors = ['article', '.entry-content', '.post-content', '.page-content', 'main .content', 'main'];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.length > 100) return el.innerText.trim();
      }
      return document.body.innerText.trim();
    });

    const isPaywalled = result.toLowerCase().includes('please login') ||
                        result.toLowerCase().includes('subscribe to continue') ||
                        page.url().includes('login');

    if (isPaywalled) {
      console.log(`  ${label}: paywalled`);
      return null;
    }

    console.log(`  ${label}: ${result.length} chars`);
    return { label, url: page.url(), content: result, scrapedAt: new Date().toISOString() };
  } catch (e) {
    console.log(`  ${label}: error - ${e.message.split('\n')[0]}`);
    return null;
  }
}

async function scrapePortfolios(page, allLinks) {
  // Find portfolio links from navigation
  const portfolioLinks = allLinks.filter(l =>
    l.href.includes('portfolio') || l.href.includes('house') ||
    ['targaryen','baratheon','lannister','tyrell','arryn','tarly','stark','frey','hightower'].some(n => l.href.toLowerCase().includes(n))
  );

  // Also try the portfolios index page
  await page.goto(`${BASE_URL}/portfolios/`, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  const portfolioIndexLinks = await page.evaluate((base) => {
    return Array.from(document.querySelectorAll('a[href]'))
      .map(a => ({ text: a.innerText.trim(), href: a.href }))
      .filter(l => l.href.startsWith(base))
      .filter((l, i, arr) => arr.findIndex(x => x.href === l.href) === i);
  }, BASE_URL).catch(() => []);

  const allPortfolioLinks = [...new Map([...portfolioLinks, ...portfolioIndexLinks].map(l => [l.href, l])).values()];
  console.log(`\nPortfolio links found: ${allPortfolioLinks.length}`);
  allPortfolioLinks.forEach(l => console.log(`  ${l.text}: ${l.href}`));

  const results = [];
  for (const link of allPortfolioLinks.slice(0, 10)) {
    const data = await scrapePage(page, link.href, link.text || link.href);
    if (data) results.push(data);
  }
  return results;
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  try {
    await login(page);

    // Discover all links while logged in
    const allLinks = await discoverLinks(page);

    // Get latest daily briefing post (click into it from blog index)
    await page.goto(`${BASE_URL}/blog-2/`, { waitUntil: 'networkidle', timeout: 30000 });
    const latestPostLink = await page.evaluate(() => {
      const a = document.querySelector('article a, h2 a, h1 a, .entry-title a');
      return a ? a.href : null;
    });
    if (latestPostLink) {
      console.log(`Latest briefing post: ${latestPostLink}`);
    }

    // Key pages to scrape
    const targetPages = [
      { url: latestPostLink || `${BASE_URL}/blog-2/`, label: 'daily-briefing-latest' },
      { url: `${BASE_URL}/app/trades/`, label: 'trades' },
      { url: `${BASE_URL}/app/trade-watch/`, label: 'trade-watch' },
      { url: `${BASE_URL}/the-current-outlook/`, label: 'market-outlook' },
      { url: `${BASE_URL}/samwise/samwise-strategies/`, label: 'strategy' },
      { url: `${BASE_URL}/nasdaq-100-qqq-corrections-rallies/`, label: 'nasdaq-tables' },
    ];

    const pages = [];
    for (const target of targetPages) {
      const data = await scrapePage(page, target.url, target.label);
      if (data) pages.push(data);
    }

    // Scrape portfolios
    const portfolios = await scrapePortfolios(page, allLinks);

    // Scrape recent articles (up to 5)
    const articleLinks = allLinks.filter(l => l.href.includes('/category/articles/') || (l.href.includes('sam-weiss.com') && l.text.length > 15 && l.href.includes('2026'))).slice(0, 5);
    const articles = [];
    for (const link of articleLinks) {
      const data = await scrapePage(page, link.href, `article-${link.text.slice(0, 30)}`);
      if (data) articles.push(data);
    }

    const output = {
      scrapedAt: new Date().toISOString(),
      pages,
      portfolios,
      articles,
      discoveredLinks: allLinks,
    };

    const outPath = `${OUTPUT_DIR}/sam-weiss-${new Date().toISOString().split('T')[0]}.json`;
    writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nSaved to ${outPath}`);
    console.log(`Pages scraped: ${pages.length}, Portfolios: ${portfolios.length}, Articles: ${articles.length}`);

  } finally {
    await browser.close();
  }
}

run().catch(console.error);
