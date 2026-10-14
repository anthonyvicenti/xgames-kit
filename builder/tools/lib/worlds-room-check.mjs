// verify, worlds (CONTRACT §9): the room. Real Chrome contexts enter one world through its world card
// (gf-multiplayer 1.5.0, the friends page in world mode: /p/<slug>/gf/mp/index.html), with real clicks and keys.
//
//   checkWorldRoom({browser, server, log, shot}) → {gate, friends, handoff, record}
//   5  the world gate: A enters (and hosts), B enters (and joins A) with no code; each draws the other where they
//      really are; a block A places shows in B's world, and one B places in A's
//   25 playing with friends in a world: the card asks a name first (never blank), Enter needs no code and no Start,
//      each sees the other's name over their character, nobody is a bot, and the game's menu lists who is in; each
//      enters on a spawn of their own; one colour per player (character ring = the room's dot) on every screen; a slur
//      typed as a name is masked for everyone (play-test 2026-10-09)
//   27 the host leaves and the world is kept: A builds and closes its tab; B becomes the host within seconds and keeps
//      every block and its colour; the play host has them all; C enters later and sees them; B's own new block reaches C
import { findBuildSpot, faces, actOn, aimAt } from './worlds-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }

/** One player: a context on the world card, entered with a name; the game frame and helpers. */
export async function player(browser, server, name, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text().slice(0, 200)}`); });
  await page.goto(server.friendsUrl ?? `${server.url}p/${server.slug}/gf/mp/index.html`, { waitUntil: 'load' });
  const frame = await until(async () => page.frames().find(f => /gf-world=1/.test(f.url())) ?? null, 30000, `${name}: the game's frame`);
  await until(() => frame.evaluate(() => window.__game?.ready === true), 90000, `${name}: the game to boot`);
  const G = (fn, ...a) => frame.evaluate(fn, ...a);
  const box = async () => (await (await frame.frameElement()).boundingBox()) ?? { x: 0, y: 0 };
  const P = { ctx, page, frame, G, name, box };
  P.card = async () => page.evaluate(() => ({ enter: !!document.querySelector('#mp-enter'), name: document.querySelector('#mp-name')?.value ?? document.querySelector('#mp-name')?.textContent ?? null, count: document.querySelector('#mp-world-count')?.textContent ?? null }));
  P.enter = async () => {
    await page.fill('#mp-name', name);
    await page.click('#mp-enter');
    await until(() => G(() => window.__game.phase === 'playing' && window.__game.snapshot().world?.status === 'in'), 30000, `${name}: in the world`);
    await sleep(600);
  };
  P.me = () => G(() => window.__game.snapshot().players.find(x => x.local));
  /** The colours: what the room gives each tab (its dot) and what this copy draws each player in (keyed by cid). */
  P.colors = async () => ({ room: await page.evaluate(() => Object.fromEntries((window.__party?.snapshot?.().world?.players ?? []).map(p => [p.cid ?? p.id, p.color]))),
    drawn: await G(() => window.__game.snapshot().players.map(p => ({ id: p.id, name: p.name, color: p.color, ring: p.ring }))) });
  P.state = () => G(() => { const s = window.__game.snapshot(); return { status: s.world?.status, host: s.host, players: s.players.map(p => ({ id: p.id, name: p.name, bot: p.bot, local: p.local, x: p.x, z: p.z })), build: window.__game.build() }; });
  P.voxel = (x, y, z) => G(c => window.__game.voxelAt(c[0], c[1], c[2]), [x, y, z]);
  // the game's frame for reading, the page's keyboard and mouse (moved by the frame's offset) for playing: a frame has
  // none of its own. One object per player, so the aiming helpers keep track of its mouse
  const as = { evaluate: (...a) => frame.evaluate(...a), keyboard: page.keyboard, click: sel => frame.click(sel),
    mouse: { move: async (x, y, o) => { const b = await box(); return page.mouse.move(b.x + x, b.y + y, o); }, down: o => page.mouse.down(o), up: o => page.mouse.up(o) } };
  P.spot = () => findBuildSpot(as);
  /** Click a block face ({cell, normal}) the way the camera aims (worlds-check.mjs actOn). */
  P.act = (t, button) => actOn(as, t, button);
  /** Turn the view onto a block face, as a player would, without clicking (worlds-check.mjs aimAt). */
  P.aim = t => aimAt(as, t);
  /** Place a block on a spot's ground (the hotbar's first block); → the cell. */
  P.place = async spot => { await page.keyboard.press('Digit1'); await sleep(120); await P.act(faces(spot).ground); return [spot.x, spot.top, spot.z]; };
  /** Stack one more block on a column we built (its top face). */
  P.stack = async (spot, h) => { await P.act(faces(spot).top(h)); return [spot.x, spot.top + h, spot.z]; };
  return P;
}

