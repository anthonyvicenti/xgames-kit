// The loop's seams, bound to this kit. The loop library (loop.mjs) never names a script or a folder: a host passes
// `registry`, `tools` and `versions`, and this file is what every host of this checkout passes (the MCP tools, the
// headless build command, the tests that run the real kit). Each seam is one call into the kit:
//
//   registry   registry/build-catalog.mjs createRegistry over registry/catalog.json (built fresh when it is stale)
//   create     builder/lib/create.mjs createGame on the locked spec v2     → {ok, why}
//   verify     builder/tools/verify.mjs as a child process (it starts Chrome); its verdict.json is the contracts'
//              verdict (builder/gates/verdict.schema.json), read as written → {verdictVersion, pass, gates, failed}
//   fix        builder/tools/fix.mjs when the kit has one                  → {repairs}
//   objectiveArt builder/art/objectives.mjs on the made game (the objectives' art) → {items, credits}
//   checkSpec  builder/tools/lib/spec.mjs checkSpecV2 (version, schema, registry), then create's own check in a
//              throwaway folder → problems (findings are said, never refused)
//   versions   builder/lib/checkpoint.mjs (the same store gamesfun_rollback restores from)
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createGame } from '../lib/create.mjs';
import { checkpointStore } from '../lib/checkpoint.mjs';
import { BUILDER, GF3_TOOLS, KIT_ROOT } from '../lib/paths.mjs';
import { TOOL_ENV } from '../lib/run-tool.mjs';
import { savedGpuEnv } from '../lib/gpu-env.mjs';
import { ensureCharDeps } from '../lib/char-deps.mjs';
import { ensureBrowser } from '../lib/chrome.mjs';
import { buildCatalog, createRegistry } from '../../registry/build-catalog.mjs';
import { checkSpecV2 } from '../tools/lib/spec.mjs';
import { verdictOf as recordVerdict } from '../tools/lib/verdict.mjs';
import { web3On } from '../lib/web3-switch.mjs';
import { filesHash, ignoreStateDir, STATE_DIR } from './state.mjs';

const GATES = ['A', 'B', 'C', 'D', 'E', 'F'];
const flat = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------------------------------------------------------------- the registry
/** The catalog the registry answers from: registry/catalog.json, or built from the manifests when it is missing or stale. */
export async function loadCatalog(root = KIT_ROOT) {
  const file = path.join(root, 'registry', 'catalog.json');
  const fresh = await buildCatalog(root);
  let disk = null;
  try { disk = JSON.parse(await readFile(file, 'utf8')); } catch { /* none: the fresh one stands */ }
  return disk?.inputs?.sha256 && disk.inputs.sha256 === fresh.inputs.sha256 ? disk : fresh;
}
/** The registry the loop takes, with its catalog beside the eight calls (checkSpec reads it). */
export async function kitRegistry(root = KIT_ROOT) {
  const catalog = await loadCatalog(root);
  return Object.assign(createRegistry(catalog), { catalog });
}

// ---------------------------------------------------------------- the verdict
/**
 * The verdict a verify run wrote (verdict.json, builder/gates/verdict.schema.json), as written; a whole record
 * (record.json: checks by number) is read through verify's own verdictOf. A verify that wrote nothing is a fail of
 * gate B with what it printed.
 */
export function verdictOf(raw, { runtime = null, profile = null, loop = null, code = null, stderr = '', outDir = null } = {}) {
  if (raw?.verdictVersion === 1) return { ...raw, ...(outDir ? { evidence: outDir } : {}) };
  if (raw && Array.isArray(raw.checks)) return { ...recordVerdict({ place: { runtime: runtime ?? 'three', profile }, specLoop: loop, ...raw }), ...(outDir ? { evidence: outDir } : {}) };
  const detail = flat(`verify ${raw ? 'wrote a verdict this loop cannot read' : 'wrote no verdict.json'} (exit ${code})${stderr ? `: ${String(stderr).trim().split('\n').slice(-3).join(' ')}` : ''}`, 1800);
  const f = { measure: 3, detail, rule: 'the game boots to play', fix: 'run gamesfun_verify on the game and fix what it names first' };
  return { verdictVersion: 1, runtime: runtime ?? 'three', ...(profile ? { profile } : {}), ...(loop ? { loop } : {}), run: 'build', pass: false, gates: { B: { gate: 'B', ran: [3], passed: [], skipped: [], failed: [f], ok: false } }, failed: [{ gate: 'B', area: 'code', ...f }], ...(outDir ? { evidence: outDir } : {}) };
}

