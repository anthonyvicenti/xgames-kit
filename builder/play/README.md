# The play (builder/play)

How a game plays, designed before it is built. The loop's `design` step (after create and the look, before the build
round) gives a designer round on the stronger model the person's words, the ledger, the foundation's parts (the loop
and every mechanic on the runtime, with their params), the game's world and the references (gameplay frames, or
frames sampled from a clip; kept local, never in a repository), and asks it to reason from the genre the words point
to. It answers with the **play target** (`spec.play.target`, `gf-play-target/1`, `builder/spec/play-target.schema.json`):

| field | what it holds |
|---|---|
| `genre` | the kind of play in plain words (never a game's name) and what its players come for |
| `verbs` | 2–8 core verbs, each on a control |
| `beats` | what a player does every ~5 s (`moment`), every ~30 s (`stretch`), the `round`'s arc, `between` rounds |
| `objective` | goal, win, lose; `reach` {how, within (s from a seat), risks}; `things` placed in the world, each on reachable ground |
| `touchpoints` | how players affect each other |
| `risk` | risk and reward |
| `pacing` | numbers a judge measures: `firstAction`, `eventsPerMinute`, `roundSeconds`, `turnSeconds`, `idleMax`, `comeback`, `rounds`; `downMax` (the longest a knocked player is down, flight and get-up included: **the fair-play limit the gates read**, required when players knock each other) and `out` (never, respawn, round) |
| `events` | the gameplay events the game reports with `ctx.events.count(player, name, {at})` (the judge reads `rules.<name>` in `window.__game.events()`) |
| `feel` | impact, weight, chaos, comedy, juice |
| `avoid` | failure modes with their guard: always idle and unreachable; runaway-leader when players compete |
| `makes` | 3–6 lines of what makes it play, each with what a player sees: each becomes promise `play.<n>` |
| `mechanics`, `build`, `params`, `bots` | the parts chosen and tuned, what the build writes new, rules.params, how bots play it |

`design.mjs`: `design(spec, ledger, refs, {registry, designer})` → `{target, problems}` or `{pending}` (no designer:
the session answers the brief, then `finish(base, answer)`); `designMessage`, `checkTarget` (shape and honesty checks
that hold for any game: never one genre's rules), `withPlay(spec, target)` (the spec with its play), `playPromises`,
`partsOf`, `playRefsOf`, `runnerDesigner(run)`. CLI: `node builder/play/design.mjs <spec.json> [--ledger l.json]
[--refs <folder|image|clip>]… [--design [--model opus]] | [--answer a.json] [--out target.json] [--apply spec.json]`.

The pitch carries play too: every card has `play` {style, verbs, beat, touch, chaos} and the cards differ in style,
so the person chooses play, not only look. When the person's own words never said who acts when, a card may play on
another open loop (`foundation.loopChoices`); choosing it moves the foundation and the ledger's acts line.
`gamesfun build --until build` runs the loop up to the build round (the plan, the look and the play) and stops.

The play judge (`judge.mjs`, gate D's play leg) scores a game against this target: [JUDGE.md](JUDGE.md). The events a
target names reach it as `ctx.events.count(player, name, {at})` from the game's own rules (the play feed,
runtimes/three/kit/core/play.js); `pacing.downMax` is the fair-play limit the gates read.
