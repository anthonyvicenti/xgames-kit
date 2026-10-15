#!/usr/bin/env node
// The kit's parts, as a build reads them: beside the registry (registry/catalog.json: which runtimes, profiles, loops,
// mechanics and kinds exist, are tested and are open, and the runtime x kind matrix), what each part offers in detail.
//
//   node builder/tools/catalog.mjs [--json] [--runtime three/standard-3d | three/scenic-3d | three/flat-2d | forge | vista]
//
// loops      the registry's loops (loops/<id>/loop.json), each with the flow part that plays it on three (loops/<id>/index.js)
// mechanics  components/<id>/index.js: id, `examples` (the `as` lines), the params JSON Schema, needs, owns, events
// worlds     the world module's templates (kit/world/templates/*.json recipes, expanded by kit/world/generate.js): label,
//            describe, indoor or outdoor, the set-pieces, and per size class (spec world.size) the footprint, rooms or
//            areas, entries (where enemies come in) and zones
// bodies     the asset library's bodies in the three runtime's packs (runtimes/three/art.json), then the scenic-3d
//            profile's (marked library: 'scenic-3d'); any game may wear any of them (builder/art/views.mjs)
// looks      the look module's presets (id, label, describe), else the stand-in presets
// props      the asset library's props in the three runtime's packs (id, describe, tags, size), then the scenic
//            profile's (weapons, dungeon pieces)
// clips      the character module's CLIPS
// tables     forge's and vista's data tables (spec.tables): what each table runs today
// Each world and look names its `runtime` (and `profile`); --runtime keeps one row's. Nothing here says whether a part
// is open to pitches: the registry does.
import { isMain } from './lib/main.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetsIn, bodiesIn, propEntry } from '../art/views.mjs';
import { KIT, KIT_VERSION, SCENIC_KIT, FORGE_KIT, VISTA_KIT, kitPath } from './lib/paths.mjs';
import { readCatalog } from './lib/spec.mjs';
import { importKitModule } from './lib/kit-import.mjs';
import { withDefaults } from './lib/schema.mjs';
import { kitModuleFiles } from './lib/vendor.mjs';
import { FAIR_DEFAULTS } from '../../runtimes/three/kit/core/fair-logic.js';

// What fair play does for every game (kit/core/fair.js, CONTRACT §6c); pitch and build agents read it here.
const FAIR_DESCRIBE = [
  'a knock takes a player out of control for downSeconds at most (tumble and get-up included)',
  'nobody can hurt, knock or score on a player who is down or out',
  'protectSeconds of protection after getting up or respawning (the body shimmers)',
  'startGrace seconds after Go with no hits; bots hold fire',
  'streams and contact damage push, never knock over; discrete hits and splashes knock',
  'bots pick targets that can be hit, spread out (botsPerTarget), react and aim like people (botSkill); respawn far from others',
];

// How a pitch picks bodies (characters[].body is a fill: {from: kind | library | provided | generate | reference}; the
// creator, 2026-10-07: "I am not sure if we should always make the players the same looking blobs").
const BODY_GUIDE = [
  '* the creator attached an image and asks for a character to look like it: that role is {from: "reference", reference: <revisionId>}; describe keeps outfit, accessories, colours, proportions and art style; no caricature of a group, and an enemy horde is not defined by an ethnic group',
  'players: {from: "kind"} gives the kind\'s body set (a bean for silly); otherwise a library body whose tags fit the theme, {from: "library", asset: "<pack>/<asset>"} (tagged "player"; playerColour: true gives each seat its own colour), or {from: "generate", prompt}',
  '* a bean player beside a non-bean enemy or NPC says why in body.why',
  '* every role has its own body (two roles on one bean or one library body look identical)',
  'enemies and NPCs: a library body tagged "enemy" or matching the theme, else generate or reference',
  'bodies differ in silhouette, not only colour: pick a different build or height for the enemies than for the players',
];

// ---------------------------------------------------------------------------------------------------------------------
// Parts carry their own (open builder M2-B). A mechanic is one folder, kit/mechanics/<id>/, and everything the tools
// know about it is `export const manifest` in its index.js: adding a mechanic adds a folder and changes no tool.
// The shape follows GDevelop's behaviour declarations (research/open-builder/findings/gdevelop-behaviours-2026-10-10.md):
// needs as parts and capabilities, a resource a part claims in place of a hand-written conflicts list, the state a
// check reads derived from the part's own declaration.
// ---------------------------------------------------------------------------------------------------------------------
export const MANIFEST = {
  id: 'the folder\'s name', examples: 'the `as` lines a pitch may use', params: 'JSON Schema of config/game.json → mechanics[…].params, with defaults',
  describe: 'one line for the catalog', rank: '(optional) where the catalog lists it: lower first; a part without one comes after, by id',
  needs: '{parts: [{id, why}], world: [{id, why}]} or params => that: other mechanics and world capabilities it cannot work without; create refuses a spec that lacks one, with the why',
  uses: 'mechanics it works with when the game has them (never refused)',
  owns: 'params => [{res, why, free, shared?}]: the resources it claims (input.<action>, player.socket.<name>, player.control, round.end, hud.scoreboard); create refuses two owners of one resource unless every claim on it is shared, and says how each lets go (free)',
  state: '{key, fields}: its key in window.__game.snapshot().shared (null when it keeps none) and how to read each field',
  events: '[{name, on, args, when, quiet?, play?}]: the callbacks rules.js can hook, who hears them and with what. The kit\'s event log (kit/core/events.js) records each one, and verify gate C (measure 38) looks for its answer on the screen of every player it names; quiet: true when nothing on screen answers it by itself (fair play refusing a hit); play: what it is in play (score, hit, knockout, pickup, goal, death, combo, move, tag, blast, attempt) for the play feed (kit/core/play.js)',
  sync: '{owner: host | copy | none, how}: which copy decides',
  note: 'at most three lines for the build agent, read only by builds whose spec uses the part',
  stub: '{as, worked, traps}: its variable in rules.js, one worked line, its own traps; create writes rules.js from these and `events`',
  asks: '(optional) [{about: "body" | "together", why}]: what a pitch must ask the creator when their words do not settle it and a card uses this part (a board with no player body asks how each player is shown); held by the pitch step (loop/pitch-rules.mjs), never by a build',
  holds: '(optional) [{when: {param: value}, as: "mark" | "board", why}]: when the player acts through this part all round and never as a walking body (a board played from the seats: mark; a board of one\'s own: board), so friends are seen by the kit\'s presence part (gf/mp/presence.js shapeOf: seats or boards); create writes the shape, gate E holds it',
  signs: '{sample: (shared, stats) => {key: compact} | null, judge: view => void, reportOnly?}: verify check 15\'s sign of life. sample runs in the page 4 times a second (an arrow function that uses nothing outside itself); judge reads the samples in Node and adds its items',
  counters: '(optional) (api, ctx) => [[playerId, number]]: a number it keeps per player that a score may follow (paint\'s share, tag\'s whole seconds as it). The kit\'s event log (kit/core/events.js) samples it ten times a second, and verify gate D counts a change of it as a counted event of that player, as it counts the part\'s events',
  items: '(optional) [declaration]: its things as data (kit/assets/items.js; open builder wave 10). A table: {key (the param holding the list), noun, nouns, min, max, id, name, schema (JSON Schema of ONE entry: each field\'s title, type, minimum, maximum, unit, default), front (the fields a card shows first), picture: {field, file, slot, library}, defaults: {<profile>: rows} (standard-3d, scenic-3d)}; its slot mechanic.<id>.<key> is a json slot carrying the declaration. A single item: {single: true, noun, fields: [param keys], front, picture: params => slot id}',
};
// Where a mechanic or a flow runs is not the module's to say: its registry manifest's impl (components/<id>/mechanic.json,
// loops/<id>/loop.json) says it per runtime and profile, and the registry's checkSpec holds a spec to it.
const RESOURCE_RE = /^(input\.(key\.)?[A-Za-z0-9]+|player\.socket\.[a-z_]+|player\.control|round\.end|hud\.[a-z]+)$/;

