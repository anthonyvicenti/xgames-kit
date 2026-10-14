// /api/game/…: the game the dev server serves: what it is, its slots (read and swap), and verify runs.
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { gameInfo, latestVerdict, readJson, summarizeVerdict } from '../../lib/games.mjs';
import { BIN } from '../../lib/paths.mjs';
import { listSlots, setFile, setValue } from '../../lib/slots.mjs';
import { HttpError, openGame, readBody, readJson as readBodyJson } from '../http.mjs';

export default function register(router, ctx) {
  // the open game, read at each request: the studio may open another while the server runs (builder/server/index.mjs)
  const G = () => openGame(ctx);
  const run = { child: null, lines: [], started: null, finished: null, code: null, args: [] };

  router.get('/info', async () => ({ ...(await gameInfo(G())), url: '/game/', friendsUrl: '/game/gf/mp/', network: ctx.network }));

  router.get('/slots', async req => listSlots(G(), { all: req.query.get('all') === '1' }));

  // a value slot: { id, value }
  router.post('/slots/value', async req => {
    const { id, value } = await readBodyJson(req);
    if (typeof id !== 'string') throw new HttpError(400, 'id is required');
    // refused in the kit's own words (kit/assets/items.js slotValueProblems): `problems` lists each, for the page to show
    try { return await setValue(G(), id, value); } catch (e) { throw new HttpError(400, e.message, e.problems ? { problems: e.problems } : null); }
  });

  // a file slot: the raw file as the body; ?id=<slot>&name=<file name>
  router.post('/slots/file', async req => {
    const id = req.query.get('id'), name = req.query.get('name') ?? 'upload';
    if (!id) throw new HttpError(400, 'id is required');
    const bytes = await readBody(req, { limit: 64 * 1024 * 1024 });
    try { return await setFile(G(), id, { bytes, name }); } catch (e) { throw new HttpError(400, e.message); }
  });

  // verify: the latest verdicts, and a run started from the studio (one at a time)
  router.get('/verify', async () => {
    const root = path.join(G(), 'evidence');
    let names = [];
    try { names = (await readdir(root)).filter(n => /^verify-\d+$/.test(n)).sort((a, b) => Number(b.slice(7)) - Number(a.slice(7))).slice(0, 10); } catch {}
    const runs = [];
    for (const n of names) { const v = await readJson(path.join(root, n, 'record.json')); if (v) runs.push({ ...summarizeVerdict(v, n), shots: (v.shots ?? []).map(s => `/game/evidence/${n}/${s}`) }); }
    return { running: !!run.child, started: run.started, finished: run.finished, code: run.code, args: run.args, log: run.lines.slice(-200), runs };
  });
  router.post('/verify', async req => {
    if (run.child) throw new HttpError(409, 'verify is already running');
    const body = await readBodyJson(req);
    const args = [BIN, 'verify', G()];
    if (body.quick !== false) args.push('--quick');
    if (body.check != null) { if (!/^\d+(,\d+)*$/.test(String(body.check))) throw new HttpError(400, 'check must be a number'); args.push('--check', String(body.check)); }
    Object.assign(run, { lines: [], started: new Date().toISOString(), finished: null, code: null, args: args.slice(2) });
    const child = spawn(process.execPath, args, { cwd: ctx.kitRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    run.child = child;
    const take = d => { for (const l of String(d).split(/\r?\n/)) if (l) run.lines.push(l); if (run.lines.length > 2000) run.lines.splice(0, run.lines.length - 2000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('close', code => { run.child = null; run.code = code; run.finished = new Date().toISOString(); ctx.events?.send('verify', { code }); });
    return { started: true, args: run.args };
  });
  router.get('/verify/latest', async () => (await latestVerdict(G())) ?? null);
}
