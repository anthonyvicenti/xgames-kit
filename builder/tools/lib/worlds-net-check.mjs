// verify, worlds (CONTRACT §9): the checks that need the world server (builder/world-server/serve.mjs startWorldServer)
// and, for the room, gf-multiplayer 1.5.0's world mode. Real input in real Chrome; the server's own API read back.
//
//   checkWorldPersist({browser, server, log, shot})   26 the world persists: entered through its card and built with
//        real input (blocks, paint, a sign), saved by the host's copy within seconds, and a fresh browser (a new page,
//        no state) loads it the same; the game's bare page, alone, saves nothing (it offers the world through its card
//        first; play-test 2026-10-09: the bare page changed the shared world unseen)
//   checkSpawnHolds({browser, server, log})            28 the spawn square holds: a click there is refused on the
//        player's own screen (nothing changes), and the play host refuses an edit there sent straight to it
//   checkSignFilter({browser, server, log})            29 a sign's words are filtered: a slur and a curse are masked on
//        the screen of the one who wrote them (in the world, entered through its card), in the world everyone loads,
//        and by the play host itself
import { findBuildSpot, faces, actOn, aimMode } from './worlds-check.mjs';
import { player } from './worlds-room-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, ms, what) { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(150); } }
const G = (p, fn, ...a) => p.evaluate(fn, ...a);