/** The mechanic folders of a kit: every kit/mechanics/<id>/index.js, sorted. */
export async function mechanicIds(kit = KIT) {
  const dir = kitPath(kit, 'mechanics');
  if (!existsSync(dir)) return [];
  return (await readdir(dir, { withFileTypes: true })).filter(e => e.isDirectory() && /^[a-z0-9-]+$/.test(e.name) && existsSync(join(dir, e.name, 'index.js'))).map(e => e.name).sort();
}

/** What is wrong with a manifest's shape (empty when it is whole). */
export function manifestProblems(id, m) {
  const bad = [], isFn = f => typeof f === 'function', lines = a => Array.isArray(a) && a.every(s => typeof s === 'string' && s.trim());
  if (!m || typeof m !== 'object') return [`mechanic ${id}: index.js exports no manifest`];
  if (m.id !== id) bad.push(`manifest.id is "${m.id}", the folder is "${id}"`);
  if (typeof m.describe !== 'string' || !m.describe.trim()) bad.push('describe: one line');
  if (!(isFn(m.needs) || (m.needs && typeof m.needs === 'object'))) bad.push('needs: {parts, world} or params => that');
  if (!Array.isArray(m.uses)) bad.push('uses: a list of mechanic ids');
  if (!isFn(m.owns)) bad.push('owns: params => [{res, why, free}]');
  if (!m.state || typeof m.state !== 'object' || !('key' in m.state) || typeof m.state.fields !== 'object') bad.push('state: {key, fields}');
  if (!Array.isArray(m.events) || m.events.some(e => !/^on[A-Z]\w*$/.test(e?.name ?? '') || !e.on || typeof e.args !== 'string')) bad.push('events: [{name: "onX", on, args, when}]');
  if (!['host', 'copy', 'none'].includes(m.sync?.owner) || typeof m.sync?.how !== 'string') bad.push('sync: {owner: host | copy | none, how}');
  if (!lines(m.note) || m.note.length < 1 || m.note.length > 3) bad.push('note: one to three lines');
  if (!/^[a-z][A-Za-z0-9]*$/.test(m.stub?.as ?? '') || typeof m.stub?.worked !== 'string' || /\n/.test(m.stub.worked) || !lines(m.stub?.traps) || !m.stub.traps.length) bad.push('stub: {as, worked (one line), traps}');
  if (!isFn(m.signs?.sample) || !isFn(m.signs?.judge)) bad.push('signs: {sample, judge}');
  else { try { new Function(`return (${m.signs.sample.toString()});`); } catch { bad.push('signs.sample: an arrow function that stands alone (it is sent to the page as text)'); } }
  if (m.counters !== undefined && !isFn(m.counters)) bad.push('counters: (api, ctx) => [[playerId, number]]');
  if (m.items !== undefined) for (const [k, it] of (Array.isArray(m.items) ? m.items : [null]).entries()) {
    const at = `items[${k}]`;
    if (!it || typeof it !== 'object' || typeof it.noun !== 'string') { bad.push(`${at}: {noun, ...}`); continue; }
    if (it.single) { if (!Array.isArray(it.fields) || it.fields.some(f => !(f in (m.params?.properties ?? {})))) bad.push(`${at}.fields: param keys of this mechanic`); continue; }
    if (typeof it.key !== 'string' || !m.params?.properties?.[it.key]) bad.push(`${at}.key: the param that holds the table`);
    if (!it.schema || typeof it.schema !== 'object') bad.push(`${at}.schema: the JSON Schema of one entry`);
    if (it.front !== undefined && !Array.isArray(it.front)) bad.push(`${at}.front: a list of fields`);
  }
  if (isFn(m.owns) && m.params) { try { for (const o of m.owns(withDefaults(m.params, {})) ?? []) if (!RESOURCE_RE.test(o?.res ?? '') || !o.why || !o.free) bad.push(`owns: "${o?.res}" needs a known resource name, why and free`); } catch (e) { bad.push(`owns throws: ${e.message}`); } }
  return bad.map(b => `mechanic ${id}: manifest ${b}`);
}

/**
 * Every mechanic of a kit with its module and manifest: [{id, status, module, manifest, problems}]. status is 'ready',
 * or why it is not (does not import; no manifest; the manifest's faults). `kit` is a kit folder (the default is this one).
 */
export async function mechanicParts({ kit = KIT } = {}) {
  const out = [];
  for (const id of await mechanicIds(kit)) {
    const m = await importKitModule(kitPath(kit, `mechanics/${id}/index.js`));
    if (m.error) { out.push({ id, status: `module does not import: ${m.error.message.split('\n')[0]}`, module: null, manifest: null, problems: [] }); continue; }
    const problems = m.manifest ? manifestProblems(id, m.manifest) : [];
    out.push({ id, status: typeof m.create !== 'function' || m.id !== id ? 'lacks id/create' : !m.manifest ? 'ready (no manifest: create composes it unchecked and check 15 has no sign for it)' : problems.length ? `manifest: ${problems.join('; ')}` : 'ready', module: m, manifest: m.manifest ?? null, problems });
  }
  const rank = p => (Number.isFinite(p.manifest?.rank) ? p.manifest.rank : Infinity);
  return out.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
}

/** A part's needs and claims for one game's params (defaults filled): {needs: {parts, world}, owns: [{res, why, free, shared}]}. */
export function partFor(part, params = {}) {
  const m = part?.manifest; if (!m) return { needs: { parts: [], world: [] }, owns: [] };
  const p = withDefaults(m.params ?? part.module?.params ?? {}, params ?? {});
  const needs = typeof m.needs === 'function' ? m.needs(p) : m.needs ?? {};
  const norm = l => (l ?? []).map(x => (typeof x === 'string' ? { id: x, why: '' } : x));
  return { needs: { parts: norm(needs.parts), world: norm(needs.world) }, owns: (m.owns?.(p) ?? []).map(o => ({ shared: false, ...o })) };
}

/**
 * Does this set of mechanics compose? spec.mechanics ([{id, params}]) against the parts' manifests and what the world
 * provides (a list of capabilities, or null when the world is not known: then no world need is judged). Where each one
 * runs is the registry's (checkSpec). → the refusals, each with its cause and the way out. A mechanic without a
 * manifest is not judged.
 */
