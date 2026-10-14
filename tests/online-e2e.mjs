#!/usr/bin/env node
// Online play end to end, on this machine and with nothing of ours on the internet: a game served by the dev server
// opens its rooms through a signaling server on ANOTHER origin, and a friend whose page is on a THIRD origin joins.
// Real Chrome, real WebRTC, the multiplayer kit with online play (1.6.4 or newer: builder/gf-multiplayer).
//
//   node tests/online-e2e.mjs [--out <folder>] [--ports 5997,5998,5999] [--case A|B|C]
//
//   A  online works. The signaling server is the kit's own self-host server (builder/multiplayer/p2p/serve-signal.mjs, what
//      docs/ONLINE.md tells a person to run) on the middle port. The same game is served by two dev servers (two
//      origins, as on two machines), both with GAMESFUN_ONLINE=<that server>. One page hosts, the other joins with the
//      room code, the round starts and each page draws the other player where that player is. The room was opened on
//      the signaling server, and neither dev server's own signaling saw a room.
//   B  the online host refuses (its switch is off). The middle port answers with the play host's own code
//      (builder/studio-lib/signal-core.mjs) and the switch off, so the words are the real ones. The page shows
//      the notice with those words and goes on with this machine's signaling: a second tab joins and both play.
//   C  the online host cannot be read (an answer with no CORS headers, which is what a play host that does not know
//      outside games gives, and what no network looks like to a page): the notice says it could not be reached, and
//      two tabs play on this machine.
// Never pointed at a real host. Exit 0 when every check passes. The record is <out>/online-e2e.json.
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createGame } from '../builder/lib/create.mjs';
import { BUILDER, GF_MP } from '../builder/lib/paths.mjs';
import { startDevServer } from '../builder/server/index.mjs';
import { ONLINE_LINE } from '../builder/server/online.mjs';
import { twoPlayers } from './two-players.mjs';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const [PA, PS, PB] = String(opt('ports', '5997,5998,5999')).split(',').map(Number);
const only = opt('case');
const out = opt('out') ?? await mkdtemp(path.join(os.tmpdir(), 'gf-online-e2e-'));
await mkdir(out, { recursive: true });
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `  (${String(detail).slice(0, 240)})` : ''}`); };

const version = JSON.parse(await readFile(path.join(GF_MP, 'source', 'kit.json'), 'utf8')).version;
const SIGNAL = `http://127.0.0.1:${PS}/signal/v1`;
const env = { GAMESFUN_ONLINE: SIGNAL };

// the game: the example, on the one multiplayer kit this checkout carries
const root = await mkdtemp(path.join(os.tmpdir(), 'gf-online-game-'));
const game = path.join(root, 'game');
await createGame(game, { from: 'soak-squad' });
const created = JSON.parse(await readFile(path.join(game, 'gf', 'mp', 'kit.json'), 'utf8')).version;
log(`game ${game}: create vendored gf-multiplayer ${created}; playing on ${version}`);

const record = { at: new Date().toISOString(), kit: { created, played: version }, ports: { hostPage: PA, signaling: PS, friendPage: PB }, cases: {} };
const servers = [];
const stopAll = async () => { for (const s of servers.splice(0)) await s().catch(() => {}); };
const noticeOf = page => page.evaluate(() => ({ state: window.GAMESFUN_ONLINE ?? null, notice: document.getElementById('gamesfun-online-notice')?.textContent ?? null, kit: window.__party?.snapshot()?.phase ?? null })).catch(() => null);

// a stand-in play host on the middle port: the play host's own signaling code, the switch off; `cors: false` answers the
// way a host that does not know outside games does (no page on another origin may read it)
async function refusingHost({ cors }) {
  const core = await import(pathToFileURL(path.join(BUILDER, 'studio-lib', 'signal-core.mjs')).href);
  const outside = core.outsideFromEnv({});                       // PLAY_OUTSIDE unset: off
  const sig = core.createSignaling({ store: core.memoryStore(), secret: 'online-e2e', outside });
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const origin = req.headers.origin ?? null, host = `127.0.0.1:${PS}`, pathname = new URL(req.url, 'http://x').pathname;
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', ...(cors ? core.corsHeaders(origin) : {}) };
    let r;
    if (req.method === 'OPTIONS') r = { status: cors ? 204 : 403, body: null };
    else if (pathname === '/signal/v1/ice') r = cors ? await sig.iceOutside({ origin, host, ip: '127.0.0.1', env: {}, outside }) : sig.ice({ origin, host, env: {} });
    else r = await sig.request({ origin, host, ip: '127.0.0.1', body: Buffer.concat(chunks).toString('utf8'), outside: cors ? outside : null });
    seen.push({ method: req.method, path: pathname, origin, status: r.status, body: r.body });
    res.writeHead(r.status, headers); res.end(r.body ? JSON.stringify(r.body) : undefined);
  });
  await new Promise((ok, no) => { server.once('error', no); server.listen(PS, '127.0.0.1', ok); });
  servers.push(() => new Promise(r => { server.close(r); server.closeAllConnections?.(); }));
  return { seen };
}
const dev = async (port, e = env) => { const s = await startDevServer({ gameDir: game, port, log: () => {}, watch: false, env: e }); servers.push(() => s.close()); return s; };

