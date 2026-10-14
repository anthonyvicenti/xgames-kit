// gf-forge's cards in the browser (wave 2, track G: the game loop), vendored into a game as gf/forge/cards.js (never
// edited there): the reward between waves, with its full inspector. The Rust core (forge-feel, cards.rs) owns the run:
// what a card does, the seeded three-card deal, who has chosen, the countdown. This draws it and sends the choices in.
//
//   const cards = createCards(ctx);      // ctx.forge (the host), ctx.ui (its root and cover), ctx.tables, ctx.players
//   cards.open({wave, resume})           // the host, when the wave director asks for a reward (gf/forge/ai.js does):
//                                        // the core deals; resume() is called once when it closes
//   cards.update(dt)                     // every frame, after the host's tick (every copy)
//   cards.choose(i) / take() / pass()    // what the mouse, the keys (1 2 3, Enter, Esc) and touch do
//   cards.give(player, 'card-id')        // the host's rules: a card now (their own rewards, a test's loadout)
//   cards.run()                          // the run as this copy holds it: the reward, everyone's cards, who is down
//   cards.observe()                      // what the screen shows (verify, and track U's HUD): phase, the three cards,
//                                        // the chosen one, the inspector's rows, who is still choosing, the timings
//
// The rhythm is the measured one (research/rust-engine/feel-targets.md moments 2, 3 and 17; the numbers are the deal
// table's, spec.forge.deal): three ticks 140 ms apart as the cards are dealt face down, flips of 200 ms starting 215 ms
// apart with one chime as the first begins, the rarity's colour on each card's face, a card under the pointer rising 1%
// of the screen's height and the chosen one 3.3% with a little overshoot. Choosing and taking are two steps: a click, a
// tap or 1 2 3 chooses (the inspector shows that card), the button or Enter takes it; passing is always allowed (Esc).
//
// The inspector says exactly what the card will change for this player, before → after, in the tables' own words and
// units, from the code that applies it (forge.feel_card_preview): a card already held twice shows the third's numbers.
//
// With friends: everyone chooses from their own three. A choice is a command to the host (a joiner's travels as the kit
// message 'fc'); the host's core applies it and the snapshot brings it back. The fight goes on when everyone has
// picked or passed, or when deal.seconds ran out; a strip says who is still choosing, and a player who has chosen
// walks again while they wait (to reach a downed friend).
//
// A card's face shows its picture (wave 3, track A2; gf/forge/art.js: an image slot a card, a woodcut whose paper is
// clear so the card's parchment shows through), over a faint wash of the rarity's colour; a card with no picture, or
// one whose picture does not load, keeps the plain sign. The pictures are fetched a few seconds after the game starts,
// not when the reward opens, so a flip never shows an empty face.
//
// Every word is a slot (spec.forge.deal.text, a card's name and text), every colour a card's own slot or a theme
// variable with a fallback (--gf-forge-serif, --gf-forge-ink, --gf-forge-parchment, --gf-forge-accent: track U's HUD
// theme defines them), every sound an id in the deal table.
import { net } from '../mp/net.js';
import { cardPath } from './tables/index.js';
import { PERKS } from './tables/cards.js';
import { cardPicture } from './art.js';
import { createBuilds } from './builds.js';

/** forge-feel's command ops for the run (forge_feel::op). */
export const CARD_OP = { REWARD: 74, PICK: 75, CARD: 76, REVIVE: 77 };

