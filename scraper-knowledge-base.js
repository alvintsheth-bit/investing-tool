/**
 * Knowledge Base Scraper
 * Scrapes Sam Weiss deep research: strategy, historical analysis,
 * investing principles, all articles, 18 months of daily briefings with comments.
 * Run once initially, then weekly for updates.
 */

import { chromium } from 'playwright';
import { config } from 'dotenv';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '.env') });

const BASE_URL = 'https://sam-weiss.com';
const KB_DIR = join(__dirname, 'output/knowledge-base');
const MANIFEST_PATH = join(KB_DIR, 'manifest.json');

// Modes: full (one-time deep scrape), weekly (new content only), daily (fast dynamic pages only)
// Modes: full (one-time deep scrape), weekly (new content only), fix (deep pages + portfolios only)
const MODE = process.argv[2] || 'full';

// 18 months of weekday posts ≈ 390 posts
const MAX_BRIEFINGS = (MODE === 'full' || MODE === 'briefings') ? 600 : 10;

const REFRESH_RULES = {
  // page key → how many days before re-scraping (null = never re-scrape after first run)
  strategy:           null,
  'nasdaq-historical': null,
  'investing-basics':  null,
  'market-understanding': null,
  'market-outlook':    1,    // daily
  'trade-history':     1,    // daily
  'trade-watchlist':   3,    // every few days
  portfolios:          3,    // positions change when trades happen
  articles:            7,    // new articles weekly
  'historical-briefings': null, // already have 18 months, don't re-scrape
};

function needsRefresh(manifest, key) {
  if (MODE === 'full') return true;
  if (MODE === 'fix') return true; // fix mode always re-scrapes everything
  const maxAge = REFRESH_RULES[key];
  if (maxAge === null) return false;
  const lastScraped = manifest.scraped[key];
  if (!lastScraped) return true;
  const daysSince = (Date.now() - new Date(lastScraped).getTime()) / (1000 * 60 * 60 * 24);
  return daysSince >= maxAge;
}

mkdirSync(KB_DIR, { recursive: true });
mkdirSync(join(KB_DIR, 'articles'), { recursive: true });
mkdirSync(join(KB_DIR, 'stocks'), { recursive: true });
mkdirSync(join(KB_DIR, 'portfolios'), { recursive: true });
mkdirSync(join(KB_DIR, 'briefings'), { recursive: true });

function loadManifest() {
  if (existsSync(MANIFEST_PATH)) return JSON.parse(readFileSync(MANIFEST_PATH));
  return { scraped: {}, lastFullScrape: null };
}

function saveManifest(m) {
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

function slug(text) {
  return text.replace(/[^a-z0-9-_]/gi, '-').toLowerCase().replace(/-+/g, '-').slice(0, 80);
}

function saveMarkdown(dir, filename, title, url, content) {
  const path = join(dir, `${slug(filename)}.md`);
  const md = `# ${title}\n\nSource: ${url}\nScraped: ${new Date().toISOString()}\n\n---\n\n${content}`;
  writeFileSync(path, md);
  console.log(`  Saved: ${path.replace(__dirname, '.')} (${content.length.toLocaleString()} chars)`);
  return path;
}

async function login(page) {
  await page.goto(`${BASE_URL}/login/`, { timeout: 60000 });
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
}

async function expandAccordions(page) {
  let count = 0;

  // Click "click to expand" text links (Sam Weiss uses this pattern)
  const expandTexts = await page.locator('text=/click to expand/i').all();
  for (const el of expandTexts) {
    try { await el.click({ timeout: 1500 }); count++; await page.waitForTimeout(400); } catch {}
  }

  // Click standard accordion/collapse toggles
  const toggleSelectors = [
    '[data-toggle="collapse"]', '[aria-expanded="false"]',
    '.accordion-toggle', 'summary', 'details:not([open])',
  ];
  const toggles = await page.locator(toggleSelectors.join(', ')).all();
  for (const el of toggles) {
    try { await el.click({ timeout: 1500 }); count++; await page.waitForTimeout(200); } catch {}
  }

  // Force <details> elements open
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
  });

  if (count > 0) await page.waitForTimeout(500); // let animations settle
  return count;
}

