// gf-three vfx: the kit's preset table. Pure data. (Sprites: standin/*.png; NOTICE-styles says where the style sprites
// come from: ours, drawn by scripts/make-vfx-standins.mjs, or the asset library's with their licence.) A game's config/game.json → vfx.<name> is a COPY of one of these
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
  'water-splash': { label: 'Water splash', describe: 'A cartoon column of water thrown up where something falls into the sea, falling back as drops', texture: 'puff-toon', color: '#f2fbff', colorEnd: '#8fd3f0',
    shape: { count: 34, emitter: 'disc', radius: 0.45, outward: 0.4, speed: 7.5, speedJitter: 0.45, life: 1.05, lifeJitter: 0.3, size: 0.34, sizeJitter: 0.45, gravity: 15, drag: 0.6, spread: 0.32, up: 2.6, stretch: 0, spin: 0.8, fade: 1, shrink: 0.7, grow: 1.2, intensity: 1, blending: 'normal', solid: 1 } },
  'confetti': { label: 'Confetti', describe: 'A burst of coloured paper that tumbles down: a win, a goal', texture: 'dot', color: '#ff5ea8', colorEnd: '#ffd166',
    shape: { count: 44, emitter: 'sphere', radius: 0.15, speed: 8, speedJitter: 0.5, life: 1.7, lifeJitter: 0.3, size: 0.13, sizeJitter: 0.4, gravity: 9, drag: 1.3, spread: 0.85, up: 0.8, stretch: 0, spin: 9, fade: 1, shrink: 0.25, hueJitter: 1, intensity: 1, blending: 'normal' } },
  // ---- the effect styles' presets (styles.js): a mechanic calls vfx.blast / hit / trail and the game's style picks these ----
  'blast-puffs': { label: 'Blast puffs', describe: 'A cluster of solid round cartoon puffs that swell, drift up and shrink away', texture: 'puff-toon', color: '#f4f4f8', colorEnd: '#d4d5e0',
    shape: { count: 40, emitter: 'sphere', radius: 0.6, outward: 1, speed: 3, speedJitter: 0.7, life: 1.6, lifeJitter: 0.35, size: 0.62, sizeJitter: 0.45, gravity: -0.5, drag: 3.2, spread: 1, up: 0.35, stretch: 0, spin: 0.3, fade: 1, shrink: 1, grow: 1.5, intensity: 1, blending: 'normal', solid: 1 } },
  'blast-core': { label: 'Blast core', describe: 'Warm puffs at the heart of a blast that darken to smoke', texture: 'puff-toon', color: '#f0a040', colorEnd: '#6a5a6a',
    shape: { count: 18, emitter: 'sphere', radius: 0.35, outward: 1, speed: 2.6, speedJitter: 0.5, life: 1.1, lifeJitter: 0.3, size: 0.6, sizeJitter: 0.35, gravity: -1.2, drag: 3, spread: 1, up: 0.5, stretch: 0, spin: 0.4, fade: 1, shrink: 1, grow: 1.45, intensity: 1, blending: 'normal', solid: 1 } },
  'blast-chunks': { label: 'Blast chunks', describe: 'Chunky low-poly rocks thrown far by a blast, tumbling as they fall', mesh: 'chunk', color: '#b39a78', colorEnd: '#9a8466',
    shape: { count: 16, emitter: 'sphere', radius: 0.3, outward: 1, speed: 9, speedJitter: 0.5, life: 1.8, lifeJitter: 0.3, size: 0.17, sizeJitter: 0.45, gravity: 20, drag: 0.3, spread: 1, up: 1.1, stretch: 0, spin: 8, fade: 1, shrink: 0.4, grow: 1, intensity: 1, blending: 'normal', mesh: 'chunk' } },
  'blast-shards': { label: 'Blast shards', describe: 'Thin dark shards thrown fast by a blast', mesh: 'shard', color: '#4f4842', colorEnd: '#3a3430',
    shape: { count: 18, emitter: 'sphere', radius: 0.2, outward: 1, speed: 11, speedJitter: 0.5, life: 1.2, lifeJitter: 0.3, size: 0.14, sizeJitter: 0.5, gravity: 22, drag: 0.4, spread: 1, up: 0.8, stretch: 0, spin: 12, fade: 1, shrink: 0.3, grow: 1, intensity: 1, blending: 'normal', mesh: 'shard' } },
  'blast-bits': { label: 'Blast bits', describe: 'Little bright puffs flung far out of a blast', texture: 'puff-toon', color: '#ffd040', colorEnd: '#f0a030',
    shape: { count: 14, emitter: 'sphere', radius: 0.2, outward: 1, speed: 10, speedJitter: 0.5, life: 1, lifeJitter: 0.4, size: 0.2, sizeJitter: 0.5, gravity: 9, drag: 1.2, spread: 1, up: 0.9, stretch: 0, spin: 1, fade: 1, shrink: 0.8, grow: 1, intensity: 1, blending: 'normal', solid: 1 } },
  'impact-ring': { label: 'Impact ring', describe: 'A drawn shock ring that spreads from a blast or a heavy hit', texture: 'ring', color: '#ffffff', colorEnd: '#ffe7a0',
    shape: { count: 1, emitter: 'point', speed: 0, speedJitter: 0, life: 0.3, lifeJitter: 0, size: 0.9, sizeJitter: 0, gravity: 0, drag: 0, spread: 1, up: 0, stretch: 0, spin: 0, fade: 1, shrink: 0.5, grow: 7, intensity: 1, blending: 'normal', solid: 1, upright: 1 } },
  'hit-stars': { label: 'Hit stars', describe: 'Cartoon stars that spin out of a hit', texture: 'star', color: '#ffd040', colorEnd: '#ff9a20',
    shape: { count: 7, emitter: 'sphere', radius: 0.1, speed: 5, speedJitter: 0.4, life: 0.55, lifeJitter: 0.3, size: 0.32, sizeJitter: 0.3, gravity: 8, drag: 2, spread: 1, up: 0.5, stretch: 0, spin: 5, fade: 1, shrink: 1, grow: 1, intensity: 1, blending: 'normal', solid: 1 } },
  'hit-puff': { label: 'Hit puff', describe: 'A small cartoon puff where a shot lands', texture: 'puff-toon', color: '#f4f4f8', colorEnd: '#d4d5e0',
    shape: { count: 6, emitter: 'sphere', radius: 0.12, outward: 1, speed: 1.6, speedJitter: 0.5, life: 0.6, lifeJitter: 0.3, size: 0.45, sizeJitter: 0.3, gravity: -1, drag: 3, spread: 1, up: 0.3, stretch: 0, spin: 0.4, fade: 1, shrink: 1, grow: 1.5, intensity: 1, blending: 'normal', solid: 1 } },
  'trail-puffs': { label: 'Trail puffs', describe: 'Little round puffs left behind a flying shot (continuous: follow the shot)', texture: 'puff-toon', color: '#f4f4f8', colorEnd: '#dcdce6',
    shape: { count: 3, rate: 20, emitter: 'point', speed: 0.3, speedJitter: 0.5, life: 0.55, lifeJitter: 0.3, size: 0.15, sizeJitter: 0.3, gravity: -0.4, drag: 2, spread: 1, up: 0, stretch: 0, spin: 0.5, fade: 1, shrink: 1, grow: 1.7, intensity: 1, blending: 'normal', solid: 1 } },
  'fireball': { label: 'Fireball', describe: 'A rolling fireball drawn from a flipbook (21 frames)', texture: 'fireball', color: '#ffffff', colorEnd: '#ffffff',
    shape: { count: 1, emitter: 'point', speed: 0, speedJitter: 0, life: 0.85, lifeJitter: 0, size: 3.2, sizeJitter: 0.1, gravity: 0, drag: 0, spread: 1, up: 0, stretch: 0, spin: 0, fade: 1, shrink: 0, grow: 1.15, intensity: 1, blending: 'normal', flipCols: 5, flipRows: 5, flipFrames: 21 } },
  'smoke-wisp': { label: 'Wispy smoke', describe: 'Soft smoke that rises, spreads and thins away', texture: 'smoke-wisp', color: '#9a9aa4', colorEnd: '#4c4c55',
    shape: { count: 10, emitter: 'sphere', radius: 0.4, outward: 1, speed: 1.4, speedJitter: 0.5, life: 2.2, lifeJitter: 0.3, size: 1.5, sizeJitter: 0.4, gravity: -1.2, drag: 1.5, spread: 1, up: 0.6, stretch: 0, spin: 0.6, fade: 1, shrink: 0.3, grow: 2, intensity: 1, blending: 'normal', alpha: 1 } },
  'trail-smoke': { label: 'Smoke trail', describe: 'A thin smoke trail behind a flying shot (continuous: follow the shot)', texture: 'smoke-wisp', color: '#b4b4bc', colorEnd: '#6c6c74',
    shape: { count: 3, rate: 30, emitter: 'point', speed: 0.2, speedJitter: 0.5, life: 0.9, lifeJitter: 0.3, size: 0.4, sizeJitter: 0.3, gravity: -0.6, drag: 1.5, spread: 1, up: 0, stretch: 0, spin: 0.8, fade: 1, shrink: 0.2, grow: 2.5, intensity: 1, blending: 'normal', alpha: 1 } },
  'pixel-burst': { label: 'Pixel burst', describe: 'Square bits thrown out of a blast', texture: 'square', color: '#ffd040', colorEnd: '#ff5a1f',
    shape: { count: 22, emitter: 'sphere', radius: 0.2, outward: 1, speed: 6, speedJitter: 0.5, life: 0.7, lifeJitter: 0.3, size: 0.2, sizeJitter: 0.3, gravity: 10, drag: 1, spread: 1, up: 0.6, stretch: 0, spin: 0, fade: 1, shrink: 0.8, grow: 1, intensity: 1, blending: 'normal', solid: 1, upright: 1 } },
  'pixel-smoke': { label: 'Pixel smoke', describe: 'Square smoke that rises and shrinks away', texture: 'square', color: '#9a9aa4', colorEnd: '#5a5a62',
    shape: { count: 10, emitter: 'sphere', radius: 0.3, outward: 1, speed: 1.2, speedJitter: 0.5, life: 1.2, lifeJitter: 0.3, size: 0.4, sizeJitter: 0.3, gravity: -1.5, drag: 2, spread: 1, up: 0.5, stretch: 0, spin: 0, fade: 1, shrink: 1, grow: 1.6, intensity: 1, blending: 'normal', solid: 1, upright: 1 } },
  'pixel-sparks': { label: 'Pixel sparks', describe: 'Small square sparks out of a hit', texture: 'square', color: '#ffffff', colorEnd: '#ffd040',
    shape: { count: 8, emitter: 'point', speed: 5, speedJitter: 0.4, life: 0.4, lifeJitter: 0.3, size: 0.12, sizeJitter: 0.2, gravity: 6, drag: 1.5, spread: 1, up: 0.3, stretch: 0, spin: 0, fade: 1, shrink: 0.6, grow: 1, intensity: 1, blending: 'normal', solid: 1, upright: 1 } },
  'pixel-trail': { label: 'Pixel trail', describe: 'Square bits left behind a flying shot (continuous: follow the shot)', texture: 'square', color: '#e0e0e8', colorEnd: '#a0a0aa',
    shape: { count: 2, rate: 20, emitter: 'point', speed: 0.2, speedJitter: 0.5, life: 0.5, lifeJitter: 0.3, size: 0.14, sizeJitter: 0.2, gravity: 0, drag: 2, spread: 1, up: 0, stretch: 0, spin: 0, fade: 1, shrink: 1, grow: 1, intensity: 1, blending: 'normal', solid: 1, upright: 1 } },
});

export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/** The config/game.json → vfx entry for a preset (a deep copy: the game owns it). */
export function configFor(name, texturePath) {
  const p = PRESETS[name];
  if (!p) return null;
  // a mesh preset (blast chunks) draws low-poly pieces, not a sprite: it has no texture
  return { color: p.color, colorEnd: p.colorEnd, ...(p.texture ? { texture: texturePath ?? `assets/textures/vfx-${name}.png` } : {}), shape: { ...p.shape } };
}
