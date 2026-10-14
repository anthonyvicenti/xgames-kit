// verify, worlds (CONTRACT §9b): watch then play (gf-multiplayer 1.6.x, watch/PLAN.md). Real Chrome contexts,
// real clicks and keys, the relay on the world server (builder/watch/relay/node.mjs).
//
//   checkWorldWatch({browser, server, log, shot}) → {ok, detail, record}
//   34 watch then play: H enters (the host), A enters, builds a block, opens the menu and presses Go live; the share
//      sheet has the link and Post on X, A sees LIVE, and the stream's secret is not in the origin's shared storage.
//      B opens the link: B's copy draws A where A really is, its camera follows A from A's eyes, it has A's block from
//      before the stream and the one A places while B watches (looking at it from close by: the same look), it is not
//      in the room (A sees only H), its nameplates sit over the characters, and A's count says 1 watching. A message
//      sent to the relay as a viewer closes that socket (1008). H leaves: A becomes the host and the block A places
//      next reaches B. B presses Join, names itself and enters the same world without the game reloading. C watches;
//      A stops; C's bar says it ended, with Play and no stray words; C presses Play solo: the world's own page, a
//      practice copy with nobody else. D, A on another day (a new browser), opens the streamer link A copied from the
//      share sheet, enters and goes live: the same link as before, the secret gone from the address bar and kept out
//      of localStorage, and E, opening the old link, sees D live. No console errors.
//      Beside Join a viewer's bar offers Play solo, and no room of one's own (a world is one shared world per link).
// Play-test 1 (watch/evidence/playtest-1/report.md) found what the later steps hold: the secret in localStorage,
// the viewer looking at the sky near a wall, misplaced or missing name tags, the first block after a handoff lost for
// viewers, "null" in the bar. The creator, 2026-10-10: "add an option to start own lobby or play solo" (gf-multiplayer
// 1.6.3; watch/evidence/own-room-or-solo-request-2026-10-10.json). The creator, 2026-10-11: "If I close my game
// but want to stream live from the same link as before, how can I do that?" (gf-multiplayer 1.6.5, the streamer link).
import { player } from './worlds-room-check.mjs';
import { streamerLinkFrom, voiceSteps } from './friends-watch-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a.reduce((t, v, i) => t + v * b[i], 0)))) * 180 / Math.PI;

/** A viewer: a context on the world's friends page with ?watch=<id>; the game frame and helpers. */
async function viewer(browser, server, id, name, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name}: ${m.text().slice(0, 200)}`); });
  await page.goto(`${server.friendsUrl}?watch=${id}`, { waitUntil: 'load' });
  const frame = await until(async () => page.frames().find(f => /gf-world=1/.test(f.url())) ?? null, 30000, `${name}: the game's frame`);
  await until(() => frame.evaluate(() => window.__game?.ready === true), 90000, `${name}: the game to boot`);
  const G = (fn, ...a) => frame.evaluate(fn, ...a);
  const party = () => page.evaluate(() => window.__party.snapshot());
  return { ctx, page, frame, G, name, party, voxel: (x, y, z) => G(c => window.__game.voxelAt(c[0], c[1], c[2]), [x, y, z]) };
}

