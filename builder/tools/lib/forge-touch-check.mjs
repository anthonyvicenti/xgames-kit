// verify check 13's phone leg (CONTRACT §8 forge): a phone's controls leave the picture to the game, and every action
// is still under a thumb. Kept apart from tools/verify-forge.mjs, which calls checkForgeTouch after the keys' half
// (tools/lib/forge-controls-check.mjs) and folds the answer into check 13 (controls work).
//
// Why (gf-forge wave 5, track U2, 2026-10-11; regressions/forge-crowded-phone). The creator, after trying the published
// forge game on a phone: "Can we also make the mobile controls a bit more friendsly, the HUD on the right takes up too
// much of the screen." (research/rust-engine/evidence/creator-zombie-town-request-2026-10-11.json). Seven round,
// labelled, dark buttons stood on the right all the time, whether or not they could do anything. Measured on that
// layout (the kit 0.6.0-wave4, Bone Vigil): their boxes covered 7.25% of an 844×390 screen, 7.32% of 390×844 and 9.54%
// of 667×375; at 667×375 the Raise button stood in the middle of the screen, where the aim is, and at both sideways
// sizes the Load button lay over the rounds readout. Nothing in verify looked at a phone's controls at all: check 13
// pressed keys, check 31 measured the canvas's pixels.
//
// Why check 13 and not 31 (the parent, 2026-10-11): 31 is a release's check that no game's config can fail
// (tools/lib/verdict.mjs RELEASE_ONLY), and this leg's broken example is made from slot values (forge.feel.touch.*) a
// build agent or a creator can write. It adds about 30 s to a forge build's verify.
//
// What it does: one touch page (a phone's screen, fingers through the DevTools protocol, no mouse and no keys) on the
// quiet staged moment check 16 uses (?gf-demo=feel.hit: no waves, one target 6 m ahead), with auto-fire off (as a
// player's own choice in Settings is kept in the browser, so nothing fires until a thumb does) and every weapon a
// player can hold in their hands (each `start` set true as Studio overrides a value).
//   the layout   at 844×390, 390×844 and 667×375 (the same page, turned and resized as a phone is), read from what
//                the HUD reports (window.__game.forge.feel().shown.hud.buttons: every button's box, there or not) and
//                from the HUD's own readouts on the page:
//                  - the boxes of the buttons that are there at rest cover at most COVER_MAX of the screen;
//                  - no button's seat (there now or not: an empty seat fills when its button can do something) is
//                    over the middle of the screen (the band from 30% to 70% each way, where the aim is), over a
//                    readout (health, the wave, score, coins, friends, the rounds) or the menu button, off the
//                    screen, narrower than MIN_PX, or on another's seat
//   by fingers   at 844×390, each action a player of this game needs, pressed as a thumb presses it, and the core's
//                answer read: look (a drag on the right half turns the view), move (a thumb on the left half: a stick
//                appears under it and the player walks), the quick strike (its button is there once the target is in
//                reach; a target the player cannot walk to is not judged, and the detail says so), fire, reload (its
//                button is there once a round is spent), swap (a second weapon in hand), jump, the evade
//   How to play  before the round, the menu's How to play at the three sizes: every row's words (what the control
//                does) are on the screen with room to be read (HOW_MIN px). A row's touch name is printed in the
//                keys column, and a long one takes the words' room: this track's own first cut wrote "Load button
//                (there when rounds are spent)" and pushed "Reload" off an upright phone; nothing in verify saw it
//   raise        a game whose players can be raised and whose HUD lists it: a second page on the kit's staged moment
//                (?gf-demo=controls.revive&bots=1: a friend laid down beside the player): the button is there, its
//                seat is good at the three sizes with a friend's row on the HUD, and a thumb held on it raises them
//   the tally  (v8; the creator on the forge zombie game v7, 2026-10-12: "would love to see gold and score back on the
//                display", research/rust-engine/evidence/creator-zombie-town-v7-feedback-2026-10-12.json) a game with
//                enemies and a cart: at the three sizes the HUD's score and coins are on the screen, whole, their number
//                at least TALLY_PX high
//   the cart   (v8; the same words: "The HUD/cart pop up is too small and hard to pick") a game with a cart
//                (forge.shop.on): a page on the kit's staged moment (?gf-demo=cart: the cart opens as the round starts,
//                no waves before it), measured at the three sizes from what the cart reports (window.__game.forge.shop():
//                every target a thumb presses, its cards and its heading): every target at least CART_PX tall and wide
//                and on the screen, every card's text whole, the purse and the time left in its heading; and (the review
//                of Zombie Town v8, 2026-10-12: phone labels of 9 px) none of its words under CART_TEXT_PX, with nothing
//                chosen and again with a card chosen by a tap (the inspector's words). The cart with a mouse is
//                tools/lib/forge-cart-check.mjs
// A page that is not a forge touch layer (no buttons reported) fails with that said. Budget: about 30 s, 45 with a cart.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { holdableWeapons } from './forge-feel-check.mjs';
import { reviveApplies } from './forge-controls-check.mjs';
import { CART_TEXT, smallWords } from './forge-cart-check.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r1 = v => Math.round(v * 10) / 10;
const r2 = v => Math.round(v * 100) / 100;
export const FORGE_TOUCH_LIMITS = {
  SIZES: [[844, 390], [390, 844], [667, 375]],
  /** The most of the screen the boxes of the buttons that are there at rest may cover. Today's kit: 2.4% to 4.0%
   *  (three or four buttons of 46 px and fire at 60); the layout the creator complained of: 7.25% to 9.54%. */
  COVER_MAX: 0.05,
  MIN_PX: 44,                    // a thumb's target
  MIDDLE: [0.3, 0.7],            // the band each way where the aim is
  HOW_MIN: 100,                  // the least room How to play's words column keeps on a phone, px (the kit's own rows: 222)
  LOOK_RAD: 0.15, WALK_M: 1, JUMP_RISE: 0.25, REVIVE_MIN: 0.25, STAGE_MS: 12000,
  TALLY_PX: 18,                  // the least height of the score's and the coins' number in a fight (the kit's: 28 px on a phone)
  CART_PX: 56,                   // the least height and width of anything a thumb presses in the cart (gf/forge/shop.js CART_MIN_TARGET)
  CART_TEXT_PX: 12,              // the least size of the cart's words on a phone (gf/forge/shop.js CART_TEXT_MIN.phone)
};
const TALLY = { score: 'the score', coins: 'the coins' };
const WORDS = { look: 'look', move: 'move', fire: 'fire', jump: 'jump', evade: 'the evade', strike: 'the quick strike', reload: 'reload', swap: 'swap', raise: 'raise' };
/** A button's id (gf/forge/hud.js touchPlan) for each action. */
const BUTTON = { fire: 'fire', jump: 'jump', evade: 'evade', strike: 'melee', reload: 'reload', swap: 'swap', raise: 'use' };
const does = s => typeof s === 'string' && s.trim() !== '' && !/^nothing/i.test(s.trim());

