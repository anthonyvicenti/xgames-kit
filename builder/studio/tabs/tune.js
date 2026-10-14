// Tune: the numbers, switches and choices a game exposes as value slots, as sliders and boxes. No code box.
// Every change writes the slot's config file; the dev server then reloads the preview (tune.js lib: "reload").
// Edits are staged, and "Apply" writes them all at once, so the preview reloads once.
import { APPLIES, pendingChanges, sliderRange, tunables } from '../lib/tune.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) (k in e && k !== 'list') ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(k => k != null));
  return e;
};

export default {
  id: 'tune',
  label: 'Tune',
  order: 12,
  async mount(root, ctx) {
    let slots = [], staged = {}, busy = false;
    const apply = el('button', { type: 'button', disabled: true }, 'Apply');
    const reset = el('button', { type: 'button', className: 'ghost', disabled: true }, 'Undo my edits');
    const count = el('span', { className: 'muted small' });
    const body = el('div');
    root.append(
      el('p', { className: 'muted' }, 'Numbers and switches the game exposes. Edit as many as you like, then Apply: the preview reloads once with all of them. Nothing here changes a round that is already running.'),
      el('div', { className: 'toolbar' }, apply, reset, count), body);

    const refreshButtons = () => {
      const n = pendingChanges(slots, staged).length;
      apply.disabled = reset.disabled = !n || busy;
      count.textContent = n ? `${n} change${n === 1 ? '' : 's'} waiting` : '';
    };
    function stage(s, value) { staged[s.id] = value; refreshButtons(); }

    function control(s) {
      const cur = s.id in staged ? staged[s.id] : s.value;
      if (s.type === 'boolean') {
        const i = el('input', { type: 'checkbox', checked: !!cur, 'aria-label': s.label });
        i.addEventListener('change', () => stage(s, i.checked));
        return [i];
      }
      if (s.type === 'enum') {
        const sel = el('select', { 'aria-label': s.label });
        for (const o of s.constraints?.options ?? []) { const val = o && typeof o === 'object' ? o.value : o; sel.append(el('option', { value: String(val), selected: String(val) === String(cur) }, o?.label ?? String(val))); }
        sel.addEventListener('change', () => stage(s, sel.value));
        return [sel];
      }
      const range = sliderRange(s);
      const num = el('input', { type: 'number', value: cur ?? '', step: s.type === 'integer' ? 1 : 'any', 'aria-label': `${s.label} value` });
      if (range) { num.min = range.min; num.max = range.max; }
      if (!range) { num.addEventListener('change', () => stage(s, num.value)); return [num, s.constraints?.unit ? el('span', { className: 'muted' }, s.constraints.unit) : null]; }
      const sl = el('input', { type: 'range', min: range.min, max: range.max, step: range.step, value: cur ?? range.min, 'aria-label': s.label });
      sl.addEventListener('input', () => { num.value = sl.value; stage(s, sl.value); });
      num.addEventListener('change', () => { sl.value = num.value; stage(s, num.value); });
      return [sl, num, s.constraints?.unit ? el('span', { className: 'muted' }, s.constraints.unit) : null];
    }

    async function render() {
      try {
        const r = await ctx.api('game/slots');
        slots = r.slots;
        const groups = new Map(r.groups.map(g => [g.id, g.label]));
        const list = tunables(slots);
        body.replaceChildren();
        if (!list.length) body.append(el('p', { className: 'muted empty' }, 'This game exposes no numbers to tune. Ask your session to add some, or use the Slots tab for pictures, models and sounds.'));
        let cur;
        for (const s of list) {
          if (s.group !== cur) { cur = s.group; body.append(el('h3', {}, groups.get(cur) ?? cur ?? 'Other')); }
          body.append(el('div', { className: 'row tune' },
            // a reload is every value's default (the intro says so): only a value the game takes live says it on its row
            el('div', { className: 'name', title: APPLIES[s.applies] }, s.label, el('small', {}, s.applies === 'live' ? `${s.id} · ${APPLIES.live}` : s.id)),
            el('div', { className: 'edit' }, ...control(s))));
        }
        refreshButtons();
      } catch (e) { body.replaceChildren(el('p', { className: 'error-box' }, e.message)); }
    }
    apply.addEventListener('click', async () => {
      const changes = pendingChanges(slots, staged);
      busy = true; refreshButtons();
      try {
        for (const c of changes) await ctx.api('game/slots/value', c);
        ctx.toast(`Applied ${changes.length}: the preview reloads`, 'ok');
        staged = {};
      } catch (e) { ctx.toast(e.message, 'error'); }
      busy = false; await render();
    });
    reset.addEventListener('click', () => { staged = {}; render(); });
    await render();
    let t = null;
    return ctx.on('game', ({ files = [] }) => {
      if (files.length && files.every(f => f.startsWith('evidence/'))) return;
      clearTimeout(t); t = setTimeout(() => { if (!Object.keys(staged).length) render(); }, 250);
    });
  },
};
