// Art makers (builder/art): the table, the order of choice, the PNG codec, the pixel grid, the SVG refusals, the intake
// checks, the request → take flow through a real slot, and the key adapters against the documented shapes
// (tests/art/*.fixture.json: NOT recordings; no key was on the build machine). No test here calls a service or a model.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { conceptCheck, modelCheck, pictureCheck, sheetCheck, tileCheck } from '../builder/art/checks.mjs';
import { gridProblems, rasteriseGrid } from '../builder/art/grid.mjs';
import { blank, decodePng, encodePng, scaleDown, scaleUp, stats } from '../builder/art/png.mjs';
import { artDoctor, chooseMaker, detectAgent, loadProviders, providerProblems } from '../builder/art/providers.mjs';
import { artMake, artRequest, artTake, kindOfSlot, requestText } from '../builder/art/session.mjs';
import { sizeFor, STANDARD } from '../builder/art/standard.mjs';
import { svgProblems } from '../builder/art/svg.mjs';
import { runDoctor } from '../builder/lib/doctor.mjs';
import { tempDir, tempGame } from './helpers.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = async name => JSON.parse(await readFile(path.join(here, 'art', `${name}.fixture.json`), 'utf8'));
const fill = (pic, x0, y0, w, h, [r, g, b, a = 255]) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const i = (y * pic.width + x) * 4; pic.data[i] = r; pic.data[i + 1] = g; pic.data[i + 2] = b; pic.data[i + 3] = a; } return pic; };

/** A plain but valid side-on sheet: a block figure 26 tall on the bottom edge, legs that differ per frame. */
function goodSheet(cell = 32) {
  const pic = blank(cell * 6, cell), k = cell / 32;
  STANDARD.sheet.frames.forEach((name, i) => {
    const x = i * cell, lift = name === 'air' ? 4 * k : 0;
    if (name === 'down') { fill(pic, x + 4 * k, cell - 8 * k, 24 * k, 8 * k, [230, 230, 230]); return; }
    fill(pic, x + 11 * k, cell - 26 * k - lift, 10 * k, 20 * k, [230, 230, 230]);
    fill(pic, x + (name === 'walk1' ? 9 : 11) * k, cell - 6 * k - lift, 4 * k, 6 * k, [40, 40, 60]);
    fill(pic, x + (name === 'walk2' ? 19 : 17) * k, cell - 6 * k - lift, 4 * k, 6 * k, [40, 40, 60]);
    if (name === 'act') fill(pic, x + 21 * k, cell - 20 * k, 4 * k, 3 * k, [240, 180, 140]);
  });
  return pic;
}

test('providers.json is valid, and a broken table says what is wrong', () => {
  const data = loadProviders();
  assert.deepEqual(providerProblems(data), []);
  assert.deepEqual(data.order, ['provided', 'library', 'connection', 'session', 'stand-in']);
  for (const p of data.providers.filter(p => p.reach.via === 'env')) assert.ok(p.adapter && p.cost.checked && p.licence.checked, p.id);
  const bad = structuredClone(data);
  const row = id => bad.providers.find(p => p.id === id);
  row('openai-images').reach.env = []; row('meshy').tier = 'magic'; bad.providers.push({ ...bad.providers[0] });
  const problems = providerProblems(bad).join('\n');
  assert.match(problems, /reach\.env/); assert.match(problems, /tier/); assert.match(problems, /duplicate id/);
});

test('every adapter a row names exists and exports plan and make', async () => {
  for (const p of loadProviders().providers.filter(p => p.adapter)) {
    const m = await import(`../builder/art/adapters/${p.adapter}.mjs`);
    assert.equal(typeof m.plan, 'function', p.id); assert.equal(typeof m.make, 'function', p.id);
  }
});

