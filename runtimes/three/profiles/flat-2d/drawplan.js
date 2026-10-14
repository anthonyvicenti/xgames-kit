// gf-three flat: what a top-down tile map draws, and where. Pure: the world (world.js) builds its meshes from it and
// the look judge's contact sheet (builder/look-judge/pages/flat.js) draws the same plan, so the sheet shows what a game
// shows. It reads the map (tilemap.js readMap) and which pictures the game has, and lays out:
//
//   layer 0  the base kind under every cell (grass)
//   layer 1  the other kinds, a quad a cell (the cap where the cell on the far side is another kind)
//   layer 2  "blend" kinds (a path, a pond): a second grid on the cells' corners. Each corner looks at its four cells
//            (top left 1, top right 2, bottom left 4, bottom right 8) and draws that one of the kind's 16 edge pictures,
//            so a border is soft and a corner is round, and the border still runs along the cells' own edges
//   layer 3  dressing: a small thing (a tuft, a flower, a pebble, a crop) on a share of a kind's cells, never on a cell
//            beside a soft border of another kind, the same on every machine (a hash of the cell)
//   layer 4  "connect" kinds (a fence, a wall): each cell draws one of 16 by which of its four neighbours (north 1,
//            east 2, south 4, west 8) are the same kind
//   layer 5  set pieces (a house, a tree): one picture on each footprint, standing on the footprint's near edge, sorted
//            near over far by that edge (`near`) so a body walks behind a roof and in front of a door
//   shadows  under each set piece: a flat ellipse on the ground (`shadow: true`)
//
// art: { tiles, edges, dress } each a Set of the kinds that have that picture; sizes: { '<slot>': [w, h] } pixels;
// ppm: texels a metre. An item: { slot, frame: [col, row], grid: [cols, rows], c, r (its centre in cell units: the
// middle of cell (c, r) is (c, r)), w, h (cells), layer, near? (a piece: the row of its near edge), shadow? }.
export const BLEND = { tl: 1, tr: 2, bl: 4, br: 8 };
export const CONNECT = { n: 1, e: 2, s: 4, w: 8 };
export const PAD = 12;      // cells the picture continues past the map's edge

