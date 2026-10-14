// Items: the things players pick up, carry, swing or shoot, as cards. What an item is comes from the game itself
// (assets.json → items, each mechanic's own declaration; lib/editors/items.js), so a new mechanic's things show here
// with no change to this page. Each card is a picture, a name, what it does, and a few numbers as sliders with plain
// words and the slot's own limits (the rest behind "More").
//
// Writes go through the slot route (POST /api/game/slots/value), where the kit checks the value and refuses in words:
//   a number   saved, then sent to the running game (gf:slot): when the kit takes it live, nothing reloads
//   a table    adding ("like this one"), removing and renaming an entry is one write of the table slot, made with the
//              game's own kit (kit/assets/items.js addLike / removeItem); the game reloads, and a new entry gets its own
//              picture file and its own slots
// Undo writes the old value back the same way. "Ask my session" is for what slots cannot do (a new model from words).
import { addEntry, balanceRequest, itemsOf, liveWords, lookRequest, peersOf, removeEntry, renameEntry, setEntryField, switchOption, takesLive } from '../lib/editors/items.js';
import { askBox, el, slider, swatchRow, useStyles } from '../lib/editors/ui.js';

const ICON = { entry: '➶', single: '◆', switches: '✦' };

export default {
  id: 'items',
  label: 'Items',
  order: 8,
  async mount(root, ctx) {
    useStyles();
    const panel = root.closest('.panel') ?? root;
    // the game's own kit judges and makes table entries (the same file the game, verify and the slots tool use)
    const kit = await import('/game/gf/three/assets/items.js').catch(() => null);

    // ---------- undo: each saved change is a step { id, before, after, label }; undo writes `before` back ----------
    const steps = [], redos = [];
    const undoBtn = el('button', { type: 'button', className: 'ghost', title: 'Undo the last change (Ctrl+Z)', disabled: true }, '↶ Undo');
    const redoBtn = el('button', { type: 'button', className: 'ghost', title: 'Redo (Ctrl+Shift+Z)', disabled: true }, '↷ Redo');
    const refresh = () => { undoBtn.disabled = !steps.length; redoBtn.disabled = !redos.length; };
    async function walk(from, to, side) {
      const s = from.pop(); if (!s) return;
      const row = slots.find(x => x.id === s.slot);
      const ok = await write(s.slot, s[side], `${side === 'before' ? 'Undo' : 'Redo'}: ${s.label}`, { record: false, live: !!row && takesLive(row) });
      (ok ? to : from).push(s);
      refresh();
    }
    undoBtn.addEventListener('click', () => walk(steps, redos, 'before'));
    redoBtn.addEventListener('click', () => walk(redos, steps, 'after'));
    const keys = e => {
      if (panel.hidden || !(e.ctrlKey || e.metaKey) || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); walk(steps, redos, 'before'); } else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); walk(redos, steps, 'after'); }
    };
    window.addEventListener('keydown', keys);

    // ---------- what happened, in plain words (stays across redraws) ----------
    const status = el('div', { className: 'live-note', 'aria-live': 'polite', hidden: true });
    const say = (text, kind = 'ok') => { status.hidden = !text; status.textContent = text ?? ''; status.dataset.kind = kind; };
    const list = el('div', { className: 'cards' });
    root.append(
      el('p', { className: 'muted' }, 'The things players pick up, carry, swing or shoot. Slide a number and let go: the game takes it while it runs, with no reload. A new item, a new name or a colour reloads the game. Every number stays inside what the game allows.'),
      el('div', { className: 'toolbar' }, undoBtn, redoBtn), status, list);

    let slots = [], cards = [], tables = [], open = new Set(), problems = new Map(), renaming = null;

    /**
     * One slot write through the slot route. A number the running game can take is sent to it (gf:slot) and the live
     * reload is held back for it; anything else reloads. Refused: the kit's words, under `where` (a card or the add form).
     * → true when written
     */
    async function write(slot, value, label, { record = true, where = null, live = false } = {}) {
      const file = slots.find(s => s.id === slot)?.file ?? 'config/game.json';
      if (live) ctx.preview.hold([file]);
      let r;
      try { r = await ctx.api('game/slots/value', { id: slot, value }); }
      catch (e) {
        const words = e.problems?.length ? e.problems : [e.message];
        if (where) { problems.set(where, words); paint(); }
        say(`Not saved: ${words.join(' ')}`, 'bad');
        return false;
      }
      if (where) problems.delete(where);
      if (record) { steps.push({ slot, before: r.before, after: r.after, label }); redos.length = 0; refresh(); }
      if (!live) { say(liveWords('saved', label)); return true; }
      const a = await ctx.preview.send({ type: 'gf:slot', id: slot, value: r.after }, { reply: 'gf:slot-applied', timeout: 1500 });
      if (a?.ok && (a.live === 'taken' || a.live === 'on-use')) say(liveWords(a.live, label));
      else { ctx.preview.reload(); say(liveWords(null, label)); }
      return true;
    }
    const tableOf = id => tables.find(t => t.slot.id === id);
    const tableNow = id => { const t = tableOf(id); return Array.isArray(t?.slot.value) ? t.slot.value : null; };

    // ---------- a card ----------
    function card(c) {
      const t = c.table ? tableOf(c.table) : null;
      const pic = c.picture?.type === 'image' ? el('img', { className: 'pic', src: `/game/${c.picture.file}?t=${Date.now()}`, alt: '' })
        : el('div', { className: 'pic', 'aria-hidden': 'true', style: c.colour ? { color: c.colour } : {}, title: c.picture?.type === 'model' ? 'a 3D model' : 'drawn by the kit in its colour' }, ICON[c.kind] ?? '•');
      const field = f => {
        const save = (v, label = `${c.name}: ${f.label}`) => {
          if (f.via) { const tab = tableNow(f.via.table); return tab && write(f.via.table, setEntryField(tab, f.via.index, f.via.field, v).table, label, { where: c.id }); }
          return write(f.id, v, label, { where: c.id, live: takesLive(f) });
        };
        if (f.type === 'boolean') return el('div', { className: 'field' }, el('label', { className: 'field-label' }, el('input', { type: 'checkbox', checked: !!f.value, on: { change: e => save(e.target.checked) } }), ' ', f.label));
        if (f.type === 'color') return el('div', { className: 'field' }, el('label', { className: 'field-label' }, f.label), swatchRow(f.value, v => save(v), { label: f.label }));
        if (f.type === 'enum' || (f.type === 'text' && Array.isArray(f.constraints?.enum))) {
          const opts = f.type === 'enum' ? (f.constraints.options ?? []).map(o => (o && typeof o === 'object' ? o.value : o)) : f.constraints.enum;
          return el('div', { className: 'field' }, el('label', { className: 'field-label' }, f.label), el('select', { on: { change: e => save(e.target.value) } }, ...opts.map(o => el('option', { value: o, selected: String(o) === String(f.value) }, String(o)))));
        }
        const row = slider(f, f.value, (v, done) => { if (done) save(v); }, { compare: peersOf(cards, c, f.field), typed: 'raw' });
        row.querySelector('.field-label')?.append(el('span', { className: 'how muted small', title: takesLive(f) ? 'The running game takes this number without a reload' : 'Saving this reloads the game' }, takesLive(f) ? ' · live' : ' · reloads'));
        return row;
      };
      const head = el('div', { className: 'card-head' }, pic,
        el('div', {}, renaming === c.id ? renameBox(c, t) : el('h4', {}, c.name, c.starts ? el('span', { className: 'badge' }, 'everyone starts with it') : null), el('div', { className: 'what' }, c.what)),
        el('span', { className: 'kind' }, c.noun));
      const words = problems.get(c.id);
      const refused = words ? el('div', { className: 'refused', role: 'alert' }, el('strong', {}, 'Not saved. The game says:'), ...words.map(w => el('div', {}, w))) : null;
      if (c.kind === 'switches') {
        const choices = c.options.map(o => o.id);
        return el('div', { className: 'card', 'data-card': c.id }, head,
          el('div', { className: 'switches' }, ...c.options.map(o => el('label', { className: 'switch-row' },
            el('input', { type: 'checkbox', checked: o.on, on: { change: e => { const tab = tableNow(c.table) ?? []; write(c.table, switchOption(tab, choices, o.id, e.target.checked).table, `${o.name} ${e.target.checked ? 'on' : 'off'}`, { where: c.id }); } } }),
            el('span', {}, el('b', {}, o.name), o.text ? el('small', {}, o.text) : null)))),
          refused);
      }
      const more = c.more.length ? el('details', { className: 'more', open: open.has(c.id), on: { toggle: e => { if (e.target.open) open.add(c.id); else open.delete(c.id); } } }, el('summary', {}, `More (${c.more.length})`), ...c.more.map(field)) : null;
      const btn = (label, fn, extra = {}) => el('button', { type: 'button', className: `ghost small${extra.danger ? ' danger' : ''}`, title: extra.title, disabled: extra.disabled, on: { click: fn } }, label);
      const actions = [];
      if (c.kind === 'entry' && t) {
        if (t.start && !c.starts) actions.push(btn('Start with this one', () => write(t.start.id, c.entryId, `Everyone starts with ${c.name}`, { where: c.id }), { title: `Write ${t.start.id}` }));
        actions.push(btn('Rename', () => { renaming = c.id; paint(); }));
        actions.push(btn(`Add one like this`, () => { addLike.value = c.entryId; addTable.value = c.table; addName.focus(); addBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }));
        const last = t.ids.length <= (t.item.min ?? 0);
        actions.push(btn('Remove', () => removeOne(c, t), { danger: true, disabled: last, title: last ? `A game needs at least ${t.item.min} ${t.item.min === 1 ? t.noun : t.nouns}` : `Take ${c.name} out (Undo puts it back)` }));
      }
      if (c.show) actions.push(btn('See it', () => ctx.preview.show(`/game/?gf-show=${c.show}`)));
      actions.push(btn('Play with it', () => ctx.preview.show('/game/')));
      if (c.picture?.slot && ['model', 'image'].includes(c.picture.type)) actions.push(btn(`New ${c.picture.type === 'model' ? 'model' : 'picture'}…`, () => pickFile(c), { title: `Replace its ${c.picture.type} (the slot ${c.picture.slot})` }));
      actions.push(btn('Ask about it', () => ctx.selection.set({ id: c.picture?.slot ?? c.main[0]?.id ?? c.table ?? c.id, label: c.name }), { title: 'Pick this card to ask your session about it' }));
      return el('div', { className: 'card', 'data-card': c.id }, head, refused, ...c.main.map(field), more, el('div', { className: 'card-actions' }, ...actions));
    }
    function renameBox(c, t) {
      const input = el('input', { type: 'text', value: c.name, maxLength: 32, 'aria-label': `New name for ${c.name}` });
      const done = async () => {
        const r = renameEntry(t.item, tableNow(c.table), c.entryId, input.value);
        if (r.problem) { problems.set(c.id, [r.problem]); renaming = null; paint(); return; }
        renaming = null;
        if (input.value.trim() !== c.name) await write(c.table, r.table, `${c.name} renamed ${input.value.trim()}`, { where: c.id });
        paint();
      };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') done(); else if (e.key === 'Escape') { renaming = null; paint(); } });
      setTimeout(() => { input.focus(); input.select(); }, 0);
      return el('div', { className: 'rename' }, input, el('button', { type: 'button', className: 'small', on: { click: done } }, 'Save'), el('button', { type: 'button', className: 'ghost small', on: { click: () => { renaming = null; paint(); } } }, 'Cancel'));
    }
    async function removeOne(c, t) {
      const r = removeEntry(kit, t.item, tableNow(c.table), c.entryId);
      if (r.problem) { problems.set(c.id, [r.problem]); paint(); return; }
      // the start weapon may not name what is gone: start with the first one left (one more write, undone with it)
      if (t.start && t.start.value === c.entryId) {
        const first = r.table[0]?.[t.item.id ?? 'id'];
        if (first) await write(t.start.id, first, `Everyone starts with ${first}`, { record: false });
      }
      await write(c.table, r.table, `${c.name} removed`, { where: c.id });
    }
    async function pickFile(c) {
      const input = el('input', { type: 'file', accept: c.picture.type === 'model' ? '.glb' : '.png,.jpg,.jpeg,.webp' });
      input.addEventListener('change', async () => {
        const f = input.files[0]; if (!f) return;
        try { await ctx.api(`game/slots/file?id=${encodeURIComponent(c.picture.slot)}&name=${encodeURIComponent(f.name)}`, f); say(`${c.name}: new ${c.picture.type} in. The game reloads to show it. Record its licence in ATTRIBUTION.md.`); }
        catch (e) { say(`Not used: ${e.message}`, 'bad'); }
      });
      input.click();
    }

    // ---------- add an item like an existing one: the kit makes the entry, the table slot takes it ----------
    const addTable = el('select', { 'aria-label': 'What kind of item' });
    const addLike = el('select', { 'aria-label': 'Like which one' });
    const addName = el('input', { type: 'text', placeholder: 'its name, e.g. Foam sword', 'aria-label': 'The new item\'s name', maxLength: 32 });
    const addBtn = el('button', { type: 'button' }, 'Add it');
    const addNote = el('div', { className: 'muted small' });
    const addBox = el('div', { className: 'ask-box add-box', 'data-add': '1' },
      el('label', { className: 'ask-label' }, 'Add an item'),
      el('div', { className: 'toolbar' }, addTable, el('span', { className: 'muted small' }, 'like'), addLike),
      el('div', { className: 'ask-row' }, addName, addBtn), addNote);
    const fillLikes = () => {
      const t = tableOf(addTable.value), was = addLike.value;
      const named = cards.filter(c => c.table === t?.slot.id && c.kind === 'entry');
      addLike.replaceChildren(...named.map(c => el('option', { value: c.entryId }, c.name)));
      if (named.some(c => c.entryId === was)) addLike.value = was;
      addNote.textContent = t ? `${t.ids.length} of at most ${t.item.max ?? '∞'} ${t.nouns}. The new one is a copy of the one it is like, with its own name, numbers and picture file${t.item.picture?.library ? ` (no model of its own yet: it gets the library's ${t.item.picture.library})` : ''}. The game reloads with it.` : '';
    };
    addTable.addEventListener('change', fillLikes);
    const add = async () => {
      const t = tableOf(addTable.value);
      if (!t || !kit) return;
      const r = addEntry(kit, t.item, tableNow(t.slot.id), { like: addLike.value || null, name: addName.value });
      if (r.problem) { problems.set('add', [r.problem]); paint(); return; }
      addBtn.disabled = true;
      const ok = await write(t.slot.id, r.table, `${r.entry[t.item.name ?? 'name']} added`, { where: 'add' });
      addBtn.disabled = false;
      if (ok) { addName.value = ''; await render(); document.querySelector(`[data-card="${CSS.escape(`${t.slot.id}:${r.entry[t.item.id ?? 'id']}`)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
    };
    addBtn.addEventListener('click', add);
    addName.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
    const addRefused = el('div');

    // ---------- ask my session: what slots cannot do ----------
    const askFrom = el('select', { 'aria-label': 'Which item' });
    const lookBox = askBox(ctx, {
      label: 'A new look from words',
      placeholder: 'e.g. a soft blue foam sword with a yellow handle',
      button: 'Ask my session to make it',
      compose: words => { const c = cards.find(x => x.id === askFrom.value) ?? cards[0]; return lookRequest(c, words, c?.table ? tableOf(c.table) : null); },
      selection: () => { const c = cards.find(x => x.id === askFrom.value); return c ? { id: c.picture?.slot ?? c.table ?? c.id, label: c.name } : null; },
    });
    lookBox.insertBefore(el('div', { className: 'toolbar' }, askFrom), lookBox.children[1]);
    const balanceBox = askBox(ctx, {
      label: 'Balance…',
      placeholder: 'the aim, e.g. the big pillow should be slow but worth it',
      button: 'Ask my session to balance it',
      compose: goal => balanceRequest(cards.find(c => c.id === askFrom.value) ?? cards[0], goal),
    });
    const sessionPart = el('div', {}, el('h3', {}, 'Ask your session'), el('p', { className: 'muted small' }, 'For what the page cannot do by itself: a new model or picture drawn from your words, or a judgement about balance. Your session does it and the card changes here when it lands.'),
      lookBox, el('div', { style: { height: '10px' } }), balanceBox);

    function paint() {
      const groups = [];
      for (const t of tables) {
        const mine = cards.filter(c => c.table === t.slot.id);
        groups.push(el('h3', {}, `${t.nouns.replace(/^./, x => x.toUpperCase())} `, el('span', { className: 'muted small' }, `${t.ids.length} of at most ${t.item.max ?? '∞'}`)), ...mine.map(card));
      }
      const singles = cards.filter(c => !c.table);
      if (singles.length) groups.push(el('h3', {}, 'Other things'), ...singles.map(card));
      if (!cards.length) groups.push(el('div', { className: 'card muted' }, kit ? 'This game has no items (pickups, things to carry, weapons, drops).' : 'This game was made before items were data, so the page cannot list them. Ask your session to run "npx gamesfun upgrade" on it; its items show here after that.'));
      const words = problems.get('add');
      addRefused.replaceChildren(...(words ? [el('div', { className: 'refused', role: 'alert' }, el('strong', {}, 'Not added. The game says:'), ...words.map(w => el('div', {}, w)))] : []));
      list.replaceChildren(...groups, ...(tables.some(t => t.item.schema?.properties) ? [addBox, addRefused] : []));
    }
    async function render() {
      const r = await ctx.api('game/slots?all=1');
      slots = r.slots;
      ({ cards, tables } = itemsOf(slots, r.items));
      const objectTables = tables.filter(t => t.item.schema?.properties);
      const was = addTable.value;
      addTable.replaceChildren(...objectTables.map(t => el('option', { value: t.slot.id }, `a ${t.noun}`)));
      if (objectTables.some(t => t.slot.id === was)) addTable.value = was;
      addBtn.disabled = !kit;
      fillLikes();
      const wasAsk = askFrom.value;
      askFrom.replaceChildren(...cards.filter(c => c.kind !== 'switches').map(c => el('option', { value: c.id }, c.name)));
      if (cards.some(c => c.id === wasAsk)) askFrom.value = wasAsk;
      paint();
    }
    root.append(sessionPart);
    await render();
    let t = null;
    const offGame = ctx.on('game', ({ files = [] }) => { if (files.length && files.every(f => f.startsWith('evidence/'))) return; clearTimeout(t); t = setTimeout(render, 250); });
    return () => { offGame(); window.removeEventListener('keydown', keys); };
  },
};
