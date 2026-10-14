// verify check 24: plays inside a post (CONTRACT §6d C5, §5). The creator played a game inside a post on X (2026-10-08):
// "The issue is the mouse controls are pretty janky. It doesn't stay in the iframe, you can easily move your mouse out".
// X frames the card sandboxed without allow-pointer-lock, so the lock is refused and looking is click-drag in a small
// card the cursor walks off. The kit offers a full-screen button where the frame allows it (kit/ui/hud.js); full screen
// keeps the cursor on the game. (A cursor-aim camera for refused locks was tried the same day and taken out: "I am not
// sure I like the top down. Can we undo the top down and just have the full screen button".)
//
// The check frames the game the way a post does: a stand-in post page on another origin, a 480×480 iframe sandboxed
// without allow-pointer-lock (allow-scripts allow-same-origin allow-popups allow-forms) that allows full screen.
// With real mouse and keys it:
//   - plays from the home menu (Play);
//   - clicks the game: the frame refuses the lock, and the camera stays the game's own;
//   - the full-screen button is offered; a click makes the game full screen;
//   - in full screen, a drag turns the camera (a third or first camera; others don't look with the mouse) and W moves;
//   - in full screen, a camera that looks with the mouse (cursor mode off) follows it with no button held, keeps turning
//     while the cursor rests at the screen's edge, and stops when it comes back (the creator in a post on X, 2026-10-12:
//     "Controls for [the forge zombie game] is still bad on full screen in X. The mouse doesnt want to follow at all";
//     research/foundations/evidence/x-post-fullscreen-mouse-follow-2026-10-12/report.json);
//   - a world in first person (CONTRACT §9): there a click on a block builds on it (in full screen the camera follows the
//     mouse and the crosshair aims, as under the lock; the bare page is a practice copy, so nothing is saved);
//   - the button again leaves full screen;
//   - no console errors but the browser's own refusal of the lock.
import { createServer } from 'node:http';
import { findBuildSpot, faces, actOn } from './worlds-check.mjs';
import { holdsBody, whereIs } from './part-signs.mjs';
import { walkOf } from './flat-reads.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
// the turn between two yaws, the short way round (a turn past ±π is not a turn of 2π)
const turn = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a))) : 0);
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : String(v));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }

export const CARD = 480;
export const POST_SANDBOX = 'allow-scripts allow-same-origin allow-popups allow-forms';
/** The stand-in post: the game in a card-sized frame that refuses the pointer lock and allows full screen. */
export const POST_HTML = gameUrl => `<!doctype html><meta charset="utf-8"><title>A post</title>
<body style="margin:0;background:#000;color:#fff;font:15px system-ui">
<p style="margin:12px">Someone posted a game:</p>
<iframe id="card" src="${gameUrl}" width="${CARD}" height="${CARD}" style="border:0;margin:0 12px;display:block"
 sandbox="${POST_SANDBOX}" allow="autoplay; fullscreen"></iframe></body>`;
// The browser's own words when the frame refuses the lock: expected here, never a game error.
const LOCK_REFUSED = /pointer lock.*sandboxed|allow-pointer-lock/i;
const GPU_NOISE = /GPU stall|ReadPixels|GL_CLOSE_PATH|WebGL: too many errors/i;

