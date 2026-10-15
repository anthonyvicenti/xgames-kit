// gf-three ui: widget variants the shared HUD did not have, for any game (UI only, never art: CONTRACT §2). Each one is
// drawn in the HUD's own tokens (the CSS custom properties --gf-panel, --gf-accent, --gf-text, --gf-ink, --gf-ink-w and
// the layer's data-shape / data-layout: ./kind-hud.js), so the same call reads as a comic dial in an inked cartoon HUD,
// a squared plate in a plate HUD and a plain panel with no tokens at all. A game's rules or a mechanic calls them:
//
//   ui.dial(id, {kind, value, label, where, marks, facing}) → {set(value, extra), remove(), el}
//        kind 'aim'      a half dial with a pointer: value = degrees above level (-90 … 90); facing -1 mirrors it
//             'power'    a three-quarter arc that fills: value 0 … 1
//             'wind'     a strip of five chevrons: value -1 … 1 (the sign is the way it blows)
//             'compass'  a round dial with N E S W round it and coloured dots: value = heading in degrees, marks
//                        [{angle, color}] (degrees, 0 = north)
//             'gauge'    a round badge with a number: value (any), label under it
//        where 'tl' (under the menu button), 'bl' (over the player card), 'br' (over the clock), 'tr' (under the
//              scores), 'bc' (bottom middle). Default: compass tl, the rest bl.
//   ui.teams(rows | null)          team health cards at the bottom middle: rows [{id, name, color, value, max}]; a card
//                                  whose value fell flashes; null removes them (the kit's HUD fills them itself for a
//                                  game with teams and health when the HUD's widgets name team-cards: ./hud.js)
//   ui.turnTimer(seconds | null, {color, label, low = 5})   a turn clock badge (round in a dial HUD, else a pill), bottom right
//   ui.weapons({items, pick, layout, columns, title, onPick, keepOpen}) → {open(), close(), toggle(), set(id), isOpen, remove()}
//        items [{id, label, icon?, count?}]: a grid (layout 'grid') or a wheel round the middle ('wheel'); a click picks
//   ui.announce(text, {sub, seconds = 2, color})   big inked words over a burst in the middle ("Direct hit!")
//   ui.widgets()  → [{id, kind, where, shown, value}]: what is on screen now (tests and the observation read it)
//
// Plain DOM and inline SVG; a widget is made once and only its numbers change after that (no work per frame).