export function composeProblems(mechanics = [], parts = [], { world = null, worldId = '' } = {}) {
  const byId = new Map(parts.map(p => [p.id, p])), ids = new Set(mechanics.map(m => m.id)), out = [], claims = new Map();
  for (const m of mechanics) {
    const part = byId.get(m.id); if (!part?.manifest) continue;
    const man = part.manifest, f = partFor(part, m.params);
    for (const n of f.needs.parts) if (!ids.has(n.id)) out.push(`mechanics: "${m.id}" needs the "${n.id}" mechanic${n.why ? ` (${n.why})` : ''}: add {"id": "${n.id}"} to mechanics, or change ${m.id}'s params`);
    if (world) for (const n of f.needs.world) if (!world.includes(n.id)) out.push(`mechanics: "${m.id}" needs a world that provides "${n.id}"${n.why ? ` (${n.why})` : ''}, and world.template "${worldId}" provides ${world.length ? world.join(', ') : 'none of the capabilities it lists'}: pick a world that does, or leave ${m.id} out`);
    for (const o of f.owns) { if (!claims.has(o.res)) claims.set(o.res, []); if (!claims.get(o.res).some(c => c.id === m.id)) claims.get(o.res).push({ id: m.id, ...o }); }
  }
  for (const [res, list] of claims) {
    if (list.length < 2 || list.every(c => c.shared)) continue;
    out.push(`mechanics: ${list.map(c => `"${c.id}"`).join(' and ')} both own ${res} (${list.map(c => `${c.id}: ${c.why}`).join('; ')}). One must let go: ${list.map(c => `${c.id}: ${c.free}`).join('; or ')}`);
  }
  return out;
}

/** A part as the catalog lists it (JSON): the manifest without its functions; needs and owns at the default params. */
function partEntry(part) {
  const m = part.manifest, mod = part.module;
  const base = { id: part.id, status: part.status, describe: m?.describe ?? mod?.describe ?? '', examples: m?.examples ?? mod?.examples ?? [], params: summarizeParams(m?.params ?? mod?.params) };
  if (!m) return base;
  const f = partFor(part, {});
  return { ...base, needs: f.needs, uses: m.uses ?? [], owns: f.owns.map(o => ({ res: o.res, ...(o.shared ? { shared: true } : {}), why: o.why, free: o.free })),
    state: { key: m.state?.key ?? null, fields: m.state?.fields ?? {}, ...(m.state?.stats ? { stats: m.state.stats } : {}) }, events: m.events ?? [], sync: m.sync ?? null, note: m.note ?? [],
    stub: m.stub ?? null, ...(Array.isArray(m.asks) && m.asks.length ? { asks: m.asks } : {}), sign: typeof m.signs?.judge === 'function' ? (m.signs.reportOnly ? 'reported' : 'checked') : 'none' };
}

/**
 * What each world template provides to the mechanics (its capabilities): the standard-3d recipes' zones and entries
 * (read from the recipe itself, worlds/templates/<id>.json, expanded), the voxel world's `voxel`, a scenic-3d template's
 * own templateInfo (runtimes/three/profiles/scenic-3d/kit/world/generate.js). → { id: {profile, provides: [capability]} }
 */
