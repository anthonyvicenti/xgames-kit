// One hook of the person's session, handed to the local studio: node hook.mjs <Event>   (exec form, no shell)
// Reads the event from stdin, posts it to the running studio and prints the studio's answer, which is already in
// the hook's own output form (an approval's decision, a refused stop). The studio is optional: with none running,
// or any failure, this exits 0 with no output and the session goes on as if the plugin were not there.
import { findRun, post, readInput } from './lib.mjs';

const event = process.argv[2] ?? '';
const input = await readInput();
// what the page never needs: the tool's output (can be large) and where the transcript is
delete input.tool_response;
delete input.transcript_path;
// an approval waits for the person's click (the hook's own timeout is 300 s); everything else is quick
const timeoutMs = event === 'PermissionRequest' ? 250_000 : 8000;
try {
  let run = await findRun({ cwd: input.cwd });
  if (run) {
    let res = await post(run, `/api/session/hook/${event}`, input, { timeoutMs });
    if (res.status === 401) {   // the studio restarted with a new token between the read and the post
      run = await findRun({ cwd: input.cwd });
      if (run) res = await post(run, `/api/session/hook/${event}`, input, { timeoutMs });
    }
    if (res.status === 200 && res.text.trim()) process.stdout.write(res.text);
  }
} catch { /* never hold a session because the page is closed */ }
process.exit(0);
