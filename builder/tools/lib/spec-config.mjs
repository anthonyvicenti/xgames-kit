// A game spec v2 (builder/spec/game-spec.v2.schema.json) → the project's config files, sound list, multiplayer
// manifest and asset choices. Pure apart from reading the libraries (track L's props, track C's bodies) when they
// exist. Deterministic: positions come from a random stream seeded by the spec's title.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { STANDIN_ASSETS, KIT, FORGE, FORGE_KIT, VISTA_KIT, importPart, kitPath, isScenic } from './paths.mjs';
import { playersModeOf, isMade } from './spec.mjs';
import { createRng, hashString } from '../../../runtimes/three/kit/core/rng.js';
import { FAIR_DEFAULTS } from '../../../runtimes/three/kit/core/fair-logic.js';
import { assetsIn, bodiesIn, bodyEntry, findAsset, licenceOf, localFile, propEntry } from '../../art/views.mjs';
import { importLayer } from './kit-import.mjs';
// kit modules whose imports cross layers: through the hook (kit-import.mjs importLayer)
const { generateLayout } = await importLayer(kitPath(KIT, 'world/generate.js'));

const SIZES = { small: 12, medium: 18, large: 26 };
const SEAT_COLORS = ['#4f7cff', '#ff5ea8', '#3ddc84', '#ffd166', '#b388ff', '#ff8a50', '#4dd0e1', '#e57373'];   // the party page's seat colours
// a gameplay prop (mechanics and rules spawn it) or a layout piece: the spec's world.props[].kind says (a consumable
// is "gameplay": "drink to refill your bladder" as scenery reads as litter and the pickup mechanic draws its stand-in
// gem instead)
/** A gameplay prop's size (m) and a layout piece's room around it (m) when the spec gives none. */
export const PROP_DEFAULTS = { size: 0.6, radius: 1.4 };

// sound words → gf-audio presets (builder/gf-audio/source/presets.json)
const SOUND_WORDS = [
  [/whoosh|throw|swing|swish|toss/i, 'arrow-whoosh'], [/bonk|boing|bounce|rubber|squish/i, 'bounce'], [/slap|catch|smack|clap/i, 'hit-soft'],
  [/punch|crunch|thud|smash/i, 'hit-crunch'], [/bell|ring|chime|whistle|gong|buzzer|horn/i, 'alarm'], [/coin|collect|pickup|pick up/i, 'coin'],
  [/gem|sparkle/i, 'gem'], [/jump/i, 'jump'], [/land/i, 'land'], [/splash|water|spray|hose|stream|squirt|liquid/i, 'splash'],
  [/explo|boom|blast/i, 'explosion-small'], [/laser|zap/i, 'laser-soft'], [/shoot|pew|shot|fire/i, 'pew-retro'], [/cheer|victory|win|yay/i, 'win'],
  [/lose|fail|game over/i, 'lose'], [/hurt|ouch|ow\b/i, 'hurt'], [/power/i, 'powerup'], [/heal/i, 'heal'], [/door|latch/i, 'door'],
  [/engine|motor/i, 'engine-loop'], [/wind|breeze/i, 'wind-loop'], [/step|footstep/i, 'footstep'], [/alarm|siren/i, 'alarm'], [/click|tap|button/i, 'click'],
  [/count|beep|tick/i, 'countdown'], [/hit|bump/i, 'hit-soft'],
];
export function presetFor(s) { const t = `${s.id} ${s.describe ?? ''}`; for (const [re, p] of SOUND_WORDS) if (re.test(t)) return p; return 'hit-soft'; }

async function readJsonMaybe(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }

/**
 * The library's prop for a spec prop name. It must match the name itself (the id, a part of the id, or a tag); among
 * those, the one sharing most words with the description wins ("a soft red rubber dodgeball" → ball-red). Ties keep
 * the library's order. `asset` (a fill's `<pack>/<asset>`) names it exactly. null: no match (a stand-in is used).
 */
