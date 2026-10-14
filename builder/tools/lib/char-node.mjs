// Import this first (statically) in a track C tool; then import kit modules dynamically:
//   import './lib/char-node.mjs';  const rig = await import('../kit/character/rig.js');
// Registers char-resolve.mjs so 'three', 'three/addons/*' and '@dimforge/rapier3d-compat' resolve under Node.
import { register } from 'node:module';
register('./char-resolve.mjs', import.meta.url);
