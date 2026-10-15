// The pitch and the spec, held to the ledger and the foundation. The pitch never narrows: every card keeps every line
// the creator did not cut, a line the kit lacks is built (spec.build, named in the card's v1.build), and v1.notYet holds
// only what the creator's own words cut. The runtime and the loop are the foundation's; a card varies how it plays
// and, since a kind never changes play, how it looks.
//
// Pure: checkPitch(pitch, ctx) and checkSpec(spec, ctx) → ['$.cards[0].spec.build: …'].
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { liveRows, WHERE, NO_CHARACTER } from './ledger.mjs';
import { heldBy, shapeOf, SEES } from '../gf-multiplayer/source/presence.js';
import { parseBy, provenOn } from './registry.mjs';
import { HOW_BUILD, LONGER, NARROWING, list, names } from './words.mjs';
import { findNames, referenceNames } from '../lib/publish/names.mjs';

export const SPEC_VERSION = 2;
export const MAX_CARDS = 3;
export const PITCH_VERSION = 2;

/**
 * The pitch round's answer as pitch.v2 has it (builder/spec/pitch.v2.schema.json), less what the loop adds itself
 * (pitchVersion, the ledger with its foundation) and less each card's spec (the spec round checks that one against
 * spec v2 and the registry). A host gives it to a round as its output schema; checkPitch holds the answer to it.
 */
export const PITCH_OUTPUT = (() => {
  const p = structuredClone(JSON.parse(readFileSync(new URL('../spec/pitch.v2.schema.json', import.meta.url), 'utf8')));
  delete p.$schema; delete p.$id;
  p.required = p.required.filter(k => k !== 'pitchVersion' && k !== 'ledger');
  delete p.properties.pitchVersion; delete p.properties.ledger;
  p.properties.cards.items.properties.spec = { type: 'object' };
  return p;
})();
let validatePitch = null;
/** The pitch's problems against pitch.v2's own shape (the card fields, the reply's length, research, policy). */
export function pitchShapeProblems(pitch) {
  validatePitch ??= new Ajv2020({ allErrors: true, strict: false }).compile(PITCH_OUTPUT);
  if (validatePitch(pitch)) return [];
  return validatePitch.errors.slice(0, 20).map(e => `$${(e.instancePath || '').replaceAll('/', '.').replace(/\.(\d+)/g, '[$1]')}: ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ''}${e.params?.additionalProperty ? ` (${e.params.additionalProperty} is not a pitch v2 field)` : ''}`);
}

/**
 * One spec against the ledger and the foundation. ctx: {ledger, foundation, registry, checkSpec?} where checkSpec is
 * the host's own check (create's schema and the registry's composition rules) → problems.
 */
