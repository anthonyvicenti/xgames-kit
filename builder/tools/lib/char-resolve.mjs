// Node module hooks for track C's tools: lets kit modules that `import 'three'` (and the import-map names a game
// uses) run under Node, resolved to the pinned copies in ./char-deps and the vendored Rapier.
import { pathToFileURL, fileURLToPath } from 'node:url';
const nm = fileURLToPath(new URL('./char-deps/node_modules/', import.meta.url));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const MAP = {
  'three': nm + 'three/build/three.module.js',
  '@dimforge/rapier3d-compat': repo + 'runtimes/three/vendor/rapier@0.19.2/rapier.mjs',
};
export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: pathToFileURL(MAP[specifier]).href, shortCircuit: true };
  if (specifier.startsWith('three/addons/')) return { url: pathToFileURL(nm + 'three/examples/jsm/' + specifier.slice(13)).href, shortCircuit: true };
  if (specifier.startsWith('three/examples/jsm/')) return { url: pathToFileURL(nm + 'three/' + specifier.slice(6)).href, shortCircuit: true };
  return next(specifier, context);
}
