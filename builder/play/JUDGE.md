# The play judge (builder/play)

Is this game a game, and does it play the way its play target says? The creator, 2026-10-14, after the look test's three
levels (visuals 8.5/10): "The biggest thing these all miss is the actual gameplay itself ... We need a better gameplayer
designer and judge. We were supposed to collect berries, but there were no berries anywhere. I think in the ocean I saw
some boxes but those are impossible to get." Every gate passed that: they checked that controls work, friends see each
other and a round ends, not that the objective could be reached or that anything happened.

The designer half (`design.mjs`, `spec.play.target`) is play-design's ([README.md](README.md)). This file is the judge.

```
real play (session.mjs)                 bots + the scripted player (agent.mjs), 2 and 4 players, 2 rounds each, stepped
   │                                    time; a friends round over real WebRTC, both screens kept; a frame a second
   ▼
the play feed (window.__game.play())    runtimes/three/kit/core/play.js, every runtime: objectives and their reach,
   │                                    gameplay events by kind and time, players on each other, idle, leads, per round
   ├──► measured (measure.mjs)          against spec.play.target's pacing (else the loop's defaults); HARD findings
   └──► judged (vision.mjs)             clips (contact strips) on a fixed rubric, 3 passes
            ▼
score (judge.mjs)                       0–100, an interval, a verdict: pass | fail | unsure (| skipped: not yet for Godot)
   ▼
gate D, measure 6's play leg            builder/tools/lib/play-check.mjs; the loop keeps the record (S.playJudge)
```

## The play feed: `window.__game.play()` (gf-play/1)

