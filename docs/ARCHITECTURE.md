# xgames-kit architecture

xgames-kit is a repository that advanced users clone and open in the AI coding agent they
already use (Claude Code, Codex, Cursor, opencode, Cline…). The agent follows `AGENTS.md` to
turn a prompt into a multiplayer three.js browser game on games.fun's `gf-three` kit, then adds
a Solana economy (items, loot boxes, a shop, lotteries, stakes, crafting and a token, as one spec; devnet). Everything runs on Windows, macOS and Linux with
Node 24 and Chrome. No desktop app, no build step, and no bash.

## Two audiences

- **Game builders.** The user and their agent. `README.md` (quick start) and `AGENTS.md`/`CLAUDE.md`
  (the build playbook) are for them, as are `skills/` (mirrored for each agent) and the MCP server.
- **Kit maintainers.** `docs/` (this file, `DEVELOPING.md`, `MCP.md`) and `CONTRIBUTING.md` are for them.

## Layout

| Path | What | Owner during the first build |
| --- | --- | --- |
| `bin/gamesfun.mjs` | CLI entry; dispatches to `builder/commands/*.mjs` (a command that fails to load is reported, never fatal) | core |
| `builder/commands/` | `create`, `dev`, `verify`, `slots`, `catalog`, `examples`, `play`, `promises`, `rig-check`, `meshy`, `login`, `logout`, `publish` (one module per subcommand) | core; `web3.mjs` is web3's |
| `builder/lib/publish/`, `builder/lib/credentials.mjs` | Publishing to games.fun (`docs/PUBLISH.md`): the file tree, the secrets scan (a copy of games.fun's `creator-studio/lib/publish-scan.mjs`; `tests/fixtures/publish-scan-cases.json` is shared), the verify gate, the sign-in client; `builder/lib/credentials.mjs` is the sign-in's public index on top of `builder/lib/secret-store.mjs`, the kit's one secret store | core |
| `builder/lib/` | Shared code: paths and path safety, the kit hooks and tool runner, Chrome discovery, games, slots, examples, local state | core |
| `builder/mcp/server.mjs` | MCP server (stdio) exposing the CLI's operations as agent tools; loads `builder/mcp/tools/*.mjs` | core; `builder/mcp/tools/web3.mjs` is web3's |
| `builder/server/` | The local dev server behind `gamesfun dev`: serves a game, the studio page, live reload, local multiplayer signaling, and API routes from `builder/server/routes/*.mjs`; `builder/server/online.mjs` gives a game's pages the online-play line when the game's multiplayer kit knows it (`docs/ONLINE.md`, `GAMESFUN_ONLINE`) | core; `builder/server/routes/web3.mjs` is web3's |
| `builder/studio/` | The local studio page (plain ES modules, no build): game preview plus tabs loaded from `builder/studio/tabs/*.js` | core; `builder/studio/tabs/economy.js` and `builder/studio/tabs/web3/` are web3's |
| `builder/backend/`, `builder/lib/backend/` | A game's own backend, optional (Supabase first): the in-game client `gf-backend` (copied to a game's `gf/backend/`), providers as files in `builder/lib/backend/providers/`, `backend.json`, the secret scan and the row-level-security checker; `builder/lib/secret-store.mjs` keeps the person's own sign-ins outside every repo (docs/BACKEND.md) | backend |
| `builder/web3/` | Solana layer: transaction builders, Irys uploads, network config, and the in-game kit `gf-web3` | web3 |
| `builder/tools/`, `builder/loop/`, `builder/spec/`, `builder/CONTRACT.md`, `builder/GATES.md` | The tools that create and verify a game (the six gates), the build loop as a library, the spec schemas and prompts, the kit's API | core |
| `builder/ui/`, `builder/gf-multiplayer/`, `builder/gf-audio/`, `builder/gf-assets/`, `builder/multiplayer/`, `builder/watch/`, `builder/world-server/`, `builder/qa/`, `builder/asset-manifest/`, `builder/audio-gates/`, `builder/studio-lib/` | The shared parts every game or check uses: the menu and HUD, the kits every game vendors (one copy each), signaling and the two-player gate, the watch relay, the world server, the Chrome launcher, the asset validator, the loudness gates | core |
| `runtimes/three/` (`kit/`, `profiles/flat-2d`, `profiles/scenic-3d`, `library/`, `vendor/`), `runtimes/forge/`, `runtimes/vista/`, `runtimes/godot/` | What runs a game | core, per runtime |
| `components/<id>/`, `loops/<id>/`, `worlds/` | The mechanics, the session loops and the world generators (inside a game's `gf/three/`; [LAYOUT.md](LAYOUT.md)) | core |
| `builder/templates/game/` | What `create` writes into a new game besides gf-three's output: its `AGENTS.md`, `CLAUDE.md`, `.gitignore` | core |
| `examples/minimal/<id>/` | Complete example games `create --from` starts from (`spec.json`, `rules.js`, `README.md`, `example.json`) | core |
| `skills/` | Agent skills (source of truth), mirrored to `.claude/skills/` and `.agents/skills/` by `scripts/sync-skills.mjs` | core; `skills/gamesfun-web3*/` are web3's |
| `games/` | The user's games (git-ignored) | users |
| `.gamesfun/` | Local state (git-ignored): running dev servers, the Meshy ledger | — |
| `tests/` | `node --test` suites | each owner |

## How the tools run

The tools in `builder/tools/` read the kit's layers where they are ([LAYOUT.md](LAYOUT.md)): a game's `gf/three/` is
assembled from `runtimes/three/kit/`, `components/`, `loops/`, `worlds/`, `builder/ui/` and the flat profile by one
table (`GAME_TREE` in `builder/tools/lib/paths.mjs`), and a kit module imported in Node resolves its imports through the
game's tree (`builder/tools/lib/kit-import.mjs`). Each tool runs as a child process: `node builder/tools/<tool>.mjs …`
(`builder/lib/run-tool.mjs`), with the environment the tools read their settings from (`GF_MANIFEST_IGNORE` names this
kit's own ignore list). The tools find their packages (Playwright, the 3D tools' packages) through their own search
order. Commands then add what the tools don't have: finding Chrome on each OS, examples, the game's agent guide,
game-folder resolution.

## Seams

The parts of the kit work against these contracts. Keep them stable, and change one only after
agreeing the change with the maintainers. Fields marked *extra* were added by the core build; they are
additive, and code that ignores them keeps working.

**Commands:** `builder/commands/<name>.mjs` exports
`default { name, summary, usage, run(args: string[]): Promise<number | void> }`. The return value is the exit code.
`builder/lib/cli.mjs` has optional helpers (`parse`, `guard`, `printJson`, `UsageError`).

**MCP tools:** `builder/mcp/tools/<area>.mjs` exports `tools`, an array of
`{ name, description, inputSchema /* JSON Schema */, annotations, outputSchema?, handler(input, ctx) → result }`.
`annotations` holds the four MCP hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), honest
for that tool; `outputSchema` is for an answer with a stable shape (it then also goes out as `structuredContent`).
Arguments are checked against `inputSchema` with Ajv before the handler runs. Shared schemas: `builder/mcp/schemas.mjs`. Every tool that
spends money, signs or changes chain state must return a step for the human ("open this link and
approve in your wallet"). It never signs. Names match `^[a-zA-Z0-9_-]{1,64}$` and are unique across files (a
duplicate or a file that fails to load is reported on stderr and skipped). A result may be a string, any JSON value
(sent as text), or an MCP result `{ content: [...] }`; a throw becomes `isError` with the message. *Extra* in `ctx`:
`{ kitRoot, log(...), progress(message), runCli(args, { onLine }) → { code, stdout, stderr }, signal }`.

