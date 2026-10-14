// verify, worlds (CONTRACT §9; worlds/PLAN.md): the checks a world game needs in place of a round's.
// Each drives a real page with real mouse, keys or touch and reads the kit's observation (window.__game: voxelAt,
// topAt, signAt, build(), shove(), project()).
//
//   checkWorldControls({newPage, url, game, log, shot})  13 in a world: each control the HUD lists does what it says,
//        seen on the player's own screen: a click puts a block on the face under the cursor, a right click takes it
//        away, the break tool, paint, a sign through its editor and E on it, the hotbar keys, a shove, a jump
//   checkWorldTouch({newPage, url, log, shot})            30 phones: on a 390×844 touch screen, the stick walks, a tap
//        places, a long press breaks, the hotbar and tools answer taps, a drag turns the camera, Jump jumps
//   checkWorldEdits / the persist and handoff checks: worlds-net-check.mjs (they need the world server and two browsers)
//
// Acting on a block the way the page's camera does (aimAt, actOn): the orbit camera, and first person where the aim
// follows the cursor (a post that refused the lock, a phone), click where the face shows on screen; first person with
// the lock (CONTRACT §9) takes the mouse with a first click, then turns the view with real mouse moves (the view turns
// with the movement between mouse events) until the face under the crosshair is the one meant, and clicks in place.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(120); } }
const G = (p, fn, ...a) => p.evaluate(fn, ...a);

/** Walk the local player off the spawn square (it is protected) and find a cell in front of it to build on (on screen
 *  where the cursor aims; anywhere in reach with the crosshair, which turns to it). The cell is one the player can
 *  really click: nothing stands between the eye and it, and nobody stands on it. In first person the view runs along
 *  the ground, so a block an earlier check built hides the cells behind it and the click lands on that block instead
 *  (2026-10-10: checks 5, 27 and 30 failed that way on Blockhaven after the camera became first person). */
export async function findBuildSpot(p, { turn = null } = {}) {
  const me = () => G(p, () => window.__game.snapshot().players.find(x => x.local));
  const crosshair = (await aimMode(p)) === 'crosshair';
  const free = async () => {
    const m = await me();
    return G(p, ([m, crosshair]) => {
      const g = window.__game, out = [];
      for (let r = 2; r <= 5; r++) for (let k = 0; k < 16; k++) {
        const a = k / 16 * Math.PI * 2, x = Math.floor(m.x + Math.sin(a) * r), z = Math.floor(m.z + Math.cos(a) * r);
        const top = g.topAt(x, z);
        if (top <= 0 || g.voxelAt(x, top, z) || g.voxelAt(x, top + 1, z) || g.protectedAt(x, top, z)) continue;
        if (Math.abs(top - m.y) > 1.2) continue;
        const s = g.project(x + 0.5, top, z + 0.5);
        if (!crosshair && (!s?.front || s.x < 40 || s.y < 60 || s.x > innerWidth - 40 || s.y > innerHeight - 110)) continue;
        // a clear line from the eye to the middle of the ground there, and no player on the cell
        const eye = g.camera()?.eye, to = [x + 0.5, top + 0.02, z + 0.5];
        if (eye) {
          const d = to.map((v, i) => v - eye[i]), n = Math.ceil(Math.hypot(...d) / 0.1);
          let hidden = false;
          for (let i = 1; i < n && !hidden; i++) hidden = !!g.voxelAt(Math.floor(eye[0] + d[0] * i / n), Math.floor(eye[1] + d[1] * i / n), Math.floor(eye[2] + d[2] * i / n));
          if (hidden) continue;
        }
        if (g.snapshot().players.some(q => Math.abs(q.x - to[0]) < 0.9 && Math.abs(q.z - to[2]) < 0.9)) continue;
        out.push({ x, z, top, sx: s?.x, sy: s?.y, r, off: Math.abs(Math.atan2(Math.sin(a - (g.camera()?.yaw ?? 0)), Math.cos(a - (g.camera()?.yaw ?? 0)))) });
      }
      // where the crosshair aims, the spot nearest ahead first: a short turn (a mouse that only follows, in a post's
      // full screen, cannot turn half way round without reaching the screen's edge)
      if (crosshair) out.sort((u, v) => u.off - v.off);
      return out[0] ?? null;
    }, [m, crosshair]);
  };
  let spot = await free();
  // where only what is on screen can be clicked (a phone: a narrow view along the ground), look around first, as a
  // player would: `turn()` turns the view a little with real input
  const lookAround = async () => { for (let t = 0; turn && !spot && t < 14; t++) { await turn(); spot = await free(); } };
  await lookAround();
  for (let i = 0; !spot && i < 4; i++) {
    await p.keyboard.down('KeyW'); await sleep(700); await p.keyboard.up('KeyW'); await sleep(300);
    spot = await free();
    await lookAround();
  }
  return spot;
}
const key = async (p, k) => { await p.keyboard.press(k); await sleep(140); };

