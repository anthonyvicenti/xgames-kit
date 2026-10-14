// rules.js: THE GAME AGENT'S FILE. Island Circuit: what makes this game this game (builder/CONTRACT.md §3).
// The kit runs the home menu, the HUD (lap and place included), players, bots, the round and replay (CONTRACT §6g).
//
// Hook: Race your friends three laps around an island; first over the line wins.
// Rules:
//   Everyone drives a car around a closed track. Pass the gates in order and finish three laps; the first car over
//   the line wins and the finish order is shown.
// Win: The first car to finish three laps wins; the finish order is shown.
// Round: 300 s · players 2–8, bots fill empty seats
// Tuning (config/game.json → rules.params, each a rules.* slot): the car's maxSpeed, accel, brake, turnRate, grip,
//   reverse, coast, carLength, carTint, carYaw, chaseTurn (how fast the camera swings behind the car); the track's
//   trackRadius, trackWave, trackLobes, trackWidth, trackStart, gates, coneSpacing, edgeBounce, edgeSteer; the bots'
//   botPace and botLook.
// The game's own modules:
//   src/track.js  the closed road loop on the island, its gates and grid, cones on its edges, edges that push cars back
//   src/car.js    each player's car body in their colour, and steer / accelerate / brake driving
// Mechanics: race — "three laps through the track's gates" (its gates are the track's, config/game.json)
// Controls: steer (A/D, ←/→), accelerate (W, ↑), brake and reverse (S, ↓); on a phone the stick does all three.

import { createTrack } from './src/track.js';
import { createCars } from './src/car.js';

let track = null, cars = null, race = null;
const ordinal = n => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;

export default {
  setup(ctx) {
    race = ctx.mechanics.get('race');
    track = createTrack(ctx);
    track.dress();
    cars = createCars(ctx, track);
    // the race scores a finish itself (placePoints) and the kit's results card names the winner: nothing to add here
  },

  roundStart(ctx) {
    cars.update(ctx);
  },

  update(ctx, dt) {
    cars.update(ctx, dt);
  },

  // Host, alone with bots: each bot drives its car along the road.
  bot(ctx, p, dt) {
    cars.botDrive(p, dt);
  },

  // The race ends the round when the first car finishes three laps.
  check(ctx) { return race?.check?.() ?? null; },

  // The results card in finishing order: the finishers by place, then everyone else by how far round they got.
  results(ctx) {
    const rows = race?.standings?.() ?? ctx.players.list().map(p => ({ player: p }));
    return rows.map((r, i) => ({ id: r.player.id, name: `${ordinal(i + 1)} · ${r.player.name}`, value: r.player.score }));
  },

  observe(ctx) {
    const me = ctx.me;
    if (!me || !track) return null;
    const n = track.nearest(me.position.x, me.position.z);
    return { speed: Math.round((cars?.speedOf(me) ?? 0) * 10) / 10, offRoad: Math.round(Math.max(0, Math.abs(n.lat) - track.shape.width / 2) * 100) / 100, along: Math.round(n.s * 10) / 10, trackLength: Math.round(track.shape.length * 10) / 10 };
  },
};
