// gf-three smooth terrain: the mesh worker (world.js starts one). It keeps its own copy of the field, applies the same
// edits the main thread does, in the same order, and meshes the chunks they touch, off the main thread. Messages:
//   in  { type: 'init', meta: {size, cell, origin}, data, top }   the field as generated (data: its values, top: per column)
//   in  { type: 'mesh', job, chunks: [[cx, cy, cz], ...] }         → { type: 'chunk', job, chunk, res } each, then { type: 'done', job }
//   in  { type: 'edit', job, edits: [[op, x, y, z, r], ...] }      applies them, meshes what they touched: as 'mesh'
//   in  { type: 'reset', job, data }                               the field back to these values (a new round), every chunk meshed again
import { TerrainField } from './field.mjs';
import { meshChunk, origOf, transfers } from './mesh.mjs';

let F = null, top = null, orig = null;

function meshAll(job, list) {
  for (const c of list) {
    const res = meshChunk(F, c[0], c[1], c[2], { top, orig });
    postMessage({ type: 'chunk', job, chunk: c, res }, transfers(res));
  }
  postMessage({ type: 'done', job });
}
const every = () => { const out = []; for (let y = 0; y < F.cy; y++) for (let z = 0; z < F.cz; z++) for (let x = 0; x < F.cx; x++) out.push([x, y, z]); return out; };

self.onmessage = ({ data: m }) => {
  try {
    if (m.type === 'init') {
      F = new TerrainField({ size: m.meta.size, cell: m.meta.cell, origin: m.meta.origin, data: m.data });
      top = m.top; orig = origOf(F);
    } else if (m.type === 'mesh') meshAll(m.job, m.chunks ?? every());
    else if (m.type === 'edit') {
      const touched = new Map();
      for (const e of m.edits) for (const c of F.chunksOf(F.apply(e))) touched.set(c.join(','), c);
      meshAll(m.job, [...touched.values()]);
    } else if (m.type === 'reset') { F.d.set(m.data); meshAll(m.job, every()); }
  } catch (e) {
    postMessage({ type: 'error', job: m.job, error: String(e?.stack ?? e) });
  }
};