async function extractContent(page) {
  if (page.url().includes('/app/')) {
    await page.waitForTimeout(2000);
  }

  return page.evaluate(() => {
    // Preferred: actual post/page content container (excludes admin bar, nav, sidebar)
    const el = document.querySelector('.entry-content') ||
               document.querySelector('.post-content') ||
               document.querySelector('.page-content') ||
               document.querySelector('article .content') ||
               document.querySelector('article');
    if (el) return el.innerText.trim();

    // Last resort: site content area (not body or main, which include #wpadminbar)
    const site = document.querySelector('.site-content') ||
                 document.querySelector('#content') ||
                 document.querySelector('#primary');
    return site ? site.innerText.trim() : '';
  });
}

async function extractComments(page) {
  return page.evaluate(() => {
    const comments = [];
    const commentEls = document.querySelectorAll(
      '.comment, .comment-body, article.comment, li.comment, .wp-comment'
    );
    commentEls.forEach(el => {
      const author = el.querySelector('.comment-author, .fn, .author')?.innerText?.trim() || 'Unknown';
      const date = el.querySelector('.comment-date, .comment-metadata time, time')?.innerText?.trim() || '';
      const body = el.querySelector('.comment-content, .comment-text, p')?.innerText?.trim() || el.innerText.trim();
      if (body && body.length > 10) {
        comments.push({ author, date, body });
      }
    });
    return comments;
  });
}

function humanDelay() {
  // Random 3-8 second delay between pages — looks like a human reading
  const ms = 3000 + Math.random() * 5000;
  return new Promise(r => setTimeout(r, ms));
}

async function scrapePage(page, url, label, includeComments = false, attempt = 1) {
  await humanDelay();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
    if (page.url().includes('login')) { console.log(`  ${label}: needs login`); return null; }
    await page.waitForTimeout(300);

    const content = await extractContent(page);
    if (!content || content.length < 150) { console.log(`  ${label}: empty`); return null; }

    let comments = [];
    if (includeComments) comments = await extractComments(page);

    console.log(`  ${label}: ${content.length.toLocaleString()} chars${comments.length ? `, ${comments.length} comments` : ''}`);
    return { url, content, comments };
  } catch (e) {
    const msg = e.message.split('\n')[0];
    if (attempt === 1 && msg.includes('Execution context was destroyed')) {
      console.log(`  ${label}: retrying...`);
      // Navigate away to reset state before retry
      await page.goto(`${BASE_URL}/blog-2/`, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      return scrapePage(page, url, label, includeComments, 2);
    }
    console.log(`  ${label}: error — ${msg}`);
    return null;
  }
}

function formatBriefingMarkdown(title, url, content, comments) {
  let md = content;
  if (comments.length > 0) {
    md += '\n\n---\n\n## COMMENTS\n\n';
    md += comments.map(c => `**${c.author}** (${c.date}):\n${c.body}`).join('\n\n---\n\n');
  }
  return md;
}

async function getPostLinks(page, indexUrl) {
  try {
    await page.goto(indexUrl, { waitUntil: 'networkidle', timeout: 30000 });
    const links = await page.evaluate((base) => {
      const seen = new Set();
      return Array.from(document.querySelectorAll('article a, h1 a, h2 a, h3 a, .entry-title a'))
        .map(a => ({ text: a.innerText.trim().replace(/\s+/g, ' '), href: a.href.split('#')[0] }))
        .filter(l => {
          if (!l.href.startsWith(base)) return false;
          if (l.text.length < 10) return false;  // skip "7 Comments", "Next", etc.
          if (/^\d+\s+comments?$/i.test(l.text)) return false;  // skip "25 Comments" links
          if (seen.has(l.href)) return false;
          seen.add(l.href);
          return true;
        });
    }, BASE_URL);
    // Check multiple pagination patterns WordPress blogs use
    const hasNext = (await page.locator([
      'a.next', 'a[rel="next"]', '.next a',
      'a:has-text("Older")', 'a:has-text("older")',
      'a:has-text("Previous Posts")', 'a:has-text("Next Page")',
      '.nav-previous a', '.pagination a:has-text("Next")',
    ].join(', ')).count()) > 0;
    return { links, hasNext };
  } catch {
    return { links: [], hasNext: false };
  }
}

