---
name: make-a-game
description: What goes into the rounds of a game's creation - the requirements ledger in the person's own words, the three questions that place it (runtime, loop, kind), 2-3 pitch cards that never narrow the idea, a spec v2 that locks, and the build round that writes rules.js, src/ modules and declared overrides. Use when someone asks to make, build, prototype or start a game, or says "a game like X"; the build-loop skill holds the order of the steps.
---

# Make a game

**The order of the steps is the creation loop's, not this skill's.** Call `gamesfun_next {"game": "games/<name>"}` and
do what it says (skill `build-loop`; without the MCP tools: `node bin/gamesfun.mjs tool gamesfun_next --game
games/<name>`). The loop hands you each round with its message. This skill is what goes into those rounds. AGENTS.md
(repository root) is the map.

## 0. Know what the kit has

```bash
npx gamesfun catalog --all                      # loops, mechanics + params, worlds, looks, bodies, props
node registry/build-catalog.mjs --matrix        # runtimes x kinds: what is proven, what is a look, what is open
node registry/build-catalog.mjs --which devices=phone camera=first   # which runtimes meet these limits
npx gamesfun examples                           # complete games to start from or learn from
```

The catalog assists; it never narrows an idea. What it lacks, the game builds.

## 1. The ledger: what they asked for, in their words

The ledger round's message lists the registry's words (loops by who acts when, cameras, devices, kinds, capabilities,
mechanics). Write one line per essential:
- exactly one each for **who acts when** (`acts`), **the perspective** (`perspective`: camera and dimension), **how
  friends play together** (`players`: versus, coop, teams, turns, own-board) and **what a player is** (`body`:
  character, board, vehicle, cursor, cards, boat, other); at least one **action**; one for the devices when they named
  any, for the feel, for each reference, and for every other thing they asked for (`thing`);
- `words`: their own words, copied exactly (a few are enough). A line with no words of theirs is not theirs;
- `home`: `exists` with `by` (`mechanic:<id>`, `loop:<id>`, `runtime:<id>`, `kind:<id>`, `capability:<id>`), or
  `build` with `how` (what will be written) and `where` (`rules`, `module` or `engine`), or `probe` with a question
  and a bound in minutes when only a short try can tell;
- `needs`: the capabilities the line needs from what runs the game (the runtime is chosen by these).

Ask only how friends play together and what a player is, and only when their words leave it open (`asked: true` on
the line, the question in `asks` with options and a default); a question their words already answer is never asked. Never
cut a line yourself: a line leaves only with the person's own words (`cut: {words}`).

## 2. The foundation

The loop chooses it from your ledger: the runtime and profile by hard limits (devices, graphics, camera, what must be
built), the loop by the acts line, the kind last from the feel and reference lines. When the loop the idea needs is
not open on that runtime, the acts line becomes a build line on the closest loop. Say its plain words to the person
on the cards (a device limit, what this game builds).

## 3. The pitch: 2–3 cards

- Takes that differ in **how they play** (a different goal or way friends interact), all on the foundation's runtime
  and loop. A named game ("a game like X") gets its faithful take first.
- Each card: `{id, title, take, v1: {has, build, notYet}, spec}`. **Every card keeps every line of the ledger.**
  `v1.build` names, in plain words, everything the card builds new; `v1.notYet` holds only what the person cut.
- The reply says what card 1 does, what is built new, and that building new takes longer. It never says the kit
  cannot do something.
- The questions are the ledger's, and only those.

World size: `small` is one space everyone sees across; `medium` has rooms or areas joined by doors and paths; `large`
is a place to roam. Characters: each role can have its own body (a boss that wears its minions' body reads as one of
them); a kind's own body set fills `{"from": "kind"}`.

## 4. The spec (v2)

`builder/spec/game-spec.v2.schema.json`; examples in `builder/spec/examples/game-spec.v2/`. Required: `specVersion`
(2), `title`, `hook`, `runtime` (+ `profile` when the runtime has profiles), `loop`, `kind`, `players`, `multiplayer`
(`mode` live, room or solo with a written `why`; `together`), `devices` (`targets`), `camera`, `world`, `mechanics`,
`rules`, `characters`, `build`. Also `prompt` (their words), `controls` (only keys the game really uses), `round`
(the loop's clock and its numbers), `sounds`, `content`, `accept`. Every ledger line whose home is `build` has a build
item `{what, how, where, row}`; item n is the promise `build.<n>`. Put every tuning number in `rules.params`.

## 5. Create, then the build round

`gamesfun_step_create` makes the game from the locked spec and hands you the build round: a one-page brief from the
manifests of only the parts the spec chose, every promise the build writes, the five rules and the six gates. The game
gets its own `AGENTS.md`.

## 6. Write the game's own code

Write only what makes this game this game, on the surface its runtime gives (the brief names the section):
- **three** (every profile): `rules.js` with `ctx` (`builder/CONTRACT.md` §3). Its hooks: `setup` (get mechanics,
  make HUD meters, register callbacks), `roundStart` (reset per-round state), `update` (the players this copy owns;
  host-only scoring under `if (ctx.host)`, not every frame), `event` (an edge another copy sent), `check` (host: end
  early with `{winners, reason}`), `results`, `bot` (bots act through `ctx.bots` and `p.bot`).
- **forge**: the spec's data tables first (`spec.tables`: weapons, enemies, waves, cards…), then `rules.js` for what
  they cannot say (commands in, events out; `runtimes/CONTRACT.md` and `builder/CONTRACT.md` §8).
- **vista**: its tables and `rules.js` over `ctx.vista` (`builder/CONTRACT.md` §8).
- **godot**: the game's own scenes and scripts in its Godot project, talking to the kit through the bridge
  (`runtimes/godot/README.md`).

On every runtime: tuning numbers in `config/game.json` → `rules.params` (each a slot), chance through the runtime's
seeded random (`ctx.rng()` on three), shared decisions on the host, nothing visible drawn in code. After adding rules
params, props or mechanics: `npx gamesfun slots write games/<name>`.

Every build promise is yours to make work: a module under `src/` that `rules.js` imports, or, when only the runtime
can do it, an edit of the runtime's copy in the game declared in the game's record (`overrides`, with the file's
hash before the edit and why). Say plainly in the summary what does not work yet.

## 7. End the round

Your quick check is `gamesfun_verify` (skill `verify-and-playtest`): fix, repeat, until it passes on the files as they
are. Then `gamesfun_step_fix` with `summary` and `controls`; the loop runs the six gates and the black-box play-test of the
promises (the playtester subagent's, never yours) and names each next tool.

## 8. Tell the person

After `gamesfun_step_deliver`: the outcome's ledger first (each line proven, failed or untested, by name), then what
they will see and the controls in one line. `gamesfun_dev_start` lets them play. Their next request is a change
(`gamesfun_change`): it re-enters at the ledger.