/** The actions a player of this game needs on a phone, in the order they are tried. (pure)
 *  hold: the weapons a player can hold (forge-feel-check.mjs holdableWeapons). */
export function touchNeeds(game, hold = []) {
  const W = game?.forge?.weapons ?? [], C = game?.controls ?? {};
  const out = ['look', 'move'];
  if (W.length) out.push('strike');
  if (W.length || does(C.primary)) out.push('fire');
  if (hold.some(x => (Number(W[x.row]?.magazine) || 0) > 0)) out.push('reload');
  if (hold.length > 1) out.push('swap');
  out.push('jump', 'evade');
  if (reviveApplies(game) && does(C.interact)) out.push('raise');
  return out;
}

const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const name = b => (b.label ? `${String(b.label).slice(0, 1).toUpperCase()}${String(b.label).slice(1)}` : b.id);

/**
 * One screen's layout, judged (pure). m: {size: [W, H], buttons: [{id, label, there, x, y, w, h}] (every button's box,
 * there now or not), readouts: [{id, x, y, w, h}]} → {ok, cover (the share of the screen under the boxes that are
 * there), there: [ids], fails: [{rule, text}]}
 */
export function judgeTouchLayout(m, L = FORGE_TOUCH_LIMITS) {
  const [W, H] = m.size, fails = [], B = m.buttons ?? [];
  const there = B.filter(b => b.there);
  const cover = there.reduce((n, b) => n + b.w * b.h, 0) / (W * H);
  if (!B.length) return { ok: false, cover: 0, there: [], fails: [{ rule: 'none', text: 'the page shows no touch buttons at all' }] };
  // the share is held at rest: a staged moment (`with`: beside a fallen friend) has a button more on purpose
  if (!m.with && cover > L.COVER_MAX) fails.push({ rule: 'cover', text: `the touch controls cover ${r1(cover * 100)}% of the screen at rest (the most a phone's picture gives up is ${r1(L.COVER_MAX * 100)}%): ${there.length} buttons there with nothing to do (${there.map(b => `${name(b)} ${Math.round(b.w)} px`).join(', ')})` });
  const mid = { x: W * L.MIDDLE[0], y: H * L.MIDDLE[0], w: W * (L.MIDDLE[1] - L.MIDDLE[0]), h: H * (L.MIDDLE[1] - L.MIDDLE[0]) };
  for (const b of B) {
    if (Math.min(b.w, b.h) < L.MIN_PX) fails.push({ rule: 'small', text: `${name(b)} is ${Math.round(Math.min(b.w, b.h))} px across (a thumb needs ${L.MIN_PX})` });
    if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) fails.push({ rule: 'off', text: `${name(b)} is partly off the screen` });
    if (hit(b, mid)) fails.push({ rule: 'middle', text: `${name(b)} is over the middle of the screen, where the aim is` });
    for (const r of m.readouts ?? []) if (hit(b, r)) fails.push({ rule: 'readout', text: `${name(b)} lies over ${r.id}` });
  }
  for (let i = 0; i < B.length; i++) for (let j = i + 1; j < B.length; j++) {
    const p = B[i], q = B[j];
    if (Math.hypot(p.x + p.w / 2 - q.x - q.w / 2, p.y + p.h / 2 - q.y - q.h / 2) < (Math.min(p.w, p.h) + Math.min(q.w, q.h)) / 2 - 1) fails.push({ rule: 'overlap', text: `${name(p)} and ${name(q)} share a seat` });
  }
  // v8: in a game with enemies and a cart, the score and the coins are on the screen in a fight
  if (m.needsTally) for (const [k, what] of Object.entries(TALLY)) {
    const t = m.tally?.[k];
    if (!t?.shown) fails.push({ rule: 'tally', text: `${what} is not on the screen in a fight` });
    else if (t.x < 0 || t.y < 0 || t.x + t.w > W + 1 || t.y + t.h > H + 1) fails.push({ rule: 'tally', text: `${what} is partly off the screen` });
    else if (!(t.px >= L.TALLY_PX)) fails.push({ rule: 'tally', text: `${what} is ${Math.round(t.px)} px high (it needs ${L.TALLY_PX})` });
  }
  return { ok: fails.length === 0, cover, there: there.map(b => b.id), fails };
}

/**
 * How to play on one phone screen (pure). m: {size: [W, H], rows: [{key, words, x, w, kw}]} (each row's keys cell text
 * and width, its words and the words cell's box) → fails, at most one: [{rule: 'how', w (the least room a row's words
 * have), off (some run off the screen), culprit (the longest name in the keys column, which sets that column's width),
 * text}].
 */
export function judgeHowToPlay(m, L = FORGE_TOUCH_LIMITS) {
  const [W] = m.size, rows = m.rows ?? [];
  const bad = rows.filter(r => r.x < -1 || r.x + r.w > W + 1 || r.w < L.HOW_MIN);
  if (!bad.length) return [];
  const w = Math.round(Math.min(...bad.map(r => r.w))), off = bad.some(r => r.x < -1 || r.x + r.w > W + 1);
  const culprit = [...rows].sort((p, q) => (q.kw ?? q.key.length) - (p.kw ?? p.key.length))[0].key;
  return [{ rule: 'how', w, off, culprit, text: `How to play leaves what a control does ${w} px${off ? ', off the screen' : ''} (it needs ${L.HOW_MIN}): its keys column is as wide as its longest name, "${culprit}"` }];
}

