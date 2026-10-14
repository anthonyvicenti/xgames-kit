#!/usr/bin/env node
// create for runtime godot: a spec (v2: runtime "godot", profile "2d") → a game folder that boots, plays alone and
// with friends, and passes the runtime's measures.
//
//   node runtimes/godot/tools/create.mjs <spec.json> <new-game-dir> [--no-export] [--json]
//
// What it writes (the parts marked shared are the shared create's once the layout lands; see INTEGRATION.md):
//   spec.json, config/{game,look,world,characters}.json, assets.json (every visible thing a slot),
//   multiplayer.json (live), rules.js (the game's, a stub), assets/ (the kit's stand-in pictures, gf-flat-1)  shared
//   gf/three/ (the shared kit's three.js-free parts boot.js reaches), gf/mp/, gf/gf-assets.js, audio/           shared
//   gf/godot/ (this runtime's page side), index.html, main.js                                                   runtime
//   project/ (the Godot project: project.godot, main.tscn, main.gd, addons/gf/), build/ (its export)             runtime
//   xgames.json (what made the game: versions and the hash of every kit file it carries)
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportGame } from './export.mjs';
import { walkReach, worldFor } from '../kit/world.js';
import { importShared, isMain, KIT_VERSIONS, PPM, repoFileOf, RUNTIME, SHARED, TOOLCHAIN, VERSION } from './lib.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const json = v => JSON.stringify(v, null, 2) + '\n';
const slug = t => String(t).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 48) || 'game';

/** The side-on stage a spec without a map gets: ground, posts at the ends, ledges a jump apart, four spawns. */
export const DEFAULT_SIDE_MAP = {
  rows: [
    'B..........................B',
    'B..........................B',
    'B..........======..........B',
    'B..........................B',
    'B...====............====...B',
    'B..........................B',
    'B.........========.........B',
    'B..........................B',
    'B..====..............====..B',
    'B.1....1............1....1.B',
    '############################',
  ],
};
/**
 * The starters create writes, by camera: a profile, its plane, the world template, the Godot project under templates/
 * and the stand-in body sheet. Side-on runs and jumps on a stage; seen from above walks eight ways on a field.
 */
export const STARTERS = {
  side: { profile: '2d', camera: 'side', plane: 'side', world: 'stage', template: '2d-side', body: 'body-side.png', background: { pixel: '#1d2236', drawn: '#cdeaf5' } },
  top: { profile: '2d', camera: 'top', plane: 'top', world: 'field', template: '2d-top', body: 'body-top.png', background: { pixel: '#2b3a2a', drawn: '#7fae6a' } },
  // 3D: an arena on the same map seen from above, gf-humanoid-1 bodies from the library, a three-quarter follow camera
  follow: { profile: '3d', camera: 'follow', plane: 'top', world: 'arena', template: '3d-follow', body: 'gf-beans/bean-classic', background: { pixel: '#9fd3f0', drawn: '#9fd3f0' } },
};
/** The starter a spec gets: its camera's (a 3D spec with none: follow; else side-on). */
export const starterOf = spec => STARTERS[spec?.camera ?? (spec?.profile === '3d' ? 'follow' : 'side')] ?? null;
/** Stand-in pictures (gf-flat-1, CC0, the kit's own) for tile kinds and props, by name. */
const TILE_STANDIN = { ground: 'tile-ground', brick: 'tile-brick', ledge: 'tile-ledge', wall: 'tile-wall', grass: 'tile-grass', path: 'tile-path', water: 'tile-water' };
const PROP_STANDIN = ['coin', 'gem', 'star', 'heart', 'key', 'crate'];

/**
 * The asset library (library/packs through builder/art/views.mjs): every file slot a new game gets is filled from it,
 * as on every runtime. A bare name resolves in the game's style's stand-in pack, then runtimes/godot/art.json's packs;
 * a "<pack>/<id>" ref (a spec's fill.asset) is exact. → { pick(name), bytes(asset), file(asset), licence(asset) }
 */
async function artLibrary(style) {
  const V = await import('../../../builder/art/views.mjs');
  const L = V.artLibrary();
  const packs = [`flat-standins-${style}`, ...JSON.parse(await readFile(join(RUNTIME, 'art.json'), 'utf8')).packs];
  return {
    pick: name => (name ? V.findAsset(String(name), packs, { L }) : null),
    file: a => V.assetFile(a, { L }),
    bytes: async a => readFile(await V.assetFile(a, { L })),
    licence: a => { const l = V.licenceOf(a, L); return { spdx: l.spdx, author: l.author ?? null, url: l.url || null, ref: `${a.pack}/${a.id}`, ...(l.credit ? { credit: l.credit } : {}) }; },
  };
}
/** Godot's own licence and third-party notices at the pinned tag, copied beside the engine into every game. */
export const GODOT_NOTICES = ['GODOT-LICENSE.txt', 'GODOT-COPYRIGHT.txt'];
const KIT_SOUNDS = {
  'ui-click': { label: 'Menu click', src: { preset: 'click' }, bus: 'ui' },
  'round-countdown': { label: 'Countdown beep', src: { preset: 'countdown' }, bus: 'ui' },
  'round-go': { label: 'Round starts', src: { preset: 'confirm' }, bus: 'ui' },
  'round-win': { label: 'You won the round', src: { preset: 'win' } },
  'round-end': { label: 'The round is over', src: { preset: 'lose' } },
};

