// gf-three flat: the tile map (gf-tilemap-1). Pure: Node (create, the reach tool, tests) and the page import it.
//
// A flat world's ground, walls, platforms and colliders come from ONE value: config/world.json → `map` (the slot
// `world.map`). It is the file a painter edits; nothing else has to change when it does.
//
//   { "format": "gf-tilemap-1", "plane": "top" | "side", "tile": 1,            metres a cell
//     "base": "grass",                                                        top only: the kind drawn under every cell
//     "kinds":  { "ground": { "solid": true }, "ledge": { "solid": "top" }, "path": { "solid": false, "edges": "blend" } },
//     "legend": { ".": null, "#": "ground", "=": "ledge", "1": "spawn", "o": "mark:coin" },
//     "rows":   ["........", "..==..o.", ".1......", "########"] }
//
// One character is one cell. Every row has the same length. Row 0 is the TOP of a side-on map and the FAR side (-Z) of
// a top-down one. A legend entry is null (empty), a kind id, "spawn" (seats take them in reading order), or
// "mark:<name>" (a named place rules.js and mechanics read with world.marks(name)).
// A kind's solid: true (a wall, a block of ground), false (drawn only), or "top" (side-on: a ledge you land on from
// above, jump up through from below and drop through with Down). Its picture is the slot world.tiles.<kind>.
// Seen from above a kind may also say how it meets its neighbours and what lies on it (drawplan.js draws it):
//   "edges": "blend"    its edge with what is around it is drawn from a set of 16 (world.edges.<kind>, a 4 x 4 grid):
//                       soft, rounded borders, a path over grass, a pond's shore (the four cells round a corner pick one)
//   "edges": "connect"  it joins its neighbours of the same kind (a fence, a wall, a hedge): one of 16 by which of the
//                       four cells beside it are the same kind
//   "dress": 0.2        that share of its cells (and of the base's) get a small thing on them: a tuft, a flower, a
//                       pebble, a crop (world.dress.<kind>, a strip of pictures; never on a cell beside another kind)
//   "piece": [5, 3]     a set piece: a house, a tree. Its cells are its footprint, [across, deep]; one picture
//                       (world.tiles.<kind>, any size) stands on each footprint's near edge, as wide as it is drawn
//
// Where a cell is in the world (centre(c, r)):
//   side   x = (c - cols/2 + 0.5) * tile, y = (rows - 1 - r - 0.5) * tile: the TOP of the bottom row is y = 0
//   top    x = (c - cols/2 + 0.5) * tile, z = (r - rows/2 + 0.5) * tile, y = 0
export const FORMAT = 'gf-tilemap-1';
export const LIMITS = { cols: [8, 96], rows: [6, 64], tile: [0.5, 4], kinds: 32 };
const KIND_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** Read and check a map. → { ok, problems, plane, tile, cols, rows, kinds, base, cells, spawns, marks, ... } */
export function readMap(map) {
  const problems = [], bad = m => { problems.push(m); };
  const out = { ok: false, problems, plane: map?.plane === 'side' ? 'side' : 'top', tile: 1, cols: 0, rows: 0, kinds: {}, base: null, cells: [], spawns: [], marks: {} };
  if (!map || typeof map !== 'object') { bad('the map is missing'); return out; }
  if (map.format !== FORMAT) bad(`format is "${map.format}", not "${FORMAT}"`);
  if (!['top', 'side'].includes(map.plane)) bad(`plane is "${map.plane}" (top or side)`);
  const tile = Number(map.tile ?? 1);
  if (!(tile >= LIMITS.tile[0] && tile <= LIMITS.tile[1])) bad(`tile is ${map.tile} (${LIMITS.tile[0]} to ${LIMITS.tile[1]} metres)`);
  out.tile = Number.isFinite(tile) && tile > 0 ? tile : 1;
  const kinds = map.kinds && typeof map.kinds === 'object' ? map.kinds : {};
  if (!Object.keys(kinds).length) bad('kinds is empty');
  if (Object.keys(kinds).length > LIMITS.kinds) bad(`${Object.keys(kinds).length} kinds (at most ${LIMITS.kinds})`);
  for (const [id, k] of Object.entries(kinds)) {
    if (!KIND_RE.test(id)) bad(`kind "${id}": a lower-case word`);
    const solid = k?.solid ?? false;
    if (![true, false, 'top'].includes(solid)) bad(`kind "${id}": solid is true, false or "top"`);
    if (solid === 'top' && out.plane !== 'side') bad(`kind "${id}": a ledge (solid "top") is a side-on thing`);
    const kk = { solid };
    if (k?.edges != null) { if (!['blend', 'connect'].includes(k.edges)) bad(`kind "${id}": edges is "blend" or "connect"`); else if (out.plane !== 'top') bad(`kind "${id}": edges are drawn seen from above (plane top)`); else kk.edges = k.edges; }
    if (k?.dress != null) { if (!(typeof k.dress === 'number' && k.dress >= 0 && k.dress <= 1)) bad(`kind "${id}": dress is a share of its cells, 0 to 1`); else if (out.plane !== 'top') bad(`kind "${id}": dressing is laid seen from above (plane top)`); else kk.dress = k.dress; }
    if (k?.piece != null) {
      const ok = Array.isArray(k.piece) && k.piece.length === 2 && k.piece.every(n => Number.isInteger(n) && n >= 1 && n <= 12);
      if (!ok) bad(`kind "${id}": piece is its footprint in cells, [across, deep], 1 to 12 each`); else if (out.plane !== 'top') bad(`kind "${id}": a set piece stands seen from above (plane top)`); else kk.piece = k.piece;
    }
    out.kinds[id] = kk;
  }
  if (map.base != null) { if (out.plane !== 'top') bad('base is a top-down thing (side-on, an empty cell is sky)'); else if (!out.kinds[map.base]) bad(`base "${map.base}" is not a kind`); else if (out.kinds[map.base].solid) bad(`base "${map.base}" is solid: nobody could walk`); else out.base = map.base; }
  const legend = map.legend && typeof map.legend === 'object' ? map.legend : {};
  for (const [ch, v] of Object.entries(legend)) {
    if ([...ch].length !== 1) bad(`legend "${ch}": one character`);
    if (v !== null && v !== 'spawn' && !(typeof v === 'string' && (out.kinds[v] || /^mark:[a-z][a-z0-9-]{0,23}$/.test(v)))) bad(`legend "${ch}": "${v}" is not a kind, "spawn" or "mark:<name>"`);
  }
  const rows = Array.isArray(map.rows) ? map.rows : [];
  if (!rows.length || rows.some(r => typeof r !== 'string')) { bad('rows: a list of strings'); return out; }
  const cols = [...rows[0]].length;
  out.cols = cols; out.rows = rows.length;
  if (cols < LIMITS.cols[0] || cols > LIMITS.cols[1]) bad(`${cols} cells across (${LIMITS.cols[0]} to ${LIMITS.cols[1]})`);
  if (rows.length < LIMITS.rows[0] || rows.length > LIMITS.rows[1]) bad(`${rows.length} rows (${LIMITS.rows[0]} to ${LIMITS.rows[1]})`);
  const unknown = new Set();
  for (const [r, text] of rows.entries()) {
    const chars = [...text], line = [];
    if (chars.length !== cols) bad(`row ${r + 1} is ${chars.length} cells long, row 1 is ${cols}`);
    for (let c = 0; c < cols; c++) {
      const ch = chars[c] ?? ' ';
      if (!(ch in legend)) { unknown.add(ch); line.push(null); continue; }
      const v = legend[ch];
      if (v === 'spawn') { out.spawns.push({ c, r }); line.push(null); }
      else if (typeof v === 'string' && v.startsWith('mark:')) { (out.marks[v.slice(5)] ??= []).push({ c, r }); line.push(null); }
      else line.push(v);
    }
    out.cells.push(line);
  }
  if (unknown.size) bad(`rows use ${[...unknown].map(c => `"${c}"`).join(', ')}, which the legend does not name`);
  if (!out.spawns.length) bad('no spawn (a legend entry "spawn" and at least one cell of it)');
  out.ok = !problems.length;
  return Object.assign(out, helpers(out));
}

