// Slots & assets: every model, texture and value the game shows (its assets.json). Change a value or replace a file
// here and the game reloads with it: no code change (rules R1–R5 in AGENTS.md).
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) (k in e && k !== 'list') ? (e[k] = v) : e.setAttribute(k, v);
  e.append(...kids.filter(k => k != null));
  return e;
};
const ACCEPT = { model: '.glb', image: '.png,.jpg,.jpeg,.webp', texture: '.ktx2,.hdr', audio: '.ogg,.mp3,.wav,.m4a', font: '.ttf,.otf,.woff,.woff2', data: '.json' };
const ext = f => String(f).split('.').pop().toLowerCase();

export default {
  id: 'assets',
  label: 'Slots & assets',
  order: 10,
  async mount(root, ctx) {
    let all = false, busy = false;
    const head = el('div', { className: 'toolbar' });
    const toggle = el('label', {}, el('input', { type: 'checkbox' }), ' every slot (advanced too)');
    toggle.firstChild.addEventListener('change', e => { all = e.target.checked; render(); });
    const count = el('span', { className: 'muted' });
    head.append(toggle, count);
    const body = el('div');
    root.append(
      el('p', { className: 'muted' }, 'Everything the players see is a slot. Change one here (or with ', el('code', {}, 'npx gamesfun slots set'), ') and the game reloads with it.'),
      head, body);

    async function save(id, value) {
      try { const r = await ctx.api('game/slots/value', { id, value }); ctx.toast(`${id}: ${JSON.stringify(r.before)} → ${JSON.stringify(r.after)}`, 'ok'); }
      catch (e) { ctx.toast(e.message, 'error'); render(); }
    }
    async function upload(slot, file) {
      try {
        const r = await ctx.api(`game/slots/file?id=${encodeURIComponent(slot.id)}&name=${encodeURIComponent(file.name)}`, file);
        ctx.toast(`${slot.id}: replaced (${Math.round(r.bytes / 1024)} KB). Record its licence in ATTRIBUTION.md.`, 'ok');
      } catch (e) { ctx.toast(e.message, 'error'); }
    }

    function editor(s) {
      const c = s.constraints ?? {};
      if (s.kind === 'file') {
        const pick = el('input', { type: 'file', accept: ACCEPT[s.type] ?? `.${ext(s.file)}`, hidden: true });
        pick.addEventListener('change', () => { if (pick.files[0]) upload(s, pick.files[0]); pick.value = ''; });
        const btn = el('button', { type: 'button', className: 'ghost' }, 'Replace…');
        btn.addEventListener('click', () => pick.click());
        const thumb = ['png', 'jpg', 'jpeg', 'webp'].includes(ext(s.file)) ? el('img', { className: 'thumb', src: `/game/${s.file}?t=${Date.now()}`, alt: '' }) : null;
        const size = el('span', { className: 'muted mono' }, s.missing ? 'missing' : `${Math.max(1, Math.round((s.bytes ?? 0) / 1024))} KB`);
        return [thumb, size, btn, pick];
      }
      if (s.kind !== 'value') return [el('span', { className: 'muted' }, '(not editable here)')];
      const v = s.value;
      switch (s.type) {
        case 'color': {
          const i = el('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000' });
          i.addEventListener('change', () => save(s.id, i.value));
          return [el('span', { className: 'mono muted' }, String(v ?? '')), i];
        }
        case 'number': case 'integer': {
          const i = el('input', { type: 'number', value: v ?? '', step: s.type === 'integer' ? 1 : 'any' });
          if (typeof c.min === 'number') i.min = c.min;
          if (typeof c.max === 'number') i.max = c.max;
          i.addEventListener('change', () => save(s.id, i.value));
          return [i, c.unit ? el('span', { className: 'muted' }, c.unit) : null];
        }
        case 'boolean': {
          const i = el('input', { type: 'checkbox', checked: !!v });
          i.addEventListener('change', () => save(s.id, i.checked));
          return [i];
        }
        case 'enum': {
          const sel = el('select');
          for (const o of c.options ?? []) { const val = o && typeof o === 'object' ? o.value : o; sel.append(el('option', { value: String(val), selected: String(val) === String(v) }, o?.label ?? String(val))); }
          sel.addEventListener('change', () => save(s.id, sel.value));
          return [sel];
        }
        case 'text': {
          if (Array.isArray(c.enum)) {
            const sel = el('select');
            for (const o of c.enum) sel.append(el('option', { value: o, selected: o === v }, o));
            sel.addEventListener('change', () => save(s.id, sel.value));
            return [sel];
          }
          const i = el('input', { type: 'text', value: v ?? '' });
          if (c.maxLength) i.maxLength = c.maxLength;
          i.addEventListener('change', () => save(s.id, i.value));
          return [i];
        }
        case 'colors': {
          const i = el('input', { type: 'text', value: Array.isArray(v) ? v.join(', ') : '' , title: 'colours, comma separated' });
          i.addEventListener('change', () => save(s.id, i.value));
          return [i];
        }
        default: return [el('span', { className: 'mono muted' }, JSON.stringify(v)?.slice(0, 40) ?? '')];
      }
    }

    async function render() {
      if (busy) return; busy = true;
      try {
        const r = await ctx.api(`game/slots${all ? '?all=1' : ''}`);
        const groups = new Map(r.groups.map(g => [g.id, g.label]));
        const showOf = new Map();
        for (const s of r.showcase ?? []) for (const id of s.slots ?? []) showOf.set(id, s.query);
        count.textContent = `${r.slots.length} of ${r.total} slots`;
        body.replaceChildren();
        let cur;
        for (const s of r.slots) {
          if (s.group !== cur) { cur = s.group; body.append(el('h3', {}, groups.get(cur) ?? cur ?? 'Other')); }
          const name = el('div', { className: 'name pick', tabIndex: 0, role: 'button', title: 'Pick this to ask your session about it', 'aria-pressed': String(ctx.selection.get()?.id === s.id) }, s.label ?? s.id, el('small', {}, `${s.id} · ${s.type}${s.scope === 'player' ? ' · per player' : ''}`));
          const pickIt = () => { const on = ctx.selection.get()?.id === s.id; ctx.selection.set(on ? null : { id: s.id, label: s.label ?? s.id }); };
          name.addEventListener('click', pickIt);
          name.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickIt(); } });
          const show = showOf.get(s.id);
          const kids = editor(s);
          if (show) { const b = el('button', { type: 'button', className: 'ghost', title: 'Show it in the preview' }, 'Show'); b.addEventListener('click', () => ctx.preview.show(`/game/${show}`)); kids.unshift(b); }
          body.append(el('div', { className: 'row' }, name, el('div', { className: 'edit' }, ...kids)));
        }
      } catch (e) { body.replaceChildren(el('p', { className: 'error-box' }, e.message)); }
      finally { busy = false; }
    }
    await render();
    let t = null;
    const offSel = ctx.selection.onChange(sel => { for (const n of body.querySelectorAll('.pick')) n.setAttribute('aria-pressed', String(n.querySelector('small')?.textContent.split(' · ')[0] === sel?.id)); });
    const offGame = ctx.on('game', ({ files = [] }) => {
      if (files.length && files.every(f => f.startsWith('evidence/'))) return;
      clearTimeout(t); t = setTimeout(render, 200);
    });
    return () => { offSel(); offGame(); };
  },
};
