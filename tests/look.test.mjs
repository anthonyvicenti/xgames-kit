// The looks layer's judge and tuning loop (builder/look): the measured parts, the pass rule, the search, the ladder, the
// calibration checks and measure 23's inputs. No browser here: pictures are made in memory, the vision judge is a fake.
process.env.GF_LOOK_SETTINGS = '0';   // no vision model here: settings come from the numbers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toOklab, oklabToHex, hexToOklab, frameStats, compareStats, emd1d, paletteDistance, measuredMark, poolStats, trimBars, colourWords } from '../builder/look/stats.mjs';
import { score, pairUp, confidenceOf, targetStats, spread, BAR } from '../builder/look/judge.mjs';
import { cleanAnswer, judgedMark, PARTS } from '../builder/look/vision.mjs';
import { leversOf, stepLever, overlayOf, descend, ladderOf, overLook, anchorsOf } from '../builder/look/tune.mjs';
import { checkCalibration, majorityVs } from '../builder/look/calibrate.mjs';
import { lookInputs, checkLook } from '../builder/tools/lib/look-check.mjs';
import { framingsOf } from '../builder/look/render.mjs';
import { lookTuneLines } from '../builder/loop/messages.mjs';

/** A picture in memory: f(x, y) → [r, g, b]. */
const picture = (w, h, f) => { const data = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); data.set([r, g, b, 255], (y * w + x) * 4); } return { width: w, height: h, data }; };
// a candy scene: a saturated blue sky over green grass with red blobs outlined in black
const candy = picture(96, 54, (x, y) => (y < 18 ? [60, 130, 245] : (x % 24 < 10 && y % 18 < 8 ? ((x % 24 === 0 || y % 18 === 0) ? [10, 10, 10] : [230, 40, 50]) : [80, 200, 70])));
const greyed = picture(96, 54, (x, y) => { const [r, g, b] = (y < 18 ? [60, 130, 245] : (x % 24 < 10 && y % 18 < 8 ? ((x % 24 === 0 || y % 18 === 0) ? [10, 10, 10] : [230, 40, 50]) : [80, 200, 70])); const l = Math.round(0.3 * r + 0.59 * g + 0.11 * b); return [l, l, l]; });

test('OKLab: hex round trip, white and black, colours in words', () => {
  for (const hex of ['#ffffff', '#000000', '#3f6fe8', '#8fae4c']) assert.equal(oklabToHex(hexToOklab(hex)), hex);
  assert.ok(Math.abs(toOklab(255, 255, 255)[0] - 1) < 1e-3);
  assert.match(colourWords(hexToOklab('#3f6fe8')), /blue/);
  assert.match(colourWords(hexToOklab('#808080')), /grey/);
});

test('frame stats: palette clusters by share, 16-bin histograms that sum to 1, edges and outlines, the sky band', () => {
  const s = frameStats(candy);
  assert.equal(s.value.length, 16); assert.equal(s.chroma.length, 16);
  assert.ok(Math.abs(s.value.reduce((a, b) => a + b, 0) - 1) < 0.01);
  assert.ok(s.palette[0].share >= s.palette.at(-1).share);
  assert.ok(s.edges.density > 0 && s.edges.dark > 0, 'the black outlines are edges and dark lines');
  assert.ok(s.regions.top.C > 0.15, 'the blue sky band is saturated');
  assert.ok(s.tones.shadow[0] < s.tones.highlight[0]);
});

test('a frame against itself marks 100 on every part; a greyed copy loses saturation and says so', () => {
  const a = frameStats(candy), g = frameStats(greyed);
  const same = compareStats(a, a);
  for (const v of Object.values(same.parts)) assert.ok(v >= 99, JSON.stringify(same.parts));
  assert.equal(same.findings.length, 0);
  const c = compareStats(g, a);
  assert.ok(c.parts.saturation < 20, `saturation ${c.parts.saturation}`);
  assert.ok(c.findings.some(f => /less saturated/.test(f)), c.findings.join(' | '));
  assert.ok(c.findings.some(f => /sky\) too desaturated/.test(f)), c.findings.join(' | '));
  assert.ok(measuredMark(c.parts) < measuredMark(same.parts) - 40, 'one part that collapses pulls the whole mark down (geometric mean)');
});

