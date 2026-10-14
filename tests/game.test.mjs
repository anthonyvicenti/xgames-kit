// create (from an example and from a spec) and slots (values and files), on games in temp folders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createGame } from '../builder/lib/create.mjs';
import { listExamples } from '../builder/lib/examples.mjs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { BIN, EXAMPLES, KIT_ROOT, toPosix } from '../builder/lib/paths.mjs';
import { coerceValue, listSlots, setFile, setValue } from '../builder/lib/slots.mjs';
import { tempDir, tempGame } from './helpers.mjs';
import { libraryFile } from '../builder/art/views.mjs';

let g;
before(async () => { g = await tempGame(); });
after(async () => { await g?.cleanup(); });

test('examples list the shipped example', async () => {
  const all = await listExamples();
  assert.ok(all.some(e => e.id === 'soak-squad'));
});

test('create --from: a full game with the example\'s rules and the game\'s own agent guide', async () => {
  for (const f of ['index.html', 'main.js', 'rules.js', 'spec.json', 'assets.json', 'multiplayer.json', 'gf-three.json', 'config/game.json', 'gf/three/kit.js', 'gf/mp/net.js', 'audio/audio.js', 'vendor/three/build/three.module.js', 'AGENTS.md', 'CLAUDE.md', '.gitignore']) {
    assert.ok(existsSync(path.join(g.dir, ...f.split('/'))), f);
  }
  assert.equal(await readFile(path.join(g.dir, 'rules.js'), 'utf8'), await readFile(path.join(EXAMPLES, 'soak-squad', 'rules.js'), 'utf8'));
  const agents = await readFile(path.join(g.dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /^# Soak Squad/);
  assert.ok(agents.includes(`${toPosix(path.relative(g.dir, KIT_ROOT))}/AGENTS.md`), 'points back to the playbook');
  assert.doesNotMatch(agents, /\{\{[A-Z_]+\}\}/, 'no unfilled placeholders');
  assert.equal((await readFile(path.join(g.dir, 'CLAUDE.md'), 'utf8')).trim(), '@AGENTS.md');
  assert.equal(JSON.parse(await readFile(path.join(g.dir, 'multiplayer.json'), 'utf8')).mode, 'live');
});

test('a created game passes the kit\'s asset-manifest validator (verify check 1), agent guide files included', async () => {
  const { validateGame } = await import(pathToFileURL(path.join(KIT_ROOT, 'builder', 'asset-manifest', 'validate.mjs')).href);
  const v = await validateGame(g.dir);
  assert.deepEqual(v.errors, []);
  assert.equal(v.ok, true);
  const ignored = JSON.parse(await readFile(path.join(g.dir, 'assets.json'), 'utf8')).ignore.map(e => e.path);
  for (const p of ['AGENTS.md', 'CLAUDE.md', '.claude/**', 'scratch/**']) assert.ok(ignored.includes(p), p);
});

test('slots write keeps the agent ignores, and slots check agrees', async () => {
  const run = args => spawnSync(process.execPath, [BIN, 'slots', ...args], { encoding: 'utf8' });
  assert.equal(run(['check', g.dir]).status, 0, 'fresh game is up to date');
  assert.equal(run(['write', g.dir]).status, 0);
  assert.equal(run(['check', g.dir]).status, 0, 'still up to date after write');
  const { validateGame } = await import(pathToFileURL(path.join(KIT_ROOT, 'builder', 'asset-manifest', 'validate.mjs')).href);
  assert.equal((await validateGame(g.dir)).ok, true);
});

test('create again keeps the game\'s own rules.js and config; create refuses a folder that is not a game', async () => {
  await writeFile(path.join(g.dir, 'rules.js'), '// mine\nexport default {};\n');
  await createGame(g.dir, { from: 'soak-squad' });
  assert.equal(await readFile(path.join(g.dir, 'rules.js'), 'utf8'), '// mine\nexport default {};\n');
  await writeFile(path.join(g.dir, 'rules.js'), await readFile(path.join(EXAMPLES, 'soak-squad', 'rules.js')));
  const t = await tempDir();
  try {
    await writeFile(path.join(t.dir, 'notes.txt'), 'x');
    await assert.rejects(createGame(t.dir, { from: 'soak-squad' }), /not a game/);
    await assert.rejects(createGame(path.join(t.dir, 'x')), /--spec|--from/);
  } finally { await t.cleanup(); }
});

test('create --spec: validates the spec and writes a stub rules.js', async () => {
  const t = await tempDir();
  try {
    const spec = JSON.parse(await readFile(path.join(EXAMPLES, 'soak-squad', 'spec.json'), 'utf8'));
    spec.title = 'Spec Test';
    await writeFile(path.join(t.dir, 'spec.json'), JSON.stringify(spec));
    const r = await createGame(path.join(t.dir, 'game'), { spec: path.join(t.dir, 'spec.json') });
    assert.equal(r.title, 'Spec Test');
    assert.match(await readFile(path.join(t.dir, 'game', 'rules.js'), 'utf8'), /THE GAME AGENT'S FILE/);
    spec.mechanics = [{ id: 'not-a-mechanic' }];
    await writeFile(path.join(t.dir, 'bad.json'), JSON.stringify(spec));
    await assert.rejects(createGame(path.join(t.dir, 'bad'), { spec: path.join(t.dir, 'bad.json') }), /spec/);
  } finally { await t.cleanup(); }
});

test('slots: values are checked against the slot and written to its config', async () => {
  const { slots, total } = await listSlots(g.dir);
  assert.ok(total > 100 && slots.length <= 40);
  const r = await setValue(g.dir, 'world.backyard.ground.color', '#3A7A3A');
  assert.equal(r.after, '#3a7a3a');
  assert.equal(JSON.parse(await readFile(path.join(g.dir, 'config', 'world.json'), 'utf8')).ground.color, '#3a7a3a');
  await assert.rejects(setValue(g.dir, 'round.seconds', '5'), /less than 30 s, the least it can be/);   // the kit's own words
  await assert.rejects(setValue(g.dir, 'world.backyard.ground.color', 'green'), /colour/);
  await assert.rejects(setValue(g.dir, 'no.such.slot', '1'), /no slot/);
  await assert.rejects(setValue(g.dir, 'prop.bucket', '1'), /file/);
  assert.equal(coerceValue({ id: 'x', type: 'boolean' }, 'on'), true);
  assert.equal(coerceValue({ id: 'x', type: 'integer', constraints: { min: 1 } }, '3'), 3);
  assert.equal(coerceValue({ id: 'x', type: 'enum', constraints: { options: [{ value: 'day' }, { value: 'night' }] } }, 'night'), 'night');
  assert.deepEqual(coerceValue({ id: 'x', type: 'colors', constraints: { min: 1, max: 3 } }, '#fff, #000'), ['#fff', '#000']);
  assert.throws(() => coerceValue({ id: 'x', type: 'text', constraints: { maxLength: 3 } }, 'long'));
});

test('slots: a file swap must be the same kind and a real file of that kind', async () => {
  const t = await tempDir();
  try {
    const glb = libraryFile('kenney-holiday-kit/bench');
    const r = await setFile(g.dir, 'prop.bucket', { from: glb });
    assert.equal(r.file, 'assets/models/bucket.glb');
    assert.ok((await readFile(path.join(g.dir, 'assets', 'models', 'bucket.glb'))).equals(await readFile(glb)));
    await mkdir(t.dir, { recursive: true });
    await writeFile(path.join(t.dir, 'fake.glb'), 'not a glb');
    await assert.rejects(setFile(g.dir, 'prop.bucket', { from: path.join(t.dir, 'fake.glb') }), /not a valid \.glb/);
    await writeFile(path.join(t.dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await assert.rejects(setFile(g.dir, 'prop.bucket', { from: path.join(t.dir, 'pic.png') }), /\.glb file/);
    await assert.rejects(setFile(g.dir, 'round.seconds', { from: glb }), /value slot/);
  } finally { await t.cleanup(); }
});
