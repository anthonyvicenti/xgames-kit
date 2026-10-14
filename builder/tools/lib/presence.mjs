// How a friend is seen when the players are not characters, for the tools (create, verify's gate E, the loop): the
// shape of a game's friends from its spec and its parts' manifests (gf/mp/presence.js shapeOf), and what create puts in
// a game for it. builder/multiplayer/STANDARD.md, "Seeing a friend with no character".
import { join } from 'node:path';
import { BUILDER } from './paths.mjs';
import { heldBy, shapeOf, SEES, SHAPES } from '../../gf-multiplayer/source/presence.js';
import { mechanicParts } from '../catalog.mjs';

export { heldBy, shapeOf, SEES, SHAPES };
/** The kit's stand-in avatar (the ui.avatar slot's first file). */
export const AVATAR = join(BUILDER, 'ui', 'presence-avatar.svg');
export const AVATAR_FILE = 'assets/ui/avatar.svg';
export const AVATAR_LICENSE = { spdx: 'CC0-1.0', author: 'xgames-kit (stand-in)', url: 'https://xgames.fun' };
/** The words under each avatar (config/game.json → text; ui.mood-* slots). */
export const MOOD_TEXT = { moodWaiting: 'waiting', moodThinking: 'thinking…', moodPlaced: 'placed!', moodWon: 'won!', moodLost: 'lost', moodAway: 'away' };

let parts = null;
/** A mechanic's manifest by id, from this kit (null when it has none). */
export async function manifestOf() {
  parts ??= new Map((await mechanicParts()).map(p => [p.id, p.manifest]));
  return id => parts.get(id) ?? null;
}
/**
 * A spec's (or config/game.json's) friends: → {shape: 'character' | 'seats' | 'boards' | null (solo), held, sees}.
 * `of`: a manifest lookup (manifestOf()); the kit's own when left out.
 */
export async function shapeOfSpec(spec, { of = null } = {}) {
  const look = of ?? await manifestOf();
  const together = spec?.multiplayer?.mode === 'solo' ? 'solo' : spec?.multiplayer?.together ?? spec?.players?.together ?? 'versus';
  const held = heldBy(spec?.mechanics ?? [], look);
  const shape = shapeOf({ together, presence: spec?.multiplayer?.presence ?? null, held });
  return { shape, held, sees: shape ? SEES[shape] : null };
}