/** A cell's own random number in [0, 1), the same everywhere: salt picks one of several. */
export function cellHash(c, r, salt = 0) {
  let h = Math.imul(c | 0, 374761393) ^ Math.imul(r | 0, 668265263) ^ Math.imul(salt | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** The blend picture's index of the corner between cells (c - 1, r - 1) and (c, r): which of the four are `kind`. */
export const blendMask = (at, kind, c, r) => (at(c - 1, r - 1) === kind ? 1 : 0) | (at(c, r - 1) === kind ? 2 : 0) | (at(c - 1, r) === kind ? 4 : 0) | (at(c, r) === kind ? 8 : 0);
/** The connect picture's index of cell (c, r): which of its four neighbours are `kind`. */
export const connectMask = (at, kind, c, r) => (at(c, r - 1) === kind ? 1 : 0) | (at(c + 1, r) === kind ? 2 : 0) | (at(c, r + 1) === kind ? 4 : 0) | (at(c - 1, r) === kind ? 8 : 0);

export function drawPlan(M, { tiles = new Set(), edges = new Set(), dress = new Set(), sizes = {}, ppm = 16, pad = PAD } = {}) {
  const items = [], tile = M.tile;
  // a spawn or a mark is an empty cell to the map, but it is drawn as the ground around it: a coin on a path keeps the
  // path under it (the commonest kind of its four neighbours that nobody stands on; the base when none is)
  const under = new Map();
  for (const { c, r } of [...M.spawns, ...Object.values(M.marks).flat()]) {
    const n = {};
    for (const [dc, dr] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) { const k = M.at(c + dc, r + dr); if (k && !M.kinds[k]?.solid && !M.kinds[k]?.piece) n[k] = (n[k] ?? 0) + 1; }
    const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 2) under.set(`${c},${r}`, best[0]);
  }
  const cell = (c, r) => M.at(c, r) ?? under.get(`${c},${r}`) ?? null;
  // past the map's edge the nearest edge cell repeats, so no screen shape shows a void
  const at = (c, r) => cell(Math.max(0, Math.min(M.cols - 1, c)), Math.max(0, Math.min(M.rows - 1, r)));
  const kindOf = (c, r) => at(c, r) ?? M.base;          // what is on a cell, the base where nothing else is
  const K = M.kinds, base = M.base;
  const frames = slot => { const s = sizes[slot]; return s && s[0] >= s[1] * 2 ? Math.round(s[0] / s[1]) : 1; };
  const blended = k => K[k]?.edges === 'blend' && edges.has(k);
  const connected = k => K[k]?.edges === 'connect' && edges.has(k);
  const piece = k => Array.isArray(K[k]?.piece) && tiles.has(k);
  const order = Object.keys(K);

  for (let r = -pad; r < M.rows + pad; r++) for (let c = -pad; c < M.cols + pad; c++) {
    if (base && tiles.has(base)) { const slot = `world.tiles.${base}`, n = frames(slot); items.push({ slot, frame: [n - 1, 0], grid: [n, 1], c, r, w: 1, h: 1, layer: 0 }); }
    const k = at(c, r);
    if (!k || k === base || blended(k) || piece(k) || !tiles.has(k) && !connected(k)) continue;
    if (connected(k)) { items.push({ slot: `world.edges.${k}`, frame: [connectMask(at, k, c, r) % 4, Math.floor(connectMask(at, k, c, r) / 4)], grid: [4, 4], c, r, w: 1, h: 1, layer: 4, kind: k }); continue; }
    const slot = `world.tiles.${k}`, n = frames(slot), inside = r >= 0 && r < M.rows;
    // the cap where the cell on the far side is not this kind (inside the map only; past it, all fill)
    const cap = n >= 2 && inside && at(c, r - 1) !== k;
    items.push({ slot, frame: [n >= 2 && !cap ? 1 : 0, 0], grid: [n, 1], c, r, w: 1, h: 1, layer: 1, kind: k });
  }
  // the blend kinds, in the order the map lists them (a path, then the water over it)
  for (const k of order.filter(blended)) {
    for (let r = -pad + 1; r < M.rows + pad; r++) for (let c = -pad + 1; c < M.cols + pad; c++) {
      const m = blendMask(at, k, c, r);
      if (m) items.push({ slot: `world.edges.${k}`, frame: [m % 4, Math.floor(m / 4)], grid: [4, 4], c: c - 0.5, r: r - 0.5, w: 1, h: 1, layer: 2, kind: k, sub: order.indexOf(k) });
    }
  }
  // dressing: on a share of a kind's cells (the base's too), never beside another kind, shifted a few whole texels
  for (const k of order.filter(x => dress.has(x) && (K[x].dress ?? 0) > 0)) {
    const slot = `world.dress.${k}`, n = frames(slot), share = K[k].dress, step = 1 / ppm / tile;
    for (let r = -pad; r < M.rows + pad; r++) for (let c = -pad; c < M.cols + pad; c++) {
      if (kindOf(c, r) !== k || cellHash(c, r, 1) >= share) continue;
      // off a soft border: a flower in the grass never sits on a path's edge (what grows in a blend kind, a crop in
      // its soil, keeps every cell)
      if (!blended(k) && [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dc, dr]) => { const n = kindOf(c + dc, r + dr); return n !== k && blended(n); })) continue;
      const v = Math.floor(cellHash(c, r, 2) * n), jx = Math.round((cellHash(c, r, 3) - 0.5) * 6) * step, jy = Math.round((cellHash(c, r, 4) - 0.5) * 6) * step;
      items.push({ slot, frame: [v, 0], grid: [n, 1], c: c + jx, r: r + jy, w: 1, h: 1, layer: 3, kind: k });
    }
  }
  // set pieces: one picture a footprint, read in reading order over the map's own cells
  for (const k of order.filter(piece)) {
    const [fw, fd] = K[k].piece, used = new Set(), slot = `world.tiles.${k}`, [pw, ph] = sizes[slot] ?? [fw * ppm * tile, fd * ppm * tile];
    for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) {
      if (M.at(c, r) !== k || used.has(`${c},${r}`)) continue;
      for (let j = 0; j < fd; j++) for (let i = 0; i < fw; i++) if (M.at(c + i, r + j) === k) used.add(`${c + i},${r + j}`);
      const w = pw / ppm / tile, h = ph / ppm / tile, mid = c + (fw - 1) / 2, near = r + fd - 0.5;
      items.push({ slot: null, shadow: true, c: mid + 0.1, r: near - 0.1, w: Math.min(w, fw) * 1.08, h: Math.min(fd, 1.6) * 0.75, layer: 3.5, kind: k });
      items.push({ slot, frame: [0, 0], grid: [1, 1], c: mid, r: near - h / 2, w, h, layer: 5, near, kind: k, footprint: { c, r, w: fw, d: fd } });
    }
  }
  return items;
}
