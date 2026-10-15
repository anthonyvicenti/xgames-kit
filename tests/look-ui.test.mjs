// The looks layer's HUD and effects half (wave 2): a target's UI facts become the shared HUD's tokens (never per-game
// code), its effect facts pick an effect style the mechanics call, the kinds' own HUDs are unchanged without a target,
// and the reference-name rule: a published game never carries the name of a game it was made to look or play like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { loadSchemas, SCHEMA } from '../registry/schemas.mjs';
import { hudOf, typeOf, fontOf, vfxOf, applyTargetUi, FONTS } from '../builder/look/ui-style.mjs';
import { hudCss, hudVars } from '../builder/ui/kind-hud.js';
import { STYLES, styleFromFacts, presetsOf } from '../runtimes/three/kit/vfx/styles.js';
import { PRESETS } from '../runtimes/three/kit/vfx/presets.js';
import { normalizeShape } from '../runtimes/three/kit/vfx/sim.js';
import * as vfxModule from '../runtimes/three/kit/vfx/module.js';
import { slotsFor } from '../runtimes/three/kit/vfx/slots.js';
import { referenceNames, nameFromWords, findNames, redactText, redactJson, namesMessage } from '../builder/lib/publish/names.mjs';
import { buildTree } from '../builder/lib/publish/tree.mjs';
import { preflight } from '../builder/lib/publish/index.mjs';

const { validate } = await loadSchemas();
const KINDS = readdirSync(join(KIT_ROOT, 'kinds')).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(KIT_ROOT, 'kinds', f), 'utf8')));

/** An inked cartoon target, the shape of the artillery proving case (no game named anywhere). */
const CARTOON = {
  schema: 'gf-look-target/1', from: 'refs', confidence: 0.8,
  ui: { style: 'inked teal dials and badges', font: ['chunky rounded display'], type: 'rounded', accent: ['#ffc020', '#2f8fa8'], panel: '#2a7f9a', corners: 'rounded', ink: 'high', inkColor: '#141414',
    shapes: ['dial', 'bar'], layout: 'corners', widgets: ['radial-dial', 'compass', 'team-cards', 'turn-timer', 'damage-numbers'], motion: 'pop', tags: 'ink-text' },
  vfx: { style: 'clusters of solid round puffs', scale: 'high', palette: ['#f0f0f4', '#e8a030', '#6a5a6a', '#ffd040'], explosion: 'puffs', smoke: 'puffs', debris: 'chunks', sparks: 'stars', rings: true, numbers: 'comic', trail: 'puffs', outline: 'low' },
  reads: ['solid round puffs', 'inked round dials', 'bright sky'], avoid: ['realistic smoke'],
};

test('the target schema holds the UI and effect facts the HUD and the effects are driven by', () => {
  assert.deepEqual(validate(SCHEMA.lookTarget, CARTOON), []);
  assert.ok(validate(SCHEMA.lookTarget, { ...CARTOON, ui: { ...CARTOON.ui, shapes: ['hexagon'] } }).length, 'an unknown shape word is refused');
  assert.ok(validate(SCHEMA.lookTarget, { ...CARTOON, vfx: { ...CARTOON.vfx, explosion: 'nuclear' } }).length, 'an unknown explosion is refused');
});

