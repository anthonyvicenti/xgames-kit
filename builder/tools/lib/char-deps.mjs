// Track C tool dependencies, pinned in ./char-deps/package.json (node_modules is gitignored).
// Installed on first use (builder/lib/char-deps.mjs ensureCharDeps); by hand: (cd builder/tools/lib/char-deps && npm ci)
import { createRequire } from 'node:module';
import { ensureCharDeps } from '../../lib/char-deps.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkg = new URL('./char-deps/package.json', import.meta.url);
const req = createRequire(pkg);
const nm = fileURLToPath(new URL('./char-deps/node_modules', import.meta.url));
// installed on first use, one process at a time (builder/lib/char-deps.mjs: a process that finds another installing waits)
ensureCharDeps();
if (!existsSync(nm)) {
  throw new Error(`char tools: dependencies missing. Run: (cd ${fileURLToPath(new URL('./char-deps', import.meta.url))} && npm ci)`);
}
const load = (id) => import(pathToFileURL(req.resolve(id)).href);

export const gltfCore = await load('@gltf-transform/core');
export const gltfExt = await load('@gltf-transform/extensions');
export const gltfFn = await load('@gltf-transform/functions');
export const { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } = await load('meshoptimizer');
export const sharp = (await load('sharp')).default;

let ioPromise;
/** A NodeIO with every extension registered and meshopt ready (decode and encode). */
export function io() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new gltfCore.NodeIO()
      .registerExtensions(gltfExt.ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
  })();
  return ioPromise;
}

/** three.js 0.186, the ES module build (math, Object3D, Skeleton, AnimationMixer all run in Node). */
export const THREE = await import(pathToFileURL(nm + '/three/build/three.module.js').href);
/** A three addon by its path under examples/jsm, e.g. addon('utils/SkeletonUtils.js'). */
export const addon = (p) => import(pathToFileURL(nm + '/three/examples/jsm/' + p).href);
