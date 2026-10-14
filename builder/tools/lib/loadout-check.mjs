// The loadout leg of verify check 5 (CONTRACT §6e): two players over real WebRTC, each with their own test loadout
// (a body colour and a shot or stream colour), must each be drawn in their own look on the OTHER player's screen; a
// change mid-round reaches the other copy; a copy that arrives late (a reload) gets everyone's looks. With `third`, a
// third player joins during round 1 and must see the host's look in round 2 (the proof script, tools/loadouts.mjs).
//
// The check reads what each copy really draws (window.__game.looks(): the colour the body's tint materials are set to
// and read back from the material, the colour of the liquid arc's material, the colour this copy resolves for each
// shooter), never the loadout table alone, and takes screenshots from each player's own view.
//
//   const r = await checkLoadouts({ dir, outDir, log, third: false });   → { ok, detail, record, warnings }
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { endRound, snap, sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { launchForGame } from './paths.mjs';
import { getPointer } from '../../gf-assets/source/gf-assets.js';

const TINT = 'character.tint.player';
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
const near = (a, b, tol = 6) => !!a && !!b && hex(a).every((v, i) => Math.abs(v - hex(b)[i]) <= tol);

/** Test loadouts for this game: colours unlike the game's own (its seat colours and its shot colour). */
export function testLoadouts(assets, defaults) {
  const looks = (assets.slots ?? []).filter(s => s.scope === 'player');
  const tint = looks.some(s => s.id === TINT);
  const colors = looks.filter(s => s.type === 'color').map(s => s.id);
  const taken = [...(defaults.palette ?? []), ...Object.values(defaults.colors ?? {})].map(c => String(c).toLowerCase());
  const pick = list => list.find(c => !taken.some(t => /^#[0-9a-f]{6}$/.test(t) && near(t, c, 40))) ?? list[0];
  const make = (t, c) => ({ values: { ...(tint ? { [TINT]: t } : {}), ...Object.fromEntries(colors.map(id => [id, c])) }, files: {} });
  return {
    A: make(pick(['#23c64a', '#3ad16b']), pick(['#2457ff', '#1f7aff'])),          // green body, blue shots
    B: make(pick(['#ff8a1f', '#ffa040']), pick(['#b03bff', '#c45cff'])),          // orange body, purple shots
    A2: make(pick(['#13d6d6', '#2ee0e0']), pick(['#ff2d3a', '#ff4b55'])),         // the change: cyan body, red shots
    tint, colors,
  };
}

/**
 * Why a player's page has no running game, from the party page's state (gate-lib snap) and the game's net snapshot.
 * Pure, so a test holds the wording. A round that ended by itself is the usual cause: the leg needs about two minutes
 * of a round with two players who mostly stand still.
 */
export function describeLost(party, net) {
  if (!party) return 'the party page did not answer';
  if (party.room === 'results' || party.card === 'results') return `the round had already ended (the party page shows the results${party.round ? ` of round ${party.round}` : ''}): this leg needs a round that lasts about two minutes with two players who mostly stand still, and this game's round ended by itself before that`;
  if (party.phase === 'home') return 'its party page is back at the Host / Join lobby (it did not rejoin the room)';
  if (net && net.started === false) return `its game loaded but the round has not started for it (party page: ${party.phase ?? '?'}${party.card ? `, ${party.card}` : ''})`;
  return `its party page shows ${party.phase ?? '?'}${party.card ? ` (${party.card})` : ''}${party.room ? `, room ${party.room}` : ''} and no game frame`;
}

export async function checkLoadouts({ dir, outDir = null, log = () => {}, third = false, throwBall = false, loadouts = null, shots = [], seconds = 240 } = {}) {
  const assets = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  const game = JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
  const prjSpec = (game.mechanics ?? []).find(m => m.id === 'projectile');
  const SHOT = (assets.slots ?? []).some(s => s.id === 'mechanic.projectile.color' && s.scope === 'player') && prjSpec ? 'mechanic.projectile.color' : null;
  const stream = prjSpec?.params?.kind === 'continuous';
  const valueOf = async id => { const s = assets.slots.find(x => x.id === id); if (!s?.source?.pointer) return null; try { return getPointer(JSON.parse(await readFile(join(dir, s.source.file), 'utf8')), s.source.pointer); } catch { return null; } };
  const defaults = { palette: (await valueOf(TINT)) ?? [], colors: SHOT ? { [SHOT]: await valueOf(SHOT) } : {} };
  const T = loadouts ?? testLoadouts(assets, defaults);
  const record = { loadouts: { A: T.A, B: T.B, A2: T.A2 }, defaults, steps: [], shots: [], errors: [] };
  const warnings = [], noTint = new Set();
  const steps = record.steps;
  const step = (name, ok, detail) => { steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} loadout ${name}: ${detail}`); return !!ok; };
  if (!T.tint && !SHOT) return { ok: true, detail: 'no player-look colour slots in this game; nothing to check', record, warnings: ['loadouts: the game declares no player-look colours'] };

  const srv = await startParty({ dir, port: 0 });
  // a scenic game on WebGPU, a party game on WebGL (CONTRACT §8; paths.mjs launchForGame)
  const { browser, note: gpuNote } = await launchForGame(launchChrome, dir);
  if (gpuNote) warnings.push(`loadouts: ${gpuNote}`);
  const shot = async (page, name) => {
    if (!outDir) return null;
    const f = `loadout-${String(record.shots.length + 1).padStart(2, '0')}-${name}.jpg`;
    record.shots.push(f); shots.push(f);
    await page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }).catch(() => {});
    return f;
  };
  const player = async (label, loadout) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    // a round long enough for every step (Studio's own override mechanism), in every frame: the game's frame reads it
    await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] }; });
    if (loadout) await ctx.addInitScript(l => { window.__GF_LOADOUT = l; }, loadout);
    const page = await ctx.newPage();
    page.on('pageerror', e => record.errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) record.errors.push(`${label}: ${m.text().slice(0, 240)}`); });
    return { label, ctx, page };
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const looks = async P => frameOf(P)?.evaluate(() => window.__game?.looks?.() ?? null).catch(() => null) ?? null;
  const net = async P => frameOf(P)?.evaluate(() => window.__game?.snapshot()?.net ?? null).catch(() => null) ?? null;
  const entryOf = (L, id) => L?.players?.find(p => p.id === id) ?? null;
  const freeMouse = P => P.page.evaluate(() => { try { document.getElementById('game').contentDocument.exitPointerLock(); } catch {} }).catch(() => {});
  // the game's frame on the party page. It is gone when the round is over (the page shows the room or the results), so
  // every step that clicks or turns in it asks first: a null box read as b.x was this leg's own crash ("Cannot read
  // properties of null (reading 'x')", 9 of check 5's 11 failures in recorded builds).
  const frameBox = P => P.page.locator('#game').boundingBox({ timeout: 2000 }).catch(() => null);
  const focus = async P => { const b = await frameBox(P); if (!b) return false; await P.page.mouse.click(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2)).catch(() => {}); return true; };
  /** Where a player's page is when its game frame is gone, in words for the step's detail. */
  const whereIs = async P => { const s = await snap(P.page).catch(() => null), n = await net(P); return describeLost(s, n); };

  /** What is wrong with how `entry` (a player as one copy draws them) wears loadout L (null: the game's own). */
  const problems = (entry, L, { streamed = false, ball = false } = {}) => {
    if (!entry) return ['not on this copy'];
    const out = [], d = entry.drawn;
    if (T.tint) {
      const want = L?.values?.[TINT] ?? null;
      if (!d) out.push('no body drawn');
      else {
        if ((d.tint ?? null) !== want) out.push(`body colour ${d.tint ?? 'the game\'s'} (want ${want ?? 'the game\'s'})`);
        const target = want ?? entry.color;
        if (d.material && d.mix >= 0.999 && !near(d.material, target)) out.push(`the body's tint material is ${d.material} (want ${target})`);
        if (want && !d.material) noTint.add(entry.id);
        if (!d.visible && !entry.local) out.push('the body is not visible');           // a first-person player hides their own
      }
    }
    if (SHOT) {
      const want = L?.values?.[SHOT] ?? defaults.colors[SHOT];
      if (!entry.shots) out.push('no shots reported');
      else {
        if (entry.shots.color !== want) out.push(`shot colour ${entry.shots.color} (want ${want})`);
        if (stream && streamed && entry.shots.stream !== want) out.push(`stream drawn in ${entry.shots.stream ?? 'nothing yet'} (want ${want})`);
        if (!stream && ball && entry.shots.ball && entry.shots.ball !== want) out.push(`ball drawn in ${entry.shots.ball} (want ${want})`);   // when one flew
      }
    }
    return out;
  };
  /** Wait until `viewer` draws player `id` in loadout L. → the problems left (empty: it does) */
  const seesLook = async (viewer, id, L, ms, opts) => {
    let last = ['never looked'];
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { last = problems(entryOf(await looks(viewer), id), L, opts); if (!last.length) return []; await sleep(300); }
    return last;
  };
  /** Turn `viewer` to face player `id` (real mouse under pointer lock, in strokes: unlock, re-centre, relock), so the
   *  other player is in the middle of the view. → whether `id` is on screen afterwards */
  const view = async P => frameOf(P)?.evaluate(() => { const s = window.__game?.snapshot(); const c = window.__game?.controls?.(); return s ? { players: s.players, aim: c?.aim?.dir ?? null } : null; }).catch(() => null) ?? null;
  const errTo = async (viewer, id) => {
    const g = await view(viewer); const me = g?.players.find(p => p.local), o = g?.players.find(p => p.id === id);
    if (!me || !o || !g.aim) return null;
    const want = Math.atan2(o.x - me.x, o.z - me.z), have = Math.atan2(g.aim[0], g.aim[2]);
    return Math.atan2(Math.sin(want - have), Math.cos(want - have));
  };
  const turnTo = async (viewer, id) => {
    const b = await frameBox(viewer); if (!b) return false;
    const cx = Math.round(b.x + b.width / 2), cy = Math.round(b.y + b.height / 2);
    const stroke = async px => {
      await viewer.page.mouse.move(cx, cy); await sleep(30);
      const n = Math.max(1, Math.ceil(Math.abs(px) / 20));
      for (let k = 1; k <= n; k++) { await viewer.page.mouse.move(cx + Math.round(px * k / n), cy); await sleep(20); }
      await sleep(150);
      await freeMouse(viewer); await viewer.page.mouse.move(cx, cy); await sleep(50); await focus(viewer); await sleep(120);
    };
    let radPerPx = null;                                             // learnt from the first stroke (sign and size)
    for (let i = 0; i < 14; i++) {
      const e0 = await errTo(viewer, id);
      if (e0 === null) break;
      if (Math.abs(e0) < 0.1) break;
      const px = radPerPx ? Math.max(-240, Math.min(240, e0 / radPerPx)) : 60;
      await stroke(px);
      const e1 = await errTo(viewer, id);
      if (e1 !== null && Math.abs(px) >= 30) { const r = (e0 - e1) / px; if (Math.abs(r) > 1e-4) radPerPx = r; }
    }
    return !!(await net(viewer))?.peers?.find(p => p.id === id)?.onScreen;
  };
  /** A thrown shot that needs something in hand (a dodgeball): walk to the nearest free carry item with real keys,
   *  take it with E, face `to`, throw (F) and screenshot `viewer` while it flies. → whether a ball left */
  const grabAndThrow = async (P, to, viewer) => {
    const ctl = () => frameOf(P)?.evaluate(() => window.__game?.controls?.() ?? null).catch(() => null);
    const step = async k => { const a = (await ctl())?.me; await P.page.keyboard.down(k); await sleep(200); await P.page.keyboard.up(k); await sleep(250); const b = (await ctl())?.me; if (!a || !b) return null; const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz); return l > 0.05 ? [dx / l, dz / l] : null; };
    const f = await step('KeyW'), rt = await step('KeyD');
    if (!f || !rt) { record.throwWhy = 'the host did not move on W or D'; return false; }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const c = await ctl(); if (!c) return false;
      if ((c.me.holding ?? 0) > 0) break;
      // a free carry item, or a pickup spot (a game may hand out the ball from a pickup)
      const t = (c.interactables ?? []).filter(x => x.kind === 'carry' || x.kind === 'pickup').sort((a, b) => a.d - b.d)[0];
      if (!t) { record.throwWhy = `nothing to pick up (${(c.interactables ?? []).map(x => x.kind).join(', ') || 'no interactables'})`; return false; }
      const dx = t.x - c.me.x, dz = t.z - c.me.z, d = Math.hypot(dx, dz), want = (t.reach ?? 1.8) * 0.6;
      if (d <= want) { await P.page.keyboard.press('KeyE'); await sleep(400); continue; }
      const ux = dx / d, uz = dz / d, pf = ux * f[0] + uz * f[1], pr = ux * rt[0] + uz * rt[1];
      const keys = []; if (pf > 0.38) keys.push('KeyW'); if (pf < -0.38) keys.push('KeyS'); if (pr > 0.38) keys.push('KeyD'); if (pr < -0.38) keys.push('KeyA');
      for (const k of keys) await P.page.keyboard.down(k);
      await sleep(Math.max(60, Math.min(260, (d - want) * 90)));
      for (const k of keys) await P.page.keyboard.up(k);
      await sleep(120);
    }
    if (!((await ctl())?.me?.holding > 0)) { record.throwWhy = `no item in hand after 15 s (${JSON.stringify((await ctl())?.me ?? null)})`; return false; }
    // the thrower keeps the heading it had (turning re-takes the mouse with a click, which would throw); the viewer
    // turns to the thrower, so the ball is in its view as it leaves
    await turnTo(viewer, P === viewer ? to : (await net(P))?.you);
    await P.page.keyboard.down('KeyF'); await sleep(80); await P.page.keyboard.up('KeyF');
    await sleep(180); await shot(viewer.page, 'joiner-sees-host-throw');
    await sleep(180); await shot(viewer.page, 'joiner-sees-host-throw-later');
    return true;
  };
  /** Hold the shot (F) on a player's page for `ms`, with an optional screenshot of another page midway. */
  const fire = async (P, ms, during = null) => { await P.page.keyboard.down('KeyF'); await sleep(Math.min(ms, 700)); if (during) await during(); await sleep(Math.max(0, ms - 700)); await P.page.keyboard.up('KeyF'); };

  let ok = false;
  try {
    // ---- a room: the host (A) and a joiner (B), each with their own loadout ----
    const A = await player('A', T.A), B = await player('B', T.B);
    // a game with enemies plays the leg on waves' staged moment (one enemy standing still, no waves), so idle test
    // players are not downed before their looks are compared (gf-scenic wave 1: a run of levels was lost mid-leg)
    // (a forge game with enemies: its rules end no round under the gate's own flag, ?gf-gate=1, so two idle players who
    // fall to the first wave leave the round running for the rest of the leg; ruin-hold, 2026-10-13)
    const calm = (game.mechanics ?? []).some(m => m.id === 'waves') ? '&gf-demo=waves.hit' : (game.forge?.enemies ?? []).length ? '&gf-gate=1' : '';
    await A.page.goto(`${srv.partyUrl}?max=${seconds}&gq=${encodeURIComponent(`bots=0${calm}`)}`, { waitUntil: 'load' });
    await until(async () => (await snap(A.page))?.phase === 'home', 20000, 'the lobby');
    await A.page.fill('#gfp-name', 'Ana'); await A.page.click('#gfp-host');
    await until(async () => { const s = await snap(A.page); return s?.phase === 'room' && s.code && s.host ? s : null; }, 20000, 'the host to open a room');
    const invite = await A.page.inputValue('#mp-invite');
    await B.page.goto(invite, { waitUntil: 'load' });
    await until(async () => (await snap(B.page))?.phase === 'home', 20000, 'the joiner lobby');
    await B.page.fill('#gfp-name', 'Ben'); await B.page.click('#gfp-join');
    await until(async () => (await snap(A.page))?.racers.length === 2 && (await snap(B.page))?.racers.length === 2, 30000, 'both players in the room');
    await A.page.click('#mp-start');
    await until(async () => (await net(A))?.started && (await net(B))?.started, 90000, 'both games to start');
    const [aId, bId] = [(await net(A)).you, (await net(B)).you];
    record.ids = { A: aId, B: bId };
    await focus(A); await focus(B);

    // ---- each copy draws the other in their own look (and itself in its own) ----
    await fire(A, 1600); await fire(B, 1600);
    const bSeesA = await seesLook(B, aId, T.A, 12000, { streamed: true, ball: true });
    const aSeesB = await seesLook(A, bId, T.B, 12000, { streamed: true, ball: true });
    const aSeesA = await seesLook(A, aId, T.A, 3000);
    step('the joiner draws the host in the host\'s loadout', !bSeesA.length, bSeesA.length ? bSeesA.join('; ') : `body ${T.A.values[TINT] ?? '-'}, shots ${SHOT ? T.A.values[SHOT] : '-'}`);
    step('the host draws the joiner in the joiner\'s loadout', !aSeesB.length, aSeesB.length ? aSeesB.join('; ') : `${T.B ? `body ${T.B.values[TINT] ?? '-'}, shots ${SHOT ? T.B.values[SHOT] : '-'}` : 'the game\'s own look'}`);
    step('the host draws itself in its loadout', !aSeesA.length, aSeesA.length ? aSeesA.join('; ') : 'its own screen shows its look');
    // screenshots: each player's own view, the two facing each other, the other one shooting
    const bTurned = await turnTo(B, aId), aTurned = await turnTo(A, bId);
    await fire(A, 1500, () => shot(B.page, 'joiner-sees-host'));
    await fire(B, 1500, () => shot(A.page, 'host-sees-joiner'));
    await fire(A, 1500, () => shot(A.page, 'host-own-view'));
    if (!bTurned || !aTurned) warnings.push(`loadouts: the other player was not on screen for a screenshot (joiner→host ${bTurned}, host→joiner ${aTurned}); the material check still ran`);
    // a thrown shot that needs a ball in hand: the host picks one up and throws it at the joiner, whose copy must draw
    // the ball in the host's colour (the proof run; verify checks the colour each copy resolves for the shooter)
    if (throwBall && SHOT && !stream) {
      const thrown = await grabAndThrow(A, bId, B);
      const ballSeen = thrown ? await until(async () => { const e = entryOf(await looks(B), aId); return e?.shots?.ball ? e : null; }, 4000, 'the ball on the joiner').catch(() => null) : null;
      if (thrown) step('the joiner draws the host\'s thrown ball in the host\'s colour', ballSeen?.shots?.ball === T.A.values[SHOT], `ball ${ballSeen?.shots?.ball ?? 'not drawn'} (want ${T.A.values[SHOT]})`);
      else warnings.push(`loadouts: the host could not pick up something to throw (${record.throwWhy ?? '?'}); the ball colour was not seen in flight`);
    }

    // ---- a change mid-round, from the page hosting the game (postMessage), reaches the other copy ----
    await A.page.evaluate(() => { window.__gfApplied = []; addEventListener('message', e => { if (e.data?.type === 'gf:loadout-applied') window.__gfApplied.push(e.data); }); });
    await A.page.evaluate(l => document.getElementById('game').contentWindow.postMessage({ type: 'gf:loadout', loadout: l }, '*'), T.A2);
    const applied = await until(async () => (await A.page.evaluate(() => window.__gfApplied?.[0] ?? null)), 5000, 'the game to answer gf:loadout-applied').catch(() => null);
    step('the game answers the page', !!applied?.key, applied ? `gf:loadout-applied key ${applied.key}, ${applied.dropped.length} dropped` : 'no gf:loadout-applied');
    await fire(A, 1400);
    const changed = await seesLook(B, aId, T.A2, 8000, { streamed: true });
    step('a change mid-round shows on the other copy', !changed.length, changed.length ? changed.join('; ') : `the joiner now draws the host with body ${T.A2.values[TINT] ?? '-'}, shots ${SHOT ? T.A2.values[SHOT] : '-'}`);
    if (await turnTo(B, aId)) { await turnTo(A, bId); await fire(A, 1300, () => shot(B.page, 'joiner-sees-host-after-change')); }

    // ---- a late copy: the joiner reloads mid-round and must get the host's look from the host's pose ----
    await B.page.reload({ waitUntil: 'load' });
    const back = await until(async () => { const n = await net(B); return n?.started && n.peers?.some(p => p.id === aId && p.x != null); }, 90000, 'the joiner to drop back in').then(() => true).catch(() => false);
    if (!back || !(await focus(B))) {
      // the reloaded joiner is not in a running round: say where its page is instead of reading a frame that is not there
      step('a late copy (reloaded) gets the host\'s look', false, `the reloaded joiner did not drop back into the round within 90 s: ${await whereIs(B)}; the host: ${await whereIs(A)}`);
    } else {
      const late = await seesLook(B, aId, T.A2, 15000);
      const lateBack = await seesLook(A, bId, T.B, 15000);
      step('a late copy (reloaded) gets the host\'s look', !late.length, late.length ? late.join('; ') : 'the reloaded joiner draws the host in the changed look');
      step('the reloaded player\'s look reaches the host again', !lateBack.length, lateBack.length ? lateBack.join('; ') : 'the host draws the joiner in their look');
      if (await turnTo(B, aId)) { await turnTo(A, bId); await fire(A, 1300, () => shot(B.page, 'joiner-after-reload-sees-host')); }
    }

    // ---- a third player who joins during the round plays the next one and sees the host's look ----
    if (third) {
      const C = await player('C', null);
      await C.page.goto(invite, { waitUntil: 'load' });
      await until(async () => (await snap(C.page))?.phase === 'home', 20000, 'the third player lobby');
      await C.page.fill('#gfp-name', 'Cy'); await C.page.click('#gfp-join');
      await until(async () => (await snap(A.page))?.racers.length === 3, 30000, 'the third player in the room');
      const cs = await snap(C.page);
      record.third = { watching: cs?.racers?.find(r => r.id === cs.you)?.watching ?? null };
      await freeMouse(A); await endRound(A.page);
      await until(async () => (await snap(A.page))?.room === 'results', 20000, 'round 1 to end');
      await sleep(900); await freeMouse(A);
      await A.page.click(await A.page.isVisible('#mp-again') ? '#mp-again' : '#start');
      await until(async () => (await net(A))?.started && (await net(B))?.started && (await net(C))?.started && (await snap(A.page))?.round === 2, 90000, 'round 2 with three players');
      const cId = (await net(C)).you;
      await focus(A); await focus(C);
      await fire(A, 1600);
      // round 2 loads a fresh page: A wears its page's loadout again (T.A), B its own
      const cSeesA = await seesLook(C, aId, T.A, 15000, { streamed: true });
      const cSeesB = await seesLook(C, bId, T.B, 8000);
      const aSeesC = await seesLook(A, cId, null, 8000);
      step('a player who joined during the round sees the host\'s look in the next one', !cSeesA.length, cSeesA.length ? cSeesA.join('; ') : `${cs?.racers?.length ?? 3} in the room; the late joiner draws the host in its look`);
      step('the late joiner sees the joiner\'s look too', !cSeesB.length, cSeesB.length ? cSeesB.join('; ') : 'yes');
      step('the late joiner (no loadout) is drawn in the game\'s look', !aSeesC.length, aSeesC.length ? aSeesC.join('; ') : 'the host draws the late joiner in the game\'s own look');
      if (await turnTo(C, aId)) { await turnTo(A, cId); await fire(A, 1500, () => shot(C.page, 'late-joiner-sees-host')); }
      await C.ctx.close();
    }
    if (noTint.size) warnings.push('loadouts: the game\'s body has no tint material (tint_* or gf_body.gfTint), so a player\'s own body colour cannot show on it');
    const kitErrors = record.errors.filter(e => /gf-three|loadout/i.test(e));
    step('no loadout errors', !kitErrors.length, kitErrors.length ? kitErrors.slice(0, 3).join(' | ') : `${record.errors.length} console errors in all, none from the kit's looks`);
    await A.ctx.close(); await B.ctx.close();
    ok = steps.every(s => s.ok);
  } catch (e) {
    step('run', false, e.message);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  if (outDir) await writeFile(join(outDir, 'loadouts.json'), JSON.stringify(record, null, 2) + '\n').catch(() => {});
  const failed = steps.filter(s => !s.ok);
  const detail = ok
    ? `loadouts: each copy draws the other player in their own look (the body colour read from its material${SHOT ? (stream ? ', the stream colour from the arc\'s material' : ', the shot colour each copy resolves for the shooter') : ''}), a change mid-round and a reloaded copy follow${third ? ', and a player who joined late sees it' : ''}`
    : `loadouts failed: ${failed.slice(0, 3).map(s => `${s.name}: ${s.detail}`).join(' | ')}`;
  return { ok, detail, record, warnings };
}