// ─── 18 months of daily briefings + comments ─────────────────────────────────
async function scrapeBriefings(page) {
  console.log(`\n[Briefings] Scraping up to ${MAX_BRIEFINGS} posts with comments (18 months)...`);
  let scraped = parseInt(process.env.BRIEFING_RESUME_COUNT || '0');
  let pageNum = parseInt(process.env.BRIEFING_RESUME_PAGE || '1');

  while (scraped < MAX_BRIEFINGS) {
    const indexUrl = pageNum === 1 ? `${BASE_URL}/blog-2/` : `${BASE_URL}/blog-2/page/${pageNum}/`;
    console.log(`\n  Index page ${pageNum}: ${indexUrl}`);

    const { links, hasNext } = await getPostLinks(page, indexUrl);
    if (!links.length) break;

    for (const link of links) {
      if (scraped >= MAX_BRIEFINGS) break;
      const result = await scrapePage(page, link.href, link.text.slice(0, 60), true);
      if (!result) continue;
      const filename = `${String(scraped + 1).padStart(4, '0')}-${link.text}`;
      const fullContent = formatBriefingMarkdown(link.text, link.href, result.content, result.comments);
      saveMarkdown(join(KB_DIR, 'briefings'), filename, link.text, link.href, fullContent);
      scraped++;
    }

    if (!hasNext) {
      // Try next page directly — pagination detection sometimes misses it
      const nextUrl = `${BASE_URL}/blog-2/page/${pageNum + 1}/`;
      try {
        await page.goto(nextUrl, { waitUntil: 'networkidle', timeout: 15000 });
        const testLinks = await page.locator('article a, h2 a, .entry-title a').count();
        if (testLinks === 0) break; // truly no more pages
        // There are posts — pagination detection was wrong, continue
      } catch {
        break;
      }
    }
    pageNum++;
  }

  console.log(`\n  Briefings scraped: ${scraped}`);
  return scraped;
}

async function scrapeArticles(page) {
  console.log('\n[Articles] Scraping all articles with comments...');
  let count = 0;
  let pageNum = 1;

  while (true) {
    const indexUrl = pageNum === 1 ? `${BASE_URL}/category/articles/` : `${BASE_URL}/category/articles/page/${pageNum}/`;
    const { links, hasNext } = await getPostLinks(page, indexUrl);
    if (!links.length) break;

    console.log(`  Articles page ${pageNum}: ${links.length} found`);
    for (const link of links) {
      const result = await scrapePage(page, link.href, link.text.slice(0, 60), true);
      if (!result) continue;
      const filename = `${String(++count).padStart(3, '0')}-${link.text}`;
      const fullContent = formatBriefingMarkdown(link.text, link.href, result.content, result.comments);
      saveMarkdown(join(KB_DIR, 'articles'), filename, link.text, link.href, fullContent);
    }

    if (!hasNext) break;
    pageNum++;
  }

  console.log(`  Articles scraped: ${count}`);
  return count;
}

