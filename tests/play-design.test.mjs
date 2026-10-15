// The gameplay layer's designer (builder/play/design.mjs) and its step in the loop: the play target's schema and checks,
// the designer's brief, the spec with its play, the promises of play, the play pitch (cards that differ in play, a card
// on another loop the person left open), and the design step between the look and the build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTarget, designMessage, finish, partsOf, PLAY_OUTPUT, playPromises, withPlay, design } from '../builder/play/design.mjs';
import { openLoop, fileStore, stateFileOf, checkPitch, chooseFoundation, composeBrief, promisesOf, messages } from '../builder/loop/index.mjs';
import { loadSchemas, SCHEMA } from '../registry/schemas.mjs';
import { fakeBindings, scriptedVerify } from './loop/dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, pitchV2, playOf, PROMPT, GATE_PLAY, CARD_WORDS } from './loop/fixtures/registry.mjs';
import { TAG_PLAY, TAG_PLAY_ANSWER, tagSpec } from './loop/fixtures/tag.mjs';

const reg = fakeRegistry();
const { validate } = await loadSchemas();
const v = t => validate(SCHEMA.playTarget, t);
const EXAMPLES = new URL('../builder/spec/examples/play-target/', import.meta.url);

test('the play target schema: the examples hold, and the spec and the pitch carry it', async () => {
  const files = (await readdir(EXAMPLES)).filter(f => f.endsWith('.json')).sort();
  assert.ok(files.some(f => f.startsWith('valid-')) && files.some(f => f.startsWith('invalid-')));
  for (const f of files) {
    const t = JSON.parse(await readFile(new URL(f, EXAMPLES), 'utf8'));
    const problems = v(t);
    if (f.startsWith('valid-')) assert.deepEqual(problems, [], f); else assert.ok(problems.length, `${f} should fail`);
  }
  assert.deepEqual(v(TAG_PLAY), []);
  assert.deepEqual(v(GATE_PLAY), []);
  assert.deepEqual(validate(SCHEMA.spec, { ...tagSpec(), play: { sketch: playOf(0), target: TAG_PLAY } }).filter(p => p.startsWith('/play')), [], 'spec v2 carries play {sketch, target}');
  assert.ok(validate(SCHEMA.spec, { ...tagSpec(), play: { target: { schema: 'gf-play-target/1' } } }).some(p => p.startsWith('/play/target')), 'a target in a spec is held to its schema');
  // the designer's output shape is the target's, less what finish adds
  for (const k of ['schema', 'from', 'confidence', 'sources']) assert.ok(!(k in PLAY_OUTPUT.properties), k);
  assert.ok(!JSON.stringify(PLAY_OUTPUT).includes('$ref'), 'the round\'s schema needs no other file');
});

