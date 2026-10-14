// gf-three core: how many pixels the game draws (CONTRACT §6i; the creator, 2026-10-09: "Different screen sizes make the
// game look bad. I just tested a smaller screen size and the game looks very fuzzy ... How can we fix this for all our
// games"). Pure: boot passes the window's numbers in, so tests call it in Node.
//
// The canvas draws at the screen's real pixels (its CSS size × devicePixelRatio), lowered only to stay within the
// quality tier's pixel budget, and it follows the screen: a window resize, a browser zoom, a move to another monitor,
// a phone turned or a device chosen in the browser's device mode. Until then the ratio was fixed when the game loaded,
// at most 1 on the low tier, so every phone drew a third of its pixels and stretched them (33% of an iPhone's
// resolution, 50% of a tablet's), and a zoom or device change after loading kept the old ratio (67% at 150% zoom).
//
//   pixelRatioFor({ dpr, width, height, budget, max }) → the ratio: dpr, lowered only to keep width × height × ratio²
//                                    within budget, never under 1 (one CSS pixel) unless dpr itself is
//   watchPixelRatio(win, fn) → stop  fn() whenever devicePixelRatio changes (zoom, another monitor, device mode)
//   createGovernor(opts)              lowers the ratio while frames stay slow (scale 1 → 0.85 → …), never under one CSS
//                                    pixel; reset() on a resize or zoom starts again from the full ratio
//
// Budgets: high = a 4K screen at one pixel per CSS pixel (8.3 MP; a 5K or 4K-at-2× screen draws 75%); low (phones,
// slow machines) = 3.2 MP: a phone at its full 3× (1170 × 2532 = 3.0 MP), a tablet at about 90%.

export const PIXEL_BUDGET = { high: 3840 * 2160, low: 3.2e6 };
export const MAX_RATIO = 3;

export function pixelRatioFor({ dpr = 1, width = 1, height = 1, budget = PIXEL_BUDGET.high, max = MAX_RATIO } = {}) {
  const d = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = Math.max(1, width) * Math.max(1, height);
  const fit = Math.sqrt(Math.max(1, budget) / area);
  return Math.max(Math.min(d, 1), Math.min(d, max, fit));
}

/** Call fn whenever the device pixel ratio changes (a matchMedia query on the current ratio, armed again each time). */
export function watchPixelRatio(win, fn) {
  let mq = null, stopped = false;
  const on = () => { if (stopped) return; arm(); fn(); };
  function arm() {
    mq?.removeEventListener?.('change', on);
    if (stopped || !win?.matchMedia) return;
    try { mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`); mq.addEventListener?.('change', on); } catch { mq = null; }
  }
  arm();
  return () => { stopped = true; mq?.removeEventListener?.('change', on); };
}

/**
 * The frame-rate guard: a game that cannot keep up at the full ratio draws fewer pixels rather than stutter. Frames
 * are sampled only while `active` (playing, the tab in view), after `warmup` seconds (shaders compile then); a window
 * of `window` seconds under `minFps` lowers the scale by `step`, down to `floor` (a fraction of the full ratio that
 * the caller computes so the ratio never goes under one CSS pixel). It never raises the scale by itself: a resize or a
 * zoom resets it (no oscillation).
 */
export function createGovernor({ minFps = 40, window = 3, warmup = 5, step = 0.85 } = {}) {
  let scale = 1, acc = 0, n = 0, t = 0, seen = 0, last = null;
  return {
    get scale() { return scale; },
    /** Why the scale is below 1: {fps, at} of the window that lowered it last, else null. */
    get last() { return last; },
    reset() { scale = 1; acc = n = t = seen = 0; last = null; },
    /** One frame (dt seconds). → true when the scale changed (the caller sizes the canvas again). */
    frame(dt, { active = true, floor = 0 } = {}) {
      if (!active || !(dt > 0)) return false;
      seen += dt;
      if (seen < warmup || dt > 0.5) return false;       // loading hitches and a tab coming back are not slowness
      acc += dt; n++; t += dt;
      if (t < window) return false;
      const fps = n / acc; acc = n = t = 0;
      if (fps >= minFps || scale <= floor + 1e-6) return false;
      scale = Math.max(floor, scale * step);
      last = { fps: Math.round(fps * 10) / 10, at: Math.round(seen * 10) / 10 };
      return true;
    },
  };
}
