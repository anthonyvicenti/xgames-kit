// An outdoor party template (kit/world/templates/<id>.json: arena, backyard, plaza) → a recipe of the places vocabulary
// (open builder wave 10, track H; the places spike's from-yard.mjs). Pure. The template stays the data people and the
// slots edit; generate.js builds its world through this recipe, and the world is the one the template always gave
// (tests/d-places.test.mjs: byte for byte at every size and seed).
//
// The template's own hand layout is the small world (`place`, its props as they are). A bigger class keeps the
// middle's set-pieces where they are and moves what stands near an edge out with that edge (`stretch`), keeping the
// gates' ways in clear; the edge closes again with gaps only at the gates (`gates`, `edge`), rows of buildings close a
// square (`rows`), the backdrop rings follow it out so the world goes on (`backdrop-ring`), and the recipe's groups
// dress the new floor (`grow`).
//   fromYard(template) → { place, profile, rng, about, steps }
const SIZES = ['small', 'medium', 'large'];
const DROP_FROM_BASE = ['kind', 'sizes', 'edge', 'grow', 'outside', 'groups', 'footprints', 'setPieces'];
const LAYOUT = { props: [], scatter: [], spawns: [], zones: {} };
const sizeOf = (t, size) => t.sizes?.[size] ?? t.sizes?.small ?? t.size ?? [24, 24];

export function fromYard(t) {
  if (t.kind === 'indoor') throw new Error(`${t.template} is an indoor template (generate.js building): not an outdoor place`);
  const o = t.outside ?? {}, edge = t.edge ?? null, rows = o.rows ?? null;
  // the sizes that lay a row of buildings (the hand-placed ones go there); small only when the row says so
  const rowSizes = rows ? SIZES.filter(s => s !== 'small' || rows.small) : [];
  const edgePieces = new Set([...(edge ? [edge.piece, edge.corner, edge.gatePosts, ...(edge.also ?? [])] : [])].filter(Boolean));
  // the fields the place carries as they are, in the template's order (the layout's own lists are filled by the steps)
  const copy = JSON.parse(JSON.stringify(t));
  for (const k of DROP_FROM_BASE) delete copy[k];
  for (const [k, empty] of Object.entries(LAYOUT)) if (k in copy) copy[k] = JSON.parse(JSON.stringify(empty));
  const steps = [
    { do: 'rect', size: Object.fromEntries(SIZES.map(s => [s, sizeOf(t, s)])), copy },
    { do: 'zones', zones: t.zones ?? {} },
    { do: 'place', list: (t.props ?? []).filter(p => !edgePieces.has(p.prop)), without: Object.fromEntries(SIZES.map(s => [s, rowSizes.includes(s) ? rows.buildings : []])) },
  ];
  if (t.scatter?.length) steps.push({ do: 'scatter', list: t.scatter });
  steps.push({ do: 'spawns', at: t.spawns ?? [] });
  steps.push({ do: 'gates', gates: t.gates ?? {}, ...(t.gateWidth ? { width: t.gateWidth } : {}) });
  steps.push({ do: 'stretch', from: t.size ?? [24, 24], band: t.grow?.band ?? 4, footprints: t.footprints ?? {} });
  if (edge?.piece) { const { also, ...e } = edge; steps.push({ do: 'edge', ...e }); }
  if (rows && rowSizes.length) steps.push({ do: 'rows', ...rows, only: rowSizes, sizes: o.sizes ?? {} });
  for (const ring of [o.ring, ...(o.rings ?? [])].filter(Boolean)) steps.push({ do: 'backdrop-ring', ...ring, sizes: o.sizes ?? {} });
  if (t.grow) steps.push({ do: 'grow', band: t.grow.band ?? 4, footprints: t.footprints ?? {}, groups: t.groups ?? {}, per: Object.fromEntries(SIZES.map(s => [s, t.grow[s] ?? []])) });
  return { place: t.template, profile: 'standard-3d', rng: 'party', about: `the ${t.template} template (kit/world/templates/${t.template}.json) as a recipe (kit/world/from-yard.js)`, steps };
}