test('the order of choice past the library: provided → a connection → the session → stand-ins', () => {
  const none = {};
  assert.equal(chooseMaker({ kind: 'picture', provided: 'x.png', env: { OPENAI_API_KEY: 'k' }, agent: 'claude' }).maker.id, 'provided');
  assert.equal(chooseMaker({ kind: 'picture', env: { OPENAI_API_KEY: 'k' }, agent: 'claude' }).maker.id, 'openai-images');
  assert.equal(chooseMaker({ kind: 'picture', env: none, agent: 'claude' }).maker.id, 'session-draws');
  assert.equal(chooseMaker({ kind: 'picture', env: none, agent: 'codex' }).maker.id, 'session-image-tool');
  assert.equal(chooseMaker({ kind: 'sheet', env: { OPENAI_API_KEY: 'k' }, agent: 'codex' }).maker.id, 'session-draws', 'no picture service is offered a body sheet');
  assert.equal(chooseMaker({ kind: 'tile', style: 'pixel', env: { OPENAI_API_KEY: 'k' }, agent: 'codex' }).maker.id, 'session-draws', 'pixel art is drawn as a grid, not shrunk from a painting');
  assert.equal(chooseMaker({ kind: 'model', env: none, envFile: {}, agent: 'claude' }).maker.id, 'stand-in');
  assert.equal(chooseMaker({ kind: 'model', env: none, envFile: { MESHY_API_KEY: 'k' }, agent: 'claude' }).maker.id, 'meshy', 'the kit\'s .env is Meshy\'s documented place');
  assert.equal(chooseMaker({ kind: 'model', env: { MESHY_API_KEY: 'k', TRIPO_API_KEY: 'k' }, envFile: {} }).maker.id, 'meshy', 'several: the first row');
  assert.equal(chooseMaker({ kind: 'model', env: { MESHY_API_KEY: 'k', TRIPO_API_KEY: 'k', GF_ART_MODEL: 'tripo' }, envFile: {} }).maker.id, 'tripo', 'several: the one the person names');
  const c = chooseMaker({ kind: 'picture', env: { OPENAI_API_KEY: 'k', GF_ART_PICTURE: 'connection:higgsfield' }, agent: 'claude' });
  assert.equal(c.maker.id, 'connection'); assert.equal(c.connection, 'higgsfield');
  assert.equal(chooseMaker({ kind: 'picture', env: { OPENAI_API_KEY: 'k', GF_ART_PICTURE: 'session' }, agent: 'claude' }).maker.id, 'session-draws');
  assert.equal(chooseMaker({ kind: 'picture', env: { GF_ART_PICTURE: 'stand-in' }, agent: 'claude' }).maker.id, 'stand-in');
  const why = chooseMaker({ kind: 'model', env: none, envFile: {}, agent: 'claude' });
  assert.ok(why.passedOver.some(p => p.id === 'meshy' && /MESHY_API_KEY is not set/.test(p.why)));
});

test('a key is only ever "set or not": no value reaches a choice, a doctor line or a ticket', async () => {
  const secret = 'sk-THIS-MUST-NOT-APPEAR-0123456789';
  const env = { OPENAI_API_KEY: secret, MESHY_API_KEY: secret, TRIPO_API_KEY: secret };
  const t = await tempDir();
  try {
    const r = await artRequest({ out: path.join(t.dir, 'a.png'), kind: 'picture', style: 'drawn', subject: 'a crate', env, agent: 'claude', stateDir: t.dir });
    const all = JSON.stringify([chooseMaker({ kind: 'picture', env }), chooseMaker({ kind: 'model', env }), artDoctor({ env }), r, await readFile(path.join(t.dir, 'tickets', `${r.ticket}.json`), 'utf8')]);
    assert.ok(!all.includes(secret));
    assert.equal(r.maker, 'openai-images'); assert.match(r.next, /ask/i);
  } finally { await t.cleanup(); }
});

