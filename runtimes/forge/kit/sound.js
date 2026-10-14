// gf-forge's sound side (wave 2, track U), vendored into a game as gf/forge/sound.js (never edited there). The core
// plays its own sounds by name through gf-audio (the host routes each SOUND event to ctx.audio); the sound list is the
// art library's files (research/gf-forge/library/sounds, wired by library/tools/sound-wire.mjs at create). This adds the
// sounds no core event carries, all through the same ctx.audio (gf-audio: the default buses, the limiter, the mute):
//
//   the night bed    "ambient-night": a wind and crickets loop on the ambient bus, from the home menu on (gf-audio
//                    starts loops on the first click or touch)
//   the heartbeat    "player-lowhealth" is a loop: the core starts it as health falls into a low stage; here it beats
//                    faster at each stage and stops when health is back, the player falls or the round ends
//   the wave         "wave-start": a bell as a wave begins; "wave-end": a short sting when one is cleared
//
// Every id is optional: a game whose sound list lacks one (an older game still on presets) plays nothing for it.
//
//   const sound = createForgeSound(ctx);   // gf/forge/feel.js makes it
//   sound.update(dt, view, F)               // every frame, with the feel view
const BED = 'ambient-night', HEART = 'player-lowhealth';
/** The heartbeat's rate at each low-health stage (1: the file's own, about 67 beats a minute). */
export const HEART_RATE = [1, 1, 1.2, 1.42];

export function createForgeSound(ctx, { host = ctx.forge } = {}) {
  const audio = ctx.audio;
  if (!audio || !host) return null;
  const has = id => { try { return !!audio.has(id); } catch { return false; } };
  const play = (id, o = {}) => { try { return audio.play(id, { optional: true, ...o }); } catch { return null; } };
  const S = { bed: false, heart: 0, plays: {}, phase: null };
  const count = id => { S.plays[id] = (S.plays[id] ?? 0) + 1; };
  if (has(BED)) { play(BED); S.bed = true; }
  const offs = [];
  offs.push(host.on('rule', e => {
    if (e.name === 'wave-start' && has('wave-start')) { play('wave-start'); count('wave-start'); }
    else if (e.name === 'wave-clear' && has('wave-end')) { play('wave-end'); count('wave-end'); }
  }));
  const heart = stage => {
    if (stage === S.heart) return;
    if (!has(HEART)) { S.heart = stage; return; }
    if (stage > 0) { if (S.heart === 0) { play(HEART); count(HEART); } try { audio.raw?.set?.(HEART, { pitch: HEART_RATE[stage] ?? 1 }, 0.3); } catch {} }
    else { try { audio.stop(HEART); } catch {} }
    S.heart = stage;
  };
  return {
    /** Every frame, with the feel view and its field numbers. */
    update(dt, view, F) {
      const phase = ctx.round?.phase ?? 'playing';
      const stage = phase === 'playing' && view && !(view[F.dead] > 0.5) ? view[F.stage] | 0 : 0;
      heart(stage);
      // the core starts the loop itself on a stage's first frame, and a file still decoding starts late: keep the rate the stage's
      S.t = (S.t ?? 0) + dt;
      if (stage > 0 && S.t > 0.25 && has(HEART)) { S.t = 0; try { audio.raw?.set?.(HEART, { pitch: HEART_RATE[stage] ?? 1 }, 0.3); } catch {} }
      S.phase = phase;
    },
    observe: () => ({ bed: S.bed, heart: S.heart, plays: { ...S.plays } }),
    dispose() { for (const off of offs) off(); try { audio.stop(HEART); } catch {} },
  };
}
