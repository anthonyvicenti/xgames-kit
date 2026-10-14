#!/usr/bin/env node
// Runs the frozen economy evals with a real agent: for each case, a fresh copy of this kit (its tracked files, as a
// clone has them) in a folder of its own outside the repo, a game made from a kit example, and one headless Claude Code
// session given the case's one sentence. The session has the kit's MCP server (economy_* tools on, GAMESFUN_WEB3=1)
// and the kit's own skills and AGENTS.md, for that session only: the server comes from --mcp-config (nothing is
// registered with the person's agent, and their own MCP servers are left out), settings come from the copy alone
// (no user settings, so no user hooks or plugins), and permissions are "accept edits in this folder, the economy
// tools and the two read-only picture lists, nothing else" (no shell; anything that would ask is refused). Then the
// game's gamesfun.json is scored with score.mjs.
//
//   node builder/web3/economy/evals/run.mjs --out <folder> [--case e01-coin-flip-arena,e03-hat-shop] [--parallel 4]
//        [--timeout-min 25] [--max-turns 60] [--budget 10] [--model <m>] [--example coin-hop] [--holdout] [--json]
//   node builder/web3/economy/evals/run.mjs --out <folder> --score-only      (scores what an earlier run left)
//
// <out>/<id>/kit/           the copy, with the game at games/<id>
// <out>/<id>/transcript.jsonl   the session (stream-json), <out>/<id>/run.json what it did and cost
// <out>/specs/<id>.json     the game's gamesfun.json after the session (what score.mjs reads)
// <out>/summary.json        per case: pass, the checks that failed, tool calls, time, cost
import { spawn, execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES, scoreAll } from './score.mjs';

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** What the session is told besides the creator's sentence: only the facts of a headless run. */
export const appendedPrompt = (id) => [
  'This is a non-interactive run: nobody reads your questions or answers them before the session ends.',
  'When something is unclear, choose, and say what you chose.',
  `The game is games/${id} (made from a kit example; it has no economy yet).`,
].join(' ');

/** The claude command line for a case. */
export function claudeArgs({ prompt, id, mcpConfig, maxTurns = 60, budget = 10, model = null }) {
  const tools = ['catalog', 'examples', 'check', 'simulate', 'cost', 'explain', 'save', 'publish', 'status', 'decide'].map((t) => `mcp__gamesfun__economy_${t}`);
  tools.push('mcp__gamesfun__web3_list_pictures', 'mcp__gamesfun__web3_player_looks'); // read-only: what an item can look like
  return [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--setting-sources', 'project,local',
    '--tools', 'Read,Glob,Grep,Write,Edit,Skill',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--allowedTools', ['Skill', ...tools].join(','),
    '--append-system-prompt', appendedPrompt(id),
    '--max-turns', String(maxTurns), '--max-budget-usd', String(budget),
    '--no-session-persistence',
    ...(model ? ['--model', model] : []),
  ];
}

/** What a stream-json transcript says: tool calls in order, refusals, the result line. */
export function readTranscript(text) {
  const calls = [], denied = [];
  let result = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') calls.push({ name: b.name.replace(/^mcp__gamesfun__/, ''), input: b.input });
    if (m.type === 'result') result = m;
  }
  for (const d of result?.permission_denials ?? []) denied.push(d.tool_name);
  return {
    calls: calls.map((c) => c.name),
    saved: calls.some((c) => c.name === 'economy_save'),
    denied,
    turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null,
    seconds: result?.duration_ms ? Math.round(result.duration_ms / 1000) : null,
    stop: result ? result.subtype : 'no result',
    last: typeof result?.result === 'string' ? result.result.slice(0, 1500) : null,
  };
}

/** A copy of the kit as a fresh clone has it: tracked files (as they are now), node_modules linked. */
async function copyKit(dest) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: KIT, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const f of files) {
    if (!existsSync(path.join(KIT, f))) continue; // deleted in the working tree
    await mkdir(path.dirname(path.join(dest, f)), { recursive: true });
    await cp(path.join(KIT, f), path.join(dest, f));
  }
  await symlink(path.join(KIT, 'node_modules'), path.join(dest, 'node_modules'));
}