// ---- aiming at a block with real input, the way the camera does it ----
/** A spot's faces: the ground's top (a block placed goes on the spot), the top of the block placed there, the cell
 *  above that (a sign stood on it; any face of it). */
export const faces = spot => ({
  ground: { cell: [spot.x, spot.top - 1, spot.z], normal: [0, 1, 0] },
  top: (h = 1) => ({ cell: [spot.x, spot.top + h - 1, spot.z], normal: [0, 1, 0] }),
  cell: (h = 1) => ({ cell: [spot.x, spot.top + h, spot.z], normal: null }),
});
const camOf = p => G(p, () => window.__game.camera());
/** 'crosshair' (first person while the middle of the screen aims) or 'pointer' (the cursor or a finger aims). */
export async function aimMode(p) { const c = await camOf(p).catch(() => null); return c?.mode === 'first' && !c.aimFree ? 'crosshair' : 'pointer'; }
// a point just inside the face (the ray enters the cell through it), or the cell's middle for any face
const facePoint = t => (t.normal ? t.cell.map((v, i) => v + 0.5 + t.normal[i] * 0.48) : t.cell.map(v => v + 0.5));
const cursors = new WeakMap();          // per page: where the mouse is (under the lock only its moves count)
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const same = (a, b) => !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
/** First person: a click on the middle of the game takes the mouse (only takes it). → the camera after */
export async function takeMouse(p) {
  const c = await camOf(p);
  if (c.locked || c.following || c.mode !== 'first' || c.aimFree) return c;
  const [w, h] = await G(p, () => [innerWidth, innerHeight]);
  const at = { x: w / 2, y: h / 2 }; cursors.set(p, at);
  await p.mouse.move(at.x, at.y); await sleep(60); await p.mouse.down(); await sleep(40); await p.mouse.up();
  return until(async () => { const c = await camOf(p); return c.locked || c.lockRefused ? c : null; }, 3000, 'the mouse lock').catch(() => camOf(p));
}
async function turn(p, dx, dy) {
  const at = cursors.get(p) ?? { x: 640, y: 360 }; cursors.set(p, at);
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 30));
  for (let i = 0; i < n; i++) { at.x += dx / n; at.y += dy / n; await p.mouse.move(at.x, at.y); }
  await sleep(140);
}
/** Turn the first-person view with real mouse moves until the crosshair's block face is `t`. → the build pick */
async function lookAtFace(p, t) {
  const pt = facePoint(t);
  let pick = null;
  for (let i = 0; i < 6; i++) {
    const c = await camOf(p), d = pt.map((v, k) => v - c.eye[k]);
    const dYaw = wrap(Math.atan2(d[0], d[2]) - c.yaw), dPitch = Math.atan2(-d[1], Math.hypot(d[0], d[2])) - c.pitch;
    const k = (c.sensitivity || 0.0024) * (c.lookScale || 1);
    if (Math.abs(dYaw) > 0.002 || Math.abs(dPitch) > 0.002) await turn(p, -dYaw / k, (c.invertY ? -1 : 1) * dPitch / k);
    else await sleep(100);
    pick = (await G(p, () => window.__game.build())).pick;
    if (pick && same(pick.cell, t.cell) && (!t.normal || same(pick.normal, t.normal))) return pick;
  }
  return pick;
}
/** Point at a block face ({cell, normal | null}) the way the camera aims, without clicking. → {mode, pick, s} */
export async function aimAt(p, t) {
  if ((await aimMode(p)) === 'crosshair') {
    await takeMouse(p);
    if ((await aimMode(p)) === 'crosshair') return { mode: 'crosshair', pick: await lookAtFace(p, t) };
  }
  const q = facePoint(t), s = await G(p, q => window.__game.project(q[0], q[1], q[2]), q);
  await p.mouse.move(s.x, s.y, { steps: 2 }); await sleep(120);
  return { mode: 'pointer', s, pick: (await G(p, () => window.__game.build())).pick };
}
/** Click (or right click) a block face with real input, the way the camera aims. → what aimAt gave */
export async function actOn(p, t, button = 'left') {
  const a = await aimAt(p, t);
  await sleep(40); await p.mouse.down({ button }); await sleep(50); await p.mouse.up({ button }); await sleep(260);
  return a;
}