function helpers(M) {
  const { cols, rows, tile, plane } = M, side = plane === 'side';
  const at = (c, r) => (r < 0 || r >= rows || c < 0 || c >= cols ? undefined : M.cells[r]?.[c] ?? null);
  const solid = (c, r) => { const k = at(c, r); return k === undefined ? 'edge' : k ? M.kinds[k]?.solid ?? false : false; };
  /** The middle of a cell in the world. */
  const centre = (c, r) => (side ? { x: (c - cols / 2 + 0.5) * tile, y: (rows - 1 - r - 0.5) * tile, z: 0 } : { x: (c - cols / 2 + 0.5) * tile, y: 0, z: (r - rows / 2 + 0.5) * tile });
  /** Where a body stands in a cell: side-on the bottom edge of the cell, from above its middle. */
  const feet = (c, r) => { const p = centre(c, r); return side ? { x: p.x, y: p.y - tile / 2, z: 0 } : p; };
  /** The cell a world point is in. */
  const cellAt = p => (side ? { c: Math.floor(p.x / tile + cols / 2), r: rows - 2 - Math.floor(p.y / tile) } : { c: Math.floor(p.x / tile + cols / 2), r: Math.floor(p.z / tile + rows / 2) });
  const size = { w: cols * tile, h: rows * tile };
  // the play area in the world: side-on X by Y (the bottom row lies under y = 0), from above X by Z
  const area = side ? { minX: -size.w / 2, maxX: size.w / 2, minY: -tile, maxY: size.h - tile } : { minX: -size.w / 2, maxX: size.w / 2, minZ: -size.h / 2, maxZ: size.h / 2 };
  return { at, solid, centre, feet, cellAt, size, area, side };
}

