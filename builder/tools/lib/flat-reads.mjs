// What a check reads in a flat (2D) game where it would otherwise assume a 3D one. The facts are the part's own
// (the game's copy of gf/three/flat/index.js → manifest.reads(plane), worldReport, bodyReport): this file only finds
// that copy and gives the 3D answer for every other game, so no check keeps a list of planes, cameras or keys.
//
//   const flat = await flatOf(dir);   // null for a game that is not flat
//   const walk = walkOf(flat);        // { keys, axes, forward, jump? } for any game
//
// A game is flat when gf-three.json → modules.flat is "top" or "side" (the same value as config/game.json → plane).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The walk of a game that is not flat: W is forward, the camera turns with the mouse. */
export const WALK_3D = Object.freeze({ keys: { up: 'KeyW', right: 'KeyD', down: 'KeyS', left: 'KeyA' }, axes: ['x', 'z'], forward: 'KeyW', why: 'a 3D game walks forward on W' });

/** → null, or { plane, part (the game's own flat module), reads } */
export async function flatOf(dir) {
  if (!dir) return null;
  let plane = null;
  try { plane = JSON.parse(await readFile(join(dir, 'gf-three.json'), 'utf8'))?.modules?.flat ?? null; } catch { return null; }
  if (plane !== 'top' && plane !== 'side') return null;
  const file = resolve(dir, 'gf/three/flat/index.js');
  if (!existsSync(file)) throw new Error(`gf-three.json says the game is flat (${plane}) but it has no gf/three/flat/index.js`);
  const part = await import(pathToFileURL(file).href);
  return { plane, part, reads: part.manifest.reads(plane) };
}

/** Which keys walk the player, along which axes, and which one is "forward" (the key a check holds to move). */
export const walkOf = flat => flat?.reads?.walk ?? WALK_3D;
