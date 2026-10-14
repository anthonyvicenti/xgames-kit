// The npm packages ingest needs (sharp, gltf-transform, meshoptimizer): the same pinned set the 3D tools use
// (builder/tools/lib/char-deps/package.json), installed beside it on first use. Only ingest, previews and validators
// load this; finding, filling and fetching need none of it.
import { ensureCharDeps } from '../lib/char-deps.mjs';

ensureCharDeps();
const deps = await import('../tools/lib/char-deps.mjs');

export const { sharp, gltfCore, gltfExt, gltfFn, MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier, io } = deps;
