import * as cheerio from 'cheerio';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const BASE_URL = 'https://www.iabilet.ro';
const CITY_PATH = '/bilete-in-cluj-napoca/';
const MAX_PAGES = 20;
const REQUEST_DELAY = 500;
const USER_AGENT = 'ClujTonight/1.0 (event aggregator)';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (res.status === 429) {
    console.warn(`Rate limited on ${url}, waiting 5s...`);
    await sleep(5000);
    const retry = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!retry.ok) return null;
    return retry.text();
  }
  if (!res.ok) return null;
  return res.text();
}

async function getEventUrls() {
  const allUrls = new Set();
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `${BASE_URL}${CITY_PATH}?page=${page}`;
    console.log(`Fetching listing page ${page}...`);

    const html = await fetchPage(url);
    if (!html) break;

    const $ = cheerio.load(html);
    const links = [];

    $('a[href*="/bilete-"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/bilete-') && !href.includes('bilete-in-') && !href.includes('bilete-la-')) {
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        links.push(fullUrl);
      }
    });

    if (links.length === 0) {
      console.log(`No event links on page ${page}, stopping.`);
      break;
    }

    const newUrls = links.filter(u => !allUrls.has(u));
    if (newUrls.length === 0) {
      console.log(`All duplicates on page ${page}, stopping.`);
      break;
    }

    newUrls.forEach(u => allUrls.add(u));
    console.log(`  Found ${newUrls.length} new event URLs (total: ${allUrls.size})`);

    page++;
    await sleep(REQUEST_DELAY);
  }

  return [...allUrls];
}

async function getEventDetails(eventUrl) {
  const html = await fetchPage(eventUrl);
  if (!html) return null;

  const $ = cheerio.load(html);
  let event = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html().replace(/\/\*<!\[CDATA\[\*\//, '').replace(/\/\*\]\]>\*\//, '').trim();
      const data = JSON.parse(raw);
      if (data['@type'] === 'Event' || data['@type']?.includes?.('Event')) {
        const startDate = data.startDate;

        event = {
          name: data.name || null,
          date: startDate || null,
          venue: data.location?.name || null,
          price: data.offers?.price?.toString() || data.offers?.[0]?.price?.toString() || null,
          currency: data.offers?.priceCurrency || data.offers?.[0]?.priceCurrency || 'RON',
          url: eventUrl
        };
      }
    } catch (e) {
      // Malformed JSON-LD, skip
    }
  });

  return event;
}

async function scrape() {
  console.log('Starting scrape for Cluj-Napoca events...\n');

  const urls = await getEventUrls();
  console.log(`\nFound ${urls.length} event URLs. Fetching details...\n`);

  const events = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`[${i + 1}/${urls.length}] ${url}`);

    try {
      const event = await getEventDetails(url);
      if (event && event.date) {
        events.push(event);
        console.log(`  ✓ ${event.name}`);
      } else {
        console.log(`  ✗ skipped (no valid data)`);
      }
    } catch (err) {
      console.warn(`  ✗ error fetching: ${err.message}`);
    }

    await sleep(REQUEST_DELAY);
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = events.filter(e => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(`\nScraped ${unique.length} valid events.`);

  if (unique.length === 0) {
    console.error('ERROR: Zero events scraped. Not overwriting existing data.');
    process.exit(1);
  }

  if (!existsSync('data')) mkdirSync('data');
  writeFileSync('data/events.json', JSON.stringify(unique, null, 2));
  console.log('Written to data/events.json');
}

scrape().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