export async function worldParts({ kit = KIT, scenicKit = SCENIC_KIT } = {}) {
  const out = {};
  const tdir = kitPath(kit, 'world/templates');
  if (existsSync(tdir)) {
    const gen = await importKitModule(kitPath(kit, 'world/generate.js'));
    for (const f of (await readdir(tdir)).filter(x => x.endsWith('.json')).sort()) {
      const t = await readJson(join(tdir, f)); if (!t || gen.error) continue;
      const L = gen.generateLayout(t, { size: 'small' });
      out[t.template ?? f.replace(/\.json$/, '')] = { profile: 'standard-3d', provides: [...Object.keys(L.zones ?? {}).map(z => `zone:${z}`), ...((L.entries ?? []).length ? ['entries'] : []), ...((L.rooms ?? []).length ? ['rooms'] : [])] };
    }
  }
  if (existsSync(kitPath(kit, 'world/voxel/default.json'))) out.voxel = { profile: 'standard-3d', provides: ['voxel'] };
  if (existsSync(kitPath(kit, 'world/terrain/default.json'))) out.terrain = { profile: 'standard-3d', provides: ['terrain', 'zone:centre'] };
  const sw = existsSync(join(scenicKit, 'world/generate.js')) ? await importKitModule(join(scenicKit, 'world/generate.js')) : null;
  if (sw && !sw.error) for (const id of sw.templates ?? []) out[id] = { profile: 'scenic-3d', provides: sw.templateInfo?.[id]?.provides ?? [] };
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Loops: how a game is played, by who acts when. Which loops exist and where each is open is the registry's
// (loops/<id>/loop.json); on three a loop is played by a flow part (loops/<id>/index.js with a manifest, LOOP_MANIFEST
// below), the timed round's for round and run, none for a world (a mode of the session).
// ---------------------------------------------------------------------------------------------------------------------
const flowPart = (kit, id) => existsSync(kitPath(kit, 'loops', id, 'index.js'));

// A flow carries its own, like a mechanic (MANIFEST above), in kit/loops/<id>/index.js → `export const manifest`.
export const LOOP_MANIFEST = {
  id: 'the folder\'s name', params: 'JSON Schema of config/game.json → round.params (spec.round.params), with defaults; each is a round.* value slot',
  describe: 'one line for the catalog',
  seconds: '"required" (round.seconds is the length of a round) or "cap" (round.seconds is optional: a cap on the whole session)',
  seats: '{alone: "fill" | "min", late: "join" | "wait", why}: how many bots play with one person (every seat up to players.max, or the fewest the game needs: players.min - 1), and what happens to a seat that arrives mid-game',
  needs: '{parts: [{id, why}], world: [{id, why}]}: mechanics and world capabilities it cannot work without',
  uses: '(optional) mechanics it joins when the game has them (turns joins a board: kit/loops/turns/board.js)',
  refuse: '(optional) spec => [reason with the way out]: what create refuses in a spec on this loop (two owners of one clock)',
  state: '{key, fields}: its key in window.__game.snapshot().shared (null when it keeps none) and how to read each field',
  events: '[{name, on, args, when}]: the rules.js hooks it calls (a hook\'s name, not onX: they are hooks of the rules object)',
  sync: '{owner: host | copy | none, how}: which copy decides',
  note: 'at most three lines for the build agent, read only by builds whose spec uses the loop',
  stub: 'null (the six hooks every rules.js has are its own), or {as, worked, traps, joined?}: (joined: the one line the stub carries instead when the spec has a mechanic the flow `uses`) ctx.<as> in rules.js, one worked line, its own traps; create writes its hooks into rules.js from these and `events`',
  signs: '{sample, judge}: verify check 15\'s sign of life, as a mechanic\'s; pulse: null or {what, min, of: snapshot => number, fix}: what "something happens" is for check 12 (null: a score that moves); pressed: (before, after) => boolean, optional: what a press that reached the flow looks like, for check 13 when no mechanic exposes anything to walk to; short: seconds => [patch]: what a check changes beside round.seconds for its short run',
};
/** What is wrong with a flow manifest's shape (empty when it is whole). */
export function flowProblems(id, m) {
  const bad = [], isFn = f => typeof f === 'function', lines = a => Array.isArray(a) && a.every(x => typeof x === 'string' && x.trim());
  if (!m || typeof m !== 'object') return [`loop ${id}: index.js exports no manifest`];
  if (m.id !== id) bad.push(`manifest.id is "${m.id}", the folder is "${id}"`);
  if (typeof m.describe !== 'string' || !m.describe.trim()) bad.push('describe: one line');
  if (!['required', 'cap'].includes(m.seconds)) bad.push('seconds: "required" or "cap"');
  if (!['fill', 'min'].includes(m.seats?.alone) || !['join', 'wait'].includes(m.seats?.late) || typeof m.seats?.why !== 'string') bad.push('seats: {alone: fill | min, late: join | wait, why}');
  if (!m.needs || typeof m.needs !== 'object') bad.push('needs: {parts, world}');
  if (!m.state || typeof m.state !== 'object' || !('key' in m.state) || typeof m.state.fields !== 'object') bad.push('state: {key, fields}');
  if (!Array.isArray(m.events) || m.events.some(e => !/^[a-z]\w*$/.test(e?.name ?? '') || !e.on || typeof e.args !== 'string')) bad.push('events: [{name: a rules hook, on, args, when}]');
  if (!['host', 'copy', 'none'].includes(m.sync?.owner) || typeof m.sync?.how !== 'string') bad.push('sync: {owner: host | copy | none, how}');
  if (!lines(m.note) || m.note.length < 1 || m.note.length > 3) bad.push('note: one to three lines');
  if (m.stub !== null && (!/^[a-z][A-Za-z0-9]*$/.test(m.stub?.as ?? '') || typeof m.stub?.worked !== 'string' || /\n/.test(m.stub.worked) || !lines(m.stub?.traps) || !m.stub.traps.length)) bad.push('stub: null, or {as, worked (one line), traps}');
  if (!isFn(m.signs?.sample) || !isFn(m.signs?.judge)) bad.push('signs: {sample, judge}');
  else { try { new Function(`return (${m.signs.sample.toString()});`); } catch { bad.push('signs.sample: an arrow function that stands alone (it is sent to the page as text)'); } }
  if (m.signs && m.signs.pulse != null && (!isFn(m.signs.pulse.of) || !Number.isFinite(m.signs.pulse.min) || typeof m.signs.pulse.what !== 'string' || typeof m.signs.pulse.fix !== 'string')) bad.push('signs.pulse: null, or {what, min, of, fix}');
  if (m.signs && !isFn(m.signs.short)) bad.push('signs.short: seconds => [patch]');
  if (m.signs?.pressed != null && !isFn(m.signs.pressed)) bad.push('signs.pressed: (before, after) => boolean');
  return bad.map(b => `loop ${id}: manifest ${b}`);
}
/** The flow folders of a kit: every kit/loops/<id>/index.js, with its module and manifest: [{id, status, module, manifest, problems}]. */
export async function flowParts({ kit = KIT } = {}) {
  const dir = kitPath(kit, 'loops'), out = [];
  if (!existsSync(dir)) return out;
  for (const e of (await readdir(dir, { withFileTypes: true })).filter(x => x.isDirectory() && /^[a-z0-9-]+$/.test(x.name) && flowPart(kit, x.name)).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const m = await importKitModule(join(dir, e.name, 'index.js'));
    if (m.error) { out.push({ id: e.name, status: `module does not import: ${m.error.message.split('\n')[0]}`, module: null, manifest: null, problems: [] }); continue; }
    const problems = flowProblems(e.name, m.manifest);
    out.push({ id: e.name, status: typeof m.create !== 'function' || m.id !== e.name ? 'lacks id/create' : problems.length ? `manifest: ${problems.join('; ')}` : 'ready', module: m, manifest: m.manifest ?? null, problems });
  }
  return out;
}
/** The flow a loop is played by: its own part, the timed round's (round, run), or none (a world is a mode of the session). */
export const flowOf = loop => (loop === 'world' ? null : loop === 'run' || loop == null ? 'round' : loop);
/** A flow part as the catalog lists it (JSON): the manifest without its functions. */
function flowEntry(part) {
  const m = part?.manifest; if (!m) return null;
  return { id: part.id, params: summarizeParams(m.params), seconds: m.seconds, seats: m.seats, needs: m.needs, state: m.state, events: m.events, sync: m.sync, note: m.note, stub: m.stub,
    sign: { alive: 'checked', pulse: m.signs?.pulse ? m.signs.pulse.what : 'a score that moves', pressed: typeof m.signs?.pressed === 'function' ? 'the flow\'s own' : 'any change of state' } };
}
/**
 * The loops, as the registry lists them (loops/<id>/loop.json), each with the flow part that plays it on three:
 * [{id, label, status, describe, pick, acts, clock, runtimes, flow, part}]. status: 'ready' when it exists and is open on
 * some runtime, else 'planned' with the registry's note. `runtimes`: where it is open ('three/standard-3d', 'forge', …).
 */
export async function loopParts({ kit = KIT, flows = null } = {}) {
  const F = flows ?? await flowParts({ kit }), reg = await readCatalog();
  return reg.loops.map(l => {
    const open = Object.entries(l.impl ?? {}).filter(([, v]) => v.state?.open).flatMap(([rt, v]) => (v.profiles?.length ? v.profiles.map(p => `${rt}/${p}`) : [rt]));
    const flow = l.state?.exists ? flowOf(l.id) : null, part = flow ? F.find(f => f.id === flow && f.manifest) ?? null : null;
    return { id: l.id, label: l.name ?? l.id, status: l.state?.exists && open.length ? 'ready' : `planned${l.state?.note ? ` (${l.state.note})` : ''}`, describe: l.describe, ...(l.pick ? { pick: l.pick } : {}), acts: l.acts, clock: l.clock, runtimes: open,
      ...(flow && part ? { flow, part: flowEntry(part) } : {}) };
  });
}

// The scenic worlds in words, for a scenic kit whose world module does not describe its own yet (templateInfo in
// runtimes/three/profiles/scenic-3d/kit/world/generate.js, which the catalog reads first).
const SCENIC_WORLDS = {
  island: { label: 'Island', describe: 'one island in the sea: cliffs, grass, trees, paths and water round it' },
  isles: { label: 'Floating isles', describe: 'floating islands over a void, one per level, joined by portals; cliff skirts below' },
  ruins: { label: 'Ruins', describe: 'a stone arena among ruins and trees' },
  dungeon: { label: 'Dungeon', describe: 'rooms joined by doors, one room set per level' },
};
// The forge world in words (runtimes/forge/kit/world.js), until it describes its own.
const FORGE_WORLDS = {
  'crypt-room': { label: 'Crypt room', kind: 'indoor', describe: 'a torch-lit stone room of KayKit dungeon pieces (3, 4 or 5 tiles of 3 m a side by size), barrels and crates, the spec\'s own props by the far wall' },
  'ruins-arena': { label: 'Ruins arena', kind: 'outdoor', describe: 'a moonlit ruined courtyard generated from world.seed (8, 10 or 12 tiles of 3 m a side by size): broken walls and a gate, braziers and torches, cover between a stone plaza and the walls, graves enemies rise from, dead trees past the walls; the spec\'s own props round the plaza' },
  'town-street': { label: 'Town street', kind: 'outdoor', describe: 'a gaslit old-town street at night generated from world.seed: wet cobbles 9 m wide and 30, 36 or 42 m long that open into a small square at the middle (21 by 12, 27 by 18 or 33 by 18 m), timber-framed and brick house fronts on both sides with lit windows and shop signs, gas lamps, four side alleys, a barricade at one end and iron railings in fog at the other, roofs and a church tower past the houses; carts, barrels, crates and a market stall for cover; enemies come up from cellar hatches and street drains. The thing to guard stands in the middle of the square: name it "pump" for the town pump' },
};
const FORGE_LOOKS = {
  'moonlit-ruins': { label: 'Moonlit ruins', describe: 'a cold moon with shadows, teal fog, warm fires and bloom, square texels and grain: the ruins arena\'s look' },
  'ember-crypt': { label: 'Ember crypt', describe: 'dark red fog and red-orange fire light: the crypt room\'s look' },
  'ash-storm': { label: 'Ash storm', describe: 'a dim sun through falling ash, thick warm fog' },
  'gaslit-street': { label: 'Gaslit street', describe: 'warm, nearly steady gas light in pools on wet cobbles under a cold high moon, slate-blue fog that thins the far end of a street, lit windows that glow, square texels and grain: the town street\'s look' },
};
const readJson = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };
const summarizeParams = schema => Object.fromEntries(Object.entries(schema?.properties ?? {}).map(([k, s]) => [k, { type: s.type ?? (s.enum ? 'enum' : '?'), ...(s.enum ? { enum: s.enum } : {}), ...('default' in s ? { default: s.default } : {}), ...(s.minimum !== undefined ? { min: s.minimum } : {}), ...(s.maximum !== undefined ? { max: s.maximum } : {}), ...(s.description ? { describe: s.description } : {}) }]));