async function scrapeUnderstandingMarket(page) {
  await humanDelay();
  await page.goto(`${BASE_URL}/understanding-the-stock-market/`, { waitUntil: 'networkidle', timeout: 35000 });
  if (page.url().includes('login')) return null;

  const chapterCount = await page.locator('a:has-text("READ MORE"), button:has-text("READ MORE"), a:has-text("Read More"), .read-more').count();
  console.log(`  Understanding the Market: found ${chapterCount} chapters`);

  let allContent = '';

  for (let i = 0; i < chapterCount; i++) {
    try {
      await page.goto(`${BASE_URL}/understanding-the-stock-market/`, { waitUntil: 'networkidle', timeout: 35000 });
      await page.waitForTimeout(400);

      const readMores = await page.locator('a:has-text("READ MORE"), button:has-text("READ MORE"), a:has-text("Read More"), .read-more').all();
      if (i >= readMores.length) break;

      await readMores[i].click({ timeout: 2000 });
      await page.waitForTimeout(800);

      let slideNum = 1;
      let seenUrls = new Set();
      let consecutiveEmpty = 0;

      while (slideNum <= 20) {
        const currentUrl = page.url();
        if (seenUrls.has(currentUrl)) break;
        seenUrls.add(currentUrl);

        const slideContent = await extractContent(page);
        if (slideContent && slideContent.length > 100) {
          allContent += `\n\n--- Chapter ${i + 1}, Slide ${slideNum} ---\n\n` + slideContent;
          console.log(`    Chapter ${i + 1} slide ${slideNum}: ${slideContent.length.toLocaleString()} chars`);
          consecutiveEmpty = 0;
        } else {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break;
        }

        const nextHref = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, button'));
          const next = candidates.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toUpperCase().replace(/\s+/g, ' ');
            const cls = (el.className || '').toLowerCase();
            return t.includes('NEXT SLIDE') || t.includes('NEXT PAGE') ||
                   (t === 'NEXT' && el.tagName === 'A') ||
                   cls.includes('next-slide') || cls.includes('slide-next') ||
                   el.getAttribute('rel') === 'next';
          });
          return next ? (next.href || '__click__') : null;
        });

        if (!nextHref) {
          const curUrl = page.url().replace(/\/$/, '').replace(/-\d+$/, '');
          const guessUrl = `${curUrl}-${slideNum + 1}/`;
          await page.goto(guessUrl, { waitUntil: 'networkidle', timeout: 20000 });
          if (!page.url().includes('sam-weiss.com')) break;
        } else if (nextHref === '__click__') {
          await page.locator('button').filter({ hasText: /next/i }).first().click({ timeout: 2000 });
        } else {
          await page.goto(nextHref, { waitUntil: 'networkidle', timeout: 30000 });
        }

        await page.waitForTimeout(700);
        if (!page.url().includes('sam-weiss.com')) break;
        slideNum++;
      }
    } catch (e) {
      console.log(`  Chapter ${i + 1}: error — ${e.message.split('\n')[0]}`);
    }
  }

  const result = allContent.trim();
  console.log(`  Understanding the Market total: ${result.length.toLocaleString()} chars`);
  return result || null;
}

async function scrapeMarketOutlook(page) {
  await humanDelay();
  await page.goto(`${BASE_URL}/the-current-outlook/`, { waitUntil: 'networkidle', timeout: 35000 });
  if (page.url().includes('login')) return null;

  // Only click <summary> and <button> toggles (not <a> links which may navigate)
  let expanded = 0;
  const safeToggleSelectors = ['summary', 'button[aria-expanded="false"]', 'button.accordion-toggle'];
  for (const sel of safeToggleSelectors) {
    const els = await page.locator(sel).all();
    for (const el of els) {
      try { await el.click({ timeout: 1500 }); expanded++; await page.waitForTimeout(300); } catch {}
    }
  }

  // Force all hidden content visible via DOM manipulation (no navigation risk)
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => { d.open = true; });
    document.querySelectorAll('[aria-hidden="true"]').forEach(el => el.removeAttribute('aria-hidden'));
    document.querySelectorAll('.collapse:not(.show)').forEach(el => el.classList.add('show'));
    // Show elements hidden via inline style
    document.querySelectorAll('.entry-content *').forEach(el => {
      const s = el.style;
      if (s.display === 'none') s.display = '';
      if (s.visibility === 'hidden') s.visibility = '';
      if (s.height === '0px' || s.maxHeight === '0px') {
        s.height = 'auto';
        s.maxHeight = 'none';
        s.overflow = 'visible';
      }
    });
  });

  await page.waitForTimeout(1000);
  const content = await extractContent(page);
  console.log(`  Market Outlook: ${content.length.toLocaleString()} chars (${expanded} safe toggles clicked)`);
  return content;
}

