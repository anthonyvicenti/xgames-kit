# Developing xgames-kit

For maintainers of the kit itself. Game builders want `README.md` and `AGENTS.md`. The layout and the seams are in
`ARCHITECTURE.md`.

## Setup

Node 24 (`.nvmrc`), then `npm ci`. Chrome or Edge for the browser tests (else Playwright's Chromium is downloaded on
first use).

```bash
npm test                         # every suite but the smoke test (about 2 minutes; a few open Chrome, most need none)
npm run test:smoke               # the smoke test alone: per example, create, quick verify, two pages that see each other (~4 min an example)
node scripts/sync-skills.mjs --check   # the skill mirrors and the generated files are in sync
node tests/two-players.mjs http://127.0.0.1:5180/ --shots <dir>    # the two-page check against a running dev server
node tests/loop/dryrun/dry-run.mjs   # the creation loop's dry run through its MCP tools, no model, no browser (writes dryrun/record.json, transcript.txt)
npx gamesfun build --prompt "<idea>" --game games/<name>   # one real build, headless, with your own Claude Code (every round's transcript in the game's loop folder)
node tests/backend-local-e2e.mjs --api <url> --key <publishable> --db <postgres url> [--out <dir>]   # a game saves a high score to a real local Supabase (Supabase CLI's Docker stack, psql): migration, RLS checks, one round in Chrome
node tests/online-e2e.mjs [--out <dir>] [--ports a,b,c]            # online play: two pages on two origins through a signaling server on a third; a host that refuses (~1 min, real browser, nothing on the internet)
```

`tests/loop/` holds the creation loop's tests: the library on a made-up registry (the dry run among them), the loop
bound to this kit on the real registry and create (`kit.test.mjs`), and `gamesfun build` with `claude -p` stood in by
`fake-claude.mjs` (`headless.test.mjs`).

`npm run test:smoke` sets `GAMESFUN_SMOKE=1` itself (scripts/smoke.mjs), on every system. `GAMESFUN_SMOKE=1 npm test`
(PowerShell: `$env:GAMESFUN_SMOKE = "1"; npm test`) runs everything at once.

## The kit's layers

The kit is edited here, where it is: nothing is synced from games.fun any more (its research tree is the history the
kit came from). [LAYOUT.md](LAYOUT.md) says what each folder holds and where every folder of the old `kits/` went.
Three things a change has to keep:

1. **A game's tree.** A game's `gf/three/` is assembled from `runtimes/three/kit/`, `components/`, `loops/`, `worlds/`,
   `builder/ui/` and `runtimes/three/profiles/flat-2d/` (`GAME_TREE` in `builder/tools/lib/paths.mjs`). A kit module
   imports as a game sees it; the tools read the kit with `kitPath()` and `walkKit()`, and Node imports a module whose
   imports cross layers with `importLayer()` (`builder/tools/lib/kit-import.mjs`).
2. **The hashes.** `builder/gf-multiplayer`, `builder/gf-audio` and `builder/gf-assets` are held to their own
   `kit.json` and `SHA256SUMS`, forge's two wasm builds to `runtimes/forge/kit/BUILD.json`; a change there updates
   them in the same commit (`tests/layers.test.mjs`).
3. **The licences.** A library file has its `LICENSES.json` record (CC0 or permissive; never Meshy output), a vendored
   library its licence text beside it, and `THIRD_PARTY.md` its row (`tests/licensing.test.mjs`,
   `tests/layers.test.mjs`).

After a change to the kit: `npm test`, then `GAMESFUN_SMOKE=1 npm test` (every example must still pass verify). If an
example fails, fix the kit or `examples/<set>/<id>/`, and update its `example.json` → `verified`. A game made on an
older kit is created again from its spec when it is wanted (`gamesfun create games/<name> --spec
games/<name>/spec.json`): there is no upgrade path.

## How the tools are run

Each tool runs as a child process: `node builder/tools/<tool>.mjs …` (`builder/lib/run-tool.mjs`), with no copies of
a tool's command line. What this checkout tells the tools goes through the
environment:

