// gf-forge's HUD (wave 2, track U), vendored into a game as gf/forge/hud.js (never edited there). The forge-only widgets
// of the "grim" theme (gf/three/ui/theme.js; research/gf-forge/hud/DESIGN.md), drawn on the shared UI layer (#gf-ui) from
// what the core says: the feel view (gf/forge/feel.js reads it every frame and hands it on), the core's players and
// entities, and its rule events. It never writes the core's state; the touch buttons only add button bits to the local
// player's input (BTN: evade, reload, quick melee, next weapon) and press the shared input's actions (fire, jump, use).
//
//   vitals     in the kit's player card (#gf-hud): health as a large number and a bar notched in tenths, what a hit took
//              in blood for a moment, armour when there is some, stamina under it; the three low-health stages (the feel
//              table's thresholds) each change the colour, the pulse and a word: Wounded, Bleeding, Last breath
//   the wave   top centre: "Wave 2 of 4" (an endless run: "Wave 12"), how many remain and the round clock on one line, the goal under it; a boss's
//              name and bar while one fights
//   score      top left beside the menu button, each gain as a "+n" under it; coins top right. v8 (the creator on
//              Zombie Town v7: "would love to see gold and score back on the display"): bigger numbers (36 px, 28 on a
//              phone) under a brighter label, the whole top of the HUD twice its size on a screen of 2400×1300 and up
//              (the creator plays at 3840×2160); while the cart covers the game its heading shows both
//              (gf/forge/shop.js). verify check 13's phone leg holds them on the screen in a fight
//   friends    under the coins: each other player's name, colour and health; down, and being revived when the game says
//   banners    a wave starting, a wave cleared, a boss rising (soft: the rules' own banner wins); the results card's
//              title takes the outcome's colour
//   touch      a phone's buttons (wave 5, track U2; the creator, 2026-10-11: "make the mobile controls a bit more
//              friendsly, the HUD on the right takes up too much of the screen"): small pictures with no dark disc,
//              see-through until a thumb is on them, in an arc round fire at the bottom right. A button is there only
//              when it can do something: reload with rounds spent, the quick strike with an enemy close, swap with a
//              second weapon in hand, raise beside a fallen friend. Each has its own fixed seat, so none moves when
//              another comes or goes. Their names show under them for the first seconds of a round, with one line on
//              how a phone plays. Fire lets its touch through to the view (a drag on it still turns, and it fires for
//              as long as it is held). The weapon also fires by itself while the aim rests on an enemy (the player's
//              own choice in Settings: on for a touch screen, off for a mouse). Sizes, the look and auto-fire are the
//              slots forge.feel.touch.* (gf/forge/tables/feel.js); touchSeats() lays the seats out from them.
//              The vitals and the rounds stay clear of both thumbs (bottom centre sideways, the top corners upright)
//
// Words are config/game.json → text (ui.* slots: wave, remain, waveStart …); colours and type are the theme's.
//
//   const hud = createForgeHud(ctx);      // after ctx.ui and ctx.hud exist (gf/forge/feel.js makes it)
//   hud.update(dt, view, F)                // every frame: the feel view and its field numbers
//   hud.touch()                            // {held, pressed}: the touch buttons' BTN bits this frame (the boot ORs them in)
//   hud.gyro()                             // {dx, dy}: radians the phone was turned since the last call (gyro aim)
//   hud.settings(row, store)               // the forge rows in the kit's Settings panel (auto-fire; gyro aim and its sensitivity)
//
// Wave 3 (track M): the mouse wheel and a two-finger tap on the look half pick the next weapon (the shared input
// keeps the wheel for its cursor modes, so in first person it reached nobody); gyro aim, off unless the player turns
// it on in Settings (iOS asks for its permission at that tap), scaled by the slot forge.feel.gyro.sensitivity and the
// player's own slider. ctx.forgeHud is this HUD.
//   hud.coins(n)                           // rules.js may set the coins shown (else: the local player's purse, as the
//                                          // core keeps it: picked up, less what they spent; wave 7, gf/forge/shop.js)
//   hud.observe()                          // for QA (window.__game.forge.feel().shown.hud)
import { BTN, KIND, ENTITY_FLAG } from './host.js';
import { loadChoice } from './governor.js';

