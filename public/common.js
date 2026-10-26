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

// ---------- UI helpers ----------

// Outline icons, 24px grid, drawn with currentColor.
const ICONS = {
  'chevron-left': '<path d="M15 18l-6-6 6-6"/>',
  'chevron-right': '<path d="M9 18l6-6-6-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  share: '<path d="M12 15V4M8 8l4-4 4 4M5 13v6a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

// The brand mark: a navy paddle with the orange ball.
const BRAND_MARK = `<svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <circle cx="13" cy="13" r="10" fill="var(--primary)"/>
  <rect x="18.5" y="18" width="5" height="11" rx="2.5" transform="rotate(-45 21 23.5)" fill="var(--primary)"/>
  <circle cx="25" cy="7" r="4" fill="var(--accent)"/></svg>`;

// A ping pong table seen from above, used as a table's column header.
const TABLE_TOP = '<span class="tabletop" aria-hidden="true"><i></i></span>';

// <span data-icon="refresh"></span> → the icon; <span data-icon="brand"></span> → the mark.
function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    el.outerHTML = el.dataset.icon === 'brand' ? BRAND_MARK : icon(el.dataset.icon);
  });
}
hydrateIcons();

// Loading state for the Button component: keeps the button's width, shows a spinner.
function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  btn.disabled = loading;
  btn.setAttribute('aria-busy', String(loading));
}

// Current local date and minutes-from-midnight in the center's time zone.
function centerNow(timeZone) {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
  } catch {
    return null;
  }
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
