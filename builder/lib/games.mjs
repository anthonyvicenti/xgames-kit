// Games on disk: which folder a command means, and what a game is called.
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GAMES, KIT_ROOT, toPosix } from './paths.mjs';

/** A game folder: what create writes (index.html, assets.json, and gf-three.json, or xgames.json for runtime godot). */
export const isGame = dir => ['index.html', 'assets.json'].every(f => existsSync(path.join(dir, f))) && ['gf-three.json', 'xgames.json'].some(f => existsSync(path.join(dir, f)));

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

/** Every game under games/. → [{ name, dir, title }] */
export async function listGames(root = GAMES) {
  let names = [];
  try { names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    if (!isGame(dir)) continue;
    const spec = await readJson(path.join(dir, 'spec.json'), {});
    out.push({ name, dir, title: spec.title ?? name });
  }
  return out;
}

/** Display path: relative to the kit root when inside it, else absolute; always with forward slashes. */
export const shown = dir => { const rel = path.relative(KIT_ROOT, dir); return toPosix(rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : dir); };

/**
 * The game a command means: the folder given, else the current folder when it is a game, else the only game in
 * games/. Throws an Error whose message says what to do.
 */
export async function resolveGame(arg, { cwd = process.cwd() } = {}) {
  if (arg) {
    const dir = path.resolve(cwd, arg);
    if (!existsSync(dir)) throw new Error(`${arg}: no such folder. A game starts from the person's own idea (the build loop, or the studio's start page: npx gamesfun dev); create --from <example> only when they ask for an example`);
    if (!isGame(dir)) throw new Error(`${arg}: not a game folder (no index.html, gf-three.json and assets.json). Make one with: npx gamesfun create ${arg} --from <example>`);
    return dir;
  }
  if (isGame(cwd)) return path.resolve(cwd);
  const games = await listGames();
  if (games.length === 1) return games[0].dir;
  if (!games.length) throw new Error('No game yet. The person describes their first one on the studio\'s start page (npx gamesfun dev with no folder), or you make it from their idea with the build loop. Do not make an example game to have something to show: create --from <example> only when they ask for one.');
  throw new Error(`Which game? ${games.map(g => shown(g.dir)).join(', ')}`);
}

/** What the studio and the MCP tools show about a game. */
export async function gameInfo(dir) {
  const spec = await readJson(path.join(dir, 'spec.json'), {});
  const game = await readJson(path.join(dir, 'config', 'game.json'), {});
  const mp = await readJson(path.join(dir, 'multiplayer.json'), {});
  const record = await readJson(path.join(dir, 'gf-three.json'), {});
  const web3 = await readJson(path.join(dir, 'gamesfun.json'), null);
  return {
    name: path.basename(dir),
    dir: shown(dir),
    title: game.text?.title ?? spec.title ?? path.basename(dir),
    hook: game.text?.hook ?? spec.hook ?? '',
    camera: spec.camera ?? null,
    players: spec.players ?? null,
    mechanics: (spec.mechanics ?? []).map(m => ({ id: m.id, as: m.as ?? '' })),
    controls: game.controls ?? spec.controls ?? {},
    multiplayer: mp.mode ?? null,
    kit: record.kit ?? null,
    network: web3?.network ?? 'devnet',
    gamesfun: web3,
    latestVerify: await latestVerdict(dir),
  };
}

/** The newest verify run in <game>/evidence/verify-N/ (its record.json: every measure with its detail), summarised. */
export async function latestVerdict(dir) {
  const root = path.join(dir, 'evidence');
  let runs = [];
  try { runs = (await readdir(root)).filter(n => /^verify-\d+$/.test(n)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7))); } catch { return null; }
  for (const run of runs) {
    const v = await readJson(path.join(root, run, 'record.json'));
    if (v) return summarizeVerdict(v, run);
  }
  return null;
}

export function summarizeVerdict(v, run = null) {
  const ran = (v.checks ?? []).filter(c => c.ok !== null);
  return {
    run, pass: !!v.pass, quick: !!v.quick, started: v.started ?? null, seconds: v.seconds ?? null,
    passed: ran.filter(c => c.ok).length, ran: ran.length, skipped: (v.checks ?? []).filter(c => c.ok === null).map(c => c.n),
    failed: (v.checks ?? []).filter(c => c.ok === false).map(c => ({ n: c.n, name: c.name, detail: c.detail })),
    checks: (v.checks ?? []).map(c => ({ n: c.n, name: c.name, ok: c.ok, detail: c.detail })),
  };
}