export async function catalog({ kit = KIT } = {}) {
  const found = await kitModuleFiles();
  const out = { kit: { name: 'gf-three', version: KIT_VERSION }, fair: { defaults: { ...FAIR_DEFAULTS }, does: FAIR_DESCRIBE, config: 'config/game.json → fair (fair.* slots); off only when the creator asks' }, mechanics: [], worlds: [], bodies: [], looks: [], props: [], clips: [], rows: {} };
  // mechanics: every folder under components/, each as its own manifest describes it (no table here); where each runs
  // is the registry's (components/<id>/mechanic.json impl), added here as `runs`
  const reg = await readCatalog();
  for (const part of await mechanicParts({ kit })) { const r = reg.mechanics.find(m => m.id === part.id); out.mechanics.push({ ...partEntry(part), runs: runsOf(r?.impl) }); }
  out.mechanicFields = MANIFEST;
  // worlds of the standard-3d profile (worlds/templates/*.json recipes)
  const provides = await worldParts({ kit });
  const tdir = kitPath(kit, 'world/templates');
  const templates = existsSync(tdir) ? (await readdir(tdir)).filter(f => f.endsWith('.json')).sort() : [];
  const gen = await import('../../worlds/generate.js');
  const STD = { runtime: 'three', profile: 'standard-3d' };
  for (const f of templates) {
    const t = await readJson(join(tdir, f)); if (!t) continue;
    // each size class as a game of that size gets it (the spec's world.size); the seed is the title's, so rooms vary
    const sizes = Object.fromEntries(gen.SIZES.map(k => { const L = gen.generateLayout(t, { size: k }); return [k, { size: L.size, area: L.size[0] * L.size[1], rooms: (L.rooms ?? []).map(r => r.label), entries: (L.entries ?? []).map(e => e.name), zones: Object.keys(L.zones ?? {}), ceiling: L.ceiling?.height ?? null }]; }));
    const small = gen.generateLayout(t, { size: 'small' });
    out.worlds.push({ id: t.template ?? f.replace(/\.json$/, ''), ...STD, label: t.label ?? '', describe: t.describe ?? '', kind: t.kind ?? 'outdoor', setPieces: t.setPieces ?? [], size: small.size, spawns: small.spawns?.length ?? 0, zones: Object.keys(small.zones ?? {}), props: [...new Set((small.props ?? []).map(p => p.prop))].length, sizes, provides: provides[t.template ?? f.replace(/\.json$/, '')]?.provides ?? [] });
  }
  // the block world (CONTRACT §9): the world loop's (loops/world/loop.json needs it and the build mechanic)
  if (provides.voxel) out.worlds.push({ id: 'voxel', ...STD, label: 'Block world', describe: 'a generated block island everyone shares and changes (place, break and paint blocks), saved on the play host. Only for the loop "world" (with the build mechanic): never a timed round. world.params tunes the terrain (seed, radius, hills, trees, lake)', kind: 'outdoor', setPieces: [], size: null, spawns: 0, zones: [], props: 0, sizes: {}, provides: provides.voxel.provides, loop: 'world' });
  // smooth terrain (worlds/terrain): islands in a sea or a cliff shore that explosions carve (the carve mechanic)
  if (provides.terrain) out.worlds.push({ id: 'terrain', ...STD, label: 'Smooth terrain', describe: 'generated rounded land in a sea (islands, or a cliff shore) with a soil cross-section, which explosions carve into smooth craters (the carve mechanic) on every screen. world.params: shape (islands | cliffs), size [x, y, z] m, land {height, hills, cliff, overhang, tunnels}, islands {count, radius}, materials {top, soil: {from: "library:<pack>/<id>", size}}', kind: 'outdoor', setPieces: [], size: null, spawns: 8, zones: ['centre'], props: 0, sizes: {}, provides: provides.terrain.provides });
  out.worldSizes = Object.fromEntries(gen.SIZES.map(k => [k, { area: gen.SIZE_CLASSES[k].area, describe: gen.SIZE_CLASSES[k].describe }]));
  // bodies (tags to match a game's theme; `playerColour` when the kit tints the body per seat); a body the model judge
  // fails (a clip distorts its hands, face, …) is not offered
  for (const b of bodiesIn('three')) out.bodies.push({ id: b.id, label: b.label, describe: b.describe ?? '', from: b.from ?? null, tags: b.tags, height: b.height, playerColour: b.tint.length > 0, file: b.file, ref: b.ref });
  out.bodies.push({ id: 'generate', describe: 'a new body from a sentence ({from: "generate", prompt}); tools/meshy-character.mjs, about 6 min and 41 credits, in parallel with the build', from: 'generate' });
  out.bodies.push({ id: 'reference', describe: 'a body from the creator\'s attached image ({from: "reference", reference: <revisionId>}; the character\'s describe says what to keep); same cost as generate', from: 'reference' });
  out.bodyGuide = BODY_GUIDE;
  // looks of the standard-3d profile
  const look = found.look ? await importKitModule(kitPath(KIT, 'look/look.js')) : null;
  const presets = look && !look.error ? look.presets : (await importKitModule(kitPath(KIT, 'core/standins/look.js'))).presets;
  for (const [id, p] of Object.entries(presets ?? {})) out.looks.push({ id, ...STD, label: p.label ?? id, describe: p.describe ?? '', times: look?.TIMES ?? ['day', 'golden', 'night'] });
  // props
  for (const p of assetsIn('three', { category: 'prop' }).map(a => propEntry(a))) out.props.push({ id: p.id, describe: p.describe ?? '', tags: p.tags, size: p.size, ref: p.ref });
  // clips
  const ch = found.character ? await importKitModule(kitPath(KIT, 'character/character.js')) : null;
  out.clips = (ch && !ch.error && ch.CLIPS) || (await importKitModule(kitPath(KIT, 'core/standins/character.js'))).CLIPS;
  // the melee clips the standard clip file carries since 2026-10-08 (RIG.md §4), for the melee mechanic
  const rig = await importKitModule(kitPath(KIT, 'character/rig.js'));
  if (!rig.error && Array.isArray(rig.MELEE_CLIPS)) out.clips = [...new Set([...out.clips, ...rig.MELEE_CLIPS])];
  out.rows['three/standard-3d'] = { worlds: out.worlds.map(w => w.id), looks: out.looks.map(l => l.id) };
  // the three runtime's scenic-3d profile: runtimes/three/profiles/scenic-3d/kit's look and world, its library
  const scenic = await scenicCatalog();
  out.worlds.push(...scenic.worlds); out.looks.push(...scenic.looks);
  for (const b of scenic.bodies) if (!out.bodies.some(x => x.id === b.id)) out.bodies.splice(out.bodies.length - 2, 0, b);
  for (const p of scenic.props) if (!out.props.some(x => x.id === p.id)) out.props.push(p);
  out.rows['three/scenic-3d'] = { worlds: scenic.worlds.map(w => w.id), looks: scenic.looks.map(l => l.id), bodies: scenic.bodies.map(b => b.id), props: scenic.props.map(p => p.id), ...(scenic.note ? { note: scenic.note } : {}) };
  // the three runtime's flat-2d profile (kit/flat): its planes, worlds, looks, cameras and the mechanics run on each
  // plane are the part's own manifest
  const flat = await flatCatalog({ kit });
  if (flat) { out.worlds.push(...flat.worlds); out.looks.push(...flat.looks); out.rows['three/flat-2d'] = flat.row; }
  // the forge runtime: its worlds, looks and data tables
  const forge = await forgeCatalog();
  out.worlds.push(...forge.worlds); out.looks.push(...forge.looks); out.rows.forge = forge.row;
  // the vista runtime: the core's island, its looks, its data tables
  const vista = await vistaCatalog();
  out.worlds.push(...vista.worlds); out.looks.push(...vista.looks); out.rows.vista = vista.row;
  // how a game is played: the registry's loops, each with the flow that plays it
  out.loops = await loopParts({ kit });
  // what a spec says that the tools read and guess nothing from (GATES.md); the taste a creator may change
  out.spec = {
    schema: 'builder/spec/game-spec.v2.schema.json',
    props: { kind: 'gameplay (a thing the game uses) or scenery (laid out in the world)', goal: 'true for the thing the players defend', size: 'a gameplay prop\'s size in metres', radius: 'the room a scenery prop keeps around it' },
    taste: { 'mechanics[waves].params.hitsPerKill': 'the fewest hits a basic enemy takes (default 2; 1 allows one-hit kills): verify gate F, measure 39, holds the game to the locked spec\'s number', 'mechanics[projectile].params.muzzle': '"chest" (a throw, a water gun) or "hips" (a pee stream): where shots and the stream leave the body' },
  };
  return out;
}