| Setting | Set by | What it does |
|---|---|---|
| `GF_MANIFEST_IGNORE` | `builder/lib/run-tool.mjs`, for every tool | names `builder/lib/manifest-ignore.json`: the files this kit adds to a game that are not assets (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.agents/`, `scratch/`, `gamesfun.json`). gf-three writes them into `assets.json` → `ignore` and keeps them |
| `MESHY_API_KEY`, `GF_MESHY_LEDGER`, `GF_MESHY_WAVE`, `GF_MESHY_CAP` | `gamesfun meshy` | the person's own key, and a ledger under `.gamesfun/` (outside games.fun the tools refuse a paid task without one) |
| `CHROME_PATH` | `builder/lib/chrome.mjs` `ensureBrowser`, only when no browser is installed | Playwright's own Chromium, downloaded once. Finding an installed Chrome, Chromium or Edge is the tools' job (`builder/qa/browser.mjs`) |

Playwright is found by package name (`playwright-core`, pinned in this package). The 3D tools' own packages
(gltf-transform, meshoptimizer, sharp) are installed on first use into `builder/tools/lib/char-deps/`
(`builder/lib/char-deps.mjs`; git-ignored). `verify` needs them too since check 19 reads every body's skeleton.

`builder/lib/manifest-ignores.mjs` remains for one caller: `builder/web3/node/game.mjs` adds `gamesfun.json` to a game that already
has an `assets.json` and adds its ignore entry at once. It reads the same JSON file.

## Tool faults worked around here

Faults in the kit's tools that this checkout works around, to be fixed in the tools themselves. Deleted here because the loop library now covers them: `paths.GAME` for the rescue and play-repair messages, `playWords.REPORT_HOW` for the play-test brief's report line (`gamesfun_playtest_report`), a refusal that `step()` returns being marked told, `.gf-loop/**` in the game's ignore list decided by where the state file is (`ignoreStateDir`), `host.session` kept as `state.session` (the stop guard holds that session only); the reminder
round's words after a restart, the promises writer bound by hand, the rewriting of the loop's messages and of the play-tester's brief for this kit's
folders and tools (`paths`, `toolNames`, `playWords`), stopping a running verify with its host (`host.signal`), and the roll-back work-around (`loop.cancel`). Fixed upstream and removed from this table: the forge
HUD and forge-spec refusals now load by `importPart` (`spec-config.mjs`, `create.mjs`); `verify.mjs` imports the body judge
only when check 19 runs (the CLI still installs the 3D packages first, so check 19 can run); the scenic `follow` camera
failing checks 24 and 34 (the example passes both); melee under `third` and `orbit` cameras (a scenic spec with either
camera passed 27 of 27 with `--quick --release`).

| Fault | Where | Work-around here | Fix asked for |
|---|---|---|---|
| `lookdev/capture.mjs` (check 9's contact sheet) is left out | `tools/verify.mjs` | none needed: `--quick` skips it and a full verify says it is absent | none |
| Keeping a person's edits made while the play-tester had the game has no entry in the loop library | `loop/build-loop.mjs` (the `playtest` and `deliver` steps) | `gamesfun_keep_edits` (`builder/mcp/tools/loop.mjs`) uses the library's own steps: it puts the play-tester's files back for the one step that reads the report (so the proof on record names those files), restores the kept files, and lets the delivery step's stale-proof rule send the loop to verify and then to the play-test again. With no report the round ends as an error, and the library then delivers with no play-test on the kept files (the kit's delivery answer says so by name) | `loop.keepEdits({wish})`: the wish on the state, from a handed play-test straight to verify, and a play-test afterwards also when the first round had no report |
| A friend's join sometimes hangs after the connection opens: the host never answers the friend's first message ("Connected. Waiting for the host…" until the gate times out) | `gf-multiplayer` 1.6.3's lobby (1.7.0 is the version new games get now; whether the hang still happens on it is not known) or the gate (`builder/multiplayer/party/gate.mjs`); seen once on a Linux runner and once here under load (`docs/CI.md`, fault 7) | none: the run is repeated | find the race (it may be the one behind the refused `signal` calls seen after a join) |
| `specs/dev-dodgeball.spec.json` names no `loop`, and a pitch card's spec must (`$.cards[n].spec.loop`) | `builder/spec/specs/` | none: the pitch round's message points to it as an example of a locked spec, where `loop` is optional | add `"loop": "round"` so the example is also a valid card spec |

## Examples

An example is `examples/minimal/<id>/` with `spec.json` (a locked spec), `rules.js`, `README.md` (what it shows,
provenance) and `example.json` (`title`, `summary`, `verified: { result, kits, date }`). Optional `files/` is laid over
the created game (then `assets.json` is regenerated). An example ships only after `npx gamesfun verify --quick` passes
on a fresh `create --from` with the current kits; record the result in `example.json`. An example that a kit fault fails may list the failing checks in `example.json` → `knownFailing` and say why in its README; the smoke test then requires exactly those to fail. No example has one now (`giant-four` had check 7 until the kits carried audio gate v5). Every example's `spec.json` is a spec v2, so each is tagged by its runtime, profile, loop and kind:
`soak-squad` (three/standard-3d, round, silly), `isle-run` (three/scenic-3d, run, scenic: WebGPU, with WebGL2 inside WebGPURenderer where Chrome has no adapter), `coin-hop` (three/flat-2d, seen from the side, drawn), `giant-four` (three/standard-3d, the `turns` loop and the `board` mechanic), `table-four` (the same board played from the seats: friends seen as seat cards, pointers and moves), `lights-race` (own boards side by side: each friend's board live beside yours) and `lantern-cove` (vista, calm). A forge example is coming: it needs its free stand-in art.

**The vista example.** Nothing closes an example: a runtime is open to pitches when its registry manifest says so
(`runtimes/<id>/runtime.json` → `state.open`). `lantern-cove` runs only where Chrome has a hardware WebGPU adapter with
at least 31 sampled and 5 storage textures per shader stage (no WebGL path; `runtimes/vista/kit/gpu.js`), so CI never
creates it (`docs/CI.md`), and the smoke test (`npm run test:smoke`) plays it only on a machine like that.
`tests/examples.test.mjs` reads its rules like every other example's. A forge example's rules will import the game's
own copy of the forge kit (`./gf/forge/feel.js`), which the test maps to `runtimes/forge/kit/`.

`tests/try-it-shots.mjs <out dir> [port]` takes the screenshots `docs/TRY-IT.md` shows (`docs/try-it/01` to `10`) from real runs of the examples; run it again when the studio page or an example changes.

## The studio's web3 tab

The Economy tab (`builder/studio/tabs/economy.js`; it replaced the Token and Shop tabs) is on by default since 2026-10-12. One
switch, `builder/lib/web3-switch.mjs`, serves the studio and the MCP server: with `GAMESFUN_WEB3=0` (or `off`, `false`, `no`),
`GET /api/studio/tabs` (`builder/server/routes/studio.mjs`) leaves `economy.js` out of the list the page builds its tab row
from, so it is neither in the page nor reachable by keyboard, and the `web3_*` and `economy_*` tools are not offered,
even for a game that has a `gamesfun.json`. `tests/web3-switch.test.mjs` holds both ways.

## Skills

`skills/<name>/SKILL.md` is the source. `node scripts/sync-skills.mjs` mirrors it byte for byte into `.claude/skills/`
and `.agents/skills/`; `tests/skills.test.mjs` fails on drift. The front matter `name` must equal the folder name.
Four things are generated first (`scripts/gen-loop.mjs`), never edited by hand: `skills/build-loop/SKILL.md` (from
the loop's order, `builder/loop/order.mjs`, and the loop tools), `plugin/agents/playtester.md` and
`plugin/agents/reader.md` (from `builder/loop/playtest.mjs` and `builder/loop/reader.mjs`), and the block between the
`gf:rules` marks in `AGENTS.md` (the five prompt rules, `builder/loop/brief.mjs` RULES, each with its enforcer in
`builder/tools/lib/homes.json`). Change one of those sources and run the script.

## Cross-platform rules

No shell: child processes are `process.execPath` plus arguments (npm through `npm-cli.js`). No symlinks, no case-only
renames, no POSIX-only paths: build paths with `path.join`, show them with forward slashes (`toPosix`). Tests check
Windows path rules with `path.win32` so they run everywhere. `.gitattributes` makes text LF everywhere and keeps the
kit's layers byte-exact (the folders that were `kits/`).

## The one line: agents, doctor, connect, update

Code: `builder/lib/agents.json` (the rows) and `builder/lib/agents.mjs` (its reader), `builder/lib/connect.mjs`, `builder/lib/doctor.mjs`,
`builder/lib/update.mjs`, `builder/lib/proc.mjs` (programs started without a shell, trees stopped), `builder/lib/mcp-check.mjs` (starts our
server and lists its tools), the three commands, `tests/one-line.test.mjs`. The text a person pastes and what the agent does
at each step: `docs/ONE-LINE.md`.

**A new agent is a row.** Copy a row in `builder/lib/agents.json`: `binaries` per system, `install` per system, `mcp.add`,
`get`, `list`, `remove` as argument lists (`{name}`, `{scope}`, `{command}`, and the element `{...args}`), `scopes` and
`defaultScope`. `tests/one-line.test.mjs` validates every row. We never edit an agent's own configuration file; if an agent
has no command for adding a server, it does not get a row (document the manual step in `docs/MCP.md` instead).

**What the vendors document (fetched 2026-10-10; re-read before changing a row).**
- Claude Code, https://code.claude.com/docs/en/mcp: "claude mcp add [options] <name> -- <command> [args...]";
  "the `--` (double dash) separates Claude's own options, such as `--transport`, `--env`, and `--scope`, from the command
  and arguments that run the server"; scopes "`local` (default): available only to you in the current project",
  "`project`: shared with everyone in the project via the `.mcp.json` file", "`user`: available to you across all
  projects"; `claude mcp list`, `claude mcp get <name>`, `claude mcp remove <name>` (with `--scope <scope>` for a
  duplicate); "Claude Code prompts for approval in interactive sessions before using project-scoped servers from
  `.mcp.json` files" (until then `list` shows "Pending approval").
- Codex, https://learn.chatgpt.com/docs/extend/mcp?surface=cli (developers.openai.com/codex/mcp redirects there):
  "codex mcp add <server-name> --env VAR1=VALUE1 --env VAR2=VALUE2 -- <stdio server-command>"; "codex mcp list" shows
  configured servers; "By default this is `~/.codex/config.toml`"; project scope is `.codex/config.toml` ("trusted
  projects only"). `get`, `remove`, `list --json` and `CODEX_HOME` are not on that page; they are in `codex mcp --help`
  of codex-cli 0.160.0 (`CODEX_HOME` moved the config file in the run below).

**What is tested, and where.**
- Unit tests (`npm test`, any system): the rows; the agents' commands for both agents; Windows PATHEXT lookup and the
  `.cmd` shim through cmd.exe (with `path.win32`, a fake platform, and refusal of cmd.exe syntax characters); the
  `taskkill`/process-group choice; `connect` against a recording stand-in for the agents (register, already
  registered, replace, remove, a server that does not start, a refused add, dry run); `doctor` with injected probes
  (old Node, missing packages, software graphics, busy ports, a missing optional agent, per-system fixes); `update`
  against real git repositories made in a temporary folder (up to date, fast-forward, diverged, dirty, no upstream,
  `npm ci` only when the lockfile changed); the daily check's switches; the one line is identical in README and
  `docs/ONE-LINE.md`.
- Real runs on Linux (2026-10-10): `connect` against the installed Claude Code 2.1.296 in a scratch folder (project
  scope, then local scope, where `claude mcp list` shows "Connected"), and against codex-cli 0.160.0 with `CODEX_HOME`
  pointed at a scratch folder; each registration was removed afterwards.
- **Not run:** anything on Windows or macOS (no machine). Untested there: the `cmd.exe` call for `codex.cmd`, `taskkill`,
  `winget`/`brew` fix lines, Chrome and Edge lookup (covered by the kit's own tests), a real `claude.exe`.
  Codex's `.cmd` shim is the likeliest first failure on Windows.

**The daily update check** starts a detached `node bin/gamesfun.mjs update --refresh-cache` (stdio ignored, never awaited)
when `.gamesfun/update-check.json` is over a day old, and prints its cached note after a command that talks to a person.
Off with `GAMESFUN_NO_UPDATE_CHECK=1`, in CI, under `node --test`, for `--json` output and for `dev`.
git is started with `GIT_TERMINAL_PROMPT=0` so a private remote fails instead of asking a question.

## CI

`.github/workflows/check.yml` runs `npm ci`, the tests, and create plus `verify --quick --profile
.github/ci-profile.json` for the party, board and scenic examples (not the vista one: a runner has no WebGPU adapter, and
vista has no WebGL path; not the forge one either: verify runs forge on WebGPU only). Pushes to `main`, pull requests and runs by hand run
on Linux only (Windows costs two times the minutes, macOS ten); another system runs only when a run by hand names it.
Its actions are pinned to commit SHAs. `docs/CI.md` has the profile, what a runner can check, the measured
software-rendering runs and the cost. It runs on GitHub since 2026-10-11, green on Linux, Windows and macOS; `docs/CI.md` section 7 lists what the
first runs found and section 8 what still has to be tried by hand on a real Windows machine or a Mac. One system or one
job runs alone by hand: `gh workflow run check.yml --ref <branch> -f system=windows -f job=scenic`.