export async function checkWorldWatch({ browser, server, log = () => {}, shot = null }) {
  const steps = [], errors = [], record = { steps };
  const step = (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} [watch] ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };
  let H = null, A = null, B = null, C = null, D = null, E = null;
  try {
    if (!server.relay) { step('the world server carries the stream relay', false, 'startWorldServer({watch: false})'); return done(); }
    // ---- H hosts; A enters, builds, goes live from the menu ----
    H = await player(browser, server, 'Hal', errors);
    await H.enter();
    A = await player(browser, server, 'Ada', errors);
    await A.enter();
    const spot = await A.spot(); if (!spot) throw new Error('A has nowhere to build');
    const before = await A.place(spot);                                    // built before anyone watches
    await until(async () => (await A.voxel(...before)) || null, 3000, 'A\'s first block');
    await A.page.keyboard.press('Escape'); await sleep(400);
    const offered = await A.frame.evaluate(() => !!document.querySelector('#gf-live'));
    step('the menu offers Go live in a world with friends', offered, offered ? '#gf-live' : 'no #gf-live in the pause menu');
    await A.frame.click('#gf-live');
    const live = await until(async () => { const s = (await A.page.evaluate(() => window.__party.snapshot())).live; return s.state === 'on' ? s : null; }, 10000, 'A live');
    const sheet = await A.page.evaluate(() => ({ shown: !!document.querySelector('#mp-live-share:not([hidden])'), link: document.querySelector('#mp-live-link')?.value ?? null,
      post: document.querySelector('#mp-live-post')?.getAttribute('href') ?? null, badge: document.querySelector('#mp-live:not([hidden])')?.textContent ?? null }));
    step('Go live: the share sheet has the link and Post on X; LIVE shows', sheet.shown && sheet.link === live.link && /^https:\/\/x\.com\/intent\/post\?/.test(sheet.post ?? '') && decodeURIComponent(sheet.post).includes(live.link) && /LIVE/.test(sheet.badge ?? ''),
      `link ${sheet.link}; badge "${sheet.badge}"`);
    const leaked = await A.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('gf-watch:')).length).catch(() => -1);
    step('the stream\'s secret is not in the origin\'s shared storage', leaked === 0, leaked ? `localStorage holds ${leaked} gf-watch entries` : 'sessionStorage only');
    const keep = await streamerLinkFrom(A.page);                          // kit 1.6.5: the same link next time
    step('the share sheet hands the streamer a private link for the same stream next time', !!keep && keep.includes(`#gf-stream=${live.id}.`) && !keep.includes('watch='), keep ? keep.replace(/(#gf-stream=[a-z0-9]{12}\.).*/, '$1…') : 'no #mp-live-keep, or it copied nothing');
    await A.page.click('#mp-live-close').catch(() => {});
    if (shot) await shot(A.page, 'watch-live');
    // ---- B watches ----
    B = await viewer(browser, server, live.id, 'viewer B', errors);
    const keyed = await until(async () => { const w = (await B.party()).watch; return w?.keyed ? w : null; }, 15000, 'B tuned in').catch(() => null);
    step('a viewer tunes in to the stream (key frame taken)', !!keyed, keyed ? `following ${keyed.follow?.name} (${keyed.roster} in the stream)` : JSON.stringify((await B.party()).watch));
    const voice = await voiceSteps({ streamer: A.page, streamerGame: A.page.frames().find(f => f.parentFrame() === A.page.mainFrame()), viewer: B.page, step });
    if (voice.skipped) log(`  watch: ${voice.skipped}`);
    const bar = await B.page.evaluate(() => document.querySelector('#mp-watch:not([hidden])')?.textContent ?? null);
    step('the viewer\'s bar: LIVE, the streamer, Join', /LIVE/.test(bar ?? '') && /Ada/.test(bar ?? '') && /Join/.test(bar ?? ''), bar ?? 'no bar');
    // kit 1.6.3: the game alone beside Join; a world is one shared world per link, so no room of one's own
    const ways = await B.page.evaluate(() => { const b = s => { const e = document.querySelector(s); return e && !e.disabled && e.getBoundingClientRect().width > 0 ? e.textContent : null; }; return { join: b('#mp-watch-join'), own: b('#mp-watch-own'), solo: b('#mp-watch-solo') }; });
    step('beside Join, a viewer is offered the game alone (a world has no room of one\'s own)', !!ways.join && !!ways.solo && !ways.own, JSON.stringify(ways));
    // A walks (back, away from its block: forward it would stand on it, and a block can't go where someone stands); B
    // draws A where A really is, and its camera follows A
    const a0 = await A.me();
    await A.page.keyboard.down('KeyS'); await sleep(350); await A.page.keyboard.up('KeyS'); await sleep(1500);
    const aMe = await A.me();
    const seen = await until(async () => { const s = await B.G(() => window.__game.snapshot()); const p = s.players.find(x => !x.local && x.name === 'Ada'); return p && Math.hypot(p.x - aMe.x, p.z - aMe.z) < 1.6 ? { p, s } : null; }, 5000, 'A on B').catch(() => null);
    const walked = Math.hypot(aMe.x - a0.x, aMe.z - a0.z);
    step('the viewer draws the streamer where they really are (after a walk)', !!seen && walked > 0.3, seen ? `A walked ${walked.toFixed(2)} m to ${aMe.x},${aMe.z}; B draws ${seen.p.x},${seen.p.z}` : `A at ${aMe.x},${aMe.z}; B: ${JSON.stringify((await B.G(() => window.__game.snapshot().players)).map(p => [p.name, p.x, p.z, p.local]))}`);
    const w = seen?.s.watch ?? (await B.G(() => window.__game.snapshot().watch));
    step('the viewer\'s camera follows the streamer', !!w?.target && w.target === seen?.p.id, JSON.stringify(w));
    const [ca, cb] = [await A.G(() => window.__game.camera()), await B.G(() => window.__game.camera())];
    const gap = Math.hypot(...ca.eye.map((v, i) => v - cb.eye[i])), deg = angle(ca.dir, cb.dir);
    step('the viewer sees as the streamer does', ca.mode === 'first' ? gap < 0.4 && deg < 12 : deg < 40, `${ca.mode}: the eyes ${gap.toFixed(2)} m apart, the looks ${deg.toFixed(1)}° apart`);
    // blocks: the one from before the stream (the world's load plus the key frame) and one placed while B watches; A then
    // looks at it from close by, where the aim's origin and the eyes differ most (play-test 1: 0 against 48.8 degrees)
    const during = await A.stack(spot, 1);
    const [b1, b2, a1, a2] = [await until(async () => (await B.voxel(...before)) || null, 6000, 'the first block on B').catch(() => 0), await until(async () => (await B.voxel(...during)) || null, 6000, 'the second block on B').catch(() => 0), await A.voxel(...before), await A.voxel(...during)];
    const why = async () => { const b = (await A.state()).build; return `A's build: pick ${JSON.stringify(b?.pick?.cell ?? null)}, refused ${JSON.stringify(b?.stats?.refusedBy ?? {})}, placed ${b?.stats?.placed}`; };
    step('the viewer sees blocks built before and during the stream', b1 > 0 && b1 === a1 && b2 > 0 && b2 === a2, `before ${before.join(',')}: A ${a1} B ${b1}; during ${during.join(',')}: A ${a2} B ${b2}${a2 ? '' : `; ${await why()}`}`);
    // A walks up to the two-block column and looks straight at its side, at eye height
    const side = () => { const dx = aMe.x - (during[0] + 0.5), dz = aMe.z - (during[2] + 0.5); return { cell: during, normal: Math.abs(dx) > Math.abs(dz) ? [Math.sign(dx), 0, 0] : [0, 0, Math.sign(dz)] }; };
    const face = side();
    await A.aim(face).catch(() => {});
    await A.page.keyboard.down('KeyW'); await sleep(1300); await A.page.keyboard.up('KeyW'); await sleep(300);
    await A.aim(face).catch(() => {});
    await sleep(1500);
    const [na, nb] = [await A.G(() => window.__game.camera()), await B.G(() => window.__game.camera())];
    const nearDeg = angle(na.dir, nb.dir), wall = Math.hypot(na.eye[0] - (during[0] + 0.5), na.eye[2] - (during[2] + 0.5));
    step('close to a wall, the viewer still looks where the streamer looks', na.mode !== 'first' || nearDeg < 12, `${na.mode}: ${nearDeg.toFixed(1)}° apart, ${wall.toFixed(2)} m from the column (pitch A ${(Math.asin(na.dir[1]) * 57.3).toFixed(1)}°, B ${(Math.asin(nb.dir[1]) * 57.3).toFixed(1)}°)`);
    // the viewer is not in the room, and the streamer sees the count
    const aState = await A.state(), bParty = await B.party();
    const others = aState.players.filter(p => !p.local && !p.bot).map(p => p.name);
    step('the viewer is not in the room (no seat, nobody new on A)', bParty.world?.status === 'watch' && !bParty.world?.code && others.length === 1 && others[0] === 'Hal', `B status ${bParty.world?.status}; A sees ${JSON.stringify(others)}`);
    const count = await until(async () => { const s = await A.page.evaluate(() => ({ n: window.__party.snapshot().live.viewers, badge: document.querySelector('#mp-live')?.textContent ?? '' })); return s.n >= 1 && /1 watching/.test(s.badge) ? s : null; }, 6000, 'the count').catch(() => null);
    step('the streamer sees how many watch', !!count, count ? count.badge : 'no count');
    // names over characters on the viewer's screen (the streamer's own is left out in first person: B sees from A's eyes)
    const tags = await B.G(() => {
      const s = window.__game.snapshot(), out = [], W = innerWidth, Ht = innerHeight;
      const plates = [...document.querySelectorAll('.gf-plate')].filter(e => e.style.display !== 'none');
      for (const p of s.players) {
        if (p.local || p.id === s.watch?.target) continue;
        const at = window.__game.project(p.x, p.y + 1.7, p.z);
        if (!at?.front || at.x < 20 || at.x > W - 20 || at.y < 20 || at.y > Ht - 20) continue;
        const e = plates.find(x => x.lastChild?.textContent === p.name);
        if (!e) { out.push({ name: p.name, missing: true }); continue; }
        const r = e.getBoundingClientRect();
        out.push({ name: p.name, dx: Math.round(r.left + r.width / 2 - at.x), dy: Math.round(r.bottom - at.y) });
      }
      return out;
    });
    step('a viewer\'s nameplates sit over the characters it can see', tags.every(t => !t.missing && Math.abs(t.dx) <= 40 && Math.abs(t.dy) <= 120), tags.length ? JSON.stringify(tags) : 'nobody else in view');
    // read-only: a crafted message from a viewer's socket is refused by the relay and changes nothing
    const relay = `ws://${new URL(server.url).host}/watch/v1/${live.id}`;
    const code = await B.page.evaluate(url => new Promise(r => { const ws = new WebSocket(url); ws.onopen = () => ws.send(JSON.stringify({ k: 'd', t: 0, m: [[0, 'e:g', 'p1', { n: 'build:ed', d: { l: [[999, 'x.y', 1, 1, 1, 1]] } }]] })); ws.onclose = e => r(e.code); setTimeout(() => r('timeout'), 5000); }), relay);
    const still = await A.voxel(...during);
    step('a viewer can\'t send: the relay closes a socket that tries (1008)', code === 1008 && still === a2, `close ${code}`);
    if (shot) await shot(B.page, 'watch-viewer');
    // ---- H leaves: A hosts; A's next block reaches B (play-test 1: the first block after a handoff was lost) ----
    await H.ctx.close(); H = null;
    await until(async () => { const s = await A.state(); return s.status === 'in' && s.host ? s : null; }, 20000, 'A to host');
    await A.page.keyboard.down('KeyS'); await sleep(700); await A.page.keyboard.up('KeyS');      // off the wall, room to build
    await sleep(800);
    // A breaks the column's top block (a right click; which face the click lands on doesn't matter): the first edit of the
    // new room, which play-test 1 saw lost for viewers already watching
    const aNow = await A.me();
    const toA = Math.abs(aNow.x - (during[0] + 0.5)) > Math.abs(aNow.z - (during[2] + 0.5)) ? [Math.sign(aNow.x - (during[0] + 0.5)), 0, 0] : [0, 0, Math.sign(aNow.z - (during[2] + 0.5))];
    await A.act({ cell: during, normal: toA }, 'right');
    const [a3, b3] = [await until(async () => (await A.voxel(...during)) === 0 || null, 4000, 'A\'s break after the handoff').then(() => 0).catch(async () => A.voxel(...during)),
      await until(async () => (await B.voxel(...during)) === 0 || null, 8000, 'the break on B').then(() => 0).catch(async () => B.voxel(...during))];
    step('after the host leaves, the streamer\'s next edit reaches the viewer', a3 === 0 && b3 === 0, `cell ${during.join(',')} broken: A ${a3}, B ${b3}${a3 ? `; ${await why()}` : ''}`);
    // ---- B joins in place ----
    await B.G(() => { window.__watchMark = 1; });
    await B.page.click('#mp-watch-join');
    await until(() => B.page.evaluate(() => !!document.querySelector('#mp-enter')), 5000, 'the world card over the stream');
    await B.page.fill('#mp-name', 'Bo');
    await B.page.click('#mp-enter');
    await until(() => B.G(() => window.__game.phase === 'playing' && window.__game.snapshot().world?.status === 'in'), 30000, 'B in the world');
    await sleep(800);
    const mark = await B.G(() => window.__watchMark ?? null);
    const bIn = await B.party(), aSeesBo = await until(async () => (await A.state()).players.find(p => !p.local && p.name === 'Bo') ?? null, 6000, 'Bo on A').catch(() => null);
    const bDuring = await B.voxel(...during);
    step('Join puts the viewer in the same world, without reloading the game', mark === 1 && !bIn.watch && bIn.world?.status === 'in' && !!aSeesBo && bDuring === 0, `mark ${mark} (1: no reload); B status ${bIn.world?.status}, still watching ${!!bIn.watch}; A sees Bo ${!!aSeesBo}; the column's top block on B ${bDuring} (broken: 0)`);
    // ---- C watches; A stops; C sees the end ----
    C = await viewer(browser, server, live.id, 'viewer C', errors);
    await until(async () => (await C.party()).watch?.keyed || null, 15000, 'C tuned in').catch(() => {});
    await A.frame.evaluate(() => document.exitPointerLock?.()).catch(() => {});
    await A.page.keyboard.press('Escape'); await sleep(300); await A.page.keyboard.press('Escape'); await sleep(200);
    await A.page.click('#mp-live');
    await A.page.click('#mp-live-stop');
    const ended = await until(async () => { const w2 = (await C.party()).watch; return w2?.ended ? w2 : null; }, 6000, 'the end on C').catch(() => null);
    const cBar = await C.page.evaluate(() => document.querySelector('#mp-watch')?.textContent ?? '');
    step('Stop ends the stream for viewers, with Play and no stray words', !!ended && /ended/.test(cBar) && /Play/.test(cBar) && !/null|undefined/.test(cBar) && (await A.page.evaluate(() => window.__party.snapshot().live.state)) === 'off', cBar);
    // ---- C plays alone: the world's own page, a practice copy (kit 1.6.3) ----
    await C.page.click('#mp-watch-solo').catch(() => {});
    const solo = await until(() => C.page.evaluate(() => window.__game?.ready === true && document.querySelector('#gf-play') ? { url: location.href, net: window.__game.snapshot().net ?? null, play: document.querySelector('#gf-play').textContent } : null), 60000, 'the world alone on C').catch(() => null);
    step('Play solo: the world\'s own page, a practice copy with nobody else', !!solo && solo.net === null && !/\/gf\/mp\//.test(new URL(solo.url).pathname) && !new URL(solo.url).searchParams.has('watch'), solo ? `${solo.url}; "${solo.play}"` : `still at ${C.page.url()}`);
    // ---- another day: A's streamer link in a new browser, the same public link (kit 1.6.5) ----
    let again = null, dUrl = '', dNote = false, dLeak = -1, eLive = null;
    if (keep) {
      D = await player(browser, { ...server, friendsUrl: keep }, 'Ada', errors);
      dUrl = D.page.url();
      dNote = await until(() => D.page.evaluate(() => !!document.querySelector('#mp-live-saved:not([hidden])')), 8000, 'the saved-link note').catch(() => false);
      await D.enter();
      await D.page.keyboard.press('Escape'); await sleep(400);
      await D.frame.click('#gf-live').catch(() => {});
      again = await until(async () => { const s = (await D.page.evaluate(() => window.__party.snapshot())).live; return s.state === 'on' ? s : null; }, 15000, 'D live').catch(() => null);
      dLeak = await D.page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('gf-watch:')).length).catch(() => -1);
      if (again) {
        E = await viewer(browser, server, live.id, 'viewer E', errors);
        eLive = await until(async () => { const w2 = (await E.party()).watch; return w2?.live && !w2.ended ? w2 : null; }, 15000, 'E sees D live').catch(() => null);
      }
    }
    step('another day, the streamer link goes live on the same link, and the old link shows it', !!again && again.id === live.id && again.link === live.link && !!eLive && !/gf-stream/.test(dUrl) && dNote && dLeak === 0,
      again ? `live on ${again.id} (was ${live.id}); the old link ${eLive ? 'shows it live' : 'does not show it live'}; the address bar ${/gf-stream/.test(dUrl) ? 'still holds the secret' : 'is clean'}; the note ${dNote ? 'shown' : 'not shown'}; localStorage ${dLeak} gf-watch entries` : `D is ${keep ? 'not live' : 'never opened: no streamer link'}`);
    step('no console errors', errors.length === 0, errors.slice(0, 4).join(' | '));
  } catch (e) {
    step('the flow ran to the end', false, e.message);
  } finally {
    for (const P of [H, A, B, C, D, E]) await P?.ctx.close().catch(() => {});
  }
  return done();

  function done() {
    const failed = steps.filter(s => !s.ok);
    return { ok: steps.length > 0 && !failed.length, detail: failed.length ? failed.map(s => `${s.name}: ${s.detail}`).slice(0, 3).join(' · ') : `${steps.length} steps: Go live, watch where the streamer is and as they look, blocks before, during and after a handoff, read-only, Join in place, Stop, the game alone, the same link another day`, record };
  }
}
