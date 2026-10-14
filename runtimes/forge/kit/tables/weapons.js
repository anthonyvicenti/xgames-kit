// spec.forge.weapons[]: the player's weapons (owner: forge-feel, track F). A row names a `kind` (the mechanism) and may
// start from a `preset` (a weapon whose numbers are the measured feel targets: research/rust-engine/feel-targets.md
// moments 8-11); anything it sets itself wins. Every value is a slot (forge.weapons.<id>.<field>). forge-feel fills a
// row the same way in Rust (weapon_defs.rs; its test holds the two to research/gf-forge/fixtures/feel/data/weapons.json,
// written by `node research/gf-forge/tools/tables.mjs --write`).
import { num, int, bool, color, text, choice, sound, obj, id } from './fields.js';

export const KINDS = ['hitscan', 'projectile', 'melee', 'beam', 'charge'];

export const fields = {
  id: id(),
  name: text('', 'Name', 'What the HUD and the cards call it'),
  kind: choice('projectile', KINDS, 'Kind', 'hitscan (instant rays), projectile (a flying shot), melee (a swing), beam (held, continuous), charge (hold to power up, release to fire)'),
  preset: choice('', ['', 'pistol', 'shotgun', 'repeater', 'blade'], 'Preset', 'Start from a measured weapon (its numbers, then this row\'s own)'),
  slot: int(1, 1, 4, '', 'Key', 'The number key that selects it'),
  start: bool(true, 'In hand at the start', 'The player starts with it; the rules can give the others (a card, a pickup)'),
  damage: num(20, 0, 10000, 'hp', 'Damage', 'A hit\'s damage (each pellet\'s, for several)', 'main'),
  critMultiplier: num(2, 1, 10, '×', 'Critical multiplier', 'Damage on a critical region (a head)'),
  fireInterval: num(0.25, 0.02, 10, 's', 'Time between shots', 'Rounded to whole 120 Hz steps (feel target 10: 12-14 steps for 9 a second)'),
  auto: bool(false, 'Automatic', 'Held fire keeps firing'),
  magazine: int(6, 0, 999, '', 'Magazine', 'Shots before a reload (0: never reloads)'),
  reload: num(0.94, 0, 10, 's', 'Reload time', 'Seconds to reload (it reloads by itself when empty)'),
  raise: num(0.2, 0, 2, 's', 'Raise time', 'Seconds to bring it up after switching to it, before it fires [E]'),
  pellets: int(1, 1, 64, '', 'Pellets', 'Rays or shots a trigger pull fires'),
  spread: num(0.5, 0, 45, '°', 'Spread', 'The cone pellets scatter in (its full width)'),
  range: num(100, 1, 1000, 'm', 'Range', 'How far it reaches'),
  speed: num(85, 1, 1000, 'm/s', 'Shot speed', 'A projectile\'s speed (feel target 9: 80-90 m/s)'),
  radius: num(0.05, 0, 2, 'm', 'Shot size', 'A projectile\'s radius'),
  knockback: num(2, 0, 100, 'm/s', 'Knockback', 'The push a hit gives'),
  kick: obj({
    pitch: num(0.66, 0, 20, '°', 'pitch', 'The camera\'s upward kick at its peak, on frame 2 (feel target 5)'),
    yaw: num(0.006, 0, 5, '°', 'yaw', 'The sideways kick, alternating (feel targets: at most 0.01°)'),
    half: num(0.07, 0.005, 2, 's', 'half back', 'Seconds to 50% back (moment 9: about 70 ms for the pistol; moment 8: 95 ms for the shotgun)'),
    back: num(0.15, 0.01, 2, 's', 'return', 'Seconds to 90% back (feel target 5: 0.15-0.18)'),
    view: num(0.06, 0, 0.5, '', 'weapon kick', 'The weapon\'s snap up, as a share of the screen height (moment 8: 10% for the shotgun)'),
  }, 'Kick'),
  muzzle: obj({
    color: color('#ffb865', 'colour', 'The muzzle flash light (feel target 6: warm (1.00, 0.48, 0.13) linear)'),
    radius: num(3.4, 0, 30, 'm', 'radius', 'Its reach (feel target 6: 3.4 m)'),
    intensity: num(0.95, 0, 20, '', 'intensity', 'Its peak (feel target 6: 0.95-1.8)'),
    frames: int(2, 1, 30, 'frames', 'frames', 'How long it lasts at 60 Hz (feel target 6: 2-4)'),
    sparks: int(4, 0, 64, '', 'sparks', 'Sparks at the barrel (moment 8)'),
    smoke: num(0.13, 0, 2, 's', 'smoke after', 'A barrel smoke puff this long after the shot (moment 8: about 130 ms; 0: none)'),
  }, 'Muzzle'),
  impact: obj({
    color: color('#ff9945', 'colour', 'The light a hit makes (moment 10: (1.00, 0.32, 0.06) linear)'),
    radius: num(2.5, 0, 30, 'm', 'radius', 'Its reach (moment 10: 2.5 m)'),
    intensity: num(1.17, 0, 20, '', 'intensity', 'Its peak (moment 10: 1.17)'),
    frames: int(4, 1, 30, 'frames', 'frames', 'How long it lasts (moment 10: 4)'),
  }, 'Impact'),
  tracer: color('#ff9a3c', 'Tracer colour', 'A projectile\'s streak (moment 9: thin orange)'),
  melee: obj({
    reach: num(2.2, 0.2, 10, 'm', 'reach', 'How far a swing reaches'),
    arc: num(70, 0, 360, '°', 'arc', 'How wide it sweeps'),
    windup: num(0.045, 0, 2, 's', 'windup', 'Before it swings (moment 11: in view by 45 ms)'),
    contact: num(0.156, 0, 2, 's', 'contact', 'When it lands, from the press (moment 11: 150-170 ms)'),
    recover: num(0.25, 0, 3, 's', 'recover', 'After it lands, before the next [E]'),
    whoosh: num(0.122, 0, 2, 's', 'whoosh', 'When the swing sound starts, from the press (moment 11: about 122 ms)'),
    targets: int(3, 1, 16, '', 'targets', 'The most enemies one swing hits [E]'),
  }, 'Melee'),
  sounds: obj({
    fire: sound('shot', 'pew-retro', 'A shot'),
    reload: sound('reload', 'click', 'A reload'),
    impact: sound('impact', 'hit-soft', 'A shot landing'),
    empty: sound('', 'click', 'Firing empty'),
    swing: sound('swing', 'arrow-whoosh', 'A swing'),
  }),
};

