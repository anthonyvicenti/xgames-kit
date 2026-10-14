// Making a file fit to ship before it is kept: a GLB through gltf-transform (dedup, prune, textures capped, meshopt
// compression, and KTX2 textures when asked and toktx is on this machine); a PNG re-encoded as plain 8-bit RGBA with
// no metadata. → { bytes, did: [plain words], skipped: [plain words] }
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sharp } from './deps.mjs';

let deps = null;
async function gltf() {
  if (deps) return deps;
  const d = await import('./deps.mjs');
  await d.MeshoptDecoder.ready; await d.MeshoptEncoder.ready;
  deps = { core: d.gltfCore, ext: d.gltfExt, fn: d.gltfFn, mo: { MeshoptDecoder: d.MeshoptDecoder, MeshoptEncoder: d.MeshoptEncoder, MeshoptSimplifier: d.MeshoptSimplifier }, io: await d.io() };
  return deps;
}

/** toktx (KTX-Software) if this machine has it: XGAMES_TOKTX, then PATH. */
export function findToktx(env = process.env) {
  if (env.XGAMES_TOKTX && existsSync(env.XGAMES_TOKTX)) return env.XGAMES_TOKTX;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['toktx'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

/** A GLB whose textures sit beside it as files (uri): read with them and written back as one self-contained GLB. */
export async function packGlb(file) {
  const { io } = await gltf();
  const doc = await io.read(file);
  return Buffer.from(await io.writeBinary(doc));
}

/** Does a GLB name files outside itself? */
export function glbHasExternal(bytes) {
  const len = bytes.readUInt32LE(12), j = JSON.parse(bytes.toString('utf8', 20, 20 + len));
  return [...(j.images ?? []), ...(j.buffers ?? [])].some(x => x.uri && !x.uri.startsWith('data:'));
}

export async function optimizeGlb(bytes, { maxTexture = 1024, ktx2 = false, env = process.env } = {}) {
  const { fn, mo, io, ext } = await gltf();
  const doc = await io.readBinary(new Uint8Array(bytes));
  const did = [], skipped = [];
  await doc.transform(fn.dedup(), fn.prune());
  did.push('dedup and prune');
  // textures: no side over maxTexture (sharp keeps the format)
  let resized = 0;
  for (const t of doc.getRoot().listTextures()) {
    const size = t.getSize();
    if (size && Math.max(...size) > maxTexture) resized++;
  }
  if (resized) { await doc.transform(fn.textureCompress({ encoder: sharp, resize: [maxTexture, maxTexture] })); did.push(`${resized} texture${resized === 1 ? '' : 's'} capped at ${maxTexture} px`); }
  if (ktx2) {
    const toktx = findToktx(env);
    if (!toktx) skipped.push('KTX2: toktx is not on this machine (XGAMES_TOKTX)');
    else {
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'art-ktx2-'));
      try {
        let n = 0;
        for (const t of doc.getRoot().listTextures()) {
          if (t.getMimeType() === 'image/ktx2') continue;
          const src = path.join(tmp, `t${n}.png`), out = path.join(tmp, `t${n}.ktx2`);
          await writeFile(src, await sharp(t.getImage()).png().toBuffer());
          const r = spawnSync(toktx, ['--t2', '--encode', 'uastc', '--uastc_quality', '2', '--zcmp', '18', '--genmipmap', out, src], { encoding: 'utf8' });
          if (r.status !== 0) { skipped.push(`KTX2: toktx failed on a texture (${(r.stderr || '').trim().slice(0, 120)})`); continue; }
          t.setImage(new Uint8Array(await readFile(out))).setMimeType('image/ktx2');
          n++;
        }
        if (n) { doc.createExtension(ext.KHRTextureBasisu).setRequired(true); did.push(`${n} texture${n === 1 ? '' : 's'} to KTX2 (UASTC)`); }
      } finally { await rm(tmp, { recursive: true, force: true }); }
    }
  }
  await doc.transform(fn.meshopt({ encoder: mo.MeshoptEncoder, level: 'medium' }));
  did.push('meshopt compression');
  return { bytes: Buffer.from(await io.writeBinary(doc)), did, skipped };
}

export async function normalizePng(bytes) {
  const out = await sharp(bytes).ensureAlpha().png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
  return { bytes: out, did: ['re-encoded as 8-bit RGBA PNG without metadata'], skipped: [] };
}