**Dev-server routes:** `builder/server/routes/<area>.mjs` exports
`default function register(router, ctx)`. `router` has `get(path, handler)` and
`post(path, handler)` under `/api/<area>/…`. `ctx` holds `{ gameDir, kitRoot, network, log }`.
Handlers receive `(req, res, params)`. The server binds 127.0.0.1 only and checks Host/Origin.
Details as built: `<area>` is the file name (lower-case letters, digits, dashes); a path may hold `:name` segments,
which arrive in `params`; `req.query` is the URL's `searchParams`; a handler may be async, and a value it returns
without writing a response is sent as JSON (a thrown `HttpError(status, message)` from `builder/server/http.mjs` sends that
status). `builder/server/http.mjs` also has `sendJson`, `readBody`, `readJson` (size-limited). A route file that throws on load
is reported and skipped. *Extra* in `ctx`: `url` (the server's base URL) and `events.send(event, data)` (a
Server-Sent Event to open studio pages; `ctx.on(event)` in tabs receives it).

**Studio tabs (tools):** `builder/studio/tabs/<id>.js` exports `default { id, label, order, group?, action?, mount(el, ctx) }`. Here
`ctx` holds `{ game, api(path, body?), wallet, toast(msg) }`, and `wallet` is the Wallet Standard
connection the studio page owns. As built: `game` is `/api/game/info` (title, hook, mechanics, controls, `network`,
`gamesfun` = the game's `gamesfun.json`); `api('web3/items')` or `api('/api/web3/items')` GETs, `api(path, body)` POSTs
JSON (or raw bytes for a Blob or ArrayBuffer) and resolves to the parsed JSON or rejects with the server's error;
`wallet` (`builder/studio/wallet.js`) is `{ list(), connect(name?), disconnect(), account, address, wallet, feature(name),
onChange(fn) }` over the standard's `wallet-standard:app-ready` / `register-wallet` events; `toast(msg, kind?)` with
kind `'ok'` or `'error'`. `mount` may return a cleanup function. Tabs are listed by `GET /api/studio/tabs` and mounted
when first opened. The page is the conversation on the left (`builder/studio/chat.js`: the person's requests, their session's
steps, the build loop's concepts, stages and verdicts, permission questions, one box to ask) and the product on the right:
the game preview with the tabs as tools in a bar over it, the open one in an inspector beside it. The tools are grouped
(Edit, Test, Launch), each group in `order`; an optional `group` (a word) puts a tab under that heading, and a tab
without one goes under More. With no game open (`gamesfun dev` with no folder) the page is the start page
(`builder/studio/start.js`): describe a game (the idea goes to the session and starts the build loop on a fresh `games/<name>`),
open one of yours, or start from an example. The dev server's open game can change while it runs: routes read
`ctx.gameDir` at each request (null when none is open) and may listen with `ctx.onGame(fn)`. The look is one
design system in `builder/studio/studio.css` (its header lists the tokens and the classes a tab uses). *Extra* in `ctx`: `preview` (`reload()`, `show(path)`) and `on(event, fn)` for
dev-server events (`game` when the game's files change, `verify`, and any `ctx.events.send` from a route).

**Adding a tool to the studio (a module of its own, e.g. Publish or a backend):** one file, `builder/studio/tabs/<id>.js`; the
shell is not edited.

```js
export default {
  id: 'publish',                 // the tab's id: #publish links open it, tests click #tabs [data-id="publish"]
  label: 'Publish',              // its name in the tool bar and the inspector's title
  group: 'Launch',               // Edit | Test | Launch (a new word makes a new group, shown after these; none: More)
  order: 90,                     // its place inside the group
  action: { label: 'Publish' },  // optional: also a primary button beside the preview's bar, for the flow's last step
  icon: '<path d="M12 3v12M7 8l5-5 5 5M5 21h14"/>',   // optional: its icon, SVG shapes on a 24 x 24 grid, stroked
  wide: { game: 'thumbnail' },   // optional: the whole product side while it is open; the game a thumbnail in the
                                 // corner ('thumbnail', or true) or out of sight ('hidden'), back when it closes
  mount(el, ctx) { /* draw into el; ctx as below; return a cleanup function if it needs one */ },
};
```

The tool opens in the inspector beside the game (on a phone, under it): 403 px wide on a 1440 px screen, 480 px (720
device pixels, at the studio's 1.5 zoom) on a 3840 px one; `clamp(340px, 28vw, 480px)`, the `--inspector-w` token. A
`wide` tool gets the whole product side instead (1008 px at 1440, 2100 px or 3150 device pixels at 3840; the thumbnail
288 by 162; on a phone nothing changes, everything stacks), and a click on the game's thumbnail closes it. It is listed only once a game exists: the
start page and a game still being pitched show no tools. It draws with the classes in `builder/studio/studio.css` (its header
lists them), and asks the person's session only through the conversation's one box, never a box of its own:

```js
ctx.chat.ask({
  label: 'This rule',                                   // the chip over the box: what the request is about
  placeholder: 'e.g. make the prize pot bigger',        // the box's placeholder while the chip is there
  compose: words => `In the economy's rule "weekly": ${words}. …`,  // what the session is told (the person's words are
                                                        // shown in the thread; this line goes after them, for the session)
  selection: () => ({ id: 'economy.lotteries.weekly', label: 'Weekly draw' }),  // optional: what is picked, sent along
  button: 'Ask my session',                             // optional: the send button's words while the chip is there
  onSent: request => {},                                // optional: after the bridge took it
});
```

`ctx.chat.ask` focuses the box with that context; the person types and sends; × on the chip asks about the whole game
again. `ctx.chat.send(text)` sends words as they are (the start page's idea, a concept picked). The editors' "Ask my
session" buttons call `askBox(ctx, { label, placeholder, compose, selection, button, onSent })` in
`builder/studio/lib/editors/ui.js`, which is `ctx.chat.ask` behind a button. A page with no conversation (a test page) has no
`ctx.chat`; `askBox` then draws a box of its own. A route of its own is `builder/server/routes/<area>.mjs` (below); it reads `ctx.gameDir` at
each request, because the open game can change while the server runs.

**Game config:** each game keeps its public web3 settings in `<game>/gamesfun.json`, written by the
web3 layer and read by the in-game kit. It holds public addresses only, never secrets. The dev server reads its
`network` (default `devnet`; `GAMESFUN_NETWORK` overrides) for `ctx.network`, and `/api/game/info` returns the file.

## The dev server's URLs

| Path | Serves |
| --- | --- |
| `/` | redirect to `/studio/` |
| `/studio/…` | `builder/studio/` (index, shell, `tabs/*.js`) |
| `/game/…` | the game folder; HTML pages get the live-reload script; `/game/gf/mp/` is the friends lobby; `/game/gamesfun.json` answers 204 (no web3 settings) when the game has none, so the host bridge's reads print no 404 |
| `/signal` (WebSocket), `/signal/v1`, `/signal/v1/ice` | gf-multiplayer signaling, from the kits' own signal server |
| `/api/<area>/…` | routes; core areas: `game` (info, slots, verify), `studio` (tabs), `dev` (status) |
| `/__gamesfun/events`, `/__gamesfun/reload.js` | live reload (Server-Sent Events) |

Every response is `no-store`, `nosniff` and frameable only by the server's own pages. Paths are resolved by
`resolveInside` (`builder/lib/paths.mjs`): no traversal, no dotfiles (`.env` is never served), no Windows device names,
drive letters or alternate data streams.

## Rules

- Cross-platform: Node APIs only (`node:path`, `node:fs`), no shell scripts, no symlinks in
  committed paths, no case-only renames. Paths are built with `path.join`/`URL`. Child processes are
  `process.execPath` with arguments, never a shell; npm is run through its own `npm-cli.js`.
- Chrome is the reference browser. `gamesfun verify` and `gamesfun play` drive it through Playwright (Chrome or Edge
  installed on the machine, else Playwright's Chromium, installed on demand). `gamesfun dev` opens the studio in the
  person's own Chrome (their profile, so their wallet extension is there), else their default browser.
- The kit's layers are edited here; a kit a game vendors changes with its hashes (`kit.json`, `SHA256SUMS`) in the
  same commit. `.gitattributes` keeps them byte-exact on every OS.
- Licences: only permissive dependencies. Keep each vendored LICENSE beside its copy and list
  it in `THIRD_PARTY.md`.
- Devnet only until the owner approves mainnet.
- The kit never holds a user's private key. Wallets sign in the user's own browser.
