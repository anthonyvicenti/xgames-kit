// A GLB's triangles in Node (the level composer's set pieces: worlds/terrain/piece.mjs), as the browser's loader gives
// them: every mesh primitive's positions through its node's world matrix, 9 numbers a triangle, metres.
//
//   const tris = await glbTriangles(file)          → Float32Array
//   const pieces = await piecesOf(gameDir, ids)    → {id: {tris}} from the game's assets/models/<id>.glb
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { trianglesOf, joinTriangles } from '../../../worlds/terrain/piece.mjs';

export async function glbTriangles(file) {
  const { io, gltfCore } = await import('./char-deps.mjs');
  const doc = await (await io()).readBinary(new Uint8Array(await readFile(file)));
  const out = [];
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const visit = (node) => {
    const mesh = node.getMesh(), m = node.getWorldMatrix();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== gltfCore.Primitive.Mode.TRIANGLES) continue;
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const n = pos.getCount(), flat = new Float32Array(n * 3), el = [];
      for (let i = 0; i < n; i++) { pos.getElement(i, el); flat[i * 3] = el[0]; flat[i * 3 + 1] = el[1]; flat[i * 3 + 2] = el[2]; }
      const idx = prim.getIndices()?.getArray() ?? null;
      out.push(trianglesOf(flat, idx, m));
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const n of scene?.listChildren() ?? []) visit(n);
  return joinTriangles(out);
}

/** The set pieces a composition names, from a game's own models (assets/models/<id>.glb). Missing ones are left out. */
export async function piecesOf(game, ids) {
  const out = {};
  for (const id of [...new Set(ids)]) {
    const f = join(game, 'assets/models', `${id}.glb`);
    if (existsSync(f)) out[id] = { tris: await glbTriangles(f) };
  }
  return out;
}
