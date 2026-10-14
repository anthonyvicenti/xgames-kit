// verify check 13's mouse leg for a forge game with a pedlar's cart (CONTRACT §8 forge, item 21; 2026-10-12).
// Kept apart from tools/verify-forge.mjs, which calls checkForgeCart beside the keys' half and the phone leg and folds
// the answer into check 13 (controls work).
//
// Why (never again; the creator before Zombie Town v8 went out: "Have we logically reviewed the interface so its makes
// sense from a users perspective and is nice and easy to navigate. V7 had buttons not work, small text, poor placement,
// and confusing mechanics", research/rust-engine/evidence/creator-zombie-town-v8-go-and-review-2026-10-12.json). A
// player's-eye review with a real mouse (gf-forge/evidence/zombie-town-v8-ux-review-2026-10-12) found what no
// check saw, because every check that opened the cart used a stand-in pointer lock or clicked through script:
//   - v7's cart buttons did nothing: taking the free card captured the mouse again while the cart stayed open, so every
//     click went to the game behind it;
//   - v8 bought a card from two shots fired as the cart opened (the cart opens the instant the last enemy falls, with the
//     cursor where the aim was, and a card's face bought on a double click);
//   - Esc and Enter left the cart with a card chosen; the cart's words were 9 to 12 px.
//
// What it does: one page at 1280×720 with the REAL pointer lock (no stand-in) and the real mouse and keys, on the kit's
// staged moment ?gf-demo=cart.locked (gf/forge/shop.js: the cart opens only while the mouse is captured, as when a
// wave's last enemy falls under the aim, and again each time it was left and the mouse taken back).
//   capture    a click on the game captures the mouse; while the cart is open the mouse is free (pointerLockElement null)
//   guard      two real clicks at the middle of the screen, the first within GUARD_CLICK_MS of the cart opening: the cart
//              is still open, nothing is chosen, bought, refused or left. At the second opening the cursor rests where
//              Done was (the mouse is taken back where it was let go): a click there at once must not leave
//   buttons    after the guard: a click on a card's face chooses it (the inspector shows), Esc lets go of it and never
//              leaves, a click on a Buy button answers (a purchase, or the note why not), Done leaves; at the second
//              opening Enter with nothing chosen leaves
//   text       every word in the cart at least DESKTOP_PX tall (with nothing chosen and with a card chosen)
// Budget: about 20 s.

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const FORGE_CART_LIMITS = { SIZE: [1280, 720], DESKTOP_PX: 14, PHONE_PX: 12, GUARD_CLICK_MS: 200, STAGE_MS: 20000 };

/** In the page: the cart's words under `floor` px that are on the screen (font-size 0 is a hidden word). */
export const CART_TEXT = floor => {
  const root = document.getElementById('gf-forge-cart'); if (!root) return { min: null, small: [] };
  const small = []; let min = Infinity;
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const t = n.textContent.trim(), e = n.parentElement; if (!t || !e) continue;
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) continue;
    const px = parseFloat(getComputedStyle(e).fontSize); if (!(px >= 1)) continue;
    min = Math.min(min, px);
    if (px < floor - 0.01 && !small.some(s => s.text === t.slice(0, 40))) small.push({ text: t.slice(0, 40), px: Math.round(px * 10) / 10 });
  }
  return { min: Number.isFinite(min) ? Math.round(min * 10) / 10 : null, small: small.sort((a, b) => a.px - b.px).slice(0, 8) };
};
/** The words of a CART_TEXT answer for a fail line: "COINS", "SCORE" and 2 more. */
export const smallWords = small => { const q = small.map(s => `"${s.text}"`); return q.length <= 3 ? q.join(', ').replace(/, ([^,]*)$/, ' and $1') : `${q.slice(0, 3).join(', ')} and ${q.length - 3} more`; };