/**
 * --holdout: the copy no longer holds this case's answer. economy_examples lists every eval reference and fixture with
 * its prompt (an eval's prompt word for word), so as the kit ships an agent can fetch the spec a case was scored
 * against. Here the copy drops the case from cases.json (its checks too), deletes its reference (a fixture leaves the
 * examples list), and drops tests/ (fixtures copied into tests). What still holds the prompt is listed as `leaks`.
 */
async function holdOut(kit, c) {
  const casesFile = path.join(kit, 'builder', 'web3', 'economy', 'evals', 'cases.json');
  const all = JSON.parse(await readFile(casesFile, 'utf8'));
  all.cases = all.cases.filter((x) => x.id !== c.id);
  await writeFile(casesFile, `${JSON.stringify(all, null, 2)}\n`);
  await rm(path.join(kit, 'builder', 'web3', 'economy', c.reference), { force: true });
  if (c.reference.startsWith('fixtures/')) {
    const tools = path.join(kit, 'builder', 'mcp', 'tools', 'economy.mjs');
    const name = path.basename(c.reference, '.json');
    const src = await readFile(tools, 'utf8');
    const out = src.replace(new RegExp(`'${name}', |, '${name}'`), '');
    if (out === src) throw new Error(`--holdout: could not take ${name} out of the examples list`);
    await writeFile(tools, out);
  }
  await rm(path.join(kit, 'tests'), { recursive: true, force: true });
  const needle = c.prompt.slice(0, 50);
  const hits = [];
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: KIT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files) {
    const text = await readFile(path.join(kit, f), 'utf8').catch(() => '');
    if (text.includes(needle)) hits.push(f);
  }
  return hits;
}

function runChild(cmd, args, { cwd, env, timeoutMs, out }) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '';
    c.stdout.on('data', (d) => { stdout += d; out?.(d); });
    c.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { process.kill(-c.pid, 'SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    c.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr, timedOut: signal === 'SIGTERM' }); });
  });
}

