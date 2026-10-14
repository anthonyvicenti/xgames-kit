// verify check 13 (controls work) for a forge game (CONTRACT §8 forge). Every control the HUD's line lists
// (config/game.json → controls: jump, interact, primary, secondary) must do something the player sees on their own
// screen. Kept apart from tools/verify-forge.mjs, which calls checkForgeControls.
//
// Why forge has its own (track S2, 2026-10-10; gf-three/regressions/forge-dead-controls): the shared check
// (tools/lib/controls-check.mjs) passed the wave 1b Forge Room, whose HUD printed "right click / Q: nothing yet" and
// "E: nothing yet". It asks whether "some game state changed" after a key, and in a wave fight the state always changes
// (enemies walk, the director counts seconds); with no kit crosshair it asks for 1% of the middle of the screen to
// change, which a walking skeleton does. Nothing in it could find a dead control on forge.
//
// What this one does: one page on a staged, quiet moment (?gf-demo=controls: gf/forge/ai.js runs no waves under any
// ?gf-demo, so nothing moves but the fires), bots off, real keys and a real mouse.
//   noise      with no key down, the page's own state is read IDLE_READS times and the screen IDLE_FRAMES times: every
//              state value that changes by itself (a clock, a fire's flicker) and every pixel that does is left out of
//              what follows, and the share of pixels still changing between quiet frames is the screen's noise floor
//   jump       Space → the player rises JUMP_RISE m (as on gf-three)
//   primary,   the button held HOLD_MS → (1) the game's state answers: a value of the feel view (shots, ammunition, a
//   secondary  swing, a charge, the field of view), of what the renderer drew (muzzle flashes, swings), of the shared
//              state, the scores or the rules' own observation changes that did not change by itself; and (2) the
//              player sees it: SEEN_MIN of the screen's pixels or three times the noise floor, whichever is more, change
//   interact   E tapped, then held HOLD_MS → the game's state answers (as above); the kit's forge boot exposes nothing
//              to walk to yet (controls().interactables is empty), so E is pressed where the player stands
//   interact   a control that is for a fallen friend (down and revive, wave 2) has nothing to do alone. When E answered
//   among      nothing above and the game's players can be revived (players.max over 1, forge.player.revive.time), it is
//   friends    held again on the kit's staged moment (?gf-demo=controls.revive&bots=1: gf/forge/cards.js lays the other
//              player down beside this one): the revive must run (the friend stands up, or its progress passes
//              REVIVE_MIN). Found by the wave 2 merge: Bone Vigil's "hold to raise a fallen friend" read DEAD
// A control that answers nothing is DEAD, and the detail says what to do: give it something to do, or take it out of
// spec.controls, because the HUD prints every control listed there. Budget: about 12 s.
import { POINTER_LOCK } from './forge-feel-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 100) / 100;
export const FORGE_CONTROL_LIMITS = { JUMP_RISE: 0.25, HOLD_MS: 1400, IDLE_READS: 12, IDLE_FRAMES: 8, PIXEL_T: 60, SEEN_MIN: 0.003, NOISE_TIMES: 3, REVIVE_MIN: 0.25, REVIVE_STAGE_MS: 12000 };
const ACTIONS = ['jump', 'interact', 'primary', 'secondary'];
const KEYS = { primary: 'click / F', secondary: 'right click / Q', interact: 'E', jump: 'Space' };

/** In the page: everything a control could change, as one object (the feel view, what was drawn, the shared state, the
 *  scores, the rules' own observation, the HUD's words). */