/** Problems with a spec for this runtime, in words (empty: it can be created). */
// create refuses only what cannot boot (runtimes/CONTRACT.md §2.3): a profile, camera rig or world with no starter
// here, a multiplayer mode the boot does not run. A loop this runtime has not proven is built on its closest one (a
// build item), never refused.
export function checkSpec(spec) {
  const p = [];
  if (spec?.specVersion !== 2) p.push(`specVersion is ${JSON.stringify(spec?.specVersion)}: create reads spec v2 only`);
  if (spec?.runtime !== 'godot') p.push(`runtime is "${spec?.runtime}", not "godot"`);
  const st = starterOf(spec);
  if (!st) p.push(`camera "${spec?.camera}": runtime godot's starters are ${Object.keys(STARTERS).map(c => `"${c}"`).join(', ')}`);
  else {
    if (spec?.profile !== st.profile) p.push(`profile "${spec?.profile}": camera "${st.camera}" is a profile "${st.profile}" starter on runtime godot`);
    if ((spec?.world?.template ?? st.world) !== st.world) p.push(`world "${spec.world.template}": camera "${st.camera}"'s world is the ${st.world} (a gf-tilemap-1 map, plane ${st.plane})`);
  }
  if (!['live', 'solo'].includes(spec?.multiplayer?.mode ?? 'live')) p.push(`multiplayer mode "${spec.multiplayer.mode}": the godot boot runs live rounds and solo games (room is not wired)`);
  if (!spec?.title || typeof spec.title !== 'string') p.push('title: a name for the game');
  return p;
}

/** Notes create says about a spec it accepts (never a refusal). */
function notesFor(spec, style, kindStyle) {
  const n = [];
  if (!['round', 'endless'].includes(spec.loop ?? 'round')) n.push(`loop "${spec.loop}" has no implementation on godot yet: the session runs the round loop under it, and the game builds the rest (a build item on its closest loop)`);
  if (starterOf(spec)?.profile === '2d' && kindStyle !== style) n.push(`kind "${spec.kind}": its look names no 2D style (pixel or drawn), so the ${style} style was used`);
  if (spec.multiplayer?.watch) n.push('multiplayer.watch: Go live is not on godot yet');
  if (spec.multiplayer?.voice) n.push('multiplayer.voice: voice chat is not wired on godot yet');
  return n;
}

/** The 2D art style of a kind's look (its `style`, kinds/<id>.json), never read from the kind's name: pixel when it names none. */
export const flatStyleOf = look => (Object.hasOwn(PPM, look?.style ?? '') ? look.style : 'pixel');

/** The kind's preset (kinds/<id>.json), when the kinds folder is there: its look values and HUD colours. */
async function kindOf(id) {
  const f = join(SHARED.kinds, `${id}.json`);
  return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : null;
}


/**
 * The map: the spec's rows and legend over the plane's defaults (gf/three/flat/tilemap.js KINDS, LEGENDS), read by the
 * kit's own gf-tilemap-1 reader. A spec with no map gets the side-on default stage, or a generated field seen from above
 * (the same generator three's flat profile uses, seeded by the title, so one spec always makes one map).
 */
export async function mapOf(spec) {
  const { readMap, reachOf, jumpReach, generateMap, KINDS, LEGENDS } = await importShared('gf/three/flat/tilemap.js');
  const plane = starterOf(spec)?.plane ?? 'side';
  const src = spec.world?.map ?? (plane === 'side' ? DEFAULT_SIDE_MAP : generateMap({ plane, size: spec.world?.size ?? 'small', seats: Math.max(2, spec.players?.max ?? 4), rng: seeded(spec.title ?? 'game') }));
  const controller = {};   // the starter's speed and jump: the controller.* slots' defaults (5.2, 10.5)
  // a 3D arena with no map of its own: the seats start together in the middle (the follow camera shows about ten
  // metres around a player, so friends spawned in the field's corners never saw each other; verify run 2, 2026-10-13)
  if (starterOf(spec)?.profile === '3d' && !spec.world?.map) src.rows = gatherSpawns(src.rows, src.legend, KINDS.top, Math.max(2, spec.players?.max ?? 4));
  const map = { format: 'gf-tilemap-1', plane, tile: src.tile ?? 1, ...(plane === 'top' ? { base: src.base ?? 'grass' } : {}), kinds: { ...KINDS[plane], ...(src.kinds ?? {}) }, legend: { ...LEGENDS[plane], ...(src.legend ?? {}) }, rows: src.rows };
  // only the kinds the rows use (a stand-in picture for each)
  const used = new Set();
  for (const r of map.rows ?? []) for (const ch of r) { const v = map.legend[ch]; if (typeof v === 'string' && map.kinds[v]) used.add(v); }
  if (map.base) used.add(map.base);
  map.kinds = Object.fromEntries(Object.entries(map.kinds).filter(([k]) => used.has(k)));
  map.legend = Object.fromEntries(Object.entries(map.legend).filter(([, v]) => v === null || v === 'spawn' || String(v).startsWith('mark:') || used.has(v)));
  const M = readMap(map);
  // side-on: every mark and ledge within a jump of a spawn, by the same model the starter's physics follow
  // (templates/2d-side/main.gd: gravity 20, falling 1.7 times heavier, the controller's jump and speed); seen from
  // above: every spawn and mark can be walked to from the first spawn
  const reach = !M.ok ? null : plane === 'top' ? walkReach(M) : reachOf(M, jumpReach({ gravity: 20, fallScale: 1.7, jump: controller.jump ?? 10.5, speed: controller.speed ?? 5.2 }));
  if (reach?.problems.length) { M.ok = false; M.problems.push(...reach.problems); }
  return { map, M, reach };
}

