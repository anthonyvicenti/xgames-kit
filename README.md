# xgames-kit

An open-source game builder for the AI coding agent you already use (Claude Code, Codex, Cursor, opencode, Cline…).
You describe a multiplayer browser game. Your agent writes down what you asked for in your own words, pitches two or
three takes, locks a spec and builds the game; six gates and a black-box play-tester decide when it is done. Friends
join from their own browser and see each other in the game. Every model, texture and number is a slot you can swap
without code.

Windows, macOS and Linux, with Node 24 and Chrome (or Edge). No desktop app and no build step. MIT licensed. The
command it installs is `gamesfun` (`npx gamesfun …` or `node bin/gamesfun.mjs …`); its MCP tools are `gamesfun_*`.

**Status, plainly:** used day to day on Linux by its makers; on Windows and macOS only automated tests have run it so
far ([docs/TRY-IT.md](docs/TRY-IT.md) asks for your first report). The web3 parts run on Solana devnet only. A game
passing the gates is the kit's bar, not a player's verdict.

## Quick start (about a minute)

Open your coding agent (Claude Code or Codex) in a terminal, in the folder where you keep projects, and paste this:

```text
I want you to set up the XGames.fun game kit in this folder so I can make games in its studio. Here is what that involves, and I agree to it: git clone https://github.com/anthonyvicenti/xgames-kit.git (skip the clone if an xgames-kit folder is already here), then in that folder, with Node 24, run these one at a time: npm ci, then node bin/gamesfun.mjs doctor, then node bin/gamesfun.mjs connect, then start node bin/gamesfun.mjs dev in the background (it opens the studio's start page in my browser, where I describe my first game), then start node bin/gamesfun.mjs session wait in the background too. session wait is how the studio page reaches you in this session: it ends when I send something from the page and prints my request and how to build it, so when it ends, build what I asked with the kit's commands, report it with the command it names, and start session wait again. You don't need the kit's tools loaded in this session and nothing needs a reload: every tool has a node bin/gamesfun.mjs command. connect adds the kit's tools and a plugin to you at user scope for my next sessions; the plugin lets the studio page on 127.0.0.1 show my sessions, send them my requests and answer their permission prompts. I can undo it with node bin/gamesfun.mjs connect --remove. Tell me what each step printed in one line. If a step fails, do what its "If it fails" section in xgames-kit/docs/ONE-LINE.md says, and if that doesn't fix it, stop and tell me exactly what failed. Never ask me for a password, token or key. End with the studio address, and tell me to type my first game idea there.
```

Your agent clones this repository, installs it, checks your machine (`doctor`), adds the kit's tools to itself through
its own commands (`connect`; `connect --remove` undoes it), and opens the studio in your browser. Type your first idea
there. What each step does and what to do when one fails: [docs/ONE-LINE.md](docs/ONE-LINE.md). Your agent talks to
its model the way it always does, under your own login; nothing here signs you in or sends anything to a model.

By hand instead: `npm ci`, then `npx gamesfun dev` (or `node bin/gamesfun.mjs dev`) opens the studio; open this folder
in your agent and say what you want ("make a game where we defend a lighthouse from crabs"). Claude Code reads
`CLAUDE.md` (which imports `AGENTS.md`) and offers the MCP server from `.mcp.json`; Codex, Cursor, opencode and Cline
read `AGENTS.md` ([docs/MCP.md](docs/MCP.md) sets up the server for each). Stay current with
`node bin/gamesfun.mjs update` (fast-forward only).

## Three questions place every game

| Question | Answer | Chosen by |
|---|---|---|
| What runs it? | the **runtime** (and its profile) | hard limits only: the devices, the graphics, the camera, what must be built |
| How is it played? | the **loop** (`round`, `run`, `world`, `turns`, `match`, `endless`, `saved`) and its mechanics | who acts when, and what moves |
| How does it feel? | the **kind** | last, from your words and references |

A spec (v2, `builder/spec/game-spec.v2.schema.json`) says each. The registry (`registry/`, built from the parts'
own manifests) answers what exists, what is tested and what is open: `npx gamesfun catalog`, and
`npx gamesfun catalog matrix` for which kinds are proven on which runtime. The catalog assists; it never refuses or
narrows an idea. What the kit lacks, the game builds (in `rules.js`, a module under `src/`, or a declared override of
a runtime file), and the play-tester checks it like every other promise. A part moves into the kit only after a
second game needs it.

