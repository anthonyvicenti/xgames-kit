// gf-three flat: the judge of a flat picture (gf-flat-1, ART-STANDARD.md). Pure and dependency-free: it takes decoded
// RGBA ({ width, height, data: Uint8Array of width*height*4, straight alpha }) and runs in Node and in a page.
//
//   judge('body', image, { style: 'pixel', plane: 'side' })   a body sheet: shape, cell, empty, anchor, overfill, same, alpha, margin
//   judge('prop', image, { style })                           a prop: size, empty, alpha
//   judge('tile', image, { style, solid: true })              a tile: shape, cell, opaque, seam, alpha
//   judge('edges', image, { style, mode: 'blend'|'connect' }) a kind's 16 edge pictures (4 x 4): shape, cell, empty, opaque
//   judge('dress', image, { style })                          a dressing strip: shape, cell, empty
//   judge('tile', image, { style, piece: true })              a tile-set piece (an edge, a corner, an end, one part of a
//                                                             bigger picture): the same, but no seam (it never repeats)
//   → { ok, kind, style, cell, rows, frames, errors: [{rule, frame, message}], warnings: [{rule, frame, message}] }
//
// It holds what a file can be measured for. It does not see whether six frames are one character or whether a walk
// reads as a walk: that is a look judge's work (ART-STANDARD.md §6).
import { STYLES, FRAMES, ROWS, FILL } from './slots.js';

const A_SOLID = 128;      // a texel counts as drawn at or above this alpha

/** The drawn texels of a rectangle: count, bounds and middle. */
function mass(img, x0, y0, w, h) {
  let n = 0, minX = w, maxX = -1, minY = h, maxY = -1, sx = 0, sy = 0, half = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const a = img.data[((y0 + y) * img.width + x0 + x) * 4 + 3];
    if (a > 8 && a < 247) half++;
    if (a < A_SOLID) continue;
    n++; sx += x + 0.5; sy += y + 0.5;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { n, half, minX, maxX, minY, maxY, cx: n ? sx / n : w / 2, cy: n ? sy / n : h / 2, share: n / (w * h) };
}
/** The share of texels that differ between two equal rectangles (colour or alpha, past a small step). */
function differ(img, ax, ay, bx, by, w, h) {
  let n = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((ay + y) * img.width + ax + x) * 4, j = ((by + y) * img.width + bx + x) * 4, d = img.data;
    if (Math.abs(d[i + 3] - d[j + 3]) > 48 || (d[i + 3] >= A_SOLID && Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) > 48)) n++;
  }
  return n / (w * h);
}
function colours(img, limit = 64) {
  const seen = new Set(), d = img.data;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3] < A_SOLID) continue; seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); if (seen.size > limit) break; }
  return seen.size;
}
const pct = v => `${Math.round(v * 100)}%`;

