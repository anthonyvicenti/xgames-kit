// art harmonize: a pack's assets through the style pass, baked into NEW assets for one look. The originals stay as they
// are (their manifests, previews and binaries are never written); each harmonised copy is its own asset in a derived
// pack, with provenance (`harmonized`: the original, the look, the settings) and its own measured signature, preview
// and validators, so the resolver and the coverage report can offer it like any other asset.
//
//   art harmonize --pack <id> --look <look> [--level <id>] [--style pixel|drawn] [--into <pack>] [--only a,b] [--public] [--dry] [--json]
//
// <look> is a look target (gf-look-target/1 JSON: a spec's look.target, target.mjs --out), a game's config/look.json
// (its harmonize block), a game folder (its config/look.json, else spec.json look.target), or a kind (kinds/<id>.json:
// its packs' measured style). --level holds a target with looks to one of them. --style: the art style of the game the
// pictures go into (a drawn picture in a pixel game is pixelated to 16 texels a metre); left out, each picture's own.
// The derived pack is `<pack>-h-<look name>` (or --into), private unless --public, under the source pack's licence.
// The same numbers run at load time in the three runtime (runtimes/three/kit/look/harmonize.js); a bake is for a
// library variant, a KTX2 or compressed file the runtime cannot recolour, or a look many games share.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { analyze, contractSignature, contractValidated } from './analyze.mjs';
import { packDir } from './config.mjs';
import { kindTarget, styleFit } from './coverage.mjs';
import { loadLibrary } from './library.mjs';
import { clip, schemas } from './manifest.mjs';
import { clean, readSources, refreshPack, writeSources } from './packs.mjs';
import { fetchAsset, put } from './store.mjs';
import { distanceTo, harmonizeGlb, harmonizePng, harmonizeValues } from '../look/harmonize.mjs';
import { targetOfLook } from '../look/looks.mjs';
import { HARMONIZE_VERSION, settingsOfLook } from '../../runtimes/three/kit/look/harmonize-core.js';

export const HARMONIZE_TOOL = `art harmonize ${HARMONIZE_VERSION}`;
const today = () => new Date().toISOString().slice(0, 10);
const slug = s => String(s ?? 'look').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'look';
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
const sha = s => createHash('sha256').update(s).digest('hex');
const isTarget = j => j?.schema === 'gf-look-target/1' || !!j?.palette?.colors;

/**
 * A look, wherever it is written → { name, sha256 (of what was read), target (or null), settings(style) → the pass's
 * settings for an asset of that art style }.
 */
export function readLook(look, { level = null, kindsDir = null, lib = null } = {}) {
  let file = look, json = null, name = null;
  if (existsSync(look) && statSync(look).isDirectory()) {
    const lj = path.join(look, 'config/look.json'), sj = path.join(look, 'spec.json');
    if (existsSync(lj) && readJson(lj).harmonize) file = lj;
    else if (existsSync(sj) && readJson(sj).look?.target) { json = readJson(sj).look.target; name = path.basename(path.resolve(look)); }
    else throw new Error(`${look}: no config/look.json with a harmonize block and no spec.json look.target`);
  } else if (!existsSync(look) && kindsDir && existsSync(path.join(kindsDir, `${look}.json`))) {
    const kind = readJson(path.join(kindsDir, `${look}.json`));
    json = kindTarget(kind, lib ?? []);
    if (!json) throw new Error(`kind ${look}: none of its packs is measured`);
    json = { ...json, materials: { ...(json.materials ?? {}), ...(look === 'pixel' ? { texture: 'pixel', shading: 'pixel' } : {}) } };
    name = look;
  } else if (!existsSync(look)) throw new Error(`no look at ${look} (a target JSON, a config/look.json, a game folder or a kind)`);
  json ??= readJson(file);
  name ??= path.basename(file).replace(/\.json$/, '').replace(/\.target$/, '');
  const hash = sha(JSON.stringify(json));
  if (isTarget(json)) {
    const t = level ? targetOfLook(json, level) : json;
    if (level && !t.level) throw new Error(`the target has no look "${level}" (${(json.looks ?? []).map(x => x.id).join(', ') || 'no looks'})`);
    return { name: level ?? t.level?.id ?? name, sha256: hash, target: t, settings: style => harmonizeValues(t, { style, looks: json.looks }) };
  }
  const s = settingsOfLook(json, level ?? json.level ?? null);
  if (!s) throw new Error(`${file}: its harmonize block asks for nothing (strength 0 or no palette)`);
  return { name: level ?? json.level ?? name, sha256: hash, target: null, settings: () => s };
}

/** The derived pack's id: <pack>-h-<look>, the pack's part shortened to fit 40 characters. */
export function derivedId(packId, look) {
  const tail = `-h-${slug(look)}`;
  return `${packId.slice(0, 40 - tail.length).replace(/[-.]+$/, '')}${tail}`;
}