/**
 * The cart on one screen (pure, v8). c: {size: [W, H], shown, targets: [{id, rect: [x, y, w, h]}], cards: [{slot, id,
 * textFits}], heading: {purse, clock}} (what window.__game.forge.shop() reports) → fails [{rule, text}].
 */
export function judgeCartLayout(c, L = FORGE_TOUCH_LIMITS) {
  const [W, H] = c.size, fails = [];
  if (!c.shown) return [{ rule: 'cart', text: 'the cart did not open on its staged moment (?gf-demo=cart)' }];
  const T = c.targets ?? [];
  if (!T.length) fails.push({ rule: 'cart', text: 'the cart reports nothing a thumb can press' });
  const nameOf = id => String(id).replace(/^item-/, '').replace(/^buy-(\d)$/, 'Buy $1').replace(/^card-(\d)$/, 'card $1').replace(/^done$/, 'Done');
  for (const t of T) {
    const [x, y, w, h] = t.rect;
    if (h < L.CART_PX || w < L.CART_PX) fails.push({ rule: 'cart', text: `the cart's ${nameOf(t.id)} is ${Math.round(w)}×${Math.round(h)} px (a thumb needs ${L.CART_PX} each way)` });
    if (x < -1 || y < -1 || x + w > W + 1 || y + h > H + 1) fails.push({ rule: 'cart', text: `the cart's ${nameOf(t.id)} is partly off the screen` });
  }
  for (const k of c.cards ?? []) if (k.id && k.textFits === false) fails.push({ rule: 'cart', text: `the cart's card ${k.slot + 1} (${k.id}) has its text cut off` });
  if (c.text?.small?.length) fails.push({ rule: 'cart-text', text: `the cart's text ${smallWords(c.text.small)} is under ${L.CART_TEXT_PX} px on a phone${c.chosen ? ' (a card chosen)' : ''}` });
  if (!/\d/.test(String(c.heading?.purse ?? ''))) fails.push({ rule: 'cart', text: 'the cart\'s heading shows no purse' });
  if (!/\d/.test(String(c.heading?.clock ?? ''))) fails.push({ rule: 'cart', text: 'the cart\'s heading shows no time left' });
  return fails;
}

/**
 * The leg's verdict (pure). m: {applies, why, sizes: [{size, buttons, readouts, with?}] (each as judgeTouchLayout
 * takes it; `with`: what was staged, for the words), needs: [action], did: {action: {ok, why}}, stopped: a message}
 * → {ok, judged, detail, layouts: [judgeTouchLayout's answers]}
 */
export function judgeForgeTouch(m, L = FORGE_TOUCH_LIMITS) {
  if (!m.applies) return { ok: true, judged: false, detail: `a phone's controls: nothing to judge (${m.why})`, layouts: [] };
  if (m.stopped && !(m.sizes ?? []).length) return { ok: false, judged: false, detail: `a phone's controls could not be played: ${m.stopped}`, layouts: [] };
  const layouts = (m.sizes ?? []).map(s => ({ size: s.size, with: s.with ?? null, ...judgeTouchLayout(s, L) }));
  const hows = (m.how ?? []).map(h => ({ size: h.size, fails: judgeHowToPlay(h, L) }));
  const at = l => `${l.size[0]}×${l.size[1]}`;
  const order = l => { const i = L.SIZES.findIndex(s => s[0] === l.size[0] && s[1] === l.size[1]); return i < 0 ? 99 : i; };
  const rest = layouts.filter(l => !l.with).sort((a, b) => order(a) - order(b));
  const sizes = rest.map(at).join(', ').replace(/, ([^,]*)$/, ' and $1');
  const bad = [];
  // one line a rule, with the sizes it failed at: the same button over the same readout at two sizes is said once,
  // and what also fails at rest is not said again for the staged moment
  const seen = new Map();
  for (const l of [...layouts].sort((a, b) => order(a) - order(b) || (a.with ? 1 : 0) - (b.with ? 1 : 0))) for (const f of l.fails) {
    const k = f.rule === 'cover' ? `cover ${at(l)}` : f.text;
    if (!seen.has(k)) seen.set(k, { f, rest: [], staged: [] });
    (l.with ? seen.get(k).staged : seen.get(k).rest).push(l.with ? `${at(l)} ${l.with}` : at(l));
  }
  for (const { f, rest: r, staged } of seen.values()) bad.push(`at ${[...new Set(r.length ? r : staged)].join(' and ')} ${f.text}`);
  // How to play: said once for the name that takes the room, with the sizes it fails at
  const rows = new Map();
  for (const h of [...hows].sort((a, b) => order(a) - order(b))) for (const f of h.fails) { if (!rows.has(f.culprit)) rows.set(f.culprit, { w: f.w, at: [], off: [] }); const g = rows.get(f.culprit); g.w = Math.min(g.w, f.w); g.at.push(at(h)); if (f.off) g.off.push(at(h)); }
  for (const [culprit, g] of rows) bad.push(`at ${g.at.join(' and ')} How to play leaves what a control does ${g.w} px (it needs ${L.HOW_MIN})${g.off.length ? `, off the screen at ${g.off.join(' and ')}` : ''}: its keys column is as wide as its longest name, "${culprit}"`);
  // the cart (v8): one line a rule, with the sizes it failed at
  const carts = (m.cart?.sizes ?? []).map(c => ({ size: c.size, chosen: !!c.chosen, fails: judgeCartLayout(c, L) }));
  const cartSeen = new Map();
  for (const c of [...carts].sort((p, q) => order(p) - order(q))) for (const f of c.fails) { if (!cartSeen.has(f.text)) cartSeen.set(f.text, []); cartSeen.get(f.text).push(at(c)); }
  for (const [text, sz] of cartSeen) bad.push(`at ${[...new Set(sz)].join(' and ')} ${text}`);
  if (m.cart?.stopped) bad.push(`the cart could not be measured: ${m.cart.stopped}`);
  const missing = (m.needs ?? []).filter(a => !m.did?.[a]?.ok);
  for (const a of missing) bad.push(`${WORDS[a] ?? a}: ${m.did?.[a]?.why ?? 'not tried (the page stopped before it)'}`);
  if (m.stopped) bad.push(`the page stopped: ${m.stopped}`);
  const cover = rest.map(l => `${(l.cover * 100).toFixed(1)}%`).join(', ').replace(/, ([^,]*)$/, ' and $1');
  if (!bad.length) {
    const how = (m.needs ?? []).map(a => `${WORDS[a] ?? a}${m.did[a].note ? ` (${m.did[a].note})` : ''}`).join(', ');
    const tallyOk = rest.some(l => (m.sizes ?? []).some(s => s.needsTally)) ? `; the score and the coins on the screen in a fight` : '';
    const cartOk = carts.length ? `; the cart, measured at ${[...new Set(carts.map(at))].join(', ').replace(/, ([^,]*)$/, ' and $1')}${carts.some(c => c.chosen) ? ' (and again with a card chosen)' : ''}: ${m.cart.sizes[0]?.targets?.length ?? 0} targets each at least ${L.CART_PX} px, every card's text whole, no word under ${L.CART_TEXT_PX} px, the purse and the time left in its heading` : '';
    return { ok: true, judged: true, layouts, hows, carts, detail: `a phone's controls, measured at ${sizes}: the buttons there at rest cover ${cover} of the screen (at most ${r1(L.COVER_MAX * 100)}%), every seat at least ${L.MIN_PX} px across and none over the middle, a readout or the menu button${hows.length ? '; How to play\'s rows keep their words on the screen' : ''}${tallyOk}${cartOk}; by fingers: ${how}` };
  }
  const layoutBad = layouts.some(l => l.fails.length);
  const tallyBad = layouts.some(l => l.fails.some(f => f.rule === 'tally')), cartBad = cartSeen.size > 0 || !!m.cart?.stopped;
  return { ok: false, judged: true, layouts, hows, carts, detail: `a phone's controls, measured at ${sizes}: ${bad.join('; ')}.` +
    (tallyBad ? ' The score and the coins are the kit\'s HUD (gf/forge/hud.js, .gf-fh-score and .gf-fh-coins): do not hide, cover or shrink them; a game with coins to spend shows them in every fight.' : '') +
    (cartBad ? ' The pedlar\'s cart is the kit\'s (gf/forge/shop.js, config/game.json → forge.shop): do not restyle or shrink it; every card, Buy, item tile and Done must stay at least ' + L.CART_PX + ' px for a thumb, and no word under ' + L.CART_TEXT_PX + ' px on a phone.' : '') +
    (layoutBad ? ' A phone\'s buttons are laid out by the kit from the slots forge.feel.touch.* (config/game.json → forge.feel.touch: size, fire, gap, edge, lift, always): keep them small, and let a button be there only when it can do something (always: false). A game with more actions than a small phone has room for takes one out of config/game.json → controls.' : '') +
    (rows.size ? ' How to play prints a row\'s touch name in its keys column (config/game.json → controls.more: [keys, what it does, the touch name]): keep the name to a word or two ("Load button"), and say when it applies in what it does.' : '') +
    (missing.length ? ' Every action a player needs must have a control a thumb can reach when it applies: do not hide or cover the kit\'s touch layer (#gf-ui .gf-touch), and list in config/game.json → controls only what the game does.' : '') };
}

