# Evals: how a run works

Evals are append only. A set is written, frozen with a date and a hash, and never edited again: a better case is a new
case in a new manifest, and a run that went wrong is a new pass. `run.mjs` is the runner; its adapters to the two loops,
the witness and the two-player probe are not wired yet (see "Not wired yet").

## What is here

| Path | What |
|---|---|
| `paired/` | The phase 5 gate: 12 prompts, each built 3 times by the old loop and 3 times by the new one. `set.json` (arms, measures, pass rule), `RUBRIC.md`, `JUDGE.md`, `cases/PA01`–`PA12` |
| `breadth/` | Breadth pass 1: one prompt for each of the 25 most-played archetypes, through the whole new loop once. `set.json` (outcomes, exit), `JUDGE.md` (rubric and prompt), `cases/B01`–`B25` |
| `depth/` | Depth pass 1: a showcase slot per kind with reference candidates for the creator to name one, and the blind protocol. `slots.json`, `set.json`, `PROTOCOL.md`; the creator's choices go in `choices/` |
| `cases/` | T1–T7 re-created as spec v2 cases (runtime, profile, loop, kind; no engine field), with `set.json` |
| `<set>/frozen/<date>-<n>.json` | A set's manifests: one hash per file, and one for the set |
| `records/<set>/<pass>/` | Everything a pass writes (below). Written once, then frozen |
| `run.mjs`, `lib/` | The runner: `freeze.mjs` (hashes, manifests), `sets.mjs` (loading, private inputs, planning), `record.mjs` (the record format), `blind.mjs` (bundle ids, bundles, scrubbing), `score.mjs` (the pass rules), `arms.mjs` (the adapters) |
| `tests/` | `node --test evals/tests/` |

## Freezing

`node evals/run.mjs freeze <set> --date YYYY-MM-DD` writes `<set>/frozen/<date>-<n>.json` with a sha256 for every file
no earlier manifest lists, and refuses when a frozen file has changed. A JSON file is hashed as canonical JSON (keys
sorted, no spaces) and a text file with `\n` line endings, so re-indenting or a line-ending change is not a change; a
changed word or value is. A case file also says `"frozen": "<date>"`, which must match the manifest that lists it.

`node evals/run.mjs check` checks every set and lists files not frozen yet. A run refuses to plan on a set that fails it.

## A pass, step by step

1. **Plan.** `node evals/run.mjs plan <set> --seed N` reads each arm's pin (the commit of the loop and the kit releases
   it serves) and writes `records/<set>/<pass>/plan.json`: the set's hash, each case's frozen hash, the pins, every run
   (`<case>-<arm>-r<rep>`) in one order shuffled by the seed so machine load falls on both arms alike, and the audit
   sample (five bundle ids per arm). It writes the map from run to bundle id into `sealed/map.json`. The pass id is
   `<date>-<n>`.
2. **Run.** `node evals/run.mjs run <set> --pass <id> [--model ID]` takes each planned run that has no record yet:
   - resolves the case's inputs: the prompt, the images in order, the answers, the own-words list; whatever is kept
     privately is found by hash in `XGK_EVAL_PRIVATE` (below), and the run stops before the loop starts if it is not there;
   - builds the game through the arm's loop, headless, with the base model (`--model`, default `claude-opus-5-5`, the
     same for both arms). Questions the loop asks are answered with the case's answers and recorded. Nobody touches the
     run; if someone has to, the record says so (`outcome.rescue`) and the run does not count as completed;
   - hands the delivered game to the **witness**: two black-box players, one per screen, that play it as new players to
     the end of its loop (or 10 minutes for a world, endless or saved game), writing what they did and saw, with screens
     every 5 seconds and at events, and a 20-second clip per minute. They never read the game's files, its spec or its
     delivery note, and are never told which arm made it;
   - runs the **two-player probe**: two browsers join through the game's own flow, play 2 minutes, and each screen is
     checked for the other player through `window.__game` against the pixels;
   - writes the blind bundle (`blind/<bundle id>/`), then the record (`runs/<run>/record.json`), then freezes the run's
     folder (`runs/<run>/FROZEN.json`). Nothing is written until every step has returned.
   The wall clock (`set.json` → `wallClockHours`, 8) is the only stop, the same for both arms. Cost is never a stop.
3. **Judge.** For each bundle, a fresh model session gets the set's `JUDGE.md` with `{{bundle}}` filled in and a working
   folder holding a copy of that bundle and nothing else (no repository, no records, no other bundle). Its reply goes to
   `judgements/<bundle id>.json`, written once. A judgement that marks the control present is void, and the bundle goes
   to a new session (`judgements/<bundle id>.2.json`, the void one kept).
4. **Audit.** A person marks the audit sample's bundles the same way, without seeing the reader's marks:
   `audit/<bundle id>.json`. Their marks change nothing; disagreements on core lines are listed in the result.
5. **Score.** `node evals/run.mjs score <set> --pass <id>` joins records and judgements through the sealed map and,
   when nothing is missing, writes `result.json` once: the gate (paired) or the exit (breadth), with everything the set
   says to report beside it.
6. **Freeze the pass.** The whole `records/<set>/<pass>/` folder is frozen (`FROZEN.json`), and the creator is told the
   result in plain words, failures first. A green result is not creator acceptance.

Depth sessions are run by people with the creator (`depth/PROTOCOL.md`); their sheets and the creator's words go into
`records/depth/<kind>/<date>-<n>/` and are frozen the same way.

## The two arms, headless