async function scrapeStrategy(page) {
  await humanDelay();
  await page.goto(`${BASE_URL}/samwise/samwise-strategies/`, { waitUntil: 'networkidle', timeout: 35000 });
  if (page.url().includes('login')) return null;

  let fullContent = '';

  // Click each tab and collect content from each
  const tabSelectors = [
    'a:has-text("EXECUTIVE SUMMARY")', 'a:has-text("4-PART FRAMEWORK")',
    'a:has-text("HIGH-PRO STRATEGY")', 'a:has-text("SAMWISE RULE")',
    'li:has-text("EXECUTIVE SUMMARY")', 'li:has-text("4-PART FRAMEWORK")',
  ];

  // First collect current visible content
  await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
  await page.waitForTimeout(500);

  // Click through each tab
  for (const sel of tabSelectors) {
    const tabs = await page.locator(sel).all();
    for (const tab of tabs) {
      try {
        const tagName = await tab.evaluate(el => el.tagName.toLowerCase());
        const href = await tab.evaluate(el => el.href || '');
        // Only click if it's an in-page link (anchor) or tab UI element, not a full navigation
        if (!href || href.includes('#') || href.includes(BASE_URL + '/samwise/samwise-strategies')) {
          await tab.click({ timeout: 2000 });
          await page.waitForTimeout(800);
          await page.evaluate(() => { document.querySelectorAll('details').forEach(d => { d.open = true; }); });
          const snippet = await extractContent(page);
          if (snippet && !fullContent.includes(snippet.slice(0, 100))) {
            fullContent += '\n\n' + snippet;
          }
        }
      } catch {}
    }
  }

  // Final pass — expand any remaining "click to expand" within the entry-content only
  const expandables = await page.locator('.entry-content').getByText(/click to expand/i).all();
  for (const el of expandables) {
    try { await el.click({ timeout: 1500 }); await page.waitForTimeout(400); } catch {}
  }
  await page.waitForTimeout(500);
  const finalContent = await extractContent(page);
  if (finalContent && !fullContent.includes(finalContent.slice(0, 100))) {
    fullContent += '\n\n' + finalContent;
  }

  const result = fullContent.trim() || finalContent;
  console.log(`  Strategy: ${result.length.toLocaleString()} chars (with tabs expanded)`);
  return result;
}

