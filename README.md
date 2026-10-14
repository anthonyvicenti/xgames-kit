# xgames-kit

An open-source game builder for the AI coding agent you already use (Claude Code, Codex, Cursor, opencode, Cline…).
You describe a multiplayer 3D browser game; your agent pitches it, locks a spec, builds it on games.fun's three.js kit
(**gf-three**), and the kit's own checks and a black-box play-tester decide when it is done. Friends join from their
own browser and see each other in the game. Every model, texture and number is a slot you can swap without code.

Windows, macOS and Linux, with Node 24 and Chrome (or Edge). No desktop app and no build step. MIT licensed.

The repository is `xgames-kit`; the command it installs is `gamesfun` (`npx gamesfun …` or `node bin/gamesfun.mjs …`),
and its MCP tools are named `gamesfun_*`.

**Status, plainly:** used day to day on Linux by its makers; on Windows and macOS only automated tests have run it so
far ([docs/TRY-IT.md](docs/TRY-IT.md) asks for your first report). The web3 parts run on Solana devnet only. A game
passing the kit's checks is the kit's bar, not a player's verdict.

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

## How the AI loop works

```
 your words ──▶ pitch ──▶ spec ──▶ create ──▶ rules ──▶ gates ──▶ black-box ──▶ deliver
                2–3 takes  locked    the kit    your      the full   play-test      the honest
                you pick   & checked builds it  agent     verify in  by a separate  outcome, with
                                                writes    real Chrome subagent      what failed
                                                rules.js
                                ▲                              │ fail
                                └──────── repair round ◀───────┘
```

1. **Pitch.** The agent reads the kit's catalog and offers 2–3 takes that differ in how they play; you pick one.
2. **Spec.** Your choice becomes a game spec that must validate against the schema and the kit; then it is locked.
3. **Create.** A script makes the game from the spec: the kit vendored, the world, the mechanics, bodies and look.
4. **Rules.** The agent writes only what makes this game this game (`rules.js`) and tunes its config.
5. **Gates.** `verify` plays the game in real Chrome with real keys and mouse, alone with bots and as two players over
   WebRTC, and answers six questions, the gates: is the kit intact and everything a slot, does it boot clean, does
   every input and event show on the player's screen, does the round close with scores from real events, do friends
   see each other, and is it what the spec says. A fail hands the agent a repair round. A bug report never adds a
   rule: it becomes a broken example a gate must fail ([GATES.md](builder/GATES.md)).
6. **Black-box play-test.** A separate subagent plays the game from the screen only and reports which promises it saw
   work. It never sees the code.
7. **Deliver.** The version that passed is handed over with its honest outcome, and what still fails is named.

The order is held by the loop's tools (`gamesfun_next` and the `gamesfun_step_*` tools, also from a terminal as
`node bin/gamesfun.mjs tool <name>`), not by a prompt. The playbook for agents is [AGENTS.md](AGENTS.md).

## Runtimes, loops and kinds

A spec (v2, `builder/spec/game-spec.v2.schema.json`) places a game by three answers: **runtime** and its **profile**
(what runs it, chosen by hard limits: devices, graphics, camera), **loop** (how it is played: who acts when) and **kind**
(how it feels; it never changes play). `npx gamesfun catalog` lists them from the registry (`registry/catalog.json`),
with each one's state and its device limits said plainly; `npx gamesfun catalog matrix` shows which kinds are proven
on which runtime.

| Runtime / profile | For | Draws with |
|---|---|---|
| `three` / `standard-3d` | 3D on lots, buildings, arenas and the block world | WebGL (three.js) |
| `three` / `flat-2d` | 2D games seen from above or from the side | WebGL (three.js) |
| `three` / `scenic-3d` | stylised scenic 3D: living grass, fog, a day cycle | WebGPU, or WebGL2 inside the same renderer |
| `vista` | calm games where the place is the point: a coast, the sea, the sky | **WebGPU only**, on a desktop graphics card |
| `forge`, no example yet | first-person action with weight for friends in co-op | a prebuilt Rust core on WebGPU, or its WebGL2 build where a browser has no WebGPU |

**vista** plays on a desktop only. It has no WebGL path: a browser without WebGPU, or a card with fewer than 31 sampled
or 5 storage textures per shader stage, gets the kit's "open in a browser with WebGPU" screen; never a phone, never
inside a post on X. Each vista game carries the core (about 53 MB; about 62 MB a game). Its clouds are the core's own
(MIT): this kit leaves out the volumetric sky-pro-webgpu clouds, whose notice names a separate licence. The example is
`lantern-cove`.

