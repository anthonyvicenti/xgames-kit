// gf-vista look values (research/super-scenic/PLAN.md §5 wave 1: time of day, sea state, exposure as slots, swapped
// live). Each value is plain data a spec or Studio can set; apply() pushes it into the core exactly the way the core's
// own panel does (core/src/ui/AppUI.js: the sea-state presets, the exposure slider, the time-of-day dial), so a value
// set here and the same value picked in the panel draw the same pixels (the frame comparison relies on it).
import { MathUtils } from '../core/src/engine/index.js';
import { G } from '../core/src/core/Globals.js';

/** Hours of the day by name (24 h clock). The reference pack's matrix uses these six. */
export const HOURS = { dawn: 6.4, morning: 9.5, noon: 12.5, golden: 16.2, sunset: 18.4, night: 21.5 };
/** Sea states by name: wind (m/s), fetch (km), choppiness, swell, surf (shore wave amplitude, m), period (s), whitecaps. */
export const SEAS = {
  calm: { wind: 3.5, fetch: 40, chop: 0.75, swell: 0.28, surf: 0.18, period: 11, whitecaps: 0.2 },
  breezy: { wind: 7, fetch: 120, chop: 0.9, swell: 0.48, surf: 0.34, period: 9, whitecaps: 0.5 },
  choppy: { wind: 12, fetch: 300, chop: 1.05, swell: 0.68, surf: 0.56, period: 8.5, whitecaps: 0.75 },
  storm: { wind: 20, fetch: 900, chop: 1.2, swell: 1.0, surf: 0.9, period: 12, whitecaps: 1 },
};
/**
 * Named looks for a spec's `look.preset` (vista's own names: no other engine uses them). Each is a whole look, named
 * for how it looks rather than for the clock (the reference's 18.4 "sunset" is dusk from most cameras): the hour,
 * the sea state, the exposure (EV), and cloud cover (0..1, the core's default when left out; the core draws the most
 * cumulus near 0.62 and thins them above about 0.7, so no value gives an overcast sky). A spec may still override
 * any one value.
 */
export const PRESETS = {
  'clear-morning': { hour: 9.5, sea: 'calm', exposure: 0, why: 'fresh morning light, glassy turquoise shallows' },
  'bright-noon': { hour: 12.5, sea: 'breezy', exposure: 0, why: 'high sun, clear water over the seabed, crisp cloud shadows' },
  'golden-hour': { hour: 17.6, sea: 'breezy', exposure: 0, why: 'warm low sun on the hills and sand, long shadows' },
  'sunset-glow': { hour: 17.9, sea: 'calm', exposure: 0.3, why: 'the sun on the horizon, gold sky, pink cloud undersides' },
  'moonlit-night': { hour: 21.5, sea: 'calm', exposure: 0.8, why: 'moon and stars, lamp points, a dark glinting sea' },
  'storm-swell': { hour: 14, sea: 'storm', exposure: 0, clouds: 0.62, why: 'a heavy sky, big breaking surf, whitecaps, wind in the palms' },
};
export const DEFAULT_PRESET = 'golden-hour';

/** The slot descriptions the observation interface lists (`__game.looks`) and a spec's look block uses. */
export const LOOKS = {
  hour: { type: 'number', min: 0, max: 24, default: 'golden', names: HOURS, why: 'time of day: the sun, the sky, the light' },
  sea: { type: 'enum', options: Object.keys(SEAS), default: 'breezy', why: 'sea state: wind, waves, surf and whitecaps' },
  exposure: { type: 'number', min: -3, max: 3, default: 0, unit: 'EV', why: 'exposure in stops around the core default' },
  clouds: { type: 'number', min: 0, max: 1, default: 'the core\'s', why: 'cloud cover' },
  veil: { type: 'number', min: 0, max: 1, default: 'the core\'s', why: 'a high veil of thin cloud over the whole sky (1: a grey, overcast day)' },
  haze: { type: 'number', min: 0.5, max: 8, default: 1.6, why: 'the sea air\'s haze: how far you see before the distance turns grey (1.6 a clear day, 4 and up a grey or stormy one)' },
};