/** Stops a child and what it started (verify starts Chrome): its process group on Linux and macOS, taskkill on Windows. */
export function killTree(child) {
  const pid = child?.pid;
  if (!pid) return;
  if (process.platform === 'win32') { try { execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* gone */ } return; }
  try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/** A command without a shell, its output collected; `signal` and `timeoutMs` stop the whole tree. → {code, stdout, stderr, aborted, timedOut} */
export function runTree(file, args, { cwd = KIT_ROOT, env = process.env, signal = null, timeoutMs = 0, onLine = null } = {}) {
  return new Promise(done => {
    let stdout = '', stderr = '', aborted = false, timedOut = false, finished = false, buf = '';
    if (signal?.aborted) return done({ code: 1, stdout, stderr: 'aborted before it started', aborted: true, timedOut });
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    child.stdout.on('data', d => { if (stdout.length < 64 << 20) stdout += d; if (onLine) { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } } });
    child.stderr.on('data', d => { if (stderr.length < 8 << 20) stderr += d; });
    const stop = () => killTree(child);
    const onAbort = () => { aborted = true; stop(); };
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = timeoutMs > 0 ? setTimeout(() => { timedOut = true; stop(); }, timeoutMs) : null;
    const end = code => {
      if (finished) return; finished = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (aborted || timedOut) stop();
      done({ code: typeof code === 'number' ? code : 1, stdout, stderr, aborted, timedOut });
    };
    child.on('error', e => { stderr += String(e.message); end(1); });
    child.on('close', end);
  });
}

/**
 * A command prefix verify runs under (GAMESFUN_GPU_WRAP, split on spaces): a machine whose graphics card is shared
 * by several jobs hands verify to its own queue this way. Unset: verify runs directly.
 */
export const gpuWrap = (env = process.env) => String(env.GAMESFUN_GPU_WRAP ?? '').trim().split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- the look (builder/look)
/**
 * The look step's tools: the style target from the spec's references and the person's images and words (measured
 * here, judged by the loop's round), its 2–3 options drawn as contact sheets on the game's own world (the GPU work
 * through GAMESFUN_GPU_WRAP like verify), and the picked option written into config/look.json (an option with its own
 * world and camera makes the game again from its spec, which the loop locks). GAMESFUN_LOOK=0 turns
 * the step off.
 */