test('a target\'s UI facts become HUD tokens over the kind\'s: type → a library font, ink, shape, layout, motion, tags, numbers', () => {
  const silly = KINDS.find(k => k.id === 'silly').hud;
  const { tokens, said } = hudOf(CARTOON, silly);
  assert.equal(tokens.font, 'Lilita One');
  assert.equal(tokens.accent, '#ffc020');
  assert.equal(tokens.panel, '#2a7f9af2', 'a heavily inked panel is solid');
  assert.equal(tokens.ink, '#141414'); assert.equal(tokens.inkWidth, 3.5);
  assert.equal(tokens.shape, 'dial'); assert.equal(tokens.layout, 'corners'); assert.equal(tokens.motion, 'pop');
  assert.equal(tokens.tags, 'ink-text'); assert.equal(tokens.numbers, 'comic');
  assert.ok(tokens.widgets.includes('team-cards'));
  assert.ok(said.length >= 8);
  // the stylesheet: the ink on every panel, the clock as a round dial in the bottom right, numbers that pop
  const sheet = hudCss(tokens);
  assert.match(sheet, /font-family:"Lilita One"/);
  assert.match(sheet, /\.gf-timer\{width:74px;height:74px[^}]*border-radius:50%/);
  assert.match(sheet, /\.gf-top\{top:auto;left:auto;right:18px;bottom:18px/);
  assert.match(sheet, /gf-num-comic/);
  assert.match(sheet, /\.gf-plate\{background:transparent/);
  assert.equal(hudVars(tokens)['--gf-ink-w'], '3.5px');
});

test('type classes read from the font words, and every class names fonts the library holds', () => {
  assert.equal(typeOf({ font: ['chunky rounded display'] }), 'rounded');
  assert.equal(typeOf({ font: ['bold comic lettering'] }), 'comic');
  assert.equal(typeOf({ font: ['8-bit pixel caps'] }), 'pixel');
  assert.equal(typeOf({ font: ['clean humanist sans'] }), 'plain');
  assert.equal(typeOf({ font: ['engraved serif'] }), 'serif');
  assert.equal(typeOf({}), null);
  const packs = new Set(readdirSync(join(KIT_ROOT, 'library/packs')));
  for (const [cls, fonts] of Object.entries(FONTS)) for (const f of fonts) assert.ok(packs.has(`ofl-${f.toLowerCase().replace(/\s+/g, '-')}`), `${cls}: ${f} is a library font pack`);
  assert.equal(fontOf('plain'), null, 'plain is the system sans');
});

test('controls: no target leaves every kind\'s HUD exactly as it was; a calm target keeps glass panels; a pixel target stays pixel', () => {
  for (const k of KINDS) {
    if (k.hud.theme) continue;
    const { tokens } = hudOf({ schema: 'gf-look-target/1', reads: ['x'] }, k.hud);
    assert.deepEqual(tokens, k.hud, `${k.id}: a target with no UI facts changes nothing`);
    assert.doesNotMatch(hudCss(k.hud), /gf-in-pop|gf-num-comic|\.gf-top\{/, `${k.id}: the kind's own sheet has no target rules`);
  }
  // a hollow-cave target read as dark glass and a clean sans: translucent panels, the system sans, a thin line
  const glass = hudOf({ ui: { font: ['clean humanist sans'], panel: '#14171c', accent: ['#f0a040'], corners: 'rounded', ink: 'low' } }, KINDS.find(k => k.id === 'blocky').hud).tokens;
  assert.equal(glass.panel, '#14171ccc'); assert.equal(glass.font, undefined); assert.equal(glass.weight, 600); assert.equal(glass.inkWidth, 1.5);
  const px = hudOf({ ui: { font: ['blocky 8-bit pixel caps'], corners: 'square', ink: 'mid' } }, KINDS.find(k => k.id === 'pixel').hud).tokens;
  assert.equal(px.font, 'Silkscreen'); assert.equal(px.pixel, true); assert.equal(px.radius, '2px');
});

test('applyTargetUi writes the tokens and the font into config, keeps a theme, skips the runtimes with their own HUD', async () => {
  const C = { game: { ui: { accent: '#ff5fa2', style: { font: 'Fredoka', radius: '999px', weight: 700, fontFile: 'assets/fonts/fredoka.ttf' } } }, assets: [] };
  const fontFile = async f => ({ file: `/lib/${f}.ttf`, ext: '.ttf', pack: `ofl-${f}` });
  const r = await applyTargetUi(C, { look: { target: CARTOON } }, { place: { runtime: 'three', profile: 'standard-3d' }, fontFile });
  assert.equal(C.game.ui.accent, '#ffc020');
  assert.equal(C.game.ui.style.font, 'Lilita One');
  assert.equal(C.game.ui.style.fontFile, 'assets/fonts/lilita-one.ttf');
  assert.ok(C.assets.some(a => a.to === 'assets/fonts/lilita-one.ttf' && a.license.spdx === 'OFL-1.1'));
  assert.match(r.notes.join(' '), /look target HUD/);
  const themed = { game: { ui: { theme: 'grim' } }, assets: [] };
  assert.match((await applyTargetUi(themed, { look: { target: CARTOON } }, { place: { runtime: 'three' }, fontFile })).notes[0], /theme grim stands/);
  assert.equal(themed.game.ui.style, undefined);
  const forge = { game: { ui: {} }, assets: [] };
  assert.match((await applyTargetUi(forge, { look: { target: CARTOON } }, { place: { runtime: 'forge' }, fontFile })).notes[0], /draws its own HUD/);
  const own = { game: { ui: { accent: '#123456' } }, assets: [] };
  await applyTargetUi(own, { look: { target: CARTOON, palette: ['#123456'] } }, { place: { runtime: 'three' }, fontFile });
  assert.equal(own.game.ui.accent, '#123456', "the spec's own palette keeps its accent");
});

test('effect facts pick a style; each fact swaps its own part; every preset a style names exists', () => {
  const c = styleFromFacts(CARTOON.vfx);
  assert.equal(c.style, 'cartoon');
  assert.ok(c.blast.includes('blast-puffs') && c.blast.includes('blast-chunks') && c.blast.includes('impact-ring'));
  assert.deepEqual(c.hit.slice(0, 1), ['hit-stars']);
  assert.equal(c.trail, 'trail-puffs'); assert.equal(c.numbers, 'comic'); assert.equal(c.scale, 1.35);
  assert.equal(styleFromFacts({ explosion: 'fireball' }).style, 'fiery');
  assert.equal(styleFromFacts({ explosion: 'pixel' }).style, 'pixel');
  assert.equal(styleFromFacts({}).style, 'soft');
  const mixed = styleFromFacts({ explosion: 'puffs', smoke: 'wispy', debris: 'shards', rings: false });
  assert.equal(mixed.blast[0], 'smoke-wisp'); assert.ok(mixed.blast.includes('blast-shards') && !mixed.blast.includes('blast-chunks') && !mixed.blast.includes('impact-ring') && !mixed.blast.includes('blast-puffs'));
  assert.deepEqual(styleFromFacts({ explosion: 'none' }).blast, []);
  for (const s of Object.values(STYLES)) for (const n of presetsOf(s)) assert.ok(PRESETS[n], `${n} is a preset`);
  for (const [n, p] of Object.entries(PRESETS)) {
    const sh = normalizeShape(p.shape);
    if (p.shape.mesh) assert.equal(sh.mesh, p.shape.mesh, n); else assert.ok(p.texture, `${n}: a sprite preset names its sprite`);
    if (p.texture) assert.ok(readdirSync(join(KIT_ROOT, 'runtimes/three/kit/vfx/standin')).includes(`${p.texture}.png`), `${n}: standin/${p.texture}.png`);
  }
  assert.equal(normalizeShape({ mesh: 'boulder' }).mesh, '', 'an unknown mesh is a sprite');
  assert.equal(vfxOf({}), null);
});

test('the vfx module: a target with effect facts gets config fx, the style\'s presets tinted, a slot, and credited sprites', () => {
  const spec = { mechanics: [{ id: 'projectile', params: { splashRadius: 2 } }], look: { target: CARTOON } };
  assert.equal(vfxModule.uses(spec), true);
  assert.equal(vfxModule.uses({ mechanics: [{ id: 'health' }] }), false, 'no target effect facts, no Fx param: no module');
  const { game } = vfxModule.configFor(spec);
  assert.equal(game.fx.style, 'cartoon');
  for (const n of presetsOf(game.fx)) assert.ok(game.vfx[n], n);
  assert.equal(game.vfx['blast-core'].color, '#e8a030', 'the core takes the target\'s second effect colour');
  assert.equal(game.vfx['blast-chunks'].texture, undefined, 'rocks are meshes, not sprites');
  const slots = slotsFor({ game });
  assert.ok(slots.some(s => s.id === 'vfx.style' && s.source.pointer === '/fx'));
  const fiery = vfxModule.configFor({ look: { target: { vfx: { explosion: 'fireball' } } } }).game;
  const files = vfxModule.files(fiery);
  const fb = files.find(f => f.from.endsWith('fireball.png'));
  assert.equal(fb.license.spdx, 'CC-BY-4.0'); assert.match(fb.license.credit, /Quiver/);
  assert.ok(readFileSync(join(KIT_ROOT, 'runtimes/three/kit/vfx/NOTICE-styles'), 'utf8').includes('CC BY 4.0'));
});

// ---- the reference-name rule ----------------------------------------------------------------------------------------

test('names: read from the look refs, the ledger\'s references and its reference rows; found through case, CamelCase and a typo', () => {
  assert.equal(nameFromWords('the same asethetic as Glimmer Valley Rumble that lets people battle for an NFT'), 'Glimmer Valley Rumble');
  assert.equal(nameFromWords('a game like PlopBall'), 'PlopBall');
  const names = referenceNames({
    spec: { look: { refs: [{ sha256: 'a'.repeat(64), game: 'Hollow Cavern' }] } },
    ledger: { references: [{ name: 'Tiny Tank Party' }], rows: [{ about: 'reference', words: 'the same aesthetic as glimer valey rumble' }, { about: 'action', words: 'throw' }] },
  });
  assert.deepEqual(names, ['Hollow Cavern', 'Tiny Tank Party', 'glimer valey rumble']);
  assert.equal(findNames('class GlimmerValleyRumble {}', names)[0]?.found, 'GlimmerValleyRumble', 'the typed name finds the real spelling, in CamelCase');
  assert.equal(findNames('assets/hollow-cavern-logo.png', names)[0]?.found, 'hollow-cavern');
  assert.deepEqual(findNames('Throw tanks at your friends in a hollow, then a cavern', names), [], 'ordinary words apart do not match');
  const warn = findNames('Welcome to Glimmer town', names);
  assert.equal(warn.length, 1); assert.equal(warn[0].warn, true, 'the first word alone is a warning, not a refusal');
  assert.equal(namesMessage(warn.map(h => ({ ...h, path: 'x' }))), null);
  assert.equal(redactText('make it like Tiny Tank Party, please', names), 'make it like a reference game, please');
  assert.deepEqual(redactJson({ prompt: 'like hollow cavern', look: { refs: [{ sha256: 'a', game: 'Hollow Cavern', note: 'a cave' }] } }, names), { prompt: 'like a reference game', look: { refs: [{ sha256: 'a', note: 'a cave' }] } });
});

test('publish: spec.json goes up without the names, a game file that names a reference refuses the publish', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-names-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const spec = { specVersion: 2, title: 'Puff Barrage', prompt: 'make a game with the same aesthetic as Glimmer Valley Rumble that lets people battle', look: { refs: [{ sha256: 'b'.repeat(64), game: 'Glimmer Valley Rumble' }] } };
  await writeFile(join(dir, 'spec.json'), JSON.stringify(spec, null, 2));
  await writeFile(join(dir, 'rules.js'), 'export default { setup() {} };\n');
  await mkdir(join(dir, 'config'));
  await writeFile(join(dir, 'config', 'game.json'), JSON.stringify({ text: { title: 'Puff Barrage' } }));
  const built = await buildTree(dir);
  assert.deepEqual(built.names, ['Glimmer Valley Rumble']);
  assert.deepEqual(built.copied, ['spec.json']);
  const sent = JSON.parse(Buffer.from(built.sources.get(built.tree.files.find(f => f.path === 'spec.json').sha256).data).toString('utf8'));
  assert.equal(sent.prompt, 'make a game with the same aesthetic as a reference game that lets people battle');
  assert.equal(sent.look.refs[0].game, undefined);
  assert.equal(JSON.parse(await readFile(join(dir, 'spec.json'), 'utf8')).prompt, spec.prompt, 'the file on disk keeps the person\'s words');
  const plan = built.sources.get(built.tree.files.find(f => f.path === 'adaptation-plan.json').sha256).data.toString('utf8');
  assert.doesNotMatch(plan, /Glimmer/i, 'the adaptation plan is made from the copy');
  const clean = await preflight(dir, { origin: 'https://example.games' });
  assert.equal(clean.names, null);
  // the game's own words carry the name: refused, with the file and the line
  await writeFile(join(dir, 'config', 'game.json'), JSON.stringify({ text: { title: 'Puff Barrage', how: 'Just like\nGlimmer Valley Rumble!' } }, null, 1));
  const bad = await preflight(dir, { origin: 'https://example.games' });
  assert.match(bad.names, /config\/game\.json:\d+ \("Glimmer Valley Rumble"\)/);
  assert.equal(bad.named.length, 1);
});

test('pitch applyArt: the ground pattern names the file it copied (a real game drew a white ground before)', async t => {
  const { applyArt } = await import('../builder/look/pitch.mjs');
  const { existsSync } = await import('node:fs');
  const dir = await mkdtemp(join(tmpdir(), 'gf-applyart-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'config'));
  await writeFile(join(dir, 'config/characters.json'), JSON.stringify({ roles: { player: { body: 'x.glb' } } }));
  await writeFile(join(dir, 'config/world.json'), JSON.stringify({ ground: { color: '#55aa55' } }));
  const src = join(dir, 'meadow.png'); await writeFile(src, Buffer.from('89504e470d0a1a0a', 'hex'));
  await applyArt(dir, { hero: null, bodies: [], props: [] }, { id: 'meadow-top', file: src, ext: '.png' });
  const w = JSON.parse(await readFile(join(dir, 'config/world.json'), 'utf8'));
  assert.ok(existsSync(join(dir, w.ground.pattern.file)), `the pattern ${w.ground.pattern.file} exists in the game`);
});

test('the vfx stand-ins reach a game only as the files its effect style uses (no flipbook unless the style draws one)', async () => {
  const cartoon = vfxModule.files(vfxModule.configFor({ look: { target: CARTOON } }).game);
  assert.ok(!cartoon.some(f => f.from.endsWith('fireball.png')), 'a cartoon game carries no fireball flipbook');
  assert.ok(vfxModule.files(vfxModule.configFor({ look: { target: { vfx: { explosion: 'fireball' } } } }).game).some(f => f.from.endsWith('fireball.png')));
  const vendor = readFileSync(join(KIT_ROOT, 'builder/tools/lib/vendor.mjs'), 'utf8');
  assert.match(vendor, /\^vfx\\\/standin\\\//, 'gf/three never carries the stand-in folder');
});
