// Core MCP tools: catalog, examples, create, verify, slots, and the dev server's status, start and stop.
import { spawn } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { catalog, catalogLines, DEFAULT_SECTIONS, SECTIONS } from '../../lib/catalog.mjs';
import { createGame } from '../../lib/create.mjs';
import { listExamples } from '../../lib/examples.mjs';
import { listGames, resolveGame, shown, summarizeVerdict } from '../../lib/games.mjs';
import { BIN, KIT_ROOT, STATE } from '../../lib/paths.mjs';
import { listSlots, setFile, setValue } from '../../lib/slots.mjs';
import { stopTree } from '../../lib/proc.mjs';
import { alive, listDevServers } from '../../lib/state.mjs';
import { CATALOG_OUTPUT, SLOTS_LIST_OUTPUT, SLOTS_SET_OUTPUT, VERIFY_OUTPUT } from '../schemas.mjs';

const gameProp = { type: 'string', description: 'The game folder, relative to the kit root (e.g. games/my-game). Optional when there is only one game.' };
const game = dir => resolveGame(dir, { cwd: KIT_ROOT });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function reachable(url) {
  try { const r = await fetch(`${url}api/dev/status`, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; }
}

export const tools = [
  {
    name: 'gamesfun_catalog',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: CATALOG_OUTPUT,
    description: 'What the kit has, from the registry: the runtimes and their profiles (with their limits said plainly), the kinds and the runtime x kind matrix, the loops (how a game is played), the mechanics (with their params), world templates, looks, bodies, props, clips and fair-play defaults. It assists and never narrows an idea: what it lacks, a game builds. Default sections: runtimes, loops, kinds and mechanics.',
    inputSchema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'string', enum: SECTIONS }, description: `Any of ${SECTIONS.join(', ')}` }, json: { type: 'boolean', description: 'Return the raw catalog JSON for the sections (large)' } } },
    async handler({ sections, json }) {
      const c = await catalog();
      const want = sections?.length ? sections : DEFAULT_SECTIONS;
      if (json) return Object.fromEntries(want.flatMap(s => (s === 'loops' ? [[s, c[s]], ['loopGuide', c.loopGuide]] : [[s, c[s]]])));
      return catalogLines(c, want).join('\n');
    },
  },
  {
    name: 'gamesfun_examples',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Complete example games that gamesfun_create can start from (each passes verify).',
    inputSchema: { type: 'object', properties: {} },
    async handler() { return (await listExamples()).map(({ dir, ...e }) => e); },
  },
  {
    name: 'gamesfun_games',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'The games in this kit checkout (games/*).',
    inputSchema: { type: 'object', properties: {} },
    async handler() { return (await listGames()).map(g => ({ name: g.name, dir: shown(g.dir), title: g.title })); },
  },
  {
    name: 'gamesfun_create',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Make a game folder from an example (from) or from a locked game spec file (spec): a runnable multiplayer game on the spec\'s runtime with the kit vendored, the world, mechanics, bodies and look applied, every visible thing a slot, and an AGENTS.md guide. With a spec, rules.js is a stub you then write. Re-running on an existing game refreshes the kit and keeps rules.js and config.',
    inputSchema: {
      type: 'object', required: ['dir'],
      properties: {
        dir: { type: 'string', description: 'New game folder, relative to the kit root, e.g. games/my-game' },
        from: { type: 'string', description: 'An example id (gamesfun_examples)' },
        spec: { type: 'string', description: 'Path to a game spec JSON (builder/spec/game-spec.schema.json), relative to the kit root' },
        force: { type: 'boolean', description: 'Create into a non-empty folder, or reset a game to its example' },
      },
    },
    async handler({ dir, from, spec, force }) {
      const r = await createGame(dir, { from, spec, force, cwd: KIT_ROOT });
      return { ...r, dir: r.shown, next: [`gamesfun_verify {"dir": "${r.shown}"}`, `gamesfun_dev_start {"dir": "${r.shown}"}`, `edit ${r.shown}/rules.js and ${r.shown}/config/*.json (read ${r.shown}/AGENTS.md)`] };
    },
  },
  {
    name: 'gamesfun_verify',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: VERIFY_OUTPUT,
    description: 'Run gf-three verify on a game: real Chrome with real input, alone with bots and two players over WebRTC, then one verdict (about 2 minutes with quick). Returns pass/fail per check with details and the evidence folder. check runs one check alone (10, 13, 14, 15, 16, or the static 11, 17).',
    inputSchema: { type: 'object', properties: { dir: gameProp, quick: { type: 'boolean', description: 'Skip the contact sheet (default true)' }, check: { type: 'string', description: 'One measure alone, e.g. "13" or "11,17"' }, gate: { type: 'string', enum: ['A', 'B', 'C', 'D', 'E', 'F'], description: 'One gate alone (GATES.md): A integrity, B health, C cause -> effect, D the loop closes, E shared truth, F matches the spec' } } },
    async handler({ dir, quick = true, check, gate }, ctx) {
      const d = await game(dir);
      const args = ['verify', d, '--json'];
      if (quick) args.push('--quick');
      if (check) args.push('--check', String(check));
      if (gate) args.push('--gate', gate);
      ctx.progress(`verify ${shown(d)}: starting Chrome`);
      const r = await ctx.runCli(args, { onLine: (line, stream) => { if (stream === 'stderr' || /^(PASS|FAIL|SKIP)\b/.test(line)) ctx.progress(line); } });
      const i = r.stdout.indexOf('{'), j = r.stdout.lastIndexOf('}');
      let rec = null;
      try { rec = JSON.parse(r.stdout.slice(i, j + 1)); } catch {}
      if (!rec) throw new Error(`verify did not produce a verdict (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-4).join(' | ')}`);
      const s = summarizeVerdict(rec);
      return { game: shown(d), pass: s.pass, passed: s.passed, ran: s.ran, skipped: s.skipped, failed: s.failed, checks: s.checks.map(c => `${c.ok === null ? 'SKIP' : c.ok ? 'PASS' : 'FAIL'} ${c.n} ${c.name}${c.ok === false ? ` — ${c.detail}` : ''}`), notes: (rec.notes ?? []).slice(0, 8), evidence: rec.outDir ? path.relative(KIT_ROOT, path.resolve(d, rec.outDir)).split(path.sep).join('/') : null, seconds: rec.seconds };
    },
  },
  {
    name: 'gamesfun_slots_list',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: SLOTS_LIST_OUTPUT,
    description: 'List a game\'s slots: every model, texture and tuning value it shows (assets.json), with current values. The main tier (about 40) by default; all for every slot.',
    inputSchema: { type: 'object', properties: { dir: gameProp, all: { type: 'boolean' }, group: { type: 'string', description: 'Only one group, e.g. props, world, rules' } } },
    async handler({ dir, all, group }) {
      const r = await listSlots(await game(dir), { all });
      const rows = group ? r.slots.filter(s => s.group === group) : r.slots;
      return { total: r.total, shown: rows.length, groups: r.groups, slots: rows.map(s => ({ id: s.id, label: s.label, type: s.type, group: s.group, ...(s.kind === 'file' ? { file: s.file, bytes: s.bytes } : { value: s.value }), constraints: s.constraints })) };
    },
  },
  {
    name: 'gamesfun_slots_set',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    outputSchema: SLOTS_SET_OUTPUT,
    description: 'Swap a slot with no code change: a value slot takes value (colour "#rrggbb", number, text, true/false, an enum option); a file slot takes file, a path to a new file of the same kind (.glb stays .glb), copied to the slot\'s own path. Checked against the slot\'s constraints.',
    inputSchema: { type: 'object', required: ['id'], properties: { dir: gameProp, id: { type: 'string' }, value: { description: 'The new value (value slots)' }, file: { type: 'string', description: 'Path to the new file (file slots), relative to the kit root' } } },
    async handler({ dir, id, value, file }) {
      const d = await game(dir);
      if (file) return { ...(await setFile(d, id, { from: path.resolve(KIT_ROOT, file) })), reminder: 'Record the file\'s source and licence in ATTRIBUTION.md, then verify.' };
      if (value === undefined) throw new Error('give value (a value slot) or file (a file slot)');
      return setValue(d, id, value);
    },
  },
  {
    name: 'gamesfun_dev_status',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'The dev servers running from this kit checkout: their URLs (studio, game, friends lobby), game and pid.',
    inputSchema: { type: 'object', properties: {} },
    async handler() {
      const out = [];
      for (const s of await listDevServers()) {
        const st = await reachable(s.url);
        out.push({ ...s, reachable: !!st, studio: `${s.url}studio/`, play: `${s.url}game/`, friends: `${s.url}game/gf/mp/` });
      }
      return out.length ? out : 'No dev server is running. Start one with gamesfun_dev_start (or npx gamesfun dev <game> in a terminal).';
    },
  },
  {
    name: 'gamesfun_dev_start',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Start the dev server in the background (127.0.0.1 only): the studio, the game with live reload, and local multiplayer signaling so two tabs play together. Returns its URLs. With dir, it opens that game; without dir, the studio\'s start page, where the person describes a game or opens one of theirs (it never opens a game they did not pick, and you never make an example game to have something to show). Reuses a server already running for that game, or for the start page.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string', description: 'The game folder, relative to the kit root (e.g. games/my-game). Without it: the start page.' }, port: { type: 'integer' } } },
    async handler({ dir, port }) {
      const d = dir ? await game(dir) : null;
      const running = (await listDevServers()).find(s => (s.gameDir ? path.resolve(s.gameDir) : null) === d);
      if (running && await reachable(running.url)) return { ...running, reused: true, studio: `${running.url}studio/`, play: `${running.url}game/`, friends: `${running.url}game/gf/mp/` };
      await mkdir(STATE, { recursive: true });
      const logFile = path.join(STATE, `dev-${Date.now()}.log`);
      const fd = openSync(logFile, 'a');
      const args = [BIN, 'dev', ...(d ? [d] : []), '--no-open', ...(port ? ['--port', String(port)] : [])];
      const child = spawn(process.execPath, args, { cwd: KIT_ROOT, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
      child.unref();
      closeSync(fd);
      for (let i = 0; i < 60; i++) {
        await sleep(250);
        const s = (await listDevServers()).find(x => x.pid === child.pid);
        if (s && await reachable(s.url)) return { ...s, studio: `${s.url}studio/`, play: `${s.url}game/`, friends: `${s.url}game/gf/mp/`, log: path.relative(KIT_ROOT, logFile).split(path.sep).join('/') };
        if (!alive(child.pid)) break;
      }
      throw new Error(`the dev server did not start; see ${path.relative(KIT_ROOT, logFile)}`);
    },
  },
  {
    name: 'gamesfun_dev_stop',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Stop a dev server started from this checkout (by pid, or the only one running).',
    inputSchema: { type: 'object', properties: { pid: { type: 'integer' } } },
    async handler({ pid }) {
      const list = await listDevServers();
      const s = pid ? list.find(x => x.pid === pid) : list.length === 1 ? list[0] : null;
      if (!s) throw new Error(list.length ? `which one? ${list.map(x => `${x.pid} (${x.game})`).join(', ')}` : 'no dev server is running');
      stopTree({ pid: s.pid });          // the server and anything it started, the same way on Windows, macOS and Linux (builder/lib/proc.mjs)
      for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(150);
      return { stopped: s.pid, game: s.game };
    },
  },
];