const CSS = `
#gf-ui .gf-dock{position:absolute;display:flex;gap:10px;align-items:flex-end;pointer-events:none}
#gf-ui .gf-dock[data-at=tl]{top:62px;left:12px;flex-direction:column;align-items:flex-start}
#gf-ui .gf-dock[data-at=bl]{left:12px;bottom:12px;flex-direction:row}
#gf-ui .gf-dock[data-at=br]{right:18px;bottom:18px;flex-direction:column;align-items:flex-end}
#gf-ui .gf-dock[data-at=tr]{right:12px;top:12px;flex-direction:column;align-items:flex-end}
#gf-ui .gf-dock[data-at=bc]{left:50%;bottom:34px;translate:-50% 0;flex-direction:column;align-items:stretch;gap:5px}
#gf-ui .gf-dial{position:relative;display:flex;flex-direction:column;align-items:center;gap:2px;color:var(--gf-text,#fff)}
#gf-ui .gf-dial svg{display:block;overflow:visible;filter:drop-shadow(0 3px 0 #0004)}
#gf-ui .gf-dial .face{fill:var(--gf-panel,#1c2133cc);stroke:var(--gf-ink,#0009);stroke-width:max(2px,var(--gf-ink-w,2px))}
#gf-ui .gf-dial .ink{stroke:var(--gf-ink,#0009);stroke-width:max(2px,var(--gf-ink-w,2px));stroke-linejoin:round;stroke-linecap:round}
#gf-ui .gf-dial .acc{fill:var(--gf-accent,#ff7a59)}
#gf-ui .gf-dial .track{fill:none;stroke:#ffffff2a;stroke-width:9}
#gf-ui .gf-dial .fill{fill:none;stroke:var(--gf-accent,#ff7a59);stroke-width:9;stroke-linecap:round}
#gf-ui .gf-dial .off{fill:#ffffff40;stroke-width:max(1.5px,calc(var(--gf-ink-w,2px) * .5))}
#gf-ui .gf-dial text{fill:var(--gf-text,#fff);font:inherit;font-size:15px;text-anchor:middle;dominant-baseline:central;paint-order:stroke fill;stroke:var(--gf-ink,#0009);stroke-width:max(2px,var(--gf-ink-w,2px))}
#gf-ui .gf-dial em{font-style:normal;font-size:12px;opacity:.9;-webkit-text-stroke:max(0px,calc(var(--gf-ink-w,0px) * .5)) var(--gf-ink,#000);paint-order:stroke fill}
#gf-ui .gf-team{display:grid;grid-template-columns:minmax(80px,auto) minmax(150px,240px);align-items:center;gap:10px}
#gf-ui .gf-team b{color:var(--c,#fff);font-size:18px;text-align:right;white-space:nowrap;-webkit-text-stroke:max(1.5px,calc(var(--gf-ink-w,2px) * .8)) var(--gf-ink,#000a);paint-order:stroke fill;text-shadow:0 2px 0 var(--gf-ink,#000a)}
#gf-ui .gf-team span{position:relative;height:20px;border-radius:min(var(--gf-team-r,6px),10px);background:#00000059;overflow:hidden;box-shadow:0 0 0 max(2px,var(--gf-ink-w,2px)) var(--gf-ink,#000a)}
#gf-ui .gf-team span u{position:absolute;inset:0 auto 0 0;background:#fff;transition:width .4s ease-in .3s}
#gf-ui .gf-team span i{position:absolute;inset:0 auto 0 0;background:var(--c,#ff5e6c);box-shadow:inset 0 -5px 0 #0003,inset 0 3px 0 #ffffff40}
#gf-ui .gf-team.hit span{box-shadow:0 0 0 max(2px,var(--gf-ink-w,2px)) #fff}
#gf-ui .gf-turn{min-width:62px;height:40px;padding:0 14px;border-radius:999px;display:flex;align-items:center;justify-content:center;gap:6px;font-size:22px;font-variant-numeric:tabular-nums;background:var(--gf-panel,#1c2133cc);color:var(--gf-text,#fff);box-shadow:0 0 0 var(--gf-ink-w,0px) var(--gf-ink,#000),0 4px 0 var(--gf-ink-w,0px) var(--gf-ink,#0000);-webkit-text-stroke:calc(var(--gf-ink-w,0px) * .6) var(--gf-ink,#000);paint-order:stroke fill}
#gf-ui[data-shape=dial] .gf-turn{width:78px;height:78px;min-width:0;padding:0;border-radius:50%;font-size:26px}
#gf-ui .gf-turn i{width:12px;height:12px;border-radius:50%;background:var(--c,var(--gf-accent,#ff7a59));box-shadow:0 0 0 2px var(--gf-ink,#0006)}
#gf-ui[data-shape=dial] .gf-turn i{display:none}
#gf-ui[data-shape=dial] .gf-turn{box-shadow:0 0 0 var(--gf-ink-w,0px) var(--gf-ink,#000),0 4px 0 var(--gf-ink-w,0px) var(--gf-ink,#0000),inset 0 0 0 5px var(--c,transparent)}
#gf-ui .gf-turn.low{animation:gf-turn-low .8s ease-in-out infinite}
@keyframes gf-turn-low{50%{scale:1.1;color:#ffd166}}
#gf-ui .gf-weapons{position:absolute;right:18px;top:50%;translate:0 -50%;pointer-events:auto;display:none;padding:10px;border-radius:min(var(--gf-w-r,14px),16px);background:var(--gf-panel,#1c2133ee);box-shadow:0 0 0 var(--gf-ink-w,0px) var(--gf-ink,#000),0 6px 22px #0006}
#gf-ui .gf-weapons.on{display:block}
#gf-ui .gf-weapons h3{margin:0 0 8px;font-size:15px;text-align:center}
#gf-ui .gf-weapons .grid{display:grid;grid-template-columns:repeat(var(--cols,5),58px);gap:7px}
#gf-ui .gf-weapons button{position:relative;width:58px;height:58px;border:0;border-radius:min(var(--gf-w-r,12px),12px);background:#ffffff1f;color:var(--gf-text,#fff);font:inherit;font-size:24px;line-height:1;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;box-shadow:0 0 0 max(1.5px,calc(var(--gf-ink-w,2px) * .6)) var(--gf-ink,#0006)}
#gf-ui .gf-weapons button small{font-size:10px;opacity:.9;max-width:54px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gf-ui .gf-weapons button sup{position:absolute;right:3px;top:2px;font-size:11px}
#gf-ui .gf-weapons button img{width:30px;height:30px;object-fit:contain}
#gf-ui .gf-weapons button.pick{background:var(--gf-accent,#ff7a59);color:#fff}
#gf-ui .gf-weapons button:hover{filter:brightness(1.2)}
#gf-ui .gf-weapons.wheel{right:auto;left:50%;top:50%;translate:-50% -50%;width:300px;height:300px;padding:0;border-radius:50%}
#gf-ui .gf-weapons.wheel .grid{display:block;position:relative;width:100%;height:100%}
#gf-ui .gf-weapons.wheel button{position:absolute;left:50%;top:50%;margin:-29px;border-radius:50%}
#gf-ui .gf-weapons.wheel h3{position:absolute;left:50%;top:50%;translate:-50% -50%;margin:0;max-width:110px}
#gf-ui .gf-announce{position:absolute;left:50%;top:30%;translate:-50% -50%;display:none;flex-direction:column;align-items:center;pointer-events:none}
#gf-ui .gf-announce.on{display:flex}
#gf-ui .gf-announce svg{position:absolute;left:50%;top:50%;width:150%;height:250%;translate:-50% -50%;z-index:-1;overflow:visible}
#gf-ui .gf-announce svg polygon{fill:var(--c,var(--gf-accent,#ffc020));stroke:var(--gf-ink,#0000);stroke-width:max(0px,var(--gf-ink-w,0px));stroke-linejoin:round}
#gf-ui .gf-announce b{font-size:52px;line-height:1;color:#fff;white-space:nowrap;-webkit-text-stroke:max(3px,var(--gf-ink-w,3px)) var(--gf-ink,#000c);paint-order:stroke fill;text-shadow:0 5px 0 var(--gf-ink,#000a)}
#gf-ui .gf-announce small{margin-top:4px;font-size:20px;color:#fff;-webkit-text-stroke:max(2px,calc(var(--gf-ink-w,2px) * .7)) var(--gf-ink,#000c);paint-order:stroke fill}
#gf-ui[data-shape=banner] .gf-announce b{rotate:-4deg}
@media (max-width:640px){#gf-ui .gf-dock[data-at=tl]{top:52px}#gf-ui .gf-dial svg{scale:.8}#gf-ui .gf-team{grid-template-columns:auto 120px}#gf-ui .gf-team b{font-size:14px}#gf-ui .gf-announce b{font-size:34px}#gf-ui .gf-weapons .grid{grid-template-columns:repeat(var(--cols,5),46px)}#gf-ui .gf-weapons button{width:46px;height:46px}}
`;

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r1 = v => Math.round(v * 10) / 10;
const DEF_WHERE = { compass: 'tl', aim: 'bl', power: 'bl', wind: 'bl', gauge: 'tr' };
const fmt = s => { s = Math.max(0, Math.ceil(s)); return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : String(s); };
/** A point on a circle (degrees, 0 = right, counter-clockwise up). */
const at = (cx, cy, r, deg) => [cx + Math.cos(deg * Math.PI / 180) * r, cy - Math.sin(deg * Math.PI / 180) * r];
const arc = (cx, cy, r, a0, a1) => { const [x0, y0] = at(cx, cy, r, a0), [x1, y1] = at(cx, cy, r, a1); const large = Math.abs(a1 - a0) > 180 ? 1 : 0; return `M${x0.toFixed(1)} ${y0.toFixed(1)}A${r} ${r} 0 ${large} ${a1 < a0 ? 1 : 0} ${x1.toFixed(1)} ${y1.toFixed(1)}`; };

