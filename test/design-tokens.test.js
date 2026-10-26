const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PUBLIC = path.join(__dirname, '..', 'public');
const tokensCss = fs.readFileSync(path.join(PUBLIC, 'tokens.css'), 'utf8');

// Resolve --name to a #RRGGBB value, following var() references.
function token(name, seen = new Set()) {
  if (seen.has(name)) throw new Error(`token loop at ${name}`);
  seen.add(name);
  const m = new RegExp(`${name}:\\s*([^;]+);`).exec(tokensCss);
  assert.ok(m, `token ${name} is defined`);
  const value = m[1].trim();
  const ref = /^var\((--[\w-]+)\)$/.exec(value);
  return ref ? token(ref[1], seen) : value;
}

function luminance(hex) {
  const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test('spec palette values are exact', () => {
  const spec = {
    '--navy-900': '#0B1F3A', '--navy-700': '#13305C', '--navy-500': '#1E3A8A', '--white': '#FFFFFF',
    '--bg-app': '#F4F6FA', '--surface-2': '#EEF2F8', '--track': '#E6EBF2', '--line': '#E2E8F0',
    '--muted': '#5B6B82', '--on-navy-muted': '#C7D2E3', '--orange': '#F97316', '--orange-text': '#C2410C',
    '--orange-100': '#FFEDD5', '--orange-50': '#FFF7ED', '--green': '#15803D', '--red': '#B91C1C', '--red-200': '#FECACA',
  };
  for (const [name, hex] of Object.entries(spec)) assert.equal(token(name).toUpperCase(), hex, name);
});

test('every text colour pair meets WCAG AA (4.5:1)', () => {
  const pairs = [
    ['--text', '--surface'], ['--text', '--bg'], ['--text-muted', '--surface'], ['--text-muted', '--bg'],
    ['--text-muted', '--surface-2'], ['--ink-2', '--track'], ['--white', '--navy-900'], ['--white', '--navy-700'],
    ['--on-navy-muted', '--navy-900'], ['--accent-text', '--surface'], ['--orange-ink', '--orange-100'],
    ['--orange-ink-strong', '--orange-50'], ['--ink', '--navy-tint'], ['--success', '--success-bg'],
    ['--danger', '--danger-bg'], ['--danger', '--surface'], ['--ink', '--orange'], ['--white', '--orange-text'],
    ['--peach', '--navy-900'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
  }
});

test('disabled "full" slots keep the design colours, above 3:1', () => {
  // WCAG 1.4.3 exempts inactive controls; a full slot is a disabled, struck-through button.
  const ratio = contrast(token('--slot-full-ink'), token('--slot-full-bg'));
  assert.ok(ratio >= 3, `full slot text is ${ratio.toFixed(2)}:1`);
});

test('no raw colours outside tokens.css', () => {
  const offenders = [];
  for (const file of fs.readdirSync(PUBLIC)) {
    if (file === 'tokens.css' || !/\.(css|js|html)$/.test(file)) continue;
    const lines = fs.readFileSync(path.join(PUBLIC, file), 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/name="theme-color"/.test(line)) return; // a meta tag can't read CSS variables
      const code = line.replace(/&#\d+;/g, '');
      if (/#[0-9a-fA-F]{3,8}\b(?![\w-])/.test(code) && !/href="#|#[a-z]+[A-Z]?\w*['"`)]/.test(code)) offenders.push(`${file}:${i + 1}`);
      if (/rgba?\(/.test(code)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
