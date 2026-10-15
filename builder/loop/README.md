# The creation loop (builder/loop)

One loop for every runtime, held by its tools (`builder/mcp/loop-tools.mjs`, bound to this kit in
`builder/mcp/tools/loop.mjs`), by `gamesfun build` (headless) and by Studio's worker alike. The library never starts an
agent or calls a model: a host passes runners, or each round is handed over and taken back with the next
`step(input)`. `kit.mjs` binds the seams to this kit (registry, create, verify, fix, checkSpec, checkpoints).

## Steps and tools

| Step | Tool | Input it takes |
|---|---|---|
| ledger | `gamesfun_step_ledger` | `idea` (+`references`), then `ledger` {rows, asks}; `answer` {words} or {deliver: true} when the person was asked |
| foundation | `gamesfun_step_foundation` | `probes` [{row, home, evidence, by?, how?, where?}]; `approve` (the person's yes to a migration) or `decline` (their no: the game keeps its runtime, and their words amend the ledger) |
| pitch | `gamesfun_step_pitch` | nothing (hands the round); `choice` {card, answers, words}: answers or any words send the card through a spec round that applies them; a bare pick locks the card |
| spec | `gamesfun_step_spec` | `pitch` {reply, cards, questions} or `spec` |
| create | `gamesfun_step_create` | nothing; runs create and hands the build round (one-page brief) |
| design | `gamesfun_step_design` | nothing (hands the designer round, on the stronger model); `target` (the play target: `builder/play/README.md`). Its mechanics and build lines join the spec, the game is made again when the spec changed, each line of what makes it play becomes a promise `play.<n>` |
| build, repair (round end), fix | `gamesfun_step_fix` | `summary`, `controls` |
| economy (a kept economy only) | `gamesfun_step_economy` | nothing; the kit's economy checker on gamesfun.json |
| backend (a kept backend only) | `gamesfun_step_backend` | nothing; no secret, row-level security on every table |
| verify | `gamesfun_step_verify` | nothing |
| playtest | `gamesfun_step_playtest` + `gamesfun_playtest_report` {token, report} | the report: every promise asked `seen` / `not-seen` / `unreachable` |
| read (the second reader) | `gamesfun_step_read` + `gamesfun_reader_report` {token, reading} | the reading: every ledger line `kept` / `partly` / `lost` / `cannot-tell` |
| repair | `gamesfun_step_repair` | nothing; hands the ladder's next round |
| ask | `gamesfun_ask` | `message`, `questions` (top of the ladder; or giving a round up) |
| deliver | `gamesfun_step_deliver` | nothing |
| (after delivery) | `gamesfun_change` | `request`: re-enters at the ledger |

`gamesfun_next` reads the state and names the next tool, the round with you, the ladder and what the person is asked.
Unchanged from the kit and not here: `gamesfun_play`, `gamesfun_rollback`, `gamesfun_keep_edits`, `gamesfun_requests`.

## Files

`order.mjs` (the order, once), `loop.mjs` (`openLoop(host)`), `ledger.mjs`, `foundation.mjs`, `pitch.mjs`,
`promises.mjs`, `brief.mjs`, `ladder.mjs`, `playtest.mjs`, `reader.mjs` (the second reader), `parts.mjs` (the economy
and the backend), `change.mjs`, `registry.mjs` (the calls the loop makes),
`messages.mjs`, `state.mjs` (gf-loop/2), `words.mjs`. Shapes follow `contracts/builder/loop/*.schema.json`
(gf-ledger/1, gf-promises/1, gf-ladder/1), `contracts/builder/gates/verdict.schema.json` and spec v2;
`tests/contracts.test.mjs` holds them to it.

## The stop rule and the ladder

After a repair round, a result that fails on the same set as the one before it (`repeat`), on a set seen earlier in
this ladder (`returned`), or after a round that changed no file (`unchanged`) climbs: `model` → `specialist` (one round
per area: art, sound, netcode, feel, code) → `generate` (skipped, said, when nothing stuck is art or sound) → `ask`.
No round count, no cost stop. The ladder is in the state (`state.ladder`, gf-ladder/1); an answer resets it on the new
plan and keeps the stronger model. Progress keys for Studio: `SAY` (= `creator-studio/lib/ladder.mjs` LADDER_SAY),
through `host.say(key, detail)`; `ladderRecordOf(state)` gives `ladderRecord`'s numbers.

## What Studio's worker changes to call it

1. One `openLoop` per project, not two loops per claim: the store is per game (`fileStore(<jobs>/<project>/loop.json)`),
   so a pitch claim, the person's choice and the build claim resume the same state. Pitch job = steps ledger,
   foundation, pitch (status `waiting-on-creator`, `about: 'cards'`); refine = `step({choice})`, spec; build = create
   to deliver.
2. `agent(o)` returns the round's result instead of the worker reading out/*.json: `{ledger}`, `{probes}`, `{pitch}`,
   `{spec}`, `{summary, controls}`, `{questions}` or `{gaveUp}`. `o.kind` is ledger | amend | probe | pitch | spec |
   build | change | migrate | repair | specialist (`o.area`) | generate (`o.areas`; turn paid makers on, no cap) | ask;
   `o.model` is `limits.model` or `limits.strong`.
3. `playtester(o)` returns the report; `o.focus` is the promise ids asked.
4. `tools`: `create(spec, {game, kind})` → `{ok, why}`, `verify(game, {n})` → a verdict in the contracts' shape (`pass`,
   `gates`, flat `failed` with `area`), `fix`, `hash`, `checkSpec` (the spec v2 schema + registry), `ownFiles`.