/** Where a registry manifest's impl is open: ['three/standard-3d', 'forge', …]. */
export const runsOf = impl => Object.entries(impl ?? {}).filter(([, v]) => v.state?.open).flatMap(([rt, v]) => (v.profiles?.length ? v.profiles.map(p => `${rt}/${p}`) : [rt]));

/** The scenic-3d profile's worlds, looks and bodies: what its look and world modules export, its library. */
async function scenicCatalog() {
  const out = { worlds: [], looks: [], bodies: [], props: [], note: null };
  const world = await importKitModule(join(SCENIC_KIT, 'world/world.js'));
  const look = await importKitModule(join(SCENIC_KIT, 'look/look.js'));
  if (world.error || look.error) { out.note = `does not import: ${(world.error ?? look.error).message.split('\n')[0]}`; return out; }
  const at = { runtime: 'three', profile: 'scenic-3d' };
  for (const id of world.templates ?? []) {
    const info = world.templateInfo?.[id] ?? SCENIC_WORLDS[id] ?? {};
    out.worlds.push({ id, ...at, label: info.label ?? id, describe: info.describe ?? '', kind: info.kind ?? 'outdoor', levels: info.levels ?? 'one place', provides: info.provides ?? [], sizes: Object.fromEntries(Object.entries(world.SIZE_RADIUS ?? {}).map(([k, r]) => [k, { radius: r, area: Math.round(Math.PI * r * r) }])) });
  }
  for (const [id, p] of Object.entries(look.presets ?? {})) out.looks.push({ id, ...at, label: p.label ?? id, describe: p.describe ?? '', times: look.TIMES ?? ['day', 'golden', 'dusk', 'night'] });
  // the scenic-3d profile's packs in the asset library (runtimes/three/profiles/scenic-3d/art.json): KayKit bodies on
  // gf-humanoid-1, which create resolves by asset on any three profile, and its props (weapons with a grip, dungeon pieces)
  for (const b of bodiesIn('scenic')) out.bodies.push({ id: b.id, label: b.label, describe: b.describe ?? '', from: b.from ?? null, tags: b.tags, height: b.height, playerColour: b.tint.length > 0, file: b.file, ref: b.ref, library: 'scenic-3d' });
  for (const p of assetsIn('scenic', { category: 'prop' }).map(a => propEntry(a))) out.props.push({ id: p.id, describe: p.describe ?? '', tags: p.tags, size: p.size, ref: p.ref, ...(p.kind ? { kind: p.kind } : {}), ...(p.hands ? { hands: p.hands } : {}), library: 'scenic-3d' });
  return out;
}

/**
 * The forge runtime: its worlds, looks, the bodies friends see, and its data tables (spec.tables) with what each runs
 * today (tables/index.js RUNS). Whether it is open to pitches is the registry's (runtimes/forge/runtime.json).
 */
