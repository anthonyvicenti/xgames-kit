// Promises need proof (creator decision 2026-10-06, research/foundations/evidence/studio-v2-build-method-decision-2026-10-06.json).
// A game promises things: every control its HUD lists, what each mechanic is "as", the hook on its title card, the core
// loop in its rules, the creator's accept items, and the kit's standing promises. This module derives that list from
// spec.json and config/game.json, with no browser. Each promise names its proofs: a verify check ('verify:N') or a
// play-tester's own screen ('play'). The worker writes it into every build and v2 change job (job/promises.json), and
// the play-tester (builder/spec/prompts/playtest.md) is held to the 'play' ones.
//
//   const list = derivePromises({ spec, config });   // { schema, title, hook, controls, promises: [...], notPromised, excluded }
//   const list = await promisesFor(gameDir, { spec }); // reads <game>/spec.json (or the spec given) and <game>/config/game.json
//
// A promise: { id, text (plain words a player would say), source (where it came from), proofs: ['verify:N' | 'play'],
//              core (true: the first-minute loop; a core promise still failing after the repair rounds fails the job),
//              kind: 'control' | 'loop' | 'score' | 'mechanic' | 'hook' | 'accept' | 'build' | 'kit', and for a control: action, keys, key, hud;
//              confirm: true when only the play-tester seeing it work proves it: an unanswered or untested one counts as failed }
// What the game builds new (spec.build, the pitch never narrows an idea to the kit; the creator, 2026-10-12: "Let the build
// write engine code") is a 'build' promise each: core, proved only by the play-tester's own screen, and never left untested.
// The spec's notInV1 items are never promised: a derived promise that is mostly one of them is dropped (listed in `excluded`).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FORGE_KIT, importPart } from './paths.mjs';
// the forge runtime's tables, when this checkout carries the forge runtime
let fillForgeTables = null;
if (existsSync(join(FORGE_KIT, 'tables/index.js'))) ({ fill: fillForgeTables } = await importPart(join(FORGE_KIT, 'tables/index.js'), 'the forge runtime'));

export const SCHEMA = 'gf-three-promises/1';

/** What the kit's HUD prints for each action (kit/ui/ui.js helpLine) and the key the play tool presses for it. */
export const CONTROL_KEYS = {
  primary: { keys: 'click / F', key: 'Mouse' },
  secondary: { keys: 'right click / Q', key: 'MouseRight' },
  interact: { keys: 'E', key: 'KeyE' },
  jump: { keys: 'Space', key: 'Space' },
};

/** The HUD's help line for a controls map, exactly as kit/ui/ui.js draws it (the follow camera's mouse aims). */
export function hudLine(controls = {}, camera = 'third') {
  const parts = ['WASD move', camera === 'follow' ? 'mouse aim' : 'mouse look'];
  if (controls.primary) parts.push(`click / F: ${controls.primary}`);
  if (controls.secondary) parts.push(`right click / Q: ${controls.secondary}`);
  if (controls.interact) parts.push(`E: ${controls.interact}`);
  if (controls.jump) parts.push(`Space: ${controls.jump}`);
  parts.push('Esc: menu');
  return parts.join(' · ');
}

