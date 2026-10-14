// /api/studio/…: what the studio page loads: its tabs (builder/studio/tabs/*.js, the tabs seam), and which game it has open.
//   GET  /tabs       → [{ file, url }]
//   GET  /project    → { name, dir, made, games }  the game the server has open (null: the start page)
//   POST /project    { name } opens games/<name> (a game, or a folder the build loop is making); { name: null } closes it
//   POST /new        { idea } → { name, dir }  a fresh folder name for a new idea, opened (nothing is written: the build
//                    loop makes the folder when the person's session starts it; the page sends the idea to the session)
//   POST /example    { example, name? } → { name, dir }  a game made from an example (builder/lib/create.mjs), opened
//   GET  /home       → { project, games: [{ name, title, hook, made, loop }], examples: [{ id, title, summary }], setup }
//   GET  /setup      → { connected, agents, at }  whether `gamesfun connect` has run on this checkout (its record in
//                    .gamesfun/connected.json), so the page can say the one step that is left
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createGame } from '../../lib/create.mjs';
import { listExamples } from '../../lib/examples.mjs';
import { isGame, readJson } from '../../lib/games.mjs';
import { STATE, STUDIO } from '../../lib/paths.mjs';
import { web3On } from '../../lib/web3-switch.mjs';
import { HttpError, readJson as readBody } from '../http.mjs';
import { gameFolder, gameReady } from '../index.mjs';

// Web3 is on by default (builder/lib/web3-switch.mjs): GAMESFUN_WEB3=0 takes the Economy tab out of the list the page builds
// its tab row from, so it is not in the DOM and cannot be reached by keyboard.
export const WEB3_TAB_FILES = new Set(['economy.js']);
/** Where `gamesfun connect` records that it ran (builder/commands/connect.mjs). */
export const CONNECTED_FILE = path.join(STATE, 'connected.json');

/** A short folder name from the person's words: "a pillow fight in a backyard!" → pillow-fight-backyard. */
export function slugOf(words) {
  const skip = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'in', 'on', 'with', 'for', 'to', 'my', 'me', 'i', 'we', 'game', 'like', 'where', 'that', 'is', 'are', 'make', 'want', 'some', 'your', 'our', 'at', 'by']);
  const parts = String(words ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\w\s-]/g, ' ').split(/[\s_-]+/).filter(w => w && !skip.has(w) && /^[a-z0-9]+$/.test(w));
  return parts.slice(0, 4).join('-').slice(0, 40).replace(/-+$/, '') || 'new-game';
}
/** The first free name under root: base, base-2, base-3, … */
export function freeName(root, base) {
  for (let i = 1; i < 1000; i++) { const n = i === 1 ? base : `${base}-${i}`; if (!existsSync(path.join(root, n))) return n; }
  throw new HttpError(409, 'no free folder name');
}

async function loopOf(dir) {
  const s = await readJson(path.join(dir, '.gf-loop', 'state.json'), null);
  return s ? { kind: s.kind ?? null, status: s.status ?? null, step: s.step ?? null, prompt: typeof s.prompt === 'string' ? s.prompt : null } : null;
}
/** The person's games: made ones (create ran) and folders the build loop is still making (a .gf-loop, no game yet). */
export async function listProjects(root) {
  let names = [];
  try { names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => e.name).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const dir = path.join(root, name);
    const made = isGame(dir), loop = await loopOf(dir);
    if (!made && !loop) continue;
    const spec = await readJson(path.join(dir, 'spec.json'), {});
    const game = await readJson(path.join(dir, 'config', 'game.json'), {});
    const idea = made ? null : loop?.prompt?.slice(0, 160) ?? null;
    out.push({ name, title: game.text?.title ?? spec.title ?? (idea ? idea.split('\n')[0] : name), hook: game.text?.hook ?? spec.hook ?? '', made, loop: loop && { kind: loop.kind, status: loop.status, step: loop.step } });
  }
  return out;
}

export async function setupOf() {
  const v = await readJson(CONNECTED_FILE, null);
  return { connected: !!v?.connected, plugin: !!v?.plugin, agents: Array.isArray(v?.agents) ? v.agents : [], at: v?.at ?? null };
}

export default function register(router, ctx = {}) {
  router.get('/tabs', async () => {
    let files = [];
    try { files = (await readdir(path.join(STUDIO, 'tabs'))).filter(f => /^[a-z0-9][a-z0-9-]*\.js$/.test(f)).sort(); } catch {}
    if (!web3On(process.env)) files = files.filter(f => !WEB3_TAB_FILES.has(f));
    return files.map(f => ({ file: f, url: `/studio/tabs/${f}` }));
  });

  const root = () => ctx.gamesRoot;
  const project = () => (ctx.gameDir ? { name: path.basename(ctx.gameDir), dir: ctx.gameDir, made: gameReady(ctx.gameDir) } : null);
  router.get('/project', async () => ({ project: project() }));
  router.post('/project', async req => {
    const { name } = await readBody(req);
    if (name === null || name === undefined || name === '') { ctx.setGame(null); return { project: null }; }
    let dir;
    try { dir = gameFolder(root(), name); } catch (e) { throw new HttpError(400, e.message); }
    if (!existsSync(dir)) throw new HttpError(404, `no game "${name}" in games/`);
    ctx.setGame(dir);
    return { project: project() };
  });
  router.post('/new', async req => {
    const { idea } = await readBody(req, { limit: 16 * 1024 });
    if (typeof idea !== 'string' || !idea.trim()) throw new HttpError(400, 'Say what the game is first.');
    const name = freeName(root(), slugOf(idea));
    ctx.setGame(gameFolder(root(), name));
    return { name, dir: ctx.gameDir, project: project() };
  });
  router.post('/example', async req => {
    const { example, name } = await readBody(req);
    const list = await listExamples();
    const ex = list.find(e => e.id === example);
    if (!ex) throw new HttpError(400, `no example "${example}" (examples: ${list.map(e => e.id).join(', ')})`);
    const folder = freeName(root(), typeof name === 'string' && name ? slugOf(name) : ex.id);
    const dir = gameFolder(root(), folder);
    try { await createGame(dir, { from: ex.id }); } catch (e) { throw new HttpError(500, `could not make ${folder} from ${ex.id}: ${e.message}`); }
    ctx.setGame(dir);
    return { name: folder, dir, project: project() };
  });
  router.get('/setup', async () => setupOf());
  router.get('/home', async () => ({
    project: project(),
    games: await listProjects(root()),
    examples: (await listExamples()).map(e => ({ id: e.id, title: e.title, summary: e.summary })),
    setup: await setupOf(),
  }));
}