export async function checkWorldControls({ newPage, url, game, log = () => {}, shot = null }) {
  const steps = [], warnings = [], record = { steps };
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };
  const P = await newPage('world controls');
  const p = P.page;
  try {
    await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
    await until(() => G(p, () => window.__game?.phase === 'lobby' && window.__game.menu?.()?.view === 'home'), 90000, 'the home menu');
    await p.click('#gf-play');
    await until(() => G(p, () => window.__game.phase === 'playing'), 15000, 'play');
    await sleep(700);
    const B = () => G(p, () => window.__game.build());
    const hot = (await B()).hotbar;
    // jump
    const y0 = (await G(p, () => window.__game.snapshot().players.find(x => x.local))).y;
    await p.keyboard.press('Space'); let top = y0;
    for (let i = 0; i < 6; i++) { await sleep(90); top = Math.max(top, (await G(p, () => window.__game.snapshot().players.find(x => x.local))).y); }
    step('jump: the player rises', top - y0 > 0.4, `rose ${(top - y0).toFixed(2)} m`);
    await sleep(600);
    const spot = await findBuildSpot(p);
    const mode = await aimMode(p), at = mode === 'crosshair' ? 'crosshair' : 'cursor';
    if (!step('a spot to build on, off the spawn square, in reach', !!spot, spot ? `cell ${spot.x},${spot.top},${spot.z}; aimed with the ${at}` : 'none found after walking')) throw new Error('nowhere to build');
    const F = faces(spot);
    // first person: a first click takes the mouse and does nothing else
    if (mode === 'crosshair') {
      const n0 = (await B()).stats.placed, c = await takeMouse(p);
      step('first person: a first click takes the mouse, and only that', c.locked && c.crosshair && (await B()).stats.placed === n0, `locked ${c.locked}, crosshair ${c.crosshair}`);
    }
    // place: click the top face of the ground cell under the spot
    await key(p, 'Digit1');
    const want = hot[0];
    await actOn(p, F.ground);
    const placed = await until(() => G(p, s => window.__game.voxelAt(s.x, s.top, s.z), spot), 2000, 'the block').catch(() => 0);
    const b1 = await B();
    step(`click: a block (${want}) goes on the face under the ${at}`, placed > 0, `cell ${spot.x},${spot.top},${spot.z} = ${placed}; placed ${b1.stats.placed}, refused ${JSON.stringify(b1.stats.refusedBy)}`);
    if (shot) await shot(p, 'world-placed');
    // the block aimed at now is the new one: right click takes it away
    await actOn(p, F.top(), 'right');
    const gone = await until(() => G(p, s => window.__game.voxelAt(s.x, s.top, s.z) === 0, spot), 2000, 'the block to go').catch(() => false);
    step(`right click: the block under the ${at} breaks`, gone, `broken ${(await B()).stats.broken}`);
    // the break tool: X, then a left click breaks
    await actOn(p, F.ground);                              // a block to break
    await key(p, 'KeyX');
    const tb = (await B()).tool;
    await actOn(p, F.top());
    const gone2 = await until(() => G(p, s => window.__game.voxelAt(s.x, s.top, s.z) === 0, spot), 2000, 'the block to go').catch(() => false);
    step('X: the break tool, and a click breaks', tb === 'break' && gone2, `tool ${tb}`);
    await key(p, 'KeyX');
    // the hotbar keys
    await key(p, 'Digit3');
    const t3 = await B();
    step('1 – 0: the hotbar keys pick a block', t3.slot === 2 && t3.tool === 'place', `slot ${t3.slot}, tool ${t3.tool}`);
    // the wheel picks the next block where it does not zoom (first person)
    if (mode === 'crosshair') {
      await p.mouse.wheel(0, 100); await sleep(250);
      const tw = await B();
      step('the wheel: the next block', tw.slot === 3 && tw.tool === 'place', `slot ${tw.slot}`);
    }
    // paint: P, a colour, a click on a block
    await key(p, 'Digit1'); await actOn(p, F.ground);
    const before = await G(p, s => window.__game.voxelAt(s.x, s.top, s.z), spot);
    await key(p, 'KeyP'); await key(p, 'Digit2');
    const tp = await B();
    await actOn(p, F.top());
    const after = await until(async () => { const v = await G(p, s => window.__game.voxelAt(s.x, s.top, s.z), spot); return v !== before ? v : null; }, 2000, 'paint').catch(() => before);
    step('P: the paint tool, a colour key, and a click paints the block', tp.tool === 'paint' && (after >> 8) > 0 && (after & 255) === (before & 255), `tool ${tp.tool}, colour ${tp.color}; ${before} → ${after}`);
    if (shot) await shot(p, 'world-painted');
    await key(p, 'KeyP');
    // a sign: the sign block, a click opens the editor, words go up; E on it opens the editor again
    const signSlot = hot.indexOf('sign');
    if (signSlot >= 0 && signSlot < 10) {
      await key(p, `Digit${(signSlot + 1) % 10}`);
      await actOn(p, F.top());
      const open = await until(() => G(p, () => document.querySelector('#gf-sign-editor')?.classList.contains('on')), 2000, 'the sign editor').catch(() => false);
      // first person: the editor gives the mouse back, so the words can be typed and OK clicked
      const freed = mode === 'crosshair' ? !(await camOf(p)).locked : true;
      if (open) { await p.keyboard.type('Verify was here'); await p.click('#gf-sign-ok'); await sleep(400); }
      const sign = await G(p, s => window.__game.signAt(s.x, s.top + 1, s.z), spot);
      step('a sign: its editor opens, and the words go up', open && freed && sign?.text === 'Verify was here', `editor ${open}${mode === 'crosshair' ? `, the mouse given back ${freed}` : ''}, sign ${JSON.stringify(sign)}`);
      if (shot) await shot(p, 'world-sign');
      await aimAt(p, F.cell());
      await key(p, 'KeyE');
      const again = await until(() => G(p, () => document.querySelector('#gf-sign-editor')?.classList.contains('on')), 1500, 'the editor').catch(() => false);
      step(`E: change the sign under the ${at}`, again, again ? 'the editor opened' : 'nothing opened');
      if (again) { await p.keyboard.press('Escape'); await sleep(200); }
    } else warnings.push('world controls: no sign block in the first ten hotbar slots; the sign steps are skipped');
    // a shove (alone it finds nobody: it still swings, and the shove mechanic counts the miss)
    if (game.mechanics?.some(m => m.id === 'shove')) {
      const s0 = await G(p, () => window.__game.shove());
      await key(p, 'KeyF'); await sleep(200);
      const s1 = await G(p, () => window.__game.shove());
      step('F: a shove', (s1.shoves + s1.missed) > (s0.shoves + s0.missed), `shoves ${s1.shoves}, missed ${s1.missed}`);
    }
    if (P.errors.length) step('no console errors', false, [...new Set(P.errors)].slice(0, 3).join(' | '));
  } catch (e) { step('the world controls run', false, e.message); }
  finally { await P.ctx.close(); }
  const fail = steps.filter(s => !s.ok);
  return { ok: !fail.length, detail: fail.length ? fail.map(s => `${s.name}: ${s.detail}`).join('; ') : `${steps.length} steps: ${steps.map(s => s.name.split(':')[0]).join(', ')}`, record, warnings };
}