/** Per kind: the values a row of that kind starts from (over the field defaults). */
export const kinds = {
  hitscan: { damage: 12, fireInterval: 0.1, auto: true, magazine: 30, reload: 1.5, speed: 1000, kick: { pitch: 0.3, half: 0.045, back: 0.08 }, muzzle: { intensity: 1.4, frames: 3 } },
  projectile: {},
  melee: { damage: 35, fireInterval: 0.45, magazine: 0, reload: 0, range: 2.2, speed: 1, kick: { pitch: 0, yaw: 0, view: 0 }, muzzle: { intensity: 0, sparks: 0, smoke: 0 }, sounds: { fire: 'swing' } },
  beam: { damage: 60, fireInterval: 0.05, auto: true, magazine: 0, range: 20, kick: { pitch: 0.05 }, muzzle: { smoke: 0 } },
  charge: { damage: 80, fireInterval: 0.8, magazine: 0, speed: 60, kick: { pitch: 1.5 } },
};

/** Weapons whose numbers are the measured feel targets (moments 8-11). Names are generic; sound ids are the forge
 *  library's (research/gf-forge/library/sounds/SOUNDS.md), declared with a gf-audio preset until a game carries them. */
export const presets = {
  // moment 9: 6 rounds, a projectile at about 85 m/s, +0.66° kick peaking on frame 2, a 2-frame light at 0.95
  pistol: { kind: 'projectile', name: 'Sidearm', damage: 20, fireInterval: 0.25, magazine: 6, reload: 0.94, speed: 85, kick: { pitch: 0.66, yaw: 0.006, half: 0.07, back: 0.15, view: 0.06 }, muzzle: { intensity: 0.95, frames: 2 },
    sounds: { fire: 'weapon-pistol-shot', reload: 'weapon-pistol-reload', impact: 'impact-bone', empty: 'weapon-pistol-dry' } },
  // moment 8: 2 shells, single shots, +1.19° at frame 2, back by 0.3 s, a 4-frame light at 1.8, auto-reload in 1.22 s
  shotgun: { kind: 'hitscan', name: 'Scattergun', slot: 2, damage: 9, pellets: 8, spread: 6, auto: false, fireInterval: 0.35, magazine: 2, reload: 1.22, range: 40, kick: { pitch: 1.19, yaw: 0.01, half: 0.095, back: 0.18, view: 0.1 }, muzzle: { intensity: 1.8, frames: 4, sparks: 6 },
    sounds: { fire: 'weapon-shotgun-shot', reload: 'weapon-shotgun-reload', impact: 'impact-bone', empty: 'weapon-shotgun-dry' } },
  // moment 10: about 9 a second (13 steps apart), +0.34° a shot at its peak (0.26° on frame 1), about half back before
  // the next, a 3-frame light
  repeater: { kind: 'hitscan', name: 'Repeater', slot: 3, damage: 10, auto: true, fireInterval: 0.108, magazine: 40, reload: 1.6, spread: 1.2, kick: { pitch: 0.34, yaw: 0.01, half: 0.1, back: 0.18, view: 0.03 }, muzzle: { intensity: 1.2, frames: 3, smoke: 0 },
    sounds: { fire: 'weapon-mg-shot', reload: 'weapon-mg-reload', impact: 'impact-bone', empty: 'weapon-mg-dry' } },
  // moment 11: a quick melee over the gun, contact at about 156 ms, the camera still
  blade: { kind: 'melee', name: 'Blade', slot: 4, damage: 40, melee: { reach: 2.2, arc: 80, windup: 0.045, contact: 0.156, recover: 0.25, whoosh: 0.122 },
    sounds: { fire: 'melee-swing', swing: 'melee-swing', impact: 'melee-hit' } },
};

export const owner = 'forge-feel (track F)';
