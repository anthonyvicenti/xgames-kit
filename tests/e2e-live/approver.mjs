// Test harness only (the end-to-end proof, tests/e2e-live/README.md). Stands in for the person at the terminal of a
// child session started by tests/bridge-live/child.mjs: it reads each permission question the session shows and
// answers it with a key, as a person would, and writes down every question and answer. It passes no flag to the
// agent and changes no setting: the session stays in its default permission mode and asks every time.
//
//   node tests/e2e-live/approver.mjs <child terminal url> <log file>
//
// It answers "1" (yes, once) to a shell command, and "2" (yes, and do not ask again for this) to a file edit or one
// of this kit's own tools, when the question offers it. It never picks an option that changes the permission mode.
// A question that matches HOLD is left for the person running the proof (the log says HELD). While the file
// <log file>.pause exists it answers nothing: the proof's page steps answer those questions from the studio page.
import { appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const [url, logFile] = process.argv.slice(2);
const HOLD = /\bsudo\b|rm\s+-rf?\s+[~/]|\.claude\.json|credential|\.ssh\b|\bpkill\b|\bkillall\b|git\s+push|--dangerously|settings\.json|curl\s+(?!.*(127\.0\.0\.1|localhost))/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = line => appendFile(logFile, `${new Date().toISOString()} ${line}\n`);
let lastTail = '', lastAt = 0;

for (;;) {
  await sleep(1200);
  if (existsSync(`${logFile}.pause`)) continue;
  let screen;
  try { screen = await (await fetch(`${url}/screen?n=200000`)).text(); } catch { continue; }
  // The terminal is read as a stream, not a screen: a question stays open while only a spinner is redrawn after it
  // (blank lines and one glyph), and is over once anything else was printed after its last line.
  const foot = screen.lastIndexOf('Esc to cancel');
  const asked = screen.lastIndexOf('Do you want');
  if (foot < 0 || asked < 0 || asked > foot || foot - asked > 1500) continue;
  const after = screen.slice(foot).replace(/^Esc to cancel[^\n]*/, '').replace(/\b\d+ of \d+\b/g, '').replace(/[\s●○◐◑◒◓✶✻✽✢✳·*]/g, '');
  if (after.length > 12) continue;
  const tail = screen.slice(Math.max(0, asked - 300), foot);
  if (tail === lastTail && Date.now() - lastAt < 20000) continue;   // the same question: give the key time to land
  const at = asked;
  const from = Math.max(screen.lastIndexOf('●', at), at - 2500);
  const question = screen.slice(from).replace(/[╌─]{5,}/g, '').replace(/\s+/g, ' ').trim();
  const options = screen.slice(at);
  if (HOLD.test(question)) { if (lastTail !== tail) await log(`HELD ${JSON.stringify(question.slice(0, 900))}`); lastTail = tail; continue; }
  const two = /2\. Yes, (and don.t ask again|allow all edits|and always allow)/.test(options) && !/2\. Yes, and switch to auto/.test(options);
  const shell = /Bash command|Bash\(/.test(question);
  const key = !shell && two ? '2' : '1';
  await fetch(`${url}/keys`, { method: 'POST', body: JSON.stringify({ keys: key }) });
  await log(`ANSWER ${key} ${JSON.stringify(question.slice(0, 900))}`);
  lastTail = tail; lastAt = Date.now();
}