test('doctor has one art line, and it names the maker and why', async () => {
  const line = artDoctor({ env: {}, envFile: {}, agent: 'claude' });
  assert.equal(line.status, 'ok'); assert.match(line.detail, /your own session draws them/); assert.match(line.detail, /MESHY_API_KEY/);
  assert.match(artDoctor({ env: { OPENAI_API_KEY: 'k' }, envFile: {}, agent: 'claude' }).detail, /OpenAI Images API \(OPENAI_API_KEY is set/);
  const d = await runDoctor({ graphics: false, probes: { detected: [], chrome: null, playwright: { installed: true, path: 'x' }, git: 'git', ports: [[5180, true]], writable: {}, bridge: { id: 'bridge', label: 'Studio bridge', status: 'ok', detail: '', fix: null } } });
  assert.equal(d.items.filter(i => i.id === 'art').length, 1);
});

test('which agent: from the MCP client\'s name, else the environment', () => {
  assert.equal(detectAgent({ env: {}, client: 'claude-code' }), 'claude');
  assert.equal(detectAgent({ env: {}, client: 'codex-mcp-client' }), 'codex');
  assert.equal(detectAgent({ env: { CLAUDECODE: '1' } }), 'claude');
  assert.equal(detectAgent({ env: {} }), null);
});

test('png: what is written is what is read; shrinking and enlarging', () => {
  const pic = fill(fill(blank(8, 4), 0, 0, 8, 4, [10, 20, 30, 0]), 2, 1, 3, 2, [200, 100, 50, 255]);
  const back = decodePng(encodePng(pic));
  assert.equal(back.width, 8); assert.equal(back.height, 4); assert.ok(back.data.equals(pic.data)); assert.equal(back.hadAlpha, true);
  assert.equal(stats(back).drawn, 6); assert.deepEqual(stats(back).box, { x: 2, y: 1, w: 3, h: 2, right: 3, bottom: 1 });
  assert.equal(scaleUp(pic, 3).width, 24); assert.equal(stats(scaleUp(pic, 3)).drawn, 54);
  const small = scaleDown(fill(blank(64, 64), 16, 16, 32, 32, [255, 0, 0]), 16, 16);
  assert.equal(stats(small).drawn, 64); assert.equal(small.data[(5 * 16 + 5) * 4], 255);
  assert.throws(() => decodePng(Buffer.from('not a png at all')), /not a PNG/);
});

test('a pixel grid: problems are named; a good one becomes pixels', () => {
  const g = { format: 'gamesfun-pixel-grid/1', size: [4, 2], palette: { '.': null, a: '#ff0000' }, frames: { picture: ['.aa.', 'a..a'] } };
  assert.deepEqual(gridProblems(g, { size: [4, 2] }), []);
  const pic = rasteriseGrid(g);
  assert.equal(stats(pic).drawn, 4); assert.equal(pic.data[4], 255); assert.equal(pic.data[3], 0);
  assert.match(gridProblems({ ...g, frames: { picture: ['.aa.', 'a.a'] } }).join(), /row 2 is 3 characters; it needs 4/);
  assert.match(gridProblems({ ...g, frames: { picture: ['.aa.', 'a..z'] } }).join(), /"z", which is not in the palette/);
  assert.match(gridProblems(g, { size: [8, 8] }).join(), /the request asked for \[8, 8\]/);
  assert.match(gridProblems(g, { frames: ['idle', 'walk1'] }).join(), /frame "idle" is missing/);
  assert.match(gridProblems({ ...g, palette: { '.': null, a: 'red' } }).join(), /not a colour/);
});

test('an SVG is refused when it could run, reach outside itself, or depends on a font', () => {
  const ok = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><defs><g id="a"><rect width="4" height="4"/></g></defs><use href="#a"/><rect fill="url(#g)" width="1" height="1"/></svg>';
  assert.deepEqual(svgProblems(ok, { box: [128, 128] }), []);
  const bad = inner => svgProblems(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">${inner}</svg>`, { box: [128, 128] }).join('\n');
  assert.match(bad('<script>alert(1)</script>'), /no <script>/);
  assert.match(bad('<rect onload="x()"/>'), /event attributes/);
  assert.match(bad('<image href="https://example.com/a.png"/>'), /no <image>/);
  assert.match(bad('<use href="https://example.com/a.svg#x"/>'), /only links to parts of this SVG/);
  assert.match(bad('<rect fill="url(https://example.com/p)"/>'), /only url\(#id\)/);
  assert.match(bad('<text>hi</text>'), /no <text>/);
  assert.match(bad('<foreignObject/>'), /foreignObject/);
  assert.match(svgProblems(ok, { box: [256, 256] }).join(), /the request asked for "0 0 256 256"/);
  assert.match(svgProblems('<p>hello</p>').join(), /not an SVG/);
});

test('the sheet check (gf-flat-1): a good sheet passes; each rule fails for its own reason', () => {
  for (const cell of [32, 64]) assert.deepEqual(sheetCheck(goodSheet(cell), { plane: 'side', style: 'pixel' }).problems, [], `cell ${cell}`);
  const problems = (edit, opts = {}) => { const p = goodSheet(); edit(p); return sheetCheck(p, { plane: 'side', style: 'pixel', ...opts }).problems.join('\n'); };
  assert.match(sheetCheck(blank(160, 32), {}).problems.join(), /6 square cells in one row/);
  assert.match(problems(p => fill(p, 32, 0, 32, 32, [0, 0, 0, 0])), /"walk1": the cell is empty/);
  assert.match(problems(p => { fill(p, 0, 0, 32, 32, [0, 0, 0, 0]); fill(p, 11, 2, 10, 20, [230, 230, 230]); }), /"idle": the lowest drawn pixel is 10 above the bottom edge/);
  assert.match(problems(p => { fill(p, 0, 0, 32, 32, [0, 0, 0, 0]); fill(p, 11, 1, 10, 31, [230, 230, 230]); }), /"idle": the figure is 31 of 32 pixels tall/);
  assert.match(problems(p => { fill(p, 64, 0, 32, 32, [0, 0, 0, 0]); for (let y = 0; y < 32; y++) p.data.copy(p.data, (y * 192 + 64) * 4, (y * 192 + 32) * 4, (y * 192 + 64) * 4); }), /"walk1" and "walk2" are the same picture/);
  assert.match(problems(p => { fill(p, 96, 0, 32, 32, [0, 0, 0, 0]); for (let y = 0; y < 32; y++) p.data.copy(p.data, (y * 192 + 96) * 4, (y * 192) * 4, (y * 192 + 32) * 4); }), /"idle" and "air" are the same picture/);
  assert.match(problems(p => { fill(p, 128, 0, 32, 32, [0, 0, 0, 0]); fill(p, 0 + 128, 6, 10, 26, [230, 230, 230]); }), /"act": the figure is \d+ pixels left of the middle/);
  assert.match(problems(p => fill(p, 10, 8, 12, 12, [200, 200, 200, 128])), /half see-through/);
  assert.match(problems(() => {}, { cell: 64 }), /the request asked for 64x64/);
  // drawn: the 2-pixel margin
  const d = goodSheet(256); fill(d, 256, 100, 2, 40, [10, 10, 10]);
  assert.match(sheetCheck(d, { plane: 'side', style: 'drawn' }).problems.join(), /"walk1": \d+ drawn pixels in the 2-pixel margin/);
  // top-down: the centre, not the feet
  const top = blank(192, 32); STANDARD.sheet.frames.forEach((n, i) => fill(top, i * 32 + 8 + (n === 'walk1' ? 1 : 0), 8 + (n === 'air' ? 1 : 0), 16, 16, [230, 230, 230]));
  assert.deepEqual(sheetCheck(top, { plane: 'top', style: 'pixel' }).problems, []);
});

test('a picture: empty, no see-through ground, cut off at an edge', () => {
  const good = fill(blank(16, 16), 3, 3, 10, 10, [200, 150, 50]);
  assert.deepEqual(pictureCheck(good, { size: [16, 16], style: 'pixel' }).problems, []);
  assert.match(pictureCheck(blank(16, 16)).problems.join(), /nothing is drawn/);
  assert.match(pictureCheck(fill(blank(16, 16), 0, 0, 16, 16, [9, 9, 9])).problems.join(), /no see-through ground/);
  assert.match(pictureCheck(fill(blank(16, 16), 0, 3, 10, 10, [9, 9, 9])).problems.join(), /runs off the left edge/);
  assert.match(pictureCheck(good, { size: [32, 32] }).problems.join(), /it must be 32x32/);
});

test('a tile: see-through pixels and a seam are refused; a tile that wraps passes', () => {
  const flat = fill(blank(16, 16), 0, 0, 16, 16, [90, 168, 69]);
  fill(flat, 4, 4, 2, 2, [63, 138, 58]); fill(flat, 10, 9, 2, 2, [124, 196, 90]);
  assert.deepEqual(tileCheck(flat, { size: [16, 16], style: 'pixel' }).problems, []);
  const holes = fill(blank(16, 16), 0, 0, 16, 16, [90, 168, 69]); fill(holes, 5, 5, 3, 3, [0, 0, 0, 0]);
  assert.match(tileCheck(holes, { style: 'pixel' }).problems.join(), /9 pixels are see-through/);
  const seam = fill(blank(16, 16), 0, 0, 16, 16, [90, 168, 69]); fill(seam, 15, 0, 1, 16, [20, 20, 20]);
  assert.match(tileCheck(seam, { style: 'pixel' }).problems.join(), /left and right edges do not continue/);
  const drawn = tileCheck(seam, { style: 'drawn' });
  assert.equal(drawn.ok, true, 'in drawn art a seam is a warning (gf-flat-1 §4)'); assert.match(drawn.warnings.join(), /left and right/);
});

test('a concept picture is checked before a model is paid for', () => {
  const good = fill(fill(blank(512, 512), 0, 0, 512, 512, [255, 255, 255]), 128, 96, 256, 320, [120, 80, 40]);
  assert.deepEqual(conceptCheck(good).problems, []);
  assert.match(conceptCheck(fill(fill(blank(512, 512), 0, 0, 512, 512, [255, 255, 255]), 0, 96, 400, 416, [120, 80, 40])).problems.join(), /touches|corners/);
  assert.match(conceptCheck(fill(fill(blank(512, 512), 0, 0, 512, 512, [255, 255, 255]), 250, 250, 12, 12, [0, 0, 0])).problems.join(), /fill most of the frame/);
  assert.match(conceptCheck(blank(64, 64)).problems.join(), /at least 256x256/);
});

/** The smallest GLB with `triangles` triangles declared (no geometry bytes are needed to count them). */
function glb(triangles) {
  let json = JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], accessors: [{ count: triangles * 3, type: 'VEC3', componentType: 5126 }, { count: triangles * 3, type: 'SCALAR', componentType: 5125 }] });
  while (json.length % 4) json += ' ';
  const head = Buffer.alloc(20);
  head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length, 8); head.writeUInt32LE(json.length, 12); head.write('JSON', 16, 'latin1');
  return Buffer.concat([head, Buffer.from(json)]);
}

