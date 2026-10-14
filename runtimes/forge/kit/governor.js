// gf-forge: the governor (wave 3, track M), vendored as gf/forge/governor.js; the deciding half is pure (tests call
// it in Node). When frames stay short for a few seconds a forge game draws less, a step at a time, and takes it back
// when there is room: a phone that warms up, or a wave larger than it can draw, costs picture quality before it costs
// frames.
//
// What a step lowers (LEVELS), all of it the game's own quality and none of it a rule of play:
//   scale       the scene's render scale (the look's `renderScale`: the scene is drawn at fewer pixels and scaled up;
//               the canvas, the HUD and the text keep theirs), never under one CSS pixel
//   particles   the particle budget, as a share of the tier's
//   rest        the pieces of a kill that stay lying (`feel.kill.rest`): the oldest shrink away, as past the cap
//   flying      the pieces flying at once (`feel.kill.budget`)
//   fires       the fires that cast a shadow, as a share of the tier's (the low tier has none)
// Nothing pops: the scale moves a tenth at a time, pieces shrink away over `feel.kill.restFade`, new particles are
// fewer (none is removed), and a fire's shadow goes only at the third step.
//
// When: frames are counted while a round is played and the page is in view, in windows of `window` seconds. The
// screen's own rate is the best window seen so far, taken up to the next usual rate (30, 60, 90, 120, 144): a phone
// held to 30 frames a second by its battery saver is not short of frames at 30. Two windows in a row under `down` of
// that rate: a step down. `upAfter` seconds at `up` of it or better: a step back up, to see; if frames fall short again
// within `probe` seconds that try failed, and the next one waits twice as long (at most `upMax`).
//
//   const gov = createGovernor();                 // gov.on = false: the Settings toggle
//   if (gov.frame(dt, { active })) apply(gov.level)   // every frame; true when the level changed
//   gov.observe()                                 // {on, level, of, rate, fps, down, up, upWait, changes, last}
//   lookFor(look, tier, step, { TIERS, floor, width })  // config/look.json's values with a level's step applied (for pack)
//   QUALITY                                       // forge-feel's op for the pieces: floats [rest, flying]

/** forge-feel `op::QUALITY`: floats [the share of the resting cap, the share of the flying budget]. */
export const QUALITY = 78;

/** What each level keeps of the tier's own quality (level 0: all of it). */
export const LEVELS = [
  { scale: 1, particles: 1, rest: 1, flying: 1, fires: 1 },
  { scale: 0.9, particles: 0.8, rest: 0.75, flying: 1, fires: 1 },
  { scale: 0.8, particles: 0.65, rest: 0.5, flying: 0.75, fires: 1 },
  { scale: 0.7, particles: 0.5, rest: 0.35, flying: 0.6, fires: 0.5 },
  { scale: 0.6, particles: 0.4, rest: 0.25, flying: 0.5, fires: 0 },
  { scale: 0.5, particles: 0.3, rest: 0.15, flying: 0.4, fires: 0 },
];
const RATES = [30, 60, 90, 120, 144];
/** The usual screen rate a measured best belongs to: 31 is a 60 Hz screen falling short, 30.2 is a 30 Hz one. */
export const rateOf = best => RATES.find(r => best <= r * 1.04) ?? RATES.at(-1);

export function createGovernor({ levels = LEVELS, window = 2, slowWindows = 2, down = 0.84, up = 0.95, upAfter = 8, upMax = 120, probe = 10, warmup = 5 } = {}) {
  const max = levels.length - 1;
  let on = true, level = 0, seen = 0, acc = 0, n = 0, slow = 0, good = 0, best = 0, upWait = upAfter, sinceUp = Infinity, fps = null, changes = 0, last = null;
  const window_ = () => { acc = 0; n = 0; };
  const api = {
    get on() { return on; },
    /** Off: back to the tier's own quality at once (the caller applies level 0), and nothing is counted. */
    set on(v) { on = !!v; if (!on) { level = 0; slow = good = 0; window_(); } },
    get level() { return level; },
    get levels() { return levels; },
    get step() { return levels[level]; },
    /** QA: go to a level now. */
    force(l) { level = Math.max(0, Math.min(max, Math.round(Number(l) || 0))); slow = good = 0; sinceUp = Infinity; changes++; last = { why: 'forced', level, at: Math.round(seen * 10) / 10 }; return level; },
    reset() { level = 0; seen = acc = n = slow = good = 0; upWait = upAfter; sinceUp = Infinity; fps = null; last = null; },
    /**
     * One frame of `dt` seconds. active: a round is being played with the page in view (frames in a menu, a hidden
     * tab or a pause say nothing about the game). → true when the level changed.
     */
    frame(dt, { active = true } = {}) {
      if (!on || !(dt > 0)) return false;
      if (!active || dt > 0.5) { window_(); return false; }   // a hitch of half a second is a tab coming back, not slowness
      seen += dt;
      if (seen < warmup) return false;                          // shaders compile in the first seconds
      acc += dt; n++;
      if (acc < window) return false;
      fps = n / acc; window_();
      if (fps > best) best = fps;
      const rate = rateOf(best);
      if (fps < rate * down) {
        good = 0;
        if (++slow < slowWindows || level >= max) return false;
        slow = 0;
        // short again soon after a step up: that try failed, the next waits longer
        if (sinceUp < probe) upWait = Math.min(upMax, upWait * 2);
        sinceUp = Infinity;
        level++; changes++;
        last = { why: 'short', fps: Math.round(fps * 10) / 10, rate, level, at: Math.round(seen * 10) / 10 };
        return true;
      }
      slow = 0;
      good = fps >= rate * up ? good + window : 0;
      if (sinceUp < Infinity) { sinceUp += window; if (sinceUp >= probe * 3) { sinceUp = Infinity; upWait = upAfter; } }   // the step up held
      if (level > 0 && good >= upWait) {
        good = 0; sinceUp = 0;
        level--; changes++;
        last = { why: 'room', fps: Math.round(fps * 10) / 10, rate, level, at: Math.round(seen * 10) / 10 };
        return true;
      }
      return false;
    },
    observe: () => ({ on, level, of: max, step: { ...levels[level] }, rate: best ? rateOf(best) : null, best: Math.round(best * 10) / 10, fps: fps === null ? null : Math.round(fps * 10) / 10, upWait, changes, last }),
  };
  return api;
}

