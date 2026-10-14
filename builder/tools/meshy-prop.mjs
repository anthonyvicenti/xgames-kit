#!/usr/bin/env node
// meshy-prop.mjs: a sentence or a reference image → a game prop (Meshy image-to-3D, no rig, lean GLB in metres).
//
//   node builder/tools/meshy-prop.mjs --prompt "a giant glowing gold coin on a pedestal" --out token.glb [--size 1.6]
//   node builder/tools/meshy-prop.mjs --image ref.png --out token.glb [--describe "what to keep"] [--no-concept]
//        [--id token] [--polycount 6000] [--texture 1024] [--dry-run]
//   node builder/tools/meshy-prop.mjs --fit any.glb --out prop.glb --size 1.6     (normalise only: no Meshy, no credits)
//   import { generateProp, fitProp } from './meshy-prop.mjs';    // the Studio worker runs the CLI (lib/v2.mjs startGenerated)
//
// The spec's world.props[].from 'generate' | 'reference' (creator, Hang Up On Them, 2026-10-07: the token to defend was a
// 3 KB crate stand-in because the worker never generated props). Steps, as meshy-character.mjs does for bodies:
//   1. concept: one picture of the object alone, whole, three-quarter view, plain background (text-to-image from the
//      words, or image-to-image from the reference). --no-concept sends a clean reference straight to image-to-3D.
//   2. image-to-3D: textured, remeshed (~6k triangles), no rig.
//   3. fitProp: one root node `gf_prop` (extras gfProp, gfSource 'meshy', gfSize): metres, Y up, base at y = 0, centred in x
//      and z, its largest side scaled to --size (the prop's size in the game; the kit fits a replacement again when it
//      draws it); Meshy's emissive copy of the albedo removed, textures capped, dedup/weld/meshopt (optimize.mjs's path).
//   4. a sidecar <out>.json: licence, tasks, credits, size, the words or reference it was made from.
// Cost: about 36 credits (6 + 30). Every paid task is in library/meshy-ledger.jsonl and the wave's cap (GF_MESHY_WAVE,
// GF_MESHY_CAP; tools/lib/char-meshy.mjs) is checked before each one. Licence: Meshy output, unconfirmed tier, recorded as
// LicenseRef-Meshy-Paid: the creator's paid plan, confirmed 2026-10-10 (the same record as meshy-character.mjs).
// Exit 0 made, 1 failed (Meshy or the network: worth one retry), 2 bad usage, 3 refused (the credit cap, or no key: no retry).
import { isMain } from './lib/main.mjs';
import './lib/char-node.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as meshy from './lib/char-meshy.mjs';
import { io, gltfCore } from './lib/char-deps.mjs';
import { optimizeDoc } from './lib/char-optimize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = b => createHash('sha256').update(b).digest('hex');
const mime = p => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[extname(p).toLowerCase()] ?? 'image/png');
/** Exit code 3: a refusal another try would meet again (the cap, a missing key). */
export const REFUSED = /Meshy cap|MESHY_API_KEY/;

/** The object alone: "a giant glowing gold coin on a pedestal in the middle of the office" → "... on a pedestal". */
export const objectWords = s => String(s ?? '').replace(/\s+(?:in|at|near|by|beside|behind|inside|outside|around|along)\s+(?:the\s+)?(?:middle|centre|center|corner|corners|edge|edges|side|sides|back|front|end|entrance|room|office|park|plaza|arena|yard|backyard)\b.*$/i, '').trim();

export function conceptPrompt({ prompt, describe, image = false } = {}) {
  const what = prompt ? objectWords(prompt) : 'the object in the reference picture';
  return [`A single 3D game prop: ${what}.`,
    'The whole object in view, three-quarter view from slightly above, standing upright on its own base, centred in the frame.',
    describe ? `Keep these details: ${describe}.` : image ? 'Keep the same shape, colours and details as the reference.' : '',
    'Chunky, readable stylised game art: clear shapes and bold colours; no characters, no hands, no text or logos.',
    'Even soft lighting, plain white background, no floor, no shadow, no other objects.'].filter(Boolean).join(' ').slice(0, 1500);
}

/** Triangles and the size of the scene's bounds (metres) of a glTF-Transform document. */
function stats(doc) {
  let tris = 0;
  for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) { const i = p.getIndices(), pos = p.getAttribute('POSITION'); tris += (i ? i.getCount() : pos?.getCount() ?? 0) / 3; }
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const b = gltfCore.getBounds(scene);
  return { triangles: Math.round(tris), size: [0, 1, 2].map(k => +(b.max[k] - b.min[k]).toFixed(3)), min: b.min.map(v => +v.toFixed(3)) };
}

