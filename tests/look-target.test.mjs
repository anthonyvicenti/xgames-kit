// The looks layer's target half (builder/look): references by content, the measured numbers, a target from a judge's
// answer (or from words alone) that holds to gf-look-target/1, the target on the three runtime's levers (the spec's own
// answers win), and the pitch's readings and options (drawn by a stand-in, no GPU here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { loadSchemas, SCHEMA } from '../registry/schemas.mjs';
import { measureSet } from '../builder/look/measure.mjs';
import { readManifest, refsOf, findRefs, sha256Of } from '../builder/look/refs.mjs';
import { extract, finish, JUDGED_SCHEMA, judgeMessage } from '../builder/look/target.mjs';
import { applyTarget, lookValues, skyOf, LEVERS } from '../builder/look/apply.mjs';
import { readings, options, skies } from '../builder/look/pitch.mjs';
import { hexToOklab } from '../builder/look/stats.mjs';

const { validate } = await loadSchemas();
const { sharp } = await import(pathToFileURL(join(KIT_ROOT, 'builder/tools/lib/char-deps.mjs')).href);

/** A frame: a sky band on top, a ground band below, a red blob in the middle (a character). */
async function frame(file, { sky = '#4a90e2', ground = '#5cb85c', blob = '#e8473c' } = {}) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="${sky}"/><rect y="110" width="320" height="70" fill="${ground}"/><circle cx="160" cy="80" r="22" fill="${blob}" stroke="#111111" stroke-width="3"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
  return file;
}
const JUDGED = {
  lighting: { key: '#fff2d8', fill: '#5a5f9e', keyStrength: 'mid', contrast: 0.4, shadowSoftness: 0.6, fog: { density: 0.15, color: '#a9c4ec' }, time: 'day', sky: ['#4a90e2', '#6952bd'], local: ['#ffb030'] },
  materials: { shading: 'soft-toon', bands: 2, roughness: 0.7, gloss: 'low', rim: 'low', texture: 'painted' },
  shapes: { chunkiness: 0.8, roundness: 0.8, detail: 'low', headToBody: 0.55, eyes: 'huge', language: ['rounded', 'chunky'] },
  camera: { view: 'three-quarter', pitch: 20, distance: 'mid', fov: 55, framings: [{ name: 'mid', pitch: 20, distance: 10, fov: 55 }] },
  ui: { style: 'chunky inked badges', font: ['chunky rounded display'], accent: ['#ffc21a'], corners: 'irregular', ink: 'high' },
  reads: ['a bright blue sky over green land', 'one red creature in the middle', 'dark outlines around it'],
  avoid: ['realistic textures'], outline: { level: 'mid', color: '#111111' }, roles: [{ hex: '#000000', role: 'nothing' }],
};

test('references by content: a manifest is checked by sha256, the spec carries no path, frames are found again by hash', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-refs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const set = join(dir, 'set'); await mkdir(set);
  await frame(join(set, 'a.png')); await frame(join(set, 'b.png'), { sky: '#6952bd' });
  const sha = await sha256Of(join(set, 'a.png'));
  await writeFile(join(set, 'manifest.json'), JSON.stringify({ schema: 'gf-look-refs/1', name: 'set', frames: [{ file: 'a.png', sha256: sha, url: 'https://example.com/a', frame: 'gameplay' }, { file: 'b.png', sha256: '0'.repeat(64), frame: 'scene' }] }));
  const m = await readManifest(set);
  assert.equal(m.frames.length, 1, 'a frame whose hash does not match is left out');
  assert.match(m.problems[0], /b\.png: sha256/);
  const refs = refsOf(m.frames);
  assert.deepEqual(refs, [{ sha256: sha, url: 'https://example.com/a', frame: 'gameplay' }]);
  assert.ok(!JSON.stringify(refs).includes(dir), 'no local path in what the spec carries');
  const found = await findRefs([...refs, { sha256: 'f'.repeat(64) }], { dirs: [dir] });
  assert.equal(found.frames[0].file, join(set, 'a.png'));
  assert.deepEqual(found.missing, ['f'.repeat(64)]);
});

