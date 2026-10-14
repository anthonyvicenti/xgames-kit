// art ingest <path|url> --pack <id>: take files into a pack. A file, a folder, a zip or a URL (of a file or a zip).
// For each file: detect the format; optimize a GLB (gltf-transform: dedup, prune, textures capped, meshopt, KTX2 when
// asked) or normalize a PNG; drop it when its sha256 is already in the library; render its preview; run its validator;
// measure its style signature; write its manifest; refresh the pack. A pack is a licence record: when the pack does not
// exist and no licence is given, every file goes to the quarantine folder, never the index.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze, contractSignature, contractValidated, TOOL } from './analyze.mjs';
import { packDir } from './config.mjs';
import { detect, extensionOf } from './detect.mjs';
import { findBySha, loadLibrary, readPack } from './library.mjs';
import { cleanTags, clip, schemas } from './manifest.mjs';
import { glbHasExternal, normalizePng, optimizeGlb, packGlb } from './optimize.mjs';
import { clean, readSources, refreshPack, writeSources } from './packs.mjs';
import { licenceClass, loadPolicy } from './policy.mjs';
import { put, sha256 } from './store.mjs';

// folder names that say nothing about the thing (they still sit in the manifest's `from`)
const FOLDER_NOISE = new Set(['sprites', 'png', 'default', 'double', 'retina', 'hd', 'models', 'glb', 'format', 'gltf', 'fbx', 'obj', 'textures', 'assets', 'art', 'graphics', 'unzipped', 'vector', 'svg']);
const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Glob → RegExp over a forward-slash relative path (** any depth, * one segment, ? one char). */
export function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, base));
    else out.push({ file: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}

/** The input as a list of { file, rel }, with a cleanup. URLs are downloaded, zips unpacked, into a temporary folder. */
export async function expandInput(input, { fetchImpl = fetch } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'art-ingest-'));
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  let file = input, origin = { input };
  if (/^https?:\/\//.test(input)) {
    const r = await fetchImpl(input);
    if (!r.ok) { await cleanup(); throw new Error(`download failed: ${r.status} ${input}`); }
    const bytes = Buffer.from(await r.arrayBuffer());
    file = path.join(tmp, decodeURIComponent(new URL(input).pathname.split('/').pop() || 'download'));
    await writeFile(file, bytes);
    origin = { input, download: input, sha256: sha256(bytes) };
  }
  if (!existsSync(file)) { await cleanup(); throw new Error(`no such file or folder: ${input}`); }
  if (statSync(file).isDirectory()) return { files: walk(file), cleanup, origin };
  const head = await readFile(file);
  if (head.length > 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const dir = path.join(tmp, 'unzipped');
    await mkdir(dir);
    const r = spawnSync('unzip', ['-q', '-o', file, '-d', dir], { encoding: 'utf8' });
    if (r.status !== 0) { await cleanup(); throw new Error(`could not unpack the zip (unzip: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)})`); }
    origin.zipSha256 = origin.sha256 ?? sha256(head);
    return { files: walk(dir), cleanup, origin };
  }
  return { files: [{ file, rel: path.basename(file) }], cleanup, origin };
}

