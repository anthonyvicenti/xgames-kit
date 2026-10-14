// The write guard: node guard.mjs   (a PreToolUse hook, exec form, no shell; Node's own modules only)
//
// The build loop keeps its own folder inside each game: <game>/.gf-loop/ (the state, the locked spec, the promises,
// the verdicts, the play-tester's brief and report, the checkpoints). The loop's tools write it; a session that edits
// it is editing the proof its game is checked against (seen on 2026-10-11: a session took a failing control out of
// the locked spec). The loop library notices and puts things back; this hook stops the write before it happens.
//
// Denied, with a reason that names the tool to use instead:
//   - Edit, Write, MultiEdit, NotebookEdit on a path under a `.gf-loop` folder. The play-tester subagent alone may
//     write its own `job/playtest/out/` and `job/playtest/runs/`.
//   - Bash (and PowerShell) when the command names a `.gf-loop` path and is not plainly a read. A command is let
//     through only when it can be shown to read (readOnlyShell below): every program in it is on a short list of
//     programs that only read (cat, head, tail, ls, grep, wc, jq …; Get-Content, Get-ChildItem, Select-String … in
//     PowerShell), and it has no redirect to a file, no variable, no command substitution, no brace or bracket and
//     none of the flags that make a reader write or run something (find -exec or -delete, sort -o, rg --pre).
//     Anything else that names the folder is refused, with the reason (reads used to be refused,
//     and a refused read teaches a session to work around the guard).
//   - Edit and Write on a game's own spec.json (the copy verify reads) while that game's run is building and its
//     spec is locked (the loop's state says so). A change run may still alter the plan in its change round: no lock yet.
//   - Edit and Write inside a game the person has just rolled back from the studio page, until the session has
//     called gamesfun_next (the mark <game>/.gf-loop/cancel.json; builder/lib/cancel.mjs).
//   - The play-tester is a black box. Its Read (and Grep and Glob, should it be given them) outside its own play-test
//     folder (<game>/.gf-loop/job/playtest/: the brief, the promises, its runs' screenshots) is denied: it never sees
//     the game's code, config or the kit.
//   - The play-test report is the play-tester's: gamesfun_playtest_report (the MCP tool, or a shell command that names
//     it) from anything that is not the playtester subagent is denied. The tool itself also takes a report only with
//     the round's one-time token (builder/mcp/tools/loop.mjs), which holds where this hook does not run (another agent).
//   - The second reader is a black box too: its Read outside the play-tester's runs (the screenshots) and its own
//     reading folder (<game>/.gf-loop/job/reader/) is denied, and gamesfun_reader_report is the reader subagent's alone.
//
// What this cannot stop, plainly: a command that builds the path when it runs (a variable, a glob such as `.gf-l*`,
// `cd` into the folder by another name, a script file that holds the path), a shell command that rewrites the game's
// own spec.json (a command that names spec.json is too often a read to refuse), a tool of another MCP server that
// writes files, and anything done outside the session. For those the loop's own checks stand (the library's lock, held in
// the MCP server's memory). A hook that fails (no node, a crash) decides nothing, by Claude Code's rule.
//
// Output form (https://code.claude.com/docs/en/hooks.md, read 2026-10-11): exit 0 with
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}
// and exit 0 with no output for "no decision". A subagent's tool calls run the same hook with `agent_type` set.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOOP_DIR = '.gf-loop';
export const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
export const SHELL_TOOLS = ['Bash', 'PowerShell'];
export const READ_TOOLS = ['Read', 'Grep', 'Glob'];
/** Where the play-tester subagent may write, under a game's .gf-loop/. */
export const PLAYTESTER_MAY = ['job/playtest/out/', 'job/playtest/runs/'];
/** Where the play-tester subagent may read, under a game's .gf-loop/: its own folder and nothing else. */
export const PLAYTESTER_READS = 'job/playtest/';
export const REPORT_TOOL = 'gamesfun_playtest_report';
const isPlaytester = type => /(^|:)playtester$/.test(String(type ?? ''));
/** The report tool by its MCP name (mcp__<server>__gamesfun_playtest_report), whatever the server is called. */
export const isReportTool = name => new RegExp(`^mcp__.+__${REPORT_TOOL}$`).test(String(name ?? ''));
/** The second reader: where it may read and write under a game's .gf-loop/, and its reading tool. */
export const READER_READS = ['job/playtest/runs/', 'job/reader/'];
export const READER_MAY = ['job/reader/out/', 'job/playtest/runs/'];
export const READING_TOOL = 'gamesfun_reader_report';
const isReader = type => /(^|:)reader$/.test(String(type ?? ''));
export const isReadingTool = name => new RegExp(`^mcp__.+__${READING_TOOL}$`).test(String(name ?? ''));

