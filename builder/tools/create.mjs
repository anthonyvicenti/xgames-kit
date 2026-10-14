#!/usr/bin/env node
// create: a game spec v2 → a runnable, multiplayer, slot-complete game on its runtime and profile (CONTRACT §1;
// runtimes/CONTRACT.md §2). A script, no agent: the same spec always gives the same files.
//
//   node builder/tools/create.mjs <spec.json> <out-dir> [--force] [--new-rules] [--standins] [--standin-mechanics] [--json]
//
//   --force      also overwrite config/*.json, assets/* and multiplayer.json when they exist (without it an existing one
//                is kept as it is: re-running create refreshes the kit and the vendored code only)
//   --new-rules  replace rules.js with the stub too (never done otherwise: rules.js is the game agent's file)
//   --standins   use the kit's stand-in look, world and character even when the real modules exist
//   --standin-mechanics   leave the mechanics' modules out (the rules do their part; their params stay in config)
//   Options are kept in gf-three.json: a re-run without flags makes the same choices again.
//
// It reads a spec v2 only (builder/spec/game-spec.v2.schema.json: runtime, profile, loop, kind; an older spec is refused
// with what to do) and holds it to the registry (registry/catalog.json: a hard limit the runtime breaks, an id no
// manifest has); vendors three, Rapier, postprocessing and N8AO
// (vendor/), the kit (gf/three/), gf-multiplayer (its current KIT_VERSION, gf/mp/, via builder/multiplayer/party/adopt.mjs), gf-assets
// 1.3.0 (gf/gf-assets.js) and gf-audio 1.5.0 (audio/); writes config/*.json, assets/, assets.json (from the slot
// declarations), multiplayer.json (mode live), index.html, main.js, a rules.js stub carrying the spec's rules as
// comments, ATTRIBUTION.md, spec.json and gf-three.json (the build record). Exit 0 ok, 1 failed, 2 bad usage or spec.
//
// Parts carry their own (each mechanic's `manifest` in kit/mechanics/<id>/index.js; tools/catalog.mjs MANIFEST): the
// spec's mechanics are composed by their manifests and a set that cannot work is refused with the cause (a part or a
// world capability it needs and the spec lacks, two owners of one resource; where a mechanic runs is the registry's);
// rules.js is assembled from the stubs of the spec's mechanics: each one's callbacks as empty named handlers, one
// worked line and its own traps.
import { isMain } from './lib/main.mjs';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, relative, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO, KIT, SCENIC_KIT, FORGE, FORGE_KIT, VISTA_KIT, importPart, KIT_VERSION, SCENIC_VERSION, FORGE_VERSION, VISTA_VERSION, GF_AUDIO, json, sha256, walk, kitPath, placeOf, isScenic, isFlat, coreDrawn } from './lib/paths.mjs';
import { check, withDefaults } from './lib/schema.mjs';
import { readSpec, readCatalog, lookOf, planeOf } from './lib/spec.mjs';
import { applyKind } from '../../kinds/apply.mjs';
import { put, vendorLibraries, vendorKit, vendorGfAssets, kitModuleFiles, optionalModuleDirs, gameCodeTexts, kitNow } from './lib/vendor.mjs';
import { overrideConflicts, holdOverrides } from './lib/overrides.mjs';
import { importKitModule } from './lib/kit-import.mjs';
import { specToConfig } from './lib/spec-config.mjs';
import { libraryFill } from '../art/fill.mjs';
import { refFile } from '../art/views.mjs';
import { assembleManifest } from './lib/slots-lib.mjs';
import { ensurePictures } from './lib/items-lib.mjs';
import { mechanicIds, composeProblems, worldParts, flowOf, flowParts } from './catalog.mjs';
import { adopt } from '../multiplayer/party/adopt.mjs';
import { shapeOfSpec, AVATAR, AVATAR_FILE, AVATAR_LICENSE, MOOD_TEXT } from './lib/presence.mjs';
import { KIT_VERSION as MP_KIT_VERSION } from '../multiplayer/party/manifest.mjs';

export const AUDIO_FILES = ['audio.js', 'zzfx.mjs', 'sounds.mjs', 'meter.mjs', 'presets.json', 'code-sounds.js', 'LICENSE-zzfx', 'ATTRIBUTION.md', 'VERSION'];

/** Which real modules to use: present in the kit source AND importable with the contract's exports. `place` is the
 *  spec's {runtime, profile}. three scenic-3d (CONTRACT §8): the look and world are runtimes/three/profiles/scenic-3d/kit's,
 *  never stand-ins. → {modules: {runtime, profile, look, world, character, mechanics, flat?}, why, mods} */
export async function decideModules({ standins = false, standinMechanics = false, place = { runtime: 'three', profile: 'standard-3d' }, kit = KIT, flat = null } = {}) {
  const found = await kitModuleFiles(), out = { runtime: place.runtime, ...(place.profile ? { profile: place.profile } : {}), look: false, world: false, character: false, mechanics: [] }, why = [];
  // a flat-2d game is the three kit with the flat look, world, body and controller (kit/flat/) and every mechanic the
  // kit has; which of them run on its plane (from its camera) is the flat part's to say (manifest.runs)
  if (flat) {
    out.flat = flat;
    const mods = { flat: await importKitModule(kitPath(KIT, 'flat/index.js')), mechanics: {} };
    if (mods.flat.error) throw new Error(`flat: kit/flat/index.js does not import (${mods.flat.error.message.split('\n')[0]})`);
    why.push(`look, world, character, controller: the flat-2d profile's parts, plane ${flat} (kit/flat)`);
    for (const id of found.mechanics) {
      const m = await importKitModule(kitPath(kit, `mechanics/${id}/index.js`));
      if (m.error || typeof m.create !== 'function' || m.id !== id) continue;
      out.mechanics.push(id); mods.mechanics[id] = m;
    }
    return { modules: out, why, mods };
  }
  const scenic = isScenic(place);
  // the vista runtime (CONTRACT §8 vista): its look and world are runtimes/vista/kit's (kit/config.js: the core's island,
  // kit/look.js's presets); no three.js character and no mechanic module (the core plays the fishing and the boat from
  // the spec's tables); never stand-ins
  if (place.runtime === 'vista') {
    const m = await importPart(join(VISTA_KIT, 'config.js'), 'the vista runtime');
    const missing = ['templates', 'presets', 'lookConfig', 'worldConfig', 'slotsFor'].filter(n => !(n in m));
    if (missing.length) throw new Error(`runtimes/vista/kit/config.js lacks ${missing.join(', ')}: the vista runtime has no stand-in`);
    out.look = true; out.world = true;
    why.push(`look: the vista runtime's (${VISTA_VERSION}: the core's sky, sea, clouds and light; the look preset sets the hour, the sea state, the exposure and the clouds)`,
      `world: the vista runtime's (islands: each generated from its seed and words, runtimes/vista/kit/world/places.js; never the reference island)`,
      'character: the vista runtime\'s (first person: your own body is never drawn; friends are gf-humanoid-1 bodies skinned by the core, gf/vista/kit/humanoid.js)',
      'mechanics: no mechanic module runs on vista (the core plays the fishing and the boat from the spec\'s tables; the rules are rules.js)');
    return { modules: out, why, mods: { look: m, world: m, mechanics: {} } };
  }
  // the forge runtime (CONTRACT §8 forge): its look and world are runtimes/forge/kit's; no three.js character, and no
  // mechanic module runs on it yet (their params stay in config for the rules); never stand-ins
  if (place.runtime === 'forge') {
    await importPart(join(FORGE_KIT, 'look.js'), 'the forge runtime');   // absent: the plain "not in this checkout" wording
    const mods = { mechanics: {} };
    for (const [key, rel, names] of [['look', 'look.js', ['presets', 'lookConfig', 'slotsFor', 'pack']], ['world', 'world.js', ['templates', 'worldConfig', 'slotsFor', 'loadWorld']]]) {
      const m = await importKitModule(join(FORGE_KIT, rel));
      const missing = names.filter(n => !(n in m));
      if (m.error || missing.length) throw new Error(`${key}: ${rel} ${m.error ? `does not import (${m.error.message.split('\n')[0]})` : `lacks ${missing.join(', ')}`} in runtimes/forge/kit: the forge runtime has no stand-in`);
      out[key] = true; mods[key] = m; why.push(`${key}: the forge runtime's (${FORGE_VERSION})`);
    }
    why.push('character: the forge runtime\'s (first person: your own body is never drawn; friends and enemies are skinned by the Rust renderer, gf/forge/wear.js)');
    // a mechanic with a forge implementation (components/<id>/impl/forge) runs on forge; its params, slots and sounds are
    // its manifest's, as on three (the three module is read for its declarations only, never vendored into the game)
    for (const id of found.mechanics) {
      if (!existsSync(kitPath(KIT, `mechanics/${id}/impl/forge/index.js`))) continue;
      const m = await importKitModule(kitPath(KIT, `mechanics/${id}/index.js`));
      if (m.error || m.id !== id) continue;
      out.mechanics.push(id); mods.mechanics[id] = m;
    }
    why.push(`mechanics: ${out.mechanics.length ? `${out.mechanics.join(', ')} run on forge (components/<id>/impl/forge); the others` : 'none runs on forge;'} keep their params in config/game.json for the rules (the Rust core plays weapons, hits, enemies and waves from the spec's tables)`);
    return { modules: out, why, mods };
  }
  if (standins && !scenic) return { modules: out, why: ['--standins: every module is a stand-in'], mods: {} };
  const mods = {};
  const tryMod = async (key, rel, names, root = KIT, label = 'the real module') => {
    if (root === KIT && !found[key]) { why.push(`${key}: not in the kit yet (stand-in)`); return; }
    const m = await importKitModule(kitPath(root, rel));
    const missing = names.filter(n => !(n in m));
    if (m.error || missing.length) {
      const what = `${key}: ${rel} ${m.error ? `does not import (${m.error.message.split('\n')[0]})` : `lacks ${missing.join(', ')}`}`;
      if (root !== KIT) throw new Error(`${what} in runtimes/three/profiles/scenic-3d/kit: the scenic-3d profile has no stand-in`);
      why.push(`${what} (stand-in)`); return;
    }
    out[key] = true; mods[key] = m; why.push(`${key}: ${label}`);
  };
  if (scenic) {
    await tryMod('look', 'look/look.js', ['createRenderer', 'applyLook', 'presets', 'lookConfig'], SCENIC_KIT, `the scenic-3d profile's (${SCENIC_VERSION})`);
    await tryMod('world', 'world/world.js', ['loadWorld', 'templates', 'worldConfig'], SCENIC_KIT, `the scenic-3d profile's (${SCENIC_VERSION})`);
  } else {
    await tryMod('look', 'look/look.js', ['createRenderer', 'applyLook']);
    await tryMod('world', 'world/world.js', ['loadWorld']);
  }
  if (standins) { why.push('--standins: the character and mechanics are stand-ins (a scenic game keeps its look and world)'); return { modules: out, why, mods }; }
  await tryMod('character', 'character/character.js', ['spawnCharacter']);
  // the real character plays the shared clips on gf-humanoid-1 bodies: without both in the library it can't run
  if (out.character && !refFile('humanoid-clips/gf-humanoid-1')) { out.character = false; why.push('character: the asset library\'s clip file (humanoid-clips/gf-humanoid-1) is not on this machine (stand-in)'); }
  mods.mechanics = {};
  if (standinMechanics) { why.push('mechanics: left out (--standin-mechanics: the rules do their part)'); return { modules: out, why, mods }; }
  // `kit` (tests): the mechanics' declarations read from another kit folder; vendoring (tools/lib/vendor.mjs) still copies this kit
  for (const id of kit === KIT ? found.mechanics : await mechanicIds(kit)) {
    const m = await importKitModule(kitPath(kit, `mechanics/${id}/index.js`));
    if (m.error || typeof m.create !== 'function' || m.id !== id) { why.push(`mechanic ${id}: ${m.error ? 'does not import' : 'lacks id/create'} (its params stay in config)`); continue; }
    out.mechanics.push(id); mods.mechanics[id] = m;
  }
  return { modules: out, why, mods };
}

