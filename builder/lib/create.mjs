// gamesfun create: gf-three's create (spec → a runnable, multiplayer, slot-complete game), then the example's own
// rules and files when the game starts from an example, then the game's guide for the user's agent (AGENTS.md, with a
// CLAUDE.md that imports it).
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { UsageError } from './cli.mjs';
import { resolveExample } from './examples.mjs';
import { isGame, shown } from './games.mjs';
import { GAME_TEMPLATE, KIT_ROOT, toPosix } from './paths.mjs';
import { runTool, runToolJson } from './run-tool.mjs';
import { web3On } from './web3-switch.mjs';
import { refreshClient } from './backend/index.mjs';
import { createGodotGame, isGodotSpec } from '../../runtimes/godot/gamesfun.mjs';
import { copyFileWritable } from './writable.mjs';

/**
 * The in-game web3 kit (gf/web3/ and the gamesfun.json stub), from this checkout's builder/web3/ folder. Imported when it is
 * needed, so the kit's core (create, verify, the loop) runs in a checkout without builder/web3/: then a game is made without
 * it (null), whatever the switch says. Any other failure is a real one and is thrown.
 */
async function installWeb3(dir) {
  let mod;
  try { mod = await import('../web3/node/install.mjs'); }
  catch (e) { if (e?.code === 'ERR_MODULE_NOT_FOUND' && /web3[\\/]node[\\/]install\.mjs/.test(String(e.message))) return null; throw e; }
  return mod.installGfWeb3(dir);
}

/** The game's own guide files, written from builder/templates/game/ (never over files that exist, unless forced). */
export const GUIDE_FILES = [['AGENTS.md', 'AGENTS.md'], ['CLAUDE.md', 'CLAUDE.md'], ['gitignore', '.gitignore']];

async function walk(dir, base = dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, base, out); else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

export function fillTemplate(text, vars) {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export async function writeGuide(dir, { force = false } = {}) {
  const spec = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8').catch(() => '{}'));
  const kitRel = toPosix(path.relative(dir, KIT_ROOT)) || '.';
  const vars = {
    TITLE: spec.title ?? path.basename(dir),
    HOOK: spec.hook ?? '',
    GAME: shown(dir),
    KIT: kitRel,
    MECHANICS: (spec.mechanics ?? []).map(m => `\`${m.id}\`${m.as ? ` (${m.as})` : ''}`).join(', ') || '(none)',
    CONTROLS: Object.entries(spec.controls ?? {}).map(([k, v]) => `${k}: ${v}`).join('; ') || '(none named)',
    WORLD: spec.world ? `${spec.world.template}, ${spec.world.size ?? 'small'}` : '',
    PLACE: [spec.runtime && `runtime ${spec.runtime}${spec.profile ? `/${spec.profile}` : ''}`, spec.loop && `loop ${spec.loop}`, spec.kind && `kind ${spec.kind}`].filter(Boolean).join(', ') || 'a game',
  };
  const wrote = [];
  for (const [from, to] of GUIDE_FILES) {
    const out = path.join(dir, to);
    if (existsSync(out) && !force) continue;
    await writeFile(out, fillTemplate(await readFile(path.join(GAME_TEMPLATE, from), 'utf8'), vars));
    wrote.push(to);
  }
  return wrote;
}

/**
 * Make a game. target: the folder. One of spec (a game spec file) or from (an example id or folder).
 * → { ok, dir, title, example, wrote, kept, applied, guide, notes, warnings, slots, main }
 */
export async function createGame(target, { spec = null, from = null, force = false, cwd = process.cwd(), env = process.env } = {}) {
  if (!target) throw new UsageError('create needs a folder, e.g. games/my-game');
  if (!spec && !from) throw new UsageError('create needs --spec <spec.json> (your locked game spec) or --from <example> (npx gamesfun examples lists them)');
  if (spec && from) throw new UsageError('use --spec or --from, not both');
  const dir = path.resolve(cwd, target);
  const fresh = !isGame(dir);
  if (fresh && existsSync(dir) && (await readdir(dir)).length && !force) throw new Error(`${target} exists and is not a game. Pick an empty folder, or pass --force to create into it`);
  const example = from ? await resolveExample(from, { cwd }) : null;
  const specPath = example ? path.join(example.dir, 'spec.json') : path.resolve(cwd, spec);
  if (!existsSync(specPath)) throw new Error(`${spec}: no such spec file`);
  if (await isGodotSpec(specPath)) return createGodotGame(dir, { specPath, example, force, fresh, kitRoot: KIT_ROOT, shown: shown(dir) });   // runtime godot

  const flags = [];
  if (force) flags.push('--force');
  if (force && example) flags.push('--new-rules');
  const r = await runToolJson('create', [specPath, dir, ...flags]);
  if (!r.data) throw new Error(`gf-three create did not answer (exit ${r.code}): ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' | ')}`);
  if (!r.data.ok) throw new Error(`the spec does not make a game:\n  ${(r.data.problems ?? []).join('\n  ')}`);

  // an example's own rules and files go into a new game (or over everything, with --force); never over the user's work
  const applied = [];
  if (example && (fresh || force)) {
    const rules = path.join(example.dir, 'rules.js');
    if (existsSync(rules)) { await copyFileWritable(rules, path.join(dir, 'rules.js')); applied.push('rules.js'); }
    const files = path.join(example.dir, 'files');
    if (existsSync(files)) {
      for (const rel of await walk(files)) {
        const to = path.join(dir, rel);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFileWritable(path.join(files, rel), to);
        applied.push(toPosix(rel));
      }
      // config or asset files changed: assets.json follows the declarations again (keeping the sound list)
      const w = await runTool('slots', [dir, '--write'], { stdio: 'pipe' });
      if (w.code !== 0) throw new Error(`slots --write failed: ${w.stderr.trim()}`);
    }
  }
  const guide = await writeGuide(dir, { force: force && fresh });
  // the one place the in-game kit gf-web3 (gf/web3/) and the gamesfun.json stub are added: the CLI, the MCP tools, the
  // build loop and the scripts all come through here, and web3On(env) decides (on by default; GAMESFUN_WEB3=0 turns it off)
  const web3 = web3On(env) ? await installWeb3(dir) : null;
  await refreshClient(dir);   // gf/backend/, only in a game that has a backend (backend.json); nothing otherwise
  const specJson = JSON.parse(await readFile(path.join(dir, 'spec.json'), 'utf8'));
  return {
    ok: true, dir, shown: shown(dir), title: specJson.title, example: example?.id ?? null, fresh,
    wrote: r.data.wrote?.length ?? 0, kept: r.data.kept ?? [], applied, guide, web3,
    notes: r.data.notes ?? [], warnings: r.data.warnings ?? [], modules: r.data.why ?? [], slots: r.data.slots, main: r.data.main,
  };
}