/**
 * The leg's verdict (pure). m: {applies, stopped, captured (a click captured the mouse), locks: [{at, captured}] (while
 * the cart was open), guard: [{at, ms, acted}] (acted: what a click inside the guard did, or null; ms: how long after the
 * cart opened the first press came), buttons: [{id, ok, why}], text: [{at, small: [{text, px}]}]} → {ok, judged, detail}
 */
export function judgeCartMouse(m, L = FORGE_CART_LIMITS) {
  if (!m.applies) return { ok: true, judged: false, detail: 'the cart with a mouse: nothing to judge (the game has no cart)' };
  const bad = [], notes = [];
  if (m.captured === false) bad.push('a click on the game did not capture the mouse, so the cart could not open on its staged moment (?gf-demo=cart.locked)');
  const held = (m.locks ?? []).filter(l => l.captured);
  if (held.length) bad.push(`the cart is open while the mouse is captured (${held.map(l => l.at).join('; ')}): a click lands on the game behind it, not on the cart's buttons (v7's broken buttons)`);
  for (const g of m.guard ?? []) {
    if (g.acted) bad.push(`a click ${g.ms} ms after the cart opened acted (${g.at}: ${g.acted}): the cart takes no click, tap or key for its opening guard`);
    else if (g.ms === null || g.ms > (g.guardMs ?? 600) - 50) notes.push(`${g.at}: the first click came ${g.ms ?? '?'} ms after the cart opened, too late to try the guard`);
  }
  for (const b of m.buttons ?? []) if (!b.ok) bad.push(b.why);
  for (const t of m.text ?? []) if (t.small?.length) bad.push(`the cart's text ${smallWords(t.small)} is under ${L.DESKTOP_PX} px with a mouse (${t.at}; the smallest ${t.small[0].px} px)`);
  if (m.stopped) bad.push(`the page stopped: ${m.stopped}`);
  if (!bad.length) {
    const judged = (m.guard ?? []).filter(g => !g.acted && g.ms !== null && g.ms <= (g.guardMs ?? 600) - 50);
    return { ok: true, judged: true, notes, detail: `the cart with a real mouse at ${L.SIZE.join('×')}: the mouse free while it is open${judged.length ? `, ${judged.length} click${judged.length > 1 ? 's' : ''} inside its opening guard taken by nothing (${judged.map(g => `${g.ms} ms`).join(', ')})` : ''}, ${(m.buttons ?? []).map(b => b.id).join(', ')} answer, its words at least ${L.DESKTOP_PX} px` };
  }
  return { ok: false, judged: true, notes, detail: `the cart with a real mouse at ${L.SIZE.join('×')}: ${bad.join('; ')}. The cart is the kit's (gf/forge/shop.js): it frees the mouse when it opens, takes no input for its opening guard (CART_GUARD_MS), buys only from Buy, its key twice or Enter, never leaves on Esc, and keeps its words at least ${L.DESKTOP_PX} px with a mouse and ${L.PHONE_PX} on a phone; do not restyle it or take the mouse back while it is open.` };
}

// ---------------------------------------------------------------------------------------------------------------------
// the browser half

const SHOP = () => { try { return window.__game?.forge?.shop?.() ?? null; } catch { return null; } };
const LOCKED = () => !!document.pointerLockElement;
const centre = r => ({ x: r[0] + r[2] / 2, y: r[1] + r[3] / 2 });

/**
 * Check 13's mouse leg. newPage(label, {overrides, viewport}) → {ctx, page, errors} (verify's own; no lock stand-in);
 * url: the served game; game: config/game.json. → {ok, judged, detail, record, warnings}
 */
