#!/usr/bin/env node
// The look pitch: 2–3 readings of a game's style target, each rendered on the game's own world and bodies before any
// gameplay is built, so the person picks the look (or, headless, the judge's best is taken). Each option is a
// different reading of the same target, never a different target: as the references read, pushed, and a third that
// is the target's other sky when its frames show two, else a softer one. Since looks wave 2 the readings differ in
// the place and the camera too (world.mjs): the faithful one stands in the world the target reads as, seen from its
// play camera; the pushed one has more land, more cloud and a lower, closer camera; the third takes the runtime's next
// world when it is nearly as close, else the references' wide view. An option whose world or camera differs from the
// game's is made by create from the option's spec (so its sheet is what the game would be); the pick writes that spec.
//
//   readings(target) → [{id, title, reading, target}]
//   const opts = await options(spec, { game, out });   // → [{id, title, reading, target, values, sheet, tiles, score}]
//   await overview(opts, { refs, out })                 // one picture: the references on top, an option per row
//
//   node builder/look/pitch.mjs <game> [--out dir] [--target target.json] [--refs <reference folder>] [--packs a,b] [--software]
//
// Each option is measured once and corrected once (grade saturation and exposure by its lit pixels against the
// target's), and the correction is kept only when the judge's measured mark against the references does not fall.
// The sheets are the look judge's contact sheets (builder/look-judge/kind-sheet.mjs --game), drawn from a copy of the
// game whose config/look.json is the option's (the game's other files are linked, not copied). A runtime whose sheet
// does not read a game yet draws the kind's own sheet, and the option says so. Run it through the GPU slots
// (gpu-run.sh) on this machine.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { over } from '../../kinds/apply.mjs';
import { KIT_ROOT } from '../lib/paths.mjs';
import { lookValues, resolved, LEVERS, placeKey } from './apply.mjs';
import { worldPlan, specWithWorld, dressingOf, cameraOf, strataOf, compositionPieces, composeOf } from './world.mjs';
import { SET_PIECE } from '../art/recipe.mjs';
import { targetOfLook, wherePlaces } from './looks.mjs';

/** The runtime's own ground and cliff pictures (the terrain world's pack), ranked with a look's packs for its ground. */
export const GROUND_PACKS = ['xk-terrain'];
// a prop longer than SET_PIECE (metres) is a set piece: the world's dressing places it, the props shot leaves it out
export { SET_PIECE };
import { findRefs } from './refs.mjs';
import { measureSet, rgbaOf } from './measure.mjs';
import { compareStats, frameStats, hexToOklab, measuredMark } from './stats.mjs';

const LEVEL = ['none', 'low', 'mid', 'high'];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r2 = x => Math.round(x * 100) / 100;
const step = (lv, d) => (lv ? LEVEL[clamp(LEVEL.indexOf(lv) + d, 0, 3)] : lv);
const okDist = (h1, h2) => { const p = hexToOklab(h1), q = hexToOklab(h2); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };

/** A target with its lit chroma, contrast, shadows, haze and ink moved together (k > 0 louder, k < 0 softer). */
function lean(t, k) {
  const o = structuredClone(t);
  if (o.palette?.mean?.litC != null) o.palette.mean.litC = Math.round(o.palette.mean.litC * (1 + 0.4 * k) * 1000) / 1000;
  if (o.lighting) {
    if (o.lighting.contrast != null) o.lighting.contrast = r2(clamp(o.lighting.contrast + 0.25 * k, 0, 1));
    if (o.lighting.keyStrength) o.lighting.keyStrength = step(o.lighting.keyStrength, Math.sign(k));
    if (o.lighting.shadowSoftness != null) o.lighting.shadowSoftness = r2(clamp(o.lighting.shadowSoftness - 0.2 * k, 0, 1));
    if (o.lighting.fog?.density != null) o.lighting.fog.density = r2(clamp(o.lighting.fog.density - 0.12 * k, 0, 1));
  }
  if (o.edges?.outline) o.edges.outline = step(o.edges.outline, 2 * Math.sign(k));
  if (o.materials?.rim) o.materials.rim = step(o.materials.rim, Math.sign(k));
  return o;
}

/** The skies a target's references show, far apart from each other (a level per sky), the main one first. */
export function skies(t) {
  const list = t.lighting?.sky?.length ? t.lighting.sky : (t.regions?.sky?.colors ?? []).filter(c => c.share >= 0.15).map(c => c.hex);
  const out = [];
  for (const h of list) if (out.every(o => okDist(o, h) > 0.12)) out.push(h);
  return out;
}