export async function libraryProp(name, describe, { asset = null } = {}) {
  const props = assetsIn('three', { category: 'prop' }).filter(a => localFile(a)).map(a => ({ ...propEntry(a), path: localFile(a) }));
  // a fill's asset (<pack>/<asset>) names it exactly, in any pack of the library
  const exact = asset ? findAsset(asset) : null;
  if (exact?.category === 'prop' && localFile(exact)) return { ...propEntry(exact), path: localFile(exact) };
  const words = String(describe ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3);
  const ok = p => p && /\.glb$/i.test(p.file);
  let best = null, bestScore = 0;
  for (const p of props) {
    if (!ok(p)) continue;
    const parts = String(p.id).toLowerCase().split(/[^a-z0-9]+/), tags = (p.tags ?? []).map(t => String(t).toLowerCase());
    const named = p.id === name ? 1000 : parts.includes(name) ? 100 : tags.includes(name) ? 50 : 0;
    if (!named) continue;
    const hay = new Set([...parts, ...tags, ...String(p.describe ?? '').toLowerCase().split(/[^a-z0-9]+/)]);
    const score = named + words.filter(w => hay.has(w)).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return best;
}
/** A library asset's licence as the game carries it, by its ref or id (a licence that asks for credit, CC BY, carries
 *  the title, the credit line, the licence's page and what was changed: "credit the author, the title and a link, and
 *  say you changed it"). null when the library has no such asset. */
async function libraryLicense(ref) {
  const a = findAsset(ref, 'three');
  return a ? licenceOf(a) : null;
}
/** The licence page of a Creative Commons licence that asks for credit (CC-BY-3.0 → …/by/3.0/), else null. */
export function licenceUrl(spdx) {
  const m = /^CC-BY(-SA|-NC|-ND|-NC-SA|-NC-ND)?-(\d\.\d)$/.exec(String(spdx ?? ''));
  return m ? `https://creativecommons.org/licenses/by${(m[1] ?? '').toLowerCase()}/${m[2]}/` : null;
}
/**
 * The library's gf-humanoid-1 body for a spec character: its fill (characters[].body). from library: the asset named
 * (`<pack>/<asset>`). from generate or reference: its `standIn` (when the pitch names one) until the made body lands in
 * the slot, and kept if making it fails: a far better fallback than the bean (verify check 14 still counts it as a
 * stand-in until the worker records why it stayed). from kind (and anything else): the kind's body set, the bean today
 * (the asset library's resolver takes this over). From library/bodies.json, else the scenic-3d library's.
 */
async function libraryBody(body, { avoid = new Set() } = {}) {
  const local = b => (localFile(findAsset(b.ref)) ? { ...b, path: localFile(findAsset(b.ref)) } : null);
  const bodies = bodiesIn('three').map(local).filter(Boolean);
  const wanted = body?.from === 'library' ? body.asset : isMade(body) ? body.standIn : null;
  if (wanted) {
    // any library body on gf-humanoid-1 by <pack>/<asset> (a scenic KayKit adventurer, a kind's block body): every
    // body plays the same clip file, so any game may wear it; one its validator failed is never worn
    const a = findAsset(wanted);
    if (a?.category === 'body' && (a.validated ?? []).every(v => v.ok !== false)) { const e = local(bodyEntry(a)); if (e) return e; }
  }
  // the bean (the kind's body set today, or a stand-in for a body to be made): the first one no other role described
  // differently wears already (`avoid`), so two roles never share a body by construction (GATES.md: gate F confirms it)
  const beans = bodies.filter(x => x.from === 'bean' || (x.tags ?? []).includes('bean'));
  const bean = beans.find(x => !avoid.has(x.id)) ?? beans[0];
  return bean ?? bodies[0] ?? null;
}

/**
 * spec → { game, look, world, characters, sounds, multiplayer, assets: [{to, from, license, note}], record, notes }
 * modules: the real modules create found ({look, world, character, mechanics}); lookPreset(id, time): values or null.
 */
/**
 * A forge game's multiplayer.json check.query (create writes it, upgrade adds it to a game that lacks it). The live
 * gate plays a round with scripted random input for 40 s and then checks that a host in a background tab does not
 * stop the world, play again and a reload. A forge round does not last that long under random input: in a wave fight
 * both players fall, in a walk-to game the random walk reaches the goal (gf-forge/INTEGRATION.md mismatch 28:
 * the background-host step was "not reached" on both forge games). With ?gf-gate=1 the forge boot
 * (kit/core/boot-forge.js) lets the rules end no round: the clock and the host's End round still do. QA only.
 */
export const FORGE_GATE_QUERY = 'gf-gate=1';
// Where a stream leaves the body is the spec's: the projectile's `muzzle` param ("hips" for a pee stream; the creator,
// 2026-10-07: "have the pee stream start a bit lower towards the lower part of their body"). Until 2026-10-12 create
// and upgrade guessed it from the words of the creator's prompt (isPeeGame); the spec step sets it now (GATES.md).

/**
 * Hits read (creator, "Hang Up On Them", 2026-10-07: "The zombies are instant killed to I couldn't even tell what was
 * happened"): an enemy the game's weapon kills in one hit shows nothing between the shot and the kill. So a basic
 * enemy takes 2–4 hits from the default weapon (the projectile's damage, or a stream's per-tick damage): when the
 * spec's damage would kill a wave-1 enemy in one hit, its hit points go up to three hits' worth. Not when the spec
 * asks for one-hit kills (waves `oneHitKills`). Changes `mechanics` in place. → a note, or null
 */
export function enemyToughness(mechanics) {
  const w = mechanics.find(m => m.id === 'waves'), p = mechanics.find(m => m.id === 'projectile');
  if (!w || !p || w.params?.oneHitKills === true || w.params?.hittable === false) return null;
  // the hits per kill the spec asks for (waves hitsPerKill, a spec default of 2: verify gate F, measure 39)
  const want = Number.isInteger(w.params?.hitsPerKill) && w.params.hitsPerKill >= 1 ? w.params.hitsPerKill : 2;
  if (want <= 1) return null;
  const stream = (p.params?.kind ?? 'discrete') === 'continuous';
  const dmg = Number(stream ? p.params?.streamDamage : p.params?.damage);
  const hp = Number(w.params?.hp);
  if (!(dmg > 0) || !(hp > 0) || Math.ceil(hp / dmg - 1e-9) >= want) return null;
  const hits = Math.max(3, want);
  const to = Math.max(2, Math.ceil(dmg * hits));
  w.params.hp = to;
  return `waves: hp ${hp} → ${to}, so an enemy takes ${hits} hits from the ${stream ? 'stream' : 'shot'} (damage ${dmg}) and each one shows (a health bar, a flash); the spec's waves hitsPerKill (${want}) says how few is too few, and oneHitKills only when the creator asks for one-hit kills`;
}

export async function specToConfig(spec, { place = { runtime: spec.runtime, profile: spec.profile ?? null }, modules, lookPreset = null, lookConfig = null, standinPresetValues, mechanicDefaults = {}, mechanicSounds = {}, mechanicItems = {}, worldConfig = null, flow = null, flat = null }) {
  const notes = [];
  const rng = createRng(hashString(`${spec.title}|layout`));
  const P = spec.players ?? { min: 1, max: 4 };
  const half = SIZES[spec.world?.size ?? 'small'] ?? 12;
  const assets = [];

  // ---- props: layout pieces and gameplay props ----
  const gameProps = [], layoutProps = [], propFiles = {}, named = {};   // named: the spec's prop name → its slot id
  // (a flat game has no layout pieces: its world is a tile map, so every prop the spec names is the game's own)
  for (const p of spec.world?.props ?? []) (flat || p.kind === 'gameplay' ? gameProps : layoutProps).push(p);
  // with the real world module the layout pieces come from its catalog (realWorld below); here: the gameplay props,
  // and with the stand-in world every prop
  // (a forge world places every spec prop itself, from its own library: CONTRACT §8 forge)
  // (a vista world is the core's island: create refuses props on it, so there are none here)
  const forge = place.runtime === 'forge', vista = place.runtime === 'vista';
  for (const p of forge || vista ? [] : spec.world?.props ?? []) {
    if (modules.world && layoutProps.includes(p)) continue;
    // a flat (2D) game's prop is a picture (kit/flat): an image slot, a stand-in in the game's art style until one is made
    if (flat) { named[p.name] = `prop.${p.name}`; propFiles[p.name] = flat.part.propFor(p, { style: flat.style, assets, repoFile: flat.repoFile }); continue; }
    const made = isMade(p.fill);   // the worker makes it (tools/meshy-prop.mjs) and places it here
    const lib = !made ? await libraryProp(p.name, p.describe, { asset: p.fill?.asset }) : null;
    const to = `assets/models/${p.name}.glb`;
    named[p.name] = `prop.${p.name}`;
    if (lib) {
      const license = await libraryLicense(lib.ref);
      assets.push({ to, from: lib.path, license });
      propFiles[p.name] = { file: to, from: `library:${lib.ref}`, ...(license ? { license } : {}) };
    } else {
      const stand = existsSync(join(STANDIN_ASSETS, `${p.name}.glb`)) ? p.name : 'crate';
      const license = { spdx: 'CC0-1.0', author: 'games.fun (stand-in, gf-three/tools/lib/standin-bake.mjs)', url: 'https://games.fun' };
      assets.push({ to, from: join(STANDIN_ASSETS, `${stand}.glb`), license });
      propFiles[p.name] = { file: to, from: `standin:${stand}`, license };
      notes.push(`prop "${p.name}": no library match yet, stand-in ${stand}.glb${made ? ' (the spec asks for a made model: gamesfun art generate puts it in this slot; verify check 14 fails while the stand-in stays unrecorded)' : ''}`);
    }
  }
  // the layout: each layout piece `count` times, apart from each other, the spawns and the centre
  const spawns = [];
  const nSpawn = Math.max(2, P.max ?? 4);
  for (let i = 0; i < nSpawn; i++) { const a = Math.PI / 4 + (i / nSpawn) * Math.PI * 2; spawns.push([r2(Math.cos(a) * half * 0.55), 0, r2(Math.sin(a) * half * 0.55)]); }
  const placed = [];
  const free = (x, z, r) => Math.hypot(x, z) > 4 && spawns.every(s => Math.hypot(s[0] - x, s[2] - z) > 3) && placed.every(q => Math.hypot(q.at[0] - x, q.at[2] - z) > r + q.r);
  for (const p of layoutProps) {
    const r = Number.isFinite(p.radius) && p.radius > 0 ? p.radius : PROP_DEFAULTS.radius;   // the spec's room around it
    for (let k = 0; k < (p.count ?? 1); k++) {
      let x = 0, z = 0, tries = 0;
      do { const a = rng() * Math.PI * 2, d = half * (0.3 + rng() * 0.5); x = Math.cos(a) * d; z = Math.sin(a) * d; tries++; } while (!free(x, z, r) && tries < 200);
      placed.push({ prop: p.name, at: [r2(x), 0, r2(z)], rot: r2(Math.atan2(-x, -z) + (rng() - 0.5) * 0.8), scale: 1, r });
    }
  }
  const worldProps = placed.map(({ r, ...q }) => q);

  // ---- characters ----
  const roles = {}, bodies = {};
  // the forge runtime (CONTRACT §8 forge "Live co-op"): no three.js character; the body friends see, its clips and the
  // model of each weapon a friend holds come from the asset library through the forge's cast (gf/forge/wear.js), each a slot
  let forgeWear = null;
  if (forge) {
    const W = await importPart(join(FORGE_KIT, 'wear.js'), 'the forge runtime');
    const L = await (await importPart(join(FORGE, 'tools/library.mjs'), 'the forge runtime')).forgeLibrary();
    const lic = (rel, scenic = false) => { const l = scenic ? L.licences[rel] : L.forgeLicences[rel]; return l ? { spdx: l.spdx, author: l.author, url: l.page ?? l.from ?? '' } : null; };
    const filled = (await importPart(join(FORGE_KIT, 'tables/index.js'), 'the forge runtime')).fill(spec.tables ?? {});
    // the forge's catalog (runtimes/forge/tools/library.mjs, after tracks C2 and C3): the four co-op hunters
    // by seat, the Meshy weapons, the first-person arms, a kill's pieces and the effect pictures (gf/forge/wear.js)
    forgeWear = W.wearConfig(filled, L.forgeCatalog);
    const held = [];
    for (const f of W.wearFiles(filled, L.forgeCatalog)) {
      assets.push({ to: f.to, from: f.scenic ? L.scenicFile(f.from) : L.forgeFile(f.from), license: lic(f.from, f.scenic) });
      if (/held-/.test(f.to)) held.push(`${f.what.replace(/^the /, '')} (${f.from})`);
    }
    notes.push(`characters: friends see each other as the co-op hunters, one body a seat (slots ${W.BODY}, ${W.bodySlot(1)}, …), skinned by the forge renderer, their cloth in the player's colour${held.length ? `, holding ${held.join(', ')}` : ''}${forgeWear.fp ? '; the first-person arms and weapons, a kill\'s pieces, a coin and the effect pictures are slots too' : ''}`);
  }
  // the vista runtime (CONTRACT §8 vista): no three.js character. Friends see each other as gf-humanoid-1 bodies skinned
  // by the core (gf/vista/kit/humanoid.js), one a seat: kit/bodies.json's default list (realistic bodies), else the
  // Quaternius bodies; each a slot, with the shared clips
  let vistaWear = null;
  if (vista) { const vb = await vistaBodies({ assets, notes }); vistaWear = vb.config; vb.files.forEach((f, i) => { bodies[`seat${i + 1}`] = f; }); }
  // a flat (2D) game's body is a picture sheet (kit/flat/character.js, the gf-flat-1 standard)
  if (flat) for (const c of spec.characters) { const b = flat.part.bodyFor(c, { plane: flat.plane, style: flat.style, assets, repoFile: flat.repoFile }); roles[c.role] = b.role; bodies[c.role] = b.record; notes.push(b.note); }
  // a body per described role, by construction: a role the spec describes differently from one already given a library
  // body never gets that same file (a bean stand-in is the next bean); two roles the spec gives the same body and the
  // same words may share it. Measure 14 (gate F) confirms it on the built game.
  const worn = [];                                   // [{id, key}] the library bodies given so far, and to what
  const roleKey = c => JSON.stringify([String(c.describe ?? '').toLowerCase(), c.body ?? null]);
  for (const c of forge || flat || vista ? [] : spec.characters) {
    const to = `assets/models/body-${c.role}.glb`;
    const lib = modules.character ? await libraryBody(c.body, { avoid: new Set(worn.filter(w => w.key !== roleKey(c)).map(w => w.id)) }) : null;
    if (lib) worn.push({ id: lib.id, key: roleKey(c) });
    if (lib) {
      // the body's licence, from its pack in the library (a CC BY one with its title and credit line)
      const rec = licenceOf(findAsset(lib.ref));
      const license = { ...rec, ...(licenceUrl(rec.spdx) ? { title: rec.title ?? lib.label ?? lib.id, credit: rec.credit ?? `"${rec.title ?? lib.label ?? lib.id}" by ${rec.author}, ${rec.spdx.replace(/^CC-BY-/, 'CC BY ')}${rec.url ? ` (${rec.url})` : ''}` } : {}) };
      assets.push({ to, from: lib.path, license }); bodies[c.role] = { file: to, from: `library:${lib.ref}`, ...(license ? { license } : {}) };
      if (isMade(c.body)) notes.push(`character "${c.role}": ${lib.id} stands in until the made body is placed in its slot (gamesfun art generate; verify check 14 fails while it stays unrecorded)`);
    }
    else {
      const license = { spdx: 'CC0-1.0', author: 'Quaternius', url: 'https://quaternius.itch.io/universal-animation-library' };
      assets.push({ to, from: join(STANDIN_ASSETS, 'mannequin.glb'), license });
      bodies[c.role] = { file: to, from: 'standin:mannequin', license };
      notes.push(`character "${c.role}": body from ${c.body?.from ?? '?'} is not available yet, stand-in UAL mannequin${isMade(c.body) ? '; the made body goes into this slot' : ''}`);
    }
    // a hat (character.hat.<role>, worn on the head socket): a stand-in cap until a library hat or a generated one exists
    let hat = null;
    if (c.hat) {
      hat = `assets/models/hat-${c.role}.glb`;
      const variant = /backward|reverse/i.test(c.hat) ? 'cap-backwards' : 'cap';
      assets.push({ to: hat, from: join(STANDIN_ASSETS, `${variant}.glb`), license: { spdx: 'CC0-1.0', author: 'games.fun (stand-in, gf-three/tools/lib/standin-bake.mjs)', url: 'https://games.fun' } });
      bodies[`${c.role}.hat`] = { file: hat, from: `standin:${variant}`, describe: c.hat, license: { spdx: 'CC0-1.0', author: 'games.fun (stand-in)', url: 'https://games.fun' } };
      notes.push(`character "${c.role}": hat "${c.hat}" is a stand-in ${variant}.glb (Studio generates or uploads into character.hat.${c.role})`);
    }
    roles[c.role] = { body: to, height: 1.7, ...(hat ? { hat, hatDescribe: c.hat } : {}), ...(c.describe ? { describe: c.describe } : {}), ...(bodies[c.role].license ? { license: bodies[c.role].license } : {}) };
  }
  const clips = humanoidClips();
  if (modules.character && !forge && !vista && clips) assets.push({ to: 'assets/clips/gf-humanoid-1.glb', from: clips.from, license: clips.license });

  // ---- the ground (stand-in world only: the real world draws its own from colour slots and a noise texture) ----
  if (!modules.world && !forge && !flat && !vista) assets.push({ to: 'assets/textures/ground.ktx2', from: join(STANDIN_ASSETS, 'grass.ktx2'), license: { spdx: 'CC0-1.0', author: 'Poly Haven', url: 'https://polyhaven.com/a/leafy_grass' } });

  // ---- config files ----
  const mechanics = (spec.mechanics ?? []).map(m => ({ id: m.id, ...(m.as ? { as: m.as } : {}), params: { ...(mechanicDefaults[m.id] ?? {}), ...(m.params ?? {}) } }));
  const tough = enemyToughness(mechanics);
  if (tough) notes.push(tough);
  // a mechanic's own table of things (its manifest.items, kit/assets/items.js; open builder wave 10): the profile's
  // default table when the spec gives none, written into the game so a page can add to it and every number is a slot.
  // A default's picture may be "library:<id>": create's ensurePictures (tools/lib/items-lib.mjs) copies it in.
  const itemProfile = isScenic(place) ? 'scenic-3d' : 'standard-3d';
  for (const m of mechanics) for (const it of mechanicItems[m.id] ?? []) {
    if (it.single || !it.key || !it.defaults || (Array.isArray(m.params[it.key]) && m.params[it.key].length)) continue;
    const rows = it.defaults[itemProfile] ?? it.defaults['standard-3d'];
    if (!Array.isArray(rows) || !rows.length) continue;
    m.params[it.key] = JSON.parse(JSON.stringify(rows));
    notes.push(`${m.id}: the ${itemProfile} profile's own ${it.nouns ?? it.key} (${rows.map(r => r.name ?? r.id ?? r).join(', ')}), written into config/game.json → ${it.key}`);
  }
  if (isScenic(place)) await scenicMechanicArt(mechanics, assets, notes);
  const game = {
    schemaVersion: 0,
    title: spec.title,
    hook: spec.hook ?? '',
    text: { title: spec.title, hook: spec.hook ?? '', goal: goalLine(spec), play: 'Play', again: 'Play again', waiting: 'Waiting for everyone…', you: 'You', wins: '{name} wins!', draw: 'Round over: nobody scored', lost: 'Defeated' },
    players: { min: P.min ?? 1, max: P.max ?? 4, bots: P.bots !== false, teams: spec.multiplayer?.teams ?? 0, mode: playersModeOf(spec), together: spec.multiplayer?.together ?? 'versus', botNames: ['Pip', 'Bo', 'Moss', 'Juno', 'Rex', 'Ivy', 'Tam'] },
    // a flow other than the timed round (kit/loops/<id>, open builder M4-C) is named with its params; one with no
    // round clock (turns, endless) gets round.seconds only when the spec gives it (a cap)
    round: { ...(flow && !Number.isInteger(spec.round?.seconds) ? {} : { seconds: spec.round?.seconds ?? 120 }), countdown: 3, replay: spec.round?.replay !== false, ...(spec.round?.winBy ? { winBy: spec.round.winBy } : {}), ...(spec.round?.loseBy ? { loseBy: spec.round.loseBy } : {}), ...(flow ? { flow: flow.id, params: flow.params } : {}) },
    camera: spec.camera ?? 'third',
    // forge (CONTRACT §8 forge): the walk, the jump and the field of view are the data tables' (game.forge.player), so
    // the controller keeps only the mouse's sensitivity
    controller: forge || vista ? { camera: { first: { sensitivity: cameraDefaults('first').sensitivity } } } : { speed: 5.2, sprint: 7.4, jump: 7.2, camera: { [spec.camera ?? 'third']: cameraDefaults(spec.camera ?? 'third') } },
    controls: { ...(spec.controls ?? {}) },
    // forge (CONTRACT §8 forge): every spec prop is the game's own, placed by the world module; no size or count values,
    // which the forge world does not read
    props: vista ? [] : forge ? (spec.world?.props ?? []).map(p => ({ name: p.name, ...(p.describe ? { describe: p.describe } : {}), ...(p.role ? { role: p.role } : {}) }))
      : gameProps.map(p => ({ name: p.name, describe: p.describe, count: p.count ?? 1, ...(p.role ? { role: p.role } : {}), ...(typeof p.goal === 'boolean' ? { goal: p.goal } : {}), size: Number.isFinite(p.size) && p.size > 0 ? p.size : PROP_DEFAULTS.size })),
    mechanics,
    rules: { summary: spec.rules?.summary ?? '', ...(spec.rules?.scoring ? { scoring: spec.rules.scoring } : {}), params: { ...(spec.rules?.params ?? {}) } },
    // fair play (kit/core/fair.js): on by default in every game; each value a fair.* slot the creator tunes in Studio
    fair: { ...FAIR_DEFAULTS },
    ui: { panel: '#1c2133d9', text: '#ffffff', crosshair: '#ffffff' },
  };
  // fair play is about knocks and bots, which the forge runtime has neither of yet: no fair.* values
  // (slots that would change nothing) until it does
  if (forge || vista) delete game.fair;
  // vista: co-op and calm, no bots (each player fishes, sails and walks on their own; friends see each other)
  if (vista) Object.assign(game.players, { bots: false, mode: 'coop', together: 'coop' });
  // vista's keys are the core's own (core/src/core/Input.js read by its player and its fishing): the shared kit's other
  // names for an action (F for the primary, Q for the secondary) do nothing there, so the spec's controls are written as
  // the game's own rows (controls.more), which How to play and the HUD's line show as they are
  if (vista) game.controls = vistaControls(spec.controls ?? {});
  // a flat (2D) game: its plane, its jump and its controls are the flat part's to set (kit/flat/slots.js gameFor)
  if (flat) Object.assign(game, flat.part.gameFor(spec, game));
  // the forge data tables (spec.tables: player, physics, weapons, enemies, waves, cards, …), every value filled and a
  // slot (runtimes/forge/kit/tables; create has already refused what the core can't do)
  const forgeTables = forge ? await importPart(join(FORGE_KIT, 'tables/index.js'), 'the forge runtime') : null;
  if (forge) game.forge = forgeTables.fill(spec.tables ?? {});
  // the vista data tables (spec.tables: species, gear, vendors, economy, start; runtimes/vista/kit/tables), every value
  // filled and a slot (create has already refused what the core can't do)
  const vistaTables = vista ? await importPart(join(VISTA_KIT, 'tables/index.js'), 'the vista runtime') : null;
  if (vista) game.vista = vistaTables.fill(spec.tables ?? {});
  // the real look writes its own config/look.json (the whole preset, every value a slot); the stand-in keeps `values`
  const realLook = lookConfig?.(spec.look?.preset ?? 'jelly-pastel', spec.look?.time ?? 'day');
  const look = realLook ?? { preset: spec.look?.preset ?? 'jelly-pastel', time: spec.look?.time ?? 'day', ...(spec.look?.palette ? { palette: spec.look.palette } : {}), values: lookPreset?.(spec.look?.preset, spec.look?.time) ?? standinPresetValues(spec.look?.preset, spec.look?.time ?? 'day') };
  const lookPlayers = look.palette?.players;
  // the scenic-3d profile's world module writes its own config/world.json (CONTRACT §8): a generated island, ruins or isles;
  // a voxel world (CONTRACT §9) is the kit's default block island, seeded by the title
  let world = spec.world?.template === 'voxel' ? await voxelWorld(spec, { assets, notes })
    : worldConfig ? await worldConfig(spec, { spawns, layoutProps, rng, assets, propFiles, notes, named })
    : modules.world ? await realWorld(spec, { spawns, layoutProps, rng, assets, propFiles, notes, named }) : null;
  if (spec.loop === 'world') worldGame(spec, game, world, notes);
  if (!world) world = {
    template: spec.world?.template ?? 'backyard', size: spec.world?.size ?? 'small', half,
    ground: { texture: 'assets/textures/ground.ktx2', color: '#d4f0b0', repeat: Math.round(half / 1.5), license: { spdx: 'CC0-1.0', author: 'Poly Haven', url: 'https://polyhaven.com/a/leafy_grass' } },
    props: worldProps, spawns, zones: { centre: { shape: 'circle', at: [0, 0, 0], size: [2.5] } }, walls: true,
    ...(spec.world?.notes ? { notes: spec.world.notes } : {}),
  };
  // seat colours (character.tint.<role>): the look's player palette when it has one, else the party page's colours
  const characters = { roles, palette: (Array.isArray(lookPlayers) ? lookPlayers : SEAT_COLORS).slice(0, Math.max(4, P.max ?? 4)), nameplate: { show: true }, ...(forgeWear ? { forge: forgeWear } : {}), ...(vistaWear ? { vista: vistaWear } : {}) };

  // ---- sounds: the spec's, then the kit's round sounds ----
  const sounds = { version: 1, sounds: {} };
  for (const s of spec.sounds ?? []) sounds.sounds[s.id] = { label: cap(s.describe ?? s.id), src: { preset: s.preset ?? presetFor(s) } };
  const kitSounds = { 'ui-click': ['Menu click', 'click', 'ui'], 'round-countdown': ['Countdown beep', 'countdown', 'ui'], 'round-go': ['Round starts', 'confirm', 'ui'], 'round-win': ['You won the round', 'win', 'sfx'] };
  // an enemy going down (kit/mechanics/waves soundKill), in games that have enemies
  if (mechanics.some(m => m.id === 'waves')) kitSounds['enemy-down'] = ['An enemy goes down', 'explosion-small', 'sfx'];
  // the forge core's own events (gf/three/core/boot-forge.js plays them for the local player): steps, jumps, landings
  // the forge core's own sounds: every sound id its tables name (steps, jumps, landings, and the weapons' and enemies'),
  // which the host plays by name when the core says so
  if (forge) {
    for (const s of forgeTables.soundsOf(game.forge)) kitSounds[s.id] ??= [s.label, s.preset, 'sfx'];
    kitSounds['round-end'] ??= ['The round ends', 'lose', 'sfx'];
  }
  // the vista core's own sounds (its field recordings: steps, surf, reel, splash), listed by name when the vista kit says
  // which it plays through gf-audio (track G: the tables' `soundsOf`/`SOUNDS`, else kit/audio.js); until then the core's
  // own soundscape plays them, which the record notes
  if (vista) {
    kitSounds['round-end'] ??= ['The session ends', 'confirm', 'sfx'];
    const own = await vistaSounds(game.vista, vistaTables);
    // a full entry (the core's own sounds keep engine 'vista-core', read-only and their reason: the soundscape plays
    // them, gf-audio's kit plays the rest); a bare [label, preset, bus] row otherwise
    for (const s of own.list) {
      if (s.engine || s.src?.file) { if (!sounds.sounds[s.id]) { const { id, ...rest } = s; sounds.sounds[id] = rest; } }
      else kitSounds[s.id] ??= [s.label ?? s.id, s.src ?? s.preset ?? 'click', s.bus ?? 'sfx'];
    }
    notes.push(own.note);
  }
  // the flow's own sounds (kit/loops/<id> → sounds: a turn passing), in games that flow plays
  for (const [id, v] of Object.entries(flow?.sounds ?? {})) kitSounds[id] ??= v;
  // the action mechanics' own sounds (melee, levels, boss, loot: each plays these ids, optional; CONTRACT §8)
  // (a mechanic folder that exports `sounds` brings its own: create hands them in as mechanicSounds)
  for (const m of mechanics) for (const [id, v] of Object.entries({ ...(MECHANIC_SOUNDS[m.id] ?? {}), ...(mechanicSounds[m.id] ?? {}) })) kitSounds[id] ??= v;
  // a kit sound is a preset id, or a full source (layers: one sound made of several presets played together)
  for (const [id, [label, preset, bus]] of Object.entries(kitSounds)) if (!sounds.sounds[id]) sounds.sounds[id] = { label, src: typeof preset === 'string' ? { preset } : preset, ...(bus !== 'sfx' ? { bus } : {}) };

  const multiplayer = spec.loop === 'world' ? {
    // a world (gf-multiplayer 1.5.0 world rooms, worlds/PLAN.md §4.4): the room for this post, no rounds
    schemaVersion: 2, mode: 'world', title: spec.title.slice(0, 60), players: { min: 1, max: Math.min(8, P.max ?? 8) },
    world: {
      entry: 'index.html', query: '', key: 'auto', tagline: (spec.hook ?? '').slice(0, 140), hud: 'game',
      sees: 'Each player sees the others as their character, in their seat colour, with a ring at their feet and their name above, building where they point.',
      shares: 'The world itself: every block placed, broken or painted and every sign, ordered by the host\'s copy and saved on the play host.',
    },
    check: { near: 2.5, seconds: 60 },
  } : {
    schemaVersion: 2, mode: 'live', title: spec.title.slice(0, 60), players: { min: 1, max: Math.min(8, P.max ?? 4) },
    live: {
      entry: 'index.html', seedParam: null, team: spec.multiplayer?.together === 'coop' || forge, metric: 'score', direction: 'higher', unit: 'pts', maxSeconds: flow ? flowMaxSeconds(spec, flow) : Math.min(3600, (spec.round?.seconds ?? 120) + 30),
      // forge (CONTRACT §8 forge "Live co-op"): co-op for 2–4, the host's core owns the world (research/rust-engine/PLAN.md §9)
      sees: vista ? 'Each player sees the others as a person (a gf-humanoid-1 body, one a seat, in their colour) standing, walking, running, swimming or at the helm where they really are, with their name above in their colour.'
        : forge ? 'Each player sees the others as a hooded body in their own colour, holding the weapon they hold, with their name above, where the host\'s core has them.'
        : 'Each player sees the others as their character, in their seat colour, with a ring at their feet and their name above.',
      shares: vista ? 'The session and its clock, the scores, the time of day and the sea state, owned by the host\'s copy (each player\'s own catch, cooler and money are their own)'
        : forge ? 'Everything the host\'s core simulates (every player\'s body from their inputs, enemies, shots, hits), sent in its snapshots, and the round, its clock and the scores'
        : 'The round and its clock, the scores and everything the rules share (ctx.shared), owned by the host\'s copy',
      // gf-multiplayer 1.4.0: the game's world behind the waiting room, and the game's own HUD and room menu in a round
      backdrop: 'gf-backdrop=1', hud: 'game',
    },
    check: { near: 2.5, seconds: 60 },
  };
  if (forge || vista) multiplayer.players.max = Math.min(4, multiplayer.players.max);
  // how friends play is the spec's (multiplayer.mode): live above; a room game's rules are its room.js and bot.js (the
  // build writes them: gf-multiplayer's room mode); solo says why (spec.multiplayer.why)
  const mpMode = spec.multiplayer?.mode ?? 'live';
  const mpOut = spec.loop === 'world' || mpMode === 'live' ? multiplayer
    : mpMode === 'room' ? { schemaVersion: 2, mode: 'room', title: multiplayer.title, players: multiplayer.players, room: { entry: 'index.html', module: 'room.js', bot: 'bot.js', start: 'lobby' }, check: multiplayer.check }
    : { schemaVersion: 2, mode: 'solo', title: multiplayer.title, reason: String(spec.multiplayer?.why ?? '').padEnd(20, '.') };
  if (mpMode === 'room') notes.push('multiplayer: a room game (spec.multiplayer.mode room): its rules are room.js and bot.js, which the build writes (gf-multiplayer room mode); multiplayer.json names them');
  // vista: co-op; no backdrop behind the friends page's waiting room (it would boot the core and compile its shaders a
  // second time for the lobby alone); the gate's random input never presses the core's own keys
  if (vista) { multiplayer.live.team = true; delete multiplayer.live.backdrop; multiplayer.check.avoidKeys = ['KeyF', 'KeyT', 'KeyM', 'KeyL', 'KeyP']; }
  // forge: the live gate plays the game with FORGE_GATE_QUERY (multiplayer.json check.query: a query for scripted
  // players, never used in real play), so the steps after its 40 s of random input find the round still running
  if (forge) multiplayer.check.query = FORGE_GATE_QUERY;
  if (!look.palette?.accent) game.ui.accent = spec.look?.palette?.[0] ?? '#ff7a59';   // the look's accent wins when it has one
  // forge, wave 2 (track U; runtimes/forge/hud/create.mjs): the grim theme's colours, words and fonts, the forge keys
  // for How to play and touch, the library's sound files in place of the presets above, the friends page's colours
  if (forge) (await importPart(join(FORGE, 'hud/create.mjs'), 'the forge runtime')).forgeHud({ spec, game, sounds, multiplayer, assets, world, notes });
  const props = world.__catalog ?? null; delete world.__catalog;
  const worldArt = world.__art ?? null; delete world.__art;
  return { game, look, world, characters, props, sounds, multiplayer: mpOut, assets, propFiles, named, bodies, notes, worldArt };
}

/**
 * The real world module (track L): its template's recipe (kit/world/templates/<id>.json) expanded at the spec's size
 * class by kit/world/generate.js (seeded by the title, so each game gets its own rooms and the same ones every time),
 * plus the spec's own layout props it lacks, and config/props.json, the catalog entries the game uses (L's
 * CONTRACT-REQUEST). Every prop the layout places gets its library model copied to assets/models/<id>.glb. null when
 * the template is missing.
 */
async function realWorld(spec, { spawns, layoutProps, rng, assets, propFiles, notes, named }) {
  const T = spec.world?.template ?? 'backyard';
  const tpl = await readJsonMaybe(kitPath(KIT, `world/templates/${T}.json`));
  if (!tpl) { notes.push(`world: the real module has no ${T} template; stand-in world`); return null; }
  // the props the template and the spec name, by their ids in the three runtime's packs (runtimes/three/art.json)
  const byId = new Map(assetsIn('three', { category: 'prop' }).filter(a => localFile(a)).map(a => [a.id, { ...propEntry(a), path: localFile(a) }]));
  const size = spec.world?.size ?? 'small';
  const world = generateLayout(tpl, { size, seed: hashString(`${spec.title}|world`) });
  notes.push(`world: ${T} at size ${size}, ${world.size.join(' x ')} m${world.rooms?.length ? `, ${world.rooms.length} rooms (${world.rooms.map(r => r.id).join(', ')})` : ''}${world.entries?.length ? `, entries ${world.entries.map(e => e.name).join(', ')}` : ''}`);
  const [W, D] = world.size ?? [24, 24];
  const sp = (world.spawns ?? spawns).map(s => ({ x: s[0], z: s[2] }));
  // the game's own gameplay props are never scenery: a template ball would look pickable and is not
  const gameNames = (spec.world?.props ?? []).filter(p => !layoutProps.includes(p)).map(p => p.name);
  const isGameplay = id => { const e = byId.get(id); const parts = String(id).split(/[^a-z0-9]+/); return gameNames.some(n => parts.includes(n) || (e?.tags ?? []).includes(n)); };
  const dropped = (world.props ?? []).filter(p => isGameplay(p.prop)).map(p => p.prop);
  if (dropped.length) { world.props = world.props.filter(p => !isGameplay(p.prop)); notes.push(`world: left out the template's ${[...new Set(dropped)].join(', ')} (the game's own ${gameNames.join(', ')} are gameplay props)`); }
  world.scatter = (world.scatter ?? []).filter(s => !isGameplay(s.prop));
  const used = new Map();
  const taken = (world.props ?? []).map(p => ({ x: p.at?.[0] ?? 0, z: p.at?.[2] ?? 0 }));
  // the spec's layout props: the template keeps its own; any count it lacks is placed in the open
  for (const p of layoutProps) {
    const entry = await libraryProp(p.name, p.describe);
    if (!entry) { notes.push(`world: no library prop for "${p.name}"; not placed (the template has its own scenery)`); continue; }
    named[p.name] = `prop.${entry.id}`;
    const have = (world.props ?? []).filter(q => q.prop === entry.id).length;
    for (let k = have; k < (p.count ?? 1); k++) {
      let x = 0, z = 0, ok = false;
      for (let tries = 0; tries < 300 && !ok; tries++) {
        x = (rng() - 0.5) * W * 0.8; z = (rng() - 0.5) * D * 0.8;
        ok = Math.hypot(x, z) > 4 && sp.every(s => Math.hypot(s.x - x, s.z - z) > 3) && taken.every(t => Math.hypot(t.x - x, t.z - z) > 2.2);
      }
      taken.push({ x, z });
      (world.props ??= []).push({ prop: entry.id, at: [r2(x), 0, r2(z)], rot: Math.round(rng() * 360), scale: 1 });
    }
    if (entry.id !== p.name) notes.push(`world: "${p.name}" is the library's "${entry.id}"`);
  }
  if ((world.spawns ?? []).length < (spec.players?.max ?? 4)) world.spawns = spawns;
  world.zones = { centre: { shape: 'circle', at: [0, 0, 0], size: [2.5] }, ...(world.zones ?? {}) };
  // every prop the layout uses (placed or scattered): its model and its catalog entry
  for (const id of [...(world.props ?? []).map(p => p.prop), ...(world.scatter ?? []).map(s => s.prop)]) used.set(id, byId.get(id));
  const gameProps = (spec.world?.props ?? []).filter(p => !layoutProps.includes(p));
  for (const p of gameProps) { const e = await libraryProp(p.name, p.describe); if (e) used.set(p.name, { ...e, id: p.name }); }
  const catalog = { schema: 'gf-three-props/1', about: 'The asset library\'s props this game uses (library/packs, each named by its ref), for the world module.', props: [] };
  for (const [id, e] of [...used.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!e) { notes.push(`world: the template uses "${id}", which the three runtime's packs lack (runtimes/three/art.json)`); continue; }
    const { path: from, ...entry } = e;
    catalog.props.push({ ...entry, id });
    const to = `assets/models/${id}.glb`;
    if (!assets.some(a => a.to === to)) { const license = await libraryLicense(e.ref); assets.push({ to, from, license }); propFiles[id] ??= { file: to, from: `library:${e.ref}`, ...(license ? { license } : {}) }; }
  }
  world.__catalog = catalog;
  return world;
}

function cameraDefaults(mode) {
  if (mode === 'orbit') return { distance: 8, fov: 55 };   // CONTRACT §9
  if (mode === 'first') return { fov: 72, sensitivity: 0.0024 };
  if (mode === 'top') return { distance: 15, fov: 50 };
  if (mode === 'follow') return { distance: 34, minDistance: 20, maxDistance: 46, pitchDeg: 48, yawDeg: 45, fov: 25 };   // CONTRACT §8
  return { distance: 5.2, fov: 60, sensitivity: 0.0026 };
}
const r2 = v => Math.round(v * 100) / 100;
const cap = s => String(s).replace(/^./, c => c.toUpperCase()).slice(0, 60);

/** The HUD's goal line and How to play's (CONTRACT §6g): the spec's win line, else its rules summary, else its hook. */
/** The party page's time cap for a game a flow plays: a capped session's cap, a match's rounds and pauses, else the
 *  room's longest (an hour): a game with no clock is not cut short by the page. */
function flowMaxSeconds(spec, flow) {
  const s = spec.round?.seconds, P = flow.params ?? {};
  if (Number.isInteger(P.rounds)) return Math.min(3600, P.rounds * ((s ?? 120) + (P.between ?? 3)) + 30);
  return Number.isInteger(s) ? Math.min(3600, s + 30) : 3600;
}
export function goalLine(spec) {
  const t = String(spec.round?.winBy || spec.rules?.summary || spec.hook || '').replace(/\s+/g, ' ').trim();
  if (t.length <= 120) return t;
  const cut = t.slice(0, 119); const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  return stop > 40 ? cut.slice(0, stop + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
}

// ---- the action mechanics' sounds and, in scenic games, their art (CONTRACT §8; gf-scenic wave 1, track M) ----
const MECHANIC_SOUNDS = {
  // the place sound is a soft hit with a low thump under it (play-test 2026-10-09: too quiet in mixed play; gainDb never
  // goes above 0, audio/GUIDE.md, so it gains body instead)
  build: { 'block-place': ['A block is placed', { layers: [{ preset: 'hit-soft' }, { preset: 'land', gainDb: -2 }] }, 'sfx'], 'block-break': ['A block breaks', 'hit-crunch', 'sfx'], paint: ['Paint sprays on', 'splash', 'sfx'], sign: ['A sign goes up', 'confirm', 'sfx'], fuse: ['A boom block is lit', 'countdown', 'sfx'], boom: ['A boom block pops', 'explosion-small', 'sfx'], denied: ['That can\'t be done', 'error', 'ui'], 'world-enter': ['You arrive in the world', 'powerup', 'ui'] },
  shove: { shove: ['A shove', 'arrow-whoosh', 'sfx'], 'shove-miss': ['A shove at nobody', 'hover', 'sfx'] },
  melee: { 'melee-swing': ['A sword whoosh', 'arrow-whoosh', 'sfx'], 'melee-heavy': ['A heavy sword whoosh', 'arrow-whoosh', 'sfx'], 'melee-hit': ['A crunchy hit', 'hit-crunch', 'sfx'], 'melee-block': ['A hit on a shield', 'hit-soft', 'sfx'], 'melee-dash': ['A quick dodge whoosh', 'jump', 'sfx'] },
  waves: { 'enemy-windup': ['An enemy about to strike', 'click', 'sfx'], 'enemy-swing': ['An enemy swing', 'arrow-whoosh', 'sfx'] },
  boss: { 'boss-roar': ['The boss roars', 'explosion-big', 'sfx'], 'boss-slam': ['The boss slams the ground', 'explosion-small', 'sfx'], 'boss-down': ['The boss falls', 'explosion-big', 'sfx'], 'enemy-windup': ['An enemy about to strike', 'click', 'sfx'] },
  levels: { 'portal-open': ['The portal opens', 'level-up', 'sfx'], 'portal-travel': ['Through the portal', 'powerup', 'sfx'] },
  loot: { 'loot-coin': ['A coin', 'coin', 'sfx'], 'loot-potion': ['A potion', 'heal', 'sfx'], 'loot-chest': ['A chest opens', 'door', 'sfx'], 'loot-weapon': ['A new weapon', 'gem', 'sfx'], 'loot-upgrade': ['An upgrade picked', 'level-up', 'sfx'] },
};

/** The scenic profile's props by id (its packs: runtimes/three/profiles/scenic-3d/art.json), each with its local file. */
function scenicProps() {
  return new Map(assetsIn('scenic', { category: 'prop' }).filter(a => localFile(a)).map(a => [a.id, { ...propEntry(a), path: localFile(a), license: licenceOf(a) }]));
}
/**
 * A scenic game's melee weapons, enemy and boss weapons and loot (chest, coin, potion) are the scenic library's KayKit
 * models (the scenic profile's packs in the asset library, CC0), copied into the mechanics' own model files. A spec (or the
 * pitch) names a library prop by its id wherever a mechanic takes a model file: a waves type's or the boss's `weapon`,
 * a melee weapon's `model` (e.g. "kaykit-skeleton-axe"); create copies it to assets/models/<id>.glb and fills the
 * grip from the library. Unnamed: the boss a staff, loot the dungeon chest, coin and bottle; the player's weapons are
 * melee's own default table (its manifest.items: a sword, an axe and a greatsword). A party game keeps the mechanics'
 * kit-drawn stand-ins.
 */
async function scenicMechanicArt(mechanics, assets, notes) {
  const lib = scenicProps();
  if (!lib.size) return;
  const grip = e => (e.grip ? { position: e.grip.position, quaternion: e.grip.quaternion } : undefined);
  const add = (id, to = `${id}.glb`) => {
    const e = lib.get(id);
    if (!e) return null;
    if (!assets.some(a => a.to === `assets/models/${to}`)) assets.push({ to: `assets/models/${to}`, from: e.path, license: e.license });
    return { ...e, to };
  };
  /** A library id where a model file goes: → {file, grip} (the file name in assets/models/), else null. */
  const named = v => { if (typeof v !== 'string' || !v) return null; const id = v.replace(/\.glb$/, ''); const e = lib.has(id) ? add(id) : null; return e ? { file: e.to, grip: grip(e) } : null; };
  const used = new Set();
  // a melee weapon the spec names by a library id (its `model` or `prop`); the default table is melee's own
  // (kit/mechanics/melee WEAPON_ITEM.defaults['scenic-3d']: "library:<id>" pictures that create's ensurePictures copies in)
  const melee = mechanics.find(m => m.id === 'melee');
  for (const w of Array.isArray(melee?.params?.weapons) ? melee.params.weapons : []) { const r = named(w.model) ?? named(w.prop); if (r) { w.model = r.file; delete w.prop; w.grip ??= r.grip; used.add(r.file); } }
  const waves = mechanics.find(m => m.id === 'waves');
  for (const t of waves?.params?.types ?? []) { const r = named(t.weapon); if (r) { t.weapon = r.file; t.weaponGrip ??= r.grip; used.add(r.file); } }
  const boss = mechanics.find(m => m.id === 'boss');
  if (boss) {
    const r = named(boss.params.weapon) ?? (!boss.params.weapon ? named('kaykit-staff') : null);
    if (r) { boss.params.weapon = r.file; boss.params.weaponGrip ??= r.grip; used.add(r.file); }
  }
  if (used.size) notes.push(`scenic library models: ${[...used].join(', ')} (KayKit, CC0)`);
  if (mechanics.some(m => m.id === 'loot')) {
    const got = [['chest', 'dungeon-chest'], ['coin', 'dungeon-coin'], ['potion', 'dungeon-bottle']].filter(([k, src]) => add(src, `loot-${k}.glb`)).map(([k]) => k);
    if (got.length) notes.push(`loot: the scenic library's ${got.join(', ')} (KayKit Dungeon Remastered, CC0)`);
  }
}

// ---- worlds (CONTRACT §9; worlds/PLAN.md) ----
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const merge = (a, b) => { const out = { ...a }; for (const [k, v] of Object.entries(b ?? {})) out[k] = isObj(v) && isObj(a?.[k]) ? merge(a[k], v) : v; return out; };

/** config/world.json for world.template 'voxel': the kit's default block island (kit/world/voxel/default.json) seeded by
 *  the title, the spec's world.params merged over it, every block texture copied from the library (with its licence),
 *  and the spawn square protected (the play host refuses edits there too). */
async function voxelWorld(spec, { assets, notes }) {
  const D = JSON.parse(await readFile(kitPath(KIT, 'world/voxel/default.json'), 'utf8'));
  delete D.about;
  const hotbar = D.hotbar; delete D.hotbar;
  const V = merge(D, spec.world?.params ?? {});
  delete V.hotbar;
  V.terrain = { ...V.terrain, seed: V.terrain?.seed ?? (hashString(`${spec.title}|island`) % 1e9) };
  const plaza = V.terrain.plaza ?? {};
  if (typeof plaza.signText === 'string') plaza.signText = plaza.signText.replace(/\{title\}/g, spec.title).slice(0, 60);
  const textures = {};
  for (const [name, src] of Object.entries(V.textures ?? {})) {
    if (!String(src).startsWith('library:')) { textures[name] = src; continue; }
    const a = findAsset(src, 'three'), from = a && localFile(a);
    if (!from) { notes.push(`world: block texture ${name}: ${src} is not in the library on this machine; left as the kit's colour`); continue; }
    const to = `assets/textures/blocks/${name}.png`;
    assets.push({ to, from, license: licenceOf(a) });
    textures[name] = to;
  }
  V.textures = textures;
  const [sx, sy, sz] = V.size;
  const at = plaza.at ?? [Math.floor(sx / 2), Math.floor(sz / 2)], half = plaza.half ?? 6;
  V.protect ??= [{ min: [at[0] - half, V.floor ?? 1, at[1] - half], max: [at[0] + half, sy - 1, at[1] + half], why: 'spawn square' }];
  notes.push(`world: a voxel island ${sx} × ${sy} × ${sz}, seed ${V.terrain.seed}, ${V.blocks.length} blocks, spawn square protected`);
  return { template: 'voxel', voxel: V, __hotbar: spec.world?.params?.hotbar ?? hotbar };
}

/** A world game (the world loop): no clock, results or bots; first person (the creator, 2026-10-09: "Can we make it
 *  first person?"; spec.camera 'orbit' keeps the third-person one); the build tools' words. */
function worldGame(spec, game, world, notes) {
  game.round = { mode: 'world', countdown: 0, replay: false, ...(spec.round?.winBy ? { winBy: spec.round.winBy } : {}) };
  game.players.bots = false;
  game.camera = spec.camera ?? 'first';
  game.controller = { speed: 5.0, sprint: 7.2, jump: 7.4, camera: { [game.camera]: cameraDefaults(game.camera) } };
  // the bare page's home menu: Enter the world (the world card, saved) first, then a practice copy that saves nothing
  Object.assign(game.text, { play: 'Enter the world', playSub: 'Build, break and paint anything', enter: 'Enter the world', enterSub: 'Build with everyone here: it is all saved',
    practice: 'Try it on your own', practiceSub: 'A practice copy: nothing you build is saved', welcome: `Welcome to ${spec.title}` });
  if (!spec.round?.winBy) game.text.goal = 'Build anything: it stays for everyone';
  const build = game.mechanics.find(m => m.id === 'build');
  if (build) {
    if (!build.params.hotbar?.length && world?.__hotbar) build.params.hotbar = world.__hotbar;
    game.controls = { primary: 'use the tool (place a block)', secondary: 'break a block', interact: 'change a sign', jump: 'jump',
      more: [[game.camera === 'first' ? '1 – 0 · wheel' : '1 – 0', 'pick a block', 'Hotbar'], ['X', 'break tool', 'Break button'], ['P', 'paint tool', 'Paint button'], ...(game.mechanics.some(m => m.id === 'shove') ? [['F', 'shove someone', 'Shove button']] : [])],
      ...(spec.controls ?? {}) };
  } else notes.push('world: the world loop without the build mechanic: nothing can change the world');
  if (world) delete world.__hotbar;
  delete game.props;
}

// ---- the vista runtime's keys, bodies and sounds ----
/**
 * A vista game's controls (config/game.json → controls): the core's own keys as rows of [keys, what], the spec's words
 * on the keys the core really uses: the left button for the primary, the right for the secondary, E for interact,
 * Space for jump, and R for the rod (the core's, always there).
 */
export function vistaControls(c = {}) {
  const more = [['R', 'take out or put away the rod']];
  if (c.primary) more.push(['Click', String(c.primary)]);
  if (c.secondary) more.push(['Right click', String(c.secondary)]);
  if (c.interact) more.push(['E', String(c.interact)]);
  for (const r of Array.isArray(c.more) ? c.more : []) if (Array.isArray(r) && r[0] && r[1]) more.push([String(r[0]), String(r[1])]);
  return { ...(c.jump ? { jump: String(c.jump) } : {}), more };
}
/** The shared gf-humanoid-1 clip file every body plays: → { from (its file here), license } or null. */
function humanoidClips() {
  const a = findAsset('humanoid-clips/gf-humanoid-1'), from = a && localFile(a);
  return from ? { from, license: licenceOf(a) } : null;
}
/**
 * config/characters.json → vista, and the body files copied in: kit/bodies.json's `default` ids (track C's realistic
 * bodies) when that list exists and the library has them here, else the wave 1 sandbox's four Quaternius bodies; the
 * shared clips. Each body's file and licence are the library's (kit/bodies.json adds heights and the like).
 */
export async function vistaBodies({ assets, notes }) {
  const C = await importPart(join(VISTA_KIT, 'config.js'), 'the vista runtime');
  const kitList = await readJsonMaybe(join(VISTA_KIT, 'bodies.json'));
  const asset = id => { const a = findAsset(id, 'three'); return a?.category === 'body' && localFile(a) ? a : null; };
  const rec = id => { const a = asset(id), k = kitList?.bodies?.[id]; return a ? { ...bodyEntry(a), ...(k ?? {}), file: localFile(a), license: licenceOf(a) } : null; };
  let ids = Array.isArray(kitList?.default) ? kitList.default.filter(id => asset(id)) : [];
  const from = ids.length ? 'kit/bodies.json (track C)' : 'the wave 1 sandbox\'s Quaternius bodies (kit/bodies.json is not in yet)';
  if (!ids.length) ids = C.FALLBACK_BODIES.filter(id => asset(id));
  if (!ids.length) throw new Error('vista: no body for friends: neither kit/bodies.json\'s defaults nor the Quaternius bodies are in the asset library on this machine');
  while (ids.length < C.SEATS) ids = [...ids, ...ids].slice(0, C.SEATS);
  const records = Object.fromEntries(ids.map(id => [id, rec(id)]));
  const files = [];
  for (const id of new Set(ids)) {
    const r = records[id];
    assets.push({ to: C.bodyFile(id), from: r.file, license: r.license });
    files.push({ file: C.bodyFile(id), from: `library:${r.ref}`, license: r.license });
  }
  const clips = humanoidClips();
  if (!clips) throw new Error('vista: the shared clip file (humanoid-clips/gf-humanoid-1) is not in the asset library on this machine');
  assets.push({ to: C.CLIPS_FILE, from: clips.from, license: clips.license });
  notes.push(`characters: friends see each other as gf-humanoid-1 bodies skinned by the vista core, one a seat (${ids.join(', ')}; from ${from}), tinted in their colour; slots ${C.bodySlot(0)}, ${C.bodySlot(1)}, …`);
  return { config: C.bodiesConfig(ids, records), files };
}
/** The core's sounds as gf-audio lists them: the tables module's `soundsOf(tables)` or `SOUNDS`, else kit/audio.js's. */
async function vistaSounds(tables, T) {
  let found = null;
  try { found = typeof T?.soundsOf === 'function' ? T.soundsOf(tables) : Array.isArray(T?.SOUNDS) ? T.SOUNDS : null; } catch { found = null; }
  // track G's list (kit/sounds.json): the core's 42 field recordings and the HUD's own few, with the game's paths
  // (the sandboxes link the core at gf/core/; a game vendors it at gf/vista/core/)
  if (!found && existsSync(join(VISTA_KIT, 'sounds.json'))) {
    try {
      const L = JSON.parse(await readFile(join(VISTA_KIT, 'sounds.json'), 'utf8'));
      found = Object.entries(L.sounds ?? {}).map(([id, v]) => ({ id, ...structuredClone(v), ...(v?.src?.file ? { src: { ...v.src, file: String(v.src.file).replace(/^gf\/core\//, 'gf/vista/core/') } } : {}) }));
    } catch { found = null; }
  }
  if (!found && existsSync(join(VISTA_KIT, 'audio.js'))) {
    try { const A = await importPart(join(VISTA_KIT, 'audio.js'), 'the vista runtime'); found = typeof A.soundsOf === 'function' ? A.soundsOf(tables) : Array.isArray(A.SOUNDS) ? A.SOUNDS : null; } catch { found = null; }
  }
  if (Array.isArray(found) && found.length) return { list: found.filter(s => s && typeof s.id === 'string'), note: `sounds: the vista core's ${found.length} sounds are listed by name (assets.json → sounds), played through gf-audio` };
  return { list: [], note: 'sounds: the vista core\'s field recordings (surf, wind, steps, reel, splash) still play through its own soundscape, not gf-audio; they become named sounds here once the vista kit lists them (track G: kit/audio.js or the tables\' SOUNDS)' };
}