/** What a file is, when the caller did not say: its format, its shape and where it sits in the source. */
export async function guessCategory(kind, rel, bytes) {
  const p = rel.toLowerCase();
  if (kind.dimension === 'audio') return 'sound';
  if (kind.dimension === 'font') return 'font';
  if (kind.dimension === '2d') {
    let w = 0, h = 0, clear = 0;
    try {
      const { sharp } = await import('./deps.mjs');
      const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      w = info.width; h = info.height;
      let n = 0; for (let i = 3; i < data.length; i += 4) if (data[i] < 128) n++;
      clear = n / (w * h);
    } catch {}
    if (w && Math.min(w / 6, h) >= 32 && (w === h * 6 || w * 3 === h * 6)) return 'sprite-sheet';
    // a square from a tile set is a tile when it fills its square; an object on a see-through ground is a picture
    if (/(^|\/)(tiles?|tileset|terrain)(\/|_|-)|(^|\/)tile[_-]?\d/.test(p) && clear < 0.25) return 'tile';
    if (/(^|\/)(textures?|materials?)\//.test(p) || /_(albedo|diff|diffuse|basecolor|a)\.(png|jpe?g)$/.test(p)) return 'texture';
    if (/(^|\/)(fx|effects?|particles?)\//.test(p)) return 'effect';
    if (/(^|\/)cards?\//.test(p)) return 'card';
    return 'picture';
  }
  if (kind.format === 'glb') {
    const len = bytes.readUInt32LE(12), doc = JSON.parse(bytes.toString('utf8', 20, 20 + len));
    const names = (doc.nodes ?? []).map(n => n.name ?? '');
    if ((doc.skins ?? []).length && names.some(n => /hips$/i.test(n))) return 'body';
    if (!(doc.meshes ?? []).length && (doc.animations ?? []).length) return 'clip';
    return 'prop';
  }
  return 'prop';
}

/** Put a file the library refused into the quarantine folder with its reason. */
async function quarantine(config, bytes, rel, why, origin) {
  const hash = sha256(bytes), dir = path.join(config.quarantine, hash);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, path.basename(rel)), bytes);
  await writeFile(path.join(dir, 'record.json'), JSON.stringify({ file: rel, sha256: hash, why, origin, date: today() }, null, 1) + '\n');
  return dir;
}

/**
 * ingest(input, opts) → { pack, added: [ref], duplicates: [{file, of}], quarantined: [{file, why}], skipped: [{file, why}], failed: [{ref, problems}] }
 * opts: config, pack (id), renderer (render.mjs; needed for 3D, KTX2, sounds and fonts), include/exclude (globs),
 *   category, style, plane, texelsPerMetre, tags, describe, id (single file), idFrom ('name' | 'path'),
 *   licence { spdx, author, url, credit } + newPack { title, owner, visibility, describe, source } to start a pack,
 *   asIs (keep bytes as they are), ktx2, maxTexture, policy,
 *   replace (make the asset of the same id again in place, keeping its words), retarget / fix (rig/index.mjs: a body
 *   put on gf-humanoid-1, or corrected), peak (dBFS: a sound lowered to peak there, sound/peak.mjs), collider ('box' |
 *   'cylinder' | 'trunk' | 'none': a prop's collider fitted to its measured size, colliderFor)
 */
export async function ingest(input, opts) {
  const { config, pack: packId, renderer = null } = opts;
  const policy = opts.policy ?? loadPolicy(config.policyFile);
  const S = schemas();
  const out = { pack: packId, added: [], duplicates: [], quarantined: [], skipped: [], failed: [], schemaProblems: [] };
  const { files, cleanup, origin } = await expandInput(input, opts);
  const work = await mkdtemp(path.join(os.tmpdir(), 'art-work-'));
  // a local input is named by its file name only: a public manifest never carries a path on this machine
  const shown = /^https?:\/\//.test(input) ? input : path.basename(input);
  try {
    // the pack: an existing one (public or private), or a new one when a licence record is given
    const lib = loadLibrary(config);
    let entry = lib.find(p => p.pack.id === packId) ?? null;
    let def = entry?.pack ?? null;
    if (!def && opts.licence?.spdx) {
      const c = licenceClass(policy, opts.licence.spdx);
      if (!c?.allowed) throw new Error(`licence ${opts.licence.spdx} is outside the policy (library/policy.json); nothing was taken in`);
      const np = opts.newPack ?? {};
      def = clean({ packVersion: 1, id: packId, title: np.title ?? packId, describe: np.describe, licence: opts.licence, source: np.source ?? (origin.zipSha256 && origin.download ? { kind: 'zip', download: origin.download, sha256: origin.zipSha256, retrieved: today() } : { kind: 'own', store: 'local' }), owner: np.owner ?? 'third-party', visibility: np.visibility ?? 'public', dimension: '3d' });
      if (S) { const probs = S.validatePack({ ...def, dimension: def.dimension }); if (probs.length) throw new Error(`the new pack's record is not valid: ${probs.join('; ')}`); }
    }
    const include = (opts.include ?? []).map(globRe), exclude = (opts.exclude ?? []).map(globRe);
    const chosen = files.filter(f => (!include.length || include.some(r => r.test(f.rel))) && !exclude.some(r => r.test(f.rel)));
    if (!def) {
      for (const f of chosen) {
        const bytes = await readFile(f.file);
        if (!detect(bytes)) continue;
        await quarantine(config, bytes, f.rel, `no licence record: pack "${packId}" does not exist and no --licence was given`, origin);
        out.quarantined.push({ file: f.rel, why: 'no licence record' });
      }
      return out;
    }
    const dir = packDir(config, def);
    const existing = existsSync(path.join(dir, 'pack.json')) ? readPack(dir) : { assets: [] };
    const ids = new Set(existing.assets.map(a => a.id));
    const sources = readSources(dir);
    for (const f of chosen) {
      let bytes = await readFile(f.file);
      let kind = detect(bytes);
      if (!kind) { out.skipped.push({ file: f.rel, why: 'not a format the library takes' }); continue; }
      if (kind.format === 'gltf') { out.skipped.push({ file: f.rel, why: 'a .gltf with separate files: pack it as a GLB first (gltf-transform copy in.gltf out.glb)' }); continue; }
      const did = [], skippedSteps = [];
      if (kind.format === 'glb' && glbHasExternal(bytes)) { bytes = await packGlb(f.file); did.push('its texture files packed inside'); }
      // the id it takes: from the file name (or its path inside the source); with `replace`, the asset of that id is
      // made again in place (its words kept), else the id is made unique in the pack
      const stem = (opts.idFrom === 'path' ? f.rel.replace(/\.[^.]+$/, '') : path.basename(f.rel).replace(/\.[^.]+$/, ''));
      let id = slug(opts.id && chosen.length === 1 ? opts.id : stem) || 'asset';
      if (!/^[a-z0-9]/.test(id)) id = `a-${id}`;
      const replacing = opts.replace ? existing.assets.find(a => a.id === id) ?? null : null;
      // the steps a pack's rebuild line names: a body put on gf-humanoid-1 or corrected, a sound's peak lowered
      if (opts.retarget && kind.format === 'glb') {
        const { RETARGETS } = await import('./rig/index.mjs');
        if (!RETARGETS[opts.retarget]) throw new Error(`no retarget "${opts.retarget}" (have ${Object.keys(RETARGETS).join(', ')})`);
        const r = await RETARGETS[opts.retarget](bytes, { id }); bytes = r.bytes; did.push(...r.did);
      }
      // a plain mesh rigged on an archetype's standard (worm, blob, quadruped, flyer: builder/art/rig/autorig.mjs)
      if (opts.autorig && kind.format === 'glb') {
        const { autorig, RIG_OF } = await import('./rig/autorig.mjs');
        const r = await autorig(bytes, { archetype: opts.autorig, id, height: opts.height ?? null, turn: opts.turn ?? 0, tint: opts.tint ?? null, tintMix: opts.tintMix ?? null });
        bytes = r.bytes; did.push(...r.did);
        opts = { ...opts, rig: opts.rig ?? RIG_OF[opts.autorig], category: opts.category ?? 'body' };
      }
      if (opts.fix && kind.format === 'glb') {
        const { FIXES } = await import('./rig/index.mjs');
        if (!FIXES[opts.fix]) throw new Error(`no fix "${opts.fix}" (have ${Object.keys(FIXES).join(', ')})`);
        const r = await FIXES[opts.fix](bytes, { id }); bytes = r.bytes; did.push(...r.did);
      }
      if (opts.peak != null && kind.dimension === 'audio') {
        const { limitPeak } = await import('./sound/peak.mjs');
        const r = await limitPeak(bytes, { peakDb: Number(opts.peak) });
        bytes = r.bytes; kind = detect(bytes);
        did.push(`lowered ${Math.abs(r.gainDb)} dB so it peaks at ${r.peakDb} dBFS, Ogg Opus 48 kHz (builder/art/sound/peak.mjs)`);
      }
      const category = opts.category ?? await guessCategory(kind, f.rel, bytes);
      // optimize
      if (!opts.asIs && kind.format === 'glb') { const r = await optimizeGlb(bytes, { ktx2: !!opts.ktx2, maxTexture: opts.maxTexture ?? 1024 }); if (r.bytes.length < bytes.length || opts.ktx2) { bytes = r.bytes; did.push(...r.did); } else did.push('kept as given (optimizing made it no smaller)'); skippedSteps.push(...r.skipped); }
      if (!opts.asIs && kind.format === 'png') { const r = await normalizePng(bytes); bytes = r.bytes; did.push(...r.did); }
      const hash = sha256(bytes), srcHash = sha256(await readFile(f.file));
      const self = d => (d && replacing && d.pack.id === def.id && d.asset.id === replacing.id ? null : d);
      const dup = self(findBySha(lib, hash)) ?? self(findBySha(lib, srcHash)) ?? (existing.assets.find(a => a.sha256 === hash && a !== replacing) ? { pack: def, asset: existing.assets.find(a => a.sha256 === hash) } : null);
      if (dup) { out.duplicates.push({ file: f.rel, of: `${dup.pack.id}/${dup.asset.id}` }); continue; }
      if (!replacing) for (let k = 2; ids.has(id); k++) id = `${slug(stem)}-${k}`;
      ids.add(id);
      const stored = await put(config.store, bytes);
      const tmp = path.join(work, `${hash}.${extensionOf(kind.format)}`);
      await writeFile(tmp, bytes); // the renderer and rig-check read a file with its extension
      let r;
      try {
        r = await analyze(bytes, { path: tmp, category, renderer, hints: { style: opts.style, plane: opts.plane, tileSet: opts.tileSet, texelsPerMetre: opts.texelsPerMetre, poseBody: opts.poseBody, role: opts.role, ambient: opts.ambient, solid: opts.solid ?? false, rig: opts.rig ?? 'gf-humanoid-1' } });
      } finally { await rm(tmp, { force: true }); }
      const words = stem.split(/[\/_\-\s.]+/).filter(w => w.length > 1 && !/^\d+$/.test(w));
      const folders = path.dirname(f.rel).split('/').flatMap(d => d.split(/[_\-\s.]+/)).map(w => w.toLowerCase()).filter(w => w.length > 1 && !FOLDER_NOISE.has(w));
      // a body on the standard plays the shared clips and carries the standard's sockets (RIG.md); a replaced asset
      // keeps what its manifest said that this run does not measure
      // a creature's body (CREATURES.md) plays no clip file: its archetype says how it moves
      const creature = { 'gf-worm-1': 'worm', 'gf-blob-1': 'blob', 'gf-quadruped-1': 'quadruped', 'gf-flyer-1': 'flyer' }[opts.rig ?? ''] ?? null;
      const standard = category === 'body' && (opts.rig ?? 'gf-humanoid-1') === 'gf-humanoid-1' ? { clips: 'humanoid-clips/gf-humanoid-1', sockets: ['head', 'hand_r', 'hand_l', 'back'] }
        : category === 'body' && creature ? { archetype: creature, sockets: ['head', 'hand_r', 'hand_l', 'back'] } : {};
      const collider = category === 'prop' && opts.collider ? colliderFor(opts.collider, r.use?.size) : null;
      const use = clean({ ...(replacing?.use ?? {}), ...standard, ...r.use, ...(collider ? { collider } : {}), ...(opts.style ? { style: opts.style } : {}), ...(category === 'tile' ? (opts.tileSet ? { tile: false, tileSet: opts.tileSet } : { tile: true }) : {}), ...(category === 'sprite-sheet' && opts.plane ? { plane: opts.plane } : {}), ...(category === 'body' ? { rig: opts.rig ?? 'gf-humanoid-1', origin: 'feet', facing: '+z' } : {}), ...(category === 'prop' ? { origin: 'feet', facing: '+z' } : {}) });
      const describe = opts.describe && chosen.length === 1 ? opts.describe : replacing?.describe ?? `${words.join(' ').toLowerCase() || id}${category === 'tile' ? ' tile' : ''}`;
      const manifest = clean({
        assetVersion: 1, id, pack: def.id, file: `${id}.${extensionOf(kind.format)}`, sha256: hash, bytes: bytes.length, preview: `previews/${id}.png`,
        from: clip(`${opts.from ? `${opts.from}: ` : ''}${f.rel}${did.length ? `; ${did.join(', ')}` : ''}`, 300), dimension: r.dimension, category, describe: clip(describe),
        tags: cleanTags([...(opts.tags ?? []), ...(replacing?.tags ?? [...words.map(w => w.toLowerCase()), ...folders])]), use, budgets: r.budgets,
        validated: r.validated.map(contractValidated).filter(Boolean), fits: { signature: contractSignature(r.signature) },
        source: clean({ ...(replacing?.source ?? {}), ...(origin.download && !origin.zipSha256 ? { download: origin.download } : {}), ...(srcHash !== hash ? { sha256: srcHash } : {}), ...(did.length ? { modified: clip(did.join(', '), 300) } : {}), retrieved: today() }),
      });
      if (S) for (const p of S.validateAsset(manifest)) out.schemaProblems.push(`${def.id}/${id} ${p}`);
      await mkdir(path.join(dir, 'assets'), { recursive: true });
      await mkdir(path.join(dir, 'previews'), { recursive: true });
      await writeFile(path.join(dir, 'previews', `${id}.png`), r.preview);
      await writeFile(path.join(dir, 'assets', `${id}.json`), JSON.stringify(manifest, null, 1) + '\n');
      sources.assets[id] = clean({ ...(replacing ? { ...sources.assets[id], replaced: { sha256: replacing.sha256, date: today() } } : {}), origin: `ingest ${shown}${f.rel !== path.basename(origin.input) ? ` → ${f.rel}` : ''}`, signature: r.signature, validated: r.validated, skippedSteps: skippedSteps.length ? skippedSteps : undefined });
      out.added.push(`${def.id}/${id}`);
      if (manifest.validated?.some(v => !v.ok)) out.failed.push({ ref: `${def.id}/${id}`, problems: manifest.validated.filter(v => !v.ok).flatMap(v => v.report?.problems ?? []) });
    }
    if (out.added.length || !existsSync(path.join(dir, 'pack.json'))) {
      await writeSources(dir, sources);
      const { problems } = await refreshPack(config, def, { licenceText: opts.licenceText ?? null, licenceFile: opts.licenceFile ?? null, validate: S?.validatePack });
      out.schemaProblems.push(...problems.map(p => `${def.id} (pack) ${p}`));
    }
    return out;
  } finally { await cleanup(); await rm(work, { recursive: true, force: true }); }
}

export const INGEST_TOOL = TOOL;

/**
 * A prop's collider from its measured size (metres, base at y = 0, centred over x = z = 0, as fitProp and the library's
 * props are): 'box' (a building, a wall, a crate: its footprint a little inside the model), 'cylinder' (a tower, a
 * mesa, a drum), 'trunk' (a tree: the trunk only; the scenery adds a ball for the canopy), 'none' (held things, grass).
 * → use.collider, or null when there is no size to fit it to.
 */
export function colliderFor(shape, size) {
  if (shape === 'none') return { shape: 'none' };
  if (!Array.isArray(size) || size.length !== 3 || !size.every(n => n > 0)) return null;
  const [x, y, z] = size, r3 = n => +n.toFixed(3), wide = Math.max(x, z);
  if (shape === 'box') return { shape: 'box', size: [r3(x * 0.9), r3(y), r3(z * 0.9)], offset: [0, r3(y / 2), 0] };
  if (shape === 'cylinder') return { shape: 'cylinder', radius: r3(wide * 0.45), height: r3(y), offset: [0, r3(y / 2), 0] };
  if (shape === 'trunk') return { shape: 'cylinder', radius: r3(Math.max(0.12, wide * 0.08)), height: r3(y * 0.6), offset: [0, r3(y * 0.3), 0] };
  throw new Error(`no collider shape "${shape}" (box, cylinder, trunk, none)`);
}