/** A target whose play camera is moved: eye and distance scaled, or another framing (the references' wide view) as play. */
function camLean(t, { eye = 1, distance = 1, framing = null } = {}) {
  const o = structuredClone(t);
  if (!o.camera) return o;
  const f = framing ? o.camera.framings?.find(x => x.name === framing) : null;
  if (f) {
    // the wide view becomes the play camera: its pitch, distance, fov and height; the horizon is what they make
    o.camera.framings = [{ ...f, frame: 'gameplay' }, ...o.camera.framings.filter(x => x !== f).map(x => (x.frame === 'gameplay' ? { ...x, frame: 'other' } : x))];
    o.camera.horizon = null;
    if (f.height != null) o.camera.eye = f.height;
    return o;
  }
  if (o.camera.eye != null) o.camera.eye = r2(o.camera.eye * eye);
  const play = (o.camera.framings ?? []).find(x => x.frame === 'gameplay') ?? o.camera.framings?.[0];
  if (play) { play.distance = r2(play.distance * distance); if (play.height != null) play.height = r2(play.height * eye); }
  return o;
}
/** The references' wide framing (a scene or terrain view higher and further than the play one), when they have one. */
const wideFraming = t => (t.camera?.framings ?? []).filter(f => (f.frame === 'scene' || f.frame === 'terrain') && f.pitch < 50).sort((a, b) => a.distance - b.distance)[0]?.name ?? null;

/** 2–3 readings of one target, each with its place (world: the runtime's world by rank, pushed or not) and camera. */
export function readings(target) {
  // references that span distinct looks (levels: target.looks, target.mjs): one option per look, the biggest three,
  // each its own palette, sky, light and place, held to its own frames (never one averaged look)
  if ((target.looks?.length ?? 0) >= 2) {
    return [...target.looks].sort((a, b) => (b.share ?? 0) - (a.share ?? 0)).slice(0, 3).map(L => ({
      id: `level-${L.id}`, title: L.name, level: L.id, frames: L.frames,
      reading: `the references' "${L.name}" look (${L.frames.length} of their frames${L.setting ? `, ${L.setting}` : ''}): its own palette, sky, light and place, held to its own frames`,
      target: { ...targetOfLook(target, L.id), looks: target.looks }, world: { rank: 0, push: 0 },
    }));
  }
  const out = [
    { id: 'faithful', title: 'As the references read', reading: 'the measured palette, light and ink as they are, in the place the references show, from their play camera', target: structuredClone(target), world: { rank: 0, push: 0 } },
    { id: 'pushed', title: 'Pushed', reading: 'the same target louder: more colour on the lit surfaces, a stronger, harder sun, two levels more ink, one more of rim; more land and cloud, the camera lower and closer', target: camLean(lean(target, 1), { eye: 0.7, distance: 0.8 }), world: { rank: 0, push: 1 } },
  ];
  // the other sky: the references' second sky (skyOf takes the first)
  const other = skies(target)[1];
  if (other) {
    const t = structuredClone(target);
    t.lighting = { ...t.lighting, sky: [other, ...(t.lighting?.sky ?? []).filter(h => h !== other)] };
    out.push({ id: 'other-sky', title: 'The other sky', reading: `the references' second sky (${other}): their levels swing between skies, this is the next one`, target: t, world: { rank: 0, push: -0.5 } });
  } else out.push({ id: 'softer', title: 'Softer', reading: 'the same target calmer: less colour, a weaker, softer sun, more haze, two levels less ink', target: lean(target, -1), world: { rank: 0, push: -0.5 } });
  // the third reading's place: the runtime's next world when it reads nearly as close (the person sees both families),
  // else the references' wide view of the same place
  const third = out[2], wide = wideFraming(target);
  third.world.next = true;
  // the wide view stands when the third stays in the same world; in the next world it keeps the play camera (the two
  // places are compared from the same eye)
  if (wide) { third.plain = { target: third.target, reading: third.reading }; third.target = camLean(third.target, { framing: wide }); third.reading += `; seen from the references' wide view (${wide})`; }
  return out;
}

/** A copy of the game whose config/look.json is `look`: config/ and spec.json copied, everything else linked. */
async function gameCopy(game, dir, look) {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const name of readdirSync(game)) {
    if (name.startsWith('.') || name === 'config' || name === 'assets') continue;
    await symlink(path.join(game, name), path.join(dir, name));
  }
  // assets: a folder of links one level down, so a look's art can be added beside the game's own
  if (existsSync(path.join(game, 'assets'))) {
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    for (const name of readdirSync(path.join(game, 'assets'))) await symlink(path.join(game, 'assets', name), path.join(dir, 'assets', name));
  }
  await cp(path.join(game, 'config'), path.join(dir, 'config'), { recursive: true });
  await writeFile(path.join(dir, 'config/look.json'), JSON.stringify(look, null, 2) + '\n');
  return dir;
}

