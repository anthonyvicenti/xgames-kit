// gf-vista: a GLB with EXT_meshopt_compression (gltfpack's output, what gf-three's optimize.mjs and the KayKit library
// write) → the same GLB with plain buffer views, so the core's glTF reader (core/src/engine/loaders/GLTF.js parseGLB)
// can take it. Copied from research/gf-forge/kit/meshopt.js (2026-10-12) with one addition: `allow` drops extensions
// from extensionsRequired that the caller handles itself (kit/humanoid-rig.js dequantises KHR_mesh_quantization), since
// parseGLB refuses any required extension. The decoder is meshoptimizer's own (vendor/meshopt_decoder.module.js, MIT,
// vendor/LICENSE-meshoptimizer). A GLB without anything to change comes back as it was.
import { MeshoptDecoder } from './vendor/meshopt_decoder.module.js';

const GLTF = 0x46546c67, JSON_CHUNK = 0x4e4f534a, BIN_CHUNK = 0x004e4942;
const EXTS = ['EXT_meshopt_compression', 'KHR_meshopt_compression'];

/** ArrayBuffer → ArrayBuffer: the GLB with its meshopt buffer views decoded and the `allow`ed extensions no longer
 *  required (or the same buffer when there is nothing to do). */
export async function plainGlb(buf, { allow = [] } = {}) {
  const dv = new DataView(buf);
  if (buf.byteLength < 20 || dv.getUint32(0, true) !== GLTF || dv.getUint32(16, true) !== JSON_CHUNK) return buf;
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const meshopt = (json.extensionsUsed ?? []).some(e => EXTS.includes(e));
  const relax = (json.extensionsRequired ?? []).some(e => allow.includes(e));
  if (!meshopt && !relax) return buf;
  let bin = null;
  for (let at = 20 + jsonLen; at + 8 <= buf.byteLength;) {
    const len = dv.getUint32(at, true), type = dv.getUint32(at + 4, true);
    if (type === BIN_CHUNK) { bin = new Uint8Array(buf, at + 8, len); break; }
    at += 8 + len;
  }
  if (meshopt && !bin) throw new Error('a meshopt GLB without its binary chunk');
  if (meshopt) await MeshoptDecoder.ready;
  // buffer 0 is the GLB's own chunk; the extension's fallback buffers hold no bytes
  const dataOf = i => { if ((i ?? 0) !== 0) throw new Error(`buffer ${i} is not the GLB's own (external buffers are not read)`); return bin; };
  const parts = []; let total = 0;
  const put = bytes => { const at = total; parts.push(bytes); total += bytes.length; const pad = (4 - (total % 4)) % 4; if (pad) { parts.push(new Uint8Array(pad)); total += pad; } return at; };
  if (bin) {
    for (const v of json.bufferViews ?? []) {
      const ext = EXTS.map(e => v.extensions?.[e]).find(Boolean);
      if (ext) {
        const src = dataOf(ext.buffer).subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength);
        const out = new Uint8Array(ext.count * ext.byteStride);
        MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, src, ext.mode, ext.filter ?? 'NONE');
        v.byteOffset = put(out); v.byteLength = out.length; v.buffer = 0;
        if (ext.mode === 'ATTRIBUTES') v.byteStride = ext.byteStride; else delete v.byteStride;
        for (const e of EXTS) delete v.extensions[e];
        if (!Object.keys(v.extensions).length) delete v.extensions;
      } else {
        const src = dataOf(v.buffer);
        v.byteOffset = put(src.slice(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)); v.buffer = 0;
      }
    }
    json.buffers = [{ byteLength: total }];
  }
  const drop = (list, also = []) => (list ?? []).filter(e => !EXTS.includes(e) && !also.includes(e));
  json.extensionsUsed = drop(json.extensionsUsed); if (!json.extensionsUsed.length) delete json.extensionsUsed;
  json.extensionsRequired = drop(json.extensionsRequired, allow); if (!json.extensionsRequired.length) delete json.extensionsRequired;
  // the GLB again: JSON padded with spaces, BIN with zeros
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (text.length % 4)) % 4, jl = text.length + jpad;
  const out = new Uint8Array(12 + 8 + jl + (bin ? 8 + total : 0));
  const o = new DataView(out.buffer);
  o.setUint32(0, GLTF, true); o.setUint32(4, 2, true); o.setUint32(8, out.length, true);
  o.setUint32(12, jl, true); o.setUint32(16, JSON_CHUNK, true);
  out.set(text, 20); out.fill(0x20, 20 + text.length, 20 + jl);
  if (bin) {
    o.setUint32(20 + jl, total, true); o.setUint32(24 + jl, BIN_CHUNK, true);
    let at = 28 + jl;
    for (const p of parts) { out.set(p, at); at += p.length; }
  }
  return out.buffer;
}
