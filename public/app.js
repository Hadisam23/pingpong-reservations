// The player app shell (Phase 4): the tab bar every main screen shares, the signed-in
// player, guest bookings kept on this device, and date/price formatting.
// Needs config.js, common.js, ui.js and auth.js loaded first.
const App = (() => {
  const TABS = [
    { id: 'home', label: 'Home', icon: 'home', href: 'home.html' },
    { id: 'tables', label: 'Tables', icon: 'table', href: 'book.html' },
    { id: 'lessons', label: 'Lessons', icon: 'coach', href: 'lessons.html' },
    { id: 'bookings', label: 'Bookings', icon: 'calendar', href: 'bookings.html' },
    { id: 'profile', label: 'Profile', icon: 'profile', href: 'profile.html' },
  ];

  // Renders the tab bar into <nav class="ui-tabbar" id="tabbar">. Guests' Profile tab
  // goes to the Welcome screen (create an account or log in).
  function tabbar(current, { guest = false } = {}) {
    const nav = document.getElementById('tabbar');
    if (!nav) return;
    nav.className = 'ui-tabbar';
    nav.setAttribute('aria-label', 'Main');
    nav.innerHTML = TABS.map(t => {
      const href = guest && t.id === 'profile' ? 'welcome.html' : t.href;
      const cur = t.id === current ? ' aria-current="page"' : '';
      return `<a class="ui-tab" href="${href}"${cur}>${UI.icon(t.icon)}${UI.esc(t.label)}</a>`;
    }).join('');
  }

  // ---------- guest bookings on this device ----------
  // A guest proves a booking is theirs with its manage token; we keep code + token here.
  const GUEST_KEY = 'rc.guestBookings';
  const guestBookings = () => store.get(GUEST_KEY, []);
  function rememberGuestBooking(code, token) {
    const list = guestBookings().filter(b => b.code !== code);
    list.unshift({ code, token });
    store.set(GUEST_KEY, list.slice(0, 20));
  }
  const tokenFor = code => (guestBookings().find(b => b.code === code) || {}).token || null;

  // ---------- API with the signed-in player's token (app) or cookie (web) ----------
  function call(path, opts = {}) {
    return Auth.call(path, opts);
  }
  // Adds ?token= for guest bookings (and keeps any query already there)
  const withToken = (path, token) => (token ? `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}` : path);

  // ---------- formatting ----------
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayParts(date) {
    const d = new Date(`${date}T12:00:00Z`);
    return { dow: DOW[d.getUTCDay()], num: d.getUTCDate(), month: MONTHS[d.getUTCMonth()] };
  }
  const shortDay = date => { const p = dayParts(date); return `${p.dow} ${p.num}`; };          // Tue 27
  const longDay = date => { const p = dayParts(date); return `${p.dow} ${p.num} ${p.month}`; }; // Tue 27 Oct
  const range = (start, end) => `${start} – ${end}`;
  const price = (amount, currency) => money(amount, currency);

  // "Next up · Tomorrow" style label relative to today
  function relativeDay(date, today) {
    if (date === today) return 'Today';
    if (date === addDays(today, 1)) return 'Tomorrow';
    return longDay(date);
  }

  // Seconds → "9:41"
  const clock = seconds => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  const flash = message => sessionStorage.setItem('rc.flash', message);
  function showFlash() {
    const message = sessionStorage.getItem('rc.flash');
    if (message) { sessionStorage.removeItem('rc.flash'); UI.toast(message, { kind: 'success' }); }
  }

  const param = name => new URLSearchParams(location.search).get(name);

  return {
    tabbar, guestBookings, rememberGuestBooking, tokenFor, call, withToken,
    dayParts, shortDay, longDay, range, price, relativeDay, clock, flash, showFlash, param,
  };
})();