try {
  if (!only || only === 'A') {
    log('case A: online through a signaling server on another origin, the friend on a third');
    const { startSignalServer } = await import(pathToFileURL(path.join(BUILDER, 'multiplayer', 'p2p', 'serve-signal.mjs')).href);
    const sig = await startSignalServer({ port: PS, host: '127.0.0.1', allow: `http://127.0.0.1:${PA},http://127.0.0.1:${PB}`, log: () => {} });
    servers.push(() => sig.close());
    const A = await dev(PA), B = await dev(PB);
    const html = await (await fetch(new URL('game/gf/mp/', A.url))).text();
    check('A the friends page carries the online line before its first script', html.search(/<script\b/i) === html.indexOf('<script>window.GF_P2P_CONFIG = Object.assign({ signal: \'online\''), ONLINE_LINE);
    let seenBefore = null;
    const r = await twoPlayers(A.url, { shots: out, joinerBase: B.url, log, onPages: async ({ host }) => { seenBefore = await noticeOf(host); } });
    const stats = { signaling: sig.sig.stats(), hostDev: A.signaling.stats(), friendDev: B.signaling.stats() };
    record.cases.A = { invite: r.invite, friendUrl: r.friendUrl, samples: r.samples, inPlace: r.inPlace, onScreen: r.onScreen, errors: r.errors, host: r.host, joiner: r.joiner, stats, page: seenBefore };
    check('A the friend joined from another origin and each page draws the other player in place', r.ok, `${r.inPlace}/${r.samples} samples in place; host page ${new URL(r.invite).origin}, friend page ${new URL(r.friendUrl).origin}; errors ${JSON.stringify(r.errors)}`);
    check('A the two pages are on two origins, and the signaling on a third', new URL(r.invite).origin !== new URL(r.friendUrl).origin && ![new URL(r.invite).origin, new URL(r.friendUrl).origin].includes(new URL(SIGNAL).origin));
    check('A the room was opened on the signaling server, not on either dev server', stats.signaling.httpRooms >= 1 && stats.signaling.httpJoins >= 1 && [stats.hostDev, stats.friendDev].every(d => d.rooms === 0 && d.httpRooms === 0 && d.joins === 0 && d.httpJoins === 0), `signaling: ${stats.signaling.httpRooms} room(s), ${stats.signaling.httpJoins} join(s) over HTTP; the dev servers: ${stats.hostDev.rooms + stats.hostDev.httpRooms} and ${stats.friendDev.rooms + stats.friendDev.httpRooms}`);
    check('A the page said nothing: online play worked', seenBefore?.state?.use === 'online' && !seenBefore?.notice, JSON.stringify(seenBefore));
    await stopAll();
  }
  for (const [id, cors] of [['B', true], ['C', false]]) {
    if (only && only !== id) continue;
    log(`case ${id}: the online host ${cors ? 'refuses (switch off)' : 'cannot be read by the page'}; the game goes on with this machine`);
    const host = await refusingHost({ cors });
    const A = await dev(PA);
    let seen = null;
    const r = await twoPlayers(A.url, { log, seconds: 6, onPages: async ({ host: H }) => { seen = await noticeOf(H); await H.screenshot({ path: path.join(out, `${id}-notice.png`) }); } });
    const dv = A.signaling.stats();
    record.cases[id] = { invite: r.invite, samples: r.samples, inPlace: r.inPlace, errors: r.errors, page: seen, hostAnswers: host.seen.slice(0, 6), devSignaling: dv };
    const words = cors ? /^Online play is not available from this page: Online play for games run from other sites is off for now\. Play in two tabs on this machine, or host your own signaling\. Friends can still join on this machine/ : /^Online play could not be reached \(127\.0\.0\.1:\d+ did not answer this page\)\. Friends can still join on this machine/;
    check(`${id} the host answered the page's first request with a refusal`, host.seen.some(x => x.path === '/signal/v1/ice' && x.status === 403), JSON.stringify(host.seen[0]));
    check(`${id} the page says so in plain words`, words.test(seen?.notice ?? ''), seen?.notice);
    check(`${id} the page went on with this machine: a room, a second tab joined, both in one round`, r.ok && seen?.state?.use === 'this-machine', `${r.inPlace}/${r.samples} in place; errors ${JSON.stringify(r.errors)}`);
    check(`${id} the room is on this machine's own signaling, and none was opened on the host that refused`, dv.rooms + dv.httpRooms >= 1 && dv.joins + dv.httpJoins >= 1 && !host.seen.some(x => x.body?.t === 'hosted'), `this machine: ${dv.rooms + dv.httpRooms} room(s), ${dv.joins + dv.httpJoins} join(s)`);
    await stopAll();
  }
} catch (e) {
  check('the run finished', false, e.stack ?? e.message);
} finally {
  await stopAll();
  record.checks = checks; record.ok = checks.length > 0 && checks.every(c => c.ok);
  await writeFile(path.join(out, 'online-e2e.json'), JSON.stringify(record, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
console.log(`${record.ok ? 'ONLINE-E2E PASS' : 'ONLINE-E2E FAIL'}  record: ${path.join(out, 'online-e2e.json')}`);
process.exitCode = record.ok ? 0 : 1;