## Runtimes

| Runtime / profile | For | Runs on | Examples |
|---|---|---|---|
| `three` / `standard-3d` | 3D: arenas, yards, a board on a square, a block world | any browser with WebGL2: desktops, laptops, phones, inside a post on X | `soak-squad`, `giant-four`, `block-valley` |
| `three` / `scenic-3d` | stylised scenic 3D: living grass, fog, a day cycle | WebGPU, else WebGL2 in the same renderer | `isle-run` |
| `three` / `flat-2d` | 2D seen from above or from the side | as standard-3d | `coin-hop`, `market-day` |
| `forge` | first person with weight, co-op for 1 to 4 | phones and desktops: WebGPU where the browser has it, else its WebGL2 build; first person only | `ruin-hold` |
| `vista` | calm places: a coast, the sea, the sky | **a desktop browser with WebGPU only**: not phones or tablets, not inside a post on X; the first visit compiles shaders (about 10 s); about 62 MB a game | `lantern-cove`, `isle-hop` |
| `godot` / `2d`, `3d` | Godot 4 web exports: 2D side-on and top-down, 3D with a follow camera | WebGL2, one thread; a 37.7 MB engine file (about 9 MB compressed) on first load; not Safari | `godot-ledge-friends`, `godot-meadow-walk`, `godot-arena-friends`, `godot-coin-hop` |

Phones are measured in a phone-sized browser, not yet on a real phone. forge's core is our own Rust on wgpu, shipped
as two prebuilt, hash-pinned `.wasm` builds, so no Rust toolchain is needed; its example draws free CC0 stand-ins.
Godot installs its toolchain only when a game chooses it. Each runtime's limits are in its `runtimes/<id>/runtime.json`.

## Kinds: starting looks, not rules

A kind is one JSON preset (`kinds/<id>.json`): the look, the world family, the camera, the bodies, the sound
character, the HUD and the art packs ranked first. `create` applies it as a starting point. Your spec's own answers
always win, a kind never changes how the game plays, and a kind not yet proven on a runtime is allowed (the game
builds its look there, and the gates say so).

| Kind | The feel | Proven on |
|---|---|---|
| `silly` | toon low-poly in pastels, soft bodies that flop | three standard-3d |
| `blocky` | blocks under a real sun, block people in saturated colours | three standard-3d (the block world) |
| `lofi` | cheap and dark on purpose: hard pixels, dither, grime | a look on three and forge |
| `scenic` | painterly stylised 3D where the light does the work | three scenic-3d |
| `dark` | grim fantasy at night: ruins, embers, firelight | forge |
| `calm` | photoreal light, sea and sky | vista |
| `pixel` | 2D pixel art, 16 texels a metre | three flat-2d, godot 2d |
| `drawn` | 2D hand-drawn cartoon, 128 texels a metre | three flat-2d |

## The asset library

One library of packs serves every runtime, 2D and 3D alike (`library/`). A pack has one licence, one pinned source
and one owner; every asset has one manifest and one preview. Style is measured at ingest and judged on each kind's
contact sheet, never declared by a folder. A slot asks by need and the resolver answers by fit: the kind's packs
first, then the slot's words, then the devices' budgets, then the licence policy (own, CC0 and MIT first; CC-BY with
its credit line written into the game). Search before you generate: `gamesfun art find "wooden bridge" --kind scenic
--3d`; add your own art with `gamesfun art ingest`. [library/README.md](library/README.md) has the rest.

## How a game is made

```
idea → ledger → foundation → pitch (you choose) → spec (locked) → create → build round → six gates
     → play-test of the promises → second reader → deliver
                     a fail: a repair round, under the stop rule and its ladder
```

1. **Ledger.** Before any card, what you asked for, in your own words, each line with a home: the kit has it, the
   game builds it, or a short probe decides.
2. **Foundation.** The runtime by hard limits, the loop by who acts when, the kind last.
3. **Pitch and spec.** Two or three cards that differ in how they play; every card keeps every line. You choose, and
   the spec is locked. Every "the game builds it" line becomes a promise.
4. **Create and build.** The game is made from the spec; your agent writes `rules.js`, its `src/` modules and any
   declared overrides from a one-page brief of only the parts the spec chose.
