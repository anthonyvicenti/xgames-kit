// `gamesfun backend …`: connect a game to its own backend (optional: a game with none is the default) and check what
// reaches it. Providers plug in as files in builder/lib/backend/providers/ (builder/lib/backend/providers.mjs has the shape); this
// command is the same for all of them. docs/BACKEND.md has the story; skills/gamesfun-backend is the agent's part.
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { guard, parse, printJson, UsageError } from '../lib/cli.mjs';
import { resolveGame, shown } from '../lib/games.mjs';
import * as B from '../lib/backend/index.mjs';
import { PROVIDERS } from '../lib/backend/providers.mjs';
import { describeHits } from '../lib/backend/scan.mjs';
import { dbPassword } from '../lib/backend/supabase.mjs';
import { storeInfo } from '../lib/secret-store.mjs';

const providerUsage = [...PROVIDERS.values()].flatMap(p => (p.cli?.usage ?? [`connect ${p.id} [game]   ${p.about}`]).map(l => `  ${l}`));
const usage = `Usage: gamesfun backend <command> [options]

A game needs no backend; add one when it needs scores, saves, accounts or a server of its own. Only public values
reach the game (backend.json: the URL and a key designed to be public); every table the game uses needs row-level
security; secrets never enter the game's files. Providers: ${[...PROVIDERS.keys()].join(', ')}.

${providerUsage.join('\n')}
  use <provider> [game] --url <url> [--key <public key>] [--players anonymous|none]
                                      write the public settings your agent got (Supabase: get_project_url and
                                      get_publishable_keys); refuses any key that is not public
  check [game]                        backend.json, no secrets in the game, row-level security on every table in
                                      supabase/migrations and every table the code reads
      --live                          also ask the project (the kit's own Supabase sign-in)
      --rows <file|->                 judge rows your agent got by running the --live-sql query (execute_sql)
      --live-sql                      print that query
  status [game]                       what is connected, and how
  disconnect [provider]               forget (and revoke) the kit's own sign-in; --forget-app also forgets your OAuth
                                      app; --from-game <game> removes backend.json and gf/backend/ from a game
  password <ref>                      a database password the kit generated (in your own terminal only)
  agents [game]                       what "Add Supabase to my agents" added for this game (which files)
      --remove                        undo exactly that (an entry someone changed since is left)
  --json                              machine-readable output`;

const options = Object.assign({
  url: { type: 'string' }, key: { type: 'string' }, players: { type: 'string' },
  live: { type: 'boolean' }, rows: { type: 'string' }, 'live-sql': { type: 'boolean' },
  'forget-app': { type: 'boolean' }, 'from-game': { type: 'string' }, remove: { type: 'boolean' },
}, ...[...PROVIDERS.values()].map(p => p.cli?.options ?? {}));