const STATE = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), f = g.forge?.feel?.() ?? null, d = g.forge?.drawn?.() ?? null, me = s.players.find(p => p.local);
  let c = null, h = null; try { c = g.controls?.() ?? null; } catch {} try { h = g.hud?.() ?? null; } catch {}
  return {
    phase: s.phase, y: me?.y ?? null,
    sig: {
      view: f?.shown?.view ?? null,
      shown: f?.shown ? { numbers: f.shown.numbers.length, hitMarker: f.shown.hitMarker, ammo: f.shown.ammo?.text ?? null, weapon: f.shown.ammo?.name ?? null, combo: f.shown.combo?.text ?? null } : null,
      shots: f?.stats?.shots ?? null,
      drawn: d ? { muzzleFlashes: d.muzzleFlashes, hitFlashes: d.hitFlashes, swings: d.swings, rigid: d.rigid, fpMuzzle: d.fpMuzzle, fpSwing: d.fpSwing } : null,
      shared: s.shared ?? null, rules: s.rules ?? null, scores: s.players.map(p => p.score), alive: me?.alive ?? null,
      prompt: c?.prompt ?? '', interactables: c?.interactables?.length ?? 0, meters: h?.meters ?? null, entities: g.forge?.entities?.().length ?? null,
    },
  };
};

/** Can a player of this game be brought back by a friend? (pure) */
export function reviveApplies(game) { return (game?.players?.max ?? 1) > 1 && Number(game?.forge?.player?.revive?.time) > 0; }

/** In the page: who is down and how far each revive is (the run's facts, window.__game.forge.run()). */
const RUN = () => {
  const g = window.__game; let r = null; try { r = g?.forge?.run?.() ?? null; } catch {}
  return { phase: g?.phase ?? null, players: (r?.players ?? []).map(p => ({ id: p.player, local: !!p.local, down: !!p.down, revive: Math.round((p.revive ?? 0) * 100) / 100, alive: p.alive !== false })) };
};

/** The verdict on interact among friends (pure). m: {staged, idle (the friend's revive with no key down), best (with E held), up (they stood up), seconds} */
export function judgeRevive(m, L = FORGE_CONTROL_LIMITS) {
  if (!m.staged) return { ok: false, why: 'no fallen friend could be staged (the game made no second player, or it never went down)' };
  if (m.up) return { ok: true, why: `E held beside a fallen friend brought them back up in ${m.seconds} s (staged: a bot laid down beside the player)` };
  if (m.best - m.idle >= L.REVIVE_MIN) return { ok: true, why: `E held beside a fallen friend ran the revive to ${Math.round(m.best * 100)}% (staged: a bot laid down beside the player)` };
  return { ok: false, why: `E held ${m.seconds} s beside a fallen friend did nothing: the revive stood at ${Math.round(m.best * 100)}%` };
}

