// The look judge's sheet page for the three runtime's flat-2d profile (kinds pixel, drawn): ?kind=<id>&shot=world|
// hero|bodies|props. It draws through the flat runtime's picture rules (runtimes/three/profiles/flat-2d/look.js: an
// orthographic view, one texel density for the whole picture — 16 texels a metre for pixel, 128 for drawn — nearest
// filtering and cut-out alpha for pixel, smooth filtering and soft edges for drawn, and a pixel view snapped so one
// texel is a whole number of screen pixels). The pictures are the kind's packs (sheet-packs.json) and the runtime's
// stand-ins; the drawn kind's bodies are the baked gf-flat-1 sheets (lib/bake-flat.mjs). The pixel kind draws its own
// packs from the asset library through the runtime's draw plan (its sheet.world: a town map and the art of each kind).
import * as THREE from 'three';
import { STYLES } from '/kit/flat/slots.js';
import { readMap } from '/kit/flat/tilemap.js';
import { drawPlan } from '/kit/flat/drawplan.js';

const Q = new URLSearchParams(location.search);
const SHOT = Q.get('shot') ?? 'world';
const S = window.__sheet = { ready: false, errors: [], info: { shot: SHOT } };
addEventListener('error', e => S.errors.push(String(e.error?.stack ?? e.message)));
addEventListener('unhandledrejection', e => S.errors.push(String(e.reason?.stack ?? e.reason)));

const kind = await (await fetch(`/xk/kinds/${Q.get('kind')}.json`)).json();
const LF = kind.look.three, style = LF.style, ppm = STYLES[style].ppm, pixel = style === 'pixel';
const W = innerWidth, H = innerHeight;
const canvas = document.getElementById('view');
// no multisampling: the pictures carry their own soft edges, and MSAA with cut-out alpha dropped whole tiles on this
// machine's driver (a drawn ground tile came out as one flat colour)
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1); renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
const scene = new THREE.Scene(), back = new THREE.Scene();   // back: the backdrop, drawn first in its own pass
// the pixel kind's ground and its shadows each in their own pass under what stands (a cut-out picture is drawn in
// three's opaque pass, before any see-through shadow, whatever its order)
const groundPass = new THREE.Scene(), shadePass = new THREE.Scene();
back.background = new THREE.Color(LF.values?.background ?? '#8fd3ff');

// ---- the view: metres tall; a pixel view is snapped to whole screen pixels a texel (kit/flat/look.js resizeCamera) ----
function view(metresTall) {
  let viewH = metresTall;
  if (pixel) { const k = Math.max(1, Math.round(H / viewH / ppm)); viewH = H / (k * ppm); S.info.pxPerTexel = k; }
  const viewW = viewH * W / H;
  const cam = new THREE.OrthographicCamera(0, viewW, viewH, 0, -10, 10);
  return { cam, w: viewW, h: viewH };
}

// ---- pictures: a texture per file, a region per sprite (the flat runtime's picture material) ----
const textures = new Map();
async function tex(url) {
  if (!textures.has(url)) textures.set(url, new THREE.TextureLoader().loadAsync(url).then(t => {
    t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = false; t.anisotropy = 1;
    t.magFilter = t.minFilter = pixel ? THREE.NearestFilter : THREE.LinearFilter;
    return t;
  }));
  return textures.get(url);
}
const layers = [], materials = new Map();
/** A sprite: url, its source rectangle in pixels (or the whole picture), placed with its bottom-left at (x, y) metres,
 *  sized by the style's texels a metre unless w is given. flip: mirrored. z: draw order. */
