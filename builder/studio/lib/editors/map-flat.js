// The map painter (a flat game's tile map, the slot world.map), laid over the preview while the Map tab is shown.
// Paint, box, fill, pick and erase; start spots and marks; undo; the kit's own checks as you paint (a ledge or a coin no
// jump reaches turns red); "Save & play" writes the slot and the game reloads with the map. No model is called: "ask my
// session" puts the words in the person's own session's queue.
import { createHistory } from './history.js';
import { charFor, checkMap, entryAt, fillCells, gridOf, jumpShade, lineCells, paintCells, paletteOf, rectCells, resizeGrid, withGrid } from './paint.js';
import { askBox, el, onShown, undoBar } from './ui.js';

const TOOLS = [
  { id: 'paint', label: 'Paint', key: 'b', icon: '✎', hint: 'Click or drag to paint. Right-click erases.' },
  { id: 'box', label: 'Box', key: 'r', icon: '▭', hint: 'Drag a box to fill it.' },
  { id: 'fill', label: 'Fill', key: 'f', icon: '◧', hint: 'Fill every joined cell of the same kind.' },
  { id: 'pick', label: 'Pick', key: 'i', icon: '⌖', hint: 'Click a cell to paint with what it holds.' },
  { id: 'erase', label: 'Erase', key: 'e', icon: '⌫', hint: 'Click or drag to empty cells.' },
];

