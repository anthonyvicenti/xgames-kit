import { guard, parse, printJson, UsageError } from '../lib/cli.mjs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { connect } from '../lib/connect.mjs';
import { STATE } from '../lib/paths.mjs';

/**
 * What the studio page reads to say the one step left (builder/server/routes/studio.mjs /setup): connect ran here and which
 * agents now have the tools and the plugin. --remove takes the record away with the registration.
 */
export async function recordConnected(r, { remove = false, dir = STATE } = {}) {
  const file = path.join(dir, 'connected.json');
  if (remove) { await rm(file, { force: true }); return null; }
  const ok = r.results.filter(a => ['registered', 'already registered'].includes(a.status));
  if (!ok.length) return null;
  const v = { connected: true, plugin: ok.some(a => ['installed', 'already installed'].includes(a.plugin?.status)), agents: ok.map(a => ({ id: a.id, name: a.name, plugin: a.plugin?.status ?? null })), at: new Date().toISOString() };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(v, null, 2) + '\n');
  return v;
}

/** One line for a registration re-pointed at this checkout: the old folder, the new one, and how to switch back. */
export function movedLine(m, { dryRun = false } = {}) {
  const back = m.live ? 'that folder still holds a kit: run connect in that folder to switch back' : 'that folder no longer holds a kit';
  return `${dryRun ? 'would move' : 'moved'}: ${m.what} was from ${m.from}, ${dryRun ? 'would be' : 'is now'} from ${m.to} (${back})`;
}

const usage = `Usage: gamesfun connect [--agent <id>] [--scope <scope>] [--dir <folder>] [--replace] [--remove] [--dry-run] [--json]

Register this kit's MCP server with your coding agent (every agent found; rows are in lib/agents.json) using the agent's
own command ("claude mcp add", "codex mcp add"), then check the server starts, lists its tools, and shows up in the
agent's own list. For Claude Code it also installs this kit's plugin from this checkout ("claude plugin marketplace add",
"claude plugin install"): the hooks that let the studio page reach your session. It never edits an agent's config
file, signs in, or reads a credential.
  --agent <id>    only that agent (claude, codex)
  --scope <s>     Claude Code: user (default; every folder), local (this folder, private), project (.mcp.json in --dir)
                  Codex has one scope, user
  --dir <folder>  the folder local and project scopes belong to (default: the current one)
  --replace       register again from this checkout even when it already is (one from another folder, an older or a
                  deleted clone, is re-pointed here without it: one "moved" line each, the old folder and the new)
  --remove        take the registration and the plugin out again
The environment variables GAMESFUN_CONNECT_SCOPE and GAMESFUN_CONNECT_DIR set --scope and --dir when they are not given.
  --dry-run       print the agent commands, run none that change anything`;

export default {
  name: 'connect',
  summary: 'add our MCP server to Claude Code and Codex through their own commands',
  usage,
  run: args => guard(async () => {
    const { values } = parse(args, { agent: { type: 'string' }, scope: { type: 'string' }, dir: { type: 'string' }, replace: { type: 'boolean' }, remove: { type: 'boolean' }, 'dry-run': { type: 'boolean' } }, usage);
    if (values.replace && values.remove) throw new UsageError(`--replace and --remove together make no sense\n\n${usage}`);
    const r = await connect({ agent: values.agent ?? null, scope: values.scope ?? null, dir: values.dir ?? null, replace: !!values.replace, remove: !!values.remove, dryRun: !!values['dry-run'] });
    if (!values['dry-run'] && r.ok) await recordConnected(r, { remove: !!values.remove }).catch(() => {});
    if (values.json) { printJson(r); return r.ok ? 0 : 1; }
    if (r.error) console.error(r.error);
    if (r.server?.ok) console.log(`server: starts, ${r.server.tools.length} tools (${r.server.tools.join(', ')})`);
    for (const a of r.results) {
      console.log(`${a.name}: ${a.status}`);
      for (const m of a.moved ?? []) console.log(`  ${movedLine(m, { dryRun: !!values['dry-run'] })}`);
      for (const s of a.steps) console.log(`  ${s.do}: ${s.command}${s.code === undefined ? '' : `  -> exit ${s.code}`}${s.note ? ` (${s.note})` : ''}`);
      if (a.note) console.log(`  ${a.note}`);
      if (a.plugin) console.log(`  plugin (the studio page's link to your session): ${a.plugin.status}${a.plugin.note ? `: ${a.plugin.note}` : ''}`);
      // the one step the person does by hand: also when it was already there (this session may not have loaded it yet)
      if (['registered', 'already registered', 'would register'].includes(a.status) || ['installed', 'already installed', 'would install'].includes(a.plugin?.status)) console.log(`  next: ${a.restartHint}`);
    }
    return r.ok ? 0 : 1;
  }),
};