/** The widget kinds: each builds its SVG once and returns draw(value, extra). */
const KINDS = {
  aim(svg, o) {
    svg.setAttribute('viewBox', '-6 -6 76 108'); svg.setAttribute('width', 76); svg.setAttribute('height', 108);
    const f = o.facing === -1 ? -1 : 1, g = svgEl('g', f === -1 ? { transform: 'translate(64 0) scale(-1 1)' } : {});
    g.append(svgEl('path', { class: 'face', d: 'M10 2 A 48 48 0 0 1 10 98 Z' }));
    for (const a of [90, 45, 0, -45, -90]) { const [x, y] = at(10, 50, 44, a); g.append(svgEl('circle', { class: 'acc ink', cx: x.toFixed(1), cy: y.toFixed(1), r: a % 90 ? 2.6 : 4 })); }
    const hand = svgEl('g'); hand.append(svgEl('line', { class: 'ink', x1: 10, y1: 50, x2: 50, y2: 50, style: 'stroke-width:calc(max(2px,var(--gf-ink-w,2px)) + 4px)' }), svgEl('line', { x1: 10, y1: 50, x2: 50, y2: 50, stroke: 'var(--gf-accent,#ff7a59)', 'stroke-width': 4, 'stroke-linecap': 'round' }),
      svgEl('path', { class: 'ink', d: 'M46 42 L60 50 L46 58 Z', fill: 'var(--gf-accent,#ff7a59)' }));
    g.append(hand, svgEl('circle', { class: 'ink', cx: 10, cy: 50, r: 8, fill: '#e0303a' }));
    svg.append(g);
    return v => { hand.setAttribute('transform', `rotate(${(-clamp(v, -90, 90)).toFixed(1)} 10 50)`); };
  },
  power(svg) {
    svg.setAttribute('viewBox', '0 0 80 80'); svg.setAttribute('width', 80); svg.setAttribute('height', 80);
    svg.append(svgEl('circle', { class: 'face', cx: 40, cy: 40, r: 36 }), svgEl('path', { class: 'track', d: arc(40, 40, 25, 225, -45) }));
    const fill = svgEl('path', { class: 'fill' }), num = svgEl('text', { x: 40, y: 42 });
    svg.append(fill, num);
    return v => { const k = clamp(v, 0, 1); fill.setAttribute('d', k > 0.005 ? arc(40, 40, 25, 225, 225 - 270 * k) : ''); fill.style.stroke = k > 0.8 ? '#ff4040' : ''; num.textContent = `${Math.round(k * 100)}`; };
  },
  wind(svg) {
    svg.setAttribute('viewBox', '0 0 132 40'); svg.setAttribute('width', 132); svg.setAttribute('height', 40);
    svg.append(svgEl('rect', { class: 'face', x: 2, y: 2, width: 128, height: 36, rx: 18 }));
    const ch = []; for (let i = 0; i < 5; i++) { const p = svgEl('path', { class: 'ink off' }); svg.append(p); ch.push(p); }
    return v => {
      const k = clamp(v, -1, 1), n = Math.round(Math.abs(k) * 5), dir = k < 0 ? -1 : 1;
      ch.forEach((p, i) => {
        const x = dir > 0 ? 18 + i * 21 : 114 - i * 21;
        p.setAttribute('d', dir > 0 ? `M${x} 11 L${x + 12} 20 L${x} 29 L${x + 5} 20 Z` : `M${x} 11 L${x - 12} 20 L${x} 29 L${x - 5} 20 Z`);
        p.setAttribute('class', i < n ? 'ink acc' : 'ink off');
      });
    };
  },
  compass(svg, o) {
    svg.setAttribute('viewBox', '-14 -14 108 108'); svg.setAttribute('width', 108); svg.setAttribute('height', 108);
    svg.append(svgEl('circle', { class: 'face', cx: 40, cy: 40, r: 34 }), svgEl('path', { d: 'M40 14 V66 M14 40 H66', stroke: '#ffffff30', 'stroke-width': 3 }));
    const rose = svgEl('g'), marks = svgEl('g');
    for (const [t, a] of [['N', 90], ['E', 0], ['S', -90], ['W', 180]]) { const [x, y] = at(40, 40, 45, a); const tx = svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), style: 'font-size:14px' }); tx.textContent = t; tx.style.fill = 'var(--gf-accent,#ffc020)'; rose.append(tx); }
    svg.append(rose, marks);
    return (v, extra = {}) => {
      rose.setAttribute('transform', `rotate(${(-(v || 0)).toFixed(1)} 40 40)`);
      const list = extra.marks ?? o.marks ?? [];
      marks.replaceChildren(...list.slice(0, 16).map(m => { const [x, y] = at(40, 40, 34, 90 - (m.angle ?? 0) + (v || 0)); return svgEl('circle', { class: 'ink', cx: x.toFixed(1), cy: y.toFixed(1), r: 5, fill: m.color ?? '#fff' }); }));
    };
  },
  gauge(svg) {
    svg.setAttribute('viewBox', '0 0 76 76'); svg.setAttribute('width', 76); svg.setAttribute('height', 76);
    svg.append(svgEl('circle', { class: 'face', cx: 38, cy: 38, r: 34 }));
    const num = svgEl('text', { x: 38, y: 40, style: 'font-size:24px' }); svg.append(num);
    return v => { num.textContent = typeof v === 'number' ? String(r1(v)) : String(v ?? ''); };
  },
};