const WHY_FILE = 'The folder .gf-loop/ is the build loop\'s own (its state, the locked spec, the promises, the verdicts, the play-tester\'s brief and report): only the loop\'s tools write it, and the game is checked against the spec as it was locked. Change the game instead (rules.js, config, slots). If a part of the plan cannot be built, ask the person with the gamesfun_ask tool; gamesfun_next says what comes next.';
const WHY_SHELL = why => `A shell command that names a path under .gf-loop/ (the build loop's own folder) may only read it, and this one was not plainly a read: ${why}. Plain reads are let through (cat, head, tail, ls, grep, wc, jq; Get-Content, Get-ChildItem, Select-String), with no redirect to a file, no variable and no command substitution; or read the file with the Read tool. Nothing in that folder is yours to write. If a part of the plan cannot be built, ask the person with the gamesfun_ask tool; gamesfun_next says what comes next.`;
const WHY_SPEC = 'This game\'s spec is locked: it is the plan the person agreed to, and the game is verified and play-tested against it as locked. An edit passes no check and drops no promise (the loop puts the file back). Make the game do what the spec says (rules.js, config, slots). If a part of the plan cannot be built, or the person wants the plan changed, ask with the gamesfun_ask tool; a change to a delivered game starts with gamesfun_change.';
const WHY_PLAYTESTER_READ = 'You are the black-box play-tester: you read only your own folder (the PLAYTEST.md brief, promises.json and the screenshots under runs/), never the game\'s code, config, assets or the kit. Judge what your screen shows: play with gamesfun_play and read the screenshots it names.';
const WHY_REPORT = 'Only the playtester subagent reports on a play-test: start it with the message gamesfun_step_playtest gave you (gamesfun_next shows it again) and let it call gamesfun_playtest_report. Do not play-test or report on your own game.';
const WHY_READER_READ = 'You are the second reader: you read only the screenshots the play-tester kept (job/playtest/runs/) and your own folder, never the game\'s code, config, assets, the build\'s transcript or the kit. Judge what the screenshots show; play with gamesfun_play to see more.';
const WHY_READING = 'Only the reader subagent hands in a reading: start it with the message gamesfun_step_read gave you (gamesfun_next shows it again) and let it call gamesfun_reader_report. Do not read your own game for the record.';
const WHY_ROLLED_BACK = 'The person has just rolled this game back from the studio page, and the run that was under way is cancelled. Call the gamesfun_next tool first (it ends the run and says what the person did); do not put the undone changes back.';

/** The path after the last `.gf-loop` segment, with forward slashes, or null when the path is not under one. */
export function underLoopDir(file) {
  const parts = String(file).split(/[\\/]+/);
  const i = parts.lastIndexOf(LOOP_DIR);
  return i < 0 ? null : parts.slice(i + 1).join('/');
}
/** Does a command line name a `.gf-loop` path? Any quoting or separator around the name counts. */
export const namesLoopDir = command => /(^|[^A-Za-z0-9_-])\.gf-loop($|[^A-Za-z0-9_-])/.test(String(command ?? ''));

