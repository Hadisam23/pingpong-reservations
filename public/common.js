// Small helpers shared by the booking, manage and admin pages.

// Empty on the website (same origin). The mobile build sets it in config.js.
const API_BASE = (window.PP_CONFIG && window.PP_CONFIG.apiBase) || '';

// Capacitor injects window.Capacitor inside the native app.
const isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const nativePlugin = name => (isNativeApp && window.Capacitor.Plugins && window.Capacitor.Plugins[name]) || null;

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('Could not reach the server. Check your connection.'), { code: 'network' });
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON, e.g. a proxy error page */ }
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || `Request failed (${res.status})`);
    err.code = data && data.error && data.error.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

const $ = sel => document.querySelector(sel);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function money(amount, currency) {
  try {
    const fraction = Number.isInteger(amount) ? 0 : 2;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: fraction, maximumFractionDigits: fraction }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function toMin(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(date, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

function statusLabel(status) {
  return { confirmed: 'Confirmed', checked_in: 'Checked in', no_show: 'No-show', cancelled: 'Cancelled' }[status] || status;
}

function typeColorIndex(types, id) {
  const i = types.findIndex(t => t.id === id);
  return i < 0 ? 0 : i % 5;
}

async function shareLink({ title, text, url }) {
  const share = nativePlugin('Share');
  if (share) return share.share({ title, text, url, dialogTitle: title });
  if (navigator.share) return navigator.share({ title, text, url });
  throw new Error('Sharing is not supported here');
}

function canShare() {
  return !!(nativePlugin('Share') || navigator.share);
}

function haptic(kind = 'SUCCESS') {
  const h = nativePlugin('Haptics');
  if (h) h.notification({ type: kind }).catch(() => {});
}

// Storage can be unavailable (private mode, blocked site data): never let it break the page.
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};