/**
 * Any GLB → a game prop: one root node `gf_prop` (extras), its largest side `size` metres, base at y = 0, centred in x
 * and z; clips and skins dropped; lean (textures capped, meshopt). → { bytes, report: {size, min, triangles, scale}, notes }
 */
export async function fitProp(bytes, { size = 1, texture = 1024, rough = 0.8, extras = {} } = {}) {
  if (!(size > 0)) throw new Error(`fitProp: size must be a positive number of metres (got ${size})`);
  const nio = await io();
  const doc = await nio.readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  for (const a of doc.getRoot().listAnimations()) a.dispose();      // a prop plays no clips
  for (const n of doc.getRoot().listNodes()) if (n.getSkin()) n.setSkin(null);
  for (const s of doc.getRoot().listSkins()) s.dispose();
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  if (!scene) throw new Error('fitProp: the GLB has no scene');
  const root = doc.createNode('gf_prop');
  for (const n of scene.listChildren()) { scene.removeChild(n); root.addChild(n); }
  scene.addChild(root);
  const b = gltfCore.getBounds(scene);
  const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  if (!(span > 0) || !Number.isFinite(span)) throw new Error('fitProp: the model is empty');
  const k = size / span;
  root.setScale([k, k, k]).setTranslation([-k * (b.min[0] + b.max[0]) / 2, -k * b.min[1], -k * (b.min[2] + b.max[2]) / 2]);
  root.setExtras({ ...root.getExtras(), gfSize: size, ...extras });
  const notes = await optimizeDoc(doc, { textureSize: texture, meshopt: true, roughness: rough });
  const out = await nio.writeBinary(doc);
  return { bytes: out, report: { ...stats(doc), scale: +k.toFixed(5) }, notes };
}

/**
 * { prompt | image, out, id, describe, size = 1, concept = true, polycount = 6000, texture = 1024, dryRun, onProgress }
 * → { ok, file, sidecar, id, credits, tasks, report, work }
 */
