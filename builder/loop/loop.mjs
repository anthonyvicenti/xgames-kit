// The creation loop, once: every host (Studio's worker, a person's own agent session through the MCP tools, the dry
// run) opens it on a game and steps it. Each step runs, saves the state and says what comes next, so a tool can run
// one step and stop, and a run that was killed picks up where it was (the ladder too).
//
//   ledger → foundation → pitch → spec → create → build → fix → [economy] → [backend] → verify → playtest → read → deliver
//   a part check, verify or the play-test fails → repair (the stop rule: same set again, or an earlier set back → climb the ladder:
//   stronger model → specialist rounds → paid generation → ask) → fix → verify …
//   a change request or the creator's answer → ledger (amended) → foundation (a runtime change waits for a yes) → spec …
//
// The library never starts an agent and never calls a model. A host passes runners (`agent`, `playtester`); with none,
// each round is handed over: step() answers {waiting, message}, and the next step(input) takes the round's result.
import { chooseFoundation, foundationSummary, rehomeLedger, resolveProbes } from './foundation.mjs';
import { applyAnswers, checkAmend, checkLedger, ledgerOutputSchema, sourcesOf } from './ledger.mjs';
import { checkPitch, checkSpec, friendsShapeOf, PITCH_OUTPUT, PITCH_VERSION } from './pitch.mjs';
import { classifyChange, checkChangeSpec } from './change.mjs';
import { creatorSummary, holdPromises, ledgerVerdict, notYetWords, outcomeOf, promisesDoc, promisesOf, settlePromises } from './promises.mjs';
import { failingSet, ladderRecordOf, newLadder, nextRound, observe, resetLadder, SAY, sayKeyOf } from './ladder.mjs';
import { focusOf, mergeAnswers, playtestBrief, readReport, runsOf, seenAsNeeded, twoSeats } from './playtest.mjs';
import { composeBrief, manifestsOf } from './brief.mjs';
import { READER_TRIES, readerBrief, readerBundle, readerOutcome, readReading, withMarks } from './reader.mjs';
import { applyPartAnswers, backendAtDelivery, checkPart, checkPartsPitch, checkPartsSpec, economyAtDelivery, partAnswerKeys, partStepsOf, PART_IDS } from './parts.mjs';
import { checkRegistry, rid } from './registry.mjs';
import { liveRows } from './ledger.mjs';
import { memoryStore, newState, proofOf, sha } from './state.mjs';
import { STEPS, actionOf, toolOf } from './order.mjs';
import * as M from './messages.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const flat = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** The look's measure (builder/tools/lib/look-check.mjs, gate F): tuned before a look repair. */
export const LOOK_MEASURE = 23;

/**
 * host:
 *   registry             the registry (registry.mjs lists its calls)
 *   game                 the game's folder (tools read it)
 *   store                {load, save}: the state; default in memory. A host whose builder can write the file passes a sealed store
 *   tools                {create(spec, {game, kind}) → {ok, why}, fix(game) → {repairs}, verify(game, {n}) → verdict,
 *                         hash(game) → string, checkSpec?(spec) → problems, ownFiles?(game) → [paths]}
 *                        a verdict (builder/gates/verdict.schema.json): {pass, gates: {A..F: {ran, passed, skipped: [], failed?, ok}},
 *                        failed: [{gate, measure, area?, detail, rule, fix}]}; a gate ran when ran.length > 0
 *   versions             {keep(name), restore(name), has(name)}: 'created' and 'verified'
 *   agent(o)             the runner, o = {step, kind, message, model, strong, area?, areas?} → the round's result
 *                        ({ledger} | {probes} | {pitch} | {spec} | {summary, controls} | {questions} | {gaveUp, questions?});
 *                        absent: every round is handed over
 *   playtester(o)        o = {message, focus, model} → the report; absent: handed over
 *   reader(o)            the second reader, o = {message, bundle, model} → the reading (reader.mjs); absent: handed over
 *   parts                {economy?, backend?}: the optional parts this host offers (parts.mjs), each an adapter
 *                        {check(game) → {ok, problems: [{code, message, fix}], warnings}, publish?(game), status?(game)};
 *                        a part left out is off, and a pitch or spec that names it is refused with the reason
 *   limits               {model, strong, playtestModel, readerModel}: the model names a runner is given
 *   tools.captures?(game) → [{file, what}]: the play-tester's screenshots, for the second reader
 *   tools.tuneLook?(game, {n}) → builder/look/tune.mjs's record ({score: {before, after, bar}, wrote, ladder}): the look's
 *                        cheap levers, run when only the look (measure 23) failed, before any look repair
 *   tools.playRun?(game, name) → a gamesfun_play run's record (play.json) or null: what proves a friends promise was
 *                        seen with two player-driven seats (playtest.mjs twoSeats); without it none is proven
 *   hooks                {cards(pitch), ask(questions), migration(m), deliver(outcome)}: what only the host shows
 *   toolNames, reportHow the host's words in the messages
 *   flags                {playtest: false} turns the play-tester off, {reader: false} the second reader (the delivery says so)
 *   session              the agent session driving this run (a stop guard holds that session; kept in the state)
 *   clock, log
 * → {state, next(), step(input), run(), change(request), answer(words), cancel(why), proof()}
 */
/**
 * The person's references as the ledger carries them into the pitch: an image by its sha256 (never its local path), a
 * page by its URL, a game by its name. → [{sha256?, url?, name?, note?}]
 */