test('a model: a triangle budget by role', () => {
  assert.equal(modelCheck(glb(9000), { role: 'prop' }).ok, true);
  assert.equal(modelCheck(glb(9000), { role: 'prop' }).facts.triangles, 9000);
  assert.match(modelCheck(glb(90000), { role: 'prop' }).problems.join(), /90000 triangles: a prop gets at most 15000/);
  assert.equal(modelCheck(glb(30000), { role: 'body' }).ok, true);
  assert.match(modelCheck(Buffer.from('nope, not a model at all'), {}).problems.join(), /not a GLB/);
});

test('the request says everything a maker needs: size, frames, view, feet, tint, palette, the answer\'s form', () => {
  const [w, h] = sizeFor('sheet', 'pixel');
  const text = requestText({ kind: 'sheet', style: 'pixel', plane: 'side', subject: 'a fox', size: [w, h], cell: h, palette: ['#112233'], direction: 'cosy', answer: 'grid' });
  for (const want of ['a fox', '6 square cells of 32x32', 'idle', 'walk1', 'walk2', 'air', 'act', 'down', 'FACING RIGHT', 'bottom 2 rows', '#e0e0e0', '#112233', 'cosy', 'gamesfun-pixel-grid/1', 'LOOK']) assert.ok(text.includes(want), want);
  const svg = requestText({ kind: 'tile', style: 'drawn', subject: 'sand', size: [128, 128], answer: 'svg' });
  assert.match(svg, /viewBox="0 0 128 128"/); assert.match(svg, /No <text>/); assert.match(svg, /comes back in on the left/);
});

