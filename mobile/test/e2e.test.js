// End-to-end test of the mobile app bundle (www/) on an emulated iPhone.
//
// The bundle is served from its own origin and talks cross-origin (CORS) to a
// real backend seeded with demo data, just like the app does on a device.
//
//   npm run test:e2e                         # Chromium, iPhone viewport
//   E2E_BROWSER=webkit npm run test:e2e      # WebKit (Safari engine), needs `npx playwright install webkit`
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const playwright = require('playwright');
const { createApp } = require('../../src/app');
const { seedDemo } = require('../../src/seed');
const { buildWeb } = require('../scripts/build-web');

const PASSWORD = 'desk-test';
const SHOTS = path.join(__dirname, '..', 'shots');
const browserName = process.env.E2E_BROWSER || 'chromium';

let server, appServer, apiBase, appOrigin, service, browser, context, outDir;

const listen = app => new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

before(async () => {
  // App bundle on its own origin (stands in for capacitor://localhost)
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-www-'));
  const appStatic = express();
  appStatic.use(express.static(outDir));
  appServer = await listen(appStatic);
  appOrigin = `http://localhost:${appServer.address().port}`;

  const created = createApp({ adminPassword: PASSWORD, corsOrigins: [appOrigin] });
  service = created.service;
  seedDemo(created.db, service, { seed: 2026 });
  server = await listen(created.app);
  apiBase = `http://127.0.0.1:${server.address().port}`;
  buildWeb({ apiUrl: apiBase, outDir });
  fs.mkdirSync(SHOTS, { recursive: true });

  browser = await playwright[browserName].launch();
  const { defaultBrowserType, ...iphone } = playwright.devices['iPhone 13'];
  context = await browser.newContext({ ...iphone, ...(browserName === 'firefox' ? { isMobile: false } : {}) });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => appServer.close(resolve));
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function openPage(file = 'index.html') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(`${appOrigin}/${file}`);
  return { page, errors };
}

async function adminApi(p, opts = {}) {
  const res = await fetch(apiBase + '/api/admin' + p, {
    ...opts, headers: { authorization: `Bearer ${PASSWORD}`, 'content-type': 'application/json' },
  });
  return res.json();
}

async function noHorizontalScroll(page) {
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth }));
  assert.ok(scrollWidth <= innerWidth, `page scrolls sideways: ${scrollWidth} > ${innerWidth}`);
}

const DEMO = { email: 'player@rallyclub.test', password: 'rally-demo-2026' };

// Picks the first bookable day from `dayIndex` on that has a free time; returns { date, time }.
async function pickSlot(page, { dayIndex = 2 } = {}) {
  await page.waitForSelector('#dates .ui-date');
  const days = page.locator('#dates .ui-date:not([disabled])');
  for (let i = dayIndex; i < await days.count(); i++) {
    await days.nth(i).click();
    await page.waitForSelector('#slots .ui-slot, #slots.ui-slots-empty');
    const free = page.locator('#slots .ui-slot:not([disabled])');
    if (await free.count()) {
      const time = (await free.first().textContent()).trim();
      await free.first().click();
      const date = await page.locator('#dates .ui-date[aria-pressed="true"]').getAttribute('data-value');
      return { date, time };
    }
  }
  throw new Error('no free slot');
}

async function logIn(page) {
  await page.goto(`${appOrigin}/login.html`);
  await page.fill('#email', DEMO.email);
  await page.fill('#password', DEMO.password);
  await page.click('button[type=submit]');
  await page.waitForURL(/home\.html/);
}

test('guest: Welcome → book a table → checkout → booked with a QR code → cancel', async () => {
  const { page, errors } = await openPage('index.html');
  await page.waitForURL(/welcome\.html/);
  await page.click('text=Book as a guest');
  await page.waitForURL(/book\.html/);
  await page.waitForSelector('#slots .ui-slot');
  assert.equal(await page.textContent('#sub'), 'Rally Club · Main hall');
  assert.deepEqual(await page.locator('#durs .ui-segment').allTextContents(), ['30 min', '60 min', '90 min']);
  assert.deepEqual(await page.locator('#areas .ui-radio-card__name').allTextContents(), ['Main hall', 'Private room']);
  assert.equal(await page.locator('#tabbar .ui-tab').count(), 5);
  // Guests book 3 days ahead: later days are disabled with a hint
  assert.ok(await page.locator('#dates .ui-date[disabled]').count() > 0);
  assert.match(await page.textContent('#windowHint'), /Members can book further ahead/);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-1-book.png`), fullPage: true });

  const { time } = await pickSlot(page);
  assert.match(await page.textContent('#sum'), new RegExp(`${time}–`));
  await page.click('#go');
  await page.waitForURL(/checkout\.html/);
  await page.waitForSelector('#payBar:not([hidden])');
  assert.match(await page.textContent('#countdownText'), /Held for you · (10:00|9:5\d)/);
  assert.equal(await page.isVisible('#guestForm'), true);
  assert.deepEqual(await page.locator('#methods .ui-option__title').allTextContents(), ['Card ending 4242']);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-2-checkout.png`), fullPage: true });

  // Required fields
  await page.click('#pay');
  assert.equal(await page.getAttribute('#gName', 'aria-invalid'), 'true');
  await page.fill('#gName', 'Guest Player');
  await page.fill('#gEmail', 'guest@example.com');
  await page.fill('#gPhone', '052-555-0101');
  await page.click('#pay');
  await page.waitForURL(/confirmed\.html/);
  await page.waitForSelector('#qr svg');
  assert.equal(await page.textContent('#title'), "You're booked!");
  assert.match(await page.textContent('#tCode'), /^#RC-[A-Z2-9]{6}$/);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-3-confirmed.png`), fullPage: true });

  // My bookings (kept on this device for guests) → cancel
  await page.click('.ui-tab:has-text("Bookings")');
  await page.waitForSelector('.ui-booking');
  assert.match(await page.textContent('.ui-booking__title'), new RegExp(`Table · ${time}`));
  await page.click('[data-cancel]');
  await page.waitForSelector('#cancelSheet:not([hidden])');
  await page.click('#cancelYes');
  await page.waitForSelector('.ui-empty');
  await page.click('#tabs [data-value="past"]');
  assert.match(await page.textContent('.ui-booking__meta'), /Cancelled/);
  assert.deepEqual(errors, []);
});

