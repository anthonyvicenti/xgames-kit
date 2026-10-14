// assets.json from slot declarations (CONTRACT §2.2): the kit's own modules (core, ui, controller), the look, world
// and character modules (real or stand-in), each mechanic, config/*.json and the files under assets/.
//
//   const m = await assembleManifest(gameDir, { sounds });   // → the gf-assets/1 object (not written)
//
// The ignore list (files in the game folder that are not game assets) is the kit's own entries (BASE_IGNORE), then
// the entries a checkout configures (GF_MANIFEST_IGNORE: a JSON file holding [{path, reason}], e.g. the guide files a
// coding agent's project carries), then whatever further entries the game's assets.json already has. Those are kept
// the way its sound list is kept, so `slots --write`, a second create and upgrade never drop them.
//
// Declarations are read from the game's own kit copy (gf/three/) when it has one, else from the kit source.
// Main tier: at most MAIN_MAX slots stay "main", by each declaration's `rank` (the rest become "advanced").
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, SCENIC_KIT, FORGE_KIT, VISTA_KIT, walk, kitPath } from './paths.mjs';
import { assetsIn, findAsset, licenceOf } from '../../art/views.mjs';
import { importKitModule } from './kit-import.mjs';

export const MAIN_MAX = 40;
export const GROUPS = [
  ['text', 'Title & text'], ['characters', 'Characters'], ['props', 'Props'], ['world', 'World'], ['look', 'Look & light'], ['look-times', 'Look: times of day'], ['look-quality', 'Look: quality tiers'],
  ['rules', 'Rules & scoring'], ['mechanics', 'How it plays'], ['controls', 'Movement & camera'], ['ui', 'Menus & HUD'], ['models', 'Other models'],
];
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));

/** What every gf-three game ignores: the files create vendors and the records beside them. */
export const BASE_IGNORE = [
  { path: 'vendor/**', reason: 'pinned library code: three.js 0.186.0, Rapier 0.19.2, postprocessing, N8AO (licences beside each copy)' },
  { path: 'gf/**', reason: 'kit copies: gf-three, gf-multiplayer, gf-assets (vendored by create, never edited)' },
  { path: 'audio/**', reason: 'gf-audio 1.5.0 kit' },
  { path: 'evidence/**', reason: 'QA evidence (verify runs), append-only' },
  { path: 'tests/**', reason: 'the game\'s own tests (verify check 35): play scripts that hold its own promises, not assets' },
  { path: 'spec.json', reason: 'the game spec this project was made from (builder/spec/game-spec.schema.json)' },
  { path: 'gf-three.json', reason: 'build record from create: kit version, modules, where each asset came from' },
  { path: 'generated.json', reason: 'record of the models the spec asked to generate and what happened (the Studio worker writes it; verify check 14 reads it)' },
  { path: 'multiplayer.json', reason: 'multiplayer manifest (multiplayer/STANDARD.md)' },
];
const ignoreEntry = e => e && typeof e.path === 'string' && e.path && typeof e.reason === 'string' && e.reason;

/** The ignore entries a checkout adds to every game: GF_MANIFEST_IGNORE names a JSON file holding [{path, reason}]. */
export function configuredIgnore({ env = process.env, read = p => readFileSync(p, 'utf8') } = {}) {
  const file = env.GF_MANIFEST_IGNORE;
  if (!file) return [];
  let list;
  try { list = JSON.parse(read(file)); } catch (e) { throw new Error(`GF_MANIFEST_IGNORE: ${file} is not readable JSON (${e.message.split('\n')[0]})`); }
  if (!Array.isArray(list) || !list.every(ignoreEntry)) throw new Error(`GF_MANIFEST_IGNORE: ${file} must hold a list of {path, reason}`);
  return list.map(e => ({ path: e.path, reason: e.reason }));
}

/**
 * A manifest's ignore list: the kit's entries, then the configured ones, then the game's own further entries
 * (`existing`: the ignore list of the assets.json the game has now). One entry per path; the kit's wording wins for
 * its own paths, so a game cannot reword or drop them. Pure.
 */
export function mergeIgnore({ configured = [], existing = [] } = {}) {
  const out = BASE_IGNORE.map(e => ({ ...e })), seen = new Set(out.map(e => e.path));
  for (const e of [...configured, ...(Array.isArray(existing) ? existing : [])]) {
    if (!ignoreEntry(e) || seen.has(e.path)) continue;
    seen.add(e.path); out.push({ path: e.path, reason: e.reason });
  }
  return out;
}

