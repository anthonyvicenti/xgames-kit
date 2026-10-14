// Keep the kit current: `update` fetches and fast-forwards this checkout (never a merge, never a rewrite), reinstalls
// packages only when package-lock.json changed, and a cached once-a-day check says when a newer kit exists. The check
// runs in a detached process, never delays a command, and is off with GAMESFUN_NO_UPDATE_CHECK=1 (also off in CI, in
// tests and for --json output). git never asks a question here: a private remote that needs a login just fails.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { npmCli } from './char-deps.mjs';
import { BIN, KIT_ROOT, STATE } from './paths.mjs';
import { run } from './proc.mjs';

export const CACHE = path.join(STATE, 'update-check.json');
export const DAY_MS = 24 * 60 * 60 * 1000;
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '', LC_ALL: 'C' };

const git = (args, { cwd = KIT_ROOT, timeoutMs = 60000, env = GIT_ENV } = {}) => run('git', args, { cwd, env, timeoutMs });
const out = r => r.stdout.trim();

/** What this checkout is relative to its upstream. → { ok, head, upstream, ahead, behind, dirty } or { ok: false, error } */
export async function kitState({ cwd = KIT_ROOT, fetch = true } = {}) {
  const top = await git(['rev-parse', '--show-toplevel'], { cwd });
  if (top.code !== 0) return { ok: false, error: top.error ?? 'this folder is not a git checkout, so it cannot update itself: fetch the kit again with git clone' };
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd });
  if (up.code !== 0) return { ok: false, error: 'this branch has no upstream to update from (git branch --set-upstream-to=origin/main)' };
  if (fetch) {
    const f = await git(['fetch', '--quiet'], { cwd, timeoutMs: 45000 });
    if (f.code !== 0) return { ok: false, error: `git fetch failed: ${(f.stderr || f.error || 'no answer').trim().split('\n')[0]}` };
  }
  const head = out(await git(['rev-parse', 'HEAD'], { cwd }));
  const counts = out(await git(['rev-list', '--left-right', '--count', 'HEAD...@{u}'], { cwd })).split(/\s+/).map(Number);
  const dirty = out(await git(['status', '--porcelain', '--untracked-files=no'], { cwd })).length > 0;
  return { ok: true, head, upstream: out(up), ahead: counts[0] || 0, behind: counts[1] || 0, dirty };
}

/** Fast-forward to the upstream and reinstall packages if the lockfile changed. → { ok, status, ... } */
export async function updateKit({ cwd = KIT_ROOT, dryRun = false, log = () => {}, install = true } = {}) {
  const s = await kitState({ cwd });
  if (!s.ok) return { ok: false, status: 'cannot-check', error: s.error };
  if (s.behind === 0) return { ok: true, status: 'up-to-date', head: s.head.slice(0, 9), upstream: s.upstream, ahead: s.ahead };
  if (s.ahead > 0) return { ok: false, status: 'diverged', error: `this checkout has ${s.ahead} commit(s) of its own and ${s.behind} new one(s) upstream; update only fast-forwards. Merge or rebase by hand, or fetch the kit fresh.`, ...s };
  if (s.dirty) return { ok: false, status: 'dirty', error: 'tracked files in this checkout are changed; commit or restore them first (git status), then run update again', ...s };
  if (dryRun) return { ok: true, status: 'would-update', behind: s.behind, upstream: s.upstream };
  const m = await git(['merge', '--ff-only', '@{u}'], { cwd });
  if (m.code !== 0) return { ok: false, status: 'failed', error: `git merge --ff-only failed: ${(m.stderr || m.stdout).trim().split('\n')[0]}` };
  const now = out(await git(['rev-parse', 'HEAD'], { cwd }));
  const files = out(await git(['diff', '--name-only', s.head, now], { cwd })).split('\n').filter(Boolean);
  const log10 = out(await git(['log', '--oneline', '-n', '10', `${s.head}..${now}`], { cwd })).split('\n').filter(Boolean);
  const lockChanged = files.includes('package-lock.json') || files.includes('package.json');
  const result = { ok: true, status: 'updated', from: s.head.slice(0, 9), to: now.slice(0, 9), commits: s.behind, changed: files.length, log: log10, installed: false, kitsChanged: files.some(f => /^(runtimes|components|loops|worlds|builder\/(ui|gf-multiplayer|gf-audio|gf-assets))\//.test(f)) };
  if (install && (lockChanged || !existsSync(path.join(cwd, 'node_modules')))) {
    const cli = npmCli();
    if (!cli) return { ...result, ok: false, error: 'updated, but npm was not found to reinstall packages: run npm ci' };
    log('package-lock.json changed: npm ci');
    const r = await run(process.execPath, [cli, 'ci', '--no-audit', '--no-fund'], { cwd, env: process.env, timeoutMs: 600000 });
    if (r.code !== 0) return { ...result, ok: false, error: `updated, but npm ci failed (exit ${r.code}): ${(r.stderr || r.error || '').trim().split('\n').slice(-3).join(' | ')}` };
    result.installed = true;
  }
  if (path.resolve(cwd) === KIT_ROOT) await writeCache({ checkedAt: Date.now(), behind: 0, upstream: s.upstream });   // the kit's own state, not a test's repository
  return result;
}

async function writeCache(v, file = CACHE) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(v) + '\n');
  try { await rename(tmp, file); } catch { await writeFile(file, JSON.stringify(v) + '\n'); }
}
export async function readCache(file = CACHE) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}

/** Is the daily check allowed to run right now? Pure, so the switches are tested. */
export function checkAllowed({ env = process.env, cache = null, now = Date.now() } = {}) {
  if (env.GAMESFUN_NO_UPDATE_CHECK && env.GAMESFUN_NO_UPDATE_CHECK !== '0') return false;
  if (env.CI || env.NODE_TEST_CONTEXT) return false;
  return !cache?.checkedAt || now - cache.checkedAt >= DAY_MS || cache.checkedAt > now;
}

/** The one-line note when the cache says a newer kit exists. */
export function noticeText(cache) {
  if (!cache || !(cache.behind > 0)) return null;
  return `gamesfun: a newer kit is available (${cache.behind} new commit${cache.behind === 1 ? '' : 's'} on ${cache.upstream}). Run: node bin/gamesfun.mjs update   (silence this: GAMESFUN_NO_UPDATE_CHECK=1)`;
}

/** Run by the detached process: fetch, count, write the cache. Fails quietly. */
export async function refreshCache() {
  const s = await kitState({});
  await writeCache(s.ok ? { checkedAt: Date.now(), behind: s.behind, upstream: s.upstream } : { checkedAt: Date.now(), behind: 0, error: s.error });
}

/** At the start of a command: start a refresh in the background if it is due, and return the cached notice. Never waits. */
export async function startUpdateCheck({ env = process.env, now = Date.now(), spawnFn = spawn, cacheFile = CACHE } = {}) {
  const cache = await readCache(cacheFile);
  if (checkAllowed({ env, cache, now })) {
    try {
      const child = spawnFn(process.execPath, [BIN, 'update', '--refresh-cache'], { cwd: KIT_ROOT, env: { ...env, GAMESFUN_NO_UPDATE_CHECK: '' }, detached: true, stdio: 'ignore', windowsHide: true });
      child.on?.('error', () => {});
      child.unref?.();
    } catch {}
  }
  const allowed = !(env.GAMESFUN_NO_UPDATE_CHECK && env.GAMESFUN_NO_UPDATE_CHECK !== '0') && !env.CI;
  return allowed ? noticeText(cache) : null;
}