export function lookTools({ log = () => {}, env = process.env } = {}) {
  const mod = name => import(pathToFileURL(path.join(BUILDER, 'look', name)).href);
  return {
    async lookTarget(spec, { references = [], words = '' }) {
      const [{ extract }, { findRefs }] = await Promise.all([mod('target.mjs'), mod('refs.mjs')]);
      const fromSpec = spec.look?.refs?.length ? (await findRefs(spec.look.refs)).frames : [];
      const given = references.filter(r => r?.file && /\.(png|jpe?g|webp)$/i.test(r.file)).map(r => ({ file: r.file, frame: 'other', note: r.caption ?? null }));
      const frames = [...fromSpec, ...given];
      if (!frames.length && !String(words).trim()) return { why: 'no reference image and no words about the look' };
      return extract({ refs: frames, words, kind: spec.kind });
    },
    async finishTarget(base, judged) {
      const [{ finish, measureLooks }, { loadSchemas, SCHEMA }] = await Promise.all([mod('target.mjs'), import(pathToFileURL(path.join(KIT_ROOT, 'registry', 'schemas.mjs')).href)]);
      // the references' looks (levels), each measured from its own frames
      const target = await measureLooks(finish(base, judged), base);
      const problems = (await loadSchemas()).validate(SCHEMA.lookTarget, target);
      return problems.length ? { ok: false, problems } : { ok: true, target };
    },
    async lookOptions(spec, { game, target }) {
      const { options, renderSheet } = await mod('pitch.mjs');
      const wrap = gpuWrap(env), gpuEnv = { ...env, ...savedGpuEnv() }, render = (g, out, o) => renderSheet(g, out, { ...o, wrap, env: gpuEnv });
      try { return await options(spec, { game, target, render, score: judgeUnder(wrap, gpuEnv, { log }), packs: spec.look?.packs ?? [], log }); } catch (e) { log(`look options: ${flat(e.message, 300)}`); return [{ ok: false, skipped: flat(e.message, 200) }]; }
    },
    async applyLook(game, option, { spec = null } = {}) {
      // an option made from its own spec (its world and camera: builder/look/world.mjs) makes the game again from that
      // spec first; the loop locks it in place of the old one
      let made = null;
      if (option.made && spec) {
        made = { ...spec, world: option.made.world, look: { ...(spec.look ?? {}), target: option.made.target } };
        const specFile = path.join(loopDir(game), 'spec.json');
        await mkdir(path.dirname(specFile), { recursive: true });
        await writeFile(specFile, JSON.stringify(made, null, 2) + '\n');
        try { await createGame(game, { spec: specFile, force: true, cwd: KIT_ROOT, env }); }
        catch (e) { return { ok: false, why: `the look's world could not be made: ${flat(e.message, 300)}` }; }
      }
      const file = path.join(game, 'config', 'look.json');
      const { over } = await import(pathToFileURL(path.join(KIT_ROOT, 'kinds', 'apply.mjs')).href);
      const look = JSON.parse(await readFile(file, 'utf8')), time = look.time ?? 'day';
      let next = over(look, option.values ?? {});
      if (next.times?.[time]) next.times[time] = over(next.times[time], option.values ?? {});
      await writeFile(file, JSON.stringify(next, null, 2) + '\n');
      return { ok: true, ...(made ? { spec: made } : {}) };
    },
  };
}

/**
 * The look judge as its own process, on the same terms as the sheets and verify: under GAMESFUN_GPU_WRAP and with the
 * GPU env doctor saved. Its live render opens a browser, and in the loop's own process that browser got neither (no
 * hardware GL on a wrapped host: every option's judge timed out waiting for the game, T8 run 1, 2026-10-14).
 * → score(game, target, refs) → the judge's record, or null when it gave none (the option is then unscored)
 */
export function judgeUnder(wrap = [], env = process.env, { log = () => {}, judgeFile = path.join(BUILDER, 'look', 'judge.mjs') } = {}) {
  return async (game, target, refs = []) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'gf-look-judge-'));
    try {
      const t = path.join(dir, 'target.json'), m = path.join(dir, 'refs.json'), out = path.join(dir, 'record.json');
      await writeFile(t, JSON.stringify(target ?? null));
      await writeFile(m, JSON.stringify({ frames: (refs ?? []).filter(f => f?.file) }));
      const [cmd, ...pre] = wrap.length ? [...wrap, process.execPath] : [process.execPath];
      await new Promise(done => {
        const c = spawn(cmd, [...pre, judgeFile, game, '--target', t, '--refs', m, '--out', path.join(game, '.verify', 'look'), '--json', out], { stdio: ['ignore', 'pipe', 'pipe'], env });
        c.stdout.on('data', d => log(String(d).trimEnd())); c.stderr.on('data', d => log(String(d).trimEnd()));
        c.on('close', done); c.on('error', e => { log(`look judge: ${e.message}`); done(1); });
      });
      return existsSync(out) ? JSON.parse(await readFile(out, 'utf8')) : null;
    } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
  };
}

// ---------------------------------------------------------------- the tools of one game
const readJson = async f => { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return null; } };
export const loopDir = game => path.join(game, STATE_DIR);

/**
 * The kit's tools for one game, as openLoop takes them. `registry`: the loop's registry (for the kind's look).
 * `quick`: verify --quick (tests and dry runs; a delivery's verify is the full one). `timeoutMinutes`: verify's wall clock.
 */