export async function generateProp(opts) {
  const { image = null, prompt = null, out, describe = null, concept = true, size = 1, polycount = 6000, texture = 1024, dryRun = false, onProgress = m => process.stderr.write(`\r${m}      `) } = opts;
  if (!image && !prompt) throw new Error('generateProp: give image or prompt');
  if (!out) throw new Error('generateProp: give out (a .glb path)');
  const id = opts.id ?? basename(out, '.glb');
  const work = resolve(here, '../../.gamesfun/meshy', `prop-${id}`);
  mkdirSync(work, { recursive: true });
  const plan = [...(prompt && !image ? ['text-to-image'] : concept ? ['image-to-image'] : []), 'image-to-3d'];
  const estimate = plan.reduce((a, k) => a + meshy.COST[k], 0);
  const before = meshy.spent();
  if (before + estimate > meshy.CAP) throw new Error(`Meshy cap: ${before} credits spent in ${meshy.WAVE}; about ${estimate} credits for this prop would pass the ${meshy.CAP}-credit cap. Stopped before any call.`);
  if (dryRun) return { ok: true, dryRun: true, plan, estimate, spent: before, cap: meshy.CAP, wave: meshy.WAVE, conceptPrompt: conceptPrompt({ prompt, describe, image: !!image }) };

  const tasks = {};
  const refBytes = image ? readFileSync(image) : null;
  // 1. concept
  let conceptTask = null;
  if (prompt && !image) {
    conceptTask = await meshy.create('text-to-image', '/v1/text-to-image', { ai_model: 'nano-banana-2', prompt: conceptPrompt({ prompt, describe }), aspect_ratio: '1:1', remove_background: true }, `${id} prop-concept`);
    const t = await meshy.wait('/v1/text-to-image', conceptTask, `${id} prop-concept`, { onProgress });
    tasks.concept = { id: conceptTask, endpoint: 'text-to-image', credits: t.consumed_credits };
    await meshy.download(t.image_urls[0], resolve(work, 'concept.png'));
  } else if (concept) {
    conceptTask = await meshy.create('image-to-image', '/v1/image-to-image', { ai_model: 'nano-banana-2', prompt: conceptPrompt({ prompt, describe, image: true }), reference_image_urls: [meshy.dataUri(refBytes, mime(image))], aspect_ratio: '1:1', remove_background: true }, `${id} prop-concept`);
    const t = await meshy.wait('/v1/image-to-image', conceptTask, `${id} prop-concept`, { onProgress });
    tasks.concept = { id: conceptTask, endpoint: 'image-to-image', credits: t.consumed_credits };
    await meshy.download(t.image_urls[0], resolve(work, 'concept.png'));
  }
  // 2. image to 3D, no rig
  const to3dBody = { ai_model: 'latest', should_remesh: true, topology: 'triangle', target_polycount: polycount, should_texture: true, enable_pbr: false,
    ...(conceptTask ? { input_task_id: conceptTask } : { image_url: meshy.dataUri(refBytes, mime(image)) }) };
  const to3d = await meshy.create('image-to-3d', '/v1/image-to-3d', to3dBody, `${id} prop-image-to-3d`);
  const t3 = await meshy.wait('/v1/image-to-3d', to3d, `${id} prop-image-to-3d`, { onProgress });
  tasks.to3d = { id: to3d, credits: t3.consumed_credits };
  const raw = await meshy.download(t3.model_urls.glb, resolve(work, 'model.glb'));
  if (t3.thumbnail_url) await meshy.download(t3.thumbnail_url, resolve(work, 'model-thumb.png')).catch(() => {});
  process.stderr.write('\n');
  // 3. metres, base at 0, the prop's size, lean
  const r = await fitProp(raw, { size, texture, extras: { gfProp: id, gfSource: 'meshy' } });
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), r.bytes);
  const credits = Object.values(tasks).reduce((a, t) => a + (t.credits ?? 0), 0);
  // 4. sidecar
  const sidecar = {
    id, kind: 'prop', file: basename(out), from: image ? 'reference' : 'generate', tags: ['generated', 'meshy'],
    describe: describe ?? prompt ?? 'generated from a reference image', size,
    license: { spdx: 'LicenseRef-Meshy-Paid', author: 'Meshy AI (generated for games.fun)', url: 'https://www.meshy.ai',
      note: 'Meshy output generated on the creator\'s paid Meshy plan (the creator, 2026-10-10: "They are paid"); under Meshy\'s paid-plan terms the output belongs to the account holder, so no attribution is required (STUDIO_BUILD_PLAYBOOK §5)' },
    meshy: { wave: meshy.WAVE, tasks, credits, polycount, concept: !!conceptTask, generated: new Date().toISOString() },
    reference: image ? { file: image, sha256: sha(refBytes) } : null, prompt: prompt ?? null,
    model: { bytes: r.bytes.length, sha256: sha(Buffer.from(r.bytes)), triangles: r.report.triangles, size: r.report.size },
  };
  const sidecarPath = resolve(out).replace(/\.glb$/, '.json');
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2) + '\n');
  return { ok: true, file: resolve(out), sidecar: sidecarPath, id, credits, tasks, report: r.report, notes: r.notes, work };
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  const val = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const out = val('--out');
  const size = val('--size') ? +val('--size') : 1;
  const usage = 'usage: meshy-prop.mjs (--prompt "<text>" | --image <png>) --out <glb> [--size m] [--describe ..] [--id ..] [--no-concept] [--polycount n] [--dry-run]\n       meshy-prop.mjs --fit <in.glb> --out <glb> --size m';
  if (!out || !(size > 0) || !(val('--image') || val('--prompt') || val('--fit'))) { console.error(usage); process.exit(2); }
  try {
    if (val('--fit')) {
      const r = await fitProp(readFileSync(resolve(val('--fit'))), { size, texture: val('--texture') ? +val('--texture') : 1024, extras: { gfProp: val('--id') ?? basename(out, '.glb') } });
      mkdirSync(dirname(resolve(out)), { recursive: true });
      writeFileSync(resolve(out), r.bytes);
      console.log(`${resolve(out)}  ${(r.bytes.length / 1024).toFixed(0)} KB  ${r.report.triangles} tris  ${r.report.size.join(' x ')} m`);
      process.exit(0);
    }
    const r = await generateProp({ image: val('--image') && resolve(val('--image')), prompt: val('--prompt'), out, id: val('--id'), describe: val('--describe'), size,
      concept: !a.includes('--no-concept'), polycount: val('--polycount') ? +val('--polycount') : 6000, texture: val('--texture') ? +val('--texture') : 1024, dryRun: a.includes('--dry-run') });
    if (r.dryRun) { console.log(JSON.stringify(r, null, 1)); process.exit(0); }
    console.log(`PASS ${r.file}  ${r.credits} credits  ${r.report.triangles} tris  ${r.report.size.join(' x ')} m  (${meshy.WAVE}: ${meshy.spent()} / ${meshy.CAP})`);
    console.log(`  work files: ${r.work}`);
  } catch (e) {
    console.error(`\nmeshy-prop: ${e.message}`);
    process.exit(REFUSED.test(e.message) ? 3 : 1);
  }
}