/** The kit's standing promises (CONTRACT §5 check numbers). verify proves them; 'play' adds what a new player sees. */
export const KIT_PROMISES = [
  // proved by verify alone (no 'play' proof: the play-tester is not asked). Since M2-C the kit refuses what the brief forbids at
  // the call, with a code on console.error (kit/core/refusals.js), so check 3 is where a refused call shows up.
  { id: 'kit.boots', text: 'The game opens and plays without errors: nothing in a round throws, and no call the kit refuses (a sound that is not listed, a slot that does not exist, a goal line that is too short) goes unnoticed.', proofs: ['verify:3'], check: 'boots with no console errors' },
  // (check 1: assets.json lists exactly the slots the declarations give; check 4: every mesh on screen carries one, and
  // the game's own code builds nothing to draw)
  { id: 'kit.slots', text: 'Everything I see in the game is a piece that can be shown and swapped in Studio: a model, a picture or a number with a slot of its own, never a shape drawn in the game\'s code.', proofs: ['verify:1', 'verify:4'], check: 'slot coverage' },
  // (check 2: every kit file is its release's, or an override the game declared with its release base: CONTRACT §1.7)
  { id: 'kit.release', text: 'The game runs on the released kit and runtime: every part of them it carries is the release\'s own, or a change this game declared for itself with its reason, so a fix to the kit reaches it and nothing in it is a broken copy.', proofs: ['verify:2'], check: 'kit copies unedited' },
  { id: 'kit.friends', text: 'With friends in the game, I see each of them as a character with a name, where they really are.', proofs: ['verify:5'], check: 'friends visible' },
  { id: 'kit.round', text: 'A round ends on a results screen that says who won, and I can play again.', proofs: ['verify:6', 'play'], check: 'a round to results and replay' },
  { id: 'kit.fair', text: 'When I get knocked down I am back up within a moment, and nobody can keep me on the floor.', proofs: ['verify:10', 'play'], check: 'fair play' },
  { id: 'kit.clean', text: 'The world looks tidy: nothing floating, sunk into something else or cluttering the floor.', proofs: ['verify:11'], check: 'clean world' },
  { id: 'kit.happens', text: 'Something happens in a round: scores move, each point from something a player did.', proofs: ['verify:12'], check: 'scores come from counted events' },
  { id: 'kit.events', text: 'Whatever happens to me in the game (a hit I land or take, a kill, a pickup, a shot) shows on my own screen or I hear it, at once.', proofs: ['verify:38'], check: 'every event answered' },
  { id: 'kit.controls', text: 'Every control the HUD lists does something I can see.', proofs: ['verify:13'], check: 'controls work' },
  { id: 'kit.looks', text: 'Every character and prop the creator asked to be made is that model, or the delivery names the placeholder still in its place and why; no enemy wears a player\'s body in another colour.', proofs: ['verify:14'], check: 'looks honoured' },
  { id: 'kit.sounds', text: 'Every sound the game lists plays at its moment and I can hear it, and every sound or music file the creator gave it is one of them.', proofs: ['verify:18', 'verify:38'], check: 'sounds play' },
  { id: 'kit.bodies', text: 'Every character looks whole when it moves: its face, body, arms, hands, legs and feet keep their shape in every animation (no crooked hand or folded palm, no stretched face).', proofs: ['verify:19'], check: 'bodies hold their shape' },
  { id: 'kit.menu', text: 'The game opens on a home menu: Play, Play with friends, How to play (every control and the goal), Settings (volume, mouse sensitivity) and Connect wallet; Esc pauses a round, and I can go back to the menu.', proofs: ['verify:20', 'play'], check: 'the menu works' },
  { id: 'kit.hud', text: 'In a round the HUD shows me my own state: my health when the game has hit points (it drops when I am hurt), when I am knocked down or out, the goal, and each meter the game has (a tank, my paint share, the wave and enemies left, my lap).', proofs: ['verify:21', 'play'], check: 'the HUD shows your state' },
  { id: 'kit.wallet', text: 'On the games.fun page, the home menu connects my wallet, lists the items I own from this game, and Wear puts one on me where everyone sees it.', proofs: ['verify:22'], check: 'the wallet in the menu' },
  { id: 'kit.lobby', text: 'Playing with friends, I pick my name before I host or join and can change it in the waiting room; the waiting room shows the room code once and everyone in the colour their character wears; only friends play (no bots); and the results show each of us our own score.', proofs: ['verify:25'], check: 'playing with friends' },
  { id: 'kit.post', text: 'Inside a post on X (a small frame that cannot lock the mouse) a button makes the game full screen, so the mouse stays on the game, and I can still look around by dragging.', proofs: ['verify:24'], check: 'plays inside a post' },
  { id: 'kit.screens', text: 'The game looks sharp on my phone, my tablet and my computer, at any window size, and stays sharp when I zoom the browser or turn the phone.', proofs: ['verify:31', 'play'], check: 'sharp on every screen' },
  { id: 'kit.world', text: 'The world is a whole place the size I asked for: a building has walls all round, a ceiling and real doors (enemies come in through them), and past the walls I see a street or skyline, not an empty plain.', proofs: ['verify:17', 'play'], check: 'the world is complete' },
];