test('request → take through a real slot: a refusal names the fix, a pass is written to the slot\'s own file', async () => {
  const g = await tempGame();
  try {
    const stateDir = path.join(g.root, 'state'), slot = 'world.backyard.ground.pattern';
    const assets = JSON.parse(await readFile(path.join(g.dir, 'assets.json'), 'utf8'));
    const row = assets.slots.find(s => s.id === slot);
    assert.equal(kindOfSlot(row), 'tile');
    const file = path.join(g.dir, ...row.source.file.split('/'));
    const before = await readFile(file), was = decodePng(before);
    // the asset library comes first: it has a striped lawn pattern; asked for a new one, the session draws it
    const lib = await artRequest({ game: g.dir, slot, subject: 'striped lawn', style: 'drawn', env: {}, agent: 'claude', stateDir });
    assert.equal(lib.maker, 'library'); assert.match(lib.pick.ref, /lawn/); assert.match(lib.next, /--library/);
    const r = await artRequest({ game: g.dir, slot, subject: 'striped lawn', style: 'drawn', fresh: true, env: {}, agent: 'claude', stateDir });
    assert.equal(r.maker, 'session-draws'); assert.equal(r.answer, 'svg'); assert.deepEqual(r.size, [was.width, was.height], 'the stand-in\'s own size is kept');
    assert.match(r.request, new RegExp(`viewBox="0 0 ${was.width} ${was.height}"`));
    // a second request reuses the game's style anchor
    assert.equal((await artRequest({ game: g.dir, slot, subject: 'again', env: {}, agent: 'claude', stateDir })).style, 'drawn');
    // handed back as a file (so this test needs no browser): first a wrong one, then a right one
    const bad = path.join(g.root, 'bad.png'), good = path.join(g.root, 'good.png');
    await writeFile(bad, encodePng(fill(blank(was.width, was.height), 0, 0, was.width, was.height >> 1, [90, 168, 69])));
    const refused = await artTake(r.ticket, { file: bad, stateDir });
    assert.equal(refused.ok, false); assert.match(refused.problems.join(), /see-through/);
    assert.ok((await readFile(file)).equals(before), 'a refused picture never reaches the slot');
    await writeFile(good, encodePng(fill(blank(was.width * 2, was.height * 2), 0, 0, was.width * 2, was.height * 2, [90, 168, 69])));
    const kept = await artTake(r.ticket, { file: good, stateDir });
    assert.equal(kept.ok, true, kept.problems.join()); assert.equal(kept.written.slot, slot);
    const now = decodePng(await readFile(file));
    assert.deepEqual([now.width, now.height], [was.width, was.height], 'a bigger picture is shrunk to the slot'); assert.equal(now.data[0], 90);
    assert.match(await readFile(path.join(stateDir, 'ledger.jsonl'), 'utf8'), /"maker":"session-draws"/);
    // the library's pick, taken: its own file and licence, through the slot
    const took = await artTake(lib.ticket, { library: true, stateDir });
    assert.equal(took.ok, true, took.problems.join()); assert.equal(took.written.slot, slot);
    assert.match(await readFile(path.join(stateDir, 'ledger.jsonl'), 'utf8'), /"maker":"library"/);
    await assert.rejects(artRequest({ game: g.dir, slot: 'character.body.player', subject: 'x', kind: 'sheet', env: {}, stateDir }), /holds a \.glb file; art made here is PNG/);
  } finally { await g.cleanup(); }
});