- **old**: games.fun's Studio v2 worker, driven as its own eval harness drives it (`research/studio-v2/evals/run.mjs`
  against local Studio, never production), with the case written as a one-off case in that harness's format: the prompt,
  the images, answers default accept, choose the card closest to the prompt. Forge and vista are opened on that worker
  (`GF_FORGE_OPEN=1`, `GF_VISTA_OPEN=1`), as the creator opened them on 2026-10-13. Its build model is set on the worker
  for the whole pass.
- **new**: xgames-kit's loop in one headless model session (the kit CLI with the build prompt and the kit's tools), in a
  fresh `games/<name>` folder under the run's directory. The loop's own tools hold the order (ledger, foundation, build,
  gates, play-test, deliver). Its ladder may climb to a stronger model: that is part of what is measured, and the record
  lists every model used.

Both return the same shape to the runner (`lib/arms.mjs`): delivered or not, the game's folder and hash, the questions
and answers, the rungs climbed, the models, tokens, minutes and money.

## Blinding

- A reader gets a bundle id and a bundle: the case's own words (prompt, images, ledger or musts, policy, control) and
  the witness's evidence. Never the spec, the delivery note, the loop's transcript or ledger, the pins or the models.
- Free text from the witness and the probe is scrubbed of the names of the kits, products, loops and models
  (`lib/blind.mjs` → `ARM_WORDS`); the game's own screens are not touched, because they are the game. Before a bundle
  is written, `leaks()` refuses it if any record field or any pinned name is in it.
- `sealed/map.json` is the only link from a bundle to its run. No reader or witness process is given its path.
- The paired reader is asked at the end which system it thinks built the game. If guesses are right more than 75% of
  the time, the result says the blinding was weak.

## Private inputs

Some cases need files that may never be in a public repository: the creator's uploaded images (T4, PA04), a third
party's screenshot the creator linked (PA08), and T6's prompt and own-words list, which name a private reference game.
A case lists each by sha256 only. The runner finds them in the folder named by `XGK_EVAL_PRIVATE`, by hash (images as
bytes, JSON as canonical JSON), so the folder's layout does not matter. On the owner's machine the folder is kept
outside every repository; to restore it elsewhere, copy the images from the research repo's eval refs and the live job
that holds the linked image, and write T6's private JSON from the research repo's T6 case (`{"schema":
"xgk-eval-private/1", "case": "T6", "prompt", "ownWords"}`), then check the hashes. A run that cannot find a private
input stops before the loop starts; it is never run with a stand-in.

## The record

`runs/<run>/record.json`, schema `xgk-eval-record/1`, checked by `validateRecord()` before it is written:

| Field | Holds |
|---|---|
| `set`, `setHash`, `case`, `caseHash` | what ran, with the hashes it was frozen under |
| `arm`, `rep`, `runKey`, `pass` | which run (`<case>-<arm>-r<rep>`) of which pass |
| `loop` | `{name, commit}`: the arm's pin |
| `model` | `{base, used}`: the base model and every model the run called |
| `started`, `finished` | ISO times with zone; `finished` is null when the wall clock stopped it |
| `outcome` | `delivered`, `rescue` (+ `rescueNotes`), `stopped` (null, wall-clock, error, declined, asking), `questions`, `ladder`, `lastWords` when nothing was delivered |
| `game` | `{sha256, dir, url}` when delivered, else null |
| `measures` | the runner's own: `completed` and `multiplayer`, each `{value, why}`; completed only with delivery and no rescue |
| `usage` | tokens, minutes, money: reported, never a stop |
| `blindId` | the bundle's id |
| `evidence` | `[{what, ref}]` |

The readers' marks are not in the record: they are `judgements/<bundle id>.json` (schema `xgk-eval-judgement/1`, the
shape in each `JUDGE.md`), joined only when the pass is scored.

## What is wired

`lib/arms.mjs`: both loops. **new** is `gamesfun build` (`builder/loop/headless.mjs`), called as a function with the
case's prompt, images and answers, the base model and the wall clock; its pin is this repository's commit. **old** is
the build loop of the kit before the cut, at a checkout pinned to commit 63c30a4 (`XGK_OLD_LOOP_DIR`; `git worktree
add <dir> 63c30a4` in that kit), driven by one headless Claude Code session through its own MCP tools and its plugin's
play-tester, standing in for the person by the defaults. Both return the same shape.

The **judge** is wired: `node evals/run.mjs judge <set> --pass ID [--only BLINDID] [--model ID]` (`lib/judge.mjs`)
gives each bundle that has no judgement a fresh session with the set's frozen `JUDGE.md` (its prompt part, `{{bundle}}`
filled in) as its whole prompt, a temporary copy of that bundle as its only folder (Read, Glob and Grep inside it; no
MCP server, no shell, no web), and writes its reply to `judgements/<bundle id>.json` once. A reply that is not of the
set's shape is asked of a fresh session once more, then the command stops; a void judgement (control present) is kept
and the bundle goes to a fresh session (`<bundle id>.2.json`), which `score` takes over the void one. It is the same
second reader the loop runs before every delivery (`builder/loop/reader.mjs`).

## Not wired yet

`witness.play` (two headless GPU browsers and a black-box model player) and `probe.twoPlayer` throw `NotWired`, so
`run` stops at the first delivered game, before anything is recorded. The probes a case names (`probe:foundation`,
`probe:promises`, `probe:own-words`, `probe:slot`, `probe:feel-targets`, `probe:look-pack`, `probe:frame-budget`) are
not written either; `checkFoundation()` in `lib/score.mjs` is the first one's core. Until they exist, a case item that
needs one is recorded as not run, never as passed.
