// Intake checks: what a made or given piece of art must pass before it is kept (and, for a concept picture, before a
// 3D model is paid for). Each check returns { ok, problems: [plain sentences that say what to change], facts }.
// They read pixels and bytes only; nothing here calls a model or a service.
import { stats } from './png.mjs';
import { STANDARD } from './standard.mjs';

const done = (problems, facts = {}, warnings = []) => ({ ok: !problems.length, problems, warnings, facts });
const pct = v => `${Math.round(v * 100)}%`;

function styleProblems(pic, style, standard = STANDARD) {
  const out = [], warnings = [], s = stats(pic), st = standard.styles[style];
  if (!st) return { out, warnings };
  if (st.softLimit !== null && s.soft / s.pixels > st.softLimit) out.push(`${s.soft} pixels are half see-through: pixel art needs every pixel fully drawn or fully clear`);
  if (st.colours && s.colours > st.colours) warnings.push(`${s.colours > 4096 ? 'more than 4096' : s.colours} colours: pixel art reads best with at most ${st.colours}`);
  return { out, warnings };
}

/** One object on a see-through ground: the right size, something drawn, nothing cut off at an edge. */
export function pictureCheck(pic, { size = null, style = null, standard = STANDARD } = {}) {
  const out = [], s = stats(pic), sp = styleProblems(pic, style, standard);
  if (size && (pic.width !== size[0] || pic.height !== size[1])) out.push(`the picture is ${pic.width}x${pic.height}; it must be ${size[0]}x${size[1]}`);
  if (!s.box) return done(['nothing is drawn: the picture is empty'], s);
  if (s.cover > 0.97) out.push('the picture has no see-through ground: draw the object alone, with nothing behind it');
  else if (s.cover < 0.04) out.push(`only ${pct(s.cover)} of the picture is drawn: make the object fill most of it`);
  if (s.cover <= 0.97) {
    const cut = [s.box.x === 0 && 'left', s.box.y === 0 && 'top', s.box.right === 0 && 'right', s.box.bottom === 0 && 'bottom'].filter(Boolean);
    // a wide run of drawn pixels on an edge is a cut-off object; one or two pixels touching is a snug fit
    const edge = side => { let n = 0; const w = pic.width, h = pic.height; for (let i = 0; i < (side === 'left' || side === 'right' ? h : w); i++) { const x = side === 'left' ? 0 : side === 'right' ? w - 1 : i, y = side === 'top' ? 0 : side === 'bottom' ? h - 1 : i; if (pic.data[(y * w + x) * 4 + 3] >= 16) n++; } return n / (side === 'left' || side === 'right' ? h : w); };
    const hard = cut.filter(side => edge(side) > 0.25);
    if (hard.length) out.push(`the object runs off the ${hard.join(' and ')} edge: fit all of it inside, with a little room`);
  }
  out.push(...sp.out);
  return done(out, s, sp.warnings);
}

/**
 * A body sheet (THE sheet check: the one function to change when the standard does; gf-flat-1 §2). Six square cells in
 * a row (or three rows of six), each drawn, the figure the right size with its feet or centre where the game expects,
 * the walk frames different.
 */
