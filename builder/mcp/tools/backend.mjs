// Backend MCP tools (optional part: a game with no backend never needs them). The agent's way to connect Supabase is
// Supabase's own MCP server (its tools list_projects, get_project_url, get_publishable_keys, apply_migration,
// execute_sql, get_advisors); these tools are the kit's half: the steps, writing the public settings, the checks.
// None of them signs anyone in or returns a token, a secret key or a password.
import { resolveGame, shown } from '../../lib/games.mjs';
import * as B from '../../lib/backend/index.mjs';
import { KIT_ROOT } from '../../lib/paths.mjs';

const gameProp = { type: 'string', description: 'The game folder, relative to the kit root (e.g. games/my-game). Optional when there is only one game.' };
const game = dir => resolveGame(dir, { cwd: KIT_ROOT });
const providerProp = { type: 'string', description: 'The provider id (default supabase).' };

export const tools = [
  {
    name: 'gamesfun_backend_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Is a backend connected to this game (none is the default and fine), which providers the kit knows, and the steps to connect one through the person\'s own agent.',
    inputSchema: { type: 'object', properties: { dir: gameProp } },
    async handler({ dir }) {
      const d = await game(dir);
      const s = await B.status(d);
      return { game: shown(d), backend: s.game.settings, error: s.game.settingsError, providers: s.providers.map(p => ({ id: p.id, label: p.label, kind: p.kind, about: p.about, ways: p.ways.map(w => w.label), kitSignedIn: !!p.status?.signedIn, steps: p.agent.steps, then: p.agent.tools })) };
    },
  },
  {
    name: 'gamesfun_backend_add_mcp',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Add Supabase\'s hosted MCP server (https://mcp.supabase.com/mcp) to the person\'s Claude Code and Codex with their own `mcp add` commands. Then tell the person how to sign in (returned per agent): their browser opens Supabase. Nobody registers an app and the kit keeps no token.',
    inputSchema: { type: 'object', properties: {} },
    async handler() { return { agents: await B.mcp.addServer() }; },
  },
  {
    name: 'gamesfun_backend_use',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: 'Write a game\'s public backend settings (backend.json) and its client (gf/backend/): the project URL and its publishable key from Supabase\'s get_project_url and get_publishable_keys. Refuses any key that is not public (a secret or service-role key) and a game folder that holds a secret.',
    inputSchema: { type: 'object', required: ['url'], properties: { dir: gameProp, provider: providerProp, url: { type: 'string' }, key: { type: 'string', description: 'The publishable key (sb_publishable_…) or legacy anon key. Never a secret key.' }, players: { enum: ['anonymous', 'none'], description: 'anonymous (default): each player signs in anonymously and gets an id for their own rows' } } },
    async handler({ dir, provider = 'supabase', url, key = null, players = 'anonymous' }) {
      const d = await game(dir);
      const r = await B.use(d, { provider, url, key, players });
      return { game: shown(d), settings: r.settings, next: 'Write tables in supabase/migrations/ (skill gamesfun-backend), run gamesfun_backend_check, then apply_migration through Supabase\'s MCP.' };
    },
  },
  {
    name: 'gamesfun_backend_check',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'The backend checks: backend.json valid, no secret in the game\'s files, row-level security on every table in supabase/migrations and on every table the code reads. With rows (the result of running liveSql through Supabase\'s execute_sql), also judges the project itself. Run it before every apply_migration.',
    inputSchema: { type: 'object', properties: { dir: gameProp, rows: { type: 'array', items: { type: 'object' }, description: 'Rows from execute_sql with the liveSql query' } } },
    async handler({ dir, rows }) {
      const d = await game(dir);
      const out = await B.check(d);
      if (rows) { out.live = await B.judgeRows(d, rows); out.ok = out.ok && out.live.ok; }
      return { ok: out.ok, settings: out.settings, settingsError: out.settingsError, secrets: out.scan.hits, rls: out.rls, live: out.live ?? null, liveSql: B.LIVE_SQL };
    },
  },
];
