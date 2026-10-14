// gf-three core: stepped time (QA only, CONTRACT §5). With ?gf-step=1, alone, the frame loop stops following the wall
// clock: time stands still until window.__game.step(ms) is called, which runs the frames those milliseconds hold at the
// fixed 60 Hz, one after another, without waiting. Real keys and clicks stay real: they land in the input as they do
// in play and the next stepped frame reads them. A check then waits in simulated time, so a slow machine (a loaded
// graphics card, software rendering) changes how long the check takes and never what it measures.
//
// Pure: boot.js passes its frame function in. Tests: tests/t-step.test.mjs.
//
// What stepped time moves (everything the frame loop drives): ctx.time (now, dt, round, left), the round clock and the
// countdown (kit/net/session.js tick), Rapier (world.step, 60 Hz), the controllers and the camera rig, every mechanic's
// update(dt), rules.update, the bots, fair play, ctx.onFrame, the characters' animations, the world and the look's
// update(dt), the HUD's and the UI's timers that count dt (banners, the countdown, the round clock).
// What it cannot move (the browser's own clocks; none of them decides a round):
//   - audio: the AudioContext's time is the sound card's. A stepped page plays a second's sounds at once, so nothing
//     that measures sound runs on one (verify's audio gate stays on the real-time solo round).
//   - CSS transitions and animations, and the UI's cosmetic timers (a bar's 160 ms hit flash, a toast, the loading
//     screen): wall-clock.
//   - the input's own stamps (performance.now for a tap against a long press, lastInput): real, as the input is.
//   - asset loads, fetch, promises and the page's timers: they land between steps, when the caller yields.
//   - shader time (the scenic look's TSL time node) and the frame-rate guard's measurements: wall-clock, looks only.
//   - anything over the network (gf/mp/net.js): a live round is never stepped.

/** The flag: stepped time is on only when the page's address asks for it, and never in a live round or a backdrop. */
export const stepAsked = (params, { live = false, backdrop = false } = {}) => params?.get?.('gf-step') === '1' && !live && !backdrop;

export const STEP_MAX_MS = 600000;

/**
 * createStepper({frame, hz}) → {step, state}. frame({dt, draw}) runs one frame of exactly dt seconds; draw says whether
 * this frame is presented (only the last frame of a step is: the frames between cost no drawing).
 *   step(ms, {draw = true}) → {frames, simulated (ms, in all), owed (ms not yet a whole frame)}
 * Milliseconds that do not fill a frame are kept and count toward the next call, so step(10) six times is step(60).
 */
export function createStepper({ frame, hz = 60 }) {
  const H = 1 / hz, FRAME_MS = 1000 / hz;
  const state = { frames: 0, owed: 0, simulated: 0, busy: false };
  function step(ms, { draw = true } = {}) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > STEP_MAX_MS) throw new Error(`step(ms): a number of milliseconds from 0 to ${STEP_MAX_MS}`);
    if (state.busy) throw new Error('step(ms) called from inside a stepped frame');
    state.owed += ms; state.simulated += ms;
    const n = Math.floor(state.owed / FRAME_MS + 1e-9);
    state.owed = Math.max(0, state.owed - n * FRAME_MS);
    state.busy = true;
    try { for (let i = 0; i < n; i++) { state.frames++; frame({ dt: H, draw: draw && i === n - 1 }); } }
    finally { state.busy = false; }
    return { frames: n, simulated: state.simulated, owed: state.owed };
  }
  return { step, state };
}

/**
 * A fixed camera's place (the 'follow' and 'top' rigs, kit/controller/camera-rig.js): it sits opposite its heading,
 * raised by its pitch, `distance` from the pivot. A viewer's camera (boot.js watchCamera) is placed with this, so it
 * stands where the streamer's own rig stands. → out {x, y, z}
 */
export function fixedCameraPlace(C, pivot, out = {}) {
  const yaw = (C.yawDeg ?? 0) * Math.PI / 180, pitch = (C.pitchDeg ?? 50) * Math.PI / 180, d = C.distance ?? 20;
  out.x = pivot.x - Math.sin(yaw) * Math.cos(pitch) * d;
  out.y = pivot.y + Math.sin(pitch) * d;
  out.z = pivot.z - Math.cos(yaw) * Math.cos(pitch) * d;
  return out;
}