**forge has no example yet: its free stand-in art is still to be made.** The runtime is in `runtimes/forge` (its core is
our own Rust, MIT, on wgpu, shipped as two prebuilt, hash-pinned `.wasm` builds, one for WebGPU and one for WebGL2, so
no Rust toolchain is needed). The kit ships no Meshy output, so a forge game made here draws CC0 stand-ins in place of
models made with Meshy; those stand-ins are not made yet, and a forge example comes with them. Art and sound licences:
[THIRD_PARTY.md](THIRD_PARTY.md).

## Enforced by code, and advice

| Enforced by code | Advice the agent is given |
|---|---|
| the order of the steps; a step out of order is refused | keep the first version small (one map, one loop, 2–4 mechanics) |
| the locked spec (an edit is put back and refused) | pitch takes that differ in how they play |
| the loop's state, sealed with an HMAC (key in your config folder) | choose the smallest edit that does what you asked |
| proof is about the files as they are (change a file, and that step runs again) | say plainly what was left out and why |
| the play-test report: only the play-tester's, with the round's one-time token | the content policy (steer, don't refuse) |
| the kit's checks, and the kit's copies in a game unedited | |
| in Claude Code with the kit's plugin: no writes to the loop's folder; the play-tester reads only its own folder | |
| devnet only; no private key in the kit; wallets sign in your browser | |

What code cannot hold is said where it applies: [plugin/scripts/guard.mjs](plugin/scripts/guard.mjs) and
[builder/lib/loop-seal.mjs](builder/lib/loop-seal.mjs) each list what they cannot stop.

## Commands

`npx gamesfun help` lists them all; `npx gamesfun <command> --help` gives each one's options. The ones you will meet:

| Command | |
|---|---|
| `dev [dir]` | the studio: the game, its slots, verify, a friends lobby, live reload (127.0.0.1 only) |
| `examples`, `catalog [--all]` | example games (`soak-squad`, `giant-four`, `isle-run`, `coin-hop`, `lantern-cove`; a forge example is coming); what the kit can build (`catalog runtimes`, `kinds`, `matrix`, `loops`, `mechanics`) |
| `create <dir> --from <example>` / `--spec <file>` | make a game outside the loop |
| `verify [dir] --quick` | the checks, in real Chrome with real input (about 2 minutes) |
| `slots list\|set …` | list and swap slots (`slots set prop.bucket --file my.glb`) |
| `play [dir] --steps '…' --out <dir>` | play it like a new player, with screenshots |
| `tool <name> '<json>'` | any of the kit's MCP tools, from a terminal |
| `doctor`, `connect`, `update` | is this machine ready; add the tools to your agent; fetch the newest kit |
| `login`, `publish [dir]` | put a game on games.fun at an unlisted link ([docs/PUBLISH.md](docs/PUBLISH.md)) |

## Where things are

The repository is in layers ([docs/LAYOUT.md](docs/LAYOUT.md) has the whole map): `builder/` the shared system (the
CLI, the MCP server, the studio page, create and verify, the build loop, the kits every game vendors) · `runtimes/`
what runs a game (three with its profiles, forge, vista) · `components/` the mechanics · `loops/` · `worlds/` ·
`examples/` example games · `games/` your games (git-ignored) · `AGENTS.md` the playbook · `skills/` the agent skills ·
`plugin/` the Claude Code plugin (hooks, the play-tester agent) · `docs/` the docs ([docs/README.md](docs/README.md)
is the index).

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

MIT: see [LICENSE](LICENSE). It covers everything of ours here. The kits (gf-three, gf-scenic, gf-forge, gf-vista,
gf-multiplayer, gf-audio, gf-assets) carry three.js, Rapier, pmndrs postprocessing, N8AO, ecctrl, ws and ZzFX,
and a library of CC0 and CC BY models by Kenney, Quaternius, Poly by Google and others. Those keep their own licences:
[THIRD_PARTY.md](THIRD_PARTY.md) lists each, [CREDITS.md](CREDITS.md) thanks the people, and
[docs/LICENSING.md](docs/LICENSING.md) says in plain words what a game you make has to carry.