export function kitTools({ registry, log = () => {}, signal = null, quick = false, timeoutMinutes = 30, env = process.env, look = env.GAMESFUN_LOOK !== '0' } = {}) {
  /** The locked spec v2, written where create reads it. → its path */
  const writeSpec = async (spec, dir) => {
    const file = path.join(dir, 'spec.json');
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(spec, null, 2) + '\n');
    return file;
  };
  return {
    ...(look ? lookTools({ log, env }) : {}),
    /**
     * The design step's references (builder/play/design.mjs playRefsOf takes them): the person's own images and clips,
     * then the look's reference frames on this machine (spec.look.refs, by sha256: builder/look/refs.mjs), gameplay first.
     */
    async playRefs(spec, { references = [] } = {}) {
      const given = references.filter(r => r?.file).map(r => ({ file: r.file, note: r.caption ?? r.note ?? null }));
      if (!spec.look?.refs?.length) return given;
      try {
        const { findRefs } = await import(pathToFileURL(path.join(BUILDER, 'look', 'refs.mjs')).href);
        const { frames } = await findRefs(spec.look.refs);
        const order = f => (f.frame === 'gameplay' ? 0 : f.frame === 'vfx' ? 1 : 2);
        return [...given, ...frames.sort((a, b) => order(a) - order(b)).map(f => ({ file: f.file, note: [f.frame, f.note].filter(Boolean).join(': ') || null }))];
      } catch (e) { log(`play refs: ${flat(e.message, 200)}`); return given; }
    },
    async create(spec, { game, newRules = false }) {
      try {
        const file = await writeSpec(spec, loopDir(game));
        await createGame(game, { spec: file, force: true, newRules, cwd: KIT_ROOT, env });
        await ignoreStateDir(game);
        log(`create: ${spec.runtime}${spec.profile ? `/${spec.profile}` : ''} ${spec.loop} ${spec.kind}`);
        return { ok: true };
      } catch (e) { return { ok: false, why: flat(e.message, 1200) }; }
    },
    // the art step for what the objectives draw (builder/art/objectives.mjs): the library by meaning, else a maker in the
    // look's style on the person's own key (cost never stops a build; GAMESFUN_ART_MAKE=0 keeps makers off), else the
    // stand-in and why, which gate F fails until it is filled
    async objectiveArt(game) {
      try {
        const { objectiveArt, makerEnv } = await import(pathToFileURL(path.join(BUILDER, 'art', 'objectives.mjs')).href);
        const r = await objectiveArt(game, { yes: env.GAMESFUN_ART_MAKE !== '0' && await makerEnv(), log });
        for (const i of r.items) if (i.now !== 'kept' && i.now !== 'spec') log(`objective art: ${i.slot} ${i.now}${i.ref ? ` ${i.ref}` : ''}${i.why ? ` (${flat(i.why, 160)})` : ''}`);
        return { items: r.items.map(({ name, slot, now, ref = null, why = null }) => ({ name, slot, now, ref, why })), credits: r.credits };
      } catch (e) { log(`objective art could not run: ${flat(e.message, 200)}`); return { items: [], credits: 0, error: flat(e.message, 300) }; }
    },
    async fix(game) {
      const tool = path.join(GF3_TOOLS, 'fix.mjs');
      if (!existsSync(tool)) return { repairs: [] };
      try {
        const { fixGame } = await import(pathToFileURL(tool).href);
        const r = await fixGame(game, { apply: true });
        return { repairs: (r?.repairs ?? []).map(x => ({ ...x, line: x.line ?? `${x.fix} ${x.file ?? ''}`.trim() })) };
      } catch (e) { log(`fix could not run: ${flat(e.message, 200)}`); return { repairs: [] }; }
    },
    async verify(game, { n = 1 } = {}) {
      const outDir = path.join(loopDir(game), 'verify', String(n));
      await rm(outDir, { recursive: true, force: true });
      await mkdir(outDir, { recursive: true });
      const spec = await readJson(path.join(loopDir(game), 'spec.json'));
      const wrap = gpuWrap(env), argv = [path.join(GF3_TOOLS, 'verify.mjs'), game, '--out', outDir, ...(quick ? ['--quick'] : [])];
      const [cmd, ...args] = wrap.length ? [...wrap, process.execPath, ...argv] : [process.execPath, ...argv];
      log(`verify ${n}${quick ? ' (quick)' : ''}: ${path.basename(game)}`);
      // what verify needs, found or installed once: a browser, and the 3D tools' packages (gate A reads every skeleton)
      const runEnv = { ...env, ...TOOL_ENV, ...savedGpuEnv() };
      await ensureBrowser({ log, env: runEnv });
      ensureCharDeps({ log });
      const r = await runTree(cmd, args, { cwd: KIT_ROOT, env: runEnv, signal, timeoutMs: timeoutMinutes * 60000 });
      if (r.aborted) { const e = new Error('verify was stopped: the host aborted it'); e.name = 'AbortError'; throw e; }
      const raw = await readJson(path.join(outDir, 'verdict.json'));
      const v = verdictOf(raw, { runtime: spec?.runtime ?? null, profile: spec?.profile ?? null, loop: spec?.loop ?? null, code: r.timedOut ? 'timed out' : r.code, stderr: r.stderr || r.stdout.slice(-2000), outDir });
      // gate D's play leg (builder/play/judge.mjs) wrote its record beside the verdict: the loop keeps it (S.playJudge)
      const pj = await readJson(path.join(outDir, 'play', 'play-judge.json')).catch(() => null);
      if (pj?.verdict) v.play = { verdict: pj.verdict, score: pj.score, interval: pj.interval, bar: pj.bar, advisory: pj.advisory, hard: pj.hard ?? [], parts: pj.parts, findings: (pj.findings ?? []).slice(0, 12), change: pj.change ?? [], clips: (pj.clips ?? []).map(c => c.file), record: path.join(outDir, 'play', 'play-judge.json') };
      await writeFile(path.join(outDir, 'gates.json'), JSON.stringify(v, null, 2) + '\n');
      return v;
    },
    /**
     * The look's cheap levers (builder/look/tune.mjs), when only the look failed verify: a child process on the graphics
     * card like verify. A SUGGESTION ONLY (the parent, 2026-10-14: the tuner pulled a daylight overworld toward cave
     * frames while its score rose): the proposed values and the before/after sheet are written to `outDir`, never into
     * the game, until the tune compares like with like per setting. → its record ({score, values, ladder, wrote: false,
     * suggestion: {values, sheet}}) or {error}
     */
    async tuneLook(game, { n = 1 } = {}) {
      const outDir = path.join(loopDir(game), 'look-tune', String(n));
      const wrap = gpuWrap(env), argv = [path.join(KIT_ROOT, 'builder', 'look', 'tune.mjs'), game, '--out', outDir, '--json'];
      const [cmd, ...args] = wrap.length ? [...wrap, process.execPath, ...argv] : [process.execPath, ...argv];
      log(`look tune ${n}: ${path.basename(game)}`);
      const runEnv = { ...env, ...TOOL_ENV, ...savedGpuEnv() };
      await ensureBrowser({ log, env: runEnv });
      const r = await runTree(cmd, args, { cwd: KIT_ROOT, env: runEnv, signal, timeoutMs: timeoutMinutes * 60000 });
      if (r.aborted) { const e = new Error('the look tuning was stopped: the host aborted it'); e.name = 'AbortError'; throw e; }
      const line = String(r.stdout ?? '').trim().split('\n').reverse().find(l => l.startsWith('{'));
      try { const t = JSON.parse(line); return { ...t, wrote: false, suggestion: { values: path.join(outDir, 'look.json'), sheet: path.join(outDir, 'before-after.jpg') } }; } catch { return { error: flat(`tune.mjs wrote no record (exit ${r.timedOut ? 'timed out' : r.code}): ${String(r.stderr || r.stdout).trim().split('\n').slice(-2).join(' ')}`, 600) }; }
    },
    hash: game => filesHash(game),
    /** checkSpecV2 (version, schema, registry: its problems; findings are said, never refused), then create's own check. */
    async checkSpec(spec) {
      const { problems } = await checkSpecV2(spec, { catalog: registry?.catalog ?? null });
      if (problems.length) return problems;
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'gf-spec-'));
      try {
        const file = await writeSpec(spec, tmp);
        await createGame(path.join(tmp, 'game'), { spec: file, cwd: KIT_ROOT, env: { ...env, GAMESFUN_WEB3: '0' } });
        return [];
      } catch (e) { return String(e.message).split('\n').map(l => l.trim()).filter(l => l && !/^the spec does not make a game/.test(l)).slice(0, 20).map(l => `create: ${l}`); }
      finally { await rm(tmp, { recursive: true, force: true }); }
    },
    /** The play-tester's screenshots, newest round first (the second reader's captures). → [{file, what}] */
    async captures(game) {
      const runs = path.join(loopDir(game), 'job', 'playtest', 'runs'), out = [];
      for (const run of await readdir(runs).catch(() => [])) {
        for (const f of await readdir(path.join(runs, run)).catch(() => [])) {
          if (!/\.(png|jpe?g)$/i.test(f)) continue;
          const file = path.join(runs, run, f);
          const st = await stat(file).catch(() => null);
          if (st) out.push({ file, what: `${run}: ${f.replace(/\.(png|jpe?g)$/i, '').replace(/^\d+-/, '')}`, t: st.mtimeMs });
        }
      }
      return out.sort((a, b) => b.t - a.t).slice(0, 80).map(({ file, what }) => ({ file, what }));
    },
    /** A gamesfun_play run's record (play.json), by the run's name, or null: what a friends promise rests on. */
    async playRun(game, name) {
      if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(String(name ?? ''))) return null;
      return readJson(path.join(loopDir(game), 'job', 'playtest', 'runs', name, 'play.json'));
    },
    remove: (game, paths) => removeMade(game, paths),
    /** The game's own code beside the kit's: src/ and declared overrides (what a migration rewrites). */
    async ownFiles(game) {
      const out = [];
      const walk = async (dir, rel) => {
        let entries = [];
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const r = `${rel}/${e.name}`;
          if (e.isDirectory()) await walk(path.join(dir, e.name), r); else if (e.isFile()) out.push(r);
        }
      };
      for (const top of ['src', 'overrides']) await walk(path.join(game, top), top);
      return out.sort();
    },
  };
}

