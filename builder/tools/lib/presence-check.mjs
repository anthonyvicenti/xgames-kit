// The presence leg of verify measure 5 (gate E, shared truth): when the players are not characters (a board played
// from the seats, own boards side by side, a game whose own code holds them), each player must still see the other:
// their presence on their own screen, and their moves live (builder/multiplayer/STANDARD.md, "Seeing a friend with no
// character"; the creator, 2026-10-14: "You can fix seeing your friend default").
//
// What the game should show comes from its locked spec and its parts (gf/mp/presence.js shapeOf: a part that holds
// every player's body), never from its own config, so a game whose settings say its players are characters while a part
// holds them still has to show them. Two players over real WebRTC, real mouse:
//   - each screen reports the other's presence (window.__game.snapshot().net.presence) in the expected shape
//   - seats: the other's seat card is on screen with their name and colour; boards: their board's panel is
//   - each player makes moves by clicking where their own screen says they may (controls().points); each move shows on
//     the other's screen within MOVE_SECONDS: seats, the move counted and its ring drawn where it landed; boards, the
//     other's board on this screen is the board they have
//   - seats: a player's pointer moves on the other's screen to the cell they point at
// A game that lists no points is played with random input instead, and only what it moved is compared.
//
//   const r = await checkPresence({ dir, outDir, log, shots });   → { ok, detail, record, warnings, ran }
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startParty } from '../../multiplayer/party/lib.mjs';
import { inFrame, snap, sleep, until } from '../../multiplayer/party/gate-lib.mjs';
import { launchChrome, GPU_TROUBLE } from '../../qa/browser.mjs';
import { fuzz } from '../../asset-manifest/play-driver.mjs';
import { launchForGame } from './paths.mjs';
import { shapeOfSpec, SEES } from './presence.mjs';

export const MOVE_SECONDS = 3;
const MOVES_EACH = 2;

/** The shape this game must show, from its spec and parts: → {shape, held, sees} ('character' or null: nothing to check). */
export async function expectedShape(dir) {
  const file = join(dir, 'spec.json');
  const spec = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
  return shapeOfSpec(spec);
}