test('distances: the earth mover\'s distance and the palette transport are zero for the same thing and grow apart', () => {
  const h = [0.5, 0.5, ...Array(14).fill(0)], k = [...Array(14).fill(0), 0.5, 0.5];
  assert.equal(emd1d(h, h), 0);
  assert.ok(emd1d(h, k) > 0.8);
  const P = [{ lab: hexToOklab('#3f6fe8'), share: 1 }], Q = [{ lab: hexToOklab('#e84a3a'), share: 1 }];
  assert.ok(paletteDistance(P, P) < 0.01);
  assert.ok(paletteDistance(P, Q) > 20);
});

test('letterbox bars are cut off before measuring', () => {
  const boxed = picture(40, 30, (x, y) => (y < 5 || y >= 25 ? [0, 0, 0] : [200, 100, 50]));
  const t = trimBars(boxed);
  assert.deepEqual([t.width, t.height], [40, 20]);
  assert.equal(trimBars(candy), candy);
});

test('pooled stats keep the shape a comparison needs', () => {
  const p = poolStats([frameStats(candy), frameStats(greyed)]);
  assert.equal(p.value.length, 16);
  assert.ok(Math.abs(p.palette.reduce((s, c) => s + c.share, 0) - 1) < 0.01);
  assert.ok(compareStats(p, p).parts.palette >= 99);
});

test('confidence: frames on file, or a target from frames with its numbers, hold the bar; words alone are advisory', () => {
  const measured = { from: 'refs', palette: { colors: [{ hex: '#3f6fe8', share: 1 }], value: { mean: 0.5, spread: 0.3, hist: Array(16).fill(1 / 16) } } };
  assert.equal(confidenceOf(null, [{ file: 'a.jpg' }]), 'refs');
  assert.equal(confidenceOf(measured, []), 'refs');
  assert.equal(confidenceOf({ from: 'words', palette: { colors: [{ hex: '#ffffff', share: 1 }] } }, [{ file: 'a.jpg' }]), 'words');
  assert.equal(confidenceOf({ from: 'refs' }, []), 'words', 'a target with no numbers and no frames holds nothing');
  assert.equal(BAR.refs, 55); assert.equal(BAR.words, null);
  const t = targetStats({ ...measured, regions: { sky: { colors: [{ hex: '#3f6fe8', share: 1 }], value: 0.6, chroma: 0.17 } } });
  assert.equal(t.value.length, 16); assert.equal(t.chroma, null);
  assert.equal(t.regions.top.lab.length, 3);
});

test('pairing: the same framing name first, then the frame kind\'s hint, then the closest measured', () => {
  const ours = [{ framing: 'wide', stats: frameStats(candy) }, { framing: 'hero', stats: frameStats(greyed) }];
  const refs = [{ framing: 'hero', stats: frameStats(candy) }, { frame: 'terrain', stats: frameStats(greyed) }, { stats: frameStats(greyed) }];
  const p = pairUp(refs, ours);
  assert.deepEqual(p.map(x => x.ours.framing), ['hero', 'wide', 'hero']);
  assert.equal(spread(Array.from({ length: 12 }, (_, i) => ({ id: String(i + 1), ref: { frame: i % 3 ? 'gameplay' : 'vfx' } })), 4).length, 4);
});

