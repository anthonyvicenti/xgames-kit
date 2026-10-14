// The Economy tab's own pieces of page: the money-flow picture (inline SVG drawn from economy-parts.js's layout, in
// the studio's theme colours so it reads in light and dark) and the tab's styles, scoped under .gfw3 .econ.
import { flowGraph, layoutFlow } from './economy-parts.js';

const NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

/** The colour of each kind of line and box, as theme variables. */
// --econ-item is the second accent mixed half and half with the text colour (the tab's CSS below): the studio's lime
// alone is too pale on the light theme's white. A box with no colour of its own (a part) is outlined in --muted, which
// reads at 3:1 or more on both themes' cards (--line, its old outline, was about 1.2:1).
const EDGE = { pay: '--accent', payout: '--good', burn: '--bad', treasury: '--warn', lock: '--muted', item: '--econ-item', move: '--accent' };
const NODE = { players: '--text', pool: '--accent', winners: '--good', places: '--good', stakers: '--good', treasury: '--warn', burn: '--bad', account: '--muted', item: '--econ-item' };
const colour = (name, fallback = '#8b7cff') => `var(${name}, ${fallback})`;
const clip = (text, px, size) => {
  const max = Math.max(4, Math.floor(px / (size * 0.56)));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * The money flow as an SVG `width` wide. opts: { onPick(part), live: Map(partId → 'live' | 'changed'), selected }.
 * Every box that is a part is a button (click, Enter or Space) that opens its card.
 */
export function drawFlow(spec, width, { onPick = () => {}, live = new Map(), selected = null } = {}) {
  const graph = flowGraph(spec);
  const L = layoutFlow(graph, width);
  const root = svg('svg', { class: 'econ-flow', width: L.width, height: L.height, viewBox: `0 0 ${L.width} ${L.height}`, role: 'img', 'aria-label': 'Where the money goes: players pay into the parts, the parts fill the pools, the pools pay out.', 'data-testid': 'econ-flow' });
  const defs = svg('defs');
  for (const [kind, v] of Object.entries(EDGE))
    defs.append(svg('marker', { id: `econ-arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, svg('path', { d: 'M0,0 L10,5 L0,10 z', style: `fill:${colour(v)}` })));
  root.append(defs);
  const lines = svg('g', { class: 'econ-edges' });
  const labels = svg('g', { class: 'econ-labels' });
  for (const e of L.edges) {
    lines.append(svg('path', { d: e.d, class: `econ-edge ${e.kind}`, style: `stroke:${colour(EDGE[e.kind])}`, 'marker-end': `url(#econ-arrow-${e.kind})`, 'data-from': e.from, 'data-to': e.to }));
    if (e.label) {
      labels.append(svg('g', { class: 'econ-label', transform: `translate(${Math.round(e.lx)},${Math.round(e.ly)})` },
        svg('rect', { x: -e.lw / 2, y: -9, width: e.lw, height: 18, rx: 9, style: `stroke:${colour(EDGE[e.kind])}` }),
        svg('text', { x: 0, y: 4, 'text-anchor': 'middle' }, e.label)));
    }
  }
  root.append(lines);
  const boxes = svg('g', { class: 'econ-nodes' });
  const big = L.width < 480 ? 12 : 13; // a phone's narrower boxes take a smaller letter
  for (const n of L.nodes) {
    const id = n.part ? `${n.part.section}:${n.part.key}` : null;
    const state = id ? live.get(id) : null;
    const g = svg('g', {
      class: `econ-node ${n.kind}${n.part ? ' pick' : ''}${selected && id === selected ? ' on' : ''}`,
      transform: `translate(${n.x},${n.y})`,
      ...(n.part ? { role: 'button', tabindex: 0, 'aria-label': `${n.label}: open its card`, 'data-part': id } : {}),
    },
    svg('title', {}, `${n.label}${n.sub ? `: ${n.sub}` : ''}`),
    svg('rect', { width: n.w, height: n.h, rx: 9, style: `stroke:${colour(NODE[n.kind] ?? '--muted', '#9aa4b5')}` }),
    svg('text', { x: 9, y: 18, class: 'econ-node-label', style: `font-size:${big}px` }, clip(n.label, n.w - (state ? 28 : 16), big)),
    svg('text', { x: 9, y: 34, class: 'econ-node-sub', style: `font-size:${big - 2}px` }, clip(n.sub, n.w - 16, big - 2)),
    state ? svg('circle', { cx: n.w - 12, cy: 13, r: 4.5, class: `econ-dot ${state}` }, svg('title', {}, state === 'live' ? 'Live' : 'Changed since it went live')) : null);
    if (n.part) {
      g.addEventListener('click', () => onPick(n.part));
      g.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(n.part);
        }
      });
    }
    boxes.append(g);
  }
  const captions = svg('g', { class: 'econ-captions' }, L.captions.map((c) => svg('text', { x: 8, y: c.y, class: 'econ-caption' }, c.text)));
  root.append(captions, boxes, labels);
  return root;
}

/** The legend under the picture: what each colour of line means. */
export const LEGEND = [
  ['pay', 'players pay in'],
  ['payout', 'paid out'],
  ['treasury', 'to your treasury'],
  ['burn', 'burned'],
  ['lock', 'locked or handed in'],
];
export const edgeColour = (kind) => colour(EDGE[kind]);

const CSS = `
.gfw3.econ{max-width:none;gap:12px;--econ-item:color-mix(in srgb,var(--accent-2,#b9f26c) 50%,var(--text,#e8ecf3))}
.gfw3 .econ-flow{display:block;max-width:100%;height:auto;overflow:visible}
.gfw3 .econ-caption{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;fill:var(--muted,#9aa4b5);paint-order:stroke;stroke:var(--panel-2,#161a22);stroke-width:5px;stroke-linejoin:round}
.gfw3 .econ-edge{fill:none;stroke-width:2;opacity:.8}
.gfw3 .econ-edge.lock,.gfw3 .econ-edge.move{stroke-dasharray:5 4}
.gfw3 .econ-label rect{fill:var(--panel,#0f1218);stroke-width:1;opacity:.96}
.gfw3 .econ-label text{font-size:11px;fill:var(--text,#e8ecf3)}
.gfw3 .econ-node rect{fill:var(--panel-2,#161a22);stroke-width:1.5}
.gfw3 .econ-node.pool rect{stroke-width:2}
.gfw3 .econ-node-label{font-size:13px;font-weight:600;fill:var(--text,#e8ecf3)}
.gfw3 .econ-node-sub{font-size:11px;fill:var(--muted,#9aa4b5)}
.gfw3 .econ-node.pick{cursor:pointer}
.gfw3 .econ-node.pick:hover rect,.gfw3 .econ-node.pick:focus rect,.gfw3 .econ-node.on rect{fill:var(--panel,#0f1218);stroke-width:3}
.gfw3 .econ-node.pick:focus{outline:none}
.gfw3 .econ-dot.live{fill:var(--good,#4fd18b)}.gfw3 .econ-dot.changed{fill:var(--warn,#ffcf5a)}
.gfw3 .econ-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--muted,#9aa4b5);margin-top:6px}
.gfw3 .econ-legend i{display:inline-block;width:18px;height:3px;border-radius:2px;vertical-align:middle;margin-right:5px}
.gfw3 .econ-part{display:grid;gap:8px;scroll-margin:12px;transition:box-shadow .3s}
.gfw3 .econ-part.flash{box-shadow:0 0 0 3px var(--accent,#8b7cff)}
.gfw3 .econ-part-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gfw3 .econ-part-head strong{font-size:15px}
.gfw3 .econ-kind{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#9aa4b5);border:1px solid var(--line,#2a3140);border-radius:999px;padding:1px 8px}
.gfw3 .econ-key{font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--muted,#9aa4b5)}
.gfw3 .econ-state{font-size:12px;margin-left:auto}.gfw3 .econ-state.live{color:color-mix(in srgb,var(--good,#4fd18b) 65%,var(--text,#e8ecf3))}.gfw3 .econ-state.changed{color:color-mix(in srgb,var(--warn,#c58a00) 65%,var(--text,#e8ecf3))}
.gfw3 .econ-state.draft{color:var(--muted,#9aa4b5)}
.gfw3 .econ-fields{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px 10px}
.gfw3 .econ-fields label.field{font-size:12px}
.gfw3 .econ-fields label.field.wide{grid-column:1/-1}
.gfw3 label.check{display:flex;gap:6px;align-items:center;font-size:13px;color:var(--text,#e8ecf3)}
.gfw3 label.check input{width:auto}
.gfw3 .econ-rows{display:grid;gap:6px}
.gfw3 .econ-rows-head{font-size:12px;color:var(--muted,#9aa4b5);display:flex;justify-content:space-between;align-items:center;gap:8px}
.gfw3 .econ-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px;border:1px dashed var(--line,#2a3140);border-radius:8px}
.gfw3 .econ-row > *{flex:1 1 90px;min-width:0}
.gfw3 .econ-row > .num{flex:0 1 86px}
.gfw3 .econ-row > button.x{flex:0 0 auto;padding:4px 9px}
.gfw3 .econ-row .unit{flex:0 0 auto;font-size:12px;color:var(--muted,#9aa4b5)}
.gfw3 .econ-facts{display:grid;gap:2px;padding:8px 10px;border-radius:8px;background:var(--panel,transparent);border-left:3px solid var(--accent,#8b7cff);font-size:13px}
.gfw3 .econ-facts b{font-weight:600}
.gfw3 .econ-note{padding:7px 10px;border-radius:8px;font-size:13px;background:var(--panel,transparent);border:1px solid var(--line,#2a3140)}
.gfw3 .econ-note.refusal{border-left:4px solid var(--bad,#ff7a7a)}
.gfw3 .econ-note.warning{border-left:4px solid var(--warn,#ffcf5a)}
.gfw3 .econ-note .fix{color:var(--muted,#9aa4b5);margin-top:2px}
.gfw3 .econ-note .code{white-space:nowrap;font-family:var(--mono,ui-monospace,monospace);font-size:11px;color:var(--muted,#9aa4b5)}
.gfw3 .econ-day{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--muted,#9aa4b5)}
.gfw3 .econ-day input{width:84px}
.gfw3 .econ-add{display:flex;flex-wrap:wrap;gap:6px}
.gfw3 .econ-add button{font-size:13px;padding:5px 10px}
.gfw3 .econ-live{display:grid;gap:8px}
.gfw3 .econ-go{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.gfw3 .econ-go .why{flex:1 1 220px}
.gfw3 .econ-cost{font-size:22px;font-weight:700}
.gfw3 .econ-receipts{margin:0;padding-left:18px;display:grid;gap:3px;font-size:13px}
.gfw3 .econ-receipts a{color:var(--accent,#8b7cff)}
.gfw3 .econ-group{display:grid;gap:10px}
.gfw3 .econ-group > h3{margin:6px 0 0;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted,#9aa4b5)}
.gfw3 .econ-sum{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.gfw3 .econ-sum div{padding:8px 10px;border-radius:8px;background:var(--panel,transparent);border:1px solid var(--line,#2a3140)}
.gfw3 .econ-sum b{display:block;font-size:16px}
.gfw3 .econ-sum span{font-size:12px;color:var(--muted,#9aa4b5)}
.gfw3 .linkish{background:none;border:0;padding:0;color:var(--accent,#8b7cff);cursor:pointer;font:inherit;text-decoration:underline}
.gfw3 input.bad{border-color:var(--bad,#ff7a7a)}
.gfw3 .econ-token{display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap}
`;
export function econStyles() {
  if (document.getElementById('gfw3-econ-styles')) return;
  document.head.append(Object.assign(document.createElement('style'), { id: 'gfw3-econ-styles', textContent: CSS }));
}