/** Interact among friends: E held beside a fallen friend on the kit's staged moment. → {ok, why, record, warnings} */
async function reviveLeg({ newPage, url, game, shot, L }) {
  const hold = (Number(game.forge.player.revive.time) || 2) * 1000 + 1200, warnings = [];
  const T = await newPage('controls revive', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 180 }] } });
  const p = T.page, m = { staged: false, idle: 0, best: 0, up: false, seconds: 0 };
  await p.addInitScript(POINTER_LOCK);
  let why = null;
  try {
    await p.goto(`${url}?seed=7&bots=1&gf-demo=controls.revive`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    let friend = null;
    for (let t = Date.now(); Date.now() - t < L.REVIVE_STAGE_MS && !friend; ) { await sleep(150); friend = (await p.evaluate(RUN).catch(() => null))?.players.find(x => !x.local && x.down) ?? null; }
    if (friend) {
      m.staged = true;
      await sleep(900);                                             // the player is put beside them
      const of = async () => (await p.evaluate(RUN).catch(() => null))?.players.find(x => x.id === friend.id) ?? null;
      for (let i = 0; i < 6; i++) { await sleep(100); m.idle = Math.max(m.idle, (await of())?.revive ?? 0); }
      const t1 = Date.now();
      await p.keyboard.down('KeyE');
      while (Date.now() - t1 < hold) { await sleep(100); const f = await of(); if (!f) continue; m.best = Math.max(m.best, f.revive); if (!f.down && f.alive) { m.up = true; break; } if (m.best > 0.4 && !m.shot) m.shot = await shot(p, 'controls-interact-reviving'); }
      await p.keyboard.up('KeyE');
      m.seconds = r2((Date.now() - t1) / 1000);
    }
  } catch (e) { why = `the revive page stopped: ${e.message}`; }
  finally {
    const errors = T.errors.slice();
    await T.ctx.close().catch(() => {});
    if (errors.length) warnings.push(`controls revive page console errors: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
  }
  const j = why ? { ok: false, why } : judgeRevive(m, L);
  return { ok: j.ok, why: j.why, warnings, record: { url: '?seed=7&bots=1&gf-demo=controls.revive', ...m } };
}

/** {a: {b: 1, c: [2]}} → Map('a.b' → '1', 'a.c.0' → '2'). */
export function flat(o, path = '', out = new Map()) {
  if (o === null || typeof o !== 'object') { out.set(path, JSON.stringify(o ?? null)); return out; }
  const keys = Object.keys(o);
  if (!keys.length) out.set(path, Array.isArray(o) ? '[]' : '{}');
  for (const k of keys) flat(o[k], path ? `${path}.${k}` : k, out);
  return out;
}
/** The paths whose value differs between two flattened states (a path only one has counts). */
export function changed(a, b) {
  const out = [];
  for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) out.push(k);
  return out;
}

/** Pixel shares in a browser page: `quiet` frames give the pixels that change by themselves (left out) and, from their
 *  second half, the noise floor; `held` frames give the most that changed beyond those. Full frames, compared at half size. */
async function pixels(browser, quiet, held, T) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ([Q, H, T]) => {
      const load = async s => { const im = new Image(); im.src = 'data:image/png;base64,' + s; await im.decode(); const w = im.width >> 1, h = im.height >> 1; const c = new OffscreenCanvas(w, h); const g = c.getContext('2d'); g.drawImage(im, 0, 0, w, h); return { w, h, d: g.getImageData(0, 0, w, h).data }; };
      const qs = []; for (const s of Q) qs.push(await load(s));
      const half = Math.max(1, qs.length >> 1), base = qs[half - 1], n = base.w * base.h;
      const diff = (a, b, i) => Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      const mask = new Uint8Array(n);
      for (const q of qs.slice(0, half - 1)) for (let k = 0; k < n; k++) if (diff(q.d, base.d, k * 4) > T) mask[k] = 1;
      const share = f => { let c = 0; for (let k = 0; k < n; k++) if (!mask[k] && diff(f.d, base.d, k * 4) > T) c++; return c / n; };
      let floor = 0; for (const q of qs.slice(half)) floor = Math.max(floor, share(q));
      const frames = []; for (const s of H) frames.push(share(await load(s)));
      let masked = 0; for (let k = 0; k < n; k++) masked += mask[k];
      return { floor, frames, masked: masked / n };
    }, [quiet.map(b => b.toString('base64')), held.map(b => b.toString('base64')), T]);
  } finally { await page.close(); }
}

/** The verdict on one held or pressed control (pure). m: {action, words, effects: [paths], seen, floor, needSeen} */
export function judgeForgeControl(m, L = FORGE_CONTROL_LIMITS) {
  const keys = KEYS[m.action] ?? m.action, fails = [];
  const need = Math.max(L.SEEN_MIN, (m.floor ?? 0) * L.NOISE_TIMES);
  if (!m.effects.length) fails.push(`${keys} changed nothing in the game: no shot, swing, charge or reload in the feel view, nothing new drawn, no shared state, score or rule value moved`);
  if (m.needSeen && m.effects.length && !(m.seen >= need)) fails.push(`${keys} changed the game's state (${m.effects.slice(0, 3).join(', ')}) but nothing on the player's screen: ${r2(m.seen * 100)}% of the pixels changed (needs ${r2(need * 100)}%; the quiet screen's own noise is ${r2((m.floor ?? 0) * 100)}%)`);
  const ok = fails.length === 0;
  const what = m.effects.slice(0, 4).join(', ') + (m.effects.length > 4 ? ` and ${m.effects.length - 4} more` : '');
  return { ok, why: ok ? `${m.held ? `held ${L.HOLD_MS / 1000} s` : 'pressed'}: the game answered (${what})${m.needSeen ? ` and ${r2(m.seen * 100)}% of the screen changed (quiet noise ${r2((m.floor ?? 0) * 100)}%)` : ''}` : fails.join('; ') };
}

/** Check 13 on forge. newPage(label, {overrides}) → {ctx, page, errors} (verify's own); url: the served game; game:
 *  config/game.json; browser: for the pixel analysis. → {ok, detail, record, warnings} */
export async function checkForgeControls({ newPage, browser, url, game, shot = async () => null, log = () => {} }) {
  const L = FORGE_CONTROL_LIMITS, t0 = Date.now();
  const listed = Object.keys(game.controls ?? {}).filter(k => ACTIONS.includes(k) && String(game.controls[k] ?? '').trim()).sort((a, b) => ACTIONS.indexOf(a) - ACTIONS.indexOf(b));
  const others = Object.keys(game.controls ?? {}).filter(k => !ACTIONS.includes(k));
  const results = [], warnings = [];
  if (others.length) warnings.push(`controls lists ${others.join(', ')}: not kit actions (the HUD line shows only primary, secondary, interact and jump); not tested`);
  if (!listed.length) return { ok: true, detail: 'config/game.json lists no controls (WASD and mouse look only); nothing to test', record: { listed, results, seconds: 0 }, warnings };
  const T = await newPage('controls', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 180 }] } });
  const p = T.page;
  await p.addInitScript(POINTER_LOCK);
  const state = () => p.evaluate(STATE);
  const png = () => p.screenshot({ type: 'png' });
  const record = { url: '?seed=7&bots=0&gf-demo=controls', listed, limits: L, noise: null };
  try {
    await p.goto(`${url}?seed=7&bots=0&gf-demo=controls`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    await p.click('#gf-play');
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('the round did not start'); await sleep(120); }
    await sleep(2400);                                              // the "Go!" banner and fair play's opening grace
    const vp = p.viewportSize() ?? { width: 1280, height: 720 };
    await p.mouse.move(vp.width / 2, vp.height / 2); await p.mouse.click(vp.width / 2, vp.height / 2); await sleep(900);   // takes the mouse, as a player does (a click is a shot: let it pass)

    // ---- what changes by itself: state values and pixels, with no key down ----
    const noisy = new Set();
    let prev = flat((await state()).sig);
    for (let i = 0; i < L.IDLE_READS; i++) { await sleep(100); const cur = flat((await state()).sig); for (const k of changed(prev, cur)) noisy.add(k); prev = cur; }
    const quiet = []; for (let i = 0; i < L.IDLE_FRAMES; i++) { quiet.push(await png()); await sleep(90); }
    for (const k of changed(prev, flat((await state()).sig))) noisy.add(k);
    record.noise = { state: [...noisy].slice(0, 12), stateCount: noisy.size };

    /** Hold or press, reading the state as it goes. → {effects, frames} */
    const act = async (down, up, ms, frames) => {
      const before = flat((await state()).sig), eff = new Set(), held = [];
      await down();
      for (const t1 = Date.now(); Date.now() - t1 < ms; ) { if (frames) held.push(await png()); else await sleep(70); for (const k of changed(before, flat((await state()).sig))) if (!noisy.has(k)) eff.add(k); }
      await up();
      for (let i = 0; i < 4; i++) { await sleep(110); for (const k of changed(before, flat((await state()).sig))) if (!noisy.has(k)) eff.add(k); }
      return { effects: [...eff].sort(), held };
    };

    for (const action of listed) {
      const words = game.controls[action];
      if (action === 'jump') {
        const a = await state(); let top = a.y;
        await p.keyboard.down('Space'); await sleep(90); await p.keyboard.up('Space');
        for (let i = 0; i < 8; i++) { await sleep(90); top = Math.max(top, (await state()).y); }
        const rise = r2(top - a.y);
        results.push({ action, words, ok: rise >= L.JUMP_RISE, rise, why: rise >= L.JUMP_RISE ? `rose ${rise} m` : `Space: the player rose ${rise} m (needs ${L.JUMP_RISE}); check spec.forge.player.jump (m/s) and that the rules do not hold the player (controller.enabled)` });
        await sleep(700);
        continue;
      }
      let m;
      if (action === 'interact') {
        const tap = await act(() => p.keyboard.down('KeyE'), () => p.keyboard.up('KeyE'), 120, false);
        const hold = tap.effects.length ? { effects: [] } : await act(() => p.keyboard.down('KeyE'), () => p.keyboard.up('KeyE'), L.HOLD_MS, false);
        m = { action, words, effects: [...new Set([...tap.effects, ...hold.effects])], held: !tap.effects.length, needSeen: false, seen: 0, floor: 0 };
      } else {
        const button = action === 'primary' ? 'left' : 'right';
        const a = await act(() => p.mouse.down({ button }), () => p.mouse.up({ button }), L.HOLD_MS, true);
        const px = await pixels(browser, quiet, a.held, L.PIXEL_T);
        m = { action, words, effects: a.effects, held: true, needSeen: true, seen: Math.max(0, ...px.frames), floor: px.floor, frames: a.held.length, masked: r2(px.masked * 100) };
        if (a.held.length) await shot(p, `controls-${action}-held`, a.held[Math.min(a.held.length - 1, 2)]);
      }
      const j = judgeForgeControl(m, L);
      results.push({ action, words, ok: j.ok, why: j.why, effects: m.effects.slice(0, 12), seen: r2((m.seen ?? 0) * 100), noise: r2((m.floor ?? 0) * 100), frames: m.frames ?? 0 });
      await sleep(500);
    }
  } catch (e) {
    results.push({ action: 'run', ok: false, why: `the controls page stopped: ${e.message}` });
  } finally {
    const errors = T.errors.slice();
    await T.ctx.close().catch(() => {});
    if (errors.length) warnings.push(`controls page console errors: ${[...new Set(errors)].slice(0, 2).join(' | ')}`);
  }
  // interact among friends: what is for a fallen friend is held again beside one
  const lone = results.find(r => r.action === 'interact' && !r.ok);
  if (lone && reviveApplies(game)) {
    const rv = await reviveLeg({ newPage, url, game, shot, L });
    record.revive = rv.record; warnings.push(...rv.warnings);
    if (rv.ok) { lone.ok = true; lone.why = `alone it has nothing to do; ${rv.why}`; lone.staged = 'a fallen friend'; }
    else lone.why += `; among friends: ${rv.why}`;
  }
  const ok = results.length > 0 && results.every(r => r.ok);
  const line = r => `${r.action}${r.words ? ` ("${r.words}")` : ''}: ${r.ok ? 'ok' : 'DEAD'}, ${r.why}`;
  const detail = ok ? results.map(line).join('; ')
    : `${results.filter(r => !r.ok).map(line).join('; ')}. The HUD lists ${listed.map(a => `${KEYS[a]}: "${game.controls[a]}"`).join(', ')}; every listed control must do something the player sees on their own screen. ` +
      'On forge the buttons are the core\'s: primary fires the weapon in hand (spec.forge.weapons; the rules arm players with FEEL_OP.LOADOUT), secondary is its alternate fire, interact is the rules\' own. Give a dead control something to do, or take it out of spec.controls (the HUD prints every control listed there, whatever its words say).' +
      (results.some(r => r.ok) ? ` Working: ${results.filter(r => r.ok).map(r => r.action).join(', ')}.` : '');
  log(`  forge controls: ${ok ? 'ok' : 'FAIL'} ${detail.slice(0, 220)}`);
  return { ok, detail, warnings, record: { ...record, observation: 'forge: the feel view, what was drawn, the shared state, scores, the rules\' observation', results, seconds: Math.round((Date.now() - t0) / 1000) } };
}