export async function checkWorldTouch({ browser, url, log = () => {}, shot = null }) {
  const steps = [], warnings = [], record = { steps };
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  try {
    await p.goto(`${url}?seed=7`, { waitUntil: 'load' });
    await until(() => G(p, () => window.__game?.menu?.()?.view === 'home'), 90000, 'the home menu');
    await p.tap('#gf-play');
    await until(() => G(p, () => window.__game.phase === 'playing'), 15000, 'play');
    await sleep(700);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id })) });
    const tap = async (x, y) => { await touch('touchStart', [[x, y, 0]]); await sleep(90); await touch('touchEnd', []); await sleep(260); };
    const me = () => G(p, () => window.__game.snapshot().players.find(x => x.local));
    const buttons = await G(p, () => [...document.querySelectorAll('.gf-touch.on button')].map(b => b.textContent));
    step('touch controls show', buttons.includes('Jump'), `buttons: ${buttons.join(', ')}`);
    // the stick: drag up on the left half
    const a = await me();
    await touch('touchStart', [[90, 640, 1]]); for (let i = 1; i <= 8; i++) { await touch('touchMove', [[90, 640 - i * 9, 1]]); await sleep(40); }
    await sleep(900); await touch('touchEnd', []); await sleep(300);
    const b = await me();
    step('the stick walks', Math.hypot(b.x - a.x, b.z - a.z) > 1, `${Math.hypot(b.x - a.x, b.z - a.z).toFixed(2)} m`);
    // a drag on the right half turns the camera
    const y0 = (await G(p, () => window.__game.camera())).yaw;
    await touch('touchStart', [[300, 420, 2]]); for (let i = 1; i <= 10; i++) { await touch('touchMove', [[300 - i * 12, 420, 2]]); await sleep(30); } await touch('touchEnd', []); await sleep(300);
    const y1 = (await G(p, () => window.__game.camera())).yaw;
    step('a drag turns the camera', Math.abs(y1 - y0) > 0.2, `yaw ${y0.toFixed(2)} → ${y1.toFixed(2)}`);
    // a spot in view with nothing in front of it; when a block built earlier hides them all, a drag turns the view
    const spot = await findBuildSpot(p, { turn: async () => { await touch('touchStart', [[300, 420, 2]]); for (let i = 1; i <= 8; i++) { await touch('touchMove', [[300 - i * 12, 420, 2]]); await sleep(30); } await touch('touchEnd', []); await sleep(300); } });
    if (!step('a spot to build on, on screen', !!spot, spot ? `cell ${spot.x},${spot.top},${spot.z}` : 'none')) throw new Error('nowhere to build');
    await tap(spot.sx, spot.sy);
    const placed = await until(() => G(p, s => window.__game.voxelAt(s.x, s.top, s.z), spot), 2000, 'the block').catch(() => 0);
    step('a tap places a block where it lands', placed > 0, `cell = ${placed}`);
    const s2 = await G(p, s => window.__game.project(s.x + 0.5, s.top + 0.98, s.z + 0.5), spot);
    await touch('touchStart', [[s2.x, s2.y, 3]]); await sleep(650); await touch('touchEnd', []); await sleep(300);
    const gone = await until(() => G(p, s => window.__game.voxelAt(s.x, s.top, s.z) === 0, spot), 2000, 'the break').catch(() => false);
    step('a long press breaks it', gone, '');
    await p.tap('#gf-tool-paint'); await sleep(200);
    const tp = await G(p, () => window.__game.build());
    step('the paint tool answers a tap', tp.tool === 'paint', `tool ${tp.tool}`);
    await p.tap('#gf-tool-paint'); await sleep(200);
    await p.tap('#gf-hotbar .gf-slot[data-i="2"]'); await sleep(200);
    const ts = await G(p, () => window.__game.build());
    step('a hotbar slot answers a tap', ts.slot === 2, `slot ${ts.slot}`);
    const j0 = (await me()).y;
    await p.tap('.gf-touch button[data-action="jump"]'); let top = j0;
    for (let i = 0; i < 6; i++) { await sleep(90); top = Math.max(top, (await me()).y); }
    step('Jump jumps', top - j0 > 0.4, `rose ${(top - j0).toFixed(2)} m`);
    if (shot) await shot(p, 'world-phone');
    if (errors.length) step('no console errors', false, errors.slice(0, 3).join(' | '));
  } catch (e) { step('the phone run', false, e.message); }
  finally { await ctx.close(); }
  const fail = steps.filter(s => !s.ok);
  return { ok: !fail.length, detail: fail.length ? fail.map(s => `${s.name}: ${s.detail}`).join('; ') : `390×844 touch: ${steps.length} steps passed`, record, warnings };
}