async function runCase(c, o) {
  const dir = path.join(o.out, c.id);
  await rm(dir, { recursive: true, force: true });
  const kit = path.join(dir, 'kit');
  await copyKit(kit);
  const leaks = o.holdout ? await holdOut(kit, c) : null;
  execFileSync(process.execPath, ['bin/gamesfun.mjs', 'create', `games/${c.id}`, '--from', o.example], { cwd: kit, stdio: 'ignore', env: { ...process.env, GAMESFUN_NO_UPDATE_CHECK: '1' } });
  const mcpConfig = path.join(dir, 'mcp.json');
  await writeFile(mcpConfig, JSON.stringify({ mcpServers: { gamesfun: { type: 'stdio', command: process.execPath, args: [path.join(kit, 'builder', 'mcp', 'server.mjs')], env: { GAMESFUN_WEB3: '1', GAMESFUN_NO_OPEN: '1', GAMESFUN_NO_UPDATE_CHECK: '1' } } } }, null, 2));
  const args = claudeArgs({ prompt: c.prompt, id: c.id, mcpConfig, maxTurns: o.maxTurns, budget: o.budget, model: o.model });
  const started = Date.now();
  const transcript = createWriteStream(path.join(dir, 'transcript.jsonl')); // written as it goes
  const r = await runChild('claude', args, {
    out: (d) => transcript.write(d),
    cwd: kit,
    env: { ...process.env, GAMESFUN_WEB3: '1', GAMESFUN_NO_OPEN: '1', GAMESFUN_NO_UPDATE_CHECK: '1' },
    timeoutMs: o.timeoutMin * 60_000,
  });
  await new Promise((resolve) => transcript.end(resolve));
  if (r.stderr) await writeFile(path.join(dir, 'stderr.txt'), r.stderr);
  const t = readTranscript(r.stdout);
  const config = await readFile(path.join(kit, 'games', c.id, 'gamesfun.json'), 'utf8').catch(() => null);
  if (config) await writeFile(path.join(o.out, 'specs', `${c.id}.json`), config);
  const run = { id: c.id, exit: r.code, timedOut: r.timedOut, wallSeconds: Math.round((Date.now() - started) / 1000), ...t, ...(leaks ? { holdout: true, leaks } : {}), hasEconomy: !!(config && JSON.parse(config).economy) };
  await writeFile(path.join(dir, 'run.json'), JSON.stringify(run, null, 2));
  return run;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** Scores <out>/specs and joins each case's run record. */
export async function summarize(out, { only = null } = {}) {
  const s = scoreAll({ dir: path.join(out, 'specs') });
  const cases = [];
  for (const r of s.results) {
    if (only && !only.includes(r.id)) continue;
    const run = JSON.parse(await readFile(path.join(out, r.id, 'run.json'), 'utf8').catch(() => 'null'));
    cases.push({
      id: r.id, pass: r.pass, passed: r.passed, total: r.total,
      failed: r.checks.filter((k) => !k.ok).map((k) => `${k.says}${k.why ? `: ${k.why}` : ''}`),
      saved: run?.saved ?? null, calls: run?.calls ?? null, denied: run?.denied ?? null,
      turns: run?.turns ?? null, ...(run?.holdout ? { leaks: run.leaks } : {}), seconds: run?.seconds ?? run?.wallSeconds ?? null, costUsd: run?.costUsd ?? null, stop: run?.stop ?? null, timedOut: run?.timedOut ?? null,
    });
  }
  const meta = JSON.parse(await readFile(path.join(out, 'meta.json'), 'utf8').catch(() => 'null'));
  return { ...(meta ? { meta } : {}), passed: cases.filter((c) => c.pass).length, of: cases.length, costUsd: Math.round(cases.reduce((a, c) => a + (c.costUsd ?? 0), 0) * 100) / 100, cases };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
  const out = value('--out') && path.resolve(value('--out'));
  if (!out) {
    console.error('Usage: node web3/economy/evals/run.mjs --out <folder> [--case <id,id>] [--parallel 4] [--timeout-min 25] [--max-turns 60] [--budget 10] [--model <m>] [--example coin-hop] [--holdout] [--score-only] [--json]');
    process.exit(2);
  }
  if (path.relative(KIT, out) && !path.relative(KIT, out).startsWith('..')) {
    console.error(`--out must be outside the kit (${KIT}): each case gets a copy of the kit of its own.`);
    process.exit(2);
  }
  const only = value('--case')?.split(',') ?? null;
  const cases = CASES.filter((c) => !only || only.includes(c.id));
  if (!args.includes('--score-only')) {
    const o = { out, example: value('--example', 'coin-hop'), parallel: Number(value('--parallel', 4)), timeoutMin: Number(value('--timeout-min', 25)), maxTurns: Number(value('--max-turns', 60)), budget: Number(value('--budget', 10)), model: value('--model', null), holdout: args.includes('--holdout') };
    await mkdir(path.join(out, 'specs'), { recursive: true });
    const git = (...a) => execFileSync('git', a, { cwd: KIT, encoding: 'utf8' }).trim();
    const meta = {
      startedAt: new Date().toISOString(),
      kit: { commit: git('rev-parse', '--short', 'HEAD'), changed: git('status', '--porcelain').split('\n').filter(Boolean) },
      claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(),
      model: o.model ?? 'the default',
      options: { holdout: o.holdout, example: o.example, parallel: o.parallel, timeoutMin: o.timeoutMin, maxTurns: o.maxTurns, budgetUsd: o.budget },
      appended: appendedPrompt('<id>'),
    };
    await writeFile(path.join(out, 'meta.json'), JSON.stringify(meta, null, 2));
    await pool(cases, o.parallel, async (c) => {
      const t0 = Date.now();
      console.error(`start ${c.id}`);
      const r = await runCase(c, o).catch((e) => ({ id: c.id, error: e.message }));
      console.error(`done  ${c.id} in ${Math.round((Date.now() - t0) / 1000)}s: ${r.error ?? `${r.stop}, saved ${r.saved}, $${r.costUsd}`}`);
    });
  }
  const s = await summarize(out, { only });
  await writeFile(path.join(out, 'summary.json'), JSON.stringify(s, null, 2));
  if (args.includes('--json')) console.log(JSON.stringify(s, null, 2));
  else {
    for (const c of s.cases) {
      console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.id} (${c.passed}/${c.total}) ${c.seconds ?? '?'}s $${c.costUsd ?? '?'}${c.saved === false ? ' (never saved)' : ''}`);
      for (const f of c.failed) console.log(`     ✗ ${f}`);
    }
    console.log(`\n${s.passed} of ${s.of} pass. Cost $${s.costUsd}.`);
  }
}
