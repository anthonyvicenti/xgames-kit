// The default way to connect Supabase: the person's own agent adds Supabase's hosted MCP server and signs in in the
// browser (dynamic client registration: nobody registers an app, the kit never sees a token). Supabase's docs,
// https://supabase.com/docs/guides/getting-started/mcp (read 2026-10-12):
//   Claude Code  claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp", then
//                /mcp → supabase → Authenticate (the browser opens)
//   Codex        codex mcp add supabase --url "https://mcp.supabase.com/mcp", then codex mcp login supabase
// The kit adds it with the agent's own command, as `gamesfun connect` adds the kit's server (builder/lib/connect.mjs): it never
// edits an agent's configuration file. Claude Code gets scope `local` (this checkout, the person's alone), not
// `project`, so no .mcp.json naming the person's database is written into the kit's folder.
// The URL carries at most one query parameter: on Windows Codex is a .cmd shim and builder/lib/proc.mjs refuses a `&` in its
// arguments (cmd.exe syntax).
import { mkdir as mkdirP, readFile as readF, rm as rmF, writeFile as writeF } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';
import { detectAll, loadAgents } from '../agents.mjs';
import { KIT_ROOT } from '../paths.mjs';
import { run } from '../proc.mjs';

export const NAME = 'supabase';
export const BASE = 'https://mcp.supabase.com/mcp';
/** The server's link: the whole account (to list and create projects), or one project once it is picked. */
export const mcpUrl = (projectRef = null) => (projectRef ? `${BASE}?project_ref=${encodeURIComponent(projectRef)}` : BASE);

/** Per agent: how to add the server, how the person signs in, the tools the agent then calls. */
export const STEPS = {
  claude: {
    add: url => ['mcp', 'add', '--scope', 'local', '--transport', 'http', NAME, url],
    get: ['mcp', 'get', NAME],
    remove: ['mcp', 'remove', '--scope', 'local', NAME],
    signIn: 'In Claude Code type /mcp, pick "supabase" and choose Authenticate: your browser opens Supabase; sign in and allow access to your organization. (A session started before this needs /mcp once to see the new server.)',
  },
  codex: {
    add: url => ['mcp', 'add', NAME, '--url', url],
    get: ['mcp', 'get', NAME],
    remove: ['mcp', 'remove', NAME],
    signIn: 'In a terminal run: codex mcp login supabase. Your browser opens Supabase; sign in and allow access to your organization.',
  },
};

/** What the agent does once signed in: Supabase's own tool names, so the kit's route and the agent's are the same. */
export const AGENT_TOOLS = [
  'list_projects (or create_project: the person picks a name and region; free plans have 2 active projects, so offer an existing one first)',
  'get_project_url and get_publishable_keys (keep only the publishable key, or the legacy anon key)',
  'npx gamesfun backend use supabase <game> --url <url> --key <publishable key>  (writes backend.json; refuses any other key)',
  'npx gamesfun backend check <game>  (row-level security on every table, no secret in the game) before apply_migration',
  'apply_migration with each file of <game>/supabase/migrations, then get_advisors (type security) and execute_sql with `npx gamesfun backend check --live-sql`',
];

/** Add Supabase's MCP server to every agent found (or `agent`). → [{ id, name, status, command, output, signIn }] */
export async function addServer({ agent = null, projectRef = null, runner = run, detected = null, env = process.env, platform = process.platform } = {}) {
  const found = (detected ?? await detectAll(loadAgents(), { env, platform })).filter(d => STEPS[d.id] && (agent ? d.id === agent : d.found));
  const url = mcpUrl(projectRef);
  const out = [];
  for (const d of found) {
    const s = STEPS[d.id];
    const rec = { id: d.id, name: d.name, url, signIn: s.signIn, command: [d.id, ...s.add(url)].join(' ') };
    out.push(rec);
    if (!d.found) { rec.status = 'not installed'; continue; }
    const had = await runner(d.path, s.get, { cwd: KIT_ROOT, env, timeoutMs: 30000, platform });
    if (had.code === 0 && /mcp\.supabase\.com/.test(`${had.stdout}${had.stderr}`)) { rec.status = 'already added'; continue; }
    const r = await runner(d.path, s.add(url), { cwd: KIT_ROOT, env, timeoutMs: 60000, platform });
    rec.status = r.code === 0 ? 'added' : 'failed';
    rec.output = `${r.stdout}${r.stderr}`.trim().split('\n').slice(0, 6).join('\n') || r.error || '';
  }
  return out;
}