export async function mountPainter(root, ctx, slotList) {
  const kit = { ...(await import('/game/gf/three/flat/index.js')), ...(await import('/game/gf/three/flat/tilemap.js')), SIDE: (await import('/game/gf/three/flat/slots.js')).SIDE };
  const fetchJson = async f => (await fetch(`/game/${f}?t=${Date.now()}`, { cache: 'no-store' })).json();
  let world = await fetchJson('config/world.json'), gameCfg = await fetchJson('config/game.json'), look = await fetchJson('config/look.json').catch(() => ({}));
  const seats = Math.max(2, Number(ctx.game.players?.max ?? 4));

  // pictures: each tile kind's slot, each mark's prop slot (a mark "coin" is drawn with prop.coin)
  const slotFile = id => slotList.slots.find(s => s.id === id)?.file ?? null;
  const images = new Map();
  let thumbTimer = null;
  const picture = file => {
    if (!file) return null;
    if (!images.has(file)) { const im = new Image(); im.src = `/game/${file}?t=${Date.now()}`; im.onload = () => { draw(); clearTimeout(thumbTimer); thumbTimer = setTimeout(() => paintPalette(), 50); }; images.set(file, im); }
    return images.get(file);
  };
  const tilesOf = () => Object.fromEntries(Object.keys(world.map.kinds ?? {}).map(k => [k, slotFile(`world.tiles.${k}`)]));
  const marksOf = () => Object.fromEntries(slotList.slots.filter(s => /^prop\.[a-z0-9-]+$/.test(s.id)).map(s => [s.id.slice(5), s.file]));

  const history = createHistory(world.map);
  let saved = JSON.stringify(world.map);
  let tool = 'paint', brush = null, hover = null, drag = null, editing = true, check = null, showReach = true;
  const map = () => history.current;

  // ---------- the side panel ----------
  const toolBtns = TOOLS.map(t => el('button', { type: 'button', className: 'tool', title: `${t.label} (${t.key.toUpperCase()}): ${t.hint}`, 'aria-pressed': 'false', on: { click: () => setTool(t.id) } }, el('span', { className: 'ico' }, t.icon), t.label));
  const paletteEl = el('div', { className: 'palette', role: 'listbox', 'aria-label': 'What to paint' });
  const status = el('div', { className: 'checks', 'aria-live': 'polite' });
  const saveBtn = el('button', { type: 'button', title: 'Write the map to the game and play it' }, '▶ Save & play');
  const editBtn = el('button', { type: 'button', className: 'ghost', title: 'Back to painting' }, '✎ Edit');
  const revert = el('button', { type: 'button', className: 'ghost', title: 'Throw away what is not saved' }, 'Discard changes');
  const clear = el('button', { type: 'button', className: 'ghost danger hold', title: 'Hold for a second and a half to empty the whole map (Undo brings it back)' }, el('span', { className: 'fillbar' }), 'Hold to clear');
  const size = el('span', { className: 'muted small mono' });
  const sizeBtns = [['cols', -1, '− column'], ['cols', 1, '+ column'], ['rows', -1, '− row'], ['rows', 1, '+ row']].map(([k, d, label]) => el('button', { type: 'button', className: 'ghost small', on: { click: () => resize(k, d) } }, label));
  const reachToggle = el('label', { className: 'small' }, el('input', { type: 'checkbox', checked: true, on: { change: e => { showReach = e.target.checked; draw(); } } }), ' show where a jump lands');
  const { bar: undoBtns, refresh: refreshUndo, off: offKeys } = undoBar(history, () => { recheck(); draw(); paintPalette(); }, root.closest('.panel') ?? root);

  root.append(
    el('p', { className: 'muted' }, 'Paint the level right on the game. Red means a player cannot get there. Save & play to try it; Edit to come back.'),
    el('div', { className: 'toolbar' }, saveBtn, editBtn, ...undoBtns),
    el('div', { className: 'tools', role: 'toolbar', 'aria-label': 'Tools' }, ...toolBtns),
    el('h3', {}, 'Paint with'), paletteEl,
    el('h3', {}, 'Is it playable?'), status,
    el('h3', {}, 'Size'), el('div', { className: 'toolbar' }, size, ...sizeBtns),
    el('div', { className: 'toolbar' }, reachToggle),
    el('h3', {}, 'Ask your session'),
    askBox(ctx, {
      label: 'Say what to change, in your words',
      placeholder: 'e.g. add a high ledge on the left with two coins, and a gap in the middle floor',
      compose: words => `Change this game's level (the tile map, slot world.map in config/world.json → map, format gf-tilemap-1): ${words}. Keep the same kinds and legend where you can. Every ledge, coin and start spot must stay reachable (the kit's reach check: node builder/tools/flat-map.mjs <game>; the studio's Map tab shows red where not). After writing the map run that tool with --sync.`,
      selection: () => ({ id: 'world.map', label: 'Tile map' }),
    }),
    el('div', { className: 'toolbar end' }, revert, clear));

  function setTool(id) { tool = id; toolBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(TOOLS[i].id === id))); canvas.style.cursor = id === 'pick' ? 'copy' : 'crosshair'; }
  function paintPalette() {
    const items = paletteOf(map(), { tiles: tilesOf(), marks: marksOf() });
    if (brush === null || !items.some(p => p.entry === brush.entry)) brush = items[0];
    paletteEl.replaceChildren();
    let group = null;
    for (const p of items) {
      if (p.group !== group) { group = p.group; }
      const thumb = el('canvas', { width: 32, height: 32, className: 'thumb' });
      drawThumb(thumb.getContext('2d'), p, 32);
      const kind = p.group === 'tiles' ? (p.solid === 'top' ? 'a ledge: stand on it, jump up through it' : p.solid ? 'solid' : 'drawn only') : p.note ?? '';
      const b = el('button', { type: 'button', role: 'option', className: 'swatch-item', 'aria-selected': String(brush?.entry === p.entry), title: kind, on: { click: () => { brush = p; if (tool === 'erase' || tool === 'pick') setTool('paint'); paintPalette(); } } },
        thumb, el('span', {}, p.label, el('small', {}, kind)));
      paletteEl.append(b);
    }
  }
  function drawThumb(g, p, s) {
    g.clearRect(0, 0, s, s);
    if (p.entry === null) { g.strokeStyle = '#ff5e6c'; g.lineWidth = 2; g.beginPath(); g.moveTo(6, 6); g.lineTo(s - 6, s - 6); g.moveTo(s - 6, 6); g.lineTo(6, s - 6); g.stroke(); return; }
    if (p.entry === 'spawn') { spawnGlyph(g, s / 2, s / 2, s * 0.38, '1'); return; }
    const im = picture(p.picture);
    if (im?.complete && im.naturalWidth) { const h = im.naturalHeight, frames = Math.max(1, Math.round(im.naturalWidth / h)); g.imageSmoothingEnabled = world.style !== 'pixel'; g.drawImage(im, 0, 0, im.naturalWidth / frames, h, 0, 0, s, s); }
    else { g.fillStyle = '#6d8bff'; g.fillRect(4, 4, s - 8, s - 8); }
  }

  // ---------- the view over the preview ----------
  const canvas = el('canvas', { className: 'paint-canvas', tabIndex: 0, 'aria-label': 'The level: paint on it' });
  const banner = el('div', { className: 'overlay-bar' }, el('strong', {}, 'Editing the level'), el('span', { className: 'muted small' }, 'Save & play to try it'));
  const keyNote = el('div', { className: 'overlay-key small' },
    el('span', {}, el('i', { className: 'k bad' }), 'no jump reaches it'), el('span', {}, el('i', { className: 'k shade' }), 'a jump from the cursor lands here'), el('span', {}, el('i', { className: 'k ok' }), 'a player can stand and get here'));
  const pan = el('input', { type: 'range', className: 'pan', min: 0, max: 0, value: 0, hidden: true, 'aria-label': 'Slide along the map', on: { input: () => layout() } });
  keyNote.prepend(pan);
  const view = el('div', { className: 'paint-view' }, banner, canvas, keyNote);
  let geo = { cell: 16, ox: 0, oy: 0 };
  const g = canvas.getContext('2d');

  function layout() {
    const rect = view.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, M = map(), cols = M.rows[0].length, rows = M.rows.length;
    const top = banner.offsetHeight + 6, bottom = keyNote.offsetHeight + 6;
    // a finger needs about 22 px: when the whole map would be smaller, keep the cells that big and slide along it
    const fit = Math.floor(Math.min((rect.width - 16) / cols, (rect.height - top - bottom - 8) / rows));
    const cell = Math.max(fit, Math.min(22, Math.floor((rect.height - top - bottom - 8) / rows)));
    const wide = cell * cols > rect.width - 16;
    pan.hidden = !wide; pan.max = String(Math.max(0, cell * cols - (rect.width - 16)));
    if (Number(pan.value) > Number(pan.max)) pan.value = pan.max;
    canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr);
    canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    geo = { cell, ox: wide ? 8 - Number(pan.value) : Math.round((rect.width - cell * cols) / 2), oy: Math.round(top + (rect.height - top - bottom - cell * rows) / 2), w: rect.width, h: rect.height };
    canvas.dataset.geo = JSON.stringify({ cell, ox: geo.ox, oy: geo.oy, cols, rows });      // where the cells are (tests, tools)
    draw();
  }
  const cellAt = e => { const r = canvas.getBoundingClientRect(), M = map(); const c = Math.floor((e.clientX - r.left - geo.ox) / geo.cell), row = Math.floor((e.clientY - r.top - geo.oy) / geo.cell); return c >= 0 && row >= 0 && c < M.rows[0].length && row < M.rows.length ? { c, r: row } : null; };

  function draw(M = map()) {
    if (!view.isConnected) return;
    const grid = gridOf(M), { cell, ox, oy } = geo, cols = grid[0].length, rows = grid.length, side = M.plane === 'side';
    g.clearRect(0, 0, geo.w, geo.h);
    // the sky (side-on) or the ground (from above), as the look draws it
    g.fillStyle = look.values?.background ?? (side ? '#cdeaf5' : '#84c76f');
    g.fillRect(ox, oy, cell * cols, cell * rows);
    const base = !side && M.base ? picture(tilesOf()[M.base]) : null;
    g.imageSmoothingEnabled = world.style !== 'pixel';
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = ox + c * cell, y = oy + r * cell, entry = M.legend[grid[r][c]] ?? null;
      if (base) tileImg(base, x, y, cell, false);
      if (entry && M.kinds[entry]) {
        const im = picture(tilesOf()[entry]);
        const above = r > 0 ? M.legend[grid[r - 1][c]] ?? null : null;
        if (im?.complete && im.naturalWidth) tileImg(im, x, y, cell, above !== entry);
        else { g.fillStyle = M.kinds[entry].solid ? '#7d6a55' : '#b9d78f'; g.fillRect(x, y, cell, M.kinds[entry].solid === 'top' ? cell / 3 : cell); }
      }
    }
    // reach: where a player can stand and get to (green tops), where a jump from the cursor lands (shade)
    if (showReach && check) {
      if (side && check.reached) { g.fillStyle = 'rgba(75,224,168,.9)'; for (const k of check.reached) { const [c, r] = k.split(',').map(Number); g.fillRect(ox + c * cell + 1, oy + (r + 1) * cell - 3, cell - 2, 3); } }
      if (side && hover && check.reach) {
        const Mx = kit.readMap(M);
        // from where the cursor would stand: the first place to stand at or below it
        let r0 = hover.r; const standable = r => Mx.solid(hover.c, r) !== true && (r === Mx.rows - 1 || [true, 'top'].includes(Mx.solid(hover.c, r + 1)));
        while (r0 < Mx.rows && !standable(r0)) r0++;
        if (Mx.ok && r0 < Mx.rows) {
          g.fillStyle = 'rgba(109,139,255,.22)';
          for (const q of jumpShade(Mx, check.reach, hover.c, r0)) if (Mx.solid(q.c, q.r) !== true) g.fillRect(ox + q.c * cell, oy + q.r * cell, cell, cell);
          g.strokeStyle = 'rgba(109,139,255,.9)'; g.lineWidth = 2; g.strokeRect(ox + hover.c * cell + 3, oy + r0 * cell + 3, cell - 6, cell - 6);
        }
      }
    }
    // marks and start spots on top
    let seat = 0;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const entry = M.legend[grid[r][c]] ?? null, x = ox + c * cell, y = oy + r * cell;
      if (entry === 'spawn') spawnGlyph(g, x + cell / 2, y + cell / 2, cell * 0.4, String(++seat));
      else if (typeof entry === 'string' && entry.startsWith('mark:')) {
        const im = picture(marksOf()[entry.slice(5)]);
        if (im?.complete && im.naturalWidth) { const s = cell * 0.8; g.drawImage(im, x + (cell - s) / 2, y + (cell - s) / 2, s, s); }
        else { g.fillStyle = '#ffc94d'; g.beginPath(); g.arc(x + cell / 2, y + cell / 2, cell * 0.3, 0, 7); g.fill(); }
      }
    }
    // what is wrong, in red
    if (check) for (const k of check.bad) {
      const [c, r] = k.split(',').map(Number), x = ox + c * cell, y = oy + r * cell;
      g.fillStyle = 'rgba(255,60,80,.38)'; g.fillRect(x, y, cell, cell);
      g.strokeStyle = '#ff3c50'; g.lineWidth = 2; g.strokeRect(x + 1, y + 1, cell - 2, cell - 2);
    }
    // the grid, faint
    g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = 1; g.beginPath();
    for (let c = 0; c <= cols; c++) { g.moveTo(ox + c * cell + 0.5, oy); g.lineTo(ox + c * cell + 0.5, oy + rows * cell); }
    for (let r = 0; r <= rows; r++) { g.moveTo(ox, oy + r * cell + 0.5); g.lineTo(ox + cols * cell, oy + r * cell + 0.5); }
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.35)'; g.strokeRect(ox + 0.5, oy + 0.5, cols * cell, rows * cell);
    // the stroke being made, and the cursor
    if (drag?.tool === 'box' && drag.at) { const a = drag.start, b = drag.at; g.strokeStyle = '#fff'; g.setLineDash([4, 3]); g.lineWidth = 2; g.strokeRect(ox + Math.min(a.c, b.c) * cell, oy + Math.min(a.r, b.r) * cell, (Math.abs(a.c - b.c) + 1) * cell, (Math.abs(a.r - b.r) + 1) * cell); g.setLineDash([]); }
    if (hover) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.strokeRect(ox + hover.c * cell + 1, oy + hover.r * cell + 1, cell - 2, cell - 2); }
  }
  function tileImg(im, x, y, cell, cap) {
    if (!im?.complete || !im.naturalWidth) return;
    const h = im.naturalHeight, frames = Math.max(1, Math.round(im.naturalWidth / h)), f = frames === 2 && !cap ? 1 : 0;
    g.drawImage(im, f * h, 0, h, h, x, y, cell, cell);
  }
  function spawnGlyph(ctx2, x, y, rad, label) {
    ctx2.fillStyle = '#ffffff'; ctx2.strokeStyle = '#1b1d27'; ctx2.lineWidth = 2;
    ctx2.beginPath(); ctx2.arc(x, y, rad, 0, 7); ctx2.fill(); ctx2.stroke();
    ctx2.fillStyle = '#1b1d27'; ctx2.font = `700 ${Math.max(8, Math.round(rad * 1.2))}px system-ui, sans-serif`; ctx2.textAlign = 'center'; ctx2.textBaseline = 'middle'; ctx2.fillText(label, x, y + 1);
  }

  // ---------- strokes ----------
  function place(cells, entry) {
    let M = map();
    const got = charFor(M, entry); M = got.map;
    const next = withGrid(M, paintCells(gridOf(M), cells, got.ch));
    return next;
  }
  let working = null;      // the map while a stroke is being made (pushed to history once, at the end)
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', e => {
    const at = cellAt(e); if (!at) return;
    canvas.setPointerCapture(e.pointerId);
    const t = e.button === 2 ? 'erase' : tool, entry = t === 'erase' ? null : brush?.entry ?? null;
    if (t === 'pick') { const got = entryAt(map(), gridOf(map()), at.c, at.r); const items = paletteOf(map(), { tiles: tilesOf(), marks: marksOf() }); brush = items.find(p => p.entry === got) ?? brush; setTool(got === null ? 'erase' : 'paint'); paintPalette(); return; }
    if (t === 'fill') { const M0 = map(); const got = charFor(M0, entry); commit(withGrid(got.map, fillCells(gridOf(got.map), at.c, at.r, got.ch))); return; }
    drag = { tool: t, entry, start: at, last: at, at };
    if (t === 'paint' || t === 'erase') { working = place([at], entry); recheck(working); draw(working); }
  });
  canvas.addEventListener('pointermove', e => {
    const at = cellAt(e);
    if (!drag) { if (at?.c !== hover?.c || at?.r !== hover?.r) { hover = at; draw(); } return; }
    if (!at) return;
    hover = at;
    if (drag.tool === 'box') { drag.at = at; draw(); return; }
    if (at.c === drag.last.c && at.r === drag.last.r) return;
    const M0 = working ?? map(); const got = charFor(M0, drag.entry);
    working = withGrid(got.map, paintCells(gridOf(got.map), lineCells(drag.last, at), got.ch));
    drag.last = at; recheck(working); draw(working);
  });
  const end = () => {
    if (!drag) return;
    if (drag.tool === 'box' && drag.at) commit(place(rectCells(drag.start, drag.at), drag.entry));
    else if (working) commit(working);
    drag = null; working = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; draw(); } });
  const commit = next => { history.push(next); refreshUndo(); recheck(); draw(); paintDirty(); };

  function resize(k, d) {
    const M = map(), grid = gridOf(M), want = { cols: grid[0].length + (k === 'cols' ? d : 0), rows: grid.length + (k === 'rows' ? d : 0) };
    const L = kit.LIMITS ?? { cols: [8, 96], rows: [6, 64] };
    if (want.cols < L.cols[0] || want.cols > L.cols[1] || want.rows < L.rows[0] || want.rows > L.rows[1]) { ctx.toast(`A map is ${L.cols[0]} to ${L.cols[1]} cells across and ${L.rows[0]} to ${L.rows[1]} high`, 'error'); return; }
    const got = charFor(M, null);
    commit(withGrid(got.map, resizeGrid(gridOf(got.map), want, got.ch, { plane: M.plane })));
    layout();
  }

  // ---------- the checks (the kit's own, from the game's copy of the flat part) ----------
  function recheck(M = map()) {
    try { check = checkMap(M, { kit, game: { world, config: gameCfg }, seats }); }
    catch (e) { check = { ok: false, errors: [e.message], warnings: [], bad: new Set(), reached: new Set(), spawns: 0, seats }; }
    status.replaceChildren(
      el('div', { className: `check-line ${check.spawns >= seats ? 'ok' : 'bad'}` }, `${check.spawns} start spot${check.spawns === 1 ? '' : 's'} for ${seats} players`),
      ...check.errors.map(t => el('div', { className: 'check-line bad' }, plain(t))),
      ...check.warnings.slice(0, 3).map(t => el('div', { className: 'check-line warn' }, plain(t))),
      ...(check.ok ? [el('div', { className: 'check-line ok' }, 'Every ledge, coin and start spot can be reached.')] : []));
    saveBtn.disabled = !check.ok;
    saveBtn.title = check.ok ? 'Write the map to the game and play it' : 'Fix what is red first: the game would refuse this map';
    size.textContent = `${M.rows[0].length} × ${M.rows.length} cells`;
  }
  const plain = t => String(t).replace(/^the /, s => s.toUpperCase().slice(0, 1) + s.slice(1));
  function paintDirty() { const dirty = JSON.stringify(map()) !== saved; revert.disabled = !dirty; banner.querySelector('.muted').textContent = dirty ? 'Not saved yet. Save & play to try it' : 'Saved. Save & play to try it'; }

  // ---------- save, play, edit ----------
  async function save() {
    saveBtn.disabled = true;
    try {
      const r = await ctx.api('editors/map', { map: map() });
      saved = JSON.stringify(map()); paintDirty();
      ctx.toast(`Saved the map (${r.cols} × ${r.rows}, ${r.spawns} start spots). The game reloads with it.`, 'ok');
      setEditing(false);
    } catch (e) { ctx.toast(e.message, 'error'); }
    finally { saveBtn.disabled = !check?.ok; }
  }
  function setEditing(on) {
    editing = on;
    editBtn.hidden = on; saveBtn.hidden = !on;
    if (on && !root.closest('.panel')?.hidden) { ctx.preview.overlay(view); requestAnimationFrame(layout); }
    else { ctx.preview.overlay(null); if (!on) { ctx.preview.show('/game/'); } }
  }
  saveBtn.addEventListener('click', save);
  editBtn.addEventListener('click', () => setEditing(true));
  revert.addEventListener('click', () => { history.push(JSON.parse(saved)); refreshUndo(); recheck(); draw(); paintDirty(); });
  // the Reset Rocket: a hold, not a click; Undo brings the map back
  let holdTimer = null;
  const startHold = () => { clear.classList.add('holding'); holdTimer = setTimeout(() => { clear.classList.remove('holding'); const M = map(), grid = gridOf(M), got = charFor(M, null); commit(withGrid(got.map, grid.map(r => r.map(() => got.ch)))); ctx.toast('Cleared. Undo brings it back.', 'ok'); }, 1500); };
  const stopHold = () => { clearTimeout(holdTimer); clear.classList.remove('holding'); };
  clear.addEventListener('pointerdown', startHold); clear.addEventListener('pointerup', stopHold); clear.addEventListener('pointerleave', stopHold);

  const keys = e => {
    if ((root.closest('.panel')?.hidden) || !editing || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || e.ctrlKey || e.metaKey) return;
    const t = TOOLS.find(x => x.key === e.key.toLowerCase()); if (t) { setTool(t.id); e.preventDefault(); }
  };
  window.addEventListener('keydown', keys);

  // the game's files changed (a save, or the person's session): take the new map when nothing here is unsaved
  const offGame = ctx.on('game', async ({ files = [] }) => {
    if (files.length && !files.some(f => f.startsWith('config/') || f.startsWith('assets/') || f === 'assets.json')) return;
    const nextWorld = await fetchJson('config/world.json').catch(() => null);
    gameCfg = await fetchJson('config/game.json').catch(() => gameCfg);
    look = await fetchJson('config/look.json').catch(() => look);
    if (files.some(f => f.startsWith('assets/'))) images.clear();
    if (!nextWorld?.map) return;
    const theirs = JSON.stringify(nextWorld.map);
    world = nextWorld;
    if (theirs === saved) { draw(); return; }
    if (JSON.stringify(map()) === saved) { saved = theirs; history.push(nextWorld.map); refreshUndo(); recheck(); draw(); paintDirty(); paintPalette(); ctx.toast('The map changed in the game\'s files (your session?): showing it. Undo goes back.', 'ok'); }
    else ctx.toast('The map changed in the game\'s files while you have unsaved edits here. Save keeps yours; Discard changes takes theirs.', 'error');
  });

  const ro = new ResizeObserver(() => layout());
  ro.observe(view);
  const offShown = onShown(root.closest('.panel') ?? root, shown => { if (shown && editing) { ctx.preview.overlay(view); requestAnimationFrame(layout); } else ctx.preview.overlay(null); });
  setTool('paint'); paintPalette(); recheck(); paintDirty();
  editBtn.hidden = true;
  ctx.preview.overlay(view); requestAnimationFrame(layout);
  return () => { offGame(); offKeys(); offShown(); ro.disconnect(); window.removeEventListener('keydown', keys); ctx.preview.overlay(null); };
}