async function stdin() {
  if (process.stdin.isTTY) throw new UsageError('paste it on stdin (for example: pbpaste | npx gamesfun backend …), or type it and press Ctrl+D (Ctrl+Z, Enter on Windows)');
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function checkCmd(values, gameArg) {
  if (values['live-sql']) { console.log(B.LIVE_SQL); return 0; }
  const gameDir = await resolveGame(gameArg);
  const out = await B.check(gameDir);
  if (values.live) out.live = await B.checkLive(gameDir);
  if (values.rows) {
    let rows = JSON.parse(values.rows === '-' ? await stdin() : await readFile(values.rows, 'utf8'));
    if (!Array.isArray(rows) && Array.isArray(rows?.result)) rows = rows.result;
    out.live = await B.judgeRows(gameDir, rows);
  }
  out.ok = out.ok && (out.live ? out.live.ok : true);
  if (values.json) { printJson(out); return out.ok ? 0 : 1; }
  if (out.settingsError) console.log(`backend.json: ${out.settingsError}`);
  else console.log(out.settings ? `backend.json: ${out.settings.provider} at ${out.settings.url} (${out.settings.keyKind ?? 'no'} key)` : 'backend.json: none (this game has no backend)');
  console.log(out.scan.ok ? `secrets: none in ${out.scan.files} files` : `secrets: REFUSED\n${describeHits(out.scan.hits)}`);
  console.log(`row-level security (${out.rls.migrations.length} migration${out.rls.migrations.length === 1 ? '' : 's'}; the code reads ${out.rls.used.join(', ') || 'no table'}): ${out.rls.ok ? 'ok' : 'REFUSED'}`);
  for (const t of out.rls.tables) console.log(`  ${t.name}: rls ${t.rls ? 'on' : 'OFF'}, ${t.policies} polic${t.policies === 1 ? 'y' : 'ies'}`);
  for (const r of out.rls.refused) console.log(`  refused: ${r}`);
  for (const w of out.rls.warned) console.log(`  warning: ${w}`);
  if (out.live) {
    console.log(`the project itself: ${out.live.ok ? 'ok' : 'REFUSED'}`);
    for (const r of out.live.refused) console.log(`  refused: ${r}`);
    for (const w of out.live.warned) console.log(`  warning: ${w}`);
  }
  console.log(out.ok ? 'backend check: OK' : 'backend check: FAILED (fix the refusals above; nothing was applied)');
  return out.ok ? 0 : 1;
}

export default {
  name: 'backend',
  summary: 'optional: a game\'s own backend (backend connect supabase|railway), check access rules and secrets',
  usage,
  run: args => guard(async () => {
    const { values, positionals } = parse(args, options, usage);
    const [sub, a1, a2] = positionals;
    if (sub === 'connect') {
      const p = B.provider(a1 ?? 'supabase');
      if (!p.cli?.connect) {
        const steps = p.agentSteps();
        if (values.json) return printJson({ provider: p.id, steps: steps.steps, tools: steps.tools });
        for (const s of [...steps.steps, '', ...steps.tools]) console.log(s);
        return 0;
      }
      return p.cli.connect(values, a2, { printJson, stdin, resolveGame });
    }
    if (sub === 'use') {
      if (!values.url) throw new UsageError('use needs --url <the public URL> (and --key <its public key> when the provider has one)');
      const gameDir = await resolveGame(a2);
      const r = await B.use(gameDir, { provider: a1 ?? 'supabase', url: values.url, key: values.key ?? null, players: values.players === 'none' ? 'none' : 'anonymous' });
      if (values.json) return printJson({ game: shown(gameDir), settings: r.settings });
      console.log(`Wrote ${shown(gameDir)}/backend.json (${r.settings.url}${r.settings.keyKind ? `, ${r.settings.keyKind} key` : ''}) and the client at gf/backend/.`);
      console.log('Next: tables and access rules in supabase/migrations/ (skill gamesfun-backend), then npx gamesfun backend check.');
      return 0;
    }
    if (sub === 'check') return checkCmd(values, a1);
    if (sub === 'status') {
      const gameDir = await resolveGame(a1).catch(() => null);
      const s = await B.status(gameDir ?? process.cwd());
      if (values.json) return printJson({ ...s, store: storeInfo() });
      console.log(gameDir ? `${shown(gameDir)}: ${s.game.settings ? `${s.game.settings.provider} at ${s.game.settings.url}` : s.game.settingsError ?? 'no backend (the default)'}` : 'No game.');
      for (const p of s.providers) console.log(`${p.label}: the kit's own sign-in ${p.status?.signedIn ? `${p.status.signedIn.kind}, kept in ${storeInfo().where}` : 'none'}${p.status?.oauthApp ? `; OAuth app: ${p.status.oauthApp.own ? 'your own' : 'games.fun\'s'}` : ''}`);
      return 0;
    }
    if (sub === 'disconnect') {
      const p = B.provider(a1 ?? 'supabase');
      const r = await p.disconnect({ forgetApp: values['forget-app'] });
      let game = null;
      if (values['from-game']) {
        const gameDir = await resolveGame(values['from-game']);
        await B.config.remove(gameDir);
        await rm(path.join(gameDir, ...B.CLIENT_IN_GAME), { recursive: true, force: true });
        game = shown(gameDir);
      }
      if (values.json) return printJson({ ...r, game });
      console.log(r.removed ? `Forgot the kit's ${p.label} sign-in${r.revoked ? ` and revoked it at ${p.label}` : ''}.` : `The kit had no ${p.label} sign-in saved.`);
      if (r.note) console.log(r.note);
      if (game) console.log(`Removed backend.json and gf/backend/ from ${game}.`);
      if (p.id === 'supabase') console.log('An MCP connection is your agent\'s: remove it with "claude mcp remove --scope local supabase" or "codex mcp remove supabase".');
      return 0;
    }
    if (sub === 'agents') {
      const gameDir = await resolveGame(a1);
      if (values.remove) {
        const r = await B.mcp.removeFromAgents(gameDir);
        if (values.json) return printJson({ game: shown(gameDir), removed: r });
        if (!r.length) console.log(`The kit added nothing to your agents for ${shown(gameDir)}.`);
        for (const x of r) console.log(`${x.name}: ${x.status} (${x.file})${x.output ? `. ${x.output}` : ''}`);
        return r.some(x => x.status === 'failed') ? 1 : 0;
      }
      const list = await B.mcp.added(gameDir);
      if (values.json) return printJson({ game: shown(gameDir), added: list });
      if (!list.length) console.log(`The kit added nothing to your agents for ${shown(gameDir)}.`);
      for (const x of list) console.log(`${x.name}: Supabase's MCP server (${x.url}) in ${x.file}, ${x.scope} scope`);
      return 0;
    }
    if (sub === 'password') {
      if (!process.stdout.isTTY) throw new Error('the password is shown only in your own terminal (not to a program or an agent): run this yourself');
      const pw = dbPassword(a1);
      console.log(pw ?? `No password saved for ${a1} (the kit keeps only the ones it generated when it created a project).`);
      return pw ? 0 : 1;
    }
    throw new UsageError(usage);
  }),
};