export async function checkWorldRoom({ browser, server, log = () => {}, shot = null }) {
  const steps = [], errors = [], record = { steps };
  const step = (group, name, ok, detail = '') => { steps.push({ group, name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} [${group}] ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };
  let A = null, B = null, C = null;
  try {
    // ---- 25 / 5: two players enter one world through its card ----
    A = await player(browser, server, 'Ada', errors);
    const cardA = await A.card();
    step('friends', 'the world card asks a name first (never blank), with Enter and no code', cardA.enter && !!cardA.name, JSON.stringify(cardA));
    if (shot) await shot(A.page, 'world-card');
    await A.enter();
    const a0 = await A.state();
    step('gate', 'the first player in hosts the world', a0.host === true && a0.status === 'in', `host ${a0.host}, status ${a0.status}`);
    B = await player(browser, server, 'Bo', errors);
    const cardB = await B.card();
    step('friends', 'the card says someone is building', /1|building|here/i.test(cardB.count ?? ''), cardB.count ?? '');
    await B.enter();
    const b0 = await B.state();
    step('gate', 'the second player joins the same world, as a guest', b0.host === false && b0.status === 'in', `host ${b0.host}, status ${b0.status}`);
    // a spawn of their own: the second player in never lands on the first (who has not moved yet)
    const [a1, b1] = [await A.me(), await B.me()];
    const apart = Math.hypot(a1.x - b1.x, a1.z - b1.z);
    step('friends', 'each player enters on a spawn of their own', apart >= 1.2, `${apart.toFixed(2)} m apart`);
    // each sees the other where they really are
    await A.page.keyboard.down('KeyW'); await sleep(700); await A.page.keyboard.up('KeyW'); await sleep(900);
    const [aMe, bMe] = [await A.me(), await B.me()];
    const [aSeen, bSeen] = [await until(async () => (await B.state()).players.find(p => !p.local && p.name === 'Ada'), 6000, 'A on B').catch(() => null), await until(async () => (await A.state()).players.find(p => !p.local && p.name === 'Bo'), 6000, 'B on A').catch(() => null)];
    const near = (p, q) => p && q && Math.hypot(p.x - q.x, p.z - q.z) < 1.6;
    step('gate', 'each draws the other where they really are', near(aSeen, aMe) && near(bSeen, bMe), `A at ${aMe.x},${aMe.z} seen by B at ${aSeen?.x},${aSeen?.z}; B at ${bMe.x},${bMe.z} seen by A at ${bSeen?.x},${bSeen?.z}`);
    step('friends', 'names over each other, nobody a bot', aSeen?.name === 'Ada' && bSeen?.name === 'Bo' && ![...(await A.state()).players, ...(await B.state()).players].some(p => p.bot), '');
    // one colour per player: on each screen, everyone's character and ring wear the colour the room shows as their dot
    const colorRows = [];
    for (const P of [A, B]) {
      const c = await until(async () => { const c = await P.colors(); return c.drawn.length >= 2 && Object.keys(c.room).length >= 2 ? c : null; }, 5000, `${P.name}: colours`).catch(() => P.colors());
      for (const d of c.drawn) colorRows.push({ on: P.name, who: d.name, room: c.room[d.id] ?? null, color: d.color, ring: d.ring });
    }
    const lc = v => String(v ?? '').toLowerCase();
    const colorOk = colorRows.length >= 4 && colorRows.every(r => r.room && lc(r.color) === lc(r.room) && lc(r.ring) === lc(r.room))
      && new Set(colorRows.map(r => lc(r.room))).size === 2;
    step('friends', 'one colour per player: each character\'s ring is the room\'s dot, on every screen', colorOk, JSON.stringify(colorRows));
    const bColor = colorRows.find(r => r.on === 'Bo' && r.who === 'Bo')?.color ?? null;
    if (shot) await shot(B.page, 'world-two');
    // an edit on each shows on the other
    const sa = await A.spot(); if (!sa) throw new Error('A has nowhere to build');
    const ca = await A.place(sa);
    const onB = await until(async () => (await B.voxel(...ca)) || null, 5000, 'A\'s block on B').catch(() => 0);
    step('gate', 'a block A places shows in B\'s world', onB > 0 && onB === (await A.voxel(...ca)), `cell ${ca.join(',')}: A ${await A.voxel(...ca)}, B ${onB}`);
    const sb = await B.spot(); if (!sb) throw new Error('B has nowhere to build');
    const cb = await B.place(sb);
    const onA = await until(async () => (await A.voxel(...cb)) || null, 5000, 'B\'s block on A').catch(() => 0);
    step('gate', 'a block B places shows in A\'s world', onA > 0 && onA === (await B.voxel(...cb)), `cell ${cb.join(',')}: B ${await B.voxel(...cb)}, A ${onA}`);
    // the menu lists who is in
    await B.page.keyboard.press('Escape'); await sleep(400);
    const room = await B.G(() => window.__game.menu());
    const listed = await B.frame.evaluate(() => [...document.querySelectorAll('#gf-room li')].map(li => li.textContent));
    step('friends', 'the game\'s menu lists who is in the world', listed.some(t => /Ada/.test(t)) && listed.some(t => /Bo/.test(t)), JSON.stringify(listed));
    await B.page.keyboard.press('Escape'); await sleep(300);
    void room;
    // ---- 27: A builds a little more and closes its tab; B takes over ----
    // Three more blocks, each on a spot's ground: a player on the ground can't click the top of a column taller than
    // their eyes (first person, 2026-10-09), so a four-block tower only ever got its first two. Only blocks A really
    // has count: the steps below are about the handoff, not about A's aim.
    const tower = (await A.voxel(...ca)) ? [ca] : [];
    for (let i = 0; i < 6 && tower.length < 4; i++) {
      const s = await A.spot(); if (!s) break;
      const c = await A.place(s);
      if (await until(async () => (await A.voxel(...c)) || null, 1500, 'A\'s block').catch(() => 0)) tower.push(c);
    }
    step('handoff', 'the host builds four blocks before leaving', tower.length === 4, `${tower.length} placed: ${tower.map(c => c.join(',')).join(' · ')}`);
    await until(async () => { for (const c of tower) if (!(await B.voxel(...c))) return null; return true; }, 5000, 'A\'s tower on B').catch(() => {});
    const t0 = Date.now();
    await A.ctx.close(); A = null;                        // pagehide: the host's tab goes away
    const took = await until(async () => { const s = await B.state(); return s.status === 'in' && s.host ? s : null; }, 20000, 'B to host').catch(() => null);
    const ms = Date.now() - t0;
    step('handoff', 'the other player becomes the host within seconds', !!took && ms < 8000, `${(ms / 1000).toFixed(1)} s`);
    record.handoffMs = ms;
    const keptB = await Promise.all(tower.map(c => B.voxel(...c)));
    step('handoff', 'the new host keeps every block the old one placed', keptB.every(v => v > 0), JSON.stringify(keptB));
    const bAfter = (await B.colors()).drawn.find(d => d.name === 'Bo');
    step('handoff', 'the new host keeps its colour', !!bColor && lc(bAfter?.color) === lc(bColor) && lc(bAfter?.ring) === lc(bColor), `before ${bColor}, after ${bAfter?.color} (ring ${bAfter?.ring})`);
    // the play host has them (the old host's last save, or the new host's save of its tail)
    const saved = await until(async () => { const w = await (await fetch(server.apiUrl)).json(); const cells = new Set((w.edits ?? []).filter(e => e[5]).map(e => `${e[2]},${e[3]},${e[4]}`)); return tower.every(c => cells.has(c.join(','))) ? w : null; }, 15000, 'the play host to have the tower').catch(() => null);
    step('handoff', 'the play host has every block', !!saved, saved ? `seq ${saved.seq}` : 'missing');
    // C arrives after the handoff, named with a slur in disguise: nobody, C included, ever sees it (gf-multiplayer 1.5.1)
    C = await player(browser, server, 'n1gg3r', errors);
    await C.enter();
    const cOnB = await until(async () => (await B.state()).players.find(p => !p.local) ?? null, 6000, 'C on B').catch(() => null);
    const cSelf = await C.me();
    const cards = await C.page.evaluate(() => (window.__party?.snapshot?.().world?.players ?? []).map(p => p.name));
    const seen = [cOnB?.name, cSelf?.name, ...cards].filter(v => typeof v === 'string');
    step('friends', 'a slur typed as a name is masked for everyone', !!cOnB && seen.length >= 3 && !seen.some(t => /n\W*[1i!]\W*g\W*g/i.test(t)),
      `on B: ${cOnB?.name}; on C: ${cSelf?.name}; the room: ${JSON.stringify(cards)}`);
    const keptC = await Promise.all([...tower, cb].map(c => C.voxel(...c)));
    step('handoff', 'a player who arrives later sees every block', keptC.every(v => v > 0), JSON.stringify(keptC));
    const sb2 = await B.spot();
    const cb2 = sb2 ? await B.place(sb2) : null;
    const onC = cb2 ? await until(async () => (await C.voxel(...cb2)) || null, 5000, 'B\'s new block on C').catch(() => 0) : 0;
    step('handoff', 'the new host\'s own edits reach the newcomer', onC > 0, cb2 ? `cell ${cb2.join(',')}` : 'no spot');
    if (shot) await shot(C.page, 'world-after-handoff');
    if (errors.length) step('gate', 'no console errors', false, [...new Set(errors)].slice(0, 3).join(' | '));
  } catch (e) { step('gate', 'the room run', false, e.message); }
  finally { for (const P of [A, B, C]) await P?.ctx.close().catch(() => {}); }
  const part = g => { const s = steps.filter(x => x.group === g || (g === 'gate' && x.name === 'the room run')); const f = s.filter(x => !x.ok); return { ok: s.length > 0 && !f.length, detail: f.length ? f.map(x => `${x.name}: ${x.detail}`).join('; ') : `${s.length} steps: ${s.map(x => x.name).join('; ')}` }; };
  return { gate: part('gate'), friends: part('friends'), handoff: part('handoff'), record };
}
