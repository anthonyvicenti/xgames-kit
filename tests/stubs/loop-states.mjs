// Loop states for the studio page's layout test and shots, made by the real loop library (builder/loop) on its test
// fakes (tests/loop: the fake registry, a scripted verify, a runner host): a run waiting on the person's pick of the
// cards (an economy offered), and a delivered run that climbed the ladder, was play-tested twice, read by the second
// reader (one line partly kept, one finding) and kept its economy. Each is written into a game folder as
// <game>/.gf-loop/state.json, where the studio reads it.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openLoop, fileStore, stateFileOf } from '../../builder/loop/index.mjs';
import { fakeBindings, scriptedVerify, seenTwo, touch } from '../loop/dryrun/fakes.mjs';
import { fakeRegistry, goodLedger, PROMPT } from '../loop/fixtures/registry.mjs';

const SPEC = { specVersion: 2, runtime: 'forge', loop: 'run', kind: 'dark', title: 'Gate of Ash', hook: 'Hold the gate with friends until the boss comes.', mechanics: [{ id: 'waves' }, { id: 'boss' }], controls: { swing: 'Mouse', hook: 'E' },
  build: [{ what: 'a grappling hook that pulls you onto the walls', how: 'a module in src/hook.js', where: 'module', row: 'hook' }], notInV1: [] };
const card = (id, title, hook) => ({ id, title, hook, whyFunny: 'Friends swinging into each other off the walls.', conceptPrompt: 'A ruined gate at night, torches, a crowd of zombies.', howItPlays: 'Waves come at the gate; hook onto the walls to hit them from above; the boss comes last.', players: '2 to 4, together', v1: { has: ['waves', 'a boss'], build: ['a grappling hook that pulls you onto the walls'], notYet: [] }, spec: { ...SPEC, economy: { in: 'gamesfun.json' } } });
const PITCH = {
  research: { bank: [], web: [], notes: '' }, policy: { ok: true },
  reply: 'Card 1 holds the gate in the ruins. A grappling hook that pulls you onto the walls is built new for this game, which makes the build take longer.',
  cards: [card('a', 'Gate of Ash', 'Hold the gate with friends until the boss comes.'), card('b', 'Wall Runners', 'Hook from wall to wall while the horde climbs.')],
  questions: [{ id: 'money', about: 'economy', text: 'Play each run for a pot in SOL?', options: [{ id: 'keep', label: 'Yes, a pot in SOL' }, { id: 'no-economy', label: 'No economy, just the game' }], default: 'keep' }],
  offers: { economy: { what: 'Each player puts 0.01 SOL into a pot per run; the team that beats the boss shares it.', price: 'about 0.05 SOL', clears: true } },
};
const C13 = { gate: 'C', measure: 13, detail: 'pressing E shows no hook on the player\'s own screen', rule: 'Every input shows on the screen of the player it concerns.', fix: 'Draw the hook line from the hand to the wall while E is held.' };

/** → {making, delivered}: two gf-loop/2 states, as the loop library wrote them. */
export async function loopStates() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-loop-states-'));
  try {
    const game = path.join(root, 'games', 'gate');
    await mkdir(game, { recursive: true });
    const registry = fakeRegistry();
    const B = fakeBindings({ registry, root, verify: scriptedVerify([[C13], [C13]], { runtime: 'forge' }).verify });
    const G = { game, arg: 'games/gate' };
    let n = 0, pt = 0;
    const L = await openLoop({
      registry, game, store: fileStore(stateFileOf(game)), tools: B.tools(G), versions: B.versions(G), limits: B.limits,
      parts: { economy: { check: async () => ({ ok: true, problems: [] }), publish: async () => ({ ok: true, approve: { link: 'http://127.0.0.1:5199/studio/#economy?flow=economy', step: 'Open the studio\'s Economy tab and press "Put it live".' } }), status: async () => ({ live: false }) } },
      agent: async o => {
        if (o.kind === 'ledger') return { ledger: goodLedger() };
        if (o.kind === 'pitch') return { pitch: PITCH };
        await touch(game, 'rules.js', `// round ${++n}`);
        return { summary: 'Hold the gate with friends; hook onto the walls with E.', controls: 'WASD move, mouse swing, E hook' };
      },
      playtester: async o => ({ promises: o.focus.map(id => (++pt <= o.focus.length && id === 'row.boss' ? { id, status: 'unreachable', note: 'the third wave never ended for a new player' } : { ...seenTwo(id), evidence: [`runs/two/${id}.png`] })), feel: ['the hook is the best part', 'waves feel long'], summary: 'Played four runs; the hook works, the boss came on the second round.' }),
      reader: async o => ({ rows: o.bundle.rows.map(r => (r.id === 'view' ? { id: r.id, mark: 'partly', why: 'first person, but the swing has little weight on screen', evidence: ['runs/one/2.png'] } : { id: r.id, mark: 'kept', why: 'the captures show it', evidence: ['runs/one/1.png'] })), findings: ['The gate is small: three players fill it, so it reads as a doorway more than a gate.'], summary: 'A co-op gate defence in dark ruins with a working grappling hook; the weight of first person is only partly there.' }),
    });
    let r = await L.run({ idea: PROMPT });
    if (r.about !== 'cards') throw new Error(`the loop did not reach the cards: ${JSON.stringify(r).slice(0, 300)}`);
    const making = JSON.parse(await readFile(stateFileOf(game), 'utf8'));
    r = await L.run({ choice: { card: 'a', answers: { money: 'keep' } } });
    if (r.next !== 'done') throw new Error(`the loop did not deliver: ${JSON.stringify(r).slice(0, 300)}`);
    const delivered = JSON.parse(await readFile(stateFileOf(game), 'utf8'));
    return { making, delivered };
  } finally { await rm(root, { recursive: true, force: true }); }
}

/** Write a state where the studio reads it. */
export async function writeLoopState(gameDir, state) {
  const file = stateFileOf(gameDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2) + '\n');
}

