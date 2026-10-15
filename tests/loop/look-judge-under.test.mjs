// The look step's judge runs as its own process under the host's GPU wrap and with its GPU env, like the sheets and
// verify (found by T8 run 1, 2026-10-14: judged in the loop's own process, its browser had no hardware GL on a wrapped
// host and every option's judge timed out waiting for the game).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judgeUnder } from '../../builder/loop/kit.mjs';

test('judgeUnder: the judge runs under the wrap, with the GPU env, and its record comes back', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-judge-under-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = join(dir, 'seen.json');
  // a wrap that marks the run as queued (a real one takes a GPU slot and sets the GPU flags)
  const wrap = join(dir, 'wrap.sh');
  await writeFile(wrap, `#!/bin/sh\nexport GF_QUEUED=1\nexec "$@"\n`, { mode: 0o755 });
  const fake = join(dir, 'judge.mjs');
  await writeFile(fake, `import { readFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), opt = k => a[a.indexOf(k) + 1];
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ game: a[0], queued: process.env.GF_QUEUED ?? null, gpu: process.env.CHROME_ARGS ?? null, target: JSON.parse(readFileSync(opt('--target'), 'utf8')), refs: JSON.parse(readFileSync(opt('--refs'), 'utf8')) }));
writeFileSync(opt('--json'), JSON.stringify({ score: 61, findings: [{ line: 'warmer light' }] }));
`);
  const score = judgeUnder([wrap], { ...process.env, CHROME_ARGS: '--use-gl=angle --use-angle=gl-egl' }, { judgeFile: fake });
  const r = await score(join(dir, 'game'), { reads: ['sunny'] }, [{ file: '/refs/a.png', frame: 'gameplay' }, { note: 'no file' }]);
  assert.equal(r.score, 61);
  assert.equal(r.findings[0].line, 'warmer light');
  const s = JSON.parse(await readFile(seen, 'utf8'));
  assert.equal(s.queued, '1', 'under the wrap');
  assert.match(s.gpu, /use-angle=gl-egl/, 'with the GPU env');
  assert.deepEqual(s.target, { reads: ['sunny'] });
  assert.deepEqual(s.refs.frames.map(f => f.file), ['/refs/a.png']);
});

test('judgeUnder: a judge that gives no record leaves the option unscored', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'gf-judge-under-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'judge.mjs');
  await writeFile(fake, 'process.exit(1);\n');
  assert.equal(await judgeUnder([], process.env, { judgeFile: fake })(dir, null, []), null);
});
