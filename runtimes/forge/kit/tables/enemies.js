// spec.forge.enemies[]: the enemy types (owner: forge-ai, track A). A row names an `archetype` (its behaviour) and
// starts from that archetype's values; anything it sets itself wins. Defaults are the measured feel targets
// (research/rust-engine/feel-targets.md moment 13 and target 9). Every number, colour and switch is a slot
// (forge.enemies.<id>.<field>); the eye colour is how a type reads at a glance. Clip names and the body are texts (not
// slots): they name a clip in the gf-humanoid-1 forge clip file and a body in research/gf-forge/library.
//
// forge-ai (research/gf-forge/core/forge-ai) reads every field below; its Rust defaults equal these (a cargo test holds
// them to research/gf-forge/fixtures/ai/tables/archetypes.json, which `node research/gf-forge/tools/ai-tables.mjs --write`
// writes from this file).
import { num, int, bool, color, text, choice, sound, ref, obj, id } from './fields.js';

export const ARCHETYPES = ['chaser', 'runner', 'caster', 'shield', 'brute', 'boss'];

export const fields = {
  id: id(),
  name: text('', 'Name', 'What the HUD calls it'),
  archetype: choice('chaser', ARCHETYPES, 'Archetype', 'chaser (rises, closes in and lunges), runner (a faster chaser), caster (seeks a clear lane and throws), shield (blocks from the front: flank it, break the shield or overwhelm it), brute (slow, a long tell, a slam that knocks you down), boss (phases, telegraphed slams, combos, summons and a charge)'),
  body: text('skeleton-grim-chaser', 'Body', 'A library body on gf-humanoid-1 (research/gf-forge/library/bodies/<body>.glb)'),
  health: num(30, 1, 100000, 'hp', 'Health', 'Hit points', 'main'),
  speed: num(3.3, 0, 30, 'm/s', 'Chase speed', 'Its top speed (moment 13: 3.3 for a chaser, 4.2 for a runner, against the player\'s 7.8)', 'main'),
  damage: num(13, 0, 10000, 'hp', 'Damage', 'A hit\'s damage (moment 13: 12-15)'),
  reach: num(0.9, 0.2, 30, 'm', 'Reach', 'It stops this far from its target to attack (moment 13: 0.8-0.95 m)'),
  windup: num(0.3, 0, 5, 's', 'Windup', 'The tell before a hit: its eyes ramp up (feel target 9: 0.27-0.33 s)'),
  lunge: obj({
    distance: num(0.5, 0, 5, 'm', 'distance', 'How far it lunges into the hit (feel target 9: about 0.5 m)'),
    time: num(0.067, 0.01, 1, 's', 'time', 'How fast (feel target 9: about 67 ms)'),
    dip: num(0.12, 0, 1, 'm', 'dip', 'How far it ducks into it (feel target 9: 10-15 cm)'),
  }, 'Lunge'),
  recover: num(0.25, 0, 5, 's', 'Recovery', 'Backing off after a hit (moment 13: 200-270 ms)'),
  backoff: num(0.2, 0, 3, 'm', 'Back-off', 'How far it steps back while it recovers (moment 13: back out to 0.45-0.65 m)'),
  cooldown: num(1.1, 0, 10, 's', 'Attack cooldown', 'Seconds from one hit to its next (moment 13: 0.9-1.4 s)'),
  radius: num(0.35, 0.1, 3, 'm', 'Body radius', 'Its capsule'),
  height: num(1.8, 0.3, 6, 'm', 'Body height', 'Its capsule'),
  scale: num(1, 0.2, 5, '×', 'Size', 'Its body\'s scale (a chaser is 1.1, its head level with the player\'s eyes; a runner 0.92 of that: moment 13)'),
  tint: color('#ffffff', 'Tint', 'Its body\'s tint'),
  turn: num(540, 10, 3600, '°/s', 'Turn rate', 'How fast it turns to face its target (a slow-turning shield-bearer can be flanked)'),
  ring: num(2.4, 0.5, 20, 'm', 'Waiting ring', 'How far it circles its target while others hold the attack tokens'),
  climb: num(0, 0, 1, 'm', 'Climbs', 'The highest ledge it walks up without jumping (0: none; climbing costs a crowd more)'),
  eye: obj({
    color: color('#ffaf48', 'colour', 'Its eye glow, by type (moment 13: orange for a chaser)', 'main'),
    glow: num(2.4, 0, 20, '', 'glow', 'Eye glow at rest (moment 13: 2.3-2.5)'),
    windupGlow: num(0.13, 0, 2, '', 'windup glow', 'How much brighter the eyes get through the windup, as a share (feel target 9: +12-15%)'),
  }, 'Eyes'),
  arrival: obj({
    emerge: bool(true, 'from the ground', 'It rises out of the ground (moment 13)'),
    depth: num(0.5, 0, 3, 'm', 'depth', 'How far under it starts (moment 13: 0.45-0.5 m)'),
    hold: num(0.2, 0, 3, 's', 'hold', 'It waits before rising (moment 13: about 200 ms)'),
    time: num(1.0, 0, 5, 's', 'time', 'Until it stands and chases (moment 13: about 1 s)'),
  }, 'Arrival'),
  ranged: obj({
    range: num(12, 0, 200, 'm', 'range', 'How far it throws from (0: no ranged attack)'),
    keep: num(6, 0, 100, 'm', 'keep away', 'It backs off when a target comes closer than this'),
    speed: num(12, 0.5, 200, 'm/s', 'shot speed', 'Its projectile\'s speed (moment 13: about 12 m/s for a fireball)'),
    windup: num(0.34, 0, 5, 's', 'windup', 'Before the release (moment 13: about 340 ms)'),
    color: color('#fe6c19', 'shot colour', 'Its projectile\'s light (moment 13: (0.99, 0.15, 0.01) linear)'),
    light: num(4.6, 0, 30, 'm', 'shot light radius', 'Its projectile\'s light reach (moment 13: 4.6 m)'),
    intensity: num(6, 0, 50, '', 'shot light intensity', 'Its projectile\'s light (moment 13: about 6)'),
  }, 'Ranged'),
  shield: obj({
    arc: num(140, 10, 360, '°', 'arc', 'The shield covers this much of its front'),
    block: num(0.15, 0, 1, '×', 'blocked damage', 'The share of a hit that gets through the shield'),
    hp: num(60, 1, 100000, 'hp', 'shield strength', 'Damage the shield takes before it breaks'),
    stagger: num(0.8, 0, 5, 's', 'break stagger', 'It reels this long when the shield breaks'),
    overwhelmHits: int(4, 1, 50, '', 'overwhelm hits', 'This many hits on it within the window drop its guard'),
    overwhelmWindow: num(1.2, 0.1, 10, 's', 'overwhelm window', 'The window for those hits'),
    overwhelmTime: num(1.5, 0, 10, 's', 'guard down', 'How long its guard stays down when overwhelmed'),
  }, 'Shield'),
  slam: obj({
    radius: num(2.2, 0.3, 20, 'm', 'radius', 'How far its slam reaches'),
    arc: num(140, 10, 360, '°', 'arc', 'How wide in front'),
    knock: bool(true, 'knocks down', 'A slam knocks the player down (fair play: at most one knockdown in 3 s, at most 0.8 s)'),
    knockTime: num(0.6, 0, 0.8, 's', 'knockdown time', 'How long the player stays down'),
    knockSpeed: num(6, 0, 20, 'm/s', 'knock speed', 'How hard the player is thrown back'),
  }, 'Slam'),
  boss: obj({
    phases: int(3, 1, 3, '', 'phases', 'Its health splits into this many phases; each new phase adds an attack'),
    roar: num(1.6, 0, 5, 's', 'roar', 'Between phases it roars this long and cannot be hurt'),
    summon: ref('enemies', 'summons', 'The enemy type it raises from the ground in phase 2 and after'),
    summonCount: int(3, 0, 12, '', 'summon count', 'How many it raises each time'),
    chargeSpeed: num(12, 0, 40, 'm/s', 'charge speed', 'Its charge in the last phase'),
    chargeDistance: num(8, 0, 30, 'm', 'charge distance', 'How far it charges'),
  }, 'Boss'),
  react: obj({
    spring: num(5, 0, 40, 'rad/s', 'flinch', 'How hard a hit kicks the bone it lands on (0: off, when the weapons drive the springs)'),
    stagger: num(0.35, 0, 10, '×', 'stagger at', 'One hit this share of its health or more makes it reel (cancels a windup)'),
    knock: num(0.6, 0, 10, '×', 'knockdown at', 'One hit this share of its health or more knocks it down'),
    down: num(1.0, 0, 10, 's', 'down time', 'How long it lies down when knocked down'),
    getup: num(1.0, 0, 10, 's', 'get-up time', 'How long it takes to get up'),
  }, 'Reactions'),
  score: int(10, 0, 100000, 'pts', 'Score', 'Points for a kill'),
  coins: int(1, 0, 1000, '', 'Coins', 'Coins a kill drops'),
  debris: int(48, 0, 200, 'pieces', 'Kill debris', 'Pieces it breaks into (feel target 8: 40-55)'),
  // sound ids: the library's where it has one (research/gf-forge/library/sounds/sounds.json), so a game that takes the
  // library's sounds list hears them; a preset otherwise
  sounds: obj({
    attack: sound('enemy-attack', 'hit-crunch', 'An enemy attacks'),
    hurt: sound('impact-bone', 'hit-soft', 'An enemy is hit'),
    die: sound('bone-break', 'explosion-small', 'An enemy breaks apart'),
    spawn: sound('enemy-emerge', 'door', 'An enemy rises'),
    tell: sound('enemy-windup', 'arrow-whoosh', 'An enemy winds up'),
    cast: sound('enemy-cast', 'laser-soft', 'An enemy casts'),
    impact: sound('enemy-orb-impact', 'hit-soft', 'An enemy\'s shot lands'),
    slam: sound('boss-slam', 'explosion-big', 'A heavy slam'),
    roar: sound('boss-roar', 'alarm', 'A roar'),
    block: sound('shield-block', 'hit-crunch', 'A shield blocks'),
    shatter: sound('shield-break', 'explosion-small', 'A shield breaks'),
  }),
  clips: obj({
    arrive: text('emerge', 'arrive'), idle: text('idle_combat', 'idle'), move: text('run', 'move'), tell: text('windup', 'tell'),
    attack: text('lunge', 'attack'), recover: text('recover', 'recover'),
    hitFront: text('hit_front', 'hit from the front'), hitBack: text('hit_back', 'hit from behind'), hitLeft: text('hit_left', 'hit from the left'), hitRight: text('hit_right', 'hit from the right'),
    fall: text('knockdown', 'knocked down'), rise: text('getup', 'get up'), die: text('death', 'death'),
    roar: text('taunt', 'roar'), combo1: text('slash_1', 'combo 1'), combo2: text('slash_2', 'combo 2'), combo3: text('slash_3', 'combo 3'),
    guard: text('block', 'guard'), blocked: text('block_hit', 'blocked'),
  }, 'Clips'),
};