export async function checkSpec(spec, { ledger, foundation, registry, hostCheck = null, at = '$' } = {}) {
  const out = [], live = liveRows(ledger), build = Array.isArray(spec?.build) ? spec.build : [];
  if (!spec || typeof spec !== 'object') return [`${at}: no spec`];
  if (spec.specVersion !== SPEC_VERSION) out.push(`${at}.specVersion: ${SPEC_VERSION}`);
  // the loop may be another the person left open (foundation.loopChoices: they never said who acts when)
  const otherLoop = k => k === 'loop' && (foundation.loopChoices ?? []).includes(spec.loop);
  for (const k of ['runtime', 'profile', 'loop']) if ((spec[k] ?? null) !== (foundation[k] ?? null) && !otherLoop(k)) out.push(`${at}.${k}: "${foundation[k]}", the foundation's (${k === 'loop' ? foundation.why.loop : foundation.why.runtime}); a change of ${k} goes through the ledger and the foundation`);
  const kinds = await registry.kinds(), k = kinds.find(x => x.id === spec.kind);
  if (!k) out.push(`${at}.kind: a registry kind (${kinds.map(x => x.id).join(', ')})`);
  else if (!provenOn(k, spec.runtime, spec.profile) && !build.some(b => b?.kind === spec.kind)) out.push(`${at}.build: the ${spec.kind} look is not proven on ${spec.runtime}: add a build line {what, how, where, kind: "${spec.kind}"} that proves it in this game`);
  // every build line: what, how, where, and the ledger line it serves
  build.forEach((b, i) => {
    if (!b?.what) out.push(`${at}.build[${i}].what: what is built, in the person's words as the card says it`);
    if (!HOW_BUILD.test(String(b?.how ?? ''))) out.push(`${at}.build[${i}].how: what will be written (rules logic, a module in src/, an engine override)`);
    if (!WHERE.includes(b?.where)) out.push(`${at}.build[${i}].where: rules, module or engine`);
    if (!b?.kind && !live.some(r => r.id === b?.row)) out.push(`${at}.build[${i}].row: the id of the ledger line it serves`);
  });
  // every line the creator did not cut is kept
  const mech = new Set((spec.mechanics ?? []).map(m => m?.id ?? m));
  for (const r of live) {
    if (r.home === 'build' && !build.some(b => b?.row === r.id)) out.push(`${at}.build: the ledger line "${r.id}" (${r.what}) is built for this game: a build line with row "${r.id}" says what will be written`);
    if (r.home !== 'exists') continue;
    const ref = parseBy(r.by);
    const kept = !ref ? true : ref.type === 'mechanic' ? mech.has(ref.id) : ref.type === 'loop' ? spec.loop === ref.id || foundation.loopBuild?.wants === ref.id || (r.about === 'acts' && otherLoop('loop'))
      // the runtime is the foundation's (by hard limits): a line the ledger gave to another runtime is kept on the chosen one
      : ref.type === 'runtime' ? spec.runtime === ref.id || spec.runtime === foundation.runtime : ref.type === 'kind' ? true : true;
    if (!kept) out.push(`${at}: the ledger line "${r.id}" (${r.what}) is done by ${r.by}, and this spec ${ref.type === 'mechanic' ? `has no mechanic "${ref.id}"` : `is not on ${ref.type} "${ref.id}"`}: keep it`);
  }
  if (foundation.loopBuild && !build.some(b => b?.row === foundation.loopBuild.row)) out.push(`${at}.build: who acts when (${foundation.loopBuild.wants}) is built on the ${foundation.loop} loop: a build line with row "${foundation.loopBuild.row}"`);
  // not yet: only what the person cut
  const cut = (ledger?.rows ?? []).filter(r => r.cut);
  for (const [i, n] of (spec.notInV1 ?? []).entries()) {
    if (!cut.some(r => names(n, r.what) || names(n, r.words ?? ''))) out.push(`${at}.notInV1[${i}]: "${n}" is not a line the person cut; nothing they asked for waits for a later version (a line the kit lacks is built: spec.build)`);
  }
  // how friends are seen agrees with what a player is (the ledger's body line; gf/mp/presence.js): players who are no
  // characters (a board, a pointer, cards) are shown by presence, seats round one board or boards side by side
  const body = live.find(r => r.about === 'body')?.body, together = live.find(r => r.about === 'players')?.together ?? spec.multiplayer?.together;
  if (body && together !== 'solo' && spec.multiplayer && spec.multiplayer.mode !== 'solo') {
    const man = new Map();
    for (const m of spec.mechanics ?? []) if (m?.id && !man.has(m.id)) man.set(m.id, typeof registry.manifest === 'function' ? await Promise.resolve(registry.manifest('mechanic', m.id)).catch(() => null) : null);
    const shape = shapeOf({ together: spec.multiplayer.together, presence: spec.multiplayer.presence ?? null, held: heldBy(spec.mechanics ?? [], id => man.get(id)) });
    const want = spec.multiplayer.together === 'own-board' ? 'boards' : 'seats';
    if (NO_CHARACTER.includes(body) && shape === 'character') out.push(`${at}.multiplayer.presence: the ledger's body line makes the players no characters (${body}), and no part of this spec holds them: set "${want}" (friends seen as ${want}: ${SEES[want]}), or use a part that holds them (the board's presence "cursor", or its boards "own")`);
    else if (NO_CHARACTER.includes(body) && spec.multiplayer.together === 'own-board' && shape === 'seats') out.push(`${at}.multiplayer: each player has their own board (together own-board), so friends are seen as boards: the board's boards "own", or presence "boards"`);
    else if (body === 'character' && shape !== 'character') out.push(`${at}.multiplayer.presence: the ledger's body line makes the players characters, and this spec shows them as ${shape}: drop presence, or play the board walking (presence "walk")`);
  }
  // the players' shape agrees with the ledger's body line: a worm, blob, quadruped or flyer the person asked for is that
  // archetype's body in the spec (a humanoid in its place is the look drifting from the idea)
  const shape = live.find(r => r.about === 'body' && r.body === 'character')?.archetype;
  if (shape) {
    const player = (spec.characters ?? []).find(c => c?.role === 'player');
    const has = player?.body?.archetype ?? 'humanoid';
    if (player && has !== shape) out.push(`${at}.characters[player].body.archetype: the ledger's body line makes the players ${shape === 'humanoid' ? 'humanoids' : `a ${shape}`} ("${live.find(r => r.about === 'body')?.words ?? ''}"), and this spec gives them a ${has}: set body.archetype "${shape}" (a library body of that archetype, or one made and rigged by autorig)`);
  }
  out.push(...namedInShown(spec, ledger, at));
  if (hostCheck) out.push(...(await hostCheck(spec)).map(p => `${at}: ${p}`));
  return out;
}

/** What players read of a spec: its name, hook, round, rules, controls and characters (publish refuses a file that names a reference game). */
const SHOWN = ['title', 'hook', 'round', 'rules', 'controls', 'characters'];
/**
 * A game this one is made like, named where players read it (T1 run 1, 2026-10-14: "PeeVPee Brawl"). The person's words
 * keep the name (spec.prompt, the ledger); publish would refuse the game at the end (builder/lib/publish/names.mjs),
 * so the spec is held to it when it is locked. → problems
 */
