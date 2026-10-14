// The pitch and the spec, held to the ledger and the foundation. The pitch never narrows: every card keeps every line
// the creator did not cut, a line the kit lacks is built (spec.build, named in the card's v1.build), and v1.notYet holds
// only what the creator's own words cut. The runtime and the loop are the foundation's; a card varies how it plays
// and, since a kind never changes play, how it looks.
//
// Pure: checkPitch(pitch, ctx) and checkSpec(spec, ctx) → ['$.cards[0].spec.build: …'].
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { liveRows, WHERE } from './ledger.mjs';
import { parseBy, provenOn } from './registry.mjs';
import { HOW_BUILD, LONGER, NARROWING, list, names } from './words.mjs';

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
  for (const k of ['runtime', 'profile', 'loop']) if ((spec[k] ?? null) !== (foundation[k] ?? null)) out.push(`${at}.${k}: "${foundation[k]}", the foundation's (${k === 'loop' ? foundation.why.loop : foundation.why.runtime}); a change of ${k} goes through the ledger and the foundation`);
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
    const kept = !ref ? true : ref.type === 'mechanic' ? mech.has(ref.id) : ref.type === 'loop' ? spec.loop === ref.id || foundation.loopBuild?.wants === ref.id
      : ref.type === 'runtime' ? spec.runtime === ref.id : ref.type === 'kind' ? true : true;
    if (!kept) out.push(`${at}: the ledger line "${r.id}" (${r.what}) is done by ${r.by}, and this spec ${ref.type === 'mechanic' ? `has no mechanic "${ref.id}"` : `is not on ${ref.type} "${ref.id}"`}: keep it`);
  }
  if (foundation.loopBuild && !build.some(b => b?.row === foundation.loopBuild.row)) out.push(`${at}.build: who acts when (${foundation.loopBuild.wants}) is built on the ${foundation.loop} loop: a build line with row "${foundation.loopBuild.row}"`);
  // not yet: only what the person cut
  const cut = (ledger?.rows ?? []).filter(r => r.cut);
  for (const [i, n] of (spec.notInV1 ?? []).entries()) {
    if (!cut.some(r => names(n, r.what) || names(n, r.words ?? ''))) out.push(`${at}.notInV1[${i}]: "${n}" is not a line the person cut; nothing they asked for waits for a later version (a line the kit lacks is built: spec.build)`);
  }
  if (hostCheck) out.push(...(await hostCheck(spec)).map(p => `${at}: ${p}`));
  return out;
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
    const said = (c?.v1?.build ?? []).join(' | ');
    for (const b of c?.spec?.build ?? []) if (b?.what && !names(said, b.what)) out.push(`${at}.v1.build: "${b.what}" is built new for this game: name it in the card's v1.build in plain words`);
    const cut = (ledger?.rows ?? []).filter(r => r.cut);
    for (const n of c?.v1?.notYet ?? []) if (!cut.some(r => names(n, r.what) || names(n, r.words ?? ''))) out.push(`${at}.v1.notYet: "${n}" is not something the person cut: keep it in the card (built new when the kit lacks it)`);
  }
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
