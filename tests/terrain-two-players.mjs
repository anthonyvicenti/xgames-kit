// The terrain world over real WebRTC: a host and a joiner in one room of a game with the terrain world and the carve
// mechanic (the example crater-isles, or any such game), the host lobbing bombs with real clicks. Both screens must hold
// the same ground (window.__game.terrainHash(): a hash of every sample of the field) with the craters in it; then a third
// player joins late and must get the same edited ground (the host's log, replayed on the same generated land).
//
//   node tests/terrain-two-players.mjs <game dir> [--shots <dir>] [--bombs 6] [--late]
// Under the GPU wrapper on Linux: .claude/scripts/gpu-run.sh node tests/terrain-two-players.mjs ...
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { isMain } from '../builder/lib/main.mjs';
import { serve } from '../builder/tools/serve.mjs';
import { launchChrome } from '../builder/qa/browser.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) {
  const t0 = Date.now();
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(200); }
}
const party = page => page.evaluate(() => window.__party?.snapshot() ?? null).catch(() => null);
const gameFrame = page => page.frames().find(f => f.parentFrame() === page.mainFrame());
const inGame = (page, fn) => gameFrame(page)?.evaluate(fn).catch(() => null) ?? null;
const ground = page => inGame(page, () => (window.__game?.terrainHash ? { hash: window.__game.terrainHash(), t: window.__game.terrain(), started: !!window.__game.snapshot()?.net?.started } : null));

export async function terrainTwoPlayers(dir, { shots = null, bombs = 6, late = true, log = () => {} } = {}) {
  const s = await serve(dir, { port: 0 });
  const browser = await launchChrome({ gpu: 'webgl', disableFeatures: ['WebRtcHideLocalIpsWithMdns'], args: ['--autoplay-policy=no-user-gesture-required'] });
  const errors = [], out = { ok: false, steps: [] };
  const step = (name, ok, saw) => { out.steps.push({ name, ok: !!ok, saw }); log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${saw}`); };
  if (shots) mkdirSync(shots, { recursive: true });
  const open = async label => {
    const c = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await c.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${label}: ${m.text()}`); });
    return page;
  };
  const join = async (page, name, url) => {
    await page.goto(url, { waitUntil: 'load' });
    await until(async () => (await party(page))?.phase === 'home', 20000, `${name}'s lobby`);
    await page.fill('#gfp-name', name);
    await page.click('#gfp-join');
  };
  try {
    const H = await open('host'), J = await open('joiner');
    await H.goto(s.partyUrl, { waitUntil: 'load' });
    await until(async () => (await party(H))?.phase === 'home', 20000, 'the host lobby');
    await H.fill('#gfp-name', 'Hosta');
    await H.click('#gfp-host');
    await until(async () => { const p = await party(H); return p?.phase === 'room' && p.code ? p : null; }, 20000, 'the host to open a room');
    const invite = await H.inputValue('#mp-invite');
    await join(J, 'Joan', invite);
    await until(async () => (await party(H))?.racers?.length === 2 && (await party(J))?.racers?.length === 2, 30000, 'both players in the room');
    await H.click('#mp-start');
    await until(async () => (await ground(H))?.started && (await ground(J))?.started, 90000, 'the round to start on both');
    const g0 = [await ground(H), await ground(J)];
    step('both copies start on the same generated ground', g0[0].hash === g0[1].hash, `host ${g0[0].hash}, joiner ${g0[1].hash}`);

    // the host lobs bombs with real clicks at the ground under its crosshair (the camera tilted down first)
    const frameH = gameFrame(H);
    await frameH.locator('canvas').first().click({ position: { x: 640, y: 360 } }).catch(() => {});
    await H.mouse.move(640, 360); await H.mouse.move(640, 470, { steps: 6 });
    for (let i = 0; i < bombs; i++) {
      await H.mouse.move(640 + (i % 3 - 1) * 90, 470 + (i % 2) * 30, { steps: 3 });
      await H.mouse.down(); await sleep(70); await H.mouse.up();
      await sleep(1100);
    }
    await sleep(3000);
    const [h1, j1] = [await ground(H), await ground(J)];
    const made = h1.t.carve?.applied ?? 0;
    step('the host\'s bombs carved craters', made > 0 && h1.hash !== g0[0].hash, `${made} edits on the host (${h1.t.carve?.stats?.carved} carved), ground ${g0[0].hash} → ${h1.hash}`);
    step('the joiner holds the same ground, every crater in the same place', h1.hash === j1.hash && (j1.t.carve?.applied ?? 0) === made, `host ${h1.hash} (${made} edits), joiner ${j1.hash} (${j1.t.carve?.applied} edits)`);
    step('the joiner saw each crater as it happened (not caught up afterwards)', (j1.t.carve?.stats?.caughtUp ?? 0) === 0 && (j1.t.carve?.stats?.carved ?? 0) === made, `joiner carved ${j1.t.carve?.stats?.carved} live, caught up ${j1.t.carve?.stats?.caughtUp}`);
    if (shots) {
      await H.screenshot({ path: path.join(shots, 'host.png') }); await J.screenshot({ path: path.join(shots, 'joiner.png') });
      // the same wide view on both screens (the look's contact-sheet camera): the craters in the same places, by eye
      for (const [p, n] of [[H, 'host-wide.png'], [J, 'joiner-wide.png']]) { await inGame(p, () => window.__gfLook?.shot('wide')); await sleep(600); await p.screenshot({ path: path.join(shots, n) }); await inGame(p, () => window.__gfLook?.shot(null)); }
    }

    if (late) {
      // a third player joins the round already under way: the host sends its log, the late copy replays it
      const L = await open('late');
      await join(L, 'Lenny', invite);
      await until(async () => (await ground(L))?.started, 90000, 'the late copy to load');
      await until(async () => { const g = await ground(L); return g && g.t.carve?.applied >= made ? g : null; }, 20000, 'the late copy to catch up');
      const [h2, l2] = [await ground(H), await ground(L)];
      step('a late joiner gets the edited ground', h2.hash === l2.hash, `host ${h2.hash}, late ${l2.hash} (${l2.t.carve?.applied} edits, ${l2.t.carve?.stats?.caughtUp} from the host's log, asked ${l2.t.carve?.stats?.asked}×)`);
      if (shots) await L.screenshot({ path: path.join(shots, 'late.png') });
    }
    step('no page errors', errors.length === 0, errors.slice(0, 5).join(' | ') || 'none');
    out.ok = out.steps.every(x => x.ok);
    out.remeshMs = { host: h1.t.remeshMax, joiner: j1.t.remeshMax };
    return out;
  } catch (e) {
    step('the run finished', false, e.message);
    out.errors = errors;
    return out;
  } finally { await browser.close().catch(() => {}); await s.close?.().catch?.(() => {}); s.server?.close?.(); }
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), arg = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const dir = a.find((x, i) => !x.startsWith('--') && !['--shots', '--bombs'].includes(a[i - 1]));
  if (!dir) { console.error('usage: node tests/terrain-two-players.mjs <game dir> [--shots <dir>] [--bombs 6] [--no-late]'); process.exit(2); }
  const r = await terrainTwoPlayers(dir, { shots: arg('--shots'), bombs: Number(arg('--bombs') ?? 6), late: !a.includes('--no-late'), log: m => console.error(m) });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
