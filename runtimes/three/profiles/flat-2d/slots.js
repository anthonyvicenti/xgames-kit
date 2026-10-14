// gf-three flat: the declarations of a flat (2D) game. Pure: Node imports it (create, tools/slots.mjs, the catalog) and
// so does the page. A flat game is the same kit with four parts swapped and everything else kept:
//
//   the look        an orthographic camera, unlit pictures, one of two art STYLES (pixel, drawn)        look.js
//   the world       a tile map (tilemap.js): `field` seen from above, `stage` seen from the side        world.js
//   the body        a picture: a sheet of frames by the gf-flat-1 standard (ART-STANDARD.md)             character.js
//   the controller  the kit's own capsule and controller, with a flat camera rig in place of its rig    controller.js
//
//   plane 'top'   the ground is X-Z, the camera looks straight down, screen up is -Z, nobody jumps
//   plane 'side'  the ground is along X, gravity pulls down Y, every body stays at Z = 0, Space jumps
import { humanize } from '../core/slots.js';
import { lookSlots as valueSlots } from '../core/standins/slots.js';
import { FORMAT, KINDS, LEGENDS, SIZES, generateMap, readMap, reachOf, jumpReach } from './tilemap.js';

export const STANDARD = 'gf-flat-1';
export const PLANES = ['top', 'side'];
export const templates = { top: ['field'], side: ['stage'] };
export const cameras = { top: 'top', side: 'side' };
/** The two art styles (ART-STANDARD.md §1). ppm: texels per metre, the same for every picture of a game. */
export const STYLES = {
  pixel: { ppm: 16, cell: 32, tile: 16, cells: [16, 24, 32, 48, 64], tiles: [8, 32], props: [8, 128], hard: true },
  drawn: { ppm: 128, cell: 256, tile: 128, cells: [128, 512], tiles: [64, 256], props: [64, 1024], hard: false },
};
/** A body sheet: 6 frames across, and 1 row (`turn`) or 3 (`down`, `side`, `up`). */
export const FRAMES = ['idle', 'walk1', 'walk2', 'air', 'act', 'down'];
export const ROWS = { 1: ['turn'], 3: ['down', 'side', 'up'] };
/** A standing figure fills at most this share of its cell's height, so a cell is height / FILL metres square. */
export const FILL = 0.85;
/** Side-on, what a body does (config/game.json → controller): a jump that clears two cells with room to spare. */
export const SIDE = { jump: 10.5, speed: 5.2, sprint: 7.4, fallScale: 1.7 };

// The flat looks. Each names its style. view: metres across the SHORTER side of a wide screen; portrait: metres across
// a phone held upright (side-on only: see controller.js for the rule).
export const presets = {
  'pixel-day': { label: 'Pixel day', describe: 'Pixel art under a clear sky: hard pixels, every texel a whole number of screen pixels', style: 'pixel', values: { background: '#8fd3ff', ground: '#6fb65c', view: 12, portrait: 11 } },
  'pixel-night': { label: 'Pixel night', describe: 'Pixel art at night: the same hard pixels on a deep blue', style: 'pixel', values: { background: '#1b1c3a', ground: '#23264d', view: 12, portrait: 11 } },
  'drawn-day': { label: 'Drawn day', describe: 'Drawn art, smooth at any size, on a warm paper sky', style: 'drawn', values: { background: '#cdeaf5', ground: '#84c76f', view: 12, portrait: 11 } },
  'drawn-dusk': { label: 'Drawn dusk', describe: 'Drawn art at dusk: smooth shapes on a peach and violet sky', style: 'drawn', values: { background: '#f3b9a0', ground: '#7d6aa8', view: 12, portrait: 11 } },
};
export const DEFAULT_LOOK = 'pixel-day';
export const styleOf = lookCfg => (lookCfg?.style in STYLES ? lookCfg.style : presets[lookCfg?.preset]?.style ?? 'pixel');
export const presetValues = id => JSON.parse(JSON.stringify((presets[id] ?? presets[DEFAULT_LOOK]).values));
/** config/look.json of a flat game: the preset, its style, and its values (each number and colour a look.* slot). */
export function lookConfig(id, { plane = 'top' } = {}) {
  const key = id in presets ? id : DEFAULT_LOOK, values = presetValues(key);
  // from above the picture is the ground itself: what shows past the map's edge is the ground colour, not the sky
  if (plane === 'top') { values.background = values.ground; delete values.portrait; }
  delete values.ground;
  return { preset: key, flat: plane, style: presets[key].style, standard: STANDARD, values };
}

