// gf-vista audio: the core's soundscape (core/src/audio/SoundScape.js: surf wave by wave, wind, birds, the boat, the
// rod and reel, footsteps; 42 CC0 field recordings) plays into the shared gf-audio kit (research/foundations/kits/
// gf-audio, current 1.5.0; research/audio/GUIDE.md) instead of its own speakers:
//   - core patch #2 (core/PATCHES.md) builds the soundscape in the kit's AudioContext and ends it in the kit's sfx bus
//     (busInput('sfx')), so the kit's bus level, master, player volume, mute, limiter and hidden-tab silence apply,
//     with the creator-approved bus levels unchanged. Nothing connects to ctx.destination but the kit itself.
//   - the soundscape's own master volume is set to 1: the kit's player volume is the one volume (GUIDE §3: don't carry
//     an old master gain over).
//   - every core sound is listed in kit/sounds.json (id, label, file, `engine: 'vista-core'`) for a game's assets.json
//     `sounds`, so Studio lists them. splitSounds() keeps them out of createAudio (the soundscape plays them; the kit
//     would decode every file again); attachVistaAudio() applies each one's gainDb (0 or below) as a trim.
//     Replacing a core sound's file is not wired yet (the soundscape reads its files through vista-io: a game's reader).
//   - the HUD's own few sounds (panel, buy, refused, bite cue) are ordinary kit sounds (presets) in the same list.
//
//   import { createAudio } from './audio/audio.js';
//   const { kit, core } = splitSounds(assets.sounds);
//   const audio = createAudio(kit, { presets, storageKey: '<slug>' });
//   const a = attachVistaAudio(vista, audio, { manifest: assets.sounds, game });   // before the first click
import SOUNDS from './sounds.json' with { type: 'json' };
import { routeSoundScape } from '../core/src/audio/SoundScape.js';
import { BANK } from '../core/src/audio/soundBank.js';

export { SOUNDS };
export const CORE_PREFIX = 'vista-';
const bankId = id => id.slice(CORE_PREFIX.length).replace(/-/g, '_');

/** A sound list split in two: what the gf-audio kit plays (kit) and the core's own sounds (core, by id). */
export function splitSounds(manifest = SOUNDS) {
  const kit = { ...manifest, sounds: {} }, core = {};
  for (const [id, s] of Object.entries(manifest?.sounds ?? {})) (s?.engine === 'vista-core' ? core : kit.sounds)[id] = s;
  delete kit._note;
  return { kit, core };
}

const ORIGINAL = new Map();   // bank id → its measured loudness before any trim
/** Apply each core sound's gainDb (0 or below; a boost is ignored, GUIDE §4) as a trim of the soundscape's level. */
export function applyCoreTrims(manifest = SOUNDS) {
  const { core } = splitSounds(manifest);
  const trims = {};
  for (const [id, s] of Object.entries(core)) {
    const b = BANK[bankId(id)];
    if (!b) continue;
    if (!ORIGINAL.has(bankId(id))) ORIGINAL.set(bankId(id), structuredClone(b.lufs));
    const g = Math.min(0, Number(s.gainDb) || 0), base = ORIGINAL.get(bankId(id));
    b.lufs = Array.isArray(base) ? base.map(v => v - g) : base - g;   // the mixer's gain is target minus this
    if (g) trims[id] = g;
  }
  return trims;
}

/**
 * Route the core's soundscape into a gf-audio kit instance and hook the HUD's sounds to the game's events.
 *   vista   from createVista (its app.audio is the soundscape; null under ?noAudio)
 *   audio   a gf-audio kit instance (createAudio(...)), the game's one mix
 *   manifest  the game's sound list (assets.json sounds), for the core sounds' trims; default kit/sounds.json
 *   game    optional, from createVistaGame: its events play the HUD's sounds
 * → { routed, why?, trims, dispose() }
 */
export function attachVistaAudio(vista, audio, { manifest = SOUNDS, game = null } = {}) {
  const sc = vista?.app?.audio ?? null;
  const offs = [];
  const play = id => audio.play(id, { optional: true });
  if (game) {
    offs.push(game.on('panel', p => { if (p.panel) play('vista-panel'); }));
    offs.push(game.on('bought', () => play('vista-buy')));
    offs.push(game.on('toast', t => { if (t.key === 'tooDear' || t.key === 'owned') play('vista-refused'); }));
    offs.push(game.on('bite', () => play('vista-bite')));
  }
  const trims = applyCoreTrims(manifest);
  if (!sc) return { routed: false, why: 'the core has no soundscape (?noAudio)', trims, dispose: () => offs.forEach(f => f()) };
  if (sc.ctx && sc.ctx !== audio.context) return { routed: false, why: 'the soundscape already made its own audio context; attach before the first click', trims, dispose: () => offs.forEach(f => f()) };
  routeSoundScape({ context: audio.context, output: audio.busInput('sfx') });
  sc.setMasterVolume(1);
  // the core resumes its soundscape on a click into the canvas; a game's first gesture may be on the menu instead
  const wake = () => { sc.resume().catch?.(() => {}); };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, wake, { capture: true, passive: true });
  return {
    routed: true, trims,
    dispose() {
      offs.forEach(f => f());
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) removeEventListener(ev, wake, { capture: true });
      routeSoundScape(null);
    },
  };
}