/** The words for a person (or their agent) with no agent the kit can drive. */
export const manualSteps = (url = mcpUrl()) => [
  `Claude Code: claude mcp add --scope local --transport http ${NAME} "${url}", then /mcp → supabase → Authenticate`,
  `Codex: codex mcp add ${NAME} --url "${url}", then codex mcp login ${NAME}`,
  `Any other agent: add the HTTP MCP server ${url} and sign in when it asks (Supabase's docs: https://supabase.com/docs/guides/getting-started/mcp)`,
];

// ---------------------------------------------------------------- "Add Supabase to my agents" (the one-button flow)
// After the kit has connected a project, it adds Supabase's MCP server, scoped to that project, to each agent it finds
// (the agents `doctor` detects: builder/lib/agents.json). Each agent's own command does the writing, never the kit:
//   Claude Code  project scope, in the game folder: `claude mcp add --scope project --transport http supabase <url>`
//                run there writes <game>/.mcp.json (checked with Claude Code 2.1.296 under a scratch HOME: it writes the
//                folder it runs in, also inside a git checkout). A Claude Code session started in the game folder uses
//                it after the person approves it once.
//   Codex        user scope (Codex's MCP servers live in its own config.toml): `codex mcp add supabase --url <url>`.
// An agent that already has a server named "supabase" (any scope) is left as it is, and the person is told. What was
// added is recorded in <game>/.gamesfun/agents-supabase.json, so "Remove" undoes exactly that and nothing else.

export const RECORD = ['.gamesfun', 'agents-supabase.json'];
const recordFile = gameDir => nodePath.join(gameDir, ...RECORD);
const readJsonFile = async f => { try { return JSON.parse(await readF(f, 'utf8')); } catch { return null; } };

