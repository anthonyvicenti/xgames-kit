// spec.forge.endless (owner: forge-ai, wave 6: the wave director's laps). The creator, 2026-10-11: "Can we make the
// game endless with increasing difficulty and increasing buffs they can choose. WE can use the same boss over and
// assets over." With `on`, the waves never run out: after the last one (the boss's, as a rule) the director starts
// again at wave `from`, a lap more, and each lap the waves are bigger and their enemies tougher by the shares below
// (1 + share × lap). Rewards come round with the waves that have them, so the buffs a player takes keep growing.
// The most alive at once stops growing at `aliveMost` (the crowd's frame budget on a phone) and the speed at
// `speedMost` times its own. The run ends when everyone has fallen: a game that is endless names the loop "endless"
// (no round clock), and its rules end the run in check(ctx).
import { num, int, bool, obj } from './fields.js';

export const fields = {
  on: bool(false, 'Endless', 'After the last wave the waves start again, harder each time round, until everyone falls'),
  from: int(1, 1, 64, '', 'Start again at wave', 'The wave each new lap starts at (1: the first; skip an easy opening with 2)'),
  grow: obj({
    enemies: num(0.25, 0, 5, '×', 'more enemies a lap', 'The share of every wave\'s enemies added each time round (a boss stays one)'),
    alive: num(0.15, 0, 5, '×', 'more at once a lap', 'The share added to each wave\'s most alive at once each time round'),
    health: num(0.2, 0, 5, '×', 'more health a lap', 'The share added to every enemy\'s health each time round, the boss\'s too'),
    damage: num(0.1, 0, 5, '×', 'harder hits a lap', 'The share added to every enemy\'s damage each time round'),
    speed: num(0.04, 0, 1, '×', 'faster a lap', 'The share added to every enemy\'s speed each time round, up to Fastest'),
  }, 'Each time round'),
  aliveMost: int(16, 1, 200, '', 'Most at once, ever', 'However many laps, no wave has more alive at once than this (or its own most, when that is more): the crowd a phone can draw'),
  speedMost: num(1.3, 1, 3, '×', 'Fastest', 'However many laps, an enemy is at most this many times its own speed'),
};

export const owner = 'forge-ai (wave 6)';