async function scrapeInvestingBasics(page) {
  await humanDelay();
  await page.goto(`${BASE_URL}/investing-basics/`, { waitUntil: 'networkidle', timeout: 35000 });
  if (page.url().includes('login')) return null;

  // Count chapters from the main page first
  const chapterCount = await page.locator('a:has-text("READ MORE"), button:has-text("READ MORE"), a:has-text("Read More"), .read-more').count();
  console.log(`  Investing Basics: found ${chapterCount} chapters`);

  let allContent = '';

  for (let i = 0; i < chapterCount; i++) {
    try {
      // Always re-navigate to base page to get fresh handles
      await page.goto(`${BASE_URL}/investing-basics/`, { waitUntil: 'networkidle', timeout: 35000 });
      await page.waitForTimeout(400);

      const readMores = await page.locator('a:has-text("READ MORE"), button:has-text("READ MORE"), a:has-text("Read More"), .read-more').all();
      if (i >= readMores.length) break;

      await readMores[i].click({ timeout: 2000 });
      await page.waitForTimeout(800);

      // Paginate through all slides in this chapter
      let slideNum = 1;
      let seenUrls = new Set();
      let consecutiveEmpty = 0;

      while (slideNum <= 20) {
        const currentUrl = page.url();
        if (seenUrls.has(currentUrl)) break; // loop detected
        seenUrls.add(currentUrl);

        const slideContent = await extractContent(page);
        if (slideContent && slideContent.length > 100) {
          allContent += `\n\n--- Chapter ${i + 1}, Slide ${slideNum} ---\n\n` + slideContent;
          console.log(`    Chapter ${i + 1} slide ${slideNum}: ${slideContent.length.toLocaleString()} chars`);
          consecutiveEmpty = 0;
        } else {
          consecutiveEmpty++;
          if (consecutiveEmpty >= 2) break; // stop after 2 empty slides in a row
        }

        // Detect next-slide navigation — check button text loosely, then fall back to URL pattern
        const nextHref = await page.evaluate(() => {
          const candidates = Array.from(document.querySelectorAll('a, button'));
          const next = candidates.find(el => {
            const t = (el.innerText || el.textContent || '').trim().toUpperCase().replace(/\s+/g, ' ');
            const cls = (el.className || '').toLowerCase();
            return t.includes('NEXT SLIDE') || t.includes('NEXT PAGE') ||
                   (t === 'NEXT' && el.tagName === 'A') ||
                   cls.includes('next-slide') || cls.includes('slide-next') ||
                   cls.includes('nav-next') || el.getAttribute('rel') === 'next';
          });
          if (next) return next.href || next.getAttribute('data-href') || '__click__';

          // Debug: return all links with "next" in text so we can see what's available
          const debug = candidates
            .filter(el => (el.innerText || el.textContent || '').toLowerCase().includes('next'))
            .map(el => `[${el.tagName}] "${(el.innerText||'').trim().slice(0,30)}" href=${el.href||'none'}`);
          return debug.length ? '__debug__:' + debug.join(' | ') : null;
        });

        if (nextHref && nextHref.startsWith('__debug__:')) {
          console.log(`    Chapter ${i + 1} slide ${slideNum}: debug="${nextHref}"`);
        } else {
          console.log(`    Chapter ${i + 1} slide ${slideNum}: next="${nextHref}"`);
        }

        if (!nextHref || nextHref.startsWith('__debug__:')) {
          // URL pattern fallback: try appending -2, -3 etc. to current slug
          const curUrl = page.url().replace(/\/$/, '');
          // Remove any existing trailing number (-2, -3...)
          const baseUrl = curUrl.replace(/-\d+$/, '');
          const nextNum = slideNum + 1;
          const guessUrl = `${baseUrl}-${nextNum}/`;
          console.log(`    Chapter ${i + 1} slide ${slideNum}: trying URL guess ${guessUrl}`);
          await page.goto(guessUrl, { waitUntil: 'networkidle', timeout: 20000 });
          // If we got redirected to a non-investing-basics page, stop
          if (!page.url().includes('investing-basics') && !page.url().includes('sam-weiss.com/chapter')) break;
        } else if (nextHref === '__click__') {
          const btn = page.locator('button').filter({ hasText: /next/i }).first();
          await btn.click({ timeout: 2000 });
        } else {
          await page.goto(nextHref, { waitUntil: 'networkidle', timeout: 30000 });
        }
        await page.waitForTimeout(700);

        if (!page.url().includes('sam-weiss.com')) break;
        slideNum++;
      }
    } catch (e) {
      console.log(`  Chapter ${i + 1}: error — ${e.message.split('\n')[0]}`);
    }
  }

  const result = allContent.trim();
  console.log(`  Investing Basics total: ${result.length.toLocaleString()} chars`);
  return result || null;
}

async function scrapeDeepPages(page, manifest) {
  console.log('\n[Deep Research] Scraping foundational content...');
  const pages = [
    { url: `${BASE_URL}/samwise/samwise-strategies/`,          label: 'Samwise Strategy',        file: 'strategy' },
    { url: `${BASE_URL}/the-current-outlook/`,                 label: 'Current Market Outlook',   file: 'market-outlook' },
    { url: `${BASE_URL}/nasdaq-100-qqq-corrections-rallies/`,  label: 'NASDAQ Historical Tables', file: 'nasdaq-historical' },
    { url: `${BASE_URL}/app/trade-watch/`,                     label: 'Trade Watchlist',          file: 'trade-watchlist' },
    { url: `${BASE_URL}/app/trades/`,                          label: 'Full Trade History',       file: 'trade-history' },
    { url: `${BASE_URL}/understanding-the-stock-market/`,      label: 'Understanding the Market', file: 'market-understanding' },
  ];

  for (const p of pages) {
    if (!needsRefresh(manifest, p.file)) {
      console.log(`  ${p.label}: skipping (static, already scraped)`);
      continue;
    }
    const result = await scrapePage(page, p.url, p.label);
    if (result) {
      saveMarkdown(KB_DIR, p.file, p.label, p.url, result.content);
      manifest.scraped[p.file] = new Date().toISOString();
    }
  }

  // Investing basics needs special accordion handling
  if (needsRefresh(manifest, 'investing-basics')) {
    const content = await scrapeInvestingBasics(page);
    if (content && content.length > 500) {
      saveMarkdown(KB_DIR, 'investing-basics', 'Core Investing Principles', `${BASE_URL}/investing-basics/`, content);
      manifest.scraped['investing-basics'] = new Date().toISOString();
    }
  }
}

