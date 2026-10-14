// Fake kit bindings for the dry run and the tests: a create that writes two files, a fix that repairs nothing, a verify
// that answers from a script, checkpoints as folder copies. Nothing here opens a browser or calls a model.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileStore, filesHash, stateFileOf } from '../../../builder/loop/state.mjs';

const GATES = ['A', 'B', 'C', 'D', 'E', 'F'];

/**
 * A verify that answers from a script: verifies[n - 1] is a list of failures ({gate, measure, area?, detail, rule, fix})
 * or 'pass'; past the end of the script every verify passes. `skipped`: gates this runtime skips (always).
 */
export function scriptedVerify(script, { skipped = [], runtime = 'three' } = {}) {
  const calls = [];
  const MEASURES = { A: [1, 2, 4, 18, 19], B: [3, 9], C: [10, 13, 15, 16, 38], D: [6, 12], E: [5, 25], F: [11, 14, 17, 35, 39] };
  const verify = async (game, { n }) => {
    const step = script[n - 1] ?? 'pass';
    const failed = step === 'pass' ? [] : step;
    calls.push({ n, failed: failed.map(f => `${f.gate}:${f.measure}`) });
    // the verdict's shape: builder/gates/verdict.schema.json (contracts)
    const gates = Object.fromEntries(GATES.map(g => {
      if (skipped.includes(g)) return [g, { gate: g, ran: [], passed: [], skipped: MEASURES[g].map(m => ({ measure: m, why: 'no phone on this host' })), ok: true }];
      const bad = failed.filter(f => f.gate === g);
      const ran = MEASURES[g];
      return [g, { gate: g, ran, passed: ran.filter(m => !bad.some(f => f.measure === m)), skipped: [], ...(bad.length ? { failed: bad.map(({ gate, area, ...f }) => f) } : {}), ok: !bad.length }];
    }));
    return { verdictVersion: 1, runtime, run: 'build', gates, failed, pass: !failed.length };
  };
  return { verify, calls };
}

export function fakeBindings({ registry, root, verify, log = () => {}, say = null }) {
  return {
    registry, root, ...(say ? { say } : {}),
    store: G => fileStore(stateFileOf(G.game)),
    tools: G => ({
      async create(spec, { game }) {
        await mkdir(join(game, 'src'), { recursive: true });
        await writeFile(join(game, 'index.html'), `<!doctype html><title>${spec.title}</title>\n`);
        await writeFile(join(game, 'spec.json'), JSON.stringify(spec, null, 2));
        await writeFile(join(game, 'rules.js'), '// the stub create wrote\n');
        log(`create: ${spec.runtime}/${spec.profile}`);
        return { ok: true };
      },
      fix: async () => ({ repairs: [] }),
      verify,
      hash: game => filesHash(game),
      playRun: async (game, name) => (name === 'two' ? TWO_SEATS : null),
      checkSpec: async () => [],
      ownFiles: async game => (existsSync(join(game, 'src')) ? (await readdir(join(game, 'src'))).map(f => `src/${f}`) : []),
    }),
    versions: G => {
      const keep = n => join(dirname(G.game), `.${basename(G.game)}.keep`, n);      // beside the game, never inside it
      const filter = src => !src.includes('/.gf-loop');
      return {
        keep: async n => { await rm(keep(n), { recursive: true, force: true }); await cp(G.game, keep(n), { recursive: true, filter }); },
        restore: async n => { await cp(keep(n), G.game, { recursive: true, force: true }); },
        has: async n => existsSync(keep(n)),
      };
    },
    limits: { model: 'sonnet', strong: 'opus', playtestModel: 'sonnet' },
  };
}

/** The agent's hand in the game folder: write a file (the round changed the game) or not. */
export const touch = (game, name, body) => writeFile(join(game, name), body);

/** A runner host's second reader that marks every ledger line kept (o.bundle is what the reader is given). */
export const keepAll = async o => ({ schema: 'gf-reading/1', rows: o.bundle.rows.map(r => ({ id: r.id, mark: 'kept', why: 'the captures show it', evidence: ['runs/r/a.jpg'] })), findings: [], summary: 'It kept what was asked.' });

/**
 * A friends run's record as builder/tools/play.mjs writes it (play.json): hosted on the friends page, a second window
 * joined, each player acting and captured, two players and no bot on each screen. The fake tools answer it for run "two".
 */
export const TWO_SEATS = {
  friend: true, ok: true,
  steps: [
    { n: 1, do: 'start', friend: true },
    { n: 2, do: 'move', keys: ['KeyW'], seconds: 1 },
    { n: 3, do: 'move', keys: ['KeyW'], seconds: 1, who: 'friend' },
    { n: 4, do: 'snap', name: 'host', state: { players: [{ name: 'You', you: true, bot: false }, { name: 'Friend', bot: false }] } },
    { n: 5, do: 'snap', name: 'friend', who: 'friend', state: { players: [{ name: 'Host', bot: false }, { name: 'You', you: true, bot: false }] } },
  ],
};
/** A promise seen in the two-player run, with what each screen showed (every fake tester answers this way). */
export const seenTwo = id => ({ id, status: 'seen', evidence: [`runs/two/${id}.jpg`], screens: { host: 'the friend is beside me at the gate', friend: 'the host is beside me at the gate' } });