async function sprite(url, { x, y, rect = null, w = null, z = 2, flip = false, tint = null }) {
  const into = z <= 0 ? back : z < 2 ? groundPass : scene;
  const t = await tex(url);
  const iw = t.image.width, ih = t.image.height;
  const [sx, sy, sw, sh] = rect ?? [0, 0, iw, ih];
  // one material per picture; the region is the quad's own UVs (a town of 300 tiles is one texture, not 300)
  const key = `${url}|${tint ?? ''}`;
  let m = materials.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: t, color: tint ?? '#ffffff', transparent: !pixel, alphaTest: pixel ? 0.5 : 0.02, depthWrite: false, depthTest: false }); materials.set(key, m); }   // a 2D picture: draw order is the layer (renderOrder), never depth
  const mw = w ?? sw / ppm, mh = mw * sh / sw;
  const g = new THREE.PlaneGeometry(mw, mh), uv = g.attributes.uv;
  const u0 = sx / iw, u1 = (sx + sw) / iw, v0 = 1 - (sy + sh) / ih, v1 = 1 - sy / ih;
  for (let i = 0; i < uv.count; i++) { const L = uv.getX(i) < 0.5 !== flip; uv.setXY(i, L ? u0 : u1, uv.getY(i) < 0.5 ? v0 : v1); }
  const mesh = new THREE.Mesh(g, m);
  mesh.position.set(x + mw / 2, y + mh / 2, z * 0.01); mesh.renderOrder = z;
  into.add(mesh); layers.push(mesh);
  return { w: mw, h: mh };
}
// a row's words go under the tile (the sheet's caption line, S.info.captions), never over the art
const label = text => { (S.info.captions ??= []).push(text); };
const rng = (seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; })(7);

// ---- the drawn kind's packs (the pixel kind draws from the asset library: below) ----
const STANDIN = `/xk/builder/tools/lib/standin-assets/flat/${style}/`;
const NP = '/packs/new-platformer-pack/Sprites/';
const np = (dir, name, x, y, o = {}) => sprite(`${NP}${dir}/Double/${name}.png`, { x, y, z: o.z ?? 2, flip: o.flip ?? false, w: o.w ?? null });

// ---- the pixel kind: its own packs in the asset library (/lib3/<pack>/<id>.png), laid out by the flat runtime's own
// draw plan (drawplan.js), so the world shot is what a game with the same map draws: the base, soft edges, dressing,
// fences, set pieces standing near over far, and the runtime's shadows ----
const LIB = ref => `/lib3/${ref}.png`;
let shadowMat = null;
/** The runtime's ground shadow (look.js groundShadow): a hard-edged ellipse, see-through. */
function shadow(cx, cy, w, h, z = 1.05) {
  if (!shadowMat) {
    const W = 32, H = 16, d = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const dx = (x + 0.5 - W / 2) / (W / 2), dy = (y + 0.5 - H / 2) / (H / 2); d[(y * W + x) * 4 + 3] = dx * dx + dy * dy <= 1 ? 255 : 0; }
    const t = new THREE.DataTexture(d, W, H, THREE.RGBAFormat); t.magFilter = t.minFilter = THREE.NearestFilter; t.needsUpdate = true;
    shadowMat = new THREE.MeshBasicMaterial({ color: '#1a1030', map: t, transparent: true, opacity: 0.26, depthWrite: false, depthTest: false });
  }
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), shadowMat);
  m.position.set(cx, cy, z * 0.01); m.renderOrder = z; shadePass.add(m); layers.push(m);
}
/** A tile map drawn through the runtime's draw plan. art: { tiles, edges, dress } kind → library ref. The map's column
 *  c is at x = ox + c, its row r's top edge at y = top - r. → the plan's items */
