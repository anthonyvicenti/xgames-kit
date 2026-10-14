// gamesfun meshy: optional 3D generation with the user's own Meshy key (never committed: .env is git-ignored).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ensureCharDeps } from '../lib/char-deps.mjs';
import { guard, UsageError } from '../lib/cli.mjs';
import { KIT_ROOT, STATE } from '../lib/paths.mjs';
import { runTool } from '../lib/run-tool.mjs';

const usage = `Usage:
  gamesfun meshy prop --prompt "<what it is>" --out <file.glb> [--size <m>] [--dry-run]
  gamesfun meshy prop --image <ref.png> --out <file.glb> [--describe "<what to keep>"] [--size <m>]
  gamesfun meshy character --prompt "<what it looks like>" --out <file.glb> [--enemy] [--dry-run]
  gamesfun meshy character --image <ref.png> --out <file.glb> [--describe "<what to keep>"]
  gamesfun meshy status

Optional. Makes a prop (about 36 credits) or a rigged gf-humanoid-1 body (about 41 credits) with Meshy, using YOUR key:
put MESHY_API_KEY=… in .env at the root of this checkout (git-ignored; see .env.example). Spend is recorded in
.gamesfun/meshy-ledger.jsonl and capped by GF_MESHY_CAP (default 150 credits). Then put the file in its slot:
  npx gamesfun slots set prop.<name> --file <file.glb>      or      character.body.<role>
Meshy output is recorded as CC BY 4.0 crediting Meshy until you confirm your plan's licence terms.`;

const LEDGER = path.join(STATE, 'meshy-ledger.jsonl');

export function loadDotEnv(file = path.join(KIT_ROOT, '.env')) {
  if (!existsSync(file)) return {};
  try { return parseEnv(readFileSync(file, 'utf8')); } catch { return {}; }
}

function status(env) {
  let rows = [];
  try { rows = readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch {}
  const byId = new Map();
  for (const r of rows) byId.set(r.id, { ...byId.get(r.id), ...r });
  const spent = [...byId.values()].reduce((n, r) => n + (r.credits ?? r.estimate ?? 0), 0);
  console.log(`Meshy key: ${env.MESHY_API_KEY ? 'set (.env)' : 'not set (put MESHY_API_KEY=… in .env)'}`);
  console.log(`Spent: ${spent} credits in ${byId.size} task(s); cap ${env.GF_MESHY_CAP ?? 150} (GF_MESHY_CAP). Ledger: ${path.relative(KIT_ROOT, LEDGER)}`);
}

export default {
  name: 'meshy',
  summary: 'optional: generate a prop or a character with your own Meshy key',
  usage,
  run: args => guard(async () => {
    const [what, ...rest] = args;
    const fileEnv = loadDotEnv();
    const env = {
      MESHY_API_KEY: process.env.MESHY_API_KEY ?? fileEnv.MESHY_API_KEY ?? '',
      GF_MESHY_CAP: process.env.GF_MESHY_CAP ?? fileEnv.GF_MESHY_CAP ?? '150',
      GF_MESHY_WAVE: 'gamesfun-kit',
      GF_MESHY_LEDGER: LEDGER,
    };
    if (what === 'status') return status(env);
    if (what !== 'prop' && what !== 'character') throw new UsageError(usage);
    if (!env.MESHY_API_KEY && !rest.includes('--dry-run')) throw new Error('Meshy is optional, and needs your own key: put MESHY_API_KEY=… in .env at the root of this checkout (git-ignored; copy .env.example). Or use a library model: npx gamesfun catalog bodies props');
    ensureCharDeps();
    await mkdir(STATE, { recursive: true });
    if (what === 'prop') return (await runTool('meshy-prop', rest, { env })).code;
    return (await runTool('meshy-character', rest, { env })).code;
  }),
};
