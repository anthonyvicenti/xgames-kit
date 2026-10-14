// The multiplayer gate for a LIVE game (multiplayer.json mode "live"): players in one shared space who see each other.
// Called by gate.mjs after the manifest, the kit copy and solo play have been checked. Same setup: one Chrome, a
// separate context for a host and a joiner, real WebRTC, real mouse and keyboard.
//
// What a live game's observation must report, in window.__game.snapshot().net (null when played alone):
//   you, host, started                      this copy's player id, whether it owns the shared world, whether play began
//   me: {x, y, z?}                           where this player is, in world units
//   peers: [{id, name, x, y, z?, onScreen}]  every OTHER player this copy is drawing: where it draws them, and whether
//                                            their character is inside this player's view right now
//   clock                                    seconds of shared time, owned by the host's copy, rising while the round runs
//   shared                                   a short string that is equal on every copy when the shared world is in sync
//                                            (the wave and the ids of the live enemies; "-" when only the level is shared)
//
// Checks: both games load and say ready; everyone starts together; each copy draws the other player where that
// player really is; a friend's character is on screen (with a screenshot of that moment); the host's movement shows
// on the joiner's screen; the shared world matches; the world keeps running while the host's tab is in the
// background; a result reaches both; play again; a reload drops back into the round and sees the others; the host
// ends a round; the host leaving closes the room.
import { fuzz } from '../../asset-manifest/play-driver.mjs';
import { checkTransport, connectionTrace, endRound, inFrame, joinState, p2p, sleep, snap, until } from './gate-lib.mjs';

// play stops this long before the room's cap (the background-host step and the results come after it), and plays at
// least PLAY_MIN however late it starts
const PLAY_MARGIN = 16000, PLAY_MIN = 12000, PLAY_MAX = 40000;
/** When scripted play stops (ms, wall clock): PLAY_MARGIN before the room's own end of the round, at most PLAY_MAX from now, at least PLAY_MIN. */
export const playDeadline = ({ roundT0, now, cap }) => Math.max(now + PLAY_MIN, Math.min(roundT0 + cap * 1000 - PLAY_MARGIN, now + PLAY_MAX));
const dist = (a, b) =>Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));