export async function checkEmbed({ newPage, url, game = {}, flat = null, log = () => {}, shot = null }) {
  const gameUrl = `${url}${url.includes('?') ? '&' : '?'}seed=4&bots=1`;
  const html = POST_HTML(gameUrl);
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const postUrl = `http://127.0.0.1:${server.address().port}/status/1`;
  const T = await newPage('post', { realLock: true });   // this page tests the frame's own refusal of the lock (tools/lib/lock.mjs)
  const p = T.page, steps = [], fail = [], warnings = [];
  // the orbit camera (CONTRACT §9) never asks for the lock: the mouse stays free, a drag turns it, a click acts
  // The follow camera (CONTRACT §8, scenic) never asks either: the cursor aims and nothing turns the camera
  // (kit/core/input.js: input.cursorMode true). Until 2026-10-10 it was held to "the frame refused the lock", which a
  // camera that never asks cannot show, so every game with the follow camera failed here on create's untouched output.
  // A flat game (tools/lib/flat-reads.mjs) says so itself: its pointer never locks and never turns the camera.
  const pointer = flat?.reads?.pointer ?? null, fwd = walkOf(flat).forward, key = fwd.replace(/^Key/, '');
  const camera = game.camera ?? 'third', orbit = camera === 'orbit', free = orbit || camera === 'follow' || pointer?.locks === false;
  const looks = (camera === 'third' || camera === 'first' || orbit) && pointer?.turnsCamera !== false;
  const record = { camera, steps };
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); if (!ok) fail.push(`${name}${detail ? ` (${detail})` : ''}`); return !!ok; };
  const F = p.frameLocator('#card');
  const frame = () => p.frames().find(f => f !== p.mainFrame());
  const gm = fn => frame()?.evaluate(fn).catch(() => null);
  const cam = () => gm(() => window.__game?.camera?.() ?? null);
  const me = () => gm(() => window.__game.players.find(x => x.local));
  try {
    await p.goto(postUrl, { waitUntil: 'load' });
    await until(() => gm(() => window.__game?.menu?.()?.view === 'home'), 90000, 'the game\'s home menu');
    await F.locator('#gf-play').first().click({ timeout: 5000 });
    await until(() => gm(() => window.__game?.phase === 'playing'), 30000, 'the round to start');
    step('plays from the home menu inside the post', true);
    const b = await p.locator('#card').boundingBox();
    await p.mouse.click(b.x + b.width / 2, b.y + b.height * 0.62); await sleep(600);
    const c1 = await cam(); record.afterClick = c1;
    if (!c1) throw new Error('the game has no camera observation (window.__game.camera): a kit before 2026-10-08');
    if (free) step('the camera needs no pointer lock (it never asks), and stays the game\'s own', !c1.locked && c1.mode === camera && c1.cursorMode,
      `locked ${c1.locked}, cursor mode ${c1.cursorMode}, camera ${c1.mode} (the game's: ${camera})`);
    else step('the post\'s frame refuses the pointer lock, and the camera stays the game\'s own', c1.lockRefused && !c1.locked && c1.mode === camera,
      `lock refused ${c1.lockRefused}, locked ${c1.locked}, camera ${c1.mode} (the game's: ${camera})`);
    if (shot) await shot(p, 'post-card');
    // full screen: the frame allows it, so the kit's button must be there and work
    const fs0 = c1.fullscreen;
    if (step('the full-screen button is offered', fs0?.shown, JSON.stringify(fs0))) {
      await F.locator('#gf-fullscreen').click({ timeout: 4000 });
      const on = await until(async () => ((await cam())?.fullscreen?.on ? true : null), 3000, 'full screen').catch(() => false);
      step('the button makes the game full screen', on, '');
      if (on) {
        await sleep(500);
        const vp = p.viewportSize();
        if (looks) {
          // a drag across the screen turns the camera (the lock is still refused: looking is click-drag)
          const y0 = (await cam())?.yaw;
          await p.mouse.move(vp.width * 0.35, vp.height * 0.5); await p.mouse.down();
          await p.mouse.move(vp.width * 0.75, vp.height * 0.5, { steps: 12 }); await p.mouse.up(); await sleep(300);
          const y1 = (await cam())?.yaw;
          const turned = Number.isFinite(y0) && Number.isFinite(y1) ? Math.abs(y1 - y0) : 0;
          step('in full screen a drag turns the camera', turned > 0.2, `yaw ${Number.isFinite(y0) ? y0.toFixed(2) : y0} → ${Number.isFinite(y1) ? y1.toFixed(2) : y1}`);
          if (!c1.cursorMode || c1.cursor === 'look') {
            // the mouse alone, no button: the camera follows it; at the screen's edge it keeps turning; back in the
            // middle it stops
            await p.mouse.move(vp.width * 0.5, vp.height * 0.5, { steps: 4 }); await sleep(300);
            const f0 = (await cam())?.yaw;
            await p.mouse.move(vp.width * 0.7, vp.height * 0.5, { steps: 12 }); await sleep(300);
            const f1 = (await cam())?.yaw;
            step('in full screen the camera follows the mouse with no button held', turn(f0, f1) > 0.15, `yaw ${f2(f0)} → ${f2(f1)}`);
            await p.mouse.move(vp.width - 2, vp.height * 0.5, { steps: 6 }); await sleep(200);
            const e0 = (await cam())?.yaw; await sleep(800); const e1 = (await cam())?.yaw;
            step('in full screen a cursor resting at the screen\'s edge keeps turning the camera', turn(e0, e1) > 0.3, `yaw ${f2(e0)} → ${f2(e1)} in 0.8 s at the edge`);
            await p.mouse.move(vp.width * 0.5, vp.height * 0.5, { steps: 6 }); await sleep(200);
            const m0 = (await cam())?.yaw; await sleep(600); const m1 = (await cam())?.yaw;
            step('back in the middle the camera holds still', turn(m0, m1) < 0.05, `yaw ${f2(m0)} → ${f2(m1)} in 0.6 s`);
          }
        } else warnings.push(`plays inside a post: the ${camera} camera does not look with the mouse; the drag step is skipped`);
        // a part that holds the body (it owns player.control by its manifest: a board with a cursor) reports the
        // player's mark instead (players[].mark, tools/lib/part-signs.mjs): W must move that
        const held = holdsBody(game);
        const a = whereIs(await me()); await p.keyboard.down(fwd); await sleep(1200); await p.keyboard.up(fwd); await sleep(200); const z = whereIs(await me());
        const moved = a && z && a.mark === z.mark ? Math.hypot(z.x - a.x, z.z - a.z) : 0;
        step(held && z?.mark ? `in full screen ${key} moves the player's mark (the ${held.id} holds the body)` : `in full screen ${key} moves the player`, moved > 1, `${Math.round(moved * 10) / 10} m${held && !z?.mark ? `; the ${held.id} owns player.control and reports no mark (presence(p))` : ''}`);
        if (game.round?.mode === 'world' && camera === 'first') {
          // the game's frame as a page: its own reading, the post's keyboard and mouse moved by the frame's offset
          const fr = frame(), box = async () => (await (await fr.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
          const as = { evaluate: (...x) => fr.evaluate(...x), keyboard: p.keyboard, mouse: { move: async (x, y, o) => { const b = await box(); return p.mouse.move(b.x + x, b.y + y, o); }, down: o => p.mouse.down(o), up: o => p.mouse.up(o) } };
          const spot = await findBuildSpot(as);
          if (spot) await actOn(as, faces(spot).ground);
          const placed = spot ? await until(() => fr.evaluate(s => window.__game.voxelAt(s.x, s.top, s.z) || null, spot), 2000, 'the block').catch(() => 0) : 0;
          const c = await cam();
          const follows = !!c?.following;
          step(follows ? 'a click on a block builds there (the crosshair aims; the camera follows the mouse)' : 'a click on a block builds there (the aim follows the cursor)',
            placed > 0 && (follows ? !c?.aimFree && c?.crosshair : c?.aimFree && !c?.crosshair), spot ? `cell ${spot.x},${spot.top},${spot.z} = ${placed}; aim free ${c?.aimFree}, crosshair ${c?.crosshair}, following ${follows}` : 'no spot on screen');
        }
        if (shot) await shot(p, 'post-fullscreen');
        await F.locator('#gf-fullscreen').click({ timeout: 4000 }).catch(() => {});
        const off = await until(async () => ((await cam())?.fullscreen?.on === false ? true : null), 3000, 'back from full screen').catch(() => false);
        step('the button leaves full screen', off, '');
      }
    }
    const errors = T.errors.filter(e => !LOCK_REFUSED.test(e) && !GPU_NOISE.test(e));
    step('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
  } catch (e) { if (!fail.length) fail.push(e.message); }
  finally { await T.ctx.close().catch(() => {}); await new Promise(r => server.close(r)); }
  const ok = fail.length === 0 && steps.length > 0;
  const detail = ok ? `in a ${CARD}×${CARD} post frame that refuses the lock: the camera stays ${camera}, the full-screen button works${looks ? ', a drag turns the camera' : ''}${looks && !record.afterClick?.cursorMode ? ', the camera follows the mouse with no button and turns at the edge' : ''}, ${key} moves` : fail.join('; ');
  log(`embed: ${ok ? 'ok' : 'FAIL'} ${detail.slice(0, 200)}`);
  return { ok, detail, record, warnings };
}
