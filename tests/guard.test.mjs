// The plugin's write guard (plugin/scripts/guard.mjs): what it denies, what it lets through, and what it cannot
// stop. The decision is tested as a function and as the real process Claude Code starts (node, stdin, stdout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CANCEL_FILE } from '../builder/lib/cancel.mjs';
import { CANCEL_FILE as BRIDGE_CANCEL_FILE } from '../builder/bridge/loop-state.mjs';
import { KIT_ROOT } from '../builder/lib/paths.mjs';
import { decide, namesLoopDir, readOnlyShell, READ_PROGRAMS, underLoopDir } from '../plugin/scripts/guard.mjs';

const SCRIPT = path.join(KIT_ROOT, 'plugin', 'scripts', 'guard.mjs');
const cwd = path.join(os.tmpdir(), 'kit');
const call = (tool_name, tool_input, more = {}) => ({ hook_event_name: 'PreToolUse', session_id: 's', cwd, tool_name, tool_input, ...more });
const run = input => new Promise((resolve, reject) => {
  const c = spawn(process.execPath, [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let out = '';
  c.stdout.on('data', d => { out += d; });
  c.on('error', reject);
  c.on('close', code => resolve({ code, out }));
  c.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
});

test('denied: Edit and Write under a .gf-loop folder, in every spelling of the path', () => {
  for (const file of ['games/a/.gf-loop/job/spec.json', path.join(cwd, 'games', 'a', '.gf-loop', 'state.json'), 'games\\a\\.gf-loop\\job\\promises.json', 'games/a/x/../.gf-loop/job/playtest/PLAYTEST.md', '.gf-loop/state.json', 'games/a/.gf-loop/job/playtest/out/playtest.json']) {
    for (const tool of ['Edit', 'Write', 'MultiEdit']) assert.match(decide(call(tool, { file_path: file })) ?? '', /gamesfun_ask/, `${tool} ${file}`);
  }
  assert.match(decide(call('NotebookEdit', { notebook_path: 'games/a/.gf-loop/x.ipynb' })), /gamesfun_ask/);
  assert.equal(underLoopDir('games/a/.gf-loop/job/spec.json'), 'job/spec.json');
  assert.equal(underLoopDir('games/a/rules.js'), null);
});

test('let through: the game\'s own files, a name that only looks alike, and tools that write nothing', () => {
  for (const file of ['games/a/rules.js', 'games/a/config/game.json', 'games/a/spec.json', 'games/a/.gf-loopy/x', 'notes/gf-loop.md']) assert.equal(decide(call('Write', { file_path: file })), null, file);
  assert.equal(decide(call('Read', { file_path: 'games/a/.gf-loop/state.json' })), null, 'reading is not writing');
  assert.equal(decide(call('mcp__gamesfun__gamesfun_step_fix', { game: 'games/a' })), null);
  assert.equal(decide(call('Write', {})), null);
});

test('denied: a shell command that names a .gf-loop path and is not plainly a read', () => {
  for (const command of [
    'echo "{}" > games/a/.gf-loop/state.json', 'sed -i s/KeyE// games/a/.gf-loop/job/spec.json', 'rm -rf games/a/.gf-loop',
    'cd games/a/.gf-loop && echo x > state.json', 'node -e "require(\'fs\').writeFileSync(\'games/a/.gf-loop/job/spec.json\',\'{}\')"', 'cp /tmp/s.json "games/a/.gf-loop/job/spec.json"', 'python3 -c "open(\'.gf-loop/state.json\',\'w\')"',
    'Set-Content games\\a\\.gf-loop\\state.json "{}"',
    // a reader in front of a writer, and a reader made to write or run something
    'cat games/a/.gf-loop/state.json | tee games/a/.gf-loop/state.json', 'cat games/a/.gf-loop/state.json >> games/a/.gf-loop/job/spec.json', 'cat /tmp/s.json >games/a/.gf-loop/job/spec.json',
    'find games/a/.gf-loop -name "*.json" -delete', 'find games/a/.gf-loop -type f -exec rm {} +', 'sort -o games/a/.gf-loop/state.json /tmp/x', 'sort --output=games/a/.gf-loop/state.json /tmp/x', 'sort --compress-program=/tmp/x games/a/.gf-loop/state.json',
    'uniq /tmp/x games/a/.gf-loop/state.json', 'rg --pre /tmp/x.sh lock games/a/.gf-loop', 'cd games/a/.gf-loop; mv job/spec.json /tmp/', 'cd games/a/.gf-loop\nrm state.json', 'ls games/a/.gf-loop && rm games/a/rules.js',
    // what the guard cannot follow is refused, never guessed
    'cat $(echo games/a/.gf-loop/state.json)', 'cat `echo games/a/.gf-loop/state.json`', 'cat "$HOME/games/a/.gf-loop/state.json"', 'X=1 cat games/a/.gf-loop/state.json', 'cat games/a/.gf-loop/{state,x}.json', '(cat games/a/.gf-loop/state.json)',
    'cat games/a/.gf-loop/state.json &', 'cat \\"a > games/a/.gf-loop/state.json \\"', './cat games/a/.gf-loop/state.json', '/tmp/cat games/a/.gf-loop/state.json', 'env cat games/a/.gf-loop/state.json', 'cat "games/a/.gf-loop/state.json',
    'cat games/a/.gf-loop/state.json 2>games/a/.gf-loop/job/spec.json', 'cat games/a/.gf-loop/state.json 2>/dev/nullx', 'cat < games/a/.gf-loop/state.json', 'less games/a/.gf-loop/state.json', 'awk 1 games/a/.gf-loop/state.json', 'xargs cat games/a/.gf-loop/state.json',
    'Get-Content games\\a\\.gf-loop\\state.json | Set-Content games\\a\\.gf-loop\\state.json', 'Get-Content games\\a\\.gf-loop\\state.json | Out-File x.json', 'Get-ChildItem games\\a\\.gf-loop | ForEach-Object { Remove-Item $_ }', '(Get-Content games\\a\\.gf-loop\\state.json).Length',
    '[IO.File]::WriteAllText("games/a/.gf-loop/state.json", "{}")', 'Remove-Item -Recurse games\\a\\.gf-loop',
  ]) for (const tool of ['Bash', 'PowerShell']) assert.match(decide(call(tool, { command })) ?? '', /gamesfun_ask/, command);
  for (const command of ['npm test', 'ls games/a', 'node bin/gamesfun.mjs verify games/a --quick', 'git status', 'echo .gf-loopy', 'rm -rf games/a']) assert.equal(decide(call('Bash', { command })), null, command);
  assert.equal(namesLoopDir(undefined), false);
  // the refusal says why, so the session can see it was the form and not the read
  assert.match(decide(call('Bash', { command: 'cat games/a/.gf-loop/state.json > /tmp/x' })), /redirects to or from a file/);
  assert.match(decide(call('Bash', { command: 'sed -n 1p games/a/.gf-loop/state.json' })), /"sed" is not on the list of programs that only read/);
});

test('let through: a shell command that only reads under .gf-loop (question 28, decided 2026-10-11)', () => {
  for (const command of [
    'cat games/a/.gf-loop/state.json', 'head -n 20 games/a/.gf-loop/job/spec.json', 'tail -5 "games/a/.gf-loop/job/rounds/round-1.md"', 'ls -la games/a/.gf-loop', 'ls games/a/.gf-loop/job/out/verify-1/',
    'wc -l games/a/.gf-loop/job/promises.json', 'grep -n "KeyE" games/a/.gf-loop/job/spec.json', 'grep -rn \'"ok": false\' games/a/.gf-loop/job/out', 'rg lock games/a/.gf-loop', 'find games/a/.gf-loop -name "verdict.json"', 'find games/a/.gf-loop -type f -newer games/a/rules.js -print',
    'jq .status games/a/.gf-loop/state.json', 'jq \'{step, status, why: .why}\' games/a/.gf-loop/state.json', 'jq -r \'.checks[] | select(.ok == false) | "\\(.n) \\(.name)"\' games/a/.gf-loop/job/out/verify-1/verdict.json',
    'cat games/a/.gf-loop/state.json | jq .step', 'cat games/a/.gf-loop/state.json 2>/dev/null', 'ls games/a/.gf-loop 2>&1 | head -3', 'cat games/a/.gf-loop/state.json > /dev/null', 'grep -c ok games/a/.gf-loop/job/out/verify-1/verdict.json || echo none',
    'cd games/a/.gf-loop && ls && cat state.json', 'cd games/a/.gf-loop; cat state.json', 'ls games/a/.gf-loop/checkpoints | sort -r | uniq -c | head', 'diff games/a/.gf-loop/job/spec.json games/a/spec.json', 'stat games/a/.gf-loop/state.json', 'sha256sum games/a/.gf-loop/job/spec.json',
    'test -f games/a/.gf-loop/cancel.json && echo yes', '[ -d games/a/.gf-loop ] && echo there', 'du -sh games/a/.gf-loop', 'cat games/a/.gf-loop/state.json\nls games/a',
    'Get-Content games\\a\\.gf-loop\\state.json', 'gc games\\a\\.gf-loop\\state.json | ConvertFrom-Json | Select-Object -Property step, status', 'Get-ChildItem -Recurse games\\a\\.gf-loop | Select-Object -First 5', 'Select-String -Path games\\a\\.gf-loop\\job\\spec.json -Pattern KeyE',
    'Test-Path games\\a\\.gf-loop\\cancel.json', 'Get-FileHash games\\a\\.gf-loop\\job\\spec.json', 'type games\\a\\.gf-loop\\state.json', 'dir games\\a\\.gf-loop',
  ]) for (const tool of ['Bash', 'PowerShell']) assert.equal(decide(call(tool, { command })), null, command);
  assert.equal(readOnlyShell('cat a | jq .'), null);
  assert.match(readOnlyShell('cat a | tee b'), /"tee" is not on the list/);
  for (const p of ['sed', 'awk', 'tee', 'xargs', 'node', 'python3', 'git', 'less', 'more', 'cp', 'mv', 'rm', 'touch', 'foreach-object', 'where-object', 'set-content', 'out-file']) assert.equal(READ_PROGRAMS.has(p), false, p);
});

test('what it cannot stop: a command that builds the path when it runs (said plainly; the loop\'s own lock stands for these)', () => {
  for (const command of ['d=.gf-; echo x > games/a/${d}loop/state.json', 'echo x > games/a/.gf-l*/state.json', 'cd games/a && cd .gf-* && echo x > state.json', 'node scratch/edit-the-spec.js', 'printf \'%s\' .gf -loop | tr -d " "']) {
    assert.equal(decide(call('Bash', { command })), null, command);
  }
});

test('the play-tester subagent may write its own out/ and runs/, and nothing else under .gf-loop', () => {
  for (const agent_type of ['playtester', 'gamesfun:playtester']) {
    assert.equal(decide(call('Write', { file_path: 'games/a/.gf-loop/job/playtest/out/playtest.json' }, { agent_type })), null);
    assert.equal(decide(call('Write', { file_path: 'games/a/.gf-loop/job/playtest/runs/first/01.jpg' }, { agent_type })), null);
    for (const file of ['games/a/.gf-loop/job/playtest/PLAYTEST.md', 'games/a/.gf-loop/job/playtest/promises.json', 'games/a/.gf-loop/job/spec.json', 'games/a/.gf-loop/state.json', 'games/a/.gf-loop/job/playtest/out/../../spec.json']) {
      assert.match(decide(call('Write', { file_path: file }, { agent_type })) ?? '', /gamesfun_ask/, file);
    }
    assert.match(decide(call('Bash', { command: 'echo x > games/a/.gf-loop/job/playtest/out/playtest.json' }, { agent_type })), /Read tool/);
  }
  // the main session, and any other subagent, may not write the report
  assert.match(decide(call('Write', { file_path: 'games/a/.gf-loop/job/playtest/out/playtest.json' })), /gamesfun_ask/);
  assert.match(decide(call('Write', { file_path: 'games/a/.gf-loop/job/playtest/out/playtest.json' }, { agent_type: 'general-purpose' })), /gamesfun_ask/);
});

test('a game the person just rolled back: an edit is refused until gamesfun_next has been called', async t => {
  assert.deepEqual(CANCEL_FILE, BRIDGE_CANCEL_FILE, 'the writer and the bridge\'s reader name the same file');
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'games', 'a');
  await mkdir(path.join(game, 'config'), { recursive: true });
  assert.equal(decide(call('Edit', { file_path: path.join(game, 'rules.js') })), null);
  await mkdir(path.join(game, CANCEL_FILE[0]), { recursive: true });
  await writeFile(path.join(game, ...CANCEL_FILE), '{}');
  assert.match(decide(call('Edit', { file_path: path.join(game, 'rules.js') })), /rolled this game back.*gamesfun_next/s);
  assert.match(decide(call('Write', { file_path: path.join(game, 'config', 'game.json') })), /gamesfun_next/);
  assert.equal(decide(call('Write', { file_path: path.join(root, 'games', 'b', 'rules.js') })), null, 'another game is not held');
});

test('the game\'s own spec.json is refused while its run is building with the spec locked (seen live: the hook let that edit through)', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gf-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const game = path.join(root, 'games', 'a'), spec = path.join(game, 'spec.json'), state = path.join(game, '.gf-loop', 'state.json');
  await mkdir(path.dirname(state), { recursive: true });
  assert.equal(decide(call('Edit', { file_path: spec })), null, 'no run: the game is the person\'s');
  await writeFile(state, JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status: 'building', step: 'playtest', lock: { spec: { sha: 'x' } } }));
  assert.match(decide(call('Edit', { file_path: spec })), /spec is locked.*gamesfun_ask/s);
  assert.match(decide(call('Write', { file_path: spec })), /spec is locked/);
  assert.equal(decide(call('Edit', { file_path: path.join(game, 'config', 'spec.json') })), null, 'only the game\'s own spec');
  assert.equal(decide(call('Edit', { file_path: path.join(game, 'rules.js') })), null);
  // a change run before its round is over has no lock yet: the plan may change there; a delivered game is the person's again
  await writeFile(state, JSON.stringify({ schema: 'gf-loop/1', kind: 'change', status: 'building', step: 'agent', lock: null }));
  assert.equal(decide(call('Edit', { file_path: spec })), null);
  await writeFile(state, JSON.stringify({ schema: 'gf-loop/1', kind: 'build', status: 'delivered', step: 'done', lock: { spec: { sha: 'x' } } }));
  assert.equal(decide(call('Edit', { file_path: spec })), null);
  // not stopped: a shell command on that file (the loop's lock puts it back)
  assert.equal(decide(call('Bash', { command: `sed -i s/interact// ${spec}` })), null);
});

