// gf-three vfx: the kit's preset table. Pure data. A game's config/game.json → vfx.<name> is a COPY of one of these
// (create writes it for the effects a spec's mechanics name), and every value in the copy is a slot, so a creator or
// Studio changes the copy, never this table. `texture` names the stand-in sprite (kit/vfx/standin/<texture>.png) the
// game gets as assets/textures/vfx-<name>.png. Starting values for the burst presets follow GameFactory-3A's vfx-kit
// (Apache-2.0; see ATTRIBUTION.md) in spirit: the parameter names are its vocabulary, the numbers were tuned here.
export const PRESETS = Object.freeze({
  'spark-burst': { label: 'Spark burst', describe: 'A pop of stretched sparks: a hit, a pickup, a bounce', texture: 'glow', color: '#ffb23a', colorEnd: '#ff5a1f',
    shape: { count: 24, speed: 7, life: 0.45, size: 0.17, gravity: 12, drag: 1.5, spread: 0.9, up: 0.35, stretch: 3, fade: 1.2, shrink: 0.6, intensity: 2.2, blending: 'additive' } },
  'impact-flash': { label: 'Impact flash', describe: 'A bright ring of light thrown outward: a heavy hit, a landing', texture: 'glow', color: '#ffe2b0', colorEnd: '#8fd0ff',
    shape: { count: 18, emitter: 'ring', radius: 0.22, outward: 1, speed: 5.5, speedJitter: 0.2, life: 0.28, lifeJitter: 0.2, size: 0.28, sizeJitter: 0.3, gravity: 0, drag: 4, spread: 1, up: 0, stretch: 2.5, fade: 1, shrink: 0.9, intensity: 0.9, blending: 'additive' } },
  'smoke-puff': { label: 'Smoke puff', describe: 'A cartoon puff of smoke that rises, swells and shrinks away', texture: 'puff', color: '#c9c9d2', colorEnd: '#7e7e8a',
    shape: { count: 9, emitter: 'sphere', radius: 0.12, speed: 1.1, speedJitter: 0.5, life: 1, lifeJitter: 0.3, size: 0.5, sizeJitter: 0.3, gravity: -1.6, drag: 2, spread: 1, up: 0.6, stretch: 0, spin: 1.4, fade: 1, shrink: 0.9, grow: 2.2, intensity: 1, blending: 'normal' } },
  'dust-kick': { label: 'Dust kick', describe: 'A low ring of dust kicked up by a landing or a slide', texture: 'puff', color: '#d6c7a4', colorEnd: '#a8977a',
    shape: { count: 12, emitter: 'disc', radius: 0.25, outward: 1, speed: 2.2, speedJitter: 0.4, life: 0.6, lifeJitter: 0.3, size: 0.32, sizeJitter: 0.3, gravity: 0, drag: 3, spread: 1, up: 0.12, stretch: 0, spin: 1, fade: 1, shrink: 0.9, grow: 2, intensity: 1, blending: 'normal' } },
  'fire': { label: 'Fire', describe: 'A flame that burns where it is put (continuous: follow it on an object)', texture: 'glow', color: '#ffb347', colorEnd: '#ff3b1f',
    shape: { count: 10, rate: 46, emitter: 'disc', radius: 0.12, speed: 1.1, speedJitter: 0.4, life: 0.62, lifeJitter: 0.3, size: 0.4, sizeJitter: 0.3, gravity: -5, drag: 1.2, spread: 0.5, up: 1.1, stretch: 0, spin: 2, fade: 1, shrink: 0.95, intensity: 1.5, blending: 'additive' } },
  'magic-sparkle': { label: 'Magic sparkle', describe: 'A ring of little lights drifting upward (continuous: follow it on an object)', texture: 'glow', color: '#b388ff', colorEnd: '#6ad7ff',
    shape: { count: 16, rate: 30, emitter: 'ring', radius: 0.5, speed: 0.5, speedJitter: 0.5, life: 0.95, lifeJitter: 0.3, size: 0.15, sizeJitter: 0.4, gravity: -1.2, drag: 1, spread: 0.4, up: 1.6, stretch: 0, spin: 3, fade: 1.4, shrink: 0.7, intensity: 1.8, blending: 'additive' } },
  'confetti': { label: 'Confetti', describe: 'A burst of coloured paper that tumbles down: a win, a goal', texture: 'dot', color: '#ff5ea8', colorEnd: '#ffd166',
    shape: { count: 44, emitter: 'sphere', radius: 0.15, speed: 8, speedJitter: 0.5, life: 1.7, lifeJitter: 0.3, size: 0.13, sizeJitter: 0.4, gravity: 9, drag: 1.3, spread: 0.85, up: 0.8, stretch: 0, spin: 9, fade: 1, shrink: 0.25, hueJitter: 1, intensity: 1, blending: 'normal' } },
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/** The config/game.json → vfx entry for a preset (a deep copy: the game owns it). */
export function configFor(name, texturePath) {
  const p = PRESETS[name];
  if (!p) return null;
  return { color: p.color, colorEnd: p.colorEnd, texture: texturePath ?? `assets/textures/vfx-${name}.png`, shape: { ...p.shape } };
}