export async function gateLive({ manifest, live, assets, dir, srv, player, check, notes, shot, rec, errors, seconds, signal = null, legs = null, diagnose = null }) {
  const frameOf = page => page.frames().find(f => f.parentFrame() === page.mainFrame());
  const game = page => frameOf(page)?.evaluate(() => window.__game?.snapshot() ?? null).catch(() => null) ?? null;
  const net = async page => (await game(page))?.net ?? null;
  const near = typeof manifest.check?.near === 'number' ? manifest.check.near : 2.5;      // world units a drawn friend may lag behind
  const cap = Math.max(30, Math.min(600, manifest.check?.seconds ?? seconds));
  const gq = typeof manifest.check?.query === 'string' && manifest.check.query ? `&gq=${encodeURIComponent(manifest.check.query)}` : '';
  const avoidKeys = [...new Set([...(assets?.check?.play?.avoidKeys ?? []), ...(manifest.check?.avoidKeys ?? [])])];

  if (gq) notes.push(`the gate played the game with ?${manifest.check.query} (check.query: a gentler or shorter round for scripted players, never used in real play)`);
  // Give the mouse back to the page before a click on the party page's own buttons. A player presses Escape; under
  // automation a synthetic Escape lets a game take the mouse straight back, so the gate asks the browser directly.
  const freeMouse = page => page.evaluate(() => { try { document.getElementById('game').contentDocument.exitPointerLock(); } catch {} try { document.exitPointerLock(); } catch {} }).catch(() => {});

  const H = await player('host'), J = await player('joiner');
  await H.page.goto(`${srv.partyUrl}?max=${cap}${gq}${signal ? `&signal=${signal}` : ''}`, { waitUntil: 'load' });
  await until(async () => (await snap(H.page))?.phase === 'home' || (await snap(H.page))?.fatal, 20000, 'the lobby');
  const boot = await snap(H.page);
  if (!check('shell-boots', boot?.phase === 'home' && !boot.fatal, boot?.fatal || 'the Host / Join lobby is up')) throw new Error('shell did not boot');
  await H.page.fill('#gfp-name', 'Hosta');
  await H.page.click('#gfp-host');
  const hs = await until(async () => { const s = await snap(H.page); return s?.phase === 'room' && s.code && s.card === 'lobby' && s.host ? s : null; }, 20000, 'the host to open a room');
  check('host-opens-room', /^[A-Z2-9]{6}$/.test(hs.code), `room ${hs.code}`);
  const invite = await H.page.inputValue('#mp-invite');
  await J.page.goto(invite, { waitUntil: 'load' });
  await until(async () => (await snap(J.page))?.phase === 'home', 20000, 'the joiner lobby');
  await J.page.fill('#gfp-name', 'Joan');
  await J.page.click('#gfp-join');
  const joining = connectionTrace(H, J);
  await until(async () => { await joining.watch(); const a = await snap(H.page), b = await snap(J.page); return a?.racers.length === 2 && b?.racers.length === 2 && b.phase === 'room'; }, 30000, 'both players in the room')
    .catch(async e => {
      const where = `${await joinState(H, J)}; ${joining.text()}`;
      // the join failed: is it this game, or WebRTC on this machine? (record.webrtc; gate-lib webrtcProbe)
      if (diagnose) { rec.signaling = srv.sig.stats(); rec.webrtc = await diagnose().catch(x => ({ error: String(x?.message ?? x).slice(0, 200) })); }
      throw new Error(`${e.message} (${where})`);
    });
  const j0 = await snap(J.page), h0 = await snap(H.page);
  const joined = j0.you && j0.you !== h0.you && !j0.host && (await p2p(J.page))?.connected === true;
  if (!joined && diagnose) rec.webrtc = await diagnose().catch(x => ({ error: String(x?.message ?? x).slice(0, 200) }));
  check('joiner-joins-over-webrtc', joined, `host ${h0.you} "${h0.names[h0.you]}", joiner ${j0.you} "${j0.names[j0.you]}"${joined ? '' : ` (${await joinState(H, J)}; ${joining.text()})`}`);
  await checkTransport({ H, J, srv, signal, check, rec });
  await shot(H.page, 'host-lobby');
  if (legs === 'lobby') {
    // the lobby legs only (gate.mjs legs): the room is open and both players are in it over WebRTC; no round is played
    const kitErrors = errors.filter(e => e.kit);
    check('no-kit-errors', kitErrors.length === 0, kitErrors.slice(0, 3).map(e => `${e.who}: ${e.text}`).join(' | '));
    notes.push('lobby legs only: no round was started, so nothing here says the players see each other in play');
    rec.signaling = srv.sig.stats();
    return;
  }

  // ---- the round loads for everyone, then starts for everyone ----
  await H.page.click('#mp-start');
  const loaded = await until(async () => (await snap(H.page))?.gameReady && (await snap(J.page))?.gameReady, 90000, 'both games to load and say ready').then(() => true).catch(() => false);
  check('both-games-ready', loaded, loaded ? 'both games loaded, attached to the round and called net.ready()' : 'a game never called net.ready() (the round would start without it after 25 s)');
  await until(async () => (await snap(H.page))?.revealed && (await snap(J.page))?.revealed, 45000, 'the countdown');
  let tH = 0, tJ = 0;
  await until(async () => { const [a, b] = [await net(H.page), await net(J.page)]; if (a?.started && !tH) tH = Date.now(); if (b?.started && !tJ) tJ = Date.now(); return tH && tJ; }, 20000, 'both games to start').catch(() => {});
  check('everyone-starts-together', tH && tJ && Math.abs(tH - tJ) < 1500, tH && tJ ? `the two games started ${Math.abs(tH - tJ)} ms apart` : `started: host ${!!tH}, joiner ${!!tJ} (the game must begin play from net.onStart, with no title screen to click through)`);
  const [nh, nj] = [await net(H.page), await net(J.page)];
  check('one-host', nh?.host === true && nj?.host === false, `host copy: ${nh?.you}, the other: ${nj?.you}`);

  // ---- scripted players, kept off the party page's own cards (gate-lib) ----
  const proxyOf = async P => { const box = await P.page.locator('#game').boundingBox(); return inFrame(P.page, frameOf(P.page), { width: Math.round(box.width), height: Math.round(box.height) }); };
  // A live round starts itself (net.onStart): there is no title to get past, and the game's solo start steps would only
  // stall here while the world runs on. One real click in the middle of the game gives it focus (and the mouse, in a
  // game that takes it), as a player's first click would.
  for (const P of [H, J]) { const box = await P.page.locator('#game').boundingBox(); await P.page.mouse.click(Math.round(box.width / 2), Math.round(box.height / 2)).catch(() => {}); }

  // ---- each copy draws the other player, where that player really is ----
  const seen = async (viewer, other) => { const [v, o] = [await net(viewer.page), await net(other.page)]; const p = v?.peers?.find(x => x.id === o?.you); return p && p.x != null && o.me ? { p, me: o.me, d: dist(p, o.me) } : null; };
  const jSeesH = await until(() => seen(J, H), 10000, 'the joiner to draw the host').catch(() => null);
  const hSeesJ = await until(() => seen(H, J), 10000, 'the host to draw the joiner').catch(() => null);
  check('each-draws-the-other', !!jSeesH && !!hSeesJ, jSeesH && hSeesJ ? `the joiner draws "${jSeesH.p.name}", the host draws "${hSeesJ.p.name}"` : `joiner draws the host: ${!!jSeesH}; host draws the joiner: ${!!hSeesJ} (snapshot().net.peers must list every other player with a position)`);

  // ---- play: both move with real input; the gate watches positions, the screen and the shared world ----
  const trace = { onScreen: { host: 0, joiner: 0 }, sharedSame: 0, sharedSamples: 0, sharedDiff: [], hostMoved: 0, drawnGap: [], firstShot: false };
  const hostStart = (await net(H.page))?.me;
  // The room ends a round `cap` seconds after it began (gf-multiplayer room.js, by the room's own clock), whatever the
  // gate was doing meanwhile. So play stops PLAY_MARGIN before that, counted from when the round began, not from now:
  // on a loaded machine the steps above (both games ready, each drawing the other) take longer, and a deadline counted
  // from here ran the round into its cap before the background-host step (Isle Run, twice, only with another verify on
  // the graphics card). PLAY_MIN keeps some play when the steps above ate the round; the background step then moves to
  // round 2 (below).
  const roundT0 = tH && tJ ? Math.min(tH, tJ) : Date.now();
  const end = playDeadline({ roundT0, now: Date.now(), cap });
  rec.play = { secondsIntoRound: Math.round((Date.now() - roundT0) / 100) / 10, playSeconds: Math.round((end - Date.now()) / 100) / 10, cap };
  const watch = (async () => {
    while (Date.now() < end) {
      const [a, b] = [await net(H.page), await net(J.page)];
      if (a && b) {
        const hp = b.peers?.find(x => x.id === a.you), jp = a.peers?.find(x => x.id === b.you);
        if (hp?.onScreen) { trace.onScreen.joiner++; if (!trace.firstShot) { trace.firstShot = true; await shot(J.page, 'joiner-sees-the-host'); } }
        if (jp?.onScreen) { trace.onScreen.host++; if (!trace.hostShot) { trace.hostShot = true; await shot(H.page, 'host-sees-the-joiner'); } }
        if (hostStart && a.me) trace.hostMoved = Math.max(trace.hostMoved, dist(a.me, hostStart));
        if (hp && hp.x != null && a.me) trace.drawnGap.push(dist(hp, a.me));
        if (typeof a.shared === 'string' && typeof b.shared === 'string') { trace.sharedSamples++; if (a.shared === b.shared) trace.sharedSame++; else if (trace.sharedDiff.length < 3) trace.sharedDiff.push(`host "${a.shared.slice(0, 60)}" / joiner "${b.shared.slice(0, 60)}"`); }
      }
      await sleep(350);
    }
  })();
  const drive = async (P, n) => { const proxy = await proxyOf(P); for (let i = 0; Date.now() < end; i++) { const s = await snap(P.page); if (!s || s.room === 'results') break; await fuzz(proxy, { seconds: 2, seed: 500 * (n + 1) + i, avoidKeys, restart: async () => {}, buttons: false }).catch(() => {}); } };
  await Promise.all([drive(H, 0), drive(J, 1), watch]);
  await shot(H.page, 'host-playing'); await shot(J.page, 'joiner-playing');
  rec.live = { ...trace, near };

  check('host-movement-shows-on-the-joiner', trace.hostMoved > near && trace.drawnGap.length > 5 && trace.drawnGap.slice(-8).some(d => d <= near * 2),
    `the host moved ${trace.hostMoved.toFixed(1)} units; the joiner drew the host ${trace.drawnGap.length ? Math.min(...trace.drawnGap.slice(-8)).toFixed(2) : '?'} units from where the host was (allowed ${near * 2})`);
  check('a-friend-is-on-screen', trace.onScreen.joiner + trace.onScreen.host > 0, `the other player's character was inside the view in ${trace.onScreen.joiner} of the joiner's samples and ${trace.onScreen.host} of the host's (screenshots: *-sees-the-*)`);
  check('both-see-each-other-on-screen', trace.onScreen.joiner > 0 && trace.onScreen.host > 0, `joiner saw the host ${trace.onScreen.joiner} times, host saw the joiner ${trace.onScreen.host} times`, { soft: true });
  const agree = trace.sharedSamples ? trace.sharedSame / trace.sharedSamples : 0;
  check('the-shared-world-matches', trace.sharedSamples >= 5 && agree >= 0.8, `${trace.sharedSame} of ${trace.sharedSamples} samples had the same shared world on both copies${trace.sharedDiff.length ? `; e.g. ${trace.sharedDiff[0]}` : ''}`);

  // ---- the host's tab goes behind another one: the shared world keeps running for the joiner ----
  // In round 1 while it runs; when round 1 has already ended (the game's own end under random input: everyone down, the
  // goal reached), at the start of round 2 instead, so whether it is measured never depends on how long scripted
  // players survived or how loaded the machine was.
  const backgroundStep = async round => {
    const other = await H.ctx.newPage();
    await other.goto('about:blank'); await other.bringToFront();
    // the clock read against the wall clock between the two reads, never a fixed 2 s: a loaded machine stretches the reads
    const t1 = Date.now(), c1 = (await net(J.page))?.clock; await sleep(2000); const c2 = (await net(J.page))?.clock, t2 = Date.now();
    await H.page.bringToFront(); await other.close();
    const span = (t2 - t1) / 1000;
    check('a-background-host-does-not-stop-the-world', typeof c1 === 'number' && typeof c2 === 'number' && c2 - c1 > 0.6 * span, `the shared clock went ${c1} → ${c2} on the joiner in ${span.toFixed(1)} s while the host's tab was in the background, in round ${round} (the game runs its frame through net.loop). Headless Chrome does not slow a background tab the way a real one does, so this proves the frames kept coming, not that a real hidden tab is safe`);
  };
  let backgroundDone = false;
  if ((await snap(J.page))?.room === 'racing') { await backgroundStep(1); backgroundDone = true; }
  else notes.push('round 1 ended before the background-host step (the game\'s own end under random input, or the room\'s cap); it ran at the start of round 2');

  // ---- a result for the round, the same on both ----
  if ((await snap(H.page))?.room !== 'results') { await freeMouse(H.page); await endRound(H.page); }
  await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', 20000, 'the round to end');
  await until(async () => (await snap(H.page))?.results && (await snap(J.page))?.results, 5000, 'the results').catch(() => {});
  const [h2, j2] = [await snap(H.page), await snap(J.page)];
  const overH = await net(H.page), overJ = await net(J.page);
  check('the-games-know-the-round-is-over', overH?.over === true && overJ?.over === true, `net.over on the host's copy: ${overH?.over}, on the joiner's: ${overJ?.over} (the game stops its world and sound from net.onEnd, and reports net.over in snapshot().net)`, { soft: true });
  check('both-see-the-same-results', JSON.stringify(h2.results) === JSON.stringify(j2.results) && h2.results?.ranking?.length === 2, `round ${h2.round}${h2.results?.team ? `, one team result (${h2.results.won === true ? 'won' : h2.results.won === false ? 'lost' : 'ended by the host'})` : ''}`);
  check('scripted-play-stayed-in-round-1', h2.round === 1 && j2.round === 1, `the room is at round ${h2.round}`);
  await shot(H.page, 'host-results');
  rec.round1 = h2.results;

  // ---- play again; a reload drops back into the running round and sees the others ----
  await sleep(900);
  await freeMouse(H.page);
  await H.page.click(await H.page.isVisible('#mp-again') ? '#mp-again' : '#start');
  await until(async () => { const a = await snap(H.page), b = await snap(J.page); return a?.round === 2 && b?.round === 2 && a.revealed && b.revealed; }, 90000, 'round 2');
  await until(async () => (await net(H.page))?.started && (await net(J.page))?.started, 20000, 'round 2 to start').catch(() => {});
  check('play-again-starts-a-new-round', (await net(H.page))?.started === true && (await net(J.page))?.started === true, 'both games are playing round 2');
  if (!backgroundDone) {
    if ((await snap(J.page))?.room === 'racing') await backgroundStep(2);
    else check('a-background-host-does-not-stop-the-world', false, 'not checked: round 1 ended before this step and round 2 was not running either', { soft: true });
  }
  await J.page.reload({ waitUntil: 'load' });
  const back = await until(async () => { const s = await snap(J.page); const n = await net(J.page); return s?.phase === 'room' && s.round === 2 && n?.started && n.peers?.some(p => p.id === h0.you && p.x != null) ? { s, n } : null; }, 90000, 'the joiner to drop back in').catch(() => null);
  check('reload-drops-back-into-the-round', !!back && back.s.you === j0.you, back ? `seat ${back.s.you} again, playing, and drawing the host` : 'after a reload the joiner did not get back into the running round (a late or returning player starts from net.onStart at once and takes the world from the host)');
  await shot(J.page, 'joiner-after-reload');

  if ((await snap(H.page))?.room !== 'results') { await freeMouse(H.page); await endRound(H.page); }
  await until(async () => (await snap(H.page))?.room === 'results' && (await snap(J.page))?.room === 'results', 20000, 'End round').then(() => check('host-ends-the-round', true, 'both pages show round 2 results')).catch(e => check('host-ends-the-round', false, e.message));

  await H.page.close();
  const gone = await until(async () => { const s = await p2p(J.page); return s && ['closed', 'lost'].includes(s.phase) ? s : null; }, 25000, 'the joiner to notice').catch(() => null);
  check('host-leaving-closes-the-room', !!gone, gone ? `the joiner sees: ${gone.reason}` : 'the joiner never noticed');

  const kitErrors = errors.filter(e => e.kit);
  check('no-kit-errors', kitErrors.length === 0, kitErrors.slice(0, 3).map(e => `${e.who}: ${e.text}`).join(' | '));
  const gameErrors = errors.filter(e => !e.kit);
  if (gameErrors.length) notes.push(`${gameErrors.length} console errors from the game itself under scripted input (not the kit): ${[...new Set(gameErrors.map(e => e.text))].slice(0, 3).join(' | ')}`);
  rec.signaling = srv.sig.stats();
}