/**
 * 11 in a world: the world lint (no browser). The island is generated in Node from config/world.json exactly as the
 * game does, then: the terrain names its generator version; every block texture is a file in the game and an image
 * slot, at least as big as the high tier draws it (FACE_SIZES.high: a smaller face is stretched and looks soft on a big
 * screen; the creator, 2026-10-09: "I am not sure why the game looks so blurry still"); the hotbar's blocks exist and may be placed; the paint fits a cell (at most 15 colours); the spawn square is
 * protected and every spawn stands on it, on solid ground, with two free cells above; the size fits the play host.
 */
/** A PNG's or JPEG's size from its bytes ({w, h}), or null. */
function imageSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}

export async function lintWorld(dir, { kitDir }) {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { kitPath } = await import('./paths.mjs');
  const imp = rel => import(pathToFileURL(kitPath(kitDir, rel)).href);
  const [{ VoxelGrid }, { blockTable, FACE_SIZES }, { generateTerrain }] = await Promise.all([imp('world/voxel/grid.mjs'), imp('world/voxel/blocks.mjs'), imp('world/voxel/terrain.mjs')]);
  const cfg = JSON.parse(await readFile(join(dir, 'config/world.json'), 'utf8'));
  const game = JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
  const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  const errors = [], notes = [];
  const V = cfg.voxel ?? {};
  if (cfg.template !== 'voxel') return { ok: false, errors: ['config/world.json: template is not voxel'], notes };
  if (!Number.isInteger(V.terrain?.generator)) errors.push('voxel.terrain.generator: name the generator version (1): the play host keeps only changed cells, so the island must never change under them');
  let table;
  try { table = blockTable(V); } catch (e) { return { ok: false, errors: [`blocks: ${e.message}`], notes }; }
  const slotIds = new Set(assets.slots.map(s => s.id));
  const want = FACE_SIZES?.high ?? 0, small = [];
  for (const [name, file] of Object.entries(V.textures ?? {})) {
    if (!existsSync(join(dir, file))) { errors.push(`texture ${name}: ${file} is missing`); continue; }
    if (!slotIds.has(`world.voxel.texture.${name}`)) errors.push(`texture ${name}: no slot world.voxel.texture.${name} in assets.json`);
    const size = imageSize(await readFile(join(dir, file)));
    if (want && size && Math.min(size.w, size.h) < want) small.push(`${name} ${size.w}×${size.h}`);
  }
  if (small.length) errors.push(`block faces under ${want} px are stretched and look blurry on a big screen (the high tier draws every face at ${want}): ${small.join(', ')}; draw them at ${want} (worlds/tools/vector_tiles.mjs for the Kenney faces, bake_blocks.py for ours)`);
  const build = (game.mechanics ?? []).find(m => m.id === 'build');
  for (const id of build?.params?.hotbar ?? []) { const b = table.byId.get(id); if (!b) errors.push(`hotbar: no block "${id}"`); else if (!b.place) errors.push(`hotbar: "${id}" may not be placed`); }
  if ((V.paint ?? []).length > 15) errors.push(`paint: ${V.paint.length} colours (a cell holds 15)`);
  if (V.size.some(n => n > 512)) errors.push(`size ${V.size.join('×')}: over the play host's 512 a side`);
  const grid = new VoxelGrid({ size: V.size, info: table.info, tints: table.tints });
  const T = generateTerrain(grid, table, V.terrain ?? {});
  const inside = (b, x, y, z) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2];
  const prot = V.protect ?? [];
  if (!prot.length) errors.push('voxel.protect: the spawn square is not protected (a newcomer could land in a crater or a sealed box)');
  for (const [i, s] of T.spawns.entries()) {
    const x = Math.floor(s.x), z = Math.floor(s.z), y = s.y;
    if (!grid.solidAt(x, y - 1, z)) errors.push(`spawn ${i}: no solid ground under (${x}, ${y}, ${z})`);
    if (grid.solidAt(x, y, z) || grid.solidAt(x, y + 1, z)) errors.push(`spawn ${i}: inside a block at (${x}, ${y}, ${z})`);
    if (prot.length && !prot.some(b => inside(b, x, y, z) && inside(b, x, y - 1, z))) errors.push(`spawn ${i}: (${x}, ${y}, ${z}) is outside the protected square`);
  }
  if (T.sign) { const [x, y, z] = T.sign.cell; if (!prot.some(b => inside(b, x, y, z))) notes.push('the welcome sign stands outside the protected square: anyone can change it'); }
  notes.push(`island: ${T.trees} trees, plaza at height ${T.plaza.y}, ${T.spawns.length} spawns, ${table.list.length} blocks, ${table.textures.length} textures`);
  return { ok: !errors.length, errors, notes };
}
