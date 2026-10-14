// What the three editors (Map, Skins, Items) share on the page: one look and one set of habits.
//   select → a palette or picker → a property card → undo → see it in the preview → "ask my session" with a picture back.
// Plain DOM, no build. The pure logic each editor runs is beside this file (paint.js, layout.js, skins.js, items.js).
import { sessionApi } from '../session-client.js';
import { fieldRange, clampField } from './items.js';
import { SWATCHES } from './skins.js';

export const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'on') { for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); continue; }
    if (k === 'style' && typeof v === 'object') { Object.assign(e.style, v); continue; }
    (k in e && k !== 'list' && !k.startsWith('aria-') && !k.startsWith('data-')) ? (e[k] = v) : e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter(k => k != null && k !== false));
  return e;
};

/** The editors' stylesheet, once per page. */
export function useStyles() {
  if (document.querySelector('link[data-editors]')) return;
  document.head.append(el('link', { rel: 'stylesheet', href: '/studio/editors.css', 'data-editors': '1' }));
}

/** Undo and Redo buttons for a history (history.js), with Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or Y) while the panel is
 *  shown. apply(state) draws a state. → { bar, refresh() } */
export function undoBar(history, apply, panel) {
  const undo = el('button', { type: 'button', className: 'ghost', title: 'Undo (Ctrl+Z)' }, '↶ Undo');
  const redo = el('button', { type: 'button', className: 'ghost', title: 'Redo (Ctrl+Shift+Z)' }, '↷ Redo');
  const refresh = () => { undo.disabled = !history.canUndo; redo.disabled = !history.canRedo; };
  undo.addEventListener('click', () => { apply(history.undo()); refresh(); });
  redo.addEventListener('click', () => { apply(history.redo()); refresh(); });
  const key = e => {
    if (panel.hidden || !(e.ctrlKey || e.metaKey) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); apply(history.undo()); refresh(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); apply(history.redo()); refresh(); }
  };
  window.addEventListener('keydown', key);
  refresh();
  return { bar: [undo, redo], refresh, off: () => window.removeEventListener('keydown', key) };
}

/**
 * "Ask my session": the studio has ONE box for the person's own agent session, the conversation's on the left
 * (builder/studio/chat.js). An editor hands it a context: what the request is about (label), a placeholder, and compose(words)
 * → what the session is told. The page calls no model: the session does the work and the result lands in the game's
 * files, which the editor shows when they change. With no conversation on the page (a test page), a box of its own.
 */
export function askBox(ctx, { label, placeholder, compose, selection = () => null, button = 'Ask my session', onSent = () => {} }) {
  if (ctx.chat?.ask) {
    const go = el('button', { type: 'button', className: 'ghost', on: { click: () => ctx.chat.ask({ label, placeholder, compose, selection, button, onSent }) } }, button);
    return el('div', { className: 'ask-box ask-handoff' }, el('div', { className: 'ask-label' }, label), el('div', { className: 'ask-row' }, go, el('span', { className: 'muted small' }, 'You type it in the conversation, on the left.')));
  }
  const box = el('textarea', { className: 'ask', rows: 2, placeholder, 'aria-label': label });
  const send = el('button', { type: 'button' }, button);
  const state = el('div', { className: 'ask-state muted small', 'aria-live': 'polite' });
  send.addEventListener('click', async () => {
    const words = box.value.trim();
    if (!words) { box.focus(); return; }
    send.disabled = true;
    try {
      const r = await sessionApi('request', { text: compose(words), selection: selection() ?? undefined });
      state.textContent = r.session ? 'Sent. Your session has it; the change shows here when it lands.' : 'Waiting for your agent session: it gets this as soon as one is connected.';
      state.dataset.state = 'sent';
      box.value = '';
      onSent(r);
    } catch (e) { state.textContent = `Not sent: ${e.message}`; state.dataset.state = 'error'; }
    finally { send.disabled = false; }
  });
  return el('div', { className: 'ask-box' }, el('label', { className: 'ask-label' }, label), box, el('div', { className: 'ask-row' }, send, state));
}

/** A number as a slider with a plain label, its unit and its range (the slot's own min and max: never past them).
 *  typed: 'raw' sends a number typed in the box as it is, so the kit can refuse one outside the range in its own words
 *  (the slider itself still stops at the ends); the default holds it inside the range. */
export function slider(slot, value, onChange, { compare = null, typed = 'clamp' } = {}) {
  const r = fieldRange(slot), unit = slot.constraints?.unit ?? '';
  const num = el('input', { type: 'number', value: value ?? '', step: r?.step ?? (slot.type === 'integer' ? 1 : 'any'), 'aria-label': `${slot.label} value` });
  const kids = [];
  let range = null;
  if (r) {
    range = el('input', { type: 'range', min: r.min, max: r.max, step: r.step, value: value ?? r.min, 'aria-label': slot.label });
    num.min = r.min; num.max = r.max;
    range.addEventListener('input', () => { num.value = range.value; onChange(clampField(slot, range.value), false); });
    range.addEventListener('change', () => onChange(clampField(slot, range.value), true));
    kids.push(range);
  }
  num.addEventListener('change', () => {
    const n = Number(num.value);
    if (typed === 'raw' && Number.isFinite(n) && num.value.trim() !== '') { onChange(slot.type === 'integer' ? Math.round(n) : n, true); return; }
    const v = clampField(slot, num.value); num.value = v; if (range) range.value = v; onChange(v, true);
  });
  const ends = r ? el('span', { className: 'ends muted small' }, `${r.min}–${r.max}${unit ? ` ${unit}` : ''}`) : unit ? el('span', { className: 'muted small' }, unit) : null;
  const bar = compare?.length ? el('span', { className: 'peers muted small' }, 'Others: ', compare.map(p => `${p.name} ${p.value}${unit ? ` ${unit}` : ''}`).join(' · ')) : null;
  return el('div', { className: 'field' }, el('label', { className: 'field-label' }, slot.label), el('div', { className: 'field-edit' }, ...kids, num, ends), bar);
}

/** A colour from a small palette first, a free picker second ("More…"). onPick(colour). */
export function swatchRow(current, onPick, { swatches = SWATCHES, label = 'Colour' } = {}) {
  const row = el('div', { className: 'swatches', role: 'group', 'aria-label': label });
  for (const c of swatches) row.append(el('button', { type: 'button', className: 'swatch', title: c, 'aria-label': c, 'aria-pressed': String(c === current), style: { background: c }, on: { click: () => onPick(c) } }));
  const more = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(current ?? '') ? current : '#ffffff', title: 'Any colour', 'aria-label': 'Any colour' });
  more.addEventListener('change', () => onPick(more.value));
  row.append(el('label', { className: 'swatch-more', title: 'Any colour' }, more, 'More…'));
  return row;
}

/** Call fn(shown) when the tab's panel is shown or hidden (the shell toggles `hidden`); the editors lay their view over
 *  the preview only while their tab is the one shown. → off() */
export function onShown(panel, fn) {
  const mo = new MutationObserver(() => fn(!panel.hidden));
  mo.observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  return () => mo.disconnect();
}

/** An image's pixels (for the kit's picture judge, which runs in the page). → { width, height, data } */
export async function pixelsOf(url) {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data, img };
}