async function scrapePortfolios(page) {
  console.log('\n[Portfolios] Scraping all portfolio pages...');

  // Scrape the overview tab first (consolidated view of all portfolios)
  const overviewUrl = `${BASE_URL}/samwise/samwise-portfolio/`;
  await humanDelay();
  try {
    await page.goto(overviewUrl, { waitUntil: 'networkidle', timeout: 35000 });
    if (!page.url().includes('login')) {
      await page.evaluate(() => {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
        document.querySelectorAll('.collapse:not(.show)').forEach(el => el.classList.add('show'));
        document.querySelectorAll('.entry-content *').forEach(el => {
          const s = el.style;
          if (s.display === 'none') s.display = '';
          if (s.height === '0px' || s.maxHeight === '0px') { s.height = 'auto'; s.maxHeight = 'none'; }
        });
      });
      await page.waitForTimeout(800);
      const content = await extractContent(page);
      if (content && content.length > 150) {
        saveMarkdown(KB_DIR, 'portfolio-overview', 'Portfolio Overview', overviewUrl, content);
      }
    }
  } catch (e) {
    console.log(`  overview: error — ${e.message.split('\n')[0]}`);
  }

  const names = ['targaryen', 'baratheon', 'lannister', 'tyrell', 'arryn', 'tarly', 'stark', 'frey', 'hightower'];
  for (const name of names) {
    const url = `${BASE_URL}/samwise/samwise-portfolio/${name}-portfolio/`;
    await humanDelay();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 35000 });
      if (page.url().includes('login')) { console.log(`  ${name}: needs login`); continue; }

      // Expand all dropdowns via DOM manipulation only (no link clicks)
      await page.evaluate(() => {
        document.querySelectorAll('details').forEach(d => { d.open = true; });
        document.querySelectorAll('[aria-hidden="true"]').forEach(el => el.removeAttribute('aria-hidden'));
        document.querySelectorAll('.collapse:not(.show)').forEach(el => el.classList.add('show'));
        document.querySelectorAll('.entry-content *').forEach(el => {
          const s = el.style;
          if (s.display === 'none') s.display = '';
          if (s.visibility === 'hidden') s.visibility = '';
          if (s.height === '0px' || s.maxHeight === '0px') {
            s.height = 'auto'; s.maxHeight = 'none'; s.overflow = 'visible';
          }
        });
      });

      // Also click safe toggles (summary, buttons only — no <a> links)
      for (const sel of ['summary', 'button[aria-expanded="false"]']) {
        const els = await page.locator(sel).all();
        for (const el of els) {
          try { await el.click({ timeout: 1500 }); await page.waitForTimeout(200); } catch {}
        }
      }

      await page.waitForTimeout(800);
      const content = await extractContent(page);
      if (content && content.length > 150) {
        saveMarkdown(join(KB_DIR, 'portfolios'), name, `${name} Portfolio`, url, content);
      } else {
        console.log(`  ${name}: empty`);
      }
    } catch (e) {
      console.log(`  ${name}: error — ${e.message.split('\n')[0]}`);
    }
  }
}

async function scrapeStocks(page) {
  console.log('\n[Stocks] Scraping stock research pages...');
  const stockUrls = [
    { url: `${BASE_URL}/nvidia/`, ticker: 'NVDA' },
    { url: `${BASE_URL}/apple-aapl/`, ticker: 'AAPL' },
  ];

  const { links } = await getPostLinks(page, `${BASE_URL}/services/`);
  for (const l of links) {
    if (!l.href.includes('samwise') && !l.href.includes('login') && !l.href.includes('category')) {
      stockUrls.push({ url: l.href, ticker: l.text });
    }
  }

  for (const s of stockUrls) {
    const result = await scrapePage(page, s.url, s.ticker);
    if (result && result.content.length > 300) {
      saveMarkdown(join(KB_DIR, 'stocks'), s.ticker, `${s.ticker} Research`, s.url, result.content);
    }
  }
}