test('checkTarget: an idle and a reach guard always, a leader guard and a touchpoint when players compete, numbers that fit, real parts', async () => {
  const spec = { ...tagSpec(), ledger: { rows: [{ id: 'tag' }] } };
  assert.deepEqual(await checkTarget(TAG_PLAY, { spec, registry: reg, validate: v }), []);
  const bad = structuredClone(TAG_PLAY);
  bad.avoid = bad.avoid.filter(a => a.failure === 'unreachable');
  bad.touchpoints = [];
  bad.pacing = { ...bad.pacing, firstAction: 120, roundSeconds: 90, comeback: 0 };
  bad.mechanics = [{ id: 'jetpack', why: 'fly' }];
  bad.events = bad.events.map(e => ({ ...e, meaningful: false }));
  const p = (await checkTarget(bad, { spec, registry: reg, validate: v })).join('\n');
  assert.match(p, /a guard against "idle"/);
  assert.match(p, /"runaway-leader"/);
  assert.match(p, /touchpoints: friends play together/);
  assert.match(p, /firstAction/);
  assert.match(p, /comeback/);
  assert.match(p, /no mechanic "jetpack".*build line/);
  assert.match(p, /keep the plan's "tag"/);
  assert.match(p, /at least one meaningful event/);
  const knocks = { ...TAG_PLAY, touchpoints: [{ how: 'a blast flings them', kind: 'knock', often: 'every turn' }] };
  assert.match((await checkTarget(knocks, { spec })).join(), /pacing\.downMax: players knock each other down/);
  assert.deepEqual((await checkTarget({ ...knocks, pacing: { ...knocks.pacing, downMax: 6, out: 'round' } }, { spec, validate: v })), []);
  assert.match(composeBrief({ spec: { ...tagSpec(), play: { target: { ...knocks, pacing: { ...knocks.pacing, downMax: 6, out: 'round' } } } }, ledger: { rows: [] }, promises: [], manifests: { runtime: null, loop: null, mechanics: [], kind: null, packs: [] } }), /knocked down: a player is back in control within 6 s of a knock .*knocked out of play: out until the round ends/);
  // a reference game the person named never appears in the target
  const named = { ...spec, references: [{ name: 'Mega Lobber' }] };
  assert.match((await checkTarget({ ...TAG_PLAY, genre: { name: 'Mega Lobber style', traits: ['a', 'bb'] } }, { spec: named })).join(), /names "Mega Lobber"/);
});

test('withPlay: mechanics kept and tuned, new ones and build lines joined, rules.params tuned, the sketch kept', () => {
  const spec = { ...tagSpec(), play: { sketch: playOf(0) } };
  const target = { ...TAG_PLAY, mechanics: [{ id: 'tag', params: { tagCooldown: 2 }, why: 'x' }, { id: 'shove', as: 'push', params: { force: 4 }, why: 'y' }], build: [{ what: 'a dive tag', how: 'rules: a lunge on primary', where: 'rules', why: 'reach' }], params: { diveSeconds: 0.4 } };
  const s = withPlay(spec, target, { rowOf: () => 'tag' });
  assert.deepEqual(s.mechanics.map(m => m.id), ['tag', 'shove']);
  assert.deepEqual(s.mechanics[0].params, { tagCooldown: 2 });
  assert.equal(s.build.at(-1).row, 'tag');
  assert.equal(s.build.length, spec.build.length + 1);
  assert.equal(s.rules.params.diveSeconds, 0.4);
  assert.deepEqual(s.play.sketch, playOf(0));
  assert.equal(s.play.target, target);
  assert.equal(withPlay(s, target).build.length, s.build.length, 'a build line is never added twice');
});

test('the promises of play: one per line of what makes it play, core, proven only on the tester\'s screen', async () => {
  const ps = playPromises(TAG_PLAY);
  assert.deepEqual(ps.map(p => p.id), ['play.1', 'play.2', 'play.3']);
  assert.ok(ps.every(p => p.kind === 'play' && p.core && p.confirm && p.area === 'play' && p.proofs.join() === 'play'));
  assert.match(ps[0].text, /You see it when: the it marker jumps/);
  const all = promisesOf({ spec: tagSpec(), ledger: { rows: [] } });
  assert.ok(all.some(p => p.id === 'play.2'));
  const doc = { schema: 'gf-promises/1', spec: 'a'.repeat(64), runtime: 'three', promises: all };
  assert.deepEqual(validate(SCHEMA.promises, doc), []);
});

test('the designer\'s brief: the person\'s words, the ledger, the world, the parts with their params, the references, genre reasoning', async () => {
  const spec = { ...tagSpec(), play: { sketch: playOf(1) }, world: { template: 'terrain', params: { shape: 'islands', sea: { size: 1800 }, islands: { count: 3 } } } };
  const parts = await partsOf(spec, reg);
  assert.equal(parts.mechanics[0].id, 'tag', 'the plan\'s mechanics first');
  assert.ok(parts.mechanics.every(m => m.id !== 'waves' || true));
  const m = designMessage({ spec, ledger: { rows: [{ id: 'tag', about: 'action', what: 'Tag another player', words: 'tag', home: 'exists', by: 'mechanic:tag', core: true }] }, refs: [{ file: '/refs/a.jpg', kind: 'frame', frame: 'gameplay' }], parts });
  assert.match(m, /a game of tag in a backyard/);
  assert.match(m, /- tag \[action, core\] "tag" → Tag another player/);
  assert.match(m, /Name the genre their words point to/);
  assert.match(m, /surrounded by sea \(water a body can fall into\)/);
  assert.match(m, /3 islands/);
  assert.match(m, /plays as: a scramble on the walls/);
  assert.match(m, /### \* tag: roles that pass on contact/);
  assert.match(m, /\/refs\/a\.jpg \(gameplay\)/);
  assert.match(m, /Never narrow the idea/);
  assert.doesNotMatch(m, /Your last answer was not valid/);
  assert.match(designMessage({ spec, problems: ['x is wrong'], previous: { a: 1 } }), /Your last answer was not valid[\s\S]*x is wrong[\s\S]*"a":1/);
});

test('design(): a spec\'s own target is taken; else a designer answers, and with none the session is handed the brief', async () => {
  const given = await design(tagSpec(), null, [], { registry: reg, validate: v });
  assert.equal(given.given, true);
  const { play, ...bare } = tagSpec();
  const pending = await design(bare, null, [], { registry: reg });
  assert.ok(pending.pending.message.includes('## The target (every field)'));
  const r = await design(bare, null, [], { registry: reg, validate: v, designer: async () => ({ target: TAG_PLAY_ANSWER, model: 'fake-opus' }) });
  assert.deepEqual(r.problems, []);
  assert.equal(r.target.from, 'words');
  assert.equal(r.target.sources.model, 'fake-opus');
  assert.deepEqual(finish({ refs: 4, words: true }, TAG_PLAY_ANSWER).from, 'refs+words');
});

// ---- the loop's design step
const BARE = (() => { const { play, ...s } = { specVersion: 2, play: null, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate', hook: 'Hold it.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] }; return s; })();
const cards = (styles = [0, 1]) => pitchV2({ reply: 'Card 1 holds the gate. A grappling hook that pulls you onto the walls is built new, which makes the build take longer.', cards: styles.map((st, i) => ({ id: 'ab'[i], title: 'ab'[i], play: playOf(st), v1: { has: ['waves at the gate'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: BARE })), questions: [] });
const { schema: _s, from: _f, confidence: _c, sources: _src, ...GATE_ANSWER } = GATE_PLAY;

async function host(t) {
  const root = await mkdtemp(join(tmpdir(), 'gf-play-design-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'games', 'g');
  await mkdir(game, { recursive: true });
  const B = fakeBindings({ registry: reg, root, verify: scriptedVerify([]).verify });
  const G = { game, arg: 'games/g' };
  const made = [];
  const tools = { ...B.tools(G), create: async (spec, o) => { made.push(spec); return B.tools(G).create(spec, o); } };
  const L = await openLoop({ registry: reg, game, store: fileStore(stateFileOf(game)), tools, versions: B.versions(G) });
  return { L, made, game };
}

test('the design step: after create, a designer round on the stronger model; its answer joins the spec, the game is made again, the brief carries it', async t => {
  const { L, made } = await host(t);
  await L.step({ idea: PROMPT }); await L.step({ ledger: goodLedger() }); await L.step({});
  await L.step({ pitch: cards() }); await L.step({ choice: { card: 'b' } }); await L.step({});
  let r = await L.step({});
  assert.equal(r.next, 'design', 'create, then the play');
  assert.deepEqual(made.at(-1).play, { sketch: playOf(1) }, 'the chosen card\'s play is in the spec');
  r = await L.step({});
  assert.equal(r.waiting, 'agent');
  assert.equal(r.kind, 'design');
  assert.equal(r.model, 'opus', 'the stronger model designs');
  assert.deepEqual(r.action, { tool: 'gamesfun_step_design', args: { target: {} }, returns: 'target' });
  assert.match(r.message, /plays as: a scramble on the walls/);
  // an answer that drops a mechanic of the plan and lacks guards is handed back with its problems
  r = await L.step({ target: { ...GATE_ANSWER, mechanics: [{ id: 'waves', why: 'w' }], avoid: GATE_ANSWER.avoid.slice(0, 1) } });
  assert.equal(r.waiting, 'agent');
  assert.match(r.message, /keep the plan's "boss"/);
  assert.match(r.message, /a guard against "unreachable"/);
  r = await L.step({ target: { ...GATE_ANSWER, mechanics: [...GATE_ANSWER.mechanics, { id: 'shove', params: { force: 3 }, why: 'knock them off the wall' }], build: [{ what: 'zombies knocked off the wall fall and splat', how: 'a module in src/fall.js', where: 'module', why: 'the comedy' }] } });
  assert.equal(r.next, 'build', r.why);
  assert.match(r.why, /3 promise\(s\) of play, 1 thing\(s\) the build writes/);
  const spec = made.at(-1);
  assert.deepEqual(spec.mechanics.map(m => m.id), ['waves', 'boss', 'shove'], 'the game was made again with the play\'s mechanics');
  assert.equal(spec.play.target.genre.name, 'co-op wave defence');
  assert.deepEqual(spec.play.sketch, playOf(1));
  assert.equal(spec.build.at(-1).row, 'hold', 'a build line serves a ledger line');
  assert.deepEqual(L.state.promises.filter(p => p.kind === 'play').map(p => p.id), ['play.1', 'play.2', 'play.3']);
  assert.ok(L.state.promises.some(p => p.id === `build.${spec.build.length}`), 'the play\'s build line is a promise');
  assert.equal(JSON.parse(L.state.lock.spec.text).play.target.genre.name, 'co-op wave defence', 'the lock holds the spec with its play');
  r = await L.step({});
  assert.equal(r.kind, 'build');
  assert.match(r.message, /## The play \(designed before this round: write toward it\)/);
  assert.match(r.message, /ctx\.events\.count\(player, '<name>'/);
  assert.match(r.message, /1\. Every swing lands with weight/);
});

test('the play pitch: every card says how it plays, the cards differ in play, and a card may take a loop the person left open', async () => {
  const L0 = goodLedger();
  const f = await chooseFoundation(L0, reg);
  assert.deepEqual(f.loopChoices, [], 'the person said who acts when ("a boss at the end"): no other loop');
  const one = cards([0, 1]);
  let p = await checkPitch({ ...one, cards: one.cards.map(({ play, ...c }, i) => (i ? c : { ...c, play })) }, { ledger: L0, foundation: f, registry: reg });
  assert.ok(p.some(x => /cards\[1\]\.play: how this card plays/.test(x)));
  p = await checkPitch(cards([0, 0]), { ledger: L0, foundation: f, registry: reg });
  assert.ok(p.some(x => /differ in how they play/.test(x)));
  assert.deepEqual(await checkPitch(cards([0, 1]), { ledger: L0, foundation: f, registry: reg }), []);
  // the acts line not in the person's words: another open loop may play it
  const open = goodLedger(); open.rows.find(r => r.about === 'acts').words = null;
  const f2 = await chooseFoundation(open, reg);
  assert.ok(f2.loopChoices.includes('round') && !f2.loopChoices.includes('run'), f2.loopChoices.join());
  const other = pitchV2({ ...cards([0, 1]), cards: cards([0, 1]).cards.map((c, i) => (i ? { ...c, spec: { ...c.spec, loop: 'round' } } : c)) });
  assert.deepEqual(await checkPitch(other, { ledger: open, foundation: f2, registry: reg }), []);
  assert.ok((await checkPitch(other, { ledger: L0, foundation: f, registry: reg })).some(x => /\.loop: "run"/.test(x)), 'with the person\'s own words on it, the loop is theirs');
});

test('the repair after a play-test carries the lines of play it missed, the target\'s guards and the judge\'s findings', () => {
  const promises = playPromises(GATE_PLAY);
  const m = messages.repairMessage({ round: { kind: 'repair' }, after: 'playtest', playtest: { answers: { 'play.2': { status: 'not-seen', note: 'nobody climbed' } } }, promises, play: GATE_PLAY, playJudge: { score: 41, bar: 50, findings: [{ part: 'pacing', line: 'idle 40 s between waves', source: 'measured' }] } });
  assert.match(m, /## The play \(spec\.play\.target: co-op wave defence\)/);
  assert.match(m, /avoid idle: the next wave starts as the last breaks/);
  assert.match(m, /scored it 41\/100 \(the bar 50\)[\s\S]*- measured, pacing: idle 40 s between waves/);
  assert.match(m, /Fix the play, not the test/);
  assert.doesNotMatch(messages.repairMessage({ round: { kind: 'repair' }, after: 'verify', verify: { failed: [] }, promises, play: GATE_PLAY }), /## The play/, 'a verify repair with no play finding carries no play section');
  const brief = composeBrief({ spec: { ...BARE, play: { target: GATE_PLAY } }, ledger: goodLedger(), promises: [], manifests: { runtime: null, loop: null, mechanics: [], kind: null, packs: [] } });
  assert.match(brief, /every few seconds: swing at what reaches the gate/);
});

test('the proving cases (builder/play/cases): an artillery battle, a board game, a calm co-op garden; each target valid, none naming a reference game', async () => {
  const dir = new URL('../builder/play/cases/', import.meta.url);
  const cases = await Promise.all(['artillery', 'board', 'calm'].map(async id => JSON.parse(await readFile(new URL(`${id}.json`, dir), 'utf8'))));
  for (const c of cases) {
    assert.deepEqual(v(c.target), [], `${c.id}: the target holds its schema`);
    assert.doesNotMatch(JSON.stringify(c), /worms\s+ul\w*\s+mayhem/i, `${c.id}: no reference game's name`);
    assert.ok(c.target.makes.length >= 3 && c.target.avoid.some(a => a.failure === 'idle') && c.target.avoid.some(a => a.failure === 'unreachable'));
  }
  const [art, board, calm] = cases;
  // three different plays, measured apart: chaos and impact separate the brawl from the garden
  assert.ok(art.target.feel.chaos > board.target.feel.chaos && board.target.feel.chaos > calm.target.feel.chaos);
  assert.equal(calm.target.pacing.comeback, 0, 'nobody competes in the garden');
  assert.ok(art.target.touchpoints.some(t => t.kind === 'knock') && art.target.avoid.some(a => a.failure === 'runaway-leader'));
});

test('a target thing hit from afar is not a spot to walk to; a game\'s own objectives come from rules.objectives', async () => {
  const { wantOf: wantsOf } = await import('../builder/play/measure.mjs');
  const things = [{ what: 'rival worms', where: 'on the islands', placed: 'ground', reach: 'aim', count: 12 }, { what: 'a crate', where: 'open ground', placed: 'ground', reach: 'walk', count: 2 }, { what: 'a berry', where: 'lawn', placed: 'ground', count: 3 }];
  assert.deepEqual(v({ ...TAG_PLAY, objective: { ...TAG_PLAY.objective, things } }), []);
  assert.deepEqual(wantsOf({ objective: { things } }, {}).things.map(t => t.what), ['a crate', 'a berry']);
  const boot = await readFile(new URL('../runtimes/three/kit/core/boot.js', import.meta.url), 'utf8');
  assert.match(boot, /rules\.objectives === 'function' \? \[\.\.\.list, \{ id: 'rules', objectives: \(\) => rules\.objectives\(ctx\) \}\]/);
});