// ---------------------------------------------------------------- a shell command that only reads
// Programs that read and print and do nothing else, on the three systems. Names are compared in lower case, bare (no
// folder in front: `./cat` is not `cat`). A program that can write or run something with the right flag is here only
// with that flag refused (UNSAFE_ARGS); one that is too wide to judge (sed, awk, tee, xargs, node, python, git, less,
// PowerShell's ForEach-Object and Where-Object) is left out, and the command is refused.
export const READ_PROGRAMS = new Set([
  // POSIX shells (and Git Bash on Windows)
  'cat', 'head', 'tail', 'ls', 'dir', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'find', 'stat', 'jq', 'sort', 'uniq', 'cut', 'tr', 'nl', 'tac', 'diff', 'cmp', 'du',
  'od', 'hexdump', 'sha256sum', 'sha1sum', 'md5sum', 'shasum', 'basename', 'dirname', 'realpath', 'readlink', 'pwd', 'cd', 'echo', 'printf', 'test', '[', 'true', 'false', 'date', 'column',
  // cmd and PowerShell
  'type', 'findstr', 'get-content', 'gc', 'get-childitem', 'gci', 'select-string', 'sls', 'get-item', 'gi', 'test-path', 'get-filehash', 'resolve-path',
  'measure-object', 'select-object', 'sort-object', 'convertfrom-json', 'format-list', 'fl', 'format-table', 'ft', 'out-string', 'write-output', 'get-location', 'set-location', 'get-date',
]);
/** Per program: an argument that makes it write a file or run another program. */
const UNSAFE_ARGS = {
  find: a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a),
  // sort: -o writes, --compress-program runs one; only the plain short ordering flags are let through
  sort: a => a.startsWith('-') && !/^-[bdfgiMhnRrVsuzkt0-9.,]+$/.test(a),
  rg: a => /^--(pre|hostname-bin)(=|$)/.test(a),
  date: a => /^(-s|--set)/.test(a),
};
/** Redirects that write no file: they are taken out before the command is judged. */
const HARMLESS_REDIRECT = /(^|\s)(2>&1|[12&]?>\s?\/dev\/null)(?=$|\s)/g;

/**
 * Is this shell command plainly a read? → null when it is, else why not (a short phrase for the session).
 * Deliberately narrow: a command it cannot follow is "not plainly a read", never a guess. It reads bash and PowerShell
 * alike, so what means different things in the two (a backslash before a quote, a backtick) is refused outright.
 */
