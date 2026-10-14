// measure 5's live gate times its scripted play by the room's own round (builder/multiplayer/party/gate-live.mjs): the
// room ends a round `cap` seconds after it began, whatever the gate was doing, so play ends a margin before that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundVerdict, playDeadline } from '../builder/multiplayer/party/gate-live.mjs';

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

// The background-host step holds the joiner's clock (the host's own) with the host's tab behind another to its pace with
// the tab in front, read just before and after, never to the wall clock: a frame's step is capped at 0.1 s, so a game
// drawn under 6 frames a second on a loaded machine ran under the old rule's 0.6 s a second in front as much as behind.
const pace = p => ({ pace: p });
test('a busy machine that runs the game at half speed in front and behind passes; a host that stops fails', () => {
  assert.equal(backgroundVerdict({ front: [pace(0.45), pace(0.4)], behind: [pace(0.42)] }).ok, true);
  const stopped = backgroundVerdict({ front: [pace(1), pace(1), pace(1), pace(1)], behind: [pace(0), pace(0), pace(0)] });
  assert.equal(stopped.ok, false);
  assert.match(stopped.detail, /3 times/);
  // a host on a once-a-second page timer: a 0.1 s step a second, against 1 in front
  assert.equal(backgroundVerdict({ front: [pace(1), pace(1), pace(1), pace(1)], behind: [pace(0.1), pace(0.1), pace(0.1)] }).ok, false);
});

test('one busy spell inside a window is tried again; the slower in-front window around a try is its reference', () => {
  assert.equal(backgroundVerdict({ front: [pace(1), pace(1)], behind: [pace(0.3)] }).ok, false);
  assert.equal(backgroundVerdict({ front: [pace(1), pace(1), pace(1)], behind: [pace(0.3), pace(0.9)] }).ok, true);
  // the machine got busy across the try: 0.35 behind keeps half of the 0.6 after it
  assert.equal(backgroundVerdict({ front: [pace(1), pace(0.6)], behind: [pace(0.35)] }).ok, true);
});

test('a clock that does not rise with the host in front either is not judged', () => {
  const v = backgroundVerdict({ front: [pace(0), pace(0)], behind: [pace(0)] });
  assert.equal(v.ok, null);
  assert.equal(backgroundVerdict({ front: [{ pace: null }, { pace: null }], behind: [{ pace: null }] }).ok, null);
});
