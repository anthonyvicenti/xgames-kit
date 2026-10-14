#!/usr/bin/env node
// optimize.mjs: make a GLB a lean gf-humanoid-1 body (or just a lean GLB).
//
//   node builder/tools/optimize.mjs <in.glb> <out.glb> [--normalize] [--height <m>] [--texture <px>]
//        [--tint <material,...>] [--rough <0-1>] [--no-meshopt] [--keep-animations]
//
//   --normalize   put the rig on gf-humanoid-1 (tools/lib/char-gltf.mjs normalizeBody): canonical bone names
//                 (Meshy, Mixamo, Rigify/UAL and Quaternius rigs are recognised), canonical parents, metres, Y up,
//                 facing +Z, feet at the origin, identity joint frames; unweighted helpers dropped
//   --height      standing height in metres (default: keep; centimetre rigs are scaled by 0.01)
//   --texture     cap textures at this many pixels (default 1024); JPEG unless the alpha is used
//   --tint        rename these materials to tint_<name> so the kit tints them per player
//   --tint-mix    how far the tint replaces their colour, 0–1 (default 1; detailed bodies look better around 0.4)
// Always: Meshy's emissive copy of the albedo removed, dedup, prune, weld, then quantize + meshopt (KTX2 is not
// produced here: toktx is not installed; see RIG.md §7). Prints the size and runs rig-check when normalising.
import { isMain } from './lib/main.mjs';
import './lib/char-node.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { io, gltfCore } from './lib/char-deps.mjs';
import { normalizeBody, bodyStats, disposeAnimation } from './lib/char-gltf.mjs';
import { optimizeDoc } from './lib/char-optimize.mjs';

/** In-memory version: bytes in, { bytes, report, notes, stats } out. */
export async function optimizeBody(bytes, { normalize = false, height, texture = 1024, tint = [], tintMix, rough, meshopt = true, keepAnimations = false, extras = {} } = {}) {
  const nio = await io();
  const doc = await nio.readBinary(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  let report = null;
  if (normalize) report = normalizeBody(doc, { height, keepAnimations });
  else if (!keepAnimations) for (const a of doc.getRoot().listAnimations()) disposeAnimation(a);
  for (const m of doc.getRoot().listMaterials()) if (tint.includes(m.getName())) m.setName(`tint_${m.getName()}`);
  const root = doc.getRoot().listNodes().find(n => n.getName() === 'gf_body');
  const tintNames = doc.getRoot().listMaterials().map(m => m.getName()).filter(n => /^tint/i.test(n));
  if (root) root.setExtras({ ...root.getExtras(), gfRig: 'gf-humanoid-1', ...(tintNames.length ? { gfTint: tintNames } : {}), ...(tintMix != null ? { gfTintMix: tintMix } : {}), ...extras });
  const notes = await optimizeDoc(doc, { textureSize: texture, meshopt, roughness: rough });
  const out = await nio.writeBinary(doc);
  return { bytes: out, report, notes, stats: bodyStats(doc, out.length) };
}

if (isMain(import.meta)) {
  const args = process.argv.slice(2);
  const val = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const flags = new Set(['--normalize', '--no-meshopt', '--keep-animations']);
  const pos = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !flags.has(args[i - 1])));
  if (pos.length < 2) { console.error('usage: optimize.mjs <in.glb> <out.glb> [--normalize] [--height m] [--texture px] [--tint a,b] [--rough r]'); process.exit(2); }
  const [inp, outp] = pos.map(p => resolve(p));
  const r = await optimizeBody(readFileSync(inp), {
    normalize: args.includes('--normalize'), height: val('--height') ? +val('--height') : undefined, texture: val('--texture') ? +val('--texture') : 1024,
    tint: (val('--tint') ?? '').split(',').filter(Boolean), tintMix: val('--tint-mix') ? +val('--tint-mix') : undefined, rough: val('--rough') ? +val('--rough') : undefined,
    meshopt: !args.includes('--no-meshopt'), keepAnimations: args.includes('--keep-animations'),
  });
  mkdirSync(dirname(outp), { recursive: true });
  writeFileSync(outp, r.bytes);
  console.log(`${outp}  ${(r.bytes.length / 1024).toFixed(0)} KB  ${Math.round(r.stats.triangles)} tris  ${r.stats.joints} joints  ${r.stats.materials} materials`);
  if (r.report) console.log(`  normalised: ${JSON.stringify(r.report.fix)} height ${r.report.height} m; renamed ${r.report.renamed.length}; dropped ${r.report.dropped.join(', ') || '-'}; merged ${r.report.merged.join(', ') || '-'}`);
  for (const n of r.notes) console.log(`  ${n}`);
  if (r.report) {
    const { rigCheck } = await import('./rig-check.mjs');
    const c = await rigCheck(outp);
    console.log(`  rig-check: ${c.ok ? 'PASS' : 'FAIL'}${c.errors.map(e => `\n    error: ${e}`).join('')}${c.warnings.map(w => `\n    warn:  ${w}`).join('')}`);
    process.exitCode = c.ok ? 0 : 1;
  }
}
