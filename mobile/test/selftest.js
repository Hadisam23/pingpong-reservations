// In-app smoke test, only bundled when SELFTEST=1 (see scripts/test-ios.sh).
// Drives the real booking UI inside the iOS WKWebView: picks a coaching session,
// taps the first free slot, books it, and shows PASS/FAIL at the bottom of the screen.
(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const waitFor = async (fn, ms = 15000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(200);
    }
    throw new Error('Timed out waiting for the page');
  };
  const banner = (text, ok) => {
    const d = document.createElement('div');
    d.id = 'selftest-result';
    d.textContent = text;
    d.style.cssText = `position:fixed;left:0;right:0;bottom:0;z-index:99;font:600 15px -apple-system,sans-serif;color:#fff;
      padding:14px 14px calc(14px + env(safe-area-inset-bottom));background:${ok ? '#1A7F37' : '#CF222E'}`;
    document.body.appendChild(d);
  };

  try {
    await waitFor(() => document.querySelector('#types .type-opt'));
    (document.querySelector('[data-type="coaching"]') || document.querySelector('#types .type-opt')).click();

    let cell = null;
    for (const chip of document.querySelectorAll('#dates .chip:not([disabled])')) {
      chip.click();
      await sleep(1500);
      cell = document.querySelector('#grid .cell.free');
      if (cell) break;
    }
    if (!cell) throw new Error('No free slot found in the booking window');
    cell.click();

    await waitFor(() => !document.querySelector('#formCard').classList.contains('hidden'));
    document.querySelector('#name').value = 'iOS Simulator Test';
    document.querySelector('#phone').value = '0501234567';
    document.querySelector('#submit').click();

    await waitFor(() => !document.querySelector('#done').classList.contains('hidden')
      || (!document.querySelector('#formError').classList.contains('hidden') && document.querySelector('#formError').textContent));
    const error = document.querySelector('#formError');
    if (!error.classList.contains('hidden')) throw new Error(error.textContent);
    banner(`SELFTEST PASS · booked ${document.querySelector('#doneCode').textContent}`, true);
  } catch (err) {
    banner(`SELFTEST FAIL · ${err.message}`, false);
  }
})();
