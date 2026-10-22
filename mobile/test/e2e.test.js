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

// Picks a day at least 2 days out (so it's cancellable), then the first free cell.
async function pickSlot(page, { type = 'casual', duration = '1h', dayIndex = 2 } = {}) {
  await page.waitForSelector('#types .type-opt');
  await page.click(`[data-type="${type}"]`);
  await page.locator('#dates .chip:not([disabled])').nth(dayIndex).click();
  await page.waitForSelector('#grid .cell');
  await page.locator('#durations button', { hasText: new RegExp(`^${duration}$`) }).click();
  const cell = page.locator('#grid .cell.free').first();
  const slot = { tableId: Number(await cell.getAttribute('data-t')), start: Number(await cell.getAttribute('data-s')) };
  await cell.click();
  await page.waitForSelector('#formCard:not(.hidden)');
  return slot;
}

test('booking page: 5 tables, booking types and seeded reservations', async () => {
  const { page, errors } = await openPage();
  await page.waitForSelector('#grid .cell');
  assert.equal(await page.locator('#grid .th').count(), 5);
  assert.deepEqual(await page.locator('#types .type-opt .tl1').allTextContents(),
    ['Casual play', 'Training with robot', 'Private coaching', 'League match', 'Birthday / event']);

  // Seeded reservations show up as taken cells on a few days
  let busy = 0;
  for (let i = 0; i < 4 && busy === 0; i++) {
    await page.locator('#dates .chip:not([disabled])').nth(i).click();
    await page.waitForTimeout(400);
    busy = await page.locator('#grid .cell.busy').count();
  }
  assert.ok(busy > 0, 'expected seeded bookings to show as taken');
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-1-grid.png`), fullPage: true });
  assert.deepEqual(errors, []);
});

test('book a coaching session end to end; price includes the coaching extra', async () => {
  const { page, errors } = await openPage();
  await pickSlot(page, { type: 'coaching' });
  const summary = await page.textContent('#summary');
  assert.match(summary, /Private coaching/);

  await page.fill('#name', 'Mobile Tester');
  await page.fill('#phone', '052-555-0101');
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-2-form.png`), fullPage: true });
  await page.click('#submit');
  await page.waitForSelector('#done:not(.hidden)');
  const code = (await page.textContent('#doneCode')).trim();
  assert.match(code, /^[A-Z2-9]{6}$/);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-3-confirmed.png`), fullPage: true });

  const shownPrice = await page.textContent('#doneSummary');
  // Find the booking through the admin API and check type + price
  let booking;
  for (let d = 0; d < 15 && !booking; d++) {
    const day = await adminApi(`/day?date=${addDays(service.today().date, d)}`);
    booking = day.bookings.find(b => b.code === code);
  }
  assert.ok(booking, 'booking should exist on the server');
  assert.equal(booking.type, 'coaching');
  assert.equal(booking.source, 'online');
  const [h, m] = booking.start.split(':').map(Number);
  const start = h * 60 + m;
  assert.equal(booking.price, service.quote(booking.date, start, start + 60, 'coaching'));
  assert.ok(shownPrice.includes(String(booking.price)), `confirmation shows ${shownPrice}`);
  assert.deepEqual(errors, []);
});

test('party type disables durations shorter than 2 hours', async () => {
  const { page } = await openPage();
  await page.waitForSelector('#types .type-opt');
  await page.click('[data-type="party"]');
  const states = await page.locator('#durations button').evaluateAll(bs => bs.map(b => [b.textContent, b.disabled, b.classList.contains('on')]));
  assert.deepEqual(states, [['30m', true, false], ['1h', true, false], ['1h 30m', true, false], ['2h', false, true]]);
});

test('my bookings list, manage page and cancellation', async () => {
  const { page, errors } = await openPage();
  await pickSlot(page, { type: 'training', dayIndex: 3 });
  await page.fill('#name', 'Cancel Me');
  await page.fill('#phone', '052-555-0202');
  await page.click('#submit');
  await page.waitForSelector('#done:not(.hidden)');
  const code = (await page.textContent('#doneCode')).trim();

  await page.reload();
  await page.waitForSelector('#myBookings:not(.hidden)');
  const item = page.locator('#myBookingsList li', { hasText: 'Training with robot' }).last();
  await item.locator('a').click();
  await page.waitForSelector('#view:not(.hidden)');
  assert.equal((await page.textContent('#vCode')).trim(), code);
  assert.match(await page.textContent('#vSummary'), /Training with robot/);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-4-manage.png`), fullPage: true });

  await page.click('#cancelBtn');
  await page.waitForSelector('#vStatus.cancelled');
  assert.match(await page.textContent('#viewMsg'), /cancelled/);

  // Lookup by code + phone also works
  const { page: p2 } = await openPage('manage.html');
  await p2.fill('#code', code);
  await p2.fill('#phone', '0525550202');
  await p2.click('#lookupBtn');
  await p2.waitForSelector('#view:not(.hidden)');
  assert.equal((await p2.textContent('#vStatus')).trim(), 'Cancelled');
  assert.deepEqual(errors, []);
});

test('someone else takes the slot first: friendly error and refreshed grid', async () => {
  const { page } = await openPage();
  const slot = await pickSlot(page, { dayIndex: 4 });
  const date = await page.evaluate(() => state.date);
  // Another customer books it through the API before we tap "Book"
  const res = await fetch(`${apiBase}/api/bookings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tableId: slot.tableId, date, start: toHHMM(slot.start), duration: 60, name: 'Fast Finger', phone: '0529990000' }),
  });
  assert.equal(res.status, 201);

  await page.fill('#name', 'Slow Poke');
  await page.fill('#phone', '052-555-0303');
  await page.click('#submit');
  await page.waitForSelector('#gridMsg.alert.err');
  assert.match(await page.textContent('#gridMsg'), /just taken/);
  assert.ok(await page.locator('#formCard').isHidden(), 'form closes with the lost selection');
  const cell = page.locator(`#grid .cell[data-t="${slot.tableId}"][data-s="${slot.start}"]`);
  assert.match(await cell.getAttribute('class'), /busy/);
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
  const result = await page.waitForSelector('#selftest-result', { timeout: 30000 });
  const text = await result.textContent();
  assert.match(text, /^SELFTEST PASS · booked [A-Z2-9]{6}$/, text);
  const code = text.slice(-6);
  let found;
  for (let d = 0; d < 15 && !found; d++) {
    found = (await adminApi(`/day?date=${addDays(service.today().date, d)}`)).bookings.find(b => b.code === code);
  }
  assert.equal(found.name, 'iOS Simulator Test');
  assert.equal(found.type, 'coaching');
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-6-selftest.png`) });
  assert.deepEqual(errors, []);
});

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}