test('the measured half: palette clusters, lit pixels, edges, and the sky and ground bands', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-measure-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const s = await measureSet([await frame(join(dir, 'a.png')), await frame(join(dir, 'b.png'))]);
  const near = (hex, list) => Math.min(...list.map(c => { const p = hexToOklab(c.hex), q = hexToOklab(hex); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); }));
  assert.ok(near('#4a90e2', s.palette) < 0.04 && near('#5cb85c', s.palette) < 0.04, JSON.stringify(s.palette));
  assert.ok(s.palette[0].share >= s.palette.at(-1).share, 'largest share first');
  assert.equal(s.value.hist.length, 16);
  assert.ok(near('#4a90e2', s.regions.sky.colors) < 0.04, 'the top band is the sky');
  assert.ok(near('#5cb85c', s.regions.ground.colors) < 0.04, 'the bottom band is the ground');
  assert.ok(s.regions.characters && near('#e8473c', s.regions.characters.colors) < 0.06, 'the saturated blob neither band holds is a character');
  assert.ok(s.mean.litL > 0.45 && s.mean.litC > 0.05);
  assert.ok(s.edges.density > 0);
});

test('a target from frames and a judge holds to gf-look-target/1; from words alone it says so', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-target-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.ok(!JSON.stringify(JUDGED_SCHEMA).includes('$ref'), 'the rubric\'s schema stands alone (a runner\'s structured output)');
  let asked = null;
  const judge = async q => { asked = q; return { judged: JUDGED, model: 'a-model' }; };
  const { target } = await extract({ refs: [await frame(join(dir, 'a.png'))], words: 'like a cartoon game', kind: 'silly', judge });
  assert.deepEqual(validate(SCHEMA.lookTarget, target), []);
  assert.match(asked.message, /Read tool/);
  assert.match(asked.message, /never names the reference game/);
  assert.equal(target.from, 'refs+words');
  assert.equal(target.words, undefined, 'with frames, the words stay in the spec\'s prompt');
  assert.deepEqual(target.sources.measured, ['palette', 'regions', 'edges']);
  assert.equal(target.edges.outline, 'mid');
  assert.ok(target.avoid.some(a => /characters, names, logos and art/.test(a)));
  const { pending } = await extract({ refs: [], words: 'a cosy golden village', kind: 'calm' });
  assert.match(pending.message, /from the words alone/);
  const w = finish(pending.base, { ...JUDGED, palette: [{ hex: '#f2b45a', share: 0.6 }, { hex: '#6fa35a', share: 0.4 }] });
  assert.deepEqual(validate(SCHEMA.lookTarget, w), []);
  assert.equal(w.from, 'words');
  assert.equal(w.confidence, 0.4);
  assert.equal(w.words, 'a cosy golden village');
  assert.ok(w.sources.judged.includes('palette'));
  assert.ok(judgeMessage({ frames: [] }).length > 200);
});

