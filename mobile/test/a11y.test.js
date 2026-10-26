// Phase 9: accessibility and layout pass over every screen, on a small phone (320 px) and a
// regular one. axe-core checks WCAG 2.1 A/AA rules; we also check that nothing scrolls sideways.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const playwright = require('playwright');
const { createApp } = require('../../src/app');
const { seedDemo } = require('../../src/seed');

const AXE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
let server, base, created, browser;

before(async () => {
  created = createApp({});
  seedDemo(created.db, created.service, { seed: 99 });
  await new Promise(resolve => { server = created.app.listen(0, '127.0.0.1', resolve); });
  base = `http://localhost:${server.address().port}`;
  browser = await playwright.chromium.launch();
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

async function audit(page, name) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(() => window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], resultTypes: ['violations'] }));
  const problems = result.violations
    .filter(v => ['serious', 'critical'].includes(v.impact))
    .map(v => `${name}: ${v.id} (${v.impact}) → ${v.nodes.slice(0, 3).map(n => n.target.join(' ')).join(' | ')}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) problems.push(`${name}: scrolls sideways by ${overflow}px`);
  return problems;
}

async function visit(context, file, ready) {
  const page = await context.newPage();
  await page.goto(`${base}/${file}`);
  await page.waitForSelector(ready, { timeout: 15000 });
  await page.waitForTimeout(250);   // let transitions settle (contrast is read from the final colours)
  return page;
}

const PLAYER_PAGES = [
  ['home.html', '#hero:not([hidden])'], ['book.html', '#slots .ui-slot'], ['bookings.html', '.ui-booking'],
  ['lessons.html', '.ui-coach'], ['lessons.html?tab=group', '.ui-class'], ['packs.html', '.ui-radio-card'],
  ['membership.html', '#card:not([hidden])'], ['profile.html', '#head:not([hidden])'], ['profile-edit.html', '#levels .ui-chip'],
  ['notifications.html', '.ui-note-item'],
];
const GUEST_PAGES = [
  ['welcome.html', '.ui-welcome__actions'], ['signup.html', '#accountForm'], ['login.html', 'form'], ['forgot.html', 'form'],
  ['manage.html', '#form'], ['book.html', '#slots .ui-slot'], ['home.html', '#hero:not([hidden])'],
];

for (const width of [320, 390]) {
  test(`player screens pass axe and fit a ${width}px phone`, async () => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const login = await context.newPage();
    await login.goto(`${base}/login.html`);
    await login.fill('#email', 'player@rallyclub.test');
    await login.fill('#password', 'rally-demo-2026');
    await login.click('button[type=submit]');
    await login.waitForURL(/home/);
    const problems = [];
    for (const [file, ready] of PLAYER_PAGES) {
      const page = await visit(context, file, ready);
      problems.push(...await audit(page, file));
      await page.close();
    }
    // A hold for checkout, then the confirmed ticket
    const coach = await visit(context, 'lessons.html', '.ui-coach');
    await coach.locator('.ui-coach').first().click();
    await coach.waitForSelector('#types .ui-choice');
    await coach.waitForTimeout(300);
    problems.push(...await audit(coach, 'coach.html'));
    const book = await visit(context, 'book.html', '#slots .ui-slot:not([disabled])');
    await book.locator('#dates .ui-date:not([disabled])').nth(2).click();
    await book.waitForSelector('#slots .ui-slot:not([disabled])');
    await book.locator('#slots .ui-slot:not([disabled])').first().click();
    await book.click('#go');
    await book.waitForSelector('#payBar:not([hidden])');
    await book.waitForTimeout(250);
    problems.push(...await audit(book, 'checkout.html'));
    await book.click('#pay');
    await book.waitForSelector('#qr svg');
    await book.waitForTimeout(250);
    problems.push(...await audit(book, 'confirmed.html'));
    assert.deepEqual(problems, []);
    await context.close();
  });
}

test('guest screens and the admin panel pass axe', async () => {
  const context = await browser.newContext({ viewport: { width: 375, height: 800 } });
  const problems = [];
  for (const [file, ready] of GUEST_PAGES) {
    const page = await visit(context, file, ready);
    problems.push(...await audit(page, `guest ${file}`));
    await page.close();
  }
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await desk.newPage();
  await page.goto(`${base}/admin`);
  await page.waitForSelector('#loginForm');
  problems.push(...await audit(page, 'admin login'));
  await page.fill('#lEmail', 'admin@rallyclub.test');
  await page.fill('#lPassword', 'rally-demo-2026');
  await page.click('#loginBtn');
  await page.waitForSelector('.ad-cal');
  for (const id of ['calendar', 'bookings', 'checkin', 'coaches', 'classes', 'pricing', 'members', 'settings', 'reports']) {
    await page.click(`#nav a[data-id="${id}"]`);
    await page.waitForFunction(() => !document.querySelector('.ad-main .ui-skel'));
    await page.waitForTimeout(250);
    problems.push(...await audit(page, `admin #${id}`));
  }
  assert.deepEqual(problems, []);
  await context.close();
  await desk.close();
});