async function drawMap(map, art, { ox, top, pad = 3 }) {
  const M = readMap(map);
  if (!M.ok) throw new Error(`map: ${M.problems.join('; ')}`);
  const has = { tiles: new Set(), edges: new Set(), dress: new Set() }, sizes = {}, urls = {};
  for (const [group, prefix] of [['tiles', 'world.tiles.'], ['edges', 'world.edges.'], ['dress', 'world.dress.']]) {
    for (const [k, ref] of Object.entries(art[group] ?? {})) { const t = await tex(LIB(ref)); has[group].add(k); sizes[prefix + k] = [t.image.width, t.image.height]; urls[prefix + k] = LIB(ref); }
  }
  const items = drawPlan(M, { ...has, sizes, ppm, pad });
  // one mesh per picture and layer (a town is hundreds of quads; one mesh each lost the software renderer's context)
  const groups = new Map();
  for (const it of items) {
    const X = ox + it.c + 0.5, Y = top - it.r - 0.5;
    if (it.shadow) { shadow(X, Y, it.w, it.h); continue; }
    // the ground in layers; what stands (a set piece) by the row of its near edge, as the bodies are
    const z = it.layer === 5 ? 2 + (it.near + 0.5) * 0.01 : 1 + it.layer * 0.01 + (it.sub ?? 0) * 0.001;
    const key = `${it.slot}|${z}`;
    if (!groups.has(key)) groups.set(key, { url: urls[it.slot], z, quads: [] });
    groups.get(key).quads.push({ x: X - it.w / 2, y: Y - it.h / 2, w: it.w, h: it.h, frame: it.frame, grid: it.grid });
  }
  for (const g of groups.values()) await batch(g.url, g.z, g.quads);
  return { M, items };
}
/** Many quads of one picture as one mesh. quads: [{ x, y (bottom left), w, h (metres), frame: [col, row], grid: [cols, rows] }] */
async function batch(url, z, quads) {
  const t = await tex(url), key = `${url}|`;
  let m = materials.get(key);
  if (!m) { m = new THREE.MeshBasicMaterial({ map: t, transparent: !pixel, alphaTest: pixel ? 0.5 : 0.02, depthWrite: false, depthTest: false }); materials.set(key, m); }
  const n = quads.length, pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
  quads.forEach((q, i) => {
    const u0 = q.frame[0] / q.grid[0], u1 = (q.frame[0] + 1) / q.grid[0], v0 = 1 - (q.frame[1] + 1) / q.grid[1], v1 = 1 - q.frame[1] / q.grid[1];
    pos.set([q.x, q.y, 0, q.x + q.w, q.y, 0, q.x + q.w, q.y + q.h, 0, q.x, q.y + q.h, 0], i * 12);
    uv.set([u0, v0, u1, v0, u1, v1, u0, v1], i * 8);
    idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(new THREE.BufferAttribute(idx, 1));
  const mesh = new THREE.Mesh(g, m); mesh.position.z = z * 0.01; mesh.renderOrder = z; mesh.frustumCulled = false;
  (z < 2 ? groundPass : scene).add(mesh); layers.push(...quads.map(() => mesh));
}
const bodyRef = id => (id === 'folk-player' ? 'flat-standins-pixel/body-top' : `xk-pixel-folk/${id}-top`);
/** A villager standing with its feet at (x, y) metres: one 32 px cell (2 m) of its sheet, its shadow under it. */
async function villager(ref, { x, y, row = 0, frame = 0, flip = false, near = 0 }) {
  shadow(x, y + 0.04, 0.85, 0.32);
  await sprite(LIB(ref), { rect: [frame * 32, row * 32, 32, 32], x: x - 1, y, w: 2, z: 2 + near * 0.01 + 0.005, flip });
}
/** A plain field to stand things on: grass and its dressing, through the same plan. */
function field(cols, rows) { return { format: 'gf-tilemap-1', plane: 'top', tile: 1, base: 'grass', kinds: { grass: { solid: false, dress: 0.3 } }, legend: { '.': null, '1': 'spawn' }, rows: Array.from({ length: rows }, (_, r) => (r === 0 ? '1' : '.') + '.'.repeat(cols - 1)) }; }
const FIELD_ART = { tiles: { grass: 'flat-standins-pixel/tile-grass' }, dress: { grass: 'xk-pixel-town/dress-grass' } };

async function pixelShot(shot) {
  const town = await (await fetch(`/xk/${kind.sheet.world}`)).json();
  if (shot === 'world' || shot === 'hero') {
    // world: the whole town at 4 screen pixels a texel (about what a game shows on a wide screen); hero: two villagers
    // by a door at 12
    const { cam, w, h } = view(shot === 'world' ? 11.25 : 3.75);
    const focus = shot === 'world' ? [town.map.rows[0].length / 2, town.map.rows.length / 2 - 0.3] : [3.9, 6.1];
    const ox = w / 2 - focus[0], top = h / 2 + focus[1];
    await drawMap(town.map, town.art, { ox, top });
    const bodies = shot === 'world' ? town.sheet.bodies : town.sheet.hero;
    for (const b of bodies) await villager(bodyRef(b.id), { x: ox + b.at[0], y: top - b.at[1], row: b.row, frame: b.frame, flip: !!b.flip, near: b.at[1] });
    if (shot === 'hero') label('the kind\'s villagers at 16 texels a metre, 12 screen pixels a texel, in front of a set piece');
    return cam;
  }
  if (shot === 'bodies') {
    const { cam, w, h } = view(7.5);
    await drawMap(field(Math.ceil(w) + 2, Math.ceil(h) + 2), FIELD_ART, { ox: -1, top: h + 1, pad: 0 });
    const folk = town.sheet.folk, step = Math.min(1.02, (w - 0.4) / folk.length), x0 = (w - step * (folk.length - 1)) / 2;
    for (const [k, id] of folk.entries()) await villager(bodyRef(id), { x: x0 + k * step, y: 5.25, row: 0, near: 0 });
    label(`${folk.length} villagers seen from above (the player's light grey shirt takes each seat's colour)`);
    // one villager's six frames, side-on and from above
    const S = town.sheet.frames, fx = (w - 12) / 2 + 1;
    for (let f = 0; f < 6; f++) await villager(bodyRef(S.side), { x: fx + f * 2, y: 2.85, row: 1, frame: f, near: 1 });
    for (let f = 0; f < 6; f++) await villager(bodyRef(S.down), { x: fx + f * 2, y: 0.45, row: 0, frame: f, near: 2 });
    label('gf-flat-1 frames: idle · walk1 · walk2 · air · act · down, side-on and from above (each sheet passes the flat judge)');
    return cam;
  }
  // props: the town's things standing on grass with their shadows, then the pickups
  const { cam, w, h } = view(7.5);
  await drawMap(field(Math.ceil(w) + 2, Math.ceil(h) + 2), FIELD_ART, { ox: -1, top: h + 1, pad: 0 });
  const rows = [[3.35, town.sheet.props[0]], [1.85, town.sheet.props[1]], [0.35, town.sheet.props[2]]];
  for (const [r, [y, row]] of rows.entries()) {
    const ts = await Promise.all(row.map(ref => tex(LIB(ref)))), ws = ts.map(t => t.image.width / ppm), gap = 0.25;
    let x = (w - ws.reduce((a, b) => a + b, 0) - gap * (row.length - 1)) / 2;
    for (const [k, ref] of row.entries()) {
      shadow(x + ws[k] / 2, y + 0.1, ws[k] * (ws[k] > 2 ? 0.75 : 0.85), Math.min(0.6, ws[k] * 0.3));
      await sprite(LIB(ref), { x, y, z: 2 + r * 0.01 });
      x += ws[k] + gap;
    }
  }
  label('trees, a well, a lamp, props and pickups from the kind\'s packs, each with the runtime\'s shadow');
  return cam;
}

async function ground(w, y = 0, rows = 2) {
  for (let x = 0; x < Math.ceil(w); x++) {
    for (let r = 0; r < rows - 1; r++) await np('Tiles', 'terrain_grass_block_center', x, y + r, { z: 1, w: 1 });
    await np('Tiles', 'terrain_grass_block_top', x, y + rows - 1, { z: 1, w: 1 });
  }
}
async function backdrop(w, h, y0 = 0) {
  // the pack's backdrop is stacked: hills at the bottom, a band of clouds above them, the sky colour above that
  const s = Math.max(h * 0.55, 3), n = Math.ceil(w / s) + 1;
  back.background = new THREE.Color('#c3e3ff');
  for (let i = 0; i < n; i++) {
    await sprite(`${NP}Backgrounds/Double/background_color_hills.png`, { x: i * s, y: y0, w: s, z: 0 });
    await sprite(`${NP}Backgrounds/Double/background_clouds.png`, { x: i * s, y: y0 + s, w: s, z: 0 });
  }
}
const BODY = c => `/packs/baked/body-np-${c}.png`;
const frame = (c, f, x, y, flip = false) => sprite(BODY(c), { rect: [f * 256, 0, 256, 256], x, y, z: 3, flip });

async function drawnShot(shot) {
  if (shot === 'world') {
    const { cam, w, h } = view(9);
    await backdrop(w, h);
    await ground(w, 0, 2);
    // a gap of water
    for (const x of [9, 10]) { await np('Tiles', 'water', x, 0, { z: 1.5, w: 1 }); await np('Tiles', 'water_top', x, 1, { z: 1.5, w: 1 }); }
    const plat = async (x, y, n) => { await np('Tiles', 'terrain_grass_horizontal_left', x, y, { w: 1 }); for (let i = 1; i < n - 1; i++) await np('Tiles', 'terrain_grass_horizontal_middle', x + i, y, { w: 1 }); await np('Tiles', 'terrain_grass_horizontal_right', x + n - 1, y, { w: 1 }); };
    await plat(5, 4, 3); await plat(11, 5.5, 3);
    for (const [n, x, y] of [['block_coin', 7.5, 6.5], ['bricks_brown', 6.5, 6.5], ['block_exclamation', 5.5, 6.5]]) await np('Tiles', n, x, y, { w: 1 });
    for (const [n, x, y] of [['bush', 0.3, 2], ['mushroom_red', 3.8, 2], ['sign_right', 7.6, 2], ['fence', 13, 2], ['fence', 14, 2], ['flag_green_a', 15, 2], ['coin_gold', 11, 6.6], ['coin_gold', 12, 6.6], ['coin_gold', 8.5, 7.6], ['gem_blue', 6, 5], ['spring', 12, 2], ['ladder_top', 5.1, 4], ['ladder_middle', 5.1, 3], ['ladder_bottom', 5.1, 2]]) await np('Tiles', n, x, y, { w: 1 });
    await frame('beige', 0, 1.5, 2); await frame('pink', 3, 8.4, 2.9, false);
    await np('Enemies', 'slime_normal_walk_a', 13, 6.5, { z: 3, flip: true, w: 1 }); await np('Enemies', 'bee_a', 9.3, 4.2, { z: 3, w: 1 }); await np('Enemies', 'snail_walk_a', 15.2, 2, { z: 3, flip: true, w: 1 });
    return cam;
  }
  if (shot === 'hero') {
    const { cam, w, h } = view(3.2);
    await backdrop(w, h); await ground(w, -0.6, 2);
    await frame('beige', 0, w / 2 - 2.1, 1.4); await frame('green', 4, w / 2 + 0.1, 1.4, true);
    label('baked gf-flat-1 frames at 128 texels a metre', w / 2, 0.25, cam);
    return cam;
  }
  if (shot === 'bodies') {
    const { cam, w, h } = view(4.5);
    await backdrop(w, h); await ground(w, -0.3, 2);
    const cs = ['beige', 'green', 'pink', 'purple', 'yellow'], fs = [0, 1, 3, 4, 5];
    for (const [k, c] of cs.entries()) await frame(c, fs[k], (w - cs.length * 1.5) / 2 - 0.25 + k * 1.5, 1.7);
    label('5 bodies, frames idle · walk1 · air · act · down (each a 6-frame sheet that passes the flat judge)', w / 2, 0.5, cam);
    return cam;
  }
  const { cam, w, h } = view(6);
  await backdrop(w, h); await ground(w, -1, 2);
  const rows = [['coin_gold', 'coin_silver', 'gem_blue', 'gem_red', 'gem_green', 'heart', 'key_yellow', 'star', 'lock_yellow'], ['mushroom_red', 'bush', 'sign', 'spring', 'fence', 'flag_red_a', 'lever', 'bomb', 'block_exclamation']];
  for (const [r, row] of rows.entries()) { const x0 = (w - row.length * 1.15) / 2; for (const [k, n] of row.entries()) await np('Tiles', n, x0 + k * 1.15, r ? 1 : 3.4, { w: 1 }); }
  return cam;
}

const cam = pixel ? await pixelShot(SHOT) : await drawnShot(SHOT);
S.info.style = style; S.info.ppm = ppm; S.info.sprites = layers.length;
const draw = () => { renderer.autoClear = true; renderer.render(back, cam); renderer.autoClear = false; for (const sc of [groundPass, shadePass, scene]) { renderer.clearDepth(); renderer.render(sc, cam); } };
draw();
await new Promise(r => requestAnimationFrame(r));
draw();
S.ready = true;
