// Test harness only, never product code (Linux and macOS: it needs `script` for a terminal; Windows has none, so the
// live proof there is by hand: tests/bridge-live/README.md).
// Starts the tester's OWN Claude Code, interactive, in a scratch project folder with the kit's plugin loaded, and
// exposes its terminal on a local port so a test can type. It passes no permission-skipping flag, reads no credential
// and touches no setting of this machine: the child signs in the way `claude` always does for the person here, and
// loads only the scratch project's own settings.
//
//   node tests/bridge-live/child.mjs <scratch-project-dir> --port <n> [--model haiku] [--game <dir>]
//   node tests/bridge-live/child.mjs <folder> --port <n> --plain [--model haiku]
//     --plain: the end-to-end proof. A session as a person starts it: no plugin flag, no fixture server, and no
//     settings written here. Whatever the folder's own project and local settings name is loaded (what `gamesfun
//     connect` registered through the agent's own commands), and nothing else of this machine's.
//   POST /type   {"text":"hello"}      types the text and presses Enter
//   POST /keys   {"keys":"\r"}         raw keys
//   GET  /screen                       the last 4000 characters, colours removed
//   POST /stop                         ends the child and this process
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const kit = path.resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const project = path.resolve(args[0]);
const model = opt('--model', 'haiku');
const PORT = Number(opt('--port', 5912));
const game = path.resolve(opt('--game', path.join(project, 'game')));
const plain = args.includes('--plain');
const debugLog = path.resolve(opt('--debug-file', path.join(project, 'debug.log')));

const q = s => `'${s.replaceAll("'", "'\\''")}'`;
mkdirSync(project, { recursive: true });
let cmd;
if (plain) {
  cmd = ['stty rows 50 cols 150;', 'claude', '--model', model, '--permission-mode', 'default', '--setting-sources', 'project,local', '--debug-file', q(debugLog)].join(' ');
} else {
  mkdirSync(path.join(project, '.claude'), { recursive: true });
  // The scratch project allows only the two fixture tools, so everything else still asks (the approvals test needs that).
  writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['mcp__gamesfun__gamesfun_requests', 'mcp__gamesfun__gamesfun_next'] } }, null, 2) + '\n');
  const mcp = path.join(project, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { gamesfun: { command: process.execPath, args: [path.join(here, 'mcp-fixture.mjs')], env: { GF_FIXTURE_GAME: game } } } }, null, 2) + '\n');
  cmd = ['stty rows 50 cols 150;', 'claude', '--model', model, '--strict-mcp-config', '--mcp-config', q(mcp), '--permission-mode', 'default', '--setting-sources', 'project,local',
    '--plugin-dir', q(path.join(kit, 'plugin')), '--debug-file', q(debugLog)].join(' ');
}

// A fresh session, not a child of whatever session ran this script.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
env.TERM = 'xterm-256color';
const child = spawn('script', ['-qfc', cmd, '/dev/null'], { cwd: project, env, stdio: ['pipe', 'pipe', 'inherit'] });
let screen = '';
child.stdout.on('data', d => { screen = (screen + d.toString('utf8')).slice(-200_000); });
child.on('exit', code => { console.log(`child exited ${code}`); process.exit(0); });

const strip = s => s.replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, m => (/[HfABCDGd]$/.test(m) ? ' ' : '')).replace(/\x1b[()][A-Za-z0-9]|\x1b[=>]/g, '').replace(/[ \t]+/g, ' ');
const body = async req => { let t = ''; for await (const c of req) t += c; return t ? JSON.parse(t) : {}; };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/screen') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(strip(screen).slice(-Number(url.searchParams.get('n') || 4000)));
  }
  if (req.method === 'POST' && url.pathname === '/type') {
    const { text } = await body(req);
    child.stdin.write(text);
    setTimeout(() => child.stdin.write('\r'), 400);   // let the input box take the paste first
    return res.end('ok\n');
  }
  if (req.method === 'POST' && url.pathname === '/keys') { child.stdin.write((await body(req)).keys); return res.end('ok\n'); }
  if (req.method === 'POST' && url.pathname === '/stop') { res.end('ok\n'); child.stdin.write('\x03'); setTimeout(() => child.stdin.write('\x03'), 300); setTimeout(() => { child.kill(); process.exit(0); }, 2500); return; }
  res.writeHead(404); res.end();
}).listen(PORT, '127.0.0.1', () => console.log(`child terminal on http://127.0.0.1:${PORT} pid ${process.pid} project ${project}`));