export function sheetCheck(pic, { plane = 'side', style = null, cell = null, standard = STANDARD } = {}) {
  const S = standard.sheet, frames = S.frames, n = frames.length, out = [], warnings = [];
  const rows = pic.width === pic.height * n ? 1 : pic.width * 3 === pic.height * n ? 3 : 0;
  if (!rows) return done([`the sheet is ${pic.width}x${pic.height}: it must be ${n} square cells in one row (width = ${n} x height), or three such rows (${frames.join(', ')})`], { frames: [] });
  const c = pic.width / n, st = standard.styles[style];
  if (cell && c !== cell) out.push(`each cell is ${c}x${c}; the request asked for ${cell}x${cell} (the sheet ${cell * n}x${cell * rows})`);
  else if (st?.cells && !st.cells.includes(c)) out.push(`each cell is ${c}x${c}; ${st.label} cells are ${st.cells.join(', ')}`);
  const bottomAnchor = plane === 'side' || rows === 3;
  const facts = { cell: c, rows, frames: [] };
  const alphaAt = (x, y) => pic.data[(y * pic.width + x) * 4 + 3];
  for (let r = 0; r < rows; r++) {
    const rowName = S.rows[rows][r], where = name => (rows === 3 ? `"${name}" (row ${rowName})` : `"${name}"`);
    const per = frames.map((name, i) => ({ name, i, ...stats(pic, { x: i * c, y: r * c, w: c, h: c }) }));
    facts.frames.push(...per.map(f => ({ row: rowName, name: f.name, cover: +f.cover.toFixed(3), box: f.box })));
    const empty = per.filter(f => !f.box || f.cover < S.empty);
    if (empty.length) { out.push(`${empty.map(f => where(f.name)).join(', ')}: the cell is empty or nearly empty (under ${pct(S.empty)} drawn): draw the character in every cell`); continue; }
    if (per.every(f => f.cover > 0.97)) { out.push('the sheet has no see-through ground: draw the character alone, with nothing behind it'); continue; }
    for (const f of per) {
      const mid = f.box.x + f.box.w / 2 - c / 2;
      if (Math.abs(mid) > c * S.centre) out.push(`${where(f.name)}: the figure is ${Math.round(Math.abs(mid))} pixels ${mid < 0 ? 'left' : 'right'} of the middle; keep it within ${Math.floor(c * S.centre)} of the centre column`);
      if (bottomAnchor) {
        const allow = Math.max(1, Math.floor(c * (f.name === 'air' ? S.airFeet : S.feet)));
        if (f.box.bottom >= allow) out.push(`${where(f.name)}: the lowest drawn pixel is ${f.box.bottom} above the bottom edge; ${f.name === 'air' ? `even in the air it stays in the bottom ${allow} rows` : `the feet stand in the bottom ${allow} rows of the cell`}`);
      } else {
        const midY = f.box.y + f.box.h / 2 - c / 2;
        if (Math.abs(midY) > c * S.centre) out.push(`${where(f.name)}: the figure is ${Math.round(Math.abs(midY))} pixels ${midY < 0 ? 'above' : 'below'} the middle; seen from above it sits on the cell's centre`);
      }
      if (st?.margin) {
        let bad = 0;
        for (let k = 0; k < c; k++) for (let m = 0; m < st.margin; m++) { if (alphaAt(f.i * c + m, r * c + k) >= 16) bad++; if (alphaAt(f.i * c + c - 1 - m, r * c + k) >= 16) bad++; if (alphaAt(f.i * c + k, r * c + m) >= 16) bad++; }
        if (bad) out.push(`${where(f.name)}: ${bad} drawn pixels in the ${st.margin}-pixel margin at the left, right or top of the cell: keep it clear, or the next cell shows a sliver`);
      }
    }
    const idle = per[0];
    if (bottomAnchor && idle.box.h > c * S.overfill) out.push(`${where('idle')}: the figure is ${idle.box.h} of ${c} pixels tall; aim for ${pct(S.fill)} of the cell (${Math.floor(c * S.fill)} pixels) and never over ${pct(S.overfill)}, or its head goes through platforms`);
    if (idle.box.h < c * S.small) warnings.push(`${where('idle')}: the figure is only ${idle.box.h} of ${c} pixels tall: it will read small`);
    const differ = (a, b) => { let d = 0; for (let y = 0; y < c; y++) for (let x = 0; x < c; x++) { const p = ((r * c + y) * pic.width + a * c + x) * 4, q = ((r * c + y) * pic.width + b * c + x) * 4; if (Math.abs(pic.data[p + 3] - pic.data[q + 3]) > 8 || (pic.data[p + 3] > 8 && Math.abs(pic.data[p] - pic.data[q]) + Math.abs(pic.data[p + 1] - pic.data[q + 1]) + Math.abs(pic.data[p + 2] - pic.data[q + 2]) > 24)) d++; } return d / (c * c); };
    for (const [a, b, fix] of [['walk1', 'walk2', 'swap the legs so the walk moves'], ['idle', 'air', 'lift the legs or arms so a jump reads']]) {
      if (differ(frames.indexOf(a), frames.indexOf(b)) < S.same) out.push(`${where(a)} and "${b}" are the same picture: ${fix}`);
    }
  }
  if (rows === 3 && plane === 'side') warnings.push('a three-row sheet in a side-on game: only its "side" row is used');
  const sp = styleProblems(pic, style, standard);
  return done([...out, ...sp.out], facts, [...warnings, ...sp.warnings]);
}