// ---------------------------------------------------------------------------------------------------------------------
// the browser half

/** In the page: the screen, every touch button's box, and the HUD's readouts as they stand. */
const MEASURE = () => {
  const g = window.__game; let hud = null; try { hud = g?.forge?.feel?.()?.shown?.hud ?? null; } catch {}
  const vis = e => { if (!e?.isConnected) return null; const r = e.getBoundingClientRect(); const ok = typeof e.checkVisibility === 'function' ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : e.offsetParent !== null; return ok && r.width > 2 && r.height > 2 ? { x: r.x, y: r.y, w: r.width, h: r.height } : null; };
  const readouts = [];
  for (const [id, sel] of [['the menu button', '#gf-ui .gf-menubtn:not(.gf-fsbtn)'], ['the full-screen button', '#gf-ui .gf-fsbtn'], ['the health readout', '#gf-ui .gf-fh-vitals'], ['the wave readout', '#gf-ui .gf-top'], ['the score', '#gf-ui .gf-fh-score'], ['the coins', '#gf-ui .gf-fh-coins'],
    ['a friend\'s row', '#gf-ui .gf-fh-friend'], ['the rounds readout', '#gf-ui .gf-feel-ammo'], ['the combo', '#gf-ui .gf-feel-combo'], ['a meter', '#gf-ui .gf-meters .gf-meter'], ['the prompt', '#gf-ui .gf-prompt']]) {
    for (const e of document.querySelectorAll(sel)) { const r = vis(e); if (r) readouts.push({ id, ...r }); }
  }
  // a button that is not there keeps its seat's box (the kit hides it without taking it out of the layout); an older
  // kit says only `shown`
  const buttons = (hud?.buttons ?? []).filter(b => b.rect && b.rect.w > 0).map(b => ({ id: b.id, label: b.label, there: b.there !== undefined ? !!(b.there && b.shown) : !!b.shown, x: b.rect.x, y: b.rect.y, w: b.rect.w, h: b.rect.h }));
  // the score and the coins (v8): each on the screen, and how high its number is drawn
  const tally = {};
  for (const [k, sel] of [['score', '#gf-ui .gf-fh-score'], ['coins', '#gf-ui .gf-fh-coins']]) {
    const e = document.querySelector(sel), r = vis(e), b = e?.querySelector('b');
    tally[k] = r ? { shown: true, ...r, px: b ? parseFloat(getComputedStyle(b).fontSize) * (parseFloat(getComputedStyle(e).zoom) || 1) : 0 } : { shown: false };
  }
  return { size: [innerWidth, innerHeight], layout: hud?.layout ?? null, touch: !!hud?.touch, buttons, readouts, tally };
};
/** MEASURE, for the forge kit's own phone tool (gf-forge/tools/touch-check.mjs): page.evaluate(TOUCH_MEASURE). */
export const TOUCH_MEASURE = MEASURE;
/** In the page: the cart as it reports itself (gf/forge/shop.js observe). */
const CART = () => { let o = null; try { o = window.__game?.forge?.shop?.() ?? null; } catch {} return o ? { size: [innerWidth, innerHeight], shown: !!o.shown, chosen: o.selected >= 0, targets: o.targets ?? [], cards: (o.cards ?? []).map(c => ({ slot: c.slot, id: c.id, textFits: c.textFits })), heading: o.heading ?? null } : { size: [innerWidth, innerHeight], shown: false, targets: [], cards: [], heading: null }; };
/** In the page: How to play's rows as shown, with each words cell's box (the menu must be on that view). */
const HOW = () => {
  const dl = document.getElementById('gf-how-keys'); if (!dl) return null;
  const rows = []; let key = null;
  for (const e of dl.children) {
    if (e.tagName === 'DT') key = { t: e.textContent.trim(), w: (e.firstElementChild ?? e).getBoundingClientRect().width };
    else if (e.tagName === 'DD' && key !== null) { const r = e.getBoundingClientRect(); rows.push({ key: key.t, kw: key.w, words: e.textContent.trim(), x: r.x, w: r.width }); key = null; }
  }
  return { size: [innerWidth, innerHeight], rows };
};
/** In the page: what a thumb's press changes. */
const STATE = () => {
  const g = window.__game; if (!g) return null;
  const s = g.snapshot(), me = s.players.find(p => p.local), c = g.camera();
  let f = null; try { f = g.forge?.feel?.() ?? null; } catch {}
  const v = f?.shown?.view ?? {}, st = document.querySelector('#gf-ui .gf-stick'), sr = st && getComputedStyle(st).display !== 'none' ? st.getBoundingClientRect() : null;
  return { phase: s.phase, x: me?.x ?? 0, y: me?.y ?? 0, z: me?.z ?? 0, yaw: c?.yaw ?? 0, weapon: v.weapon, ammo: v.ammo, magazine: v.magazine, reloading: v.reloading, shots: v.shots, swing: v.swing, evading: v.evading, evadeCool: v.evadeCool,
    near: f?.shown?.hud?.auto?.near ?? null,
    stick: sr ? { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 } : null, buttons: (f?.shown?.hud?.buttons ?? []).map(b => ({ id: b.id, there: b.there !== undefined ? !!(b.there && b.shown) : !!b.shown, down: !!b.down, rect: b.rect })) };
};
/** In the page: who is down and how far each raise is (the run's facts). */
const RUN = () => { const g = window.__game; let r = null; try { r = g?.forge?.run?.() ?? null; } catch {} return (r?.players ?? []).map(p => ({ id: p.player, local: !!p.local, down: !!p.down, revive: Math.round((p.revive ?? 0) * 100) / 100, alive: p.alive !== false })); };

