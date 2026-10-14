#!/usr/bin/env node
// Two players hop islands together, on a game create made from a spec v2 (examples/minimal/isle-hop): two headless
// WebGPU pages, a host and a joiner, join through the kit's friends lobby over real WebRTC (gf/mp, live mode), and
//   1. the host's copy goes to island 2: its island rides in its world message, the joiner's copy follows; both build
//      island 2 (the spec's place, by its key), arrive aboard at its dock, and each draws the other where that player's
//      own copy says it is;
//   2. the joiner asks for island 1 (its copy sends the ask; the host's copy decides, through the game's own gate): both
//      go back;
//   3. a player who comes in mid-trip: the joiner's game frame loads again while the host goes on to island 3; its fresh
//      copy (built on island 1) takes the host's island from the first world message and lands there.
// The shortcut, said plainly: a hop starts through window.__game.vista.hop (QA: the host's follow, the joiner's ask)
// instead of a sail-out at the helm; what happens after it (the world message, the rebuild, the arrival) is the game's.
//
//   gpu-run.sh node runtimes/vista/tools/hop-friends.mjs <game dir> [--out <dir>]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { launchChrome, LOCAL_WEBRTC_OFF } from '../../../builder/qa/browser.mjs';
import { startParty } from '../../../builder/multiplayer/party/lib.mjs';
import { snap, until, sleep, p2p } from '../../../builder/multiplayer/party/gate-lib.mjs';
import { expectedIslands } from '../../../builder/tools/verify-vista.mjs';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i < 0 ? d : (process.argv[i + 1] ?? true); };
const DIR = resolve(process.argv[2] ?? '');
const OUT = resolve(String(arg('out', join(DIR, 'hop-friends'))));
const NEAR = 0.5;
const rec = { tool: 'runtimes/vista/tools/hop-friends.mjs', started: new Date().toISOString(), game: DIR, near: NEAR, shortcut: 'a hop starts through window.__game.vista.hop (the host\'s copy follows its own decision; the joiner\'s copy asks the host), not a sail-out at the helm', checks: [], numbers: {}, shots: [], errors: [], notes: [] };
const check = (name, ok, detail = '') => { rec.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`); return !!ok; };
const r3 = v => Math.round(v * 1000) / 1000;

await mkdir(OUT, { recursive: true });
const { list } = await expectedIslands(DIR);
rec.islands = list.map(({ name, seed, key }) => ({ name, seed, key }));
const srv = await startParty({ dir: DIR, port: 0 });
const browser = await launchChrome({ gpu: 'webgpu', disableFeatures: LOCAL_WEBRTC_OFF });
rec.gpu = browser.webgpu ?? null;
const frameOf = page => page.frames().find(f => f.parentFrame() === page.mainFrame());
const game = (P, fn, a) => frameOf(P.page).evaluate(fn, a);
const gsnap = P => game(P, () => window.__game?.snapshot() ?? null).catch(() => null);
async function player(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => rec.errors.push({ who: label, text: e.message.slice(0, 300) }));
  page.on('console', m => { if (m.type() === 'error' && !/favicon|ShoreWaves/.test(m.text())) rec.errors.push({ who: label, text: m.text().slice(0, 300) }); });
  return { label, ctx, page };
}
const shot = async (P, name, note) => { const file = `${String(rec.shots.length + 1).padStart(2, '0')}-${P.label}-${name}.jpg`; await P.page.screenshot({ path: join(OUT, file), type: 'jpeg', quality: 80 }); rec.shots.push({ file, note }); };
// where each draws the other, against where the other's own copy says it is
async function together(H, J, hid, jid) {
  const [h, j] = [await gsnap(H), await gsnap(J)];
  const me = s => s.players.find(p => p.local), other = (s, id) => s.players.find(p => p.id === id);
  const hj = other(h, jid), jh = other(j, hid), jm = me(j), hm = me(h);
  const gap = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.z - b.z) : Infinity);
  return { h, j, errJ: gap(hj, jm), errH: gap(jh, hm), seen: { hostSeesJoiner: !!hj?.onScreen, joinerSeesHost: !!jh?.onScreen } };
}

let exit = 1;
try {
  const H = await player('host'), J = await player('joiner');
  const t0 = Date.now();
  await H.page.goto(`${srv.url}gf/mp/`, { waitUntil: 'load' });
  await until(async () => (await snap(H.page))?.phase === 'home', 30000, 'the host lobby');
  await H.page.fill('#gfp-name', 'Hosta');
  await H.page.click('#gfp-host');
  const hs = await until(async () => { const s = await snap(H.page); return s?.phase === 'room' && s.code ? s : null; }, 30000, 'the room');
  const invite = await H.page.inputValue('#mp-invite');
  await J.page.goto(invite, { waitUntil: 'load' });
  await until(async () => (await snap(J.page))?.phase === 'home', 30000, 'the joiner lobby');
  await J.page.fill('#gfp-name', 'Joan');
  await J.page.click('#gfp-join');
  await until(async () => (await snap(H.page))?.racers?.length === 2 && (await snap(J.page))?.racers?.length === 2, 45000, 'both players in the room');
  const conn = await p2p(J.page);
  check('joiner-joins-over-webrtc', conn?.connected === true, `room ${hs.code}`);
  await H.page.click('#mp-start');
  await until(async () => (await snap(H.page))?.gameReady && (await snap(J.page))?.gameReady, 240000, 'both games ready');
  await until(async () => (await gsnap(H))?.net?.started && (await gsnap(J))?.net?.started, 120000, 'both games started');
  rec.numbers.secondsToBothStarted = Math.round((Date.now() - t0) / 100) / 10;
  const [h0, j0] = [await gsnap(H), await gsnap(J)];
  const hid = h0.me, jid = j0.me;
  check('one-host', h0.host === true && j0.host === false, `host ${hid}, joiner ${jid}`);
  check('both-on-island-1', h0.world.island === 0 && j0.world.island === 0 && h0.world.place.key === list[0].key && j0.world.place.key === list[0].key, `${h0.world.names[0]}: place ${h0.world.place.key} on both (the spec's ${list[0].key})`);
  await sleep(1500);
  await shot(H, 'island-1', `the host on ${list[0].name}`);

  // ---- 1. the host's copy goes to island 2; the joiner's follows from the world message
  const tA = Date.now();
  const [rh, rj] = await Promise.all([game(H, () => window.__game.vista.hop(1)), until(async () => { const s = await gsnap(J); return s?.world?.island === 1 && s.world.place.key === list[1].key ? s : null; }, 90000, 'the joiner on island 2').then(() => ({ ok: true }), e => ({ ok: false, why: e.message }))]);
  rec.numbers.hop1 = { hostMs: Date.now() - tA, host: rh, joiner: rj };
  await sleep(3000);   // poses settle (the kit draws 130 ms behind, then smoothing)
  const a = await together(H, J, hid, jid);
  rec.numbers.atIsland2 = { errHostDrawsJoiner: r3(a.errJ), errJoinerDrawsHost: r3(a.errH), seen: a.seen, host: a.h.world, joiner: a.j.world };
  check('both-on-island-2', rh?.ok && rj.ok && a.h.world.place.key === list[1].key && a.j.world.place.key === list[1].key, `host and joiner on ${list[1].name} (place ${list[1].key})`);
  check('host-draws-the-joiner-where-it-is', a.errJ <= NEAR, `${a.errJ.toFixed(3)} m (allowed ${NEAR})`);
  check('joiner-draws-the-host-where-it-is', a.errH <= NEAR, `${a.errH.toFixed(3)} m (allowed ${NEAR})`);
  check('they-see-each-other-aboard', a.seen.hostSeesJoiner && a.seen.joinerSeesHost, JSON.stringify(a.seen));
  await shot(H, 'island-2-sees-joiner', `${list[1].name}: the host aboard at the dock`);
  await shot(J, 'island-2-sees-host', `${list[1].name}: the joiner aboard at the dock`);

  // ---- 2. the joiner asks for island 1; the host's copy decides (the game's gate: a friend's ask passes)
  const [rj2] = await Promise.all([game(J, () => window.__game.vista.hop(0))]);
  const back = await until(async () => { const [h, j] = [await gsnap(H), await gsnap(J)]; return h?.world?.island === 0 && j?.world?.island === 0 ? true : null; }, 90000, 'both back on island 1').then(() => true, () => false);
  check('a-joiner-asks-the-host-decides', rj2?.ok && back, `the joiner's ask answered ${JSON.stringify(rj2)}; both on ${list[0].name}: ${back}`);

  // ---- 3. mid-trip: the host goes on to island 3 while the joiner's game frame loads again (a fresh copy)
  if (list.length >= 3) {
    const src = frameOf(J.page).url();
    const hop3 = game(H, () => window.__game.vista.hop(2));
    await sleep(300);
    await frameOf(J.page).goto(src).catch(e => rec.notes.push('joiner frame reload: ' + e.message.slice(0, 200)));
    await hop3;
    const landed = await until(async () => { const s = await gsnap(J); return s?.world?.island === 2 && s.world.place.key === list[2].key ? s : null; }, 240000, 'the fresh joiner on island 3').catch(e => { rec.notes.push(e.message); return null; });
    check('a-player-joining-mid-trip-lands-on-the-current-island', !!landed, landed ? `the joiner's fresh copy booted ${list[0].name}, took the host's island from the world message and landed on ${list[2].name}` : 'the fresh copy did not land on island 3 (see notes)');
    if (landed) { await sleep(2500); await shot(J, 'joined-mid-trip-island-3', `the joiner's fresh copy on ${list[2].name}`); await shot(H, 'island-3', `the host on ${list[2].name}`); }
  }
  const pageErrors = rec.errors;
  check('no-page-errors', pageErrors.length === 0, pageErrors.slice(0, 3).map(e => `${e.who}: ${e.text}`).join(' | '));
  exit = rec.checks.every(c => c.ok) ? 0 : 1;
} catch (e) {
  rec.fatal = String(e?.stack ?? e).slice(0, 1200);
  console.error(e);
} finally {
  rec.finished = new Date().toISOString();
  rec.verdict = exit === 0 ? 'pass' : 'fail';
  rec.passed = rec.checks.filter(c => c.ok).length; rec.total = rec.checks.length;
  await writeFile(join(OUT, 'record.json'), JSON.stringify(rec, null, 2) + '\n');
  await browser.close().catch(() => {});
  await srv.close().catch(() => {});
  console.log(`${rec.verdict}: ${rec.passed}/${rec.total} → ${join(OUT, 'record.json')}`);
  process.exit(exit);
}