export async function checkPresence({ dir, outDir = null, log = () => {}, shots = [], seconds = 300 } = {}) {
  const want = await expectedShape(dir);
  const record = { expected: want.shape, held: want.held, steps: [], shots: [], errors: [], moves: [] };
  const warnings = [];
  if (!want.shape || want.shape === 'character') return { ok: true, ran: false, detail: 'the players are characters: the position legs see them', record, warnings };
  const steps = record.steps;
  const step = (name, ok, detail) => { steps.push({ name, ok: !!ok, detail }); log(`${ok ? 'pass' : 'FAIL'} presence ${name}: ${detail}`); return !!ok; };

  const srv = await startParty({ dir, port: 0 });
  const { browser, note: gpuNote } = await launchForGame(launchChrome, dir);
  if (gpuNote) warnings.push(`presence: ${gpuNote}`);
  const shot = async (page, name) => {
    if (!outDir) return null;
    const f = `presence-${String(record.shots.length + 1).padStart(2, '0')}-${name}.jpg`;
    record.shots.push(f); shots.push(f);
    await page.screenshot({ path: join(outDir, f), type: 'jpeg', quality: 80 }).catch(() => {});
    return f;
  };
  const player = async label => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(() => { window.__GF_ASSET_OVERRIDES = { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] }; });
    const page = await ctx.newPage();
    page.on('pageerror', e => record.errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !GPU_TROUBLE.test(m.text())) record.errors.push(`${label}: ${m.text().slice(0, 240)}`); });
    return { label, ctx, page };
  };
  const frameOf = P => P.page.frames().find(f => f.parentFrame() === P.page.mainFrame());
  const net = async P => frameOf(P)?.evaluate(() => window.__game?.snapshot()?.net ?? null).catch(() => null) ?? null;
  const pres = async P => (await net(P))?.presence ?? null;
  const points = async P => frameOf(P)?.evaluate(() => window.__game?.controls?.()?.points ?? []).catch(() => []) ?? [];
  const box = P => P.page.locator('#game').boundingBox({ timeout: 2000 }).catch(() => null);
  const entry = (pr, id) => pr?.seats?.find(s => s.id === id) ?? null;
  const own = pr => pr?.seats?.find(s => s.local) ?? null;
  const who = { A: 'the host', B: 'the joiner' };

  let ok = true;
  try {
    const A = await player('host'), B = await player('joiner');
    await A.page.goto(`${srv.partyUrl}?max=${seconds}&gq=${encodeURIComponent('bots=0')}`, { waitUntil: 'load' });
    await until(async () => (await snap(A.page))?.phase === 'home', 20000, 'the lobby');
    await A.page.fill('#gfp-name', 'Ana'); await A.page.click('#gfp-host');
    await until(async () => { const s = await snap(A.page); return s?.phase === 'room' && s.code && s.host ? s : null; }, 20000, 'the host to open a room');
    await B.page.goto(await A.page.inputValue('#mp-invite'), { waitUntil: 'load' });
    await until(async () => (await snap(B.page))?.phase === 'home', 20000, 'the joiner lobby');
    await B.page.fill('#gfp-name', 'Ben'); await B.page.click('#gfp-join');
    await until(async () => (await snap(A.page))?.racers.length === 2 && (await snap(B.page))?.racers.length === 2, 30000, 'both players in the room');
    await A.page.click('#mp-start');
    await until(async () => (await net(A))?.started && (await net(B))?.started, 90000, 'both games to start');
    const ids = { A: (await net(A)).you, B: (await net(B)).you };
    const names = { A: 'Ana', B: 'Ben' };
    record.ids = ids;
    await sleep(1500);

    // ---- each screen shows the other's presence, in the shape the game must have ----
    const P = { A, B };
    for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
      const pr = await until(async () => { const x = await pres(P[me]); return x && entry(x, ids[other]) ? x : null; }, 10000, 'presence').catch(() => null);
      if (!step(`${who[me]} shows ${who[other]}`, !!pr, pr ? `${pr.shape}: ${who[other]} is listed` : `the players are not characters here (${want.held.join(', ') || 'the spec says so'}), so ${SEES[want.shape]}; ${who[me]}'s screen shows no presence for ${who[other]} at all (window.__game.snapshot().net.presence ${pr === null ? 'is missing' : 'lists nobody'})`)) { ok = false; continue; }
      if (!step(`${who[me]} shows the ${want.shape} shape`, pr.shape === want.shape, `this screen shows ${pr.shape}; the game must show ${want.shape} (${SEES[want.shape]})`)) ok = false;
      const e = entry(pr, ids[other]);
      if (want.shape === 'seats') {
        if (!step(`${who[me]} sees ${who[other]}'s seat card`, e.card?.visible && e.name === names[other] && e.avatar, e.card?.visible ? `"${e.name}" in ${e.color}, avatar ${e.avatar ? 'drawn' : 'missing'}, mood ${e.mood}, at ${e.card.x},${e.card.y}` : `${who[other]}'s seat card is not on ${who[me]}'s screen`)) ok = false;
      } else if (!step(`${who[me]} sees ${who[other]}'s board`, e.board?.panel?.visible, e.board?.panel?.visible ? `"${e.name}"'s ${e.board.cols}×${e.board.rows} board in ${e.color}, at ${e.board.panel.x},${e.board.panel.y}` : `${who[other]}'s own board is not on ${who[me]}'s screen${e.board ? ' (known, not drawn)' : ' (never arrived)'}`)) ok = false;
    }

    // ---- moves, each made with the mouse on its player's own screen, land live on the other's ----
    const made = { A: 0, B: 0 }, seenOn = { A: 0, B: 0 }, lags = [], pointerSeen = { A: null, B: null };
    const t0 = Date.now();
    let fuzzed = false;
    while ((made.A < MOVES_EACH || made.B < MOVES_EACH) && Date.now() - t0 < 90000) {
      let acted = false;
      for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
        if (made[me] >= MOVES_EACH) continue;
        const pts = await points(P[me]); if (!pts.length) continue;
        const b = await box(P[me]); if (!b) continue;
        const pt = pts[Math.floor(pts.length / 2)], x = b.x + pt.x, y = b.y + pt.y;
        const before = own(await pres(P[me]));
        // the pointer first: hover over the cell, then the other screen must show it there
        await P[me].page.mouse.move(x, y, { steps: 6 }); await sleep(450);
        const mine = own(await pres(P[me]))?.pointer?.cell ?? (await pres(P[me]))?.me?.pointer ?? null;
        if (mine && pointerSeen[me] === null) {
          const seen = await until(async () => { const e = entry(await pres(P[other]), ids[me]); return e?.pointer && e.pointer.cell?.[0] === mine[0] && e.pointer.cell?.[1] === mine[1] && (want.shape === 'boards' ? e.board?.panel?.visible : e.pointer.onScreen) ? e : null; }, 2500, 'the pointer').catch(() => null);
          pointerSeen[me] = !!seen;
          record.moves.push({ pointer: me, cell: mine, seen: !!seen });
        }
        await P[me].page.mouse.click(x, y);
        const after = await until(async () => { const o = own(await pres(P[me])); return o && o.moves > (before?.moves ?? 0) ? o : null; }, 2500, 'the move').catch(() => null);
        if (!after) continue;
        made[me]++; acted = true;
        const t1 = Date.now();
        const landed = await until(async () => {
          const e = entry(await pres(P[other]), ids[me]);
          if (!e || e.moves < after.moves) return null;
          if (want.shape === 'boards') return e.board?.g === after.board?.g && e.board?.panel?.visible ? e : null;
          return e.lastMove?.shown && e.card?.visible ? e : null;
        }, MOVE_SECONDS * 1000, 'the move on the other screen').catch(() => null);
        if (landed) { seenOn[other]++; lags.push(Date.now() - t1); }
        record.moves.push({ by: me, n: after.moves, cell: after.lastMove?.cell ?? null, seenOnOther: !!landed, ms: Date.now() - t1 });
        if (made.A + made.B === 2) { await shot(A.page, 'host-sees-joiner'); await shot(B.page, 'joiner-sees-host'); }
      }
      if (!acted) {
        if (Date.now() - t0 > 20000 && !made.A && !made.B && !fuzzed) {
          // a game that names nothing to click: random input on both, then compare what each made
          fuzzed = true;
          for (const [n, Q] of [A, B].entries()) { const b = await box(Q); if (b) await fuzz(inFrame(Q.page, frameOf(Q), { width: Math.round(b.width), height: Math.round(b.height) }), { seconds: 6, seed: 7 + n, buttons: false, restart: async () => {} }).catch(() => {}); }
          break;
        }
        await sleep(400);
      }
      if ((await snap(A.page))?.room === 'results') break;
    }
    if (fuzzed) {
      for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
        const mine = own(await pres(P[me]));
        const e = await until(async () => { const x = entry(await pres(P[other]), ids[me]); return x && mine && x.moves >= mine.moves ? x : null; }, MOVE_SECONDS * 1000, 'moves').catch(() => null);
        if (!step(`${who[me]}'s moves show on ${who[other]}'s screen`, mine?.moves > 0 && !!e, `random input: ${who[me]} made ${mine?.moves ?? 0} moves; ${who[other]}'s screen shows ${e?.moves ?? 'none of them'}`)) ok = false;
      }
    } else {
      for (const [me, other] of [['A', 'B'], ['B', 'A']]) {
        if (!step(`${who[me]}'s moves land on ${who[other]}'s screen`, made[me] > 0 && seenOn[other] === made[me], made[me] ? `${seenOn[other]} of ${made[me]} moves ${who[me]} made with the mouse showed on ${who[other]}'s screen within ${MOVE_SECONDS} s (${want.shape === 'boards' ? 'their board, as they have it' : 'counted on their seat card, a ring where it landed'})` : `${who[me]} could make no move with the mouse in 90 s (controls().points named none)`)) ok = false;
        if (want.shape === 'seats' || pointerSeen[me] !== null) if (!step(`${who[me]}'s pointer shows on ${who[other]}'s screen`, pointerSeen[me] === true, pointerSeen[me] === null ? `${who[me]}'s screen reported no pointer of its own` : pointerSeen[me] ? 'the other screen showed it at the cell pointed at' : `${who[other]}'s screen never showed ${who[me]}'s pointer at the cell they pointed at`)) ok = false;
      }
      record.lagMs = lags.length ? Math.max(...lags) : null;
    }
    if (!record.shots.length) { await shot(A.page, 'host-sees-joiner'); await shot(B.page, 'joiner-sees-host'); }
    const pageErrors = record.errors.filter(e => /pageerror|presence/i.test(e));
    if (pageErrors.length) warnings.push(`presence: ${pageErrors.slice(0, 2).join(' | ')}`);
    await A.ctx.close(); await B.ctx.close();
  } catch (e) {
    ok = false; step('the two-player presence leg', false, `stopped: ${e.message}`);
  } finally {
    await browser.close().catch(() => {});
    await srv.close().catch(() => {});
  }
  const failed = steps.filter(s => !s.ok);
  const detail = ok
    ? `no player is a character (${want.held.join(', ') || 'the spec says so'}): ${want.shape} shown on both screens; ${steps.filter(s => /land on|show on/.test(s.name)).map(s => s.detail).join('; ')}`
    : `no player is a character here (${want.held.join(', ') || 'the spec says so'}), so ${SEES[want.shape]}: ${failed.slice(0, 3).map(s => `${s.name}: ${s.detail}`).join('; ')}`;
  return { ok, ran: true, detail, record, warnings };
}
