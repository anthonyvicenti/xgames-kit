// gf-vista's part of window.__game (runtimes/CONTRACT.md §6): what only the vista core knows, in the shapes every runtime
// gives (camera, screen), and vista's own snapshot block. Read-only: nothing here changes the game. The boot
// (gf/three/core/boot-vista.js) builds the rest from the shared kit's pieces.
//
//   vistaPart(vgame, ctx)    the game's events (bite, hooked, catch, lost, sold, bought, board, leave) as the kit's event
//                            log reads a part's: `vista.<name>`, naming this copy's own player (every event happens on
//                            the copy of the player it concerns)
//   frameMeter()             frames a second and the median frame, from the frame loop's own times
//   aimOf(app, eye, dir)     what the view is on: the island's ground or the sea, within `far` metres
import { LOOKS } from './look.js';

/** The keys the core's player reads (core/src/player, core/src/App.js), for check 15's new-player hand. */
export const CONTROLS = [
  { keys: ['KeyW', 'KeyA', 'KeyS', 'KeyD'], does: 'move (on foot, swimming, steering the boat)' },
  { keys: ['mouse'], does: 'look (click to capture the mouse)' },
  { keys: ['ShiftLeft'], does: 'sprint, boat boost' },
  { keys: ['Space'], does: 'jump, swim up' },
  { keys: ['KeyC'], does: 'crouch, dive' },
  { keys: ['KeyE'], does: 'interact: board the boat, take or leave the helm, step ashore, trade' },
  { keys: ['KeyR'], does: 'take out or put away the fishing rod' },
  { keys: ['mouse-left'], does: 'hold to wind up, release to cast; strike; hold to reel' },
];

const r3 = v => Math.round(v * 1000) / 1000;

/** The core's look speed: radians a pixel of mouse (core/src/player). */
export const LOOK_RADIANS = 0.0022;

export function createObserve(vista) {
  const { app } = vista;
  const cam = app.camera;
  const players = () => vista.players?.list?.() ?? [];
  const o = {
    runtime: 'vista',
    version: vista.VERSION,
    /** the camera the core drew this frame, in the contract's shape (eye, dir, yaw, pitch, fov) and its own extras */
    camera() {
      const e = cam.matrixWorld.elements;   // column 2 is +Z; the camera looks down −Z
      const fx = -e[8], fy = -e[9], fz = -e[10];
      return { eye: [cam.position.x, cam.position.y, cam.position.z].map(r3), dir: [fx, fy, fz].map(r3), yaw: r3(Math.atan2(-fx, -fz)), pitch: r3(Math.asin(Math.max(-1, Math.min(1, fy)))), fov: cam.fov, near: cam.near, far: cam.far, sensitivity: LOOK_RADIANS, underwater: (app.cameraWaterHeight ?? 0) > cam.position.y };
    },
    /** what the canvas is and how fast it draws, in the contract's shape ({dpr, css, buffer, ratio, api, gpu}; fps,
     *  frameMs and quality come from the boot) and the core's own (its render scale and CPU time a frame) */
    screen() {
      const c = app.engine.canvas, dpr = globalThis.devicePixelRatio || 1;
      return { dpr, css: [c.clientWidth, c.clientHeight], buffer: [c.width, c.height], ratio: c.clientWidth ? r3(c.width / c.clientWidth) : null, budget: null, api: 'webgpu', gpu: vista.gpu ?? null, renderScale: app.settings.renderScale, cpuMs: app.cpuMs ? r3(app.cpuMs) : null };
    },
    /** the world state a check needs: the local player, the boat, the look, the other players */
    snapshot() {
      const p = app.player, b = app.boatCtl;
      return {
        t: performance.now(),
        mode: app.freeCam ? 'free' : p.mode,   // walk | swim | boat | deck | free
        player: { x: r3(p.position.x), y: r3(p.position.y), z: r3(p.position.z), yaw: r3(p.yaw ?? 0), grounded: !!p.grounded },
        boat: { x: r3(b.position.x), y: r3(b.position.y), z: r3(b.position.z), speed: r3(b.velocity.length()), driven: !!b.driven },
        look: vista.look.state,
        players: players(),
        started: vista.started,
      };
    },
    looks: LOOKS,
    controls: CONTROLS,
    coverage() { return { ok: false, why: 'not yet for vista (wave 2, track S)' }; },
    sight() { return { ok: false, why: 'not yet for vista (wave 2, track S)' }; },
  };
  return o;
}

/** The game's events the kit's event log reads (gf/three/core/events.js): every one is this copy's own player's. */
export const EVENTS = ['bite', 'hooked', 'catch', 'lost', 'sold', 'bought', 'board', 'leave'];

/** The vista game as a part of the event log. vgame: kit/game.js's; ctx: the boot's (ctx.me is this copy's player). */
export function vistaPart(vgame, ctx) {
  const subs = new Map(EVENTS.map(n => [n, []]));
  const part = { id: 'vista', standin: false, manifest: { id: 'vista', events: EVENTS.map(name => ({ name })) } };
  for (const n of EVENTS) {
    part[n] = fn => { subs.get(n).push(fn); };
    vgame.on(n, () => {
      const me = ctx.me;
      if (!me) return;
      const a = { player: me, at: me.position ? { x: me.position.x, y: me.position.y, z: me.position.z } : null };
      for (const fn of subs.get(n)) { try { fn(a); } catch { /* the log's own */ } }
    });
  }
  return part;
}

/** The frame cost as the screen sees it: frames a second and the median frame in milliseconds, over the last 2 s. */
export function frameMeter({ keep = 120 } = {}) {
  const ms = [];
  return {
    frame(raw) { if (raw > 0 && raw < 1) { ms.push(raw * 1000); if (ms.length > keep) ms.shift(); } },
    observe() {
      if (!ms.length) return { fps: null, frameMs: null };
      const s = [...ms].sort((a, b) => a - b), med = s[Math.floor(s.length / 2)], mean = ms.reduce((a, b) => a + b, 0) / ms.length;
      return { fps: Math.round(10000 / mean) / 10, frameMs: Math.round(med * 10) / 10 };
    },
  };
}

/**
 * What the view is on, along it from the eye: the island's ground (core TerrainData heightAt) or the sea (sea level 0),
 * marched in half-metre steps within `far` metres. heightAt(x, z) → metres. → {dist, point, hit: 'ground' | 'water' | null}
 */
export function aimOf(heightAt, eye, dir, { far = 80, step = 0.5, sea = 0 } = {}) {
  const [ox, oy, oz] = eye, [dx, dy, dz] = dir;
  for (let t = step; t <= far; t += step) {
    const x = ox + dx * t, y = oy + dy * t, z = oz + dz * t;
    let g = -Infinity; try { g = heightAt(x, z); } catch { /* off the map */ }
    if (y <= Math.max(g, sea)) return { dist: r3(t), point: { x: r3(x), y: r3(Math.max(g, sea)), z: r3(z) }, hit: g >= sea ? 'ground' : 'water' };
  }
  return { dist: far, point: { x: r3(ox + dx * far), y: r3(oy + dy * far), z: r3(oz + dz * far) }, hit: null };
}