/** Per archetype: the values a row starts from (over the field defaults). Bodies and eye colours are the library's
 *  grim set (research/gf-forge/library/catalog.json roles enemy.skeleton.*). */
export const archetypes = {
  // a body is built 1.75 m tall and the player's eyes are at 1.74 m: at 1.1 a chaser's head is level with them, so a
  // round fired with no up or down aim lands (measured on Bone Vigil, 2026-10-11: 20 of 68 at 1.0, 35 of 57 at 1.12)
  chaser: { scale: 1.1, ranged: { range: 0 } },
  runner: { speed: 4.2, scale: 1.01, tint: '#ffe2c8', eye: { color: '#ff4224' }, ranged: { range: 0 } },
  caster: { body: 'skeleton-grim-caster', scale: 1.1, speed: 2.4, health: 25, reach: 1.0, cooldown: 2.2, eye: { color: '#4bffc0' }, ranged: { range: 12, keep: 6, speed: 24, windup: 0.34, color: '#3ffa8b', light: 4.6, intensity: 6 }, clips: { move: 'walk', tell: 'cast_windup', attack: 'cast' } },
  shield: { body: 'skeleton-grim-soldier', scale: 1.1, speed: 2.8, health: 60, damage: 15, turn: 140, eye: { color: '#ff4224' }, ranged: { range: 0 }, clips: { move: 'walk' } },
  brute: { body: 'skeleton-grim-brute', speed: 2.6, health: 120, damage: 25, reach: 1.5, radius: 0.5, height: 2.2, windup: 0.8, recover: 0.9, backoff: 0, cooldown: 2.4, turn: 200, ring: 3.2, eye: { color: '#ff8930' }, ranged: { range: 0 }, react: { stagger: 0.5, knock: 2 }, score: 40, coins: 4, clips: { move: 'walk', attack: 'heavy', hitFront: 'hit_heavy', hitBack: 'hit_heavy', hitLeft: 'hit_heavy', hitRight: 'hit_heavy' } },
  boss: { body: 'skeleton-grim-lord', speed: 2.4, health: 1500, damage: 30, reach: 2.4, radius: 0.6, height: 2.6, windup: 0.9, recover: 1.0, backoff: 0, cooldown: 1.6, turn: 220, ring: 4, eye: { color: '#ff7027', glow: 3.0 }, arrival: { time: 1.8 }, ranged: { range: 0 }, slam: { radius: 3.0, arc: 160, knockTime: 0.7 }, react: { stagger: 2, knock: 2 }, score: 500, coins: 25, clips: { arrive: 'emerge_leap', move: 'walk', attack: 'heavy', hitFront: 'hit_heavy', hitBack: 'hit_heavy', hitLeft: 'hit_heavy', hitRight: 'hit_heavy' } },
};

export const owner = 'forge-ai (track A)';