`runtimes/three/kit/core/play.js`, wired by the three runtime's boot, forge's and vista's (Godot keeps its own boot and
event log: not yet). It reads what the kit already keeps: the event log (`kit/core/events.js`: every mechanic's manifest
events, scores, presses, a game's own `ctx.events.count`), the players, the round, and each mechanic's objectives.
Nothing in it is sent to other copies or changes play.

| Field | What |
|---|---|
| `objectives` | `[{id, part, kind, x, y, z, open, reach, by, why?, closest, taken}]`: a mechanic's `objectives()` (pickup: every spot; race: every gate), else its `interactables()`. `reach`: `ctx.world.reach(from, to)` when the world has it (`by: 'world'`), else the ground under the spot (`by: 'ground'`): no ground under it ("out at sea"), the sea floor under the water, more than 0.6 m inside the ground, more than 1.6 m above it (a jump) |
| `rounds[].events` | `total`, `meaningful` (what players did: a score is the result of one and a combo a run of them, neither adds), `perMinute`, `byType` (score, hit, knockout, pickup, goal, death, combo, move, tag, blast; attempt: a shot, a throw, a swing), `byName`, `first` (s from the round's start), `longestGap` (dead air) |
| `rounds[].interactions` | events done by one player to another (`who` names both): `total`, `perMinute`, `pairs {'a>b': n}` |
| `rounds[].idle`, `quiet` | each player's seconds standing still with nothing done (`idle`), and each player's longest stretch with nothing meaningful done by or to them (`quiet`, the target's `idleMax`) |
| `rounds[].leads`, `outcome` | lead changes (one player alone on top, above zero), winners, reason, scores, margin |
| `rounds[].objectives` | `present, reachable, unreachable, unknown, approached, taken, takenSpots` |
| `rounds[].timeline` | `[[t, type, name, actor, target]]`, the first 600 |

Types: a mechanic's manifest event may say its own (`events: [{name, play: 'pickup'}]`); else a table of the kit's
event names; else the name's words. A game's own event is `ctx.events.count(player, name, { at, target })` (the seam
play-design's brief uses: `play.target.events[].name`), read as `rules.<name>`; `target` names who it was done to, so a
game's own player-on-player event counts as an interaction; the target can mark a name `meaningful: false`.

## Real play: session.mjs and agent.mjs

The game is served as a player gets it and played on the game's own clock (stepped time, `kit/core/step.js`: a loaded
machine changes nothing measured), at two and four players where the spec allows (bots fill the seats; a game with no
bots plays alone and in the friends round), two rounds each of the game's own length (30–120 s), with Play again
between them. The scripted player (`agent.mjs`) is a new player's hand on real keys and the mouse: it goes for the
nearest open objective and gives up on one it gets no closer to in 9 s (jumping when stuck), turns to a rival in range
(learning which way and how far the mouse turns the view) and uses the main action, presses interact near something,
clicks what a board offers, tries each of the game's own control rows (`controls.more`) now and then, and wanders when
nothing is near. A live game also gets one friends round (45 s): two scripted players over real WebRTC through the
game's friends page, both screens kept.

## Measured (measure.mjs)

Held to `spec.play.target.pacing` and its touchpoints and events; with no target, to the loop's defaults (`DEFAULTS`:
a round wants a meaningful action in 10 s, 6 meaningful events a minute, nobody quiet over 30 s, and a versus game one
player-on-player moment a minute). Parts 0–100, a weighted geometric mean (one collapsed part pulls the whole down):
objective (reachable and taken), pace, dead air, quiet, idle, first action, interaction, completion, leads.

**Hard findings** fail the play leg whatever the target, because they say the game is not a game yet:
- objectives a player cannot reach: none can be reached and none was taken; or most cannot (`HARD.unreachableShare`,
  0.5); or none was taken in every round played. Out of reach is the ground probe's answer, or nobody (bots included)
  got within 3 m of it after the scripted player tried and gave up (a fence, a wall, a cliff the probe cannot see);
- the play target places things in the world and the game has no objective at all;
- nothing meaningful for 30 s (or the target's `idleMax`, if longer) in most rounds someone was seen playing (bots in the
  round, or the scripted player's presses reached the game). A game whose verbs need a sequence no press starts (take
  out the rod, cast, wait, strike) with no bots is said, and the play-tester's report decides it.

## Judged (vision.mjs)

Clips: per player count the opening and the busiest six seconds (by the round's meaningful events), and the friends
round with both screens, each a strip of six frames a second apart. One `claude -p` session a pass (the person's own
login, only the Read tool, the strips copied to a temporary folder), three passes in parallel with the clips' order
reversed on every other. Rubric (`play-rubric-1`), each 0–4: clarity, feel and impact, chaos and drama, player
interaction, would play again, plus each of the target's "what makes it play" lines (`makes[].says`, with what a player
sees). Chaos weighs by the target's `feel.chaos`; interaction drops out for a game played alone. Reference gameplay
frames (`--refs <folder>`, local only, never in a repository or a game) are shown as the kind of play to hold it to,
never its art. The judge is told the game's hook, rules, controls and target, never the measured numbers.

## Score and verdict (judge.mjs)

`score = 0.6 · measured + 0.4 · judged` (measured alone with `--no-vision` or `GF_PLAY_VISION=0`); an interval round it,
± 3 · 0.4 · max(sd of the passes, `NOISE.judgedSd`) / √passes. Verdict: **fail** on any hard finding; with a play target,
**fail** when the whole interval is below `BAR` (50), **unsure** (advisory, never a fail) when it holds the bar, else
**pass**; with no target, scored and advisory (only hard findings fail).

```
node builder/play/judge.mjs <game> [--out dir] [--no-vision] [--passes 3] [--refs <folder>] [--rounds 2] [--no-duo]
                                   [--play <out>/play.json]      # judge a kept play again, without playing it
node builder/play/stability.mjs <game> [--n 10] [--out file.json]  # the same game judged N times from fresh play
```

Writes `<out>/play-judge.json` (`gf-play-judge/1`), `play.json` (the play), `clip-N.jpg` and `frames/`.

## In the gates and the loop

**Gate D, measure 6's play leg** (`builder/tools/lib/play-check.mjs`; why D and not a new gate: builder/GATES.md, "Gate D
widened"). Verify runs it once its other sessions have closed (three, forge and vista flows; worlds have no measure 6).
A failed leg carries `area: 'play'` into the verdict; the loop keeps the judge's record as `S.playJudge`, the repair
brief lists its hard findings first, then what it measured and watched, its changes and the clips
(`messages.mjs playJudgeLines`), and when the same play failure comes back the ladder's model rung is a game designer's
round (specialist `play`) on the stronger model.

## Calibration and stability

`evidence/calibration-look-test-2026-10-14.json` and `evidence/stability-2026-10-14.json`: the creator's three levels
(copies; their rules.js is create's stub, their berries the pickup part's y = 0 on island terrain) and the kit's Critter
Lob example (the same game written out, picked by playing it), each judged 10 times from fresh play, 3 vision passes a
time. The creator said all three levels miss on play ("no berries anywhere ... impossible to get"):

| Game | Verdict, 10 runs | Score (mean ± sd, range) | Why |
|---|---|---|---|
| sunny-castle-isles | fail 10/10 | 15.9 ± 3.4 (10.4–19.8) | most objectives cannot be reached (80–87%: out in the sea, inside the ground) |
| violet-dusk-fortress | fail 10/10 | 20.4 ± 1.7 (17.4–22) | the same (83–90%) |
| sunset-canyon-sands | fail 10/10 | 9.0 ± 0.7 (8–10.4) | the same (97%), and nothing meaningful for 60 s and more |
| critter-lob (example) | pass 10/10 | 80.4 ± 1.0 (78.6–82.1) | every berry taken, 80 meaningful events a minute, seeds bowling friends over |

The measured half moved by at most 3.9 points run to run (the play itself: bots, the scripted player, the friends
round), the judged half by 2.1–4.3 (sd), under `NOISE.judgedSd` (6), which stays. The vision judge's own summaries say
what the creator said ("no berries can be seen, no seeds fly and nobody hits anyone"). Two non-artillery controls, once
each: market-day (flat-2d pixel coins) passes at 46 and table-four (a board on the turns loop) at 58.8, both advisory
(no target), with findings a person would recognise (every villager looks the same; discs appear with no slide or thud).
The kit's turn-based artillery example blast-isles (after the chaos merge) plays: about 76 (measured 100: 30 meaningful
events a minute, no dead air; judged 39), and the vision judge names what keeps it from playing well in the creator's
genre: players blast themselves into the sea, rivals on far islands are rarely hit (players touched each other in 2 of
5 rounds), the camera rests on empty sea after a knock-out. Its first run showed two measuring gaps, now fixed: a fling
or a fall names its thrower apart (so a throw is a player-on-player touch), and a turns game whose verbs hit bodies
expects players to touch each other.
The bar (50) sits between the levels (at most 22) and the example (at least 78.6); it is held only with a play target,
and no game here has one yet: re-calibrate it once play-design's step writes targets for real games.

What it cannot do yet: Godot (no play feed); a verb that needs a sequence the scripted player does not follow (fishing)
without bots; a route the scripted player cannot find in a maze (it walks straight: an objective behind a detour can be
given up, which alone is never enough for "out of reach" without nobody getting within 3 m).
