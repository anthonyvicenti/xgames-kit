// The pointer lock on a check's page.
//
// The WebGPU Chrome the scenic-3d profile and the forge runtime are verified in (a newer headless build than the WebGL one) gives a
// page the pointer lock and then reports every mouse event twice: the event, and a mousemove whose movement is minus
// the pointer's position (a click at 640,400 arrives with movementX -640, movementY -400; a move to x arrives as +x then
// -x). Measured 2026-10-10 on Chrome 151: each press and each release turned a third-person camera 95 degrees and
// pitched it to its stop, with the mouse standing still, so checks 13 and 16 failed every scenic game with a `third`
// camera ("the swing went 95 degrees away from where the player aims"). The WebGL Chrome (148) reports only what moved.
// No player's browser does this: it is the harness's input path, so the harness is what is mended. On a WebGPU page
// the lock is emulated, as the forge checks always did (tools/lib/forge-feel-check.mjs POINTER_LOCK): the page is told
// it has the lock, and the real mouse's own relative motion reaches the game.
//
// An emulated lock leaves the cursor a cursor: it stops at the screen's edge. `turnBy` goes back to the middle with the
// lock released before it would leave (as tools/play.mjs does).
// A page that tests the lock itself (check 24: a post's frame that refuses it) must ask for the real one: {realLock: true}.

/** In the page (an init script): requestPointerLock answers at once, and the page reads as locked. */
export const EMULATED_LOCK = () => {
  if (window.__gfEmulatedLock) return;
  window.__gfEmulatedLock = true;
  let locked = null;
  Element.prototype.requestPointerLock = function () { locked = this; document.dispatchEvent(new Event('pointerlockchange')); return Promise.resolve(); };
  Object.defineProperty(Document.prototype, 'pointerLockElement', { get() { return locked; }, configurable: true });
  Document.prototype.exitPointerLock = function () { locked = null; document.dispatchEvent(new Event('pointerlockchange')); };
};

/** Does a page on this renderer need the emulated lock? (launchForGame's `gpu`: 'webgpu' | 'webgl' | 'software') */
export const needsEmulatedLock = gpu => gpu === 'webgpu';

/** Install the emulated lock on a new page when its browser needs it. → true when installed */
export async function lockFor(page, gpu, { realLock = false } = {}) {
  if (realLock || !needsEmulatedLock(gpu)) return false;
  await page.addInitScript(EMULATED_LOCK);
  return true;
}

/**
 * Turn by (dx, dy) mouse pixels from `cursor` ({x, y}, updated). Under the real lock the cursor may go anywhere; under
 * the emulated one it returns to the middle, lock released, before it would leave the screen.
 */
export async function turnBy(page, cursor, dx, dy, { stepPx = 30 } = {}) {
  const vp = page.viewportSize() ?? { width: 1280, height: 720 };
  const emulated = await page.evaluate(() => !!window.__gfEmulatedLock).catch(() => false);
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / stepPx));
  for (let i = 1; i <= n; i++) {
    const nx = cursor.x + dx / n, ny = cursor.y + dy / n;
    if (emulated && (nx < 60 || nx > vp.width - 60 || ny < 60 || ny > vp.height - 60)) {
      await page.evaluate(() => document.exitPointerLock()).catch(() => {});
      cursor.x = Math.round(vp.width / 2); cursor.y = Math.round(vp.height / 2);
      await page.mouse.move(cursor.x, cursor.y);
      await page.evaluate(() => document.getElementById('gf-canvas')?.requestPointerLock()).catch(() => {});
    }
    cursor.x += dx / n; cursor.y += dy / n;
    await page.mouse.move(cursor.x, cursor.y);
  }
}
