// three.js in Node for track C's tools: load a GLB with the same GLTFLoader the browser uses (textures stripped,
// since Node has no image decoder), so rig-check measures exactly what the game will see.
import './char-node.mjs';
import { readFileSync } from 'node:fs';
import { io, gltfFn, gltfCore, MeshoptDecoder } from './char-deps.mjs';

export const THREE = await import('three');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
export const SkeletonUtils = await import('three/addons/utils/SkeletonUtils.js');

/** Bytes of `src` (path or Uint8Array) with every texture removed (materials keep their factors). */
export async function stripTextures(src) {
  const nio = await io();
  const doc = await nio.readBinary(typeof src === 'string' ? new Uint8Array(readFileSync(src)) : src);
  doc.setLogger(new gltfCore.Logger(gltfCore.Logger.Verbosity.SILENT));
  for (const t of doc.getRoot().listTextures()) t.dispose();
  await doc.transform(gltfFn.prune());
  return nio.writeBinary(doc);
}

/** GLTFLoader.parse in Node. Returns the gltf result ({scene, animations, ...}). */
export async function loadGLB(src) {
  await MeshoptDecoder.ready;
  const bytes = await stripTextures(src);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((ok, bad) => loader.parse(ab, '', ok, bad));
}