/** A ground tile (gf-flat-1 §4, a one-cell `fill`): square, filled edge to edge, and it repeats without a line. */
export function tileCheck(pic, { size = null, style = null, solid = true, standard = STANDARD } = {}) {
  const out = [], warnings = [], s = stats(pic), K = standard.kinds.tile;
  if (size && (pic.width !== size[0] || pic.height !== size[1])) out.push(`the tile is ${pic.width}x${pic.height}; it must be ${size[0]}x${size[1]}`);
  if (pic.width !== pic.height) out.push(`the tile is ${pic.width}x${pic.height}; a tile is square`);
  if (solid && s.cover < 1) out.push(`${s.pixels - s.drawn} pixels are see-through: a solid ground tile fills its whole square`);
  // the seam: the mean colour step across the wrap, against the mean step between neighbours inside the tile
  const W = pic.width, H = pic.height, px = (x, y) => { const i = (y * W + x) * 4; return [pic.data[i], pic.data[i + 1], pic.data[i + 2]]; };
  const dist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  let lr = 0, tb = 0, inX = 0, inY = 0;
  for (let y = 0; y < H; y++) { lr += dist(px(0, y), px(W - 1, y)); for (let x = 0; x + 1 < W; x++) inX += dist(px(x, y), px(x + 1, y)); }
  for (let x = 0; x < W; x++) { tb += dist(px(x, 0), px(x, H - 1)); for (let y = 0; y + 1 < H; y++) inY += dist(px(x, y), px(x, y + 1)); }
  const seam = { leftRight: +(lr / H).toFixed(1), topBottom: +(tb / W).toFixed(1), insideAcross: +(inX / (H * Math.max(1, W - 1))).toFixed(1), insideDown: +(inY / (W * Math.max(1, H - 1))).toFixed(1) };
  // a floor of 6 (of 765) so a nearly flat tile is not failed for a step nobody can see
  for (const [label, wrap, inside, fix] of [['left and right', seam.leftRight, seam.insideAcross, 'make what leaves on the right come back in on the left'], ['top and bottom', seam.topBottom, seam.insideDown, 'make what leaves at the bottom come back in at the top']]) {
    const base = Math.max(inside, 2);
    const msg = `the ${label} edges do not continue each other (a step of ${wrap} across the join against ${inside} inside the tile): a repeated tile would show a line; ${fix}`;
    if (wrap > base * K.seamFail && style === 'pixel') out.push(msg);
    else if (wrap > base * K.seam) (style === 'pixel' || style === 'drawn' ? warnings : out).push(msg);
  }
  const sp = styleProblems(pic, style, standard);
  return done([...out, ...sp.out], { ...s, seam }, [...warnings, ...sp.warnings]);
}

/**
 * A concept picture, before a 3D model is bought from it: one subject, whole, on a plain or see-through ground.
 * (A model made from a cut-off or cluttered picture is money spent on the wrong thing.)
 */
