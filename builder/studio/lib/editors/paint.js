// The map painter's logic, with no DOM: a gf-tilemap-1 map (config/world.json → map, the slot world.map) as a grid
// of legend characters, and the strokes a person makes on it. Pure: the page and the tests import it.
//
// The painter never invents a format: what it saves is the same map, with the same kinds and legend, and new legend
// characters only when the person places something the legend had no character for. Whether the map is good is the
// kit's to say (kit/flat: readMap, reachOf, worldReport); see checkMap below, which takes those functions in.

/** The map's rows as a grid of single characters. */
export const gridOf = map => (map?.rows ?? []).map(r => [...r]);
/** A grid back into the map (a new object; kinds and legend kept). */
export const withGrid = (map, grid) => ({ ...map, rows: grid.map(r => r.join('')) });

/** What a legend entry is, in words a person reads. */
export function entryLabel(entry) {
  if (entry === null) return 'Empty';
  if (entry === 'spawn') return 'Start spot';
  if (typeof entry === 'string' && entry.startsWith('mark:')) return words(entry.slice(5));
  return words(entry);
}
const words = id => String(id).replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase());

const SPARE = 'abcdefghijklmnopqrstuvwxyzACDEFGHIJKLMNOPQRSTUVWXYZ023456789+*%&@!?$';

/** The legend character for an entry (a kind id, "spawn", "mark:<name>" or null), adding one to the legend when the
 *  map has none. → { map, ch } (map is the same object when nothing was added) */
export function charFor(map, entry) {
  const legend = map.legend ?? {};
  for (const [ch, v] of Object.entries(legend)) if (v === entry) return { map, ch };
  const used = new Set(Object.keys(legend));
  const ch = [...SPARE].find(c => !used.has(c));
  if (!ch) throw new Error('the legend has no free character left');
  return { map: { ...map, legend: { ...legend, [ch]: entry } }, ch };
}

/** The palette a person picks from: every tile kind (with its picture slot), the start spot, every mark, empty. */
export function paletteOf(map, { tiles = {}, marks = {} } = {}) {
  const out = [];
  for (const [kind, k] of Object.entries(map.kinds ?? {})) {
    if (kind === map.base) continue;                          // from above the base is drawn under every cell: it is "empty"
    out.push({ entry: kind, label: entryLabel(kind), group: 'tiles', solid: k?.solid ?? false, picture: tiles[kind] ?? null, slot: `world.tiles.${kind}` });
  }
  out.push({ entry: 'spawn', label: 'Start spot', group: 'marks', picture: null, slot: null, note: 'Players start here, one spot a seat' });
  const names = new Set(Object.values(map.legend ?? {}).filter(v => typeof v === 'string' && v.startsWith('mark:')).map(v => v.slice(5)));
  for (const n of Object.keys(marks)) names.add(n);
  for (const n of names) out.push({ entry: `mark:${n}`, label: entryLabel(n), group: 'marks', picture: marks[n] ?? null, slot: marks[n] ? `prop.${n}` : null, note: `A place the game puts a ${entryLabel(n).toLowerCase()}` });
  out.push({ entry: null, label: 'Erase', group: 'erase', picture: null, slot: null });
  return out;
}