// ---- a look's art: the packs an option brings (a kind's, or a pack made for this look, such as a Meshy wave)
/**
 * The art the named packs hold for a look, ranked against the target (builder/art/coverage.mjs styleFit): a rigged
 * body for the player, the rest of the bodies (a blob or a critter with no rig standard yet stands still), the props,
 * and the ground tops. → {packs, hero, bodies: [{ref, file, height, rigged}], props: [{ref, file, height}], grounds: [{ref, file, fit, saturation}]}
 */
export async function artOf(packs, target) {
  const [{ artLibrary, localFile }, { styleFit }] = await Promise.all([import('../art/views.mjs'), import('../art/coverage.mjs')]);
  const L = artLibrary(), all = packs.flatMap(id => L.packs.get(id)?.assets ?? []);
  const file = a => { const f = localFile(a); return f && existsSync(f) ? f : null; };
  const item = a => ({ ref: `${a.pack}/${a.id}`, id: a.id, file: file(a), ext: path.extname(a.file), height: a.use?.height ?? a.use?.size?.[1] ?? null });
  // rigged: on a standard (gf-humanoid-1, or a creature's: CREATURES.md) and passing its validator (a failed rig, such
  // as Meshy's biped on a legless critter, stands still like an unrigged body)
  const bodies = all.filter(a => a.category === 'body' && file(a)).map(a => ({ ...item(a), rigged: !!a.use?.rig && a.use.rig !== 'none' && (a.validated ?? []).every(v => v.ok !== false) }));
  const sat = a => a.fits?.signature?.palette?.saturation ?? 0;
  // the ground the target walks on (the colour the judge called grass or ground, else the measured ground band): a top
  // whose own colours are nearest it fits first; with none, the style fit decides
  const want = target?.palette?.colors?.find(c => /grass|turf|ground/i.test(c.role ?? ''))?.hex ?? target?.regions?.ground?.colors?.[0]?.hex ?? null;
  // by hue and chroma first (a texture is lit and graded in the game; its lightness moves, its colour family does not)
  const hueDist = (h1, h2) => { const p = hexToOklab(h1), q = hexToOklab(h2); return Math.hypot(p[1] - q[1], p[2] - q[2]) + 0.3 * Math.abs(p[0] - q[0]); };
  const near = a => { const hs = a.fits?.signature?.palette?.hues?.slice(0, 3) ?? []; return want && hs.length ? Math.min(...hs.map(h => hueDist(h, want))) : null; };
  const grounds = all.filter(a => a.category === 'texture' && file(a) && (/(^|-)top$/.test(a.id) || (a.tags ?? []).some(t => /grass|turf|top/.test(t))))
    .map(a => ({ ...item(a), fit: target ? styleFit(a, target)?.fit ?? null : null, near: near(a), saturation: sat(a), hues: a.fits?.signature?.palette?.hues ?? [] }))
    .sort((x, y) => (x.near != null && y.near != null ? x.near - y.near : (y.fit ?? 0) - (x.fit ?? 0)));
  // the soils: pictures of the ground cut open (a cliff's face), with their own colours
  const soils = all.filter(a => a.category === 'texture' && file(a) && (/(^|-)soil$/.test(a.id) || (a.tags ?? []).some(t => /soil|strata|cliff/.test(t))))
    .map(a => ({ ...item(a), hues: a.fits?.signature?.palette?.hues ?? [] }));
  return {
    packs, hero: bodies.find(b => b.rigged) ?? null, soils,
    // the others: a body whose rigged twin is here (<id>-rigged, <id>-blob, …) gives way to it
    bodies: bodies.filter(b => b !== bodies.find(r => r.rigged) && !bodies.some(r => r.rigged && r !== b && r.id.startsWith(`${b.id}-`)) && !(!b.rigged && /-rigged$/.test(b.id))),
    // the props shot holds things at hand's or furniture size; a set piece (a castle, a mesa) stands in the world
    props: all.filter(a => a.category === 'prop' && file(a) && Math.max(...(a.use?.size ?? [0])) <= SET_PIECE).map(item).slice(0, 8),
    grounds,
  };
}

/**
 * The ground each reading takes: the top nearest the target's grass for all of them (wave 1 gave the pushed reading
 * the most saturated top and the third the next one: by eye both read as other games, candy sprinkles and cobbles,
 * while the readings' light, place and camera already differ).
 */