async function run() {
  const manifest = loadManifest();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const startTime = Date.now();

  const page = await context.newPage();

  try {
    console.log(`\nMode: ${MODE.toUpperCase()}\n`);
    await login(page);

    if (MODE === 'understanding') {
      const content = await scrapeUnderstandingMarket(page);
      if (content && content.length > 500) {
        saveMarkdown(KB_DIR, 'market-understanding', 'Understanding the Stock Market', `${BASE_URL}/understanding-the-stock-market/`, content);
      }
      manifest.lastFullScrape = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE === 'portfolios') {
      await scrapePortfolios(page);
      manifest.scraped['portfolios'] = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE === 'outlook') {
      const content = await scrapeMarketOutlook(page);
      if (content && content.length > 500) {
        saveMarkdown(KB_DIR, 'market-outlook', 'Current Market Outlook', `${BASE_URL}/the-current-outlook/`, content);
      }
      manifest.lastFullScrape = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE === 'basics') {
      const content = await scrapeInvestingBasics(page);
      if (content && content.length > 500) {
        saveMarkdown(KB_DIR, 'investing-basics', 'Core Investing Principles', `${BASE_URL}/investing-basics/`, content);
      }
      manifest.lastFullScrape = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE === 'strategy') {
      const content = await scrapeStrategy(page);
      if (content && content.length > 500) {
        saveMarkdown(KB_DIR, 'strategy', 'Samwise Strategy', `${BASE_URL}/samwise/samwise-strategies/`, content);
      }
      manifest.lastFullScrape = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE === 'articles') {
      await scrapeStocks(page);
      await scrapeArticles(page);
      // Retry Understanding the Market which timed out before
      const umResult = await scrapePage(page, `${BASE_URL}/understanding-the-stock-market/`, 'Understanding the Market');
      if (umResult) saveMarkdown(KB_DIR, 'market-understanding', 'Understanding the Market', `${BASE_URL}/understanding-the-stock-market/`, umResult.content);
      manifest.lastFullScrape = new Date().toISOString();
      saveManifest(manifest);
      await browser.close();
      return;
    }

    if (MODE !== 'briefings') {
      if (needsRefresh(manifest, 'strategy') || needsRefresh(manifest, 'nasdaq-historical')) {
        await scrapeDeepPages(page, manifest);
      } else {
        console.log('\n[Deep Research] Skipping — static content already scraped.');
      }

      if (needsRefresh(manifest, 'portfolios')) {
        await scrapePortfolios(page);
        manifest.scraped['portfolios'] = new Date().toISOString();
      } else {
        console.log('\n[Portfolios] Skipping — scraped within last 3 days.');
      }

      if (needsRefresh(manifest, 'articles')) {
        await scrapeStocks(page);
        await scrapeArticles(page);
        manifest.scraped['articles'] = new Date().toISOString();
      } else {
        console.log('\n[Articles/Stocks] Skipping — scraped within last 7 days.');
      }
    } else {
      console.log('\n[Deep Research / Portfolios / Articles] Skipping — briefings-only mode.');
    }

    if (MODE !== 'fix') {
      await scrapeBriefings(page);
      manifest.scraped['historical-briefings'] = new Date().toISOString();
    } else {
      console.log('\n[Briefings] Skipping — fix mode only updates deep pages + portfolios.');
    }

    // briefings-only mode exits here — deep pages and portfolios were skipped above

    manifest.lastFullScrape = new Date().toISOString();
    saveManifest(manifest);

    const elapsed = Math.round((Date.now() - startTime) / 1000 / 60);
    const fileCount = execSync(`find "${KB_DIR}" -name "*.md" | wc -l`).toString().trim();
    const size = execSync(`du -sh "${KB_DIR}"`).toString().trim().split('\t')[0];

    console.log('\n' + '═'.repeat(60));
    console.log('KNOWLEDGE BASE COMPLETE');
    console.log(`  Files: ${fileCount} markdown files`);
    console.log(`  Size:  ${size}`);
    console.log(`  Time:  ${elapsed} minutes`);
    console.log(`  Path:  ${KB_DIR}`);
    console.log('═'.repeat(60));

  } finally {
    await browser.close();
  }
}

run().catch(console.error);
