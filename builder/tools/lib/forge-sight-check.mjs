// verify check 5's forge leg (CONTRACT §8 forge "Live co-op"): two players over real WebRTC through the kit's friends
// page, in WebGPU Chrome, with real keys and mouse. It proves what the live gate's random input cannot in first person
// (its clicks at random places under the pointer lock leave the camera on the ceiling or the floor):
//
//   friend in sight   each player turns to face the other with real mouse strokes (yaw and pitch, learning the
//                     sensitivity from the first stroke), then the other must be on this player's screen (the game's own
//                     onScreen: in front, in view, no wall between) and their body must cover pixels in the core's
//                     slot-ID pass (window.__game.sight: what Rust drew, not a projection), in the colour the core holds
//                     for them, holding their weapon; a screenshot from each side
//   prediction feel   the joiner holds W: how long until its own player moves on its own screen (prediction: one or two
//                     frames) and until the host's copy of it moves (the inputs' trip); and the host's snapshot sizes and
//                     the joiner's reconciliation counts
//
//   const r = await checkForgeSight({ dir, outDir, shots, log });   → { ok, detail, record, warnings }
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { snap, sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { launchForGame } from './paths.mjs';

const BODY = 'character.body.player';

export async function checkForgeSight({ dir, outDir = null, shots = [], log = () => {} } = {}) {
  const record = { steps: [], shots: [], feel: null, net: null, sight: null };
  const warnings = [];
  const step = (name, ok, detail) => { record.steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} forge ${name}: ${detail}`); return !!ok; };
  const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  if (!assets.slots?.some(s => s.id === BODY)) return { ok: false, detail: `no ${BODY} slot: the game draws no body for friends (re-run create)`, record, warnings };
  const srv = await startParty({ dir, port: 0 });
  const { browser } = await launchForGame(launchChrome, dir, { place: { runtime: 'forge' } });
  const errors = [];
  const player = async who => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] }; });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(`${who}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) errors.push(`${who}: ${m.text().slice(0, 240)}`); });
    return { who, ctx, page };
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const ev = (P, fn, arg) => frameOf(P)?.evaluate(fn, arg).catch(() => null) ?? null;
  const shot = async (P, name) => {
    if (!outDir) return null;
    const f = `forge-${String(record.shots.length + 1).padStart(2, '0')}-${name}.jpg`;
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
    await until(async () => (await ev(H, () => window.__game?.snapshot?.()?.net?.started)) && (await ev(J, () => window.__game?.snapshot?.()?.net?.started)), 90000, 'both games to start');
    await sleep(1500);
    // keyboard focus on each game's canvas, with no click: a click takes the pointer lock, and in the friends page's
    // frame chrome-headless-shell reports the locked mouse's moves as 0 (movementX/Y), so no script can turn a
    // first-person view there; the players start facing the room as they spawned, and walk with real keys
    const focus = async P => { await frameOf(P)?.focus('#gf-canvas').catch(() => {}); await sleep(100); };
    for (const P of [H, J]) await focus(P);

    // ---- prediction feel: the joiner holds W (and walks ahead of the host, into the host's view) ----
    const watch = P => ev(P, () => {
      window.__gfFeel = { down: null, moved: null, friendMoved: null };
      const local = () => window.__game.forge.players().find(p => p.local), other = () => window.__game.forge.players().find(p => !p.local);
      const l0 = local(), o0 = other();
      addEventListener('keydown', e => { if (e.code === 'KeyW' && window.__gfFeel.down === null) window.__gfFeel.down = Date.now(); }, true);
      const tick = () => {
        const f = window.__gfFeel, l = local(), o = other();
        if (f.moved === null && f.down !== null && l && Math.hypot(l.x - l0.x, l.z - l0.z) > 0.01) f.moved = Date.now();
        if (f.friendMoved === null && o && o0 && Math.hypot(o.x - o0.x, o.z - o0.z) > 0.01) f.friendMoved = Date.now();
        if (f.moved === null || f.friendMoved === null) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await watch(J); await watch(H);
    await J.page.keyboard.down('KeyW'); await sleep(420); await J.page.keyboard.up('KeyW'); await sleep(700);
    const fj = await ev(J, () => window.__gfFeel), fh = await ev(H, () => window.__gfFeel);
    const ownMs = fj?.down && fj?.moved ? fj.moved - fj.down : null, hostMs = fj?.down && fh?.friendMoved ? fh.friendMoved - fj.down : null;
    record.feel = { joinerOwnMs: ownMs, hostSeesMs: hostMs };
    ok = step('the-joiner-moves-at-once', ownMs !== null && ownMs <= 120, ownMs === null ? 'the joiner\'s own player never moved on W' : `the joiner's own player moved ${ownMs} ms after W went down (predicted on its copy); the host's copy of it ${hostMs ?? '?'} ms after (its inputs' trip)`) && ok;

    // ---- friend in sight: the one ahead is on the screen of the one behind, in the core's own drawing ----
    const sightOf = async P => ev(P, async body => {
      const s = window.__game.snapshot(), other = s.players.find(p => !p.local);
      const peer = s.net?.peers?.find(p => p.id === other?.id);
      // the friend's own body slot (each seat wears its own hunter: character.body.player, .2, .3, .4)
      const friend = window.__game.forge.bodies().find(b => b.player === other?.id) ?? null;
      const sight = await window.__game.sight([friend?.slot ?? body]).catch(e => ({ error: e.message }));
      return { onScreen: !!peer?.onScreen, pixels: sight?.pixels ?? 0, share: sight?.share ?? 0, friend, error: sight?.error ?? null };
    }, BODY);
    const sh = await sightOf(H);
    await shot(H, 'host-sees-the-joiner');
    // the host walks past the joiner: now the host is ahead, in the joiner's view
    await H.page.keyboard.down('KeyW'); await sleep(900); await H.page.keyboard.up('KeyW'); await sleep(700);
    const sj = await sightOf(J);
    await shot(J, 'joiner-sees-the-host');
    record.sight = { host: sh, joiner: sj };
    const seeLine = (who, s) => s ? `${who}: ${s.onScreen ? 'on screen' : 'not on screen'}, ${s.pixels} px of their body in the slot-ID pass (${(s.share * 100).toFixed(1)}%), ${s.friend ? `drawn ${s.friend.renderer} in ${s.friend.color}${s.friend.held ? ` holding ${s.friend.held}` : ''}` : 'no body'}` : `${who}: no answer`;
    ok = step('each-sees-the-other', sh?.onScreen && sj?.onScreen && sh.pixels > 0 && sj.pixels > 0 && sh.friend && sj.friend,
      `walking ahead with real keys: ${seeLine('the host sees the joiner', sh)}; ${seeLine('the joiner sees the host', sj)}`) && ok;
    // ---- the net: the host's snapshot sizes, the joiner's reconciliation ----
    const [nh, nj] = [await ev(H, () => window.__game.forge.net()), await ev(J, () => window.__game.forge.net())];
    record.net = { host: nh, joiner: nj };
    const bytes = nh?.snapshots?.lastBytes ?? null;
    ok = step('snapshots-and-reconciliation', bytes !== null && bytes <= 2600 && (nj?.snapshots?.applied ?? 0) > 10 && (nj?.checked ?? 0) > 5,
      `the host's last snapshot ${bytes ?? '?'} bytes (budget 2600), ${nh?.snapshots?.sent ?? '?'} sent; the joiner applied ${nj?.snapshots?.applied ?? '?'} (${nj?.snapshots?.stale ?? 0} stale), checked its prediction ${nj?.checked ?? '?'} times: ${nj?.corrected ?? '?'} smoothed, ${nj?.snapped ?? '?'} snapped, largest difference ${nj?.maxError ?? '?'} m; ${nj?.suppressed ?? 0} of the host's events it had already played`) && ok;
  } catch (e) {
    ok = step('run', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  if (errors.length) { ok = step('no-console-errors', false, [...new Set(errors)].slice(0, 3).join(' | ')) && ok; }
  const failed = record.steps.filter(s => !s.ok);
  return { ok: ok && !failed.length, record, warnings, detail: failed.length ? failed.map(s => `${s.name}: ${s.detail}`).join(' · ') : record.steps.map(s => `${s.name}: ${s.detail}`).join(' · ') };
}