/** Solid cells merged into as few rectangles as cover them (colliders): [{c, r, w, h}] in cells. `want`: which solid. */
export function rects(M, want = true) {
  const used = Array.from({ length: M.rows }, () => new Array(M.cols).fill(false)), out = [];
  const is = (c, r) => c < M.cols && r < M.rows && !used[r][c] && M.solid(c, r) === want;
  for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) {
    if (!is(c, r)) continue;
    let w = 1; while (is(c + w, r)) w++;
    let h = 1;
    // a ledge is one row thick by what it is; a block grows down while the whole run is solid
    if (want === true) grow: for (; r + h < M.rows; h++) for (let i = 0; i < w; i++) if (!is(c + i, r + h)) break grow;
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used[r + j][c + i] = true;
    out.push({ c, r, w, h });
  }
  return out;
}

/** A rectangle of cells as a box in the world: side-on {x, y, w, h}, from above {x, z, w, d} (centre and size, metres). */
export function boxOf(M, q) {
  const a = M.centre(q.c, q.r), b = M.centre(q.c + q.w - 1, q.r + q.h - 1), w = q.w * M.tile, h = q.h * M.tile;
  return M.side ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w, h } : { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, w, d: h };
}

// ---------------------------------------------------------------------------------------------------------------------
// Side-on: what a jump reaches. The numbers are the capsule's (kit/controller/capsule.mjs): a jump sets the vertical
// speed, gravity is the game's on the way up and `fallScale` times it on the way down. This is the MODEL; the proof is
// tools/flat-reach.mjs, which drives the real player over every jump the model says the map needs.
// ---------------------------------------------------------------------------------------------------------------------
export const REACH_MARGIN = 0.82;       // a map may ask for 82% of what the model says a jump can do, never all of it

