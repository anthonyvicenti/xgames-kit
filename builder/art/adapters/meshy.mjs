// Meshy, through the kit's existing `gamesfun meshy` command (builder/commands/meshy.mjs): the person's own MESHY_API_KEY from
// the environment or the kit's git-ignored .env, a credit cap (GF_MESHY_CAP) and its own ledger. This file only maps a
// ticket to that command, so Meshy is a row like every other maker. NOT RUN this time (no key on the build machine).
import { existsSync } from 'node:fs';
import path from 'node:path';
import { BIN, KIT_ROOT } from '../../lib/paths.mjs';
import { run } from '../../lib/proc.mjs';

export function plan(t, row, { image = null } = {}) {
  const what = t.role === 'body' ? 'character' : 'prop';
  const out = 'from-maker.glb';
  return { command: ['gamesfun', 'meshy', what, ...(image ? ['--image', image, '--describe', t.subject] : ['--prompt', [t.subject, t.direction].filter(Boolean).join('. ')]), '--out', out], credits: row.estimate?.credits ?? null };
}

export async function make(t, row, { env, dir, image = null }) {
  const p = plan(t, row, { image });
  const file = path.join(dir, 'from-maker.glb');
  const args = [BIN, ...p.command.slice(1, -1), file];
  const r = await run(process.execPath, args, { cwd: KIT_ROOT, env, timeoutMs: 30 * 60 * 1000 });
  if (r.code !== 0 || !existsSync(file)) throw new Error(`gamesfun meshy did not make a model: ${(r.stderr || r.stdout || r.error || '').trim().split('\n').slice(-3).join(' ')}`);
  return { file, cost: { credits: row.estimate?.credits ?? null, note: 'the real figure is in .gamesfun/meshy-ledger.jsonl (gamesfun meshy status)' } };
}
