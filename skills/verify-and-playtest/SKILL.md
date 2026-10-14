---
name: verify-and-playtest
description: Prove a game works - your own quick check with gamesfun verify (real Chrome, real input, two players over WebRTC) until the six gates pass, the right lever for each failing measure, the look questions, how the loop's black-box play-test proves each promise, and what happens when repairs repeat (the stop rule and the ladder). Use inside a build or repair round, after any change, or when someone reports that something doesn't work.
---

# Verify and play-test

Two kinds of proof, and they are not the same:

| | Who | When | Counts for delivery |
|---|---|---|---|
| **Your quick check**: `gamesfun_verify` (`npx gamesfun verify games/<name> --quick`), and trying a control yourself with `gamesfun_play` | you, the author | inside your round, as often as you like | no: it tells you when to end the round |
| **The full verify**: `gamesfun_step_verify` | the loop | after `gamesfun_step_fix` | yes, for the files it ran on |
| **The black-box play-test**: `gamesfun_step_playtest` | the `playtester` subagent, with only the screen | after the full verify passes | yes, for the files it was given |

An author tests what they meant; a new player tests what is there. So your own play is a quick check, and the
play-test on record is the play-tester's: the loop reads only a report written with the round's one-time token, which
only the play-tester gets. A green verify is the kit's bar, not the person's verdict: report honestly.

## Your quick check

```bash
npx gamesfun verify games/<name> --quick          # about 2 minutes; PASS/FAIL per check, then one verdict
npx gamesfun verify games/<name> --check 13       # one check alone while you fix it
```

With the MCP tools: `gamesfun_verify {"dir": "games/<name>"}` (`check` for one). Measures that run alone: 10, 13, 15, 16,
23, 25, 35, 38, 39 and the ones with no browser (11, 14, 17, 18, 19; `--check 11,17` takes a list); `--gate C` runs a gate.
Chrome: `CHROME_PATH`, else an installed Chrome or Edge, else Playwright's Chromium (downloaded once). Evidence:
`games/<name>/evidence/verify-N/` (append-only). Exit code 0 means it passed. Before you call `gamesfun_step_fix`, run
the whole `--quick` once more on the files as they are. Never change a check, its thresholds or the kit to pass.

## The gates, and the lever for each

verify answers six questions about the player's experience, the **gates**
(`builder/GATES.md`; the reference is `builder/CONTRACT.md` §5). Each gate is made of
measures, still numbered as before so `--check N` runs one measure; `--gate C` runs a whole gate. A failing line names
its gate, its measure, its rule and its fix. A complaint about a game never adds a check: it becomes a broken example a
gate must fail.

| Gate | The question | Measures | Usual cause of a fail | Lever |
|---|---|---|---|---|
| **A** integrity | Kit untouched, every visible thing a slot, every slot's file there and valid | 1, 2, 4, 18, 19 | a kit copy edited; a mesh drawn in code; config added without regenerating; a sound id with no entry; a broken body | `npx gamesfun create games/<name> --spec games/<name>/spec.json` restores the kit copies; make it a slot; `npx gamesfun slots write games/<name>`; add the sound to `assets.json` → `sounds`; another body or `npx gamesfun rig-check` |
| **B** health | Boots to play with no errors and no kit refusals | 3 | an exception in `rules.js`; a refusal (`gf-three refused [<code>]`: the game hid the menu, took the pointer lock, swallowed input…) | the console line names the code and the fix; leave the kit's menu, HUD, mouse and camera to the kit |
| **C** cause → effect | Every input and every event the kit logs shows on that player's screen soon; control comes back | 10, 13, 15, 16, 38 | a control with no visible effect; an event nobody sees or hears; an unused mechanic; bots ganging up | use the mechanic's own `fire`/`stream`/E or take the control out; make the rules use the mechanic; bots via `ctx.bots.target`/`attack` |
| **D** the loop closes | A round ends, replays, and every score comes from a counted event | 6, 12 | the round never ends; a score that only ticks | `check()` returns null or `{winners, reason}`; score in `onHit`/`onDamage`/`onCollect`, never per frame |
| **E** shared truth | Every player sees the others where they are; each player's own values are theirs | 5, 25 | shared state decided on a non-host copy; one shared score; bots with friends | `if (ctx.host)`, `ctx.shared`, events on edges (skill `multiplayer`); each player's score in `p.score`; `rules.bot` for solo only |
| **F** matches the spec | World size and completeness, a body per role, hits per kill, the game's own tests | 11, 14, 17, 35, 39 | props placed badly; walls removed; roles sharing a body; a one-hit weapon the spec didn't ask for; a failing own test | `config/world.json` → `props`; keep the generated world; a body per role; a weapon's damage against its enemies' health (or the spec's `hitsPerKill`); fix the game, the test is the promise |
| judges | The reference likeness (when the spec has references), the black-box play-test | 23 | the look drifted from the references | the failing line's notes; advice, not a rule |

Release-only measures test the kit, not your game, and a build's verify neither runs nor requires them: 7 (bus
loudness), 8 (swap proof), 20–22 (menu, HUD, wallet), 24 (in a post), 31 (sharp on every screen), 34 (watch then
play). Check 9 (the contact sheet on the GPU) is skipped by `--quick`.