async function forgeCatalog() {
  const row = { worlds: [], looks: [], tables: {},
    play: 'no mechanic modules: its play is the spec\'s tables (player, weapons, enemies, waves, cards, …) and rules.js (commands in, events out)',
    multiplayer: 'live co-op for 2-4: the host\'s core owns the world and replays each friend\'s inputs; each player moves at once on their own screen (predicted) and sees the others as a hunter in their colour (one body a seat), holding their weapon',
    bodies: ['the four co-op hunters, one a seat: hooded, templar, rogue, witchfinder (what friends see; their cloth takes the player\'s colour)', 'enemies: two sets by archetype, chosen by each enemy row\'s `body`: the grim skeletons (skeleton-grim-chaser, skeleton-grim-caster, skeleton-grim-soldier, skeleton-grim-brute, skeleton-grim-lord; the default) and the risen townsfolk, zombie-like (zombie-shambler for a chaser, zombie-sprinter for a runner, zombie-spitter for a caster, zombie-bulwark for a shield, zombie-butcher for a brute, zombie-mayor for a boss), each holding its own things'],
    props: ['chest (the forge library\'s iron-bound reliquary: the thing to guard; verify looks for it on screen at the start)', 'pump (the forge library\'s town pump: the thing to guard in a town-street)'],
    // what the runtime does not do yet: a game that needs it builds it (spec.build: its own modules or an override)
    builds: [
      'more than one place: levels, rooms to clear, doors, portals, a second map (one arena a game: crypt-room, ruins-arena or town-street)',
      'versus or teams (players cannot hurt each other: co-op for 2-4)',
      'the three runtime\'s mechanics (pickups to carry, stations, paint, races, a base with health to defend): the play is the tables and rules.js',
      'an alternate fire (right click), thrown things, grenades, vehicles, mounts, building',
    ] };
  const worlds = [], looks = [];
  try {
    const world = await importKitModule(join(FORGE_KIT, 'world.js')), look = await importKitModule(join(FORGE_KIT, 'look.js')), tables = await importKitModule(join(FORGE_KIT, 'tables/index.js'));
    for (const id of world.templates ?? []) { const info = FORGE_WORLDS[id] ?? {}; worlds.push({ id, runtime: 'forge', label: info.label ?? id, describe: info.describe ?? '', kind: info.kind ?? 'indoor', sizes: Object.fromEntries(Object.entries(world.WORLD_SIZES?.[id] ?? world.SIZES ?? {}).map(([k, n]) => [k, { size: world.WORLD_FOOTPRINTS?.[id]?.[k] ?? [n * (world.TILE ?? 3), n * (world.TILE ?? 3)] }])) }); }
    for (const [id, p] of Object.entries(look.presets ?? {})) { const info = FORGE_LOOKS[id] ?? {}; looks.push({ id, runtime: 'forge', label: p.label ?? info.label ?? id, describe: p.describe ?? info.describe ?? '', times: ['night'] }); }
    for (const [t, r] of Object.entries(tables.RUNS ?? {})) row.tables[t] = { runs: r.now ?? null, notYet: r.notYet ?? null };
    const W = tables.weapons ?? {}, E = tables.enemies ?? {}, C = tables.cards ?? {};
    row.tables.weapons && Object.assign(row.tables.weapons, { kinds: W.KINDS ?? [], presets: ['pistol', 'shotgun', 'repeater', 'blade'] });
    row.tables.enemies && Object.assign(row.tables.enemies, { archetypes: E.ARCHETYPES ?? [] });
    row.tables.cards && Object.assign(row.tables.cards, { rarities: C.RARITIES ?? [] });
    row.tablesHow = 'spec.tables = {player, weapons: [{id, preset | kind, …}], enemies: [{id, archetype, …}], waves: [{id, enemies: [{type, count}]}], cards: [{id, rarity, stat, add}], …}; every value a slot; create refuses what the core cannot do';
  } catch (e) { row.note = `does not import: ${e.message.split('\n')[0]}`; }
  row.worlds = worlds.map(w => w.id); row.looks = looks.map(l => l.id);
  return { row, worlds, looks };
}

/**
 * The vista runtime: the core's island, its six looks, its data tables (spec.tables) and what it has. Whether it is
 * open to pitches is the registry's (runtimes/vista/runtime.json).
 */
export async function vistaCatalog() {
  const row = { worlds: [], looks: [],
    play: 'no mechanic modules: its play is the core\'s walking, swimming, boat and fishing, the spec\'s tables and rules.js (events in: bite, hooked, catch, lost, sold, bought, board, leave; ctx.finish ends the session)',
    multiplayer: 'live co-op for 1-4 on one island: each player walks, swims, sails and fishes on their own copy, and sees the others as people (a gf-humanoid-1 body, one a seat, in their colour) where they really are; the host\'s copy owns the time of day, the sea state, the clock and the results',
    tables: {
      species: 'what bites, where and what it is worth: {<id>: {name, habitat: [shallows | reef | pier | bay | deep], minKg, maxKg, value}}; the ids are the core\'s swimming fish (silverside, mullet, needlefish, sergeant, grunt, yellowtail, chromis, tang, wrasse, parrot, angel, jack, barracuda, grouper, redSnapper, tuna, mahi, tarpon), the names our own',
      gear: 'what the shop sells: {<id>: {name, kind, price, <its stat>}}; kinds and their stat: line lineKg (breaking strain, kg), reel reelSpeed (how fast the line comes in), rod castM (longest cast, m), hold holdKg (cooler, kg), tank fuelL, engine speedMul (the boat\'s), finder and lights (no stat). A spec\'s gear replaces the defaults whole, so list a price-0 starter of each kind the player needs (a line, a reel, a rod, a hold) and the upgrades above it',
      vendors: '{buyer: {name, greeting}, shop: {name, greeting}}: generic names of our own',
      economy: '{startMoney, fuelPrice}',
      start: 'pier (the pier\'s foot on the beach, looking out along the pier: the best first view, the default) | pier-head (the end of the pier, facing open sea) | beach | boat: where players begin',
    },
    tablesHow: 'spec.tables = {species, gear, vendors, economy, start}; every value a slot; runtimes/vista/kit/tables check() refuses what the core cannot do (create refuses the spec)',
    has: ['1 to 5 islands in the open sea, each generated from its own seed and words (world.islands: size, shape, coast, coves, a river mouth, cliffs, sand, rock, plants, reef, a pier, dock or jetty, a village or none, the time of day and the weather), and the boat to sail between them', 'walking, swimming, diving and a boat to take out', 'wildlife that lives on its own: a humpback whale that cruises the deep water, blows and breaches, fish on the reef, gulls, crabs', 'fishing: casting, bites, the catch, a cooler, a fish buyer and a tackle shop (spec.tables)', 'six looks from a clear morning to a storm swell', 'friends on the same island who see each other'],
    // what the runtime does not do yet: a game that needs it builds it (spec.build: its own modules or an override)
    builds: ['any world but the core\'s island (a coast of its own, a second map, levels or rooms)', 'enemies, combat, weapons, health, building, crafting or farming', 'a boat friends ride together (each player\'s boat is their own copy\'s)', 'progress saved between sessions on the play host'],
    bodies: ['friends see each other as gf-humanoid-1 bodies from runtimes/vista/kit/bodies.json (realistic bodies), else four library bodies, one a seat, in each player\'s colour'] };
  const worlds = [], looks = [];
  try {
    const C = await importKitModule(join(VISTA_KIT, 'config.js'));
    if (C.error) throw C.error;
    for (const id of C.templates ?? []) { const info = C.TEMPLATE_INFO?.[id] ?? {}; worlds.push({ id, runtime: 'vista', label: info.label ?? id, describe: info.describe ?? '', kind: info.kind ?? 'outdoor', starts: Object.keys(C.PLACES ?? {}),
      // one island at every size class (spec world.size changes nothing yet)
      sizes: Object.fromEntries(['small', 'medium', 'large'].map(k => [k, { size: [2048, 2048], note: 'the core\'s one island' }])) }); }
    for (const [id, p] of Object.entries(C.presets ?? {})) looks.push({ id, runtime: 'vista', label: p.label ?? id, describe: p.describe ?? '', times: [p.hour < 7 || p.hour > 20 ? 'night' : p.hour > 16.5 ? 'golden' : 'day'] });
  } catch (e) { row.note = `does not import: ${String(e?.message ?? e).split('\n')[0]}`; }
  row.worlds = worlds.map(w => w.id); row.looks = looks.map(l => l.id);
  return { row, worlds, looks };
}