export function createLook(app) {
  const fft = app.fft, shore = app.shore;
  const state = { hour: app.settings.timeOfDay, sea: 'breezy', exposure: 0, wind: fft.local.windSpeed, windDir: fft.local.windDirection };
  const cloudsDefault = app.clouds ? app.clouds.coverage.value : null, veilDefault = app.clouds?.params?.fields?.cirrus?.value ?? null, hazeDefault = app.haze?.density?.value ?? null;

  function applySea(name) {
    const p = SEAS[String(name).toLowerCase()];
    if (!p) throw new Error(`unknown sea state "${name}" (${Object.keys(SEAS).join(', ')})`);
    // AppUI's preset apply: spectrum(), whitecaps(), then choppiness and the shore waves
    fft.local.windSpeed = p.wind;
    fft.local.windDirection = state.windDir;
    fft.local.fetch = p.fetch;
    fft.swell.scale = p.swell;
    fft.updateSpectrumUniforms();
    const a = MathUtils.degToRad(state.windDir);
    G.windDir.value.set(Math.cos(a), Math.sin(a));
    G.windSpeed.value = p.wind;
    fft.foamBias.value = 0.5 + 0.16 * p.whitecaps + 0.01 * MathUtils.clamp(p.wind - 7, -5, 12);
    fft.foamDecay.value = 0.6 - 0.35 * p.whitecaps;
    fft.choppiness.value = p.chop;
    shore.amplitude.value = p.surf;
    shore.period.value = p.period;
    state.sea = String(name).toLowerCase();
    state.wind = p.wind;
  }

  function hourOf(v) {
    const h = typeof v === 'string' ? HOURS[v] ?? Number(v) : Number(v);
    if (!Number.isFinite(h)) throw new Error(`unknown hour "${v}" (a number 0-24 or ${Object.keys(HOURS).join(', ')})`);
    return h >= 0 && h < 24 ? h : ((h % 24) + 24) % 24;
  }

  return {
    LOOKS, HOURS, SEAS, PRESETS,
    get state() { return { preset: state.preset ?? null, hour: app.settings.timeOfDay, sea: state.sea, exposure: state.exposure, clouds: app.clouds ? app.clouds.coverage.value : null, veil: app.clouds?.params?.fields?.cirrus?.value ?? null, haze: app.haze?.density?.value ?? null } },
    /** set({preset, hour, sea, exposure}): any subset, applied at once (the next frame draws it); a preset first,
     *  then any single value given beside it */
    set(v = {}) {
      if (v.preset !== undefined) {
        const name = v.preset, p = PRESETS[name];
        if (!p) throw new Error(`unknown look preset "${name}" (${Object.keys(PRESETS).join(', ')})`);
        v = { hour: p.hour, sea: p.sea, exposure: p.exposure, clouds: p.clouds ?? cloudsDefault, veil: p.veil ?? veilDefault, haze: p.haze ?? hazeDefault, ...Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== 'preset' && x !== undefined)) };
        state.preset = name;
      }
      if (v.hour !== undefined) app.settings.timeOfDay = state.hour = hourOf(v.hour);
      if (v.sea !== undefined) applySea(v.sea);
      if (v.exposure !== undefined) {
        const ev = MathUtils.clamp(Number(v.exposure) || 0, -3, 3);
        state.exposure = ev;
        app.settings.exposure = 0.55 * Math.pow(2, ev);   // AppUI's exposure slider
      }
      if (v.clouds !== undefined && v.clouds !== null && app.clouds) app.clouds.coverage.value = MathUtils.clamp(Number(v.clouds), 0, 1);   // AppUI's cloud cover slider
      if (v.veil !== undefined && v.veil !== null && app.clouds?.params?.fields?.cirrus) app.clouds.params.fields.cirrus.value = MathUtils.clamp(Number(v.veil), 0, 1);   // the cirrus veil's amount
      if (v.haze !== undefined && v.haze !== null && app.haze?.density) app.haze.density.value = MathUtils.clamp(Number(v.haze), 0.5, 8);   // the air's haze (post/AirHaze.js)
      return this.state;
    },
  };
}