/** → { up (metres a jump rises), across(rise) (metres covered landing `rise` above the take-off; below is negative) } */
export function jumpReach({ gravity = 20, jump = 10.5, fallScale = 1.7, speed = 5.2 } = {}) {
  const up = (jump * jump) / (2 * gravity), tUp = jump / gravity;
  const across = rise => (rise > up ? 0 : speed * (tUp + Math.sqrt((2 * (up - rise)) / (gravity * fallScale))));
  return { up, across, gravity, jump, fallScale, speed };
}

/**
 * The places a body can stand on a side-on map, and which of them a body starting at a spawn can get to.
 * A cell is standable when it and the cell above are free and the cell below is solid, a ledge, or the map's bottom.
 * A surface is a run of standable cells in one row. From surface A a body gets to B by walking off or jumping when,
 * for some pair of their cells, the rise is at most `up` and the gap at most across(rise), both times REACH_MARGIN.
 * → { surfaces: [{id, r, c0, c1, ledge, y}], edges: [{from, to, a: [c, r], b: [c, r], rise, gap}], reached: Set(id),
 *     tree: [edge] (one way to each reached surface), problems: [string], notes: [string] }
 */
export function reachOf(M, reach) {
  const free = (c, r) => { const s = M.solid(c, r); return s === false || s === 'top'; };
  const stand = (c, r) => free(c, r) && (r === 0 || free(c, r - 1)) && (r === M.rows - 1 || M.solid(c, r + 1) === true || M.solid(c, r + 1) === 'top');
  const surfaces = [], idAt = new Map();
  for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) {
    if (!stand(c, r) || idAt.has(`${c},${r}`)) continue;
    const below = r === M.rows - 1 ? 'edge' : M.solid(c, r + 1);
    let c1 = c; while (stand(c1 + 1, r) && (r === M.rows - 1 ? 'edge' : M.solid(c1 + 1, r + 1)) === below) c1++;
    const s = { id: surfaces.length, r, c0: c, c1, ledge: below === 'top', y: M.feet(c, r).y };
    for (let i = c; i <= c1; i++) idAt.set(`${i},${r}`, s.id);
    surfaces.push(s);
  }
  const up = reach.up * REACH_MARGIN, tile = M.tile, edges = [];
  for (const A of surfaces) for (const B of surfaces) {
    if (A === B) continue;
    const rise = (A.r - B.r) * tile;
    if (rise > up) continue;
    // the nearest pair of cells: the gap is the free air between the two runs (0 when they overlap or touch)
    const ca = Math.max(A.c0, Math.min(A.c1, B.c0 > A.c1 ? A.c1 : B.c1 < A.c0 ? A.c0 : Math.max(A.c0, B.c0)));
    const cb = Math.max(B.c0, Math.min(B.c1, ca));
    const gap = Math.max(0, Math.abs(ca - cb) - 1) * tile;
    if (gap > reach.across(Math.max(rise, 0)) * REACH_MARGIN) continue;
    // straight up or down through the same column needs the way to be open: a ledge lets a body through, a block does not
    if (ca === cb && rise > 0 && !B.ledge) continue;
    if (ca === cb && rise < 0 && !A.ledge) continue;
    edges.push({ from: A.id, to: B.id, a: [ca, A.r], b: [cb, B.r], rise, gap });
  }
  const reached = new Set(), tree = [], queue = [];
  for (const s of M.spawns) { const id = idAt.get(`${s.c},${s.r}`); if (id !== undefined && !reached.has(id)) { reached.add(id); queue.push(id); } }
  while (queue.length) { const id = queue.shift(); for (const e of edges) if (e.from === id && !reached.has(e.to)) { reached.add(e.to); tree.push(e); queue.push(e.to); } }
  const problems = [], notes = [], where = (c, r) => `column ${c + 1}, row ${r + 1}`;
  for (const s of M.spawns) if (idAt.get(`${s.c},${s.r}`) === undefined) problems.push(`the spawn at ${where(s.c, s.r)} is not a place to stand (it needs two free cells and something solid under it)`);
  for (const [name, list] of Object.entries(M.marks)) for (const m of list) {
    // a mark may float (a coin in the air): it belongs to the surface under it, within a jump
    let r = m.r; while (r < M.rows && idAt.get(`${m.c},${r}`) === undefined) r++;
    const id = idAt.get(`${m.c},${r}`);
    if (id === undefined || (r - m.r) * tile > up) problems.push(`the mark "${name}" at ${where(m.c, m.r)} is more than a jump (${up.toFixed(1)} m) above anywhere to stand`);
    else if (!reached.has(id)) problems.push(`the mark "${name}" at ${where(m.c, m.r)} is over a place no jump reaches from a spawn`);
  }
  for (const s of surfaces) if (!reached.has(s.id)) (s.ledge ? problems : notes).push(`${s.ledge ? 'the ledge' : 'the ground'} at ${where(s.c0, s.r)}${s.c1 > s.c0 ? ` to column ${s.c1 + 1}` : ''} cannot be reached from a spawn: a jump rises ${up.toFixed(1)} m and crosses ${(reach.across(0) * REACH_MARGIN).toFixed(1)} m`);
  return { surfaces, edges, reached, tree, problems, notes, idAt };
}