/** Fingers on a page: touch points through the DevTools protocol (every event carries all the points that are down). */
export function fingersOn(cdp) {
  const down = new Map();
  const send = type => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down].map(([id, p]) => ({ id, x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 0.6 })) });
  const F = {
    async press(id, x, y) { down.set(id, { x, y }); await send('touchStart'); },
    async move(id, x, y) { if (!down.has(id)) return; down.set(id, { x, y }); await send('touchMove'); },
    async drag(id, dx, dy, steps = 6, ms = 16) { const p = down.get(id); if (!p) return; const x0 = p.x, y0 = p.y; for (let i = 1; i <= steps; i++) { await F.move(id, x0 + (dx * i) / steps, y0 + (dy * i) / steps); await sleep(ms); } },
    // a touchEnd names the points that end (Chrome lifts the ones listed and keeps the rest; an empty list lifts all).
    // Until wave 5 this sent the points that stayed, so with two fingers down it lifted the other one.
    async lift(id) { const p = down.get(id); if (!p) return; down.delete(id); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ id, x: Math.round(p.x), y: Math.round(p.y), radiusX: 9, radiusY: 9, force: 0.6 }] }); },
    async tap(x, y, ms = 70) { await F.press(9, x, y); await sleep(ms); await F.lift(9); },
    async all() { if (down.size) { down.clear(); await send('touchEnd'); } },
  };
  return F;
}

/** A phone's page: verify's own newPage with a touch screen, its fingers, and the round started by a tap on Play. */
async function phone({ newPage, url, query, label, patches, L, gameId, menu = null }) {
  const [W, H] = L.SIZES[0];
  const T = await newPage(label, { overrides: { patches }, viewport: { width: W, height: H }, context: { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } });
  const p = T.page, cdp = await T.ctx.newCDPSession(p), F = fingersOn(cdp);
  // auto-fire off, as a player's own choice in Settings is kept (gf/forge/governor.js): nothing fires until a thumb does
  await p.addInitScript(id => { try { localStorage.setItem(`gf3-forge:${id}`, JSON.stringify({ autoFire: false })); } catch {} }, gameId);
  await p.goto(`${url}?seed=7&${query}`, { waitUntil: 'load' });
  for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'lobby'; ) { if (Date.now() - t > 90000) throw new Error('no lobby in 90 s'); await sleep(200); }
  if (menu) await menu(p, F);                                       // what is read from the menu before the round
  const play = await p.evaluate(() => { const r = document.getElementById('gf-play')?.getBoundingClientRect(); return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; });
  if (!play) throw new Error('no Play button on the menu');
  await F.tap(play.x, play.y);
  for (let t = Date.now(); (await p.evaluate(() => window.__game?.phase ?? null).catch(() => null)) !== 'playing'; ) { if (Date.now() - t > 20000) throw new Error('a tap on Play did not start the round'); await sleep(120); }
  return { T, p, F, state: () => p.evaluate(STATE), measure: () => p.evaluate(MEASURE) };
}

/**
 * Check 13's phone leg. newPage(label, {overrides, viewport, context}) → {ctx, page, errors} (verify's own); url: the
 * served game; game: config/game.json; dir: the game folder (rules.js says whether the rules arm players).
 * → {ok, judged, detail, record, warnings}
 */