async function openGame(browser, url, label, errors) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${label}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${label}: ${m.text().slice(0, 240)}`); });
  await p.goto(url, { waitUntil: 'load' });
  await until(() => G(p, () => window.__game?.ready === true), 90000, `${label} to boot`);
  return { ctx, p };
}
async function enter(p) {
  await p.click('#gf-play');
  await until(() => G(p, () => window.__game.phase === 'playing'), 15000, 'play');
  await sleep(700);
}
const cellsAt = (p, s) => G(p, s => [0, 1, 2].map(d => window.__game.voxelAt(s.x, s.top + d, s.z)), s);
const done = (steps, okLine) => { const fail = steps.filter(s => !s.ok); return { ok: !fail.length, detail: fail.length ? fail.map(s => `${s.name}: ${s.detail}`).join('; ') : okLine(steps), record: { steps } }; };
const stepper = (steps, log) => (name, ok, detail = '') => { steps.push({ name, ok: !!ok, detail }); log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); return !!ok; };
const hotIndex = async (p, id) => (await G(p, () => window.__game.build().hotbar)).indexOf(id);
/** A player in the world (worlds-room-check player()) as the page these helpers drive: its game frame for reading and
 *  clicking, the page's keyboard and mouse (moved by the frame's offset). */
const asPage = P => ({
  evaluate: (fn, ...a) => P.frame.evaluate(fn, ...a), keyboard: P.page.keyboard, click: sel => P.frame.click(sel),
  mouse: { move: async (x, y, o) => { const b = await P.box(); return P.page.mouse.move(b.x + x, b.y + y, o); }, down: o => P.page.mouse.down(o), up: o => P.page.mouse.up(o) },
});
const pickSlot = async (p, id) => { const i = await hotIndex(p, id); if (i < 0 || i > 9) return false; await p.keyboard.press(`Digit${(i + 1) % 10}`); await sleep(140); return true; };

export async function checkWorldPersist({ browser, server, log = () => {}, shot = null }) {
  const steps = [], step = stepper(steps, log), errors = [];
  let A = null, B = null, S = null;
  try {
    A = await player(browser, server, 'Builder', errors);
    const a = asPage(A);
    const w0 = await G(a, () => window.__game.world().loaded);
    step('the world loads from the play host', w0.mode === 'server' && !w0.error, `mode ${w0.mode}, seq ${w0.seq}${w0.error ? `, ${w0.error}` : ''}`);
    await A.enter();
    const spot = await findBuildSpot(a);
    if (!step('a spot to build on', !!spot, spot ? `${spot.x},${spot.top},${spot.z}` : 'none')) throw new Error('nowhere to build');
    await pickSlot(a, 'brick') || await a.keyboard.press('Digit3');
    const F = faces(spot);
    await actOn(a, F.ground);
    await actOn(a, F.top(1));
    await a.keyboard.press('KeyP'); await sleep(120); await a.keyboard.press('Digit5'); await sleep(120);
    await actOn(a, F.top(2));
    await a.keyboard.press('KeyP'); await sleep(120);
    let signed = false;
    if (await pickSlot(a, 'sign')) {
      await actOn(a, F.top(2));
      signed = await until(() => G(a, () => document.querySelector('#gf-sign-editor')?.classList.contains('on')), 2500, 'the sign editor').catch(() => false);
      if (signed) { await a.keyboard.type('Still here tomorrow'); await a.click('#gf-sign-ok'); await sleep(300); }
    }
    const built = await cellsAt(a, spot), sign = await G(a, s => window.__game.signAt(s.x, s.top + 2, s.z), spot);
    step('built with real input: two blocks, paint, a sign', built[0] && built[1] && (built[1] >> 8) > 0 && (!signed || sign?.text === 'Still here tomorrow'), `cells ${JSON.stringify(built)}, sign ${JSON.stringify(sign)}`);
    if (shot) await shot(A.page, 'world-built');
    // the host's copy saves every couple of seconds
    const saved = await until(async () => { const s = await G(a, () => window.__game.world().store); return s.queued === 0 && s.pushed >= (signed ? 4 : 3) ? s : null; }, 12000, 'the save').catch(() => null);
    const api = await (await fetch(server.apiUrl)).json();
    step('saved on the play host within seconds', !!saved && api.seq >= (signed ? 4 : 3), `pushed ${saved?.pushed ?? '?'}; the play host's seq ${api.seq}`);
    await A.ctx.close(); A = null;
    // a fresh browser, on the world card: the world behind it is loaded from the play host
    B = await player(browser, server, 'Fresh', errors);
    const b = asPage(B);
    const w1 = await G(b, () => window.__game.world().loaded);
    const again = await cellsAt(b, spot), sign2 = await G(b, s => window.__game.signAt(s.x, s.top + 2, s.z), spot);
    step('a fresh browser loads the same world', JSON.stringify(again) === JSON.stringify(built) && JSON.stringify(sign2) === JSON.stringify(sign), `seq ${w1.seq}, cells ${JSON.stringify(again)}, sign ${JSON.stringify(sign2)}`);
    if (shot) { await B.enter(); await shot(B.page, 'world-reloaded'); }
    await B.ctx.close(); B = null;
    // the game's bare page, alone: it offers the world through its card first, and builds there are never saved
    S = await openGame(browser, server.gameUrl, 'bare page', errors);
    const first = await G(S.p, () => { const all = [...document.querySelectorAll('#gf-menu button')].filter(x => x.offsetParent); return { first: all[0]?.id ?? null, label: all[0]?.textContent?.trim() ?? null, practice: document.querySelector('#gf-play')?.textContent?.trim() ?? null }; });
    step('the bare page offers the shared world first', first.first === 'gf-friends', `first button ${first.first} ("${first.label}"); #gf-play "${first.practice}"`);
    const seq0 = (await (await fetch(server.apiUrl)).json()).seq;
    await enter(S.p);
    const sp = await findBuildSpot(S.p);
    if (sp) { await pickSlot(S.p, 'brick') || await S.p.keyboard.press('Digit3'); await actOn(S.p, faces(sp).ground); }
    const placed = sp ? await G(S.p, s => window.__game.voxelAt(s.x, s.top, s.z), sp) : 0;
    await sleep(5000);       // over two of the host's save timers (saveEvery 2 s)
    const st = await G(S.p, () => ({ store: window.__game.world().store, saves: window.__game.build().saves }));
    const seq1 = (await (await fetch(server.apiUrl)).json()).seq;
    step('alone, the bare page saves nothing', placed > 0 && seq1 === seq0 && !st.saves && !(st.store?.pushed > 0), `placed ${placed} at ${sp ? `${sp.x},${sp.top},${sp.z}` : '-'}; the play host's seq ${seq0} → ${seq1}; pushed ${st.store?.pushed ?? 0}, saves ${st.saves}`);
    if (errors.length) step('no console errors', false, [...new Set(errors)].slice(0, 3).join(' | '));
  } catch (e) { step('the persistence run', false, e.message); }
  finally { await A?.ctx.close().catch(() => {}); await B?.ctx.close().catch(() => {}); await S?.ctx.close().catch(() => {}); }
  return done(steps, s => `entered through the card, built with real input, saved by the host within seconds, a fresh browser loaded it the same; the bare page alone saved nothing (${s.length} steps)`);
}

