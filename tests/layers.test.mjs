// The kit's layers (docs/LAYOUT.md): what tests/kits.test.mjs held when kits/ was a mirror of games.fun, now that the
// layers are edited here. The kits a game vendors keep their hashes, there is one copy of each, the engines travel with
// their licences, a game's tree is assembled from the layers without a gap or a double, the Node code's imports resolve,
// nothing reads a games.fun checkout, and the tree passes the public scan (secrets, private words, size).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { GAME_TREE, KIT, gameRelOf, kitPath, repoFileOf, walkKit } from '../builder/tools/lib/paths.mjs';
import { scanOne } from '../scripts/release-cut.mjs';

const at = (...p) => path.join(KIT_ROOT, ...p);
const sha = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const tracked = execFileSync('git', ['-C', KIT_ROOT, 'ls-files', '-s', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean).map(l => { const [meta, file] = l.split('\t'); return { mode: meta.split(' ')[0], file }; });
const files = tracked.map(t => t.file);
const skip = !files.length && 'not a git checkout';

test('the kits a game vendors keep their hashes: each file against its kit.json and its SHA256SUMS', () => {
  for (const kit of ['gf-multiplayer', 'gf-audio', 'gf-assets']) {
    const root = at('builder', kit), source = path.join(root, 'source');
    let n = 0;
    if (existsSync(path.join(source, 'kit.json'))) {
      for (const [f, h] of Object.entries(JSON.parse(readFileSync(path.join(source, 'kit.json'), 'utf8')).files ?? {})) { n++; assert.equal(sha(path.join(source, f)), h, `${kit}/source/${f} differs from its kit.json`); }
    }
    for (const line of readFileSync(path.join(root, 'SHA256SUMS'), 'utf8').trim().split('\n')) {
      const [h, f] = line.trim().split(/\s+\*?/);
      n++; assert.equal(sha(path.join(source, f)), h, `${kit}/source/${f} differs from SHA256SUMS`);
    }
    assert.ok(n > 0, `${kit} has a kit.json or SHA256SUMS to hold it to`);
  }
});

test('one copy of each kit: no version folders, and the multiplayer kit\'s version is the one in its kit.json', async () => {
  for (const kit of ['gf-multiplayer', 'gf-audio', 'gf-assets']) {
    const dirs = readdirSync(at('builder', kit), { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    assert.deepEqual(dirs.filter(d => /^\d+\.\d+\.\d+/.test(d)), [], `${kit} holds a version folder`);
  }
  assert.ok(!existsSync(at('kits')), 'no kits/ mirror');
  const { KIT_VERSION, releasedVersions } = await import('../builder/multiplayer/party/manifest.mjs');
  assert.equal(KIT_VERSION, JSON.parse(readFileSync(at('builder', 'gf-multiplayer', 'source', 'kit.json'), 'utf8')).version);
  assert.deepEqual(await releasedVersions(), [KIT_VERSION]);
});

test('a game\'s tree is assembled from the layers: every part exists, no file twice, each maps back to its game path', async () => {
  for (const [game, dir] of GAME_TREE) assert.ok(existsSync(dir), `${game} → ${path.relative(KIT_ROOT, dir)} is missing`);
  const rels = await walkKit();
  assert.equal(new Set(rels).size, rels.length, 'a file under gf/three/ comes from two layers');
  for (const part of ['mechanics/melee/index.js', 'loops/round/index.js', 'world/world.js', 'ui/menu.js', 'flat/index.js', 'core/boot.js']) {
    assert.ok(rels.includes(part), `gf/three/${part}`);
    assert.equal(gameRelOf(kitPath(KIT, part)), `gf/three/${part}`);
    assert.equal(repoFileOf(`gf/three/${part}`), kitPath(KIT, part));
  }
  assert.equal(path.relative(KIT_ROOT, kitPath(KIT, 'mechanics', 'melee')), path.join('components', 'melee'));
});

test('the forge engine travels with both prebuilt builds as BUILD.json pins them, their crates\' licences and the HUD fonts\' texts', () => {
  const F = at('runtimes', 'forge');
  const build = JSON.parse(readFileSync(path.join(F, 'kit', 'BUILD.json'), 'utf8'));
  assert.deepEqual(Object.keys(build.builds ?? {}).sort(), ['webgl2', 'webgpu'], 'one core, two builds');
  for (const [name, b] of Object.entries(build.builds)) {
    for (const part of ['wasm', 'glue']) assert.equal(sha(path.join(F, 'kit', b[part].file)), b[part].sha256, `${name} ${part} is the file BUILD.json pins`);
    assert.ok(existsSync(path.join(F, 'kit', path.dirname(b.wasm.file), 'LICENSES.md')), `${name}: its crates' licences beside the wasm`);
  }
  for (const f of ['kit/vendor/LICENSE-meshoptimizer', 'hud/fonts/ATTRIBUTION.md', 'hud/fonts/LICENSE-grim-display.txt', 'hud/fonts/LICENSE-grim-text.txt', 'core/Cargo.lock', 'core/LICENSES.md']) assert.ok(existsSync(path.join(F, f)), `runtimes/forge/${f}`);
  assert.ok(!files.some(f => /^runtimes\/forge\/(bench|briefs|fixtures|sandbox|evidence|lookdev\/sheets)\//.test(f)), 'no forge bench, briefs, fixtures, sandbox, evidence or contact sheets');
  assert.ok(!files.some(f => /^runtimes\/forge\/core\/(.*\/)?target\//.test(f)), 'no Rust build output');
});

test('the forge reads its art from the asset library: no art folder of its own, every name it casts is a library asset', { skip }, () => {
  assert.ok(!files.some(f => /^runtimes\/(forge|three)\/(profiles\/[^/]+\/)?library\//.test(f)), 'no runtime keeps an art folder (the library is the only index)');
  const cast = JSON.parse(readFileSync(at('runtimes', 'forge', 'cast.json'), 'utf8'));
  const assets = new Set(files.filter(f => /^library\/packs\/[^/]+\/assets\/[^/]+\.json$/.test(f)).map(f => f.replace(/^library\/packs\/([^/]+)\/assets\/([^/]+)\.json$/, '$1/$2')));
  const packs = new Set([...assets].map(r => r.split('/')[0]));
  for (const [name, ref] of Object.entries(cast.names)) {
    // a private pack (the creator's generated art) is never in the repository; its names resolve on a machine that has it
    if (!packs.has(ref.split('/')[0])) continue;
    assert.ok(assets.has(ref), `cast.json: ${name} → ${ref} is no asset in library/packs`);
  }
});

test('the vista engine travels with its licences, and without the sky-pro clouds', () => {
  const V = at('runtimes', 'vista');
  for (const f of ['core/LICENSE', 'core/ATTRIBUTION.md', 'core/CREDITS.md', 'UPSTREAM.json', 'kit/vendor/LICENSE-meshoptimizer']) assert.ok(existsSync(path.join(V, f)), `runtimes/vista/${f}`);
  assert.match(readFileSync(path.join(V, 'core', 'LICENSE'), 'utf8'), /MIT License/);
  assert.equal(JSON.parse(readFileSync(path.join(V, 'UPSTREAM.json'), 'utf8')).license, 'MIT');
  assert.ok(existsSync(path.join(V, 'core', 'src', 'sky', 'Clouds.js')), 'the core\'s own MIT clouds');
  assert.ok(!files.some(f => f === 'runtimes/vista/core/src/sky/SkyProClouds.js' || f.startsWith('runtimes/vista/core/public/clouds/')), 'no sky-pro-webgpu clouds or noise volumes');
});

// Node code: the builder's own modules, the scripts, the CLI entry, the plugin, the engines' Node tools. A kit module a
// game carries imports by the game's tree instead, and is held by the tree test above.
const PAGE = /^(builder\/(ui|gf-multiplayer|gf-audio|gf-assets|studio|web3\/gf-web3|backend\/gf-backend)\/|runtimes\/(three\/(kit|profiles|character-bench)|forge\/(kit|hud\/fonts)|vista\/(kit|hud|core))\/|components\/|loops\/|worlds\/|examples\/)|(^|\/)vendor\//;
test('every static relative import in the Node code names a file that exists', { skip }, () => {
  const bad = [];
  for (const f of files.filter(f => /\.mjs$/.test(f) && !PAGE.test(f) && /^(builder|scripts|bin|plugin|runtimes|tests)\//.test(f))) {
    const text = readFileSync(at(...f.split('/')), 'utf8');
    for (const m of text.matchAll(/^\s*(?:import|export)\s[^'";]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      if (!existsSync(at(...target.split('/')))) bad.push(`${f} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('nothing reads a games.fun checkout beside this one', { skip }, () => {
  const hits = files.filter(f => /\.(mjs|js|json|sh|yml)$/.test(f) && f !== 'tests/release-cut.test.mjs' && f !== 'tests/layers.test.mjs')
    .filter(f => /\.\.\/games\.fun(?![\w-])|GAMESFUN_REPO/.test(readFileSync(at(...f.split('/')), 'utf8')));
  assert.deepEqual(hits, []);
});

test('the tree passes the public scan: no secret, private word or huge file that the cut\'s allow-list does not explain', { skip }, () => {
  const refused = [];
  for (const f of files) {
    const file = at(...f.split('/'));
    if (!existsSync(file)) continue;
    for (const h of scanOne(f, readFileSync(file))) if (!h.allowed) refused.push(`${f}${h.line ? `:${h.line}` : ''} ${h.id}`);
  }
  assert.deepEqual(refused, []);
});

test('paths are safe on Windows and macOS: length, case, device names; no symlinks', { skip }, () => {
  const lower = new Map();
  for (const f of files) {
    assert.ok(f.length <= 180, `${f} is ${f.length} characters (a clone under a long folder breaks on Windows)`);
    const k = f.toLowerCase();
    assert.ok(!lower.has(k) || lower.get(k) === f, `${f} and ${lower.get(k)} differ only in case`);
    lower.set(k, f);
    for (const seg of f.split('/')) assert.ok(!/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(seg) && !/[<>:"|?*]/.test(seg) && !/[. ]$/.test(seg), `${f}: "${seg}" is not a name Windows allows`);
  }
  assert.deepEqual(tracked.filter(t => t.mode === '120000').map(t => t.file), [], 'symlinks');
});