/** What a 2D asset is drawn as: its own style, else its pack's tags. */
const styleOf = (a, pack) => a.use?.style ?? (a.tags?.includes('pixel') ? 'pixel' : pack.id.includes('pixel') ? 'pixel' : 'drawn');
/** The settings a signature's distance is read against: a signature's top colours. */
const topOf = sig => (sig?.palette?.top ?? []).map(t => ({ hex: t.colour, share: t.share }));

/**
 * Harmonise a pack's assets for one look. → { pack (the derived id), dir, added: [{ref, from, did, before, after}],
 * skipped: [{ref, why}], findings, dry }
 *   opts: { level, style, into, only (ids), visibility, renderer (for 3D previews and signatures: builder/art/render.mjs),
 *           dry (measure and report, write nothing), log }
 */
export async function harmonizePack(config, packId, look, opts = {}) {
  const lib = loadLibrary(config);
  const src = lib.find(p => p.pack.id === packId);
  if (!src) throw new Error(`no pack ${packId}`);
  const L = typeof look === 'string' ? readLook(look, { level: opts.level, kindsDir: config.kindsDir, lib }) : look;
  const id = opts.into ?? derivedId(packId, L.name);
  if (!/^[a-z][a-z0-9.-]{0,39}$/.test(id)) throw new Error(`--into ${id}: a pack id is lower case letters, digits, dots and dashes, at most 40, starting with a letter`);
  const visibility = opts.visibility ?? 'private';
  const def = clean({
    packVersion: 1, id, title: clip(`${src.pack.title} (harmonised: ${L.name})`, 120),
    describe: clip(`${src.pack.id}'s assets moved toward the look "${L.name}" by the style pass (${HARMONIZE_TOOL}): colours, textures and materials; shapes unchanged. The originals stay in ${src.pack.id}.`, 400),
    licence: { ...src.pack.licence, file: undefined }, owner: src.pack.owner, visibility,
    source: { kind: 'own', store: 'xgames-store', retrieved: today(), rebuild: clip(`art harmonize --pack ${packId} --look <the look, sha256 ${L.sha256.slice(0, 16)}>${opts.level ? ` --level ${opts.level}` : ''}${opts.style ? ` --style ${opts.style}` : ''}`, 300) },
    dimension: src.pack.dimension,
    notes: clip(`Derived from ${src.pack.id} by the style pass; each asset's "harmonized" names its original.${visibility === 'private' ? ' Private: kept in the private packs folder, never pushed.' : ''}`, 600),
  });
  const dir = packDir(config, def);
  const sources = readSources(dir);
  const out = { pack: id, dir, look: L.name, added: [], skipped: [], findings: [], dry: !!opts.dry };
  const only = opts.only ? new Set(opts.only) : null;
  const tmp = path.join(os.tmpdir(), `art-harmonize-${process.pid}`);
  await mkdir(tmp, { recursive: true });
  for (const a of src.assets) {
    const ref = `${packId}/${a.id}`;
    if (only && !only.has(a.id)) continue;
    if (a.dimension === 'audio' || a.category === 'font' || a.category === 'clip') { out.skipped.push({ ref, why: `${a.category}: no colours to move` }); continue; }
    const style = a.dimension === '2d' ? (opts.style ?? styleOf(a, src.pack)) : null;
    const settings = L.settings(style);
    if (!settings) { out.skipped.push({ ref, why: 'the look asks nothing of it' }); continue; }
    let file;
    try { file = (await fetchAsset(config, a, src.pack)).path; } catch (e) { out.skipped.push({ ref, why: e.message }); continue; }
    const bytes = readFileSync(file);
    let r;
    try {
      const words = [a.id, a.describe, ...(a.tags ?? [])].join(' ');
      r = a.dimension === '3d'
        ? await harmonizeGlb(bytes, settings, { words })
        : await harmonizePng(bytes, settings, { style, texelsPerMetre: a.use?.texelsPerMetre ?? null, edges: a.category !== 'texture' && a.category !== 'tile', words });
    } catch (e) { out.skipped.push({ ref, why: `the pass failed: ${e.message}` }); continue; }
    if (!r.did.length) { out.skipped.push({ ref, why: 'nothing to change (no colours the pass reads)' }); continue; }
    out.findings.push(...r.findings ?? []);
    // its own variants (a phone copy) go through the same pass, so they still match it
    const variants = [];
    for (const v of a.variants ?? []) {
      try {
        const vb = readFileSync((await fetchAsset(config, { ...a, sha256: v.sha256 }, null, { rebuild: false })).path);
        const vr = a.dimension === '3d' ? await harmonizeGlb(vb, settings, { words: [a.id, a.describe, ...(a.tags ?? [])].join(' ') }) : await harmonizePng(vb, settings, { style, words: [a.id, a.describe].join(' ') });
        if (!opts.dry) await put(config.store, vr.bytes);
        variants.push(clean({ use: v.use, file: v.file, sha256: sha(vr.bytes), bytes: vr.bytes.length, textureMax: v.textureMax }));
      } catch (e) { out.findings.push(`${ref}: its ${v.use} copy was not harmonised (${e.message})`); }
    }
    // both sides measured now, by the same tool (the original's manifest may be older): its signature, its distance to
    // the look's colours of things, and its style fit to the target
    const measure = async (b, name) => {
      const f = path.join(tmp, `${name}.${a.dimension === '3d' ? 'glb' : 'png'}`);
      await writeFile(f, b);
      try { return await analyze(b, { path: f, category: a.category, renderer: opts.renderer, hints: { style, texelsPerMetre: a.use?.texelsPerMetre, plane: a.use?.plane, tile: a.use?.tile, tileSet: a.use?.tileSet, role: a.use?.role, rig: a.use?.rig } }); }
      catch (e) { out.findings.push(`${ref}: not measured (${e.message})`); return null; }
    };
    const was = await measure(bytes, `${a.id}.before`), an = await measure(r.bytes, `${a.id}.after`);
    const after = an ? contractSignature(an.signature) : null;
    const side = m => (m ? { distance: distanceTo(topOf(m.signature), settings), fit: L.target ? styleFit({ fits: { signature: contractSignature(m.signature) } }, L.target) : null, signature: m.signature } : null);
    const measured = { before: side(was), after: side(an) };
    const hash = sha(r.bytes);
    const newId = a.id;
    const manifest = clean({
      ...a, id: newId, pack: id, budgets: an?.budgets ?? a.budgets, file: `${newId}.${a.dimension === '3d' ? 'glb' : 'png'}`, sha256: hash, bytes: r.bytes.length, preview: an?.preview ? `previews/${newId}.png` : null,
      from: clip(`harmonised from ${ref} (${r.did.join(', ')})`, 300),
      tags: [...new Set([...(a.tags ?? []), 'harmonised'])].slice(0, 24),
      validated: an ? an.validated.map(contractValidated).filter(Boolean) : a.validated,
      fits: after ? { signature: after } : undefined,
      source: clean({ ...(a.source ?? {}), modified: clip(`${HARMONIZE_TOOL}: ${r.did.join(', ')} toward the look ${L.name}`, 300), retrieved: today() }),
      variants: variants.length ? variants : undefined,
      harmonized: { from: ref, sha256: a.sha256, look: L.name, lookSha256: L.sha256, tool: HARMONIZE_TOOL, date: today(), did: r.did, settings: { strength: settings.strength, palette: settings.palette, ...(settings.quantize ? { quantize: true } : {}), ...(settings.outline && settings.outline !== 'none' ? { outline: settings.outline } : {}), ...(settings.texelsPerMetre ? { texelsPerMetre: settings.texelsPerMetre } : {}) } },
    });
    for (const p of schemas()?.validateAsset(manifest) ?? []) out.findings.push(`${id}/${newId}: ${p}`);
    out.added.push({ ref: `${id}/${newId}`, from: ref, did: r.did, before: measured.before, after: measured.after, files: { before: path.join(tmp, `${a.id}.before.${a.dimension === '3d' ? 'glb' : 'png'}`), after: path.join(tmp, `${a.id}.after.${a.dimension === '3d' ? 'glb' : 'png'}`), previewBefore: was?.preview ?? null, previewAfter: an?.preview ?? null } });
    if (opts.dry) continue;
    await put(config.store, r.bytes);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    if (an?.preview) { await mkdir(path.join(dir, 'previews'), { recursive: true }); await writeFile(path.join(dir, 'previews', `${newId}.png`), an.preview); }
    await writeFile(path.join(dir, 'assets', `${newId}.json`), JSON.stringify(manifest, null, 1) + '\n');
    sources.assets[newId] = clean({ origin: `${HARMONIZE_TOOL} ${ref} → look ${L.name}`, signature: an?.signature ?? null });
    opts.log?.(`  ${ref} → ${id}/${newId}: ${r.did.join(', ')}`);
  }
  if (!opts.dry && out.added.length) {
    await writeSources(dir, sources);
    const licFile = path.join(src.dir, 'LICENSE.txt');
    const { problems } = await refreshPack(config, def, { licenceText: existsSync(licFile) ? `The licence of ${src.pack.id}, whose assets these are, harmonised:\n\n${readFileSync(licFile, 'utf8').trim()}` : null, validate: schemas()?.validatePack });
    out.findings.push(...problems.map(p => `${id} (pack) ${p}`));
  }
  return out;
}