/** A module file from the game's kit copy, else the kit source. */
const kitFile = (gameDir, rel) => { const g = join(gameDir, 'gf/three', rel); return existsSync(g) ? g : kitPath(KIT, rel); };

// the scenic-3d profile's look and world (CONTRACT §8): the game's gf/scenic copy, else runtimes/three/profiles/scenic-3d/kit
const scenicFile = (gameDir, rel) => { const g = join(gameDir, 'gf/scenic', rel); return existsSync(g) ? g : join(SCENIC_KIT, rel); };

// the forge runtime's look and world (CONTRACT §8 forge): the game's gf/forge copy, else runtimes/forge/kit
const forgeFile = (gameDir, rel) => { const g = join(gameDir, 'gf/forge', rel); return existsSync(g) ? g : join(FORGE_KIT, rel); };

// the vista runtime's declarations (CONTRACT §8 vista): the game's gf/vista/kit copy, else runtimes/vista/kit
const vistaFile = (gameDir, rel) => { const g = join(gameDir, 'gf/vista/kit', rel); return existsSync(g) ? g : join(VISTA_KIT, rel); };

async function provider(gameDir, rel, { scenic = false, forge = false, vista = false } = {}) {
  const mod = await importKitModule(vista ? vistaFile(gameDir, rel) : forge ? forgeFile(gameDir, rel) : scenic ? scenicFile(gameDir, rel) : kitFile(gameDir, rel));
  if (mod.error) throw new Error(`${rel}: could not be imported in Node (${mod.error.message}); a module must not touch the DOM at import`);
  return mod;
}
/** A kit module as this game carries it (its gf/three copy, else the kit source): a mechanic's manifest, for one. */
export const kitModule = (gameDir, rel) => provider(gameDir, rel);
// A module's declarations: slotsFor(<its own config>, ...extra) when it has one (look: config/look.json; world:
// config/world.json, the prop catalog and the library's licences; character: config/characters.json), else `slots`.
function fromModule(mod, own, ...extra) {
  if (typeof mod.slotsFor === 'function') return mod.slotsFor(own, ...extra) ?? [];
  if (Array.isArray(mod.slots)) return mod.slots;
  return [];
}

/** Fill {placeholders} in a template from vars (deep). Unknown placeholders are left and reported. */
export function fill(template, vars, missing = new Set()) {
  if (typeof template === 'string') return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k) => (k in vars ? String(vars[k]) : (missing.add(k), m)));
  if (Array.isArray(template)) return template.map(t => fill(t, vars, missing));
  if (template && typeof template === 'object') return Object.fromEntries(Object.entries(template).map(([k, v]) => [k, fill(v, vars, missing)]));
  return template;
}

const CONFIG_FILES = { 'config/game.json': 'game', 'config/look.json': 'look', 'config/world.json': 'world', 'config/characters.json': 'characters', 'config/props.json': 'catalog' };
function valueAt(cfg, source) {
  const doc = cfg[CONFIG_FILES[source.file]];
  if (!doc) return undefined;
  let v = doc;
  for (const k of source.pointer.split('/').slice(1).map(x => x.replace(/~1/g, '/').replace(/~0/g, '~'))) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
  return v;
}

/** The licences the world module's slots carry, in its own keys ({ files: { <catalog file>: …, 'textures/<file>': … } }),
 *  from the asset library: each catalog prop by its ref, each of the three runtime's pictures by its file name. */
function libraryLicences(catalog) {
  const files = {}, rec = l => ({ spdx: l.spdx, author: l.author, page: l.url, ...(l.credit ? { title: l.title, credit: l.credit, licenseUrl: l.licenseUrl, modified: l.modified } : {}) });
  for (const e of catalog?.props ?? []) { const a = e.ref ? findAsset(e.ref) : null; if (a) files[e.file] = rec(licenceOf(a)); }
  for (const a of assetsIn('three', { category: 'texture' })) files[`textures/${a.file}`] ??= rec(licenceOf(a));
  return { files };
}