/** A world's standing promises (CONTRACT §9, round.mode "world"), in place of a round's (results and replay, fair
 *  knock-downs, moving scores, a walled world and a waiting room do not apply): verify's world checks prove them. */
export const WORLD_PROMISES = [
  { id: 'kit.world.friends', text: 'I enter the world from its card with a name I pick (no code, no Start); my friends and I each start on a spot of our own, each in one colour that the card, the menu and our character agree on, and nobody\'s name shows a slur.', proofs: ['verify:5', 'verify:25', 'play'], check: 'friends in one world' },
  { id: 'kit.world.saved', text: 'What we build in the world is saved: a fresh browser tomorrow finds it all there. The game\'s own page alone is only a practice copy that changes nothing.', proofs: ['verify:26', 'play'], check: 'the world persists' },
  { id: 'kit.world.host', text: 'When whoever is hosting leaves, the world carries on: someone else hosts within seconds and nothing anyone built is lost.', proofs: ['verify:27'], check: 'the host leaves' },
  { id: 'kit.world.spawn', text: 'Nobody can dig up, build on, paint or blow up the spawn square.', proofs: ['verify:28', 'play'], check: 'the spawn square holds' },
  { id: 'kit.world.words', text: 'The words on a sign never show a slur or a strong curse, to anyone.', proofs: ['verify:29', 'play'], check: 'sign words are filtered' },
  { id: 'kit.world.phones', text: 'On a phone I can walk, look around, build, break and use every tool by touch.', proofs: ['verify:30', 'play'], check: 'phones' },
];
/** A world in first person (the creator, 2026-10-09: "Can we make it first person?"). */
export const WORLD_FIRST_PROMISE = { id: 'kit.world.first', text: 'I see the world through my own eyes: after a first click the mouse looks around and I build where the crosshair is (the wheel picks a block); inside a post I drag to look and click the block I want; on a phone I drag to look and tap.', proofs: ['verify:13', 'verify:24', 'verify:30', 'play'], check: 'first person' };
/** The round promises a world never makes. */
const ROUND_ONLY = new Set(['kit.round', 'kit.fair', 'kit.happens', 'kit.lobby', 'kit.world']);
/** The kit's standing promises a vista game does not make yet, each with why (CONTRACT §8 vista; verdict.mjs NOT_YET_VISTA). */
export const VISTA_NOT_YET = {
  'kit.slots': 'the island the vista core draws is not slots yet (verify check 4 is not yet for vista)',
  'kit.fair': 'nothing knocks a player down in a calm vista game',
  'kit.clean': 'the world is the core\'s own island, not a layout made for the game',
  'kit.happens': 'no bots on vista (verify check 12 is not yet for vista)',
  'kit.bodies': 'the friends\' bodies are library bodies; the vista core\'s skinning is not judged by verify yet (check 19)',
  'kit.wallet': 'an item worn from the wallet is not drawn on vista bodies yet',
  'kit.post': 'a vista game is never offered inside a post on X',
  'kit.screens': 'a vista game is for a desktop browser with WebGPU, not phones',
  'kit.world': 'the world is the core\'s own island',
};

/** The action mechanics (gf-scenic wave 1, track M): what each promises a player, and which checks prove it. */
export const MECHANIC_PROMISES = {
  melee: { text: 'I swing my weapon where I aim: a combo with weight (a windup, a hit that stops for an instant, a recovery), a heavy strike and a dodge; every hit shows on the enemy and it takes a few to go down.', proofs: ['verify:13', 'verify:16', 'verify:15', 'play'] },
  levels: { text: 'When every enemy on a level is down its portal opens; stepping in together takes us all to the next level, and the last level is the boss\'s.', proofs: ['verify:15', 'play'] },
  boss: { text: 'The boss is its own big character with its name and health across the top of the screen; each attack warns on the ground before it lands, and it fights harder as it weakens.', proofs: ['verify:15', 'play'] },
  loot: { text: 'Kills drop coins (counted on the HUD) and sometimes a potion; chests open with E; a weapon I pick up changes my weapon; between levels I choose one of three upgrades.', proofs: ['verify:15', 'play'] },
};