test('take with a pixel grid: a whole body sheet, no browser', async () => {
  const t = await tempDir();
  try {
    const out = path.join(t.dir, 'body.png');
    const r = await artRequest({ out, kind: 'sheet', style: 'pixel', subject: 'a block person', env: {}, agent: 'claude', stateDir: t.dir });
    assert.equal(r.answer, 'grid');
    const sheet = goodSheet(), rows = i => Array.from({ length: 32 }, (_, y) => Array.from({ length: 32 }, (_, x) => { const k = (y * 192 + i * 32 + x) * 4; return !sheet.data[k + 3] ? '.' : sheet.data[k] > 200 ? 'w' : sheet.data[k] > 100 ? 's' : 'd'; }).join(''));
    const grid = { format: 'gamesfun-pixel-grid/1', size: [32, 32], palette: { '.': null, w: '#e6e6e6', s: '#f0b48c', d: '#28283c' }, frames: Object.fromEntries(STANDARD.sheet.frames.map((n, i) => [n, rows(i)])) };
    const missing = await artTake(r.ticket, { grid: JSON.stringify({ ...grid, frames: { idle: grid.frames.idle } }), stateDir: t.dir });
    assert.equal(missing.ok, false); assert.match(missing.problems.join(), /frame "walk1" is missing/);
    const kept = await artTake(r.ticket, { grid: JSON.stringify(grid), stateDir: t.dir });
    assert.equal(kept.ok, true, kept.problems.join());
    const pic = decodePng(await readFile(out));
    assert.deepEqual([pic.width, pic.height], [192, 32]);
    assert.ok(decodePng(await readFile(kept.look)).width >= 192, 'a picture to look at comes back');
  } finally { await t.cleanup(); }
});