export async function readConfig(gameDir) {
  const c = n => readJson(join(gameDir, `config/${n}.json`));
  const [game, look, world, characters] = await Promise.all([c('game'), c('look'), c('world'), c('characters')]);
  const record = existsSync(join(gameDir, 'gf-three.json')) ? await readJson(join(gameDir, 'gf-three.json')) : {};
  const catalog = existsSync(join(gameDir, 'config/props.json')) ? await readJson(join(gameDir, 'config/props.json')) : null;
  const licences = libraryLicences(catalog);
  const files = (await walk(join(gameDir, 'assets'))).map(r => `assets/${r}`);
  return { game, look, world, characters, record, files, catalog, licences };
}


/** ignore: the game's further ignore entries; left out, they are read from the assets.json the game already has. */
export async function assembleManifest(gameDir, { sounds = null, modules = null, ignore = undefined } = {}) {
  const cfg = await readConfig(gameDir);
  if (ignore === undefined) { try { ignore = (await readJson(join(gameDir, 'assets.json'))).ignore ?? []; } catch { ignore = []; } }
  const rec = cfg.record;
  const mods = modules ?? rec.modules ?? { look: false, world: false, character: false, mechanics: [] };
  cfg.propFiles = rec.props ?? {};
  const warnings = [];
  const slots = [];
  const push = (list, from) => { for (const s of list ?? []) slots.push({ ...s, __from: from }); };

  // mechanics with their own module declare their own slots; the rest get param slots from core
  cfg.mechanicSlots = new Set();
  const mechSlots = [], itemDecls = [];
  for (const [i, m] of (cfg.game.mechanics ?? []).entries()) {
    if (!mods.mechanics?.includes(m.id)) continue;
    const mod = await provider(gameDir, `mechanics/${m.id}/index.js`);
    // its things (kit/assets/items.js; manifest.items): indexed below, once every slot is known
    for (const it of Array.isArray(mod.manifest?.items) ? mod.manifest.items : []) itemDecls.push({ it, m, i });
    const templates = typeof mod.slotsFor === 'function' ? mod.slotsFor({ ...m, index: i, base: `/mechanics/${i}/params` }, cfg) : (mod.slots ?? []);
    if (!templates.length) continue;
    cfg.mechanicSlots.add(m.id);
    const missing = new Set();
    const vars = { ...(m.params ?? {}), id: m.id, i, index: i, base: `/mechanics/${i}/params`, as: m.as ?? m.id };
    for (const t of templates) { const s = fill(t, vars, missing); s.source ??= { file: 'config/game.json' }; s.source.file ??= 'config/game.json'; mechSlots.push(s); }
    if (missing.size) warnings.push(`mechanic ${m.id}: unfilled placeholders ${[...missing].join(', ')}`);
  }

  push((await provider(gameDir, 'ui/slots.js')).slotsFor(cfg), 'ui');
  const scenic = mods.runtime === 'three' && mods.profile === 'scenic-3d', forge = mods.runtime === 'forge', vista = mods.runtime === 'vista';
  if (vista) {
    // the vista runtime (CONTRACT §8 vista; gf/vista/kit/config.js): the bodies friends see, the seat colours and the clips;
    // the start places; the look values; every value of the data tables (config/game.json → vista)
    push((await provider(gameDir, 'config.js', { vista })).slotsFor(cfg), 'vista');
  } else if (forge) {
    // the forge runtime (CONTRACT §8 forge): its world and look modules, and the player bodies friends see (gf/forge/wear.js:
    // the seat colours, a player look (§6e); the co-op body, its clips, each held weapon)
    push(fromModule(await provider(gameDir, 'wear.js', { forge }), cfg), 'character');
    push(fromModule(await provider(gameDir, 'world.js', { forge }), cfg), 'world');
    push(fromModule(await provider(gameDir, 'look.js', { forge }), cfg), 'look');
    // the data tables (config/game.json → forge: player, physics, weapons, enemies, waves, cards): every value a slot
    if (cfg.game?.forge) push(fromModule(await provider(gameDir, 'tables/index.js', { forge }), cfg), 'tables');
  } else {
  // a flat (2D) game's look, world and picture bodies declare theirs in kit/flat/slots.js (the same three functions)
  const standins = await provider(gameDir, mods.flat ? 'flat/slots.js' : 'core/standins/slots.js');
  push(mods.character ? fromModule(await provider(gameDir, 'character/character.js'), cfg) : standins.characterSlots(cfg), 'character');   // track C's slotsFor takes {characters, …}
  // a voxel world (CONTRACT §9, worlds) is its own world module, whichever profile draws the rest
  if (cfg.world?.template === 'voxel') push(fromModule(await provider(gameDir, 'world/voxel/world.js'), cfg.world), 'world');
  else push(scenic || mods.world ? fromModule(await provider(gameDir, 'world/world.js', { scenic }), cfg.world, cfg.catalog, cfg.licences) : standins.worldSlots(cfg), 'world');
  push(scenic || mods.look ? fromModule(await provider(gameDir, 'look/look.js', { scenic }), cfg.look) : standins.lookSlots(cfg), 'look');
  }
  // the props the spec names are the game's own: main tier, with the game's description; a gameplay prop the world
  // does not place still needs its model slot
  // (rec.named: the spec's prop name → its slot id; scenery the world template brings stays advanced)
  const named = new Map(Object.values(rec.named ?? {}).map(id => [id.slice(5), { name: id.slice(5) }]));
  for (const p of cfg.game.props ?? []) named.set(p.name, p);
  // a mechanic's own prop (the pickup's coffee mug, an enemy prop) is the game's too, wherever its model came from
  for (const m of cfg.game.mechanics ?? []) { const n = m.params?.prop; if (typeof n === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(n) && !named.has(n)) named.set(n, { name: n }); }
  for (const s of slots) if (s.type === 'model' && s.id.startsWith('prop.') && named.has(s.id.slice(5))) { s.tier = 'main'; s.rank = 94; const d = named.get(s.id.slice(5)).describe; if (d) s.description = d; }
  for (const [n, p] of named) {
    if (slots.some(s => s.id === `prop.${n}`)) continue;
    const f = rec.props?.[n]?.file ?? `assets/models/${n}.glb`;
    if (!cfg.files.includes(f)) continue;
    slots.push({ id: `prop.${n}`, group: 'props', label: n.replace(/^./, c => c.toUpperCase()), type: 'model', source: { file: f }, constraints: { maxBytes: 8388608, scale: 1 }, tier: 'main', facet: 'look', rank: 94, __from: 'game',
      ...(p.describe ? { description: p.describe, generate: { prompt: p.describe, style: 'stylised low-poly game prop, soft colours, clean silhouette' } } : {}), ...(rec.props?.[n]?.license ? { license: rec.props[n].license } : {}) });
  }
  push((await provider(gameDir, 'core/slots.js')).slotsFor(cfg), 'core');
  push(mechSlots, 'mechanics');
  push((await provider(gameDir, 'controller/slots.js')).slotsFor(cfg), 'controller');
  // the optional kit modules this game carries (modules.extras; a folder with a module.js: kit/vfx/module.js documents
  // the contract): their slots, and their preview entries below. A new module needs no line here.
  const extraMods = [];
  if (!forge && !vista) for (const id of mods.extras ?? []) { const m = await provider(gameDir, `${id}/module.js`); extraMods.push(m); push(m.slotsFor?.(cfg), id); }

  // files under assets/ that no declaration covers still become slots (coverage rule 1)
  const covered = new Set(slots.map(s => s.source?.file));
  for (const f of cfg.files) {
    if (covered.has(f) || /\/(LICEN[CS]E|ATTRIBUTION|README)[^/]*$/i.test(f)) continue;
    const base = f.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
    const ext = f.split('.').pop().toLowerCase();
    const type = ['glb', 'gltf'].includes(ext) ? 'model' : ['ktx2', 'hdr'].includes(ext) ? 'texture' : ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'].includes(ext) ? 'image' : ['ogg', 'mp3', 'wav'].includes(ext) ? 'audio' : ['json', 'txt', 'csv'].includes(ext) ? 'data' : null;
    if (!type) { warnings.push(`${f}: not a slot type; left out`); continue; }
    const id = f.startsWith('assets/clips/') ? `character.clips.${base}` : `${type}.${base}`;
    slots.push({ id, group: f.startsWith('assets/clips/') ? 'characters' : 'models', label: base.replace(/[-_]+/g, ' ').replace(/^./, c => c.toUpperCase()), type, source: { file: f }, tier: 'advanced', rank: 5, __from: 'files',
      ...(f.startsWith('assets/clips/') ? { editable: false, readonlyReason: 'The shared animation clips every body plays; replaced as part of the character standard' } : {}) });
  }

  // one idea, one main slot: seat colours are character.tint.<role> (CONTRACT §2.2); the look's own player palette
  // only seeds them at create time, so it is not offered beside them
  if (slots.some(s => s.id.startsWith('character.tint.'))) for (const s of slots) if (s.id === 'look.palette.players') { s.tier = 'advanced'; s.rank = 5; s.description = 'The look preset\'s suggestion for player colours; the game uses "Player colours" (character.tint)'; }
  // slot ids are lowercase (gf-assets/1: ^[a-z0-9][a-z0-9_.-]{0,79}$); a module's camelCase id is turned to kebab case
  const ID = /^[a-z0-9][a-z0-9_.-]{0,79}$/, fixed = new Set();
  for (const s of slots) if (typeof s.id === 'string' && !ID.test(s.id)) {
    const id = s.id.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 80);
    fixed.add(`${s.__from}: ${s.id} → ${id}`); s.id = id;
  }
  if (fixed.size) warnings.push(`slot ids made lowercase (declare them so): ${[...fixed].slice(0, 6).join(', ')}${fixed.size > 6 ? ` and ${fixed.size - 6} more` : ''}`);
  // one slot per id (the first declaration wins)
  const seen = new Map(), out = [];
  for (const s of slots) {
    if (seen.has(s.id)) { warnings.push(`slot ${s.id} declared by ${seen.get(s.id)} and ${s.__from}; kept the first`); continue; }
    seen.set(s.id, s.__from); out.push(s);
  }
  // player looks (CONTRACT §6e): the kit's declarations mark the defaults (`scope: "player"`); config/game.json →
  // loadout: { slots: [ids a player's loadout may also set], off: [ids that stay the game's for everyone] }
  const lo = cfg.game.loadout && typeof cfg.game.loadout === 'object' ? cfg.game.loadout : {};
  const loAdd = new Set(Array.isArray(lo.slots) ? lo.slots : []), loOff = new Set(Array.isArray(lo.off) ? lo.off : []);
  for (const s of out) {
    if (loOff.has(s.id)) delete s.scope;
    else if (loAdd.has(s.id)) { if (['text', 'json'].includes(s.type)) warnings.push(`config/game.json loadout.slots: ${s.id} is a ${s.type} slot; text and JSON are never part of a look`); else s.scope = 'player'; }
  }
  for (const id of [...loAdd, ...loOff]) if (!seen.has(id)) warnings.push(`config/game.json loadout: there is no slot "${id}"`);
  // main tier within MAIN_MAX, by rank
  const main = out.filter(s => (s.tier ?? 'main') === 'main').sort((a, b) => (b.rank ?? 50) - (a.rank ?? 50));
  for (const s of main.slice(MAIN_MAX)) s.tier = 'advanced';
  const groupIds = GROUPS.map(g => g[0]);
  const finalSlots = out.map(({ __from, rank, ...s }) => {
    // a declared range must hold the slot's own value (a module's generic range can miss a negative default)
    if ((s.type === 'number' || s.type === 'integer') && s.source?.pointer && s.constraints) {
      const v = valueAt(cfg, s.source);
      if (typeof v === 'number') {
        if (typeof s.constraints.min === 'number' && v < s.constraints.min) { warnings.push(`slot ${s.id}: value ${v} is under its declared min ${s.constraints.min}; min widened`); s.constraints = { ...s.constraints, min: v }; }
        if (typeof s.constraints.max === 'number' && v > s.constraints.max) { warnings.push(`slot ${s.id}: value ${v} is over its declared max ${s.constraints.max}; max widened`); s.constraints = { ...s.constraints, max: v }; }
      }
    }
    if (!groupIds.includes(s.group)) { warnings.push(`slot ${s.id}: group "${s.group}" is not a kit group; put in "models"`); s.group = 'models'; }
    if (s.tier === undefined) s.tier = 'main';
    for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
    return s;
  }).sort((a, b) => groupIds.indexOf(a.group) - groupIds.indexOf(b.group));
  const used = new Set(finalSlots.map(s => s.group));

  const roles = Object.keys(cfg.characters.roles ?? {});
  // the game's own props (scenery has no preview view of its own), else, for a game that names none (a scenic game's
  // generated world is all scenery), its first few scenery props, so Studio can show one and verify check 8 can swap one
  const ownProps = [...named.keys()].filter(n => seen.has(`prop.${n}`));
  const propNames = ownProps.length ? ownProps : finalSlots.filter(s => s.type === 'model' && s.id.startsWith('prop.') && !s.id.slice(5).includes('.')).slice(0, 4).map(s => s.id.slice(5));
  const has = id => seen.has(id);
  const showcase = vista ? [
    // a vista game's preview subjects: the island behind no menu, and the same view for its look (gf/three/core/boot-vista.js)
    { id: 'world', label: 'The island', query: '?gf-show=world', groups: ['world'] },
    { id: 'look', label: 'Look and light', query: '?gf-show=look', groups: ['look'] },
  ] : [
    ...roles.map(r => ({ id: `character.${r}`, label: r === 'player' ? 'Player character' : `${r} character`, query: `?gf-show=character.${r}`, slots: [`character.body.${r}`, `character.tint.${r}`, `character.height.${r}`].filter(has) })),
    ...propNames.map(n => ({ id: `prop.${n}`, label: n.replace(/^./, c => c.toUpperCase()), query: `?gf-show=prop.${n}`, slots: [`prop.${n}`, `prop.${n}.size`].filter(has) })),
    ...extraMods.flatMap(m => m.showcase?.(cfg, has) ?? []),
    { id: 'world', label: 'The world', query: '?gf-show=world', groups: ['world'] },
    { id: 'look', label: 'Look and light', query: '?gf-show=look', groups: ['look'] },
  ];

  // the game's items (open builder wave 10): each mechanic's things, from its own manifest, as slot ids, so a page lists
  // and edits them with no list of mechanics of its own. A table is its json slot (its constraints.item says what one
  // entry is); a single item is the mechanic's own params, each field the slot that points at it.
  const byPointer = new Map(finalSlots.filter(s => s.source?.file === 'config/game.json' && s.source.pointer).map(s => [s.source.pointer, s.id]));
  const items = [];
  for (const { it, m, i } of itemDecls) {
    const base = { mechanic: m.id, ...(m.as ? { as: m.as } : {}), noun: it.noun, ...(it.nouns ? { nouns: it.nouns } : {}) };
    if (it.single) {
      const sid = k => byPointer.get(`/mechanics/${i}/params/${k}`);
      let picture = null;
      try { picture = typeof it.picture === 'function' ? it.picture(m.params ?? {}, cfg.game, has) : it.picture ?? null; } catch {}
      items.push({ ...base, single: true, picture: picture && has(picture) ? picture : null, fields: (it.fields ?? []).map(sid).filter(Boolean), front: (it.front ?? []).map(sid).filter(Boolean) });
    } else {
      const slot = byPointer.get(`/mechanics/${i}/params/${it.key}`);
      if (slot) items.push({ ...base, table: slot });
    }
  }

  const manifest = {
    schema: 'gf-assets/1',
    game: rec.game ?? 'gf-three-game',
    title: cfg.game.text?.title ?? cfg.game.title ?? 'A gf-three game',
    editing: 'live',
    groups: GROUPS.filter(([id]) => used.has(id)).map(([id, label]) => ({ id, label })),
    showcase,
    slots: finalSlots,
    ...(items.length ? { items } : {}),
    sounds: sounds ?? { version: 1, sounds: {} },
    ...(cfg.catalog ? { embed: [{ path: 'config/props.json', reason: 'the prop catalog entries the world module reads (sizes, colliders, materials)' }] } : {}),
    // a forge game draws only with WebGPU (CONTRACT §8 forge): capture, the gates and the worker's play-tests need an adapter
    // so does a vista game (CONTRACT §8 vista: WebGPU only)
    ...(forge || vista ? { runtime: { gpu: 'webgpu' } } : {}),
    check: {
      steps: [{ waitFor: "window.__game && window.__game.phase === 'lobby'", timeout: 90000 }, { wait: 500 }],
      play: { steps: [{ clickSelector: '#gf-play' }, { wait: 4500 }, { hold: 'KeyW', ms: 1200 }, { key: 'KeyE' }, { click: 'centre' }, { wait: 800 }], avoidKeys: [] },
    },
    ignore: mergeIgnore({ configured: configuredIgnore(), existing: ignore }),
  };
  return { manifest, warnings, mainCount: finalSlots.filter(s => s.tier === 'main').length, slotCount: finalSlots.length };
}
