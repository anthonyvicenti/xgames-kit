// The bridge's line for `gamesfun doctor`: is the plugin whole, which wait is set, can this system run it, and is a
// session connected to a running studio? → { id, label, status: ok|warn|fail, detail, fix: {win32, darwin, linux}|null }
// Never a "fail": the bridge is not needed for a first game. Every probe is injectable (tests name all three systems).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeStatus } from './client.mjs';
import { waitForm } from './runfile.mjs';

const KIT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const same = s => ({ win32: s, darwin: s, linux: s });

/** Every hook must be exec form with `node`: no shell on any system. → problems (strings) */
export async function checkPlugin(pluginDir) {
  const problems = [];
  let hooks = null;
  try { JSON.parse(await readFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')); } catch { problems.push('plugin/.claude-plugin/plugin.json is missing or not JSON'); }
  try { hooks = JSON.parse(await readFile(path.join(pluginDir, 'hooks', 'hooks.json'), 'utf8')).hooks; } catch { problems.push('plugin/hooks/hooks.json is missing or not JSON'); }
  for (const [event, groups] of Object.entries(hooks ?? {})) for (const g of groups) for (const h of g.hooks ?? []) {
    if (h.type !== 'command' || h.command !== 'node' || !Array.isArray(h.args)) problems.push(`${event}: a hook that is not "node" in exec form (it would need a shell)`);
  }
  for (const need of ['SessionStart', 'Stop', 'PermissionRequest']) if (hooks && !hooks[need]) problems.push(`no ${need} hook`);
  if (hooks && !hooks.PreToolUse?.some(g => !g.hooks?.some(h => h.async) && g.hooks?.some(h => h.args?.some(x => /guard\.mjs$/.test(x))))) problems.push('no write guard on PreToolUse (scripts/guard.mjs, not async)');
  const waits = ['SessionStart', 'Stop'].filter(e => hooks?.[e]?.some(g => g.hooks?.some(h => h.asyncRewake)));
  if (hooks && waits.length !== 2) problems.push('the wait (asyncRewake) is not on both SessionStart and Stop');
  return problems;
}

export async function bridgeDoctor({ root = KIT, platform = process.platform, env = process.env, probes = {} } = {}) {
  const item = (status, detail, fix = null) => ({ id: 'bridge', label: 'Studio bridge', status, detail, fix: typeof fix === 'string' ? same(fix) : fix });
  const pluginDir = path.join(root, 'plugin');
  const problems = probes.plugin ?? await checkPlugin(pluginDir);
  if (problems.length) return item('warn', `the plugin is not whole: ${problems.join('; ')}`, 'git restore plugin');
  const form = probes.form ?? await waitForm(root, env);
  if (form === 'monitor' && platform === 'win32' && !(probes.gitBash ?? false)) {
    return item('warn', 'the wait is set to "monitor", which needs Git Bash on Windows', { win32: 'node bin/gamesfun.mjs doctor --bridge-wait rewake   (or: winget install Git.Git)', darwin: 'none needed', linux: 'none needed' });
  }
  const start = 'node bin/gamesfun.mjs session wait   (in the background, in your agent session; or node bin/gamesfun.mjs connect, then /reload-plugins in Claude Code)';
  const st = probes.status ?? await bridgeStatus({ cwd: root, env });
  if (!st.running) return item('ok', `plugin whole, wait "${form}" (no shell needed: ${form === 'rewake' ? 'yes' : 'no'}); the studio is not running`, null);
  const liveSessions = (st.sessions ?? []).filter(s => s.state !== 'ended');
  if (!liveSessions.length) return item('warn', `the studio is running at ${st.url} and no agent session has reached it`, same(`have your session listen: ${start}`));
  const connected = liveSessions.filter(s => s.connected);
  if (!connected.length && liveSessions.every(s => s.state === 'idle')) return item('warn', `${liveSessions.length} session(s) known to the studio, none has its wait open: a request from the page will not wake it`, same(`press Enter once in the session's terminal (the next turn end starts the wait again); if it never opens, switch the wait: node bin/gamesfun.mjs doctor --bridge-wait ${form === 'rewake' ? 'monitor' : 'rewake'}`));
  return item('ok', `studio at ${st.url}; ${liveSessions.length} session(s), ${connected.length} with the wait open ("${form}")`);
}