export function groundFor(art, target = null) {
  const g = art?.grounds ?? [];
  // one look of several (target.level), ranked again for it by the colour its own frames name: its grass, else its sand
  // (a desert look)
  // (the lit colour of the kind: the most saturated, never a "shaded grass"); a look that names neither keeps the whole
  // set's ground (its measured ground band takes in the sea and would pick stone)
  const chroma = h => { const [, a, b] = hexToOklab(h); return Math.hypot(a, b); };
  const named = re => (target?.palette?.colors ?? []).filter(c => re.test(c.role ?? '') && !/shad/i.test(c.role ?? '')).sort((a, b) => chroma(b.hex) - chroma(a.hex))[0]?.hex;
  const want = target?.level ? named(/grass|turf|lawn|meadow/i) ?? named(/\b(sand|beach|desert|dune)\b/i) : null;
  if (!want || !g.length) return g[0] ?? null;
  const d = h => { const p = hexToOklab(h), q = hexToOklab(want); return Math.hypot(p[1] - q[1], p[2] - q[2]) + 0.3 * Math.abs(p[0] - q[0]); };
  const near = a => (a.hues.length ? Math.min(...a.hues.slice(0, 3).map(d)) : 9);
  return [...g].sort((a, b) => near(a) - near(b))[0];
}

/** The cliff picture a reading takes: the soil whose colours are nearest the target's cliff colour, else none. */
function soilFor(art, target) {
  const s = art?.soils ?? [];
  if (!s.length) return null;
  // the cliff's colour: the lightest of the target's rock and soil colours (strataOf puts it first), as cliff faces
  // catch the light
  const want = strataOf(target ?? {})?.[0];
  if (!want) return s[0];
  const near = a => Math.min(...(a.hues ?? []).slice(0, 3).map(h => okDist(h, want)), 9);
  return [...s].sort((a, b) => near(a) - near(b))[0];
}

/** An option's game made by create from the option's spec, in `dir/game` (the spec beside it). → the game folder */
async function createCopy(optSpec, dir, log = () => {}) {
  const { create } = await import('../tools/create.mjs');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'spec.json'), to = path.join(dir, 'game');
  await writeFile(file, JSON.stringify(optSpec, null, 2) + '\n');
  await rm(to, { recursive: true, force: true });
  const r = await create(file, to, { force: true });
  if (!r?.ok) throw new Error(`the option's game could not be made: ${(r?.problems ?? []).join('; ').slice(0, 400)}`);
  log(`  made ${path.basename(dir)} by create (${optSpec.world?.template})`);
  return to;
}

/**
 * A look's art into a game copy (for its sheet): the rigged body as the player, the others as more roles (they stand
 * still when they have no rig), the props on the sheet's props shot (config/look-sheet.json), the ground top as the
 * world's ground pattern over a white ground. The copy only: a build fills the game's own slots with these (the brief
 * names them).
 */
export async function applyArt(dir, art, ground) {
  const put = async (it, sub) => {
    const rel = `assets/${sub}/look-${it.id}${it.ext}`, folder = path.join(dir, 'assets', sub);
    // the copy's folder is a link into the game: made a real folder of links first, so nothing is written into the game
    if (existsSync(folder) && (await lstat(folder)).isSymbolicLink()) {
      const real = await realpath(folder); await rm(folder);
      await mkdir(folder, { recursive: true });
      for (const n of readdirSync(real)) await symlink(path.join(real, n), path.join(folder, n));
    }
    await mkdir(folder, { recursive: true }); await cp(it.file, path.join(dir, rel));
    return rel;
  };
  const chars = JSON.parse(await readFile(path.join(dir, 'config/characters.json'), 'utf8'));
  const base = chars.roles?.player ?? Object.values(chars.roles ?? {})[0] ?? {};
  const roles = {};
  if (art.hero) roles.player = { ...base, body: await put(art.hero, 'models'), height: art.hero.height ?? base.height };
  for (const b of art.bodies.slice(0, 3)) roles[b.id] = { ...base, body: await put(b, 'models'), height: b.height ?? 1 };
  if (Object.keys(roles).length) { chars.roles = { ...(roles.player ? {} : { player: base }), ...roles }; await writeFile(path.join(dir, 'config/characters.json'), JSON.stringify(chars, null, 1)); }
  if (art.props.length) await writeFile(path.join(dir, 'config/look-sheet.json'), JSON.stringify({ props: await Promise.all(art.props.map(async p => ({ id: p.id, file: await put(p, 'props'), height: p.height ?? 0.9 }))) }, null, 1));
  if (ground) {
    const w = JSON.parse(await readFile(path.join(dir, 'config/world.json'), 'utf8'));
    // the pattern names the file put() wrote (look-<id>.png): naming <id>.png left a real game's ground white
    const file = await put({ ...ground, ext: '.png' }, 'textures');
    w.ground = { ...(w.ground ?? {}), color: '#ffffff', color2: '#f2f2f2', outer: '#e8e8e8', outer2: '#dedede', pattern: { file, size: 3 } };
    await writeFile(path.join(dir, 'config/world.json'), JSON.stringify(w, null, 1));
  }
}