/** The three runtime's flat-2d profile, from kit/flat/index.js → manifest; null when the kit has no flat part. */
export async function flatCatalog({ kit = KIT } = {}) {
  if (!existsSync(kitPath(kit, 'flat/index.js'))) return null;
  const mod = await importKitModule(kitPath(kit, 'flat/index.js')), M = mod.manifest;
  if (mod.error || !M) return { row: { note: `does not import: ${mod.error?.message.split('\n')[0] ?? 'no manifest'}`, worlds: [], looks: [] }, worlds: [], looks: [] };
  const at = { runtime: 'three', profile: 'flat-2d' };
  const worlds = Object.entries(M.worlds).map(([id, w]) => ({ id, ...at, plane: w.plane, label: w.label, describe: w.describe, kind: 'outdoor', sizes: Object.fromEntries(Object.entries(w.sizes).map(([k, [c, r]]) => [k, { size: [c, r], cells: true }])) }));
  const looks = Object.entries(M.looks).map(([id, l]) => ({ id, ...at, label: l.label, describe: l.describe, style: l.style, times: ['day'] }));
  const row = {
    standard: M.standard, worlds: worlds.map(w => w.id), looks: looks.map(l => l.id), cameras: Object.values(M.cameras),
    planes: M.planes, styles: M.styles, mechanics: M.runs, body: M.body, map: M.map, side: M.side,
    spec: { camera: 'top (seen from above: world field) or side (seen from the side with gravity: world stage); the plane follows the camera', world: '{template: field | stage, size, props: pictures, map?: the level as rows of text}', characters: '[{role, describe, body: {from: "kind"}}]: every body is a picture sheet' },
    builds: ['a mechanic not in mechanics.<plane> (not run on a plane yet)', 'slopes, moving platforms, more than one screen-depth layer, a camera that turns', 'bots that plan a route up the ledges (they hop)'],
  };
  return { row, worlds, looks };
}

/** One row's catalog: the shared parts and that row's worlds and looks ('three/scenic-3d', 'forge'). */
export function forRow(c, key) {
  if (!c.rows?.[key]) throw new Error(`no runtime row "${key}" (${Object.keys(c.rows ?? {}).join(', ')})`);
  const [runtime, profile = null] = key.split('/');
  const mine = x => x.runtime === runtime && (x.profile ?? null) === profile;
  return { ...c, rows: { [key]: c.rows[key] }, worlds: c.worlds.filter(mine), looks: c.looks.filter(mine), mechanics: c.mechanics.filter(m => m.runs?.includes(key)), loops: c.loops.filter(l => l.runtimes?.includes(key)) };
}

if (isMain(import.meta)) {
  const ri = process.argv.indexOf('--runtime');
  let c = await catalog();
  if (ri > 0) { try { c = forRow(c, process.argv[ri + 1]); } catch (e) { console.error(`catalog: ${e.message}`); process.exit(2); } }
  // no process.exit: piped output larger than the pipe buffer must drain first
  if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(c, null, 2) + '\n');
  else print(c);
}
/** A mechanic's composition in words: what it needs, works with and owns, and its note. */
function partLines(m) {
  const out = [];
  if (m.needs?.parts?.length || m.needs?.world?.length) out.push(`needs: ${[...m.needs.parts.map(n => `the ${n.id} mechanic`), ...m.needs.world.map(n => `a world with ${n.id}`)].join(', ')}`);
  if (m.uses?.length) out.push(`works with: ${m.uses.join(', ')}`);
  if (m.owns?.length) out.push(`owns: ${m.owns.map(o => `${o.res}${o.shared ? ' (shared)' : ''}`).join(', ')}`);
  if (m.runs?.length) out.push(`runs on: ${m.runs.join(', ')}`);
  for (const n of m.note ?? []) out.push(`note: ${n}`);
  return out;
}
const where = x => (x.profile ? `${x.runtime}/${x.profile}` : x.runtime);
function print(c) {
  console.log(`the kit's parts (three ${c.kit.version}); what is open to pitches: npx gamesfun catalog runtimes\n`);
  console.log(`FAIR PLAY (every game, on by default; ${c.fair.config})\n  ${Object.entries(c.fair.defaults).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}\n${c.fair.does.map(d => `  - ${d}`).join('\n')}\n`);
  if (c.loops) {
    console.log('LOOPS (spec.loop: how the game is played)');
    for (const l of c.loops) console.log(`  ${l.id.padEnd(8)} ${l.status === 'ready' ? '' : `[${l.status}] `}${l.label}: ${l.describe}${l.pick ? `\n${' '.repeat(11)}pick it when ${l.pick}` : ''}${l.runtimes?.length ? `\n${' '.repeat(11)}open on ${l.runtimes.join(', ')}` : ''}`);
    console.log('');
  }
  console.log('MECHANICS');
  for (const m of c.mechanics) console.log(`  ${m.id.padEnd(11)} ${m.status === 'ready' ? '' : `[${m.status}] `}${m.describe}${m.examples.length ? `\n${' '.repeat(14)}as: ${m.examples.join(' · ')}` : ''}${Object.keys(m.params).length ? `\n${' '.repeat(14)}params: ${Object.entries(m.params).map(([k, p]) => `${k}${'default' in p ? `=${JSON.stringify(p.default)}` : ''}`).join(', ')}` : ''}${partLines(m).map(l => `\n${' '.repeat(14)}${l}`).join('')}`);
  console.log('\nWORLDS');
  for (const w of c.worlds) {
    console.log(`  ${w.id.padEnd(11)} ${w.label ? `${w.label}: ` : ''}${w.describe}${w.kind ? ` [${w.kind}]` : ''} (${where(w)})`);
    for (const [k, z] of Object.entries(w.sizes ?? {})) console.log(`${' '.repeat(14)}${k.padEnd(7)} ${z.size ? `${z.size.join(' x ')} m` : `radius ${z.radius} m`}${z.rooms?.length ? `, rooms: ${z.rooms.join(', ')}` : ''}${z.entries?.length ? `; enemies come in at ${z.entries.join(', ')}` : ''}`);
    if (w.setPieces?.length) console.log(`${' '.repeat(14)}set-pieces: ${w.setPieces.join('; ')}`);
  }
  if (c.worldSizes) console.log(`  world.size: ${Object.entries(c.worldSizes).map(([k, v]) => `${k} ${v.area[0]}–${v.area[1]} m² (${v.describe})`).join(' · ')}`);
  console.log('\nLOOKS');
  for (const l of c.looks) console.log(`  ${l.id.padEnd(14)} ${l.label}${l.describe ? `: ${l.describe}` : ''} (${l.times.join(', ')}) (${where(l)})`);
  console.log('\nBODIES');
  for (const b of c.bodies) console.log(`  ${b.id.padEnd(28)} ${b.describe}${b.tags?.length ? `\n${' '.repeat(31)}tags: ${b.tags.join(', ')}` : ''}`);
  if (c.bodyGuide) console.log(`  how to pick:\n${c.bodyGuide.map(g => `    ${g}`).join('\n')}`);
  console.log(`\nPROPS (${c.props.length})\n  ${c.props.map(p => p.id).join(', ')}`);
  console.log(`\nCLIPS\n  ${c.clips.join(', ')}`);
}
