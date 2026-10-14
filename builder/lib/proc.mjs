// Starting and stopping programs the same way on Windows, macOS and Linux, with no shell.
//   - Nothing here uses `shell: true`. A Windows batch shim (npm and Codex install as codex.cmd) cannot be started
//     without cmd.exe since Node 20, so `agentCommand` builds that one call by hand and refuses any argument that
//     cmd.exe would read as syntax.
//   - Stopping a program stops what it started too: `taskkill /T /F` on Windows, the process group on macOS and Linux
//     (the program is started as its own group leader there). The cross-system cases mirror what BuildersGate's
//     proc.py does (kill_pid_tree).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { onPath } from './chrome.mjs';

/** A program on PATH by the first of `names` that exists. → its path or null */
export function findProgram(names, { platform = process.platform, env = process.env, exists } = {}) {
  for (const n of names) {
    const p = onPath(n.replace(/\.(exe|cmd|bat)$/i, ''), { platform, env, ...(exists ? { exists } : {}) });
    if (p) return p;
  }
  return null;
}

const CMD_SYNTAX = /["%^&|<>\r\n\0!`]/;

/**
 * The program and arguments to start `file` with `args`, without a shell. A real executable runs as itself. On Windows a
 * .cmd or .bat shim needs cmd.exe: `cmd.exe /d /s /c "file" arg …`, each argument quoted when it holds a space, and
 * refused when it holds a character cmd.exe treats as syntax (" % ^ & | < > !). Our own arguments are names, flags and
 * absolute paths, so a refusal means something unexpected, not a lost feature. `impl` is path.win32 in tests.
 */
export function agentCommand(file, args = [], { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { cmd: file, args: [...args] };
  const parts = [file, ...args];
  for (const a of parts) if (CMD_SYNTAX.test(a)) throw new Error(`refusing to pass ${JSON.stringify(a)} through cmd.exe (it holds a character cmd.exe reads as syntax); install the program as an .exe or give a plainer path`);
  const q = s => (/[\s()]/.test(s) || s === '' ? `"${s}"` : s);
  return { cmd: env.ComSpec || env.COMSPEC || 'cmd.exe', args: ['/d', '/s', '/c', `"${parts.map(q).join(' ')}"`], windowsVerbatimArguments: true };
}

/** The command that ends a process and its children, or { group: true } when a signal to the group does it. */
export function stopCommand(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;   // pid 0 or negative would aim at a whole group
  if (platform === 'win32') return { cmd: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] };
  return { group: true, pid };
}

/** End `child` and everything it started. Never throws. */
export function stopTree(child, { platform = process.platform } = {}) {
  const pid = child?.pid;
  const plan = stopCommand(pid, { platform });
  if (!plan) return false;
  try {
    if (plan.group) {
      try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGKILL'); }
      const t = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch {} }, 1500);
      t.unref();
    } else {
      const k = spawn(plan.cmd, plan.args, { stdio: 'ignore', windowsHide: true });
      k.on('error', () => {});
    }
    return true;
  } catch { return false; }
}

/**
 * Run a program to the end, capturing its output; stops its whole tree at the timeout.
 * → { code, stdout, stderr, timedOut, error } (never rejects)
 */
export function run(file, args = [], { cwd = process.cwd(), env = process.env, timeoutMs = 30000, input = null, platform = process.platform } = {}) {
  return new Promise(resolve => {
    let plan;
    try { plan = agentCommand(file, args, { platform, env }); } catch (e) { return resolve({ code: null, stdout: '', stderr: '', timedOut: false, error: e.message }); }
    let stdout = '', stderr = '', timedOut = false, done = false, child;
    const finish = r => { if (done) return; done = true; clearTimeout(timer); resolve({ stdout, stderr, timedOut, error: null, ...r }); };
    try {
      child = spawn(plan.cmd, plan.args, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true, detached: platform !== 'win32', windowsVerbatimArguments: plan.windowsVerbatimArguments });
    } catch (e) { return resolve({ code: null, stdout, stderr, timedOut, error: e.message }); }
    const timer = setTimeout(() => { timedOut = true; stopTree(child, { platform }); }, timeoutMs);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    if (input !== null) child.stdin.end(input);
    child.on('error', e => finish({ code: null, error: e.message }));
    child.on('close', code => finish({ code }));
  });
}

export const isWin = (platform = process.platform) => platform === 'win32';
export const nameOf = p => path.basename(p);
