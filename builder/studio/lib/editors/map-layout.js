// The layout editor (a 3D world's props, the json slot world.<template>.layout, and its start spots,
// world.<template>.spawns), seen from above and laid over the preview while the Map tab is shown. Click to select,
// drag to move (snaps to half a metre; hold Alt for free), R turns, Delete removes, Ctrl+D copies. "Save & play" writes
// the slots and the game reloads. A first shape, as far as it goes: see the findings for what it does not do yet.
import { createHistory } from './history.js';
import { TURN, addProp, duplicateProp, fitView, hitProp, moveProp, propsView, removeProp, rotateProp, scaleProp, snap } from './layout.js';
import { askBox, el, onShown, undoBar } from './ui.js';

const SCENERY = /^(tree|bush|fence|grass|flower|cloud|rock|hedge)/;     // drawn quietly, and hidden by "scenery off"

export async function mountLayout(root, ctx, slotList, layoutSlot) {
  const base = layoutSlot.id.replace(/\.layout$/, '');
  const spawnSlot = slotList.slots.find(s => s.id === `${base}.spawns` && s.type === 'json');
  const fetchJson = async f => (await fetch(`/game/${f}?t=${Date.now()}`, { cache: 'no-store' })).json();
  let world = await fetchJson(layoutSlot.file);
  const { sizes } = await ctx.api('editors/props').catch(() => ({ sizes: {} }));
  const size = Array.isArray(world.size) ? world.size : [40, 40];
  // what the view fits: the ground, and every prop around it (houses and trees stand outside the fence)
  const span = () => { let w = size[0] / 2, d = size[1] / 2; for (const p of world.props ?? []) { if (/^cloud/.test(p.prop)) continue; w = Math.max(w, Math.abs(p.at?.[0] ?? 0) + 1.5); d = Math.max(d, Math.abs(p.at?.[2] ?? 0) + 1.5); } return [w * 2, d * 2]; };
  const history = createHistory({ props: world.props ?? [], spawns: world.spawns ?? [] });
  let saved = JSON.stringify(history.current), sel = null, drag = null, scenery = true, editing = true;
  const cur = () => history.current;

  // ---------- the side panel ----------
  const saveBtn = el('button', { type: 'button' }, '▶ Save & play');
  const editBtn = el('button', { type: 'button', className: 'ghost', hidden: true }, '✎ Edit');
  const card = el('div', { className: 'cards' });
  const addSel = el('select', { 'aria-label': 'A prop to add' });
  const addBtn = el('button', { type: 'button', className: 'ghost' }, '+ Add to the middle');
  const count = el('span', { className: 'muted small' });
  const { bar: undoBtns, refresh: refreshUndo, off: offKeys } = undoBar(history, () => { if (sel?.kind === 'prop' && sel.i >= cur().props.length) sel = null; paintCard(); draw(); dirty(); }, root.closest('.panel') ?? root);
  root.append(
    el('p', { className: 'muted' }, 'The world from above. Click a thing to pick it, drag to move it, R to turn it. Save & play to walk around in it.'),
    el('div', { className: 'toolbar' }, saveBtn, editBtn, ...undoBtns),
    el('h3', {}, 'Selected'), card,
    el('h3', {}, 'Add'), el('div', { className: 'toolbar' }, addSel, addBtn),
    el('div', { className: 'toolbar' }, el('label', { className: 'small' }, el('input', { type: 'checkbox', checked: true, on: { change: e => { scenery = e.target.checked; draw(); } } }), ' show trees, fences and flowers'), count),
    el('h3', {}, 'Ask your session'),
    askBox(ctx, {
      label: 'Say what to change, in your words',
      placeholder: 'e.g. put four benches round the middle, facing in',
      compose: words => `Change this game's world layout (the slot ${layoutSlot.id}: ${layoutSlot.file} → props, each {prop, at: [x, y, z], rot, scale}; the start spots are ${spawnSlot?.id ?? 'the spawns'}): ${words}. Use only props the world already has or the library's. Keep the gates and the walls clear, then run node builder/tools/world.mjs <game> (verify check 17).`,
      selection: () => (sel?.kind === 'prop' ? { id: layoutSlot.id, label: `${cur().props[sel.i]?.prop} at ${cur().props[sel.i]?.at?.join(', ')}` } : { id: layoutSlot.id, label: 'World layout' }),
    }));
  const kinds = [...new Set((world.props ?? []).map(p => p.prop))].sort();
  for (const k of kinds) addSel.append(el('option', { value: k }, k.replace(/-/g, ' ')));
  addBtn.addEventListener('click', () => { commit({ ...cur(), props: addProp(cur().props, addSel.value, 0, 2) }); sel = { kind: 'prop', i: cur().props.length - 1 }; paintCard(); draw(); });

  function paintCard() {
    card.replaceChildren();
    if (!sel) { card.append(el('div', { className: 'card muted' }, 'Nothing picked. Click a thing in the view.')); return; }
    if (sel.kind === 'spawn') {
      const s = cur().spawns[sel.i];
      card.append(el('div', { className: 'card', 'aria-current': 'true' }, el('div', { className: 'card-head' }, el('div', { className: 'pic' }, String(sel.i + 1)), el('div', {}, el('h4', {}, `Start spot ${sel.i + 1}`), el('div', { className: 'what' }, `at ${s[0]}, ${s[2]} m`)), el('span', { className: 'kind' }, 'start'))));
      return;
    }
    const p = cur().props[sel.i];
    if (!p) { sel = null; return paintCard(); }
    const rot = el('input', { type: 'range', min: 0, max: 345, step: TURN, value: p.rot ?? 0, 'aria-label': 'Turn' });
    rot.addEventListener('input', () => { history.push({ ...cur(), props: cur().props.map((q, j) => (j === sel.i ? { ...q, rot: Number(rot.value) } : q)) }); refreshUndo(); draw(); dirty(); });
    const sc = el('input', { type: 'range', min: 0.25, max: 4, step: 0.05, value: p.scale ?? 1, 'aria-label': 'Size' });
    sc.addEventListener('change', () => commit({ ...cur(), props: scaleProp(cur().props, sel.i, sc.value) }));
    card.append(el('div', { className: 'card', 'aria-current': 'true' },
      el('div', { className: 'card-head' }, el('div', { className: 'pic' }, '⬚'), el('div', {}, el('h4', {}, p.prop.replace(/-/g, ' ')), el('div', { className: 'what' }, `at ${p.at[0]}, ${p.at[2]} m · turned ${p.rot ?? 0}°`)), el('span', { className: 'kind' }, 'prop')),
      el('div', { className: 'field' }, el('label', { className: 'field-label' }, 'Turn'), el('div', { className: 'field-edit' }, rot, el('span', { className: 'ends muted small' }, `${p.rot ?? 0}°`))),
      el('div', { className: 'field' }, el('label', { className: 'field-label' }, 'Size'), el('div', { className: 'field-edit' }, sc, el('span', { className: 'ends muted small' }, `× ${p.scale ?? 1}`))),
      el('div', { className: 'card-actions' },
        el('button', { type: 'button', className: 'ghost small', on: { click: () => { commit({ ...cur(), props: rotateProp(cur().props, sel.i, TURN) }); paintCard(); } } }, `↻ Turn ${TURN}°`),
        el('button', { type: 'button', className: 'ghost small', on: { click: () => { const r = duplicateProp(cur().props, sel.i, { size }); commit({ ...cur(), props: r.props }); sel = { kind: 'prop', i: r.index }; paintCard(); } } }, '⧉ Copy'),
        el('button', { type: 'button', className: 'ghost small danger', on: { click: () => { commit({ ...cur(), props: removeProp(cur().props, sel.i) }); sel = null; paintCard(); } } }, '✕ Remove'),
        el('button', { type: 'button', className: 'ghost small', on: { click: () => ctx.preview.show(`/game/?gf-show=prop.${p.prop}`) }, title: 'See the model in the preview' }, 'See it'))));
  }

  // ---------- the view from above ----------
  const canvas = el('canvas', { tabIndex: 0, 'aria-label': 'The world from above' });
  const banner = el('div', { className: 'overlay-bar' }, el('strong', {}, 'The world from above'), el('span', { className: 'muted small' }, 'Saved'));
  const key = el('div', { className: 'overlay-key small' }, el('span', {}, el('i', { className: 'k sel' }), 'picked'), el('span', {}, el('i', { className: 'k spawn' }), 'start spot'), el('span', {}, 'grid: 1 m · snaps to 0.5 m (Alt: free)'));
  const view = el('div', { className: 'paint-view' }, banner, canvas, key);
  const g = canvas.getContext('2d');
  let T = fitView(size, 600, 400), W = 600, H = 400;
  function layout() {
    const r = view.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const top = banner.offsetHeight + 8, bottom = key.offsetHeight + 8;
    const t = fitView(span(), W, H - top - bottom, 18);
    T = { k: t.k, toPx: (x, z) => { const [a, b] = t.toPx(x, z); return [a, b + top]; }, toWorld: (px, py) => t.toWorld(px, py - top) };
    canvas.dataset.view = JSON.stringify({ k: T.k, origin: T.toPx(0, 0) });
    draw();
  }
  const ground = world.ground?.color ?? '#86b84a';
  function draw() {
    if (!view.isConnected) return;
    g.clearRect(0, 0, W, H);
    const [x0, z0] = T.toPx(-size[0] / 2, -size[1] / 2), [x1, z1] = T.toPx(size[0] / 2, size[1] / 2);
    g.fillStyle = '#0f1017'; g.fillRect(0, 0, W, H);
    const [sw, sd] = span(), [ax, az] = T.toPx(-sw / 2, -sd / 2), [bx, bz] = T.toPx(sw / 2, sd / 2);
    g.fillStyle = world.ground?.outer ?? '#5c7f3a'; g.fillRect(ax, az, bx - ax, bz - az);
    g.fillStyle = ground; g.fillRect(x0, z0, x1 - x0, z1 - z0);
    g.strokeStyle = 'rgba(0,0,0,.08)'; g.lineWidth = 1; g.beginPath();
    for (let x = Math.ceil(-size[0] / 2); x <= size[0] / 2; x++) { const [px] = T.toPx(x, 0); g.moveTo(px + 0.5, z0); g.lineTo(px + 0.5, z1); }
    for (let z = Math.ceil(-size[1] / 2); z <= size[1] / 2; z++) { const [, pz] = T.toPx(0, z); g.moveTo(x0, pz + 0.5); g.lineTo(x1, pz + 0.5); }
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,.45)'; g.lineWidth = 2; g.strokeRect(x0, z0, x1 - x0, z1 - z0);
    // zones, faint
    for (const [name, zn] of Object.entries(world.zones ?? {})) {
      const [zx, zz] = T.toPx(zn.at[0], zn.at[2]);
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.setLineDash([4, 4]); g.lineWidth = 1;
      if (zn.shape === 'circle') { g.beginPath(); g.arc(zx, zz, zn.size[0] * T.k, 0, 7); g.stroke(); }
      else { g.strokeRect(zx - (zn.size[0] * T.k) / 2, zz - (zn.size[2] * T.k) / 2, zn.size[0] * T.k, zn.size[2] * T.k); }
      g.setLineDash([]);
      void name;
    }
    const v = propsView(cur().props, sizes);
    // big things first, so small ones sit on top
    for (const p of [...v].sort((a, b) => b.w * b.d - a.w * a.d)) {
      const quiet = SCENERY.test(p.name);
      if (quiet && !scenery && !(sel?.kind === 'prop' && sel.i === p.i)) continue;
      const [px, pz] = T.toPx(p.x, p.z), on = sel?.kind === 'prop' && sel.i === p.i;
      g.save(); g.translate(px, pz); g.rotate((p.rot * Math.PI) / 180);
      g.fillStyle = on ? 'rgba(255,200,74,.85)' : quiet ? 'rgba(30,70,30,.35)' : 'rgba(250,248,240,.88)';
      g.strokeStyle = on ? '#ffc84a' : quiet ? 'rgba(20,50,20,.5)' : 'rgba(40,40,50,.9)'; g.lineWidth = on ? 3 : 1.2;
      const w = p.w * T.k, d = p.d * T.k;
      if (/^tree|^bush/.test(p.name)) { g.beginPath(); g.arc(0, 0, Math.max(w, d) / 2, 0, 7); g.fill(); g.stroke(); }
      else { g.fillRect(-w / 2, -d / 2, w, d); g.strokeRect(-w / 2, -d / 2, w, d); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, d / 2); g.stroke(); }
      g.restore();
      if (!quiet && p.w * T.k > 26) { g.fillStyle = '#1b1d27'; g.font = '600 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(p.name.replace(/-/g, ' '), px, pz); }
    }
    cur().spawns.forEach((s, i) => {
      const [px, pz] = T.toPx(s[0], s[2]), on = sel?.kind === 'spawn' && sel.i === i;
      g.fillStyle = '#fff'; g.strokeStyle = on ? '#ffc84a' : '#1b1d27'; g.lineWidth = on ? 3 : 2;
      g.beginPath(); g.arc(px, pz, 9, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#1b1d27'; g.font = '700 11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), px, pz + 1);
    });
    count.textContent = `${cur().props.length} things · ${cur().spawns.length} start spots`;
  }

  const worldAt = e => { const r = canvas.getBoundingClientRect(); return T.toWorld(e.clientX - r.left, e.clientY - r.top); };
  canvas.addEventListener('pointerdown', e => {
    const [x, z] = worldAt(e);
    const si = cur().spawns.findIndex(s => Math.hypot(s[0] - x, s[2] - z) * T.k < 11);
    const pi = si >= 0 ? -1 : hitProp(propsView(cur().props, sizes).filter(p => scenery || !SCENERY.test(p.name)), x, z);
    sel = si >= 0 ? { kind: 'spawn', i: si } : pi >= 0 ? { kind: 'prop', i: pi } : null;
    paintCard(); draw();
    if (!sel) return;
    canvas.setPointerCapture(e.pointerId);
    const at = sel.kind === 'spawn' ? cur().spawns[sel.i] : cur().props[sel.i].at;
    drag = { dx: at[0] - x, dz: at[2] - z, start: JSON.stringify(cur()), moved: false };
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || !sel) return;
    const [x, z] = worldAt(e), step = e.altKey ? 0 : 0.5, nx = x + drag.dx, nz = z + drag.dz;
    const next = sel.kind === 'spawn'
      ? { ...cur(), spawns: cur().spawns.map((s, j) => (j === sel.i ? [snap(nx, step), s[1], snap(nz, step)] : s)) }
      : { ...cur(), props: moveProp(cur().props, sel.i, nx, nz, { size, step }) };
    // the drag is one undo step: replace the present while dragging, push once at the end
    if (!drag.moved) { history.push(next); drag.moved = true; } else { const h = history; h.undo(); h.push(next); }
    refreshUndo(); draw();
  });
  const end = () => { if (drag?.moved) { dirty(); paintCard(); } drag = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  const keys = e => {
    if ((root.closest('.panel')?.hidden) || !editing || !sel || sel.kind !== 'prop' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (e.key === 'r' || e.key === 'R') { commit({ ...cur(), props: rotateProp(cur().props, sel.i, e.shiftKey ? -TURN : TURN) }); paintCard(); e.preventDefault(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { commit({ ...cur(), props: removeProp(cur().props, sel.i) }); sel = null; paintCard(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { const r = duplicateProp(cur().props, sel.i, { size }); commit({ ...cur(), props: r.props }); sel = { kind: 'prop', i: r.index }; paintCard(); e.preventDefault(); }
  };
  window.addEventListener('keydown', keys);

  function commit(next) { history.push(next); refreshUndo(); draw(); dirty(); }
  function dirty() { banner.querySelector('.muted').textContent = JSON.stringify(cur()) === saved ? 'Saved' : 'Not saved yet'; }
  async function save() {
    saveBtn.disabled = true;
    try {
      const now = cur(), was = JSON.parse(saved);
      if (JSON.stringify(now.props) !== JSON.stringify(was.props)) await ctx.api('game/slots/value', { id: layoutSlot.id, value: now.props });
      if (spawnSlot && JSON.stringify(now.spawns) !== JSON.stringify(was.spawns)) await ctx.api('game/slots/value', { id: spawnSlot.id, value: now.spawns });
      saved = JSON.stringify(now); dirty();
      ctx.toast('Saved the layout. The game reloads with it; Verify checks the world (check 17).', 'ok');
      setEditing(false);
    } catch (e) { ctx.toast(e.message, 'error'); }
    finally { saveBtn.disabled = false; }
  }
  function setEditing(on) { editing = on; editBtn.hidden = on; saveBtn.hidden = !on; if (on) { ctx.preview.overlay(view); requestAnimationFrame(layout); } else { ctx.preview.overlay(null); ctx.preview.show('/game/'); } }
  saveBtn.addEventListener('click', save);
  editBtn.addEventListener('click', () => setEditing(true));
  const offGame = ctx.on('game', async () => {
    const next = await fetchJson(layoutSlot.file).catch(() => null);
    if (!next) return;
    const theirs = JSON.stringify({ props: next.props ?? [], spawns: next.spawns ?? [] });
    if (theirs === saved) return;
    if (JSON.stringify(cur()) === saved) { world = next; saved = theirs; history.push(JSON.parse(theirs)); refreshUndo(); draw(); dirty(); ctx.toast('The layout changed in the game\'s files (your session?): showing it. Undo goes back.', 'ok'); }
    else ctx.toast('The layout changed in the game\'s files while you have unsaved moves here. Save keeps yours.', 'error');
  });
  const ro = new ResizeObserver(() => layout()); ro.observe(view);
  const offShown = onShown(root.closest('.panel') ?? root, shown => { if (shown && editing) { ctx.preview.overlay(view); requestAnimationFrame(layout); } else ctx.preview.overlay(null); });
  paintCard(); ctx.preview.overlay(view); requestAnimationFrame(layout);
  return () => { offGame(); offKeys(); offShown(); ro.disconnect(); window.removeEventListener('keydown', keys); ctx.preview.overlay(null); };
}
