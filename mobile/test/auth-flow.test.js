// Phase 2: accounts and onboarding, end to end on an iPhone-sized screen.
// Runs the website (session cookie) and the app bundle on its own origin (bearer token),
// the way it runs inside Capacitor.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const playwright = require('playwright');
const { createApp } = require('../../src/app');
const { buildWeb } = require('../scripts/build-web');

const SHOTS = path.join(__dirname, '..', 'shots');
let created, server, base, appServer, appOrigin, outDir, browser;

const listen = app => new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });

before(async () => {
  outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-www-auth-'));
  const appStatic = express();
  appStatic.use(express.static(outDir));
  appServer = await listen(appStatic);
  appOrigin = `http://localhost:${appServer.address().port}`;

  created = createApp({ corsOrigins: [appOrigin] });
  server = await listen(created.app);
  base = `http://localhost:${server.address().port}`;
  buildWeb({ apiUrl: base, outDir });

  browser = await playwright[process.env.E2E_BROWSER || 'chromium'].launch();
  fs.mkdirSync(SHOTS, { recursive: true });
});

after(async () => {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await new Promise(resolve => appServer.close(resolve));
  fs.rmSync(outDir, { recursive: true, force: true });
});

async function phone() {
  const { defaultBrowserType, ...iphone } = playwright.devices['iPhone 13'];
  const context = await browser.newContext(iphone);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  // 400/401 responses are expected here (wrong password, a used reset link); the pages handle them
  page.on('console', m => { if (m.type() === 'error' && !/status of 40[01]/.test(m.text())) errors.push(m.text()); });
  return { context, page, errors };
}

const lastResetLink = () => /reset-password\?token=([\w-]+)/.exec(created.mailer.outbox.at(-1).text)[0];

