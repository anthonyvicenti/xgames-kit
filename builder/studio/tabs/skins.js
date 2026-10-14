// Skins: how the players look. Pick a body, pick each seat's colour from a small palette (any colour behind "More…"),
// see it turn in the preview before anything is saved (the kit's own loadout input), then Save. A 2D game's body is a
// picture sheet: its six frames, a little animation, the kit's picture judge, and "draw me a …" through the person's
// own session (the art tool), with the new picture shown beside the old one to keep or put back.
// Everything is written through slots: character.tint.player, character.body.player, character.height.player.
import { createHistory } from '../lib/editors/history.js';
import { MOVES, bodyChoices, drawRequest, lookAlike, modelRequest, setSeat, sheetFrames, showingRole, tryOnLoadout, tryOnPath } from '../lib/editors/skins.js';
import { askBox, el, onShown, pixelsOf, swatchRow, undoBar, useStyles } from '../lib/editors/ui.js';

export default {
  id: 'skins',
  label: 'Skins',
  order: 7,
  async mount(root, ctx) {
    useStyles();
    const panel = root.closest('.panel') ?? root;
    let slots = (await ctx.api('game/slots?all=1')).slots;
    const slot = id => slots.find(s => s.id === id);
    const body = slot('character.body.player');
    const tint = slot('character.tint.player');
    if (!body) { root.textContent = 'This game has no player body slot (character.body.player).'; return; }
    const flat = body.type === 'image';
    const history = createHistory({ seats: Array.isArray(tint?.value) ? tint.value : [] });
    let saved = JSON.stringify(history.current), seat = 0, shown = !panel.hidden;
    const cur = () => history.current;
    let keepOld = null, worldStyle = null, repaintFlat = () => {};       // set by the 2D body below

    // ---------- try it on: the preview wears the look before it is saved ----------
    const tryon = el('div', { className: 'tryon', hidden: true }, el('span', {}, 'Trying it on in the preview. Not saved yet.'));
    const saveBtn = el('button', { type: 'button' }, 'Save the look');
    const resetBtn = el('button', { type: 'button', className: 'ghost' }, 'Put it back');
    tryon.append(saveBtn, resetBtn);
    // the preview shows the turning player wearing the look (CONTRACT §6e). Once it is showing, a new look is handed to
    // it as a message (gf:loadout) and the subject is made again in place, with no reload; the first time, or when the
    // game does not answer, the preview loads with the look in its address (?gf-loadout=)
    let tries = 0;
    const showTryOn = async () => {
      if (!shown) return;
      const colour = cur().seats[seat], mine = ++tries;
      let search = ''; try { search = ctx.preview.frame.contentWindow.location.search; } catch {}
      if (!showingRole(search, 'player')) { ctx.preview.show(tryOnPath('player', { colour })); return; }
      // the subject says it wore it by counting up snapshot().look.restyled (the kit's show mode)
      const look = () => { try { return ctx.preview.frame.contentWindow.__game?.snapshot?.()?.look ?? null; } catch { return null; } };
      const before = look();
      ctx.preview.send({ type: 'gf:loadout', loadout: tryOnLoadout({ colour }) });
      for (let i = 0; i < 30 && mine === tries; i++) {
        await new Promise(r => setTimeout(r, 100));
        const now = look();
        if (before && now && (now.restyled > before.restyled || now.key !== before.key)) return;
      }
      if (mine === tries) ctx.preview.show(tryOnPath('player', { colour }));
    };
    const dirty = () => { const d = JSON.stringify(cur()) !== saved; tryon.hidden = !d; };
    const { bar: undoBtns, refresh: refreshUndo, off: offKeys } = undoBar(history, () => { paintSeats(); dirty(); showTryOn(); repaintFlat(); }, panel);
    const stage = next => { history.push(next); refreshUndo(); paintSeats(); dirty(); showTryOn(); repaintFlat(); };
    saveBtn.addEventListener('click', async () => {
      try { const r = await ctx.api('game/slots/value', { id: 'character.tint.player', value: cur().seats }); saved = JSON.stringify(cur()); dirty(); ctx.toast(`Saved the seat colours (${r.after.length}). Every player sees them.`, 'ok'); }
      catch (e) { ctx.toast(e.message, 'error'); }
    });
    resetBtn.addEventListener('click', () => { history.push(JSON.parse(saved)); refreshUndo(); paintSeats(); dirty(); showTryOn(); });

    // ---------- seat colours ----------
    const seatsEl = el('div', { className: 'seats', role: 'group', 'aria-label': 'Seat colours' });
    const swatchEl = el('div');
    const alikeEl = el('div', { className: 'muted small' });
    function paintSeats() {
      const list = cur().seats, alike = lookAlike(list), close = new Set(alike.flat());
      seatsEl.replaceChildren(...list.map((c, i) => el('button', { type: 'button', className: `seat${close.has(i) ? ' alike' : ''}`, 'aria-pressed': String(i === seat), title: c, on: { click: () => { seat = i; paintSeats(); showTryOn(); repaintFlat(); } } }, el('i', { style: { background: c } }), `Player ${i + 1}`)));
      swatchEl.replaceChildren(swatchRow(list[seat], c => stage({ ...cur(), seats: setSeat(cur().seats, seat, c) }), { label: `Player ${seat + 1}'s colour` }));
      alikeEl.textContent = alike.length ? `Players ${alike.map(([a, b]) => `${a + 1} and ${b + 1}`).join(', ')} look alike: friends may mix them up.` : '';
    }

    root.append(
      el('p', { className: 'muted' }, flat ? 'How the players look: their picture and their colours. Light parts of the picture take each player\'s colour.' : 'How the players look: their body and their colours. Try a look in the preview, then save it.'),
      el('div', { className: 'toolbar' }, ...undoBtns, el('button', { type: 'button', className: 'ghost', on: { click: () => ctx.preview.show(tryOnPath('player', { colour: cur().seats[seat] })) } }, '⟳ Show it turning')),
      tryon);
    if (tint) root.append(el('h3', {}, 'Colours, one a player'), seatsEl, swatchEl, alikeEl);

    // ---------- the body ----------
    const bodyEl = el('div');
    root.append(el('h3', {}, flat ? 'The picture' : 'Body'), bodyEl);
    const offBody = flat ? await flatBody(bodyEl) : await modelBody(bodyEl);

    root.append(el('h3', {}, 'Ask your session'), askBox(ctx, {
      label: flat ? 'Draw me…' : 'Make me…',
      placeholder: flat ? 'e.g. a small knight in blue armour with a feather on the helmet' : 'e.g. a robot with round eyes and stubby legs',
      button: flat ? 'Ask my session to draw it' : 'Ask my session',
      compose: words => (flat ? drawRequest({ slot: 'character.body.player', subject: words, style: worldStyle, plane: ctx.game.plane ?? null }) : modelRequest({ slot: 'character.body.player', subject: words })),
      selection: () => ({ id: 'character.body.player', label: body.label ?? 'Player character' }),
      onSent: () => { keepOld?.(); },
    }));

    // ---------- a 3D body: the library's, each with its picture ----------
    async function modelBody(host) {
      const grid = el('div', { className: 'bodies' }), note = el('p', { className: 'muted small' });
      const undoBody = el('button', { type: 'button', className: 'ghost small', hidden: true }, '↶ Put the last body back');
      let last = null;      // the bytes the slot held before the last swap
      async function paint() {
        const r = await ctx.api('editors/bodies');
        const list = bodyChoices(r.bodies, { current: r.current });
        grid.replaceChildren(...list.map(b => el('button', { type: 'button', className: 'body-pick', 'aria-pressed': String(b.current), title: b.describe, on: { click: () => swap(b, r.bodies.find(x => x.id === b.id)) } },
          b.preview ? el('img', { src: b.preview, alt: '', loading: 'lazy' }) : el('div', { className: 'pic' }, '?'), b.label, b.current ? el('span', { className: 'now' }, 'wearing now') : null)));
        note.textContent = `${list.length} bodies from the kit's library (CC0: free to ship). A body is swapped at once and the preview shows it; "Put the last body back" undoes it.`;
      }
      async function swap(b, raw) {
        try {
          if (!last) last = { bytes: await (await fetch(`/game/${body.file}?t=${Date.now()}`)).arrayBuffer(), height: slot('character.height.player')?.value ?? null };
          const bytes = await (await fetch(raw.file)).arrayBuffer();
          await ctx.api(`game/slots/file?id=character.body.player&name=${encodeURIComponent(raw.id)}.glb`, bytes);
          if (b.height && slot('character.height.player')) await ctx.api('game/slots/value', { id: 'character.height.player', value: Math.round(b.height * 100) / 100 });
          ctx.toast(`${b.label}: on. The preview reloads with it.`, 'ok');
          undoBody.hidden = false; await paint(); showTryOn();
        } catch (e) { ctx.toast(e.message, 'error'); }
      }
      undoBody.addEventListener('click', async () => {
        if (!last) return;
        try {
          await ctx.api('game/slots/file?id=character.body.player&name=body.glb', last.bytes);
          if (last.height != null) await ctx.api('game/slots/value', { id: 'character.height.player', value: last.height });
          last = null; undoBody.hidden = true; ctx.toast('The last body is back.', 'ok'); await paint(); showTryOn();
        } catch (e) { ctx.toast(e.message, 'error'); }
      });
      host.append(grid, el('div', { className: 'toolbar' }, undoBody), note);
      await paint();
      return () => {};
    }

    // ---------- a 2D body: the picture sheet ----------
    async function flatBody(host) {
      const judgeMod = await import('/game/gf/three/flat/judge.js').catch(() => null);
      const world = await (await fetch(`/game/config/world.json?t=${Date.now()}`)).json().catch(() => ({}));
      worldStyle = world.style ?? 'pixel';
      const sheetEl = el('div', { className: 'sheet' }), animEl = el('div', { className: 'anim' }), judgeEl = el('div', { className: 'judge' }), compareEl = el('div');
      const anim = el('canvas', { width: 128, height: 128, 'aria-label': 'The character moving' });
      const moveSel = el('select', { 'aria-label': 'Which move' }, ...Object.keys(MOVES).map(m => el('option', { value: m }, m)));
      moveSel.value = 'walk';
      const upload = el('input', { type: 'file', accept: '.png', hidden: true });
      const uploadBtn = el('button', { type: 'button', className: 'ghost' }, 'Use my own picture…');
      uploadBtn.addEventListener('click', () => upload.click());
      animEl.append(anim, el('label', { className: 'small' }, 'Move ', moveSel), uploadBtn, upload);
      host.append(animEl, sheetEl, judgeEl, compareEl);
      let pic = null, frames = [], timer = null, oldBytes = null, oldUrl = null;
      // the picture as the game draws it for this player: its colours multiplied by the player's (light parts take it)
      const tinted = (g, f, size) => {
        g.clearRect(0, 0, size, size); g.imageSmoothingEnabled = worldStyle !== 'pixel';
        g.globalCompositeOperation = 'source-over'; g.drawImage(pic.img, f.x, f.y, f.w, f.h, 0, 0, size, size);
        const c = cur().seats[seat];
        if (c) { g.globalCompositeOperation = 'multiply'; g.fillStyle = c; g.fillRect(0, 0, size, size); g.globalCompositeOperation = 'destination-in'; g.drawImage(pic.img, f.x, f.y, f.w, f.h, 0, 0, size, size); }
        g.globalCompositeOperation = 'source-over';
      };
      repaintFlat = () => { if (pic) { drawSheet(); } };
      const drawSheet = () => sheetEl.replaceChildren(...frames.filter(f => f.row === 0).map(f => {
        const c = el('canvas', { width: 64, height: 64, className: worldStyle === 'pixel' ? 'pixel' : '' });
        tinted(c.getContext('2d'), f, 64);
        return el('figure', {}, c, f.name);
      }));

      async function load() {
        pic = await pixelsOf(`/game/${body.file}?t=${Date.now()}`);
        frames = sheetFrames(pic.width, pic.height);
        drawSheet();
        const verdict = judgeMod?.judge?.('body', pic, { style: worldStyle, plane: ctx.game.plane ?? world.plane ?? 'side' });
        lastVerdict = verdict;
        judgeEl.replaceChildren(verdict ? el('div', {}, el('span', { className: verdict.ok ? 'ok' : 'bad' }, verdict.ok ? '✓ The kit\'s picture judge passes this sheet' : '✕ The kit\'s picture judge refuses this sheet'),
          ...verdict.errors.slice(0, 4).map(e => el('div', { className: 'bad' }, `${e.frame ? `${e.frame}: ` : ''}${e.message}`)), ...verdict.warnings.slice(0, 2).map(w => el('div', { className: 'muted' }, w.message))) : el('span', { className: 'muted' }, 'No picture judge in this game.'));
        play();
      }
      function play() {
        clearInterval(timer);
        const names = MOVES[moveSel.value] ?? MOVES.walk, g = anim.getContext('2d');
        let i = 0;
        const step = () => { const f = frames.find(x => x.row === 0 && x.name === names[i % names.length]); if (f) tinted(g, f, 128); i++; };
        step(); timer = setInterval(step, 160);
      }
      moveSel.addEventListener('change', play);
      // the picture before a request: kept so the new one can be shown beside it, and put back with one click
      keepOld = async () => { try { oldBytes = await (await fetch(`/game/${body.file}?t=${Date.now()}`)).arrayBuffer(); oldUrl = URL.createObjectURL(new Blob([oldBytes], { type: 'image/png' })); } catch {} };
      upload.addEventListener('change', async () => {
        const f = upload.files[0]; upload.value = ''; if (!f) return;
        const url = URL.createObjectURL(f), mine = await pixelsOf(url);
        const v = judgeMod?.judge?.('body', mine, { style: worldStyle, plane: ctx.game.plane ?? 'side' });
        if (v && !v.ok) { ctx.toast(`Not used: ${v.errors.map(e => e.message).slice(0, 2).join('; ')}`, 'error'); return; }
        await keepOld();
        try { await ctx.api(`game/slots/file?id=character.body.player&name=${encodeURIComponent(f.name)}`, f); ctx.toast('Your picture is on. The preview reloads with it.', 'ok'); }
        catch (e) { ctx.toast(e.message, 'error'); }
      });
      let lastVerdict = null;
      async function offer() {
        if (!oldUrl) return;
        const refused = lastVerdict && !lastVerdict.ok;
        compareEl.replaceChildren(el('div', { className: 'card' },
          el('div', { className: `judge ${refused ? 'bad' : 'ok'}` }, refused ? 'Your session\'s picture is in, but the kit\'s picture judge refuses it (above): put the old one back, or ask again with what to change.' : 'Your session\'s picture is in and the judge passes it. Keep it?'),
          el('div', { className: 'compare' }, el('figure', {}, el('img', { src: oldUrl, alt: '', style: { width: '100%', imageRendering: worldStyle === 'pixel' ? 'pixelated' : 'auto' } }), 'before'), el('figure', {}, el('img', { src: `/game/${body.file}?t=${Date.now()}`, alt: '', style: { width: '100%', imageRendering: worldStyle === 'pixel' ? 'pixelated' : 'auto' } }), 'new')),
          el('div', { className: 'card-actions' },
            el('button', { type: 'button', className: refused ? 'ghost' : '', on: { click: () => { compareEl.replaceChildren(); oldUrl = null; ctx.toast('Kept the new picture.', 'ok'); } } }, 'Keep the new one'),
            el('button', { type: 'button', className: refused ? '' : 'ghost', on: { click: async () => { try { await ctx.api('game/slots/file?id=character.body.player&name=body.png', oldBytes); compareEl.replaceChildren(); oldUrl = null; ctx.toast('The old picture is back.', 'ok'); } catch (e) { ctx.toast(e.message, 'error'); } } } }, 'Put the old one back'))));
      }
      await load();
      const off = ctx.on('game', async ({ files = [] }) => { if (!files.length || files.includes(body.file)) { await load(); offer(); } });
      return () => { clearInterval(timer); off(); };
    }

    paintSeats(); dirty();
    const offShown = onShown(panel, s => { shown = s; if (s) showTryOn(); });
    if (shown) showTryOn();
    const offGame = ctx.on('game', async ({ files = [] }) => {
      if (files.length && !files.some(f => f.startsWith('config/') || f === 'assets.json')) return;
      slots = (await ctx.api('game/slots?all=1')).slots;
      const theirs = { seats: Array.isArray(slot('character.tint.player')?.value) ? slot('character.tint.player').value : [] };
      if (JSON.stringify(theirs) !== saved && JSON.stringify(cur()) === saved) { saved = JSON.stringify(theirs); history.push(theirs); refreshUndo(); paintSeats(); dirty(); }
    });
    return () => { offShown(); offGame(); offKeys(); offBody?.(); };
  },
};
