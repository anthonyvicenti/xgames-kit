// spec.forge.player: the first-person player (owner: forge-core reads the walk, the jump and the body; forge-feel, track
// F, the first step, evade, stamina, bob and hurt values; with forge-feel installed its controller runs the walk too). Defaults are the measured feel targets
// (research/rust-engine/feel-targets.md: "the ten that matter most" 2-4, moments 5-7 and 14); [E] marks an estimate
// track F tunes. forge-core's PlayerTable::default must equal these (kit/tables/defaults.json, a cargo test).
import { num, obj, sound, words } from './fields.js';

export const fields = {
  walk: num(7.8, 0, 30, 'm/s', 'Walking speed', 'Top speed on foot, the same in every direction; there is no sprint key (feel target 2: 7.8-8.0)', 'main'),
  accelTime: num(0.1, 0, 2, 's', 'Time to full speed', 'Seconds from standing still to 90% of the walking speed (feel target 2: about 0.1)'),
  stopTime: num(0.09, 0, 2, 's', 'Time to stop', 'Seconds from the walking speed to under 10% once the stick is let go (feel target 2: about 0.085)'),
  burst: obj({
    share: num(0.66, 0, 1, '', 'first burst', 'The share of the walking speed the first step reaches straight away (moment 5: 5.3 m/s by 27 ms); the rest closes to 90% at the time to full speed'),
    time: num(0.025, 0.001, 1, 's', 'burst time', 'Seconds the first burst takes (moment 5)'),
  }, 'First step'),
  airControl: num(0.3, 0, 1, '', 'Air control', 'The share of the ground\'s acceleration the player has in the air [E]'),
  jump: num(7.0, 0, 30, 'm/s', 'Jump strength', 'Upward speed a jump starts with (feel target 4: 7.0)', 'main'),
  gravity: num(21.6, 1, 100, 'm/s²', 'Gravity', 'How hard the player falls (feel target 4: 21.6; apex 1.13 m at 0.32 s, 0.65 s in the air)'),
  maxFall: num(40, 1, 200, 'm/s', 'Fastest fall', 'The speed a fall stops growing at'),
  coyote: num(0.1, 0, 0.5, 's', 'Coyote time', 'Seconds after walking off an edge a jump still works [E]'),
  jumpBuffer: num(0.12, 0, 0.5, 's', 'Jump buffer', 'Seconds a jump pressed just before landing waits for the ground [E]'),
  radius: num(0.3, 0.1, 1, 'm', 'Body radius', 'The player\'s capsule'),
  height: num(1.8, 0.8, 3, 'm', 'Body height', 'The player\'s capsule'),
  eye: num(1.74, 0.5, 3, 'm', 'Eye height', 'Eyes above the feet (feel targets: 1.70-1.82)'),
  stepHeight: num(0.35, 0, 1, 'm', 'Step height', 'The highest step walked up without jumping'),
  slopeMax: num(46, 0, 89, '°', 'Steepest slope', 'The steepest slope walked up'),
  snap: num(0.25, 0, 1, 'm', 'Ground snap', 'How far down the ground holds the player when it falls away (stairs down, slopes)'),
  stepEvery: num(2.2, 0.3, 10, 'm', 'Footstep every', 'Metres walked between footsteps (feel target 5: every 0.28 s at 7.8 m/s)'),
  health: num(100, 1, 10000, 'hp', 'Health', 'Hit points (feel target 10: 100 and 20 armour)', 'main'),
  armor: num(20, 0, 10000, 'hp', 'Armour', 'Absorbs damage before health does'),
  fov: num(68, 40, 120, '°', 'Field of view', 'Vertical field of view (feel targets: 68° at 16:9)'),
  evade: obj({
    distance: num(3.0, 0, 20, 'm', 'distance', 'How far an evade carries (feel target 3: about 3 m)'),
    time: num(0.17, 0.05, 1, 's', 'time', 'Seconds the dash is driven before friction stops it (feel target 3: done by about 0.18 s)'),
    peak: num(18, 0, 60, 'm/s', 'peak speed', 'The fastest it may go (feel target 3: about 17 m/s within 65 ms; 17.1-17.4 measured): its speed is the one that carries it the distance, capped here'),
    rise: num(0.035, 0.002, 0.5, 's', 'speed-up', 'How quickly it nears its top speed (moment 7: 5.7, 10.7, 13.2, 15.1 m/s on its first frames)'),
    cooldown: num(1.4, 0, 10, 's', 'cooldown', 'Seconds before the next (measured: more than 0.8 s; documented 1.4 s)'),
    fovPunch: num(2.6, 0, 20, '°', 'FOV punch', 'The field of view jumps this much on its first frame (feel target 3)'),
    fovTime: num(0.165, 0, 2, 's', 'FOV return', 'Seconds the punch takes to go back, linearly (feel target 3)'),
    dip: num(0.09, 0, 0.5, 'm', 'eye dip', 'How far the eyes drop during it (moment 7)'),
  }, 'Evade'),
  stamina: obj({
    max: num(2, 0, 10, '', 'most', 'Stamina the player can hold; jump and evade share it [E]'),
    regen: num(0.7, 0, 10, '/s', 'regain', 'Stamina regained a second [E]'),
    jumpCost: num(0, 0, 10, '', 'jump cost', 'What a jump costs [E]'),
    evadeCost: num(1, 0, 10, '', 'evade cost', 'What an evade costs [E]'),
  }, 'Stamina'),
  bob: obj({
    amount: num(0.01, 0, 0.1, 'm', 'head bob', 'Half the head\'s rise and fall while walking (feel target 2: about ±1 cm)'),
    rate: num(4.2, 0, 10, 'Hz', 'bob rate', 'Bobs a second (feel target 2: about 4 Hz)'),
    landDip: num(0.014, 0, 0.2, 'm', 'landing dip', 'How far the eyes drop on landing (feel target 4: 1.4 cm)'),
    landTime: num(0.15, 0, 1, 's', 'landing recovery', 'Seconds the eyes take to come back up (moment 6)'),
    jumpLift: num(0.045, 0, 0.3, 'm', 'air lift', 'The eyes ride this much higher in the air (moment 6: the eyes peak at 1.18 m over a 1.13 m jump) [E]'),
  }, 'Head'),
  hurt: obj({
    tint: num(0.6, 0, 1, '', 'red tint a hit', 'The edge-weighted red each hit adds, capped at 1 (feel target 10)'),
    fade: num(1.5, 0, 10, '/s', 'tint fade', 'How fast the red fades (feel target 10: 1.5 a second)'),
    shake: num(0.016, 0, 0.2, 'm', 'hurt shake', 'The camera\'s jitter while hits land (feel target 10: about ±1.6 cm)'),
    shakeRate: num(12, 0, 60, 'Hz', 'shake rate', 'Jitters a second (feel target 10: 10-15 Hz)'),
    shakeTime: num(0.25, 0, 2, 's', 'shake time', 'Seconds one hit\'s jitter lasts [E]'),
  }, 'Hurt'),
  revive: obj({
    time: num(2, 0.1, 30, 's', 'time', 'Seconds a friend holds interact beside a downed player to bring them back (the helper\'s own value)'),
    range: num(2, 0.5, 20, 'm', 'reach', 'How near the helper must stand'),
    health: num(0.4, 0.01, 1, '', 'health given', 'The share of full health a revived player comes back with'),
    look: num(0.35, 0, 1, '', 'look while down', 'The share of its usual speed a downed player\'s look turns at'),
    grace: num(1.5, 0, 10, 's', 'grace', 'Seconds nothing hurts a player just revived'),
    text: obj({
      down: words('You are down', 'you are down', 'Shown to a player who is down', 40),
      wait: words('A friend can bring you back', 'you are down: wait', 'Under it, while nobody is reviving them', 80),
      being: words('{name} is bringing you back', 'you are being revived', '{name} is the friend\'s name', 80),
      hold: words('Hold {key} to revive {name}', 'revive prompt', 'Shown beside a downed friend; {key} is the interact key or button, {name} the friend', 80),
      doing: words('Reviving {name}', 'reviving', 'While this player revives a friend', 60),
      mark: words('down', 'a friend\'s marker', 'Over a downed friend', 20),
      key: words('E', 'interact key', 'What the prompt calls the interact key', 12),
      downThem: words('{name} is down', 'watching: they are down', 'Shown to someone watching a stream when the player they follow is down; {name} is that player', 40),
      waitThem: words('A friend can bring them back', 'watching: wait', 'Under it, while nobody is reviving them', 80),
      beingThem: words('{name} is bringing them back', 'watching: being revived', '{name} is the friend\'s name', 80),
    }, 'words'),
  }, 'Down and revive (with friends: at zero health a player is down, not out)'),
  sounds: obj({
    step: sound('step', 'footstep', 'A footstep'),
    jump: sound('jump', 'jump', 'A jump'),
    land: sound('land', 'land', 'Landing from a jump'),
    evade: sound('evade', 'arrow-whoosh', 'An evade'),
    hurt: sound('hurt', 'hurt', 'The player is hurt'),
    switch: sound('weapon-switch', 'click', 'Switching weapons'),
    death: sound('player-death', 'lose', 'The player falls (moment 19: the sting on the fatal frame)'),
    down: sound('player-down', 'alarm', 'A player goes down with a friend still standing'),
    revive: sound('player-revive', 'heal', 'A downed player is brought back'),
  }),
};

export const physics = {
  gravity: num(18, 0, 100, 'm/s²', 'Debris gravity', 'How hard debris and ragdoll pieces fall (the player\'s own is player.gravity) [E]'),
  debrisLife: num(4, 0, 60, 's', 'Debris flight', 'Seconds a piece of debris may keep moving; one still falling then goes, one on the ground lies still (feel.kill.rest) [E]'),
};

export const owner = { player: 'forge-core (walk, jump, body), forge-feel (evade, stamina, bob, hurt, revive)', physics: 'forge-core' };
