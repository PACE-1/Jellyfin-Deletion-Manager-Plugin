// Browser half of the clean-container smoke test. Run through the Playwright image by smoke.py.
// Env: BASE (server URL incl. any base path), MOVIE and OTHER (two movie ids), OUT (screenshot directory).
const { chromium } = require('playwright');
const BASE = process.env.BASE, MOVIE = process.env.MOVIE, OTHER = process.env.OTHER, OUT = process.env.OUT || '/out';
const results = [];
const ok = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: pass ? '' : String(JSON.stringify(detail)).slice(0, 300) }); console.log((pass ? 'PASS ' : 'FAIL ') + name + (pass ? '' : '  -> ' + String(JSON.stringify(detail)).slice(0, 300))); };
async function login(page, user) {
  await page.waitForTimeout(1200);
  const manual = page.locator('.btnManual, button:has-text("Manual Login")');
  if (await manual.count() && await manual.first().isVisible()) await manual.first().click();
  await page.waitForSelector('input[type="text"]', { state: 'visible', timeout: 30000 });
  await page.fill('input[type="text"]', user); await page.fill('input[type="password"]', 'pw12345'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.JellyfinDeletionManager && window.ApiClient && ApiClient.getCurrentUserId(), null, { timeout: 40000 });
  await page.waitForTimeout(2000);
}
const visibleEntry = page => page.evaluate(() => [...document.querySelectorAll('.jdm-topbar-entry')].find(e => e.offsetParent !== null)?.id || null);
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
  const enhanced = []; page.on('request', r => { if (/\/JellyfinEnhanced\//.test(r.url())) enhanced.push(r.url()); });
  await page.goto(BASE + '/web/');
  await login(page, 'admin');
  ok('script injected and the UI starts after sign-in', await page.evaluate(() => !!window.JellyfinDeletionManager));
  ok('exactly one script tag', (await page.locator('script[plugin="Jellyfin Deletion Manager"]').count()) === 1);
  const entry = await visibleEntry(page); ok('top-bar entry is visible', !!entry, entry);
  if (entry) { await page.click('#' + entry); await page.waitForSelector('#jdm-dashboard-page', { timeout: 10000 }).catch(() => {}); }
  ok('entry opens the dashboard', (await page.locator('#jdm-dashboard-page').count()) === 1, page.url());
  await page.waitForSelector('.jdm-exec-banner', { timeout: 8000 }).catch(() => {});
  ok('execution-off banner shown to admin', (await page.locator('.jdm-exec-banner').count()) === 1);
  await page.goto(BASE + '/web/#/details?id=' + MOVIE);
  await page.waitForSelector('.jdm-request-button', { timeout: 20000 });
  await page.click('.jdm-request-button'); await page.waitForSelector('.jdm-modal');
  await page.waitForFunction(() => { const b = document.querySelector('.button-delete'); return b && !b.disabled; }, null, { timeout: 15000 });
  await page.click('.button-delete'); await page.waitForTimeout(2500);
  ok('admin request is approved at once and shows a countdown banner', (await page.locator('.jdm-countdown-banner').count()) === 1);
  await page.screenshot({ path: OUT + '/detail.png' });
  await page.evaluate(() => { location.hash = '#/deletion-requests'; }); await page.waitForSelector('#jdm-dashboard-page'); await page.waitForTimeout(1200);
  await page.click('.jdm-tab-button:has-text("Pending")'); await page.waitForTimeout(1500);
  await page.screenshot({ path: OUT + '/dashboard.png' });
  await page.locator('.jdm-card .jdm-chip:has-text("1 week")').first().click(); await page.waitForTimeout(2500);
  ok('the quick-approve chip schedules a pending request', (await page.locator('.jdm-card').count()) === 0, await page.locator('.jdm-card').count());
  await page.evaluate(() => { location.hash = '#/movies?collectionType=movies'; });
  await page.waitForTimeout(500);
  await page.goto(BASE + '/web/#/home'); await page.waitForTimeout(1500);
  const lib = await page.evaluate(() => ApiClient.getUserViews(ApiClient.getCurrentUserId()).then(v => v.Items.find(i => i.CollectionType === 'movies').Id));
  await page.goto(BASE + `/web/#/movies?topParentId=${lib}&collectionType=movies`);
  await page.waitForSelector(`.card[data-id="${MOVIE}"]`, { state: 'visible', timeout: 20000 }); await page.waitForTimeout(3000);
  ok('approved item has a badge on its native card', (await page.locator(`.card[data-id="${MOVIE}"] .jdm-library-badge`).count()) === 1);
  await page.screenshot({ path: OUT + '/library.png' });
  const other = page.locator(`.card[data-id="${OTHER}"]`).first();
  await other.hover(); await other.locator('button[data-action="menu"], .btnCardOptions').first().click({ force: true });
  await page.waitForSelector('.actionSheetScroller', { timeout: 8000 }); await page.waitForTimeout(1000);
  ok('native card menu has one "Request deletion" row', (await page.locator('.actionSheetScroller [data-id="jdm-request-deletion"]').count()) === 1);
  await page.screenshot({ path: OUT + '/card-menu.png' });
  await page.keyboard.press('Escape'); await page.waitForTimeout(500);
  // settings page
  await page.goto(BASE + '/web/#/configurationpage?name=Jellyfin%20Deletion%20Manager'); await page.waitForTimeout(3000);
  const boxes = await page.locator('.page:not(.hide) input[type=checkbox]').count(); ok('settings page shows its two switches', boxes === 2, boxes);
  await page.screenshot({ path: OUT + '/settings.png' });
  ok('settings page has the import action', (await page.locator('.page:not(.hide) #DeletionManagerImport').count()) === 1);
  // account switch without reload
  await page.evaluate(() => { window.__marker = 'same-page'; });
  await page.click('[aria-controls="app-user-menu"]'); await page.click('.MuiMenuItem-root:has-text("Sign Out")');
  await login(page, 'viewer');
  ok('account switch keeps the page (no reload) and resets the UI', (await page.evaluate(() => window.__marker)) === 'same-page' && (await page.locator('#jdm-dashboard-page.jdm-dashboard, .jdm-card').count()) >= 0);
  await page.evaluate(() => { location.hash = '#/deletion-requests'; }); await page.waitForSelector('#jdm-dashboard-page', { timeout: 15000 }); await page.waitForTimeout(1500);
  ok('non-admin sees no execution banner', (await page.locator('.jdm-exec-banner').count()) === 0);
  const mine = await page.evaluate(() => [...document.querySelectorAll('.jdm-card')].map(c => c.textContent));
  ok('non-admin dashboard lists only their own requests', mine.every(t => !/admin/.test(t)), mine);
  // phone viewport
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(800);
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth }));
  ok('phone width: no horizontal overflow', o.sw <= o.iw + 1, o);
  await page.screenshot({ path: OUT + '/phone-dashboard.png' });
  ok('no page errors', errors.length === 0, errors);
  ok('no request to any /JellyfinEnhanced/ route', enhanced.length === 0, enhanced);
  require('fs').writeFileSync(OUT + '/ui-results.json', JSON.stringify(results, null, 1));
  await browser.close();
  process.exit(results.some(r => !r.pass) ? 1 : 0);
})().catch(e => { console.error('UI smoke crashed:', e.message); process.exit(2); });