test('OpenAI Images adapter against the documented shape (fixture; NOT run against the service)', async () => {
  const fx = await fixture('openai-images'), t = await tempDir();
  try {
    const out = path.join(t.dir, 'crate.png'), env = { OPENAI_API_KEY: 'test-key' };
    const r = await artRequest({ out, kind: 'picture', style: 'drawn', subject: 'a wooden crate', env, agent: 'claude', stateDir: t.dir });
    assert.equal(r.maker, 'openai-images');
    const calls = [];
    const png = encodePng(fill(blank(1024, 1024), 256, 256, 512, 512, [160, 110, 60]));
    const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ...fx.response, data: [{ b64_json: png.toString('base64') }] }) }; };
    const asked = await artMake(r.ticket, { env, fetch, stateDir: t.dir });
    assert.equal(asked.paid, false); assert.equal(calls.length, 0, 'nothing is called without yes'); assert.equal(asked.plan.body.background, 'transparent');
    const made = await artMake(r.ticket, { yes: true, env, fetch, stateDir: t.dir });
    assert.equal(made.ok, true, made.problems?.join()); assert.equal(made.paid, true); assert.equal(made.cost.tokens.output_tokens, 272);
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations'); assert.equal(calls[0].init.headers.authorization, 'Bearer test-key');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'gpt-image-2.5-flare'); assert.equal(body.output_format, 'png'); assert.match(body.prompt, /a wooden crate/); assert.equal(body.response_format, undefined);
    assert.deepEqual((({ width, height }) => [width, height])(decodePng(await readFile(out))), [128, 128]);
    assert.ok(!JSON.stringify(made).includes('test-key'));
    const refuse = async () => ({ ok: false, status: 401, json: async () => fx.error });
    await assert.rejects(artMake(r.ticket, { yes: true, env, fetch: refuse, stateDir: t.dir }), /refused the request \(401\): Incorrect API key/);
    await assert.rejects(artMake(r.ticket, { yes: true, env: {}, fetch, stateDir: t.dir }), /OPENAI_API_KEY is not set/);
  } finally { await t.cleanup(); }
});

