// Rally Club front desk / admin panel (Phase 7). Staff sign in with their account (role ADMIN).
// One page, sections by hash: #calendar #bookings #checkin #coaches #classes #pricing
// #members #settings #reports. Needs config.js, common.js, ui.js and auth.js.
(() => {
  const h = UI.esc;
  const A = (path, opts) => Auth.call(`/api/admin${path}`, opts);
  const main = $('#main');
  const state = { config: null, staff: null, date: null };
  const fmt = n => money(Number(n) || 0, (state.config && state.config.currency) || 'ILS');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const LEVELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', kids: 'Kids', all: 'All levels' };
  const STATUS = { confirmed: ['Confirmed', 'table'], checked_in: ['Checked in', 'success'], no_show: ['No-show', 'danger'], cancelled: ['Cancelled', 'neutral'], held: ['On hold', 'neutral'] };
  const KIND = { TABLE: 'Table', LESSON: 'Lesson', CLASS: 'Class' };
  const PLAN = { dropin: 'Drop-in', club: 'Club', pro: 'Pro' };
  const dayLabel = date => `${DOW[new Date(`${date}T12:00:00Z`).getUTCDay()]} ${prettyDate(date, { day: 'numeric', month: 'short' })}`;
  const badge = status => { const [label, tone] = STATUS[status] || [status, 'neutral']; return `<span class="ui-badge ui-badge--${tone}">${h(label)}</span>`; };
  const field = (label, input, help = '') => `<div class="ui-field"><label class="ui-field__label">${h(label)}</label>${input}${help ? `<span class="ui-field__help">${h(help)}</span>` : ''}</div>`;
  const input = (name, value = '', attrs = '') => `<input class="ui-input" name="${name}" value="${h(value ?? '')}" ${attrs}>`;
  const formData = form => Object.fromEntries(new FormData(form).entries());

  function fail(err, form) {
    if (form && err.field) {
      const el = form.querySelector(`[name="${CSS.escape(err.field.split('.')[0])}"]`);
      if (el) { UI.fieldError(el, err.message); el.focus(); return; }
    }
    UI.toast(err.message, { kind: 'error' });
  }
  async function busy(btn, fn) {
    UI.setLoading(btn, true);
    try { return await fn(); } finally { UI.setLoading(btn, false); }
  }

  // ---------- drawer ----------
  let lastFocus = null;
  function openDrawer(html, mount) {
    lastFocus = document.activeElement;
    $('#drawerPanel').innerHTML = html;
    $('#drawer').hidden = false;
    if (mount) mount($('#drawerPanel'));
    const first = $('#drawerPanel').querySelector('input, select, textarea, button:not([data-close])') || $('#drawerPanel [data-close]');
    if (first) first.focus();
  }
  function closeDrawer() {
    $('#drawer').hidden = true;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  const drawerHead = (title, sub = '') => `<div class="ad-drawer__head"><div><h2 class="ui-h2" id="drawerTitle">${h(title)}</h2>${sub ? `<p class="ad-muted">${h(sub)}</p>` : ''}</div>
    <button type="button" class="ui-icon-btn" data-close aria-label="Close">${UI.icon('x')}</button></div>`;
  $('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer' || e.target.closest('[data-close]')) closeDrawer(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#drawer').hidden) closeDrawer(); });

  // ---------- navigation ----------
  const SECTIONS = [
    { id: 'calendar', label: 'Calendar', icon: 'calendar', render: renderCalendar },
    { id: 'bookings', label: 'Bookings', icon: 'list', render: renderBookings },
    { id: 'checkin', label: 'Check-in', icon: 'qr', render: renderCheckin },
    { id: 'coaches', label: 'Coaches', icon: 'coach', render: renderCoaches },
    { id: 'classes', label: 'Classes', icon: 'users', render: renderClasses },
    { id: 'pricing', label: 'Pricing & plans', icon: 'card', render: renderPricing },
    { id: 'members', label: 'Members', icon: 'profile', render: renderMembers },
    { id: 'settings', label: 'Settings', icon: 'settings', render: renderSettings },
    { id: 'reports', label: 'Reports', icon: 'chart', render: renderReports },
  ];
  let stopScanner = null;
  function route() {
    if (stopScanner) { stopScanner(); stopScanner = null; }
    const id = (location.hash.slice(1) || 'calendar').split('?')[0];
    const section = SECTIONS.find(s => s.id === id) || SECTIONS[0];
    $('#nav').querySelectorAll('a').forEach(a => {
      if (a.dataset.id === section.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.title = `${section.label} · Rally Club admin`;
    main.innerHTML = `<div class="ad-head"><h1>${h(section.label)}</h1></div><span class="ui-skel ui-skel--card" aria-hidden="true"></span>`;
    section.render().catch(err => {
      main.innerHTML = `<div class="ad-head"><h1>${h(section.label)}</h1></div>
        <div class="ui-empty ui-error" role="alert"><span class="ui-empty__icon">${UI.icon('alert')}</span>
        <span class="ui-empty__title">Couldn't load this page</span><span class="ui-empty__text">${h(err.message)}</span></div>`;
    });
  }
  window.addEventListener('hashchange', route);

  // ======================= calendar =======================
  const COL = 56;   // px per 30 minutes
  async function renderCalendar() {
    const d = await A(`/calendar?date=${state.date}`);
    const tools = `<div class="ad-tools">
      <button type="button" class="ui-icon-btn" id="prevDay" aria-label="Previous day">${UI.icon('back')}</button>
      <input class="ui-input" type="date" id="calDate" value="${d.date}" aria-label="Date">
      <button type="button" class="ui-icon-btn" id="nextDay" aria-label="Next day">${UI.icon('forward')}</button>
      ${UI.button({ label: 'Today', variant: 'secondary', size: 'sm', id: 'todayBtn' })}
    </div>`;
    const legend = `<div class="ad-legend" aria-label="Legend">
      <span><i class="ad-item--booking"></i>Table booking</span><span><i class="ad-item--lesson"></i>Lesson</span>
      <span><i class="ad-item--class"></i>Class / open play</span><span><i class="ad-item--block"></i>Maintenance</span>
      <span>Drag across a table to block time or add a walk-in</span></div>`;
    let body;
    if (d.closed) {
      body = `<div class="ui-empty"><span class="ui-empty__icon">${UI.icon('lock')}</span><span class="ui-empty__title">Closed</span>
        <span class="ui-empty__text">${h(d.closure || 'The club is closed this day.')}</span></div>`;
    } else {
      const open = toMin(d.open);
      const close = toMin(d.close);
      const cols = (close - open) / 30;
      const x = m => ((m - open) / 30) * COL;
      let times = '';
      for (let m = open - (open % 60); m < close; m += 60) {
        const left = Math.max(open, m);
        times += `<span class="ad-cal__time" style="width: ${(Math.min(close, m + 60) - left) / 30 * COL}px">${toHHMM(m)}</span>`;
      }
      const rows = d.tables.map(t => {
        const items = d.items.filter(i => i.tableIds.includes(t.id) && i.end > open && i.start < close && i.status !== 'cancelled');
        return `<div class="ad-cal__row"><div class="ad-cal__name"><b>${h(t.name)}</b><span>${h(t.area || '')}</span></div>
          <div class="ad-cal__track" data-table="${t.id}" style="width: ${cols * COL}px" aria-label="${h(t.name)} timeline">
          ${items.map(i => `<button type="button" class="ad-item ad-item--${i.type} is-${i.status}" data-item="${d.items.indexOf(i)}"
            style="left: ${x(Math.max(open, i.start)) + 2}px; width: ${x(Math.min(close, i.end)) - x(Math.max(open, i.start)) - 4}px"
            aria-label="${h(`${i.title}, ${toHHMM(i.start)}–${toHHMM(i.end)}, ${i.sub}`)}"><b>${h(i.title)}</b><span>${toHHMM(i.start)}–${toHHMM(i.end)} · ${h(i.sub)}</span></button>`).join('')}
          ${d.date === d.today && nowMinutes() > open && nowMinutes() < close ? `<span class="ad-now" style="left: ${x(nowMinutes())}px" aria-hidden="true"></span>` : ''}
          </div></div>`;
      }).join('');
      body = `<div class="ad-cal"><div class="ad-cal__grid"><div class="ad-cal__times"><div class="ad-cal__name"></div>${times}</div>${rows}</div></div>`;
    }
    main.innerHTML = `<div class="ad-head"><h1>${h(dayLabel(d.date))}</h1>${tools}</div>${legend}${body}`;

    const go = date => { state.date = date; renderCalendar(); };
    $('#prevDay').onclick = () => go(addDays(d.date, -1));
    $('#nextDay').onclick = () => go(addDays(d.date, 1));
    $('#todayBtn').onclick = () => go(d.today);
    $('#calDate').onchange = e => e.target.value && go(e.target.value);
    main.querySelectorAll('.ad-item').forEach(el => { el.onclick = () => openItem(d.items[Number(el.dataset.item)], d); });
    if (!d.closed) enableDrag(d);
  }

  function nowMinutes() {
    const n = centerNow(state.config.timezone);
    return n ? n.minutes : 0;
  }

  // Drag on a table's timeline → block it or add a walk-in
  function enableDrag(d) {
    const open = toMin(d.open);
    const close = toMin(d.close);
    main.querySelectorAll('.ad-cal__track').forEach(track => {
      track.addEventListener('pointerdown', e => {
        if (e.target !== track || e.button !== 0) return;
        const rect = track.getBoundingClientRect();
        const snap = px => Math.min(close, Math.max(open, open + Math.round(px / COL) * 30));
        const startX = e.clientX - rect.left;
        const ghost = document.createElement('div');
        ghost.className = 'ad-drag';
        track.appendChild(ghost);
        track.setPointerCapture(e.pointerId);
        let a = snap(startX - COL / 2 + 1);
        let b = a + 30;
        const draw = () => { ghost.style.left = `${(a - open) / 30 * COL}px`; ghost.style.width = `${(b - a) / 30 * COL}px`; };
        draw();
        const move = ev => {
          const xNow = ev.clientX - rect.left;
          const p = snap(xNow);
          const s = snap(startX - COL / 2 + 1);
          a = Math.min(s, p); b = Math.max(s + 30, p);
          if (b > close) b = close;
          draw();
        };
        const up = () => {
          track.removeEventListener('pointermove', move);
          track.removeEventListener('pointerup', up);
          ghost.remove();
          if (b > a) openNew(d, Number(track.dataset.table), a, b);
        };
        track.addEventListener('pointermove', move);
        track.addEventListener('pointerup', up);
      });
    });
  }

  function openNew(d, tableId, start, end) {
    const table = d.tables.find(t => t.id === tableId);
    openDrawer(`${drawerHead(`${table.name} · ${toHHMM(start)}–${toHHMM(end)}`, dayLabel(d.date))}
      <div id="newMode"></div>
      <form class="ui-form" id="blockForm">${field('Reason', input('reason', 'Maintenance', 'maxlength="120"'))}
        <button type="submit" class="ui-btn ui-btn--primary ui-btn--block">Block this time</button></form>
      <form class="ui-form" id="walkForm" hidden>${field('Name', input('name', '', 'required maxlength="60"'))}
        <div class="ad-row">${field('Phone (optional)', input('phone', '', 'type="tel"'))}${field('Players', input('players', '2', 'type="number" min="1" max="8"'))}</div>
        <button type="submit" class="ui-btn ui-btn--primary ui-btn--block">Add walk-in</button></form>`, panel => {
      UI.segmented(panel.querySelector('#newMode'), {
        label: 'What to add', value: 'block', options: [{ value: 'block', label: 'Block time' }, { value: 'walk', label: 'Walk-in booking' }],
        onChange: v => { panel.querySelector('#blockForm').hidden = v !== 'block'; panel.querySelector('#walkForm').hidden = v !== 'walk'; },
      });
      panel.querySelector('#blockForm').onsubmit = async e => {
        e.preventDefault();
        const f = formData(e.target);
        try {
          const res = await busy(e.target.querySelector('button'), () => A('/blocks', { method: 'POST', body: { tableId, date: d.date, start: toHHMM(start), end: toHHMM(end), reason: f.reason } }));
          closeDrawer();
          UI.toast(res.conflicts.length ? `Blocked. ${res.conflicts.length} booking(s) overlap: move or cancel them.` : 'Time blocked.', { kind: res.conflicts.length ? 'error' : 'success' });
          renderCalendar();
        } catch (err) { fail(err, e.target); }
      };
      panel.querySelector('#walkForm').onsubmit = async e => {
        e.preventDefault();
        const f = formData(e.target);
        try {
          await busy(e.target.querySelector('button'), () => A('/bookings', { method: 'POST', body: { tableId, date: d.date, start: toHHMM(start), duration: end - start, name: f.name, phone: f.phone || null, players: Number(f.players) || 2, type: 'casual' } }));
          closeDrawer();
          UI.toast('Walk-in added.', { kind: 'success' });
          renderCalendar();
        } catch (err) { fail(err, e.target); }
      };
    });
  }

  function openItem(item, d) {
    if (item.type === 'booking' || item.type === 'lesson') return openBooking(item.booking, () => renderCalendar());
    if (item.type === 'class') {
      return openDrawer(`${drawerHead(item.title, `${dayLabel(d.date)} · ${toHHMM(item.start)}–${toHHMM(item.end)}`)}
        <dl class="ad-kv"><dt>Seats</dt><dd>${h(item.sub)}</dd><dt>Tables</dt><dd>${h(item.tableIds.map(id => (d.tables.find(t => t.id === id) || {}).name).join(', '))}</dd></dl>
        <div class="ad-actions"><a class="ui-btn ui-btn--secondary ui-btn--sm" href="#classes">Manage in Classes</a></div>`);
    }
    openDrawer(`${drawerHead(item.title, `${toHHMM(item.start)}–${toHHMM(item.end)}`)}
      <div class="ad-actions"><button type="button" class="ui-btn ui-btn--danger ui-btn--sm" id="unblock">Remove block</button></div>`, panel => {
      panel.querySelector('#unblock').onclick = async e => {
        try {
          await busy(e.target.closest('button'), () => A(`/blocks/${item.blockId}`, { method: 'DELETE' }));
          closeDrawer(); UI.toast('Block removed.', { kind: 'success' }); renderCalendar();
        } catch (err) { fail(err); }
      };
    });
  }

  // Booking details with front-desk actions (calendar, bookings, check-in, members)
  function openBooking(b, refresh) {
    const when = `${dayLabel(b.date)} · ${b.start}–${b.end}`;
    const paid = b.price ? `${fmt(b.price)}${b.paymentMethod ? ` · ${b.paymentMethod.toLowerCase()}` : ''}` : (b.paymentMethod === 'MEMBERSHIP' ? 'Included in plan' : b.source === 'desk' ? 'Pay at desk' : '–');
    const act = [];
    if (b.status === 'confirmed') act.push(UI.button({ label: 'Check in', size: 'sm', attrs: 'data-status="checked_in"' }), UI.button({ label: 'No-show', variant: 'secondary', size: 'sm', attrs: 'data-status="no_show"' }));
    if (['checked_in', 'no_show'].includes(b.status)) act.push(UI.button({ label: 'Undo (back to confirmed)', variant: 'secondary', size: 'sm', attrs: 'data-status="confirmed"' }));
    if (['confirmed', 'held', 'no_show'].includes(b.status)) {
      act.push(UI.button({ label: 'Cancel & refund', variant: 'danger', size: 'sm', attrs: 'data-cancel="1"' }), UI.button({ label: 'Cancel, no refund', variant: 'ghost', size: 'sm', attrs: 'data-cancel="0"' }));
    }
    openDrawer(`${drawerHead(b.kind === 'TABLE' ? `Table · ${b.start}–${b.end}` : b.title, when)}
      <div>${badge(b.status)} <span class="ui-badge ui-badge--neutral">${KIND[b.kind]}</span></div>
      <dl class="ad-kv">
        <dt>Booking</dt><dd>#RC-${h(b.code)}</dd><dt>Name</dt><dd>${h(b.name)}</dd>
        <dt>Phone</dt><dd>${b.phone ? `<a class="ui-link" href="tel:${h(b.phone)}">${h(b.phone)}</a>` : '–'}</dd>
        <dt>Email</dt><dd>${b.email ? `<a class="ui-link" href="mailto:${h(b.email)}">${h(b.email)}</a>` : '–'}</dd>
        <dt>Where</dt><dd>${h(b.table ? `${b.table} · ${b.area}` : b.where)}</dd>
        ${b.coach ? `<dt>Coach</dt><dd>${h(b.coach)}</dd>` : ''}
        <dt>Players</dt><dd>${b.players}</dd><dt>Paid</dt><dd>${h(paid)}${b.refunded ? ' · refunded' : ''}</dd>
        <dt>Booked</dt><dd>${h(b.source === 'desk' ? 'At the desk' : b.userId ? 'Member app' : 'Guest, online')}</dd>
      </dl>
      <div class="ad-actions">${act.join('')}</div>`, panel => {
      panel.querySelectorAll('[data-status]').forEach(btn => { btn.onclick = async () => {
        try {
          const res = await busy(btn, () => (btn.dataset.status === 'checked_in'
            ? A('/checkin', { method: 'POST', body: { code: b.code } }).then(r => r.booking)
            : A(`/bookings/${b.code}/status`, { method: 'POST', body: { status: btn.dataset.status } })));
          closeDrawer(); UI.toast(`${res.name}: ${STATUS[res.status][0].toLowerCase()}.`, { kind: 'success' }); refresh();
        } catch (err) { fail(err); }
      }; });
      panel.querySelectorAll('[data-cancel]').forEach(btn => { btn.onclick = async () => {
        const refund = btn.dataset.cancel === '1';
        if (!confirm(refund ? 'Cancel this booking and refund the player?' : 'Cancel without a refund?')) return;
        try {
          await busy(btn, () => A(`/bookings/${b.code}/cancel`, { method: 'POST', body: { refund } }));
          closeDrawer(); UI.toast(refund ? 'Cancelled and refunded.' : 'Cancelled.', { kind: 'success' }); refresh();
        } catch (err) { fail(err); }
      }; });
    });
  }

  // ======================= bookings =======================
  async function renderBookings() {
    const t = state.config.today;
    main.innerHTML = `<div class="ad-head"><h1>Bookings</h1></div>
      <form class="ad-card" id="filters" style="padding: var(--space-4)"><div class="ad-row">
        ${field('Search', input('q', '', 'placeholder="Name, phone, email or code" type="search"'))}
        ${field('From', input('from', addDays(t, -7), 'type="date"'))}${field('To', input('to', addDays(t, 14), 'type="date"'))}
        ${field('Status', `<select class="ui-input" name="status"><option value="">Any</option>${Object.entries(STATUS).map(([v, [l]]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}
        ${field('Type', `<select class="ui-input" name="kind"><option value="">Any</option><option value="TABLE">Table</option><option value="LESSON">Lesson</option><option value="CLASS">Class</option></select>`)}
      </div></form><div id="results"></div>`;
    const form = $('#filters');
    const load = async () => {
      const q = new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v));
      const rows = await A(`/bookings?${q}`);
      $('#results').innerHTML = rows.length ? `<div class="ad-table-wrap"><table class="ad-table"><thead><tr>
        <th>When</th><th>Booking</th><th>Name</th><th>Type</th><th>Where</th><th>Status</th><th>Paid</th></tr></thead><tbody>
        ${rows.map((b, i) => `<tr data-open="${i}" tabindex="0"><td><b>${h(dayLabel(b.date))}</b> ${b.start}–${b.end}</td><td>#RC-${h(b.code)}</td>
          <td>${h(b.name)}<div class="ad-muted">${h(b.phone || b.email || '')}</div></td><td>${KIND[b.kind]}${b.kind !== 'TABLE' ? `<div class="ad-muted">${h(b.title)}</div>` : ''}</td>
          <td>${h(b.table || b.where)}</td><td>${badge(b.status)}</td><td>${b.price ? fmt(b.price) : '–'}</td></tr>`).join('')}
        </tbody></table></div><p class="ad-muted">${rows.length} booking${rows.length === 1 ? '' : 's'}${rows.length === 100 ? ' (first 100: narrow the search)' : ''}</p>`
        : '<div class="ui-empty"><span class="ui-empty__title">No bookings match</span><span class="ui-empty__text">Try a wider date range or a different search.</span></div>';
      $('#results').querySelectorAll('[data-open]').forEach(tr => {
        const open = () => openBooking(rows[Number(tr.dataset.open)], load);
        tr.onclick = open;
        tr.onkeydown = e => { if (e.key === 'Enter') open(); };
      });
    };
    let timer;
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 250); });
    form.addEventListener('submit', e => e.preventDefault());
    await load();
  }

  // ======================= check-in =======================
  async function renderCheckin() {
    main.innerHTML = `<div class="ad-head"><h1>Check-in</h1></div>
      <div id="result" aria-live="assertive"></div>
      <div class="ad-grid">
        <section class="ad-card" aria-labelledby="scanTitle"><div class="ad-card__head"><h2 id="scanTitle">Scan the QR code</h2>
          ${UI.button({ label: 'Start camera', size: 'sm', iconLeft: 'camera', id: 'camBtn' })}</div>
          <div class="ad-scan"><video id="video" playsinline muted hidden></video><span class="ad-scan__frame" aria-hidden="true" hidden id="frame"></span>
            <p class="ad-scan__idle" id="camIdle">Point the camera at the player's check-in pass. Codes work from 15 minutes before the start.</p></div>
        </section>
        <section class="ad-card" aria-labelledby="manualTitle"><h2 id="manualTitle">Find a booking</h2>
          <form class="ui-inline" id="codeForm"><label class="ui-sr" for="code">Booking code</label><input class="ui-input ui-input--md" id="code" name="code" placeholder="Booking code, e.g. RC-7KQ2PX" autocomplete="off" autocapitalize="characters">
            <button type="submit" class="ui-btn ui-btn--primary">Check in</button></form>
          <label class="ui-sr" for="who">Search today's bookings</label><input class="ui-input ui-input--md" id="who" type="search" placeholder="Or search today's bookings by name or phone">
          <div id="today"></div>
        </section>
      </div>`;
    const show = (ok, title, text) => {
      $('#result').innerHTML = `<div class="ad-result ad-result--${ok ? 'ok' : 'bad'}" role="status">${UI.icon(ok ? 'check' : 'alert')}<div><b>${h(title)}</b>${h(text)}</div></div>`;
      if (ok) haptic();
    };
    const checkIn = async body => {
      try {
        const r = await A('/checkin', { method: 'POST', body });
        const b = r.booking;
        show(true, `${r.already ? 'Already checked in' : 'Checked in'}: ${b.name}`, ` · ${b.kind === 'TABLE' ? (b.table || b.where) : b.title} · ${b.start}–${b.end} · ${b.players} player${b.players === 1 ? '' : 's'}`);
        loadToday();
      } catch (err) { show(false, "Can't check in", ` · ${err.message}`); }
    };
    $('#codeForm').onsubmit = e => { e.preventDefault(); const c = $('#code').value.trim(); if (c) checkIn({ code: c }); $('#code').value = ''; };

    const t = state.config.today;
    const loadToday = async () => {
      const q = $('#who').value.trim();
      const rows = (await A(`/bookings?from=${t}&to=${t}${q ? `&q=${encodeURIComponent(q)}` : ''}`)).filter(b => ['confirmed', 'checked_in', 'no_show'].includes(b.status)).reverse();
      $('#today').innerHTML = rows.length ? `<div class="ad-table-wrap"><table class="ad-table"><tbody>${rows.map(b => `<tr>
        <td><b>${b.start}</b></td><td>${h(b.name)}<div class="ad-muted">${h(b.kind === 'TABLE' ? (b.table || b.where) : b.title)}</div></td>
        <td>${b.status === 'checked_in' ? badge('checked_in') : UI.button({ label: 'Check in', size: 'sm', attrs: `data-code="${b.code}"` })}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="ad-muted">No bookings left today.</p>';
      $('#today').querySelectorAll('[data-code]').forEach(btn => { btn.onclick = () => checkIn({ code: btn.dataset.code }); });
    };
    let timer;
    $('#who').oninput = () => { clearTimeout(timer); timer = setTimeout(loadToday, 250); };
    $('#camBtn').onclick = () => (stopScanner ? (stopScanner(), stopScanner = null, resetCam()) : startScanner(token => checkIn({ token })));
    const resetCam = () => { $('#camBtn').querySelector('span').textContent = 'Start camera'; $('#video').hidden = true; $('#frame').hidden = true; $('#camIdle').hidden = false; };
    await loadToday();
  }

  // Camera scanning: BarcodeDetector where the browser has it, jsQR otherwise (Safari)
  async function startScanner(onCode) {
    const video = $('#video');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    } catch {
      UI.toast("Couldn't open the camera. Allow camera access, or type the booking code.", { kind: 'error' });
      return;
    }
    video.srcObject = stream;
    video.hidden = false; $('#frame').hidden = false; $('#camIdle').hidden = true;
    $('#camBtn').querySelector('span').textContent = 'Stop camera';
    await video.play();
    let detect;
    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => ((await detector.detect(video))[0] || {}).rawValue;
    } else {
      if (!window.jsQR) await new Promise((resolve, reject) => { const s = document.createElement('script'); s.src = `${API_BASE}/vendor/jsqr.js`; s.onload = resolve; s.onerror = reject; document.head.appendChild(s); });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const r = window.jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        return r && r.data;
      };
    }
    let running = true;
    let pauseUntil = 0;
    const loop = async () => {
      if (!running) return;
      if (Date.now() > pauseUntil && video.readyState >= 2) {
        const code = await detect().catch(() => null);
        if (code) { pauseUntil = Date.now() + 2500; onCode(code); }
      }
      setTimeout(loop, 250);
    };
    loop();
    stopScanner = () => { running = false; stream.getTracks().forEach(t => t.stop()); };
  }

  // ======================= coaches =======================
  async function renderCoaches() {
    const list = await A('/coaches');
    main.innerHTML = `<div class="ad-head"><h1>Coaches</h1>${UI.button({ label: 'Add coach', iconLeft: 'plus', size: 'sm', id: 'addCoach' })}</div>
      ${list.length ? `<div class="ad-table-wrap"><table class="ad-table"><thead><tr><th>Coach</th><th>Specialties</th><th>Levels</th><th>Weekly hours</th><th>Time off</th><th>Status</th></tr></thead><tbody>
      ${list.map((c, i) => `<tr data-open="${i}" tabindex="0"><td><b>${h(c.name)}</b><div class="ad-muted">${h(c.email)}</div></td><td>${h(c.specialties.join(', '))}</td>
        <td>${h(c.levels.map(l => LEVELS[l]).join(', '))}</td><td>${h(c.hours.map(x => `${DOW[x.dayOfWeek]} ${x.startTime}–${x.endTime}`).join(' · ') || '–')}</td>
        <td>${h(c.timeOff.map(o => `${o.startDate}${o.endDate !== o.startDate ? ` → ${o.endDate}` : ''}`).join(', ') || '–')}</td>
        <td>${c.active ? '<span class="ui-badge ui-badge--success">Active</span>' : '<span class="ui-badge ui-badge--neutral">Hidden</span>'}</td></tr>`).join('')}
      </tbody></table></div>` : '<div class="ui-empty"><span class="ui-empty__title">No coaches yet</span></div>'}`;
    $('#addCoach').onclick = () => coachForm(null);
    main.querySelectorAll('[data-open]').forEach(tr => {
      const open = () => coachForm(list[Number(tr.dataset.open)]);
      tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); };
    });
  }

  function coachForm(c) {
    const hours = c ? c.hours.slice() : [];
    const hourRow = (x, i) => `<div class="ad-row" data-hour="${i}">
      <select class="ui-input" name="day" aria-label="Day">${DOW.map((d, n) => `<option value="${n}" ${n === x.dayOfWeek ? 'selected' : ''}>${d}</option>`).join('')}</select>
      <input class="ui-input" name="startTime" type="time" step="1800" value="${x.startTime}" aria-label="From">
      <input class="ui-input" name="endTime" type="time" step="1800" value="${x.endTime}" aria-label="To">
      <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-remove="${i}">Remove</button></div>`;
    openDrawer(`${drawerHead(c ? c.name : 'Add coach', c ? 'Profile, hours and time off' : 'They can log in with this email after a password reset')}
      <form class="ui-form" id="coachForm" novalidate>
        <div class="ad-row">${field('Name', input('name', c && c.name, 'required'))}${field('Email', input('email', c && c.email, 'type="email" required'))}</div>
        <div class="ad-row">${field('Certification', input('certification', c && c.certification))}${field('Years coaching', input('yearsCoaching', c && c.yearsCoaching, 'type="number" min="0" max="70"'))}</div>
        ${field('Specialties', input('specialties', c ? c.specialties.join(', ') : '', 'placeholder="Footwork, Serve & return"'), 'Separate with commas')}
        <div class="ui-field"><span class="ui-field__label">Levels</span><div class="ad-checks">${Object.entries(LEVELS).filter(([v]) => v !== 'all').map(([v, l]) => `<label><input type="checkbox" name="levels" value="${v}" ${c && c.levels.includes(v) ? 'checked' : ''}>${l}</label>`).join('')}</div></div>
        <div class="ui-field"><label class="ui-field__label" for="bio">Bio</label><textarea class="ui-input" id="bio" name="bio" rows="3" style="height: auto; padding-top: var(--space-3)">${h(c ? c.bio || '' : '')}</textarea></div>
        <div class="ui-field"><span class="ui-field__label">Weekly hours</span><div id="hours" class="ui-form"></div>
          <button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" id="addHour" style="align-self: flex-start">${UI.icon('plus')}<span>Add hours</span></button></div>
        <label class="ui-check"><input type="checkbox" name="active" ${!c || c.active ? 'checked' : ''}> <span>Show in the app (active)</span></label>
        <button type="submit" class="ui-btn ui-btn--primary ui-btn--block">${c ? 'Save coach' : 'Add coach'}</button>
      </form>
      ${c ? `<section class="ui-form"><h3 class="ui-section">Time off</h3>
        <div id="offList">${c.timeOff.map(o => `<div class="ui-card__row"><span>${h(o.startDate)} → ${h(o.endDate)} ${o.reason ? `· ${h(o.reason)}` : ''}</span>
          <button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-off="${o.id}">Remove</button></div>`).join('') || '<p class="ad-muted">None planned.</p>'}</div>
        <form class="ad-row" id="offForm">${field('From', input('startDate', '', 'type="date" required'))}${field('To', input('endDate', '', 'type="date" required'))}${field('Reason', input('reason'))}
          <button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Add time off</button></form></section>` : ''}`, panel => {
      const paint = () => { panel.querySelector('#hours').innerHTML = hours.map(hourRow).join('') || '<p class="ad-muted">No hours yet: they won\'t have lesson slots.</p>'; };
      const read = () => [...panel.querySelectorAll('[data-hour]')].map(r => ({ dayOfWeek: Number(r.querySelector('[name="day"]').value), startTime: r.querySelector('[name="startTime"]').value, endTime: r.querySelector('[name="endTime"]').value }));
      paint();
      panel.querySelector('#addHour').onclick = () => { hours.splice(0, hours.length, ...read(), { dayOfWeek: 0, startTime: '16:00', endTime: '20:00' }); paint(); };
      panel.querySelector('#hours').onclick = e => { const r = e.target.closest('[data-remove]'); if (r) { const cur = read(); cur.splice(Number(r.dataset.remove), 1); hours.splice(0, hours.length, ...cur); paint(); } };
      panel.querySelector('#coachForm').onsubmit = async e => {
        e.preventDefault();
        const form = e.target;
        UI.clearErrors(form);
        const f = formData(form);
        const body = { ...f, levels: [...form.querySelectorAll('[name="levels"]:checked')].map(x => x.value), active: form.querySelector('[name="active"]').checked, hours: read() };
        try {
          await busy(form.querySelector('[type="submit"]'), () => A(c ? `/coaches/${c.id}` : '/coaches', { method: c ? 'PUT' : 'POST', body }));
          closeDrawer(); UI.toast(c ? 'Coach saved.' : 'Coach added.', { kind: 'success' }); renderCoaches();
        } catch (err) { fail(err, form); }
      };
      if (c) {
        panel.querySelector('#offForm').onsubmit = async e => {
          e.preventDefault();
          try { await A(`/coaches/${c.id}/time-off`, { method: 'POST', body: formData(e.target) }); closeDrawer(); UI.toast('Time off added.', { kind: 'success' }); renderCoaches(); } catch (err) { fail(err, e.target); }
        };
        panel.querySelector('#offList').onclick = async e => {
          const b = e.target.closest('[data-off]');
          if (b) { await A(`/coaches/${c.id}/time-off/${b.dataset.off}`, { method: 'DELETE' }); closeDrawer(); renderCoaches(); }
        };
      }
    });
  }

  // ======================= classes =======================
  async function renderClasses() {
    const [list, coaches, club] = await Promise.all([A(`/classes?from=${state.config.today}&days=42`), A('/coaches'), A('/club')]);
    const tables = club.tables.filter(t => t.active);
    main.innerHTML = `<div class="ad-head"><h1>Classes & open play</h1>${UI.button({ label: 'New session', iconLeft: 'plus', size: 'sm', id: 'newClass' })}</div>
      ${list.length ? `<div class="ad-table-wrap"><table class="ad-table"><thead><tr><th>When</th><th>Session</th><th>Level</th><th>Coach</th><th>Seats</th><th>Price</th><th></th></tr></thead><tbody>
      ${list.map((c, i) => `<tr><td><b>${h(dayLabel(c.date))}</b> ${c.start} · ${c.duration} min</td><td>${h(c.title)}${c.kind === 'OPEN_PLAY' ? ' <span class="ui-badge ui-badge--neutral">Open play</span>' : ''}${c.recurring ? '<div class="ad-muted">Weekly</div>' : ''}</td>
        <td>${h(LEVELS[c.level] || c.level)}</td><td>${h(c.coach || '–')}</td><td>${Math.min(c.taken, c.capacity)} / ${c.capacity}${c.taken >= c.capacity ? ' <span class="ui-badge ui-badge--danger">Full</span>' : ''}</td><td>${fmt(c.price)}</td>
        <td><div class="ad-actions"><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-edit="${i}">Edit</button><button type="button" class="ui-btn ui-btn--danger ui-btn--sm" data-cancel="${i}">Cancel</button></div></td></tr>`).join('')}
      </tbody></table></div>` : '<div class="ui-empty"><span class="ui-empty__title">No sessions in the next 6 weeks</span><span class="ui-empty__text">Add a class or open play session.</span></div>'}`;

    $('#newClass').onclick = () => openDrawer(`${drawerHead('New session', 'One date, or weekly')}
      <form class="ui-form" id="classForm" novalidate>
        <div class="ad-row">${field('Title', input('title', '', 'required placeholder="Beginner fundamentals"'))}
          ${field('Type', '<select class="ui-input" name="kind"><option value="CLASS">Class</option><option value="OPEN_PLAY">Open play</option></select>')}</div>
        <div class="ad-row">${field('Level', `<select class="ui-input" name="level">${Object.entries(LEVELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`)}
          ${field('Coach', `<select class="ui-input" name="coachId"><option value="">No coach (open play)</option>${coaches.filter(c => c.active).map(c => `<option value="${c.id}">${h(c.name)}</option>`).join('')}</select>`)}</div>
        <div class="ad-row">${field('Date', input('date', state.config.today, 'type="date" required'))}${field('Start', input('start', '18:00', 'type="time" step="1800" required'))}${field('Minutes', input('duration', '60', 'type="number" min="15" step="15"'))}</div>
        <div class="ad-row">${field('Capacity', input('capacity', '8', 'type="number" min="1"'))}${field(`Price (${state.config.currency})`, input('price', '45', 'type="number" min="0"'))}${field('Repeat weekly for', input('weeks', '1', 'type="number" min="1" max="26"'), 'weeks')}</div>
        <div class="ui-field"><span class="ui-field__label">Tables</span><div class="ad-checks" id="tableIds">${tables.map(t => `<label><input type="checkbox" name="tableIds" value="${t.id}">${h(t.name)} <span class="ad-muted">${h(t.area || '')}</span></label>`).join('')}</div></div>
        <button type="submit" class="ui-btn ui-btn--primary ui-btn--block">Create</button></form>`, panel => {
      panel.querySelector('#classForm').onsubmit = async e => {
        e.preventDefault();
        const form = e.target;
        UI.clearErrors(form);
        const f = formData(form);
        const body = { ...f, coachId: f.coachId || null, tableIds: [...form.querySelectorAll('[name="tableIds"]:checked')].map(x => Number(x.value)) };
        try {
          const r = await busy(form.querySelector('[type="submit"]'), () => A('/classes', { method: 'POST', body }));
          closeDrawer(); UI.toast(`${r.created} session${r.created === 1 ? '' : 's'} created.`, { kind: 'success' }); renderClasses();
        } catch (err) {
          if (err.field === 'tableIds') { UI.fieldError(form.querySelector('[name="tableIds"]'), err.message); return; }
          fail(err, form);
        }
      };
    });

    main.querySelectorAll('[data-edit]').forEach(btn => { btn.onclick = () => {
      const c = list[Number(btn.dataset.edit)];
      openDrawer(`${drawerHead(c.title, `${dayLabel(c.date)} · ${c.start}`)}
        <form class="ui-form" id="editClass">${field('Title', input('title', c.title))}
          <div class="ad-row">${field('Capacity', input('capacity', c.capacity, 'type="number" min="1"'), `${c.taken} taken`)}${field('Price', input('price', c.price, 'type="number" min="0"'))}</div>
          <button type="submit" class="ui-btn ui-btn--primary ui-btn--block">Save</button></form>`, panel => {
        panel.querySelector('#editClass').onsubmit = async e => {
          e.preventDefault();
          try { await A(`/classes/${c.id}`, { method: 'PATCH', body: formData(e.target) }); closeDrawer(); UI.toast('Saved.', { kind: 'success' }); renderClasses(); } catch (err) { fail(err, e.target); }
        };
      });
    }; });
    main.querySelectorAll('[data-cancel]').forEach(btn => { btn.onclick = async () => {
      const c = list[Number(btn.dataset.cancel)];
      if (!confirm(`Cancel ${c.title} on ${dayLabel(c.date)}? ${c.taken} player(s) get a full refund and a message.`)) return;
      try { const r = await busy(btn, () => A(`/classes/${c.id}`, { method: 'DELETE' })); UI.toast(`Cancelled. ${r.refunded} refund(s).`, { kind: 'success' }); renderClasses(); } catch (err) { fail(err); }
    }; });
  }

  // ======================= pricing & plans =======================
  async function renderPricing() {
    const p = await A('/pricing');
    const cur = p.currency;
    const dayBoxes = (days, i) => DOW.map((d, n) => `<label><input type="checkbox" data-rule="${i}" data-day="${n}" ${days.includes(n) ? 'checked' : ''}>${d}</label>`).join('');
    main.innerHTML = `<div class="ad-head"><h1>Pricing & plans</h1></div>
      <section class="ad-card" aria-labelledby="rulesTitle"><div class="ad-card__head"><h2 id="rulesTitle">Table prices</h2><span class="ad-muted">Per booking, in ${h(cur)}. Peak applies from the peak start to the peak end.</span></div>
        <div class="ad-table-wrap"><table class="ad-table" id="rules"><thead><tr><th>Minutes</th><th>Days</th><th>Off-peak</th><th>Peak</th><th>Peak from</th><th>Peak to</th><th></th></tr></thead><tbody>
        ${p.rules.map((r, i) => `<tr data-row="${i}"><td><input class="ui-input" name="durationMin" type="number" min="15" step="15" value="${r.durationMin}" aria-label="Minutes"></td>
          <td><div class="ad-checks">${dayBoxes(r.daysOfWeek, i)}</div></td>
          <td><input class="ui-input" name="basePrice" type="number" min="0" value="${r.basePrice}" aria-label="Off-peak price"></td><td><input class="ui-input" name="peakPrice" type="number" min="0" value="${r.peakPrice}" aria-label="Peak price"></td>
          <td><input class="ui-input" name="peakStart" type="time" value="${r.peakStart || ''}" aria-label="Peak from"></td><td><input class="ui-input" name="peakEnd" type="time" value="${r.peakEnd === '24:00' ? '' : r.peakEnd || ''}" aria-label="Peak to (empty = close)"></td>
          <td><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-drop="${i}">Remove</button></td></tr>`).join('')}</tbody></table></div>
        <div class="ad-actions">${UI.button({ label: 'Add row', variant: 'secondary', size: 'sm', id: 'addRule' })}${UI.button({ label: 'Save prices', size: 'sm', id: 'saveRules' })}</div>
      </section>

      <section class="ad-card" aria-labelledby="plansTitle"><h2 id="plansTitle">Membership plans</h2><div class="ad-grid">
        ${p.plans.map(pl => `<form class="ui-form ad-card" data-plan="${pl.id}" novalidate style="padding: var(--space-4)">
          <div class="ad-row">${field('Name', input('name', pl.name))}${field(`Price / month`, input('price', pl.price, `type="number" min="0" ${pl.id === 'dropin' ? 'disabled' : ''}`))}</div>
          <div class="ad-row">${field('Table discount %', input('tableDiscountPct', pl.tableDiscountPct, 'type="number" min="0" max="100"'))}${field('Book ahead (days)', input('bookingWindowDays', pl.bookingWindowDays, 'type="number" min="0" max="90"'))}</div>
          <div class="ad-row">${field('Table credits / month', input('monthlyTableCredits', pl.monthlyTableCredits, 'type="number" min="0"'))}${field('Lessons included / month', input('includedLessonsPerMonth', pl.includedLessonsPerMonth, 'type="number" min="0"'))}</div>
          <label class="ui-check"><input type="checkbox" name="offPeakTablesFree" ${pl.offPeakTablesFree ? 'checked' : ''}> <span>Off-peak tables included</span></label>
          ${field('Summary', input('summary', pl.summary))}
          <div class="ui-field"><label class="ui-field__label">Perks (one per line)</label><textarea class="ui-input" name="perks" rows="3" style="height: auto; padding-top: var(--space-2)">${h(pl.perks.join('\n'))}</textarea></div>
          <button type="submit" class="ui-btn ui-btn--primary ui-btn--sm">Save ${h(pl.name)}</button></form>`).join('')}
      </div></section>

      <section class="ad-card" aria-labelledby="ltTitle"><h2 id="ltTitle">Lesson types</h2>
        <div class="ad-table-wrap"><table class="ad-table"><thead><tr><th>Name</th><th>Minutes</th><th>Max students</th><th>Price</th><th>Description</th><th>Active</th><th></th></tr></thead><tbody>
        ${[...p.lessonTypes, { id: '', name: '', durationMin: 60, maxStudents: 1, price: 0, description: '', active: true }].map(t => `<tr data-lt="${t.id}">
          <td><input class="ui-input" name="name" value="${h(t.name)}" placeholder="${t.id ? '' : 'New lesson type'}" aria-label="Name"></td><td><input class="ui-input" name="durationMin" type="number" value="${t.durationMin}" aria-label="Minutes"></td>
          <td><input class="ui-input" name="maxStudents" type="number" value="${t.maxStudents}" aria-label="Max students"></td><td><input class="ui-input" name="price" type="number" value="${t.price}" aria-label="Price"></td>
          <td><input class="ui-input" name="description" value="${h(t.description || '')}" aria-label="Description"></td><td><input type="checkbox" name="active" ${t.active ? 'checked' : ''} aria-label="Active"></td>
          <td><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-save-lt="${t.id}">${t.id ? 'Save' : 'Add'}</button></td></tr>`).join('')}</tbody></table></div>
      </section>

      <div class="ad-grid">
        <section class="ad-card" aria-labelledby="packTitle"><h2 id="packTitle">Lesson packs</h2>
          <form class="ui-form" id="packForm">${p.lessonPacks.map((k, i) => `<div class="ad-row" data-pack>${field(`Pack ${i + 1}: lessons`, input('size', k.size, 'type="number" min="2"'))}${field('Saving %', input('discountPct', k.discountPct, 'type="number" min="0" max="90"'))}</div>`).join('')}
            ${field('Extra saving for members %', input('memberPackDiscountPct', p.memberPackDiscountPct, 'type="number" min="0" max="50"'))}
            <button type="submit" class="ui-btn ui-btn--primary ui-btn--sm">Save packs</button></form></section>
        <section class="ad-card" aria-labelledby="promoTitle"><h2 id="promoTitle">Promo codes</h2>
          ${p.promos.length ? `<div class="ad-table-wrap"><table class="ad-table"><tbody>${p.promos.map(x => `<tr><td><b>${h(x.code)}</b></td><td>${x.percentOff ? `${x.percentOff}%` : fmt(x.amountOff)} off</td>
            <td>until ${h(x.validTo.slice(0, 10))}</td><td>${x.uses}${x.maxUses ? ` / ${x.maxUses}` : ''} used</td><td><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-del-promo="${h(x.code)}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="ad-muted">No promo codes.</p>'}
          <form class="ui-form" id="promoForm" novalidate><div class="ad-row">${field('Code', input('code', '', 'placeholder="SPRING15"'))}${field('% off', input('percentOff', '', 'type="number" min="1" max="100"'))}${field('or amount off', input('amountOff', '', 'type="number" min="1"'))}</div>
            <div class="ad-row">${field('From', input('validFrom', state.config.today, 'type="date"'))}${field('To', input('validTo', addDays(state.config.today, 30), 'type="date"'))}${field('Max uses', input('maxUses', '', 'type="number" min="1"'))}</div>
            <button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Add promo code</button></form></section>
      </div>`;

    const readRules = () => [...main.querySelectorAll('#rules [data-row]')].map(tr => ({
      durationMin: tr.querySelector('[name="durationMin"]').value, basePrice: tr.querySelector('[name="basePrice"]').value, peakPrice: tr.querySelector('[name="peakPrice"]').value,
      peakStart: tr.querySelector('[name="peakStart"]').value || null, peakEnd: tr.querySelector('[name="peakEnd"]').value || null,
      daysOfWeek: [...tr.querySelectorAll('[data-day]:checked')].map(x => Number(x.dataset.day)),
    }));
    $('#addRule').onclick = () => {
      const rules = readRules();
      rules.push({ durationMin: 60, basePrice: 40, peakPrice: 60, peakStart: '17:00', peakEnd: null, daysOfWeek: [0, 1, 2, 3, 4] });
      A('/pricing/rules', { method: 'PUT', body: { rules } }).then(renderPricing).catch(fail);
    };
    main.querySelectorAll('[data-drop]').forEach(b => { b.onclick = () => {
      const rules = readRules();
      rules.splice(Number(b.dataset.drop), 1);
      A('/pricing/rules', { method: 'PUT', body: { rules } }).then(renderPricing).catch(fail);
    }; });
    $('#saveRules').onclick = async e => {
      try { await busy(e.currentTarget, () => A('/pricing/rules', { method: 'PUT', body: { rules: readRules() } })); UI.toast('Table prices saved.', { kind: 'success' }); } catch (err) { fail(err); }
    };
    main.querySelectorAll('[data-plan]').forEach(form => { form.onsubmit = async e => {
      e.preventDefault();
      UI.clearErrors(form);
      const f = formData(form);
      const body = { ...f, offPeakTablesFree: form.querySelector('[name="offPeakTablesFree"]').checked, perks: (f.perks || '').split('\n') };
      try { await busy(form.querySelector('[type="submit"]'), () => A(`/plans/${form.dataset.plan}`, { method: 'PUT', body })); UI.toast(`${f.name} saved.`, { kind: 'success' }); } catch (err) { fail(err, form); }
    }; });
    main.querySelectorAll('[data-save-lt]').forEach(btn => { btn.onclick = async () => {
      const tr = btn.closest('tr');
      const body = Object.fromEntries(['name', 'durationMin', 'maxStudents', 'price', 'description'].map(k => [k, tr.querySelector(`[name="${k}"]`).value]));
      body.active = tr.querySelector('[name="active"]').checked;
      try { await busy(btn, () => A(btn.dataset.saveLt ? `/lesson-types/${btn.dataset.saveLt}` : '/lesson-types', { method: btn.dataset.saveLt ? 'PUT' : 'POST', body })); UI.toast('Lesson type saved.', { kind: 'success' }); renderPricing(); } catch (err) { fail(err); }
    }; });
    $('#packForm').onsubmit = async e => {
      e.preventDefault();
      const lessonPacks = [...e.target.querySelectorAll('[data-pack]')].map(r => ({ size: r.querySelector('[name="size"]').value, discountPct: r.querySelector('[name="discountPct"]').value }));
      try { await A('/lesson-packs', { method: 'PUT', body: { lessonPacks, memberPackDiscountPct: e.target.querySelector('[name="memberPackDiscountPct"]').value } }); UI.toast('Lesson packs saved.', { kind: 'success' }); } catch (err) { fail(err); }
    };
    $('#promoForm').onsubmit = async e => {
      e.preventDefault();
      UI.clearErrors(e.target);
      try { await A('/promos', { method: 'POST', body: formData(e.target) }); UI.toast('Promo code added.', { kind: 'success' }); renderPricing(); } catch (err) { fail(err, e.target); }
    };
    main.querySelectorAll('[data-del-promo]').forEach(b => { b.onclick = () => A(`/promos/${encodeURIComponent(b.dataset.delPromo)}`, { method: 'DELETE' }).then(renderPricing).catch(fail); });
  }

  // ======================= members =======================
  async function renderMembers() {
    main.innerHTML = `<div class="ad-head"><h1>Members</h1></div>
      <form class="ad-card" id="mFilters" style="padding: var(--space-4)"><div class="ad-row">${field('Search', input('q', '', 'type="search" placeholder="Name, email or phone"'))}
        ${field('Plan', '<select class="ui-input" name="plan"><option value="">All plans</option><option value="dropin">Drop-in</option><option value="club">Club</option><option value="pro">Pro</option></select>')}</div></form>
      <div id="mList"></div>`;
    const form = $('#mFilters');
    const load = async () => {
      const q = new URLSearchParams(Object.entries(formData(form)).filter(([, v]) => v));
      const rows = await A(`/members?${q}`);
      $('#mList').innerHTML = `<div class="ad-table-wrap"><table class="ad-table"><thead><tr><th>Member</th><th>Plan</th><th>Table credits</th><th>Pack lessons</th><th>Bookings</th><th>Last visit</th><th>Role</th></tr></thead><tbody>
        ${rows.map((m, i) => `<tr data-open="${i}" tabindex="0"><td><b>${h(m.name)}</b><div class="ad-muted">${h(m.email)}</div></td>
          <td>${h(PLAN[m.planId] || m.planId)} ${m.status !== 'active' ? `<span class="ui-badge ui-badge--${m.status === 'past_due' ? 'danger' : 'neutral'}">${h(m.status.replace('_', ' '))}</span>` : ''}${m.cancelAtPeriodEnd ? '<div class="ad-muted">Cancels at period end</div>' : ''}</td>
          <td>${m.credits}</td><td>${m.packLeft}</td><td>${m.bookings}</td><td>${h(m.lastVisit || '–')}</td><td>${h(m.role.toLowerCase())}</td></tr>`).join('')}</tbody></table></div>
        <p class="ad-muted">${rows.length} member${rows.length === 1 ? '' : 's'}</p>`;
      $('#mList').querySelectorAll('[data-open]').forEach(tr => {
        const open = () => openMember(rows[Number(tr.dataset.open)].id, load);
        tr.onclick = open; tr.onkeydown = e => { if (e.key === 'Enter') open(); };
      });
    };
    let timer;
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => load().catch(fail), 250); });
    form.addEventListener('submit', e => e.preventDefault());
    await load();
  }

  async function openMember(id, refresh) {
    const m = await A(`/members/${id}`);
    openDrawer(`${drawerHead(m.name, `${m.email}${m.phone ? ` · ${m.phone}` : ''}`)}
      <dl class="ad-kv"><dt>Plan</dt><dd>${h(PLAN[m.planId] || m.planId)} · ${h(m.status.replace('_', ' '))}${m.currentPeriodEnd ? ` · ${m.cancelAtPeriodEnd ? 'ends' : 'renews'} ${h(m.currentPeriodEnd.slice(0, 10))}` : ''}</dd>
        <dt>Table credits</dt><dd>${m.credits}</dd><dt>Pack lessons</dt><dd>${m.packLeft}</dd><dt>Member since</dt><dd>${h(m.createdAt.slice(0, 10))}</dd></dl>
      <form class="ui-form" id="adjust" novalidate><h3 class="ui-section">Adjust credits</h3>
        <div class="ad-row">${field('What', '<select class="ui-input" name="type"><option value="TABLE_CREDIT">Table credits</option><option value="LESSON_PACK">Pack lessons</option></select>')}${field('Change', input('delta', '1', 'type="number" min="-100" max="100"'), 'Negative to remove')}</div>
        ${field('Reason', input('reason', '', 'required placeholder="e.g. Broken net on Table 2"'))}
        <button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Apply</button></form>
      <div class="ui-field"><label class="ui-field__label" for="role">Role</label><select class="ui-input" id="role">${['PLAYER', 'COACH', 'ADMIN'].map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></div>
      <h3 class="ui-section">Bookings</h3>
      ${m.history.length ? `<div class="ad-table-wrap"><table class="ad-table"><tbody>${m.history.slice(0, 30).map(b => `<tr><td>${h(b.date)} ${b.start}</td><td>${h(b.kind === 'TABLE' ? 'Table' : b.title)}</td><td>${badge(b.status)}</td><td>${b.price ? fmt(b.price) : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ad-muted">No bookings yet.</p>'}
      <h3 class="ui-section">Credits history</h3>
      ${m.ledger.length ? `<div class="ad-table-wrap"><table class="ad-table"><tbody>${m.ledger.slice(0, 30).map(l => `<tr><td>${h(l.createdAt.slice(0, 10))}</td><td>${l.type === 'TABLE_CREDIT' ? 'Table' : 'Pack'}</td><td><b>${l.delta > 0 ? '+' : ''}${l.delta}</b></td><td>${h(l.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ad-muted">No credit changes.</p>'}
      <h3 class="ui-section">Payments</h3>
      ${m.payments.length ? `<div class="ad-table-wrap"><table class="ad-table"><tbody>${m.payments.slice(0, 30).map(p => `<tr><td>${h(p.createdAt.slice(0, 10))}</td><td>${h(p.description || p.kind)}</td><td>${fmt(p.amount)}</td><td>${h(p.status.toLowerCase())}</td></tr>`).join('')}</tbody></table></div>` : '<p class="ad-muted">No payments.</p>'}`, panel => {
      panel.querySelector('#adjust').onsubmit = async e => {
        e.preventDefault();
        UI.clearErrors(e.target);
        try { await busy(e.target.querySelector('button'), () => A(`/members/${id}/credits`, { method: 'POST', body: formData(e.target) })); UI.toast('Credits updated.', { kind: 'success' }); refresh(); openMember(id, refresh); } catch (err) { fail(err, e.target); }
      };
      panel.querySelector('#role').onchange = async e => {
        try { await A(`/members/${id}/role`, { method: 'PUT', body: { role: e.target.value } }); UI.toast(`Role changed to ${e.target.value.toLowerCase()}.`, { kind: 'success' }); refresh(); } catch (err) { fail(err); }
      };
    });
  }

  // ======================= settings =======================
  async function renderSettings() {
    const s = await A('/club');
    main.innerHTML = `<div class="ad-head"><h1>Club settings</h1></div>
      <div class="ad-grid">
        <form class="ad-card ui-form" id="clubForm" novalidate><h2>Club</h2>
          <div class="ad-row">${field('Club name', input('centerName', s.centerName))}${field('Time zone', input('timezone', s.timezone))}</div>
          <div class="ad-row">${field('Free cancellation (hours before)', input('cancelHours', s.cancelHours, 'type="number" min="0" max="168" step="0.5"'))}${field('Minimum notice (minutes)', input('minNoticeMinutes', s.minNoticeMinutes, 'type="number" min="0"'))}</div>
          <div class="ad-row">${field('Players per table', input('maxPlayersPerTable', s.maxPlayersPerTable, 'type="number" min="1" max="8"'))}${field('Guest upcoming bookings (max)', input('maxActiveBookingsPerPhone', s.maxActiveBookingsPerPhone, 'type="number" min="1"'))}</div>
          <h3 class="ui-section">Opening hours</h3>
          ${s.hours.map((d, i) => `<div class="ad-row" data-day="${i}"><label class="ui-check" style="align-self: center"><input type="checkbox" name="open" ${d ? 'checked' : ''}> <span><b>${DOW[i]}</b> open</span></label>
            <input class="ui-input" type="time" step="1800" name="from" value="${d ? d.open : '10:00'}" aria-label="${DOW[i]} opens"><input class="ui-input" type="time" step="1800" name="to" value="${d ? d.close : '22:00'}" aria-label="${DOW[i]} closes"></div>`).join('')}
          <button type="submit" class="ui-btn ui-btn--primary ui-btn--sm">Save club settings</button></form>

        <div style="display: flex; flex-direction: column; gap: var(--space-4)">
          <section class="ad-card"><h2>Tables</h2>
            <div class="ad-table-wrap"><table class="ad-table"><tbody>${s.tables.map(t => `<tr data-table="${t.id}"><td><input class="ui-input" name="name" value="${h(t.name)}" aria-label="Table name"></td>
              <td><select class="ui-input" name="areaId" aria-label="Area">${s.areas.map(a => `<option value="${a.id}" ${a.id === t.areaId ? 'selected' : ''}>${h(a.name)}</option>`).join('')}</select></td>
              <td><div class="ad-checks"><label><input type="checkbox" name="active" ${t.active ? 'checked' : ''}>Active</label></div></td>
              <td><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-save-table="${t.id}">Save</button></td></tr>`).join('')}</tbody></table></div>
            <form class="ui-inline" id="tableForm"><input class="ui-input ui-input--md" name="name" placeholder="New table name" aria-label="New table name">
              <select class="ui-input ui-input--md" name="areaId" aria-label="Area" style="width: auto">${s.areas.map(a => `<option value="${a.id}">${h(a.name)}</option>`).join('')}</select>
              <button type="submit" class="ui-btn ui-btn--secondary">Add</button></form></section>
          <section class="ad-card"><h2>Areas</h2>
            ${s.areas.map(a => `<form class="ad-row" data-area="${a.id}">${input('name', a.name, 'aria-label="Area name"')}${input('description', a.description || '', 'aria-label="Description"')}<button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Save</button></form>`).join('')}
            <form class="ad-row" data-area="">${input('name', '', 'placeholder="New area" aria-label="New area name"')}${input('description', '', 'placeholder="Shown in the app" aria-label="Description"')}<button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Add</button></form></section>
          <section class="ad-card"><h2>Holiday closures</h2>
            ${s.closures.length ? s.closures.map(c => `<div class="ui-card__row"><span><b>${h(dayLabel(c.date))}</b> ${h(c.date)} ${c.reason ? `· ${h(c.reason)}` : ''}</span><button type="button" class="ui-btn ui-btn--ghost ui-btn--sm" data-reopen="${c.date}">Reopen</button></div>`).join('') : '<p class="ad-muted">No closures planned.</p>'}
            <form class="ad-row" id="closeForm">${field('Date', input('date', '', 'type="date" required'))}${field('Reason', input('reason', '', 'placeholder="Holiday"'))}<button type="submit" class="ui-btn ui-btn--secondary ui-btn--sm">Close this day</button></form></section>
        </div>
      </div>`;
    $('#clubForm').onsubmit = async e => {
      e.preventDefault();
      const form = e.target;
      UI.clearErrors(form);
      const hours = [...form.querySelectorAll('[data-day]')].map(r => (r.querySelector('[name="open"]').checked ? { open: r.querySelector('[name="from"]').value, close: r.querySelector('[name="to"]').value } : null));
      try { await busy(form.querySelector('[type="submit"]'), () => A('/club', { method: 'PUT', body: { ...formData(form), hours } })); state.config = await api('/api/config'); UI.toast('Settings saved.', { kind: 'success' }); } catch (err) { fail(err, form); }
    };
    main.querySelectorAll('[data-save-table]').forEach(btn => { btn.onclick = async () => {
      const tr = btn.closest('tr');
      try { await busy(btn, () => A(`/club/tables/${btn.dataset.saveTable}`, { method: 'PUT', body: { name: tr.querySelector('[name="name"]').value, areaId: tr.querySelector('[name="areaId"]').value, active: tr.querySelector('[name="active"]').checked } })); UI.toast('Table saved.', { kind: 'success' }); } catch (err) { fail(err); }
    }; });
    $('#tableForm').onsubmit = async e => { e.preventDefault(); try { await A('/club/tables', { method: 'POST', body: formData(e.target) }); UI.toast('Table added.', { kind: 'success' }); renderSettings(); } catch (err) { fail(err); } };
    main.querySelectorAll('[data-area]').forEach(form => { form.onsubmit = async e => {
      e.preventDefault();
      try { await A(form.dataset.area ? `/club/areas/${form.dataset.area}` : '/club/areas', { method: form.dataset.area ? 'PUT' : 'POST', body: formData(form) }); UI.toast('Area saved.', { kind: 'success' }); renderSettings(); } catch (err) { fail(err, form); }
    }; });
    $('#closeForm').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await A('/club/closures', { method: 'POST', body: formData(e.target) });
        UI.toast(r.affected ? `Day closed. ${r.affected} booking(s) that day still need cancelling (Bookings).` : 'Day closed.', { kind: r.affected ? 'error' : 'success' });
        renderSettings();
      } catch (err) { fail(err, e.target); }
    };
    main.querySelectorAll('[data-reopen]').forEach(b => { b.onclick = () => A(`/club/closures/${b.dataset.reopen}`, { method: 'DELETE' }).then(renderSettings).catch(fail); });
  }

  // ======================= reports =======================
  async function renderReports() {
    const t = state.config.today;
    const range = state.range || { from: addDays(t, -29), to: t };
    const r = await A(`/reports?from=${range.from}&to=${range.to}`);
    const preset = days => `<button type="button" class="ui-chip" data-days="${days}" aria-pressed="${range.from === addDays(range.to, -(days - 1)) && range.to === t}">${days} days</button>`;
    const max = Math.max(1, ...r.revenue.byKind.map(x => x.amount));
    main.innerHTML = `<div class="ad-head"><h1>Reports</h1><div class="ad-tools">${preset(7)}${preset(30)}${preset(90)}
        <input class="ui-input" type="date" id="rFrom" value="${r.from}" aria-label="From"><input class="ui-input" type="date" id="rTo" value="${r.to}" aria-label="To"></div></div>
      <div class="ad-kpis">
        <div class="ad-kpi"><span>Table utilization</span><b>${r.utilization.overall}%</b><small>of open table time</small></div>
        <div class="ad-kpi"><span>Revenue</span><b>${fmt(r.revenue.total)}</b><small>${r.revenue.refunds ? `${fmt(r.revenue.refunds)} refunded` : 'no refunds'}</small></div>
        <div class="ad-kpi"><span>No-show rate</span><b>${r.noShowRate}%</b><small>${r.noShows} of ${r.noShows + r.attended} past bookings</small></div>
        <div class="ad-kpi"><span>Active members</span><b>${r.members.active}</b><small>${r.members.newAccounts} new accounts${r.members.pastDue ? ` · ${r.members.pastDue} past due` : ''}</small></div>
      </div>
      <section class="ad-card" aria-labelledby="utilTitle"><div class="ad-card__head"><h2 id="utilTitle">Utilization by hour</h2><span class="ad-muted">Booked share of open table time, ${h(r.from)} to ${h(r.to)}</span></div>
        <div class="ad-bars" role="img" aria-label="Utilization by hour of day">${r.utilization.byHour.map(x => `<div class="ad-bar" tabindex="0" aria-label="${x.label}: ${x.pct}%"><span class="ad-bar__tip">${x.label} · ${x.pct}%</span><i style="height: ${x.pct}%"></i></div>`).join('')}</div>
        <div class="ad-axis" aria-hidden="true">${r.utilization.byHour.map(x => `<span>${x.hour % 2 === 0 ? x.hour : ''}</span>`).join('')}</div>
        <details><summary class="ad-muted">Show as a table</summary><div class="ad-table-wrap"><table class="ad-table"><thead><tr><th>Hour</th><th>Utilization</th></tr></thead><tbody>${r.utilization.byHour.map(x => `<tr><td>${x.label}</td><td>${x.pct}%</td></tr>`).join('')}</tbody></table></div></details>
      </section>
      <div class="ad-grid">
        <section class="ad-card" aria-labelledby="revTitle"><h2 id="revTitle">Revenue by type</h2>
          ${r.revenue.byKind.length ? `<div class="ad-hbars">${r.revenue.byKind.map(x => `<div class="ad-hbar"><span>${h(x.label)}</span><div class="ad-hbar__track" aria-hidden="true"><i style="width: ${x.amount / max * 100}%"></i></div><b>${fmt(x.amount)}</b></div>`).join('')}</div>` : '<p class="ad-muted">No payments in this period.</p>'}</section>
        <section class="ad-card" aria-labelledby="bkTitle"><h2 id="bkTitle">Bookings</h2>
          <dl class="ad-kv"><dt>Table bookings</dt><dd>${r.bookings.tables}</dd><dt>Lessons</dt><dd>${r.bookings.lessons}</dd><dt>Class seats</dt><dd>${r.bookings.classSeats}</dd><dt>Cancelled</dt><dd>${r.bookings.cancelled}</dd>
          ${r.members.byPlan.map(p => `<dt>${h(p.planId === 'club' ? 'Club' : p.planId === 'pro' ? 'Pro' : p.planId)} members</dt><dd>${p.n}</dd>`).join('')}</dl></section>
      </div>`;
    const go = (from, to) => { state.range = { from, to }; renderReports(); };
    main.querySelectorAll('[data-days]').forEach(b => { b.onclick = () => go(addDays(t, -(Number(b.dataset.days) - 1)), t); });
    $('#rFrom').onchange = $('#rTo').onchange = () => go($('#rFrom').value, $('#rTo').value);
  }

  // ======================= start =======================
  async function start() {
    try {
      state.staff = await A('/me');
    } catch (err) {
      $('#login').hidden = false;
      $('#shell').hidden = true;
      $('#loginLogo').innerHTML = UI.logo({ onNavy: false });
      if (err.status === 403) {
        const alert = $('#loginForm .ui-form__alert');
        alert.textContent = 'This account is not a staff account. Log in with a staff account.';
        alert.hidden = false;
      }
      return;
    }
    state.config = await api('/api/config');
    state.date = state.config.today;
    $('#login').hidden = true;
    $('#shell').hidden = false;
    $('#sideLogo').innerHTML = UI.logo({ onNavy: false, name: state.config.centerName });
    $('#whoami').textContent = state.staff.name;
    $('#nav').innerHTML = SECTIONS.map(s => `<a href="#${s.id}" data-id="${s.id}">${UI.icon(s.icon)}${h(s.label)}</a>`).join('');
    route();
  }

  $('#loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const form = e.target;
    UI.clearErrors(form);
    try {
      await busy($('#loginBtn'), () => Auth.login({ email: $('#lEmail').value, password: $('#lPassword').value }));
      start();
    } catch (err) { UI.showError(form, err); }
  });
  $('#logout').addEventListener('click', async () => { await Auth.logout().catch(() => {}); location.reload(); });

  start();
})();
