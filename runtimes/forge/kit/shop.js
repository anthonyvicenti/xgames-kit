// gf-forge's pedlar's cart in the browser (wave 7, track P: coins worth spending; v8: one selection system), vendored
// into a game as gf/forge/shop.js (never edited there). The creator, 2026-10-12: "Also coins still cant be used for
// much"; asked what coins should buy, they chose the pedlar's cart between waves and paying to revive a friend. On v7:
// "The HUD/cart pop up is too small and hard to pick. We should also have a longer timer, 2 minutes. I think the old
// system where you pick 3 cards is still overlapping. We should only have one selection system. FInally, would love to
// see gold and score back on the display"; asked how cards and the cart become one, "Cart only, no free cards". The Rust
// core (forge-feel shop.rs) owns the purse, the cart, the three cards on show, the prices and every purchase; this draws
// the cart and the paid revive, and sends a player's choices in (a joiner's as the kit message 'fb' to the host).
//
//   const shop = createShop(ctx);       // ctx.forge (the host), ctx.ui (its root and cover), ctx.tables, ctx.players
//   shop.open({wave, resume, seconds, withReward})   // the host, when the wave director says the cart opens (gf/forge/
//                                                    // ai.js does): resume() is called once when it closes
//   shop.update(dt)                     // every frame, after the host's tick (every copy)
//   shop.buy(item, arg) / buyCard(slot) / select(slot) / leave() / raise(friend)   // what keys, the mouse and touch do
//   shop.observe()                      // what the screen shows (verify, the probe tools/pedlar.mjs)
//
// The cart (v8): one large panel over most of the screen, the game's input resting under it (the game's own cover).
//   heading   the cart's name, the purse (big, with its coin), the score, the time left (m:ss) and Done
//   cards     (a cart that sells cards: an item of kind card) three cards dealt for this player, drawn as the reward
//             drew them (gf/forge/cards.js cardFront: the picture, the rarity band, the family badge, the name and the
//             text), each with a Buy button and its price (its rarity's: spec.forge.shop's card item, `rare`, `epic`).
//             A card bought leaves its place empty ("Sold") until a fresh deal. Choosing a card (a tap, a click, its
//             key) shows the inspector: what it changes for this player, before → after
//   items     the other items as big tiles: name, price, a short line and the stock; greyed when this player cannot
//             buy one (too dear, sold out, nothing to use it on). A whetstone or the salts with more than one choice
//             open a big chooser over the cards (each card it can hone with what one more step changes), with Back
// Keys: 1–3 choose a card and the same key again buys it; the items' keys follow (4…); Enter buys the card chosen (and
// says why not when it cannot), and with nothing chosen is Done; Esc lets go of the card chosen or backs out of a
// chooser, and with nothing chosen does nothing (it never leaves the cart). A card's face only chooses it: Buy (or its
// key twice, or Enter) buys. For CART_GUARD_MS after the cart opens, and after a fresh deal, it takes no click, tap or
// key: a fight's last shots never buy or leave (review of v8). Sizes follow the screen (`--u`: 1 px at 1280×720) with
// floors for a phone: every touch target is at least 56 px tall, no text under 12 px on a phone or 14 px with a mouse
// (CART_TEXT_MIN), and a card is never smaller than the reward's card was on that screen.
// A greyed item says why on its tile ("Full health", "Need 4 more", "Nothing to hone", "Sold out"); the revive is not
// shown to a player alone. A price that rose this visit shows the old one struck through, and one line says each card
// bought raises the next one's price. In the last CART_WARN_S seconds the heading counts down ("The cart leaves in 9…").
// On a phone held sideways the inspector takes the items' place while a card is chosen (Back, or Buy, returns).
// The cart closes when every player has pressed Done or its time is up (spec.forge.shop.seconds: Zombie Town's is two
// minutes); a player who pressed Done walks again and sees who is still shopping, with the time left.
//
// On a wave whose reward also opens (a game with both), the reward's three are the cards: the cart shows its items in a
// strip under them and its own card section stays shut (one screen, one timer, as wave 7 had it).
//
// The paid revive: while a friend is down in a fight, a small button at the top right under the friends' list: "Pay to
// raise Ana · 6", with its key (G); greyed while the purse is short. A revive by holding interact beside them stays free.
//
// Every word is a slot (spec.forge.shop.text, an item's name and text; the inspector's are spec.forge.deal.text), every
// colour a theme variable with a fallback, every sound an id in the shop table (gf-audio presets: shop-open, shop-buy,
// shop-deny).
import { net } from '../mp/net.js';
import { ensureCardCss, cardFront, createInspector, changeRow, weaponWords, fmt as fmtRow } from './cards.js';

/** forge-feel's command ops for the cart (forge_feel::op). */
export const SHOP_OP = { SHOP: 88, BUY: 89 };
/** op BUY's item for leaving the cart: Done (forge-feel shop.rs LEAVE). */
export const SHOP_ITEM = { LEAVE: 255 };
/** The paid revive's key in a fight. */
export const RAISE_KEY = 'KeyG';
/** The least height of anything a thumb presses in the cart, px (verify check 13's phone leg holds it). */
export const CART_MIN_TARGET = 56;
/** For this long after the cart opens (and after a fresh deal) it takes no click, tap or key, ms: the cart opens the
 *  instant the last enemy falls, with the mouse wherever the fight left it, and two shots more bought a card in the
 *  review of v8 (research/gf-forge/evidence/zombie-town-v8-ux-review-2026-10-12). Verify check 13 holds it. */
export const CART_GUARD_MS = 600;
/** The least size of the cart's text, CSS px: on a phone (a coarse pointer) and with a mouse (check 13 holds both). */
export const CART_TEXT_MIN = { phone: 12, desktop: 14 };
/** The seconds left when the cart starts counting down in its heading ("The cart leaves in 9…"). */
export const CART_WARN_S = 10;
/** An item's price as the core works it out (forge-feel shop.rs price_x: round(price × x × perLap^lap ×
 *  perBuy^bought), the table's values as 32-bit floats and their clamps). (pure) */
export function priceOf(it = {}, lap = 0, bought = 0, x = 1) {
  const f = Math.fround, n = (v, d, lo, hi) => { const k = Number(v); return f(Math.max(lo, Math.min(hi, Number.isFinite(k) ? k : d))); };
  const p = n(it.price, 10, 0, 65535) * f(x) * n(it.perLap, 1.3, 1, 10) ** Math.min(200, lap) * n(it.perBuy, 1.5, 1, 10) ** Math.min(200, bought);
  return Number.isFinite(p) ? Math.max(0, Math.round(p)) : null;
}
const RARITY = ['common', 'rare', 'epic'];