const CSS = `
#gf-forge-reward{position:absolute;inset:0;display:none;pointer-events:auto;font-family:var(--gf-forge-serif,Georgia,"Times New Roman",serif);color:var(--gf-forge-parchment,#e4d2b7);--ink:var(--gf-forge-ink,#0c0907);--paper:var(--gf-forge-parchment,#e4d2b7);--accent:var(--gf-forge-accent,#d3a446);z-index:6;user-select:none;-webkit-user-select:none;touch-action:manipulation}
#gf-forge-reward.on{display:block}
#gf-forge-reward .gfr-dim{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 40%,rgba(38,5,4,.72) 0%,rgba(12,9,7,.9) 70%,rgba(4,3,2,.96) 100%);opacity:0;transition:opacity .14s linear}
#gf-forge-reward.in .gfr-dim{opacity:1}
#gf-forge-reward .gfr-wrap{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1.6vh;padding:2vh 3vw;box-sizing:border-box}
#gf-forge-reward .gfr-head{text-align:center;line-height:1.15}
#gf-forge-reward .gfr-head h1{margin:0;font-size:clamp(20px,4.2vh,40px);font-weight:700;letter-spacing:.04em;color:var(--paper)}
#gf-forge-reward .gfr-head p{margin:.3em 0 0;font-size:clamp(12px,2vh,17px);opacity:.75;font-style:italic}
#gf-forge-reward .gfr-who span.gfr-clock{min-width:2.6em;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;border-color:color-mix(in srgb,var(--accent) 55%,transparent);color:var(--accent)}
#gf-forge-reward .gfr-who span.gfr-clock.low{color:#ff8a70;border-color:#ff8a7088}
#gf-forge-reward .gfr-table{display:flex;gap:clamp(8px,2.2vw,28px);align-items:flex-end;justify-content:center;perspective:1400px;height:clamp(150px,38vh,360px);margin-top:calc(var(--pick-lift,24px) + .6vh)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card{--c:#e4d2b7;--lift:0px;position:relative;width:clamp(92px,22.5vh,214px);height:100%;max-width:29vw;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;outline:none;-webkit-tap-highlight-color:transparent;transform:translate(var(--dx,0px),calc(var(--dy,0px) - var(--lift))) scale(var(--s,1));transition:transform var(--move,.18s) cubic-bezier(.2,.8,.3,1);opacity:var(--o,1)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.deck{--dy:-46vh;--s:.42;--o:0}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.dealt{--move:.28s}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.hover{--lift:var(--hover-lift,7px)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.sel{--lift:var(--pick-lift,24px);--move:.2s;transition-timing-function:cubic-bezier(.3,1.6,.5,1)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.gone{--o:0;--s:.9;--move:.25s;pointer-events:none}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-flip{position:absolute;inset:0;transform-style:preserve-3d;transform:rotateY(180deg);transition:transform var(--flip,.2s) cubic-bezier(.45,.05,.55,.95)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.up .gfr-flip{transform:rotateY(0deg)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:6px;box-sizing:border-box;overflow:hidden}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-back{transform:rotateY(180deg);background:repeating-linear-gradient(45deg,#2a0907 0 7px,#3b0d0a 7px 14px);border:2px solid #6a4a2a;box-shadow:inset 0 0 0 4px #1a0605,inset 0 0 0 5px #6a4a2a88,0 6px 18px #000a}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-back::after{content:"";position:absolute;left:50%;top:50%;width:34%;aspect-ratio:1;transform:translate(-50%,-50%) rotate(45deg);border:2px solid #b08a4a;box-shadow:inset 0 0 0 4px #2a0907,inset 0 0 0 5px #b08a4a88}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-front{display:flex;flex-direction:column;background:linear-gradient(180deg,color-mix(in srgb,var(--paper) 92%,#000) 0%,color-mix(in srgb,var(--paper) 74%,#3a2a18) 100%);color:var(--ink);border:2px solid color-mix(in srgb,var(--c) 70%,#2a1a0c);box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--paper) 80%,#000),inset 0 0 0 4px color-mix(in srgb,var(--c) 60%,transparent),0 6px 18px #000a}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.up.lit .gfr-front{box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--paper) 80%,#000),inset 0 0 0 4px color-mix(in srgb,var(--c) 60%,transparent),0 0 26px 4px color-mix(in srgb,var(--c) 65%,transparent),0 6px 18px #000a}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-card.sel .gfr-front{border-color:var(--accent);box-shadow:inset 0 0 0 3px color-mix(in srgb,var(--paper) 80%,#000),inset 0 0 0 4px var(--accent),0 0 22px 3px color-mix(in srgb,var(--accent) 70%,transparent),0 10px 24px #000b}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-band{flex:none;padding:.42em .5em .36em;background:var(--c);color:#14100b;font-size:clamp(9px,1.45vh,13px);letter-spacing:.16em;text-transform:uppercase;font-weight:700;display:flex;justify-content:space-between;align-items:center}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-band b{font:700 1.15em/1 ui-monospace,Menlo,monospace;letter-spacing:0;padding:.12em .4em;border:1px solid #14100b88;border-radius:3px}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign{flex:none;height:28%;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #0003;background:radial-gradient(ellipse at center,#0000 30%,#0002 100%)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign i{display:block;width:34%;aspect-ratio:1;border:3px solid color-mix(in srgb,var(--c) 55%,#1a120a);box-sizing:border-box}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign i.upgrade{transform:rotate(45deg)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign i.weapon{border-radius:0;width:46%;aspect-ratio:3.2;border-width:0 0 4px 0;box-shadow:inset 0 -9px 0 -5px color-mix(in srgb,var(--c) 55%,#1a120a)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign i.heal{border-radius:50%}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign i.perk{transform:rotate(45deg);border-radius:50% 0}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign.pic{height:44%;padding:3% 7% 1%;box-sizing:border-box;background:radial-gradient(ellipse at 50% 55%,color-mix(in srgb,var(--c) 26%,transparent) 0%,transparent 72%)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-sign.pic img{display:block;width:100%;height:100%;object-fit:contain;pointer-events:none;-webkit-user-drag:none;user-select:none}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-name{flex:none;padding:.5em .5em .15em;font-size:clamp(12px,2.3vh,21px);font-weight:700;line-height:1.1;text-align:center}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-text{flex:1;padding:.2em .7em .6em;font-size:clamp(10px,1.65vh,15px);line-height:1.25;text-align:center;opacity:.86;overflow:hidden}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-inspect{width:min(680px,94vw);height:clamp(118px,23vh,190px);overflow:hidden;box-sizing:border-box;padding:.7em 1em;border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);border-radius:4px;background:rgba(12,9,7,.78);opacity:0;transition:opacity .14s linear}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-inspect.on{opacity:1}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-inspect h2{margin:0 0 .35em;font-size:clamp(13px,2.2vh,19px);display:flex;gap:.6em;align-items:baseline;justify-content:space-between}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-inspect h2 em{font-style:normal;font-size:.72em;letter-spacing:.14em;text-transform:uppercase;color:var(--c,#e4d2b7)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows{display:grid;grid-template-columns:1fr auto auto auto auto;gap:.15em .7em;font-size:clamp(11px,1.85vh,16px);align-items:baseline}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows span{opacity:.86}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows b{font:600 1em/1.2 ui-monospace,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows b.to{color:var(--accent)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows u{text-decoration:none;opacity:.55}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows s{text-decoration:none;font:600 .86em/1.2 ui-monospace,Menlo,monospace;white-space:nowrap}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows s.up{color:#9fd08a}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows s.down{color:#ff9a80}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows i{grid-column:1/-1;font-size:.86em;opacity:.6}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows .hd{font-size:.72em;letter-spacing:.12em;text-transform:uppercase;opacity:.5;text-align:right;font-family:inherit}
#gf-forge-reward .gfr-act{display:flex;gap:1em;align-items:center;justify-content:center;flex-wrap:wrap}
#gf-forge-reward .gfr-act button{font:700 clamp(14px,2.3vh,19px)/1 var(--gf-forge-serif,Georgia,"Times New Roman",serif);min-height:44px;padding:.7em 1.5em;border-radius:3px;cursor:pointer;letter-spacing:.03em}
#gf-forge-reward .gfr-take{background:var(--accent);color:#14100b;border:1px solid #14100b}
#gf-forge-reward .gfr-take:disabled{background:#3a3128;color:#8a7a62;border-color:#3a3128;cursor:default}
#gf-forge-reward .gfr-pass{background:rgba(12,9,7,.6);color:var(--paper);border:1px solid color-mix(in srgb,var(--paper) 45%,transparent)}
#gf-forge-reward .gfr-keys{font-size:clamp(10px,1.5vh,13px);opacity:.5;letter-spacing:.04em}
#gf-forge-reward .gfr-who{display:flex;gap:.6em;flex-wrap:wrap;justify-content:center;font-size:clamp(11px,1.7vh,14px)}
#gf-forge-reward .gfr-who span{padding:.22em .7em;border-radius:3px;background:rgba(12,9,7,.7);border:1px solid #ffffff22;white-space:nowrap}
#gf-forge-reward .gfr-who span.done{opacity:.55}
#gf-forge-reward .gfr-who i{display:inline-block;width:.62em;height:.62em;border-radius:50%;margin-right:.45em;vertical-align:.02em}
#gf-forge-reward.waiting{pointer-events:none}
#gf-forge-reward.waiting .gfr-dim{opacity:0}
#gf-forge-reward.waiting .gfr-wrap{justify-content:flex-start;padding-top:15vh;gap:.8vh}
#gf-forge-reward.waiting .gfr-table,#gf-forge-reward.waiting .gfr-inspect,#gf-forge-reward.waiting .gfr-act,#gf-forge-reward.waiting .gfr-keys,#gf-forge-reward.waiting .gfr-head p{display:none}
#gf-forge-reward.waiting .gfr-head h1{font-size:clamp(14px,2.4vh,20px);padding:.3em .9em;background:rgba(12,9,7,.7);border-radius:3px}
@media (max-aspect-ratio:3/4){#gf-forge-reward .gfr-sign.pic{height:29%;padding:2% 6% 0}#gf-forge-reward .gfr-table{height:clamp(140px,27vh,300px)}#gf-forge-reward .gfr-card{width:29vw}#gf-forge-reward .gfr-keys{display:none}#gf-forge-reward .gfr-act{flex-direction:column;gap:.6em;width:100%}#gf-forge-reward .gfr-act button{width:min(86vw,420px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}#gf-forge-reward .gfr-text{font-size:clamp(10px,1.5vh,14px)}}
@media (max-height:480px){#gf-forge-reward .gfr-sign.pic{height:38%;padding:2% 5% 0}#gf-forge-reward .gfr-wrap{gap:1vh;padding:1vh 2vw;flex-flow:row wrap;align-content:center}#gf-forge-reward .gfr-head{width:100%}#gf-forge-reward .gfr-head p{display:none}#gf-forge-reward .gfr-table{height:52vh}#gf-forge-reward .gfr-card{width:21vh;max-width:15vw}#gf-forge-reward .gfr-inspect{width:42vw;min-height:52vh}#gf-forge-reward .gfr-keys{display:none}#gf-forge-reward .gfr-act{width:100%}}
@media (pointer:coarse){#gf-forge-reward .gfr-keys{display:none}#gf-forge-reward .gfr-band b{display:none}}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam{flex:none;display:flex;align-items:center;justify-content:center;gap:.4em;padding:.28em .4em;background:color-mix(in srgb,var(--f) 22%,transparent);border-bottom:1px solid color-mix(in srgb,var(--f) 55%,transparent);font-size:clamp(9px,1.4vh,12px);font-weight:700;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;overflow:hidden}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam i{display:inline-flex;gap:2px}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam i u{display:block;width:.55em;height:.55em;transform:rotate(45deg);box-shadow:inset 0 0 0 1.5px var(--f)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam i u.on{background:var(--f)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam i u.next{background:color-mix(in srgb,var(--f) 45%,transparent)}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam.done{background:var(--f);color:#14100b}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam.done i u{box-shadow:inset 0 0 0 1.5px #14100b}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam.done i u.on{background:#14100b}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-fam.done span::after{content:" ★"}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows i.fam{opacity:.95;color:var(--f,#e4d2b7);font-style:normal;font-weight:700}
:is(#gf-forge-reward,#gf-forge-cart) .gfr-rows i.fam.unlock{color:var(--accent)}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fill = (s, vars) => String(s ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
/** A number as a player reads it: whole when it is, else three figures' worth (0.658, 8.74, 11.2, 130). */
export const fmt = v => {
  if (!Number.isFinite(v)) return '–';
  const a = Math.abs(v), places = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3, k = 10 ** places, r = Math.round(v * k) / k;
  return Number.isInteger(r) ? String(r) : r.toFixed(places).replace(/0+$/, '').replace(/\.$/, '');
};

/**
 * One change of the core's preview → an inspector row: {label, before, after, unit, change ('+20%'), better (true, false
 * or null when the tables do not say), path}. The label and unit are the table field's own (tables/*.js).
 */
export function changeRow(ch, tables, { weaponLabel = null } = {}) {
  const p = cardPath(ch.path);
  const w = p?.table === 'weapons' ? (tables?.weapons ?? []).find(r => r.id === p.id) : null;
  const what = p?.field?.label || ch.path, low = /^[A-Z][a-z]/.test(what) ? what[0].toLowerCase() + what.slice(1) : what; // after a name: "Hatchet: damage"
  // a weapon by the name the player knows it by (the review of v8: "Hatchet: damage" for the quick melee on V)
  const wname = w ? (weaponLabel?.(w) || w.name || w.id) : null;
  const label = w ? `${wname}: ${low}` : p?.table === 'player' && p.key.includes('.') ? `${cap(p.key.split('.')[0])}: ${low}` : cap(what);
  const d = ch.after - ch.before, rel = ch.before ? d / Math.abs(ch.before) : null;
  const change = rel !== null && Math.abs(rel) < 9.995 ? `${d >= 0 ? '+' : '−'}${Math.round(Math.abs(rel) * 100)}%` : `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}`;
  return { path: ch.path, label, before: ch.before, after: ch.after, unit: p?.field?.unit ?? '', change, better: d === 0 ? null : (d > 0) !== LOWER_IS_BETTER.test(ch.path), held: ch.held !== false };
}
const cap = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
// values a player wants smaller (the rest: bigger is better)
const LOWER_IS_BETTER = /(reload|fireInterval|cooldown|evadeCost|jumpCost|raise|spread|windup|contact|recover|accelTime|stopTime|revive\.time|kick\.pitch|kick\.yaw)$/;

/**
 * A perk's numbers as inspector rows (wave 7, builds): the core's preview `{kind, before, after}` (each the perk's sum
 * over what is held, or null) → [{label, before, after, unit, change, better, perk}] for the numbers the perk reads
 * (tables/cards.js PERKS[kind].show), a share shown as a percentage.
 */
export function perkRows(p) {
  const P = PERKS[p?.kind];
  if (!P) return [];
  const out = [];
  for (const [k, [label, unit]] of Object.entries(P.show)) {
    const pct = unit === '%', k100 = pct ? 100 : 1;
    const a = (p.before?.[k] ?? 0) * k100, b = (p.after?.[k] ?? 0) * k100;
    if (a === b && p.before) continue;
    const d = b - a, better = d === 0 ? null : (d > 0) !== (k === 'cooldown');
    out.push({ label, before: a, after: b, unit: pct ? '%' : unit, change: p.before ? `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}${pct ? '' : unit ? ` ${unit}` : ''}` : 'new', better, perk: p.kind, key: k });
  }
  return out;
}
/**
 * The words a player knows a weapon by (pure): the quick melee a game lists in How to play (config/game.json → controls
 * .more, a row whose words say melee or strike) for a blade the player does not start with, as "Quick melee (V)" (on a
 * touch screen without the key); any other weapon by its name.
 */
export function weaponWords(ctx, w) {
  if (!w || w.kind !== 'melee' || w.start === true) return null;
  const more = ctx?.config?.controls?.more ?? [], r = Array.isArray(more) ? more.find(x => Array.isArray(x) && /melee|strike/i.test(String(x[1] ?? ''))) : null;
  if (!r?.[1]) return null;
  return ctx.input?.touch || !r[0] ? String(r[1]) : `${r[1]} (${r[0]})`;
}
/** A family (tables row) by id, and its row index. */
const familyOf = (T, id) => { const list = Array.isArray(T?.families) ? T.families : []; const i = id ? list.findIndex(f => f?.id === id) : -1; return i >= 0 ? { row: i, f: list[i] } : null; };

/** The cards' styles, put in the page once (the reward and the pedlar's cart, gf/forge/shop.js, both draw cards). */
export function ensureCardCss() {
  if (typeof document === 'undefined' || document.getElementById('gf-forge-reward-css')) return;
  const s = el('style'); s.id = 'gf-forge-reward-css'; s.textContent = CSS; document.head.append(s);
}

/**
 * A card's face (wave 2; shared with the pedlar's cart in v8): the rarity band with its key, the family badge (wave 7:
 * its plain label and how many of it this player holds, "Tank 2/3", a pip each, the one this card would add half lit),
 * the picture (wave 3: its slot's file, else the plain sign; a picture that fails to load gives way to the sign), the
 * name and the text. held(familyRow) → cards of that family this player holds; word(key, fallback) → the deal's words.
 */
export function cardFront(ctx, T, card, { key = '', held = () => 0, word = (k, d) => d } = {}) {
  const front = el('div', 'gfr-face gfr-front');
  const band = el('div', 'gfr-band'); band.append(el('span', null, word(card.rarity, cap(card.rarity ?? 'common'))), el('b', null, String(key)));
  const sign = el('div', 'gfr-sign'), glyph = () => el('i', card.kind ?? 'upgrade'), pic = cardPicture(ctx, card.id);
  if (pic) { const img = el('img'); img.alt = ''; img.draggable = false; img.decoding = 'sync'; img.addEventListener('error', () => { sign.classList.remove('pic'); sign.replaceChildren(glyph()); }, { once: true }); img.src = pic; sign.classList.add('pic'); sign.append(img); }
  else sign.append(glyph());
  const fam = familyOf(T, card.family);
  let famEl = null;
  if (fam) {
    const F = fam.f, at = Math.max(1, F.at | 0 || 3), n = Math.min(at, held(fam.row));
    famEl = el('div', `gfr-fam${n >= at ? ' done' : ''}`); famEl.style.setProperty('--f', F.color || '#c9a26b'); famEl.dataset.family = F.id;
    const pips = el('i'); for (let k = 0; k < at; k++) pips.append(el('u', k < n ? 'on' : k === n ? 'next' : ''));
    famEl.append(pips, el('span', null, fill(word('family', '{label} {n}/{at}'), { label: F.label || F.name || F.id, name: F.name || F.id, n, at })));
  }
  front.append(band, ...(famEl ? [famEl] : []), sign, el('div', 'gfr-name', card.name || card.id), el('div', 'gfr-text', card.text || ''));
  return front;
}

/**
 * The inspector (wave 2; shared with the pedlar's cart in v8): what a card will change for this player, before → after,
 * from the code that applies it (forge.feel_card_preview). → {el, show(row) → {rows, preview, family}, hide()}
 */
export function createInspector(ctx, { forge, T, word = (k, d) => d, nidOf = () => 0 }) {
  const rows = Array.isArray(T?.cards) ? T.cards : [];
  const wl = { weaponLabel: w => weaponWords(ctx, w) };
  const inspect = el('div', 'gfr-inspect'), ih = el('h2'), iname = el('span'), irar = el('em'), irows = el('div', 'gfr-rows'); ih.append(iname, irar); inspect.append(ih, irows);
  const hide = () => { inspect.classList.remove('on'); return { rows: [], preview: null, family: null }; };
  function show(row) {
    const card = rows[row];
    if (row == null || !card) return hide();
    let p = null; try { p = JSON.parse(forge.feel_card_preview(nidOf(), row)); } catch {}
    let family = null;
    // what the card changes for this player: not a weapon they do not hold, and not a value it leaves as it was (a
    // shorter reload on a blade that has none)
    const list = (p?.changes ?? []).filter(c => c.held !== false && c.before !== c.after).map(c => changeRow(c, T, wl));
    let out = list;
    iname.textContent = card.name || card.id; irar.textContent = word(card.rarity, cap(card.rarity ?? 'common')); inspect.style.setProperty('--c', card.color || '#e4d2b7');
    irows.replaceChildren();
    if (list.length) irows.append(el('span', 'hd', ''), el('b', 'hd', word('now', 'now')), el('u', 'hd', ''), el('b', 'hd', word('then', 'with it')), el('s', 'hd', ''));
    for (const r of list) {
      const unit = r.unit && r.unit !== '×' ? ` ${r.unit}` : '', x = r.unit === '×' ? '×' : '';
      const a = el('b', null, `${x}${fmt(r.before)}${unit}`), b = el('b', 'to', `${x}${fmt(r.after)}${unit}`), ch = el('s', r.better === null ? '' : r.better ? 'up' : 'down', r.change);
      a.dataset.before = r.before; b.dataset.after = r.after;
      irows.append(el('span', null, r.label), a, el('u', null, '→'), b, ch);
    }
    if (p?.weapon) {
      const w = (T.weapons ?? [])[p.weapon.row] ?? {}, n = nidOf(), v = k => forge.feel_value(n, `weapons.${w.id}.${k}`);
      irows.append(el('i', null, `${word('weapon', 'A new weapon in your hands')}: ${w.name || w.id}`));
      const facts = [['Damage', v('pellets') > 1 ? `${fmt(v('damage'))} × ${fmt(v('pellets'))}` : fmt(v('damage'))], ...(v('magazine') > 0 ? [['Magazine', fmt(v('magazine'))], ['Reload', `${fmt(v('reload'))} s`]] : []), ['Shots a second', fmt(1 / Math.max(0.02, v('fireInterval')))]];
      for (const [k, x] of facts) irows.append(el('span', null, k), el('b', null, ''), el('u', null, ''), el('b', 'to', x), el('s', null, ''));
      out = [...list, ...facts.map(([k, x]) => ({ label: `${w.name || w.id}: ${k}`, value: x, weapon: w.id }))];
    }
    if (p?.heal) {
      const a = el('b', null, fmt(p.heal.before)), b = el('b', 'to', `${fmt(p.heal.after)} / ${fmt(p.heal.max)}`);
      irows.append(el('span', null, word('heal', 'Health')), a, el('u', null, '→'), b, el('s', 'up', `+${fmt(p.heal.after - p.heal.before)}`));
      out = [...list, { label: word('heal', 'Health'), before: p.heal.before, after: p.heal.after, unit: 'hp', path: 'player.hp' }];
    }
    // wave 7 (builds): a perk's numbers now → with the card (copies stack), and the card's family toward its set bonus
    const perkRow = r => {
      const u = r.unit === '%' ? '%' : r.unit ? ` ${r.unit}` : '';
      const a = el('b', null, r.change === 'new' ? '–' : `${fmt(r.before)}${u}`), b = el('b', 'to', `${fmt(r.after)}${u}`);
      irows.append(el('span', null, r.label), a, el('u', null, '→'), b, el('s', r.better === null ? '' : r.better ? 'up' : 'down', r.change === 'new' ? '' : r.change));
    };
    if (p?.perk) {
      const pr = perkRows(p.perk);
      if (pr.length && !list.length) irows.append(el('span', 'hd', ''), el('b', 'hd', word('now', 'now')), el('u', 'hd', ''), el('b', 'hd', word('then', 'with it')), el('s', 'hd', ''));
      if (!list.length && !pr.length) irows.append(el('i', null, PERKS[p.perk.kind]?.label ?? p.perk.kind));
      for (const r of pr) perkRow(r);
      out = [...out, ...pr];
    }
    const fam = p?.family, F = fam ? (T.families ?? [])[fam.row] : null;
    if (fam && F) {
      inspect.style.setProperty('--f', F.color || '#c9a26b');
      const vars = { label: F.label || F.name || F.id, name: F.name || F.id, n: Math.min(fam.held, fam.at), next: Math.min(fam.after, fam.at), at: fam.at, bonus: F.bonus?.name || '', text: String(F.bonus?.text ?? '').replace(/^\s*(.)/, (m, c) => c.toUpperCase()) };
      // a set already complete: its badge's words and a star (another card of it still adds its own)
      const text = fam.unlocks ? fill(word('unlocks', 'Completes the {label} set: {bonus}'), vars) : fam.unlocked ? `${fill(word('family', '{label} {n}/{at}'), vars)} ★ ${vars.bonus}` : fill(word('toward', '{label} set: you hold {n} of {at} {label} cards, this one makes {next}'), vars);
      irows.append(el('i', `fam${fam.unlocks ? ' unlock' : ''}`, text));
      // what the set gives, in plain words (the review of v8: "families are unexplained where you buy")
      if (!fam.unlocked && vars.bonus) irows.append(el('i', 'fam bonus', (fam.unlocks ? vars.text : fill(word('setBonus', 'Hold {at} {label} cards: {bonus}. {text}'), vars)).replace(/\.\s*$/, '') + '.'));
      if (fam.unlocks && fam.bonus) { const br = perkRows(fam.bonus); for (const r of br) perkRow(r); out = [...out, ...br.map(r => ({ ...r, bonus: F.id }))]; }
      family = { id: F.id, label: vars.label, held: fam.held, after: fam.after, at: fam.at, unlocks: !!fam.unlocks, unlocked: !!fam.unlocked };
    }
    if (p && p.stack > 1) irows.append(el('i', null, fill(word('held', 'You can hold up to {max} of this card (you hold {n})'), { n: p.held, max: p.stack })));
    inspect.classList.add('on');
    return { rows: out, preview: p, family };
  }
  return { el: inspect, show, hide };
}

export function createCards(ctx, { host = ctx.forge, root = ctx.ui?.root } = {}) {
  const forge = host?.forge;
  if (!host || !forge?.feel_run || !root) return null;
  const T = ctx.tables ?? {}, rows = Array.isArray(T.cards) ? T.cards : [], D = T.deal ?? {}, W = D.text ?? {}, S = D.sounds ?? {};
  ensureCardCss();
  const word = (k, d) => (typeof W[k] === 'string' && W[k] ? W[k] : d);
  const play = id => { if (id) ctx.audio?.play(id, { optional: true }); };
  const nidOf = () => ctx.players?.nid?.(ctx.me?.id) ?? 0;
  const nameOf = nid => ctx.players?.byNid?.(nid)?.name ?? `Player ${nid}`;
  const colorOf = nid => ctx.players?.byNid?.(nid)?.color ?? '#ffffff';

  // ---- the screen ----
  const box = el('div'); box.id = 'gf-forge-reward';
  const dim = el('div', 'gfr-dim'), wrap = el('div', 'gfr-wrap'), clock = el('span', 'gfr-clock');
  const head = el('div', 'gfr-head'), h1 = el('h1'), sub = el('p'); head.append(h1, sub);
  const table = el('div', 'gfr-table');
  const insp = createInspector(ctx, { forge, T, word, nidOf }), inspect = insp.el;
  const act = el('div', 'gfr-act'), takeBtn = el('button', 'gfr-take'), passBtn = el('button', 'gfr-pass'); takeBtn.type = passBtn.type = 'button'; takeBtn.id = 'gf-forge-take'; passBtn.id = 'gf-forge-pass'; act.append(takeBtn, passBtn);
  const keys = el('div', 'gfr-keys'), who = el('div', 'gfr-who');
  wrap.append(head, table, inspect, act, keys, who); box.append(dim, wrap); root.append(box);

  // ---- state ----
  // phase: closed → dealing → choosing → sent (the choice is on its way to the host) → waiting (the host has it; friends
  // still choose) → closed
  const st = { phase: 'closed', index: -1, wave: 0, offers: [], cards: [], selected: -1, hover: -1, sent: null, timers: [], t0: 0, dealt: [], flipped: [], settled: 0, rows: [], preview: null, taken: null, resume: null, last: null, lastRun: 0, run: null, opened: 0, closedAt: 0 };
  const later = (ms, fn) => st.timers.push(setTimeout(fn, ms));
  const clearTimers = () => { for (const t of st.timers) clearTimeout(t); st.timers.length = 0; };
  const read = () => { try { return JSON.parse(forge.feel_run()); } catch { return null; } };
  const mine = run => run?.reward?.choices?.find(c => c.player === nidOf()) ?? null;
  /** Cards of family `row` this player holds now (the core's count; wave 7). */
  const heldOf = row => (st.run ?? read())?.players?.find(p => p.id === nidOf())?.build?.families?.[row] ?? 0;
  // the build line in the HUD and the set bonus's banner (wave 7: gf/forge/builds.js)
  const builds = createBuilds(ctx, { host, read, word, nidOf, nameOf });

  // A staged moment for verify check 13 (?gf-demo=controls.revive with one bot beside the player: ?bots=1), never on for
  // a player: the other player lies down and this copy's player is put beside them, so the interact control has what it
  // is for among friends (alone it has nothing to do). As ?gf-demo=controls and ?gf-demo=feel.hit: QA's query.
  const stagedRevive = new URLSearchParams(globalThis.location?.search ?? '').get('gf-demo') === 'controls.revive' ? { step: 0, n: 0 } : null;
  function stageRevive() {
    if (stagedRevive.step > 0 || !ctx.host || ctx.round?.phase !== 'playing') return;
    const other = (ctx.players?.list?.() ?? []).find(p => !p.local), n = other ? ctx.players.nid?.(other.id) : null;
    if (!n) return;
    if (!read()?.players?.find(p => p.id === n)?.down) { if (stagedRevive.n++ % 30 === 0) host.cmd.damage(n, 1e7, 0, [0, 0, -1]); return; }   // again until the opening grace is over
    ctx.me?.teleport?.({ x: other.position.x + 1.1, y: other.position.y, z: other.position.z }, ctx.me.yaw);
    stagedRevive.step = 1;
  }

  /** The inspector for one of the three cards: the core's preview as rows. */
  function inspectCard(i) {
    const r = insp.show(st.offers[i]);
    st.rows = r.rows; st.preview = r.preview; st.family = r.family;
  }

  function showSelected() {
    st.cards.forEach((c, i) => { c.classList.toggle('sel', i === st.selected); c.classList.toggle('hover', i === st.hover && i !== st.selected); });
    const shown = st.selected >= 0 ? st.selected : st.hover;
    if (shown >= 0) inspectCard(shown); else { inspect.classList.remove('on'); st.rows = []; st.preview = null; }
    const card = st.selected >= 0 ? rows[st.offers[st.selected]] : null;
    takeBtn.disabled = !card || st.phase !== 'choosing' || st.preview?.can === false;
    takeBtn.textContent = card ? fill(word('take', 'Take {name}'), { name: card.name || card.id }) : word('pick', 'Choose a card');
  }

  /** Choose one of the three (the inspector shows it; nothing is taken yet). */
  function choose(i) {
    if (st.phase !== 'choosing' || !(i >= 0 && i < st.offers.length) || st.offers[i] == null || !st.cards[i]?.classList.contains('up')) return false;
    if (st.selected !== i) play(S.flip);
    st.selected = i; showSelected();
    return true;
  }
  /** Send this player's choice to the host: a card of the three (0..2), or a pass. */
  function send(slot) {
    if (st.phase !== 'choosing') return false;
    const n = nidOf();
    if (ctx.host || !net.active) host.cmd.raw(CARD_OP.PICK, [n, slot]);
    else net.send('fc', { s: slot }, 'host');
    st.sent = { slot, at: performance.now() }; st.phase = 'sent';
    play(slot <= 2 ? S.pick : S.pass);
    // back to the fight's mouse on the same click or key (a gesture), when this player had it before the reward, and
    // never while the pedlar's cart is still open on the same screen: v7's cart buttons stopped working because this
    // took the mouse back while the cart stayed up (research/gf-forge/evidence/zombie-town-v8-ux-review-2026-10-12)
    if (st.locked && !ctx.input?.touch && !ctx.shop?.shown) { try { const r = document.getElementById('gf-canvas')?.requestPointerLock?.(); r?.catch?.(() => {}); } catch {} }
    // the one taken stays lifted, the others go; the player walks again while friends choose
    st.cards.forEach((c, i) => { if (i !== slot) c.classList.add('gone'); });
    takeBtn.disabled = true;
    return true;
  }
  const take = () => (st.selected >= 0 && st.preview?.can !== false ? send(st.selected) : false);
  const pass = () => send(255);

  function buildCards(offers) {
    table.replaceChildren(); st.cards = [];
    offers.forEach((row, i) => {
      const card = rows[row] ?? null;
      const b = el('button', 'gfr-card deck'); b.type = 'button'; b.dataset.i = i; b.dataset.card = card?.id ?? '';
      if (!card) { b.style.visibility = 'hidden'; table.append(b); st.cards.push(b); return; }
      b.style.setProperty('--c', card.color || '#e4d2b7');
      const flip = el('div', 'gfr-flip'), back = el('div', 'gfr-face gfr-back'), front = cardFront(ctx, T, card, { key: String(i + 1), held: heldOf, word });
      flip.append(front, back); b.append(flip);
      // under the pointer: on entering, and on any move (a card dealt under a resting mouse gets no enter of its own)
      const over = e => { if (e.pointerType === 'mouse' && st.phase === 'choosing' && st.hover !== i) { st.hover = i; showSelected(); } };
      b.addEventListener('pointerenter', over);
      b.addEventListener('pointermove', over);
      b.addEventListener('pointerleave', () => { if (st.hover === i) { st.hover = -1; showSelected(); } });
      b.addEventListener('click', e => { e.stopPropagation(); if (st.selected === i && e.detail >= 2) take(); else choose(i); });
      table.append(b); st.cards.push(b);
    });
  }

  /** The reward opens on this copy: the deal, the flips, then the choice. */
  function show(run) {
    const R = run.reward, c = mine(run);
    clearTimers();
    st.index = R.index; st.wave = R.wave; st.offers = (c?.offers ?? []).slice(0, 3); st.selected = -1; st.hover = -1; st.sent = null; st.taken = null; st.rows = []; st.preview = null;
    st.dealt = []; st.flipped = []; st.settled = 0; st.t0 = performance.now(); st.opened++;
    const tick = (Number(D.tick) || 0.14) * 1000, flip = (Number(D.flip) || 0.2) * 1000, every = (Number(D.flipEvery) || 0.215) * 1000;
    box.style.setProperty('--flip', `${flip}ms`);
    box.style.setProperty('--hover-lift', `${Math.round(innerHeight * (Number(D.hoverLift) || 0.01))}px`);
    box.style.setProperty('--pick-lift', `${Math.round(innerHeight * (Number(D.pickLift) || 0.033))}px`);
    h1.textContent = word('title', 'Choose one'); sub.textContent = fill(word('wave', 'Wave {wave} is cleared'), { wave: R.wave });
    passBtn.textContent = word('pass', 'Pass'); keys.textContent = word('keys', '1 2 3 choose · Enter takes · Esc passes');
    box.className = 'on'; inspect.classList.remove('on');
    ctx.ui?.cover?.('reward', true);
    st.locked = !!document.pointerLockElement;
    try { document.exitPointerLock?.(); } catch {}
    if (!c || c.state !== 'choosing' || !st.offers.some(x => x != null)) { st.phase = 'waiting'; box.classList.add('in', 'waiting'); release(); table.replaceChildren(); st.cards = []; return; }
    st.phase = 'dealing';
    buildCards(st.offers);
    showSelected();
    requestAnimationFrame(() => box.classList.add('in'));
    // three ticks as the cards are dealt face down, then the flips, staggered, with one chime as the first begins
    const dealAt = 110, slide = 280;
    st.cards.forEach((b, i) => later(dealAt + i * tick, () => { b.classList.remove('deck'); b.classList.add('dealt'); st.dealt[i] = performance.now() - st.t0; play(S.tick); }));
    const flipAt = dealAt + (st.cards.length - 1) * tick + slide + 60;
    st.cards.forEach((b, i) => later(flipAt + i * every, () => {
      b.classList.add('up', 'lit'); st.flipped[i] = performance.now() - st.t0;
      if (i === 0) play(S.chime); else play(S.flip);
      later(flip + 260, () => b.classList.remove('lit'));
    }));
    later(flipAt + (st.cards.length - 1) * every + flip, () => {
      st.settled = performance.now() - st.t0;
      if (st.phase !== 'dealing') return;
      st.phase = 'choosing';
      // the card the mouse already rests on, if any
      if (!ctx.input?.touch) { const h = st.cards.findIndex(b => b.matches(':hover')); if (h >= 0) st.hover = h; }
      showSelected();
    });
  }

  /** This player has chosen: the game is theirs again while friends choose (the strip stays). */
  function release() {
    ctx.ui?.cover?.('reward', false);
    const c = document.getElementById('gf-canvas'); try { c?.focus(); } catch {}
  }
  function hide() {
    clearTimers();
    box.className = ''; st.phase = 'closed'; st.closedAt = performance.now();
    release();
  }

  function strip(run) {
    const R = run.reward, left = Math.max(0, R.left);
    clock.textContent = fill(word('seconds', '{n} s'), { n: Math.ceil(left) }); clock.classList.toggle('low', left <= 5);
    const words = { choosing: word('choosing', 'choosing'), picked: word('picked', 'chose'), passed: word('passed', 'passed') };
    const sig = R.choices.map(c => `${c.player}:${c.state}`).join(',');
    if (sig !== who.dataset.sig) {
      who.dataset.sig = sig; who.replaceChildren(clock);
      for (const c of R.choices) { const s = el('span', c.state === 'choosing' ? '' : 'done'); const dot = el('i'); dot.style.background = colorOf(c.player); s.append(dot, `${c.player === nidOf() ? (ctx.config?.text?.you ?? 'You') : nameOf(c.player)}: ${words[c.state] ?? c.state}`); who.append(s); }
    }
    if (st.phase === 'waiting') { const names = R.choices.filter(c => c.state === 'choosing' && c.player !== nidOf()).map(c => nameOf(c.player)); h1.textContent = names.length ? fill(word('waiting', 'Waiting for {names}'), { names: names.join(', ') }) : ''; }
  }

  // ---- the keys (a keyboard chooses with 1 2 3 or the arrows, Enter takes, Esc passes) ----
  const onKey = e => {
    if (st.phase !== 'choosing' && st.phase !== 'dealing') return;
    const k = e.code;
    const used = ['Digit1', 'Digit2', 'Digit3', 'Numpad1', 'Numpad2', 'Numpad3', 'ArrowLeft', 'ArrowRight', 'Enter', 'NumpadEnter', 'Space', 'Escape', 'KeyA', 'KeyD'].includes(k);
    if (!used) return;
    e.preventDefault(); e.stopPropagation();
    if (st.phase !== 'choosing' || e.repeat) return;
    const n = { Digit1: 0, Digit2: 1, Digit3: 2, Numpad1: 0, Numpad2: 1, Numpad3: 2 }[k];
    if (n !== undefined) { if (st.selected === n) take(); else choose(n); }
    else if (k === 'ArrowLeft' || k === 'KeyA') choose(Math.max(0, (st.selected < 0 ? 1 : st.selected) - 1));
    else if (k === 'ArrowRight' || k === 'KeyD') choose(Math.min(st.offers.length - 1, (st.selected < 0 ? -1 : st.selected) + 1));
    else if (k === 'Escape') pass();
    else take();
  };
  addEventListener('keydown', onKey, true);
  takeBtn.addEventListener('click', e => { e.stopPropagation(); take(); });
  passBtn.addEventListener('click', e => { e.stopPropagation(); pass(); });
  // a click beside the cards keeps the choice (and never reaches the canvas, which would take the pointer)
  box.addEventListener('pointerdown', e => e.stopPropagation());

  // ---- the cards' pictures, fetched ahead of the first reward (the browser keeps them: a card's <img> then has it) ----
  const pictures = [];
  setTimeout(() => { for (const c of rows) { const u = c?.id ? cardPicture(ctx, c.id) : null; if (u) { const im = new Image(); im.decoding = 'async'; im.src = u; pictures.push(im); } } }, 2500);

  // ---- the host: joiners' choices, the director's resume ----
  if (net.active && ctx.host) net.on('fc', (d, from) => { const n = ctx.players?.nid?.(from); if (n && d && Number.isFinite(d.s)) host.cmd.raw(CARD_OP.PICK, [n, d.s >>> 0]); });
  host.on('rule', e => {
    if (e.remote || e.name !== 'reward-done') return;
    const r = st.resume; st.resume = null; st.last = { wave: e.a, picked: e.b, passed: e.c, at: Math.round(ctx.time?.now * 1000) / 1000 };
    if (r) { try { r(); } catch (err) { console.error(err); } }
  });
  // alone with bots: a bot takes its first card after a moment (the host's word)
  const botPicks = new Map();

  const api = {
    /** The host: open the reward (the core deals; resume() is called once when everyone has chosen or the time ran out). */
    open({ wave = 0, resume = null, seconds = 0, seed = null } = {}) {
      if (!rows.length) { resume?.(); return false; }
      const s = seed ?? ((Number(ctx.seed) >>> 0) ^ Math.imul((ctx.round?.number ?? 0) + 1, 0x9e3779b1)) >>> 0;
      st.resume = resume;
      host.cmd.raw(CARD_OP.REWARD, [1, wave >>> 0, s >>> 0, 0], [seconds]);
      return true;
    },
    close() { host.cmd.raw(CARD_OP.REWARD, [0, 0, 0, 0], [0]); },
    /** The host: a card now for a player (a kit player id or a core id), by the card's id or row. */
    give(player, card) { const n = typeof player === 'number' ? player : ctx.players?.nid?.(player); const row = typeof card === 'number' ? card : rows.findIndex(r => r.id === card); if (!n || row < 0) return false; host.cmd.raw(CARD_OP.CARD, [n, row]); return true; },
    /** The host: a downed player back up now (the rules' own way; share 0: the table's). */
    revive(player, share = 0) { const n = typeof player === 'number' ? player : ctx.players?.nid?.(player); if (n) host.cmd.raw(CARD_OP.REVIVE, [n], [share]); return !!n; },
    choose, take, pass,
    run: () => read(),
    /** What card `card` (an id or a row) would change for this copy's player: the core's preview with the inspector's rows. */
    preview(card) { const row = typeof card === 'number' ? card : rows.findIndex(r => r.id === card); try { const p = JSON.parse(forge.feel_card_preview(nidOf(), row)); return p && { ...p, rows: (p.changes ?? []).map(c => changeRow(c, T)) }; } catch { return null; } },
    /** A table value as this copy's player's cards leave it ("player.walk"). */
    value: (path, player = nidOf()) => { const v = forge.feel_value(player, path); return Number.isFinite(v) ? v : null; },
    get phase() { return st.phase; },
    /**
     * The run's facts for a HUD (window.__game.forge.run()): the core's, with each player's kit id and name and each
     * card's id: {reward: {open, wave, left, seconds, choices: [{player (core id), id, name, state, offers, picked}]},
     * players: [{player, id, name, color, local, cards: [ids], down, revive (0..1), reviver, reviverName, alive, hp, hpMax}]}.
     */
    facts() {
      const run = read(); if (!run) return null;
      const id = row => (row == null ? null : rows[row]?.id ?? row), kit = n => ctx.players?.byNid?.(n) ?? null;
      return {
        reward: { open: run.reward.open, wave: run.reward.wave, left: run.reward.left, seconds: run.reward.seconds, choices: run.reward.choices.map(c => ({ player: c.player, id: kit(c.player)?.id ?? null, name: nameOf(c.player), state: c.state, offers: c.offers.map(id), picked: c.picked })) },
        players: run.players.map(p => ({ player: p.id, id: kit(p.id)?.id ?? null, name: nameOf(p.id), color: colorOf(p.id), local: p.local, cards: p.cards.map(id), down: p.down, revive: p.revive, reviver: p.reviver, reviverName: p.reviver ? nameOf(p.reviver) : null, alive: p.alive, hp: p.hp, hpMax: p.hpMax, build: p.build ?? null })),
        perks: run.perks ?? null,
        notes: run.notes ?? [],
      };
    },
    update() {
      if (stagedRevive) stageRevive();
      builds?.update();
      const now = performance.now();
      // the feel view says whether a reward is open and what this player's choice is; the whole run is read when it
      // matters (open, or a few times a second for the observation)
      const v = forge.feel_view(), F = api.F ??= Object.fromEntries(forge.feel_view_names().split(',').map((n, i) => [n, i]));
      const open = v[F.reward] > 0.5;
      if (!open && st.phase === 'closed') return;
      if (now - st.lastRun > 90 || open !== (st.run?.reward?.open ?? false)) { st.run = read(); st.lastRun = now; }
      const run = st.run; if (!run) return;
      // (wave 7: a fresh deal bought at the pedlar's cart deals this player's three again in the same reward)
      if (run.reward.open && (st.phase === 'closed' || st.index !== run.reward.index || ((st.phase === 'choosing' || st.phase === 'dealing') && (mine(run)?.offers ?? []).some((x, i) => x !== st.offers[i])))) show(run);
      if (!run.reward.open) { if (st.phase !== 'closed') hide(); return; }
      const c = mine(run);
      if (st.phase === 'sent' && (c?.state !== 'choosing' || now - st.sent.at > 1500)) {
        // the host has it (or lost it: the choice opens again)
        if (c?.state === 'choosing') { st.phase = 'choosing'; st.cards.forEach(b => b.classList.remove('gone')); showSelected(); }
        else { st.taken = c?.state === 'picked' ? { slot: c.picked, card: rows[st.offers[c.picked]]?.id ?? null, rows: st.rows.slice() } : { slot: null, card: null, rows: [] }; st.phase = 'waiting'; later(Math.min(450, (Number(D.linger) || 0.6) * 1000 - 120), () => { if (st.phase === 'waiting') box.classList.add('waiting'); }); release(); }
      } else if ((st.phase === 'choosing' || st.phase === 'dealing') && c && c.state !== 'choosing') { st.phase = 'waiting'; box.classList.add('waiting'); release(); }
      // alone with bots: each bot takes the first of its three after a moment
      if (ctx.host) for (const ch of run.reward.choices) {
        if (ch.state !== 'choosing') continue;
        const p = ctx.players?.byNid?.(ch.player);
        if (!p?.isBot) continue;
        const k = `${run.reward.index}:${ch.player}`;
        if (!botPicks.has(k)) botPicks.set(k, now + 900 + 500 * (ch.player % 3));
        else if (now >= botPicks.get(k)) { host.cmd.raw(CARD_OP.PICK, [ch.player, 0]); botPicks.set(k, Infinity); }
      }
      strip(run);
    },
    /** What the screen shows (verify, track U's HUD, a play script). */
    observe() {
      const run = read(), c = mine(run), id = row => (row == null ? null : rows[row]?.id ?? row);
      const rect = b => { const r = b.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
      return {
        open: !!run?.reward?.open, phase: st.phase, shown: box.classList.contains('on'), wave: run?.reward?.wave ?? 0, left: run?.reward?.left ?? 0, seconds: run?.reward?.seconds ?? 0,
        offers: (c?.offers ?? []).map(id), state: c?.state ?? 'none', picked: c?.picked ?? null, selected: st.selected,
        cards: st.cards.map((b, i) => ({ id: b.dataset.card || null, name: rows[st.offers[i]]?.name ?? null, rarity: rows[st.offers[i]]?.rarity ?? null, color: rows[st.offers[i]]?.color ?? null, up: b.classList.contains('up'), selected: b.classList.contains('sel'), rect: b.isConnected ? rect(b) : null,
          picture: (im => (im ? { loaded: im.complete && im.naturalWidth > 0, size: [Math.round(im.getBoundingClientRect().width), Math.round(im.getBoundingClientRect().height)] } : null))(b.querySelector('.gfr-sign img')) })),
        inspector: inspect.classList.contains('on') ? { card: id(st.offers[st.selected >= 0 ? st.selected : st.hover]), can: st.preview?.can ?? null, rows: st.rows.map(r => ({ ...r })), family: st.family ?? null } : null,
        families: st.cards.map(b => { const f = b.querySelector('.gfr-fam'); return f ? { id: f.dataset.family, text: f.textContent, done: f.classList.contains('done'), rect: rect(f) } : null; }),
        build: builds?.observe() ?? null,
        taken: st.taken, last: st.last,
        choosing: (run?.reward?.choices ?? []).filter(x => x.state === 'choosing').map(x => ({ player: x.player, name: nameOf(x.player) })),
        who: (run?.reward?.choices ?? []).map(x => ({ player: x.player, name: nameOf(x.player), state: x.state })),
        timings: { dealt: st.dealt.map(Math.round), flipped: st.flipped.map(Math.round), settled: Math.round(st.settled), table: { tick: D.tick, flip: D.flip, flipEvery: D.flipEvery } },
        lifts: { hover: Math.round(innerHeight * (Number(D.hoverLift) || 0.01)), pick: Math.round(innerHeight * (Number(D.pickLift) || 0.033)) },
        buttons: { take: { text: takeBtn.textContent, disabled: takeBtn.disabled }, pass: passBtn.textContent }, opened: st.opened,
        held: (run?.players ?? []).map(p => ({ player: p.id, cards: p.cards.map(id), down: p.down, revive: p.revive, reviver: p.reviver, alive: p.alive, hp: p.hp, hpMax: p.hpMax })),
      };
    },
    /** The build line's facts (wave 7): this player's families, set bonuses and perks. */
    build: () => builds?.observe() ?? null,
    dispose() { removeEventListener('keydown', onKey, true); clearTimers(); box.remove(); builds?.dispose(); },
  };
  return api;
}