/**
 * What the forge runtime promises a player (CONTRACT §8 forge), from the game's data tables (config/game.json → forge):
 * the first-person actions the HUD's control line does not list (the evade, reload, the quick melee, the weapon keys),
 * hits that read, waves, being hurt, and what verify alone proves (every drawn thing a slot; no blank page without
 * WebGPU; a lost device recovered). The play-tester of a forge game (builder/spec/prompts/playtest-forge.md) is
 * held to the 'play' ones. → promises without `kind` and `core` (derivePromises adds them)
 */
export function forgePromises(tables = {}) {
  // filled first (the kit's own fill: a preset's magazine, an archetype's numbers), so a spec's raw rows
  // ({id, preset: "pistol"}) promise what the game made from them will have, the same as a game's filled config
  let forge = tables; try { if (fillForgeTables) forge = fillForgeTables(tables ?? {}); } catch {}
  const out = [], W = forge.weapons ?? [], E = forge.enemies ?? [], waves = forge.waves ?? [];
  const names = W.map(w => w.name || w.id).filter(Boolean);
  out.push({ id: 'forge.slots', text: 'Everything the game draws is a piece Studio can show and swap: every model, picture and number is a slot, and nothing I see is built into the runtime.', source: 'forge: slot coverage', proofs: ['verify:4'] });
  out.push({ id: 'forge.browser', text: 'In a browser without WebGPU the game says so and gives me a link to open somewhere it plays, never a blank page; and if the graphics device is lost in a round the game draws again by itself.', source: 'forge: no WebGPU, a lost device', proofs: ['verify:32', 'verify:33'] });
  // (gf-forge wave 4: a release's check, tools/lib/verdict.mjs RELEASE_ONLY, so a build's own verify leaves it untested)
  out.push({ id: 'forge.watch', text: 'In a round with friends I can go live from the menu: anyone with my link watches the fight through my eyes as I play it, and can then join us, start a room of their own or play alone.', source: 'forge: watch then play', proofs: ['verify:34'] });
  out.push({ id: 'forge.evade', text: 'Shift is a quick evade: a short dash the way I am moving, and I cannot do it again at once.', source: 'forge: the player table (evade)', proofs: ['play'] });
  if (W.length) {
    if (E.length) out.push({ id: 'kit.hits', text: 'When I shoot or strike an enemy I see each hit land: it flashes white, a number pops from it, and it takes a few hits to go down.', source: 'forge: hits read', proofs: ['verify:16', 'play'] });
    out.push({ id: 'forge.weapon', text: `My weapon is in my hand on screen${names.length ? ` (${names[0]} first)` : ''}; firing shows at once (a flash, a kick, the round gone from the counter).`, source: 'forge: the weapons table', proofs: ['play'] });   // seen, not heard: a play-tester's script has no ears (sound is checks 7 and 18)
    if (W.some(w => Number(w.magazine ?? 0) > 0)) out.push({ id: 'forge.reload', text: 'The HUD shows my rounds; R reloads, and an empty weapon reloads by itself.', source: 'forge: the weapons table (magazine, reload)', proofs: ['play'] });
    out.push({ id: 'forge.melee', text: 'V is a quick melee: a close swing that hits what is right in front of me, whatever weapon I hold.', source: 'forge: the quick melee', proofs: ['play'] });
    // only what is in hand at the start is promised as a key: a weapon a card gives is said as that (the frozen forge
    // case, 2026-10-11: "Keys 1 to 4 … pick a weapon" with three of the four given by card; the play-tester failed
    // it and the repair put every weapon in hand to make the sentence true)
    const label = w => w.name || w.id, key = w => Number(w.slot) || W.indexOf(w) + 1;
    const first = W.filter(w => w.start !== false), carded = W.filter(w => w.start === false && (forge.cards ?? []).some(c => c?.kind === 'weapon' && c.weapon === w.id));
    const list = ws => ws.map(w => `${label(w)} on ${key(w)}`).join(', ');
    const more = carded.length ? ` A reward card can give me ${carded.length > 1 ? 'another' : 'one more'} (${list(carded)}); from then on its key picks it too.` : '';
    if (first.length > 1) out.push({ id: 'forge.weapons', text: `The number keys and the wheel pick a weapon (${list(first)}); each comes up in my hand and fires its own way.${more}`, source: 'forge: the weapons table (slots, start) and the weapon cards', proofs: ['play'] });
    else if (carded.length) out.push({ id: 'forge.weapons', text: `I start with one weapon${first.length ? ` (${label(first[0])})` : ''}.${more} Each comes up in my hand and fires its own way.`, source: 'forge: the weapons table (slots, start) and the weapon cards', proofs: ['play'] });
  }
  if (E.length && waves.length) {
    out.push({ id: 'forge.waves', text: `Enemies rise in waves (${waves.length}); I can tell their kinds apart, each warns before it hits, and I can tell which wave I am on and when one is cleared.`, source: 'forge: the enemies and waves tables', proofs: ['play'] });
    out.push({ id: 'forge.hurt', text: 'When an enemy hits me I see it at once (the screen\'s edge goes red) and my health on the HUD drops; when it runs out I am down and the round ends on the results, which say what killed me.', source: 'forge: hurt, low health, the death recap', proofs: ['verify:21', 'play'] });
  }
  return out;
}

