// Phase 1 foundation: the /styleguide page renders every component and its states,
// with the real font, working keyboard behaviour and stable loading buttons.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const playwright = require('playwright');
const { createApp } = require('../../src/app');

const SHOTS = path.join(__dirname, '..', 'shots');
let server, base, browser;

before(async () => {
  const { app } = createApp({});
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await playwright[process.env.E2E_BROWSER || 'chromium'].launch();
  fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
});

async function open(viewport = { width: 1280, height: 900 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${base}/styleguide`);
  await page.evaluate(() => document.fonts.ready);
  return { page, errors };
}

test('renders every section with the real font and no errors', async () => {
  const { page, errors } = await open();
  assert.equal(await page.title(), 'Rally Club Styleguide');
  const sections = await page.locator('.sg-section > h2').allTextContents();
  assert.deepEqual(sections, ['Tokens', 'Buttons', 'Selection', 'Forms', 'Cards', 'Feedback', 'App layout']);
  assert.equal(await page.evaluate(() => document.fonts.check('800 16px "Plus Jakarta Sans"')), true);
  const family = await page.locator('.ui-btn').first().evaluate(el => getComputedStyle(el).fontFamily);
  assert.match(family, /Plus Jakarta Sans/);

  // Button matrix: 5 variants + 2 on navy, 6 states each
  assert.equal(await page.locator('#matrix .ui-btn').count(), 30);
  assert.equal(await page.locator('#matrixNavy .ui-btn').count(), 12);
  for (const v of ['primary', 'secondary', 'ghost', 'danger', 'accent', 'inverse', 'outline-on-navy']) {
    assert.ok(await page.locator(`.ui-btn--${v}`).count() > 0, v);
  }
  // Every other component is on the page
  for (const sel of ['.ui-datestrip', '.ui-segmented', '.ui-slots', '.ui-chip', '.ui-input', '.ui-switch', '.ui-radio-card',
    '.ui-option', '.ui-hero', '.ui-stat', '.ui-ticket', '.ui-badge--table', '.ui-badge--lesson', '.ui-avatar', '.ui-empty',
    '.ui-skel', '.ui-toast', '.ui-steps', '.ui-actionbar', '.ui-tabbar', '.ui-icon-btn', '.ui-logo']) {
    assert.ok(await page.locator(sel).count() > 0, `${sel} present`);
  }
  // No emoji anywhere in the UI
  const text = await page.evaluate(() => document.body.innerText);
  assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), 'no emoji');
  await page.screenshot({ path: path.join(SHOTS, 'styleguide-desktop.png'), fullPage: true });
  assert.deepEqual(errors, []);
});

test('button sizes and states match the spec', async () => {
  const { page } = await open();
  const heights = await page.locator('#sizes .ui-btn').evaluateAll(els => els.map(e => e.getBoundingClientRect().height));
  assert.deepEqual(heights, [40, 48, 56]);
  // Disabled: 40% opacity, no pointer
  const disabled = page.locator('#matrix .ui-btn--primary[disabled]:not(.is-loading)');
  assert.equal(await disabled.evaluate(el => getComputedStyle(el).opacity), '0.4');
  // Pressed scales down
  assert.match(await page.locator('#matrix .ui-btn--primary.is-active').evaluate(el => getComputedStyle(el).transform), /matrix\(0\.98/);
  // Keyboard focus shows the 4px focus ring
  await page.locator('#sizes .ui-btn').first().focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await page.waitForTimeout(300); // let the 150ms box-shadow transition finish
  const shadow = await page.locator('#sizes .ui-btn').first().evaluate(el => getComputedStyle(el).boxShadow);
  assert.match(shadow, /rgba\(30, 58, 138, 0\.25\) 0px 0px 0px 4px/);
});

test('loading keeps the button width, then restores it', async () => {
  const { page } = await open();
  const btn = page.locator('#payBtn');
  const before = await btn.evaluate(el => el.getBoundingClientRect().width);
  await btn.click();
  assert.equal(await btn.getAttribute('aria-busy'), 'true');
  assert.equal(await btn.isDisabled(), true);
  assert.equal(await btn.evaluate(el => el.getBoundingClientRect().width), before);
  await page.waitForFunction(() => !document.querySelector('#payBtn').classList.contains('is-loading'));
  assert.equal(await btn.isDisabled(), false);
  await page.waitForSelector('.ui-toasts .ui-toast');
});

test('selection widgets work with the keyboard', async () => {
  const { page } = await open();
  // Segmented tabs: arrow key moves and selects
  await page.locator('#tabs [aria-selected="true"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#tabs [aria-selected="true"]').textContent(), 'Past');
  assert.equal(await page.locator('#tabPanel').textContent(), 'Past bookings would show here.');
  // Duration: click selects
  await page.locator('#durations button', { hasText: '90 min' }).click();
  assert.equal(await page.locator('#durations [aria-pressed="true"]').textContent(), '90 min');
  // Date strip: days outside the window are disabled
  assert.equal(await page.locator('#dates .ui-date:disabled').count(), 2);
  await page.locator('#dates .ui-date', { hasText: 'Thu' }).click();
  assert.match(await page.locator('#dates [aria-pressed="true"]').textContent(), /Thu\s*29/);
  // Slots: full ones are disabled, peak ones carry the dot
  assert.equal(await page.locator('#slots .ui-slot:disabled').count(), 3);
  assert.ok(await page.locator('#slots .ui-slot__peak').count() > 0);
  await page.locator('#slots .ui-slot', { hasText: '20:30' }).click();
  assert.equal(await page.locator('#slots [aria-pressed="true"]').textContent(), '20:30');
  // Payment options: a radiogroup that arrows through
  await page.locator('#payment [aria-checked="true"]').focus();
  await page.keyboard.press('ArrowDown');
  assert.match(await page.locator('#payment [aria-checked="true"]').textContent(), /table credit/);
  // Toggle: space flips it
  const sw = page.locator('input[aria-label="Reminders"]');
  await sw.focus();
  await page.keyboard.press('Space');
  assert.equal(await sw.isChecked(), true);
  // Radio cards: picking Pro selects it and unselects Club
  await page.locator('.ui-radio-card', { hasText: 'Pro' }).click();
  assert.equal(await page.locator('input[name="plan"][value="pro"]').isChecked(), true);
});

test('fits a phone with no sideways scroll', async () => {
  const { page, errors } = await open({ width: 390, height: 844 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.equal(overflow, 0);
  await page.screenshot({ path: path.join(SHOTS, 'styleguide-phone.png'), fullPage: true });
  assert.deepEqual(errors, []);
});
