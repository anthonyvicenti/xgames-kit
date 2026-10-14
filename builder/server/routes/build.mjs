// /api/build/…: the build loop as the studio shows it (read-only), and the roll-back button.
//   GET  /state      → { loop, verdict, checkpoints, rollback, elsewhere, said }  said = the delivery's outcome in words and its first words
//                      also → { loop, verdict, checkpoints, rollback, elsewhere }  elsewhere = the game a session is building when it is not this studio's
//                      (each of)  loop = the loop state file as written (null when none),
//                      verdict = the newest verify run summarised, checkpoints = what builder/lib/checkpoint.mjs lists (M2-G)
//   GET  /look/:id   → a look option's contact sheet (the loop's look step), only a file inside the game the state names
//   POST /rollback   { id } → restores that checkpoint through builder/lib/checkpoint.mjs; a run under way is cancelled (builder/lib/cancel.mjs)
// The state file is written only by the loop library (through M2-G's tools). It is read here; never written.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCancel, writeCancel } from '../../lib/cancel.mjs';
import { latestVerdict } from '../../lib/games.mjs';
import { gameReady } from '../index.mjs';
import { KIT_ROOT } from '../../lib/paths.mjs';
import { HttpError, openGame, readJson } from '../http.mjs';
import { BASE_HEADERS } from '../security.mjs';

// where the loop keeps its state (builder/loop/state.mjs): <game>/.gf-loop/state.json, schema gf-loop/2
const STATE_FILES = ['.gf-loop/state.json'];

export async function readLoopFile(gameDir) {
  for (const rel of STATE_FILES) {
    try {
      const j = JSON.parse(await readFile(path.join(gameDir, ...rel.split('/')), 'utf8'));
      if (j && typeof j === 'object') return j;
    } catch {}
  }
  return null;
}

/**
 * What the loop's state holds for the person (the studio's conversation shows it): the idea in their words and the
 * cards of the pitch (gf-loop/2: state.prompt and state.pitch, pitch.v2.schema.json), cut to what a card shows.
 */
export function talkOf(loop) {
  const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  const list = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string').slice(0, 8).map(x => x.slice(0, n)) : []);
  const p = loop?.pitch;
  const pitch = p && typeof p === 'object' ? {
    reply: text(p.reply, 400),
    cards: (Array.isArray(p.cards) ? p.cards : []).slice(0, 3).map(c => ({ id: text(c?.id, 24), title: text(c?.title, 60), hook: text(c?.hook ?? c?.spec?.hook, 200), howItPlays: text(c?.howItPlays ?? c?.take, 600), players: text(c?.players, 80), v1: { has: list(c?.v1?.has, 120), build: list(c?.v1?.build, 120), notYet: list(c?.v1?.notYet, 120) } })),
    // what the person reads about an offered economy or backend (builder/loop/parts.mjs offerWords), with the cards
    offers: Object.fromEntries(Object.entries(p.offers ?? {}).filter(([k, o]) => ['economy', 'backend'].includes(k) && o && typeof o === 'object').map(([k, o]) => [k, { what: text(o.what, 240), price: text(o.price, 80), kind: text(o.kind, 20), needs: list(o.needs, 20), from: text(o.from, 120) }])),
    questions: (Array.isArray(p.questions) ? p.questions : []).slice(0, 3).map(q => ({ id: text(q?.id ?? q?.about, 32), text: text(q?.text, 160), default: text(q?.default, 32), options: (Array.isArray(q?.options) ? q.options : []).slice(0, 4).map(o => ({ id: text(o?.id, 32), label: text(o?.label, 60) })) })),
  } : null;
  // the look options (builder/look/pitch.mjs), each with its contact sheet served by GET /look/:option
  const L = loop?.look;
  const looks = Array.isArray(L?.options) && L.options.length ? {
    waiting: loop.status === 'waiting-on-creator' && loop.waiting?.about === 'looks',
    pick: L.pick ? { option: text(L.pick.option, 40), by: text(L.pick.by, 12) } : null,
    reads: list(L.target?.reads, 200),
    options: L.options.slice(0, 3).map(o => ({ id: text(o?.id, 40), title: text(o?.title, 80), reading: text(o?.reading, 300), score: typeof o?.score === 'number' ? o.score : null, sheet: `/api/build/look/${encodeURIComponent(text(o?.id, 40))}` })),
  } : null;
  return { idea: typeof loop?.prompt === 'string' ? loop.prompt.slice(0, 2000) : null, pitch, looks };
}

