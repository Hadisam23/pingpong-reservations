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

test('member: lessons — coach detail, book with a pack lesson; classes — join and waitlist', async () => {
  const { page, errors } = await openPage('home.html');
  await page.waitForSelector('#tabbar .ui-tab');
  if (!(await page.textContent('#name')).includes('Noa')) await logIn(page);
  await page.click('.ui-tab:has-text("Lessons")');
  await page.waitForSelector('.ui-coach');
  assert.equal(await page.locator('.ui-coach').count(), 3);
  assert.match(await page.textContent('.ui-coach__next'), /^Next free: /);
  await page.click('#levels [data-value="kids"]');
  await page.waitForFunction(() => document.querySelectorAll('.ui-coach').length === 1);
  await page.click('#levels [data-value="all"]');
  await page.waitForFunction(() => document.querySelectorAll('.ui-coach').length === 3);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-6-lessons.png`), fullPage: true });

  await page.locator('.ui-coach', { hasText: 'Dana Peretz' }).click();
  await page.waitForURL(/coach\.html/);
  await page.waitForSelector('#slots .ui-slot, #slots.ui-slots-empty');
  assert.equal(await page.locator('#types .ui-choice').count(), 3);
  if (!(await page.locator('#slots .ui-slot').count())) {
    await page.click('#otherDays');
    await page.locator('#dates .ui-date:not([disabled])').nth(1).click();
    await page.waitForSelector('#slots .ui-slot');
  }
  await page.locator('#slots .ui-slot').first().click();
  assert.match(await page.textContent('#go'), /^Book \w{3} · \d\d:\d\d$/);
  await noHorizontalScroll(page);
  await page.screenshot({ path: path.join(SHOTS, `${browserName}-7-coach.png`), fullPage: true });
  await page.click('#go');
  await page.waitForURL(/checkout\.html/);
  await page.waitForSelector('#payBar:not([hidden])');
  assert.match(await page.textContent('#sumSub'), /with Dana Peretz/);
  assert.equal(await page.isVisible('#players'), false);
  assert.equal(await page.textContent('#payLabel'), 'Use 1 pack lesson & confirm');
  await page.click('#pay');
  await page.waitForURL(/confirmed\.html/);
  await page.waitForSelector('#qr svg');

  // Group classes: the full one offers the waitlist, an open one can be joined
  await page.goto(`${appOrigin}/lessons.html?tab=group`);
  await page.waitForSelector('.ui-class');
  assert.ok(await page.locator('.ui-class', { hasText: 'On the waitlist · #1' }).count() >= 1, 'the demo player is first on the waitlist');
  const open = page.locator('.ui-class:has([data-join])').first();
  const title = (await open.locator('.ui-class__title').textContent()).trim();
  await open.locator('[data-join]').click();
  await page.waitForURL(/checkout\.html/);
  await page.waitForSelector('#payBar:not([hidden])');
  assert.match(await page.textContent('#sumTitle'), new RegExp(title.replace(/[()]/g, '.')));
  await page.click('#pay');
  await page.waitForURL(/confirmed\.html/);
  await page.goto(`${appOrigin}/lessons.html?tab=group`);
  await page.waitForSelector('.ui-class');
  assert.equal(await page.locator('.ui-class', { hasText: title }).locator('.ui-badge--success').count(), 1);
  assert.deepEqual(errors, []);
});

test('admin panel: staff login, calendar check-in, drag to block, every section loads', async () => {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await desk.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 401/403 are expected: before signing in, and for the player account
  page.on('console', m => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  await page.goto(`${apiBase}/admin`);
  // A player account is not staff
  await page.fill('#lEmail', DEMO.email);
  await page.fill('#lPassword', DEMO.password);
  await page.click('#loginBtn');
  await page.waitForSelector('#loginForm .ui-form__alert:not([hidden])');
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await page.reload();
  await page.fill('#lEmail', 'admin@rallyclub.test');
  await page.fill('#lPassword', DEMO.password);
  await page.click('#loginBtn');
  await page.waitForSelector('.ad-cal, .ad-main .ui-empty');
  for (let i = 0; i < 5 && !(await page.locator('.ad-cal .ad-item--booking.is-confirmed').count()); i++) {
    await page.click('#nextDay');
    await page.waitForTimeout(300);
  }
  assert.equal(await page.locator('.ad-cal__row').count(), 4, 'one row per table');
  await page.screenshot({ path: path.join(SHOTS, 'admin-1-calendar.png') });
  await page.locator('.ad-cal .ad-item--booking.is-confirmed').first().click();
  await page.waitForSelector('#drawer:not([hidden])');
  await page.click('#drawer [data-status="checked_in"]');
  await page.waitForSelector('.ui-toast--success');
  assert.ok(await page.locator('.ad-cal .ad-item.is-checked_in').count() > 0);

  // Drag across Table 4 to block it
  const track = page.locator('.ad-cal__track[data-table]').last();
  const box = await track.boundingBox();
  await page.mouse.move(box.x + 6, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 6 + 56 * 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.waitForSelector('#blockForm');
  await page.fill('#blockForm [name="reason"]', 'New rubber');
  await page.click('#blockForm button');
  await page.waitForSelector('.ad-cal .ad-item--block');

  for (const id of ['bookings', 'checkin', 'coaches', 'classes', 'pricing', 'members', 'settings', 'reports']) {
    await page.click(`#nav a[data-id="${id}"]`);
    await page.waitForFunction(sel => !document.querySelector('.ad-main .ui-skel') && document.querySelector(sel), '.ad-main .ad-card, .ad-main .ad-table-wrap, .ad-main .ui-empty');
    assert.equal(await page.locator('.ad-main .ui-error').count(), 0, `${id} loaded`);
  }
  await page.screenshot({ path: path.join(SHOTS, 'admin-2-reports.png'), fullPage: true });
  await page.click('#nav a[data-id="checkin"]');
  await page.waitForSelector('#codeForm');
  const today = (await adminApi(`/bookings?from=${service.today().date}&to=${service.today().date}&status=confirmed`))[0];
  if (today) {
    await page.fill('#code', `RC-${today.code}`);
    await page.click('#codeForm button');
    await page.waitForSelector('.ad-result--ok');
  }
  assert.deepEqual(errors, []);
  await desk.close();
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