/** The map's spawns moved to the middle, in a ring a few metres across, each on a cell a body can stand on. */
export function gatherSpawns(rows, legend, kinds, n) {
  const g = rows.map(r => [...r]), spawnCh = Object.keys(legend).find(k => legend[k] === 'spawn') ?? '1';
  const free = ch => { const v = legend[ch]; return v === null || v === undefined ? ch === '.' : typeof v === 'string' && kinds[v] && !kinds[v].solid; };
  for (const row of g) for (let c = 0; c < row.length; c++) if (row[c] === spawnCh) row[c] = '.';
  const mr = g.length >> 1, mc = g[0].length >> 1;
  const ring = [[-3, -2], [2, -2], [-3, 1], [2, 1], [-1, -3], [0, 2], [-4, 0], [3, 0]];
  let placed = 0;
  for (const [dc, dr] of ring) { if (placed >= n) break; const r = mr + dr, c = mc + dc; if (g[r]?.[c] !== undefined && free(g[r][c])) { g[r][c] = spawnCh; placed++; } }
  return g.map(r => r.join(''));
}

/** A small seeded random (mulberry32 over the text's fnv-1a), for maps that must come out the same for one spec. */
function seeded(text) {
  let a = 0x811c9dc5;
  for (const ch of String(text)) { a ^= ch.codePointAt(0); a = Math.imul(a, 0x01000193); }
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- vendoring: the files a game carries, from their sources ----

const SPEC_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g;
/** Where a game path's file comes from. */
export function sourceOf(gamePath) {
  // gf/godot/ is this runtime's kit/; gf/three/, gf/mp/, gf/gf-assets.js and audio/ are the shared layers (GAME_TREE)
  return repoFileOf(gamePath);
}

/** The import closure of the runtime's page side, as game paths (generated files, like gf/godot/kit.js, left out). */
export async function closure(entries = ['gf/godot/boot.js'], generated = new Set(['gf/godot/kit.js'])) {
  const seen = new Set(), queue = [...entries];
  while (queue.length) {
    const g = queue.shift();
    if (seen.has(g) || generated.has(g)) continue;
    seen.add(g);
    if (!/\.m?js$/.test(g)) continue;
    const src = sourceOf(g);
    if (!src || !existsSync(src)) throw new Error(`${g}: no source (${src ?? 'outside the kit'})`);
    const text = await readFile(src, 'utf8');
    for (const m of text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').matchAll(SPEC_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec?.startsWith('.')) continue;
      const to = posix.normalize(posix.join(posix.dirname(g), spec));
      if (!seen.has(to)) queue.push(to);
    }
  }
  return [...seen].sort();
}

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out); else out.push(relative(base, p).split('\\').join('/'));
  }
  return out;
}

// ---- the files ----