/**
 * Remove files a round made and no longer needs (a scratch file, a module it replaced): only regular files inside the
 * game that were not there when create made it (the 'created' checkpoint), never the loop's own folder and never a
 * link. What create made is the game's own or the kit's: changed, never removed here. → {removed: [rel], refused: [{path, why}]}
 */
export async function removeMade(game, paths = []) {
  const root = path.resolve(game), made = (await checkpointStore(root).get('created'))?.files ?? null;
  const out = { removed: [], refused: [] };
  for (const p of [paths].flat().slice(0, 50)) {
    const abs = path.resolve(root, String(p ?? '')), rel = path.relative(root, abs).split(path.sep).join('/');
    const no = why => out.refused.push({ path: String(p), why });
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) { no('outside the game\'s folder'); continue; }
    if (rel.split('/')[0] === STATE_DIR) { no('the loop\'s own folder is never a round\'s to change'); continue; }
    const st = await lstat(abs).catch(() => null);
    if (!st) { no('no such file'); continue; }
    if (!st.isFile()) { no(st.isSymbolicLink() ? 'a link is never removed' : 'only files are removed, one by one (a folder is left empty instead)'); continue; }
    if (!made) { no('the game has no record of what create made, so nothing can be told apart as made by a round'); continue; }
    if (rel in made) { no('create made it (the game\'s own file or a kit copy): change it instead of removing it'); continue; }
    await rm(abs); out.removed.push(rel);
  }
  return out;
}

