---
name: gamesfun-backend
description: Give a game its own backend, only when the person asks for one (high scores, saved progress, accounts, a server). Connect Supabase through Supabase's MCP server (the person signs in in their browser), write only the project URL and publishable key into the game, and add tables, row-level-security policies and edge functions safely, with `gamesfun backend check` passing before every migration. Use when someone wants a leaderboard, saves, player accounts or server logic; never add a backend unasked.
---

# A game's own backend (optional)

Most games need no backend: they run in the browser and friends play peer to peer. Add one only when the person
asks for something that must outlive a round: a leaderboard, saved progress, accounts, server logic. It is their
account and their bill. Keep live play on the kit's multiplayer (gf/mp, WebRTC). Never move pose or input sync to
Supabase Realtime: its free plan allows 100 messages a second per project, and the kit's own net is built for play.
A database holds scores, saves, accounts and lobbies.

## In the creation loop

A backend is offered at the pitch, never forced: `offers.backend` (`kind`, `needs`, `provider`) with one question
(`"about": "backend"`) that has a "No backend, play in the browser" option, unless the person's own words need one (a
global leaderboard, accounts, progress on any device: then `from`, and no question). A kept one is
`"backend": {kind, needs}` in the spec. The build round writes the tables (`supabase/migrations/`, row-level security
on every one) and the game's use of them, and the game plays in the browser until the person connects;
`gamesfun_step_backend` checks it after every round (no secret in the game, row-level security), and a refusal comes
back as a repair round. At delivery the loop says whether a backend is connected and, if not, how the person connects
their own; it never waits for it.

## What may reach the game, and what never may

| In the game's files (public by design) | Never in the game, a log, a commit or your reply |
|---|---|
| The project URL `https://<ref>.supabase.co` | The secret key `sb_secret_…` and the legacy `service_role` key (they bypass row-level security) |
| The publishable key `sb_publishable_…` (or the legacy anon key) | The database password and any `postgres://` connection string |
| `backend.json`, `gf/backend/`, `supabase/migrations/*.sql` | Supabase access tokens (`sbp_…`), OAuth tokens, `.env` files |

The kit enforces this: `gamesfun backend use` refuses a key that is not public, and `gamesfun backend check` refuses
a game whose files hold anything key-shaped. Publishing refuses it too. If Supabase's tools show you a secret key, do
not repeat it, store it or pass it to any command.

## 1. Connect (the person signs in; you never handle a token)