export function namedInShown(spec, ledger, at = '$') {
  const known = referenceNames({ spec, ledger });
  if (!known.length) return [];
  const out = [];
  for (const k of SHOWN) {
    if (spec?.[k] == null) continue;
    for (const h of findNames(typeof spec[k] === 'string' ? spec[k] : JSON.stringify(spec[k]), known).filter(x => !x.warn)) {
      out.push(`${at}.${k}: "${h.found}" names ${h.name}, the game this one is made like: players never read its name (the person's words keep it); give it a name and words of its own`);
    }
  }
  return out;
}

/** How friends are seen in a spec (gf/mp/presence.js shapeOf, with the registry's manifests): 'character' | 'seats' | 'boards' | null. */
export async function friendsShapeOf(spec, registry) {
  if (!spec?.multiplayer || spec.multiplayer.mode === 'solo' || spec.multiplayer.together === 'solo') return null;
  const man = new Map();
  for (const m of spec.mechanics ?? []) if (m?.id && !man.has(m.id)) man.set(m.id, typeof registry?.manifest === 'function' ? await Promise.resolve(registry.manifest('mechanic', m.id)).catch(() => null) : null);
  return shapeOf({ together: spec.multiplayer.together, presence: spec.multiplayer.presence ?? null, held: heldBy(spec.mechanics ?? [], id => man.get(id)) });
}

/** The cards. kind 'pitch' (2–3 cards) or 'refine' (1–3). → problems */
export async function checkPitch(pitch, { ledger, foundation, registry, hostCheck = null, kind = 'pitch', extraAsks = [] } = {}) {
  const out = [...pitchShapeProblems(pitch)], cards = Array.isArray(pitch?.cards) ? pitch.cards : [];
  const min = kind === 'pitch' ? 2 : 1;
  if (cards.length < min || cards.length > MAX_CARDS) out.push(`$.cards: ${min} to ${MAX_CARDS} cards`);
  for (const [i, c] of cards.entries()) {
    const at = `$.cards[${i}]`;
    if (!c?.id || !c?.title) out.push(`${at}: an id and a title`);
    out.push(...await checkSpec(c?.spec, { ledger, foundation, registry, hostCheck, at: `${at}.spec` }));
    if (!c?.play) out.push(`${at}.play: how this card plays ({style, verbs, beat, touch, chaos}), so the person chooses play, not only look`);
    const said = (c?.v1?.build ?? []).join(' | ');
    for (const b of c?.spec?.build ?? []) if (b?.what && !names(said, b.what)) out.push(`${at}.v1.build: "${b.what}" is built new for this game: name it in the card's v1.build in plain words`);
    const cut = (ledger?.rows ?? []).filter(r => r.cut);
    for (const n of c?.v1?.notYet ?? []) if (!cut.some(r => names(n, r.what) || names(n, r.words ?? ''))) out.push(`${at}.v1.notYet: "${n}" is not something the person cut: keep it in the card (built new when the kit lacks it)`);
  }
  // the cards differ in play: each its own style (a pitch of one card is a refine)
  const styles = cards.map(c => String(c?.play?.style ?? '').trim().toLowerCase()).filter(Boolean);
  if (cards.length > 1 && styles.length === cards.length && new Set(styles).size < styles.length) out.push(`$.cards[].play.style: the cards differ in how they play ("${styles.join('", "')}"): give each its own style of play, so the person chooses play, not only look`);
  // the reply: never narrows, and says plainly what is built new and that it takes longer
  const reply = String(pitch?.reply ?? ''), built = (cards[0]?.v1?.build ?? []).filter(Boolean);
  if (NARROWING.test(reply)) out.push(`$.reply: it says "${reply.match(NARROWING)[0]}"; nothing the person asked for is cut down to the kit: say what card 1 does, and what is built new for this game`);
  if (built.length && kind === 'pitch') {
    if (!built.some(b => names(reply, b))) out.push(`$.reply: card 1 builds ${list(built, 2)} new for this game: say so in the reply`);
    if (!LONGER.test(reply)) out.push('$.reply: say plainly that building something new makes the build take longer');
  }
  // the questions are the ledger's, and only those
  const asked = new Set((ledger?.asks ?? []).map(q => q.about));
  for (const [i, q] of (pitch?.questions ?? []).entries()) if (!asked.has(q?.about) && !extraAsks.includes(q?.about)) out.push(`$.questions[${i}]: the pitch asks only the ledger's questions (${[...asked].join(', ') || 'none'}); decide the rest from the person's words and say it`);
  for (const a of asked) if (!(pitch?.questions ?? []).some(q => q?.about === a)) out.push(`$.questions: the ledger asks about ${a}: carry its question on the cards`);
  return out;
}