export function conceptCheck(pic) {
  const out = [], W = pic.width, H = pic.height;
  if (W < 256 || H < 256) out.push(`the picture is ${W}x${H}: a model needs at least 256x256 to read the shape`);
  // the ground colour: the commonest of the four corners
  const at = (x, y) => { const i = (y * W + x) * 4; return [pic.data[i], pic.data[i + 1], pic.data[i + 2], pic.data[i + 3]]; };
  const corners = [at(0, 0), at(W - 1, 0), at(0, H - 1), at(W - 1, H - 1)];
  const near = (a, b) => (a[3] < 16 && b[3] < 16) || (a[3] >= 16 && b[3] >= 16 && Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 40);
  const ground = corners.map(c => [c, corners.filter(d => near(c, d)).length]).sort((a, b) => b[1] - a[1])[0];
  if (ground[1] < 3) out.push('the corners are different colours: put the subject alone on one plain colour or a see-through ground');
  const g = ground[0];
  let subject = 0, edge = 0, edgeN = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const is = !near(at(x, y), g);
    if (is) subject++;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) { edgeN++; if (is) edge++; }
  }
  const cover = subject / (W * H);
  if (cover < 0.05) out.push(`the subject covers ${pct(cover)} of the picture: make it fill most of the frame`);
  if (edge / edgeN > 0.08) out.push(`the subject touches ${pct(edge / edgeN)} of the border: show all of it, with room around it`);
  return done(out, { cover: +cover.toFixed(3), border: +(edge / edgeN).toFixed(3), ground: g[3] < 16 ? 'see-through' : `#${g.slice(0, 3).map(v => v.toString(16).padStart(2, '0')).join('')}` });
}

/** Triangle budgets by what a model is for (what a phone browser draws comfortably with several on screen). */
export const TRIANGLE_BUDGET = { body: 40000, prop: 15000, scenery: 30000, small: 5000 };

/** A GLB as it arrives from a maker: really a GLB, with triangles, inside the budget for its role, a sane file size. */
export function modelCheck(bytes, { role = 'prop', budget = TRIANGLE_BUDGET, maxBytes = 12 * 1024 * 1024 } = {}) {
  const out = [];
  if (bytes.length < 20 || bytes.toString('latin1', 0, 4) !== 'glTF') return done(['not a GLB file (a binary glTF): ask the maker for GLB'], {});
  const len = bytes.readUInt32LE(12);
  if (bytes.toString('latin1', 16, 20) !== 'JSON' || 20 + len > bytes.length) return done(['a GLB whose first part is not its JSON: the file is damaged'], {});
  let doc;
  try { doc = JSON.parse(bytes.toString('utf8', 20, 20 + len)); } catch { return done(['a GLB whose JSON does not parse: the file is damaged'], {}); }
  let triangles = 0;
  for (const m of doc.meshes ?? []) for (const p of m.primitives ?? []) {
    if ((p.mode ?? 4) !== 4) continue;
    const acc = doc.accessors?.[p.indices ?? p.attributes?.POSITION];
    triangles += Math.floor((acc?.count ?? 0) / 3);
  }
  const facts = { triangles, meshes: (doc.meshes ?? []).length, skins: (doc.skins ?? []).length, animations: (doc.animations ?? []).length, images: (doc.images ?? []).length, bytes: bytes.length, role };
  if (!triangles) out.push('the model has no triangles');
  const max = budget[role];
  if (max && triangles > max) out.push(`${triangles} triangles: a ${role} gets at most ${max}. Ask the maker for a lower polygon count (a target of ${Math.round(max * 0.8)}), or simplify it`);
  if (bytes.length > maxBytes) out.push(`${(bytes.length / 1048576).toFixed(1)} MB: keep a ${role} under ${(maxBytes / 1048576).toFixed(0)} MB (smaller textures)`);
  return done(out, facts);
}

/** The check for a kind of art, by name. */
export function checkArt(kind, pic, options = {}) {
  if (kind === 'sheet') return sheetCheck(pic, options);
  if (kind === 'tile') return tileCheck(pic, options);
  if (kind === 'picture') return pictureCheck(pic, options);
  throw new Error(`no picture check for kind "${kind}"`);
}