function slotsFor({ spec, style, map, props, controls, st, body3d, lic }) {
  const cell = style === 'pixel' ? 32 : 256, tile = style === 'pixel' ? 16 : 128;
  const S = [];
  const text = (id, label, pointer) => S.push({ id, group: 'text', label, type: 'text', source: { file: 'config/game.json', pointer }, tier: 'main', facet: 'words' });
  text('ui.title', 'Title', '/text/title'); text('ui.hook', 'Tagline', '/text/hook'); text('ui.goal', 'Goal', '/text/goal');
  text('ui.play', 'Play button', '/text/play'); text('ui.again', 'Play again button', '/text/again'); text('ui.wins', 'Winner line', '/text/wins'); text('ui.draw', 'Nobody scored line', '/text/draw');
  for (const [k, v] of Object.entries(controls ?? {})) if (v !== '') text(`ui.controls.${k}`, `Control: ${k}`, `/controls/${k}`);
  if (st.profile === '3d') S.push({ id: 'character.body.player', group: 'characters', label: 'Player character', type: 'model', source: { file: 'assets/models/body-player.glb', pathRef: { file: 'config/characters.json', pointer: '/roles/player/body' } },
    constraints: { rigged: true, rig: 'gf-humanoid-1', layout: '3d', maxBytes: 8388608, animations: 'the kit\'s shared clips (assets/clips/gf-humanoid-1.glb)' },
    tier: 'main', facet: 'look', scope: 'player', description: `${spec.characters?.[0]?.describe ?? 'the player'}. A rigged GLB on gf-humanoid-1 (RIG.md): metres, +Y up, facing +Z, feet on the ground; the kit's clips drive it.`, license: body3d.license });
  else S.push({ id: 'character.body.player', group: 'characters', label: 'Player character', type: 'image', source: { file: 'assets/sprites/body-player.png', pathRef: { file: 'config/characters.json', pointer: '/roles/player/body' } },
    constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, sheet: { standard: 'gf-flat-1', style, frames: ['idle', 'walk1', 'walk2', 'air', 'act', 'down'], rows: [1, 3], cell } },
    tier: 'main', facet: 'look', scope: 'player', description: `${spec.characters?.[0]?.describe ?? 'the player'}. A sheet of square cells (${cell} px), 6 across: idle, walk1, walk2, air, act, down. Feet at the bottom middle of a cell. Light parts take the player's colour.`, license: lic['character.body.player'] });
  S.push({ id: 'character.height.player', group: 'characters', label: 'Player height', type: 'number', source: { file: 'config/characters.json', pointer: '/roles/player/height' }, constraints: { min: 0.8, max: 3, unit: 'm' }, tier: 'more', facet: 'look' });
  S.push({ id: 'character.tint.player', group: 'characters', label: 'Seat colours', type: 'colors', source: { file: 'config/characters.json', pointer: '/palette' }, tier: 'more', facet: 'look' });
  for (const p of props) S.push({ id: p.id, group: 'props', label: p.label, type: 'image', source: { file: p.file }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, picture: { standard: 'gf-flat-1', style } }, tier: 'main', facet: 'look', description: p.describe, license: lic[p.id] });
  S.push({ id: 'world.map', group: 'world', label: 'Tile map', type: 'json', source: { file: 'config/world.json', pointer: '/map' }, tier: 'main', facet: 'gameplay', constraints: { format: 'gf-tilemap-1', editor: 'tilemap' }, description: 'The whole level as a grid (gf-tilemap-1): rows of characters, one a cell, read through the legend; kinds say what is solid. Row 1 is the top.' });
  const label = kind => `${kind[0].toUpperCase()}${kind.slice(1).replace(/[-_]/g, ' ')}`;
  for (const [kind, k] of Object.entries(map.kinds)) {
    if (k.piece) S.push({ id: `world.tiles.${kind}`, group: 'world', label: label(kind), type: 'image', source: { file: `assets/tiles/${kind}.png` }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, picture: { standard: 'gf-flat-1', style, piece: k.piece } }, tier: 'main', facet: 'look', license: lic[`world.tiles.${kind}`], description: `A set piece seen from above and in front, standing on its footprint of ${k.piece[0]} x ${k.piece[1]} cells (${k.piece[0] * tile} px across is its width).` });
    else S.push({ id: `world.tiles.${kind}`, group: 'world', label: `${label(kind)} tile`, type: 'image', source: { file: `assets/tiles/${kind}.png` }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, tile: { standard: 'gf-flat-1', style, size: tile, solid: k.solid } }, tier: 'main', facet: 'look', license: lic[`world.tiles.${kind}`], description: `One square tile, ${tile} x ${tile} px (1 m), or two side by side: cap, fill.` });
    if (lic[`world.edges.${kind}`]) S.push({ id: `world.edges.${kind}`, group: 'world', label: `${label(kind)} edges`, type: 'image', source: { file: `assets/tiles/${kind}-edges.png` }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, edges: { standard: 'gf-flat-1', style, size: tile * 4, mode: k.edges } }, tier: 'advanced', facet: 'look', license: lic[`world.edges.${kind}`], description: k.edges === 'connect' ? `How ${kind} joins its own kind: 16 pictures in a 4 x 4 grid (${tile * 4} px), one for each mix of its neighbours (north 1, east 2, south 4, west 8).` : `How ${kind} meets what is around it: 16 pictures in a 4 x 4 grid (${tile * 4} px), one for each mix of the four cells round a corner (top left 1, top right 2, bottom left 4, bottom right 8).` });
    if (lic[`world.dress.${kind}`]) S.push({ id: `world.dress.${kind}`, group: 'world', label: `Things on the ${kind}`, type: 'image', source: { file: `assets/tiles/${kind}-dress.png` }, constraints: { colorSpace: 'srgb', layout: '2d', maxBytes: 2097152, dress: { standard: 'gf-flat-1', style, size: tile } }, tier: 'advanced', facet: 'look', license: lic[`world.dress.${kind}`], description: `Small things scattered on ${kind} (a share of its cells, the map's "dress"): square pictures of ${tile} px side by side.` });
  }
  const num = (id, group, label, file, pointer, c, type = 'number') => S.push({ id, group, label, type, source: { file, pointer }, constraints: c, tier: 'main', facet: 'gameplay' });
  S.push({ id: 'look.background', group: 'look', label: 'Background', type: 'color', source: { file: 'config/look.json', pointer: '/values/background' }, tier: 'main', facet: 'look' });
  if (st.profile === '3d') num('look.view', 'look', 'Camera distance', 'config/look.json', '/values/view', { min: 5, max: 30, unit: 'm' });
  else num('look.view', 'look', 'View height', 'config/look.json', '/values/view', { min: 6, max: 40, unit: 'm' });
  num('round.seconds', 'rules', 'Round length', 'config/game.json', '/round/seconds', { min: 20, max: 900, unit: 's' }, 'integer');
  num('round.countdown', 'rules', 'Countdown', 'config/game.json', '/round/countdown', { min: 0, max: 10, unit: 's' }, 'integer');
  num('players.max', 'rules', 'Most players', 'config/game.json', '/players/max', { min: 1, max: 8 }, 'integer');
  num('controller.speed', 'controls', 'Running speed', 'config/game.json', '/controller/speed', { min: 1, max: 14, unit: 'm/s' });
  num('controller.jump', 'controls', 'Jump speed', 'config/game.json', '/controller/jump', { min: 3, max: 20, unit: 'm/s' });
  for (const [k, v] of Object.entries(spec.rules?.params ?? {})) {
    const type = typeof v === 'boolean' ? 'boolean' : Number.isInteger(v) ? 'integer' : typeof v === 'number' ? 'number' : 'text';
    S.push({ id: `rules.${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`, group: 'rules', label: k, type, source: { file: 'config/game.json', pointer: `/rules/params/${k}` }, tier: 'main', facet: 'gameplay' });
  }
  return S;
}