test('as the process Claude Code starts: a deny is JSON in the PreToolUse form on stdout, exit 0; no decision is silence', async () => {
  let r = await run(call('Write', { file_path: 'games/a/.gf-loop/job/spec.json', content: '{}' }));
  assert.equal(r.code, 0);
  const out = JSON.parse(r.out);
  assert.deepEqual(Object.keys(out), ['hookSpecificOutput']);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse'); assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /gamesfun_ask/);
  r = await run(call('Bash', { command: 'sed -i s/x/y/ games/a/.gf-loop/job/spec.json' }));
  assert.equal(JSON.parse(r.out).hookSpecificOutput.permissionDecision, 'deny');
  for (const input of [call('Write', { file_path: 'games/a/rules.js' }), call('Bash', { command: 'npm test' }), 'not json', '']) {
    r = await run(input);
    assert.deepEqual([r.code, r.out], [0, '']);
  }
});

test('the play-tester is a black box: it reads only its own play-test folder; the report tool is its alone', () => {
  const pt = { agent_type: 'gamesfun:playtester' };
  const own = ['games/a/.gf-loop/job/playtest/PLAYTEST.md', 'games/a/.gf-loop/job/playtest/promises.json', path.join(cwd, 'games', 'a', '.gf-loop', 'job', 'playtest', 'runs', 'first', '01-look.jpg')];
  for (const file of own) assert.equal(decide(call('Read', { file_path: file }, pt)), null, file);
  for (const file of ['games/a/rules.js', 'games/a/config/game.json', 'games/a/.gf-loop/state.json', 'games/a/.gf-loop/job/spec.json', 'games/a/.gf-loop/job/playtestx/a.md', 'games/a/.gf-loop/job/playtest/../spec.json', 'builder/CONTRACT.md', 'AGENTS.md'])
    assert.match(decide(call('Read', { file_path: file }, pt)) ?? '', /black-box play-tester/, file);
  assert.match(decide(call('Grep', { pattern: 'x', path: 'games/a' }, pt)) ?? '', /black-box/);
  assert.match(decide(call('Glob', { pattern: '**/*.js' }, pt)) ?? '', /black-box/, 'no path: the working folder, which is not its own');
  assert.equal(decide(call('Read', { file_path: 'games/a/rules.js' })), null, 'the main session reads what it likes');
  // the report: the play-tester's own tool, under whatever name the server has; refused to everyone else
  assert.equal(decide(call('mcp__gamesfun__gamesfun_playtest_report', { game: 'games/a' }, pt)), null);
  for (const tool of ['mcp__gamesfun__gamesfun_playtest_report', 'mcp__plugin_gamesfun_gamesfun__gamesfun_playtest_report']) assert.match(decide(call(tool, { game: 'games/a' })) ?? '', /Only the playtester subagent reports/, tool);
  assert.match(decide(call('Bash', { command: 'node bin/gamesfun.mjs tool gamesfun_playtest_report --args-file r.json' })) ?? '', /Only the playtester/);
  assert.match(decide(call('Bash', { command: 'node bin/gamesfun.mjs tool gamesfun_playtest_report' }, { agent_type: 'general-purpose' })) ?? '', /Only the playtester/);
  assert.equal(decide(call('mcp__gamesfun__gamesfun_play', { game: 'games/a' })), null, 'playing is not reporting');
});
