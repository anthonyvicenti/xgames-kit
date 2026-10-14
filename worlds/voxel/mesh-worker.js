// gf-three voxel world: a mesh worker (world.js starts a few at load). It keeps a copy of the play grid and its light
// to mesh chunks off the main thread, and it makes the scenery round the play area on its own (fills a strip of land
// past the edge, lights it and meshes it): none of that ever touches the main thread. Messages:
//   in  { type: 'init', V, size, data, light, biome }                  the play grid as the main thread has it
//   in  { type: 'mesh', job, chunks: [[cx, cz], ...] } (columns)        → { type: 'chunk', job, chunk, res } each, then { type: 'done', job }
//   in  { type: 'far', job, V, size, strip: { ox, oz, w, d } }          → { type: 'chunk', job, chunk, res, far: true } per 4 × 4 chunks merged, then { type: 'done', job }
import { VoxelGrid } from './grid.mjs';
import { blockTable } from './blocks.mjs';
import { terrainModel, fillRegion, landOutside } from './terrain.mjs';
import { VoxelLight } from './light.mjs';
import { meshChunk, mergeMeshes, transfers } from './mesh.mjs';

let play = null;   // { grid, light }

function setup(V, size) {
  const table = blockTable(V);
  const model = terrainModel(table, V.terrain ?? {}, size);
  return { table, model, stone: model.B.stone };
}

function send(job, chunk, res, far = false) {
  postMessage({ type: 'chunk', job, chunk, res, far }, transfers(res));
}

self.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'init') {
      const { table, model, stone } = setup(m.V, m.size);
      const grid = new VoxelGrid({ size: m.size, info: table.info, tints: table.tints });
      grid.data.set(m.data); grid.biome = m.biome; grid.outside = landOutside(model, 0, 0, stone);
      const light = new VoxelLight(grid); light.data.set(m.light);
      play = { grid, light };
    } else if (m.type === 'mesh') {
      // each entry a column of chunks [cx, cz], every height, as one mesh (world.js draws the play grid by columns)
      for (const c of m.chunks) send(m.job, c, mergeMeshes(Array.from({ length: play.grid.cy }, (_, cy) => meshChunk(play.grid, play.light, c[0], cy, c[1]))));
      postMessage({ type: 'done', job: m.job });
    } else if (m.type === 'far') {
      const { table, model, stone } = setup(m.V, m.size);
      const { ox, oz, w, d } = m.strip, sy = m.size[1];
      const grid = new VoxelGrid({ size: [w, sy, d], info: table.info, tints: table.tints });
      grid.origin = [ox, 0, oz];
      fillRegion(grid, model, ox, oz, { caves: false, ores: false });
      grid.outside = landOutside(model, ox, oz, stone);
      const light = new VoxelLight(grid); light.computeAll();
      // never edited: one mesh per 4 × 4 chunks of columns (every height), so the scenery is a few dozen draws
      const G = 4;
      for (let gx = 0; gx < grid.cx; gx += G) for (let gz = 0; gz < grid.cz; gz += G) {
        const parts = [];
        for (let cx = gx; cx < Math.min(grid.cx, gx + G); cx++) for (let cz = gz; cz < Math.min(grid.cz, gz + G); cz++) for (let cy = 0; cy < grid.cy; cy++) parts.push(meshChunk(grid, light, cx, cy, cz));
        const res = mergeMeshes(parts);
        if (Object.keys(res).length) send(m.job, [gx, 0, gz], res, true);
      }
      postMessage({ type: 'done', job: m.job });
    }
  } catch (e) {
    postMessage({ type: 'error', job: m.job, error: String(e?.stack ?? e) });
  }
};