export async function create(specPath, outDir, { force = false, newRules = false, standins = null, standinMechanics = null, kitDir = KIT, log = () => {} } = {}) {
  const t0 = performance.now();
  const dir = resolve(outDir);
  // a re-run makes the choices the first run made, unless told otherwise
  const prevRecord = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8').catch(() => '{}'));
  const prev = prevRecord.options ?? {}; prev.extras = prevRecord.modules?.extras;
  const options = { standins: standins ?? prev.standins ?? false, standinMechanics: standinMechanics ?? prev.standinMechanics ?? false };
  // a spec v2, held to its schema and to the registry (tools/lib/spec.mjs): an older spec is refused with what to do
  const read = await readSpec(resolve(specPath));
  if (read.problems.length) return { ok: false, code: 2, problems: read.problems };
  const spec0 = read.spec, specBytes = read.bytes, catalog = await readCatalog();
  const place = placeOf(spec0);
  const problems = [];
  // the flow that plays this spec's loop (loops/<id>): the timed round unless the loop has its own
  const flows = await flowParts({ kit: kitDir });
  const flowId = flowOf(spec0.loop), flow = flowId ? flows.find(f => f.id === flowId && f.manifest) ?? null : null;
  if (flow?.manifest.refuse) { try { problems.push(...(flow.manifest.refuse(spec0) ?? [])); } catch (e) { problems.push(`loop "${flow.id}": its manifest's refuse threw: ${e.message}`); } }
  // round.params are the flow's own (its params schema), as a mechanic's params are the mechanic's
  if (spec0.round?.params !== undefined && flow?.manifest.params) for (const p of check(flow.manifest.params, spec0.round.params)) problems.push(`round.params (loop "${flow.id}"): ${p}`);
  if (problems.length) return { ok: false, code: 2, problems: problems.map(p => `spec ${p}`) };

  // the spec as it is made: what it leaves to its kind is filled in (the look: the kind's on this runtime, else the
  // runtime's first for the profile; tools/lib/spec.mjs lookOf) and said in the notes. spec.json keeps the spec as locked.
  const look = lookOf(spec0, catalog);
  const spec = { ...spec0, look: { ...(spec0.look ?? {}), preset: look.preset, time: look.time } };
  const madeNotes = [...read.findings.map(f => `registry: ${f}`), `look: ${look.preset}${look.time ? ` (${look.time})` : ''}, from the ${look.from}`];
  // a world this runtime lacks is built in the game on its closest (the spec's build item with closest)
  const worldIds = (catalog.runtimes.find(r => r.id === place.runtime)?.worlds ?? []).filter(w => !w.profiles || !place.profile || w.profiles.includes(place.profile)).map(w => w.id);
  if (worldIds.length && !worldIds.includes(spec.world.template)) {
    const base = (spec.build ?? []).map(b => b.closest).find(c => worldIds.includes(c));
    if (base) { madeNotes.push(`world: "${spec.world.template}" is built in this game on ${base} (its build item)`); spec.world = { ...spec.world, template: base }; }
  }

  // a flat-2d game: the three kit with the flat parts. What a flat spec may name (its plane's world, look and camera, a
  // map every jump of which is in reach, mechanics run on its plane) and what no other spec may, are the flat part's own
  // to say (kit/flat/index.js). Its plane follows its camera (top or side).
  const flatPart = await importKitModule(kitPath(KIT, 'flat/index.js'));
  const flat = isFlat(place) ? planeOf(spec) : null;
  if (flat && flatPart.error) return { ok: false, code: 1, problems: [`flat: kit/flat/index.js does not import (${flatPart.error.message.split('\n')[0]})`] };
  if (!flatPart.error && place.runtime === 'three') {
    const bad = flat ? [...flatPart.refuse(spec), ...flatPart.mechanicsOn(spec).problems] : flatPart.refuseNotFlat(spec);
    if (bad.length) return { ok: false, code: 2, problems: bad.map(b => `spec ${b}`) };
  }
  let decided;
  try { decided = await decideModules({ ...options, place, kit: kitDir, flat }); } catch (e) { return { ok: false, code: 1, problems: [e.message] }; }
  const { modules, why, mods } = decided;
  // the spec's world and look must be ones its runtime's modules have (CONTRACT §8; the registry lists the same)
  if (isScenic(place) || coreDrawn(place)) {
    const T = spec.world?.template, L = spec.look?.preset;
    const bad = [];
    const where = place.profile ? `${place.runtime}/${place.profile}` : place.runtime;
    if (T && !mods.world.templates.includes(T)) bad.push(`world.template "${T}" is not a ${where} world (${mods.world.templates.join(', ')})`);
    if (L && !(L in mods.look.presets)) bad.push(`look.preset "${L}" is not a ${where} look (${Object.keys(mods.look.presets).join(', ')})`);
    // vista (CONTRACT §8 vista): the island's pier, stalls and boat are the place's own: no props placed from the spec yet
    if (place.runtime === 'vista' && (spec.world?.props ?? []).length) bad.push('world.props: a vista world places no props yet (each island, its pier, stalls and boat come from its place words); list none, or build them (a build item)');
    // vista: the islands' words are the place generator's (a word it does not know is said, with the ones it knows)
    if (place.runtime === 'vista') try { mods.world.specIslands(spec); } catch (e) { bad.push(e.message); }
    if (bad.length) return { ok: false, code: 2, problems: bad.map(b => `spec ${b}`) };
  }
  // world.islands is a runtime's that generates places (vista); elsewhere the islands are the game's to build
  if (place.runtime !== 'vista' && spec.world?.islands) return { ok: false, code: 2, problems: [`spec world.islands: generated islands are the vista runtime's (this spec's runtime is ${place.runtime}); build the islands in the game instead (a build item in spec.build) and leave world.islands out`] };
  // the data tables (spec.tables: forge's player, weapons, enemies, waves, cards…; vista's species, gear, vendors,
  // economy, start): checked by the runtime's own checker; a value the core can't do, a field that does not exist or a
  // wave naming a missing enemy is refused; what no system runs yet is a note
  const tableNotes = [];
  if (spec.tables !== undefined && !coreDrawn(place)) return { ok: false, code: 2, problems: [`spec tables: the data tables are a forge or vista game's (this spec's runtime is ${place.runtime}); a three.js game's numbers are its mechanics' params and rules.params`] };
  if (place.runtime === 'vista') {
    const r = (await importPart(join(VISTA_KIT, 'tables/index.js'), 'the vista runtime')).check(spec.tables ?? {});
    const probs = Array.isArray(r) ? r : r?.problems ?? [];
    if (probs.length) return { ok: false, code: 2, problems: probs.map(p => `spec tables: ${String(p).replace(/^vista[.:]\s*/, '')} (runtime vista)`) };
    tableNotes.push(...(Array.isArray(r?.notes) ? r.notes : []));
  }
  if (place.runtime === 'forge') {
    const r = (await importPart(join(FORGE_KIT, 'tables/index.js'), 'the forge runtime')).check(spec.tables);
    if (r.problems.length) return { ok: false, code: 2, problems: r.problems.map(p => `spec tables: ${String(p).replace(/^forge[.:]\s*/, '')} (runtime forge)`) };
    tableNotes.push(...r.notes);
  }
  // the spec's mechanics in the modules that exist: their params checked against each module's schema, defaults filled
  const warnings = [], mechanicDefaults = {};
  for (const m of spec.mechanics) {
    const mod = mods.mechanics?.[m.id];
    if (!mod?.params) continue;
    for (const p of check(mod.params, m.params ?? {})) warnings.push(`mechanic ${m.id}: params ${p}`);
    mechanicDefaults[m.id] = withDefaults(mod.params, {});
  }
  // what a mechanic needs to sit on a flat plane (kit/flat manifest.runs), laid under the spec's own params
  if (flat) for (const [id, p] of Object.entries(flatPart.mechanicsOn(spec).params)) mechanicDefaults[id] = { ...(mechanicDefaults[id] ?? {}), ...p };
  // do the spec's mechanics compose? Each part's manifest says what it needs and what it owns; a set that cannot work
  // is refused here, with the cause and the way out, before anything is written. A mechanic whose module is not in
  // this game (a forge game, --standin-mechanics) is not judged.
  const parts = Object.entries(mods.mechanics ?? {}).map(([id, module]) => ({ id, module, manifest: module.manifest ?? null }));
  const worldPart = modules.world && spec.world?.template ? (await worldParts({ kit: kitDir }))[spec.world.template] ?? null : null;
  const refused = composeProblems(spec.mechanics, parts, { world: worldPart?.provides ?? null, worldId: spec.world?.template ?? '' });
  if (refused.length) return { ok: false, code: 2, problems: refused.map(p => `spec ${p}`) };
  const lookMod = modules.look ? mods.look : null;
  const standinLook = await importKitModule(kitPath(KIT, 'core/standins/look.js'));
  const lookPreset = lookMod ? (id, time) => { const v = lookMod.presetValues?.(id, time) ?? lookMod.presets?.[id]; return v ? JSON.parse(JSON.stringify(v)) : null; } : null;
  // the real look's config/look.json is its whole preset (lookConfig), id dropped: every value a look.* slot
  const lookConfig = flat ? id => flatPart.lookConfig(id, { plane: flat }) : place.runtime === 'vista' ? () => mods.look.lookConfig(spec) : lookMod?.lookConfig ? (id, time) => { const c = JSON.parse(JSON.stringify(lookMod.lookConfig(id, { time }))); delete c.id; return c; } : null;
  // the forge world reads no file itself: its library (the curated KayKit pieces and their licences) is passed in
  const forgeLib = place.runtime === 'forge' ? await (await importPart(join(FORGE, 'tools/library.mjs'), 'the forge runtime')).forgeLibrary() : null;
  const flatFile = f => join(REPO, 'builder', f);      // the flat stand-in pictures (builder/tools/lib/standin-assets/flat)
  const worldConfig = flat ? (s, o) => flatPart.worldConfig(s, { ...o, repoFile: flatFile }) : place.runtime === 'vista' ? s => mods.world.worldConfig(s) : isScenic(place) ? (s, o) => mods.world.worldConfig(s, o) : place.runtime === 'forge' ? (s, o) => mods.world.worldConfig(s, { ...o, library: forgeLib }) : null;
  const flowUse = flow && flow.id !== 'round' && spec.loop !== 'world' ? { id: flow.id, params: withDefaults(flow.manifest.params ?? {}, spec.round?.params ?? {}), sounds: flow.module?.sounds ?? {} } : null;
  // a mechanic's own sounds (its module's `sounds`: id → [label, preset, bus]) are listed with the game's, like its slots
  const mechanicSounds = Object.fromEntries(Object.entries(mods.mechanics ?? {}).filter(([, m]) => m.sounds && typeof m.sounds === 'object').map(([id, m]) => [id, m.sounds]));
  // a mechanic's own things (manifest.items, kit/assets/items.js): its default table goes into the game when the spec gives none
  const mechanicItems = Object.fromEntries(Object.entries(mods.mechanics ?? {}).filter(([, m]) => Array.isArray(m.manifest?.items)).map(([id, m]) => [id, m.manifest.items]));
  const C = await specToConfig(spec, { place, modules, lookPreset, lookConfig, standinPresetValues: standinLook.presetValues, mechanicDefaults, mechanicSounds, mechanicItems, worldConfig, flow: flowUse, flat: flat ? { part: flatPart, plane: flat, style: flatPart.presets[spec.look?.preset]?.style ?? 'pixel', repoFile: flatFile } : null });
  C.notes.unshift(...madeNotes, ...(await applyKind(C, spec, { place })).notes);   // the kind's layer: kinds/apply.mjs (the one seam)
  // a param whose default follows the game's own config (a mechanic module's derive(game, params), after the kind has
  // set the camera): only what the spec left unset, and said in the notes
  for (const m of C.game?.mechanics ?? []) {
    const derive = mods.mechanics?.[m.id]?.derive, own = spec.mechanics.find(x => x.id === m.id)?.params ?? {};
    if (typeof derive !== 'function') continue;
    const set = Object.entries(derive(C.game, m.params) ?? {}).filter(([k]) => !(k in own));
    if (set.length) { Object.assign(m.params, Object.fromEntries(set)); C.notes.push(`mechanic ${m.id}: ${set.map(([k, v]) => `${k} ${v}`).join(', ')}, from the game's own config (the spec left it to the default)`); }
  }
  C.notes.push(...tableNotes);
  // how a friend is seen (gf/mp/presence.js; builder/multiplayer/STANDARD.md): a character, or, when no player is one,
  // seats round one board or each friend's own board beside yours. The three runtime draws seats and boards
  // (gf/three/ui/presence.js) with the stand-in avatar in its ui.avatar slot and the mood words as text slots.
  const friends = await shapeOfSpec(spec, { of: id => mods.mechanics?.[id]?.manifest ?? null });
  if (friends.shape && C.game.players) {
    C.game.players.presence = friends.shape;
    if (friends.shape !== 'character' && place.runtime === 'three') {
      C.assets.push({ to: AVATAR_FILE, from: AVATAR, license: AVATAR_LICENSE, note: 'the stand-in avatar a friend wears on their seat card (ui.avatar)' });
      C.game.text = { ...MOOD_TEXT, ...(C.game.text ?? {}) };
      C.notes.push(`friends: no player is a character here (${friends.held.join(', ') || 'the spec says so'}), so each friend is shown as ${friends.shape}: ${friends.sees}`);
    } else if (friends.shape !== 'character') C.notes.push(`friends: ${friends.shape} is drawn by the three runtime; ${place.runtime} has no presence part yet, so the game draws it (a build line)`);
  }
  // optional kit modules (a kit folder with a module.js; kit/vfx/module.js documents the contract): one the spec (or the
  // rules.js already there) needs gets its config block, its stand-in files and its folder in gf/three. A module added
  // to the kit later needs no line here. A game that needs none is unchanged.
  const extraFiles = [], extras = new Set(prev.extras ?? []);
  if (!coreDrawn(place)) {
    const rules = (await gameCodeTexts(dir)).join('\n');      // rules.js and the game's own src/ modules
    for (const id of await optionalModuleDirs()) {
      const m = await importKitModule(kitPath(KIT, id, 'module.js'));
      if (m.error) { warnings.push(`kit module ${id}: ${m.error.message.split('\n')[0]}`); continue; }
      if (!extras.has(id) && !m.uses?.(spec, { rules })) continue;
      extras.add(id);
      const frag = m.configFor?.(spec, { rules });
      if (frag?.game) C.game = mergeMissing(C.game, frag.game);
      for (const f of m.files?.(C.game) ?? []) extraFiles.push({ from: kitPath(KIT, f.from), to: f.to });
    }
    if (extras.size) modules.extras = [...extras].sort();
  }

  // the game's declared overrides (CONTRACT §1.7): its edits of kit files are kept through a re-run, unless the kit has
  // moved a file on since the edit's base; then nothing is written and the override that needs a rebase is named
  const conflicts = await overrideConflicts(dir, kitNow());
  if (conflicts.length) return { ok: false, code: 1, problems: conflicts.map(c => c.words) };
  const heldOverrides = await holdOverrides(dir);
  const wrote = [], kept = [];
  const own = async (rel, buf) => {     // a file the game agent or Studio owns: kept when it exists, unless --force
    const p = join(dir, rel);
    if (existsSync(p) && !(rel === 'rules.js' ? newRules : force)) { const cur = await readFile(p); if (!cur.equals(Buffer.from(buf))) kept.push(rel); return; }
    await put(p, buf, wrote, rel);
  };
  const gen = (rel, buf) => put(join(dir, rel), buf, wrote, rel);   // generated: always the create output
  await mkdir(dir, { recursive: true });

  await gen('spec.json', specBytes);
  for (const n of ['game', 'look', 'world', 'characters']) await own(`config/${n}.json`, json(C[n]));
  if (C.props) await own('config/props.json', json(C.props));
  for (const a of C.assets) await own(a.to, await readFile(a.from));
  for (const f of extraFiles) await own(f.to, await readFile(f.from));
  await own('multiplayer.json', json(C.multiplayer));
  await own('rules.js', rulesStub(spec, parts, flowUse ? flow : null, flat ? { plane: flat, note: flatPart.manifest.note(flat), controls: flatPart.manifest.planes[flat].controls } : null));
  if (!coreDrawn(place)) await gen('index.html', indexHtml(spec.title, place));
  await gen('main.js', mainJs(place));

  // the kit and everything vendored
  const kit = await vendorKit(dir, modules); wrote.push(...kit.wrote);
  // `kitDir` (tests): vendoring is tools/lib/vendor.mjs's and copies this kit. A mechanic folder only the other kit
  // has is carried in beside it, so the game still runs; gf/three/kit.js does not list it (verify check 2 would say so).
  if (kitDir !== KIT) for (const id of modules.mechanics.filter(id => !existsSync(kitPath(KIT, 'mechanics', id)))) {
    for (const rel of await walk(kitPath(kitDir, 'mechanics', id))) { if (/(^|\/)(fixture|tests?)(\/|$)/.test(rel) || /\.md$/i.test(rel)) continue; await put(join(dir, 'gf/three/mechanics', id, rel), await readFile(kitPath(kitDir, 'mechanics', id, rel)), wrote, `gf/three/mechanics/${id}/${rel}`); }
  }
  wrote.push(...(await vendorGfAssets(dir)).wrote);
  for (const f of AUDIO_FILES) await put(join(dir, 'audio', f), await readFile(join(GF_AUDIO, 'source', f)), wrote, `audio/${f}`);
  const ad = await adopt(dir, { log: () => {} });
  if (!ad.ok) return { ok: false, code: 1, problems: ad.problems };
  wrote.push(...ad.wrote);
  const libs = await vendorLibraries(dir, [...kit.sourceTexts, ...(await gameCodeTexts(dir, heldOverrides))], { place }); wrote.push(...libs.wrote);
  // the declared overrides go back over the kit's files (each one's base is the file just written: overrideConflicts)
  for (const [p, buf] of heldOverrides) { await put(join(dir, p), buf); kept.push(p); }
  // forge: the page, once everything it names is in place (it asks for every module of the game at once)
  if (place.runtime === 'forge') await gen('index.html', indexHtml(spec.title, place, { preload: await forgeModules(dir) }));
  // vista: the page names no core module (the boot loads the core only once WebGPU is there)
  if (place.runtime === 'vista') await gen('index.html', indexHtml(spec.title, place));

  // every table entry's picture its own file (open builder wave 10): a default's "library:<id>" copied in, with its grip
  // and licence (tools/lib/items-lib.mjs)
  const pics = await ensurePictures(dir);
  C.notes.push(...pics.changed.map(c => `picture: ${c}`));
  warnings.push(...pics.problems);
  // the build record, then assets.json from the declarations (keeping the sound list a game already has)
  const record = {
    kit: { name: 'gf-three', version: KIT_VERSION, runtime: place.runtime, ...(place.profile ? { profile: place.profile } : {}), ...(isScenic(place) ? { scenic: SCENIC_VERSION } : {}), ...(place.runtime === 'forge' ? { forge: FORGE_VERSION } : {}), ...(place.runtime === 'vista' ? { vista: VISTA_VERSION } : {}) },
    game: slugOf(spec.title), loop: spec.loop, kind: spec.kind, look: { preset: spec.look.preset, time: spec.look.time },
    spec: { file: 'spec.json', sha256: sha256(specBytes), ...(spec.ledger?.sha256 ? { ledger: spec.ledger.sha256 } : {}) },
    options, modules, named: C.named, props: C.propFiles, bodies: C.bodies, notes: C.notes, ...(C.worldArt ? { worldArt: C.worldArt } : {}),
    ...(prevRecord.overrides ? { overrides: prevRecord.overrides } : {}),
  };
  await gen('gf-three.json', json(record));
  let sounds = C.sounds;
  if (existsSync(join(dir, 'assets.json')) && !force) { try { sounds = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')).sounds ?? sounds; } catch {} }
  let A = await assembleManifest(dir, { sounds, modules });
  // the art order's library step: every declared file slot the game still lacks is filled from the asset library
  A = await libraryFill(dir, A, { spec, record, put: own, rewrite: gen, assemble: () => assembleManifest(dir, { sounds, modules }), warnings });
  warnings.push(...A.warnings);
  await gen('assets.json', json(A.manifest));
  await gen('ATTRIBUTION.md', attribution(spec, record));
  // the kit's own licence (MIT) beside its code: gf/three/LICENSE comes with the kit copy; gf/LICENSE says it covers
  // all of games.fun's code in the game (a forge game's gf/three/ is a closure without it)
  await gen('gf/LICENSE', kitLicence(await readFile(kitPath(KIT, 'LICENSE'), 'utf8')));
  return { ok: true, code: 0, dir, ms: Math.round(performance.now() - t0), wrote, kept, warnings, notes: C.notes, modules, why, slots: A.slotCount, main: A.mainCount };
}

/** Fill `into` with what `from` has and it lacks (deep): a value the spec or a creator already set wins. */
function mergeMissing(into, from) {
  if (!into || typeof into !== 'object' || Array.isArray(into)) return into ?? from;
  const out = { ...into };
  for (const [k, v] of Object.entries(from ?? {})) out[k] = k in out ? (v && typeof v === 'object' && !Array.isArray(v) ? mergeMissing(out[k], v) : out[k]) : v;
  return out;
}

const slugOf = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'game';
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** main.js: the shared boot, or (forge, vista: CONTRACT §8) the shared boot without three.js. `place`: {runtime, profile}. */
export function mainJs(place = { runtime: 'three' }) {
  const boot = place.runtime === 'forge' ? 'boot-forge.js' : place.runtime === 'vista' ? 'boot-vista.js' : 'boot.js';
  return `import { boot } from './gf/three/core/${boot}';\nimport rules from './rules.js';\nboot({ rules });\n`;
}

/**
 * A forge game's modules, as the page will ask for them (wave 3, track M): every file main.js reaches through static
 * imports in the game folder, the loading view's first. The page preloads them all at once; without the list a
 * browser finds each only when the one importing it has arrived (53 files, one round trip after another: 3 s of a
 * phone's first view). JSON modules are left to their importers (no browser preloads them as modules everywhere).
 */
export async function forgeModules(dir, entries = ['gf/three/ui/loading.js', 'main.js']) {
  const seen = new Set(), order = [];
  const visit = async rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = await readFile(join(dir, rel), 'utf8').catch(() => null);
    if (text === null) return;
    order.push(rel);
    // static imports and re-exports at the start of a statement (a commented example does not start one)
    for (const m of text.matchAll(/(?:^|[;\n])[ \t]*(?:import|export)\b(?:[^'"();]*?\bfrom\b)?[ \t]*['"](\.{1,2}\/[^'"]+)['"]([^;\n]*)/g)) {
      if (/\btype\s*:\s*['"]json['"]/.test(m[2]) || !/\.m?js$/.test(m[1])) continue;
      const to = posix.normalize(posix.join(posix.dirname(rel), m[1]));
      if (!to.startsWith('..')) await visit(to);
    }
  };
  for (const e of entries) await visit(e);
  return order;
}

/** The inline script of a forge page: the core's wasm, downloading and compiling from the page's first bytes (the
 *  boot takes the compiled module: window.__gfEarly.wasm.module; .bytes is what has come in, for the loading bar).
 *  The WebGPU build where the browser has WebGPU, else the WebGL2 build (wave 3, track W), and ?gf-forge-backend= as the
 *  loader reads it; `.backend` says which, and the loader takes the module only for the build it picks (a browser
 *  with WebGPU and no adapter downloads its WebGL2 build after all). The build's glue module is asked for with it: the
 *  loader imports it by name once it has picked, so it is not in the page's own preload list. */
const FORGE_EARLY = `(function(){if(!WebAssembly.compileStreaming||!window.ReadableStream)return;var q=/[?&]gf-forge-backend=(webgpu|webgl2?)(?:&|$)/.exec(location.search),b=q?(q[1]==='webgpu'?'webgpu':'webgl2'):(navigator.gpu?'webgpu':'webgl2'),E=window.__gfEarly={bytes:0,wasm:null},d=b==='webgpu'?'gf/forge/wasm/':'gf/forge/wasm-webgl2/',u=d+'forge_web_bg.wasm';try{var l=document.createElement('link');l.rel='modulepreload';l.href=d+'forge_web.js';document.head.appendChild(l)}catch(e){}try{var m=fetch(u).then(function(r){if(!r.ok||!r.body)throw new Error('HTTP '+r.status);var d=r.body.getReader();return WebAssembly.compileStreaming(new Response(new ReadableStream({pull:function(c){return d.read().then(function(x){if(x.done){c.close();return}E.bytes+=x.value.byteLength;c.enqueue(x.value)})},cancel:function(w){return d.cancel(w)}}),{headers:{'Content-Type':'application/wasm'}}))});m.catch(function(){});E.wasm={url:u,module:m,backend:b}}catch(e){}})();`;

export function indexHtml(title, place = { runtime: 'three', profile: 'standard-3d' }, { preload = null } = {}) {
  // vista (CONTRACT §8 vista): no import map (every import is relative); the core draws into #app (its Engine's
  // container); the loading view starts with the page. The core's modules are loaded by the boot once the browser is
  // known to have WebGPU, so a browser without it gets the kit's screen, never a blank page
  if (place.runtime === 'vista') return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(title)}</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#05080c}#app{position:fixed;inset:0}#app canvas{display:block}</style>
<script type="module">import { startLoading } from './gf/three/ui/loading.js'; startLoading();</script>
<script type="module" src="main.js"></script>
</head>
<body><div id="app"></div></body>
</html>
`;
  // forge (CONTRACT §8 forge): every import is relative (no three.js, no Rapier), so there is no import map.
  // Wave 3 (track M): the wasm starts with the page, and every module is asked for at once (forgeModules); a page
  // written without the list (preload null) still loads, one import after another
  if (place.runtime === 'forge') return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(title)}</title>
<link rel="icon" href="data:,">
<style>html,body{margin:0;background:#07080a}</style>
<script>${FORGE_EARLY}</script>
${(preload?.length ? preload : ['gf/forge/host.js']).map(f => `<link rel="modulepreload" href="${escHtml(f)}">`).join('\n')}
<script type="module">import { startLoading } from './gf/three/ui/loading.js'; startLoading({ theme: 'grim' });</script>
<script type="module" src="main.js"></script>
</head>
<body></body>
</html>
`;
  // the scenic-3d profile (CONTRACT §8): every module shares one three, the WebGPU build (WebGL2 fallback inside it)
  const map = isScenic(place)
    ? { imports: { three: './vendor/three/build/three.webgpu.js', 'three/webgpu': './vendor/three/build/three.webgpu.js', 'three/tsl': './vendor/three/build/three.tsl.js', 'three/addons/': './vendor/three/examples/jsm/', 'three/examples/jsm/': './vendor/three/examples/jsm/', '@dimforge/rapier3d-compat': './vendor/rapier/rapier.mjs' } }
    : { imports: { three: './vendor/three/build/three.module.js', 'three/addons/': './vendor/three/examples/jsm/', 'three/examples/jsm/': './vendor/three/examples/jsm/', '@dimforge/rapier3d-compat': './vendor/rapier/rapier.mjs', postprocessing: './vendor/postprocessing/postprocessing.module.js', n8ao: './vendor/n8ao/N8AO.js' } };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${escHtml(title)}</title>
<link rel="icon" href="data:,">
<script type="importmap">
${JSON.stringify(map, null, 2)}
</script>
<script type="module" src="main.js"></script>
</head>
<body></body>
</html>
`;
}

const comment = (s, w = 110) => String(s ?? '').split(/\n/).flatMap(line => { const out = []; let cur = ''; for (const word of line.split(/\s+/)) { if ((cur + ' ' + word).trim().length > w) { out.push(cur); cur = word; } else cur = (cur + ' ' + word).trim(); } out.push(cur); return out; }).map(l => `//   ${l}`.trimEnd()).join('\n');

/**
 * The rules.js create writes for a forge game (wave 3, track S3). The kit plays the tables by itself (the fight, the
 * waves, the reward, down and revive, the HUD); four things only the rules can say, and they are the same for every
 * wave game, so the stub says them and the build agent starts from a game that scores, can be won and can be lost
 * (prompts/build-forge.md; verify check 6 fells a player alone and waits for the results). A forge game with no waves
 * gets the hooks and the comments only.
 */
function forgeRulesStub(spec) {
  const controls = Object.entries(spec.controls ?? {}).map(([k, v]) => `//   ${k}: ${v}`).join('\n') || '//   (none named)';
  const waves = (spec.tables?.waves ?? []).length > 0 && (spec.tables?.enemies ?? []).length > 0;
  const head = `// rules.js: THE GAME AGENT'S FILE. ${spec.title}: what makes this game this game, on the forge runtime (builder/CONTRACT.md §8 forge).
// Written by create.mjs from the spec. The kit already plays the data tables (config/game.json → forge): the fight, the
// waves, the three-card reward of a wave marked reward, down and revive, the HUD, the menu, friends. Tune numbers there.
//
// Hook: ${spec.hook ?? ''}
// Rules:
${comment(spec.rules.summary)}
// Scoring: ${spec.rules.scoring ?? '(see the rules)'}
// Win: ${spec.round?.winBy ?? 'the last wave is cleared'}${spec.round?.loseBy ? `\n// Lose: ${spec.round?.loseBy}` : ''}
// Round: at most ${spec.round?.seconds} s · players ${spec.players.min}–${spec.players.max}, co-op
// Tuning numbers (config/game.json → rules.params, each a rules.* slot): ${JSON.stringify(spec.rules.params ?? {})}
// Controls (the core's own: fire, jump, Shift evades, R reloads, V is a quick melee, the number keys pick a weapon):
${controls}
// Not in v1: ${(spec.notInV1 ?? []).join('; ') || '—'}
// The creator will judge: ${(spec.accept ?? []).join('; ') || '—'}
//
// The core's rule events reach event(ctx, name, d): d = {entity, a, b, c, d}. Players are named by their core id
// (ctx.players.nid(p.id) → n, ctx.players.byNid(n) → p). Commands go in through ctx.forge.cmd, on the host only.
`;
  if (!waves) return `${head}
export default {
  // Once on every copy, after the world and the players exist.
  setup(ctx) {},
  // Every copy, when the round starts. Keep commands and scoring under \`if (ctx.host)\`.
  roundStart(ctx) { for (const p of ctx.players.list()) p.score = 0; },
  // Every frame on every copy.
  update(ctx, dt) {},
  // A rule event from the core (or a message another copy sent with ctx.net.send).
  event(ctx, name, d) {},
  // Host only: is the round over? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at round end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
`;
  return `${head}import { FEEL_OP } from './gf/forge/feel.js';

export default {
  // Once on every copy, after the world and the players exist.
  setup(ctx) {},
  // Every copy, when the round starts.
  roundStart(ctx) {
    for (const p of ctx.players.list()) p.score = 0;
    if (!ctx.host) return;
    // start over: health and armour from the tables, last run's cards gone, weapons refilled; old pieces and coins cleared
    for (const p of ctx.players.list()) { const n = ctx.players.nid(p.id); if (n != null) ctx.forge.cmd.raw(FEEL_OP.RESET, [n]); }
    ctx.forge.cmd.raw(FEEL_OP.CLEAR, []);
  },
  // A rule event from the core. Score on events, never every frame; the host's word counts.
  event(ctx, name, d) {
    const host = ctx.host && ctx.round.phase === 'playing';
    // score: a kill's points to whoever landed it (d.d: the killer's core id), a coin's value to whoever it reaches
    if (name === 'enemy-down') { const p = ctx.players.byNid(d.d); if (p && host) p.score += Math.max(1, Math.round(d.b || 1)); }
    else if (name === 'coin') { const p = ctx.players.byNid(d.entity); if (p && host) p.score += Math.max(0, Math.round(d.a || 0)); }
    // win: the last wave is cleared, whoever still stands wins
    else if (name === 'waves-done' && host) ctx.round.end('cleared', ctx.players.list().filter(p => p.alive !== false).map(p => p.id));
  },
  // Every frame on every copy.
  update(ctx, dt) {
    if (!ctx.host || ctx.round.phase !== 'playing') return;
    // lose: nobody stands (with friends a fallen player is down until one of them brings them back)
    const all = ctx.players.list();
    if (all.length && all.every(p => p.alive === false)) { ctx.round.end('lost', []); return; }
    // the clock: a run the clock ends is not won (left to itself the kit would name the top scorer the winner)
    if (ctx.time.left <= 0.5) ctx.round.end('time', []);
  },
  // Host only: is the round over for another reason? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at round end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
`;
}

/**
 * The rules.js create writes for a vista game (CONTRACT §8 vista; prompts/build-vista.md). The core plays the island by
 * itself (walking, swimming, the boat, the fishing: bites, the catch, the cooler), and the kit's game bridge
 * (gf/vista/kit/game.js) turns what happens into events: bite, hooked, catch, lost, sold, bought, board, leave. The stub
 * plays as it is: a catch scores, and a game with a goal (rules.params.goalSpecies, a count of different kinds of fish)
 * ends the session for everyone when one player reaches it; the clock ends it otherwise. The build agent starts from a
 * game that can be played, scored and finished.
 */
function vistaRulesStub(spec) {
  const controls = Object.entries(spec.controls ?? {}).map(([k, v]) => `//   ${k}: ${v}`).join('\n') || '//   (none named)';
  return `// rules.js: THE GAME AGENT'S FILE. ${spec.title}: what makes this game this game, on the vista runtime (builder/CONTRACT.md §8 vista).
// Written by create.mjs from the spec. The kit already plays the island (walk, swim, the boat), the fishing (cast, bite,
// the catch, the cooler, the buyer, the shop) from the data tables (config/game.json → vista), the look
// (config/look.json), the HUD, the menu and friends. Tune numbers there.
//
// Hook: ${spec.hook ?? ''}
// Rules:
${comment(spec.rules.summary)}
// Scoring: ${spec.rules.scoring ?? '(see the rules)'}
// Win: ${spec.round?.winBy ?? 'the goal, before the clock runs out'}${spec.round?.loseBy ? `\n// Lose: ${spec.round?.loseBy}` : ''}
// Session: at most ${spec.round?.seconds} s · players ${spec.players.min}–${spec.players.max}, together on one island
// Tuning numbers (config/game.json → rules.params, each a rules.* slot): ${JSON.stringify(spec.rules.params ?? {})}
// Controls (the core's own: WASD walk, mouse look, R the rod, hold and release the left button to cast, E to board,
// take the helm and trade; How to play lists them):
${controls}
// Not in v1: ${(spec.notInV1 ?? []).join('; ') || '—'}
// The creator will judge: ${(spec.accept ?? []).join('; ') || '—'}
//
// What the rules can use (ctx): ctx.vista.state() → {money, cooler, rod, fight, near, catches, log}; ctx.vista.sell(),
// ctx.vista.buy(id); ctx.vista.look.set({hour, sea, exposure}); ctx.vista.tables (the filled data tables); ctx.me (this
// copy's player: its score is what the results show); ctx.finish(reason) ends the session for everyone with the results.
// Events reach event(ctx, name, d) on the copy where they happened (each player fishes on their own copy):
//   bite, hooked, catch {species, name, kg, cm, value}, lost, sold {sold, money}, bought {id, money}, board, leave.
// Never touch the core (gf/vista/core) or the kit; never draw your own HUD over the kit's.
export default {
  // Once on every copy, after the island, the players and the HUD exist.
  setup(ctx) {},
  // Every copy, when the session starts.
  roundStart(ctx) { for (const p of ctx.players.list()) p.score = 0; },
  // A game event on this copy (see above), or a message another copy sent with ctx.net.send.
  event(ctx, name, d) {
    if (ctx.round.phase !== 'playing') return;
    // score: one point a fish landed (the results show each player's own)
    if (name === 'catch') {
      ctx.me.score += 1;
      // the goal: this many different kinds of fish (rules.params.goalSpecies), then the session ends for everyone
      const goal = Number(ctx.config.rules?.params?.goalSpecies) || 0;
      if (goal > 0 && Object.keys(ctx.vista.state().log ?? {}).length >= goal) ctx.finish('goal');
    }
  },
  // Every frame on every copy.
  update(ctx, dt) {},
  // Host only: is the session over for another reason? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at the end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
};
`;
}

/** A mechanic's block of setup(): what it is, its note, a worked line, its traps, then each callback it offers as an
 *  empty named handler (the manifest's `stub` and `events`). */
function stubBlock(part, as, spec) {
  const m = part.manifest, cap = x => x[0].toUpperCase() + x.slice(1), v = m.stub.as;
  const out = [`    // ---- ${part.id}${as ? ` — "${as}"` : ''}: ${m.describe}`];
  for (const n of m.note ?? []) out.push(`    //   ${n}`);
  if (m.state?.key) out.push(`    //   state: window.__game.snapshot().shared.${m.state.key} (what a test reads; the rules read it through ${v}'s own methods) → ${Object.entries(m.state.fields ?? {}).map(([k, d]) => `${k}: ${d}`).join('; ')}`);
  out.push(`    //   worked: ${m.stub.worked}`);
  for (const t of m.stub.traps ?? []) out.push(`    //   trap: ${t}`);
  if (!(m.events ?? []).length) { out.push(`    //   no callbacks: read it where the rules need it (const ${v} = ctx.mechanics.get('${part.id}');)`); return out.join('\n'); }
  out.push(`    const ${v} = ctx.mechanics.get('${part.id}');`);
  for (const e of m.events) out.push(`    ${v}?.${e.name}?.(function on${cap(part.id.replace(/-(.)/g, (_, c) => c.toUpperCase()))}${e.name.slice(2)}(e) {});   // ${e.on}: ${e.when ?? ''} · e = ${e.args}`);
  return out.join('\n');
}

/** rules.js for a new game: the spec's rules as comments, the six hooks, and in setup() the stub of each mechanic the
 *  spec uses (from its manifest). Nothing in it does anything yet: every handler is empty. */
export function rulesStub(spec, parts = [], flow = null, flat = null) {
  if (spec.runtime === 'forge') return forgeRulesStub(spec);
  if (spec.runtime === 'vista') return vistaRulesStub(spec);
  // a flow that has its own hooks (kit/loops/<id> → manifest.stub and events): its note, a worked line and its traps
  // above the hooks, and each hook it calls as an empty one. The timed round's six hooks are the ones below.
  const F = flow?.manifest?.stub ? flow.manifest : null;
  const own = new Set(['setup', 'roundStart', 'update', 'event', 'check', 'results']);
  const joined = F?.stub.joined && (F.uses ?? []).some(u => spec.mechanics.some(m => m.id === u)) ? F.stub.joined : null;
  const flowHead = joined ? `// Loop: ${flow.id} — ${F.describe} (ctx.${F.stub.as}; config/game.json → round.params ${JSON.stringify(spec.round?.params ?? {})})\n//   ${joined}\n` : F ? `// Loop: ${flow.id} — ${F.describe} (ctx.${F.stub.as}; config/game.json → round.params ${JSON.stringify(spec.round?.params ?? {})})\n${F.note.map(n => `//   ${n}`).join('\n')}\n${F.state?.key ? `//   state: window.__game.snapshot().shared.${F.state.key} (what a test reads; the rules read it through ctx.${F.stub.as}) → ${Object.entries(F.state.fields ?? {}).map(([k, d]) => `${k}: ${d}`).join('; ')}\n` : ''}//   worked: ${F.stub.worked}\n${F.stub.traps.map(t => `//   trap: ${t}`).join('\n')}\n` : '';
  const flowHooks = F && !joined ? F.events.filter(e => !own.has(e.name)).map(e => `  // ${flow.id}, ${e.on}: ${e.when ?? ''} · ${e.args}\n  ${e.name}(${(/^\(([^)]*)\)/.exec(e.args)?.[1] ?? 'ctx')}) {},\n`).join('') : '';
  const mech = spec.mechanics.map(m => `//   ${m.id}${m.as ? ` — "${m.as}"` : ''} ${JSON.stringify(m.params ?? {})}`).join('\n');
  const controls = Object.entries(spec.controls ?? {}).map(([k, v]) => `//   ${k}: ${v}`).join('\n') || '//   (none named)';
  const byId = new Map(parts.filter(p => p.manifest?.stub && Array.isArray(p.manifest.events)).map(p => [p.id, p]));
  const seen = new Set(), blocks = [];
  for (const m of spec.mechanics) { if (seen.has(m.id) || !byId.has(m.id)) continue; seen.add(m.id); blocks.push(stubBlock(byId.get(m.id), m.as, spec)); }
  const setup = blocks.length
    ? `setup(ctx) {\n    // Each mechanic below offers these callbacks. Every handler is empty: write the ones this game needs and delete the\n    // rest. "host" handlers run on the host's copy only (it owns the shared world); never change scores elsewhere.\n${blocks.join('\n\n')}\n  },`
    : 'setup(ctx) {},';
  return `// rules.js: THE GAME AGENT'S FILE. ${spec.title}: what makes this game this game (builder/CONTRACT.md §3).
// Written by create.mjs as a stub from the spec; the kit already runs the home menu, the HUD, players, bots, the round and replay (CONTRACT §6g).
//
// Hook: ${spec.hook ?? ''}
// Rules:
${comment(spec.rules.summary)}
// Scoring: ${spec.rules.scoring ?? '(see the rules)'}
// Win: ${spec.round?.winBy ?? 'most points when time runs out'}${spec.round?.loseBy ? `\n// Lose: ${spec.round?.loseBy}` : ''}
// Round: ${spec.loop === 'world' ? 'none (a world: players drop in and out)' : Number.isInteger(spec.round?.seconds) ? `${spec.round?.seconds} s` : 'no clock'} · players ${spec.players.min}–${spec.players.max}${spec.players.bots !== false ? ', bots fill empty seats' : ''}
// Tuning numbers (config/game.json → rules.params, each a rules.* slot): ${JSON.stringify(spec.rules.params ?? {})}
// Mechanics (ctx.mechanics.get(id); params in config/game.json → mechanics${blocks.length ? '; what each offers is in setup() below' : ''}):
${mech}
// Controls (ctx.me.actions.<name>.pressed / .down):
${controls}
// Not in v1: ${(spec.notInV1 ?? []).join('; ') || '—'}
// The creator will judge: ${(spec.accept ?? []).join('; ') || '—'}
${flat ? `// Flat (2D), plane ${flat.plane} (kit/flat). ${flat.controls}\n${flat.note.map(n => `//   ${n}`).join('\n')}\n` : ''}${flowHead}
export default {
  // Once on every copy, after the world, players and mechanics exist: register shared state, UI, listeners.
  ${setup}
  // Every copy, when the round starts (the same moment for everyone).
  roundStart(ctx) {},
  // Every frame on every copy. Keep host-only logic under \`if (ctx.host)\`.
  update(ctx, dt) {},
  // A gameplay event from another copy (ctx.net.send(name, data, to) on their side).
  event(ctx, name, data, from) {},
  // Host only: is the round over? null, or { winners: [playerId], reason }.
  check(ctx) { return null; },
  // Every copy, at round end: the rows of the results card.
  results(ctx) { return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score })); },
${flowHooks}};
`;
}

/** gf/LICENSE: which of the game's folders are the kit's (MIT), then the kit's licence text as it is. */
export function kitLicence(text) {
  return `The games.fun kit code in this game is under the MIT licence below: gf/three/, gf/scenic/, gf/forge/ and gf/vista/kit
and gf/vista/hud (a scenic, forge or vista game), gf/mp/, gf/gf-assets.js and audio/. Third-party files inside them and in
vendor/ keep their own licence, which sits beside each copy (a vista game's core, gf/vista/core/, is Tidewater's, under its
own MIT licence: gf/vista/core/LICENSE and ATTRIBUTION.md); ATTRIBUTION.md lists them and the art. The game's own files (rules.js, config/, its art and
sounds) are the maker's.

${text.trim()}
`;
}

/** The files a game uses whose licence asks for credit (CC BY): one full credit each, by file. */
export function creditsOf(record) {
  const out = [];
  const add = (file, what, l) => { if (l?.licenseUrl && !out.some(c => c.file === file)) out.push({ file, what, spdx: l.spdx, title: l.title ?? what, author: l.author ?? '', source: l.url ?? '', licenseUrl: l.licenseUrl, credit: l.credit ?? null, modified: l.modified ?? null }); };
  for (const [name, p] of Object.entries(record.props ?? {})) add(p.file, `prop "${name}"`, p.license);
  for (const [role, b] of Object.entries(record.bodies ?? {})) add(b.file, `body of "${role}"`, b.license);
  return out;
}
/** One credit line: title, author, source link, licence and its link, and what was changed. */
export const creditLine = c => `"${c.title}" by ${c.author}${c.source ? ` (${c.source})` : ''}, licensed under ${c.spdx.replace(/^CC-BY-/, 'CC BY ')} (${c.licenseUrl})${c.modified ? `; changed: ${c.modified}` : ''}`;

export function attribution(spec, record) {
  const art = [], credits = creditsOf(record);
  const lic = (file, l) => { const c = credits.find(x => x.file === file); return c ? creditLine(c) : `${l?.spdx ?? 'see library/LICENSES.json'}${l?.author ? `, ${l.author}` : ''}`; };
  for (const [name, p] of Object.entries(record.props ?? {})) art.push(`| ${p.file} | prop "${name}" (${p.from}) | ${lic(p.file, p.license)} |`);
  for (const [role, b] of Object.entries(record.bodies ?? {})) art.push(`| ${b.file} | body of "${role}" (${b.from}) | ${lic(b.file, b.license)} |`);
  const scenic = record.kit?.runtime === 'three' && record.kit?.profile === 'scenic-3d', forge = record.kit?.runtime === 'forge', vista = record.kit?.runtime === 'vista';
  const creditText = credits.length ? `\n## Credits\n\nThese files are used under a licence that asks for credit. Keep these lines with the game while it uses them (the game's How to play shows them to players); a file you replace with your own needs no line.\n\n${credits.map(c => `- ${c.file}: ${creditLine(c)}`).join('\n')}\n` : '';
  if (forge) return forgeAttribution(spec, record, art) + creditText;
  if (vista) return vistaAttribution(spec, record, art) + creditText;
  if (!scenic) art.push('| assets/textures/ground.ktx2 | ground (stand-in: Poly Haven leafy_grass, converted to KTX2) | CC0-1.0, Poly Haven |');
  for (const a of record.worldArt ?? []) art.push(`| ${a.file} | ${a.what} | ${a.license} |`);
  const libs = scenic
    ? ['| three.js 0.186.0 (WebGPU build, WebGL2 fallback) | vendor/three/ (three.webgpu.js, three.tsl.js, three.core.js and the addons the game imports, byte-identical to the npm tarball) | MIT |']
    : ['| three.js 0.186.0 | vendor/three/ (build and the addons the game imports, byte-identical to the npm tarball) | MIT |'];
  libs.push('| Draco decoder 1.5.6, Basis Universal transcoder 1.50 (from three.js) | vendor/three/examples/jsm/libs/{draco,basis}/ (LICENSE in each) | Apache-2.0 |', '| ktx-parse 1.1.0 and zstddec 0.0.2 by Don McCurdy, the second with the Zstandard decoder inside (from three.js) | vendor/three/examples/jsm/libs/ (LICENSE-ktx-parse, LICENSE-zstddec, LICENSE-zstd) | MIT; Zstandard BSD-3-Clause |', '| @dimforge/rapier3d-compat 0.19.2 | vendor/rapier/ | Apache-2.0 |');
  if (!scenic) libs.push('| pmndrs postprocessing 6.39.5 | vendor/postprocessing/ | Zlib |', '| N8AO | vendor/n8ao/ (LICENSE) | CC0-1.0 |');
  libs.push('| pmndrs/ecctrl (floating-capsule logic, ported) | gf/three/controller/capsule.mjs; LICENSE-ecctrl and NOTICE-ecctrl beside it | MIT |');
  if (scenic) libs.push('| folio-2025 by Bruno Simon (rendering, materials, lighting, terrain and vegetation, ported; brunosimon/folio-2025@41046b5) | gf/scenic/ (LICENSE-folio-2025 beside it) | MIT |');
  libs.push(`| gf-three${scenic ? `, gf-scenic ${record.kit.scenic}` : ''}, gf-multiplayer ${MP_KIT_VERSION}, gf-assets 1.3.0, gf-audio 1.5.0 (ZzFX, MIT) | gf/three/,${scenic ? ' gf/scenic/,' : ''} gf/mp/, gf/gf-assets.js, audio/ | MIT, Copyright (c) 2026 games.fun (gf/LICENSE) |`);
  return `# ${spec.title}: credits

Made with xgames-kit's three runtime ${KIT_VERSION}${scenic ? ` on its scenic-3d profile ${record.kit.scenic}` : ''} by create.mjs from spec.json. Licences travel with the code: each library's licence sits beside its copy.

## Code

| What | Where | Licence |
|---|---|---|
${libs.join('\n')}

## Art

| File | What | Licence |
|---|---|---|
${art.join('\n')}

Sounds are gf-audio presets (synthesised, no files).
${creditText}`;
}

/** A vista game's credits (CONTRACT §8 vista): the vendored core (Tidewater, MIT; its own attribution travels with it at
 *  gf/vista/core/ATTRIBUTION.md, its field recordings' authors in gf/vista/core/public/audio/CREDITS.md), the shared
 *  kits, and the bodies. */
function vistaAttribution(spec, record, art) {
  art.push('| assets/clips/gf-humanoid-1.glb | the shared clips friends\' bodies play | CC0-1.0, Quaternius (Universal Animation Library), retargeted by games.fun |');
  return `# ${spec.title}: credits

Made with xgames-kit ${KIT_VERSION} and its vista runtime ${record.kit.vista} by create.mjs from spec.json. Licences travel with the code: each library's licence sits beside its copy.

## Code

| What | Where | Licence |
|---|---|---|
| the vista core: Tidewater by DRG Software Solutions LLC (Dan Greenheck), https://github.com/dgreenheck/tidewater at 4811ba48 (engine, ocean, sky, clouds, post, world, player, fishing and boat), with gf-vista's marked patches | gf/vista/core/ (LICENSE, ATTRIBUTION.md, CREDITS.md and PATCHES.md beside it) | MIT |
| the core's field recordings, scanned debris and props, cloud volumes, SMAA tables and two Rocketbox characters | gf/vista/core/public/ (each folder's CREDITS.md or LICENSE beside it; gf/vista/core/ATTRIBUTION.md lists them) | CC0-1.0 and MIT, as listed there |
| meshoptimizer's decoder | gf/vista/kit/vendor/meshopt_decoder.module.js (LICENSE-meshoptimizer beside it) | MIT |
| gf-three (the shared system, without three.js), gf-vista ${record.kit.vista} (kit and HUD), gf-multiplayer ${MP_KIT_VERSION}, gf-assets 1.3.0, gf-audio 1.5.0 (ZzFX, MIT) | gf/three/, gf/vista/kit/, gf/vista/hud/, gf/mp/, gf/gf-assets.js, audio/ | MIT, Copyright (c) 2026 games.fun (gf/LICENSE) |

No player-facing name, person or place of the upstream game is used: the game's words are its own (config/game.json).

## Art

| File | What | Licence |
|---|---|---|
${art.join('\n')}

Menu and HUD sounds are gf-audio presets (synthesised, no files); the island's own sounds are the core's field recordings above.
`;
}

/** A forge game's credits (CONTRACT §8 forge): the Rust core's crates (their licences in gf/forge/wasm/LICENSES.md),
 *  meshoptimizer's decoder, the shared kits, and the art. */
function forgeAttribution(spec, record, art) {
  const seen = new Set(art.map(r => r.split(' | ')[0]));
  for (const a of record.worldArt ?? []) if (!seen.has(`| ${a.file}`)) art.push(`| ${a.file} | ${a.what} | ${a.license} |`);
  return `# ${spec.title}: credits

Made with xgames-kit ${KIT_VERSION} and its forge runtime ${record.kit.forge} by create.mjs from spec.json. Licences travel with the code: each library's licence sits beside its copy.

## Code

| What | Where | Licence |
|---|---|---|
| the gf-forge core (Rust, compiled to gf/forge/wasm/forge_web_bg.wasm): wgpu, hecs, glam, gltf, bytemuck, wasm-bindgen and the crates they use | gf/forge/wasm/ (every crate, its version and licence, and the licence texts: gf/forge/wasm/LICENSES.md) | MIT, Apache-2.0, BSD, zlib |
| meshoptimizer's decoder (the copy three.js 0.186.0 ships) | gf/forge/vendor/meshopt_decoder.module.js (LICENSE-meshoptimizer beside it) | MIT |
| gf-three (the shared system, without three.js), gf-forge ${record.kit.forge}, gf-multiplayer ${MP_KIT_VERSION}, gf-assets 1.3.0, gf-audio 1.5.0 (ZzFX, MIT) | gf/three/, gf/forge/, gf/mp/, gf/gf-assets.js, audio/ | MIT, Copyright (c) 2026 games.fun (gf/LICENSE) |

## Art

| File | What | Licence |
|---|---|---|
${art.join('\n')}

${art.some(r => r.startsWith('| assets/sounds/')) ? 'Sounds are the files above, played through gf-audio; an id the forge library has no file for is a gf-audio preset (synthesised).' : 'Sounds are gf-audio presets (synthesised, no files).'}
`;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const pos = a.filter(x => !x.startsWith('--'));
  if (pos.length < 2) { console.error('usage: create.mjs <spec.json> <out-dir> [--force] [--new-rules] [--standins] [--standin-mechanics] [--json]'); process.exit(2); }
  const r = await create(pos[0], pos[1], { force: a.includes('--force'), newRules: a.includes('--new-rules'), standins: a.includes('--standins') || null, standinMechanics: a.includes('--standin-mechanics') || null });
  process.exitCode = r.code;   // set, never process.exit(): a large --json must drain into a pipe first
  if (a.includes('--json')) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (!r.ok) { for (const p of r.problems) console.error(`problem: ${p}`); console.error('create: FAILED'); }
  else await report(r);
}
async function report(r) {
  for (const w of r.why) console.log(`module  ${w}`);
  for (const n of r.notes) console.log(`note    ${n}`);
  for (const w of r.warnings) console.log(`warning ${w}`);
  // the set-dressing lint as notes (verify check 11 fails on its errors; the build agent fixes them in config/world.json);
  // a voxel world (CONTRACT §9) has no prop layout: its own lint is verify's world lint (tools/lib/worlds-check.mjs)
  const worldJson = JSON.parse(await readFile(join(r.dir, 'config/world.json'), 'utf8').catch(() => '{}'));
  const voxel = worldJson.template === 'voxel';
  // a vista world (CONTRACT §8 vista) is the core's island: no set-dressing lint applies to it
  if (worldJson.kind === 'vista-coast') console.log(`world   ${(worldJson.islands ?? []).length} island${(worldJson.islands ?? []).length === 1 ? '' : 's'} of the game's own (${(worldJson.islands ?? []).map(i => `${i.name}: seed ${i.seed}`).join('; ')}); start places ${Object.keys(worldJson.places ?? {}).join(', ')}`);
  // a forge world (CONTRACT §8 forge): the forge world lint (gf/forge/arena.js lintWorld, track A), checks 11 and 17's
  else if (/^forge-/.test(worldJson.kind ?? '')) try {
    const { lintWorld } = await import(pathToFileURL(join(r.dir, 'gf/forge/arena.js')).href);
    const game = JSON.parse(await readFile(join(r.dir, 'config/game.json'), 'utf8'));
    const en = game.forge?.enemies ?? [];
    const l = lintWorld(worldJson, { players: game.players?.max ?? 4, enemies: en.length > 0 && (game.forge?.waves ?? []).length > 0, casters: en.some(e => e.archetype === 'caster') });
    console.log(`dressing ${l.errors} errors, ${l.warnings} warnings (forge world lint, gf/forge/arena.js: verify checks 11 and 17)`);
    for (const p of l.problems) console.log(`dressing ${p.severity === 'error' ? 'ERROR' : 'warn '} ${p.check}/${p.rule}: ${p.message} → ${p.fix}`);
  } catch (e) { console.log(`dressing the forge world lint did not run: ${e.message}`); }
  else if (voxel) {
    const { lintWorld } = await import('./lib/worlds-check.mjs');
    const l = await lintWorld(r.dir, { kitDir: join(r.dir, 'gf/three') }).catch(e => ({ ok: false, errors: [e.message], notes: [] }));
    console.log(`world   ${l.ok ? 'lint clean' : `${l.errors.length} errors`}${l.notes.length ? `: ${l.notes.join('; ')}` : ''}`);
    for (const e of l.errors) console.log(`world   ERROR ${e}`);
  } else try {
    const { loadSubject, lintDressing, lines } = await import('./lib/dressing.mjs');
    const dr = lintDressing(await loadSubject(r.dir));
    console.log(`dressing ${dr.errors} errors, ${dr.warnings} warnings (node builder/tools/dressing.mjs <game>)`);
    for (const l of lines(dr)) console.log(`dressing ${l}`);
  } catch (e) { console.log(`dressing lint did not run: ${e.message}`); }
  for (const k of r.kept) console.log(`kept    ${k} (${/^(gf|audio|vendor)\//.test(k) ? 'a declared override: gf-three.json overrides' : `yours; ${k === 'rules.js' ? '--new-rules' : '--force'} replaces it`})`);
  console.log(`create: OK ${relative(process.cwd(), r.dir) || '.'} in ${(r.ms / 1000).toFixed(1)} s · ${r.wrote.length} files written, ${r.kept.length} kept · ${r.slots} slots (${r.main} main)`);
}