export async function create(specPath, outDir, { exportNow = true, allowEvidence = false, log = () => {} } = {}) {
  const specBytes = typeof specPath === 'string' ? await readFile(specPath) : Buffer.from(JSON.stringify(specPath, null, 2) + '\n');
  const spec = JSON.parse(specBytes);
  const problems = checkSpec(spec);
  if (problems.length) return { ok: false, problems };
  const dir = resolve(outDir);
  // a new game's folder is empty (its evidence/ and .git may stay when the game is made again: gamesfun create --force)
  if (existsSync(dir) && (await readdir(dir)).some(e => !(allowEvidence && ['evidence', '.git'].includes(e)))) return { ok: false, problems: [`${dir} is not empty (create writes a new game)`] };
  const { map, M } = await mapOf(spec);
  if (!M.ok) return { ok: false, problems: M.problems.map(p => `world.map: ${p}`) };
  const st = starterOf(spec);
  const kind = await kindOf(spec.kind);
  const kl = kind?.look?.godot ?? kind?.look?.three ?? kind?.look?.flat ?? null;
  const style = flatStyleOf(kl);
  const notes = notesFor(spec, style, kl?.style);
  // a kind's look values are for its own plane: a top-down field's grass green is no side-on sky
  // (a 3D game takes a 3D look's values; a 2D one a look drawn for its own plane)
  const fits = kl && (st.profile === '3d' ? /3d$/.test(kl.profile ?? '3d') : (kl.plane ?? 'side') === st.plane);
  const kv = fits ? kl.values ?? {} : {};
  if (kl && !fits) notes.push(`kind "${spec.kind}": its look is for ${st.profile === '3d' ? `a ${kl.profile} game` : `a ${kl.plane ?? 'side'} view`}, so the ${st.world} keeps the runtime's own background`);
  const name = slug(spec.title);
  const w = async (rel, body) => { const p = join(dir, rel); await mkdir(dirname(p), { recursive: true }); await writeFile(p, body); };
  const put = async (rel, from) => { const p = join(dir, rel); await mkdir(dirname(p), { recursive: true }); await copyFile(from, p); };

  // ---- the game's own files (shared create's part) ----
  // the game's own pictures (spec.slots: game.*), each a stand-in picked by its name until the library fills it
  const props = (spec.slots ?? []).filter(s => ['prop', 'picture', 'sprite-sheet', 'card', 'effect'].includes(s.category)).map(s => {
    const name = s.id.slice(5), word = PROP_STANDIN.find(w => name.includes(w)) ?? 'star';
    const asked = s.fill?.from === 'library' ? s.fill.asset : ['generate', 'reference'].includes(s.fill?.from) ? s.fill.standIn : null;
    return { id: s.id, name, label: name[0].toUpperCase() + name.slice(1).replace(/[._-]/g, ' '), describe: s.describe, file: `assets/sprites/${name.replace(/\./g, '-')}.png`, standin: asked ?? word };
  });
  const sounds = { version: 1, sounds: { ...KIT_SOUNDS } };
  for (const s of spec.sounds ?? []) sounds.sounds[s.id] = { label: s.describe ?? s.id, src: { preset: s.preset ?? kind?.audio?.sounds?.[s.id]?.preset ?? 'coin' } };
  const text = { title: spec.title, hook: spec.hook ?? '', goal: spec.round?.winBy ?? 'most points when the time runs out', play: 'Play', again: 'Play again', waiting: 'Waiting for everyone…', you: 'You', wins: '{name} wins!', draw: 'Round over: nobody scored', go: 'Go!' };
  const game = {
    title: spec.title, hook: spec.hook ?? '', runtime: 'godot', profile: st.profile, loop: spec.loop ?? 'round', kind: spec.kind ?? style, text,
    players: { min: spec.players?.min ?? 1, max: spec.players?.max ?? 4, bots: spec.players?.bots !== false },
    round: { seconds: spec.round?.seconds ?? 60, countdown: 3, replay: spec.round?.replay ?? true, winBy: text.goal },
    camera: st.camera, plane: st.plane,
    controller: { speed: 5.2, jump: st.profile === '3d' ? 7.5 : 10.5 },
    // the starter's own words for the HUD: a follow camera aims with the mouse only when the game has a click action
    controls: { ...(spec.controls ?? (st.plane === 'side' ? { jump: 'jump (Down on a ledge drops through)' } : {})), ...(st.camera === 'follow' && !spec.controls?.primary && spec.controls?.aim === undefined ? { aim: '' } : {}) },
    rules: { summary: spec.rules?.summary ?? '', scoring: spec.rules?.scoring ?? '', params: spec.rules?.params ?? {} },
    fair: { on: false, downSeconds: 1.2 },
    ui: { panel: kind?.hud?.panel ?? '#1c2133d9', text: kind?.hud?.text ?? '#ffffff', crosshair: '#ffffff', accent: kind?.hud?.accent ?? '#ff7a59' },
  };
  const look = { kind: spec.kind ?? style, style, standard: 'gf-flat-1', flat: st.plane, values: { background: kv.background ?? st.background[style], view: kv.view ?? (st.profile === '3d' ? 11 : 12) } };
  const world = { template: st.world, plane: st.plane, style, map, tiles: Object.fromEntries(Object.keys(map.kinds).map(k => [k, `assets/tiles/${k}.png`])) };
  const characters = { roles: { player: { body: st.profile === '3d' ? 'assets/models/body-player.glb' : 'assets/sprites/body-player.png', height: 1.7, describe: spec.characters?.[0]?.describe ?? 'the player', license: null } }, palette: ['#4f7cff', '#ff5ea8', '#3ddc84', '#ffd166', '#b07cff', '#ff9a3d', '#3dd6d0', '#e6e6e6'], nameplate: { show: true } };
  await w('spec.json', specBytes);
  await w('config/game.json', json(game)); await w('config/look.json', json(look)); await w('config/world.json', json(world));
  // every file slot from the asset library (the stand-ins are its flat-standins-<style> packs)
  const A = await artLibrary(style), lic = {}, art = [];
  const fill = async (slot, file, ...names) => {
    const a = names.map(n => A.pick(n)).find(Boolean);
    if (!a) throw new Error(`${slot}: the asset library has none of ${names.join(', ')} (builder/art: art fetch)`);
    await w(file, await A.bytes(a));
    lic[slot] = A.licence(a); art.push({ slot, file, ...lic[slot] });
  };
  if (st.profile !== '3d') await fill('character.body.player', 'assets/sprites/body-player.png', st.body.replace(/\.png$/, ''));
  for (const p of props) await fill(p.id, p.file, p.standin, 'star');
  // seen from above, three's flat-2d names each kind's pictures (gf/three/flat/slots.js): a set piece's own picture, a
  // blend or connect kind's 4 x 4 edge set, a kind's dressing strip; the library has them (xk-pixel-town)
  const flat = await importShared('gf/three/flat/slots.js'), edges = {}, dress = {};
  for (const [kind, k] of Object.entries(map.kinds)) {
    const piece = k.piece ? flat.pieceFor(kind, k, style) : null;
    await fill(`world.tiles.${kind}`, `assets/tiles/${kind}.png`, ...(piece ? [piece, 'tree-oak'] : [`tile-${kind}`, TILE_STANDIN[kind], k.solid ? 'tile-wall' : 'tile-path', 'tile-brick']));
    if (st.plane !== 'top' || st.profile === '3d') continue;
    const e = k.edges ? flat.edgesFor(kind, k, style) : null;
    if (e && A.pick(`edges-${e}`)) { await fill(`world.edges.${kind}`, `assets/tiles/${kind}-edges.png`, `edges-${e}`); edges[kind] = `assets/tiles/${kind}-edges.png`; }
    const d = k.dress ? flat.dressFor(kind, k, style) : null;
    if (d && A.pick(`dress-${d}`)) { await fill(`world.dress.${kind}`, `assets/tiles/${kind}-dress.png`, `dress-${d}`); dress[kind] = `assets/tiles/${kind}-dress.png`; }
  }
  if (Object.keys(edges).length) world.edges = edges;
  if (Object.keys(dress).length) world.dress = dress;
  if (Object.keys(edges).length || Object.keys(dress).length) await w('config/world.json', json(world));
  const body3d = st.profile === '3d' ? await bodies3d(spec, w, A) : null;
  if (body3d) { lic['character.body.player'] = body3d.license; art.push({ slot: 'character.body.player', file: 'assets/models/body-player.glb', ...body3d.license }, { slot: null, file: 'assets/clips/gf-humanoid-1.glb', ...body3d.clipsLicense }); }
  characters.roles.player.license = lic['character.body.player'];
  await w('config/characters.json', json(characters));
  const slots = slotsFor({ spec, style, map, props, controls: game.controls, st, body3d, lic });
  await w('assets.json', json({ schema: 'gf-assets/1', game: name, title: spec.title, editing: 'live',
    groups: [{ id: 'text', label: 'Title & text' }, { id: 'characters', label: 'Characters' }, { id: 'props', label: 'Props' }, { id: 'world', label: 'World' }, { id: 'look', label: 'Look' }, { id: 'rules', label: 'Rules & scoring' }, { id: 'controls', label: 'Movement' }],
    slots, sounds,
    check: { steps: [{ waitFor: "window.__game && window.__game.ready && window.__game.phase === 'lobby'", timeout: 90000 }], play: { steps: [{ clickSelector: '#gf-play' }, { wait: 4500 }, { hold: 'KeyD', ms: 900 }, { key: 'Space' }, { wait: 800 }], avoidKeys: [] } },
    ignore: [{ path: 'gf/**', reason: 'kit copies (gf/three, gf/mp, gf/gf-assets.js, gf/godot), vendored by create, never edited' }, { path: 'audio/**', reason: `gf-audio ${KIT_VERSIONS.audio}` }, { path: 'build/**', reason: 'the Godot export (tools/export.mjs makes it from project/)' }, { path: 'project/**', reason: 'the Godot project: the game\'s code; its pictures are the slots above, read at run time' }, { path: 'spec.json', reason: 'the spec this game was made from' }] }));
  if (spec.multiplayer?.mode === 'solo') await w('multiplayer.json', json({ schemaVersion: 2, mode: 'solo', title: spec.title, reason: spec.multiplayer.why ?? 'played alone' }));
  else await w('multiplayer.json', json({ schemaVersion: 2, mode: 'live', title: spec.title, players: { min: 1, max: game.players.max },
    live: { entry: 'index.html', seedParam: null, team: false, metric: 'score', direction: 'higher', unit: 'pts', maxSeconds: game.round.seconds + 30,
      sees: 'Each player sees the others as their character, in their seat colour, with their name above.', shares: 'The round and its clock, the scores and ctx.shared, owned by the host\'s copy', hud: 'game' },
    check: { near: 2.5, seconds: 60 } }));
  if (!existsSync(join(dir, 'rules.js'))) await w('rules.js', rulesStub(spec));

  // ---- the shared kit's files, vendored ----
  const files = {};
  const vendor = async (g) => { const src = sourceOf(g); const b = await readFile(src); await w(g, b); files[g] = sha(b); };
  for (const g of await closure()) await vendor(g);
  for (const f of await walk(SHARED.mp)) await vendor(`gf/mp/${f}`);
  for (const f of await walk(SHARED.audio)) if (!files[`audio/${f}`]) await vendor(`audio/${f}`);
  if (existsSync(sourceOf('gf/three/LICENSE'))) await vendor('gf/three/LICENSE');
  const kitJs = `// Written by runtime godot's create: the versions of the kit parts this game carries and the hash of every file\n// (gate A, measure 2: kit copies unedited). Part of the kit copy: never edited.\nexport default ${JSON.stringify({ runtime: 'godot', version: VERSION, shared: KIT_VERSIONS, files }, null, 1)};\n`;
  await w('gf/godot/kit.js', kitJs);
  await w('gf/godot/LICENSES.md', godotLicenses());
  for (const f of GODOT_NOTICES) { const b = await readFile(join(RUNTIME, 'toolchain', f)); await w(`gf/godot/${f}`, b); files[`gf/godot/${f}`] = sha(b); }

  // ---- the page ----
  await w('main.js', "import { boot } from './gf/godot/boot.js';\nimport rules from './rules.js';\nboot({ rules });\n");
  await w('index.html', indexHtml(spec.title));

  // ---- the Godot project (the game's code: main.gd is the build agent's, addons/gf is the kit's) ----
  const T = join(RUNTIME, 'templates', st.template);
  await w('project/project.godot', (await readFile(join(T, 'project.godot'), 'utf8')).replace('$TITLE', spec.title.replace(/["\\]/g, '')));
  await put('project/main.tscn', join(T, 'main.tscn'));
  await put('project/main.gd', join(T, 'main.gd'));
  for (const f of await walk(join(RUNTIME, 'addon'))) { const b = await readFile(join(RUNTIME, 'addon', f)); await w(`project/addons/gf/${f}`, b); files[`project/addons/gf/${f}`] = sha(b); }
  const values = {};
  for (const s of slots) if (s.source.pointer !== undefined) values[s.id] = valueAt({ 'config/game.json': game, 'config/look.json': look, 'config/world.json': world, 'config/characters.json': characters }[s.source.file], s.source.pointer);
  await w('project/gf_alone.json', json({ profile: st.profile, style, ppm: PPM[style], config: { game, look, world, characters }, world: worldFor(M), values, slots: Object.fromEntries(slots.filter(s => s.source.pointer === undefined).map(s => [s.id, { type: s.type, file: s.source.file }])) }));
  await w('ATTRIBUTION.md', attribution(spec, art));
  await w('xgames.json', json({ art: art.map(a => ({ file: a.file, ref: a.ref, spdx: a.spdx })), schema: 'xgames-game/1', runtime: { id: 'godot', version: VERSION, godot: TOOLCHAIN.version, profile: st.profile, release: `runtimes/godot/releases/${VERSION}.json` }, loop: game.loop, kind: game.kind, game: name, spec: { file: 'spec.json', sha256: sha(specBytes) }, ledger: spec.ledger ?? null, build: spec.build ?? [], src: [], overrides: {}, shared: KIT_VERSIONS, kit: files, notes }));

  let exported = null;
  if (exportNow) {
    exported = await exportGame(dir, { log });
    if (!exported.ok) return { ok: false, dir, problems: exported.errors.map(e => `export: ${e}`), notes };
  }
  return { ok: true, dir, game: name, style, slots: slots.length, slotList: slots, files: Object.keys(files).length, kitFiles: files, exported, notes };
}

const valueAt = (doc, pointer) => pointer.slice(1).split('/').reduce((v, k) => (v == null ? v : v[k.replace(/~1/g, '/').replace(/~0/g, '~')]), doc);

function rulesStub(spec) {
  return `// rules.js: THE GAME AGENT'S FILE. ${spec.title} on runtime godot. The kit runs the round, the clock, the friends
// and the results; the Godot project (project/main.gd) runs the stage and the players. What happens in the game reaches
// here as rules.event(ctx, name, data, 'godot') (GF.event in GDScript), on the copy where it happened; the host owns
// the scores and ctx.shared, which the game reads as GF.shared.
export default {
  setup(ctx) {},
  event(ctx, name, data, from) {},
  check() { return null; },
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
`;
}

function indexHtml(title) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0b0e18;touch-action:none}</style>
<link rel="preload" href="build/game.wasm" as="fetch" type="application/wasm" crossorigin>
<link rel="modulepreload" href="gf/godot/boot.js">
<script type="module" src="main.js"></script>
</head>
<body></body>
</html>
`;
}

function godotLicenses() {
  return `# Godot Engine in this game

build/game.js and build/game.wasm are the Godot Engine ${TOOLCHAIN.version} web template (single-threaded, WebGL2),
unchanged; build/game.pck is this game's project packed by it. Pinned by sha256 in the xgames kit's
runtimes/godot/toolchain/toolchain.json.

Godot Engine is under the MIT licence: GODOT-LICENSE.txt beside this file (Copyright (c) 2014-present Godot Engine
contributors; Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur). Its third-party components and their licences:
GODOT-COPYRIGHT.txt beside this file. Both are the files of the engine's ${TOOLCHAIN.version.replace('.stable', '-stable')} tag.

gf/godot/ (the kit's page side) and project/addons/gf/ (the GF autoload) are the xgames kit's, under the MIT licence.
`;
}

function attribution(spec, art) {
  const lic = l => l.credit ?? `${l.spdx}${l.author ? `, ${l.author}` : ''}${l.url ? `, ${l.url}` : ''}`;
  return `# ${spec.title}: credits

- Engine: Godot Engine ${TOOLCHAIN.version} (MIT), see gf/godot/LICENSES.md
- Kit: the xgames kit (MIT): gf/godot, gf/three, gf/mp, gf/gf-assets.js, audio/ (gf-audio: ZzFX, MIT, audio/LICENSE-zzfx)

Art from the kit's asset library (each listed with its licence in assets.json until a person replaces it; the GLBs are
decoded to plain glTF for Godot's runtime reader):

| File | Library asset | Licence |
|---|---|---|
${art.map(a => `| ${a.file} | ${a.ref} | ${lic(a)} |`).join('\n')}
`;
}

/**
 * A 3D game's body and clips: the library's gf-humanoid-1 body the spec names (characters[0].body.fill: library,
 * "<pack>/<id>", like "gf-beans/bean-classic" or a quaternius-ual-bodies one) or the starter's, and the clip file its
 * manifest names, each decoded from
 * meshopt and quantised attributes to a plain GLB (Godot's runtime GLTFDocument reads neither). Needs the 3D tools'
 * packages (gltf-transform, meshoptimizer), installed once here, only for a 3D Godot game.
 */
async function bodies3d(spec, w, A) {
  const { ensureCharDeps } = await import('../../../builder/lib/char-deps.mjs');
  ensureCharDeps({ log: () => {} });
  const C = await import('../../../builder/tools/lib/char-deps.mjs');
  const io = await C.io();
  const plain = async file => {
    const doc = await io.read(file);
    await doc.transform(C.gltfFn.dequantize());
    for (const e of doc.getRoot().listExtensionsUsed()) if (['EXT_meshopt_compression', 'KHR_mesh_quantization'].includes(e.extensionName)) e.dispose();
    if (!doc.getRoot().getDefaultScene()) doc.getRoot().setDefaultScene(doc.getRoot().listScenes()[0] ?? null);
    return Buffer.from(await io.writeBinary(doc));
  };
  // the spec's body ("<pack>/<id>", or a bare id the godot packs have) or the starter's; the clips its manifest names
  const want = spec.characters?.[0]?.body;
  const asked = want?.from === 'library' ? want.asset : ['generate', 'reference'].includes(want?.from) ? want.standIn : null;
  const body = [asked, asked && String(asked).split('/').pop(), STARTERS.follow.body].map(n => A.pick(n)).find(a => a?.use?.rig === 'gf-humanoid-1');
  const clips = A.pick(body.use?.clips ?? 'humanoid-clips/gf-humanoid-1');
  await w('assets/models/body-player.glb', await plain(await A.file(body)));
  await w('assets/clips/gf-humanoid-1.glb', await plain(await A.file(clips)));
  return { id: `${body.pack}/${body.id}`, title: body.describe ?? body.id, license: A.licence(body), clipsLicense: A.licence(clips) };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), [spec, out] = a.filter(x => !x.startsWith('--'));
  if (!spec || !out) { console.error('usage: create.mjs <spec.json> <new-game-dir> [--no-export] [--json]'); process.exit(2); }
  const r = await create(spec, out, { exportNow: !a.includes('--no-export'), log: m => { if (!a.includes('--json')) console.log(m); } }).catch(e => ({ ok: false, problems: [e.stack ?? e.message] }));
  if (a.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (r.ok) { console.log(`created ${r.game} → ${r.dir} (${r.slots} slots, ${r.files} kit files, ${r.style})`); for (const n of r.notes ?? []) console.log(`  note: ${n}`); }
  else for (const p of r.problems) console.error(`refused: ${p}`);
  process.exit(r.ok ? 0 : 1);
}