export async function checkForgeCart({ newPage, url, game, shot = async () => null, log = () => {} }) {
  const L = FORGE_CART_LIMITS, warnings = [], t0 = Date.now();
  const m = { applies: !!game?.forge?.shop?.on, captured: null, locks: [], guard: [], buttons: [], text: [], stopped: null };
  const record = { url: '?seed=7&bots=0&gf-demo=cart.locked', input: 'a real mouse and keys, the real pointer lock', shots: [] };
  if (!m.applies) { const j = judgeCartMouse(m, L); return { ...j, warnings, record: { applies: false } }; }
  const [W, H] = L.SIZE;
  let T = null;
  try {
    T = await newPage('the cart, a mouse', { overrides: { patches: [{ file: 'config/game.json', pointer: '/round/seconds', value: 300 }] }, viewport: { width: W, height: H } });
    const p = T.page, shop = () => p.evaluate(SHOP), locked = () => p.evaluate(LOCKED).catch(() => null);
    // a read-only log of when each press began (this page's clock), to say how soon after the cart opened it came (a
    // pointerdown: the cart's guard cancels a guarded press, and with it the mouse's own mousedown)
    await p.addInitScript(() => { window.__gfCartDowns = []; addEventListener('pointerdown', () => window.__gfCartDowns.push(performance.now()), true); });
    await p.goto(`${url}${record.url}`, { waitUntil: 'load' });
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
    const play = await p.evaluate(() => { const r = document.getElementById('gf-play')?.getBoundingClientRect(); return r ? [r.x, r.y, r.width, r.height] : null; });
    if (!play) throw new Error('no Play button on the menu');
    await p.mouse.click(centre(play).x, centre(play).y);
    for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('a click on Play did not start the round'); await sleep(120); }
    await sleep(1500);
    // capture: a click on the game, as a player's first; a player whose click did not take clicks again, so up to three
    // clicks 2 s apart (one click with 2 s failed once on a machine at load 53 and passed alone twice, 2026-10-12)
    const capture = async () => { for (let k = 0; k < 3; k++) { await p.mouse.click(W / 2, H / 2); for (let i = 0; i < 20; i++) { if (await locked()) return true; await sleep(100); } } return false; };
    m.captured = await capture();
    if (!m.captured) throw new Error('a click on the game did not capture the mouse');
    const opened = () => p.waitForFunction(() => !!window.__game?.forge?.shop?.()?.shown, null, { polling: 'raf', timeout: L.STAGE_MS });
    /** Two quick clicks at (x, y) the moment the cart is open, then what they did. */
    const guardTry = async (at, x, y) => {
      await opened();
      await p.mouse.move(x, y);
      const pre = await shop();                       // what the cart showed before the clicks (a few ms)
      await p.mouse.down(); await p.mouse.up(); await sleep(60); await p.mouse.down(); await p.mouse.up();
      const o0 = await shop(), cap = await locked();
      m.locks.push({ at, captured: !!cap });
      const downs = await p.evaluate(() => window.__gfCartDowns.slice(-2));
      const ms = o0?.guard?.openedAt ? Math.round(downs[0] - o0.guard.openedAt) : null;
      await sleep(250);
      const o = await shop();
      const acted = !o?.shown ? 'the cart closed' : o.selected >= 0 ? `card ${o.selected + 1} chosen` : (o.bought?.length ?? 0) > (pre?.bought?.length ?? 0) ? 'a purchase' : (o.refused?.length ?? 0) > (pre?.refused?.length ?? 0) ? 'a purchase refused' : o.note && o.note !== pre?.note ? `the note "${o.note}"` : o.mode !== 'items' ? `the ${o.mode} chooser opened` : null;
      m.guard.push({ at, ms, acted, guardMs: o0?.guard?.ms ?? null, ignored: (o?.guard?.ignored ?? []).length });
      return o;
    };
    // ---- the first opening: two shots at the middle ----
    let o = await guardTry('the first opening, two clicks at the middle', W / 2, H / 2);
    { const f = await shot(p, 'cart-mouse-open'); if (f) record.shots.push(f); }
    if (!o?.shown) throw new Error('the cart closed in its opening guard');
    await sleep(Math.max(0, (o.guard?.ms ?? 600) + 150));
    m.text.push({ at: 'nothing chosen', ...(await p.evaluate(CART_TEXT, L.DESKTOP_PX)) });
    // a card's face chooses it
    const card = o.targets.find(t => t.id === 'card-1');
    if (card) {
      await p.mouse.click(centre(card.rect).x, centre(card.rect).y); await sleep(350);
      o = await shop();
      m.locks.push({ at: 'after a click on a card', captured: !!(await locked()) });
      m.buttons.push({ id: 'a card\'s face', ok: o.selected === 0 && !!o.inspector, why: `a real click on card 1's face chose nothing (selected ${o.selected}${o.inspector ? '' : ', no inspector'})` });
      m.text.push({ at: 'a card chosen', ...(await p.evaluate(CART_TEXT, L.DESKTOP_PX)) });
      { const f = await shot(p, 'cart-mouse-card'); if (f) record.shots.push(f); }
      // Esc lets go of the choice and never leaves
      await p.keyboard.press('Escape'); await sleep(300);
      o = await shop();
      m.buttons.push({ id: 'Esc', ok: !!o?.shown && o.selected < 0, why: !o?.shown ? 'Esc with a card chosen closed the cart (it lets go of the card; Done is its button or Enter)' : `Esc did not let go of the card chosen (selected ${o.selected})` });
      await p.keyboard.press('Escape'); await sleep(300);
      o = await shop();
      m.buttons.push({ id: 'Esc again', ok: !!o?.shown, why: 'Esc with nothing chosen closed the cart (it must do nothing there)' });
    } else m.buttons.push({ id: 'a card\'s face', ok: true, why: '' });
    // a Buy button answers: a purchase, or the note why not
    const buy = o?.cards?.find(c => c.buy);
    if (buy) {
      const n0 = (o.bought ?? []).length;
      await p.mouse.click(centre(buy.buy).x, centre(buy.buy).y); await sleep(400);
      const b = await shop();
      m.buttons.push({ id: 'Buy', ok: (b.bought ?? []).length > n0 || !!b.note || (b.refused ?? []).length > (o.refused ?? []).length, why: 'a real click on Buy 1 did nothing (no purchase, no note why not)' });
    }
    // Done leaves; where it was is where the mouse rests when the cart next opens
    o = await shop();
    const done = o?.leave;
    if (!done) throw new Error('the cart reports no Done button');
    await p.mouse.click(centre(done).x, centre(done).y);
    let gone = false; for (let i = 0; i < 15 && !gone; i++) { await sleep(100); gone = !(await shop())?.shown; }
    m.buttons.push({ id: 'Done', ok: gone, why: 'a real click on Done did not leave the cart' });
    // ---- the second opening: the mouse taken back, the cursor resting on Done ----
    await sleep(500);
    if (!(await locked())) await capture();
    o = await guardTry('the second opening, a click where Done is', centre(done).x, centre(done).y);
    if (o?.shown) {
      await sleep(Math.max(0, (o.guard?.ms ?? 600) + 150));
      await p.keyboard.press('Enter');
      let left = false; for (let i = 0; i < 15 && !left; i++) { await sleep(100); left = !(await shop())?.shown; }
      m.buttons.push({ id: 'Enter', ok: left, why: 'Enter with nothing chosen did not leave the cart (it is Done)' });
    }
  } catch (e) { m.stopped = e.message; }
  finally {
    if (T?.errors.length) warnings.push(`the cart's mouse page console errors: ${[...new Set(T.errors)].slice(0, 2).join(' | ')}`);
    await T?.ctx.close().catch(() => {});
  }
  const j = judgeCartMouse(m, L);
  if (j.notes?.length) warnings.push(...j.notes.map(n => `check 13, the cart with a mouse: ${n}`));
  Object.assign(record, { captured: m.captured, locks: m.locks, guard: m.guard, buttons: m.buttons, text: m.text, stopped: m.stopped, limits: L, seconds: Math.round((Date.now() - t0) / 1000) });
  log(`  forge cart, a mouse: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 240)}`);
  return { ...j, warnings, record };
}
