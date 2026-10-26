// Client side of accounts. Needs config.js, common.js (api, store) and ui.js loaded first.
//
// On the website the session lives in an HttpOnly cookie the page can't read.
// The iOS app runs on another origin (capacitor://localhost), so there the token from
// the server's response is kept in local storage and sent as a Bearer header.
const Auth = (() => {
  const KEY = 'rc.token';
  const crossOrigin = !!API_BASE;

  const token = () => (crossOrigin ? store.get(KEY, null) : null);
  const keep = result => { if (crossOrigin && result.token) store.set(KEY, result.token); return result.user; };
  const forget = () => { try { localStorage.removeItem(KEY); } catch { /* ignore */ } };
  const call = (path, opts = {}) => api(path, { ...opts, token: token() });

  async function me() {
    const { user } = await call('/api/session');
    if (!user) forget();
    return user;
  }

  // Only same-site page names are allowed as a "next" target.
  function safeNext(value, fallback = 'home.html') {
    return /^[\w-]+\.html(\?[\w=&%.-]*)?$/.test(value || '') ? value : fallback;
  }

  function goLogin() {
    const here = location.pathname.split('/').pop() || 'home.html';
    location.replace(`login.html?next=${encodeURIComponent(safeNext(here.endsWith('.html') ? here : `${here}.html`))}`);
  }

  async function requireUser() {
    const user = await me();
    if (!user) { goLogin(); return new Promise(() => {}); }
    return user;
  }

  return {
    me,
    requireUser,
    safeNext,
    signup: body => call('/api/auth/signup', { method: 'POST', body }).then(keep),
    login: body => call('/api/auth/login', { method: 'POST', body }).then(keep),
    forgot: email => call('/api/auth/forgot', { method: 'POST', body: { email } }),
    reset: body => call('/api/auth/reset', { method: 'POST', body }).then(keep),
    update: body => call('/api/me', { method: 'PATCH', body }),
    // → { user, membership, redirect } (redirect: Stripe Checkout for a new paid plan)
    choosePlan: plan => call('/api/me/plan', { method: 'PUT', body: { plan } }),
    plans: () => call('/api/plans'),
    call,
    async logout() {
      try { await call('/api/auth/logout', { method: 'POST' }); } finally { forget(); }
    },
  };
})();

// Display helpers shared by the account screens
const LEVELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
const initials = name => String(name || '').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
const firstName = name => String(name || '').trim().split(/\s+/)[0];
