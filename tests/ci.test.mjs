// The CI profile and workflow stay consistent with the verify tool that reads them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { checkProfile, requiredFor } from '../builder/tools/lib/verdict.mjs';

const at = rel => fileURLToPath(new URL(`../${rel}`, import.meta.url));

test('.github/ci-profile.json is a valid verify --profile file, and skips only checks a build runs', async () => {
  const profile = JSON.parse(await readFile(at('.github/ci-profile.json'), 'utf8'));
  assert.deepEqual(checkProfile(profile), []);
  assert.equal(profile.environment.GF_VERIFY_SOFTWARE, '1');
  // requiredFor('round') leaves out the release-only checks (7, 8, 20-22, 24, 31, 34: games.fun's RELEASE_ONLY since the gates). A build's verify does
  // not run them, so the profile must not list them; 22 and 24 were taken out at the sync of ed6c86ffa.
  const build = requiredFor('round');
  for (const s of profile.skip) assert.ok(build.includes(s.check), `check ${s.check} is not one a build's verify runs`);
  assert.deepEqual(profile.skip.filter(s => s.legs).map(s => [s.check, s.legs]), [[5, 'lobby']], 'check 5 keeps its lobby legs');
  assert.equal(profile.run, undefined, 'the file names what it skips; everything else runs');
});

test('the workflow runs the profile through the real flag for both engines, Linux only unless a run by hand names another system, one system or job by hand', async () => {
  const wf = await readFile(at('.github/workflows/check.yml'), 'utf8');
  assert.ok(!wf.includes('GF_VERIFY_PROFILE'), 'no gate variable');
  assert.equal(wf.match(/verify games\/ci(-scenic)? --quick --profile \.github\/ci-profile\.json/g)?.length, 2);
  assert.match(wf, /--from soak-squad/); assert.match(wf, /--from isle-run/);
  assert.match(wf, /--from giant-four/); assert.match(wf, /verify games\/ci-board --quick --profile \.github\/ci-profile\.json/, 'the turn-based board example runs under the profile too');
  assert.match(wf, /doctor --skip-graphics/);
  assert.ok(!wf.includes('continue-on-error'), 'no step may fail quietly: a check that cannot run on a runner leaves the profile by name, with its reason');
  // the free minutes ran out on 2026-10-12 (macOS 69 %): push, pull request and a run by hand without -f system= are Linux only
  assert.match(wf, /system:[\s\S]*?default: linux\n/, 'a run by hand defaults to Linux');
  const matrices = wf.match(/os: \$\{\{ fromJSON\(github\.event_name != 'workflow_dispatch'[\s\S]*?\) \}\}/g) ?? [];
  assert.equal(matrices.length, 2, 'one matrix per job');
  for (const m of matrices) {
    const [auto, ...rest] = m.split('||'), fallback = rest.at(-1);
    assert.ok(/ubuntu/.test(auto) && !/windows|macos/.test(auto), 'pushes to main and pull requests: Linux only');
    assert.ok(/ubuntu/.test(fallback) && !/windows|macos/.test(fallback), 'by hand without a system: Linux only');
    assert.ok(m.includes(`inputs.system == 'all' && '["ubuntu-latest","windows-latest","macos-latest"]'`), 'system=all runs all three');
    // by hand, one system alone (so a fix for Windows does not pay for macOS)
    for (const [input, os] of [['windows', 'windows-latest'], ['macos', 'macos-latest']]) assert.ok(m.includes(`inputs.system == '${input}' && '["${os}"]'`), `system=${input} runs ${os} alone`);
  }
  for (const job of ['party', 'scenic']) assert.ok(wf.includes(`if: github.event_name != 'workflow_dispatch' || inputs.job == 'all' || inputs.job == '${job}'`), `job=${job} runs alone`);
  // every system's Chrome is named, and each job reads its own
  const paths = wf.match(/CHROME_PATH: \$\{\{ fromJSON\('(\{.*\})'\)\[matrix\.os\] \}\}/g) ?? [];
  assert.equal(paths.length, 2);
  assert.deepEqual(Object.keys(JSON.parse(/fromJSON\('(\{.*\})'\)/.exec(paths[0])[1])), ['ubuntu-latest', 'windows-latest', 'macos-latest']);
});

test('every action the workflow uses is pinned to a commit, with the tag it was in a comment', async () => {
  const wf = await readFile(at('.github/workflows/check.yml'), 'utf8');
  const uses = [...wf.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 3, 'the workflow uses actions');
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${ref}: pin to a full commit SHA (a tag can be moved)`);
    assert.match(rest, /#\s*v\d+\.\d+\.\d+/, `${ref}: name the release in a comment`);
  }
});

test('npm run test:smoke really runs the smoke tests (it sets GAMESFUN_SMOKE=1 itself, on every system)', async () => {
  const pkg = JSON.parse(await readFile(at('package.json'), 'utf8'));
  assert.equal(pkg.scripts['test:smoke'], 'node scripts/smoke.mjs');
  const script = await readFile(at('scripts/smoke.mjs'), 'utf8');
  assert.match(script, /GAMESFUN_SMOKE: '1'/); assert.match(script, /smoke\.test\.mjs/);
  assert.doesNotMatch(await readFile(at('tests/smoke.test.mjs'), 'utf8'), /CI sets it/, 'the CI workflow does not set GAMESFUN_SMOKE: no file may say it does');
});