const ART = 'tools/lib/standin-assets/flat';
export const ART_LICENSE = { spdx: 'CC0-1.0', author: 'xgames-kit (stand-in, made by the kit\'s own tools: runtimes/three/tools/pixel/ for pixel art)' };
const PROP_ART = ['coin', 'gem', 'crate', 'heart', 'key', 'star'];
/** A prop's stand-in picture (kit-parent-relative): by name when the bake has it, else by what the name sounds like. */
export const propArt = (name, style = 'pixel') => `${ART}/${style}/${PROP_ART.includes(name) ? name : /coin|gold|token/.test(name) ? 'coin' : /star|point/.test(name) ? 'star' : /heart|health|heal|life/.test(name) ? 'heart' : /key/.test(name) ? 'key' : /crate|box|chest/.test(name) ? 'crate' : 'gem'}.png`;
export const bodyArt = (plane, style = 'pixel') => `${ART}/${style}/body-${plane === 'side' ? 'side' : 'top'}.png`;
export const tileArt = (kind, style = 'pixel') => `${ART}/${style}/tile-${kind}.png`;
export const edgeArt = (name, style = 'pixel') => `${ART}/${style}/edges-${name}.png`;
export const dressArt = (name, style = 'pixel') => `${ART}/${style}/dress-${name}.png`;
export const pieceArt = (name, style = 'pixel') => `${ART}/${style}/${name}.png`;
/** What the stand-in art has, by style (runtimes/three/tools/pixel/town.mjs draws the pixel set): tile kinds, edge sets
 *  (blend and connect), dressing strips and set pieces. A kind a spec's map invents gets the nearest by its name and by
 *  what it does. */
export const STANDIN_ART = {
  pixel: {
    tiles: ['grass', 'path', 'wall', 'water', 'ground', 'brick', 'ledge', 'soil', 'cobble'],
    blend: ['path', 'water', 'soil', 'cobble'], connect: ['wall', 'fence', 'hedge'], dress: ['grass', 'soil', 'path'],
    pieces: ['house-red', 'house-blue', 'shop', 'shed', 'tree-oak', 'tree-apple', 'tree-pine', 'bush', 'bush-berry', 'rock', 'boulder', 'stump', 'log-pile', 'barrel', 'crate-big', 'sign', 'mailbox', 'lamp', 'well', 'flower-pot', 'pumpkin', 'hay', 'bench'],
  },
  drawn: { tiles: ['grass', 'path', 'wall', 'water', 'ground', 'brick', 'ledge'], blend: [], connect: [], dress: [], pieces: [] },
};
const artOf = style => STANDIN_ART[style] ?? STANDIN_ART.pixel;
const tileFor = (kind, k, plane, style = 'pixel') => (artOf(style).tiles.includes(kind) ? kind : k.solid === 'top' ? 'ledge' : k.solid ? (plane === 'side' ? 'brick' : 'wall') : plane === 'side' ? 'ledge' : /soil|farm|crop|field|garden/.test(kind) && artOf(style).tiles.includes('soil') ? 'soil' : /cobble|stone|street|plaza|square/.test(kind) && artOf(style).tiles.includes('cobble') ? 'cobble' : 'path');
const NAMES = [
  [/shop|store|market|bakery|inn|tavern/, 'shop'], [/shed|barn|hut|stable/, 'shed'], [/house|home|cottage|cabin|building/, 'house-red'],
  [/apple|fruit|orchard|cherry/, 'tree-apple'], [/pine|fir|spruce|conifer/, 'tree-pine'], [/tree|oak|wood/, 'tree-oak'], [/berr/, 'bush-berry'], [/bush|shrub/, 'bush'],
  [/boulder/, 'boulder'], [/rock|stone/, 'rock'], [/stump/, 'stump'], [/log/, 'log-pile'], [/barrel|keg/, 'barrel'], [/crate|box/, 'crate-big'],
  [/sign|post/, 'sign'], [/mail/, 'mailbox'], [/lamp|light|lantern/, 'lamp'], [/well/, 'well'], [/pot|flower|plant/, 'flower-pot'], [/pumpkin/, 'pumpkin'], [/hay|straw/, 'hay'], [/bench|seat/, 'bench'],
];
/** The stand-in picture of a set piece kind (a kind with `piece`), by its name, else by its footprint. */
export function pieceFor(kind, k, style = 'pixel') {
  const have = artOf(style).pieces;
  if (!have.length) return null;
  if (have.includes(kind)) return kind;
  const hit = NAMES.find(([re, name]) => re.test(kind) && have.includes(name));
  return hit ? hit[1] : (k.piece?.[0] ?? 1) >= 3 ? 'house-red' : 'tree-oak';
}
/** The stand-in edge set of a kind with `edges`, or null when the style has none. */
export function edgesFor(kind, k, style = 'pixel') {
  const A = artOf(style), list = k.edges === 'connect' ? A.connect : A.blend;
  if (!list.length) return null;
  if (list.includes(kind)) return kind;
  if (k.edges === 'connect') return /fence|rail|pen/.test(kind) && list.includes('fence') ? 'fence' : /hedge|bush|shrub/.test(kind) && list.includes('hedge') ? 'hedge' : list.includes('wall') ? 'wall' : list[0];
  const by = /pond|lake|river|sea|water/.test(kind) ? 'water' : /soil|farm|crop|field|garden/.test(kind) ? 'soil' : /cobble|stone|street|plaza|square/.test(kind) ? 'cobble' : 'path';
  return list.includes(by) ? by : list[0];
}
/** The stand-in dressing strip of a kind with `dress`, or null. */
export function dressFor(kind, k, style = 'pixel') {
  const list = artOf(style).dress;
  if (!list.length) return null;
  if (list.includes(kind)) return kind;
  return /soil|farm|crop|field|garden/.test(kind) && list.includes('soil') ? 'soil' : /path|road|dirt|trail/.test(kind) && list.includes('path') ? 'path' : list.includes('grass') ? 'grass' : list[0];
}