// ---------------------------------------------------------------------------------------------------------------------
// A map from a spec (create): spec.world.map when the spec wrote one, else a generated one of the asked size.
// ---------------------------------------------------------------------------------------------------------------------
export const SIZES = { top: { small: [24, 16], medium: [36, 24], large: [52, 34] }, side: { small: [28, 12], medium: [42, 13], large: [60, 14] } };
export const KINDS = {
  top: { grass: { solid: false, dress: 0.22 }, path: { solid: false, edges: 'blend' }, wall: { solid: true, edges: 'connect' }, water: { solid: true, edges: 'blend' } },
  side: { ground: { solid: true }, brick: { solid: true }, ledge: { solid: 'top' } },
};
export const LEGENDS = {
  top: { '.': null, ',': 'path', '#': 'wall', '~': 'water', '1': 'spawn' },
  side: { '.': null, '#': 'ground', 'B': 'brick', '=': 'ledge', '1': 'spawn' },
};

/** A generated map: seats' spawns, walls or platforms mirrored left to right so no seat is favoured. */
export function generateMap({ plane = 'top', size = 'small', seats = 4, rng = Math.random, marks = [], reach = jumpReach() } = {}) {
  const [cols, rows] = SIZES[plane][size] ?? SIZES[plane].small, g = Array.from({ length: rows }, () => new Array(cols).fill('.'));
  const put = (c, r, ch) => { if (r >= 0 && r < rows && c >= 0 && c < cols) g[r][c] = ch; };
  const both = (c, r, ch) => { put(c, r, ch); put(cols - 1 - c, r, ch); };
  const legend = { ...LEGENDS[plane] }, markChars = 'oabcdefg';
  marks.slice(0, markChars.length).forEach((name, i) => { legend[markChars[i]] = `mark:${name}`; });
  const int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  if (plane === 'top') {
    for (let c = 0; c < cols; c++) { put(c, 0, '#'); put(c, rows - 1, '#'); }
    for (let r = 0; r < rows; r++) { put(0, r, '#'); put(cols - 1, r, '#'); }
    // a path cross through the middle, a pond, and wall pieces to run around
    const mc = cols >> 1, mr = rows >> 1;
    for (let c = 2; c < cols - 2; c++) { put(c, mr, ','); put(c, mr - 1, ','); }
    for (let r = 2; r < rows - 2; r++) { put(mc, r, ','); put(mc - 1, r, ','); }
    // spawns: toward the corners, on open ground; nothing is built beside one
    const spots = [[3, 3], [cols - 4, rows - 4], [cols - 4, 3], [3, rows - 4], [3, mr + 2], [cols - 4, mr - 3], [mc + 3, 3], [mc - 4, rows - 4]].slice(0, Math.max(2, Math.min(8, seats)));
    const near = (x, y) => spots.some(([c, r]) => (Math.abs(c - x) <= 1 || Math.abs(c - (cols - 1 - x)) <= 1) && Math.abs(r - y) <= 1);
    const n = size === 'small' ? 3 : size === 'medium' ? 5 : 8;
    for (let i = 0, tries = 0; i < n && tries < 300; tries++) {
      const long = rng() < 0.5, w = i === 0 ? 3 : long ? int(3, 5) : 1, h = i === 0 ? 2 : long ? 1 : int(3, 4), c = int(2, mc - w - 3), r = int(2, rows - h - 3);
      let clear = true;
      for (let y = r - 1; y <= r + h && clear; y++) for (let x = c - 1; x <= c + w; x++) if (g[y]?.[x] !== '.' || near(x, y)) { clear = false; break; }
      if (!clear) continue;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) both(c + x, r + y, i === 0 ? '~' : '#');
      i++;
    }
    for (const [c, r] of spots) put(c, r, '1');
    for (const [i] of marks.slice(0, markChars.length).entries()) for (let k = 0, tries = 0; k < 6 && tries < 200; tries++) { const c = int(2, cols - 3), r = int(2, rows - 3); if (g[r][c] === '.' || g[r][c] === ',') { put(c, r, markChars[i]); k++; } }
    return { format: FORMAT, plane, tile: 1, base: 'grass', kinds: KINDS.top, legend, rows: g.map(r => r.join('')) };
  }
  // side-on: the ground along the bottom row, brick posts at the ends, ledges in steps a jump apart, mirrored
  const floor = rows - 1;
  for (let c = 0; c < cols; c++) put(c, floor, '#');
  for (let r = 0; r < floor; r++) { put(0, r, 'B'); put(cols - 1, r, 'B'); }
  const step = Math.max(1, Math.min(3, Math.floor((reach.up * REACH_MARGIN) / 1)));      // cells a jump may rise
  const mc = cols >> 1;
  let r = floor - step, c = int(3, 5), tier = 0;
  while (r >= 3 && c < mc - 2) {
    const w = int(3, 5), ch = tier % 3 === 2 ? 'B' : '=';
    for (let x = 0; x < w && c + x < mc - 1; x++) both(c + x, r, ch);
    for (const [i] of marks.slice(0, markChars.length).entries()) if ((tier + i) % 2 === 0) both(c + 1, r - 2, markChars[i]);
    c += w + int(1, 2); r -= step; tier++;
  }
  // a middle ledge at the first step, and a brick block on the floor each side to hop on
  for (let x = -2; x <= 1; x++) put(mc + x, floor - step, '=');
  both(mc - 7 > 6 ? mc - 7 : 7, floor - 1, 'B');
  for (const [i] of marks.slice(0, markChars.length).entries()) { put(mc - 1, floor - step - 2, markChars[i]); for (let x = 3; x < mc - 2; x += 5) if (g[floor - 1][x] === '.' && g[floor - 2][x] === '.') both(x, floor - 1, markChars[i]); }
  // spawns: on the floor, spread, each with two free cells
  const n = Math.max(2, Math.min(8, seats)), open = [];
  for (let x = 2; x < cols - 2; x++) if (g[floor - 1][x] === '.' && g[floor - 2][x] === '.' && g[floor - 3]?.[x] !== '=' ) open.push(x);
  for (let i = 0; i < n; i++) { const x = open[Math.round(((i % 2 ? n - i : i) / Math.max(1, n - 1)) * (open.length - 1))]; if (x !== undefined && g[floor - 1][x] === '.') put(x, floor - 1, '1'); else for (const y of open) if (g[floor - 1][y] === '.') { put(y, floor - 1, '1'); break; } }
  return { format: FORMAT, plane, tile: 1, kinds: KINDS.side, legend, rows: g.map(r => r.join('')) };
}