/** Where each agent keeps what its command writes, for the person to see. */
const PLACES = {
  claude: { scope: 'project', file: gameDir => nodePath.join(gameDir, '.mcp.json'), cwd: gameDir => gameDir,
    add: url => ['mcp', 'add', '--scope', 'project', '--transport', 'http', NAME, url],
    remove: ['mcp', 'remove', '--scope', 'project', NAME],
    use: 'A Claude Code session started in the game folder uses it; Claude Code asks you to approve it once, then /mcp → supabase → Authenticate signs you in to Supabase in your browser.' },
  codex: { scope: 'user', file: (gameDir, env) => nodePath.join(env.CODEX_HOME || nodePath.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex'), 'config.toml'), cwd: gameDir => gameDir,
    add: url => ['mcp', 'add', NAME, '--url', url],
    remove: ['mcp', 'remove', NAME],
    use: 'Codex: run "codex mcp login supabase" once; your browser signs you in to Supabase.' },
};

/** Is `url` the server we would add (Supabase's MCP, this project)? Read from an agent's own `get` output. */
const mentions = (out, url) => String(out).includes(url);

/** What the kit added before for this game (or []). */
export async function added(gameDir) {
  const r = await readJsonFile(recordFile(gameDir));
  return Array.isArray(r?.added) ? r.added : [];
}

/**
 * Add Supabase's MCP server, scoped to `projectRef`, to every agent found. Never replaces an existing "supabase" entry.
 * → [{ id, name, status: 'added' | 'already there' | 'not installed' | 'failed', scope, file, command, use, output? }]
 */
export async function addToAgents(gameDir, { projectRef, runner = run, detected = null, env = process.env, platform = process.platform } = {}) {
  const url = mcpUrl(projectRef);
  const found = (detected ?? await detectAll(loadAgents(), { env, platform })).filter(d => PLACES[d.id]);
  const out = [], record = await added(gameDir);
  for (const d of found) {
    const P = PLACES[d.id];
    const file = P.file(gameDir, env);
    const rec = { id: d.id, name: d.name, scope: P.scope, file, url, use: P.use, command: [d.id, ...P.add(url)].join(' ') };
    out.push(rec);
    if (!d.found) { rec.status = 'not installed'; continue; }
    const cwd = P.cwd(gameDir);
    const had = await runner(d.path, ['mcp', 'get', NAME], { cwd, env, timeoutMs: 30000, platform });
    if (had.code === 0) {
      rec.status = 'already there';
      rec.output = `${d.name} already has a server named "supabase"${mentions(had.stdout, url) ? ' for this project' : ''}; the kit left it as it is.`;
      continue;
    }
    const before = await readF(file, 'utf8').then(() => true, () => false);
    const r = await runner(d.path, P.add(url), { cwd, env, timeoutMs: 60000, platform });
    if (r.code !== 0) {
      rec.status = 'failed';
      rec.output = `${r.stdout}${r.stderr}`.trim().split('\n').slice(0, 4).join('\n') || r.error || `${d.name} did not add it`;
      continue;
    }
    rec.status = 'added';
    record.push({ id: d.id, name: d.name, scope: P.scope, file, url, cwd, createdFile: !before, at: new Date().toISOString() });
  }
  if (record.length) {
    await mkdirP(nodePath.dirname(recordFile(gameDir)), { recursive: true });
    await writeF(recordFile(gameDir), JSON.stringify({ about: 'What gamesfun backend added to your agents for this game (Supabase\'s MCP server); "Remove" undoes exactly these.', added: record }, null, 2) + '\n');
  }
  return out;
}

/**
 * Undo what addToAgents added for this game, and only that: an entry someone changed since (another URL) is left.
 * A .mcp.json the kit created and that is empty afterwards is deleted. → [{ id, name, status: 'removed' | 'left' | 'failed', file, output? }]
 */
export async function removeFromAgents(gameDir, { runner = run, detected = null, env = process.env, platform = process.platform } = {}) {
  const record = await added(gameDir);
  if (!record.length) return [];
  const found = detected ?? await detectAll(loadAgents(), { env, platform });
  const out = [], keep = [];
  for (const a of record) {
    const d = found.find(x => x.id === a.id), P = PLACES[a.id];
    const rec = { id: a.id, name: a.name, file: a.file };
    out.push(rec);
    if (!d?.found || !P) { rec.status = 'failed'; rec.output = `${a.name} is not on this machine any more; remove "supabase" from ${a.file} yourself.`; keep.push(a); continue; }
    const now = await runner(d.path, ['mcp', 'get', NAME], { cwd: a.cwd, env, timeoutMs: 30000, platform });
    if (now.code !== 0) { rec.status = 'removed'; rec.output = 'It was already gone.'; continue; }
    if (!mentions(now.stdout, a.url)) { rec.status = 'left'; rec.output = `${a.name}'s "supabase" server is not the one the kit added any more (it points elsewhere now), so the kit left it.`; continue; }
    const r = await runner(d.path, P.remove, { cwd: a.cwd, env, timeoutMs: 60000, platform });
    if (r.code !== 0) { rec.status = 'failed'; rec.output = `${r.stdout}${r.stderr}`.trim().split('\n').slice(0, 4).join('\n') || r.error; keep.push(a); continue; }
    rec.status = 'removed';
    if (a.createdFile && a.id === 'claude') {
      const j = await readJsonFile(a.file);
      if (j && Object.keys(j).length === 1 && j.mcpServers && !Object.keys(j.mcpServers).length) { await rmF(a.file, { force: true }); rec.output = 'The kit had made this file; it is deleted again.'; }
    }
  }
  if (keep.length) await writeF(recordFile(gameDir), JSON.stringify({ about: 'What gamesfun backend added to your agents for this game (Supabase\'s MCP server); "Remove" undoes exactly these.', added: keep }, null, 2) + '\n');
  else await rmF(recordFile(gameDir), { force: true });
  return out;
}