export async function checkSpawnHolds({ browser, server, log = () => {} }) {
  const steps = [], step = stepper(steps, log), errors = [];
  let A = null;
  try {
    A = await openGame(browser, server.gameUrl, 'spawn', errors);
    await enter(A.p);
    // the cell the player stands on is in the spawn square: click the ground right beside them (on screen where the
    // cursor aims; first person turns to it)
    const me = await G(A.p, () => window.__game.snapshot().players.find(x => x.local));
    const any = (await aimMode(A.p)) === 'crosshair';
    const cell = await G(A.p, ([m, any]) => { for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) { const x = Math.floor(m.x) + dx, z = Math.floor(m.z) + dz, top = window.__game.topAt(x, z); if (window.__game.protectedAt(x, top, z)) { const s = window.__game.project(x + 0.5, top, z + 0.5); if (any || s?.front) return { x, z, top }; } } return null; }, [me, any]);
    if (!step('a cell of the spawn square in reach', !!cell, cell ? `${cell.x},${cell.top},${cell.z}` : 'none')) throw new Error('no spawn cell');
    const before = [await G(A.p, c => window.__game.voxelAt(c.x, c.top, c.z), cell), await G(A.p, c => window.__game.voxelAt(c.x, c.top - 1, c.z), cell)];
    const ground = faces(cell).ground;
    await actOn(A.p, ground);
    await actOn(A.p, ground, 'right');
    await sleep(400);
    const after = [await G(A.p, c => window.__game.voxelAt(c.x, c.top, c.z), cell), await G(A.p, c => window.__game.voxelAt(c.x, c.top - 1, c.z), cell)];
    const st = (await G(A.p, () => window.__game.build())).stats;
    step('a click and a right click there change nothing on the player\'s screen', JSON.stringify(before) === JSON.stringify(after) && (st.refusedBy.protected ?? 0) >= 1, `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}, refused ${JSON.stringify(st.refusedBy)}`);
    // the play host itself: an edit inside the square, sent straight to it (as a modified client would)
    const r = await fetch(server.apiUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(server.url).origin }, body: JSON.stringify({ op: 'push', after: 0, edits: [['verify.p1', cell.x, cell.top - 1, cell.z, 0]] }) });
    const b = await r.json().catch(() => ({}));
    step('the play host refuses an edit inside the square', (b.refused ?? []).some(x => x[0] === 'verify.p1' && x[1] === 'protected'), `HTTP ${r.status}: ${JSON.stringify(b.refused ?? b)}`);
    if (errors.length) step('no console errors', false, [...new Set(errors)].slice(0, 3).join(' | '));
  } catch (e) { step('the spawn run', false, e.message); }
  finally { await A?.ctx.close().catch(() => {}); }
  return done(steps, () => 'refused on the player\'s screen and by the play host');
}

export async function checkSignFilter({ browser, server, log = () => {} }) {
  const steps = [], step = stepper(steps, log), errors = [];
  let A = null;
  try {
    A = await player(browser, server, 'Signer', errors);
    const a = asPage(A);
    await A.enter();
    const spot = await findBuildSpot(a);
    if (!step('a spot for a sign', !!spot)) throw new Error('nowhere to build');
    if (!(await pickSlot(a, 'sign'))) { step('the hotbar has a sign', false, 'no sign in the first ten slots'); throw new Error('no sign'); }
    await actOn(a, faces(spot).ground);
    const open = await until(() => G(a, () => document.querySelector('#gf-sign-editor')?.classList.contains('on')), 2500, 'the sign editor').catch(() => false);
    if (!step('the sign editor opens', open)) throw new Error('no editor');
    // a slur (from the filter's own hard list, spaced to dodge it) and a curse
    const words = 'n i g g e r\nfuck off';
    await a.keyboard.type(words); await a.click('#gf-sign-ok'); await sleep(400);
    const s = await G(a, p => window.__game.signAt(p.x, p.top, p.z), spot);
    const masked = t => typeof t === 'string' && !/n\s*i\s*g\s*g/i.test(t) && !/fuck/i.test(t) && t.includes('*');
    step('masked on the writer\'s own screen', masked(s?.text), JSON.stringify(s));
    await until(async () => (await G(a, () => window.__game.world().store)).queued === 0, 8000, 'the save').catch(() => {});
    const api = await until(async () => { const w = await (await fetch(server.apiUrl)).json(); return (w.edits ?? []).some(e => e[2] === spot.x && e[3] === spot.top && e[4] === spot.z) ? w : null; }, 8000, 'the saved sign').catch(async () => (await fetch(server.apiUrl)).json());
    const saved = (api.edits ?? []).filter(e => e[2] === spot.x && e[3] === spot.top && e[4] === spot.z).pop();
    step('masked in the world the play host keeps', saved && masked(saved[6]), JSON.stringify(saved ?? null));
    const r = await fetch(server.apiUrl, { method: 'POST', headers: { 'content-type': 'application/json', origin: new URL(server.url).origin }, body: JSON.stringify({ op: 'push', after: api.seq, edits: [['verify.s1', spot.x + 1, spot.top, spot.z, api.config.signBlock, 'shit', 5]] }) });
    const b = await r.json().catch(() => ({}));
    const ok = (b.ok ?? []).find(x => x[0] === 'verify.s1');
    step('the play host masks words sent straight to it', ok && masked(ok[2] ?? ''), `HTTP ${r.status}: ${JSON.stringify(b.ok ?? b)}`);
    if (errors.length) step('no console errors', false, [...new Set(errors)].slice(0, 3).join(' | '));
  } catch (e) { step('the sign run', false, e.message); }
  finally { await A?.ctx.close().catch(() => {}); }
  return done(steps, () => 'a slur and a curse were masked on the writer\'s screen, in the saved world, and by the play host');
}
