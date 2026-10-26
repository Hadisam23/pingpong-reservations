// In-app smoke test, only bundled when SELFTEST=1 (see scripts/test-ios.sh).
// It is added to every page and drives the real screens inside the iOS WKWebView as a
// guest: Welcome → Book as a guest → first free time → checkout → You're booked.
// Progress survives page changes in sessionStorage; PASS/FAIL shows at the bottom.
(async () => {
  const KEY = 'rc.selftest';
  const page = (location.pathname.split('/').pop() || 'index.html').replace('.html', '');
  const step = sessionStorage.getItem(KEY) || 'start';
  if (step === 'done') return;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error(`Timed out on ${page}`);
  };
  const banner = (text, ok) => {
    const d = document.createElement('div');
    d.id = 'selftest-result';
    d.textContent = text;
    d.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:99;font:600 15px -apple-system,sans-serif;color:#fff;
      padding:14px 14px calc(14px + env(safe-area-inset-bottom));background:${ok ? '#1A7F37' : '#CF222E'}`;
    document.body.appendChild(d);
  };
  const $ = s => document.querySelector(s);

  try {
    if (page === 'welcome' && step === 'welcome') {
      sessionStorage.setItem(KEY, 'booking');
      (await waitFor(() => $('.ui-welcome__guest'))).click();
    } else if (page === 'book' && step !== 'start') {
      await waitFor(() => document.querySelector('#dates .ui-date:not([disabled])') && document.querySelector('#slots .ui-slot, #slots.ui-slots-empty'));
      let slot = $('#slots .ui-slot:not([disabled])');
      for (let i = 1; i < 4 && !slot; i++) {
        const days = [...document.querySelectorAll('#dates .ui-date:not([disabled])')];
        if (!days[i]) break;
        days[i].click();
        await sleep(1500);
        slot = $('#slots .ui-slot:not([disabled])');
      }
      if (!slot) throw new Error('No free time in the booking window');
      slot.click();
      await waitFor(() => !$('#go').disabled);
      $('#go').click();
    } else if (page === 'checkout') {
      await waitFor(() => !$('#guestForm').hidden && !$('#payBar').hidden);
      $('#gName').value = 'iOS Simulator Test';
      $('#gEmail').value = 'simulator@rallyclub.test';
      $('#gPhone').value = '0501234567';
      $('#pay').click();
      await waitFor(() => !$('#alert').hidden && $('#alert').textContent, 15000)
        .then(text => { throw new Error(text); }, () => {});
    } else if (page === 'confirmed') {
      const code = await waitFor(() => /^#RC-([A-Z2-9]{6})$/.exec(($('#tCode').textContent || '').trim()));
      await waitFor(() => $('#qr svg'));
      sessionStorage.setItem(KEY, 'done');
      banner(`SELFTEST PASS · booked ${code[1]}`, true);
    } else if (step === 'start' || step === 'welcome') {
      // Start as a clean guest on Welcome, whatever page the app opened on
      localStorage.clear();
      sessionStorage.setItem(KEY, 'welcome');
      location.replace('welcome.html');
    }
  } catch (err) {
    sessionStorage.setItem(KEY, 'done');
    banner(`SELFTEST FAIL · ${err.message}`, false);
  }
})();