async function checkpointLib() {
  try { return await import(pathToFileURL(path.join(KIT_ROOT, 'builder', 'lib', 'checkpoint.mjs')).href); } catch { return null; }
}

export default function register(router, ctx) {
  // the open game, read at each request: the studio may open another while the server runs (builder/server/index.mjs)
  const G = () => openGame(ctx);

  router.get('/state', async () => {
    if (!ctx.gameDir) return { none: true, made: false, loop: null, verdict: null, checkpoints: [], rollback: false, elsewhere: null, said: null, pitch: null, idea: null };
    const lib = await checkpointLib();
    let checkpoints = [];
    try { if (lib?.listCheckpoints) checkpoints = (await lib.listCheckpoints(G())) ?? []; } catch (e) { ctx.log(`checkpoints: ${e.message}`); }
    // a run the person rolled back is cancelled from that moment, also before a loop tool has written it into the state
    let loop = await readLoopFile(G());
    const mark = loop?.status === 'building' ? await readCancel(G()) : null;
    if (mark) loop = { ...loop, status: 'cancelled', step: 'done', outcome: 'cancelled', why: mark.reason, handed: null };
    // A session that is building another game than the one this studio shows: say so, never show nothing.
    let elsewhere = null;
    try {
      const { bridgeFor } = await import('./session.mjs');
      const other = bridgeFor(ctx.url)?.bridge.sessions().find(x => x.state !== 'ended' && x.game && path.resolve(x.game) !== path.resolve(G()));
      if (other) elsewhere = { game: other.game, name: path.relative(KIT_ROOT, other.game).split(path.sep).join('/'), loop: await readLoopFile(other.game).then(l => (l ? { status: l.status, step: l.step } : null)) };
    } catch { /* no bridge on this server */ }
    // how the delivery was named: the loop's outcome (gf-loop/2 state.outcome), and its first words when it is not yet the game asked for
    let said = null;
    if (loop?.status === 'delivered' && loop.outcome && typeof loop.outcome === 'object') said = { outcome: String(loop.outcome.outcome), words: null, firstWords: typeof loop.outcome.notYet === 'string' ? loop.outcome.notYet.slice(0, 1200) : null };
    const made = gameReady(G());
    if (made) ctx.gameMade?.();                      // the folder the loop was making is a game now: the server watches it
    return { elsewhere, loop, said, verdict: await latestVerdict(G()), checkpoints, rollback: !!lib?.restoreCheckpoint, made, ...talkOf(loop) };
  });

  // a look option's contact sheet: only a file the loop's state names, and only inside the game's folder
  router.get('/look/:option', async (req, res, { option }) => {
    const loop = await readLoopFile(G());
    const o = (loop?.look?.options ?? []).find(x => x?.id === option);
    const file = o?.sheet ? path.resolve(G(), o.sheet) : null;
    if (!file || !file.startsWith(path.resolve(G()) + path.sep) || !/\.(png|jpe?g)$/i.test(file)) throw new HttpError(404, 'no such look');
    let st; try { st = await stat(file); } catch { throw new HttpError(404, 'no such look'); }
    res.writeHead(200, { ...BASE_HEADERS, 'content-type': /\.png$/i.test(file) ? 'image/png' : 'image/jpeg', 'content-length': st.size, 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });

  router.post('/rollback', async req => {
    const { id } = await readJson(req);
    if (typeof id !== 'string' || !id) throw new HttpError(400, 'id is required');
    const lib = await checkpointLib();
    if (!lib?.restoreCheckpoint) throw new HttpError(501, 'Rolling back is not available in this kit yet (lib/checkpoint.mjs).');
    let out;
    try { out = { restored: id, ...(await lib.restoreCheckpoint(G(), id)) }; } catch (e) { throw new HttpError(400, e.message); }
    // A roll-back while a run is under way cancels the run (the decision and its reasons: builder/mcp/tools/loop.mjs,
    // applyCancel). This process cannot end the run itself (the loop's state is the MCP server's to write), so it
    // leaves the mark the loop tools apply; from this moment the stop guard and this tab read the run as cancelled.
    const loop = await readLoopFile(G());
    if (loop?.status === 'building' && loop.step !== 'done') {
      const label = (await lib.listCheckpoints(G()).catch(() => [])).find(c => c.id === id)?.label ?? id;
      const mark = await writeCancel(G(), { reason: `the person rolled the game back from the studio page to "${label}"`, checkpoint: id, label });
      out.cancelled = { run: loop.kind ?? 'build', step: loop.step, at: mark.at };
    }
    return out;
  });
}