test('member: Home → book with a table credit → My bookings → reschedule', async () => {
  const { page, errors } = await openPage('welcome.html');
  await logIn(page);
  await page.waitForSelector('#hero:not([hidden])');
  assert.equal(await page.textContent('#name'), 'Noa');
  assert.equal(await page.textContent('#plan'), 'Club member');
  assert.match(await page.textContent('#heroLabel'), /Next up/);
  assert.ok(await page.locator('#free .ui-freeslot, #free p').count() > 0);
  assert.equal(await page.getAttribute('.ui-tab[aria-current="page"]', 'href'), 'home.html');
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-4-home.png`), fullPage: true });

  await page.click('.ui-action:has-text("Book a table")');
  await page.waitForURL(/book\.html/);
  // Club books 14 days ahead: no locked days in the first week
  await page.waitForSelector('#slots .ui-slot');
  assert.equal(await page.isVisible('#windowHint'), false);
  const { time } = await pickSlot(page, { dayIndex: 3 });
  assert.match(await page.textContent('#rate'), /member rate|peak|/);
  await page.click('#go');
  await page.waitForURL(/checkout\.html/);
  await page.waitForSelector('#payBar:not([hidden])');
  await page.click('#methods [data-value="CREDIT"]');
  await page.waitForFunction(() => document.querySelector('#payLabel').textContent === 'Use 1 credit & confirm');
  await page.click('#pay');
  await page.waitForURL(/confirmed\.html/);
  await page.waitForSelector('#qr svg');

  await page.goto(`${appOrigin}/bookings.html`);
  await page.waitForSelector('.ui-booking');
  assert.equal(await page.textContent('#creditTable'), '2');
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-5-bookings.png`), fullPage: true });
  const card = page.locator('.ui-booking', { hasText: `Table · ${time}` }).first();
  await card.locator('[data-move]').click();
  await page.waitForURL(/reschedule=/);
  await page.waitForSelector('#slots .ui-slot');
  assert.equal(await page.textContent('#title'), 'Move booking');
  const free = page.locator('#slots .ui-slot:not([disabled]):not([aria-pressed="true"])');
  const newTime = (await free.last().textContent()).trim();
  await free.last().click();
  await page.click('#go');
  await page.waitForURL(/bookings\.html/);
  await page.waitForSelector('.ui-booking');
  assert.ok(await page.locator('.ui-booking__title', { hasText: `Table · ${newTime}` }).count() >= 1);
  assert.deepEqual(errors, []);
});

test('the time you picked gets taken by someone else → you are told and the times refresh', async () => {
  const { page } = await openPage('book.html');
  const { date, time } = await pickSlot(page, { dayIndex: 1 });
  // Fill the whole main hall at that time from another client
  for (let i = 0; i < 3; i++) {
    await fetch(`${apiBase}/api/holds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date, start: time, duration: 60 }) });
  }
  await page.click('#go');
  await page.waitForSelector('.ui-toast--error');
  assert.match(await page.textContent('.ui-toast--error'), /just taken/);
  await page.waitForSelector(`#slots .ui-slot[data-value="${time}"][disabled]`);
});

test('front desk on a phone: seeded day, type colors, check-in', async () => {
  const { page, errors } = await openPage('admin.html');
  await page.fill('#pw', PASSWORD);
  await page.click('#loginForm button');
  await page.waitForSelector('#tab-day:not(.hidden)');
  for (let i = 0; i < 5 && (await page.locator('.tl .bk.confirmed').count()) === 0; i++) {
    await page.click('#nextDay');
    await page.waitForTimeout(300);
  }
  assert.ok(await page.locator('.tl .bk.confirmed').count() > 0, 'expected confirmed bookings on the timeline');
  assert.equal(await page.locator('#typebar .tag').count(), 5);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-5-admin.png`), fullPage: true });

  await page.locator('.tl .bk.confirmed').first().click();
  await page.waitForSelector('#dialog:not(.hidden)');
  await page.click('#dActions [data-status="checked_in"]');
  await page.waitForSelector('#dialog.hidden', { state: 'attached' });
  assert.ok(await page.locator('.tl .bk.checked_in').count() > 0);
  assert.deepEqual(errors, []);
});

test('in-app self-test (used on the iOS Simulator) passes', async () => {
  buildWeb({ apiUrl: apiBase, outDir: path.join(outDir, 'selftest'), selfTest: true });
  const { page, errors } = await openPage('selftest/index.html');
  const result = await page.waitForSelector('#selftest-result', { timeout: 45000 });
  const text = await result.textContent();
  assert.match(text, /^SELFTEST PASS · booked [A-Z2-9]{6}$/, text);
  const code = text.slice(-6);
  let found;
  for (let d = 0; d < 15 && !found; d++) {
    found = (await adminApi(`/day?date=${addDays(service.today().date, d)}`)).bookings.find(b => b.code === code);
  }
  assert.equal(found.name, 'iOS Simulator Test');
  assert.equal(found.source, 'online');
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-6-selftest.png`) });
  assert.deepEqual(errors, []);
});

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

