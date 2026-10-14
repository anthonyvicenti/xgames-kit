# Paired eval rubric (phase 5 gate)

Frozen 2026-10-13. The pass rule is in `set.json` → `pass`; this page says how each run is scored.

## What is compared

Twelve prompts (`cases/PA01`–`PA12`), each built three times by the old loop and three times by the new loop: 72 runs.
Both arms get the same prompt, the same images, the same answers to questions, the same base model and the same wall
clock. Nothing else is shared: each arm uses its own pitch, gates, play-tester and repair rounds, because those are what
is being compared.

## The three measures

### 1. Intent kept (0 to 1 per run)

Each case carries a frozen **ledger**: the essentials of the prompt in the creator's own words (`words`, copied exactly
from the prompt) and what they mean for the game (`means`), in the vocabulary of the loop's requirements ledger
(`builder/loop/ledger.schema.json`: `about`, `core`). It was written on 2026-10-13 from the prompt and, for T1–T7,
from that case's checklist. It is not the ledger either loop writes for itself: a loop never grades its own reading.

A second reader (`JUDGE.md`) marks every ledger line from the witness bundle alone:

| Mark | Means | Counts |
|---|---|---|
| kept | The bundle shows it working as the line's `means` says | 1 |
| partly | It is there but thinner or different in a way the creator would notice (two laps for three; a sword that is a projectile) | 0.5 |
| lost | It is absent, or replaced by something else | 0 |
| cannot tell | The bundle does not show it either way | 0 |

**Intent kept = the sum over core lines (`core: true`) / the number of core lines.** The other lines are marked and
reported, never scored. "Cannot tell" scores 0 for both arms alike: the witness plays both the same way, so a thing it could not reach
is a thing a new player could not reach either.

Policy lines (`policy`) are marked `held` or `broken` and reported. A broken policy line is a finding for the creator;
it does not change the score.

The **control** (an absurd thing the game must not have, such as a working chess board) must be marked absent. If the
reader marks it present, that judgement is void and the bundle goes to a fresh reader.

### 2. Completed (yes or no per run)

From the run record and the witness, not the reader:
- a game was delivered, and no person touched the run between the prompt and the delivery (no hand edit, no step
  re-run, no answer typed beyond the case's `answers`);
- it boots to play in the witness's browser;
- the witness played it to the end of its loop: a results screen for a round, run or match; for a world, endless or
  saved game, 10 minutes of play with no blocker (a blocker: a crash, a screen the player cannot leave, a control that
  does nothing for 30 seconds while the player is alive).

A run stopped by the wall clock (8 hours) is not completed.

### 3. Multiplayer working (yes or no per run)

The runner's own two-player probe, the same for both arms: two browsers on one machine join one game through the
game's own join flow and play for two minutes. It passes when, on each screen, the other player is drawn as a character
where they really are (the bar in each case's `multiplayer.bar`), in the same round or run, and each player's score is
their own. A run that delivered nothing counts as not working. For PA11 read `multiplayer.note`: the meaning for a
board game is still the creator's open question.

The probe reads the game through `window.__game`, the observation every runtime exposes, and checks it against pixels
on screen; where a game exposes no observation, the two players' screens go to the reader as a pair of videos and the
reader answers the same question.

## Scoring a prompt and the gate

- A prompt's score per arm is the mean of its three runs.
- **Intent improves** when the new arm's mean over its 36 runs is higher than the old arm's AND the new arm wins more
  prompts than it loses (ties count for neither).
- **Completion not lower**: new completed runs ≥ old completed runs (of 36 each).
- **Multiplayer not lower**: new runs with multiplayer working ≥ old (of 36 each).
- The gate passes only when all three hold.

Reported beside the gate and never part of it: the table of 12 prompts × 2 arms, a bootstrap 90% interval of the intent
difference (10,000 resamples of prompts, seed in `plan.json`), secondary-line and policy marks, the readers' guesses of
which arm made each bundle (if they guess right more than 75% of the time the blinding is weak and the report says
so), wall time, tokens, money and the models each run used.

## Blinding

The reader gets a bundle with a random id and nothing that names the arm: no spec, no delivery note, no transcript, no
kit or loop names, no model names (RUNNER.md, "Blinding"). What the game itself shows on screen (its menus, its HUD)
stays, because that is the game. The plan file that maps bundle ids to runs is sealed: no reader process gets its path.

## Audit

A person reads five bundles of each arm, chosen by the plan's seed, and marks them the same way without seeing the
reader's marks. Their marks are recorded beside the reader's and change nothing; a disagreement on a core line is listed
in the report.
