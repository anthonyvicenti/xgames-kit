# Depth pass: the blind protocol

Frozen 2026-10-13. The slots are in `slots.json`, the measures, scale, panel and exit in `set.json`. This page says how a
slot is run, from the creator naming a reference to their verdict.

## 1. The creator names the reference

For each kind, the creator picks one game from the slot's candidates (or names another). The choice is a new file,
`choices/<kind>-<date>.json`, frozen like everything else:

```json
{ "schema": "xgk-eval-depth-choice/1", "kind": "scenic", "date": "YYYY-MM-DD",
  "reference": "<the game's name, or 'the private reference' for one that may not be named in public>",
  "creatorWords": "<what the creator said, verbatim>",
  "prompt": "<the showcase prompt: the creator's words, or ours if they asked us to write it, said which>",
  "slice": "<the part of the reference the players will play: e.g. the first 12 minutes from a new save>" }
```

The showcase prompt may name the reference game. The game built from it never carries the reference's name, people or
art (the own-words rule of T6 and T7).

## 2. The showcase is built

Through the whole loop from the prompt, with the whole ladder and no budget (`set.json` → `build`). The build ends when
the loop delivers and the team would put it in front of the creator. The delivered version, its commit and its gate
verdicts go into the slot's record (`records/depth/<kind>/<date>-<n>/`).

## 3. The blind session

**The room.** The creator's machine, the 3840x2160 screen at 60 Hz, a keyboard and mouse or a controller as the
reference expects. Both games run full screen. Nothing else on screen.

**The players.** At least six people (`set.json` → `panel`) who have not seen our game, are not on the team and are not
told which game is ours. Before they start, each says whether they have played or watched the reference; they stay in
either way, and the result is reported with and without the ones who know it.

**Hiding which is which.** Both games start from one plain launcher with two buttons, "Game A" and "Game B". A and B are
assigned per player by the plan's seed, and half the players play the reference first. Each game starts at play where
it can (skip title screens, studio logos and our own menu brand by starting a session straight into play); where a
title cannot be skipped, the person running the session covers it and notes it. Nobody in the room says either game's
name.

**The slice.** Each game is played for the same time, 12 minutes by default (the choice file may set the slice). A
multiplayer game is played in pairs if both games are multiplayer; otherwise everyone plays alone, and our game's co-op
is shown to the creator in step 5 rather than scored. No coaching beyond what each game shows on its own screen.

**Scoring.** Right after each game, before playing the other, the player scores it 1 to 7 on the four measures in
`set.json` (clarity, feel, look, again) and writes one sentence on each. After both: which they would rather play again,
and which one they think was made by the people running the session ("A", "B", or "can't tell").

**Recording.** One scoresheet per player per game, written by the person running the session, never edited after:

```json
{ "schema": "xgk-eval-depth-sheet/1", "kind": "scenic", "session": "<date>-<n>", "player": "P3",
  "knowsReference": false, "label": "A", "order": 1, "game": "sealed",
  "scores": { "clarity": 5, "feel": 4, "look": 6, "again": 5 },
  "words": { "clarity": "...", "feel": "...", "look": "...", "again": "..." } }
```

`game` stays `"sealed"` on the sheet; which label was ours is in the session's sealed map, opened only when every sheet
of the session is written. A 60-second 3840x2160 capture of each game in motion and the frame-time log of the session
are kept locally with the record (by sha256; video is not committed).

## 4. The blind score

Per measure: the mean over players of (our score − the reference's score), each player compared with themselves. A
measure is **within reach** when that mean is at least −1.0 (`set.json` → `withinReach`). Reported beside it: each
game's mean and spread, the same numbers without players who knew the reference, how many preferred ours, and how often
players guessed which was ours (more than 75% right means the hiding did not work, and the report says so).

## 5. The creator plays

Then the creator plays both, knowing which is which, for as long as they like, alone and with a friend. Their words go
verbatim into a new evidence file beside the record. The team does not summarise them into a score.

## 6. Exit and what follows

A slot exits when the creator's verdict is recorded and the blind score is within reach on at least 3 of the 4
measures. A slot that does not exit gets another build round and another session with new players (a new numbered
record; players from an earlier session do not return for the same slot). A reusable part the depth work produced (a
camera, a material, a panel) moves into a shared layer only after a second game needs it.

## The private reference

The dark slot offers the private first-person reference game. It can be played only on this machine, and its name
never enters a public file: its choice file, sheets and record call it "the private reference", and the name is kept in
the private notes.