/** A flat-2d spec's plane: its camera says it (side: seen from the side, with gravity; top: seen from above). */
export const planeOfSpec = spec => (spec?.camera === 'side' ? 'side' : 'top');

// a spec's own random numbers: the same spec gives the same map, whoever asks (create's refusal and its config)
function specRng(spec) {
  let h = 2166136261; for (const ch of `${spec.title ?? ''}|${planeOfSpec(spec)}|${spec.world?.size ?? 'small'}|flat`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => ((h = (Math.imul(h, 1103515245) + 12345) >>> 0) / 4294967296);
}

/**
 * The tile map of a spec: spec.world.map when the spec wrote one (rows, and any of tile, base, kinds, legend: what it
 * leaves out is the plane's default), else a generated map of the asked size. → the map (gf-tilemap-1)
 */
export function mapFor(spec) {
  const plane = planeOfSpec(spec), given = spec.world?.map;
  if (given?.rows) {
    return { format: FORMAT, plane, tile: given.tile ?? 1, ...(plane === 'top' ? { base: given.base ?? 'grass' } : {}),
      kinds: { ...KINDS[plane], ...(given.kinds ?? {}) }, legend: { ...LEGENDS[plane], ...(given.legend ?? {}) }, rows: given.rows };
  }
  const marks = (spec.world?.props ?? []).map(p => p.name).filter(n => /^[a-z][a-z0-9-]{0,23}$/.test(n)).slice(0, 3);
  return generateMap({ plane, size: spec.world?.size ?? 'small', seats: Math.max(2, spec.players?.max ?? 4), rng: specRng(spec), marks, reach: jumpReach(SIDE) });
}

/** What is wrong with a flat-2d spec, in words (create refuses with these before anything is written). Its plane
 *  follows its camera: top (seen from above, world field) or side (seen from the side with gravity, world stage). */
export function refuse(spec) {
  const bad = [];
  if (!Object.values(cameras).includes(spec.camera)) return [`camera: a flat-2d game is seen from above ("top") or from the side ("side"), not "${spec.camera}"`];
  const plane = planeOfSpec(spec);
  const T = spec.world?.template, L = spec.look?.preset;
  if (!templates[plane].includes(T)) bad.push(`world.template "${T}" is not the flat ${plane} world (${templates[plane].join(', ')}): camera ${spec.camera} plays on ${templates[plane].join(' or ')}`);
  if (!(L in presets)) bad.push(`look.preset "${L}" is not a flat look (${Object.keys(presets).join(', ')})`);
  if (spec.loop === 'world') bad.push('loop world: the block world is not a flat world');
  const M = readMap(mapFor(spec));
  for (const p of M.problems) bad.push(`world.map: ${p}`);
  if (M.ok && plane === 'side') for (const p of reachOf(M, jumpReach(SIDE)).problems) bad.push(`world.map: ${p}`);
  if (M.ok && M.spawns.length < Math.max(2, spec.players?.max ?? 4)) bad.push(`world.map: ${M.spawns.length} spawns for ${Math.max(2, spec.players?.max ?? 4)} seats`);
  return bad;
}
/** What a three spec on another profile may not name (so a flat world or look never lands in a 3D game by a slip). */
export function refuseNotFlat(spec) {
  const bad = [], T = spec.world?.template, L = spec.look?.preset;
  if (Object.values(templates).flat().includes(T)) bad.push(`world.template "${T}" is a flat-2d world: the spec needs "profile": "flat-2d"`);
  if (L in presets) bad.push(`look.preset "${L}" is a flat-2d look: the spec needs "profile": "flat-2d"`);
  if (spec.world?.map) bad.push('world.map is a flat-2d world\'s tile map: the spec needs "profile": "flat-2d"');
  return bad;
}

/**
 * config/world.json of a flat game (create calls it in Node; the call shape of the scenic world's worldConfig,
 * CONTRACT §8). opts.assets gets the tile pictures to copy ({to, from, license}); opts.repoFile makes `from` absolute.
 */
export function worldConfig(spec, { assets = [], notes = [], repoFile = f => f } = {}) {
  const plane = planeOfSpec(spec), style = presets[spec.look?.preset]?.style ?? 'pixel';
  const map = mapFor(spec), M = readMap(map), tiles = {}, edges = {}, dress = {};
  const copy = (to, from) => { if (!assets.some(a => a.to === to)) assets.push({ to, from: repoFile(from), license: ART_LICENSE }); return to; };
  for (const [kind, k] of Object.entries(M.kinds)) {
    // a set piece's picture is the piece itself (a house, a tree); every other kind a tile, and its edges and dressing
    // when it asks for them and the style's art has them (drawplan.js draws them; a game without them draws plain tiles)
    const piece = k.piece ? pieceFor(kind, k, style) : null;
    tiles[kind] = copy(`assets/tiles/${kind}.png`, piece ? pieceArt(piece, style) : tileArt(tileFor(kind, k, plane, style), style));
    const e = k.edges ? edgesFor(kind, k, style) : null;
    if (e) edges[kind] = copy(`assets/tiles/${kind}-edges.png`, edgeArt(e, style));
    const d = k.dress ? dressFor(kind, k, style) : null;
    if (d) dress[kind] = copy(`assets/tiles/${kind}-dress.png`, dressArt(d, style));
  }
  const extra = [Object.keys(edges).length ? `edges on ${Object.keys(edges).join(', ')}` : '', Object.keys(dress).length ? `dressing on ${Object.keys(dress).join(', ')}` : '', Object.values(M.kinds).some(k => k.piece) ? `set pieces ${Object.keys(M.kinds).filter(k => M.kinds[k].piece).join(', ')}` : ''].filter(Boolean);
  notes.push(`world: a flat ${templates[plane][0]} seen from ${plane === 'side' ? 'the side' : 'above'}, a tile map of ${M.cols} x ${M.rows} cells (${spec.world?.map?.rows ? 'the spec\'s own' : 'generated'}), ${Object.keys(map.kinds).length} tile kinds, ${M.spawns.length} spawns${extra.length ? `; ${extra.join('; ')}` : ''}`);
  // `spawns` is the world contract's field (CONTRACT §4.3: tools read a world's spawns there). In a flat world the MAP
  // is what the game reads; this list is the map's spawn cells as points, written beside it (spawnsOf), and the world's
  // own report says so when the two no longer agree (tools/flat-map.mjs <game> --sync writes it again).
  return { template: templates[plane][0], plane, size: spec.world?.size ?? 'small', half: Math.round((M.cols * M.tile) / 2), style, map, tiles, ...(Object.keys(edges).length ? { edges } : {}), ...(Object.keys(dress).length ? { dress } : {}), spawns: spawnsOf(map),
    zones: { centre: { shape: 'circle', at: [0, 0, 0], size: [2.5] } }, ...(spec.world?.notes ? { notes: spec.world.notes } : {}) };
}

/** A map's spawn cells as points [[x, y, z]], seats in reading order: what config/world.json → spawns holds. */
export function spawnsOf(map) { const M = readMap(map); return M.spawns.map(s => { const p = M.feet(s.c, s.r); return [p.x, p.y, p.z]; }); }

/** A flat game's prop: a picture. → the record create keeps (gf-three.json → props) */
export function propFor(p, { style = 'pixel', assets = [], repoFile = f => f } = {}) {
  const to = `assets/sprites/${p.name}.png`, art = propArt(p.name, style);
  assets.push({ to, from: repoFile(art), license: ART_LICENSE });
  return { file: to, from: `standin:flat/${style}/${art.split('/').pop()}`, license: ART_LICENSE };
}
/** The pixel style's villagers (runtimes/three/tools/pixel/folk.mjs), by the words that pick one for a role. The
 *  player's own body is folk-player, whose light grey shirt takes each seat's colour. */
export const FOLK = [
  ['folk-farmer', /farm|crop|field|harvest|grow/], ['folk-baker', /bak|bread|cook|chef|cafe/], ['folk-smith', /smith|forge|anvil|metal/],
  ['folk-elder', /elder|old|grand|mayor|wise|sage/], ['folk-fisher', /fish|sail|boat|sea|dock/], ['folk-gardener', /garden|flower|plant|florist/],
  ['folk-scholar', /schol|teach|book|librar|clerk|study/], ['folk-rocker', /rock|music|band|punk|guitar/], ['folk-ranger', /ranger|hunt|forest|guard|scout/],
  ['folk-courier', /courier|mail|post|deliver|runner/], ['folk-tailor', /tailor|sew|cloth|shop|merchant|keeper/], ['folk-miner', /mine|dig|cave|ore/],
];
/** The stand-in sheet of a role: the player's tintable villager, a villager the role's words name, else one picked
 *  by the role's name (the same every time), so the people of a game look like different people. */
export function folkFor(c) {
  if (c.role === 'player') return 'folk-player';
  const words = `${c.role} ${c.describe ?? ''}`.toLowerCase(), hit = FOLK.find(([, re]) => re.test(words));
  if (hit) return hit[0];
  let h = 0; for (const ch of c.role) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLK[h % FOLK.length][0];
}
/** A flat game's body: a picture sheet. → { role (config/characters.json → roles[role]), record, note } */
export function bodyFor(c, { plane = 'top', style = 'pixel', assets = [], repoFile = f => f } = {}) {
  const to = `assets/sprites/body-${c.role}.png`, sheet = plane === 'side' ? 'side' : 'top';
  // pixel: a villager (3 rows from above, 1 row side-on); drawn: the style's own stand-in sheet
  const folk = style === 'pixel' ? folkFor(c) : null, from = folk ? `${ART}/pixel/${folk}-${sheet}.png` : bodyArt(plane, style);
  assets.push({ to, from: repoFile(from), license: ART_LICENSE });
  return {
    role: { body: to, height: 1.7, ...(c.describe ? { describe: c.describe } : {}), license: ART_LICENSE },
    record: { file: to, from: folk ? `standin:flat/pixel/${folk}-${sheet}` : `standin:flat/${style}/body-${plane}`, license: ART_LICENSE },
    note: `character "${c.role}": a picture body (${STANDARD}: ${FRAMES.length} frames ${FRAMES.join(', ')}; ${style}${folk ? `, the villager ${folk}` : ''}), a stand-in until one is drawn or made`,
  };
}
/** What a flat game adds to or changes in config/game.json. */
export function gameFor(spec, game) {
  const side = planeOfSpec(spec) === 'side';
  return {
    plane: planeOfSpec(spec),
    // side-on the jump is the flat part's (two cells with room to spare); from above nobody jumps
    controller: { ...game.controller, ...(side ? { jump: SIDE.jump } : {}) },
    controls: side ? { jump: 'jump', ...(game.controls ?? {}) } : Object.fromEntries(Object.entries(game.controls ?? {}).filter(([k]) => k !== 'jump')),
  };
}

const L = 'config/look.json', W = 'config/world.json', C = 'config/characters.json';
const PICTURE = { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152 };
const styleLine = style => (style === 'drawn' ? 'drawn 2D game art, clean shapes, soft shading, transparent background' : 'pixel art, hard pixels, a dark 1 pixel outline, transparent background');

/** look: every number and colour in config/look.json → values (the stand-in look's walk does exactly this). */
export const lookSlots = cfg => valueSlots(cfg).map(s => (s.id === 'look.view' ? { ...s, label: 'View (metres across the short side)', tier: 'main', rank: 60, constraints: { min: 6, max: 40, unit: 'm' } }
  : s.id === 'look.portrait' ? { ...s, label: 'View on a phone held upright (metres across)', constraints: { min: 6, max: 30, unit: 'm' } } : s.id === 'look.background' ? { ...s, label: 'Background', tier: 'main', rank: 70 } : s));

/** world: the tile map (one value: the file a painter edits), a picture per tile kind, and a picture per prop. */
export function worldSlots(cfg) {
  const w = cfg.world ?? {}, style = w.style ?? 'pixel', S = STYLES[style] ?? STYLES.pixel, out = [];
  out.push({ id: 'world.map', group: 'world', label: 'Tile map', type: 'json', source: { file: W, pointer: '/map' }, tier: 'main', facet: 'gameplay', rank: 92,
    constraints: { format: FORMAT, editor: 'tilemap' },
    description: `The whole level as a grid (${FORMAT}): rows of characters, one a cell, read through the legend; kinds say what is solid. Row 1 is the ${w.plane === 'side' ? 'top' : 'far side'}. Each kind's picture is the slot world.tiles.<kind>.` });
  for (const [kind, file] of Object.entries(w.tiles ?? {})) {
    const k = w.map?.kinds?.[kind] ?? {};
    if (k.piece) {
      out.push({ id: `world.tiles.${kind}`, group: 'world', label: humanize(kind), type: 'image', source: { file }, constraints: { ...PICTURE, picture: { standard: STANDARD, style, piece: k.piece } }, tier: 'main', facet: 'look', rank: 87, license: ART_LICENSE,
        description: `A set piece seen from above and in front, standing on its footprint of ${k.piece[0]} x ${k.piece[1]} cells (${k.piece[0] * S.tile} px across is its width; any height up to ${S.props[1]} px). ${k.solid ? 'Solid.' : 'Drawn only.'}`,
        generate: { prompt: `a ${kind} seen from above and in front`, style: `${styleLine(style)}, ${k.piece[0] * S.tile} px wide` } });
      continue;
    }
    out.push({ id: `world.tiles.${kind}`, group: 'world', label: `${humanize(kind)} tile`, type: 'image', source: { file }, constraints: { ...PICTURE, tile: { standard: STANDARD, style, size: S.tile, solid: k.solid ?? false } }, tier: 'main', facet: 'look', rank: 88, license: ART_LICENSE,
      description: `One square tile, ${S.tile} x ${S.tile} px (1 m), or two side by side: cap, fill. ${k.solid === 'top' ? 'A ledge: landed on from above, jumped through from below.' : k.solid ? 'Solid.' : 'Drawn only: bodies walk over it.'}`,
      generate: { prompt: `a seamless ${kind} tile`, style: `${styleLine(style)}, ${S.tile}x${S.tile}, tiles on every side` } });
  }
  for (const [kind, file] of Object.entries(w.edges ?? {})) {
    const mode = w.map?.kinds?.[kind]?.edges ?? 'blend';
    out.push({ id: `world.edges.${kind}`, group: 'world', label: `${humanize(kind)} edges`, type: 'image', source: { file }, constraints: { ...PICTURE, edges: { standard: STANDARD, style, size: S.tile * 4, mode } }, tier: 'advanced', facet: 'look', rank: 60, license: ART_LICENSE,
      description: mode === 'blend' ? `How ${kind} meets what is around it: 16 pictures in a 4 x 4 grid (${S.tile * 4} px), one for each mix of the four cells round a corner (top left 1, top right 2, bottom left 4, bottom right 8).` : `How ${kind} joins its own kind: 16 pictures in a 4 x 4 grid (${S.tile * 4} px), one for each mix of its neighbours (north 1, east 2, south 4, west 8).`,
      generate: { prompt: `${kind} edges, a 4x4 autotile set`, style: styleLine(style) } });
  }
  for (const [kind, file] of Object.entries(w.dress ?? {})) {
    out.push({ id: `world.dress.${kind}`, group: 'world', label: `Things on the ${kind}`, type: 'image', source: { file }, constraints: { ...PICTURE, dress: { standard: STANDARD, style, size: S.tile } }, tier: 'advanced', facet: 'look', rank: 58, license: ART_LICENSE,
      description: `Small things scattered on ${kind} (a share of its cells, the map's "dress"): square pictures of ${S.tile} px side by side, up to 16.`,
      generate: { prompt: `small things lying on ${kind}`, style: `${styleLine(style)}, a strip of ${S.tile}x${S.tile} pictures` } });
  }
  out.push({ id: 'world.zones', group: 'world', label: 'Zones', type: 'json', source: { file: W, pointer: '/zones' }, tier: 'advanced', facet: 'gameplay', rank: 18 });
  for (const p of cfg.game?.props ?? []) {
    const rec = cfg.propFiles?.[p.name] ?? {};
    out.push({ id: `prop.${p.name}`, group: 'props', label: humanize(p.name), type: 'image', source: { file: rec.file ?? `assets/sprites/${p.name}.png` }, constraints: { ...PICTURE, picture: { standard: STANDARD, style } }, tier: 'main', facet: 'look', rank: 94,
      description: p.describe ? `${p.describe}${p.role ? ` (${p.role})` : ''}` : undefined, generate: { prompt: p.describe ?? p.name, style: styleLine(style) }, ...(rec.license ? { license: rec.license } : {}) });
  }
  return out;
}

/** character: a body PICTURE per role (a gf-flat-1 sheet), its height, the seat colours. */
export function characterSlots(cfg) {
  const c = cfg.characters ?? {}, style = cfg.world?.style ?? 'pixel', S = STYLES[style] ?? STYLES.pixel, out = [];
  for (const [role, r] of Object.entries(c.roles ?? {})) {
    // the player role's body and colour are player looks (CONTRACT §6e): each player's loadout may replace them
    const look = role === 'player' ? { scope: 'player' } : {};
    out.push({ id: `character.body.${role}`, group: 'characters', label: role === 'player' ? 'Player character' : `${humanize(role)} character`, type: 'image',
      source: { file: r.body, pathRef: { file: C, pointer: `/roles/${role}/body` } }, constraints: { ...PICTURE, sheet: { standard: STANDARD, style, frames: FRAMES, rows: [1, 3], cell: S.cell } },
      tier: 'main', facet: 'look', rank: 98, ...look,
      description: `${r.describe ? `${r.describe}. ` : ''}A sheet of square cells (${S.cell} px), ${FRAMES.length} across: ${FRAMES.join(', ')}; 1 row, or 3 (down, side, up) for a top-down game. Feet at the bottom middle of a cell. Light grey parts (a shirt) take the player's colour; skin, hair and coloured clothes keep theirs.`,
      generate: { prompt: r.describe ?? 'a friendly game character', style: `${styleLine(style)}, a sprite sheet of ${FRAMES.length} frames in a row` }, ...(r.license ? { license: r.license } : {}) });
    if (typeof r.height === 'number') out.push({ id: `character.height.${role}`, group: 'characters', label: `${role === 'player' ? 'Player' : humanize(role)} height`, type: 'number', source: { file: C, pointer: `/roles/${role}/height` }, constraints: { min: 0.6, max: 3, unit: 'm' }, tier: 'advanced', facet: 'look', rank: 30 });
  }
  if (Object.keys(c.roles ?? {}).length && !Array.isArray(cfg.look?.palette?.players)) out.push({ id: 'character.tint.player', group: 'characters', label: 'Player colours (one per seat)', type: 'colors', source: { file: C, pointer: '/palette' }, constraints: { min: 1, max: 8 }, tier: 'main', facet: 'look', rank: 86, scope: 'player', description: 'Each player\'s colour: the light greys of their body (a shirt), their ring and nameplate' });
  return out;
}

export { SIZES };