**The one button first.** The studio's Backend tab has "Connect Supabase", and `npx gamesfun backend connect supabase
games/<name>` runs the same steps in a terminal the person can see: their browser signs in to Supabase (through
games.fun's app), the kit picks or makes the project, applies `supabase/migrations/` (or the high-score and saved-progress
examples the spec's `backend.needs` names), writes `backend.json`, checks row-level security and adds Supabase's MCP
server, scoped to the project, to their agents. With several projects and no prompt it prints what to pass
(`--project <ref>` or `--create`): ask the person which. If it says one-button Supabase is not set up on this games.fun
yet, use the agent's way below.

**The agent's way** (no games.fun in between):

1. `npx gamesfun backend connect supabase --add-mcp` adds Supabase's hosted MCP server to Claude Code or Codex with
   their own commands. Tell the person the sign-in step it prints:
   - Claude Code: `/mcp` → supabase → Authenticate.
   - Codex: `codex mcp login supabase`.
   Their browser opens Supabase, they sign in and allow your access. Nobody registers an app. A session started before
   the server was added needs `/mcp` once.
2. With Supabase's tools:
   - `list_projects`. Offer an existing project before creating one: the free plan has two active projects.
   - To make a new one, ask the person for a name and a region, then `create_project` (with `get_cost` and
     `confirm_cost` when it asks).
   - A project whose status is paused (INACTIVE): tell the person "your database is paused: open it in the Supabase
     dashboard and press Restore". Do not create another one instead.
3. `get_project_url` and `get_publishable_keys`. Keep only the publishable key, or the legacy anon key if the project
   has no publishable one.
4. `npx gamesfun backend use supabase games/<name> --url <url> --key <publishable key>` writes `backend.json` and the
   client `gf/backend/`.
5. Anonymous sign-ins give each player an id for their own rows. Ask the person to turn them on: Supabase dashboard →
   Authentication → Sign In / Providers → "Allow anonymous sign-ins". The kit's own sign-in can do it instead:
   `--anonymous-sign-ins`.

No MCP-capable agent? The person can paste the URL and key in the studio's Backend tab, or sign in from the kit with
a personal access token (`connect supabase --token-stdin`). `npx gamesfun backend connect supabase --help` lists both.

## 2. Tables and access rules

Write each change as a new file `games/<name>/supabase/migrations/<yyyymmddhhmmss>_<what>.sql`. That is the Supabase
CLI's own layout. Never edit an applied migration; add the next one. Start from the references:

- `references/high-scores.sql`: everyone reads the board, and a player adds only their own scores.
- `references/saved-progress.sql`: one row per player, which only that player reads and writes.

The rules the checker holds you to (`npx gamesfun backend check games/<name>`):

- **Every table in `public` has `alter table … enable row level security`.**
  - Without it, anyone holding the game's public key can read and change every row. Refused.
  - Every table the game's code reads with `.from('name')` must be created in a migration. Refused otherwise.
- **Policies tie writes to the player:** `with check ((select auth.uid()) = player_id)`.
  - A write policy whose rule is `true` lets any player change any row. Warned.
  - Reading a public board with `using (true)` is fine.
- **Views** need `with (security_invoker = true)`. A materialized view in `public` is refused.
- **Functions:**
  - prefer `security invoker`;
  - a `security definer` function needs `set search_path = ''` and its own `auth.uid()` check.
- **Bound every value:** text lengths, number ranges, and the size of a `jsonb` column (the examples show how).

Then, in this order:
1. `backend check` until it says OK.
2. `apply_migration` with each new file: its name, and the file's SQL exactly.
3. `get_advisors` (type `security`). Fix anything it flags in the next migration.
4. `execute_sql` with the query from `npx gamesfun backend check --live-sql`. Pass the rows to
   `gamesfun_backend_check` (`rows`), or to `npx gamesfun backend check --rows -`. This is the project's own view, and
   it must be OK too.

## 3. The game's code

Import the kit's client in `rules.js`. Call it on edges only: when a round ends, or when the player saves. Never call
it every frame. Call it only for the local player (`ctx.me`). It never throws: every call resolves to
`{ data, error }`. With no database (offline, paused, or in verify's automated browser), the game plays on.

```js
import { connectBackend } from './gf/backend/index.js';

export default {
  setup(ctx) { ctx.db = connectBackend(); },           // a promise; null when the game has no backend
  results(ctx) {
    ctx.db.then(async db => {
      if (!db || !(await db.signIn())) return;           // signIn: this player's own id (anonymous)
      await db.from('high_scores').insert({ player_id: db.user.id, name: ctx.me.name, score: ctx.me.score });
      const { data } = await db.from('high_scores').select('name,score', { order: 'score.desc', limit: 5 });
      if (data?.length) ctx.ui.toast(`Best: ${data[0].name} ${data[0].score}`);
    });
    return ctx.players.list().map(p => ({ id: p.id, name: p.name, value: p.score }));
  },
};
```

- **A score written from the browser can be faked.** Say so to the person. When it matters (prizes, rankings people
  care about), check the score in an edge function (`deploy_edge_function`) that reads the result the server can trust.
  The function's own secrets are set by the person in the dashboard (Edge Functions → Secrets). Never put them in the
  game, and never in your reply.
- **verify and `gamesfun play` run in an automated browser,** where the client is off and touches nothing. To try the
  real database, play in the person's own browser (`npx gamesfun dev`).

## 4. Disconnect

- `npx gamesfun backend disconnect supabase --from-game games/<name>` removes `backend.json` and `gf/backend/` from the
  game. The database is not touched.
- The MCP connection is the person's agent's: `claude mcp remove --scope local supabase` or
  `codex mcp remove supabase`.
- The kit's own sign-in, if one was used, is forgotten and revoked by `backend disconnect supabase`.