test('Tripo adapter against the documented shape (fixture; NOT run against the service), with the intake check after', async () => {
  const fx = await fixture('tripo'), t = await tempDir();
  try {
    const out = path.join(t.dir, 'barrel.glb'), env = { TRIPO_API_KEY: 'test-key' };
    const r = await artRequest({ out, kind: 'model', subject: 'a wooden barrel', env, envFile: {}, agent: 'claude', stateDir: t.dir });
    assert.equal(r.maker, 'tripo');
    const adapters = { tripo: { ...(await import('../builder/art/adapters/tripo.mjs')) } };
    const real = adapters.tripo.make; adapters.tripo.make = (tk, row, o) => real(tk, row, { ...o, pollMs: 1 });
    const server = model => { let polls = 0; const calls = []; return { calls, fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (url.endsWith('/generation/text-to-model')) return { ok: true, json: async () => fx.create };
      if (url.includes('/tasks/')) return { ok: true, json: async () => (polls++ ? fx.success : fx.running) };
      return { ok: true, arrayBuffer: async () => model };
    } }; };
    const big = server(glb(90000));
    const over = await artMake(r.ticket, { yes: true, env, fetch: big.fetch, stateDir: t.dir, adapters });
    assert.equal(over.ok, false); assert.match(over.problems.join(), /a prop gets at most 15000/); assert.equal(over.paid, true, 'the spend is reported even when the model is refused');
    const s = server(glb(9000));
    const made = await artMake(r.ticket, { yes: true, env, fetch: s.fetch, stateDir: t.dir, adapters });
    assert.equal(made.ok, true, made.problems?.join()); assert.equal(made.cost.credits, 100);
    assert.equal(s.calls[0].url, 'https://openapi.tripo3d.com/v3/generation/text-to-model'); assert.equal(s.calls[0].init.headers.authorization, 'Bearer test-key');
    assert.equal(JSON.parse(s.calls[0].init.body).face_limit, 12000, 'the budget is asked for up front');
    assert.equal(s.calls[1].url, 'https://openapi.tripo3d.com/v3/tasks/task_abc123');
    assert.equal((await readFile(out)).toString('latin1', 0, 4), 'glTF');
    assert.match(await readFile(path.join(t.dir, 'spend.jsonl'), 'utf8'), /"maker":"tripo"/);
    const none = { fetch: async () => ({ ok: true, json: async () => fx.noCredits }) };
    await assert.rejects(artMake(r.ticket, { yes: true, env, fetch: none.fetch, stateDir: t.dir, adapters }), /not enough credits/);
    const ban = { fetch: async url => ({ ok: true, json: async () => (url.includes('/tasks/') ? fx.banned : fx.create) }) };
    await assert.rejects(artMake(r.ticket, { yes: true, env, fetch: ban.fetch, stateDir: t.dir, adapters }), /ended as "banned"/);
  } finally { await t.cleanup(); }
});

test('a bad concept picture stops a model before anything is paid', async () => {
  const t = await tempDir();
  try {
    const env = { TRIPO_API_KEY: 'k' }, concept = path.join(t.dir, 'concept.png');
    await writeFile(concept, encodePng(fill(fill(blank(512, 512), 0, 0, 512, 512, [255, 255, 255]), 250, 250, 12, 12, [0, 0, 0])));
    const r = await artRequest({ out: path.join(t.dir, 'm.glb'), kind: 'model', subject: 'a lamp', env, envFile: {}, stateDir: t.dir });
    let called = 0;
    const res = await artMake(r.ticket, { yes: true, image: concept, env, fetch: async () => { called++; throw new Error('must not be called'); }, stateDir: t.dir });
    assert.equal(res.ok, false); assert.equal(res.paid, false); assert.equal(called, 0); assert.match(res.problems.join(), /the concept picture/);
  } finally { await t.cleanup(); }
});

test('SVG → PNG in the browser (opt in: GF_ART_BROWSER=1; it starts Chrome)', { skip: !process.env.GF_ART_BROWSER }, async () => {
  const { rasteriseSvg } = await import('../builder/art/svg.mjs');
  const pic = await rasteriseSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="999"><rect x="16" y="16" width="32" height="32" fill="#ff0000"/></svg>', 64, 64);
  assert.deepEqual([pic.width, pic.height], [64, 64]);
  assert.equal(pic.data[3], 0, 'see-through where nothing is drawn');
  const i = (32 * 64 + 32) * 4; assert.deepEqual([...pic.data.subarray(i, i + 4)], [255, 0, 0, 255]);
});
