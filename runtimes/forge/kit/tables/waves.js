// spec.forge.waves[]: the encounter, wave by wave (owner: forge-ai, track A: the wave director runs them; rules.js
// decides what happens between waves). Defaults are the measured feel targets (research/rust-engine/feel-targets.md
// moments 4 and 16: the first enemies rise 0.7-2.4 s after the start, 7-10 m away; a new wave never stops play).
//
// The director (forge-ai director.rs) says what happens as rule events (rules.event(ctx, name, data, 'forge')):
//   wave-start {a: wave number, b: waves, c: enemies in it, d: 1 for a boss wave}   wave-clear {a, b, c: 1 when a reward follows}
//   wave-reward {a}: the director waits (the three-card choice is rules.js and the kit's UI) until ctx.ai.director.resume()
//   waves-done {a: waves}   boss-arrive / boss-phase {a: phase} / boss-down   enemy-down {entity, a: type row, b: score, c: coins, d: who}
import { num, int, bool, choice, ref, obj, list, id } from './fields.js';

export const fields = {
  id: id(),
  enemies: list({
    type: ref('enemies', 'type', 'An enemy id from spec.forge.enemies'),
    count: int(6, 1, 500, '', 'count', 'How many of them'),
  }, 'group', { min: 1, max: 16 }),
  delay: num(0.7, 0, 60, 's', 'Delay', 'Seconds from the wave\'s start to its first enemy (moment 4: 0.7-2.4 s)'),
  spawnEvery: num(0.6, 0, 30, 's', 'Time between arrivals', 'Seconds between two enemies rising'),
  maxAlive: int(8, 1, 200, '', 'Most at once', 'Enemies alive at once, at most'),
  attackers: int(3, 1, 50, '', 'Attackers at once', 'Enemies swinging at once, at most (attack tokens, per player)'),
  friends: num(0, 0, 3, '×', 'More for each friend', 'The share of the wave added for each player after the first: its enemies, the most alive at once, and a boss\'s health (0.5: half as much again a friend; 0: the same for any number of players)'),
  distance: obj({
    min: num(7, 0, 100, 'm', 'nearest', 'The nearest an enemy rises to a player (moment 4: 7-10 m)'),
    max: num(10, 0, 200, 'm', 'farthest', 'The farthest'),
  }, 'Arrival distance'),
  boss: bool(false, 'Boss wave', 'Its last enemy is the boss'),
  next: choice('cleared', ['cleared', 'timer'], 'Next wave', 'cleared: when every enemy is down; timer: after `time` seconds whatever is left'),
  time: num(0, 0, 600, 's', 'Time limit', 'For next: timer'),
  reward: bool(false, 'Reward after', 'When it is cleared the director waits for a reward (wave-reward: the three-card choice in rules.js), then goes on'),
};

export const owner = 'forge-ai (track A)';