/**
 * config/look.json's values with a level applied, for gf/forge/look.js `pack(look, tier)`: the render scale (never
 * under `floor`, the share of the canvas that is one CSS pixel), the particle budget and the shadowed fires as shares
 * of what the tier itself allows (`TIERS`: look.js's).
 */
export function lookFor(look = {}, tier = 'high', step = LEVELS[0], { TIERS = {}, floor = 0.25, width = 0 } = {}) {
  if (!step || (step.scale >= 1 && step.particles >= 1 && step.fires >= 1)) return look;
  const T = TIERS[tier] ?? {}, cap = (v, c) => (c === undefined ? v : Math.min(v, c));
  const base = Number.isFinite(Number(look.renderScale)) ? Number(look.renderScale) : 1;
  // the share of the canvas the scene is drawn at now: the look's own scale, and its `detail` cap on the scene's width
  // (a phone's 2532 px canvas is drawn 1440 px wide: a step must lower that, not a number already above it). `width`:
  // the canvas's own, in pixels
  const detail = Number(look.detail) || 0;
  const now = width > 0 && detail > 0 ? Math.min(base, detail / width) : base;
  const out = { ...look, renderScale: Math.min(base, Math.max(Math.min(now, floor), now * step.scale)) };
  if (look.particles !== undefined || T.budget !== undefined) {
    const budget = cap(Number.isFinite(Number(look.particles?.budget)) ? Number(look.particles.budget) : 2048, T.budget);
    out.particles = { ...(look.particles ?? {}), budget: Math.max(64, Math.round(budget * step.particles)) };
  }
  if (look.fire !== undefined) {
    const fires = cap(Number(look.fire?.shadows) || 0, T.fireShadows);
    out.fire = { ...look.fire, shadows: Math.round(fires * step.fires) };
  }
  return out;
}

/** The player's own choice for this game (the Settings toggle), kept in the browser: on unless they turned it off. */
const KEY = game => `gf3-forge:${game}`;
export function loadChoice(game) { try { return JSON.parse(localStorage.getItem(KEY(game)) ?? '{}') ?? {}; } catch { return {}; } }
export function saveChoice(game, patch) { try { localStorage.setItem(KEY(game), JSON.stringify({ ...loadChoice(game), ...patch })); } catch { /* private mode: for this visit only */ } }

/**
 * A row in the kit's Settings panel (gf/three/ui/menu.js draws #gf-settings-panel afresh each time it opens; the forge
 * boot calls this every frame the menu is open, and a row already there is left alone). → the input, or null.
 */
export function settingsRow(id, label, { type = 'checkbox', value, min, max, step, format = v => String(v), set } = {}) {
  const panel = typeof document !== 'undefined' ? document.getElementById('gf-settings-panel') : null;
  if (!panel) return null;
  const had = panel.querySelector(`#${id}`);
  if (had) return had;
  const l = document.createElement('label'); l.className = 'gf-set';
  const s = document.createElement('span'); s.textContent = label;
  const c = document.createElement('input'); c.type = type; c.id = id;
  if (type === 'range') {
    const o = document.createElement('output'); o.textContent = format(value);
    c.min = min; c.max = max; c.step = step; c.value = String(value);
    c.addEventListener('input', () => { set?.(c.valueAsNumber, c); o.textContent = format(c.valueAsNumber); });
    l.append(s, o, c);
  } else {
    c.checked = !!value;
    c.addEventListener('change', () => set?.(c.checked, c));
    l.append(s, c);
  }
  // before the Graphics row (the panel's last), so the kit's own rows stay where players know them
  const graphics = panel.querySelector('#gf-quality')?.closest('label');
  if (graphics) panel.insertBefore(l, graphics); else panel.append(l);
  return c;
}
