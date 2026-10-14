# A game's own backend (optional)

A game needs no backend. It runs in the browser, and friends play peer to peer through the kit's multiplayer. Add a
backend only when the game needs something that outlives a round:
- a leaderboard;
- saved progress;
- accounts;
- a server of its own.

It lives in the person's own account, on their own bill. The game carries only public values.

| Piece | Where |
|---|---|
| Command | `npx gamesfun backend …` (`builder/commands/backend.mjs`) |
| Library | `builder/lib/backend/`: `index.mjs` (use, check, status), `providers.mjs` (the registry), `providers/<id>.mjs` (one per provider), `supabase.mjs` (Management API, the kit's own sign-in), `mcp.mjs` (Supabase's MCP server for the person's agent), `oauth.mjs` (PKCE, loopback), `config.mjs` (`backend.json`), `scan.mjs` (secrets), `rls.mjs` (row-level security) |
| Secret store | `builder/lib/secret-store.mjs` |
| Studio | `builder/studio/tabs/backend.js` (Launch group) and one panel per provider, `builder/studio/tabs/backend/<id>.js`; routes `builder/server/routes/backend.mjs` |
| MCP tools | `builder/mcp/tools/backend.mjs`: `gamesfun_backend_status`, `_add_mcp`, `_use`, `_check` |
| In-game client | `builder/backend/gf-backend/`, copied into a game at `gf/backend/` |
| Agent skill | `skills/gamesfun-backend/` (with a high-score and a saved-progress example) |
| One button | `builder/lib/backend/flow.mjs` (steps, questions, errors), `supabase-connect.mjs`, `railway-connect.mjs`; the page side `builder/studio/tabs/backend/flow-ui.js` |
| Tests | `tests/backend.test.mjs` (against `tests/stubs/supabase-mock.mjs`); `tests/backend-one-button.test.mjs` (the flow and the CLI, against the Supabase, games.fun-route and agent stand-ins); `tests/backend-one-button-chrome.test.mjs` (the whole button in Chrome; `ONE_BUTTON_SHOTS=<dir>` saves every step and error at 1440×900 and 390×844); `tests/backend-tab.test.mjs` (Chrome); `tests/backend-local-e2e.mjs` (by hand, a real local Supabase) |

## What a game holds

- **`backend.json`**: `{ version, provider, url, key?, keyKind?, project?, origins, players }`. Public values only;
  `builder/lib/backend/config.mjs` validates the file on every read and write.
  - It is its own file because `gamesfun.json` is web3's: its writer drops fields it does not know.
  - It is not a slot, because slots are what a player sees or tunes.
- **`gf/backend/`**: the client (`connectBackend()`; `null` with no backend).
- **`supabase/migrations/*.sql`**: the tables and access rules, in the Supabase CLI's own layout. This folder is not
  part of a published game.

`builder/lib/manifest-ignore.json` lists `backend.json` and `supabase/**`, so verify check 1 does not count them as assets.

## Connecting Supabase: one button

The aim: a backend and database connect from one button in the studio, and the kit adds Supabase to the person's
agent itself. The kit does as much as possible for the person.

**"Connect Supabase"** (the studio's Backend tab, Launch group) and **`npx gamesfun backend connect supabase [game]`**
run the same module, `builder/lib/backend/supabase-connect.mjs`, on `builder/lib/backend/flow.mjs` (the steps, their clocks, the one
open question, the end in words). The studio polls `/api/backend/supabase/one-button` and answers its questions; the
terminal answers from flags (`--project`, `--create [--name --org --region]`, `--restore`, `--yes`) or a prompt, and
with no prompt (a script, an agent) prints what to pass.

| Step | What the kit does |
|---|---|
| Find games.fun's app | `GET <studio>/api/kit/supabase` (studio: `GAMESFUN_STUDIO_URL`, else `GAMESFUN_STUDIO`, the publish track's name, else `https://agentgames.fun`; `GAMESFUN_SUPABASE_BROKER` overrides the route). A person's own registered app (`--client-id`) is used instead when saved |
| Sign in | The browser opens Supabase's consent for games.fun's app: PKCE S256, a checked `state`, the loopback `http://127.0.0.1:53841/callback`. The code is traded at `<route>/token`, which adds the client secret; the tokens stay in the secret store (`backend-supabase`, which remembers the route so refreshes go through it). A working saved sign-in skips both steps |
| Read organizations and projects | `GET /v1/organizations`, `GET /v1/projects`, once each per connect (those share one budget for everyone on games.fun's app) |
| Choose the project | One project: it. Several: a picker. None: "Make one" with the organization and the region (default: Supabase's nearest smart group, from `available-regions`). Paused: "Restore it?" (`POST …/restore`). A free plan with 2 active projects: use an existing one, or the dashboard and billing links; the same choice when Supabase refuses the create, with its words |
| Make it | 32 random bytes as the database password, kept as `supabase-db-pending-<game>` before the call and as `supabase-db-<ref>` after; never shown on the page (`gamesfun backend password <ref>` in your own terminal) |
| Wait until ready | `GET /v1/projects/{ref}` every 5 s, then `…/health?services=auth,db,rest`; the page shows a clock; 10 minutes at most ("press Connect again later; nothing is lost") |
| The game's tables | The game's own `supabase/migrations/*.sql`, else the skill's examples its spec's `backend.needs` names (`leaderboard` → high scores, `saves` → saved progress; a high-score table when it names none). The kit's checker first; then `POST …/database/migrations` per file with an `Idempotency-Key` (the file's hash), so a retry never applies one twice. A table already there is kept |
| backend.json | Anonymous sign-ins on (`PATCH …/config/auth`), the publishable key (`api-keys?reveal=false`; one is made when there is none), `backend use` (its scans run), `gf/backend/` refreshed |
| Check | The live row-level-security check (`…/database/query/read-only`) |
| Add Supabase to your agents | Below |

**When 127.0.0.1 is refused.** games.fun registers both `http://127.0.0.1:53841/callback` and
`http://localhost:53841/callback`. Supabase's docs show only `http://localhost:…` redirects; nothing shows 127.0.0.1
(games.fun findings, backend-supabase-oauth.md §2). So the kit asks Supabase's authorize page once without a sign-in:
a 4xx for the 127.0.0.1 redirect makes it use `localhost`. Supabase may instead accept that request and refuse only
after the person signs in, so the page also offers "Try localhost instead" while it waits (the terminal:
`GAMESFUN_BACKEND_CALLBACK_HOST=localhost`). The route refuses any other redirect.

**Errors, in words** (`builder/lib/backend/supabase-connect.mjs`; the code is only for the page's buttons):

| When | The person reads | The page offers |
|---|---|---|
| The route answers 503 (not set up) or 404 (an older games.fun) | "One-button Supabase is not set up on <host> yet. You can connect through your agent instead: it is one button too." | **Connect through your agent** (the agent's way below), Try again |
| Consent refused | "You didn't allow games.fun to reach your Supabase account. Nothing was changed." | Try again |
| Cancel while signing in | "You stopped the sign-in. Nothing was changed." | Try again |
| Sign-in not finished in 5 minutes | "The sign-in wasn't finished. Press Connect again." | Try again |
| Port 53841 busy | "Something on this computer is using port 53841. Close it and press Connect again." | Try again |
| games.fun or Supabase unreachable | "Could not reach <host>. Check your internet connection, then press Connect again." | Try again |
| The route's 401 / 429 / 502 | used or late code; busy; Supabase down: each its sentence | Try again |
| No organization | "Your Supabase account has no organization yet. Create one at supabase.com/dashboard (it is free), then press Connect again." | the dashboard link |
| Restore refused | Supabase's words, and the dashboard (past the 1-year restore window only a download is left) | the dashboard link |
| A table refused | "Supabase refused supabase/migrations/<file>: <Postgres' message>" | Try again |
| Supabase's 429 / 401 / 403 | busy (wait N seconds); sign in again; not an owner or admin | Try again / Sign in again |

### Add Supabase to my agents

A checkbox under the button, ticked by default (and **Add Supabase to my agents** on a connected game; `--no-agents`
in the terminal). For each agent `doctor` detects (`builder/lib/agents.json`: Claude Code and Codex), with the agent's own
command, Supabase's hosted MCP server scoped to the project (`https://mcp.supabase.com/mcp?project_ref=<ref>`; Supabase's
docs: `project_ref` limits it to that project and turns off account tools):

| Agent | Scope | What changes |
|---|---|---|
| Claude Code | project, in the game folder | `claude mcp add --scope project --transport http supabase <url>`, run there, writes `<game>/.mcp.json`. Checked with Claude Code 2.1.296 under a scratch HOME: it writes the folder it runs in, also inside a git checkout. A Claude Code session started in the game folder uses it once you approve it; `/mcp` → supabase → Authenticate signs you in. A session started in another folder (the kit's, or the folder above it) does not read it |
| Codex | user (Codex keeps its servers in its own config) | `codex mcp add supabase --url <url>` → `${CODEX_HOME:-~/.codex}/config.toml`; then `codex mcp login supabase` |

- An agent that already has a server named `supabase` (any scope) is left as it is, and the page says so.
- What was added is recorded in `<game>/.gamesfun/agents-supabase.json`. **Remove from my agents** (and
  `gamesfun backend agents [game] --remove`) undoes exactly that: an entry someone changed since is left, and a
  `.mcp.json` the kit made is deleted when it is empty again. `gamesfun backend agents [game]` lists it.
- The kit never hands its own Supabase token to an agent: each agent signs in itself (Supabase's dynamic client
  registration).
- `.mcp.json` is a hidden file, so publishing leaves it out; `builder/lib/manifest-ignore.json` names it for verify check 1.

### Other ways (under "Other ways to connect")

1. **The person's own agent** (`connect supabase --agent`; `--add-mcp` adds the server to Claude Code and Codex with
   `--scope local` from the kit's folder): the agent signs in through Supabase's MCP server and calls `list_projects`,
   `get_project_url`, `get_publishable_keys`, then `gamesfun backend use`, then `apply_migration`. Nothing goes
   through games.fun. This is the fallback when the route is not set up.
2. **A personal access token** (`--token-stdin`, or pasted in the studio), then the button uses that sign-in.
3. **Paste the URL and publishable key** from the dashboard.
4. **The person's own OAuth app**: `--client-id <uuid> --client-secret-stdin` (the secret in the secret store).

## Connecting Railway: one button

**"Connect Railway"** and `npx gamesfun backend connect railway [game]` run `builder/lib/backend/railway-connect.mjs` on the
same `flow.mjs`: sign in (the kit's own client by dynamic registration: nothing to register, no secret, PKCE S256,
`http://127.0.0.1:53842/callback`), the workspace (one: it; several: a picker; `--workspace <id>`), the deploy (a
project, a service, a volume, the variables (the server's secret stays on Railway), the template
`builder/templates/backends/railway-node/` uploaded, a domain, `/health`), then `backend.json` with the URL only. A game
already on a server the kit made deploys into that project again ("Deploy the server again"). Errors are words (busy:
100 requests an hour on Free; the upload refused: deploy a published image with `--image`; a deploy that ended; a
domain not answering yet).

## What is not tested without real accounts

Everything above ran against stand-ins (`tests/stubs/supabase-mock.mjs`, `tests/stubs/gamesfun-route-mock.mjs`,
`tests/stubs/railway-mock.mjs`, `tests/stubs/fake-agents.mjs`):
- **games.fun's OAuth app is not registered and its route is not deployed.** Until both are, production answers 404
  or 503 and the button falls back to the agent's way.
- Supabase's real consent screen; whether its app form accepts the 127.0.0.1 redirect; whether its authorize page
  refuses an unregistered redirect before or after sign-in (the "Try localhost" button covers the second).
- Real error bodies: the free-plan refusal's wording (the kit matches "limit", "active project", "free", "maximum",
  "exceed"), a refused restore, `INIT_FAILED`.
- `POST …/database/migrations` with `Idempotency-Key` against real Supabase (the stand-in honours it as documented).
- Real token lifetimes and refresh through the deployed route.
- Railway: `/up` with a third-party token, `workspace:member` creating projects, client deletion ending tokens
  (open questions).
- Real Claude Code was run only to confirm where `--scope project` writes (scratch HOME); Codex's real `mcp add` was
  not run. No real agent configuration on the test machine was touched.

## The secret store (`builder/lib/secret-store.mjs`)

| System | Where |
|---|---|
| macOS | The login keychain, through `security -i`. The secret goes in on stdin, never as an argument |
| Linux | The Secret Service through `secret-tool`, when it is installed and a session bus is running |
| Windows | A DPAPI-encrypted file (PowerShell `ConvertFrom-SecureString`, this user only) |
| Anywhere else, or `GAMESFUN_SECRET_STORE=file` | A 0600 file in the user's config folder (`%APPDATA%\gamesfun`, `~/Library/Application Support/gamesfun`, `$XDG_CONFIG_HOME/gamesfun`) |

It is the kit's only secret store: `builder/lib/credentials.mjs` (the games.fun sign-in, `gamesfun login`) keeps its token
here too, under `publish-<16 hex>`; the backend's names are `backend-supabase`, `backend-supabase-app`,
`supabase-db-<ref>`, `railway-token` and `railway-client`, so the two never overwrite each other
(`tests/secret-store-shared.test.mjs`).

The file store is the one run on Linux in the tests. The keychain and DPAPI paths have not been run on macOS or
Windows yet.

## The checks

- **`scan.mjs`** refuses anything key-shaped in a game folder. It is the kit's general scanner (`builder/lib/secret-patterns.mjs`) plus:
  - `sb_secret_` and `sbp_` keys;
  - a JWT whose role is not `anon` (the service-role key, a session);
  - a Postgres URL with a password;
  - `.env` and key files.
  `use` runs it before and after writing, and publishing should refuse what it flags.
- **`rls.mjs`** refuses:
  - a `public` table without row-level security, or one that turns it off;
  - a view without `security_invoker`;
  - a materialized view;
  - a `security definer` function without `search_path`;
  - a table the code reads with `.from()` that no migration creates.
  It warns on a write policy that is `true` for everyone, and on a table with no policy. It reads both the migrations
  and, live, Postgres' own view (`LIVE_SQL`: through the Management API's read-only query, or rows from the agent's
  `execute_sql`).

## The in-game client (`builder/backend/gf-backend/index.js`)

- For Supabase:
  - anonymous sign-in, refreshed and kept per browser;
  - `from(table)` with `select`, `insert`, `upsert`, `update` and `delete` (filters `eq`, `gt`… `order`, `limit`);
  - `rpc` and `invoke` (edge functions).
- For a server provider: `get`, `post`, `put`, `del` and `socketUrl` over its URL.
- It never throws and never writes a console error. A game keeps playing when the database is away.
- **In an automated browser (`navigator.webdriver`: verify, `gamesfun play`, play-testers) it is off by default.** No
  test run writes to a person's real database. `?gf-backend=on` or `globalThis.__GF_BACKEND = 'on'` turns it on, as
  the local end-to-end script does.

## Adding a provider

Add one file, `builder/lib/backend/providers/<id>.mjs`. Its shape is in the header of `builder/lib/backend/providers.mjs`: `id`,
`label`, `kind`, `about`, `ways`, `publicKey`, `settings`, `status`, `disconnect` and `agentSteps`, plus optional
`cli`, `routes` and `panel`. If it has a panel, add `builder/studio/tabs/backend/<id>.js` too.

Nothing else changes: the command, the routes, the tab, `backend.json` and the client are shared. `tests/backend.test.mjs`
checks every provider file's shape.
