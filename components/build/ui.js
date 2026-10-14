// mechanic: build. The HUD: the hotbar along the bottom (blocks, or paint colours while painting), the tools beside
// it (break, paint), the name of what is picked, and the sign editor. DOM over the canvas, UI only: a block's picture
// is drawn from its own texture slots (the top and side faces as a small cube), never new art (CONTRACT §2).

const CSS = `
#gf-build{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:flex;align-items:flex-end;gap:10px;pointer-events:none;z-index:6}
#gf-build button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent}
#gf-build .gfp-slot i{display:block;width:30px;height:30px;border-radius:50%;box-shadow:inset 0 0 0 2px #0003}
#gf-build .gfp-slot i.wash{background:repeating-linear-gradient(45deg,#fff 0 4px,#ddd 4px 8px)}
#gf-build .gf-tools{display:flex;gap:5px;padding:6px;border-radius:14px;background:var(--gf-panel,#1c2133cc);pointer-events:auto}
#gf-build .gf-tool{width:46px;height:46px;border-radius:10px;border:2px solid #ffffff22;background:#ffffff14;display:grid;place-items:center;padding:0;position:relative}
#gf-build .gf-tool svg{width:24px;height:24px}
#gf-build .gf-tool b{position:absolute;left:4px;top:1px;font-size:10px;opacity:.75}
#gf-build .gf-tool.on{border-color:var(--gf-accent,#ff7a59);background:#ffffff26}
#gf-build-name{position:absolute;left:50%;bottom:122px;transform:translateX(-50%);padding:3px 12px;border-radius:999px;background:#0008;font-size:14px;opacity:0;transition:opacity .25s;pointer-events:none;white-space:nowrap}
#gf-build-name.on{opacity:1}
#gf-ui.gf-hotbar .gf-help{display:none}
#gf-ui.gf-hotbar #gf-fullscreen{top:10px!important;right:10px!important;bottom:auto!important}
#gf-ui.gf-hotbar .gf-toasts{top:auto;bottom:160px}
#gf-ui.gf-hotbar .gf-me{bottom:auto;top:96px;min-width:0}
#gf-ui.gf-hotbar .gf-prompt{bottom:84px}
#gf-ui.gf-hotbar .gf-touch button[data-action="jump"]{bottom:84px!important}
#gf-ui.gf-hotbar .gf-touch button[data-action="interact"]{bottom:160px!important}
@media (max-width:640px){#gf-build{bottom:6px;gap:6px}#gf-build .gf-tool{width:38px;height:38px}#gf-build .gfp-slot i{width:24px;height:24px}#gf-build .gf-tools{padding:4px;gap:4px}#gf-build-name{bottom:104px}#gf-ui.gf-hotbar .gf-prompt{bottom:66px}#gf-ui.gf-hotbar .gf-toasts{bottom:138px}#gf-ui.gf-hotbar .gf-me{top:84px}}
`;
const ICONS = {
  break: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 4.5c2.8-1 5 .3 5.5 1-2.2-.3-4 .5-5 1.5"/><path d="M14.5 4.5 9 10"/><path d="M15 7l-1.5-1.5"/><path d="M10.5 8.5l5 5"/><path d="M12 11 4.5 18.5a1.4 1.4 0 0 0 2 2L14 13"/></svg>',
  paint: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3.5" width="14" height="6" rx="1.5"/><path d="M18 6.5h1.5v5H11v3"/><rect x="9.5" y="14.5" width="3" height="6" rx="1"/></svg>',
};
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** A small cube picture from two face images (top, side): UI made from the block's own texture slots. */
export function cubeIcon(top, side, size = 76) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); if (!g) return c;
  const s = size * 0.5, T = 128;
  const face = (img, a, b, cc, d, e, f, shade) => {
    g.save(); g.setTransform(a, b, cc, d, e, f);
    if (img) g.drawImage(img, 0, 0, T, T); else { g.fillStyle = '#999'; g.fillRect(0, 0, T, T); }
    if (shade) { g.fillStyle = `rgba(0,0,0,${shade})`; g.fillRect(0, 0, T, T); }
    g.restore();
  };
  const k = s / T * 0.86;
  face(top, k, k * 0.5, -k, k * 0.5, size / 2, size * 0.08, 0);                    // top
  face(side, k, k * 0.5, 0, k, size / 2 - s * 0.86, size * 0.08 + s * 0.43, 0.14); // left
  face(side, k, -k * 0.5, 0, k, size / 2, size * 0.08 + s * 0.86, 0.3);             // right
  return c;
}

/** A sign's picture: a board on a post with three lines of writing, cut from the sign's own wood texture (a cube of
 *  it read as planks; play-test 2026-10-09). */
