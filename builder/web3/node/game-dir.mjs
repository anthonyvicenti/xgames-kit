// Which game a CLI or MCP call means, and where the studio is, for the web3 commands and tools.
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The kit's root folder (this file is builder/web3/node/game-dir.mjs). */
export const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const exists = async (p) => stat(p).then(() => true, () => false);
// a game the build loop is making counts from its pitch on (.gf-loop/): its economy is saved before create (K3)
const isGame = async (dir) => (await exists(path.join(dir, 'index.html'))) || (await exists(path.join(dir, 'gamesfun.json'))) || (await exists(path.join(dir, '.gf-loop')));

/**
 * The game folder: `--game`, else the current folder when it is a game, else the only game under games/.
 * Throws a plain message listing the games when it can't tell.
 */
export async function resolveGame(given, { kitRoot = KIT_ROOT, cwd = process.cwd() } = {}) {
  if (given) {
    const dir = path.resolve(cwd, given);
    if (!(await isGame(dir))) throw new Error(`${given} is not a game folder (no index.html or gamesfun.json).`);
    return dir;
  }
  if (await isGame(cwd)) return cwd;
  const gamesDir = path.join(kitRoot, 'games');
  const names = [];
  for (const entry of await readdir(gamesDir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory() && (await isGame(path.join(gamesDir, entry.name)))) names.push(entry.name);
  if (names.length === 1) return path.join(gamesDir, names[0]);
  if (!names.length) throw new Error('No game found. Make one with `npx gamesfun create games/<name>`, or pass --game <folder>.');
  throw new Error(`Which game? Pass --game with one of: ${names.map((n) => `games/${n}`).join(', ')}.`);
}

/**
 * The studio's address when `gamesfun dev` is running for this game: GAMESFUN_DEV_URL, else the running dev servers
 * core records in .gamesfun/dev.json (builder/lib/state.mjs). Null when none is running for it.
 */
export async function studioUrl({ gameDir = null, kitRoot = KIT_ROOT, env = process.env } = {}) {
  if (env.GAMESFUN_DEV_URL) return new URL('studio/', env.GAMESFUN_DEV_URL).toString();
  try {
    const { servers = [] } = JSON.parse(await readFile(path.join(kitRoot, '.gamesfun', 'dev.json'), 'utf8'));
    const running = servers.filter((s) => s?.url && alive(s.pid));
    const mine = running.find((s) => gameDir && s.gameDir && path.resolve(s.gameDir) === path.resolve(gameDir));
    return mine ? new URL('studio/', mine.url).toString() : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
