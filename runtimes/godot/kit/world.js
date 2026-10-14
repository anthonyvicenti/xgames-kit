// runtime godot: the map as the game reads it (GF.world), from the kit's gf-tilemap-1 reader (readMap's result M):
// the cells and kinds as they are, the spawns (where a body stands) and the marks (cell centres) in metres, y up.
// Side-on (plane "side") y is height: a spawn stands on the bottom of its cell. Seen from above (plane "top") y is
// north, the map's -z (and z is kept: a 3D game stands on the same map at (x, 0, z)): row 0 is the top of the screen,
// and a spawn stands in the middle of its cell. Pure: the page and
// create (the editor's res://gf_alone.json) both use it.
export function worldFor(M) {
  const top = M.plane === 'top';
  // (seen from above a place also keeps its z: a 3D game on the same map stands at (x, 0, z))
  const at = p => (top ? { x: p.x, y: -p.z, z: p.z } : { x: p.x, y: p.y });
  const marks = {};
  for (const [name, list] of Object.entries(M.marks ?? {})) marks[name] = list.map(m => at(M.centre(m.c, m.r)));
  return {
    plane: M.plane, tile: M.tile, cols: M.cols, rows: M.rows, kinds: M.kinds, base: M.base, cells: M.cells,
    spawns: M.spawns.map(s => at(M.feet(s.c, s.r))), marks,
  };
}

/**
 * Seen from above: which cells a body can walk to from the spawns (no solid cell, four ways), and the spawns and marks
 * it cannot reach. The side-on map's reach is the jump model's (gf/three/flat/tilemap.js reachOf). → {problems, reached}
 */
export function walkReach(M) {
  const free = (c, r) => c >= 0 && r >= 0 && c < M.cols && r < M.rows && !M.solid(c, r);
  // from the first seat's spawn: every other spawn and every mark must be walkable from it
  const reached = new Set(), queue = [], first = M.spawns.find(s => free(s.c, s.r));
  if (first) { reached.add(`${first.c},${first.r}`); queue.push([first.c, first.r]); }
  while (queue.length) {
    const [c, r] = queue.shift();
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = `${c + dc},${r + dr}`; if (free(c + dc, r + dr) && !reached.has(k)) { reached.add(k); queue.push([c + dc, r + dr]); } }
  }
  const problems = [], where = (c, r) => `column ${c + 1}, row ${r + 1}`;
  for (const s of M.spawns) if (!free(s.c, s.r)) problems.push(`the spawn at ${where(s.c, s.r)} is on a solid cell`);
  for (const s of M.spawns) if (free(s.c, s.r) && !reached.has(`${s.c},${s.r}`)) problems.push(`the spawn at ${where(s.c, s.r)} is walled off from the others`);
  for (const [name, list] of Object.entries(M.marks ?? {})) for (const m of list) if (!reached.has(`${m.c},${m.r}`)) problems.push(`the mark "${name}" at ${where(m.c, m.r)} cannot be walked to from a spawn`);
  return { problems, reached };
}

/** A PNG's size from its header ([width, height]), or null when the bytes are not a PNG. Pure. */
export function pngSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50 || b[2] !== 0x4e || b[3] !== 0x47) return null;
  const u32 = i => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
  return [u32(16), u32(20)];
}

/**
 * Seen from above: what the field draws, as three's flat-2d draws it (gf/three/flat/drawplan.js: the base under every
 * cell, the kinds, soft "blend" edges on the cells' corners, "connect" kinds joined to themselves, dressing on a share
 * of a kind's cells, set pieces standing on their footprint's near edge with a shadow), packed small for the bridge:
 * {slots: [slot id], items: [[slot index (-1 a shadow), frame col, frame row, grid cols, grid rows, c, r, w, h, layer,
 * near (a set piece's near edge, else -1)]]}, c and r the item's centre in cell units (cell (c, r)'s middle is (c, r)).
 * art: {tiles, edges, dress} Sets of kinds that have the picture; sizes: {slot: [w, h]}; ppm: texels a metre.
 */
export function planFor(M, drawPlan, { tiles = new Set(), edges = new Set(), dress = new Set(), sizes = {}, ppm = 16 } = {}) {
  const slots = [], index = new Map(), r3 = v => Math.round(v * 1000) / 1000;
  const slotOf = s => { if (!s) return -1; if (!index.has(s)) { index.set(s, slots.length); slots.push(s); } return index.get(s); };
  const items = drawPlan(M, { tiles, edges, dress, sizes, ppm })
    .sort((a, b) => a.layer - b.layer || (a.sub ?? 0) - (b.sub ?? 0))
    .map(it => [slotOf(it.slot), it.frame?.[0] ?? 0, it.frame?.[1] ?? 0, it.grid?.[0] ?? 1, it.grid?.[1] ?? 1, r3(it.c), r3(it.r), r3(it.w), r3(it.h), it.layer, Number.isFinite(it.near) ? r3(it.near) : -1]);
  return { slots, items };
}