export async function referencesOf(refs = []) {
  const out = [];
  for (const r of refs ?? []) {
    const note = r.caption ?? r.note ?? null;
    let sha = /^[0-9a-f]{64}$/.test(r.sha256 ?? '') ? r.sha256 : null;
    if (!sha && r.file) { try { sha = createHash('sha256').update(await readFile(r.file)).digest('hex'); } catch { /* gone: by its words only */ } }
    const one = { ...(sha ? { sha256: sha } : {}), ...(/^https?:\/\//.test(r.url ?? '') ? { url: String(r.url).slice(0, 400) } : {}), ...(r.name ? { name: String(r.name).slice(0, 120) } : {}), ...(note ? { note: String(note).replace(/\/[^\s]+/g, '').trim().slice(0, 200) } : {}) };
    if (Object.keys(one).length) out.push(one);
  }
  return out.slice(0, 40);
}

/** The look the build brief carries: the target and the option the person (or the judge) picked. */
export function lookOfState(S) {
  if (!S.look?.target) return null;
  const o = S.look.options?.find(x => x.id === S.look.pick?.option) ?? null;
  return { target: S.look.target, ...(o ? { option: { id: o.id, title: o.title, reading: o.reading, by: S.look.pick.by, ...(S.look.pick.words ? { words: S.look.pick.words } : {}), ...(o.world ? { world: o.world.template } : {}), ...(o.camera ? { camera: o.camera } : {}) } } : {}) };
}

export async function openLoop(host) {
  const registry = checkRegistry(host.registry);
  const store = host.store ?? memoryStore();
  const tools = host.tools, versions = host.versions ?? { keep: async () => {}, restore: async () => {}, has: async () => false };
  const hooks = host.hooks ?? {}, flags = host.flags ?? {}, log = host.log ?? (() => {}), say = host.say ?? (() => {});
  const lim = { model: null, strong: 'opus', playtestModel: 'sonnet', readerModel: 'opus', ...host.limits };
  const parts = Object.fromEntries(Object.entries(host.parts ?? {}).filter(([k, v]) => PART_IDS.includes(k) && v));
  const partsOn = Object.keys(parts);
  const extraAsks = host.extraAsks ?? partsOn;
  const allWords = () => sourcesOf(S).join('\n');
  const clock = host.clock ?? { now: () => Date.now() };
  const stamp = () => new Date(clock.now()).toISOString();
  const S = (await store.load()) ?? newState(host.kind ?? 'build');
  S.answers ??= [];
  S.models = { model: lim.model, strong: lim.strong };
  if (host.session) S.session = String(host.session);
  const hash = () => tools.hash(host.game);
  const save = async () => { S.updated = stamp(); await store.save(S); };
  const go = (next, why, more = {}) => ({ next, why, ...more });
  const lockedSpec = () => (S.lock ? JSON.parse(S.lock.spec.text) : null);
  const catalog = async () => ({ vocab: await registry.vocabulary(), acts: (await registry.loops()).filter(l => l.status?.open), kinds: await registry.kinds(), capabilities: await registry.capabilities(), mechanics: await registry.mechanics() });
  const refuse = (code, why) => { S.refusals = [...S.refusals, { code, step: S.step, at: stamp(), why }].slice(-30); return { refused: code, why }; };
  const words = { toolNames: host.toolNames };

  // ---- rounds: a runner's, or handed over once and taken back with the next step(input)
  const round = async (o, input) => {
    const model = o.strong ? lim.strong : lim.model;
    if (host.agent) {
      // a talk round handed back: the runner gets the problems and its own last answer, never the first message again
      // (found by the real builds: a runner's ledger round was asked blind, 8 or 9 times)
      const again = S.talk.again?.step === S.step && S.talk.again.kind === o.kind ? S.talk.again.message : null;
      S.talk.again = null;
      return { got: (await host.agent({ step: S.step, model, ...o, ...(again ? { message: again, again: true } : {}) })) ?? {} };
    }
    // the round's result: after the hand-over, or straight away when the session already has it (a spec the person chose)
    if (input && Object.keys(input).length && (!S.handed || S.handed.step === S.step)) { S.handed = null; return { got: input }; }
    S.handed = { step: S.step, kind: o.kind, at: stamp(), model, message: o.message, ...(o.area ? { area: o.area } : {}) };
    return { waiting: { waiting: 'agent', kind: o.kind, message: o.message, model, ...(o.area ? { area: o.area } : {}) } };
  };
  // A talk round whose answer is not valid: handed back with the problems. The same problems twice: the stronger
  // model; a third time: the person is asked (cost never ends it, the person can).
  const kindOfTalk = step => (step === 'ledger' ? (S.change && !S.change.ledger ? 'amend' : 'ledger') : step);
  const talkTrouble = (step, problems, rehand) => {
    const key = problems.slice().sort().join('\n');
    const sets = S.talk.sets;
    const again = sets.length && sets.at(-1).step === step && sets.at(-1).key === key;
    sets.push({ step, key, n: problems.length });
    if (again && !S.talk.strong) { S.talk.strong = true; S.history.push({ step, ladder: 'model', why: 'the same problems twice: the stronger model', at: stamp() }); }
    else if (again && S.talk.strong) {
      S.questions = { message: `I could not write a valid ${step} for this idea: ${problems.slice(0, 2).join('; ')}`, questions: [{ id: 'help', text: 'What should I change?', options: [{ id: 'simpler', label: 'Make it simpler' }, { id: 'explain', label: 'I will explain more' }], default: 'explain' }] };
      return go('ask', `the ${step} failed the same way on the stronger model: the person is asked`);
    }
    S.handed = host.agent ? null : { step, kind: 'repair', at: stamp(), message: rehand(problems) };
    if (host.agent) S.talk.again = { step, kind: kindOfTalk(step), message: rehand(problems) };
    return host.agent ? go(step, `the ${step} is not valid yet: ${problems.length} problem(s)`, { problems })
      : { waiting: 'agent', kind: 'repair', message: S.handed.message, problems };
  };

  // ---- the ladder, after every verify or play-test that fails
  const stuck = (items, after) => {
    const obs = observe(S.ladder ?? newLadder(), items, { after, at: stamp(), unchanged: !!S.lastRound?.unchanged, round: S.round });
    S.ladder = obs.ladder;
    for (const r of obs.climbed) { S.history.push({ step: S.step, ladder: r, why: `${obs.stop}: ${items.length} failing`, at: stamp() }); log(`  ladder: ${obs.stop} → ${r}`); }
    return obs;
  };

  const steps = {
    async ledger(input = {}) {
      if (!S.prompt && S.kind === 'build') {
        if (!input.idea) return refuse('no-idea', 'the ledger starts from the person\'s idea: pass `idea` (their words)');
        S.prompt = String(input.idea); S.references = input.references ?? [];
      }
      const amend = S.change && !S.change.ledger ? { why: S.change.why, words: S.change.words } : null;
      const cat = await catalog(), before = amend ? S.change.draft ?? S.ledger : null;
      const message = M.ledgerMessage({ prompt: S.prompt, references: S.references, amend, before, catalog: cat, problems: S.ledgerProblems ?? [], ...words });
      const r = await round({ kind: amend ? 'amend' : 'ledger', message, strong: S.talk.strong, schema: ledgerOutputSchema(cat, { extraAsks }) }, input.ledger ? { ledger: input.ledger } : null);
      if (r.waiting) return r.waiting;
      const L = r.got.ledger;
      const opts = { sources: sourcesOf(S), registry, extraAsks };
      const problems = amend ? await checkAmend(S.ledger, L, opts) : await checkLedger(L, opts);
      // a round handed back gets its own answer with the problems, so it fixes them instead of writing a new ledger
      if (problems.length) return talkTrouble('ledger', problems, p => M.ledgerMessage({ prompt: S.prompt, references: S.references, amend, before, catalog: cat, problems: p, previous: L, ...words }));
      S.talk = { sets: [], strong: S.talk.strong }; S.ledgerProblems = null;
      if (amend) S.change.ledger = { schema: 'gf-ledger/1', ...L };
      else { const refs = await referencesOf(S.references); S.ledger = { schema: 'gf-ledger/1', prompt: S.prompt, ...L, ...(refs.length ? { references: refs } : {}) }; }
      return go('foundation', amend ? 'the ledger is amended: what the change touches is worked out next' : 'the ledger holds the essentials: the foundation is chosen from it');
    },

    async foundation(input = {}) {
      const changing = !!S.change;
      let L = changing ? S.change.ledger : S.ledger;
      if (input.approve && S.waiting?.about === 'migration') {
        S.change.approved = { words: String(input.approve), at: stamp() }; S.answers.push(String(input.approve));
        S.status = 'building'; S.waiting = null;
      }
      // the person said no to the migration: the game keeps its runtime, and their words go back to the ledger, which
      // is amended so the change fits the runtime it is on (the foundation then keeps it: `current`)
      if (input.decline && S.waiting?.about === 'migration') {
        const m = S.change.migration, said = String(input.decline);
        S.answers.push(said);
        S.change.declined = [...(S.change.declined ?? []), { words: said, from: m.from, to: m.to, at: stamp() }];
        S.change.migration = null; S.status = 'building'; S.waiting = null; S.handed = null;
        S.change.draft = S.change.ledger; S.change.ledger = null;
        S.ledgerProblems = [`the person said no to moving the game from ${m.from} to ${m.to} ("${said}"): it stays on ${m.from}. Amend the lines that asked for what only ${m.to} has (their devices, graphics or camera) so the change fits ${m.from}, quoting their words; what ${m.from} lacks is a build line`];
        return go('ledger', `the person declined the migration to ${m.to}: the game stays on ${m.from}, and the ledger is amended with their words`);
      }
      if (input.probes) {
        const r = resolveProbes(L, input.probes);
        if (r.problems.length) return { ...refuse('probes', r.problems.join('; ')), waiting: 'agent', message: M.probeMessage({ probes: (await chooseFoundation(L, registry)).probes, ...words }) };
        L = r.ledger; if (changing) S.change.ledger = L; else S.ledger = L;
        S.handed = null;
      }
      if (S.waiting?.about === 'migration') return { waiting: 'creator', about: 'migration', migration: S.change.migration, why: 'the migration waits for the person\'s yes' };
      const c = changing ? await classifyChange({ before: { ledger: S.ledger, foundation: S.foundation, spec: lockedSpec() }, ledger: L, registry, ownFiles: (await tools.ownFiles?.(host.game)) ?? [] }) : null;
      const f = changing ? c.foundation : await chooseFoundation(L, registry);
      if (f.probes?.length) {
        const r = await round({ kind: 'probe', message: M.probeMessage({ probes: f.probes, ...words }) }, null);
        if (r.waiting) return r.waiting;
        return steps.foundation({ probes: r.got.probes });
      }
      if (!f.ok) {
        // the ledger is what has to change: back to it, with the problems
        if (changing) { S.change.draft = S.change.ledger; S.change.ledger = null; }
        S.handed = null; S.ledgerProblems = f.problems;
        return go('ledger', `the foundation needs the ledger changed: ${f.problems.join('; ')}`, { problems: f.problems });
      }
      if (changing && c.class === 'runtime' && !S.change.approved) {
        S.change.migration = c.migration; S.status = 'waiting-on-creator'; S.waiting = { about: 'migration' };
        await hooks.migration?.(c.migration);
        return { waiting: 'creator', about: 'migration', migration: c.migration, why: `this change needs another runtime (${c.migration.from} → ${c.migration.to}): the person sees what that means and says yes first` };
      }
      S.ledger = rehomeLedger(L, f);
      const was = S.foundation;
      S.foundation = f;
      if (changing) {
        Object.assign(S.change, { class: c.class, holds: c.holds, diff: { ...c.diff, abouts: [...c.diff.abouts] }, from: was ? rid(was.runtime, was.profile) : null, to: rid(f.runtime, f.profile) });
        return go('spec', `a ${c.class} change: the spec round, holding ${c.holds.join(', ') || 'nothing'}`);
      }
      return go('pitch', `runtime ${rid(f.runtime, f.profile)}, loop ${f.loop}, kind ${f.kind}: the pitch round`);
    },

    async pitch(input = {}) {
      // the person chose a card (with answers to the ledger's questions), or said "build it" with a spec
      if (S.waiting?.about === 'cards') {
        if (!input.choice) return { waiting: 'creator', about: 'cards', pitch: S.pitch, why: 'the cards are with the person' };
        const card = S.pitch.cards.find(c => c.id === input.choice.card) ?? S.pitch.cards[0];
        const answers = input.choice.answers ?? {};
        if (input.choice.words) S.answers.push(String(input.choice.words));
        S.ledger = applyAnswers(S.ledger, answers, { words: input.choice.words ?? null });
        const said = String(input.choice.words ?? '').trim();
        S.choice = { card: card.id, answers, ...(said ? { words: said } : {}), at: stamp() };
        S.status = 'building'; S.waiting = null;
        // a part's question (an economy, a backend) is applied here, by code; the person decides it, never the build
        const decided = applyPartAnswers(card.spec, S.pitch, answers), partKeys = partAnswerKeys(S.pitch);
        if (Object.keys(decided.decided).length) S.parts = { ...(S.parts ?? {}), ...Object.fromEntries(Object.entries(decided.decided).map(([k, v]) => [k, { ...v, offer: S.pitch.offers?.[k] ?? null, at: stamp() }])) };
        // their other answers, or any words they typed when they chose, are applied by a spec round; a bare pick locks the card
        S.candidate = { spec: decided.spec, needsRound: Object.keys(answers).some(k => !partKeys.has(k)) || !!said };
        return go('spec', `the person chose "${card.title}"`);
      }
      const pitchSchema = { type: 'object', required: ['pitch'], properties: { pitch: PITCH_OUTPUT } };
      // the worlds this runtime and profile have (found by the PA11 runs: a board example on flat-2d named "field")
      const worlds = await worldsOf(S.foundation);
      const r = await round({ kind: 'pitch', message: M.pitchMessage({ ledger: S.ledger, foundation: S.foundation, parts: partsOn, worlds, ...words }), strong: S.talk.strong, schema: pitchSchema }, input.pitch || input.spec ? input : null);
      if (r.waiting) return r.waiting;
      if (r.got.spec) { S.candidate = { spec: r.got.spec, needsRound: false }; return go('spec', 'the person had already chosen: the spec is checked'); }
      const problems = [
        ...await checkPitch(r.got.pitch, { ledger: S.ledger, foundation: S.foundation, registry, hostCheck: tools.checkSpec ?? null, extraAsks }),
        ...checkPartsPitch(r.got.pitch, { on: partsOn, words: allWords() }),
      ];
      if (problems.length) return talkTrouble('pitch', problems, p => M.pitchMessage({ ledger: S.ledger, foundation: S.foundation, parts: partsOn, worlds, problems: p, previous: r.got.pitch, ...words }));
      S.talk = { sets: [], strong: S.talk.strong };
      // the pitch carries the whole ledger (gf-ledger/1, pitch.v2.schema.json) with the foundation it chose
      S.pitch = { pitchVersion: PITCH_VERSION, ...r.got.pitch, ledger: { ...S.ledger, foundation: foundationSummary(S.foundation) } }; S.status = 'waiting-on-creator'; S.waiting = { about: 'cards' };
      await hooks.cards?.(S.pitch);
      return { waiting: 'creator', about: 'cards', pitch: S.pitch, why: 'the cards are with the person: they choose one (and answer its questions)' };
    },

    async spec(input = {}) {
      const changing = !!S.change;
      let spec = S.candidate && !S.candidate.needsRound && !S.handed ? S.candidate.spec : null;
      if (!spec) {
        const base = changing ? lockedSpec() : S.candidate?.spec;
        const message = M.specMessage({ base, answers: S.choice?.answers && Object.keys(S.choice.answers).length ? S.choice.answers : null, words: changing ? null : S.choice?.words ?? null, change: changing ? { class: S.change.class, holds: S.change.holds, to: S.change.to } : null, ...words });
        const r = await round({ kind: 'spec', message, strong: S.talk.strong }, input.spec ? { spec: input.spec } : null);
        if (r.waiting) return r.waiting;
        spec = r.got.spec;
      }
      const problems = [
        ...await checkSpec(spec, { ledger: S.ledger, foundation: S.foundation, registry, hostCheck: tools.checkSpec ?? null }),
        ...(changing ? checkChangeSpec(S.change.class, lockedSpec(), spec) : []),
        ...checkPartsSpec(spec, { on: partsOn }),
      ];
      if (problems.length) { S.candidate = { spec, needsRound: true }; return talkTrouble('spec', problems, p => M.specMessage({ base: spec, change: changing ? { class: S.change.class, holds: S.change.holds, to: S.change.to } : null, problems: p, ...words })); }
      // the lock: the spec as agreed, and its promises. A change keeps every promise of a line that is still live.
      const text = JSON.stringify(spec, null, 2) + '\n';
      const promises = promisesOf({ spec, ledger: S.ledger, loopManifest: await registry.manifest('loop', spec.loop), friends: await friendsShapeOf(spec, registry) });
      const held = changing ? (S.lock?.promises ?? []).filter(p => p.kind !== 'build' && p.kind !== 'control' && (!p.row || S.ledger.rows.some(r => r.id === p.row && !r.cut))) : [];
      holdPromises(promises, held);
      S.lock = { at: stamp(), spec: { sha: sha(text), text }, promises };
      S.promises = promises; S.candidate = null; S.talk = { sets: [], strong: S.talk.strong };
      const migrate = changing && S.change.class === 'runtime';
      // a game that was never made (create failed and the person answered) is made first, whatever the change
      return go(!changing || migrate || !S.created ? 'create' : 'build', `the spec is locked with ${promises.length} promises (${promises.filter(p => p.kind === 'build').length} the build writes)`);
    },

    async create() {
      const spec = lockedSpec(), migrate = S.change?.class === 'runtime';
      const r = await tools.create(spec, { game: host.game, kind: migrate ? 'migrate' : 'build' });
      if (!r?.ok) {
        S.questions = { message: `The kit could not make this plan (${String(r?.why ?? 'create failed').slice(0, 200)}).`, questions: [{ id: 'go', text: 'How should I go on?', options: [{ id: 'retry', label: 'Try again' }, { id: 'change', label: 'I will change the plan' }], default: 'retry' }] };
        return go('ask', 'create could not make the plan: the person decides');
      }
      await versions.keep('created');
      S.created = { at: stamp(), runtime: spec.runtime, profile: spec.profile ?? null };
      // the round after a fresh make writes the whole game (a build round), also when the run started as an answer
      S.fresh = !migrate;
      // the look comes before the build when the host draws looks (builder/look); a migration keeps the look it has
      const look = !migrate && !!tools.lookOptions && flags.look !== false;
      return go(look ? 'look' : 'build', `the game was made on ${rid(spec.runtime, spec.profile)}: ${look ? 'the look, before the build round' : `the ${migrate ? 'migration' : 'build'} round`}`);
    },

    // The look before the build (builder/look): the style target (the spec's, or read now from the references and the
    // person's words: the measured half by the kit, the judged half by a round), then 2–3 readings of it drawn on the
    // game's own world and bodies; the person picks one (headless: the judge's best) and it goes into the game's look.
    // A host with no look tools, or a runtime the sheet cannot draw, goes on to the build and says so.
    async look(input = {}) {
      const spec = lockedSpec();
      if (S.waiting?.about === 'looks') {
        if (!input.pick) return { waiting: 'creator', about: 'looks', looks: S.look.options, why: 'the look options are with the person' };
        const o = S.look.options.find(x => x.id === (input.pick.option ?? input.pick)) ?? null;
        if (!o) return refuse('no-such-look', `pick one of ${S.look.options.map(x => x.id).join(', ')}`);
        const words = String(input.pick.words ?? '').trim();
        if (words) S.answers.push(words);
        const applied = await tools.applyLook?.(host.game, o, { spec });
        if (applied && applied.ok === false) return refuse('look-not-applied', applied.why ?? 'the look could not be applied');
        // a look with its own world and camera (builder/look/world.mjs) made the game again from its spec: that spec is locked
        if (applied?.spec) { const text = JSON.stringify(applied.spec, null, 2) + '\n'; S.lock = { ...S.lock, at: stamp(), spec: { sha: sha(text), text } }; }
        S.look.pick = { option: o.id, by: input.pick.by === 'judge' ? 'judge' : 'person', ...(words ? { words } : {}), at: stamp() };
        S.status = 'building'; S.waiting = null;
        return go('build', `the look "${o.title}" is in the game: the build round`);
      }
      if (!tools.lookOptions || flags.look === false) { S.look = { skipped: 'this host draws no look options' }; return go('build', 'no look step on this host: the kind and the spec decide the look'); }
      S.look ??= {};
      if (!S.look.target) {
        if (spec.look?.target) S.look.target = spec.look.target;
        else {
          const p = await tools.lookTarget(spec, { game: host.game, references: S.references ?? [], words: S.prompt ?? '' });
          if (p?.target) S.look.target = p.target;
          else if (p?.pending) {
            const r = await round({ kind: 'look', message: p.pending.message, schema: { type: 'object', required: ['judged'], properties: { judged: p.pending.schema } }, dirs: p.pending.dirs }, input.judged ? { judged: input.judged } : null);
            if (r.waiting) return { ...r.waiting, dirs: p.pending.dirs };
            const t = await tools.finishTarget(p.pending.base, r.got.judged ?? r.got);
            if (!t?.ok) return talkTrouble('look', t?.problems ?? ['no style target'], probs => `${p.pending.message}\n\nThe last answer was not a valid target: ${probs.join('; ')}`);
            S.look.target = t.target; S.talk = { sets: [], strong: S.talk.strong };
          } else { S.look = { skipped: p?.why ?? 'no style target' }; return go('build', `no look step: ${S.look.skipped}`); }
        }
      }
      const opts = await tools.lookOptions(spec, { game: host.game, target: S.look.target });
      const drawn = (opts ?? []).filter(o => o.ok);
      if (!drawn.length) { S.look.skipped = `the look options could not be drawn${opts?.[0]?.skipped ? ` (${opts[0].skipped})` : ''}`; return go('build', `${S.look.skipped}: the target stands as create mapped it`); }
      S.look.options = drawn.map(({ id, title, reading, values, levers, sheet, tiles, score, findings, calibration, world, camera, made }) => ({ id, title, reading, values, levers, sheet, tiles, score: score ?? null, findings: findings ?? [], ...(calibration ? { calibration } : {}), ...(world ? { world } : {}), ...(camera ? { camera } : {}), ...(made ? { made } : {}) }));
      S.look.at = stamp();
      S.status = 'waiting-on-creator'; S.waiting = { about: 'looks' };
      await hooks.looks?.(S.look.options);
      return { waiting: 'creator', about: 'looks', looks: S.look.options, why: `${drawn.length} looks on the game's own world: the person picks one (headless: the judge's best)` };
    },

    async build(input = {}) {
      const spec = lockedSpec(), kind = !S.change || S.fresh ? 'build' : S.change.class === 'runtime' ? 'migrate' : 'change';
      const message = composeBrief({ kind, spec, ledger: S.ledger, promises: S.promises, manifests: await manifestsOf(spec, registry), request: S.change?.words, change: S.change?.class, tools: host.toolNames, game: host.gameRef ?? host.game, offers: S.pitch?.offers ?? {}, look: lookOfState(S) });
      if (!S.handed) { S.before = await hash(); say(SAY.build, { rung: 'build', kind }); }
      const r = await round({ kind, message, strong: !!S.ladder?.strong }, input);
      if (r.waiting) return r.waiting;
      S.round++;
      if (r.got.gaveUp) { S.questions = r.got.questions ?? null; S.gaveUp = r.got.gaveUp; return go('ask', 'the build round could not start on this plan: the person is asked'); }
      S.delivery = { summary: r.got.summary ?? '', controls: r.got.controls ?? '' };
      S.lastRound = { kind, unchanged: false };
      S.rounds.push({ n: S.round, kind, model: S.handed?.model ?? null, at: stamp() });
      return go('fix', 'the round is over: the mechanical repairs');
    },

    async fix() {
      const r = await tools.fix?.(host.game) ?? { repairs: [] };
      if (r.repairs?.length) S.history.push({ step: 'fix', why: r.repairs.map(x => x.line).join('; ').slice(0, 300), at: stamp() });
      return go(checksFrom(), checksFrom() === 'verify' ? 'the six gates on the files as they are' : `the ${checksFrom()} check, then the six gates`);
    },

    async economy() { return partStep('economy'); },
    async backend() { return partStep('backend'); },

    async verify() {
      S.verifies++;
      const before = await hash();
      const v = await tools.verify(host.game, { n: S.verifies });
      const h = (await hash()) === before ? before : null;
      // the verdict (builder/gates/verdict.schema.json): `pass`, the gates by letter with what ran, passed and was skipped, and a flat `failed`
      S.verify = { n: S.verifies, ok: v.pass === true, hash: h, at: stamp(), gates: v.gates ?? {}, failed: v.failed ?? [] };
      if (S.verify.ok) { await versions.keep('verified'); S.kept = { n: S.verifies, hash: h }; }
      if (S.phase === 'recheck') { S.phase = null; return go('deliver', 'verified again: the version is settled'); }
      if (S.verify.ok) return flags.playtest === false ? go(readOr('deliver'), 'the six gates passed; play-testing is off here') : go('playtest', 'the six gates passed: the play-tester checks the promises');
      // the look before a look repair (builder/look/tune.mjs): when every functional measure passed and only the look
      // (measure 23) failed, the cheap levers are tuned first. Until the tune compares like with like per setting its
      // values are a suggestion (the host writes them beside the game, never into it): the repair brief carries them and
      // what the levers cannot reach (S.tune). When a host does apply them (wrote), verify runs again. Once per version.
      const lookOnly = (v.failed ?? []).length > 0 && v.failed.every(f => f.measure === LOOK_MEASURE);
      if (lookOnly && tools.tuneLook && S.tune?.from !== before) {
        const t = await tools.tuneLook(host.game, { n: S.verifies }).catch(e => ({ error: flat(e.message) }));
        S.tune = { from: before, at: stamp(), ...(t?.error ? { error: t.error } : { before: t?.score?.before ?? null, after: t?.score?.after ?? null, bar: t?.score?.bar ?? null, wrote: !!t?.wrote, ladder: t?.ladder ?? null, ...(t?.suggestion ? { suggestion: t.suggestion, values: t.values ?? null } : {}) }) };
        if (S.tune.wrote) return go('verify', `only the look failed: the levers were tuned (${S.tune.before} → ${S.tune.after} of ${S.tune.bar}); verify again`);
      }
      const obs = stuck(failingSet({ verdict: v }), 'verify');
      S.repairAfter = 'verify';
      return go('repair', obs.climbed.length ? `verify failed again the same way: the ladder climbs to ${obs.climbed.join(', ')}` : `verify failed on ${v.failed.length} measure(s): a repair round`);
    },

    async playtest(input = {}) {
      const prev = S.playtest?.answers ? S.playtest : null;
      if (!S.handed) {
        const focus = focusOf(S.promises, S.phase === 'late' ? null : prev);
        const message = playtestBrief({ promises: S.promises, controls: lockedSpec().controls ?? {}, focus, game: host.gameRef ?? host.game, round: S.playtests + 1, reportHow: host.reportHow ?? 'Call gamesfun_playtest_report with your report.' });
        const at = await hash();
        if (!host.playtester) { S.handed = { step: 'playtest', kind: 'playtest', at: stamp(), focus, hash: at, message, model: lim.playtestModel }; return { waiting: 'playtest', message, model: lim.playtestModel, focus }; }
        const report = await host.playtester({ message, focus, model: lim.playtestModel });
        return finishPlaytest(report, focus, at);
      }
      if (!input.report) return { waiting: 'playtest', message: S.handed.message, model: S.handed.model, focus: S.handed.focus };
      if ((await hash()) !== S.handed.hash) { S.handed = null; return { ...refuse('stale-playtest', 'the game\'s files changed while the play-tester had it: the report is about another version, so the play-test is handed over again'), next: 'playtest' }; }
      const { focus, hash: at } = S.handed;
      const done = await finishPlaytest(input.report, focus, at);
      return done;
    },

    async read(input = {}) {
      if (flags.reader === false) return go('deliver', 'the second reader is off on this host');
      if (!S.handed) {
        const at = await hash();
        const bundle = readerBundle(S, { captures: (await tools.captures?.(host.game)) ?? [] });
        const message = readerBrief({ bundle, game: host.gameRef ?? host.game, play: !!host.readerPlays, reportHow: host.readerHow ?? 'Call gamesfun_reader_report with your reading.' });
        if (!host.reader) {
          S.handed = S.readHanded = { step: 'read', kind: 'read', at: stamp(), hash: at, message, model: lim.readerModel };
          return { waiting: 'reader', message, model: lim.readerModel };
        }
        S.readHanded = { step: 'read', kind: 'read', at: stamp(), hash: at, message, model: lim.readerModel };
        let raw = null;
        try { raw = await host.reader({ message, bundle, model: lim.readerModel }); } catch (e) { raw = { error: String(e?.message ?? e) }; }
        const done = await finishReading(raw, at);
        // a runner whose reading was refused once reads again at once (a second refusal goes on without it)
        if (done.next === 'read' && done.refused) { S.handed = null; return steps.read({}); }
        return done;
      }
      if (!input.reading) return { waiting: 'reader', message: S.handed.message, model: S.handed.model };
      if ((await hash()) !== S.handed.hash) { S.handed = null; return { ...refuse('stale-reading', 'the game\'s files changed while the second reader had it: it reads again'), next: 'read' }; }
      return finishReading(input.reading, S.handed.hash);
    },

    async repair(input = {}) {
      if (!S.handed) {
        const n = nextRound(S.ladder);
        S.ladder = n.ladder; S.current = n.round;
        if (n.round.kind === 'ask') return go('ask', 'the top of the ladder: questions for the person');
        S.before = await hash();
        say(sayKeyOf(n.round, { after: repairAfter() === 'playtest' ? 'playtest' : 'verify', ladder: S.ladder }), { rung: S.ladder?.rung ?? 'repair', ...n.round });
      }
      const after = repairAfter();
      const message = M.repairMessage({ round: S.current, after, verify: S.verify, playtest: S.playtest, promises: S.promises, ladder: S.ladder, partsFailed: S.partsFailed ?? [], tune: S.tune ?? null, ...words });
      const r = await round({ kind: S.current.kind, message, strong: S.current.strong, ...(S.current.area ? { area: S.current.area } : {}), ...(S.current.areas ? { areas: S.current.areas, generate: true } : {}) }, input);
      if (r.waiting) return r.waiting;
      S.round++;
      const unchanged = (await hash()) === S.before;
      S.lastRound = { kind: S.current.kind, unchanged };
      S.rounds.push({ n: S.round, kind: S.current.kind, ...(S.current.area ? { area: S.current.area } : {}), strong: S.current.strong, unchanged, at: stamp(), ...(r.got.gaveUp ? { gaveUp: r.got.gaveUp } : {}) });
      if (r.got.summary) S.delivery = { summary: r.got.summary, controls: r.got.controls ?? S.delivery?.controls ?? '' };
      return go('fix', `${S.current.kind === 'repair' ? 'a repair' : `a ${S.current.kind}`} round is over${unchanged ? ' (it changed no file of the game)' : ''}: the mechanical repairs`);
    },

    async ask(input = {}) {
      if (S.waiting?.about === 'questions') {
        if (!input.answer) return { waiting: 'creator', about: 'questions', questions: S.questions, why: 'the questions are with the person' };
        S.status = 'building'; S.waiting = null;
        const a = input.answer;
        if (a.deliver && !S.created) {
          // nothing was made yet (the plan never locked, or create failed): there is no game to hand over, and the run
          // ends saying so; the person's next words start a change of what there is
          S.deliverAsIs = { words: a.words ?? null, at: stamp() };
          S.outcome = { outcome: 'not-made', notYet: 'No game was made: the plan could not be settled.', ledger: null, delivery: null, asIs: S.deliverAsIs };
          S.status = 'failed';
          await hooks.deliver?.(S.outcome);
          return go('done', 'the person asked for the game as it is, and no game was made yet');
        }
        if (a.deliver) { S.deliverAsIs = { words: a.words ?? null, at: stamp() }; return go('deliver', 'the person asked for the game as it is'); }
        return reenter('answer', String(a.words ?? ''));
      }
      if (!S.questions) {
        if (!S.handed) say(SAY.ask, { rung: 'ask' });
        const r = await round({ kind: 'ask', message: M.askMessage({ ladder: S.ladder, verify: S.verify, playtest: S.playtest, promises: S.promises ?? [], ...words }), strong: true }, input.questions ? { questions: input.questions } : null);
        if (r.waiting) return r.waiting;
        S.questions = r.got.questions ?? M.defaultQuestions({ verify: S.verify, playtest: S.playtest, promises: S.promises ?? [] });
      }
      S.status = 'waiting-on-creator'; S.waiting = { about: 'questions' };
      await hooks.ask?.(S.questions);
      return { waiting: 'creator', about: 'questions', questions: S.questions, why: 'the questions are with the person; their answer re-enters at the ledger' };
    },

    async deliver() {
      if (!S.verify) { S.phase = 'recheck'; return go(checksFrom(), 'nothing was verified yet: the checks and the six gates first'); }
      const p = proofOf(S, await hash());
      if (p.verify === 'stale') { S.phase = 'recheck'; return go(checksFrom(), 'the files changed after the last verify (stale proof): check and verify again', refuse('stale-verify', 'stale proof')); }
      if (!S.verify.ok && S.kept && !S.fellBack) {
        S.fellBack = true; await versions.restore('verified'); S.phase = 'recheck';
        return go(checksFrom(), 'the latest version fails a gate: the last version that passed comes back, checked and verified again');
      }
      if (p.playtest === 'stale' && S.verify.ok && flags.playtest !== false && !S.deliverAsIs) { S.phase = 'late'; return go('playtest', 'the files changed after the last play-test (stale proof): play-test again', refuse('stale-playtest', 'stale proof')); }
      // the second reader reads every version before it is handed over (advisory: whatever it says, delivery goes on)
      if (flags.reader !== false && !(S.reading && S.reading.hash === p.hash)) return go('read', 'a second reader reads the game against the person\'s words before it is handed over (advisory)');
      if (flags.reader === false) S.reading = { status: 'off', why: 'the second reader is off on this host', hash: p.hash, at: stamp() };
      const settled = settlePromises(S.promises, { verdict: S.verify, playtest: S.playtest });
      const lv = withMarks(ledgerVerdict(S.ledger, settled), S.reading?.status === 'read' ? S.reading : null);
      const ids = st => settled.filter(x => x.status === st).map(x => x.id);
      const stale = proofOf(S, await hash()).stale;
      const outcome = {
        outcome: outcomeOf({ verdictOk: S.verify.ok, ledger: lv, stale, fallback: S.fellBack ? 'verified' : null }),
        notYet: notYetWords(lv, S.ledger) || null,
        ledger: lv, promises: { proven: ids('proven'), failed: ids('failed'), untested: ids('untested') },
        gates: Object.fromEntries(Object.entries(S.verify.gates ?? {}).map(([g, x]) => [g, !x.ran?.length ? 'did not run' : x.ok ? `pass${x.skipped?.length ? ` (skipped ${x.skipped.map(s => s.measure).join(', ')})` : ''}` : 'fail'])),
        promiseLedger: promisesDoc({ specSha: S.lock.spec.sha, spec: lockedSpec(), settled }),
        ...(flags.playtest === false ? { playtest: 'off on this host' } : {}),
        // what the person reads first is the game in their terms (the ledger as delivered), never a round's own note
        summary: creatorSummary({ spec: lockedSpec(), ledger: S.ledger, lv }),
        ladder: S.ladder?.climbs ?? [], ladderRecord: ladderRecordOf(S), rounds: S.rounds.length,
        delivery: { summary: creatorSummary({ spec: lockedSpec(), ledger: S.ledger, lv }), controls: S.delivery?.controls ?? '', lastRound: S.delivery?.summary ?? null }, ...(S.deliverAsIs ? { asIs: S.deliverAsIs } : {}),
        reader: readerOutcome(S.reading, S.ledger),
      };
      // the parts the spec keeps: going live is the person's own approval, a backend is theirs to connect; neither waits
      const spec = lockedSpec();
      if (spec?.economy && parts.economy) outcome.economy = await economyAtDelivery(parts.economy, host.game, { clears: !!S.pitch?.offers?.economy?.clears });
      if (spec?.backend && parts.backend) outcome.backend = await backendAtDelivery(parts.backend, host.game, spec.backend);
      // the host hands the version over (an upload, a publish): until it says it did, the run is not delivered. A host
      // that answers {ok: false, why} or throws keeps the run at deliver, and the next deliver step tries again
      let handed = null;
      try { handed = await hooks.deliver?.(outcome); } catch (e) { handed = { ok: false, why: String(e?.message ?? e) }; }
      if (handed && handed.ok === false) {
        S.outcome = { ...outcome, handOver: { ok: false, why: String(handed.why ?? 'the host could not hand it over').slice(0, 600), at: stamp() } };
        return { ...refuse('delivery-failed', `the host could not hand the version over: ${S.outcome.handOver.why}`), next: 'deliver' };
      }
      S.outcome = outcome; S.status = 'delivered';
      return go('done', `${outcome.outcome}: ${lv.proven.length} line(s) proven, ${lv.failed.length} failed, ${lv.untested.length} untested`, { outcome });
    },
  };

  async function finishPlaytest(raw, focus, at) {
    const friends = focus.filter(id => S.promises.find(p => p.id === id)?.friends);
    let r = readReport(raw, focus, { friends });
    if (!r.ok && host.playtester && (S.badReports ?? 0) >= 1) {
      // A runner's tester gave no valid report twice in a row: what it answered validly stands, and every promise it
      // left out or answered wrongly counts as unreachable, so the ladder sees it (a runner is never asked forever).
      const note = `the play-tester gave no valid report twice: ${r.problems.slice(0, 2).join('; ')}`.slice(0, 600);
      r = { ...r, ok: true, answers: Object.fromEntries(focus.map(id => [id, r.answers[id] ?? { status: 'unreachable', evidence: [], note }])) };
      S.history.push({ step: 'playtest', why: note, at: stamp() });
    }
    if (!r.ok) {
      S.badReports = (S.badReports ?? 0) + 1;
      S.handed = host.playtester ? null : { ...S.handed, at: stamp() };
      return { ...refuse('bad-report', r.problems.join('; ')), next: 'playtest', problems: r.problems, ...(host.playtester ? {} : { waiting: 'playtest', message: S.handed.message }) };
    }
    S.badReports = 0;
    S.handed = null; S.playtests++;
    // a friends promise the tester saw: the run it rests on is read, and only two player-driven seats prove it
    for (const id of friends) {
      const a = r.answers[id];
      if (a?.status !== 'seen') continue;
      const checks = [];
      for (const run of runsOf(a)) checks.push({ run, ...twoSeats((await tools.playRun?.(host.game, run)) ?? null) });
      const good = checks.find(c => c.ok);
      Object.assign(a, good ? { two: true, twoRun: good.run } : { two: false, twoWhy: checks.length ? checks.map(c => `${c.run}: ${c.why}`).join('; ').slice(0, 400) : 'the answer names no run' });
    }
    const answers = mergeAnswers(S.phase === 'late' ? null : S.playtest, r);
    const promiseOf = id => S.promises.find(p => p.id === id);
    const open = focus.filter(id => !seenAsNeeded(promiseOf(id), r.answers[id]));
    const notTwo = open.filter(id => r.answers[id]?.status === 'seen');          // friends promises seen without two players
    const ok = open.length === 0;
    S.playtest = { round: S.playtests, ok, hash: at, at: stamp(), answers, focus, feel: r.feel, summary: r.summary };
    if (S.phase === 'late') { S.phase = null; }
    if (ok) return go(readOr('deliver'), 'the play-tester saw every promise it was asked about');
    if (notTwo.length === open.length) {
      // only friends promises are open, seen with bots or alone: the play-test is asked again once for those; after
      // that they stay untested (a tester's run, not the game, may be what is missing)
      if ((S.twoRetries ?? 0) < 1) { S.twoRetries = (S.twoRetries ?? 0) + 1; return go('playtest', `${notTwo.join(', ')} seen without two players: the play-test is asked again, with two player-driven seats`); }
      return go(readOr('deliver'), `${notTwo.join(', ')} still not seen with two players: they stay untested`);
    }
    const obs = stuck(failingSet({ playtest: { answers }, promises: S.promises }), 'playtest');
    S.repairAfter = 'playtest';
    return go('repair', obs.climbed.length ? `the play-test failed the same way again: the ladder climbs to ${obs.climbed.join(', ')}` : 'the play-tester could not see some promises: a repair round');
  }

  /** The world templates a runtime and profile have (registry.runtimes()[].worlds), or null when the registry does not say. */
  async function worldsOf(f) {
    // the registry's own runtimes, else the catalog it was built from (the kit's registry keeps worlds there)
    const rt = (await registry.runtimes()).find(r => r.id === f?.runtime && Array.isArray(r.worlds)) ?? registry.catalog?.runtimes?.find(r => r.id === f?.runtime);
    if (!Array.isArray(rt?.worlds)) return null;
    return rt.worlds.filter(w => !w.profiles || !f.profile || w.profiles.includes(f.profile)).map(w => ({ id: w.id, describe: w.describe ?? '' }));
  }

  /** The first check after a round: the part steps the locked spec keeps, then verify. */
  function checksFrom() { return partStepsOf(lockedSpec(), partsOn)[0] ?? 'verify'; }
  /** What a repair round answers: a failed part check, verify, or the play-test. */
  function repairAfter() { return S.repairAfter ?? (S.verify && !S.verify.ok ? 'verify' : 'playtest'); }
  /** The second reader comes before `then`, unless it is off here. */
  function readOr(then) { return flags.reader === false ? then : 'read'; }

  /** A part's check (parts.mjs): ok goes on to the next check; a failure is a failing set, repaired under the stop rule. */
  async function partStep(part) {
    const spec = lockedSpec(), steps = partStepsOf(spec, partsOn), next = steps[steps.indexOf(part) + 1] ?? 'verify';
    if (!steps.includes(part)) return go(next, `this game keeps no ${part}`);
    const r = await checkPart(part, parts[part], host.game);
    S.partChecks = { ...(S.partChecks ?? {}), [part]: { ok: r.ok, problems: r.problems, warnings: r.warnings, hash: await hash(), at: stamp() } };
    if (r.ok) { S.partsFailed = (S.partsFailed ?? []).filter(p => p.part !== part); return go(next, `the ${part} check passed${r.warnings.length ? ` (${r.warnings.length} warning(s) for the person)` : ''}`); }
    S.partsFailed = [...(S.partsFailed ?? []).filter(p => p.part !== part), ...r.problems];
    S.phase = null;
    const obs = stuck(failingSet({ parts: r.problems }), part);
    S.repairAfter = 'parts';
    return go('repair', obs.climbed.length ? `the ${part} check failed again the same way: the ladder climbs to ${obs.climbed.join(', ')}` : `the ${part} check refused ${r.problems.length} thing(s): a repair round`);
  }

  /** The second reader's reading, held to its shape. Advisory: a reader that gives none twice is said, never waited on. */
  async function finishReading(raw, at) {
    const ids = liveRows(S.ledger).map(r => r.id);
    const r = readReading(raw, ids);
    S.handed = null;
    if (!r.ok) {
      S.badReadings = (S.badReadings ?? 0) + 1;
      if (S.badReadings < READER_TRIES) {
        if (!host.reader) S.handed = { ...S.readHanded, problems: r.problems, at: stamp() };
        return { ...refuse('bad-reading', r.problems.join('; ')), next: 'read', problems: r.problems, ...(host.reader ? {} : { waiting: 'reader', message: S.readHanded.message }) };
      }
      S.reading = { status: 'unread', why: `the second reader gave no valid reading ${READER_TRIES} times: ${r.problems.slice(0, 2).join('; ')}`.slice(0, 600), hash: at, at: stamp(), rows: r.rows, findings: r.findings, summary: r.summary };
      S.badReadings = 0;
      return go('deliver', 'the second reader gave no valid reading: delivery goes on and says so');
    }
    S.badReadings = 0;
    S.reading = { schema: 'gf-reading/1', status: 'read', round: (S.reading?.round ?? 0) + 1, hash: at, at: stamp(), rows: r.rows, findings: r.findings, summary: r.summary };
    const lost = Object.values(r.rows).filter(x => x.mark !== 'kept').length;
    return go('deliver', `the second reader marked every line${lost ? ` (${lost} not kept: the delivery says which)` : ': all kept'}`);
  }

  /** A change request or an answer: back to the ledger, the ladder reset on the new plan, its history kept. */
  function reenter(why, text) {
    if (S.ladder) S.ladders.push(S.ladder);
    S.ladder = S.ladder ? resetLadder(S.ladder) : null;
    S.answers.push(text);
    S.change = { why, words: text, at: stamp(), ledger: null };
    S.questions = null; S.deliverAsIs = null; S.fellBack = false; S.handed = null; S.fresh = false; S.repairAfter = null; S.partsFailed = [];
    S.playtest = null;          // the next play-test asks every promise again: earlier answers were about other files
    S.twoRetries = 0;
    return go('ledger', why === 'answer' ? 'the person answered: their words re-enter at the ledger' : 'a change request re-enters at the ledger');
  }

  const loop = {
    state: S,
    next: () => ({ step: S.step, why: S.why, tool: toolOf(S.step), status: S.status }),
    proof: async () => proofOf(S, await hash()),
    /**
     * Run the step the state names. `expect`: the step the caller means to run (a tool's): another one is refused and
     * the right step named. → {ran, next, why, …} | {ran, waiting: 'agent' | 'playtest' | 'creator', …}
     */
    async step(input = {}, { expect = null } = {}) {
      if (S.step === 'done') return { ran: 'done', next: 'done', why: S.why, outcome: S.outcome };
      if (expect && ![].concat(expect).includes(S.step)) return { ran: null, refused: 'out-of-order', why: `the loop is at "${S.step}", so ${toolOf(S.step)} is next`, next: S.step };
      const ran = S.step;
      const r = await steps[ran](input);
      if (r.waiting) { await save(); return { ran, next: ran, ...r, action: actionOf({ waiting: r.waiting, kind: r.kind ?? null, about: r.about ?? null, step: ran }) }; }
      if (r.refused && !r.next) { await save(); return { ran, next: ran, ...r, ...(r.waiting ? { action: actionOf({ waiting: r.waiting, kind: r.kind ?? 'repair', step: ran }) } : {}) }; }
      S.step = r.next ?? ran; S.why = r.why ?? S.why;
      if (r.next === 'done' && S.status === 'building') S.status = 'delivered';
      S.history = [...S.history, { step: ran, next: S.step, why: S.why, at: stamp(), ...(r.refused ? { refused: r.refused } : {}) }].slice(-80);
      await save();
      return { ran, ...r };
    },
    /** Step until a round is handed over, the person is waited on, or the run is done. */
    async run(input = {}) {
      let r = await loop.step(input);
      // a failed hand-over by the host is the host's to retry (its next deliver step), never a loop of its own
      for (let n = 0; n < 500 && !r.waiting && r.next !== 'done' && r.refused !== 'delivery-failed' && !(r.refused && r.next === r.ran && r.ran === S.step && !host.agent); n++) r = await loop.step({});
      return r;
    },
    /** A change request on a game whose run is over (or waiting): it re-enters at the ledger. */
    async change(request) {
      if (S.status === 'building' && S.step !== 'done') return { refused: 'building', why: `a run is under way at "${S.step}": finish it first (${toolOf(S.step)})` };
      if (!S.lock) return { refused: 'no-game', why: 'nothing was locked yet: start with the ledger' };
      S.kind = 'change'; S.status = 'building'; S.waiting = null; S.outcome = null;
      const r = reenter('change', String(request));
      S.step = r.next; S.why = r.why;
      S.history.push({ step: 'change', next: 'ledger', why: r.why, at: stamp() });
      await save();
      return { ran: 'change', ...r };
    },
    async cancel(why = 'cancelled by the host') {
      if (S.step === 'done') return { refused: 'already-ended' };
      S.status = 'cancelled'; S.step = 'done'; S.why = why; S.outcome = { outcome: 'cancelled' }; S.handed = null;
      await save();
      return { ran: 'cancel', next: 'done', why };
    },
  };
  return loop;
}

export { STEPS };