export function createWidgets(ctx, ui) {
  const style = el('style'); style.id = 'gf-widgets-css'; style.textContent = CSS; document.head.append(style);
  const root = ui.root, docks = new Map(), dials = new Map();
  const dock = where => {
    let d = docks.get(where); if (d) return d;
    d = el('div', 'gf-dock'); d.dataset.at = where; root.append(d); docks.set(where, d);
    return d;
  };
  // the bottom-left dock rides over the kit's player card, the bottom-right one over the clock badge (corners layout)
  function place() {
    const card = document.getElementById('gf-hud'), bl = docks.get('bl'), br = docks.get('br');
    if (bl) bl.style.bottom = `${card && card.classList.contains('on') ? card.offsetHeight + 26 : 12}px`;
    if (br) { const t = root.querySelector('.gf-top'), corners = root.dataset.layout === 'corners' && t && getComputedStyle(t).bottom !== 'auto'; br.style.bottom = `${corners ? t.offsetHeight + 34 : 18}px`; }
  }
  let ro = null;
  const watch = () => { if (ro || typeof ResizeObserver === 'undefined') return; const card = document.getElementById('gf-hud'); if (!card) return; ro = new ResizeObserver(place); ro.observe(card); };

  let teamsBox = null; const teamRows = new Map();
  let turnEl = null, turnVal = null;
  let weaponsBox = null;
  const ann = el('div', 'gf-announce'), annText = el('b'), annSub = el('small'), burst = svgEl('svg', { viewBox: '-100 -50 200 100', preserveAspectRatio: 'none' });
  { const pts = []; for (let i = 0; i < 28; i++) { const a = (i / 28) * Math.PI * 2, r = i % 2 ? 0.62 : 1; pts.push(`${(Math.cos(a) * 100 * r).toFixed(1)},${(Math.sin(a) * 50 * r).toFixed(1)}`); } burst.append(svgEl('polygon', { points: pts.join(' ') })); }
  ann.append(burst, annText, annSub); root.append(ann);
  let annT = null;

  const api = {
    dial(id, { kind = 'gauge', value = 0, label = '', where = null, marks = null, facing = 1 } = {}) {
      let w = dials.get(id);
      if (!w || w.kind !== kind) {
        w?.box.remove();
        const box = el('div', 'gf-dial'), svg = svgEl('svg'); box.dataset.widget = `dial:${id}`; box.dataset.kind = kind;
        const draw = (KINDS[kind] ?? KINDS.gauge)(svg, { marks, facing });
        const cap = el('em', null, label); box.append(svg, cap);
        dock(where ?? DEF_WHERE[kind] ?? 'bl').append(box);
        w = { kind, box, draw, cap, value: null }; dials.set(id, w); watch(); place();
      }
      const h = {
        el: w.box,
        set(v, extra = {}) { w.value = v; w.draw(v, extra); w.box.dataset.value = String(typeof v === 'number' ? r1(v) : v); if (extra.label !== undefined) w.cap.textContent = extra.label; },
        remove() { w.box.remove(); dials.delete(id); },
      };
      if (label !== undefined) w.cap.textContent = label;
      w.cap.style.display = w.cap.textContent ? '' : 'none';
      h.set(value, marks ? { marks } : {});
      return h;
    },
    teams(rows) {
      if (!rows) { teamsBox?.remove(); teamsBox = null; teamRows.clear(); return; }
      if (!teamsBox) { teamsBox = dock('bc'); teamsBox.dataset.widget = 'teams'; }
      const seen = new Set();
      for (const r of rows) {
        const id = String(r.id ?? r.name); seen.add(id);
        let t = teamRows.get(id);
        if (!t) { const row = el('div', 'gf-team'), name = el('b'), bar = el('span'), lag = el('u'), fill = el('i'); bar.append(lag, fill); row.append(name, bar); teamsBox.append(row); t = { row, name, lag, fill, last: null }; teamRows.set(id, t); }
        const frac = clamp((r.value ?? 0) / (r.max || 1), 0, 1), pct = `${(frac * 100).toFixed(1)}%`;
        if (t.name.textContent !== r.name) t.name.textContent = r.name ?? id;
        t.row.style.setProperty('--c', r.color ?? '#ff5e6c');
        t.fill.style.width = pct; t.lag.style.width = pct;
        t.row.dataset.value = String(r1(r.value ?? 0)); t.row.dataset.max = String(r.max ?? 1);
        if (t.last !== null && (r.value ?? 0) < t.last - 1e-6) { t.row.classList.add('hit'); clearTimeout(t.h); t.h = setTimeout(() => t.row.classList.remove('hit'), 180); }
        t.last = r.value ?? 0;
      }
      for (const [id, t] of teamRows) if (!seen.has(id)) { t.row.remove(); teamRows.delete(id); }
    },
    turnTimer(seconds, { color = null, label = null, low = 5 } = {}) {
      if (seconds === null || seconds === undefined) { turnEl?.remove(); turnEl = null; turnVal = null; return; }
      if (!turnEl) { turnEl = el('div', 'gf-turn'); turnEl.dataset.widget = 'turn-timer'; turnEl.append(el('i'), el('span')); dock('br').append(turnEl); watch(); place(); }
      const t = fmt(seconds);
      if (turnVal !== t) { turnVal = t; turnEl.lastChild.textContent = label ? `${label} ${t}` : t; }
      turnEl.dataset.value = String(Math.max(0, Math.ceil(seconds)));
      if (color) turnEl.style.setProperty('--c', color); else turnEl.style.removeProperty('--c');
      turnEl.classList.toggle('low', seconds > 0 && seconds <= low);
    },
    weapons({ items = [], pick = null, layout = 'grid', columns = 5, title = '', onPick = null, keepOpen = false } = {}) {
      weaponsBox?.remove();
      const box = el('div', `gf-weapons${layout === 'wheel' ? ' wheel' : ''}`); box.dataset.widget = 'weapons';
      const grid = el('div', 'grid'); grid.style.setProperty('--cols', String(clamp(columns, 1, 8)));
      if (title) box.append(el('h3', null, title));
      const btns = new Map();
      items.forEach((it, i) => {
        const b = el('button'); b.type = 'button'; b.dataset.id = it.id; b.title = it.label ?? it.id;
        if (it.icon && /^(https?:|data:|\/|\.\/|assets\/)/.test(it.icon)) { const img = el('img'); img.src = it.icon; img.alt = ''; b.append(img); } else b.append(el('span', null, it.icon ?? (it.label ?? it.id).slice(0, 2)));
        b.append(el('small', null, it.label ?? it.id));
        if (it.count != null) b.append(el('sup', null, it.count === Infinity ? '∞' : String(it.count)));
        if (layout === 'wheel') { const a = (i / Math.max(1, items.length)) * Math.PI * 2 - Math.PI / 2; b.style.translate = `${(Math.cos(a) * 112).toFixed(1)}px ${(Math.sin(a) * 112).toFixed(1)}px`; }
        b.addEventListener('click', e => { e.stopPropagation(); h.set(it.id); onPick?.(it.id); if (!keepOpen) h.close(); });
        grid.append(b); btns.set(it.id, b);
      });
      box.append(grid); root.append(box); weaponsBox = box;
      // the round goes on while it is open (a pick is quick); a press on it never reaches the game as a shot
      for (const t of ['pointerdown', 'mousedown', 'touchstart']) box.addEventListener(t, e => e.stopPropagation(), { passive: true });
      const h = {
        open() { box.classList.add('on'); },
        close() { box.classList.remove('on'); },
        toggle() { if (box.classList.contains('on')) h.close(); else h.open(); },
        set(id) { for (const [k, b] of btns) b.classList.toggle('pick', k === id); box.dataset.value = id ?? ''; },
        get isOpen() { return box.classList.contains('on'); },
        remove() { h.close(); box.remove(); if (weaponsBox === box) weaponsBox = null; },
      };
      h.set(pick);
      return h;
    },
    announce(text, { sub = null, seconds = 2, color = null } = {}) {
      annText.textContent = String(text ?? ''); annSub.textContent = sub ? String(sub) : ''; annSub.style.display = sub ? '' : 'none';
      if (color) ann.style.setProperty('--c', color); else ann.style.removeProperty('--c');
      ann.classList.remove('on'); void ann.offsetWidth; ann.classList.add('on'); ann.dataset.value = annText.textContent;
      clearTimeout(annT); annT = setTimeout(() => { ann.classList.remove('on'); ann.dataset.value = ''; }, Math.max(0.3, seconds) * 1000);
    },
    /** What the widgets show now. */
    widgets() {
      const shown = e => !!e && e.isConnected && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 2;
      const out = [...dials].map(([id, w]) => ({ id: `dial:${id}`, kind: w.kind, where: w.box.parentElement?.dataset.at ?? null, shown: shown(w.box), value: w.value }));
      if (teamsBox) out.push({ id: 'teams', kind: 'teams', where: 'bc', shown: shown(teamsBox), value: [...teamRows.entries()].map(([id, t]) => ({ id, value: Number(t.row.dataset.value), max: Number(t.row.dataset.max) })) });
      if (turnEl) out.push({ id: 'turn-timer', kind: 'turn-timer', where: 'br', shown: shown(turnEl), value: Number(turnEl.dataset.value) });
      if (weaponsBox) out.push({ id: 'weapons', kind: 'weapons', where: null, shown: shown(weaponsBox), value: weaponsBox.dataset.value ?? null });
      if (ann.classList.contains('on')) out.push({ id: 'announce', kind: 'announce', where: null, shown: true, value: ann.dataset.value });
      return out;
    },
    /** Re-place the docks (the HUD's update calls it when its card shows or hides). */
    place,
  };
  return api;
}
