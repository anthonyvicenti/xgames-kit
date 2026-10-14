// Run one of gf-three's tools (builder/tools/<name>.mjs) as its own Node process, exactly as games.fun
// ships it. A child process keeps each tool's own CLI, exit code and output, and keeps a crash or a long browser run
// out of the caller (the dev server, the MCP server).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { savedGpuEnv } from './gpu-env.mjs';
import { GF3_TOOLS, KIT_ROOT } from './paths.mjs';

/** What every tool is told about this checkout (the tools read their settings from the environment). */
export const TOOL_ENV = {
  // files this kit adds to a game that are not game assets: gf-three writes them into assets.json → ignore
  GF_MANIFEST_IGNORE: path.join(KIT_ROOT, 'builder', 'lib', 'manifest-ignore.json'),
};

export function toolPath(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad tool name ${name}`);
  return path.join(GF3_TOOLS, `${name}.mjs`);
}

/**
 * Run a tool. stdio 'inherit' streams to this terminal; 'pipe' captures. onLine(line, stream) sees each output line.
 * → Promise<{ code, stdout, stderr }>
 */
export function runTool(name, args = [], { stdio = 'inherit', env = {}, cwd = process.cwd(), onLine = null, signal } = {}) {
  return new Promise((resolve, reject) => {
    const capture = stdio !== 'inherit';
    const child = spawn(process.execPath, [toolPath(name), ...args], {
      cwd, env: { ...process.env, ...TOOL_ENV, ...savedGpuEnv(), ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', windowsHide: true, signal,
    });
    let stdout = '', stderr = '';
    const lines = (stream) => { let buf = ''; return chunk => { buf += chunk; let i; while ((i = buf.indexOf('\n')) >= 0) { onLine?.(buf.slice(0, i).replace(/\r$/, ''), stream); buf = buf.slice(i + 1); } }; };
    if (capture) {
      const out = lines('stdout'), err = lines('stderr');
      child.stdout.on('data', d => { stdout += d; out(String(d)); });
      child.stderr.on('data', d => { stderr += d; err(String(d)); });
    }
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/** Run a tool with --json and parse its stdout. → { code, data, stderr } (data null when the output was not JSON) */
export async function runToolJson(name, args = [], opts = {}) {
  const r = await runTool(name, [...args, '--json'], { ...opts, stdio: 'pipe' });
  let data = null;
  try { data = JSON.parse(r.stdout); } catch {
    // some tools print a summary line around their JSON (verify prints one after it)
    const i = r.stdout.indexOf('{'), j = r.stdout.lastIndexOf('}');
    if (i >= 0 && j > i) try { data = JSON.parse(r.stdout.slice(i, j + 1)); } catch {}
  }
  return { code: r.code, data, stderr: r.stderr, stdout: r.stdout };
}
