// measure 5's live gate times its scripted play by the room's own round (builder/multiplayer/party/gate-live.mjs): the
// room ends a round `cap` seconds after it began, whatever the gate was doing, so play ends a margin before that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playDeadline } from '../builder/multiplayer/party/gate-live.mjs';

test('a quick machine plays 40 s; a loaded one that got to play late stops before the room ends the round', () => {
  const roundT0 = 1_000_000, cap = 60;
  // got to play 1 s into the round (Isle Run on a quiet machine): 40 s of play, ending 41 s in
  assert.equal(playDeadline({ roundT0, now: roundT0 + 1000, cap }) - roundT0, 41000);
  // got to play 14 s in (a loaded machine): the old deadline (now + 40 s = 54 s in) left 6 s before the 60 s cap for the
  // background-host step; now play ends 16 s before the cap
  assert.equal(playDeadline({ roundT0, now: roundT0 + 14000, cap }) - roundT0, 44000);
  // got to play 40 s in: at least 12 s of play (the background-host step then runs in round 2)
  assert.equal(playDeadline({ roundT0, now: roundT0 + 40000, cap }) - roundT0, 52000);
});