function judgeBody(img, { style, plane }, out) {
  const S = STYLES[style], { width: W, height: H } = img, err = out.err, warn = out.warn;
  const rows = W === H * 6 ? 1 : W === H * 2 ? 3 : 0;
  if (!rows) { err('shape', null, `the sheet is ${W} x ${H}: a body sheet is 6 square cells across and 1 or 3 rows (width 6 times the height, or 2 times)`); return; }
  const cell = W / 6;
  out.cell = cell; out.rows = rows; out.frames = FRAMES.length;
  const allowed = S.cells.length === 2 ? cell >= S.cells[0] && cell <= S.cells[1] && cell % 16 === 0 : S.cells.includes(cell);
  if (!Number.isInteger(cell) || !allowed) { err('cell', null, `a cell is ${cell} px; ${style} allows ${S.cells.length === 2 ? `${S.cells[0]} to ${S.cells[1]} in steps of 16` : S.cells.join(', ')}`); if (!Number.isInteger(cell)) return; }
  if (rows === 3 && plane === 'side') warn('rows', null, 'a 3-row sheet in a side-on game: only its `side` row is used');
  // a 1-row sheet seen from above is anchored at its centre; everything else stands on the bottom middle of its cell
  const centre = rows === 1 && plane === 'top';
  const lowBand = Math.max(1, Math.round(cell / 16)), off = cell / 8, cells = [];
  for (let r = 0; r < rows; r++) for (let f = 0; f < 6; f++) {
    const name = rows === 3 ? `${ROWS[3][r]}/${FRAMES[f]}` : FRAMES[f], m = mass(img, f * cell, r * cell, cell, cell);
    cells.push(m);
    if (m.share < 0.04) { err('empty', name, `${name} is empty (${pct(m.share)} drawn; at least 4%)`); continue; }
    if (centre) {
      if (Math.abs(m.cx - cell / 2) > off || Math.abs(m.cy - cell / 2) > off) err('anchor', name, `${name}: the figure's middle is ${Math.round(m.cx)}, ${Math.round(m.cy)} in a ${cell} px cell; seen from above it sits on the cell's centre (within ${Math.round(off)} px)`);
    } else {
      const gap = cell - 1 - m.maxY, band = FRAMES[f] === 'air' ? Math.round(cell / 4) : lowBand;
      if (gap >= band) err('anchor', name, `${name}: the lowest drawn row is ${gap} px above the bottom of the cell; feet stand in the bottom ${band} px`);
      if (FRAMES[f] !== 'down' && Math.abs(m.cx - cell / 2) > off) err('anchor', name, `${name}: the figure's middle is ${Math.round(m.cx - cell / 2)} px off the cell's centre column (within ${Math.round(off)} px)`);
      if (FRAMES[f] === 'idle') {
        const tall = (m.maxY - m.minY + 1) / cell;
        if (tall > 0.9) err('overfill', name, `${name}: the figure is ${pct(tall)} of the cell's height; a standing figure fills at most ${pct(FILL)} (it is drawn larger than its body)`);
        else if (tall < 0.5) warn('small', name, `${name}: the figure is ${pct(tall)} of the cell's height: it will read small`);
      }
    }
    if (!S.hard) {
      const mg = [mass(img, f * cell, r * cell, 2, cell), mass(img, f * cell + cell - 2, r * cell, 2, cell), mass(img, f * cell, r * cell, cell, 2)];
      if (mg.some(q => q.n > 0)) err('margin', name, `${name}: drawn texels in the 2 px margin at the left, right or top of the cell (a linear filter reads across the edge)`);
    }
  }
  const same = (a, b, what) => { if (differ(img, a[0] * cell, a[1] * cell, b[0] * cell, b[1] * cell, cell, cell) < 0.01) err('same', what, `${what} are the same picture (under 1% of texels differ)`); };
  for (let r = 0; r < rows; r++) { const p = rows === 3 ? `${ROWS[3][r]}/` : ''; same([1, r], [2, r], `${p}walk1 and ${p}walk2`); same([0, r], [3, r], `${p}idle and ${p}air`); }
  if (rows === 3) { same([0, 0], [0, 1], 'down/idle and side/idle'); same([0, 0], [0, 2], 'down/idle and up/idle'); }
}

function judgeTile(img, { style, solid, piece = false }, out) {
  const S = STYLES[style], { width: W, height: H } = img, err = out.err, warn = out.warn;
  const n = W === H ? 1 : W === H * 2 ? 2 : 0;
  if (!n) { err('shape', null, `the tile is ${W} x ${H}: one square cell, or two side by side (cap, fill)`); return; }
  out.cell = H; out.frames = n;
  if (H < S.tiles[0] || H > S.tiles[1]) err('cell', null, `a tile cell is ${H} px; ${style} allows ${S.tiles[0]} to ${S.tiles[1]} (${S.tile} is 1 m)`);
  const d = img.data, step = (i, j) => Math.abs(d[i] - d[j]) + Math.abs(d[i + 1] - d[j + 1]) + Math.abs(d[i + 2] - d[j + 2]) + Math.abs(d[i + 3] - d[j + 3]);
  const at = (x, y) => (y * W + x) * 4;
  for (let k = 0; k < n; k++) {
    const x0 = k * H, name = n === 2 ? (k === 0 ? 'cap' : 'fill') : 'fill', m = mass(img, x0, 0, H, H);
    if (solid === true && m.n < H * H) err('opaque', name, `${name}: a solid tile has ${H * H - m.n} transparent texels`);
    if (m.share < 0.04) err('empty', name, `${name} is empty`);
    // a piece is drawn once where its neighbours meet (a path's edge, a wall's corner, a roof's eave), never in a run of
    // itself: its edges continue the tiles beside it, not each other, so the seam is not its rule
    if (piece) continue;
    // the seam: the mean step across the wrap against the mean step between neighbours inside the tile
    let inX = 0, inY = 0, wrapX = 0, wrapY = 0;
    for (let y = 0; y < H; y++) { wrapX += step(at(x0 + H - 1, y), at(x0, y)); for (let x = 0; x < H - 1; x++) inX += step(at(x0 + x, y), at(x0 + x + 1, y)); }
    for (let x = 0; x < H; x++) { wrapY += step(at(x0 + x, H - 1), at(x0 + x, 0)); for (let y = 0; y < H - 1; y++) inY += step(at(x0 + x, y), at(x0 + x, y + 1)); }
    const meanX = inX / (H * (H - 1)) + 2, meanY = inY / (H * (H - 1)) + 2, sx = wrapX / H / meanX, sy = wrapY / H / meanY;
    const check = (ratio, dir) => {
      if (ratio <= 3) return;
      const msg = `${name}: the ${dir} edges do not continue each other (the step across the wrap is ${ratio.toFixed(1)} times the step inside the tile; at most 3)`;
      if (S.hard && ratio > 6) err('seam', name, msg); else warn('seam', name, msg);
    };
    check(sx, 'left and right');
    // a ledge (solid "top") is a strip with air under it: it continues left and right only
    if (name === 'fill' && solid !== 'top') check(sy, 'top and bottom');
  }
}