test('score from frames: measured and judged blend, the bar, findings that say where the levers reach', async () => {
  const pics = { 'ours.png': greyed, 'ref.png': candy };
  const px = { read: async f => pics[f.split('/').pop()], extract: async () => Buffer.alloc(0), close: async () => {}, browser: null };
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-'));
  try {
    for (const f of Object.keys(pics)) await writeFile(join(dir, f), 'x');
    const judge = async pairs => ({ pairs: pairs.map(p => ({ id: p.id, parts: Object.fromEntries(PARTS.map(k => [k, k === 'palette' ? { match: 0, vs: 'worse', finding: 'grey where the reference is candy coloured' } : { match: 2, vs: 'par', finding: 'matches' }])) })), change: ['bring the colour back'], summary: 's' });
    const r = await score({ frames: [{ file: join(dir, 'ours.png'), framing: 'wide' }] }, null, [{ file: join(dir, 'ref.png'), framing: 'wide' }], { px, judge, sheet: false, sheetDir: dir });
    assert.equal(r.confidence, 'refs');
    assert.equal(r.pass, false, `score ${r.score}`);
    assert.equal(r.framings[0].judged, judgedMark(r.framings[0].judgedParts));
    assert.equal(r.findings[0].source, 'judged');
    assert.equal(r.findings[0].reach, 'levers', 'palette is the levers\'');
    assert.ok(r.findings.some(f => f.source === 'measured' && /saturated/.test(f.line)));
    const same = await score({ frames: [{ file: join(dir, 'ref.png'), framing: 'wide' }] }, null, [{ file: join(dir, 'ref.png'), framing: 'wide' }], { px, vision: false, sheet: false, sheetDir: dir });
    assert.ok(same.pass && same.score >= 99, `the reference against itself: ${same.score}`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the vision judge\'s answer is held to the rubric', () => {
  const a = cleanAnswer({ pairs: [{ pair: '1', parts: { palette: { match: 9, vs: 'great', finding: 'x' }, lighting: { match: 2, vs: 'worse', finding: 'too dark' } } }], change: [], summary: '' }, [{ id: '1' }]);
  assert.equal(a.pairs[0].parts.palette.match, null);
  assert.equal(a.pairs[0].parts.lighting.vs, 'worse');
  assert.deepEqual(Object.keys(a.pairs[0].parts), PARTS);
  assert.equal(judgedMark(a.pairs[0].parts), 50);
});

test('tuning: the levers a look has, steps within their range, the overlay holds only what moved', () => {
  const values = { renderer: { exposure: 1 }, fog: { near: 40, far: 200, color: '#ffdcec' }, sky: { top: '#2f8cff', horizon: '#bfeaff', bottom: '#e6f6ff' }, post: { grade: { saturation: 1 } } };
  const anchors = { skyTop: hexToOklab('#3f6fe8'), skyHorizon: hexToOklab('#9cc0ff') };
  const L = leversOf(values, anchors);
  assert.ok(L.some(l => l.path === 'fog.far') && L.some(l => l.path === 'colour:sky'));
  assert.ok(!L.some(l => l.path === 'sun.intensity'), 'a value the look lacks is no lever');
  const far = L.find(l => l.path === 'fog.far');
  assert.ok(stepLever(far, 200, 1) > 200 && stepLever(far, 900, 1) === 900);
  const xs = Object.fromEntries(L.map(l => [l.path, l.start]));
  assert.deepEqual(overlayOf(L, xs), {});
  const o = overlayOf(L, { ...xs, 'colour:sky': 1, 'renderer.exposure': 1.15 });
  assert.equal(o.sky.top, oklabToHex(anchors.skyTop));
  assert.equal(o.fog.color, oklabToHex(anchors.skyHorizon));
  assert.equal(o.renderer.exposure, 1.15);
  assert.equal(o.fog.far, undefined);
  const look = overLook({ fog: { far: 200 }, times: { day: { fog: { far: 100 } } } }, { fog: { far: 50 } });
  assert.equal(look.fog.far, 50); assert.equal(look.times.day.fog.far, 50, 'a time of day never shadows a tuned value');
});

test('the search climbs to a known optimum and stops at its plateau', async () => {
  const L = [{ path: 'a', kind: 'number', min: 0, max: 10, step: 1, mode: 'lin', start: 1 }, { path: 'b', kind: 'number', min: 0, max: 10, step: 1, mode: 'lin', start: 9 }];
  const f = o => 100 - ((o.a ?? 1) - 6) ** 2 - ((o.b ?? 9) - 3) ** 2;
  const d = await descend(L, async o => f(o), { rounds: 8, maxEvals: 200 });
  assert.equal(d.xs.a, 6); assert.equal(d.xs.b, 3);
  assert.equal(d.best, 100);
  assert.ok(d.evals < 200);
});

test('the ladder: below the bar, the findings only new art can reach, a swap first and then generation', () => {
  const r = { score: 44, findings: [{ framing: 'hero', part: 'characters', line: 'no googly eyes', reach: 'art' }, { framing: 'wide', part: 'sky', line: 'sky too desaturated', reach: 'levers' }] };
  const l = ladderOf(r, 60);
  assert.equal(l.needed, true);
  assert.deepEqual(l.art.map(f => f.part), ['characters']);
  assert.match(l.next[0], /^swap/); assert.match(l.next[1], /^generate/);
  assert.equal(ladderOf({ ...r, score: 70 }, 60).needed, false);
  const lines = lookTuneLines({ before: 44, after: 50, bar: 60, ladder: l, suggestion: { values: 'out/look.json', sheet: 'out/before-after.jpg' } }, { failed: [{ measure: 23 }] });
  assert.ok(lines.some(x => /no googly eyes/.test(x)) && lines.some(x => /a suggestion, not applied/.test(x) && /out\/look.json/.test(x)));
  assert.ok(lookTuneLines({ before: 44, after: 50, bar: 60, ladder: l, wrote: true }, { failed: [{ measure: 23 }] }).some(x => /config\/look.json, keep them/.test(x)), 'a host that applies them says so');
  assert.deepEqual(lookTuneLines({ before: 1 }, { failed: [{ measure: 13 }] }), [], 'only when the look failed');
});

test('anchors: the medoid of the references\' skies keeps their colour (a mean of blue and orange skies is grey)', () => {
  const sky = lab => ({ stats: { regions: { top: { L: 0.7, lab } }, tones: { shadow: [0.2, 0, 0], highlight: [0.9, 0, 0] } } });
  const blue = hexToOklab('#3f6fe8'), blue2 = hexToOklab('#4a7af0'), orange = hexToOklab('#f0a020');
  const a = anchorsOf([sky(blue), sky(blue2), sky(orange)], null);
  assert.ok(Math.hypot(a.skyTop[1], a.skyTop[2]) > 0.1, 'still a saturated sky');
});

test('calibration: the order and the person\'s read are checked, claim by claim', () => {
  const fr = (framing, score, vs) => ({ framing, score, judgedParts: vs ? Object.fromEntries(PARTS.slice(0, 3).map(k => [k, { match: 2, vs, finding: k === 'lighting' ? 'far darker' : 'x' }])) : null });
  const results = { before: { score: 30, framings: [fr('cave', 20, 'worse')] }, after: { score: 60, framings: [fr('cave', 70, 'par')] } };
  const c = checkCalibration(results, { order: ['before', 'after'], claims: [{ state: 'after', framing: 'cave', vs: ['par', 'better'] }, { state: 'before', framing: 'cave', part: 'lighting', vs: 'worse', words: 'dark' }, { framing: 'cave', above: ['before', 'after'] }] });
  assert.ok(c.every(x => x.ok), JSON.stringify(c));
  assert.equal(majorityVs({ a: { vs: 'better' }, b: { vs: 'better' }, c: { vs: 'par' } }).vs, 'better');
});

test('framings: the target\'s cameras first (pitch and distance), then the kit\'s sheet framings', () => {
  const f = framingsOf({ camera: { framings: [{ name: 'aim-close', pitch: 8, distance: 3, fov: 60, frame: 'character' }, { name: 'no-pitch' }] } });
  assert.deepEqual(f.map(x => x.name), ['aim-close', 'wide', 'hero', 'props', 'hud']);
  assert.equal(f[0].frame, 'character'); assert.equal(f[0].view.distance, 3);
});

test('measure 23: no target passes at once; a target from words is advisory; a failing judge fails the measure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-game-'));
  try {
    await mkdir(join(dir, 'game'));
    const game = join(dir, 'game');
    await writeFile(join(game, 'spec.json'), JSON.stringify({ runtime: 'forge' }));
    const none = await checkLook(game, {});
    assert.deepEqual([none.ok, none.skipped], [true, true]);
    await writeFile(join(game, 'spec.json'), JSON.stringify({ runtime: 'forge', look: { target: { schema: 'gf-look-target/1', from: 'refs', confidence: 0.9, reads: ['x'] } } }));
    assert.equal((await lookInputs(game)).why, null);
    const shot = join(dir, 'shot.jpg'); await writeFile(shot, 'x');
    const fake = r => async () => ({ score: r.score, bar: r.bar, pass: r.score >= (r.bar ?? 0), verdict: r.bar === null ? 'advisory' : r.score >= r.bar ? 'pass' : 'fail', interval: [r.score - 3, r.score + 3], passes: 3, advisory: r.bar === null, confidence: r.bar ? 'refs' : 'words', parts: {}, framings: [], findings: [{ framing: 'wide', line: 'sky too desaturated' }] });
    const low = await checkLook(game, { shots: [shot], score: fake({ score: 41, bar: 60 }), cache: false });
    assert.equal(low.ok, false); assert.match(low.detail, /41\/100.*sky too desaturated.*tune\.mjs/);
    const words = await checkLook(game, { shots: [shot], score: fake({ score: 20, bar: null }), cache: false });
    assert.equal(words.ok, true); assert.match(words.detail, /advisory/);
    const noShots = await checkLook(game, { shots: [], score: fake({ score: 90, bar: 60 }), cache: false });
    assert.equal(noShots.ok, false, 'a target with nothing to hold to it is not a pass');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('surfaces: a reference\'s ground is the band one colour family holds; ours is the band whatever it holds; surface meets surface', async () => {
  const { surfacesOf, compareStats: cmp } = await import('../builder/look/stats.mjs');
  const { judgeStats } = await import('../builder/look/judge.mjs');
  const grass = picture(80, 50, (x, y) => (y < 10 ? [90, 150, 240] : y >= 40 ? [90 + (x % 3) * 40, 200 - (x % 5) * 20, 40] : [220, 120, 160]));
  const candyGround = picture(80, 50, (x, y) => (y < 10 ? [90, 150, 240] : y >= 40 ? [250, 160, 175] : [220, 120, 160]));
  const s = surfacesOf(grass);
  assert.ok(s.sky && s.ground && s.characters);
  const ref = judgeStats(picture(80, 50, (x, y) => (y < 10 ? [90, 150, 240] : y >= 40 ? [100, 220, 80] : [220, 120, 160])), { ref: true });
  assert.ok(ref.surfaces.ground, 'one green holds the reference\'s ground band');
  const g = cmp(judgeStats(grass), ref), c = cmp(judgeStats(candyGround), ref);
  assert.ok(g.parts.ground > c.parts.ground + 15, `green ground ${g.parts.ground} against pink ${c.parts.ground}`);
  assert.ok(c.findings.some(f => /^ground: ours is .*pink|^ground: ours is .*red/.test(f)), c.findings.join(' | '));
});

test('the reads weigh the judged parts: each line counts for the part it is about', async () => {
  const { partWeights } = await import('../builder/look/vision.mjs');
  const w = partWeights(['Big soft skies with puffy clouds at dusk', 'Characters with huge googly eyes and silly hats', 'Explosions of round smoke puffs']);
  assert.deepEqual([w.lighting, w.characters, w.vfx, w.palette], [2, 2, 2, 1]);
  assert.equal(judgedMark({ palette: { match: 0 }, characters: { match: 4 } }, { palette: 1, characters: 3 }), 75);
});

test('looks side by side: each measured alone, the judge sees them together, the ranking follows the score', async () => {
  const { compare } = await import('../builder/look/judge.mjs');
  const pics = { 'a.png': greyed, 'b.png': candy, 'ref.png': candy };
  const px = { read: async f => pics[f.split('/').pop()], extract: async () => Buffer.alloc(0), close: async () => {}, browser: null };
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-cmp-'));
  try {
    for (const f of Object.keys(pics)) await writeFile(join(dir, f), 'x');
    let seen = null;
    const judgeLooks = async (refs, looks) => { seen = looks.map(l => l.id); return { options: Object.fromEntries(looks.map(l => [l.id, { parts: Object.fromEntries(PARTS.map(k => [k, { match: l.id === 'b' ? 3.2 : 1.2, vs: 'par', finding: '' }])) }])), ranking: ['b', 'a'], summary: '' }; };
    const r = await compare([{ id: 'a', game: { frames: [{ file: join(dir, 'a.png'), framing: 'wide' }] } }, { id: 'b', game: { frames: [{ file: join(dir, 'b.png'), framing: 'wide' }] } }],
      null, [{ file: join(dir, 'ref.png'), framing: 'wide' }], { px, judgeLooks, sheetDir: dir });
    assert.deepEqual(seen, ['a', 'b'], 'one call, both looks');
    assert.deepEqual(r.ranking, ['b', 'a']);
    assert.ok(r.looks.b.judged > r.looks.a.judged && r.looks.b.measured > r.looks.a.measured);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('settings: the numbers tell day from cave; a model\'s answer wins; frames given a setting keep it', async () => {
  const { classifyStats, settingsOf } = await import('../builder/look/settings.mjs');
  const day = frameStats(picture(60, 40, (x, y) => (y < 14 ? [120, 180, 250] : [90, 190, 80])));
  const cave = frameStats(picture(60, 40, (x, y) => (x % 9 === 0 && y % 7 === 0 ? [255, 200, 120] : [20, 22, 30])));
  assert.equal(classifyStats(day), 'day'); assert.equal(classifyStats(cave), 'cave');
  const got = await settingsOf([{ file: 'a.jpg', stats: day }, { file: 'b.jpg', stats: cave, setting: 'close' }], { classifyFn: async files => files.map(f => ({ file: f, setting: 'night' })) });
  assert.deepEqual(got.map(g => [g.setting, g.settingBy]), [['day', 'numbers'], ['close', 'given']], 'files that are not on disk are never sent to the model');
});

test('like with like: a reference is paired only within its setting; a setting ours never shows is a finding, not a score', async () => {
  const { pairUp, timeWeights, settingGaps } = await import('../builder/look/judge.mjs');
  const D = frameStats(candy), C = frameStats(greyed);
  const ours = [{ framing: 'hud', setting: 'day', stats: C }, { framing: 'place-cave', setting: 'cave', stats: D }];
  const refs = [{ setting: 'day', stats: D }, { setting: 'cave', stats: D }, { setting: 'night', stats: D }];
  const p = pairUp(refs, ours, { bySetting: true });
  assert.deepEqual(p.map(x => x.ours?.framing ?? null), ['hud', 'place-cave', null], 'the day reference is held to the day frame even though the cave frame measures closer');
  assert.deepEqual(timeWeights(ours), { day: 2, cave: 1 }, 'the player\'s own view is the setting with the most game time');
  assert.match(settingGaps([refs[2]])[0].line, /no frame of ours does/);
});

test('score by setting: each setting against its own references, the whole weighed by game time', async () => {
  const pics = { 'day.png': candy, 'cave.png': greyed };
  const px = { read: async f => pics[f.split('/').pop()], extract: async () => Buffer.alloc(0), close: async () => {}, browser: null };
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-set-'));
  try {
    for (const f of Object.keys(pics)) await writeFile(join(dir, f), 'x');
    const r = await score({ frames: [{ file: join(dir, 'day.png'), framing: 'hud', setting: 'day' }, { file: join(dir, 'cave.png'), framing: 'place-cave', setting: 'cave' }] }, null,
      [{ file: join(dir, 'day.png'), setting: 'day' }, { file: join(dir, 'cave.png'), setting: 'cave' }, { file: join(dir, 'cave.png'), setting: 'ui' }], { px, vision: false, sheet: false, sheetDir: dir });
    assert.deepEqual(Object.keys(r.settings).sort(), ['cave', 'day']);
    assert.ok(r.settings.day.score >= 99 && r.settings.cave.score >= 99, JSON.stringify(r.settings));
    assert.equal(r.settings.day.weight, 2);
    assert.deepEqual(r.missingSettings, ['ui']);
    assert.ok(r.findings.some(f => f.source === 'settings' && f.setting === 'ui'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('tuning by setting: a path replays to any of its steps; a setting\'s tone is its frames\' light, colour, lit surfaces and shadows', async () => {
  const { replay, toneOf, WORLD_LEVERS, caveAnchorsOf, leversOf: levers } = await import('../builder/look/tune.mjs');
  const L = [{ path: 'a', start: 1 }, { path: 'b', start: 2 }];
  assert.deepEqual(replay(L, [{ lever: 'a', value: 3 }, { levers: { a: 4, b: 5 } }, { lever: 'b', value: 6 }].slice(0, 2)), { a: 4, b: 5 });
  assert.deepEqual(replay(L, []), { a: 1, b: 2 });
  const t = toneOf([frameStats(candy), frameStats(greyed)]);
  assert.ok(t.L > 0 && t.C >= 0 && t.shadowL < t.L);
  const world = { world: { cave: 0.06, block: 1.4, spread: 1.8, caveLight: { color: '#5a74a0', strength: 0.07 }, caveFog: '#141c28' } };
  const cave = levers(world, caveAnchorsOf([{ stats: frameStats(greyed) }]), { ...WORLD_LEVERS.cave, group: 'world-cave' });
  assert.ok(cave.some(l => l.path === 'world.cave') && cave.every(l => l.group === 'world-cave'));
});

test('the before/after judge is asked in both orders and its answer is mapped back to before and after', async () => {
  const { beforeAfterPrompt } = await import('../builder/look/vision.mjs');
  const p = beforeAfterPrompt(['r.jpg'], ['x.jpg'], ['y.jpg'], { setting: 'cave' });
  assert.match(p, /closer/); assert.match(p, /better/); assert.match(p, /A look can be closer and worse/);
});

test('a stable verdict: k judge passes averaged, an interval from their spread (never narrower than the measured noise), unsure near the bar', async () => {
  const { NOISE, Z } = await import('../builder/look/judge.mjs');
  const pics = { 'ours.png': greyed, 'ref.png': candy };
  const px = { read: async f => pics[f.split('/').pop()], extract: async () => Buffer.alloc(0), close: async () => {}, browser: null };
  const dir = await mkdtemp(join(tmpdir(), 'gf-look-k-'));
  try {
    for (const f of Object.keys(pics)) await writeFile(join(dir, f), 'x');
    let call = 0, seen = [];
    const judgeAt = m => async pairs => { seen.push(pairs.map(p => p.id).join(',')); const mk = m[call++ % m.length]; return { pairs: pairs.map(p => ({ id: p.id, parts: Object.fromEntries(PARTS.map(k => [k, { match: mk, vs: 'par', finding: '' }])) })), change: [], summary: '' }; };
    const frames = { frames: [{ file: join(dir, 'ours.png'), framing: 'wide' }, { file: join(dir, 'ref.png'), framing: 'hero' }] };
    const refs = [{ file: join(dir, 'ref.png'), framing: 'wide' }, { file: join(dir, 'ref.png'), framing: 'hero' }];
    const run = (marks, k, bar) => { call = 0; seen = []; return score(frames, null, refs, { px, judge: judgeAt(marks), passes: k, sheet: false, sheetDir: dir }); };
    const r = await run([2, 2.4, 1.6], 3);
    assert.equal(r.passes, 3);
    assert.deepEqual(seen, ['1,2', '2,1', '1,2'], 'every other pass reads the pairs in the other order');
    assert.ok(Math.abs(r.framings[0].judged - 50) <= 1, 'the passes\' marks averaged');
    const width = r.interval[1] - r.interval[0];
    assert.ok(width >= 2 * Z * 0.7 * NOISE.judgedSd / Math.sqrt(3) - 0.2, `the interval is never narrower than the measured noise allows (${width})`);
    assert.ok(r.verdict === 'pass' || r.verdict === 'unsure' || r.verdict === 'fail');
    // far below the bar: fail; with the interval on the bar: unsure, which passes the gate
    const low = await run([0, 0, 0], 3);
    assert.equal(low.verdict, 'fail'); assert.equal(low.pass, false);
    const mid = await run([2, 2, 2], 3);
    const near = { ...mid, interval: [mid.bar - 2, mid.bar + 2] };
    assert.equal(near.interval[0] < near.bar && near.interval[1] >= near.bar, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('noise: the spread of repeated scores (mean, sample deviation, range, standard error)', async () => {
  const { spreadOf } = await import('../builder/look/noise.mjs');
  const s = spreadOf([50, 52, 54, 56, 58]);
  assert.deepEqual([s.n, s.mean, s.min, s.max, s.range], [5, 54, 50, 58, 8]);
  assert.ok(Math.abs(s.sd - 3.16) < 0.01 && Math.abs(s.se - 1.41) < 0.01);
  assert.equal(spreadOf([null, undefined]), null);
});