export function signIcon(wood, size = 76) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'); if (!g) return c;
  const u = size / 76;
  const fill = (x, y, w, h, r) => {
    g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); g.clip();
    if (wood) g.drawImage(wood, x, y, w, Math.max(w, h)); else { g.fillStyle = '#a0763f'; g.fillRect(x, y, w, h); }
    g.fillStyle = 'rgba(0,0,0,.12)'; g.fillRect(x, y + h - 3 * u, w, 3 * u);
    g.restore();
  };
  fill(33 * u, 40 * u, 10 * u, 32 * u, 2 * u);                 // the post
  g.fillStyle = 'rgba(0,0,0,.25)'; g.fillRect(35 * u, 40 * u, 8 * u, 4 * u);
  fill(8 * u, 10 * u, 60 * u, 34 * u, 5 * u);                  // the board
  g.strokeStyle = 'rgba(40,24,10,.55)'; g.lineWidth = 2 * u; g.beginPath(); g.roundRect ? g.roundRect(8 * u, 10 * u, 60 * u, 34 * u, 5 * u) : g.rect(8 * u, 10 * u, 60 * u, 34 * u); g.stroke();
  g.fillStyle = '#f6ecd6';                                      // the cream panel signs are written on
  g.fillRect(14 * u, 15 * u, 48 * u, 24 * u);
  g.fillStyle = '#3a2a1a';
  for (const [y, w] of [[19, 36], [26, 28], [33, 32]]) g.fillRect((38 - w / 2) * u, y * u, w * u, 3 * u);
  return c;
}

export function createBuildUi(ctx, { blocks, paint, keys = true, onSlot, onTool, onColor, onSign }) {
  const style = el('style'); style.textContent = CSS; document.head.append(style);
  const root = el('div'); root.id = 'gf-build';
  const tools = el('div', 'gf-tools');
  const name = el('div'); name.id = 'gf-build-name';
  ctx.ui.root.append(root, name);
  ctx.ui.root.classList.add('gf-hotbar');
  let nameT = null, mode = 'blocks';
  const stop = e => { e.preventDefault(); e.stopPropagation(); };

  const toolBtn = (id, icon, key, title) => {
    const b = el('button', 'gf-tool'); b.type = 'button'; b.id = `gf-tool-${id}`; b.title = title; b.innerHTML = ICONS[icon];
    if (keys) b.append(el('b', null, key));
    b.addEventListener('pointerdown', stop); b.addEventListener('click', e => { stop(e); onTool(id); });
    tools.append(b); return b;
  };
  const breakBtn = toolBtn('break', 'break', 'X', 'Break (X)');
  const paintBtn = toolBtn('paint', 'paint', 'P', 'Paint (P)');

  // the hotbar is the shared inventory panel in its bar mode (kit/ui/panels: the sideways scroll with an arrow at an end
  // that has more, the slot labels, the selected slot lifted); this part keeps what a slot means: a block, a colour
  const blockItems = () => blocks.map((b, i) => ({ id: String(i), name: b.label, node: b.icon ?? el('span', null, b.label.slice(0, 2)) }));
  const colorItems = () => [{ color: null, label: 'Wash off paint' }, ...paint.map((c, i) => ({ color: c, label: `Colour ${i + 1}` }))]
    .map((c, i) => { const s = el('i', c.color ? '' : 'wash'); if (c.color) s.style.background = c.color; return { id: String(i), name: c.label, node: s }; });
  const bar = ctx.ui.panels.inventory({ id: 'build-hotbar', mode: 'bar', into: root, barId: 'gf-hotbar', slotClass: 'gf-slot', maxWidth: 'calc(100vw - 132px)', keys: keys ? 'labels' : false,
    words: { more: 'More blocks' }, items: blockItems(), onSelect: ({ index }) => { if (mode === 'blocks') onSlot(index); else onColor(index); } });
  root.append(tools);

  // the sign editor is the shared text input: three lines, sixty characters, Ctrl+Enter or the button puts it up
  let signH = null;
  const keysHint = ctx.input?.touch ? '' : ' · Ctrl+Enter puts it up';

  return {
    root,
    select(i, tool) {
      // switching between blocks and colours starts the bar at its first slot ("wash off" stays in view)
      if (tool === 'paint' && mode !== 'colors') { mode = 'colors'; bar.update({ items: colorItems(), selected: i, scroll: 0 }); }
      else if (tool !== 'paint' && mode !== 'blocks') { mode = 'blocks'; bar.update({ items: blockItems(), selected: i, scroll: 0 }); }
      else bar.select(i);
      breakBtn.classList.toggle('on', tool === 'break');
      paintBtn.classList.toggle('on', tool === 'paint');
    },
    say(text) { name.textContent = text; name.classList.add('on'); clearTimeout(nameT); nameT = setTimeout(() => name.classList.remove('on'), 1300); },
    /** Open the sign editor with the words a sign has now; cb(text | null). */
    editSign(text, cb) {
      signH = ctx.ui.panels.input({ id: 'sign', domId: 'gf-sign-editor', ids: { field: 'gf-sign-text', ok: 'gf-sign-ok', cancel: 'gf-sign-cancel' }, title: 'Write on the sign', lines: 3, maxLength: 60, value: text ?? '',
        words: { ok: 'Put it up', cancel: 'Cancel', placeholder: 'Up to 3 short lines', hint: keysHint.replace(/^ · /, '') } });
      signH.done.then(v => cb?.(v === null ? null : v));
      onSign?.(true);
    },
    get editing() { return !!signH?.open; },
    closeSign: () => signH?.close(null),
    get mode() { return mode; },
    observe: () => ({ mode, hotbar: [...root.querySelectorAll('.gfp-bar .gfp-slot')].map(b => ({ i: Number(b.dataset.i), on: b.classList.contains('on'), title: b.title })), break: breakBtn.classList.contains('on'), paint: paintBtn.classList.contains('on'), signOpen: !!signH?.open }),
    dispose() { bar.close(); signH?.close(null); root.remove(); name.remove(); style.remove(); ctx.ui.root.classList.remove('gf-hotbar'); },
  };
}