const CSS = `
#gf-forge-cart{position:absolute;inset:0;display:none;align-items:center;justify-content:center;z-index:7;pointer-events:auto;font-family:var(--gf-forge-serif,Georgia,"Times New Roman",serif);color:var(--gf-forge-parchment,#e4d2b7);--accent:var(--gf-forge-accent,#d3a446);--ink:var(--gf-forge-ink,#0c0907);--paper:var(--gf-forge-parchment,#e4d2b7);--u:min(.078125vw,.138889vh);--m:max(8px,calc(16 * var(--u)));--tap:56px;--fmin:14px;user-select:none;-webkit-user-select:none;touch-action:manipulation}
#gf-forge-cart.on{display:flex}
#gf-forge-cart .gfc-dim{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(40,20,9,.74) 0%,rgba(10,7,5,.92) 72%,rgba(4,3,2,.96) 100%)}
#gf-forge-cart .gfc-panel{position:relative;box-sizing:border-box;width:min(max(calc(1180 * var(--u)),min(100vw,900px)),calc(100vw - 2 * var(--m) - env(safe-area-inset-left) - env(safe-area-inset-right)));height:calc(100% - 2 * var(--m) - env(safe-area-inset-top) - env(safe-area-inset-bottom));display:flex;flex-direction:column;gap:max(6px,calc(12 * var(--u)));padding:max(8px,calc(16 * var(--u))) max(8px,calc(20 * var(--u)));background:linear-gradient(180deg,rgba(32,21,12,.97),rgba(14,10,7,.97));border:1px solid color-mix(in srgb,var(--accent) 55%,transparent);border-radius:8px;box-shadow:0 12px 40px #000d,inset 0 0 0 1px #0008}
#gf-forge-cart button{font:inherit;color:inherit;cursor:pointer;-webkit-tap-highlight-color:transparent;margin:0}
#gf-forge-cart kbd{display:inline-block;font:700 max(var(--fmin),calc(12 * var(--u)))/1 ui-monospace,Menlo,monospace;padding:2px 5px;border:1px solid #ffffff55;border-radius:3px;background:#0c0907;color:var(--paper)}
#gf-forge-cart .gfc-head{flex:none;display:flex;align-items:center;gap:max(8px,calc(18 * var(--u)));min-height:var(--tap)}
#gf-forge-cart .gfc-titles{flex:1;min-width:0;line-height:1.15}
#gf-forge-cart .gfc-title{display:block;font-size:max(16px,calc(30 * var(--u)));font-weight:700;letter-spacing:.03em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gf-forge-cart .gfc-sub{display:block;font-size:max(var(--fmin),calc(15 * var(--u)));font-style:italic;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gf-forge-cart .gfc-stat{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1;min-width:max(52px,calc(80 * var(--u)))}
#gf-forge-cart .gfc-stat em{font-style:normal;font-size:max(var(--fmin),calc(13 * var(--u)));letter-spacing:.14em;text-transform:uppercase;opacity:.72;margin-bottom:max(3px,calc(6 * var(--u)));white-space:nowrap}
#gf-forge-cart .gfc-stat b{font-size:max(22px,calc(38 * var(--u)));font-weight:800;font-variant-numeric:tabular-nums;white-space:nowrap}
#gf-forge-cart .gfc-purse b{color:var(--accent)}
#gf-forge-cart .gfc-purse b::before,#gf-forge-cart .gfc-coin::before,#gf-ui .gf-forge-raise .gfc-p::before{content:"";display:inline-block;width:.62em;height:.62em;margin-right:.28em;border-radius:50%;box-shadow:inset 0 0 0 .13em var(--accent,#d3a446),0 0 0 1px #000c;background:radial-gradient(circle,var(--accent,#d3a446) 0 .12em,transparent .15em);vertical-align:.02em}
#gf-forge-cart .gfc-clock b.low{color:#ff8a70}
#gf-forge-cart .gfc-done{flex:none;min-height:var(--tap);min-width:max(96px,calc(150 * var(--u)));padding:0 max(14px,calc(22 * var(--u)));font-weight:700;font-size:max(16px,calc(22 * var(--u)));background:var(--accent);color:#14100b;border:1px solid #14100b;border-radius:4px;white-space:nowrap}
#gf-forge-cart .gfc-done kbd{margin-left:8px;background:transparent;color:#14100b;border-color:#14100b66}
#gf-forge-cart .gfc-body{position:relative;flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1.5fr) minmax(0,1fr);gap:max(8px,calc(20 * var(--u)))}
#gf-forge-cart .gfc-body.nocards{grid-template-columns:minmax(0,1fr)}
#gf-forge-cart .gfc-body.nocards .gfc-cards{display:none}
#gf-forge-cart .gfc-cards{min-width:0;min-height:0;display:flex;align-items:center;justify-content:center;gap:var(--cg,12px)}
#gf-forge-cart .gfc-slot{flex:none;width:var(--cw,160px);display:flex;flex-direction:column;align-items:stretch;gap:max(6px,calc(10 * var(--u)))}
#gf-forge-cart .gfc-slot .gfr-card{--lift:0px;width:var(--cw,160px);height:var(--ch,260px);max-width:none;transform:translateY(calc(-1 * var(--lift)));transition:transform .16s cubic-bezier(.2,.8,.3,1)}
#gf-forge-cart .gfc-slot .gfr-card .gfr-flip{transform:none;transition:none}
#gf-forge-cart .gfc-slot .gfr-card.hover{--lift:max(2px,calc(6 * var(--u)))}
#gf-forge-cart .gfc-slot .gfr-card.sel{--lift:max(4px,calc(12 * var(--u)))}
#gf-forge-cart .gfc-slot .gfr-sign.pic{height:var(--pic,44%)}
#gf-forge-cart .gfc-slot .gfr-band{font-size:max(var(--fmin),calc(var(--cw,160px) * .06))}
#gf-forge-cart .gfc-slot .gfr-fam{font-size:max(var(--fmin),calc(var(--cw,160px) * .054));white-space:normal;flex-wrap:wrap;row-gap:0;text-align:center;line-height:1.15;letter-spacing:.04em}
#gf-forge-cart .gfc-slot .gfr-name{font-size:max(var(--fmin),calc(var(--cw,160px) * .085))}
#gf-forge-cart .gfc-slot .gfr-text{font-size:max(var(--fmin),calc(var(--cw,160px) * .062))}
#gf-forge-cart .gfc-sold{width:var(--cw,160px);height:var(--ch,260px);box-sizing:border-box;display:flex;align-items:center;justify-content:center;border:2px dashed #ffffff30;border-radius:6px;font-size:max(14px,calc(var(--cw,160px) * .09));font-style:italic;opacity:.62}
#gf-forge-cart .gfc-buy{min-height:var(--tap);width:100%;display:flex;flex-wrap:wrap;align-items:center;align-content:center;justify-content:center;gap:0 .5em;font-weight:700;font-size:max(15px,calc(20 * var(--u)));background:var(--accent);color:#14100b;border:1px solid #14100b;border-radius:4px;white-space:nowrap;overflow:hidden}
#gf-forge-cart .gfc-buy .gfc-coin::before{box-shadow:inset 0 0 0 .13em #14100b;background:radial-gradient(circle,#14100b 0 .12em,transparent .15em)}
#gf-forge-cart .gfc-buy.no{background:#3a3128;color:#b4a184;border-color:#3a3128;cursor:default}
#gf-forge-cart .gfc-buy.no .gfc-coin::before{box-shadow:inset 0 0 0 .13em #ff9a80;background:radial-gradient(circle,#ff9a80 0 .12em,transparent .15em)}
#gf-forge-cart .gfc-buy.gone{visibility:hidden}
#gf-forge-cart .gfc-was{font-weight:600;opacity:.75;text-decoration:line-through;text-decoration-thickness:2px;font-variant-numeric:tabular-nums}
#gf-forge-cart .gfc-was:empty{display:none}
#gf-forge-cart .gfc-buy .why{flex-basis:100%;text-align:center;font-size:max(var(--fmin),calc(14 * var(--u)));font-weight:700;color:#ffb39f;line-height:1.15}
#gf-forge-cart .gfc-buy .why:empty{display:none}
#gf-forge-cart .gfc-rise{flex:none;font-size:max(var(--fmin),calc(14 * var(--u)));font-style:italic;opacity:.75;text-align:center;line-height:1.2}
#gf-forge-cart .gfc-rise:empty{display:none}
#gf-forge-cart .gfc-warn{display:none;font-size:max(16px,calc(26 * var(--u)));font-weight:800;color:#ff8a70;white-space:nowrap;animation:gfc-warn 1s ease-in-out infinite}
#gf-forge-cart .gfc-titles.warn .gfc-title,#gf-forge-cart .gfc-titles.warn .gfc-sub{display:none}
#gf-forge-cart .gfc-titles.warn .gfc-warn{display:block}
@keyframes gfc-warn{50%{opacity:.6}}
#gf-forge-cart .gfc-side{min-width:0;min-height:0;display:flex;flex-direction:column;gap:max(6px,calc(12 * var(--u)))}
#gf-forge-cart .gfc-look{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:max(6px,calc(10 * var(--u)))}
#gf-forge-cart .gfc-look .gfr-inspect{flex:1 1 auto;width:auto;height:auto;min-height:0;overflow:auto;font-size:max(var(--fmin),calc(16 * var(--u)))}
#gf-forge-cart .gfr-inspect h2 em,#gf-forge-cart .gfr-rows .hd{font-size:max(var(--fmin),.72em)}
#gf-forge-cart .gfr-rows s,#gf-forge-cart .gfr-rows i{font-size:max(var(--fmin),.86em)}
#gf-forge-cart .gfr-rows i.fam.bonus{color:inherit;font-weight:500;opacity:.85}
#gf-forge-cart .gfc-look .gfr-inspect h2{font-size:max(14px,calc(20 * var(--u)))}
#gf-forge-cart .gfc-look .gfr-rows{font-size:max(var(--fmin),calc(16 * var(--u)))}
#gf-forge-cart .gfc-look .gfr-inspect:not(.on){display:none}
#gf-forge-cart .gfc-hint{flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;text-align:center;padding:.6em;font-size:max(var(--fmin),calc(16 * var(--u)));font-style:italic;opacity:.6;border:1px dashed #ffffff22;border-radius:4px}
#gf-forge-cart .gfc-look.on .gfc-hint{display:none}
#gf-forge-cart .gfc-back{flex:none;min-height:var(--tap);padding:0 18px;border-radius:4px;background:rgba(12,9,7,.6);border:1px solid color-mix(in srgb,var(--paper) 45%,transparent);font-weight:700;font-size:max(15px,calc(19 * var(--u)))}
#gf-forge-cart .gfc-look .gfc-back{display:none}
#gf-forge-cart .gfc-items{flex:none;display:grid;grid-template-columns:minmax(0,1fr);gap:max(6px,calc(10 * var(--u)))}
#gf-forge-cart .gfc-item,#gf-forge-cart .gfc-choice{position:relative;min-height:max(var(--tap),calc(76 * var(--u)));box-sizing:border-box;display:grid;grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto;gap:2px 12px;align-content:center;text-align:left;padding:max(6px,calc(10 * var(--u))) max(10px,calc(16 * var(--u)));border-radius:5px;background:rgba(228,210,183,.08);border:1px solid #ffffff2c}
#gf-forge-cart .gfc-item:hover,#gf-forge-cart .gfc-choice:hover{border-color:var(--accent);background:rgba(211,164,70,.14)}
#gf-forge-cart .gfc-item .n,#gf-forge-cart .gfc-choice .n{font-size:max(14px,calc(20 * var(--u)));font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#gf-forge-cart .gfc-item .gfc-price{text-align:right;white-space:nowrap}
#gf-forge-cart .gfc-item .gfc-coin{font-size:max(16px,calc(22 * var(--u)));font-weight:800;color:var(--accent);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
#gf-forge-cart .gfc-item .gfc-was{font-size:max(var(--fmin),calc(16 * var(--u)));margin-right:.2em}
#gf-forge-cart .gfc-item .t,#gf-forge-cart .gfc-choice .t{font-size:max(var(--fmin),calc(14 * var(--u)));opacity:.75;line-height:1.2;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
#gf-forge-cart .gfc-item .s{font-size:max(var(--fmin),calc(14 * var(--u)));opacity:.75;text-align:right;white-space:nowrap;align-self:end}
#gf-forge-cart .gfc-item.gone{display:none}
#gf-forge-cart .gfc-item.no .s{opacity:1;color:#ffb39f;font-weight:700}
#gf-forge-cart .gfc-item kbd,#gf-forge-cart .gfc-choice kbd{position:absolute;top:-8px;left:-5px;opacity:.9}
#gf-forge-cart .gfc-item.no{opacity:.6}
#gf-forge-cart .gfc-item.no .gfc-coin{color:#ff9a80}
#gf-forge-cart .gfc-item.got,#gf-forge-cart .gfc-slot.got .gfc-buy{animation:gfc-got .4s ease-out}
@keyframes gfc-got{0%{box-shadow:0 0 0 0 var(--accent)}100%{box-shadow:0 0 0 12px transparent}}
#gf-forge-cart .gfc-pick{position:absolute;inset:0;z-index:3;display:none;flex-direction:column;gap:max(8px,calc(14 * var(--u)));padding:max(8px,calc(14 * var(--u)));box-sizing:border-box;background:rgba(18,13,9,.98);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:6px}
#gf-forge-cart.picking .gfc-pick{display:flex}
#gf-forge-cart .gfc-pick-head{flex:none;display:flex;align-items:center;gap:12px}
#gf-forge-cart .gfc-pick-head b{flex:1;min-width:0;font-size:max(16px,calc(26 * var(--u)))}
#gf-forge-cart .gfc-choices{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(max(230px,calc(300 * var(--u))),1fr));gap:max(8px,calc(12 * var(--u)));align-content:start;padding-top:8px}
#gf-forge-cart .gfc-choice{--c:#e4d2b7;border-color:color-mix(in srgb,var(--c) 70%,transparent);min-height:max(64px,calc(92 * var(--u)));grid-template-columns:minmax(0,1fr);grid-template-rows:auto}
#gf-forge-cart .gfc-choice .n{white-space:normal}
#gf-forge-cart .gfc-choice .r{font-size:max(var(--fmin),calc(13 * var(--u)));letter-spacing:.1em;text-transform:uppercase;color:var(--c);white-space:nowrap;text-align:left}
#gf-forge-cart .gfc-choice .t{grid-column:1/-1;-webkit-line-clamp:3}
#gf-forge-cart .gfc-foot{flex:none;display:flex;justify-content:center;font-size:max(var(--fmin),calc(14 * var(--u)));opacity:.6;text-align:center}
#gf-forge-cart .gfc-note{position:absolute;left:var(--nx,50%);top:var(--ny,auto);bottom:var(--nb,auto);width:var(--nw,auto);height:var(--nh,auto);transform:var(--nt,none);box-sizing:border-box;z-index:4;display:flex;align-items:center;justify-content:center;text-align:center;padding:.2em .6em;border-radius:4px;background:rgba(12,9,7,.94);border:1px solid #ff9a8088;color:#ffb39f;font-weight:700;font-size:max(var(--fmin),calc(17 * var(--u)));pointer-events:none}
#gf-forge-cart .gfc-note:empty{display:none}
#gf-forge-cart.shared{align-items:flex-end}
#gf-forge-cart.shared .gfc-dim{display:none}
#gf-forge-cart.shared .gfc-panel{height:auto;max-height:40%;margin-bottom:var(--m)}
#gf-forge-cart.shared .gfc-body{grid-template-columns:minmax(0,1fr)}
#gf-forge-cart.shared .gfc-cards,#gf-forge-cart.shared .gfc-look{display:none}
#gf-forge-cart.shared .gfc-items{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
#gf-ui.gf-cart-up #gf-forge-reward .gfr-wrap{bottom:var(--gf-cart-h,130px)}
#gf-ui.gf-cart-up #gf-forge-reward .gfr-sign{flex:1 1 0;height:auto;min-height:0}
#gf-ui.gf-cart-up #gf-forge-reward .gfr-text{flex:none}
@media (max-aspect-ratio:3/4){
#gf-forge-cart .gfc-head{flex-wrap:wrap;row-gap:6px}
#gf-forge-cart .gfc-titles{flex:1 0 100%}
#gf-forge-cart .gfc-stat{flex:1}
#gf-forge-cart .gfc-body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
#gf-forge-cart .gfc-look{flex:0 1 auto}
#gf-forge-cart .gfc-look .gfr-inspect{flex:0 1 auto}
#gf-forge-cart .gfc-items{grid-template-columns:minmax(0,1fr)}
#gf-forge-cart .gfc-item{grid-template-columns:minmax(0,1fr) auto;padding:6px 10px}
#gf-forge-cart .gfc-hint{display:none}
}
@media (max-height:480px){
#gf-forge-cart .gfc-sub{display:none}
#gf-forge-cart .gfc-foot{display:none}
#gf-forge-cart .gfc-item{padding:4px 10px;gap:0 10px}
#gf-forge-cart .gfc-look{display:none}
#gf-forge-cart.peek .gfc-look{display:flex}
#gf-forge-cart.peek .gfc-items{display:none}
#gf-forge-cart.peek .gfc-look .gfc-back{display:block}
}
@media (pointer:coarse){#gf-forge-cart{--fmin:12px}#gf-forge-cart kbd,#gf-forge-cart .gfc-foot,#gf-ui .gf-forge-raise kbd{display:none}#gf-forge-cart .gfc-stat em{letter-spacing:.08em}}
#gf-ui .gf-forge-waitcart{position:absolute;left:50%;top:max(104px,14vh,calc(env(safe-area-inset-top) + 104px));transform:translateX(-50%);display:none;padding:6px 14px;border-radius:3px;background:rgba(12,9,7,.78);font:italic 15px/1.2 var(--gf-forge-serif,Georgia,serif);color:var(--gf-forge-parchment,#e4d2b7);pointer-events:none;white-space:nowrap;z-index:5}
#gf-ui .gf-forge-waitcart.on{display:block}
#gf-ui .gf-forge-raise{position:absolute;right:max(14px,env(safe-area-inset-right));top:var(--gf-raise-top,96px);display:none;align-items:center;gap:8px;min-height:36px;padding:0 12px;border-radius:18px;background:rgba(12,9,7,.8);border:1px solid color-mix(in srgb,var(--gf-forge-accent,#d3a446) 60%,transparent);font:700 14px/1 var(--gf-forge-serif,Georgia,serif);color:var(--gf-forge-parchment,#e4d2b7);pointer-events:auto;cursor:pointer;z-index:5;white-space:nowrap;-webkit-tap-highlight-color:transparent;--accent:var(--gf-forge-accent,#d3a446)}
#gf-ui .gf-forge-raise.on{display:flex}
#gf-ui .gf-forge-raise.no{opacity:.5}
#gf-ui .gf-forge-raise.no .gfc-p{color:#ff9a80}
#gf-ui .gf-forge-raise kbd{font:700 12px/1 ui-monospace,Menlo,monospace;padding:2px 5px;border:1px solid #ffffff55;border-radius:3px}
@media (pointer:coarse){#gf-ui .gf-forge-raise{min-height:48px;border-radius:24px}}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fill = (s, vars) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const say = (e, t) => { if (e.textContent !== t) e.textContent = t; };
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
const fmt = v => (Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString());
/** Seconds as the clock shows them: 1:58, 0:09. */
export const clockText = s => { const n = Math.max(0, Math.ceil(s)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
const rectOf = b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };

export function createShop(ctx, { host = ctx.forge, root = ctx.ui?.root } = {}) {
  const forge = host?.forge;
  if (!host || !forge?.feel_shop_state || !root) return null;
  const T = ctx.tables ?? {}, SH = T.shop ?? {}, items = Array.isArray(SH.items) ? SH.items : [], W = SH.text ?? {}, S = SH.sounds ?? {}, cards = Array.isArray(T.cards) ? T.cards : [];
  const DW = T.deal?.text ?? {};
  const reviveRow = items.findIndex(i => i?.kind === 'revive');
  // the item whose kind is card: the three on show and their prices (none: a cart of items alone)
  const cardRow = items.findIndex(i => i?.kind === 'card');
  // the items drawn as tiles (every one but the cards)
  const tiles = items.map((it, row) => ({ it, row })).filter(x => x.it?.kind !== 'card');
  if (!document.getElementById('gf-forge-cart-css')) { const s = el('style'); s.id = 'gf-forge-cart-css'; s.textContent = CSS; document.head.append(s); }
  ensureCardCss();
  const word = (k, d) => (typeof W[k] === 'string' && W[k] ? W[k] : d);
  const dealWord = (k, d) => (typeof DW[k] === 'string' && DW[k] ? DW[k] : d);
  const weaponWordsOf = w => weaponWords(ctx, w);
  const play = id => { if (id) ctx.audio?.play(id, { optional: true }); };
  const nidOf = () => ctx.players?.nid?.(ctx.me?.id) ?? 0;
  const nameOf = nid => ctx.players?.byNid?.(nid)?.name ?? `Player ${nid}`;
  const scoreOf = () => Math.round(Number((ctx.watched?.() ?? ctx.me)?.score) || 0);
  // The cart as an object, from the core's numbers for every frame (forge-feel shop.rs `state`: the cart, the purse,
  // the three on show, this visit's purchases, the hone levels, the three's prices) and the run (forge.feel_run: the
  // cards held, who is down, the reward). What can be bought is worked out here as the core checks it; the core still
  // checks every purchase (a refusal is `buy-refused`). Numbers, not JSON, keep the wasm small.
  const RAR = { common: 0, rare: 1, epic: 2 };
  // the most cards a hand holds (forge-feel cards.rs MAX_CARDS): a full hand is dealt nothing and buys none
  const HAND_MAX = 32;
  const runOf = () => { try { return JSON.parse(forge.feel_run()); } catch { return null; } };
  const read = (n = nidOf()) => {
    let f; try { f = forge.feel_shop_state(n); } catch { return null; }
    if (!f || f.length < 13) return null;
    const b = x => x > 0.5, opt = x => (x < 0 ? null : x), run = runOf(), me = run?.players?.find(p => p.id === n) ?? null;
    const ni = f[12], bought = Array.from(f.slice(13, 13 + ni)), nh = f[13 + ni] ?? 0, levels = Array.from(f.slice(14 + ni, 14 + ni + nh));
    const at = 14 + ni + nh, prices = f.length >= at + 3 ? [opt(f[at]), opt(f[at + 1]), opt(f[at + 2])] : [null, null, null];
    const d = { on: !!SH.on, open: b(f[0]), wave: f[7], visit: f[5], lap: f[6], left: Math.round(f[1] * 100) / 100, seconds: Math.round((f[8] || Number(SH.seconds) || 0) * 100) / 100, withReward: b(f[4]), purse: f[3], inCart: b(f[2]), offers: [opt(f[9]), opt(f[10]), opt(f[11])], prices, items: [], cards: [], hone: [], down: [], visitors: [] };
    // the cards a whetstone can raise: upgrades held, below epic (a common twice, a rare once)
    (me?.cards ?? []).forEach((row, pos) => { const c = cards[row], lv = levels[pos] ?? 0, r = RAR[c?.rarity ?? 'common'] ?? 0; if (c && (c.kind ?? 'upgrade') === 'upgrade' && (c.stat || c.stat2) && r + lv < 2) d.hone.push({ pos, card: row, rarity: r + lv, level: lv }); });
    const revive = reviveRow >= 0 ? forge.feel_shop_price(n, reviveRow) : NaN;
    for (const p of run?.players ?? []) if (p.id !== n && p.down) d.down.push({ id: p.id, price: Number.isFinite(revive) ? revive : null });
    if (d.open) for (const p of run?.players ?? []) { const v = p.id === n ? f : forge.feel_shop_state(p.id); d.visitors.push({ player: p.id, inCart: v[2] > 0.5, purse: v[3] }); }
    const alive = !!me && me.alive !== false, room = (me?.cards?.length ?? 0) < HAND_MAX;
    const choosing = !!run?.reward?.open && run.reward.choices?.find(c => c.player === n)?.state === 'choosing';
    items.forEach((it, i) => {
      const price = forge.feel_shop_price(n, i), got = bought[i] ?? 0, stock = Number(it.stock) || 0, afford = d.purse >= price;
      const target = it.kind === 'card' ? room && d.offers.some(x => x !== null) : it.kind === 'reroll' ? choosing || (cardRow >= 0 && room) : it.kind === 'heal' ? alive && me.hp < me.hpMax - 1e-3 : it.kind === 'hone' ? d.hone.length > 0 : it.kind === 'revive' ? alive && d.down.length > 0 : false;
      const was = got > 0 && priceOf(it, d.lap, got) === price ? priceOf(it, d.lap, 0) : null;
      d.items.push({ row: i, id: it.id, kind: it.kind, price, was: was !== null && was < price ? was : null, bought: got, stock, left: stock ? Math.max(0, stock - got) : null, afford, target, can: (it.kind === 'revive' || d.inCart) && (!stock || got < stock) && afford && target });
    });
    if (cardRow >= 0) {
      const ci = d.items[cardRow];
      d.offers.forEach((row, slot) => {
        const price = d.prices[slot], afford = price !== null && d.purse >= price;
        // the price before any card was bought this visit (the core's own sum, priceOf), when this one rose
        const x = row === null ? 1 : [1, Number(items[cardRow].rare) || 1.5, Number(items[cardRow].epic) || 2.2][RAR[cards[row]?.rarity ?? 'common'] ?? 0];
        const was = row !== null && ci.bought > 0 && priceOf(items[cardRow], d.lap, ci.bought, x) === price ? priceOf(items[cardRow], d.lap, 0, x) : null;
        d.cards.push({ slot, row, id: row === null ? null : cards[row]?.id ?? null, price, was: was !== null && was < price ? was : null, afford, room, can: row !== null && price !== null && d.inCart && !d.withReward && room && (!ci.stock || ci.bought < ci.stock) && afford });
      });
    }
    return d;
  };
  /** What one more hone of the card at `pos` changes for this player: the first value it moves, before → after. */
  const honePreview = pos => {
    const n = nidOf(), me = runOf()?.players?.find(p => p.id === n), row = me?.cards?.[pos], c = cards[row] ?? null;
    if (!c) return null;
    const held = new Set(me.weapons ?? []), paths = [];
    for (const st of [c.stat, c.stat2]) {
      if (!st) continue;
      const m = /^weapons\.\*\.(.+)$/.exec(st);
      if (m) (T.weapons ?? []).forEach((w, r) => { if (held.has(r)) paths.push(`weapons.${w.id}.${m[1]}`); });
      else paths.push(st);
    }
    for (const path of paths) { const before = forge.feel_value(n, path), after = forge.feel_hone_value(n, pos, path); if (Number.isFinite(before) && Number.isFinite(after) && before !== after) return { path, before, after }; }
    return null;
  };

  // ---- the panel ----
  const box = el('div'); box.id = 'gf-forge-cart';
  const dim = el('div', 'gfc-dim'), panel = el('div', 'gfc-panel');
  const head = el('div', 'gfc-head'), titles = el('div', 'gfc-titles'), title = el('b', 'gfc-title'), sub = el('span', 'gfc-sub'), warn = el('b', 'gfc-warn');
  titles.append(title, sub, warn);
  const stat = (cls, label) => { const e = el('div', `gfc-stat ${cls}`), em = el('em', null, label), b = el('b'); e.append(em, b); return { e, em, b }; };
  const purseS = stat('gfc-purse', ''), scoreS = stat('gfc-score', ''), clockS = stat('gfc-clock', '');
  const doneBtn = el('button', 'gfc-done'); doneBtn.type = 'button'; doneBtn.id = 'gf-forge-cart-leave';
  head.append(titles, purseS.e, scoreS.e, clockS.e, doneBtn);
  const body = el('div', 'gfc-body'), cardsBox = el('div', 'gfc-cards'), side = el('div', 'gfc-side');
  const look = el('div', 'gfc-look'), hint = el('div', 'gfc-hint'), backBtn = el('button', 'gfc-back'); backBtn.type = 'button';
  const insp = createInspector(ctx, { forge, T, word: dealWord, nidOf });
  look.append(insp.el, hint, backBtn);
  const list = el('div', 'gfc-items'), rise = el('div', 'gfc-rise');
  side.append(look, list, rise);
  const pick = el('div', 'gfc-pick'), pickHead = el('div', 'gfc-pick-head'), pickTitle = el('b'), pickBack = el('button', 'gfc-back'), choices = el('div', 'gfc-choices');
  pickBack.type = 'button'; pickHead.append(pickTitle, pickBack); pick.append(pickHead, choices);
  body.append(cardsBox, side, pick);
  const foot = el('div', 'gfc-foot'), note = el('div', 'gfc-note');
  panel.append(head, body, foot, note);
  box.append(dim, panel);
  root.append(box);
  const waitEl = el('div', 'gf-forge-waitcart'); root.append(waitEl);
  const raiseEl = el('button', 'gf-forge-raise'); raiseEl.type = 'button'; raiseEl.id = 'gf-forge-raise';
  const raiseText = el('span'), raisePrice = el('span', 'gfc-p'), raiseKey = el('kbd', null, 'G');
  raiseEl.append(raiseText, raisePrice, raiseKey); root.append(raiseEl);

  // ---- state ----
  // mode: items (the cart) · hone (which card) · revive (which friend); sel: the card chosen (its place), hover: under
  // the mouse; peek: on a phone held sideways, the inspector in the items' place
  // armedAt: no click, tap or key acts before it (CART_GUARD_MS after the cart opened or the three were dealt again);
  // downAt: when the last press on the cart began (a click whose press began before armedAt is not taken); ignored:
  // what the guard kept from acting (for verify and the probe)
  const st = { shown: false, visit: -1, mode: 'items', sel: -1, hover: -1, data: null, lastRead: 0, botRead: 0, resume: null, last: null, locked: false, noteUntil: 0, bought: [], refused: [], raise: null, opened: 0, leftAt: 0, sent: null, sig: '', slots: [], tileEls: [], shownTiles: tiles, fitKey: '', openedAt: 0, armedAt: 0, downAt: -1, ignored: [], first: {} };
  const botLeaves = new Map();
  /** A short note (why something could not be bought) laid over the thing pressed (`on`: its element), else over the
   *  cards' row: never over the key line (review of v8). */
  const noteSay = (t, secs = 1.6, on = null) => {
    say(note, t); st.noteUntil = performance.now() + secs * 1000;
    const pr = panel.getBoundingClientRect(), r = on?.isConnected ? on.getBoundingClientRect() : null;
    const set = (k, v) => note.style.setProperty(k, v);
    if (r && r.width > 0) { set('--nx', `${Math.round(r.left - pr.left)}px`); set('--ny', `${Math.round(r.top - pr.top)}px`); set('--nw', `${Math.round(r.width)}px`); set('--nh', `${Math.round(r.height)}px`); set('--nb', 'auto'); set('--nt', 'none'); }
    else { set('--nx', '50%'); set('--ny', 'auto'); set('--nw', 'auto'); set('--nh', 'auto'); set('--nb', `${Math.round(Math.max(8, foot.offsetHeight + 12))}px`); set('--nt', 'translateX(-50%)'); }
  };
  const firstItemKey = () => (cardRow >= 0 ? 4 : 1);
  const itemKey = i => { const k = firstItemKey() + i; return k <= 9 ? k : null; };
  /** Is the cart still in its opening guard (or its fresh deal's)? */
  const guarded = () => performance.now() < st.armedAt;
  const arm = () => { st.armedAt = performance.now() + CART_GUARD_MS; };

  /** This player's purchase or Done (item: a row or SHOP_ITEM.LEAVE): the host's core decides. */
  function send(item, arg = 0) {
    if (ctx.host || !net.active) host.cmd.raw(SHOP_OP.BUY, [nidOf(), item >>> 0, arg >>> 0]);
    else net.send('fb', { i: item, a: arg }, 'host');
  }
  /** Why this player cannot buy item `it` now, in the words a tile shows ('' when they can). */
  const why = it => {
    if (!it || it.can) return '';
    if (it.left === 0) return word('soldOut', 'Sold out');
    if (!it.target) return it.kind === 'heal' ? word('full', 'Full health') : it.kind === 'hone' ? word('noHone', 'Nothing to hone') : it.kind === 'revive' ? word('noneDown', 'No friend is down') : it.kind === 'reroll' || it.kind === 'card' ? word('handFull', 'Your hand is full') : word('none', 'Nothing to use it on');
    if (!it.afford) return fill(word('need', 'Need {n} more'), { n: Math.max(1, it.price - (st.data?.purse ?? 0)) });
    return word('none', 'Nothing to use it on');
  };
  /** Why this player cannot buy the card on show `c` ('' when they can). */
  const whyCard = c => (!c || c.can || c.row === null ? '' : c.room === false ? word('handFull', 'Your hand is full') : !c.afford ? fill(word('need', 'Need {n} more'), { n: Math.max(1, (c.price ?? 0) - (st.data?.purse ?? 0)) }) : word('none', 'Nothing to use it on'));

  /** Buy item `i` (a row or an id); `arg`: a card's place among the three, a hone's card by its place in the hand, a
   *  revive's friend. A whetstone or the salts with more than one choice open the chooser. */
  function buy(i, arg) {
    const r = typeof i === 'number' ? i : items.findIndex(x => x.id === i);
    const d = st.data ?? read(), it = d?.items?.[r];
    if (!it) return false;
    if (it.kind === 'card') return buyCard(arg ?? 0);
    if (!it.can) { play(S.deny); noteSay(why(it) || word('poor', 'Not enough coins'), 1.6, st.tileEls.find(x => x.row === r)?.el); return false; }
    if (it.kind === 'hone' && arg === undefined) { if (d.hone.length === 1) arg = d.hone[0].pos; else { setMode('hone'); return true; } }
    if (it.kind === 'revive' && arg === undefined) { if (d.down.length === 1) arg = d.down[0].id; else { setMode('revive'); return true; } }
    send(r, arg ?? 0);
    st.sent = { item: r, at: performance.now() };
    st.lastRead = 0;
    return true;
  }
  /** Buy the card on show in place `slot` (0..2). */
  function buyCard(slot) {
    const d = st.data ?? read(), c = d?.cards?.[slot];
    if (!c || c.row === null) return false;
    if (!c.can) { play(S.deny); noteSay(whyCard(c) || word('poor', 'Not enough coins'), 1.6, st.slots[slot]?.buy); return false; }
    send(cardRow, slot);
    st.sent = { item: cardRow, slot, at: performance.now() };
    st.lastRead = 0;
    if (st.sel === slot) select(-1);
    return true;
  }
  /** Choose the card in place `slot` (the inspector shows it; -1: none). */
  function select(slot) {
    const d = st.data;
    st.sel = slot >= 0 && d?.offers?.[slot] !== null && d?.offers?.[slot] !== undefined ? slot : -1;
    box.classList.toggle('peek', st.sel >= 0);
    showLook();
    return st.sel >= 0;
  }
  function leave() {
    if (!st.shown) return false;
    send(SHOP_ITEM.LEAVE);
    st.leftAt = performance.now();
    hide();
    // back to the fight's mouse on the same click or key (a gesture), when this player had it before
    if (st.locked && !ctx.input?.touch) { try { const r = document.getElementById('gf-canvas')?.requestPointerLock?.(); r?.catch?.(() => {}); } catch {} }
    return true;
  }
  /** The paid revive in a fight (or the cart's): `friend` is a core id. */
  function raise(friend) {
    const d = read(); if (!d || reviveRow < 0) return false;
    const it = d.items[reviveRow], who = friend ?? d.down[0]?.id;
    if (!who || !it?.can) { play(S.deny); return false; }
    send(reviveRow, who);
    return true;
  }
  function setMode(m) {
    st.mode = m;
    box.classList.toggle('picking', m !== 'items');
    drawPick();
  }

  // ---- drawing ----
  /** The inspector for the card chosen (or under the mouse), else a line saying what to do. */
  function showLook() {
    const d = st.data, i = st.sel >= 0 ? st.sel : st.hover, row = i >= 0 ? d?.offers?.[i] : null;
    st.slots.forEach((s, k) => { s.card?.classList.toggle('sel', k === st.sel); s.card?.classList.toggle('hover', k === st.hover && k !== st.sel); });
    if (row === null || row === undefined) { insp.hide(); look.classList.remove('on'); st.look = null; return; }
    const r = insp.show(row);
    look.classList.add('on');
    st.look = { slot: i, card: cards[row]?.id ?? null, rows: r.rows, family: r.family };
  }
  function drawCards() {
    const d = st.data;
    cardsBox.replaceChildren(); st.slots = [];
    if (cardRow < 0) return;
    d.offers.forEach((row, slot) => {
      const s = el('div', 'gfc-slot'), card = row === null ? null : cards[row] ?? null;
      const buyBtn = el('button', 'gfc-buy'); buyBtn.type = 'button'; buyBtn.dataset.slot = slot;
      let face = null;
      if (card) {
        face = el('button', 'gfr-card up'); face.type = 'button'; face.dataset.slot = slot; face.dataset.card = card.id;
        face.style.setProperty('--c', card.color || '#e4d2b7');
        const flip = el('div', 'gfr-flip');
        const heldOf = fam => (runOf()?.players?.find(p => p.id === nidOf())?.build?.families?.[fam] ?? 0);
        flip.append(cardFront(ctx, T, card, { key: String(slot + 1), held: heldOf, word: dealWord }));
        face.append(flip);
        const over = e => { if (e.pointerType === 'mouse' && st.hover !== slot) { st.hover = slot; showLook(); } };
        face.addEventListener('pointerenter', over);
        face.addEventListener('pointermove', over);
        face.addEventListener('pointerleave', () => { if (st.hover === slot) { st.hover = -1; showLook(); } });
        // a card's face only chooses it (never buys, not on a double click: two shots as the cart opened bought one)
        face.addEventListener('click', e => { e.stopPropagation(); select(slot); });
        buyBtn.append(el('span', 'l', word('buy', 'Buy')), el('s', 'gfc-was', ''), el('span', 'gfc-coin', ''), el('span', 'why', ''));
        buyBtn.addEventListener('click', e => { e.stopPropagation(); buyCard(slot); });
        s.append(face, buyBtn);
      } else {
        s.append(el('div', 'gfc-sold', word('sold', 'Sold')), buyBtn);
        buyBtn.classList.add('gone'); buyBtn.disabled = true;
      }
      cardsBox.append(s); st.slots.push({ el: s, card: face, buy: buyBtn, was: buyBtn.querySelector('.gfc-was'), coin: buyBtn.querySelector('.gfc-coin'), why: buyBtn.querySelector('.why') });
    });
    st.fitKey = '';
  }
  function drawItems() {
    list.replaceChildren(); st.tileEls = [];
    // a revive is for a friend: a player alone (no one else in the run) is not shown it (review of v8: Smelling Salts
    // were always greyed out in solo)
    const alone = (runOf()?.players?.length ?? 1) <= 1;
    st.shownTiles = tiles.filter(({ it }) => !(alone && it.kind === 'revive'));
    st.shownTiles.forEach(({ it, row }, i) => {
      const b = el('button', 'gfc-item'); b.type = 'button'; b.dataset.row = row; b.dataset.id = it.id ?? '';
      const k = itemKey(i), n = el('span', 'n', it.name || cap(it.id ?? '')), p = el('span', 'gfc-price'), t = el('span', 't', it.text || ''), s = el('span', 's');
      p.append(el('s', 'gfc-was', ''), ' ', el('span', 'gfc-coin', ''));
      b.append(...(k !== null ? [el('kbd', null, String(k))] : []), n, p, t, s);
      b.addEventListener('click', e => { e.stopPropagation(); buy(row); });
      list.append(b); st.tileEls.push({ el: b, row });
    });
  }
  function drawPick() {
    const d = st.data; choices.replaceChildren();
    if (!d || st.mode === 'items') return;
    pickBack.onclick = e => { e.stopPropagation(); setMode('items'); };
    say(pickBack, word('back', 'Back'));
    const choice = (k, name, rline, color, text, on) => {
      const b = el('button', 'gfc-choice'); b.type = 'button';
      if (color) b.style.setProperty('--c', color);
      b.append(el('kbd', null, String(k)), el('span', 'n', name), el('span', 'r', rline), el('span', 't', text));
      b.addEventListener('click', e => { e.stopPropagation(); on(); });
      choices.append(b);
    };
    if (st.mode === 'hone') {
      // its heading says the price and what it does; two copies of one card at one rarity are one row ("×2": honing
      // either is the same); each row says the rarity it goes to and what one more step changes, in the inspector's
      // words and units (review of v8: duplicates, no price, "regen 1.79 → 2.27")
      const row = items.findIndex(x => x.kind === 'hone'), it = d.items[row];
      say(pickTitle, fill(word('honeTitle', '{name} · {price} coins: make one of your cards a rarity higher'), { name: items[row]?.name || cap(items[row]?.id ?? ''), price: it?.price ?? '' }));
      const groups = [];
      for (const h of d.hone) { const g = groups.find(x => x.card === h.card && x.level === h.level); if (g) g.n++; else groups.push({ ...h, n: 1 }); }
      groups.forEach((h, i) => {
        const c = cards[h.card] ?? {}; let line = '';
        const ch = honePreview(h.pos);
        if (ch) { const r = changeRow(ch, T, { weaponLabel: w => weaponWordsOf(w) }), u = r.unit && r.unit !== '×' ? ` ${r.unit}` : '', x = r.unit === '×' ? '×' : ''; line = `${r.label} ${x}${fmtRow(ch.before)}${u} → ${x}${fmtRow(ch.after)}${u}`; }
        choice(i + 1, `${c.name || c.id || `#${h.card}`}${h.n > 1 ? ` ×${h.n}` : ''}`, `${cap(dealWord(RARITY[h.rarity], RARITY[h.rarity] ?? ''))} → ${cap(dealWord(RARITY[Math.min(2, h.rarity + 1)], RARITY[Math.min(2, h.rarity + 1)]))}`, c.color, line, () => { buy(row, h.pos); setMode('items'); });
      });
    } else if (st.mode === 'revive') {
      say(pickTitle, fill(word('raise', 'Pay to raise {name}'), { name: '…' }));
      d.down.forEach((f, i) => choice(i + 1, nameOf(f.id), '', null, '', () => { buy(reviveRow, f.id); setMode('items'); }));
    }
  }
  /** Card sizes from the room the cards have: never smaller than the reward's card on this screen, and the text always
   *  whole (the picture gives way first). */
  function fit() {
    if (!st.shown || cardRow < 0 || st.data?.withReward) return;
    const W = cardsBox.clientWidth, H = cardsBox.clientHeight, key = `${W}x${H}x${innerWidth}x${innerHeight}`;
    if (!W || !H || key === st.fitKey) return;
    st.fitKey = key;
    const u = Math.min(innerWidth / 1280, innerHeight / 720), gap = Math.max(8, Math.round(16 * u));
    const buyH = Math.max(56, st.slots[0]?.buy?.offsetHeight || 56) + Math.max(6, Math.round(10 * u)) + Math.max(4, Math.round(12 * u));
    // upright, the cards' row is as tall as they are (the items take what is left): their width sets them
    const upright = innerWidth < innerHeight, ratio = upright ? 0.48 : innerHeight <= 480 ? 0.54 : 0.64;
    let cw = Math.floor((W - 2 * gap) / 3), ch = upright ? Math.floor(innerHeight * 0.42) : H - buyH;
    cw = Math.max(60, Math.min(cw, Math.floor(ch * 0.72)));
    ch = Math.max(100, Math.min(ch, Math.floor(cw / ratio)));
    panel.style.setProperty('--cw', `${cw}px`); panel.style.setProperty('--ch', `${ch}px`); panel.style.setProperty('--cg', `${gap}px`);
    // the text whole: the picture shrinks until every card's text fits (44% of the card, then less)
    for (const pic of [44, 36, 28, 20, 12]) {
      panel.style.setProperty('--pic', `${pic}%`);
      if (!textCut()) break;
    }
  }
  /** Is any card's text cut off? (its box scrolls) */
  const textCut = () => st.slots.some(s => { const t = s.card?.querySelector('.gfr-text'); return t ? t.scrollHeight > t.clientHeight + 1 : false; });

  /** Prices, stock, the purse, the score and the clock (no new elements). */
  function refresh() {
    const d = st.data; if (!d) return;
    say(purseS.b, fill(word('coins', '{n}'), { n: d.purse }));
    say(scoreS.b, String(scoreOf()));
    const left = Math.max(0, d.left); say(clockS.b, clockText(left)); clockS.b.classList.toggle('low', left <= CART_WARN_S);
    // the last seconds, counted down where the cart's name was
    const warnOn = left > 0 && left <= CART_WARN_S;
    titles.classList.toggle('warn', warnOn);
    say(warn, warnOn ? fill(word('packing', 'The cart leaves in {n}…'), { n: Math.ceil(left) }) : '');
    st.slots.forEach((s, slot) => {
      const c = d.cards[slot]; if (!c || c.row === null) return;
      say(s.coin, String(c.price ?? '–'));
      say(s.was, c.was !== null && c.was !== undefined ? String(c.was) : '');
      s.buy.classList.toggle('no', !c.can);
      const w = whyCard(c);
      say(s.why, w); s.buy.title = w;
    });
    st.tileEls.forEach(({ el: b, row }) => {
      const it = d.items[row]; if (!it) return;
      b.classList.toggle('no', !it.can);
      say(b.querySelector('.gfc-coin'), String(it.price));
      say(b.querySelector('.gfc-was'), it.was !== null && it.was !== undefined ? String(it.was) : '');
      // a greyed tile says why on itself (a phone has no hover); else what is left of the stock
      const w = why(it);
      say(b.querySelector('.s'), w || (it.left === null ? '' : fill(word('stockLeft', '{n} left'), { n: it.left })));
      b.title = w || (items[row]?.text ?? '');
    });
  }
  /** Everything for the cart as the core now says it: the cards again when the three changed, then the numbers. */
  function draw() {
    const d = st.data; if (!d) return;
    const sig = `${d.visit}|${d.offers.join(',')}|${d.withReward}`;
    if (sig !== st.sig) {
      // three new cards where cards were (a fresh deal, not a card bought out of its place): the guard again, so the
      // click that dealt them is not taken by the card that lands under it
      const was = st.sig.split('|'), before = st.sig && was[0] === String(d.visit) ? was[1].split(',') : null;
      if (before && d.offers.some((x, i) => x !== null && String(x) !== before[i])) arm();
      st.sig = sig;
      drawCards();
      if (st.sel >= 0 && d.offers[st.sel] === null) select(-1);
      else showLook();
    }
    refresh();
    if (st.mode !== 'items') { if ((st.mode === 'hone' && !d.hone.length) || (st.mode === 'revive' && !d.down.length)) setMode('items'); }
    fit();
  }

  function show(d) {
    st.shown = true; st.visit = d.visit; st.sel = -1; st.hover = -1; st.opened++; st.sig = '';
    st.openedAt = performance.now(); arm();
    say(note, ''); st.noteUntil = 0;                // a refusal's note from the last visit never greets the next
    box.className = 'on';
    box.classList.toggle('shared', !!d.withReward);
    body.classList.toggle('nocards', cardRow < 0 || !!d.withReward);
    say(title, word('title', 'The pedlar\'s cart')); say(sub, word('sub', 'Coins buy what the road ahead needs'));
    say(purseS.em, word('purse', 'Coins')); say(scoreS.em, word('score', 'Score')); say(clockS.em, word('timeLeft', 'Time left'));
    doneBtn.replaceChildren(word('leave', 'Done'), el('kbd', null, 'Enter'));
    const cardItem = cardRow >= 0 ? items[cardRow] : null;
    say(rise, cardItem && !d.withReward && (Number(cardItem.perBuy ?? 1.5) || 1) > 1 ? word('rise', 'Each card bought here raises the next one\'s price') : '');
    say(hint, word('pickHint', cardRow >= 0 ? 'Choose a card to see what it changes' : ''));
    say(backBtn, word('back', 'Back'));
    drawItems();
    const last = itemKey(Math.max(0, st.shownTiles.length - 1));
    say(foot, fill(word('keys', cardRow >= 0 ? '1–3 choose a card, again to buy · {a}–{b} buy · Enter: buy the chosen card, or Done · Esc: let go of it' : '{a}–{b} buy · Enter: Done'), { a: firstItemKey(), b: last ?? firstItemKey() }));
    st.mode = 'items';
    root.classList.toggle('gf-cart-up', !!d.withReward);
    ctx.ui?.cover?.('cart', true);
    st.locked = st.locked || !!document.pointerLockElement;
    try { if (document.pointerLockElement) document.exitPointerLock?.(); } catch {}
    play(S.open);
    draw();
    requestAnimationFrame(() => { fit(); if (d.withReward) root.style.setProperty('--gf-cart-h', `${Math.ceil(panel.getBoundingClientRect().height + 24)}px`); });
  }
  function hide() {
    if (!st.shown) return;
    st.shown = false; st.mode = 'items'; st.sel = -1; st.hover = -1;
    say(note, ''); st.noteUntil = 0;
    box.className = '';
    root.classList.remove('gf-cart-up');
    ctx.ui?.cover?.('cart', false);
    const c = document.getElementById('gf-canvas'); try { c?.focus(); } catch {}
  }
  addEventListener('resize', () => { st.fitKey = ''; if (st.shown) requestAnimationFrame(fit); });

  // ---- keys: 1–3 a card (the same key again buys it), the items' digits, Enter buys the card chosen or is Done, Esc
  // lets go of a choice (never Done), G raises a friend in a fight ----
  const DIGIT = /^(?:Digit|Numpad)(\d)$/;
  const onKey = e => {
    if (st.shown) {
      const m = DIGIT.exec(e.code), shared = !!st.data?.withReward;
      const enter = e.code === 'Enter' || e.code === 'NumpadEnter', back = e.code === 'Escape' || e.code === 'Backspace';
      if (!m && !enter && !back) return;
      // on a wave with a reward the reward keeps 1 2 3, Enter and Esc
      if (shared && !m && st.mode === 'items' && e.code !== 'Backspace') return;
      if (shared && m && cardRow >= 0 && Number(m[1]) <= 3 && st.mode === 'items') return;
      e.preventDefault(); e.stopPropagation();
      // a key held from the fight (its repeats) or pressed in the opening guard does nothing
      if (e.repeat || guarded()) { if (!e.repeat) st.ignored.push({ what: `key ${e.code}`, ms: Math.round(performance.now() - st.openedAt) }); return; }
      if (m) {
        const k = Number(m[1]);
        if (st.mode !== 'items') { if (k >= 1) choices.children[k - 1]?.click(); return; }
        if (cardRow >= 0 && k >= 1 && k <= 3) { if (st.sel === k - 1) buyCard(k - 1); else select(k - 1); return; }
        const i = k - firstItemKey();
        if (i >= 0 && i < st.tileEls.length) st.tileEls[i].el.click();
        return;
      }
      if (back) {
        // out of a chooser, else let go of the card chosen; with nothing chosen Esc does nothing (Done is its button
        // or Enter: a second Esc for the menu must not lose the cart)
        if (st.mode !== 'items') setMode('items');
        else if (st.sel >= 0) select(-1);
        return;
      }
      // Enter: the card chosen is bought (or the note says why not); nothing chosen, Done
      if (st.mode !== 'items') return;
      if (st.sel >= 0 && !shared) buyCard(st.sel);
      else leave();
      return;
    }
    if (e.repeat) return;
    if (e.code === RAISE_KEY && st.raise && ctx.round?.phase === 'playing') { e.preventDefault(); raise(st.raise.friend); }
  };
  addEventListener('keydown', onKey, true);
  // the opening guard for the mouse and touch: a press on the cart before it is armed, and the click it makes, are
  // not taken (a click is taken only when its own press came after the guard: a fire button held as the cart opened
  // and let go over a card does nothing)
  box.addEventListener('pointerdown', e => { st.downAt = performance.now(); if (guarded()) { st.ignored.push({ what: 'press', ms: Math.round(st.downAt - st.openedAt) }); e.preventDefault(); } }, true);
  box.addEventListener('click', e => {
    if (!e.isTrusted) return;                     // a key's own click on a tile (the digits)
    if (guarded() || st.downAt < st.armedAt) { e.stopPropagation(); e.preventDefault(); st.ignored.push({ what: 'click', ms: Math.round(performance.now() - st.openedAt) }); }
  }, true);
  box.addEventListener('dblclick', e => { e.stopPropagation(); e.preventDefault(); }, true);
  doneBtn.addEventListener('click', e => { e.stopPropagation(); leave(); });
  backBtn.addEventListener('click', e => { e.stopPropagation(); select(-1); });
  box.addEventListener('pointerdown', e => e.stopPropagation());
  raiseEl.addEventListener('pointerdown', e => e.stopPropagation());
  raiseEl.addEventListener('click', e => { e.stopPropagation(); if (st.raise) raise(st.raise.friend); });

  // ---- the host: joiners' purchases, the director's resume ----
  if (net.active && ctx.host) {
    const who = from => ctx.players?.nid?.(from);
    net.on('fb', (d, from) => { const n = who(from); if (n && d && Number.isFinite(d.i)) host.cmd.raw(SHOP_OP.BUY, [n, d.i >>> 0, (Number(d.a) || 0) >>> 0]); });
  }
  host.on('rule', e => {
    const mine = e.entity === nidOf();
    if (e.name === 'bought' && mine) {
      play(S.buy); st.bought.push({ item: items[e.a | 0]?.id ?? e.a, price: e.b, arg: e.c }); if (st.bought.length > 32) st.bought.shift();
      const t = (e.a | 0) === cardRow ? st.slots[e.c | 0]?.el : st.tileEls.find(x => x.row === (e.a | 0))?.el;
      t?.classList.add('got'); setTimeout(() => t?.classList.remove('got'), 450);
      st.lastRead = 0;
    } else if (e.name === 'buy-refused' && mine) {
      play(S.deny); st.refused.push({ item: items[e.a | 0]?.id ?? e.a, why: e.b }); if (st.refused.length > 32) st.refused.shift();
      noteSay([, '', '', word('soldOut', 'Sold out'), word('poor', 'Not enough coins'), word('none', 'Nothing to use it on')][e.b | 0] || '');
    } else if (e.name === 'shop-done' && !e.remote) {
      const r = st.resume; st.resume = null; st.last = { wave: e.a, sales: e.b, spent: e.c, at: Math.round((ctx.time?.now ?? 0) * 1000) / 1000 };
      if (r) { try { r(); } catch (err) { console.error(err); } }
    }
  });

  // A staged moment for verify check 13's phone leg (?gf-demo=cart), never on for a player: once the round plays the
  // host opens the cart for two minutes, with no waves before it, so its layout can be measured at each screen size.
  // ?gf-demo=cart.locked (check 13's mouse leg): the cart opens only while the mouse is captured, as it does when the
  // last enemy of a wave falls under a player's aim, and again (up to three times) each time it was left and the mouse
  // taken back, so the opening guard and the freed mouse are tried with real clicks.
  const demo = new URLSearchParams(globalThis.location?.search ?? '').get('gf-demo');
  const stagedCart = demo === 'cart' ? { opened: false } : demo === 'cart.locked' ? { locked: true, times: 0, pending: false, closedAt: 0 } : null;

  const api = {
    /** The host: open the cart (resume() is called once when it closes). → false when the game has no cart. */
    open({ wave = 0, resume = null, seconds = 0, withReward = false, seed = null } = {}) {
      if (!SH.on || !items.length) { resume?.(); return false; }
      const s = seed ?? (((Number(ctx.seed) >>> 0) ^ Math.imul((ctx.round?.number ?? 0) + 1, 0x85ebca6b) ^ Math.imul(wave + 1, 0x27d4eb2f)) >>> 0);
      st.resume = resume;
      host.cmd.raw(SHOP_OP.SHOP, [1, wave >>> 0, s >>> 0, 0, withReward ? 1 : 0], [seconds]);
      return true;
    },
    close() { host.cmd.raw(SHOP_OP.SHOP, [0, 0, 0, 0, 0], [0]); },
    buy, buyCard, select, leave, raise, honePreview,
    /** A player's purse (a core id; none: this copy's player). */
    purse(n = nidOf()) { const v = forge.feel_shop_state(n)?.[3]; return Number.isFinite(v) ? v : null; },
    read: () => read(),
    get mode() { return st.mode; },
    /** Is the cart on this copy's screen? (gf/forge/cards.js takes the mouse back only when it is not) */
    get shown() { return st.shown; },
    update() {
      const n = nidOf();
      if (!n) return;
      const s = forge.feel_shop_state(n);
      const open = s[0] > 0.5, inside = s[2] > 0.5, now = performance.now();
      if (stagedCart && ctx.host && ctx.round?.phase === 'playing' && SH.on) {
        if (!stagedCart.locked) { if (!stagedCart.opened) { stagedCart.opened = true; api.open({ wave: 1, seconds: 120 }); } }
        else if (open) { stagedCart.pending = false; stagedCart.closedAt = now; }
        else if (!stagedCart.pending && stagedCart.times < 3 && document.pointerLockElement && now - stagedCart.closedAt > 900) { stagedCart.pending = true; stagedCart.times++; api.open({ wave: stagedCart.times, seconds: 120 }); }
      }
      // the round ended with the cart open (the host's): it closes, and the director it would have resumed is gone
      if (ctx.host && ctx.round?.phase !== 'playing' && (open || st.resume)) { st.resume = null; if (open && !st.closing) { st.closing = true; api.close(); } }
      if (!open) st.closing = false;
      // ---- the cart ----
      if (open && inside && ctx.round?.phase === 'playing') {
        if (!st.data || now - st.lastRead > 120 || st.visit !== s[5]) { st.data = read(n); st.lastRead = now; }
        const d = st.data;
        if (d && (!st.shown || st.visit !== d.visit)) show(d);
        else if (d) draw();
      } else if (st.shown) hide();
      if (st.noteUntil && now >= st.noteUntil) { st.noteUntil = 0; say(note, ''); }
      // waiting for friends still in the cart (alone on a wave with no reward: the reward's own strip says it otherwise)
      let waitText = '';
      if (open && !inside && !(s[4] > 0.5)) {
        if (now - st.lastRead > 250) { st.data = read(n); st.lastRead = now; }
        const names = (st.data?.visitors ?? []).filter(v => v.inCart && v.player !== n).map(v => nameOf(v.player));
        if (names.length) waitText = `${fill(word('waiting', 'Waiting for {names}'), { names: names.join(', ') })} · ${clockText(Math.max(0, s[1]))}`;
      }
      say(waitEl, waitText); waitEl.classList.toggle('on', !!waitText);
      // ---- alone with bots: a bot leaves the cart after a moment (the host's word) ----
      if (ctx.host && open) {
        if (now - st.botRead > 300) {
          st.botRead = now;
          const d = read(n);
          for (const v of d?.visitors ?? []) {
            if (!v.inCart || !ctx.players?.byNid?.(v.player)?.isBot) continue;
            const k = `${d.visit}:${v.player}`;
            if (!botLeaves.has(k)) botLeaves.set(k, now + 700);
            else if (now >= botLeaves.get(k)) { host.cmd.raw(SHOP_OP.BUY, [v.player, SHOP_ITEM.LEAVE, 0]); botLeaves.set(k, Infinity); }
          }
        }
      }
      // ---- the paid revive in a fight: a friend down, this player standing, the cart sells it ----
      let raiseOn = null;
      const price = reviveRow >= 0 ? forge.feel_shop_price(n, reviveRow) : -1;
      if (!(open && inside) && price >= 0 && ctx.round?.phase === 'playing' && !ctx.watching?.()) {
        let downed = null, meUp = true;
        for (const [nid, r] of host.runStates?.() ?? []) { if (nid === n) meUp = r.alive !== false && !r.down; else if (r.down && !downed) downed = nid; }
        if (downed && meUp) raiseOn = { friend: downed, price, can: s[3] >= price };
      }
      st.raise = raiseOn;
      raiseEl.classList.toggle('on', !!raiseOn);
      if (raiseOn) {
        say(raiseText, fill(word('raise', 'Pay to raise {name}'), { name: nameOf(raiseOn.friend) }));
        // under the friends' list, wherever the HUD has put it on this screen
        if (now - (st.placed ?? 0) > 400) { st.placed = now; const fr = root.querySelector('.gf-fh-friends')?.getBoundingClientRect(); if (fr && fr.height > 0) root.style.setProperty('--gf-raise-top', `${Math.round(fr.bottom + 8)}px`); }
        say(raisePrice, String(raiseOn.price));
        raiseEl.classList.toggle('no', !raiseOn.can);
      }
    },
    /** What the screen shows (verify, tools/pedlar.mjs): every number, and the box of everything a thumb presses. */
    observe() {
      const n = nidOf(), d = read(n), shown = st.shown;
      const vis = e => !!e?.isConnected && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      const box1 = shown ? rectOf(panel) : null;
      const targets = [];
      const addT = (id, e, extra = {}) => { if (shown && vis(e)) targets.push({ id, rect: rectOf(e), ...extra }); };
      addT('done', doneBtn);
      st.slots.forEach((s, slot) => { if (s.card) addT(`card-${slot + 1}`, s.card); if (!s.buy.disabled) addT(`buy-${slot + 1}`, s.buy); });
      st.tileEls.forEach(({ el: b }) => addT(`item-${b.dataset.id}`, b));
      addT('back', backBtn);
      if (st.mode !== 'items') { addT('chooser-back', pickBack); [...choices.children].forEach((b, i) => addT(`choice-${i + 1}`, b)); }
      const tileOf = row => st.tileEls.find(x => x.row === row)?.el ?? null;
      return {
        on: !!SH.on, open: !!d?.open, shown, inCart: !!d?.inCart, mode: st.mode, visit: d?.visit ?? 0, wave: d?.wave ?? 0, lap: d?.lap ?? 0, left: d?.left ?? 0, seconds: d?.seconds ?? 0, withReward: !!d?.withReward,
        purse: d?.purse ?? 0, offers: (d?.offers ?? []).map(r => (r === null ? null : cards[r]?.id ?? r)),
        cards: (d?.cards ?? []).map((c, slot) => {
          const s = st.slots[slot], t = s?.card?.querySelector('.gfr-text');
          return { slot, id: c.id, name: c.row === null ? null : cards[c.row]?.name ?? null, rarity: c.row === null ? null : cards[c.row]?.rarity ?? 'common', family: c.row === null ? null : cards[c.row]?.family ?? null, price: c.price, afford: c.afford, can: c.can, sold: c.row === null, key: slot + 1,
            rect: shown && s?.card ? rectOf(s.card) : null, buy: shown && s && !s.buy.disabled ? rectOf(s.buy) : null, buyText: s?.buy?.textContent ?? null, why: s?.why?.textContent || null, was: c.was ?? null, textFits: t ? t.scrollHeight <= t.clientHeight + 1 : null,
            picture: (im => (im ? { loaded: im.complete && im.naturalWidth > 0 } : null))(s?.card?.querySelector('.gfr-sign img')) };
        }),
        selected: st.sel, inspector: st.look && look.classList.contains('on') ? { ...st.look, shown: vis(insp.el) } : null,
        items: (d?.items ?? []).map((it, i) => { const k = st.shownTiles.findIndex(x => x.row === i); return { id: items[i]?.id ?? it.id, kind: it.kind, name: items[i]?.name ?? '', price: it.price, was: it.was ?? null, bought: it.bought, left: it.left, can: it.can, afford: it.afford, target: it.target, greyed: !!tileOf(i)?.classList.contains('no'), hidden: it.kind !== 'card' && k < 0, why: tileOf(i) && !it.can ? tileOf(i).querySelector('.s')?.textContent ?? null : null, key: it.kind === 'card' || k < 0 ? null : itemKey(k), rect: shown && tileOf(i) ? rectOf(tileOf(i)) : null }; }),
        hone: d?.hone ?? [], down: d?.down ?? [], visitors: d?.visitors ?? [],
        panel: box1, cover: box1 ? Math.round((box1[2] * box1[3]) / (innerWidth * innerHeight) * 1000) / 1000 : 0, viewport: [innerWidth, innerHeight],
        heading: shown ? { purse: purseS.b.textContent, score: scoreS.b.textContent, clock: clockS.b.textContent, purseRect: rectOf(purseS.e), scoreRect: rectOf(scoreS.e), clockRect: rectOf(clockS.e) } : null,
        targets, minTarget: CART_MIN_TARGET,
        leave: shown ? rectOf(doneBtn) : null,
        raise: st.raise ? { friend: st.raise.friend, name: nameOf(st.raise.friend), price: st.raise.price, can: st.raise.can, text: raiseEl.textContent, rect: rectOf(raiseEl) } : null,
        waiting: waitEl.classList.contains('on') ? waitEl.textContent : null,
        note: note.textContent || null, bought: st.bought.slice(), refused: st.refused.slice(), last: st.last, opened: st.opened,
        // the opening guard (performance.now() times on this page) and what it kept from acting; the mouse captured?
        guard: { ms: CART_GUARD_MS, openedAt: Math.round(st.openedAt), armedAt: Math.round(st.armedAt), on: shown && guarded(), ignored: st.ignored.slice(-12) },
        mouseCaptured: !!document.pointerLockElement, warning: warn.textContent || null, rise: rise.textContent || null,
        chooser: st.mode !== 'items' ? { title: pickTitle.textContent, choices: [...choices.children].map(b => ({ name: b.querySelector('.n')?.textContent ?? '', rarity: b.querySelector('.r')?.textContent ?? '', line: b.querySelector('.t')?.textContent ?? '' })) } : null,
      };
    },
    dispose() { removeEventListener('keydown', onKey, true); box.remove(); waitEl.remove(); raiseEl.remove(); },
  };
  return api;
}