test('website: sign up, choose a plan, edit profile, log out and back in, reset password', async () => {
  const { page, errors, context } = await phone();
  const email = `noa.${Date.now()}@example.com`;

  await page.goto(`${base}/welcome`);
  assert.equal(await page.locator('h1').innerText(), 'Book a table.\nBook a coach.\nPlay more.');
  await page.click('text=Create account');

  // Step 1: errors show under the fields
  await page.click('#accountSubmit');
  for (const id of ['name', 'email', 'phone', 'password']) {
    assert.equal(await page.getAttribute(`#${id}`, 'aria-invalid'), 'true', id);
  }
  assert.match(await page.textContent('#terms-error'), /agree/);
  await page.fill('#name', 'Noa Cohen');
  assert.equal(await page.getAttribute('#name', 'aria-invalid'), null, 'error clears while typing');
  await page.fill('#email', email);
  await page.fill('#phone', '052-123-4567');
  await page.fill('#password', 'table-tennis');
  await page.click('#levels >> text=Beginner');
  await page.check('#terms');
  await page.click('#accountSubmit');

  // Step 2: Club is preselected and named on the button
  await page.waitForSelector('#stepPlan:not([hidden]) .ui-radio-card');
  assert.equal(await page.textContent('#planSubmit'), 'Continue with Club');
  await page.screenshot({ path: path.join(SHOTS, 'p2-membership.png') });
  await page.click('.ui-radio-card:has-text("Pro")');
  assert.equal(await page.textContent('#planSubmit'), 'Continue with Pro');
  await page.click('.ui-radio-card:has-text("Club")');
  await page.click('#planSubmit');

  // New accounts land on Home; Profile is a tab away
  await page.waitForURL(/home/);
  await page.waitForSelector('#hero:not([hidden])');
  await page.click('.ui-tab:has-text("Profile")');
  await page.waitForURL(/profile/);
  await page.waitForSelector('#head:not([hidden])');
  assert.equal(await page.textContent('#name'), 'Noa Cohen');
  assert.match(await page.textContent('#meta'), /^Beginner · member since/);
  assert.equal(await page.textContent('#planName'), 'Club');
  assert.match(await page.textContent('#planLine'), /Payment pending/);
  assert.equal(await page.textContent('#statWindow'), '14d');
  await page.screenshot({ path: path.join(SHOTS, 'p2-profile.png') });

  // The session is an HttpOnly cookie the page can't read
  const cookies = await context.cookies(base);
  const session = cookies.find(c => c.name === 'rc_session');
  assert.ok(session && session.httpOnly && session.sameSite === 'Lax');
  assert.equal(await page.evaluate(() => document.cookie.includes('rc_session')), false);

  // Club rules sheet opens and closes with Escape
  await page.click('#rulesBtn');
  assert.match(await page.textContent('#rulesList'), /14 days ahead/);
  await page.keyboard.press('Escape');
  assert.equal(await page.isHidden('#rules'), true);

  // Edit profile
  await page.click('text=Edit');
  await page.waitForSelector('#levels .ui-chip');
  await page.fill('#name', 'Noa Levi');
  await page.click('#levels >> text=Advanced');
  await page.click('#submit');
  await page.waitForURL(/profile/);
  await page.waitForSelector('#head:not([hidden])');
  assert.equal(await page.textContent('#name'), 'Noa Levi');
  assert.match(await page.textContent('#meta'), /^Advanced/);

  // Change plan from the profile
  await page.click('#planActions >> text=Manage');
  await page.waitForSelector('#stepPlan:not([hidden]) .ui-radio-card');
  assert.equal(await page.textContent('#planTitle'), 'Your membership');
  assert.equal(await page.isChecked('input[value="club"]'), true);
  await page.click('.ui-radio-card:has-text("Drop-in")');
  await page.click('#planSubmit');
  await page.waitForURL(/profile/);
  await page.waitForSelector('#head:not([hidden])');
  assert.equal(await page.textContent('#planName'), 'Drop-in');
  assert.equal(await page.textContent('#statWindow'), '3d');

  // Log out, a protected page sends you to log in, then back where you were
  await page.click('#logout');
  await page.waitForURL(/welcome/);
  await page.goto(`${base}/profile.html`);
  await page.waitForURL(/login\.html\?next=profile\.html/);
  await page.fill('#email', email);
  await page.fill('#password', 'wrong-password');
  await page.click('#submit');
  await page.waitForSelector('.ui-form__alert:not([hidden])');
  assert.match(await page.textContent('.ui-form__alert'), /don't match/);
  await page.fill('#password', 'table-tennis');
  await page.click('#submit');
  await page.waitForURL(/profile/);

  // Forgot password → email link → new password
  await page.click('#logout');
  await page.waitForURL(/welcome/);
  await page.goto(`${base}/forgot.html`);
  await page.fill('#email', email);
  await page.click('#submit');
  await page.waitForSelector('#sent:not([hidden])');
  await page.goto(`${base}/${lastResetLink()}`);
  await page.fill('#password', 'brand-new-pass');
  await page.fill('#confirm', 'different-pass');
  await page.click('#submit');
  assert.match(await page.textContent('#confirm-error'), /don't match/);
  await page.fill('#confirm', 'brand-new-pass');
  await page.click('#submit');
  await page.waitForURL(/home/);
  await page.waitForSelector('#hero:not([hidden])');
  // The used link no longer works
  await page.goto(`${base}/${lastResetLink()}`);
  await page.fill('#password', 'another-pass-1');
  await page.fill('#confirm', 'another-pass-1');
  await page.click('#submit');
  await page.waitForSelector('#again:not([hidden])');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.equal(overflow, 0);
  assert.deepEqual(errors, []);
});

test('app bundle (other origin): sign up keeps a bearer token, Welcome skips ahead when signed in', async () => {
  const { page, errors } = await phone();
  await page.goto(`${appOrigin}/welcome.html`);
  await page.click('text=Create account');
  await page.fill('#name', 'App User');
  await page.fill('#email', `app.${Date.now()}@example.com`);
  await page.fill('#phone', '0549876543');
  await page.fill('#password', 'from-the-app');
  await page.check('#terms');
  await page.click('#accountSubmit');
  await page.waitForSelector('#stepPlan:not([hidden]) .ui-radio-card');
  await page.click('#planSkip');
  await page.waitForURL(/home/);
  await page.click('.ui-tab:has-text("Profile")');
  await page.waitForURL(/profile/);
  await page.waitForSelector('#head:not([hidden])');
  assert.equal(await page.textContent('#planName'), 'Drop-in');
  assert.ok(await page.evaluate(() => localStorage.getItem('rc.token')), 'token kept for the app');

  await page.goto(`${appOrigin}/welcome.html`);
  await page.waitForURL(/home/);
  await page.goto(`${appOrigin}/profile.html`);
  await page.click('#logout');
  await page.waitForURL(/welcome/);
  assert.equal(await page.evaluate(() => localStorage.getItem('rc.token')), null);
  assert.deepEqual(errors, []);
});

test('the start page sends guests to Welcome, and Book as a guest opens booking', async () => {
  const { page } = await phone();
  await page.goto(`${base}/`);
  await page.waitForURL(/welcome/);
  await page.click('text=Book as a guest');
  await page.waitForURL(/book\.html/);
  await page.waitForSelector('#slots .ui-slot');
});
