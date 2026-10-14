// runtime godot: start the game's Godot export (build/game.js, game.wasm, game.pck) on the kit's canvas.
// The export is the pinned web template: WebGL2 (the compatibility renderer) and one thread, so no cross-origin
// isolation is asked of the play host. Godot's own audio is off (--audio-driver Dummy): every sound goes through
// gf-audio (GF.sound), so the kit's buses and the menu's volume hold for the whole game.

/** The engine's loader, once (it defines the global Engine class). */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`${src} did not load (export the game: runtimes/godot/tools/export.mjs)`));
    document.head.append(s);
  });
}

/** What this browser lacks for the export (WebGL2, WebAssembly), in Godot's words; [] when it can run. */
export function missingFeatures() {
  // eslint-disable-next-line no-undef
  const E = typeof Engine === 'undefined' ? null : Engine;
  return E ? E.getMissingFeatures({ threads: false }) : ['the engine did not load'];
}

/**
 * → { ok, engine?, missing? }. The canvas is the kit's (#gf-canvas); Godot sizes it to the window.
 * prints: the engine's printed lines go to onPrint / onPrintError (the boot keeps the last ones for the observation).
 */
export async function startEngine({ base = 'build/game', canvas, onPrint = () => {}, onPrintError = () => {}, onProgress = () => {}, args = [] } = {}) {
  await loadScript(`${base}.js`);
  const missing = missingFeatures();
  if (missing.length) return { ok: false, missing };
  // eslint-disable-next-line no-undef
  const engine = new Engine({
    executable: base, canvas, canvasResizePolicy: 2, focusCanvas: false, ensureCrossOriginIsolationHeaders: false,
    serviceWorker: '', experimentalVK: false, args: ['--audio-driver', 'Dummy', ...args], onPrint, onPrintError,
  });
  await engine.startGame({ onProgress });
  return { ok: true, engine };
}
