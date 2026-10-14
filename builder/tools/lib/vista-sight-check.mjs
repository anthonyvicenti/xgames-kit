// verify check 5's vista leg (CONTRACT §8 vista; research/super-scenic/PLAN.md §5 wave 1: "a second player through
// gf/mp: each sees the other where they really are"; gf-vista/tools/two-players.mjs is the wave 1 proof this
// follows): two players over real WebRTC through the kit's friends page, in WebGPU Chrome, with real keys. It proves what
// the live gate's random input does not every time in first person (a random walk can leave a friend out of view):
//
//   bodies            each copy draws the other as a gf-humanoid-1 body (the game's body slot for that seat), not the
//                     stand-in figure
//   in sight          at the start place every seat faces the others (config/world.json places): each player has the
//                     other on screen (the game's own projection: in front, in view, no hill between)
//   drawn by the core the friend's body, hidden and shown again, changes the pixels in its box on the screen (at least
//                     15% of them, and twice what two frames with it hidden differ by: the sea behind it moves; the core
//                     draws it; a name tag alone would not), with the name tags off for those frames
//   where they are    the joiner walks with real keys; once it stops, the host draws it within 0.5 m of where the
//                     joiner's own copy has it, and the other way round after the host walks
//
//   const r = await checkVistaSight({ dir, outDir, shots, log });   → { ok, detail, record, warnings }
import { join } from 'node:path';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { snap, sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { launchForGame } from './paths.mjs';
import { lockFor } from './lock.mjs';

const NEAR = 0.5;
const r3 = v => Math.round(v * 1000) / 1000;

export async function checkVistaSight({ dir, outDir = null, shots = [], log = () => {} } = {}) {
  const record = { steps: [], shots: [], bodies: null, sight: null, walk: null, pixels: null };
  const warnings = [];
  const step = (name, ok, detail) => { record.steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} vista ${name}: ${detail}`); return !!ok; };
  const srv = await startParty({ dir, port: 0 });
  const { browser, gpu } = await launchForGame(launchChrome, dir, { place: { runtime: 'vista' } });
  const errors = [];
  const player = async who => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] }; });
    const page = await ctx.newPage();
    await lockFor(page, gpu);
    page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(`${who}: ${m.text().slice(0, 240)}`); });
    return { who, ctx, page };
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const ev = (P, fn, arg) => frameOf(P)?.evaluate(fn, arg).catch(() => null) ?? null;
  const shot = async (P, name) => {
    if (!outDir) return null;
    const f = `vista-${String(record.shots.length + 1).padStart(2, '0')}-${name}.jpg`;
    record.shots.push(f); shots.push(f);
    await P.page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }).catch(() => {});
    return f;
  };
  let ok = true;
  try {
    const H = await player('host'), J = await player('joiner');
    await H.page.goto(`${srv.partyUrl}?max=300`, { waitUntil: 'load' });
    await until(async () => (await snap(H.page))?.phase === 'home', 20000, 'the lobby');
    await H.page.fill('#gfp-name', 'Hosta'); await H.page.click('#gfp-host');
    await until(async () => (await snap(H.page))?.phase === 'room', 20000, 'the room');
    await J.page.goto(await H.page.inputValue('#mp-invite'), { waitUntil: 'load' });
    await until(async () => (await snap(J.page))?.phase === 'home', 20000, 'the joiner lobby');
    await J.page.fill('#gfp-name', 'Joan'); await J.page.click('#gfp-join');
    await until(async () => (await snap(H.page))?.racers.length === 2, 30000, 'both players in the room');
    await H.page.click('#mp-start');
    await until(async () => (await ev(H, () => window.__game?.snapshot?.()?.net?.started)) && (await ev(J, () => window.__game?.snapshot?.()?.net?.started)), 180000, 'both games to start (the core boots and compiles its shaders on each)');
    const [h0, j0] = [await ev(H, () => window.__game.snapshot()), await ev(J, () => window.__game.snapshot())];
    const hid = h0.me, jid = j0.me;
    // the bodies: each copy's friend as a gf-humanoid-1 body (it replaces the stand-in once its files have loaded)
    const bodyOf = (P, id) => ev(P, id => window.__game.vista.friends().find(f => f.id === id)?.body ?? null, id);
    await until(async () => (await bodyOf(H, jid)) === 'gf-humanoid-1' && (await bodyOf(J, hid)) === 'gf-humanoid-1', 30000, 'the gf-humanoid-1 bodies').catch(() => {});
    record.bodies = { hostDrawsJoinerAs: await bodyOf(H, jid), joinerDrawsHostAs: await bodyOf(J, hid) };
    ok = step('friends-are-bodies', record.bodies.hostDrawsJoinerAs === 'gf-humanoid-1' && record.bodies.joinerDrawsHostAs === 'gf-humanoid-1', `the host draws the joiner as ${record.bodies.hostDrawsJoinerAs ?? 'nothing'}, the joiner draws the host as ${record.bodies.joinerDrawsHostAs ?? 'nothing'} (gf-humanoid-1 bodies from the game's body slots)`) && ok;
    await sleep(800);
    // in sight at the start place (seats face each other)
    const seen = async (P, id) => ev(P, id => window.__game.snapshot().net?.peers?.find(p => p.id === id)?.onScreen ?? false, id);
    const [hs, js] = [await seen(H, jid), await seen(J, hid)];
    record.sight = { hostSeesJoiner: hs, joinerSeesHost: js };
    await shot(H, 'host-sees-the-joiner'); await shot(J, 'joiner-sees-the-host');
    ok = step('each-sees-the-other', hs && js, `at the start place: the host has the joiner ${hs ? 'on screen' : 'off screen'}, the joiner has the host ${js ? 'on screen' : 'off screen'}`) && ok;
    // drawn by the core: the friend's body hidden and shown again changes the pixels in its box
    const pixels = async (P, id) => {
      const pr = await ev(P, id => { window.__game.vista.tags(false); return window.__game.vista.project(id); }, id);
      if (!pr?.rect) return { ok: false, why: 'the friend is not in front of the camera' };
      const clip = { x: Math.max(0, Math.floor(pr.rect.x0) - 4), y: Math.max(0, Math.floor(pr.rect.y0) - 4) };
      clip.width = Math.min(1280, Math.ceil(pr.rect.x1) + 4) - clip.x; clip.height = Math.min(720, Math.ceil(pr.rect.y1) + 4) - clip.y;
      if (clip.width < 4 || clip.height < 4) return { ok: false, why: `the friend's box is ${clip.width}x${clip.height} px` };
      const box = await P.page.locator('#game').boundingBox().catch(() => null) ?? { x: 0, y: 0 };
      const at = { x: Math.round(box.x + clip.x), y: Math.round(box.y + clip.y), width: clip.width, height: clip.height };
      const grab = () => P.page.screenshot({ type: 'png', clip: at });
      const A = await grab();
      await ev(P, id => window.__game.vista.showFriend(id, false), id); await sleep(500);
      const B = await grab(); await sleep(500); const B2 = await grab();
      await ev(P, id => window.__game.vista.showFriend(id, true), id); await sleep(500);
      const C = await grab();
      await ev(P, () => window.__game.vista.tags(true));
      const page = await browser.newPage();
      try {
        return await page.evaluate(async ([a, b, b2, c]) => {
          const load = async s => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); const cv = new OffscreenCanvas(im.width, im.height); const g = cv.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, im.width, im.height).data; };
          const [A, B, B2, C] = await Promise.all([a, b, b2, c].map(load));
          const diff = (x, y) => { let n = 0, d = 0; for (let i = 0; i < x.length; i += 4) { n++; if (Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]) > 24 * 3) d++; } return d / n; };
          const hide = diff(A, B), show = diff(B2, C), still = diff(B, B2);
          return { ok: hide > Math.max(0.15, 2 * still) && show > Math.max(0.15, 2 * still), hide, show, still };
        }, [A, B, B2, C].map(x => x.toString('base64')));
      } finally { await page.close(); }
    };
    const [ph, pj] = [await pixels(H, jid), await pixels(J, hid)];
    record.pixels = { host: ph, joiner: pj };
    const line = (who, p) => (p.why ? `${who}: ${p.why}` : `${who}: hiding the body changed ${(p.hide * 100).toFixed(0)}% of its box, showing it again ${(p.show * 100).toFixed(0)}% (two hidden frames differ by ${(p.still * 100).toFixed(0)}%)`);
    ok = step('the-core-draws-the-friend', ph.ok && pj.ok, `${line('on the host', ph)}; ${line('on the joiner', pj)}`) && ok;
    // where they are: the joiner walks with real keys, then the host
    const focus = async P => { await frameOf(P)?.focus('#app canvas').catch(() => {}); await sleep(100); };
    const at = (P, id) => ev(P, id => { const s = window.__game.snapshot(); return id ? s.players.find(p => p.id === id) : s.vista.player; }, id);
    const d3 = (a, b) => (a && b ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity);
    await focus(J);
    const j1 = await at(J);
    await J.page.keyboard.down('KeyD'); await sleep(900); await J.page.keyboard.up('KeyD'); await sleep(1500);
    const j2 = await at(J), hj = await at(H, jid);
    await focus(H);
    const h1 = await at(H);
    await H.page.keyboard.down('KeyA'); await sleep(900); await H.page.keyboard.up('KeyA'); await sleep(1500);
    const h2 = await at(H), jh = await at(J, hid);
    record.walk = { joinerWalked: r3(d3(j1, j2)), hostDrawsJoinerOff: r3(d3(hj, j2)), hostWalked: r3(d3(h1, h2)), joinerDrawsHostOff: r3(d3(jh, h2)) };
    ok = step('drawn-where-they-are', record.walk.joinerWalked > 1 && record.walk.hostWalked > 1 && record.walk.hostDrawsJoinerOff <= NEAR && record.walk.joinerDrawsHostOff <= NEAR,
      `the joiner walked ${record.walk.joinerWalked} m on real keys and the host draws it ${record.walk.hostDrawsJoinerOff} m from where it is; the host walked ${record.walk.hostWalked} m and the joiner draws it ${record.walk.joinerDrawsHostOff} m off (allowed ${NEAR})`) && ok;
    await shot(H, 'host-after-the-walk');
  } catch (e) {
    ok = step('run', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  const own = errors.filter(e => !/ShoreWaves\.buildDirTexture/.test(e));
  if (own.length) { ok = false; step('no-errors', false, own.slice(0, 2).join(' | ')); }
  const failed = record.steps.filter(s => !s.ok);
  return { ok: ok && failed.length === 0, record, warnings, detail: failed.length ? failed.map(s => `${s.name}: ${s.detail}`).join(' · ') : record.steps.map(s => `${s.name} (${s.detail})`).join('; ') };
}