/** Run the kind sheet on a game folder. → {sheet, tiles: {world, hero, bodies, props, hud}, record} */
export async function renderSheet(game, out, { software = false, log = () => {}, wrap = [], env = process.env } = {}) {
  const args = [path.join(KIT_ROOT, 'builder/look-judge/kind-sheet.mjs'), '--game', game, '--out', out, ...(software ? ['--software'] : [])];
  const [cmd, ...pre] = wrap.length ? [...wrap, process.execPath] : [process.execPath];
  await mkdir(out, { recursive: true });
  const code = await new Promise(done => {
    const c = spawn(cmd, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    c.stdout.on('data', d => log(String(d).trimEnd())); c.stderr.on('data', d => log(String(d).trimEnd()));
    c.on('close', done); c.on('error', () => done(1));
  });
  const recFile = readdirSync(out).find(f => f.endsWith('.json'));
  const record = recFile ? JSON.parse(await readFile(path.join(out, recFile), 'utf8')) : null;
  const tiles = Object.fromEntries((record?.tiles ?? []).map(t => [t.name, path.join(out, t.file)]));
  return { ok: code === 0 && !!record?.sheet, sheet: record?.sheet ? path.join(out, record.sheet) : null, tiles, record };
}

/** The judge's measured mark (stats.mjs) of some frames against reference stats: each frame's best match, averaged. */
export async function markOf(files, refStats) {
  const marks = [];
  for (const f of files) {
    const s = frameStats(await rgbaOf(f));
    marks.push(Math.max(...refStats.map(r => measuredMark(compareStats(s, r).parts))));
  }
  return marks.length ? Math.round(marks.reduce((a, b) => a + b, 0) / marks.length) : null;
}

/** The look judge's score when it exists (builder/look/judge.mjs score(game, target, refs)); null scores until then. */
export async function judgeOf() {
  const f = path.join(KIT_ROOT, 'builder/look/judge.mjs');
  if (!existsSync(f)) return null;
  const m = await import(pathToFileURL(f).href);
  return typeof m.score === 'function' ? m.score : null;
}
export const scoreStub = async () => null;
/** The look judge's side-by-side ranking when it exists (builder/look/judge.mjs compare(looks, target, refs)). */
export async function compareOf() {
  const f = path.join(KIT_ROOT, 'builder/look/judge.mjs');
  if (!existsSync(f)) return null;
  const m = await import(pathToFileURL(f).href);
  return typeof m.compare === 'function' ? m.compare : null;
}

/**
 * The options for a game: each reading mapped onto the runtime's levers over the game's own look, drawn on its own
 * world and bodies. spec: the game's spec (its look.target; `target` overrides). → options, best first by score when
 * the judge gives one, else in reading order (the faithful reading first).
 */
export async function options(spec, { game, out = path.join(game, '.look', 'options'), target = spec.look?.target, render = renderSheet, score = undefined, refs = null, software = false, calibrate = true, packs = [], log = () => {} } = {}) {
  if (!target) throw new Error('options: the spec has no look.target (builder/look/target.mjs makes one)');
  // each target camera asks the world for its kind of place (a target made before `where` gets it from its frame kind)
  if (target.camera?.framings?.some(f => !f.where)) target = { ...target, camera: { ...target.camera, framings: wherePlaces(target.camera.framings, target.world) } };
  const place = { runtime: spec.runtime, profile: spec.profile ?? null }, key = placeKey(place);
  const look = JSON.parse(await readFile(path.join(game, 'config/look.json'), 'utf8'));
  const time = look.time ?? spec.look?.time ?? 'day';
  const judge = score === undefined ? (await judgeOf()) ?? scoreStub : score ?? scoreStub;
  const frames = refs ?? (spec.look?.refs ? (await findRefs(spec.look.refs)).frames : []);
  const refStats = calibrate ? await Promise.all(frames.filter(f => f.frame !== 'ui').map(async f => frameStats(await rgbaOf(f.file)))) : [];
  // the look's packs, and the runtime's own ground pictures beside them (a desert look finds the sand top)
  const art = packs.length ? await artOf([...new Set([...packs, ...GROUND_PACKS])], target) : null;
  // the place: each reading's set dressing found in the library (a level's own words when its look names them, else the
  // whole target's), held to that reading's style; the words with none go to the art ladder
  const dressings = new Map();
  const dressingFor = async t => {
    const words = t.world?.props?.dressing ?? [], key = `${t.level?.id ?? ''}|${words.join('|')}`;
    if (!dressings.has(key)) {
      const d = words.length ? await dressingOf(words, { target: t, packs }) : { ids: [], missing: [], offStyle: [] };
      const at = t.level?.id ? ` (${t.level.id})` : '';
      if (d.offStyle?.length) log(`look options${at}: set dressing that does not fit the look, left to the art ladder: ${d.offStyle.map(o => `"${o.phrase}" (${o.id} ${o.fit})`).join(', ')}`);
      if (d.missing.length) log(`look options${at}: no library prop reads as ${d.missing.map(w => `"${w}"`).join(', ')} (made in the game or by the art ladder)`);
      dressings.set(key, d);
    }
    return dressings.get(key);
  };
  const result = [];
  for (const r of readings(target)) {
    const ground = groundFor(art, r.target), soil = soilFor(art, r.target), dressing = await dressingFor(r.target);
    // what the play happens on (the target's composition): its landmarks and bridges found in the level's own set
    // dressing first, made the playfield by a world that composes (worlds/terrain/compose.mjs)
    const pieces = await compositionPieces(r.target, { dressing: dressing.ids, packs });
    if (pieces.missing.length) log(`look options${r.target.level?.id ? ` (${r.target.level.id})` : ''}: no library piece for the landmark${pieces.missing.length > 1 ? 's' : ''} ${pieces.missing.map(w => `"${w}"`).join(', ')} (the land makes it, or the art ladder)`);
    const compose = composeOf(r.target, pieces);
    // the reading's place and camera (world.mjs): the third reading takes the runtime's next world when it is nearly as
    // close as the best
    const planOf = rank => worldPlan(r.target, place, { loop: spec.loop, current: spec.world?.template, art: { ...(ground ? { ground } : {}), ...(soil ? { soil } : {}) }, dressing: dressing.ids, push: r.world?.push ?? 0, rank, compose });
    let plan = planOf(0);
    const next = plan.ranked?.[1];
    if (r.world?.next && next && plan.score && next.score >= 0.75 * plan.score) {
      if (r.plain) Object.assign(r, r.plain);
      plan = planOf(1); r.reading += `; in the runtime's next closest world, ${plan.template}`;
    }
    const cam = spec.camera ? cameraOf(r.target, spec.camera) : null;
    const lv = lookValues(r.target, { ...place, base: resolved(look, time) });
    // an option whose place or camera differs from the game's is made by create from its own spec (the sheet is what the
    // game would be); else the game is copied (its own files linked) with the option's look
    const remake = !lv.skipped && !!(plan.params || (plan.template && plan.template !== spec.world?.template) || cam);
    const optSpec = remake ? specWithWorld({ ...spec, look: { ...(spec.look ?? {}), target: r.target, ...(packs.length ? { packs: [...new Set([...(spec.look?.packs ?? []), ...packs])] } : {}) } }, plan) : null;
    const dir = path.join(out, r.id);
    const makeCopy = async own => {
      let c;
      if (remake) {
        c = await createCopy(optSpec, dir, log);
        if (own) await writeFile(path.join(c, 'config/look.json'), JSON.stringify(own, null, 2) + '\n');
      } else c = await gameCopy(game, path.join(dir, 'game'), own);
      if (art) await applyArt(c, art, remake && plan.params ? null : ground);
      return c;
    };
    let own = null, copy;
    if (remake) { copy = await makeCopy(null); own = JSON.parse(await readFile(path.join(copy, 'config/look.json'), 'utf8')); }
    else {
      own = over(look, lv.values);
      if (own.times?.[time]) own.times[time] = over(own.times[time], lv.values);
      if (spec.look?.values) { own = over(own, spec.look.values); if (own.times?.[time]) own.times[time] = over(own.times[time], spec.look.values); }
      copy = await makeCopy(own);
    }
    log(`option ${r.id}: ${lv.levers.join(', ') || lv.skipped}${remake ? `; world ${plan.why}${cam ? `; camera ${Object.entries(cam.settings).map(([k, v]) => `${k} ${v}`).join(' ')}` : ''}` : ''}`);
    let drawn = await render(copy, path.join(dir, 'sheet'), { software, log });
    // measured once, corrected once: the grade and the exposure are first guesses against the kit's usual render
    // (apply.mjs LIT_C, LIT_L); the option's own frames say how far its lit surfaces are from the target's, and the
    // two levers move by that ratio before the sheet is shown
    let calibration = null;
    const want = r.target.palette?.mean;
    if (calibrate && drawn.ok && want?.litC != null && !lv.skipped) {
      const shots = ['world', 'hero', 'props'].map(k => drawn.tiles[k]).filter(f => f && existsSync(f));
      const got = shots.length ? (await measureSet(shots)).mean : null;
      if (got?.litC && got?.litL) {
        const fix = { post: { grade: { saturation: r2(clamp((own.post?.grade?.saturation ?? 1) * clamp(want.litC / got.litC, 0.5, 2), 0.4, 2.2)) } }, renderer: { exposure: r2(clamp((own.renderer?.exposure ?? 1) * clamp((want.litL / got.litL) ** 1.5, 0.6, 1.6), 0.4, 2.5)) } };
        const before = { own: structuredClone(own), values: structuredClone(lv.values), mark: refStats.length ? await markOf(shots, refStats) : null };
        own = over(own, fix); if (own.times?.[time]) own.times[time] = over(own.times[time], fix);
        lv.values = over(lv.values, fix);
        copy = await makeCopy(own);
        drawn = await render(copy, path.join(dir, 'sheet'), { software, log });
        calibration = { target: { litC: want.litC, litL: want.litL }, first: { litC: got.litC, litL: got.litL }, set: { saturation: fix.post.grade.saturation, exposure: fix.renderer.exposure } };
        // the correction stands only when the measured mark against the references does not fall (pooled means mix
        // content: a frame of sand and clouds and a frame of lawn can share a lit chroma and look nothing alike)
        if (before.mark != null) {
          const after = await markOf(['world', 'hero', 'props'].map(k => drawn.tiles[k]).filter(f => f && existsSync(f)), refStats);
          calibration.mark = { before: before.mark, after };
          if (after < before.mark) {
            own = before.own; lv.values = before.values; calibration.kept = false;
            copy = await makeCopy(own);
            drawn = await render(copy, path.join(dir, 'sheet'), { software, log });
          } else calibration.kept = true;
        }
        log(`option ${r.id}: lit chroma ${got.litC} → target ${want.litC}, lit lightness ${got.litL} → ${want.litL}: saturation ${fix.post.grade.saturation}, exposure ${fix.renderer.exposure}`);
      }
    }
    let s = null;
    // a look's option is held to its own frames (like with like); the others to all of them
    const held = r.frames ? frames.filter(f => r.frames.includes(f.sha256)) : frames;
    try { s = await judge(copy, r.target, held.length ? held : frames); } catch (e) { log(`option ${r.id}: the judge failed: ${e.message}`); }
    result.push({ id: r.id, title: r.title, ...(r.level ? { level: r.level } : {}), reading: r.reading + (art ? `; art from ${art.packs.join(', ')}${ground ? `, ground ${ground.id}` : ''}${soil && remake && plan.params ? `, cliffs ${soil.id}` : ''}` : ''), target: r.target, values: lv.values,
      ...(remake ? { world: { template: plan.template, score: plan.score, why: plan.why, notes: plan.notes, ...(plan.params ? { params: plan.params } : {}) }, ...(cam ? { camera: { rig: spec.camera, ...cam.settings } } : {}), made: { world: optSpec.world, target: r.target } } : {}), ...(art ? { art: { packs: art.packs, hero: art.hero?.ref ?? null, bodies: art.bodies.slice(0, 3).map(b => b.ref), props: art.props.map(p => p.ref), ground: ground?.ref ?? null } } : {}), levers: lv.levers, ...(lv.skipped ? { skipped: lv.skipped } : {}), sheet: drawn.sheet, tiles: drawn.tiles, ok: drawn.ok, ...(calibration ? { calibration } : {}), score: s?.score ?? null, findings: s?.findings ?? [] });
  }
  // side by side (judge.mjs compare): a judge marking each option alone gives close options the same marks; together,
  // on their sheet tiles, it ranks them as a person does (builder/look/evidence/calibration-artillery-options-*)
  // (options of different looks are held to different frames: each keeps its own score, side by side is not like with like)
  const side = score === undefined && !result.some(o => o.level) ? await compareOf() : null;
  const drawnOnes = result.filter(o => o.ok && o.tiles);
  if (side && drawnOnes.length > 1) {
    try {
      const FRAMING = { world: 'wide', hero: 'hero', props: 'props', hud: 'hud', bodies: 'bodies' };
      const c = await side(drawnOnes.map(o => ({ id: o.id, game: { frames: Object.entries(FRAMING).map(([k, framing]) => ({ file: o.tiles[k], framing })).filter(f => f.file && existsSync(f.file)) } })), target, frames, { log });
      for (const o of drawnOnes) if (c.looks[o.id]) Object.assign(o, { alone: o.score, score: c.looks[o.id].score, side: { measured: c.looks[o.id].measured, judged: c.looks[o.id].judged, rank: c.ranking.indexOf(o.id) + 1 } });
    } catch (e) { log(`the options side by side: the judge failed: ${e.message}`); }
  }
  if (result.some(o => o.score != null)) result.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  await writeFile(path.join(out, 'options.json'), JSON.stringify({ schema: 'gf-look-options/1', game: path.basename(game), runtime: key, mapped: LEVERS[key]?.mapped ?? [], options: result.map(({ target, made, ...o }) => ({ ...o, sheet: o.sheet && path.relative(out, o.sheet), tiles: Object.fromEntries(Object.entries(o.tiles ?? {}).map(([k, v]) => [k, path.relative(out, v)])) })) }, null, 1) + '\n');
  return result;
}

/** The best option: the judge's highest score, else the first (the faithful reading). */
export const bestOf = opts => opts.reduce((a, o) => ((o.score ?? -1) > (a.score ?? -1) ? o : a), opts[0]);

/**
 * One picture for the person: the reference frames on the first row (local only: this picture is never committed or
 * published when it holds them), then one row per option: its world, a body up close, props, the HUD.
 */
export async function overview(opts, { refs = [], out, width = 560 } = {}) {
  const { sharp } = await import(pathToFileURL(path.join(KIT_ROOT, 'builder/tools/lib/char-deps.mjs')).href);
  const H = Math.round(width * 9 / 16), head = 30, cols = 4;
  const rows = [...(refs.length ? [{ title: 'References (local, never published)', files: refs.slice(0, cols).map(f => f.file ?? f) }] : []),
    ...opts.map((o, i) => ({ title: `${String.fromCharCode(65 + i)}. ${o.title}${o.score != null ? ` · score ${o.score}` : ''}: ${o.reading}`, files: ['world', 'hero', 'props', 'hud'].map(k => o.tiles?.[k]).filter(Boolean) }))];
  const parts = [], labels = [];
  for (const [r, row] of rows.entries()) {
    const y = r * (H + head);
    labels.push(`<text x="8" y="${y + 20}" font-size="17" fill="#fff" font-family="sans-serif">${row.title.replace(/&/g, '&amp;').replace(/</g, '&lt;').slice(0, 160)}</text>`);
    for (const [c, f] of row.files.entries()) if (existsSync(f)) parts.push({ input: await sharp(f).resize(width, H, { fit: 'cover' }).toBuffer(), left: c * width, top: y + head });
  }
  const W = width * cols, Ht = rows.length * (H + head);
  const svg = Buffer.from(`<svg width="${W}" height="${Ht}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`);
  await sharp({ create: { width: W, height: Ht, channels: 3, background: '#15161a' } }).composite([...parts, { input: svg, left: 0, top: 0 }]).jpeg({ quality: 90 }).toFile(out);
  return out;
}

// ---- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const game = path.resolve(argv.find((a, i) => !a.startsWith('--') && !['--out', '--target', '--refs', '--packs'].includes(argv[i - 1])));
  const spec = JSON.parse(await readFile(path.join(game, 'spec.json'), 'utf8'));
  const target = opt('--target') ? JSON.parse(await readFile(opt('--target'), 'utf8')) : spec.look?.target;
  const out = path.resolve(opt('--out') ?? path.join(game, '.look', 'options'));
  let refs = null;
  if (opt('--refs')) refs = (await (await import('./refs.mjs')).readManifest(opt('--refs'))).frames;
  const opts = await options(spec, { game, out, target, refs, packs: opt('--packs')?.split(',').filter(Boolean) ?? [], software: argv.includes('--software'), log: m => console.error(m) });
  const pic = await overview(opts, { refs: refs ?? [], out: path.join(out, 'overview.jpg') });
  for (const o of opts) console.log(`${o.id}: ${o.ok ? o.sheet : 'NOT DRAWN'}${o.score != null ? `  score ${o.score}` : ''}`);
  console.log(`overview: ${pic}`);
  process.exit(opts.every(o => o.ok) ? 0 : 1);
}