5. **Six gates.** A integrity (the kit untouched, everything visible a slot), B health (boots clean, at a fair frame
   cost), C cause and effect (every input and event shows on the screen it concerns), D the loop closes (it ends,
   replays, every score from a counted event), E shared truth (friends see each other where they really are), F
   matches the spec. Each runtime supplies its own measures and names what it skips. A bug report never adds a rule:
   it becomes a broken example a gate must fail ([builder/GATES.md](builder/GATES.md)).
6. **Play-test.** A separate subagent plays from the screen only and reports each promise seen, not seen or
   unreachable. A second reader compares the result with your words.
7. **Repair, then deliver.** A failure hands back a repair round. When rounds stop making progress the loop climbs a
   ladder (a stronger model, a specialist round, paid generation, questions for you); cost never ends a build. The
   delivery names every line proven, failed or untested.

The loop's tools hold the order (`gamesfun_next` and the `gamesfun_step_*` tools; in a terminal,
`node bin/gamesfun.mjs tool <name>`), not a prompt. The guide for agents is [AGENTS.md](AGENTS.md).

## Commands

`npx gamesfun help` lists them all; `npx gamesfun <command> --help` gives each one's options.

| Command | |
|---|---|
| `dev [dir]` | the studio: the game, its slots, verify, a friends lobby, live reload (127.0.0.1 only) |
| `examples`, `catalog [--all]` | the example games; what the kit has (`catalog runtimes`, `kinds`, `matrix`, `loops`, `mechanics`) |
| `create <dir> --from <example>` / `--spec <file>` | make a game outside the loop |
| `verify [dir] --quick` | the six gates, in real Chrome with real input |
| `slots list\|set …` | list and swap slots (`slots set prop.bucket --file my.glb`) |
| `art find\|fill\|ingest\|fetch\|check\|generate` | the asset library |
| `play [dir] --steps '…' --out <dir>` | play it like a new player, with screenshots |
| `tool <name> '<json>'` | any of the kit's MCP tools, from a terminal |
| `doctor`, `connect`, `update` | is this machine ready; add the tools to your agent; fetch the newest kit |
| `login`, `publish [dir]` | put a game online at an unlisted link ([docs/PUBLISH.md](docs/PUBLISH.md)) |

## Where things are

[docs/LAYOUT.md](docs/LAYOUT.md) is the whole map: `builder/` the shared system (spec, create, slots, multiplayer,
sound, menu and HUD, the gates, the loop, the CLI, the MCP server, the studio page) · `runtimes/` what runs a game ·
`loops/` · `components/` the mechanics · `worlds/` · `kinds/` · `registry/` · `library/` the asset library ·
`examples/` · `evals/` · `games/` your games (git-ignored) · `skills/` and `plugin/` for your agent · `docs/`
([docs/README.md](docs/README.md) is the index).

## Hosted services

Two defaults point at services games.fun runs. Both are optional, and nothing else in the kit talks to a server.

- **Studio** (`login`, `publish`): https://agentgames.fun. Set `GAMESFUN_STUDIO=<https origin>` to use another one
  (http is allowed for a Studio on this machine). Nothing is sent there unless you run `login` or `publish`.
- **Online play** (signaling only: it introduces two browsers, it never sees the game):
  `https://games-fun-play.vercel.app/signal/v1`, the multiplayer kit's default. It is free for now, with rate limits
  and a daily cap. `GAMESFUN_ONLINE=off` keeps rooms on this machine (friends join in two tabs);
  `GAMESFUN_ONLINE=https://your-host/signal/v1` uses a signaling server of your own. [docs/ONLINE.md](docs/ONLINE.md)
  says how to run one (`node builder/multiplayer/p2p/serve-signal.mjs`).

## Links

[AGENTS.md](AGENTS.md) (for agents) · [docs/README.md](docs/README.md) (every doc) · [CONTRIBUTING.md](CONTRIBUTING.md) ·
[CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) ·
[CREDITS.md](CREDITS.md) · [THIRD_PARTY.md](THIRD_PARTY.md)

## Licence and credits

MIT: see [LICENSE](LICENSE). It covers everything of ours here. The runtimes and the kits every game vendors carry
three.js, Rapier, pmndrs postprocessing, N8AO, ecctrl, ws, ZzFX and the vista core, and the asset library holds
CC0 and CC BY models by Kenney, Quaternius, KayKit, Poly by Google and others. Those keep their own licences:
[THIRD_PARTY.md](THIRD_PARTY.md) lists each, [CREDITS.md](CREDITS.md) thanks the people, and
[docs/LICENSING.md](docs/LICENSING.md) says in plain words what a game you make has to carry.