export function readOnlyShell(command) {
  const text = String(command ?? '');
  // 1. split into words, keeping what was quoted apart from what was not
  const segments = [[]];
  let word = null, quote = null;
  const push = () => { if (word !== null) { segments.at(-1).push(word); word = null; } };
  const bare = [];        // the unquoted text, for the checks below
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      if (quote === '"' && (c === '$' || c === '`')) return 'it has a variable or a command inside double quotes';
      if (quote === '"' && c === '\\' && text[i + 1] === '"') return 'it has an escaped quote, which bash and PowerShell read differently';
      word = (word ?? '') + c;
      continue;
    }
    if (c === '\\' && (text[i + 1] === '"' || text[i + 1] === '\'')) return 'it has an escaped quote, which bash and PowerShell read differently';
    if (c === '"' || c === '\'') { quote = c; word ??= ''; continue; }
    const two = c + (text[i + 1] ?? '');
    if (two === '&&' || two === '||' || two === '|&') { push(); segments.push([]); bare.push(' '); i++; continue; }
    if (c === '\n' || c === ';' || c === '|') { push(); segments.push([]); bare.push(' '); continue; }
    bare.push(c);
    if (/\s/.test(c)) { push(); continue; }
    word = (word ?? '') + c;
  }
  if (quote) return 'a quote is not closed';
  push();
  // 2. nothing outside quotes that writes, substitutes or groups
  const open = bare.join('').replace(HARMLESS_REDIRECT, '$1');
  const bad = /[<>]/.test(open) ? 'it redirects to or from a file' : /[$`]/.test(open) ? 'it has a variable or a command substitution' : /[(){}]/.test(open) ? 'it has a bracket or a brace' : /&/.test(open) ? 'it starts something in the background' : null;
  if (bad) return bad;
  // 3. every program is one that only reads, without the flags that make it write or run something
  const redirect = w => /^(2>&1|[12&]?>(\/dev\/null)?|\/dev\/null)$/.test(w);
  for (const seg of segments) {
    const words = seg.filter(w => !redirect(w));
    if (!words.length) continue;
    const prog = words[0].toLowerCase();
    if (!READ_PROGRAMS.has(prog)) return `"${words[0].slice(0, 40)}" is not on the list of programs that only read`;
    const unsafe = UNSAFE_ARGS[prog];
    const hit = unsafe ? words.slice(1).find(a => unsafe(a)) : null;
    if (hit) return `"${prog} ${hit.slice(0, 30)}" can write a file or run a program`;
    if (prog === 'uniq' && words.slice(1).filter(a => !a.startsWith('-')).length > 1) return '"uniq" with two files writes the second';
  }
  return null;
}

/** The game folder a file is in when that game has a roll-back mark waiting, else null. */
export function rolledBackGame(file, exists = existsSync) {
  let d = path.dirname(path.resolve(file));
  for (let n = 0; n < 40; n++) {
    if (exists(path.join(d, LOOP_DIR, 'cancel.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** Is this file the spec of a game whose run is building with its spec locked? (the loop's state file says) */
export function lockedSpec(file, read = f => readFileSync(f, 'utf8')) {
  if (path.basename(file) !== 'spec.json') return false;
  try { const s = JSON.parse(read(path.join(path.dirname(file), LOOP_DIR, 'state.json'))); return s?.status === 'building' && !!s.lock; } catch { return false; }
}

/** → the reason to deny this tool call, or null (no decision: the session's own permission flow goes on). */
export function decide(input, { exists = existsSync } = {}) {
  const tool = input?.tool_name, ti = input?.tool_input ?? {}, playtester = isPlaytester(input?.agent_type), reader = isReader(input?.agent_type);
  if (isReportTool(tool)) return playtester ? null : WHY_REPORT;
  if (isReadingTool(tool)) return reader ? null : WHY_READING;
  if (READ_TOOLS.includes(tool)) {
    if (!playtester && !reader) return null;
    const raw = ti.file_path ?? ti.path ?? null;
    const target = path.resolve(input.cwd ?? process.cwd(), typeof raw === 'string' && raw ? raw : '.');
    const rel = underLoopDir(target), ok = rel !== null && !rel.split('/').includes('..');
    if (reader) return ok && READER_READS.some(d => (rel + '/').startsWith(d)) ? null : WHY_READER_READ;
    return ok && (rel + '/').startsWith(PLAYTESTER_READS) ? null : WHY_PLAYTESTER_READ;
  }
  if (SHELL_TOOLS.includes(tool)) {
    if (!playtester && String(ti.command ?? '').includes(REPORT_TOOL)) return WHY_REPORT;
    if (!reader && String(ti.command ?? '').includes(READING_TOOL)) return WHY_READING;
    if (!namesLoopDir(ti.command)) return null;
    const why = readOnlyShell(ti.command);
    return why ? WHY_SHELL(why) : null;
  }
  if (!FILE_TOOLS.includes(tool)) return null;
  const raw = ti.file_path ?? ti.notebook_path ?? ti.path;
  if (typeof raw !== 'string' || !raw) return null;
  const file = path.resolve(input.cwd ?? process.cwd(), raw);
  const rel = underLoopDir(file);
  if (rel !== null) {
    if (playtester && PLAYTESTER_MAY.some(dir => rel.startsWith(dir)) && !rel.split('/').includes('..')) return null;
    if (reader && READER_MAY.some(dir => rel.startsWith(dir)) && !rel.split('/').includes('..')) return null;
    return WHY_FILE;
  }
  if (lockedSpec(file)) return WHY_SPEC;
  return rolledBackGame(file, exists) ? WHY_ROLLED_BACK : null;
}

async function main() {
  let text = '';
  try { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) text += c; } catch { /* no input: no decision */ }
  let input = null;
  try { input = JSON.parse(text); } catch { /* not ours to judge */ }
  const reason = input ? decide(input) : null;
  if (reason) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  process.exit(0);
}
// run as the hook (not imported by a test): the two paths are compared through any link an install may have made
const real = p => { try { return realpathSync(p); } catch { return path.resolve(p); } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await main();