export async function checkForgeTouch({ newPage, url, game, dir = null, shot = async () => null, log = () => {} }) {
  const L = FORGE_TOUCH_LIMITS, warnings = [], t0 = Date.now();
  const weapons = game.forge?.weapons ?? [];
  const rulesText = dir ? await readFile(join(dir, 'rules.js'), 'utf8').catch(() => '') : '';
  const hold = holdableWeapons(game, rulesText);
  const needs = touchNeeds(game, hold);
  const m = { applies: game.round?.mode !== 'world', why: 'a world has its own phone check (check 30)', sizes: [], how: [], needs, did: {}, stopped: null, cart: null };
  // v8: a game with enemies and a cart shows its score and coins in a fight, and its cart is measured
  const needsTally = (game.forge?.enemies?.length ?? 0) > 0 && !!game.forge?.shop?.on;
  const hasCart = !!game.forge?.shop?.on;
  if (!m.applies) { const j = judgeForgeTouch(m, L); return { ...j, warnings, record: { applies: false, why: m.why } }; }
  const patches = [{ file: 'config/game.json', pointer: '/round/seconds', value: 180 }, ...hold.filter(x => weapons[x.row].start === false).map(x => ({ file: 'config/game.json', pointer: `/forge/weapons/${x.row}/start`, value: true }))];
  const gameId = dir ? await readFile(join(dir, 'assets.json'), 'utf8').then(t => JSON.parse(t).game ?? 'game').catch(() => 'game') : 'game';
  const did = (a, ok, why, note = null) => { m.did[a] = { ok: !!ok, why, ...(note ? { note } : {}) }; };
  const record = { url: '?seed=7&bots=0&gf-demo=feel.hit', input: 'touch points through the DevTools protocol (no mouse, no keys)', needs, holdable: hold.map(x => x.id), sizes: [], shots: [] };
  const sizesOn = async (P, tag, staged) => {
    for (const [W, H] of [...L.SIZES.slice(1), L.SIZES[0]]) {                 // the first size last: the fingers play there
      await P.p.setViewportSize({ width: W, height: H });
      await sleep(450);
      const s = await P.measure();
      m.sizes.push({ ...s, with: staged, needsTally: needsTally && !staged });
      const f = await shot(P.p, `touch-${W}x${H}${tag}`); if (f) record.shots.push(f);
    }
  };

  // ---- the layout at rest, then every action by fingers ----
  let P = null;
  try {
    // How to play, read from the menu at each size before the round (the first size last: the round is played there)
    const howToPlay = async (p, F) => {
      const tapOn = async sel => { const c = await p.evaluate(q => { const r = document.querySelector(q)?.getBoundingClientRect(); return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; }, sel); if (!c) return false; await F.tap(c.x, c.y); await sleep(280); return true; };
      if (!(await tapOn('#gf-how'))) { warnings.push('check 13 on forge, a phone: the menu has no How to play button to tap (#gf-how); its rows were not read'); return; }
      for (const [W, H] of [...L.SIZES.slice(1), L.SIZES[0]]) {
        await p.setViewportSize({ width: W, height: H }); await sleep(300);
        const h = await p.evaluate(HOW);
        if (h) m.how.push(h);
      }
      const f = await shot(p, 'touch-how-to-play'); if (f) record.shots.push(f);
      if (!(await tapOn('#gf-back'))) throw new Error('How to play has no back button to tap (#gf-back)');
    };
    P = await phone({ newPage, url, query: 'bots=0&gf-demo=feel.hit', label: 'a phone', patches, L, gameId, menu: howToPlay });
    await sleep(2400);                                              // the "Go!" banner and the opening grace
    const first = await P.measure();
    if (!first.buttons.length) throw new Error(`the page reports no touch buttons (the HUD's layout is "${first.layout}"): the forge touch layer is not there`);
    await sizesOn(P, '', null);
    const [W, H] = L.SIZES[0], F = P.F;
    const btn = async id => (await P.state()).buttons.find(b => b.id === id) ?? null;
    const centre = b => ({ x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 });
    const appears = async (id, ms = 2500) => { for (const t = Date.now(); Date.now() - t < ms; ) { const b = await btn(id); if (b?.there) return b; await sleep(90); } return null; };
    const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
    const turned = (a, b) => { let d = b.yaw - a.yaw; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return Math.abs(d); };
    const stickAt = { x: W * 0.17, y: H * 0.66 }, lookAt = { x: W * 0.58, y: H * 0.42 };

    // look: a drag on the right half, away from every button, and back again (the target stays ahead)
    if (needs.includes('look')) {
      const a = await P.state();
      await F.press(2, lookAt.x, lookAt.y); await F.drag(2, 96, 0, 8, 24); await sleep(160);
      const b = await P.state();
      await F.drag(2, -96, 0, 8, 24); await F.lift(2); await sleep(120);
      did('look', turned(a, b) >= L.LOOK_RAD, `a thumb dragged 96 px across the right half turned the view ${r2(turned(a, b))} rad (needs ${L.LOOK_RAD})`);
    }
    // move: a thumb on the left half; the stick is drawn where it landed and the player walks toward the target
    if (needs.includes('move')) {
      const a = await P.state();
      await F.press(1, stickAt.x, stickAt.y); await F.drag(1, 0, -58, 4); await sleep(820);
      const b = await P.state();
      await F.lift(1); await sleep(150);
      const under = b.stick ? Math.hypot(b.stick.x - stickAt.x, b.stick.y - stickAt.y) : null;
      did('move', dist(a, b) >= L.WALK_M && under !== null && under <= 12, under === null ? 'a thumb on the left half drew no stick' : under > 12 ? `the stick was drawn ${Math.round(under)} px from where the thumb landed` : `a thumb pushed up on the left half walked the player ${r2(dist(a, b))} m (needs ${L.WALK_M})`, 'a stick where the left thumb lands');
    }
    // the quick strike: its button is there with the target in reach. The walk above brought the player most of the
    // way; a few short pushes more until the button comes or the target is inside the blade's own reach. A target
    // that cannot be walked to (something of the arena stands between) is not a verdict against the game.
    if (needs.includes('strike')) {
      const reach = Number(weapons.find(w => w?.kind === 'melee')?.melee?.reach) || 2.2;
      let b = null, near = null;
      for (let i = 0; i < 12 && !b; i++) {
        const s = await P.state(); near = s.near; b = s.buttons.find(x => x.id === 'melee' && x.there) ?? null;
        if (b || (near !== null && near <= reach * 0.8)) break;
        await F.press(1, stickAt.x, stickAt.y); await F.drag(1, 0, -58, 3); await sleep(170); await F.lift(1); await sleep(110);
      }
      b ??= await appears('melee', 1500);
      if (!b && (near === null || near > reach)) { did('strike', true, `not judged: the staged target could not be walked to (${near === null ? 'no distance reported' : `${r1(near)} m away`})`, 'not judged: the staged target could not be reached'); warnings.push(`check 13 on forge, a phone: the quick strike's button was not judged, the staged target stayed ${near === null ? 'out of reach' : `${r1(near)} m away`} (the blade reaches ${reach} m)`); }
      else if (!b) did('strike', false, `with a target ${r1(near)} m away, inside the blade's ${reach} m, its button is not on the screen`);
      else {
        const c = centre(b); let swing = -1;
        await F.press(3, c.x, c.y);
        for (let i = 0; i < 10 && swing < 0; i++) { swing = (await P.state()).swing ?? -1; await sleep(25); }
        await F.lift(3); await sleep(500);
        did('strike', swing >= 0, swing >= 0 ? 'a tap swung' : 'a tap on its button swung nothing', 'there with a target in reach');
      }
    }
    // swap: a second weapon in hand; then until the weapon in hand has a magazine (something to fire and reload)
    if (needs.includes('swap')) {
      const b = await appears('swap', 1500), a = await P.state();
      if (!b) did('swap', false, `with ${hold.length} weapons in hand its button is not on the screen`);
      else {
        const c = centre(b); let other = null;
        await F.tap(c.x, c.y);
        for (const t = Date.now(); Date.now() - t < 2500 && other === null; ) { const s = await P.state(); if (s.weapon !== a.weapon) other = s.weapon; else await sleep(80); }
        did('swap', other !== null, other !== null ? 'a tap brought up another weapon' : 'a tap on its button brought up no other weapon');
        for (let i = 0; i < 4 && !(((await P.state()).magazine | 0) > 0) && needs.includes('reload'); i++) { await F.tap(c.x, c.y); await sleep(700); }
        await sleep(600);
      }
    }
    // fire: a tap where the fire button is (its touch goes through to the view, as a thumb's does)
    if (needs.includes('fire')) {
      const b = await appears('fire', 1000), a = await P.state();
      if (!b) did('fire', false, 'its button is not on the screen');
      else {
        const c = centre(b); let shots = a.shots ?? 0, swing = -1;
        await F.press(2, c.x, c.y);
        for (let i = 0; i < 14 && !(shots > (a.shots ?? 0)) && swing < 0; i++) { await sleep(40); const s = await P.state(); shots = s.shots ?? 0; swing = s.swing ?? -1; }
        await F.lift(2); await sleep(300);
        did('fire', shots > (a.shots ?? 0) || swing >= 0, shots > (a.shots ?? 0) ? 'a thumb on its button fired' : swing >= 0 ? 'a thumb on its button swung the weapon in hand' : 'a thumb on its button fired nothing');
      }
    }
    // reload: its button is there once a round is spent
    if (needs.includes('reload')) {
      const s0 = await P.state();
      if (!((s0.magazine | 0) > 0)) did('reload', false, 'no weapon with a magazine could be brought into the hand by the swap button');
      else {
        const b = await appears('reload', 2000);
        if (!b) did('reload', false, `with ${s0.ammo} of ${s0.magazine} rounds in the weapon its button is not on the screen`);
        else {
          const c = centre(b); let loading = 0;
          await F.tap(c.x, c.y);
          for (let i = 0; i < 12 && !loading; i++) { loading = (await P.state()).reloading ?? 0; await sleep(40); }
          did('reload', loading > 0, loading > 0 ? 'a tap reloads' : 'a tap on its button started no reload', 'there with rounds spent');
          await sleep(300);
        }
      }
    }
    if (needs.includes('jump')) {
      const b = await appears('jump', 1000), a = await P.state();
      if (!b) did('jump', false, 'its button is not on the screen');
      else {
        const c = centre(b); let top = a.y;
        await F.press(3, c.x, c.y);
        for (let i = 0; i < 12; i++) { top = Math.max(top, (await P.state()).y); await sleep(30); }
        await F.lift(3); await sleep(400);
        did('jump', top - a.y >= L.JUMP_RISE, `a tap lifted the player ${r2(top - a.y)} m (needs ${L.JUMP_RISE})`);
      }
    }
    if (needs.includes('evade')) {
      const b = await appears('evade', 1000);
      if (!b) did('evade', false, 'its button is not on the screen');
      else {
        // away from the target, the stick held: the evade throws the player where they are going
        await F.press(1, stickAt.x, stickAt.y); await F.drag(1, 0, 58, 3); await sleep(220);
        const a = await P.state(), c = centre(b); let evading = 0, cool = 0;
        await F.press(3, c.x, c.y); await sleep(50);
        for (let i = 0; i < 7; i++) { const s = await P.state(); evading = Math.max(evading, s.evading ?? 0); cool = Math.max(cool, s.evadeCool ?? 0); await sleep(30); }
        await F.lift(3); await F.lift(1); await sleep(200);
        did('evade', evading > 0 || cool > (a.evadeCool ?? 0) + 0.05, evading > 0 || cool > 0 ? 'a tap with the stick held threw the player' : 'a tap on its button did nothing');
      }
    }
  } catch (e) { m.stopped = e.message; }
  finally {
    await P?.F.all().catch(() => {});
    if (P?.T.errors.length) warnings.push(`the phone page console errors: ${[...new Set(P.T.errors)].slice(0, 2).join(' | ')}`);
    await P?.T.ctx.close().catch(() => {});
  }

  // ---- raise: beside a fallen friend ----
  if (needs.includes('raise') && !m.stopped) {
    let R = null;
    try {
      R = await phone({ newPage, url, query: 'bots=1&gf-demo=controls.revive', label: 'a phone, a fallen friend', patches: patches.slice(0, 1), L, gameId });
      let friend = null;
      for (const t = Date.now(); Date.now() - t < L.STAGE_MS && !friend; ) { await sleep(150); friend = (await R.p.evaluate(RUN).catch(() => [])).find(x => !x.local && x.down) ?? null; }
      if (!friend) did('raise', false, 'no fallen friend could be staged (the game made no second player, or it never went down)');
      else {
        await sleep(900);                                            // the player is put beside them
        const of = async () => (await R.p.evaluate(RUN).catch(() => [])).find(x => x.id === friend.id) ?? null;
        let b = null;
        for (const t = Date.now(); Date.now() - t < 2500 && !b; ) { const x = (await R.state()).buttons.find(q => q.id === 'use'); if (x?.there) b = x; else await sleep(90); }
        if (!b) did('raise', false, 'beside a fallen friend its button is not on the screen');
        else {
          await sizesOn(R, '-raise', 'beside a fallen friend');
          b = (await R.state()).buttons.find(q => q.id === 'use');
          const c = { x: b.rect.x + b.rect.w / 2, y: b.rect.y + b.rect.h / 2 }, hold = (Number(game.forge?.player?.revive?.time) || 2) * 1000 + 1500;
          let best = 0, up = false;
          const t1 = Date.now();
          await R.F.press(3, c.x, c.y);
          while (Date.now() - t1 < hold) { await sleep(100); const f = await of(); if (!f) continue; best = Math.max(best, f.revive); if (!f.down && f.alive) { up = true; break; } }
          await R.F.lift(3);
          did('raise', up || best >= L.REVIVE_MIN, up ? `a thumb held on its button brought the friend back up in ${r1((Date.now() - t1) / 1000)} s` : `a thumb held ${r1((Date.now() - t1) / 1000)} s on its button ran the raise to ${Math.round(best * 100)}%`, 'there beside a fallen friend');
        }
      }
    } catch (e) { did('raise', false, `the page stopped: ${e.message}`); }
    finally {
      await R?.F.all().catch(() => {});
      if (R?.T.errors.length) warnings.push(`the phone page (a fallen friend) console errors: ${[...new Set(R.T.errors)].slice(0, 2).join(' | ')}`);
      await R?.T.ctx.close().catch(() => {});
    }
  }

  // ---- the cart (v8): its staged moment at the three sizes ----
  if (hasCart && !m.stopped) {
    let C = null;
    m.cart = { sizes: [], stopped: null };
    try {
      C = await phone({ newPage, url, query: 'bots=0&gf-demo=cart', label: 'a phone, the cart', patches: patches.slice(0, 1), L, gameId });
      let up = false;
      for (const t = Date.now(); Date.now() - t < L.STAGE_MS && !up; ) { await sleep(200); up = !!(await C.p.evaluate(CART).catch(() => null))?.shown; }
      if (!up) m.cart.stopped = 'the cart did not open on its staged moment (?gf-demo=cart): the kit before v8 has none, or the game hides it';
      else {
        const measure = async () => ({ ...(await C.p.evaluate(CART)), text: await C.p.evaluate(CART_TEXT, L.CART_TEXT_PX) });
        for (const [W, H] of [...L.SIZES.slice(1), L.SIZES[0]]) {
          await C.p.setViewportSize({ width: W, height: H });
          await sleep(500);
          m.cart.sizes.push(await measure());
          const f = await shot(C.p, `touch-cart-${W}x${H}`); if (f) record.shots.push(f);
        }
        // a card chosen by a tap: the inspector's words at each size too
        const c1 = m.cart.sizes.at(-1)?.targets?.find(t => t.id === 'card-1');
        if (c1) {
          await C.F.tap(c1.rect[0] + c1.rect[2] / 2, c1.rect[1] + c1.rect[3] / 2); await sleep(450);
          for (const [W, H] of [...L.SIZES.slice(1), L.SIZES[0]]) {
            await C.p.setViewportSize({ width: W, height: H });
            await sleep(450);
            const c = await measure();
            if (c.chosen) m.cart.sizes.push(c);
            const f = await shot(C.p, `touch-cart-${W}x${H}-chosen`); if (f) record.shots.push(f);
          }
        }
      }
    } catch (e) { m.cart.stopped = `the page stopped: ${e.message}`; }
    finally {
      if (C?.T.errors.length) warnings.push(`the phone page (the cart) console errors: ${[...new Set(C.T.errors)].slice(0, 2).join(' | ')}`);
      await C?.T.ctx.close().catch(() => {});
    }
  }

  const j = judgeForgeTouch(m, L);
  record.cart = m.cart ? { stopped: m.cart.stopped, sizes: (j.carts ?? []).map((c, i) => ({ size: c.size, chosen: c.chosen, fails: c.fails.map(f => f.text), targets: m.cart.sizes[i].targets.map(t => ({ id: t.id, rect: t.rect })), cards: m.cart.sizes[i].cards, heading: m.cart.sizes[i].heading, text: m.cart.sizes[i].text ?? null })) } : null;
  record.tally = needsTally ? m.sizes.filter(s => !s.with).map(s => ({ size: s.size, ...s.tally })) : null;
  record.sizes = j.layouts.map((l, i) => ({ size: l.size, with: l.with, cover: r2(l.cover * 100), there: l.there, fails: l.fails.map(f => f.text), buttons: m.sizes[i].buttons.map(b => ({ id: b.id, there: b.there, x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) })), readouts: m.sizes[i].readouts.map(r => ({ id: r.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) })) }));
  record.howToPlay = (j.hows ?? []).map((h, i) => ({ size: h.size, fails: h.fails.map(f => f.text), rows: m.how[i].rows.map(r => ({ key: r.key, keyWidth: Math.round(r.kw ?? 0), words: r.words, x: Math.round(r.x), w: Math.round(r.w) })) }));
  record.did = m.did; record.stopped = m.stopped; record.limits = { coverMax: L.COVER_MAX, minPx: L.MIN_PX, middle: L.MIDDLE, howMin: L.HOW_MIN, tallyPx: L.TALLY_PX, cartPx: L.CART_PX, cartTextPx: L.CART_TEXT_PX }; record.seconds = Math.round((Date.now() - t0) / 1000);
  log(`  forge phone controls: ${j.ok ? 'ok' : 'FAIL'} ${j.detail.slice(0, 260)}`);
  return { ...j, warnings, record };
}