test('the target on the three runtime\'s levers: the judge\'s sky first, the spec\'s palette and look.values win, other runtimes say why not', async () => {
  const t = finish({ measured: null, frames: [] }, JUDGED);
  assert.equal(skyOf(t), '#4a90e2');
  const base = { sun: { intensity: 3 }, fog: { near: 60, far: 240 }, ambient: { intensity: 0.5 }, post: { grade: { saturation: 1.1 } }, renderer: { exposure: 1 } };
  const r = lookValues(t, { runtime: 'three', profile: 'standard-3d', base });
  assert.equal(r.values.sun.color, '#fff2d8');
  assert.equal(r.values.fog.color, r.values.sky.horizon, 'the fog is the horizon\'s colour');
  assert.equal(r.values.post.outline.color, '#111111');
  assert.equal(r.values.lamps.color, '#ffb030');
  assert.equal(r.values.palette.accent, '#ffc21a');
  assert.equal(r.values.materials.character.bandSoftness, 0.12);
  assert.ok(lookValues(t, { runtime: 'forge' }).skipped);
  assert.deepEqual(Object.keys(LEVERS).sort(), ['forge', 'godot', 'three/flat-2d', 'three/scenic-3d', 'three/standard-3d', 'vista']);
  // create's seam: folded into the look and its time block, the spec's palette kept, its values last
  const C = { look: { time: 'day', palette: { accent: '#000000' }, sky: { top: '#000000' }, times: { day: { sky: { top: '#111111' } } } } };
  const { notes } = applyTarget(C, { look: { target: t, palette: ['#ff0000'], values: { sky: { top: '#123456' } } } }, { place: { runtime: 'three', profile: 'standard-3d' } });
  assert.equal(C.look.palette.accent, '#000000', 'the spec\'s own palette is its answer');
  assert.equal(C.look.sky.top, '#123456');
  assert.equal(C.look.times.day.sky.top, '#123456', 'a time block never shadows them');
  assert.equal(C.look.times.day.sky.horizon, lookValues(t, { runtime: 'three' }).values.sky.horizon);
  assert.match(notes.join(' '), /look target \(words, confidence 0.25\)/, 'no frames and no words: the lowest confidence');
  const D = { look: { time: 'day' } };
  assert.match(applyTarget(D, { look: { target: t } }, { place: { runtime: 'vista' } }).notes[0], /vista .*not mapped yet/);
});

test('the pitch: three readings of one target, drawn on copies of the game; the faithful one first when nothing scores', async t => {
  const t0 = finish({ measured: null, frames: [] }, JUDGED);
  const rs = readings(t0);
  assert.deepEqual(rs.map(r => r.id), ['faithful', 'pushed', 'other-sky']);
  assert.deepEqual(skies(t0), ['#4a90e2', '#6952bd']);
  assert.equal(skyOf(rs[2].target), '#6952bd', 'the third reading is the references\' other sky');
  assert.equal(rs[1].target.edges.outline, 'high', 'pushed: more ink');
  assert.equal(readings({ ...t0, lighting: { ...t0.lighting, sky: ['#4a90e2'] } })[2].id, 'softer');
  const root = await mkdtemp(join(tmpdir(), 'gf-look-pitch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = join(root, 'g');
  await mkdir(join(game, 'config'), { recursive: true });
  await writeFile(join(game, 'config/look.json'), JSON.stringify({ time: 'day', sky: { top: '#000000' }, times: { day: {} } }));
  await writeFile(join(game, 'rules.js'), '// rules\n');
  const drawn = [];
  const render = async (copy, out) => { drawn.push(await readFile(join(copy, 'config/look.json'), 'utf8')); return { ok: true, sheet: join(out, 'k.png'), tiles: {} }; };
  const opts = await options({ runtime: 'three', profile: 'standard-3d', look: { target: t0 } }, { game, out: join(root, 'out'), render, score: null });
  assert.equal(opts.length, 3);
  assert.equal(opts[0].id, 'faithful');
  assert.equal(new Set(drawn).size, 3, 'each option drawn with its own look');
  assert.equal(await readFile(join(root, 'out/faithful/game/rules.js'), 'utf8'), '// rules\n', 'the game\'s own files are linked into the copy');
  const rec = JSON.parse(await readFile(join(root, 'out/options.json'), 'utf8'));
  assert.equal(rec.schema, 'gf-look-options/1');
});

test('the studio reads the look options from the loop state: titles, readings, a sheet URL each, and whether the person is asked', async () => {
  const { talkOf } = await import('../builder/server/routes/build.mjs');
  const loop = { status: 'waiting-on-creator', waiting: { about: 'looks' }, look: { target: { reads: ['a bright sky'] }, options: [{ id: 'faithful', title: 'As the references read', reading: 'as measured', score: null, sheet: '.look/options/faithful/sheet/silly.png' }] } };
  const { looks } = talkOf(loop);
  assert.equal(looks.waiting, true);
  assert.deepEqual(looks.reads, ['a bright sky']);
  assert.deepEqual(looks.options, [{ id: 'faithful', title: 'As the references read', reading: 'as measured', score: null, sheet: '/api/build/look/faithful' }]);
  assert.equal(talkOf({ status: 'building' }).looks, null);
});
