// The wait the session keeps: it holds a connection to the local studio and hands the page's requests to the session.
//
//   node wait.mjs [--max <seconds>]     the default: an asyncRewake hook on SessionStart and Stop. One batch of
//                                       requests on stderr, exit code 2, which wakes the session even when idle.
//   node wait.mjs --monitor             the fallback: a plugin monitor. One line per batch on stdout, for ever.
//
// Only the form the studio is set to (`wait` in the run file) connects; the other stays quiet. With no studio running
// it looks again every few seconds, so the order of starting things does not matter, and it reconnects by itself when
// the studio restarts. It ends by itself when the session is gone, when a newer wait took over, or after --max
// seconds (just before the hook's own timeout would kill it without a word).
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { alive, findRun, readInput, sleep } from './lib.mjs';

const args = process.argv.slice(2);
const monitor = args.includes('--monitor');
const form = monitor ? 'monitor' : 'rewake';
const max = Number(args[args.indexOf('--max') + 1]) || 0;
const started = Date.now();
const input = monitor ? {} : await readInput();
const session = input.session_id ?? '';
const cwd = input.cwd ?? process.cwd();

// The session is gone when our parent is. macOS and Linux: an orphan gets a new parent id. Windows: the parent id
// stays, so ask whether that process still exists.
const parent = process.ppid;
const orphaned = () => process.ppid !== parent || !alive(parent);
// One wait per session, also while no studio is running (the Stop hook starts a new one at every turn end, and with
// no server there is nobody to tell the older one it was replaced): the newest writes its process id to a small file
// in the system's temporary folder (os.tmpdir(): the same call on Windows, macOS and Linux), and an older one that
// reads another id there ends.
const mark = !monitor && session ? path.join(os.tmpdir(), `gamesfun-wait-${session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.pid`) : null;
if (mark) { try { writeFileSync(mark, String(process.pid)); } catch { /* no temporary folder: the studio still replaces an older wait */ } }
const replaced = () => { if (!mark) return false; try { return readFileSync(mark, 'utf8').trim() !== String(process.pid); } catch { return false; } };
process.on('exit', () => { if (mark && !replaced()) { try { rmSync(mark, { force: true }); } catch { /* fine */ } } });
// a stop from outside is an ordinary end (so the file above is removed). Windows knows SIGINT and SIGTERM only by name.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { try { process.on(sig, () => process.exit(0)); } catch { /* not on this system */ } }
const over = () => (max > 0 && Date.now() - started > max * 1000) || orphaned() || replaced();
setInterval(() => { if (over()) process.exit(0); }, 5000).unref();

/** One connection. → 'again' (look for the studio again) or never returns (the process exits). */
function connect(run) {
  return new Promise(resolve => {
    const q = new URLSearchParams({ form, cwd, ...(session ? { session } : {}) });
    const req = http.get(new URL(`/api/session/wait?${q}`, run.url), { headers: { 'x-gamesfun-token': run.token } }, res => {
      if (res.statusCode !== 200) { res.resume(); return resolve('again'); }
      res.setEncoding('utf8');
      let buf = '';
      // the studio writes a blank line every 25 s; silence for 70 s means it is gone
      res.setTimeout(70_000, () => req.destroy());
      res.on('data', chunk => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'requests') {
            if (monitor) console.log(String(msg.text).replaceAll('\n', '  '));
            else { process.stderr.write(msg.text + '\n', () => process.exit(2)); return; }
          } else if (msg.type === 'superseded' || msg.type === 'ended') process.exit(0);
        }
      });
      res.on('end', () => resolve('again'));
      res.on('error', () => resolve('again'));
    });
    req.on('error', () => resolve('again'));
  });
}

for (;;) {
  if (over()) process.exit(0);
  let run = null;
  try { run = await findRun({ cwd }); } catch { /* look again */ }
  if (run && (run.wait ?? 'rewake') === form) await connect(run);
  await sleep(run ? 2000 : 4000);
}
