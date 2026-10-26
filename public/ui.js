// Rally Club UI helpers (Phase 1 foundation). Pairs with components.css.
// Markup helpers return HTML strings; widget helpers render into a container and
// handle clicks and keyboard. No dependencies, works on the website and in Capacitor.
(function () {
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------- icons: the stroke set used across the design screens (24px grid, 2px stroke) ----------
  const ICONS = {
    back: '<path d="M15 18l-6-6 6-6"/>',
    forward: '<path d="M9 18l6-6-6-6"/>',
    'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
    check: '<path d="M5 12l5 5L20 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    home: '<path d="M3 10.5L12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    table: '<rect x="2" y="7" width="20" height="9" rx="1.5"/><path d="M12 7v9M5 16v4M19 16v4"/>',
    coach: '<circle cx="12" cy="7" r="4"/><path d="M5 21v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2"/>',
    users: '<circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 20v-1a5 5 0 0 1 10 0v1M15 20v-1a4 4 0 0 1 6-3.4"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4M16 2v4M3 10h18"/>',
    profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4l2.5 2.5"/>',
    share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>',
    gift: '<path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    list: '<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    logout: '<path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H4"/>',
    // The Rally Club mark: a paddle seen side-on
    mark: '<circle cx="10" cy="10" r="6.5"/><path d="M14.6 14.6 L20 20"/>',
  };

  function icon(name, { size, label, cls = '' } = {}) {
    const a11y = label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true" focusable="false"';
    const dim = size ? ` width="${size}" height="${size}"` : '';
    return `<svg class="ui-icon ${cls}"${dim} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" ${a11y}>${ICONS[name] || ''}</svg>`;
  }

  // <span data-ui-icon="bell"></span> → the icon
  function hydrate(root = document) {
    root.querySelectorAll('[data-ui-icon]').forEach(el => { el.outerHTML = icon(el.dataset.uiIcon); });
  }

  // ---------- button ----------
  // UI.button({ label, variant: 'primary', size: 'md', iconLeft, iconRight, block, href, disabled, loading, type, id, attrs })
  function button(o = {}) {
    const cls = ['ui-btn', `ui-btn--${o.variant || 'primary'}`, `ui-btn--${o.size || 'md'}`];
    if (o.block) cls.push('ui-btn--block');
    if (o.iconOnly) cls.push('ui-btn--icon');
    if (o.loading) cls.push('is-loading');
    if (o.cls) cls.push(o.cls);
    const inner = `${o.iconLeft ? icon(o.iconLeft) : ''}${o.iconOnly ? icon(o.iconOnly) : `<span>${esc(o.label)}</span>`}${o.iconRight ? icon(o.iconRight) : ''}`;
    const id = o.id ? ` id="${esc(o.id)}"` : '';
    const aria = o.iconOnly ? ` aria-label="${esc(o.label)}"` : '';
    const extra = o.attrs ? ' ' + o.attrs : '';
    if (o.href) {
      return `<a class="${cls.join(' ')}" href="${esc(o.href)}"${id}${aria}${o.disabled ? ' aria-disabled="true" tabindex="-1"' : ''}${extra}>${inner}</a>`;
    }
    const busy = o.loading ? ' aria-busy="true"' : '';
    return `<button type="${o.type || 'button'}" class="${cls.join(' ')}"${id}${aria}${o.disabled || o.loading ? ' disabled' : ''}${busy}${extra}>${inner}</button>`;
  }

  // Loading keeps the width (label stays in the layout, transparent) and disables the button.
  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
    btn.setAttribute('aria-busy', String(loading));
  }

  function iconButton({ icon: name, label, dot = false, href, id } = {}) {
    const inner = `${icon(name)}${dot ? '<span class="ui-icon-btn__dot" aria-hidden="true"></span>' : ''}`;
    const idAttr = id ? ` id="${esc(id)}"` : '';
    const name2 = dot ? `${label}, unread` : label;
    return href
      ? `<a class="ui-icon-btn" href="${esc(href)}" aria-label="${esc(name2)}"${idAttr}>${inner}</a>`
      : `<button type="button" class="ui-icon-btn" aria-label="${esc(name2)}"${idAttr}>${inner}</button>`;
  }

  // ---------- keyboard: arrow keys move between options in a group (roving focus) ----------
  function rove(container, selector) {
    container.addEventListener('keydown', e => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys) && e.key !== 'Home' && e.key !== 'End') return;
      const items = [...container.querySelectorAll(selector)].filter(el => !el.disabled);
      const i = items.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + keys[e.key] + items.length) % items.length;
      items[next].focus();
      if (container.dataset.selectOnFocus === 'true') items[next].click();
    });
  }

  // Remembers a widget on its element: later calls swap the options and re-render.
  function mount(el, get, put, render) {
    const ctl = { set(v) { get().value = v; render(); }, get: () => get().value };
    el.__ui = next => { put(next); render(); return ctl; };
    return ctl;
  }

  // ---------- date strip ----------
  // UI.dateStrip(el, { days: [{ value, dow, num, disabled }], value, onChange, label, cls })
  function dateStrip(el, opts) {
    // Calling it again on the same element updates it (no second set of listeners)
    if (el.__ui) return el.__ui(opts);
    let o = opts;
    const render = () => {
      el.className = `ui-datestrip${o.cls ? ` ${o.cls}` : ''}`;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', o.label || 'Date');
      el.innerHTML = o.days.map(d => `<button type="button" class="ui-date" data-value="${esc(d.value)}"
          aria-pressed="${d.value === o.value}" ${d.disabled ? 'disabled' : ''} aria-label="${esc(d.aria || `${d.dow} ${d.num}`)}">
          <span class="ui-date__dow">${esc(d.dow)}</span><span class="ui-date__num">${esc(d.num)}</span></button>`).join('');
    };
    render();
    el.addEventListener('click', e => {
      const b = e.target.closest('.ui-date');
      if (!b || b.disabled) return;
      o.value = b.dataset.value;
      render();
      el.querySelector(`[data-value="${CSS.escape(o.value)}"]`).focus();
      if (o.onChange) o.onChange(o.value);
    });
    rove(el, '.ui-date');
    return mount(el, () => o, next => { o = next; }, render);
  }

  // ---------- segmented control / tabs ----------
  // UI.segmented(el, { options: [{ value, label }], value, onChange, label, tabs: false })
  function segmented(el, opts) {
    // Calling it again on the same element updates it (no second set of listeners)
    if (el.__ui) return el.__ui(opts);
    let o = opts;
    const render = () => {
      el.className = 'ui-segmented';
      el.setAttribute('role', o.tabs ? 'tablist' : 'group');
      el.setAttribute('aria-label', o.label || 'Options');
      el.dataset.selectOnFocus = o.tabs ? 'true' : 'false';
      el.innerHTML = o.options.map(opt => {
        const on = opt.value === o.value;
        const state = o.tabs ? `role="tab" aria-selected="${on}" tabindex="${on ? 0 : -1}"` : `aria-pressed="${on}"`;
        return `<button type="button" class="ui-segment" data-value="${esc(opt.value)}" ${state} ${opt.disabled ? 'disabled' : ''}>${esc(opt.label)}</button>`;
      }).join('');
    };
    render();
    el.addEventListener('click', e => {
      const b = e.target.closest('.ui-segment');
      if (!b || b.disabled || b.dataset.value === String(o.value)) return;
      o.value = o.options.find(x => String(x.value) === b.dataset.value).value;
      render();
      el.querySelector(`[data-value="${CSS.escape(String(o.value))}"]`).focus();
      if (o.onChange) o.onChange(o.value);
    });
    rove(el, '.ui-segment');
    return mount(el, () => o, next => { o = next; }, render);
  }

  // ---------- start-time slots ----------
  // UI.slots(el, { slots: [{ time, full, peak }], value, onChange })
  function slots(el, opts) {
    // Calling it again on the same element updates it (no second set of listeners)
    if (el.__ui) return el.__ui(opts);
    let o = opts;
    const render = () => {
      el.className = 'ui-slots';
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', o.label || 'Start time');
      el.innerHTML = o.slots.map(s => {
        const label = `${s.time}${s.peak ? ', peak' : ''}${s.full ? ', full' : ''}`;
        return `<button type="button" class="ui-slot" data-value="${esc(s.time)}" aria-label="${esc(label)}"
          ${s.full ? 'disabled' : `aria-pressed="${s.time === o.value}"`}>${esc(s.time)}${s.peak && !s.full && s.time !== o.value ? '<span class="ui-slot__peak" aria-hidden="true"></span>' : ''}</button>`;
      }).join('');
    };
    render();
    el.addEventListener('click', e => {
      const b = e.target.closest('.ui-slot');
      if (!b || b.disabled) return;
      o.value = b.dataset.value;
      render();
      el.querySelector(`[data-value="${CSS.escape(o.value)}"]`).focus();
      if (o.onChange) o.onChange(o.value);
    });
    rove(el, '.ui-slot');
    return mount(el, () => o, next => { o = next; }, render);
  }

  // ---------- option rows (payment method): a radiogroup ----------
  // UI.options(el, { options: [{ value, title, sub }], value, onChange, label })
  function options(el, opts) {
    // Calling it again on the same element updates it (no second set of listeners)
    if (el.__ui) return el.__ui(opts);
    let o = opts;
    const render = () => {
      el.setAttribute('role', 'radiogroup');
      el.setAttribute('aria-label', o.label || 'Options');
      el.dataset.selectOnFocus = 'true';
      el.innerHTML = o.options.map(opt => {
        const on = opt.value === o.value;
        return `<button type="button" class="ui-option" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-value="${esc(opt.value)}">
          <span class="ui-option__radio" aria-hidden="true"></span>
          <span class="ui-option__text"><span class="ui-option__title">${esc(opt.title)}</span>${opt.sub ? `<span class="ui-option__sub">${esc(opt.sub)}</span>` : ''}</span></button>`;
      }).join('');
    };
    render();
    el.addEventListener('click', e => {
      const b = e.target.closest('.ui-option');
      if (!b || b.dataset.value === o.value) return;
      o.value = b.dataset.value;
      render();
      el.querySelector(`[data-value="${CSS.escape(o.value)}"]`).focus();
      if (o.onChange) o.onChange(o.value);
    });
    rove(el, '.ui-option');
    return mount(el, () => o, next => { o = next; }, render);
  }

  // ---------- pressed-state chips (filters, skill level) ----------
  // UI.chips(el, { options: [{ value, label }], value, onChange, multi: false, block: false })
  function chips(el, opts) {
    // Calling it again on the same element updates it (no second set of listeners)
    if (el.__ui) return el.__ui(opts);
    let o = opts;
    // Exposes the current value on the element so forms can read it.
    const sync = () => { el.dataset.value = o.multi ? o.value.join(',') : o.value; };
    const selected = () => (o.multi ? o.value : [o.value]);
    const render = () => {
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', o.label || 'Filters');
      el.innerHTML = o.options.map(opt => `<button type="button" class="ui-chip${o.block ? ' ui-chip--block' : ''}" data-value="${esc(opt.value)}"
        aria-pressed="${selected().includes(opt.value)}">${esc(opt.label)}</button>`).join('');
      sync();
    };
    render();
    el.addEventListener('click', e => {
      const b = e.target.closest('.ui-chip');
      if (!b) return;
      const v = b.dataset.value;
      if (o.multi) o.value = o.value.includes(v) ? o.value.filter(x => x !== v) : [...o.value, v];
      else o.value = v;
      render();
      el.querySelector(`[data-value="${CSS.escape(v)}"]`).focus();
      if (o.onChange) o.onChange(o.value);
    });
    return mount(el, () => o, next => { o = next; }, render);
  }

  // ---------- toast ----------
  function toast(message, { kind = 'info', timeout = 3200 } = {}) {
    let host = document.querySelector('.ui-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'ui-toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    const t = document.createElement('div');
    t.className = `ui-toast ui-toast--${kind}`;
    t.innerHTML = `<span class="ui-toast__dot" aria-hidden="true"></span><span>${esc(message)}</span>`;
    host.appendChild(t);
    setTimeout(() => { t.classList.add('is-leaving'); setTimeout(() => t.remove(), 200); }, timeout);
    return t;
  }

  // ---------- QR placeholder (real signed code arrives with check-in in Phase 4) ----------
  function qrPlaceholder(seed = 'RC', cells = 21) {
    let h = 2166136261;
    for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    const rand = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
    const finder = (x, y) => [[0, 0], [cells - 7, 0], [0, cells - 7]].some(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
    const inFinder = (x, y) => {
      for (const [fx, fy] of [[0, 0], [cells - 7, 0], [0, cells - 7]]) {
        if (x >= fx && x < fx + 7 && y >= fy && y < fy + 7) {
          const dx = x - fx, dy = y - fy;
          return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
        }
      }
      return false;
    };
    let rects = '';
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const on = finder(x, y) ? inFinder(x, y) : rand() > 0.52;
        if (on) rects += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
      }
    }
    return `<svg viewBox="0 0 ${cells} ${cells}" fill="var(--ink)" shape-rendering="crispEdges" role="img" aria-label="Check-in QR code">${rects}</svg>`;
  }

  // The logo lockup: white tile with the navy mark, and the name
  function logo({ name = 'Rally Club', onNavy = true } = {}) {
    return `<span class="ui-logo${onNavy ? ' ui-logo--on-navy' : ''}"><span class="ui-logo__tile">${icon('mark')}</span><span class="ui-logo__name">${esc(name)}</span></span>`;
  }

  // ---------- form errors ----------
  // Shows a message under the field (aria-invalid + aria-describedby); clears with clearErrors.
  function fieldError(input, message) {
    const field = input.closest('.ui-field') || input.parentElement;
    let el = field.querySelector('.ui-field__error');
    if (!el) {
      el = document.createElement('span');
      el.className = 'ui-field__error';
      el.id = `${input.id || input.name || 'f' + Math.random().toString(36).slice(2)}-error`;
      field.appendChild(el);
    }
    el.textContent = message;
    input.setAttribute('aria-invalid', 'true');
    const ids = new Set((input.getAttribute('aria-describedby') || '').split(' ').filter(Boolean));
    ids.add(el.id);
    input.setAttribute('aria-describedby', [...ids].join(' '));
  }

  // A field's error goes away as soon as the person edits it.
  document.addEventListener('input', e => {
    const input = e.target;
    if (!(input instanceof HTMLElement) || input.getAttribute('aria-invalid') !== 'true') return;
    input.removeAttribute('aria-invalid');
    const field = input.closest('.ui-field');
    const err = field && field.querySelector('.ui-field__error');
    if (err) err.remove();
  });

  function clearErrors(root) {
    root.querySelectorAll('.ui-field__error').forEach(el => el.remove());
    root.querySelectorAll('[aria-invalid="true"]').forEach(el => el.removeAttribute('aria-invalid'));
    root.querySelectorAll('.ui-form__alert').forEach(el => { el.hidden = true; });
  }

  // Maps an API error to the field it names (error.field), else shows it in the form's alert.
  function showError(form, err, fields = {}) {
    const input = err.field && (fields[err.field] || form.querySelector(`[name="${err.field}"]`));
    if (input) {
      fieldError(input, err.message);
      input.focus();
      return;
    }
    const alert = form.querySelector('.ui-form__alert');
    if (alert) { alert.textContent = err.message; alert.hidden = false; alert.focus(); } else toast(err.message, { kind: 'error' });
  }

  window.UI = { icon, hydrate, button, setLoading, iconButton, dateStrip, segmented, slots, options, chips, toast, qrPlaceholder, logo, esc, fieldError, clearErrors, showError };
  hydrate();
})();
