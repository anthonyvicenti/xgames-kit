// spec.forge.feel: how hits, kills, combos, aim help, low health and death feel (owner: forge-feel, track F; the
// player's own movement, evade, head and hurt values are in player.js). Defaults are the measured feel targets
// (research/rust-engine/feel-targets.md: "the ten that matter most" 7, 8 and 10, moments 11, 12, 14, 15 and 19); [E]
// marks an estimate. forge-feel's config.rs reads the same names with the same defaults (its test holds them to
// kit/tables/defaults.json).
import { num, int, bool, color, sound, words, obj } from './fields.js';

export const fields = {
  combo: obj({
    window: num(2.5, 0.1, 30, 's', 'combo window', 'Seconds a combo lasts without a new kill; its bar drains over them (not measured yet [E])'),
    step: num(0.1, 0, 5, '×', 'per kill', 'What each kill adds to the multiplier (moment 12: ×1.1, ×1.2, …)'),
    max: num(5, 1, 100, '×', 'highest', 'The highest the multiplier goes [E]'),
  }, 'Combo'),
  regions: obj({
    body: num(1, 0, 10, '×', 'body', 'Damage on the torso, pelvis or a body without parts'),
    arms: num(0.8, 0, 10, '×', 'arms', 'Damage on an arm [E]'),
    legs: num(0.8, 0, 10, '×', 'legs', 'Damage on a leg [E]'),
  }, 'Hit regions (a head is a critical hit: the weapon\'s critical multiplier)'),
  hits: obj({
    flash: num(0.042, 0, 1, 's', 'body flash', 'How long a hit enemy flashes white (target 7: 2-3 frames)'),
    flashColor: color('#ffffff', 'flash colour', 'The colour a hit enemy flashes (target 7: flat white)'),
    numbers: bool(true, 'damage numbers', 'Numbers pop from each hit, gold and larger on a critical hit (moment 12)'),
  }, 'Hits'),
  kill: obj({
    pieces: int(48, 0, 200, 'pieces', 'pieces', 'What a kill breaks into when its enemy says nothing (target 8: 40-55)'),
    budget: int(160, 0, 2000, 'pieces', 'debris budget', 'The most pieces flying at once (the physics steps them); the oldest go first, so phones hold 60 fps [E]'),
    rest: int(400, 0, 1500, 'pieces', 'pieces that stay', 'Pieces that came to rest stay on the ground, asleep (no physics), up to this many; past it the oldest fade out (0: a piece at rest goes at once)'),
    restFade: num(0.6, 0, 10, 's', 'fade', 'Seconds the oldest resting piece takes to shrink away'),
    burst: num(4.5, 0, 60, 'm/s', 'burst speed', 'How fast the pieces fly out (moment 11) [E]'),
    knockSpeed: num(4, 0, 100, 'm/s', 'knock speed', 'A piece this fast knocks down the enemy it hits and severs that part (moment 11)'),
    knockTime: num(1.2, 0, 10, 's', 'knocked down', 'Seconds a knocked-down enemy stays down and cannot attack [E]'),
    knockDamage: num(10, 0, 10000, 'hp', 'knock damage', 'What a knock-down costs the enemy [E]'),
    shed: int(30, 0, 200, 'pieces', 'shed', 'Pieces a severed enemy sheds (moment 11: about 30)'),
    coins: bool(true, 'coins', 'A kill drops coins that fly to the player (moment 12)'),
    coinValue: num(1, 0, 10000, '', 'coin value', 'What a coin is worth to the rules'),
    sounds: obj({
      crack: sound('bone-break', 'hit-crunch', 'A kill: the bone break'),
      shatter: sound('bone-shatter', 'explosion-small', 'A kill: the shatter'),
      knock: sound('impact-bone', 'hit-soft', 'A kill: the knock'),
      coin: sound('pickup-coin', 'coin', 'A coin picked up'),
    }),
  }, 'Kills'),
  aimAssist: obj({
    touch: bool(true, 'on touch', 'Aim help for players on a touch screen'),
    mouse: bool(false, 'on mouse', 'Aim help for players with a mouse'),
    cone: num(6, 0, 45, '°', 'cone', 'A target within this many degrees of the aim is helped'),
    pull: num(3, 0, 30, '/s', 'pull', 'How fast the aim turns toward it (a share of the gap a second)'),
    range: num(30, 1, 500, 'm', 'range', 'How far aim help reaches'),
  }, 'Aim help'),
  gyro: obj({
    sensitivity: num(1, 0.1, 4, '×', 'sensitivity', 'With gyro aim on (a phone, the player\'s own choice in Settings): how far the view turns for a turn of the phone (1: as far as the phone)'),
  }, 'Gyro aim'),
  // a phone's buttons (wave 5, track U2; gf/forge/hud.js draws them and lays them out from these; the core reads none
  // of it). The creator, 2026-10-11: "make the mobile controls a bit more friendsly, the HUD on the right takes up too
  // much of the screen". verify check 13's phone leg (tools/lib/forge-touch-check.mjs) holds the defaults
  touch: obj({
    size: num(46, 44, 96, 'px', 'button size', 'How wide each button is on a phone (a thumb needs 44)'),
    fire: num(60, 44, 128, 'px', 'fire button size', 'How wide the fire button is'),
    gap: num(10, 2, 40, 'px', 'gap', 'The space between the buttons'),
    edge: num(12, 0, 60, 'px', 'edge', 'How far the buttons keep from the screen\'s edge'),
    lift: num(30, 0, 200, 'px', 'lift when upright', 'How much higher the buttons sit when the phone is held upright'),
    rest: num(0.6, 0.15, 1, '', 'at rest', 'How solid a button is drawn until a thumb is on it (1: solid)'),
    discs: bool(false, 'dark discs', 'A dark disc behind each button'),
    words: bool(false, 'words', 'Each button\'s name written on it in place of its picture'),
    hint: num(6, 0, 60, 's', 'names at the start', 'Seconds each round shows the buttons\' names under them and a line on how a phone plays (0: never)'),
    tip: words('Left thumb moves, right thumb looks', 'how a phone plays', 'One line shown with the names at the start of a round', 60),
    autoTip: words('Aim at an enemy and it fires by itself', 'how auto-fire works', 'Shown beside it while auto-fire is on', 60),
    always: bool(false, 'every button always', 'Show every button all the time, not only when it can do something (reload with rounds spent, the quick strike with an enemy close, swap with a second weapon, raise beside a fallen friend)'),
    autoFire: obj({
      on: bool(true, 'on', 'On a touch screen the weapon fires by itself while the aim rests on an enemy (a player can turn it off in Settings)'),
      cone: num(2.5, 0.2, 20, '°', 'cone', 'How near the aim must be to an enemy'),
      delay: num(0.12, 0, 2, 's', 'delay', 'How long the aim rests on an enemy before the first shot'),
      range: num(30, 1, 500, 'm', 'range', 'How far away an enemy can be'),
    }, 'auto-fire'),
  }, 'Touch buttons'),
  lowHealth: obj({
    stage1: num(0.15, 0, 1, '', 'first stage', 'Health share where the edges start to darken red (documented: 15%)'),
    stage2: num(0.1, 0, 1, '', 'second stage', 'Health share of the second stage (documented: 10%)'),
    stage3: num(0.05, 0, 1, '', 'third stage', 'Health share of the last stage (documented: 5%)'),
    sound: sound('player-lowhealth', 'hit-soft', 'A heartbeat as health drops into each low stage'),
  }, 'Low health'),
  death: obj({
    recap: num(8, 0, 60, 's', 'last impacts', 'The death screen lists the hits of this many seconds before (moment 19: 8 s)'),
  }, 'Death'),
};

export const owner = 'forge-feel (track F)';