// ---- words (for the notInV1 exclusion) ----
const STOP = new Set(['the', 'and', 'with', 'your', 'you', 'for', 'that', 'this', 'are', 'its', 'their', 'they', 'them', 'have', 'has', 'can', 'see', 'into', 'from', 'when', 'what', 'who', 'one', 'out', 'off', 'all', 'any', 'more', 'than', 'then', 'not', 'but', 'get', 'got', 'how', 'per', 'each', 'also', 'mode']);
const stem = w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
export const contentWords = t => new Set((String(t).toLowerCase().match(/[a-z][a-z'-]{2,}/g) ?? []).filter(w => !STOP.has(w)).map(stem));
/** How much of the notInV1 item's content words the text repeats: {n, share}. */
export function overlap(item, text) {
  const a = contentWords(item), b = contentWords(text);
  let n = 0; for (const w of a) if (b.has(w)) n++;
  return { n, share: a.size ? n / a.size : 0 };
}
/** A promise is mostly a notInV1 item when it repeats at least two of its words and 60% of them ("more maps" alone never drops a hook about the map). */
export const isMostly = (item, text) => { const o = overlap(item, text); return o.n >= 2 && o.share >= 0.6; };

const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim();
const sentence = s => { const t = clean(s); return t && !/[.!?]$/.test(t) ? `${t}.` : t; };
const FRIENDS = /\bfriends?\b[^.]*\b(see|visible|seen|show)|\bsee each other\b|\bsee (your|my) friends\b/i;

/**
 * The promise list. `spec` is the locked game spec; `config` is config/game.json (what the game ships: its HUD controls,
 * hook and mechanics win over the spec's, because that is what the player sees).
 */
export function derivePromises({ spec = {}, config = {} } = {}) {
  const out = [], excluded = [];
  const notInV1 = (spec.notInV1 ?? []).map(clean).filter(Boolean);
  const add = p => {
    const hit = notInV1.find(n => isMostly(n, p.text));
    if (hit) { excluded.push({ id: p.id, text: p.text, because: `not in v1: ${hit}` }); return; }
    if (out.some(q => q.id === p.id)) { let i = 2; while (out.some(q => q.id === `${p.id}-${i}`)) i++; p = { ...p, id: `${p.id}-${i}` }; }
    out.push(p);
  };

  // 1. every control the HUD lists (config wins: the agent may have changed the words)
  const controls = { ...(spec.controls ?? {}), ...(config.controls ?? {}) };
  const order = Object.keys(CONTROL_KEYS), rank = a => (order.includes(a) ? order.indexOf(a) : order.length);
  for (const [action, raw] of Object.entries(controls).sort((x, y) => rank(x[0]) - rank(y[0]))) {
    const desc = clean(raw);
    if (!desc) continue;
    const k = CONTROL_KEYS[action];
    if (!k) { excluded.push({ id: `control.${action}`, text: desc, because: 'the HUD does not show this action (only primary, secondary, interact and jump)' }); continue; }
    add({ id: `control.${action}`, kind: 'control', action, keys: k.keys, key: k.key, hud: `${k.keys}: ${desc}`,
      text: `Pressing ${k.keys} does what the HUD says ("${desc}"), and I can see it happen on my own screen.`,
      source: `config/game.json controls.${action}`, proofs: ['verify:13', 'play'], core: action !== 'jump' });
  }

  // 2. the core loop (rules summary) and the scoring a new player should see in the first minute
  const rules = { ...(spec.rules ?? {}), ...(config.rules ?? {}) };
  if (clean(rules.summary)) add({ id: 'loop', kind: 'loop', text: `In my first minute I can play the core loop: ${sentence(rules.summary)}`, source: 'rules.summary', proofs: ['verify:15', 'play'], core: true });
  if (clean(rules.scoring)) add({ id: 'score', kind: 'score', text: `My score changes on screen the way the rules say: ${sentence(rules.scoring)}`, source: 'rules.scoring', proofs: ['verify:12', 'play'], core: true });

  // 3. each mechanic's "as" (what it is in this game)
  const mechanics = Array.isArray(config.mechanics) && config.mechanics.length ? config.mechanics : (spec.mechanics ?? []);
  mechanics.forEach((m, i) => {
    const as = clean(m?.as), kit = MECHANIC_PROMISES[m?.id];
    if (!m?.id || (!as && !kit)) return;
    // the action mechanics promise what the kit makes them do, beside what they are in this game, proven by checks too
    if (kit) { add({ id: `mechanic.${m.id}`, kind: 'mechanic', mechanic: m.id, text: `${as ? `${sentence(as.charAt(0).toUpperCase() + as.slice(1))} ` : ''}${kit.text}`, source: `mechanics[${i}] (${m.id}): its "as" and the kit's ${m.id}`, proofs: [...kit.proofs], core: false }); return; }
    add({ id: `mechanic.${m.id}`, kind: 'mechanic', mechanic: m.id, text: `I can see this working when I play: ${sentence(as)}`, source: `mechanics[${i}].as (${m.id})`, proofs: ['play'], core: false });
  });

  // 4. the hook on the title card
  const hook = clean(config.text?.hook ?? config.hook ?? spec.hook);
  if (hook) add({ id: 'hook', kind: 'hook', text: `What the title card says happens in a round: "${hook}"`, source: config.text?.hook ? 'config/game.json text.hook' : config.hook ? 'config/game.json hook' : 'spec.hook', proofs: ['play'], core: false });

  // 5. the creator's accept items
  (spec.accept ?? []).forEach((a, i) => {
    const text = clean(a); if (!text) return;
    add({ id: `accept.${i + 1}`, kind: 'accept', text: sentence(text.charAt(0).toUpperCase() + text.slice(1)), source: `spec.accept[${i}]`, proofs: FRIENDS.test(text) ? ['verify:5'] : ['play'], core: false });
  });

  // 5b. what this game builds new because the kit does not do it yet (spec.build: {what, how, where}): the build agent's
  // to-do list. Each must be seen working by the play-tester (confirm: an unanswered one fails, loop/playtest.mjs)
  (spec.build ?? []).forEach((b, i) => {
    const what = clean(b?.what); if (!what) return;
    add({ id: `build.${i + 1}`, kind: 'build', text: `Built new for this game, and I can see it working when I play: ${sentence(what)}`, source: `spec.build[${i}]${b.where ? ` (${b.where})` : ''}`, proofs: ['play'], core: true, confirm: true });
  });

  // 6. the kit's standing promises (the winBy words ride on the round promise)
  const world = config.round?.mode === 'world' || (config.round?.mode === undefined && spec.loop === 'world');
  const first = world && (config.camera ?? spec.camera ?? 'first') === 'first';
  const vistaGame = spec.runtime === 'vista' || !!config.vista;
  for (const k of world ? [...KIT_PROMISES.filter(k => !ROUND_ONLY.has(k.id)), ...WORLD_PROMISES, ...(first ? [WORLD_FIRST_PROMISE] : [])] : KIT_PROMISES) {
    if (vistaGame && VISTA_NOT_YET[k.id]) { excluded.push({ id: k.id, text: k.text, because: `not yet for vista: ${VISTA_NOT_YET[k.id]}` }); continue; }
    const winBy = clean(config.round?.winBy ?? spec.round?.winBy);
    const text = k.id === 'kit.round' && vistaGame ? `A session ends on a results card with each player's score that says who won${winBy ? ` (${winBy}, or the best score when time runs out)` : ' (the best score)'}, and I can play again.`
      : k.id === 'kit.round' && winBy ? `A round ends on a results screen that says who won (${winBy}), and I can play again.` : k.text;
    add({ id: k.id, kind: 'kit', text, source: `kit: ${k.check}`, proofs: [...k.proofs], core: false });
  }
  // the look the spec is held to (verify measure 23, gate F; the looks layer, 2026-10-14): a style target, or the
  // creator's style pictures (before it, the roguelike miss: "The game also doesn't have the right vibe at all")
  const refs = (spec.references ?? []).filter(r => r && r.use === 'style');
  const target = spec.look?.target ?? null;
  if (target || refs.length || spec.look?.refs?.length) {
    const reads = (target?.reads ?? []).slice(0, 3).join('; ');
    add({ id: 'kit.look', kind: 'kit', text: `The game looks like its style target${reads ? ` (${reads})` : refs.length ? ` (the creator's ${refs.length} style picture${refs.length === 1 ? '' : 's'})` : ''}: its palette, light, materials, shapes and characters, at the target's camera framings.`,
      source: target ? 'spec.look.target' : 'spec.references (use style)', proofs: ['verify:23'], core: false });
  }
  // 7. a game with enemies: every hit reads (verify check 16; creator, "Hang Up On Them": "The zombies are instant killed")
  if (mechanics.some(m => m?.id === 'waves')) add({ id: 'kit.hits', kind: 'kit', text: `When I ${mechanics.some(m => m?.id === 'melee') ? 'strike' : 'shoot'} an enemy I see each hit land: a health bar over it drops, it flashes and flinches, and it takes a few hits to go down.`, source: 'kit: hits read', proofs: ['verify:16', 'verify:39', 'play'], core: false });

  // 8. the forge runtime (CONTRACT §8 forge): what its core gives every game, from the data tables
  const forge = config.forge ?? (spec.runtime === 'forge' ? spec.tables ?? {} : null);
  if (forge) for (const p of forgePromises(forge)) add({ kind: 'kit', core: false, ...p });
  // 9. the vista runtime (CONTRACT §8 vista): what its core gives every game, from the data tables
  const vista = config.vista ?? (spec.runtime === 'vista' ? spec.tables ?? {} : null);
  // on vista, check 15 lands a fish with real input and reads the score before and after (verify-vista.mjs): it holds
  // the score promise where check 12's bots cannot (no bots on vista)
  if (vistaGame) for (const p of out) if (p.id === 'score' && !p.proofs.includes('verify:15')) p.proofs = ['verify:15', ...p.proofs];
  if (vista && (spec.runtime === 'vista' || config.vista)) for (const p of vistaPromises(vista)) add({ kind: 'kit', core: false, ...p });

  const title = clean(config.text?.title ?? config.title ?? spec.title);
  return { schema: SCHEMA, title, hook, ...(forge ? { runtime: 'forge' } : vista ? { runtime: 'vista' } : {}), controls: { hud: hudLine(controls, config.camera ?? spec.camera), list: out.filter(p => p.kind === 'control').map(p => ({ action: p.action, keys: p.keys, key: p.key, does: controls[p.action] })) },
    promises: out, notPromised: notInV1, excluded };
}

/**
 * What the vista runtime promises a player (CONTRACT §8 vista), from the game's data tables (config/game.json → vista):
 * the island, the sea, the boat and the fishing the core plays, and what verify alone proves (no blank page without
 * WebGPU, the sea drawn and moving, the look the config's). The play-tester of a vista game
 * (builder/spec/prompts/playtest-vista.md) is held to the 'play' ones. → promises without `kind` and `core`
 */
export function vistaPromises(tables = {}) {
  const out = [], species = Object.values(tables.species ?? {}).map(s => s?.name).filter(Boolean);
  const buyer = tables.vendors?.buyer?.name, shop = tables.vendors?.shop?.name;
  out.push({ id: 'vista.browser', text: 'In a browser without WebGPU the game says so and gives me a link to open it where it plays, never a blank page.', source: 'vista: no WebGPU', proofs: ['verify:32'] });
  out.push({ id: 'vista.sea', text: 'When I look out to sea the water is alive: waves move, the light glints on them, and the sky, the clouds and the light are the game\'s own look.', source: 'vista: the sea and the look', proofs: ['verify:36', 'verify:37', 'play'] });
  out.push({ id: 'vista.sharp', text: 'On my computer the game is as sharp as my screen, at any window size and browser zoom: never a small picture stretched to fit.', source: 'vista: the canvas follows the pixel ratio', proofs: ['verify:31', 'play'] });
  out.push({ id: 'vista.walk', text: 'I walk the island in first person (WASD, the mouse to look), along the pier and the beach, and I can wade and swim into the sea.', source: 'vista: the core\'s walker', proofs: ['verify:3', 'play'] });
  out.push({ id: 'vista.fish', text: `R takes out my rod; I hold and let go of the left button to cast, and when a fish bites I strike and reel it in${species.length ? ` (${species.slice(0, 3).join(', ')}${species.length > 3 ? ', …' : ''})` : ''}.`, source: 'vista: the fishing (spec.vista.species)', proofs: ['verify:15', 'verify:13', 'play'] });
  if (buyer || shop) out.push({ id: 'vista.trade', text: `I can sell my catch${buyer ? ` at ${buyer}` : ''}${shop ? ` and buy better gear at ${shop}` : ''} (E at the stall).`, source: 'vista: vendors and gear (spec.vista)', proofs: ['play'] });
  out.push({ id: 'vista.boat', text: 'E boards the moored boat by the pier and takes its helm; I can steer it out to sea and back.', source: 'vista: the core\'s boat', proofs: ['play'] });
  return out;
}

/** The promises a play-tester is asked to prove (those with a 'play' proof). */
export const playPromises = list => (list?.promises ?? list ?? []).filter(p => p.proofs?.includes('play'));

/** Reads <game>/config/game.json and the spec (`spec` path, else <game>/spec.json) and derives the list, with the proof verify:35 on each promise a test of the game names. */
export async function promisesFor(gameDir, { spec: specFile = null } = {}) {
  const dir = resolve(gameDir);
  const read = async f => JSON.parse(await readFile(f, 'utf8'));
  const sf = specFile ? resolve(specFile) : join(dir, 'spec.json');
  const spec = existsSync(sf) ? await read(sf) : {};
  const cf = join(dir, 'config/game.json');
  const config = existsSync(cf) ? await read(cf) : {};
  if (!existsSync(sf) && !existsSync(cf)) throw new Error(`${dir} has neither spec.json nor config/game.json`);
  const list = derivePromises({ spec, config });
  // A promise one of the game's own tests names is also proven by verify check 35 (tools/lib/game-tests.mjs). A game
  // with no tests/ folder costs nothing; a test file that cannot be read is check 35's to report, not this list's.
  if (!existsSync(join(dir, 'tests'))) return list;
  try { return await (await import('./game-tests.mjs')).withTestProofs(dir, list); } catch { return list; }
}

/**
 * Settle each promise from its proofs: a verify check that ran (pass/fail; a check the verdict lacks is skipped) and the
 * play-tester's answer ({id, pass: true | false | null}). → [{...promise, status: 'proven' | 'failed' | 'untested', by: [...]}]
 * A promise fails when any proof failed, is proven when at least one ran and none failed, and is untested otherwise.
 */
export function settle(promises, { verifyChecks = [], play = [] } = {}) {
  const checks = new Map(verifyChecks.map(c => [String(c.id ?? c.n), c]));
  const answers = new Map(play.map(a => [a.id, a]));
  return promises.map(p => {
    const by = [];
    for (const proof of p.proofs ?? []) {
      if (proof.startsWith('verify:')) {
        const c = checks.get(proof.slice(7));
        if (!c || c.skipped || c.ok === null) continue;
        by.push({ proof, pass: !!c.ok });
      } else if (proof === 'play') {
        const a = answers.get(p.id);
        if (a && typeof a.pass === 'boolean') by.push({ proof, pass: a.pass, note: a.note ?? null, evidence: a.evidence ?? [] });
      }
    }
    // a promise only the play-tester can prove (confirm: what the game built new) that nobody saw work is not kept
    if (p.confirm && !by.length) by.push({ proof: 'play', pass: false, note: 'unconfirmed: no play-tester saw it work on its own screen' });
    const status = by.some(b => !b.pass) ? 'failed' : by.length ? 'proven' : 'untested';
    return { ...p, status, by };
  });
}
