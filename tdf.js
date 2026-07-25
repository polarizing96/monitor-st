// TDF (Theatre Development Fund) Broadway monitor.
//
// TDF's member store runs on Salesforce B2C Commerce and is LOGIN-GATED, so
// unlike FLC we can't just hit a public API — we drive a real browser to log in
// (the login is a JS SPA), then do an in-page fetch of the catalog API with the
// authenticated session and filter to Broadway shows.
//
// "New showtime" analog = a new Broadway / Off-Broadway show in the member catalog.

// Which Performance_Type__c values to watch.
const WATCH_TYPES = ['Broadway', 'Off Broadway'];

import { chromium } from 'playwright';

const LOGIN_URL = 'https://members.tdf.org/store/login';
const STORE_ID = '0ZEfK000000qcIvWAI'; // webstore id
const CATEGORY_ID = '0ZGPe0000000AtpOAE'; // "Productions" category (all shows)

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Log in and return all watched shows (Broadway + Off-Broadway) as rows.
 * @returns {Array<{id,date,dt,movie,format,type,status,url}>}
 */
export async function fetchTdfShows({ username, password, headless = true }, log = console.log) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'America/New_York' });
    const page = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The SPA login renders Username/Password textboxes + a "Log In" button.
    await page.getByLabel('Username').waitFor({ timeout: 25_000 });
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log In' }).click();

    // Logged in when we land back on the store (offers) and it's no longer /login.
    await page.waitForFunction(() => !/\/login/.test(location.pathname), null, { timeout: 30_000 });
    await page.waitForTimeout(2500); // let the session settle
    log('[tdf] logged in');

    const products = await page.evaluate(
      async ({ store, category }) => {
        const fields = encodeURIComponent('Id,Name,Venue_Name__c,StockKeepingUnit,Performance_Type__c');
        const out = [];
        for (let p = 0; p < 5; p++) {
          const url = `/store/webruntime/api/services/data/v67.0/commerce/webstores/${store}/search/products?categoryId=${category}&fields=${fields}&page=${p}&pageSize=200&language=en-US&asGuest=false&htmlEncode=false`;
          const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
          if (!r.ok) break;
          const j = await r.json();
          const prods = j.productsPage?.products || [];
          for (const x of prods) {
            out.push({
              id: x.id,
              name: x.name,
              sku: x.fields?.StockKeepingUnit?.value || null,
              venue: x.fields?.Venue_Name__c?.value || null,
              type: x.fields?.Performance_Type__c?.value || null,
            });
          }
          if ((p + 1) * 200 >= (j.productsPage?.total || 0)) break;
        }
        return out;
      },
      { store: STORE_ID, category: CATEGORY_ID }
    );

    const watched = products.filter((p) => WATCH_TYPES.includes(p.type));
    log(`[tdf] catalog ${products.length} products, ${watched.length} Broadway/Off-Broadway`);

    return watched.map((p) => ({
      id: p.id, // stable Salesforce product id — dedup key
      date: null,
      dt: null,
      movie: p.name,
      type: p.type, // "Broadway" | "Off Broadway"
      format: p.venue || p.type,
      status: null,
      url: `https://members.tdf.org/store/product/${slug(p.name)}/${p.id}`,
    }));
  } finally {
    await browser.close();
  }
}
