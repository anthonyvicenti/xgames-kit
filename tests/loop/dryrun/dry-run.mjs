#!/usr/bin/env node
// One end-to-end dry run of the creation loop through its MCP tools, with a scripted session standing in for the agent,
// the play-tester and the person, and a scripted verify. Every call is checked against the tool the previous answer
// named, so the run also proves the tools hold the order. It shows:
//   - the ledger refused once (a line not in the person's words, a question it may not ask), then a probe round
//   - the foundation by hard limits (phone + first person with weight → forge), the kind last from the feel line
//   - a pitch that narrows the idea refused, then cards, a choice, the lock with build promises
//   - the stop rule climbing every rung: model → specialist (after a restart of the tools mid-ladder) → generate → ask
//   - the person's answer re-entering at the ledger, a second ladder where generate is skipped, "deliver as it is"
//   - a look change that tries to change play (refused), then a runtime change shown as a migration and approved
//   - each delivery's ledger: proven / failed / untested
//   node dryrun/dry-run.mjs [--quiet]        writes dryrun/record.json and dryrun/transcript.txt
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loopTools } from '../../../builder/mcp/loop-tools.mjs';
import { fakeBindings, scriptedVerify, seenTwo, touch } from './fakes.mjs';
import { fakeRegistry, goodLedger, PROMPT, CARD_WORDS, pitchV2 } from '../fixtures/registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export async function dryRun({ quiet = false, write = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gf-dry-run-'));
  const game = join(root, 'games', 'gate-of-ash');
  await mkdir(game, { recursive: true });
  const lines = [], record = { calls: [], deliveries: [], climbs: [], said: [] };
  const say = l => { lines.push(l); if (!quiet) console.log(l); };
  const F = (gate, measure, detail, area) => ({ gate, measure, detail, rule: `the rule of ${measure}`, fix: `the fix for ${measure}`, ...(area ? { area } : {}) });
  const C13 = F('C', 13, 'the hook button does nothing on touch');
  const E5 = F('E', 5, 'the hooked player stands somewhere else on the other screen');
  const A19 = F('A', 19, 'the zombie body has crooked hands', 'art');
  // verify n → its failures; past the script every verify passes. Gate B (the phone leg) is skipped on this host until the migration.
  const v = scriptedVerify([[C13], [C13], [E5], [C13], [A19], [A19]], { skipped: ['B'], runtime: 'forge' });
  let verifyNow = v.verify;
  const verify = (g, o) => verifyNow(g, o);
  const registry = fakeRegistry();
  const said = (G, key, d) => record.said.push(d?.area ? `${key}:${d.area}` : key);
  let tools = loopTools(fakeBindings({ registry, root, verify, say: said }));
  const tool = name => tools.find(t => t.name === name);
  let expected = 'gamesfun_step_ledger';
  const G = 'games/gate-of-ash';

  // one tool call, held to the tool the last answer named (or the one the person's move goes to)
  async function call(name, args = {}, { note = '' } = {}) {
    const ok = name === expected || expected === '*';
    if (!ok) throw new Error(`the session called ${name}, and the last answer named ${expected}`);
    const res = await tool(name).handler({ game: G, ...args });
    const a = res.structuredContent;
    if (a.problems && !quiet) console.log('   ', a.problems.join('\n    '));
    record.calls.push({ tool: name, refused: a.refused ?? null, step: a.step, status: a.status, next: a.tool ?? a.after?.tool ?? null, round: a.round?.kind ?? null, rung: a.ladder?.rung ?? null });
    say(`${name.padEnd(26)} → ${a.refused ? `REFUSED (${a.refused}) ` : ''}${a.status ?? ''} @ ${a.step ?? '-'}${a.round ? ` | round: ${a.round.kind}${a.round.model ? ` [${a.round.model}]` : ''}${a.round.area ? ` (${a.round.area})` : ''}` : ''}${a.ladder?.rung ? ` | rung: ${a.ladder.rung}` : ''}${a.waitingOn ? ` | waiting on the person (${a.about})` : ''}${note ? `   # ${note}` : ''}`);
    expected = a.tool ?? a.after?.tool ?? '*';
    return a;
  }
  const deliveryOf = a => {
    const o = a.outcome;
    record.deliveries.push({ outcome: o.outcome, ledger: o.ledger.rows.map(l => ({ id: l.id, status: l.status, ...(l.reader ? { reader: l.reader.mark } : {}) })), promises: o.promises, ladder: o.ladder, ladderRecord: o.ladderRecord, notYet: o.notYet, reader: o.reader });
    say(`  DELIVERED: ${o.outcome}${o.notYet ? ` — ${o.notYet}` : ''}`);
    for (const l of o.ledger.rows) say(`    ${l.status.padEnd(8)} ${l.id.padEnd(8)} ${l.what}`);
    say(`    promises: ${o.promises.proven.length} proven, ${o.promises.failed.length} failed (${o.promises.failed.join(', ') || '-'}), ${o.promises.untested.length} untested (${o.promises.untested.join(', ') || '-'}); gates ${JSON.stringify(o.gates)}`);
  };
  const play = async (statuses = {}) => {
    const a = await call('gamesfun_step_playtest', {}, { note: 'hand the play-test over' });
    const token = /Your report token: ([0-9a-f]+)/.exec(a.round.message)[1];
    const asked = [...a.round.message.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
    const report = { promises: asked.map(id => statuses[id] ? { id, status: statuses[id], note: `${statuses[id]}: the tester could not make it happen` } : { ...seenTwo(id), note: 'seen' }), feel: ['the hook is fun'], summary: 'played 8 minutes' };
    const r = await tools.find(t => t.name === 'gamesfun_playtest_report').handler({ game: G, token, report });
    if (r.isError) throw new Error(`report refused: ${r.content[0].text}`);
    expected = 'gamesfun_step_playtest';
    return call('gamesfun_step_playtest', {}, { note: `report: ${Object.entries(statuses).map(([k, s]) => `${k} ${s}`).join(', ') || 'every promise seen'}` });
  };
  // the second reader: its token is in the round's message; it marks every ledger line (here: all kept but `marks`)
  const readIt = async (marks = {}) => {
    const a = await call('gamesfun_step_read', {}, { note: 'hand the reading over' });
    const token = /Your reading token: (\S+)/.exec(a.round.message)[1];
    const part = a.round.message.split('## The ledger')[1].split('## What the game promises')[0];
    const ids = [...part.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
    const reading = { schema: 'gf-reading/1', rows: ids.map(id => (marks[id] ? { id, mark: marks[id], why: `${marks[id]}: the captures do not show it as asked`, evidence: marks[id] === 'partly' ? ['runs/r/x.jpg'] : [] } : { id, mark: 'kept', why: 'the captures show it', evidence: [`runs/r/${id}.jpg`] })), findings: Object.keys(marks).length ? ['the boss is a wave, not a giant'] : [], summary: 'A gate defence; it kept most of what was asked.' };
    const r = await tools.find(t => t.name === 'gamesfun_reader_report').handler({ game: G, token, reading });
    if (r.isError) throw new Error(`reading refused: ${r.content[0].text}`);
    record.readings = (record.readings ?? 0) + 1;
    expected = 'gamesfun_step_read';
    return call('gamesfun_step_read', {}, { note: `reading: ${Object.entries(marks).map(([k, m]) => `${k} ${m}`).join(', ') || 'every line kept'}` });
  };
  const deliver = async (note, marks = {}) => {
    if (expected === 'gamesfun_step_read') await readIt(marks);
    let a = await call('gamesfun_step_deliver', {}, { note });
    if (a.step === 'read') { await readIt(marks); a = await call('gamesfun_step_deliver', {}, { note }); }
    return a;
  };
  const roundEnd = async (body, note) => { if (body !== null) await touch(join(root, G), 'rules.js', body); return call('gamesfun_step_fix', { summary: 'Hold the gate with friends.', controls: 'WASD move, mouse swing, E hook' }, { note }); };

  say(`# Dry run: "${PROMPT}"\n`);
  // ---- the ledger: refused once, then a probe line
  let a = await call('gamesfun_step_ledger', { idea: PROMPT }, { note: 'the idea' });
  const bad = goodLedger();
  bad.rows.find(l => l.id === 'hook').words = 'a grapple to climb the walls';
  bad.asks = [{ about: 'feel', text: 'Grim or bright?', options: [{ id: 'g', label: 'grim' }, { id: 'b', label: 'bright' }], default: 'g' }];
  a = await call('gamesfun_step_ledger', { ledger: bad }, { note: 'a line not in their words, a question it may not ask' });
  say(`  problems: ${a.problems?.length}: ${a.problems?.slice(0, 2).join(' | ')}`);
  const led = goodLedger();
  Object.assign(led.rows.find(l => l.id === 'hook'), { home: 'probe', probe: { question: 'Can the runtime\'s JS layer pull a body onto a wall top?', minutes: 15 } });
  a = await call('gamesfun_step_ledger', { ledger: led }, { note: 'a valid ledger, the hook needs a probe' });
  a = await call('gamesfun_step_foundation', {}, { note: 'hands the probe round' });
  a = await call('gamesfun_step_foundation', { probes: [{ row: 'hook', home: 'build', evidence: 'probe-hook.txt: no rope part; the JS layer moves a body', how: 'a module in src/hook.js that casts a ray and pulls the body up', where: 'module' }] }, { note: 'the probe says: build it' });
  // ---- the pitch: one that narrows, then two cards
  const spec = (take) => ({ specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate of Ash', hook: 'Hold the gate with friends, in first person, until the boss comes.',
    players: { min: 1, max: 4, bots: false }, multiplayer: { mode: 'live', together: 'coop' }, devices: { targets: ['phone', 'desktop'], inputs: ['touch', 'keyboard-mouse'] }, camera: 'first',
    world: { template: 'ruins', seed: 3, size: 'medium' }, rules: { summary: 'Waves come at the gate; a boss ends the run.' }, characters: [{ role: 'player', describe: 'a watchman in your colour', body: { from: 'kind' } }],
    mechanics: [{ id: 'waves' }, { id: 'boss' }, { id: take === 'b' ? 'shove' : 'melee' }], controls: { swing: 'Mouse / tap', hook: 'E / the hook button', move: 'WASD / the stick' },
    build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js that casts a ray and pulls the body up', where: 'module', row: 'hook' }], notInV1: [] });
  const card = (id, take) => ({ ...CARD_WORDS, id, title: id === 'a' ? 'Hold the Gate' : 'Push Them Back', v1: { has: ['waves', 'a boss'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: spec(id) });
  a = await call('gamesfun_step_pitch', {}, { note: 'hands the pitch round' });
  a = await call('gamesfun_step_spec', { pitch: pitchV2({ reply: 'Not in this kit yet: the grappling hook, so card 1 has ladders.', cards: [{ ...card('a', 'swing'), v1: { has: ['waves at the gate'], build: [], notYet: ['the grappling hook'] }, spec: { ...spec('a'), build: [], notInV1: ['grappling hook'] } }, card('b', 'shove')] }) }, { note: 'cards that narrow the idea' });
  say(`  problems: ${a.problems?.length}: ${a.problems?.slice(0, 2).join(' | ')}`);
  a = await call('gamesfun_step_spec', { pitch: pitchV2({ reply: 'Card 1 holds the gate in first person on your phone. A grappling hook that pulls you onto the walls is built new for this game, which makes the build take a little longer.', cards: [card('a', 'swing'), card('b', 'shove')], questions: [] }) }, { note: 'two cards that keep every line' });
  a = await call('gamesfun_step_pitch', { choice: { card: 'a' } }, { note: 'the person chooses card a' });
  a = await call('gamesfun_step_spec', {}, { note: 'the chosen spec is checked and locked' });
  a = await call('gamesfun_step_create', {}, { note: 'create, then the build round' });
  say(`  brief: ${a.round.message.length} characters; forge's notes ${/MARK-RUNTIME-FORGE/.test(a.round.message) ? 'in' : 'MISSING'}; tag's ${/MARK-MECH-TAG/.test(a.round.message) ? 'IN (wrong)' : 'not'} (not chosen)`);
  record.brief = { chars: a.round.message.length, hasChosen: /MARK-RUNTIME-FORGE/.test(a.round.message) && /MARK-MECH-WAVES/.test(a.round.message), hasUnchosen: /MARK-MECH-TAG|MARK-RUNTIME-VISTA/.test(a.round.message) };
  await mkdir(join(game, 'src'), { recursive: true });
  await touch(game, 'src/hook.js', 'export const hook = 1;\n');
  // ---- the build round and the ladder
  a = await roundEnd('// round 1\n', 'the build round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 1: C 13 fails' });
  a = await call('gamesfun_step_repair', {}, { note: 'a plain repair' });
  a = await roundEnd('// round 2\n', 'repaired');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 2: C 13 again (repeat)' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed: the stronger model' });
  a = await roundEnd('// round 3\n', 'repaired on the stronger model');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 3: E 5 (new)' });
  a = await call('gamesfun_step_repair', {}, { note: 'a repair, still on the stronger model' });
  a = await roundEnd('// round 4\n', 'repaired');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 4: C 13 came back (returned)' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed: a specialist round' });
  // ---- the MCP server restarts with the specialist round handed over: gamesfun_next picks it up
  tools = loopTools(fakeBindings({ registry, root, verify, say: said }));
  say('  (the MCP server restarts: a fresh tools instance, nothing in memory)');
  expected = 'gamesfun_next';
  a = await call('gamesfun_next', {}, { note: 'after the restart' });
  record.resumed = { step: a.step, round: a.round?.kind, area: a.round?.area, rung: a.ladder?.rung };
  a = await roundEnd('// round 5: the hook button reads touch\n', 'the feel specialist\'s round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 5: A 19 (art)' });
  a = await call('gamesfun_step_repair', {}, { note: 'a repair' });
  a = await roundEnd('// round 6\n', 'repaired');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 6: A 19 again (repeat)' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed: paid generation' });
  await touch(game, 'zombie.glb.txt', 'a generated body');
  a = await roundEnd('// round 7\n', 'the generation round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 7 passes' });
  a = await play({ 'build.1': 'not-seen', 'row.boss': 'unreachable' });
  a = await call('gamesfun_step_repair', {}, { note: 'a repair for the play-test' });
  a = await roundEnd('// round 8\n', 'repaired');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 8 passes' });
  a = await play({ 'build.1': 'not-seen', 'row.boss': 'unreachable' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed: the top, questions' });
  a = await call('gamesfun_ask', { message: 'The hook and the boss still do not work for a new player.', questions: [{ id: 'hook', text: 'Would a rope you climb do instead of a hook?', options: [{ id: 'rope', label: 'A rope' }, { id: 'hook', label: 'Keep the hook' }], default: 'rope' }] }, { note: 'the questions' });
  record.climbs.push(...(a.ladder?.climbs ?? []).map(c => c.skipped ? `${c.rung} (skipped)` : c.rung));
  // ---- the answer re-enters at the ledger
  const answer1 = 'Keep the hook, but it can be a rope you climb instead; and the boss may come after wave 3 so we reach it.';
  expected = 'gamesfun_step_ledger';
  a = await call('gamesfun_step_ledger', { answer: { words: answer1 } }, { note: 'the person answers' });
  const amended = structuredClone(led);
  Object.assign(amended.rows.find(l => l.id === 'hook'), { home: 'build', words: 'it can be a rope you climb', what: 'A rope players climb onto the walls', how: 'a module in src/rope.js that hangs a rope and lets a body climb it', where: 'module' });
  delete amended.rows.find(l => l.id === 'hook').probe;
  Object.assign(amended.rows.find(l => l.id === 'boss'), { words: 'the boss may come after wave 3', what: 'A boss comes after wave 3' });
  a = await call('gamesfun_step_ledger', { ledger: amended }, { note: 'the amended ledger' });
  a = await call('gamesfun_step_foundation', {}, { note: 'classified' });
  say(`  change: ${a.why}`);
  const spec2 = { ...spec('a'), build: [{ what: 'a rope players climb onto the walls', how: 'a module in src/rope.js that hangs a rope and lets a body climb it', where: 'module', row: 'hook' }] };
  a = await call('gamesfun_step_spec', { spec: spec2 }, { note: 'the changed spec, locked' });
  a = await call('gamesfun_step_fix', {}, { note: 'hands the change round' });
  await touch(game, 'src/rope.js', 'export const rope = 1;\n');
  a = await roundEnd('// round 9: the rope\n', 'the change round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify 9 passes' });
  a = await play({ 'row.boss': 'not-seen' });
  a = await call('gamesfun_step_repair', {}, { note: 'a new ladder: a repair' });
  a = await roundEnd(null, 'a round that changed nothing');
  a = await call('gamesfun_step_verify', {}, { note: 'verify passes' });
  a = await play({ 'row.boss': 'not-seen' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed (unchanged): the stronger model' });
  a = await roundEnd('// round 11\n', 'repaired');
  a = await call('gamesfun_step_verify', {}, { note: 'verify passes' });
  a = await play({ 'row.boss': 'not-seen' });
  a = await call('gamesfun_step_repair', {}, { note: 'climbed: a code specialist' });
  a = await roundEnd('// round 12\n', 'the specialist round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify passes' });
  a = await play({ 'row.boss': 'not-seen' });
  a = await call('gamesfun_step_repair', {}, { note: 'generate has nothing to make: skipped, straight to questions' });
  a = await call('gamesfun_ask', { message: 'The boss still never comes for a new player.', questions: [{ id: 'go', text: 'Deliver now?', options: [{ id: 'y', label: 'Yes' }, { id: 'n', label: 'No' }], default: 'y' }] }, { note: 'the questions' });
  record.climbs2 = (a.ladder?.climbs ?? []).map(c => c.skipped ? `${c.rung} (skipped)` : c.rung);
  expected = 'gamesfun_step_ledger';
  a = await call('gamesfun_step_ledger', { answer: { words: 'Deliver it as it is.', deliver: true } }, { note: 'the person: as it is' });
  a = await deliver('delivery with its ledger', { boss: 'partly' });
  deliveryOf(a);
  // ---- a look change that tries to change play
  expected = 'gamesfun_change';
  const look = 'Make it look lo-fi, like a cheap old horror game.';
  a = await call('gamesfun_change', { request: look }, { note: 'a change of look' });
  const lookLedger = structuredClone(amended);
  Object.assign(lookLedger.rows.find(l => l.id === 'feel'), { words: 'lo-fi, like a cheap old horror game', what: 'Lo-fi, a cheap old horror look', kind: 'lofi' });
  a = await call('gamesfun_step_ledger', { ledger: lookLedger }, { note: 'the feel line changes' });
  a = await call('gamesfun_step_foundation', {}, { note: 'classified' });
  say(`  change: ${a.why}`);
  a = await call('gamesfun_step_spec', { spec: { ...spec2, kind: 'lofi', mechanics: [{ id: 'waves' }, { id: 'boss' }, { id: 'shove' }] } }, { note: 'the spec also changes a mechanic' });
  say(`  problems: ${a.problems?.slice(0, 1).join(' | ')}`);
  record.lookRefused = (a.problems ?? []).some(p => /never changes play/.test(p));
  a = await call('gamesfun_step_spec', { spec: { ...spec2, kind: 'lofi' } }, { note: 'only the look' });
  a = await call('gamesfun_step_fix', {}, { note: 'hands the change round' });
  a = await roundEnd('// round 13: lofi\n', 'the change round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify passes' });
  a = await play({});
  a = await deliver('delivery');
  deliveryOf(a);
  // ---- a runtime change: shown as a migration, then approved
  verifyNow = scriptedVerify([], { skipped: [], runtime: 'vista' }).verify;
  expected = 'gamesfun_change';
  const move = 'Make it photoreal and play it from behind the player, on my desktop.';
  a = await call('gamesfun_change', { request: move }, { note: 'a change that needs another runtime' });
  const big = structuredClone(lookLedger);
  Object.assign(big.rows.find(l => l.id === 'view'), { words: 'from behind the player', what: 'Third person, from behind', camera: 'third', needs: [] });
  Object.assign(big.rows.find(l => l.id === 'phone'), { words: 'on my desktop', what: 'It plays on a desktop', devices: ['desktop'] });
  Object.assign(big.rows.find(l => l.id === 'feel'), { words: 'Make it photoreal', what: 'Photoreal', kind: 'calm', graphics: 'photoreal' });
  a = await call('gamesfun_step_ledger', { ledger: big }, { note: 'the amended ledger' });
  a = await call('gamesfun_step_foundation', {}, { note: 'the migration is shown' });
  record.migration = a.migration;
  for (const c of a.migration?.consequences ?? []) say(`    - ${c}`);
  a = await call('gamesfun_step_foundation', { approve: 'Yes, move it.' }, { note: 'the person says yes' });
  const vistaSpec = { ...spec2, runtime: 'vista', kind: 'calm', mechanics: [], camera: 'third', devices: { targets: ['desktop'], inputs: ['keyboard-mouse'] },
    build: [spec2.build[0], ...['hold', 'waves', 'boss'].map(row => ({ what: `${amended.rows.find(l => l.id === row).what} on vista`, how: `a module in src/${row}.js that runs it`, where: 'module', row }))] };
  a = await call('gamesfun_step_spec', { spec: vistaSpec }, { note: 'the spec on vista' });
  a = await call('gamesfun_step_create', {}, { note: 'made again on vista; the migration round' });
  a = await roundEnd('// round 14: vista\n', 'the migration round ends');
  a = await call('gamesfun_step_verify', {}, { note: 'verify passes' });
  a = await play({});
  a = await deliver('delivery');
  deliveryOf(a);
  record.verifies = v.calls;
  // what the loop wrote, for the contracts' schemas (tests/contracts.test.mjs)
  const S = await fakeBindings({ registry, root, verify }).store({ game }).load();
  record.artifacts = { ledger: S.ledger, ladders: [...S.ladders, S.ladder].filter(Boolean), pitchLedger: S.pitch.ledger, promiseLedger: S.outcome.promiseLedger,
    specs: [spec2, vistaSpec], verdicts: [await v.verify(game, { n: 1 }), await v.verify(game, { n: 99 })] };
  if (write) {
    await writeFile(join(HERE, 'record.json'), JSON.stringify(record, null, 2) + '\n');
    await writeFile(join(HERE, 'transcript.txt'), lines.join('\n') + '\n');
  }
  await rm(root, { recursive: true, force: true });
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  dryRun({ quiet: process.argv.includes('--quiet') }).then(r => { console.log(`\nprogress keys: ${r.said.join(', ')}\nclimbs: ${r.climbs.join(' → ')}; second ladder: ${r.climbs2.join(' → ')}; deliveries: ${r.deliveries.map(d => d.outcome).join(', ')}`); }, e => { console.error(e); process.exit(1); });
}