/** The loop's versions ('created', 'verified') in the checkpoint store gamesfun_rollback restores from. */
export function kitVersions(game) {
  const cp = checkpointStore(game);
  return { keep: name => cp.keep(name, { step: name }), restore: name => cp.restore(name), has: name => cp.has(name), store: cp };
}

// ---------------------------------------------------------------- the optional parts
/**
 * The parts this kit offers (builder/loop/parts.mjs): the economy when web3 is on (on by default; GAMESFUN_WEB3=0 turns
 * it off), the backend always. Each adapter is one call into the kit's own tools: the economy's checker and publish
 * (builder/mcp/tools/economy.mjs economy_check, economy_publish, economy_status offline), the backend's check and status
 * (builder/lib/backend). None signs, holds a key or talks to a provider.
 */
export function kitParts({ env = process.env } = {}) {
  const out = { backend: backendPart() };
  if (web3On(env)) out.economy = economyPart();
  return out;
}
const economyTool = async name => (await import('../mcp/tools/economy.mjs')).tools.find(t => t.name === name);
function economyPart() {
  return {
    async check(game) {
      const cfg = await readJson(path.join(game, 'gamesfun.json'));
      if (!cfg?.economy || typeof cfg.economy !== 'object') return { ok: false, problems: [{ code: 'E-NONE', message: 'the game keeps an economy, and gamesfun.json has none yet', fix: 'Draft it with economy_examples and economy_check, then save it with economy_save {"game": "<this game>", "spec": …} (skill gamesfun-economy).' }] };
      const r = await (await economyTool('economy_check')).handler({ spec: cfg.economy }, {});
      return { ok: r.ok, problems: (r.refusals ?? []).map(x => ({ code: x.code, message: `${x.message ?? ''}${x.where ? ` (${x.where})` : ''}`, fix: x.fix ?? '' })), warnings: (r.warnings ?? []).map(w => w.message ?? String(w)) };
    },
    publish: async game => (await economyTool('economy_publish')).handler({ game }, {}),
    status: async game => (await economyTool('economy_status')).handler({ game, offline: true }, {}),
  };
}
function backendPart() {
  return {
    async check(game) {
      const B = await import('../lib/backend/index.mjs');
      const r = await B.check(game);
      const problems = [
        ...(r.settingsError ? [{ code: 'B-SETTINGS', message: `backend.json: ${r.settingsError}`, fix: 'Write it again with backend_use (the public URL and key only), or delete it until the person connects.' }] : []),
        ...(r.scan?.hits ?? []).slice(0, 8).map(h => ({ code: 'B-SECRET', message: `a secret in the game's files: ${h.kind ?? 'a key'} in ${h.file}${h.line ? `, line ${h.line}` : ''}`, fix: 'Take it out: a game holds only public values (the URL and the publishable key).' })),
        ...(r.rls?.refused ?? []).slice(0, 8).map(t => ({ code: 'B-RLS', message: String(t), fix: 'Turn on row-level security on every table in supabase/migrations/, with a policy for what a player may read and write (skill gamesfun-backend).' })),
      ];
      if (!problems.length && r.ok === false) problems.push({ code: 'B-CHECK', message: 'the backend check did not pass', fix: 'Run gamesfun_backend_check on the game and fix what it names.' });
      return { ok: problems.length === 0, problems, warnings: (r.rls?.warned ?? []).slice(0, 8) };
    },
    async status(game) {
      const B = await import('../lib/backend/index.mjs');
      const s = await B.status(game);
      const st = s.game?.settings;
      return st?.url ? { connected: true, provider: st.provider ?? null, url: st.url } : { connected: false };
    },
  };
}

/** Everything openLoop needs from this kit for one game (the host adds store, agent, playtester, hooks). */
export async function kitHost(game, { registry = null, log, signal, quick = false, timeoutMinutes, env = process.env } = {}) {
  const reg = registry ?? await kitRegistry();
  return { registry: reg, game, tools: kitTools({ registry: reg, log, signal, quick, timeoutMinutes, env }), versions: kitVersions(game), parts: kitParts({ env }) };
}

export { BUILDER };