/** The cells between two cells, both ends included (a fast drag must not skip cells). */
export function lineCells(a, b) {
  const out = [];
  let { c: x0, r: y0 } = a; const { c: x1, r: y1 } = b;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 10000; guard++) {
    out.push({ c: x0, r: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
  return out;
}
/** Every cell of the rectangle two cells span. */
export function rectCells(a, b) {
  const out = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push({ c, r });
  return out;
}

/** A grid with these cells set to ch (cells outside the map are ignored). → a new grid */
export function paintCells(grid, cells, ch) {
  const g = grid.map(r => r.slice());
  for (const { c, r } of cells) if (r >= 0 && r < g.length && c >= 0 && c < g[r].length) g[r][c] = ch;
  return g;
}

/** Bucket fill: every cell joined to (c, r) by sides that holds the same character becomes ch. → a new grid */
export function fillCells(grid, c, r, ch) {
  const from = grid[r]?.[c];
  if (from === undefined || from === ch) return grid;
  const g = grid.map(row => row.slice()), stack = [[c, r]];
  while (stack.length) {
    const [x, y] = stack.pop();
    if (g[y]?.[x] !== from) continue;
    g[y][x] = ch;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return g;
}

/** The entry a cell holds (eyedropper). */
export const entryAt = (map, grid, c, r) => { const ch = grid[r]?.[c]; return ch === undefined ? undefined : (map.legend ?? {})[ch] ?? null; };

/** Add or take away columns on the right, or rows at the top (side-on: the ground stays at the bottom). → a new grid */
export function resizeGrid(grid, { cols, rows }, emptyCh, { plane = 'side' } = {}) {
  let g = grid.map(r => r.slice());
  const w = g[0]?.length ?? 0;
  if (cols > w) g = g.map((r, i) => {
    // a side-on map's bottom row is ground: carry its last cell on, so the floor does not open a hole
    const pad = plane === 'side' && i === g.length - 1 ? r[w - 1] : emptyCh;
    // a wall down the right edge moves out with the edge
    const edge = r[w - 1], wall = edge !== emptyCh && i < g.length - 1 && g.slice(0, -1).every(row => row[w - 1] === edge);
    return wall ? [...r.slice(0, w - 1), ...new Array(cols - w).fill(emptyCh), edge] : [...r, ...new Array(cols - w).fill(pad)];
  });
  if (cols < w) g = g.map(r => r.slice(0, cols));
  const h = g.length, width = g[0]?.length ?? cols;
  if (rows > h) { const blank = () => new Array(width).fill(emptyCh); const add = Array.from({ length: rows - h }, blank); g = plane === 'side' ? [...add, ...g] : [...g, ...add]; }
  if (rows < h) g = plane === 'side' ? g.slice(h - rows) : g.slice(0, rows);
  return g;
}

/**
 * What is wrong with a map, as the kit says it, and which cells to colour. `kit` is the game's own copy of the flat part
 * ({ readMap, reachOf, jumpReach, worldReport, SIDE } from gf/three/flat/index.js and tilemap.js), so the painter
 * judges with the same code the game runs and create refuses with. → { ok, errors: [text], warnings: [text],
 * bad: Set("c,r"), reached: Set("c,r") (side-on: cells a body can stand on and get to), spawns, seats }
 */
export function checkMap(map, { kit, game = {}, spec = null, seats = 4 } = {}) {
  const M = kit.readMap(map), bad = new Set(), reached = new Set(), errors = [], warnings = [];
  if (!M.ok) return { ok: false, errors: M.problems.slice(), warnings, bad, reached, spawns: M.spawns?.length ?? 0, seats, reach: null };
  const report = kit.worldReport({ world: { ...(game.world ?? {}), plane: map.plane, map, spawns: undefined }, game: game.config ?? {}, spec, intent: game.world?.size });
  for (const p of report.problems) {
    if (p.rule === 'flat') continue;                                        // the part's own note on what a flat world is not
    (p.severity === 'error' ? errors : warnings).push(p.message);
  }
  let reach = null;
  if (M.side) {
    const C = game.config?.controller ?? {}, S = kit.SIDE ?? {};
    reach = kit.jumpReach({ gravity: game.config?.gravity ?? 20, jump: C.jump ?? S.jump, speed: C.speed ?? S.speed, fallScale: S.fallScale });
    const G = kit.reachOf(M, reach);
    // a surface is the row a body stands in; a ledge nobody reaches is coloured with the ledge under it
    for (const s of G.surfaces) for (let c = s.c0; c <= s.c1; c++) { (G.reached.has(s.id) ? reached : bad).add(`${c},${s.r}`); if (!G.reached.has(s.id) && s.ledge) bad.add(`${c},${s.r + 1}`); }
    // ground nobody reaches is a note, not a fault: only colour what the kit calls a problem (ledges, marks, spawns)
    for (const s of G.surfaces) if (!G.reached.has(s.id) && !s.ledge) for (let c = s.c0; c <= s.c1; c++) bad.delete(`${c},${s.r}`);
    for (const [name, list] of Object.entries(M.marks)) for (const m of list) {
      let r = m.r; while (r < M.rows && G.idAt.get(`${m.c},${r}`) === undefined) r++;
      const id = G.idAt.get(`${m.c},${r}`);
      if (id === undefined || !G.reached.has(id) || (r - m.r) * M.tile > reach.up * 0.82) bad.add(`${m.c},${m.r}`);
      void name;
    }
    for (const s of M.spawns) if (G.idAt.get(`${s.c},${s.r}`) === undefined) bad.add(`${s.c},${s.r}`);
  } else {
    // from above: a spawn or mark no one can walk to (the report's paths rule) is coloured
    const seen = new Set(), q = M.spawns.length ? [[M.spawns[0].c, M.spawns[0].r]] : [];
    while (q.length) { const [c, r] = q.pop(), k = `${c},${r}`; if (seen.has(k) || M.solid(c, r) !== false) continue; seen.add(k); q.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]); }
    for (const s of M.spawns) if (!seen.has(`${s.c},${s.r}`)) bad.add(`${s.c},${s.r}`);
    for (const list of Object.values(M.marks)) for (const m of list) if (!seen.has(`${m.c},${m.r}`)) bad.add(`${m.c},${m.r}`);
  }
  return { ok: !errors.length, errors, warnings, bad, reached, spawns: M.spawns.length, seats, reach, cols: M.cols, rows: M.rows };
}

/** The cells a jump from (c, r) can land on, by the reach model: what the painter shades under the cursor. */
export function jumpShade(M, reach, c, r, margin = 0.82) {
  const out = [];
  if (!reach || !M.side) return out;
  const up = reach.up * margin;
  for (let y = 0; y < M.rows; y++) for (let x = 0; x < M.cols; x++) {
    const rise = (r - y) * M.tile;
    if (rise > up) continue;
    const gap = Math.max(0, Math.abs(x - c) - 1) * M.tile;
    if (gap <= reach.across(Math.max(rise, 0)) * margin) out.push({ c: x, r: y });
  }
  return out;
}
