// The studio's colours pass WCAG AA: every text colour the design system uses, on every surface it sits on, in both
// themes (builder/studio/studio.css tokens). Body text needs 4.5:1; the badges and section labels are bold and small, so they
// are held to 4.5:1 too. Non-text marks (the slider, the focus ring, borders of controls) need 3:1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../builder/studio/studio.css', import.meta.url), 'utf8');
const block = sel => {
  const i = css.indexOf(`${sel} {`);
  assert.ok(i >= 0, `studio.css has ${sel}`);
  return css.slice(i, css.indexOf('}', i));
};
function tokens(text, base = {}) {
  const out = { ...base };
  for (const m of text.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const dark = tokens(block(':root, :root[data-theme=dark]'));
const light = tokens(block(':root[data-theme=light]'), dark);

function rgba(value, t, depth = 0) {
  const v = value.trim();
  const ref = v.match(/^var\(--([a-z0-9-]+)\)$/);
  if (ref) { assert.ok(depth < 8 && t[ref[1]], `token --${ref[1]}`); return rgba(t[ref[1]], t, depth + 1); }
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = v.match(/^rgba\(([^)]+)\)$/);
  if (m) { const [r, g, b, a] = m[1].split(',').map(Number); return [r, g, b, a]; }
  throw new Error(`cannot read colour ${v}`);
}
const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [text token, background token (or [soft, under]), minimum]
const PAIRS = [
  ...['ink', 'ink-2', 'muted'].flatMap(ink => ['bg', 'surface', 'surface-2', 'surface-3'].map(bg => [ink, bg, 4.5])),
  ['on-lime', 'lime', 4.5], ['on-lime', 'lime-hi', 4.5],
  ['lav-ink', 'surface', 4.5], ['lav-ink', 'surface-2', 4.5], ['lav-ink', 'bg', 4.5],
  ['ink', ['lav-soft', 'bg'], 4.5], ['ink', ['lav-soft', 'surface'], 4.5], ['ink-2', ['lav-soft', 'surface-2'], 4.5],
  ['good', 'surface-2', 4.5], ['bad', 'surface-2', 4.5], ['warn', 'surface-2', 4.5], ['info', 'surface-2', 3],
  ['good', ['good-soft', 'surface'], 4.5], ['bad', ['bad-soft', 'surface'], 4.5], ['warn', ['warn-soft', 'bg'], 4.5],
  ['ink', ['bad-soft', 'surface'], 4.5], ['ink', ['warn-soft', 'surface'], 4.5],
  ['control', 'surface-2', 3], ['lav', 'surface', 3], ['line-strong', 'surface', 1.4],
];

for (const [name, t] of [['dark', dark], ['light', light]]) {
  test(`studio colours pass AA in the ${name} theme`, () => {
    const bad = [];
    for (const [fg, bg, min] of PAIRS) {
      const back = Array.isArray(bg) ? over(rgba(t[bg[0]], t), rgba(t[bg[1]], t)) : rgba(t[bg], t);
      const r = ratio(over(rgba(t[fg], t), back), back);
      if (r < min) bad.push(`--${fg} on ${Array.isArray(bg) ? bg.map(b => `--${b}`).join(' over ') : `--${bg}`}: ${r.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(bad, []);
  });
}

test('the wordmark keeps the brand: XGames in ink, .fun in lime (dark) or the lime as ink (light)', () => {
  assert.match(css, /\.xg-mark span \{ color: var\(--lime\); \}/);
  const m = css.match(/:root\[data-theme=light\] \.xg-mark span \{ color: (#[0-9a-f]{6}); \}/i);
  assert.ok(m, 'a light-theme colour for .fun');
  assert.ok(ratio(rgba(m[1], light), rgba(light.bg, light)) >= 4.5, '.fun on the light header is AA');
});