/** An edge set (a kind's "edges", ART-STANDARD.md §4): 4 x 4 square cells of the tile size, one per neighbour mask. */
function judgeEdges(img, { style, mode = 'blend' }, out) {
  const S = STYLES[style], { width: W, height: H } = img, err = out.err;
  if (W !== H || W % 4) { err('shape', null, `the edge set is ${W} x ${H}: 4 x 4 square cells (one per neighbour mask)`); return; }
  const cell = W / 4; out.cell = cell; out.frames = 16;
  if (cell < S.tiles[0] || cell > S.tiles[1]) err('cell', null, `an edge cell is ${cell} px; ${style} allows ${S.tiles[0]} to ${S.tiles[1]} (${S.tile} is 1 m)`);
  // blend: cell 0 (no corner of the kind) may be empty, and cell 15 (all four) is the kind's fill, every texel drawn;
  // connect: every cell has the kind's own cell in it
  for (let m = mode === 'blend' ? 1 : 0; m < 16; m++) {
    const q = mass(img, (m % 4) * cell, Math.floor(m / 4) * cell, cell, cell);
    if (q.share < 0.04) err('empty', `mask ${m}`, `the picture for mask ${m} is empty`);
    if (mode === 'blend' && m === 15 && q.n < cell * cell) err('opaque', 'mask 15', `the picture for mask 15 (all four cells) has ${cell * cell - q.n} see-through texels: it is the kind's fill`);
  }
}

/** A dressing strip (a kind's "dress"): square cells of the tile size side by side, each a small thing. */
function judgeDress(img, { style }, out) {
  const S = STYLES[style], { width: W, height: H } = img, err = out.err;
  if (W % H) { err('shape', null, `the strip is ${W} x ${H}: square cells side by side`); return; }
  out.cell = H; out.frames = W / H;
  if (H < S.tiles[0] || H > S.tiles[1]) err('cell', null, `a dressing cell is ${H} px; ${style} allows ${S.tiles[0]} to ${S.tiles[1]}`);
  if (W / H > 16) err('shape', null, `${W / H} pictures in the strip; at most 16`);
  for (let k = 0; k < W / H; k++) if (mass(img, k * H, 0, H, H).n < 3) err('empty', `${k + 1}`, `picture ${k + 1} of the strip is empty`);
}

function judgeProp(img, { style }, out) {
  const S = STYLES[style], { width: W, height: H } = img, m = mass(img, 0, 0, W, H);
  out.cell = Math.max(W, H);
  if (Math.min(W, H) < S.props[0] || Math.max(W, H) > S.props[1]) out.err('size', null, `the picture is ${W} x ${H}; a ${style} prop is ${S.props[0]} to ${S.props[1]} px a side (${S.ppm} px is 1 m)`);
  if (m.share < 0.04) out.err('empty', null, `the picture is empty (${pct(m.share)} drawn)`);
}

export function judge(kind, img, { style = 'pixel', plane = 'side', solid = false, piece = false, mode = 'blend' } = {}) {
  const errors = [], warnings = [];
  const out = { ok: false, kind, style, cell: null, rows: null, frames: null, errors, warnings, err: (rule, frame, message) => errors.push({ rule, frame, message }), warn: (rule, frame, message) => warnings.push({ rule, frame, message }) };
  const done = () => { delete out.err; delete out.warn; out.ok = !errors.length; return out; };
  if (!STYLES[style]) { out.err('style', null, `style "${style}" (pixel or drawn)`); return done(); }
  if (!img || !(img.width > 0) || !(img.height > 0) || !img.data || img.data.length !== img.width * img.height * 4) { out.err('png', null, 'not an 8-bit RGBA picture'); return done(); }
  if (kind === 'body') judgeBody(img, { style, plane }, out); else if (kind === 'tile') judgeTile(img, { style, solid, piece }, out); else if (kind === 'prop') judgeProp(img, { style }, out);
  else if (kind === 'edges') judgeEdges(img, { style, mode }, out); else if (kind === 'dress') judgeDress(img, { style }, out);
  else { out.err('kind', null, `kind "${kind}" (body, prop, tile, edges or dress)`); return done(); }
  if (STYLES[style].hard) {
    const m = mass(img, 0, 0, img.width, img.height);
    if (m.half > img.width * img.height * 0.02) out.err('alpha', null, `${pct(m.half / (img.width * img.height))} of the texels are half transparent: pixel art has alpha 0 or 255 (this looks like smooth art saved as pixel art)`);
    if (colours(img, 33) > 32) out.warn('colours', null, 'more than 32 colours in a pixel picture');
  }
  return done();
}