5. `hooks`: `cards(pitch)` → studio.pitch (the pitch carries `ledger` with its `foundation`), `ask(questions)`,
   `migration(m)` (show it; the person's yes comes back as `step({approve})`), `deliver(outcome)` → finalize/upload.
   `outcome` has `outcome`, `notYet`, `ledger` (rows proven/failed/untested/cut), `promiseLedger` (gf-promises/1),
   `gates`, `ladder`, `ladderRecord`.
6. Delete: `MAX_REPAIRS`, `RESCUE_ROUNDS`, the rescue model switch, `check-honesty.mjs` engine routing, `checkJob`'s
   pitch rules, `composeBrief` from frames, `budgetScale` by build count (cost never stops a build). Change requests
   go through `loop.change(request)`, answers through `step({answer})`.
7. `reader(o)` returns the second reader's reading (o = {message, bundle, model}; `limits.readerModel`): a separate
   session that sees only `o.message` (the person's words, the ledger lines, the promises with the play-tester's log,
   the screenshots' paths) and may play the game itself (`host.readerPlays`). With no runner the round is handed over
   (`waiting: 'reader'`) and the reading comes back as `step({reading})`. `flags.reader: false` turns it off (the
   outcome says so).
8. `parts`: `kitParts({env})` (kit.mjs): the economy when web3 is on, the backend always, each `{check(game),
   publish?(game), status?(game)}`. The ledger and the pitch may ask about a part that is on (`extraAsks` defaults to
   them). The registry is `registry/build-catalog.mjs createRegistry` (kit.mjs `kitRegistry`).

## For hosts (found by Studio's first v3 build, 2026-10-13)

- The pitch is the pitch v2 shape (`PITCH_OUTPUT`, `pitchShapeProblems`; the loop stamps `pitchVersion` and the
  ledger): no host fills card fields or cuts the reply.
- `outcome.summary` (also `outcome.delivery.summary`) is the game in the person's terms, from the spec and the ledger
  as delivered (`creatorSummary`); the last round's own words are `outcome.delivery.lastRound`, for the session.
- A runner's talk round that is handed back gets its problems and its own last answer (`o.again`, the message), and
  every talk round names its output schema (`o.schema`: the ledger's from the registry's words, the pitch v2 shape).
- `hooks.deliver(outcome)` may answer `{ok: false, why}` (or throw): the run stays at deliver, `state.outcome.handOver`
  says why, and the next deliver step hands it over again. Nothing is delivered before the host says it is.
- What a host skips when it uploads or shows a game: `HOST_SKIP` / `isHostSkipped(rel)` / `deliverableFiles(game)`
  (the loop's folder, verify's evidence, node_modules, every dot name).
- `toolsFor(kind, …)` (headless.mjs): the tools one round may use, for a host that runs rounds itself.

## The second reader

Before every delivery (`read`, between the play-test and `deliver`; `deliver` sends the loop back to it when the files
changed since the last reading), an independent reader gets only the person's words and the delivered game (the
promise ledger with the play-tester's log, and its screenshots), never the build's transcript, the spec or a line's
home, and marks every ledger line `kept`, `partly`, `lost` or `cannot-tell` (`reader.mjs`, the paired rubric's marks)
with `findings` for what the marks do not say. It is advisory: it never sends the loop back and never renames the
outcome. Its marks join the delivery's ledger (`outcome.ledger.rows[].reader`) and `outcome.reader` carries the counts,
the core score and the words the person reads first. A reader that gives no valid reading twice is said
(`status: 'unread'`), never waited on. The evals' judge is the same reader: `evals/lib/judge.mjs` gives a fresh session
the set's frozen `JUDGE.md` and a copy of one blind bundle (`node evals/run.mjs judge <set> --pass ID`).

## The economy and the backend

Offered, never forced (the creator: web3 is on by default, `GAMESFUN_WEB3=0` turns it off). In tool order:
**decide** at the pitch (`offers.economy` / `offers.backend`, and a question with a way out unless the person's own
words asked for it; their answer keeps or drops it by code, `applyPartAnswers`); **check** after each round
(`economy`, `backend`: a refusal is a failing set, repaired under the stop rule like a gate); **publish / connect** at
delivery (`outcome.economy`: the approval link, nothing signed; `outcome.backend`: connected, or how to connect).
Delivery never waits on the person's wallet or account.

## Every answer's next action

Every hand-over (`waiting: 'agent' | 'playtest' | 'creator'`) carries `action`: `{tool, args, returns, or?}`, the call
that takes the round's result (`order.mjs` `ACTIONS`, `actionOf`). `returns` is the key a runner's result carries
(`ledger`, `probes`, `pitch`, `spec`, `summary`, `questions`, `report`, `choice`, `answer`, `approve | decline`); `or`
is the other way on (deliver as it is; decline a migration). The MCP tools' answers carry it too (`where()`). A host
that writes answer files reads `action` and never parses the prose.

## Changes since the staging snapshot (2026-10-13), for hosts that pinned it

- `index.mjs` exports more, nothing less: `heldStore`, `ignoreStateDir` (state), `PLAY_MINUTES`, `PLAY_GUIDE`
  (playtest), `RULES` (brief: the five prompt rules every build brief carries), `ACTIONS`, `actionOf` (order).
- `step()` answers carry `action` (above). `step({decline})` at a migration (gap 3).
- `choice.words` with no answers now gives a spec round whose message quotes them (gap 1); `specMessage` takes `words`.
- A run whose game was never made (create failed, then an answer) goes spec → create → a build round (gap 2); state
  fields `created` (when create made the game) and `fresh` (the next round writes the whole game) record it.
- `host.session`: the agent session driving the run, kept as `state.session` (the stop guard holds it).
- A runner host's play-tester that gives no valid report twice in a row: its valid answers stand and the rest count as
  `unreachable` (state `badReports`), so a runner is never asked forever.
- `answer: {deliver: true}` before any game was made ends the run with outcome `not-made` and status `failed` (it used
  to send the loop to verify a game that did not exist). A step that ends a run as failed no longer marks it delivered.
- `composeBrief({game})`: the game's folder; the brief carries the five rules and each mechanic's worked example;
  `BRIEF_MAX` is 10000.
- The MCP factory is `builder/mcp/loop-tools.mjs` (`loopTools(bind)`; `bind.reports`, `bind.handed`, `bind.session`,
  `bind.sessionOf`, `bind.extra.next` are optional); every tool has hints and an output schema.