## The look, in eight questions

From the screenshots in the evidence folder (or your own from `play`), answer yes or no; fix every "no" in
`config/*.json` and slots, never in code:
1. Does the ground read as a surface (pattern visible, players lighter or darker than it)?
2. Can you see every player's colour, and what their actions leave in the world (paint, a stream, marks), against the ground?
3. Is the floor free of litter (no loose small things, no scenery that looks collectable)?
4. Does every prop stand cleanly (no overlap, float, sink, tilt; seats face something)?
5. Is the layout purposeful (props along edges and in groups, open floor in the middle)?
6. Is everything to scale with a 1.7 m character (benches hip high, pickups about a third of its height)?
7. Do the shots show the game (no camera inside or behind a wall or prop)?
8. Does every player start on open floor, inside the play area, facing the middle?

## Trying a control yourself (a quick check)

```bash
npx gamesfun promises games/<name>                       # what the game promises (controls, loop, mechanics, hook)
npx gamesfun play games/<name> --out games/<name>/scratch/play-1 --steps '[{"do":"start","bots":3,"seed":1,"round":40},{"do":"shot","name":"first-look"},{"do":"hold","key":"Mouse","seconds":2,"shot":"firing"},{"do":"press","key":"KeyE","shot":"after-e"},{"do":"until","phase":"results","timeout":90},{"do":"again"}]'
```

With the MCP tools: `gamesfun_play` (its runs go to the loop's own folder, never the game's files). `play` prints one
line per step (phase, clock, score, HUD) and saves screenshots of the player's own view; **look at them**. Steps:
`start`, `hold`, `press`, `move`, `look`, `wait`, `shot`, `snap`, `until`, `again`, `click`.

## The black-box play-test (the loop's, not yours)

The play-test proves promises. `gamesfun_step_playtest` returns a message: the controls, and every promise the game
makes (each ledger line a part does, each build line, each control, the loop closing), each by its id. Start the
`playtester` subagent with that message as its whole task: it carries the round's report token. The subagent plays
through `gamesfun_play`, reads only its own folder, and reports each promise as `seen` (with evidence), `not-seen` or
`unreachable` with `gamesfun_playtest_report`. Do not change the game while it plays (a report about other files is
refused and the play-test handed over again), and never write or send the report yourself. Then call
`gamesfun_step_playtest` again: a promise not seen gives you a repair round. A re-test asks again what was not seen,
and every build line. If your agent cannot start a subagent, tell the person plainly that the play-test cannot run in
this session; the run waits at this step, and a session that can picks it up with `gamesfun_next`.

## When repairs repeat: the stop rule and the ladder

After each repair round the loop compares the failing set (gate measures and promises not seen) with the ones before.
The same set again, a set that came back, or a round that changed no file: the loop stops repeating and climbs. The
stronger model; then one specialist round per area that is stuck (art, sound, netcode, feel, code), each with a brief
for that specialist; then a generation round (models, pictures, sounds made by the person's makers) when what is stuck
is art or sound; then questions for the person (`gamesfun_ask`), whose answer re-enters at the ledger. There is no
round count and cost never ends a build. Read a specialist's brief as that specialist would, and never repeat what the
last round tried.

## Two players

Open the friends lobby twice (skill `multiplayer`): host in one tab, join from the other, play a round. Both screens
must show the other player where they really are. Verify check 5 does the same over real WebRTC.

## Report

Say what passed, what failed and why, what the person will see, and what you left out. Never report a check you
didn't run.