const CSS = `
/* the shared mechanics on forge (gf/forge/mechanics.js): health, the wave and the coins are this HUD's own vitals, wave
   line and purse, so the kit card's rows for the same facts stay out of sight */
#gf-ui.gf-fh .gf-me > .gf-hp,#gf-ui.gf-fh .gf-me .gf-line[data-widget="waves"],#gf-ui.gf-fh .gf-me .gf-line[data-widget="coins"]{display:none}
#gf-ui.gf-fh .gf-scores{display:none!important}
#gf-ui.gf-fh .gf-cross{display:none!important}
#gf-ui.gf-fh .gf-top,#gf-ui.gf-fh .gf-me,#gf-ui.gf-fh .gf-feel-ammo,#gf-ui .gf-fh-score,#gf-ui .gf-fh-coins,#gf-ui .gf-fh-friends{isolation:isolate}
#gf-ui.gf-fh.gf-fh-on .gf-top::before,#gf-ui.gf-fh .gf-me::before,#gf-ui.gf-fh .gf-feel-ammo::before,#gf-ui .gf-fh-score::before,#gf-ui .gf-fh-coins::before,#gf-ui .gf-fh-friends::before{content:"";position:absolute;inset:-16px -34px;z-index:-1;pointer-events:none;background:radial-gradient(closest-side,color-mix(in srgb,var(--g-ink) 62%,transparent),color-mix(in srgb,var(--g-ink) 30%,transparent) 62%,transparent)}
#gf-ui .gf-fh-vitals{display:flex;align-items:flex-end;gap:12px;text-shadow:var(--g-ts)}
#gf-ui .gf-fh-hpnum{font:800 58px/.8 var(--gf-forge-serif);letter-spacing:-.015em;min-width:1.15em;text-align:right;color:var(--g-bone);transform-origin:0 100%}
#gf-ui .gf-fh-bars{display:flex;flex-direction:column;gap:5px;width:188px;padding-bottom:2px}
#gf-ui .gf-fh-row{display:flex;align-items:baseline;gap:8px;font:600 10.5px/1 var(--gf-forge-serif);letter-spacing:.2em;text-transform:uppercase;color:var(--g-dim);white-space:nowrap}
#gf-ui .gf-fh-row em{font-style:normal}
#gf-ui .gf-fh-row i{font-style:normal;font-weight:700;font-size:12px;letter-spacing:.06em;color:var(--g-moon)}
#gf-ui .gf-fh-row s{text-decoration:none;margin-left:auto;font-weight:700;letter-spacing:.14em;color:color-mix(in srgb,var(--g-blood) 66%,#fff)}
#gf-ui .gf-fh-hp{position:relative;height:13px;background:color-mix(in srgb,var(--g-bone) 14%,#0008);box-shadow:0 0 0 1px #000d}
#gf-ui .gf-fh-hp i{position:absolute;inset:0 auto 0 0;background:var(--g-blood);transition:width .45s ease-in .28s}
#gf-ui .gf-fh-hp u{position:absolute;inset:0 auto 0 0;background:var(--g-bone)}
#gf-ui .gf-fh-hp::after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,transparent 0 calc(10% - 2px),#000d calc(10% - 2px) 10%)}
#gf-ui .gf-fh-st{position:relative;height:4px;background:color-mix(in srgb,var(--g-moon) 18%,#0008);box-shadow:0 0 0 1px #000c}
#gf-ui .gf-fh-st u{position:absolute;inset:0 auto 0 0;background:var(--g-moon);transition:background .2s}
#gf-ui .gf-fh-st.spent u{background:color-mix(in srgb,var(--g-moon) 45%,var(--g-blood))}
#gf-ui .gf-fh-vitals.hit .gf-fh-hpnum{animation:gf-fh-jolt .26s}
@keyframes gf-fh-jolt{25%{transform:translateX(-3px)}55%{transform:translateX(3px)}80%{transform:translateX(-1px)}}
#gf-ui .gf-fh-vitals[data-stage="1"] .gf-fh-hpnum{color:var(--g-ember);animation:gf-fh-beat 1.1s ease-in-out infinite}
#gf-ui .gf-fh-vitals[data-stage="1"] .gf-fh-hp u{background:var(--g-ember)}
#gf-ui .gf-fh-vitals[data-stage="1"] .gf-fh-row s{color:var(--g-ember)}
#gf-ui .gf-fh-vitals[data-stage="2"] .gf-fh-hpnum,#gf-ui .gf-fh-vitals[data-stage="3"] .gf-fh-hpnum{color:color-mix(in srgb,var(--g-blood) 70%,#fff)}
#gf-ui .gf-fh-vitals[data-stage="2"] .gf-fh-hp u,#gf-ui .gf-fh-vitals[data-stage="3"] .gf-fh-hp u{background:color-mix(in srgb,var(--g-blood) 78%,#fff)}
#gf-ui .gf-fh-vitals[data-stage="2"] .gf-fh-hpnum{animation:gf-fh-beat .85s ease-in-out infinite}
#gf-ui .gf-fh-vitals[data-stage="3"] .gf-fh-hpnum{animation:gf-fh-beat3 .6s ease-in-out infinite}
#gf-ui .gf-fh-vitals[data-stage="3"] .gf-fh-hp{box-shadow:0 0 0 1px #000d,0 0 0 2px var(--g-blood)}
@keyframes gf-fh-beat{0%,100%{opacity:1}45%{opacity:.62}}
@keyframes gf-fh-beat3{0%,100%{opacity:1;transform:scale(1)}40%{opacity:.7;transform:scale(1.09)}}
#gf-ui .gf-fh-vitals.dead .gf-fh-hpnum{color:var(--g-blood);animation:none;opacity:.8}
#gf-ui .gf-fh-wave{display:none;flex-direction:column;align-items:center}
#gf-ui.gf-fh-on .gf-fh-wave.on{display:flex}
#gf-ui .gf-fh-wave b{font:700 27px/1.02 var(--gf-forge-display);letter-spacing:.02em;text-shadow:var(--g-ts);white-space:nowrap}
#gf-ui .gf-fh-wave b::after{content:"";display:block;height:1px;margin:5px auto 4px;width:74%;background:linear-gradient(90deg,transparent,var(--g-parch) 22%,var(--g-parch) 78%,transparent);opacity:.75}
#gf-ui .gf-fh-wave.boss b{color:color-mix(in srgb,var(--g-blood) 62%,#fff)}
#gf-ui .gf-fh-sub{display:flex;gap:7px;justify-content:center;align-items:baseline;font:600 13.5px/1.2 var(--gf-forge-serif);letter-spacing:.07em;color:var(--g-dim);text-shadow:var(--g-ts);white-space:nowrap}
#gf-ui .gf-fh-sub .gf-timer{font:inherit;letter-spacing:inherit;color:inherit;text-shadow:none}
#gf-ui .gf-fh-sub .gf-timer.low{color:var(--g-ember)}
#gf-ui:not(.gf-fh-on) .gf-fh-left,#gf-ui .gf-fh-sub .gf-fh-left:empty{display:none}
#gf-ui .gf-fh-sub .gf-fh-left:not(:empty)+.gf-timer::before{content:"·";margin-right:7px;opacity:.7}
#gf-ui .gf-fh-boss{display:none;width:min(440px,58vw);margin:7px auto 1px;flex-direction:column;align-items:center;gap:4px}
#gf-ui.gf-fh-on .gf-fh-boss.on{display:flex}
#gf-ui .gf-fh-boss em{font:700 17px/1.1 var(--gf-forge-display);font-style:normal;letter-spacing:.04em;color:color-mix(in srgb,var(--g-blood) 58%,#fff);text-shadow:var(--g-ts)}
#gf-ui .gf-fh-boss span{position:relative;width:100%;height:7px;background:#000b;box-shadow:0 0 0 1px #000d,0 0 0 2px var(--g-faint)}
#gf-ui .gf-fh-boss span i{position:absolute;inset:0 auto 0 0;background:var(--g-bone);transition:width .5s ease-in .3s}
#gf-ui .gf-fh-boss span u{position:absolute;inset:0 auto 0 0;background:var(--g-blood)}
#gf-ui .gf-fh-score,#gf-ui .gf-fh-coins,#gf-ui .gf-fh-friends{position:absolute;display:none;text-shadow:var(--g-ts)}
#gf-ui.gf-fh-on .gf-fh-score,#gf-ui.gf-fh-on .gf-fh-coins{display:block}
#gf-ui.gf-fh-on .gf-fh-friends.on{display:flex}
#gf-ui .gf-fh-score{top:max(9px,env(safe-area-inset-top));left:calc(max(10px,env(safe-area-inset-left)) + 54px)}
#gf-ui .gf-fh-score em,#gf-ui .gf-fh-coins em{display:block;font:700 11.5px/1 var(--gf-forge-serif);font-style:normal;letter-spacing:.2em;text-transform:uppercase;color:color-mix(in srgb,var(--g-dim) 55%,var(--g-bone));margin-bottom:5px}
#gf-ui .gf-fh-score b,#gf-ui .gf-fh-coins b{display:block;font:800 36px/.9 var(--gf-forge-serif)}
#gf-ui .gf-fh-score i{position:absolute;left:0;top:calc(100% + 3px);font:700 16px/1 var(--gf-forge-serif);font-style:normal;color:var(--g-ember);opacity:0;white-space:nowrap}
#gf-ui .gf-fh-score i.on{animation:gf-fh-plus .95s ease-out forwards}
@keyframes gf-fh-plus{0%{opacity:0;transform:translateY(-6px)}14%{opacity:1;transform:translateY(0)}70%{opacity:1}100%{opacity:0;transform:translateY(7px)}}
#gf-ui .gf-fh-coins{top:max(9px,env(safe-area-inset-top));right:max(14px,env(safe-area-inset-right));text-align:right}
#gf-ui .gf-fh-coins b::before{content:"";display:inline-block;width:11px;height:11px;margin-right:7px;border-radius:50%;box-shadow:inset 0 0 0 2px var(--g-ember),0 0 0 1px #000c;background:radial-gradient(circle,var(--g-ember) 0 2px,transparent 2.5px);vertical-align:3px}
#gf-ui .gf-fh-coins.pop b{animation:gf-fh-coin .3s ease-out}
@keyframes gf-fh-coin{0%{transform:scale(1.25);color:var(--g-ember)}100%{transform:scale(1)}}
#gf-ui .gf-fh-friends{top:calc(max(9px,env(safe-area-inset-top)) + 54px);right:max(14px,env(safe-area-inset-right));flex-direction:column;gap:7px;align-items:flex-end}
#gf-ui .gf-fh-friend{display:grid;grid-template-columns:auto 86px;column-gap:9px;row-gap:2px;align-items:center;font:600 13px/1.15 var(--gf-forge-serif);letter-spacing:.03em}
#gf-ui .gf-fh-friend span{display:flex;align-items:center;gap:7px;justify-content:flex-end;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#gf-ui .gf-fh-friend span::before{content:"";flex:none;width:7px;height:7px;transform:rotate(45deg);background:var(--c,#fff);box-shadow:0 0 0 1px #000c}
#gf-ui .gf-fh-friend u{position:relative;display:block;height:5px;background:color-mix(in srgb,var(--g-bone) 14%,#0008);box-shadow:0 0 0 1px #000c}
#gf-ui .gf-fh-friend u b{position:absolute;inset:0 auto 0 0;background:var(--g-bone)}
#gf-ui .gf-fh-friend em{grid-column:1/-1;justify-self:end;font:700 10px/1 var(--gf-forge-serif);font-style:normal;letter-spacing:.16em;text-transform:uppercase;color:color-mix(in srgb,var(--g-blood) 62%,#fff)}
#gf-ui .gf-fh-friend em:empty{display:none}
#gf-ui .gf-fh-friend.low u b{background:var(--g-ember)}
#gf-ui .gf-fh-friend.down span{opacity:.6}
#gf-ui .gf-fh-friend.down u b{background:var(--g-blood)}
#gf-ui .gf-fh-friend.revive u b{background:var(--g-moon)}
#gf-ui .gf-fh-friend.revive em{color:var(--g-moon)}
#gf-ui .gf-fh-friend.watched span{font-weight:800;color:var(--g-bone)}
#gf-ui .gf-fh-friend.watched span::after{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:#ff4d5e;box-shadow:0 0 0 1px #000c}
#gf-ui.gf-theme-grim .gf-card[data-tone="lost"] h1{color:color-mix(in srgb,var(--g-blood) 66%,#fff)}
#gf-ui.gf-theme-grim .gf-card[data-tone="lost"] h1::after{background:var(--g-blood)}
#gf-ui.gf-theme-grim .gf-card[data-tone="won"] h1{color:color-mix(in srgb,var(--g-ember) 55%,var(--g-bone))}
#gf-ui.gf-fh .gf-touch .gf-fh-btn{position:absolute;pointer-events:auto;box-sizing:border-box;border:0;padding:0;margin:0;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;width:var(--s);height:var(--s);right:calc(var(--x) - var(--s) / 2 + env(safe-area-inset-right));bottom:calc(var(--y) - var(--s) / 2 + env(safe-area-inset-bottom));background:none;box-shadow:none;color:var(--g-bone);opacity:var(--fh-rest,.6);font:700 11px/1 var(--gf-forge-serif);letter-spacing:.1em;text-transform:uppercase;font-kerning:none;text-shadow:0 1px 0 #000,0 0 4px #000c;touch-action:none;-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none;transition:opacity .12s}
#gf-ui.gf-fh .gf-touch .gf-fh-btn svg{flex:none;width:calc(var(--s) * .58);height:calc(var(--s) * .58);overflow:visible;fill:none;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
#gf-ui.gf-fh .gf-touch .gf-fh-btn svg .o{stroke:#000;stroke-opacity:.62;stroke-width:4.4}
#gf-ui.gf-fh .gf-touch .gf-fh-btn svg .l{stroke:currentColor;stroke-width:2.1}
#gf-ui.gf-fh .gf-touch .gf-fh-btn svg .f{fill:currentColor;stroke:none}
#gf-ui.gf-fh .gf-touch .gf-fh-btn em{display:none;font-style:normal;font-size:12px;letter-spacing:.02em;white-space:nowrap;pointer-events:none}
#gf-ui.gf-fh .gf-touch .gf-fh-btn.named svg{width:calc(var(--s) * .48);height:calc(var(--s) * .48)}
#gf-ui.gf-fh .gf-touch .gf-fh-btn.named em{display:block}
#gf-ui.gf-fh .gf-touch .gf-fh-btn.down{opacity:1;background:color-mix(in srgb,var(--g-bone) 22%,transparent);box-shadow:inset 0 0 0 1.5px var(--g-bone)}
#gf-ui.gf-fh .gf-touch .gf-fh-btn[data-fh="fire"]{pointer-events:none;color:color-mix(in srgb,var(--g-ember) 72%,#fff);box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--g-ember) 78%,transparent)}
#gf-ui.gf-fh .gf-touch .gf-fh-btn[data-fh="fire"].down,#gf-ui.gf-fh .gf-touch .gf-fh-btn[data-fh="fire"].auto{opacity:1;background:color-mix(in srgb,var(--g-ember) 26%,transparent);box-shadow:inset 0 0 0 2px var(--g-ember)}
#gf-ui.gf-fh .gf-touch .gf-fh-btn.dim{opacity:calc(var(--fh-rest,.6) * .45)}
#gf-ui.gf-fh .gf-touch .gf-fh-btn.off{visibility:hidden;pointer-events:none}
#gf-ui.gf-fh:not(.gf-fh-on) .gf-touch .gf-fh-btn,#gf-ui.gf-fh:not(.gf-fh-on) .gf-touch .gf-fh-tip{display:none}
#gf-ui.gf-fh.gf-fh-discs .gf-touch .gf-fh-btn{background:color-mix(in srgb,var(--g-ink) 56%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--g-parch) 62%,transparent),0 0 0 1px #000a}
#gf-ui.gf-fh.gf-fh-discs .gf-touch .gf-fh-btn.down{background:color-mix(in srgb,var(--g-bone) 26%,transparent);box-shadow:inset 0 0 0 2px var(--g-bone),0 0 0 1px #000a}
#gf-ui.gf-fh.gf-fh-discs .gf-touch .gf-fh-btn[data-fh="fire"]{box-shadow:inset 0 0 0 1.5px var(--g-ember),0 0 0 1px #000a}
#gf-ui.gf-fh.gf-fh-words .gf-touch .gf-fh-btn svg{display:none}
#gf-ui.gf-fh.gf-fh-words .gf-touch .gf-fh-btn em{display:block;font-size:12px;letter-spacing:.02em}
#gf-ui .gf-touch .gf-fh-tip{position:absolute;left:50%;bottom:27%;transform:translateX(-50%);max-width:min(78vw,460px);text-align:center;pointer-events:none;font:500 13px/1.3 var(--gf-forge-serif);font-style:italic;letter-spacing:.02em;color:var(--g-dim);text-shadow:var(--g-ts);opacity:0;transition:opacity .5s}
#gf-ui .gf-touch .gf-fh-tip.on{opacity:.92}
#gf-ui .gf-touch .gf-fh-tip span{display:inline-block;margin:0 8px}
@media (orientation:landscape){#gf-ui.gf-fh.gf-fh-touch .gf-prompt{bottom:calc(var(--fh-row,106px) + env(safe-area-inset-bottom))}}
@media (orientation:portrait){#gf-ui.gf-fh.gf-fh-touch .gf-prompt,#gf-ui .gf-touch .gf-fh-tip{bottom:calc(var(--fh-top,262px) + env(safe-area-inset-bottom))}}
#gf-ui.gf-fh-touch .gf-fsbtn{display:none!important}
/* a phone: no HUD text under 12 px (review of Zombie Town v8) */
#gf-ui.gf-fh-touch .gf-fh-row,#gf-ui.gf-fh-touch .gf-fh-score em,#gf-ui.gf-fh-touch .gf-fh-coins em,#gf-ui.gf-fh-touch .gf-fh-friend em{font-size:12px;letter-spacing:.1em}
@media (orientation:landscape){
#gf-ui.gf-fh-touch .gf-me{left:auto;right:calc(50% + 12px);bottom:max(8px,env(safe-area-inset-bottom))}
#gf-ui.gf-fh-touch .gf-me-name{display:none}
#gf-ui.gf-fh-touch .gf-fh-hpnum{font-size:38px}
#gf-ui.gf-fh-touch .gf-fh-bars{width:128px;gap:4px}
#gf-ui.gf-fh-touch .gf-fh-hp{height:10px}
}
@media (orientation:portrait){
#gf-ui.gf-fh-touch .gf-me{left:max(12px,env(safe-area-inset-left));top:calc(max(9px,env(safe-area-inset-top)) + 78px);bottom:auto}
#gf-ui.gf-fh-touch .gf-me-name{display:none}
#gf-ui.gf-fh-touch .gf-fh-hpnum{font-size:40px}
#gf-ui.gf-fh-touch .gf-fh-bars{width:112px;gap:4px}
#gf-ui.gf-fh-touch .gf-fh-hp{height:10px}
#gf-ui.gf-fh-touch .gf-fh-friends{top:calc(max(9px,env(safe-area-inset-top)) + 134px);left:max(12px,env(safe-area-inset-left));right:auto;align-items:flex-start}
#gf-ui.gf-fh-touch .gf-fh-friend span{justify-content:flex-start}
#gf-ui.gf-fh-touch .gf-fh-friend em{justify-self:start}
}
@media (max-width:640px){
#gf-ui .gf-fh-wave b{font-size:21px}
#gf-ui .gf-fh-sub{font-size:12px}
#gf-ui .gf-fh-score b,#gf-ui .gf-fh-coins b{font-size:28px}
#gf-ui .gf-fh-score{left:calc(max(8px,env(safe-area-inset-left)) + 46px)}
#gf-ui .gf-fh-coins,#gf-ui .gf-fh-friends{right:max(10px,env(safe-area-inset-right))}
#gf-ui .gf-fh-friend{grid-template-columns:auto 58px;font-size:12px}
#gf-ui .gf-fh-friend span{max-width:84px}
#gf-ui .gf-fh-boss em{font-size:14px}
}
@media (max-height:480px){
#gf-ui .gf-fh-wave b{font-size:21px}
#gf-ui .gf-fh-wave b::after{margin:3px auto 2px}
#gf-ui .gf-fh-sub{font-size:12px}
#gf-ui .gf-fh-score b,#gf-ui .gf-fh-coins b{font-size:28px}
#gf-ui .gf-fh-friends{top:calc(max(9px,env(safe-area-inset-top)) + 46px)}
}
@media (min-width:1500px) and (min-height:880px){
#gf-ui.gf-fh:not(.gf-fh-touch) .gf-me,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-top,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-score,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-coins,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-friends{zoom:1.3}
}
@media (min-width:2400px) and (min-height:1300px){
#gf-ui.gf-fh:not(.gf-fh-touch) .gf-me,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-top,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-score,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-coins,#gf-ui.gf-fh:not(.gf-fh-touch) .gf-fh-friends{zoom:2}
}
`;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmt = (t, v = {}) => String(t ?? '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined && v[k] !== null ? String(v[k]) : ''));
const r2 = v => Math.round(v * 100) / 100;
/** The first word of a control's words, as a button's label ("fire (hold …)" → "Fire"). */
const word = (s, d) => { const w = String(s ?? '').trim().split(/[\s(,:;]+/)[0]; return w ? w.slice(0, 7) : d; };

/** Does a control's own words say it does something? (one the game lists as "nothing yet" gets no button) */
const does = s => typeof s === 'string' && s.trim() !== '' && !/^nothing/i.test(s.trim());
/** Words that say a control is for a fallen friend (down and revive). */
const FRIEND = /\b(fallen|downed|revives?|raises?|rescues?|friends?|ally|allies)\b/i;

/**
 * The touch buttons a forge game has, by what its tables hold: [{id, label, icon, action | bit, tap?, when}].
 * `when` says when a button is on the screen (the slot forge.feel.touch.always shows them all, always):
 *   'always'   fire, jump, the evade; a second action or a use the game's own words give a job
 *   'spent'    reload: the weapon in hand has a magazine and rounds are spent (it loads by itself when empty)
 *   'close'    the quick strike: something to hit is within its reach
 *   'second'   swap: a second weapon is in hand
 *   'friend'   use, in a game whose players can be raised and whose words for it are about a fallen friend: beside
 *              one (the kit's prompt is up), and while the raise runs
 */
export function touchPlan(game = {}) {
  const C = game.controls ?? {}, more = Array.isArray(C.more) ? C.more : [], weapons = game.forge?.weapons ?? [];
  // controls.more rows name their touch control ("Dodge button"): its first word is the label
  const named = what => { const r = more.find(x => Array.isArray(x) && new RegExp(what, 'i').test(String(x[1] ?? ''))); return r?.[2] ? word(r[2], null) : null; };
  const out = [];
  if (weapons.length || C.primary) out.push({ id: 'fire', label: word(C.primary, 'Fire'), icon: 'fire', action: 'primary', when: 'always' });
  out.push({ id: 'jump', label: word(C.jump, 'Jump'), icon: 'jump', action: 'jump', when: 'always' });
  out.push({ id: 'evade', label: named('evade|dodge') ?? 'Dodge', icon: 'evade', bit: BTN.EVADE, when: 'always' });
  if (weapons.some(w => (w.magazine ?? 0) > 0)) out.push({ id: 'reload', label: named('reload') ?? 'Load', icon: 'reload', bit: BTN.RELOAD, when: 'spent' });
  if (weapons.length) out.push({ id: 'melee', label: named('melee|strike') ?? 'Strike', icon: 'melee', bit: BTN.MELEE, when: 'close' });
  if (weapons.length > 1) out.push({ id: 'swap', label: named('weapon|swap') ?? 'Swap', icon: 'swap', bit: BTN.NEXT, tap: true, when: 'second' });
  // the second action and use: only when the game says they do something
  if (does(C.secondary)) out.push({ id: 'alt', label: word(C.secondary, 'Alt'), icon: 'alt', action: 'secondary', when: 'always' });
  if (does(C.interact)) {
    const raise = (game.players?.max ?? 1) > 1 && Number(game.forge?.player?.revive?.time) > 0 && FRIEND.test(C.interact);
    out.push({ id: 'use', label: word(C.interact, 'Use'), icon: raise ? 'raise' : 'use', action: 'interact', when: raise ? 'friend' : 'always' });
  }
  return out;
}

/** The kit's own values for the slots forge.feel.touch.* (gf/forge/tables/feel.js declares the same; a test holds the
 *  two together). A game made before the slots plays on these. */
export const TOUCH = { size: 46, fire: 60, gap: 10, edge: 12, lift: 30, rest: 0.6, discs: false, words: false, hint: 6, tip: 'Left thumb moves, right thumb looks', autoTip: 'Aim at an enemy and it fires by itself', always: false, autoFire: { on: true, cone: 2.5, delay: 0.12, range: 30 } };
/** What the readouts along the bottom of a phone held sideways take (health, the rounds: this file and gf/forge/feel.js), px. */
export const TOUCH_STRIP = 54;
/** Each button's own seat: [ring, degrees]. 180° is beside fire toward the middle of the screen, 90° straight above
 *  it, 0° toward the screen's edge. Ring 1 is one gap out from fire, ring 2 one button further. Seats never move:
 *  a button that is not there leaves its seat empty. */
const SEAT = { evade: [1, 180], melee: [1, 130], swap: [1, 80], jump: [1, 30], reload: [2, 105], use: [2, 62] };

/**
 * Where every touch button sits, from the slot values: {id: {x, y, s}}, the centre's distance from the screen's right
 * and bottom edges and the width, CSS px (the safe area is added by the style sheet). Fire rests where the right thumb
 * does; the others are an arc round it that stays above the readouts along the bottom and off the middle of the
 * screen. Upright, everything sits `lift` higher. (pure)
 */
export function touchSeats(cfg = {}, { upright = false } = {}) {
  const n = (v, d, lo, hi) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const size = n(cfg.size, TOUCH.size, 16, 200), fire = n(cfg.fire, TOUCH.fire, 16, 260), gap = n(cfg.gap, TOUCH.gap, 0, 80), edge = n(cfg.edge, TOUCH.edge, 0, 120);
  const lift = upright ? n(cfg.lift, TOUCH.lift, 0, 400) : 0, rad = d => (d * Math.PI) / 180;
  const r1 = fire / 2 + gap + size / 2, r2 = r1 + size + gap * 0.6;
  const fx = edge + size / 2 + r1 * Math.cos(rad(30)), fy = Math.max(edge + fire / 2, TOUCH_STRIP + size / 2) + lift;
  const seats = { fire: { x: fx, y: fy, s: fire } };
  for (const [id, [ring, deg]] of Object.entries(SEAT)) seats[id] = { x: Math.max(edge + size / 2, fx - (ring === 1 ? r1 : r2) * Math.cos(rad(deg))), y: fy + (ring === 1 ? r1 : r2) * Math.sin(rad(deg)), s: size };
  // a second action: beside the evade, further in along the same row
  seats.alt = { x: seats.evade.x + size + gap, y: fy, s: size };
  return seats;
}

/** The buttons' pictures: strokes on a 24 unit square, drawn twice (a dark line under a light one, so they read on any
 *  picture with no disc behind them). Our own drawings. */
const ICONS = {
  fire: { d: ['M12 2.6v4.2', 'M12 17.2v4.2', 'M2.6 12h4.2', 'M17.2 12h4.2', 'M18.6 12a6.6 6.6 0 1 1-13.2 0a6.6 6.6 0 1 1 13.2 0'], dot: [12, 12, 1.5] },
  jump: { d: ['M5.5 12.5l6.5-6.5l6.5 6.5', 'M5.5 19l6.5-6.5l6.5 6.5'] },
  evade: { d: ['M3 7.5h6', 'M2 12h8', 'M3 16.5h6', 'M13 5.5l6.5 6.5l-6.5 6.5'] },
  melee: { d: ['M6.5 17.5L19 5', 'M15 4.5h4.5V9', 'M4.5 12.5l7 7', 'M3.5 20.5l3-3'] },
  reload: { d: ['M18.55 14.57A7.5 7.5 0 1 1 16.8 6.7L20.5 9.5', 'M20.5 4.5v5h-5'] },
  swap: { d: ['M4 8h15', 'M15.5 4.5L19 8l-3.5 3.5', 'M20 16H5', 'M8.5 12.5L5 16l3.5 3.5'] },
  raise: { d: ['M12 7v10', 'M7 12h10', 'M21 12a9 9 0 1 1-18 0a9 9 0 1 1 18 0'] },
  use: { d: ['M20.5 12a8.5 8.5 0 1 1-17 0a8.5 8.5 0 1 1 17 0'], dot: [12, 12, 2.6] },
  alt: { d: ['M12 3l9 9l-9 9l-9-9z'], dot: [12, 12, 1.8] },
};
const SVG = 'http://www.w3.org/2000/svg';
function icon(name) {
  const I = ICONS[name]; if (!I) return null;
  const s = document.createElementNS(SVG, 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  for (const cls of ['o', 'l']) for (const d of I.d) { const p = document.createElementNS(SVG, 'path'); p.setAttribute('d', d); p.setAttribute('class', cls); s.append(p); }
  if (I.dot) { const c = document.createElementNS(SVG, 'circle'); c.setAttribute('cx', I.dot[0]); c.setAttribute('cy', I.dot[1]); c.setAttribute('r', I.dot[2]); c.setAttribute('class', 'f'); s.append(c); }
  return s;
}

export function createForgeHud(ctx, { host = ctx.forge } = {}) {
  const ui = ctx.ui, root = ui?.root;
  if (!host || !root) return null;
  if (!document.getElementById('gf-fh-css')) { const s = el('style'); s.id = 'gf-fh-css'; s.textContent = CSS; document.head.append(s); }
  root.classList.add('gf-fh');
  const T = ctx.config?.text ?? {}, game = ctx.config ?? {};
  const W = { health: 'Health', stamina: 'Stamina', wounded: 'Wounded', bleeding: 'Bleeding', lastBreath: 'Last breath', down: 'You are down', wave: 'Wave {n} of {m}', waveEndless: 'Wave {n}', remain: '{n} remain', waveStart: 'Wave {n}', waveStartSub: '{count} come for you',
    waveClear: 'Wave {n} is broken', waveClearSub: 'Catch your breath', bossRises: '{name} rises', score: 'Score', coins: 'Coins', friendDown: 'down', friendRising: 'rising', ...Object.fromEntries(Object.entries(T).filter(([, v]) => typeof v === 'string')) };

  // ---- vitals, in the kit's player card ----
  const card = root.querySelector('#gf-hud');
  const vitals = el('div', 'gf-fh-vitals'); vitals.dataset.widget = 'forge-vitals';
  const hpNum = el('b', 'gf-fh-hpnum', ''), bars = el('div', 'gf-fh-bars');
  const row = el('div', 'gf-fh-row'), label = el('em', null, W.health), ward = el('i'), stageWord = el('s');
  const hpBar = el('div', 'gf-fh-hp'), hpLag = el('i'), hpFill = el('u'); hpBar.append(hpLag, hpFill);
  const stBar = el('div', 'gf-fh-st'), stFill = el('u'); stBar.append(stFill); stBar.title = W.stamina;
  row.append(label, ward, stageWord); bars.append(row, hpBar, stBar); vitals.append(hpNum, bars);
  if (card) card.insertBefore(vitals, card.querySelector('.gf-status') ?? null);

  // ---- the wave, top centre: one column with the kit's clock and goal ----
  const top = root.querySelector('.gf-top'), timer = root.querySelector('.gf-timer'), goal = root.querySelector('#gf-goal');
  const wave = el('div', 'gf-fh-wave'), waveTitle = el('b'), sub = el('div', 'gf-fh-sub'), left = el('span', 'gf-fh-left');
  const boss = el('div', 'gf-fh-boss'), bossName = el('em'), bossTrack = el('span'), bossLag = el('i'), bossFill = el('u');
  bossTrack.append(bossLag, bossFill); boss.append(bossName, bossTrack);
  wave.append(waveTitle); sub.append(left);
  if (top) { top.prepend(wave); if (timer) sub.append(timer); top.append(sub, boss); if (goal) top.append(goal); }

  // ---- score, coins, friends ----
  const score = el('div', 'gf-fh-score'), scoreN = el('b', null, '0'), scorePlus = el('i');
  score.append(el('em', null, W.score), scoreN, scorePlus);
  const coinsEl = el('div', 'gf-fh-coins'), coinsN = el('b', null, '0');
  coinsEl.append(el('em', null, W.coins), coinsN);
  const friends = el('div', 'gf-fh-friends');
  root.append(score, coinsEl, friends);

  // ---- touch: a phone's buttons (wave 5, track U2: small pictures in fixed seats, there when they can do something) ----
  const layer = ui.touchLayer, canvas = document.getElementById('gf-canvas');
  const plan = touchPlan(game), btns = new Map();
  const bits = { held: 0, pressed: 0 };
  const offs = [];
  /** The slots forge.feel.touch.* as they are now (the tables are filled with the kit's own values). */
  const touchCfg = () => { const t = ctx.tables?.feel?.touch ?? {}; return { ...TOUCH, ...t, autoFire: { ...TOUCH.autoFire, ...(t.autoFire ?? {}) } }; };
  const press = (b, down) => {
    if (b.down === down) return;
    b.down = down; b.e.classList.toggle('down', down);
    if (b.action) ctx.input?.press(b.action, down);
    else if (down) { bits.pressed |= b.bit; if (!b.tap) bits.held |= b.bit; }
    else bits.held &= ~b.bit;
  };
  for (const p of plan) {
    const e = el(p.id === 'fire' ? 'div' : 'button', 'gf-fh-btn'); e.dataset.fh = p.id; e.setAttribute('aria-label', p.label); if (e.tagName === 'BUTTON') e.type = 'button';
    const pic = icon(p.icon); if (pic) e.append(pic);
    e.append(el('em', null, p.label));
    // on: it is on the screen now; nameT: seconds its name still shows under it
    const b = { ...p, e, down: false, ids: new Set(), on: true, nameT: 0 };
    btns.set(p.id, b);
    if (p.id !== 'fire') {
      const on = ev => { ev.preventDefault(); ev.stopPropagation(); if (b.on) press(b, true); }, off = ev => { ev.preventDefault(); press(b, false); };
      e.addEventListener('pointerdown', on); e.addEventListener('pointerup', off); e.addEventListener('pointercancel', off); e.addEventListener('pointerleave', off);
      e.addEventListener('contextmenu', ev => ev.preventDefault());
    }
    layer?.append(e);
  }
  const tip = el('div', 'gf-fh-tip'); layer?.append(tip);
  // every button into its seat, from the slots and the way the phone is held; again whenever the screen changes
  const lay = { seats: {}, upright: false };
  const layout = () => {
    const t = touchCfg();
    lay.upright = innerHeight > innerWidth; lay.seats = touchSeats(t, { upright: lay.upright });
    for (const b of btns.values()) { const s = lay.seats[b.id]; if (!s) continue; for (const k of ['x', 'y', 's']) b.e.style.setProperty(`--${k}`, `${r2(s[k])}px`); }
    const rest = Number(t.rest);
    root.style.setProperty('--fh-rest', String(Number.isFinite(rest) ? Math.max(0.05, Math.min(1, rest)) : TOUCH.rest));
    root.classList.toggle('gf-fh-discs', !!t.discs); root.classList.toggle('gf-fh-words', !!t.words);
    // the kit's prompt line and the phone's own line stay clear of the seats: over the evade's row sideways, over
    // the highest seat upright
    const mine = [...btns.keys()].map(id => lay.seats[id]).filter(Boolean);
    root.style.setProperty('--fh-row', `${Math.round((lay.seats.fire?.y ?? 77) + (lay.seats.evade?.s ?? TOUCH.size) / 2 + 6)}px`);
    root.style.setProperty('--fh-top', `${Math.round(Math.max(0, ...mine.map(q => q.y + q.s / 2)) + 20)}px`);
  };
  layout();
  addEventListener('resize', layout); offs.push(() => removeEventListener('resize', layout));
  /** A button comes or goes (its seat stays its own); one that goes while a thumb is on it is let go. */
  const show = (b, on) => { if (b.on === on) return; b.on = on; b.e.classList.toggle('off', !on); if (!on) { b.ids.clear(); press(b, false); } };
  // fire lets its touch through to the canvas, so the same thumb that holds it turns the view (the shared input's look
  // half); this only notes that the touch began on the button
  const fire = btns.get('fire');
  if (fire && canvas) {
    const inside = t => { const r = fire.e.getBoundingClientRect(); return r.width > 0 && t.clientX >= r.left - 8 && t.clientX <= r.right + 8 && t.clientY >= r.top - 8 && t.clientY <= r.bottom + 8; };
    const start = ev => { for (const t of ev.changedTouches) if (t.target === canvas && inside(t)) fire.ids.add(t.identifier); if (fire.ids.size) press(fire, true); };
    const end = ev => { for (const t of ev.changedTouches) fire.ids.delete(t.identifier); if (!fire.ids.size) press(fire, false); };
    canvas.addEventListener('touchstart', start, { passive: true });
    addEventListener('touchend', end); addEventListener('touchcancel', end);
    offs.push(() => { canvas.removeEventListener('touchstart', start); removeEventListener('touchend', end); removeEventListener('touchcancel', end); });
  }

  // ---- auto-fire (wave 5, track U2): the weapon fires by itself while the aim rests on an enemy ----
  // The player's own choice (Settings): on for a touch screen unless the game's slot says no, off for a mouse. What
  // "rests on an enemy" means: an enemy (or a target the rules stood up) in range whose body the aim is on, within
  // `cone` of its edge, with nothing of the world in between (the core's clear_line), for `delay` seconds. Looked at
  // about twelve times a second from what the core already gives every frame (the camera, the entities); the same look
  // says how near the nearest body is, which is when the quick strike's button is there. It presses the fire button's
  // own bit and nothing else: the core paces the shots, reloads and bends them as for a thumb (aim help).
  const A = { choice: null, aimed: false, t: 0, fire: false, was: false, pulls: 0, near: Infinity, scanT: 0, gap: 0, semi: false, cfg: touchCfg() };
  { const c = loadChoice(ctx.assets?.manifest?.game ?? 'game'); if (typeof c.autoFire === 'boolean') A.choice = c.autoFire; }
  const autoWanted = () => (A.choice !== null ? A.choice : !!ctx.input?.touch && A.cfg.autoFire.on !== false);
  const strikeReach = () => { const w = (ctx.tables?.weapons ?? []).find(x => x.kind === 'melee'); return (Number(w?.melee?.reach) || 2.2) + 1.3; };
  const scan = (range, wantAim) => {
    const eye = host.eye(), cone = (Math.max(0, Number(A.cfg.autoFire.cone) || 0) * Math.PI) / 180;
    let near = Infinity, aimed = false;
    for (const kind of [KIND.ENEMY, 17]) for (const e of host.entities(kind)) {
      if (e.flags & ENTITY_FLAG.DEAD) continue;
      const dx = e.x - eye.x, dz = e.z - eye.z, hd = Math.hypot(dx, dz);
      if (hd < near) near = hd;
      if (!wantAim || aimed || hd > range) continue;
      const row = kind === KIND.ENEMY ? ctx.tables?.enemies?.[e.type | 0] : null;
      const tall = (Number(row?.height) || 1.8) * (Number(row?.scale) || 1), wide = 0.32 * (Number(row?.scale) || 1);
      let dyaw = Math.atan2(-dx, -dz) - eye.yaw; while (dyaw > Math.PI) dyaw -= 2 * Math.PI; while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      if (Math.abs(dyaw) > cone + Math.atan2(wide, Math.max(hd, 0.3))) continue;
      const lo = Math.atan2(e.y + 0.06 * tall - eye.y, Math.max(hd, 0.05)) - cone, hi = Math.atan2(e.y + tall - eye.y, Math.max(hd, 0.05)) + cone;
      if (eye.pitch < lo || eye.pitch > hi) continue;
      // nothing of the world between the eye and where the aim crosses the body
      const ty = Math.min(e.y + 0.92 * tall, Math.max(e.y + 0.2 * tall, eye.y + Math.tan(eye.pitch) * hd));
      let clear = true; try { clear = host.clearLine?.({ x: eye.x, y: eye.y, z: eye.z }, { x: e.x, y: ty, z: e.z }) !== false; } catch { clear = true; }
      if (clear) aimed = true;
    }
    A.near = near; A.aimed = aimed;
  };
  const releaseAll = () => { for (const b of btns.values()) { b.ids.clear(); press(b, false); } bits.held = 0; bits.pressed = 0; A.fire = false; A.aimed = false; A.t = 0; };
  addEventListener('blur', releaseAll); offs.push(() => removeEventListener('blur', releaseAll));

  // ---- the next weapon: the mouse wheel, and two fingers tapped on the look half (wave 3) ----
  const swaps = (game.forge?.weapons ?? []).length > 1;
  const G = { wheelAt: 0, taps: new Map(), swapAt: 0, wheel: 0, twoFinger: 0 };
  if (swaps && canvas) {
    const playing = () => (ctx.round?.phase ?? 'playing') === 'playing' && !ui.covered && ctx.input?.enabled !== false;
    const swap = bit => { const t = performance.now(); if (t - G.swapAt < 140) return false; G.swapAt = t; bits.pressed |= bit; return true; };
    // a notch a swap, toward the player the next one (a trackpad's stream of small steps is one swap in 140 ms)
    const onWheel = e => { if (ctx.input?.cursorMode || !playing() || !e.deltaY) return; if (swap(e.deltaY > 0 ? BTN.NEXT : BTN.PREV)) G.wheel++; e.preventDefault(); };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // two fingers put down together on the look half and lifted again within a third of a second, neither dragged:
    // never the thumb on Fire (its touch began on the button) and never the stick's half
    const onStart = e => { const t = performance.now(); for (const c of e.changedTouches) if (c.target === canvas && c.clientX >= innerWidth / 2 && !fire?.ids.has(c.identifier)) G.taps.set(c.identifier, { t, x: c.clientX, y: c.clientY, moved: false }); };
    const onMove = e => { for (const c of e.changedTouches) { const a = G.taps.get(c.identifier); if (a && Math.hypot(c.clientX - a.x, c.clientY - a.y) > 14) a.moved = true; } };
    const onEnd = e => {
      const t = performance.now(), mine = [...e.changedTouches].map(c => G.taps.get(c.identifier)).filter(Boolean);
      for (const a of mine) {
        const pair = [...G.taps.values()].find(b => b !== a && Math.abs(b.t - a.t) < 130 && !b.moved && !b.used);
        if (pair && !a.moved && !a.used && t - a.t < 330 && playing()) { a.used = pair.used = true; if (swap(BTN.NEXT)) G.twoFinger++; }
      }
      for (const c of e.changedTouches) G.taps.delete(c.identifier);
    };
    canvas.addEventListener('touchstart', onStart, { passive: true }); addEventListener('touchmove', onMove, { passive: true }); addEventListener('touchend', onEnd); addEventListener('touchcancel', onEnd);
    offs.push(() => { canvas.removeEventListener('wheel', onWheel); canvas.removeEventListener('touchstart', onStart); removeEventListener('touchmove', onMove); removeEventListener('touchend', onEnd); removeEventListener('touchcancel', onEnd); });
  }

  // ---- gyro aim (wave 3): the phone turned is the view turned; off unless the player turns it on ----
  // The rate the phone turns (devicemotion's rotationRate, degrees a second about the device's own axes) is added up
  // between frames. Which axis is "turn" and which is "tilt" follows the way the screen is held (screen.orientation):
  // upright, turning is about the device's long axis (gamma) and tilting about its short one (beta); on its side the
  // two change places. Not tried on a phone: no device was here (the report says so).
  const gy = { on: false, dx: 0, dy: 0, last: 0, events: 0, denied: false, asked: false, user: 1 };
  const gyroBase = () => { const v = Number(ctx.tables?.feel?.gyro?.sensitivity); return Number.isFinite(v) ? v : 1; };
  const onMotion = e => {
    const r = e.rotationRate;
    if (!gy.on || !r) return;
    const t = performance.now(), dt = Math.min(0.1, gy.last ? (t - gy.last) / 1000 : (Number(e.interval) > 1 ? e.interval / 1000 : Number(e.interval) || 0.016));
    gy.last = t; gy.events++;
    if ((ctx.round?.phase ?? 'playing') !== 'playing' || ui.covered || ctx.input?.enabled === false) return;
    const held = Number(globalThis.screen?.orientation?.angle ?? globalThis.orientation), a = Number.isFinite(held) ? held : 0, k = Math.round((((a % 360) + 360) % 360) / 90) % 4;
    const beta = Number(r.beta) || 0, gamma = Number(r.gamma) || 0;
    // degrees a second, + turning left and + tilting up, as the player sees them
    const [turn, tilt] = k === 0 ? [gamma, beta] : k === 1 ? [beta, -gamma] : k === 2 ? [-gamma, -beta] : [-beta, gamma];
    const s = (Math.PI / 180) * dt * gyroBase() * gy.user;
    // the core's look: + dx turns right, + dy looks down (a mouse's way)
    gy.dx -= turn * s; gy.dy -= tilt * s * (ctx.input?.invertY ? -1 : 1);
  };
  const gyroSet = async want => {
    if (!want) { gy.on = false; removeEventListener('devicemotion', onMotion); gy.dx = gy.dy = 0; return false; }
    const DM = globalThis.DeviceMotionEvent;
    if (!DM) { gy.denied = true; return false; }
    // iOS asks, and only at a tap: the Settings toggle's own
    if (typeof DM.requestPermission === 'function') { gy.asked = true; let ok = false; try { ok = (await DM.requestPermission()) === 'granted'; } catch { ok = false; } if (!ok) { gy.denied = true; return false; } }
    gy.denied = false; gy.on = true; gy.last = 0;
    addEventListener('devicemotion', onMotion);
    return true;
  };
  offs.push(() => removeEventListener('devicemotion', onMotion));

  // ---- what the core says happened: waves, the boss, coins ----
  const S = { wave: null, boss: null, coins: 0, coinsSet: null, lastScore: null, plus: 0, plusT: 0, lastHp: null, hitT: 0, phase: null, helpT: 0, coinT: 0, friendsKey: '', lastBoss: null };
  // the shared HUD reads these three where this HUD draws them (its CSS hides the card's rows for the same facts):
  // measure 21 then finds the health, the wave and the coins a player sees (builder/ui/hud.js drawnBy)
  ctx.hud?.drawnBy?.('health', () => { const max = S.max ?? 100; return { node: vitals, shows: { value: Number.isFinite(S.frac) ? Math.round(S.frac * max * 10) / 10 : Number(hpNum.textContent), max, text: hpNum.textContent } }; });
  ctx.hud?.drawnBy?.('waves', () => ({ node: wave, shows: { wave: Number(wave.dataset.wave), alive: Number(wave.dataset.left), text: `${waveTitle.textContent} · ${left.textContent}` } }));
  ctx.hud?.drawnBy?.('coins', () => ({ node: coinsEl, shows: { value: Number(coinsN.textContent), text: coinsN.textContent } }));
  const localId = () => host.players().find(p => p.local)?.id ?? 0;
  const enemyName = r => ctx.tables?.enemies?.[r | 0]?.name || ctx.tables?.enemies?.[r | 0]?.id || '';
  offs.push(host.on('rule', e => {
    if (e.name === 'wave-start') {
      S.wave = { n: e.a | 0, m: e.b | 0, count: e.c | 0, downs: 0, boss: e.d > 0.5 };
      ui.banner?.(fmt(W.waveStart, S.wave), 2.2, { sub: fmt(W.waveStartSub, S.wave), tone: S.wave.boss ? 'blood' : null, soft: true });
    } else if (e.name === 'wave-clear') {
      if (S.wave) S.wave.cleared = true;
      ui.banner?.(fmt(W.waveClear, { n: e.a | 0, m: e.b | 0 }), 2, { sub: W.waveClearSub, tone: 'moon', soft: true });
    } else if (e.name === 'enemy-down') { if (S.wave) S.wave.downs++; }
    else if (e.name === 'boss-arrive') {
      S.boss = { net: e.entity, row: e.c | 0, name: enemyName(e.c), max: e.a };
      ui.banner?.(fmt(W.bossRises, { name: S.boss.name }), 2.6, { tone: 'blood', soft: true });
    } else if (e.name === 'boss-down') S.boss = null;
    else if (e.name === 'coin') { if (e.entity === localId()) { S.coins += Math.max(0, Math.round(e.a || 0)); S.coinT = 0.3; } }
  }));

  // ---- down and revive (track G): read whatever the game says, under any of a few names; absent, a fallen friend is "down" ----
  const downFacts = () => {
    const g = globalThis.window?.__game?.forge, src = [ctx.coop?.downed, ctx.forge?.downed, g?.downed, g?.downs, g?.coop].find(f => typeof f === 'function');
    let list = null; try { list = src ? src() : null; } catch { list = null; }
    list = Array.isArray(list) ? list : Array.isArray(list?.players) ? list.players : [];
    const byKey = new Map();
    // the core's own run state first (host.runStates(): core id → {down, revive, reviver}); a game's own list overrides it
    try { for (const [nid, r] of host.runStates?.() ?? []) if (r?.down) byKey.set(String(nid), { id: nid, down: true, revive: r.revive, by: r.reviver || null }); } catch { /* an older core has no run state */ }
    for (const d of list) { if (!d || typeof d !== 'object') continue; for (const k of [d.id, d.player, d.net]) if (k !== undefined && k !== null) byKey.set(String(k), d); }
    return byKey;
  };

  const api = {
    /** rules.js: the coins to show (null: count what the local player picks up). */
    coins(n) { S.coinsSet = n === null || n === undefined ? null : Math.max(0, Math.round(Number(n) || 0)); },
    /** The touch buttons' bits for this frame's INPUT (BTN: evade, reload, melee, next), then the edges are cleared.
     *  Auto-fire's are the fire button's own: held while it fires, and a pull each frame for a weapon that fires once
     *  a pull (the core paces it by the weapon's interval), as a thumb held on Fire gives. */
    touch() {
      if (ctx.input && !ctx.input.enabled) { bits.pressed = 0; A.was = false; return { held: 0, pressed: 0 }; }
      const out = { held: bits.held, pressed: bits.pressed }; bits.pressed = 0;
      if (A.fire) { out.held |= BTN.FIRE; if (A.semi || !A.was) out.pressed |= BTN.FIRE; if (!A.was) A.pulls++; }
      A.was = A.fire;
      return out;
    },
    /**
     * Watch then play (wave 4; CONTRACT §9b): what someone who tunes in to a stream mid-wave cannot learn from the
     * events still to come: the wave as this HUD shows it, and the boss. The streamer's copy gives it with each of the
     * stream's key frames (the shared session's watch blob, `engine`), a viewer's copy takes it; the rule events after
     * it carry on as on a joiner's copy.
     */
    watchKey() {
      const w = S.shown ?? S.wave, b = S.boss;
      return { w: w && w.n > 0 ? { n: w.n | 0, m: w.m | 0, count: w.count | 0, downs: w.downs | 0, boss: !!w.boss, cleared: !!w.cleared } : null, b: b ? { net: b.net | 0, row: b.row | 0, max: Number(b.max) || 0 } : null };
    },
    watchStart(d) {
      const w = d?.w, b = d?.b;
      if (w && Number.isFinite(w.n) && w.n > 0 && (!S.wave || S.wave.n !== (w.n | 0))) S.wave = { n: w.n | 0, m: w.m | 0, count: Math.max(0, w.count | 0), downs: Math.max(0, w.downs | 0), boss: !!w.boss, cleared: !!w.cleared };
      if (b && Number.isFinite(b.net) && !S.boss) S.boss = { net: b.net | 0, row: b.row | 0, name: enemyName(b.row), max: Number(b.max) || 0 };
      // (a viewer's page takes this as its round begins: the round's own clean start, on the next frame, keeps it)
      S.taken = true;
    },
    /** What a touch button is called (its name as shown under it, "Raise"), or null: for a prompt that names it. */
    touchLabel(id) { const l = btns.get(id)?.label; return l ? `${l.slice(0, 1).toUpperCase()}${l.slice(1)}` : null; },
    /** Gyro aim: the radians the phone was turned since the last call (the core's look: + dx right, + dy down). */
    gyro() { const out = { dx: gy.dx, dy: gy.dy }; gy.dx = gy.dy = 0; return out; },
    /** The forge rows of the kit's Settings panel: auto-fire (wave 5: on for a touch screen, off for a mouse, the
     *  player's own from then on), gyro aim (on a phone that can tell how it is turned) and its sensitivity.
     *  `row`: gf/forge/governor.js settingsRow; `store`: {choice(), save(patch)} (the player's own, kept). */
    settings(row, store) {
      if (plan.some(p => p.id === 'fire')) row('gf-autofire', 'Fire by itself when the aim is on an enemy', { value: autoWanted(), set: v => { A.choice = !!v; A.t = 0; store.save({ autoFire: !!v }); } });
      if (!ctx.input?.touch || !globalThis.DeviceMotionEvent) return;
      const c = store.choice();
      if (Number.isFinite(c.gyroScale)) gy.user = Math.max(0.25, Math.min(3, c.gyroScale));
      row('gf-gyro', gy.denied ? 'Gyro aim (this phone said no)' : 'Gyro aim (turn the phone to look)', { value: gy.on, set: (v, input) => { gyroSet(v).then(on => { input.checked = on; store.save({ gyro: on }); if (v && !on) input.closest('label')?.querySelector('span')?.replaceChildren('Gyro aim (this phone said no)'); }); } });
      row('gf-gyro-scale', 'Gyro sensitivity', { type: 'range', value: gy.user, min: 0.25, max: 3, step: 0.05, format: v => `${v.toFixed(2)}×`, set: v => { gy.user = v; store.save({ gyroScale: v }); } });
    },
    /** Every frame, with the feel view (a Float32Array) and its field numbers. */
    update(dt, view, F) {
      const phase = ctx.round?.phase ?? 'playing', playing = phase === 'playing' || phase === 'countdown';
      const on = playing && !ui.covered;
      root.classList.toggle('gf-fh-on', on);
      const touch = !!ctx.input?.touch;
      root.classList.toggle('gf-fh-touch', touch);
      if (phase !== S.phase) {
        // a new round starts clean; the help line shows for the first seconds of each
        if (phase === 'countdown' || (phase === 'playing' && S.phase !== 'countdown')) { if (!S.taken) { S.wave = null; S.boss = null; } S.coins = 0; S.lastScore = null; S.helpT = 9; A.cfg = touchCfg(); S.tipT = Math.max(0, Number(A.cfg.hint) || 0); for (const b of btns.values()) b.nameT = S.tipT; }
        S.taken = false;
        if (phase === 'results') {
          const c = root.querySelector('.gf-card[data-view="results"]'), me = ctx.me?.id, w = ctx.round?.winners ?? [];
          if (c) c.dataset.tone = w.includes(me) ? 'won' : ctx.round?.reason === 'lost' || (w.length === 0 && view?.[F?.dead] > 0.5) ? 'lost' : '';
          // the scores, on the card: the shared session makes its rows after the card is drawn, so the card's list is
          // empty (a party game's scoreboard stays up beside it; this HUD has none)
          const ul = c?.querySelector('ul');
          if (ul && !ul.children.length) {
            let rows = null; try { rows = ctx.rules?.results?.(ctx) ?? null; } catch { rows = null; }
            rows ??= (ctx.players?.list?.() ?? []).map(p => ({ id: p.id, name: p.name, value: p.score }));
            for (const r of rows) { const li = el('li'); li.append(el('span', null, `${w.includes(r.id) ? '★ ' : ''}${r.name ?? r.id}`), el('span', null, String(r.value ?? ''))); ul.append(li); }
          }
        }
        if (!playing) releaseAll();
        S.phase = phase;
      }
      if (S.helpT > 0 && phase === 'playing') S.helpT -= dt;
      root.classList.toggle('gf-help-on', on && !touch && S.helpT > 0);
      if (!view || !F) return;
      // ---- vitals ----
      // the view's health is a share; the number shown is hit points (the core's maximum, read now and then)
      if ((S.maxT = (S.maxT ?? 0) - dt) <= 0) { S.maxT = 0.5; const me = host.players().find(p => p.local); S.max = me?.hpMax > 0 ? me.hpMax : 100; }
      const frac = Math.max(0, Math.min(1, view[F.health] ?? 0)), max = S.max ?? 100;
      const hp = frac * max, dead = (view[F.dead] ?? 0) > 0.5;
      S.frac = frac;                                                  // the bar's share, as the shared HUD reads it
      const shown = String(hp > 0 && hp < 1 ? 1 : Math.round(hp));
      if (hpNum.textContent !== shown) hpNum.textContent = shown;
      const pct = `${(frac * 100).toFixed(1)}%`;
      if (hpFill.style.width !== pct) { hpFill.style.width = pct; hpLag.style.width = pct; }
      if (S.lastHp !== null && hp < S.lastHp - 0.01) { S.hitT = 0.26; vitals.classList.remove('hit'); void vitals.offsetWidth; vitals.classList.add('hit'); }
      if (S.hitT > 0 && (S.hitT -= dt) <= 0) vitals.classList.remove('hit');
      S.lastHp = hp;
      const stage = dead ? 0 : (view[F.stage] | 0);
      if (vitals.dataset.stage !== String(stage)) vitals.dataset.stage = String(stage);
      vitals.classList.toggle('dead', dead);
      const sw = dead ? W.down : [, W.wounded, W.bleeding, W.lastBreath][stage] ?? '';
      if (stageWord.textContent !== sw) stageWord.textContent = sw;
      const armor = Math.round(view[F.armor] ?? 0), wt = armor > 0 ? `+${armor}` : '';
      if (ward.textContent !== wt) ward.textContent = wt;
      const st = Math.max(0, Math.min(1, view[F.stamina] ?? 1)), stw = `${(st * 100).toFixed(1)}%`;
      if (stFill.style.width !== stw) { stFill.style.width = stw; vitals.dataset.stamina = String(r2(st)); }
      const spent = st < 0.34 || (view[F.evadeCool] ?? 0) > 0.02;
      if (spent !== S.spent) { S.spent = spent; stBar.classList.toggle('spent', spent); }
      const hv = String(Math.round(hp));
      if (vitals.dataset.value !== hv) { vitals.dataset.value = hv; vitals.dataset.max = String(Math.round(max)); }
      // the rest changes a few times a second at most, and reading the core's entities makes garbage: seven times a
      // second is as live as a counter needs (a frame's budget on a phone is the fight's)
      S.slow = (S.slow ?? 0) - dt;
      const slow = S.slow <= 0 || on !== S.wasOn;
      if (slow) { S.slow = 0.14; S.wasOn = on; }
      // ---- the wave and the boss ----
      if (slow) {
        const waves = ctx.tables?.waves?.length ?? 0, hosting = ctx.host !== false;
        let w = S.wave, ents = null;
        // the host's director is the truth where it runs; a joiner follows the rule events and counts what it sees
        const d = hosting && ctx.ai?.director?.state ? ctx.ai.director.state() : null;
        if (d && d.phase !== 'idle' && d.waves > 0) w = { n: d.endless ? d.number : d.wave, m: d.endless ? 0 : d.waves, count: d.total, downs: d.killed, boss: w?.boss ?? false, left: Math.max(0, d.total - d.killed), cleared: d.phase !== 'running' };
        S.shown = w ?? null;
        const showWave = waves > 0 && !!w && w.n > 0;
        wave.classList.toggle('on', showWave);
        if (showWave) {
          let n = w.left;
          if (n === undefined) { ents = host.entities(); const alive = ents.reduce((k, e) => k + (e.kind === KIND.ENEMY && !(e.flags & ENTITY_FLAG.DEAD) ? 1 : 0), 0); n = w.cleared ? 0 : Math.max(alive, w.count - w.downs); }
          // an endless run (spec.forge.endless) has no last wave: m is 0 and the title is the wave's number alone
          const title = fmt(w.m > 0 ? W.wave : W.waveEndless, w), lt = fmt(W.remain, { n });
          if (waveTitle.textContent !== title) waveTitle.textContent = title;
          if (left.textContent !== lt) left.textContent = lt;
          wave.classList.toggle('boss', !!w.boss);
          wave.dataset.wave = String(w.n); wave.dataset.left = String(n);
        } else if (left.textContent) left.textContent = '';
        let b = null;
        if (S.boss) {
          const a = hosting ? ctx.ai?.boss?.() : null;
          if (a && a.net === S.boss.net) b = { share: a.share };
          else { ents ??= host.entities(); const e = ents.find(x => x.net === S.boss.net && !(x.flags & ENTITY_FLAG.DEAD)); if (e) b = { share: e.hp }; else S.boss = null; }
        }
        boss.classList.toggle('on', !!b);
        if (b) {
          if (bossName.textContent !== S.boss.name) bossName.textContent = S.boss.name;
          const bp = `${(Math.max(0, Math.min(1, b.share)) * 100).toFixed(1)}%`;
          if (bossFill.style.width !== bp) { bossFill.style.width = bp; bossLag.style.width = bp; }
          boss.dataset.value = String(r2(b.share));
        }
      }
      // ---- score and coins ----
      const sc = Math.round(Number((ctx.watched?.() ?? ctx.me)?.score) || 0);
      if (S.lastScore !== null && sc > S.lastScore) { S.plus = (S.plusT > 0 ? S.plus : 0) + (sc - S.lastScore); S.plusT = 0.95; scorePlus.textContent = `+${S.plus}`; scorePlus.classList.remove('on'); void scorePlus.offsetWidth; scorePlus.classList.add('on'); }
      if (S.plusT > 0 && (S.plusT -= dt) <= 0) { scorePlus.classList.remove('on'); S.plus = 0; }
      S.lastScore = sc;
      if (scoreN.textContent !== String(sc)) scoreN.textContent = String(sc);
      // the purse the core keeps (wave 7: coins picked up less coins spent, the host's word on every copy); an older
      // core has none, and the coins picked up are counted here (forge-web feel_shop_state: [3] is the purse)
      const purse = host.forge?.feel_shop_state?.(localId())?.[3];
      if (Number.isFinite(purse)) { if (Number.isFinite(S.purse) && purse > S.purse) S.coinT = 0.3; S.purse = purse; }
      const cn = String(S.coinsSet ?? (Number.isFinite(S.purse) ? S.purse : S.coins));
      if (coinsN.textContent !== cn) coinsN.textContent = cn;
      // coins only in a game that has them: enemies to drop them, or the rules' own count
      const hasCoins = (ctx.tables?.enemies?.length ?? 0) > 0 || S.coinsSet !== null || S.coins > 0 || S.purse > 0;
      if (hasCoins !== S.hasCoins) { S.hasCoins = hasCoins; coinsEl.style.visibility = hasCoins ? '' : 'hidden'; }
      if (S.coinT > 0) { coinsEl.classList.add('pop'); if ((S.coinT -= dt) <= 0) coinsEl.classList.remove('pop'); }
      // ---- friends ----
      // friends, and the bots beside a player alone. A stream's viewer (wave 4) has no player of its own: the list is
      // everyone in the stream, the one being watched first and marked (their vitals card is a player's own, and hidden)
      const seen = slow ? ctx.watched?.() ?? null : null;
      const others = slow ? (ctx.players?.list?.() ?? []).filter(p => !p.local).sort((a, b) => (b === seen) - (a === seen)) : [];
      if (slow) friends.classList.toggle('on', others.length > 0);
      if (slow && others.length) {
        const core = new Map(host.players().map(p => [p.id, p])), facts = downFacts();
        const rows = others.map(p => {
          const nid = ctx.players.nid?.(p.id) ?? null, c = nid != null ? core.get(nid) : null, f = facts.get(String(p.id)) ?? (nid != null ? facts.get(String(nid)) : null) ?? null;
          const share = c && c.hpMax > 0 ? Math.max(0, Math.min(1, c.hp / c.hpMax)) : p.alive === false ? 0 : 1;
          const down = f ? !!(f.down ?? f.downed ?? true) : (p.alive === false || (c ? !c.alive : false));
          const rev = f && Number.isFinite(f.revive ?? f.progress) ? Math.max(0, Math.min(1, f.revive ?? f.progress)) : null;
          return { id: p.id, name: p.name, color: p.color, share: r2(share), down, revive: down && rev !== null && rev > 0 ? r2(rev) : null, by: f?.by ?? null, ...(p === seen ? { watched: true } : {}) };
        });
        const key = JSON.stringify(rows);
        if (key !== S.friendsKey) {
          S.friendsKey = key;
          friends.replaceChildren(...rows.map(r => {
            const e = el('div', `gf-fh-friend${r.down ? (r.revive !== null ? ' down revive' : ' down') : r.share <= 0.3 ? ' low' : ''}${r.watched ? ' watched' : ''}`); e.style.setProperty('--c', r.color ?? '#fff'); e.dataset.player = String(r.id);
            const bar = el('u'), fill = el('b'); fill.style.width = `${Math.round((r.revive ?? r.share) * 100)}%`; bar.append(fill);
            e.append(el('span', null, r.name ?? ''), bar, el('em', null, r.down ? (r.revive !== null ? W.friendRising : W.friendDown) : ''));
            e.dataset.value = String(r.share); e.dataset.state = r.down ? (r.revive !== null ? 'revive' : 'down') : 'up';
            return e;
          }));
        }
      } else if (slow && S.friendsKey) { S.friendsKey = ''; friends.replaceChildren(); }
      // ---- auto-fire and the touch buttons ----
      const armed = (view[F.weapon] | 0) >= 0, wr = armed ? ctx.tables?.weapons?.[view[F.weapon] | 0] : null;
      const magazine = view[F.magazine] | 0, rounds = view[F.ammo] | 0, loading = view[F.reloading] > 0;
      const mine = phase === 'playing' && !ui.covered && ctx.input?.enabled !== false && !ctx.watching?.() && !dead && !((view[F.downed] ?? 0) > 0.5);
      const wantAuto = mine && armed && !!wr && autoWanted(), wantNear = touch && btns.has('melee');
      if (wantAuto || wantNear) {
        if ((A.scanT -= dt) <= 0) {
          A.scanT = 0.08;
          const reach = wr?.kind === 'melee' ? Number(wr.melee?.reach) || Number(wr.range) || 2.2 : Math.min(Number(A.cfg.autoFire.range) || TOUCH.autoFire.range, Number(wr?.range) || Infinity);
          try { scan(reach, wantAuto); } catch { A.aimed = false; A.near = Infinity; }
        }
      } else { A.aimed = false; A.near = Infinity; A.scanT = 0; }
      A.t = wantAuto && A.aimed ? A.t + dt : 0;
      // nothing to fire while it loads or with the magazine empty (it loads by itself); a charge is let go when full
      const ready = !loading && !(magazine > 0 && rounds <= 0) && !((view[F.down] ?? 0) > 0);
      if (A.gap > 0) A.gap--;
      if (wr?.kind === 'charge' && A.fire && (view[F.charge] ?? 0) >= 0.98) A.gap = 3;
      A.fire = wantAuto && A.aimed && ready && A.t >= (Number(A.cfg.autoFire.delay) || 0) && A.gap <= 0;
      A.semi = !!wr && !wr.auto && wr.kind !== 'charge' && wr.kind !== 'beam';
      if (fire && A.fire !== A.shown) { A.shown = A.fire; fire.e.classList.toggle('auto', A.fire); }
      if (touch) {
        // a held fire button keeps firing: a weapon that fires once a pull gets a pull every frame it is held (the core
        // paces it by the weapon's own interval); a charge or a beam is held and let go, an automatic one is the core's
        if (fire?.down && A.semi) bits.pressed |= BTN.FIRE;
        // the names under the buttons, and the line on how a phone plays: the first seconds of a round
        const words = !!A.cfg.words;
        if (phase === 'playing' && S.tipT > 0) S.tipT -= dt;
        for (const b of btns.values()) {
          if (b.on && b.nameT > 0 && phase === 'playing') b.nameT -= dt;
          const named = words || b.nameT > 0;
          if (named !== b.named) { b.named = named; b.e.classList.toggle('named', named); }
        }
        if (slow) {
          // only what can be done now: a button that cannot do anything is not there (its seat stays empty)
          const always = !!A.cfg.always;
          const held = view[F.held] >>> 0; let n = 0; for (let m = held; m; m &= m - 1) n++;
          const spent = armed && magazine > 0 && rounds < magazine && !loading;
          const close = A.near <= strikeReach() + (btns.get('melee')?.on ? 0.8 : 0);
          for (const b of btns.values()) {
            let there = true;
            if (!always && !b.down) {
              if (b.when === 'spent') there = spent;
              else if (b.when === 'close') there = close;
              else if (b.when === 'second') there = n >= 2;
              else if (b.when === 'friend') there = !!ui.promptText || (view[F.reviving] ?? 0) > 0;
            }
            show(b, there);
          }
          btns.get('evade')?.e.classList.toggle('dim', (view[F.evadeCool] ?? 0) > 0.02 || st < 0.15);
          // with every button always there, the ones that cannot do anything are dimmed, as before wave 5
          btns.get('reload')?.e.classList.toggle('dim', always && !spent);
          btns.get('swap')?.e.classList.toggle('dim', always && n < 2);
          const lines = S.tipT > 0 && phase === 'playing' && !ui.promptText ? [A.cfg.tip, ...(fire && autoWanted() ? [A.cfg.autoTip] : [])].filter(t => typeof t === 'string' && t.trim()) : [], key = lines.join('|');
          if (lines.length && key !== S.tipKey) { S.tipKey = key; tip.replaceChildren(...lines.map(t => el('span', null, t))); }
          tip.classList.toggle('on', lines.length > 0);
        }
      }
    },
    /** For QA: what the HUD shows now, and where. */
    observe() {
      const seen = e => { if (!e?.isConnected) return { shown: false, rect: null }; const r = e.getBoundingClientRect(); const vis = typeof e.checkVisibility === 'function' ? e.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : e.offsetParent !== null; return { shown: !!(vis && r.width > 2 && r.height > 2 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }; };
      return {
        on: root.classList.contains('gf-fh-on'), touch: root.classList.contains('gf-fh-touch'), theme: ui.theme ?? null,
        layout: !root.classList.contains('gf-fh-touch') ? 'desk' : innerWidth >= innerHeight ? 'touch-landscape' : 'touch-portrait',
        vitals: { ...seen(vitals), hp: Number(vitals.dataset.value), max: Number(vitals.dataset.max), text: hpNum.textContent, stage: Number(vitals.dataset.stage ?? 0), word: stageWord.textContent, armor: ward.textContent, bar: hpFill.style.width, stamina: Number(vitals.dataset.stamina) },
        wave: { ...seen(wave), text: waveTitle.textContent, left: left.textContent, n: Number(wave.dataset.wave ?? 0), remain: Number(wave.dataset.left ?? 0) },
        boss: { ...seen(boss), name: bossName.textContent, share: Number(boss.dataset.value ?? 0) },
        score: { ...seen(score), text: scoreN.textContent, plus: scorePlus.classList.contains('on') ? scorePlus.textContent : null },
        coins: { ...seen(coinsEl), text: coinsN.textContent },
        friends: [...friends.children].map(e => ({ ...seen(e), player: e.dataset.player, name: e.querySelector('span')?.textContent ?? '', color: e.style.getPropertyValue('--c'), share: Number(e.dataset.value), state: e.dataset.state })),
        banner: ui.bannerText ?? null,
        // a button that is not there now keeps its seat's rect (`there` false, `shown` false)
        buttons: [...btns.values()].map(b => ({ id: b.id, label: b.label, when: b.when, there: b.on, down: b.down, dim: b.e.classList.contains('dim'), named: !!b.named, ...seen(b.e) })),
        // wave 5: the touch slots as laid out, the line on how a phone plays, and auto-fire as it stands
        touchUi: { upright: lay.upright, always: !!A.cfg.always, discs: !!A.cfg.discs, words: !!A.cfg.words, rest: Number(root.style.getPropertyValue('--fh-rest')) || null, tip: tip.classList.contains('on') ? [...tip.children].map(e => e.textContent).join(' · ') : null, seats: Object.fromEntries(Object.entries(lay.seats).filter(([id]) => btns.has(id)).map(([id, q]) => [id, { x: r2(q.x), y: r2(q.y), s: r2(q.s) }])) },
        auto: { on: autoWanted(), chosen: A.choice, aimed: A.aimed, firing: A.fire, pulls: A.pulls, near: Number.isFinite(A.near) ? r2(A.near) : null },
        bits: { held: bits.held, pressed: bits.pressed },
        // wave 3: swaps by the wheel and by two fingers so far; gyro aim as it stands
        swaps: { wheel: G.wheel, twoFinger: G.twoFinger },
        gyro: { on: gy.on, events: gy.events, denied: gy.denied, asked: gy.asked, sensitivity: gyroBase(), player: gy.user, available: !!globalThis.DeviceMotionEvent },
      };
    },
    dispose() { for (const off of offs) off(); for (const e of [vitals, wave, sub, boss, score, coinsEl, friends, tip, ...[...btns.values()].map(b => b.e)]) e.remove(); root.classList.remove('gf-fh', 'gf-fh-on', 'gf-fh-touch', 'gf-fh-discs', 'gf-fh-words'); },
  };
  ctx.forgeHud = api;
  return api;
}
