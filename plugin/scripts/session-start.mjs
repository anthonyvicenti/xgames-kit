// The SessionStart hook: node session-start.mjs   (exec form, no shell)
// Tells the studio a session started, then prints the protocol: plain output of a SessionStart hook is added to the
// session's context. With no studio running it prints nothing.
import { findRun, post, protocolWords, readInput } from './lib.mjs';

const input = await readInput();
delete input.transcript_path;
let run = null;
try {
  run = await findRun({ cwd: input.cwd });
  if (run) await post(run, '/api/session/hook/SessionStart', input, { timeoutMs: 3000 });
} catch { run = null; }
if (run) console.log(protocolWords(run.url, input.session_id, { kit: run.kit ?? null }));
process.exit(0);
