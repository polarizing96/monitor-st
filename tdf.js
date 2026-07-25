// TDF (Theatre Development Fund) Broadway + Off-Broadway SHOWTIMES monitor.
//
// TDF's member store runs on Salesforce B2C Commerce and is LOGIN-GATED, so we
// drive a real browser to log in (JS SPA login), then do authenticated in-page
// fetches of the commerce catalog:
//   • "Performances" category  → every individual showtime (Performance_Date__c)
//   • "Productions" category    → shows, used to build a PDP link per show
// Each performance is one showtime (show + date/time), filtered to Broadway /
// Off-Broadway. "New showtime" = a new performance id.

import { chromium } from 'playwright';

const LOGIN_URL = 'https://members.tdf.org/store/login';
const STORE_ID = '0ZEfK000000qcIvWAI';
const PERFORMANCES_CAT = '0ZGPe00000003CPOAY'; // "Performances" — individual showtimes
const PRODUCTIONS_CAT = '0ZGPe0000000AtpOAE'; // "Productions" — shows
const WATCH_TYPES = ['Broadway', 'Off Broadway'];

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Log in and return all Broadway/Off-Broadway showtimes as rows.
 * @returns {Array<{id,date,dt,movie,type,format,status,url}>}
 */
export async function fetchTdfShowtimes({ username, password, headless = true }, log = console.log) {
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({ userAgent: UA, locale: 'en-US', timezoneId: 'America/New_York' });
    const page = await context.newPage();

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.getByLabel('Username').waitFor({ timeout: 25_000 });
    await page.getByLabel('Username').fill(username);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(() => !/\/login/.test(location.pathname), null, { timeout: 30_000 });
    await page.waitForTimeout(2500);
    log('[tdf] logged in');

    const data = await page.evaluate(
      async ({ store, perfCat, prodCat }) => {
        const fetchCat = async (cat, fields) => {
          const out = [];
          for (let p = 0; p < 10; p++) {
            const url = `/store/webruntime/api/services/data/v67.0/commerce/webstores/${store}/search/products?categoryId=${cat}&fields=${encodeURIComponent(fields)}&page=${p}&pageSize=200&language=en-US&asGuest=false&htmlEncode=false`;
            const r = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
            if (!r.ok) break;
            const j = await r.json();
            const prods = j.productsPage?.products || [];
            out.push(...prods);
            if ((p + 1) * 200 >= (j.productsPage?.total || 0)) break;
          }
          return out;
        };
        const perfs = await fetchCat(perfCat, 'Id,Name,Performance_Date__c,Performance_Type__c,Venue_Name__c,StockKeepingUnit');
        const shows = await fetchCat(prodCat, 'Id,Name,Performance_Type__c');
        return {
          perfs: perfs.map((p) => ({
            id: p.id,
            name: p.name,
            date: p.fields?.Performance_Date__c?.value || null,
            type: p.fields?.Performance_Type__c?.value || null,
            venue: p.fields?.Venue_Name__c?.value || null,
          })),
          shows: shows.map((s) => ({ id: s.id, name: s.name })),
        };
      },
      { store: STORE_ID, perfCat: PERFORMANCES_CAT, prodCat: PRODUCTIONS_CAT }
    );

    // Map show name → member PDP link (login-gated, but points at the right show).
    const showUrl = {};
    for (const s of data.shows) showUrl[s.name] = `https://members.tdf.org/store/product/${slug(s.name)}/${s.id}`;

    const rows = data.perfs
      .filter((p) => WATCH_TYPES.includes(p.type) && p.date)
      .map((p) => ({
        id: p.id, // performance product id — unique per showtime; dedup key
        date: p.date.slice(0, 10), // YYYY-MM-DD (UTC)
        dt: p.date, // ISO UTC — rendered to ET by the formatter
        movie: p.name,
        type: p.type, // Broadway | Off Broadway
        venue: p.venue || p.type,
        format: [p.type, p.venue].filter(Boolean).join(' · '),
        status: null,
        url: showUrl[p.name] || 'https://members.tdf.org/store/',
      }));

    log(`[tdf] ${data.perfs.length} performances → ${rows.length} Broadway/Off-Broadway showtimes`);
    return rows;
  } finally {
    await browser.close();
  }
}
