// gf-three ui: themes. A theme is another look for the kit's own DOM layer (ui.js, hud.js, menu.js, loading.js): type,
// colours, panels, buttons. It changes no behaviour and no element ids, so every check that clicks the menu or reads the
// HUD sees the same things. A game with no theme (every party and scenic game) looks exactly as it did: nothing here
// runs unless a boot asks for a theme by name (createUI(ctx, {theme}), startLoading({theme})).
//
// "grim" (gf-forge wave 2, track U; research/gf-forge/hud/DESIGN.md): a dark, serif, hand-set page for night games.
// Our own design: no boxes with corner trim and no round orbs; ruled hairlines, a printed double frame on cards, ledger
// rows with dotted leaders. Two type families, both SIL OFL and vendored as slot files (research/gf-forge/hud/fonts):
//   display  "GF Grim Display" (Grenze Gotisch, a roman and blackletter hybrid): titles, banners, the wave
//   text     "GF Grim Text" (Grenze): everything else, with lining tabular figures for every number
// and six colours, each a ui.* colour slot when the game's config has it (config/game.json → ui), each a CSS custom
// property at the root so a game's own screens can use them:
//   --gf-forge-ink        the shade behind text and the panels            ui.ink
//   --gf-forge-bone       text and numbers                                ui.bone
//   --gf-forge-parchment  labels, rules, trims                            ui.parchment
//   --gf-forge-accent     ember: the main button, the combo, criticals    ui.ember
//   --gf-forge-blood      hurt, low health, lost                          ui.blood
//   --gf-forge-moon       stamina, friends, the cold accent               ui.moon
//   --gf-forge-serif, --gf-forge-display    the two font stacks
//
// Pure: Node imports it (create reads THEMES for a game's config, fonts and friends-page colours).

const SERIF = '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua","URW Palladio L",Georgia,"Times New Roman",serif';

const GRIM_CSS = `
:root{--gf-forge-display:"GF Grim Display",${SERIF};--gf-forge-serif:"GF Grim Text",${SERIF};--gf-forge-ink:#0b0d10;--gf-forge-bone:#ece4d0;--gf-forge-parchment:#c9b78e;--gf-forge-accent:#f08a2c;--gf-forge-blood:#c8242c;--gf-forge-moon:#9fc0e6}
.gf-theme-grim{--g-ink:var(--gf-forge-ink);--g-bone:var(--gf-forge-bone);--g-parch:var(--gf-forge-parchment);--g-ember:var(--gf-forge-accent);--g-blood:var(--gf-forge-blood);--g-moon:var(--gf-forge-moon);
--g-shade:color-mix(in srgb,var(--gf-forge-ink) 86%,transparent);--g-panel:color-mix(in srgb,var(--gf-forge-ink) 94%,transparent);--g-rule:color-mix(in srgb,var(--gf-forge-parchment) 42%,transparent);--g-faint:color-mix(in srgb,var(--gf-forge-parchment) 18%,transparent);--g-dim:color-mix(in srgb,var(--gf-forge-parchment) 82%,var(--gf-forge-ink));
--g-ts:0 1px 0 #000d,0 0 6px #000c,0 0 14px #0009;--gf-panel:var(--g-panel);--gf-text:var(--g-bone);--gf-accent:var(--g-ember)}
#gf-ui.gf-theme-grim{font:500 15px/1.3 var(--gf-forge-serif);color:var(--g-bone);letter-spacing:.01em;text-rendering:geometricPrecision}
#gf-ui.gf-theme-grim button{font-family:var(--gf-forge-serif)}
#gf-ui.gf-theme-grim .gf-top{top:max(10px,env(safe-area-inset-top));flex-direction:column;gap:1px;text-align:center}
#gf-ui.gf-theme-grim .gf-timer{background:none;padding:0;border-radius:0;min-width:0;font:600 14px/1.2 var(--gf-forge-serif);letter-spacing:.06em;color:var(--g-dim);text-shadow:var(--g-ts)}
#gf-ui.gf-theme-grim .gf-timer.low{color:var(--g-ember)}
#gf-ui.gf-theme-grim .gf-goal{background:none;border-radius:0;padding:0 8px;font:500 13px/1.3 var(--gf-forge-serif);color:var(--g-dim);text-shadow:var(--g-ts);top:max(58px,calc(env(safe-area-inset-top) + 48px))}
#gf-ui.gf-theme-grim .gf-top .gf-goal{position:static;transform:none;max-width:min(520px,62vw);margin-top:3px}
#gf-ui.gf-theme-grim .gf-scores{background:var(--g-shade);border-radius:2px;box-shadow:inset 0 0 0 1px var(--g-faint);padding:6px 10px}
#gf-ui.gf-theme-grim .gf-scores i{border-radius:1px;transform:rotate(45deg) scale(.8)}
#gf-ui.gf-theme-grim .gf-meter{background:none;border-radius:0;padding:0}
#gf-ui.gf-theme-grim .gf-meter b{font:600 10px/1.4 var(--gf-forge-serif);letter-spacing:.16em;text-transform:uppercase;color:var(--g-dim);opacity:1;text-shadow:var(--g-ts)}
#gf-ui.gf-theme-grim .gf-meter span{height:4px;border-radius:0;background:color-mix(in srgb,var(--g-bone) 16%,transparent);box-shadow:0 0 0 1px #0009}
#gf-ui.gf-theme-grim .gf-meter u{background:var(--g-ember)}
#gf-ui.gf-theme-grim .gf-meter.hit{box-shadow:none}
#gf-ui.gf-theme-grim .gf-banner{top:27%;font:700 clamp(30px,5.2vw,58px)/1.05 var(--gf-forge-display);letter-spacing:.035em;color:var(--g-bone);text-shadow:0 2px 0 #000c,0 0 22px #000d,0 0 44px #0009;transform:translate(-50%,-50%) scale(1.045);transition:opacity .28s ease-out,transform .9s cubic-bezier(.2,.7,.2,1);white-space:nowrap;text-align:center;max-width:94vw;will-change:transform,opacity}
#gf-ui.gf-theme-grim .gf-banner.on{transform:translate(-50%,-50%) scale(1)}
#gf-ui.gf-theme-grim .gf-banner::after{content:"";display:block;height:1px;margin:10px -8% 0;background:linear-gradient(90deg,transparent,var(--g-parch) 18%,var(--g-parch) 82%,transparent);transform:scaleX(0);transition:transform .7s cubic-bezier(.2,.7,.2,1) .08s;opacity:.85}
#gf-ui.gf-theme-grim .gf-banner.on::after{transform:scaleX(1)}
#gf-ui.gf-theme-grim .gf-banner small{display:block;margin-top:9px;font:600 clamp(12px,1.5vw,14px)/1.2 var(--gf-forge-serif);letter-spacing:.22em;text-transform:uppercase;color:var(--g-dim);white-space:normal}
#gf-ui.gf-theme-grim .gf-banner.tone-blood{color:color-mix(in srgb,var(--g-blood) 78%,#fff)}
#gf-ui.gf-theme-grim .gf-banner.tone-ember{color:color-mix(in srgb,var(--g-ember) 82%,#fff)}
#gf-ui.gf-theme-grim .gf-banner.tone-moon{color:color-mix(in srgb,var(--g-moon) 80%,#fff)}
#gf-ui.gf-theme-grim .gf-toasts{top:max(112px,calc(env(safe-area-inset-top) + 100px))}
#gf-ui.gf-theme-grim .gf-toast,#gf-ui.gf-theme-grim .gf-prompt{background:var(--g-shade);border-radius:0;padding:5px 16px;box-shadow:inset 0 1px 0 var(--g-rule),inset 0 -1px 0 var(--g-rule);font:600 14px/1.3 var(--gf-forge-serif);letter-spacing:.03em}
#gf-ui.gf-theme-grim .gf-prompt{bottom:max(96px,calc(env(safe-area-inset-bottom) + 86px))}
#gf-ui.gf-theme-grim .gf-help{font:500 12px/1.2 var(--gf-forge-serif);letter-spacing:.03em;color:var(--g-dim);opacity:0;transition:opacity .8s;text-shadow:var(--g-ts);bottom:max(8px,env(safe-area-inset-bottom));max-width:calc(100vw - 560px);overflow:hidden;text-overflow:ellipsis}
#gf-ui.gf-theme-grim.gf-help-on .gf-help{opacity:.9}
#gf-ui.gf-theme-grim .gf-plate{background:var(--g-shade);border-radius:0;padding:2px 9px 2px 7px;box-shadow:inset 0 -1px 0 var(--g-rule);font:600 12.5px/1.35 var(--gf-forge-serif);letter-spacing:.04em}
#gf-ui.gf-theme-grim .gf-plate i{border-radius:1px;width:7px;height:7px;transform:rotate(45deg);margin-right:7px;vertical-align:1px;box-shadow:0 0 0 1px #000a}
#gf-ui.gf-theme-grim .gf-hbar{border-radius:0;height:6px;box-shadow:0 0 0 1px #000d}
#gf-ui.gf-theme-grim .gf-pop{font:800 24px/1 var(--gf-forge-serif);-webkit-text-stroke:0;text-shadow:var(--g-ts)}
#gf-ui.gf-theme-grim .gf-card{background:var(--g-panel);border-radius:2px;padding:28px 32px 24px;min-width:min(320px,88vw);box-shadow:0 0 0 1px #000c,inset 0 0 0 1px var(--g-rule),inset 0 0 0 5px var(--g-ink),inset 0 0 0 6px var(--g-faint),0 18px 60px #000b}
#gf-ui.gf-theme-grim .gf-card h1{font:700 clamp(28px,5vw,42px)/1.05 var(--gf-forge-display);margin:0 0 4px;letter-spacing:.01em}
#gf-ui.gf-theme-grim .gf-card h1::after{content:"";display:block;width:56px;height:2px;margin:12px auto 2px;background:var(--g-ember)}
#gf-ui.gf-theme-grim .gf-card p{font-weight:500;color:var(--g-dim);opacity:1}
#gf-ui.gf-theme-grim .gf-card ul{margin:14px 0 6px}
#gf-ui.gf-theme-grim .gf-card li{align-items:baseline;gap:8px;padding:4px 0;font:600 16px/1.3 var(--gf-forge-serif)}
#gf-ui.gf-theme-grim .gf-card li span:first-child{display:flex;flex:1;align-items:baseline;gap:8px;min-width:0;text-align:left}
#gf-ui.gf-theme-grim .gf-card li span:first-child::after{content:"";flex:1;min-width:18px;border-bottom:1px dotted var(--g-rule);transform:translateY(-4px)}
#gf-ui.gf-theme-grim .gf-card li span:last-child{font-weight:800;font-size:18px}
#gf-ui.gf-theme-grim .gf-card button{border-radius:2px;padding:11px 26px;margin-top:14px;font:700 17px/1.1 var(--gf-forge-serif);letter-spacing:.05em;background:var(--g-ember);color:var(--g-ink);box-shadow:inset 0 0 0 1px #0004,0 2px 0 #000a;transition:filter .12s}
#gf-ui.gf-theme-grim .gf-card button:hover,#gf-ui.gf-theme-grim .gf-card button:focus-visible{filter:brightness(1.12);outline:none}
#gf-ui.gf-theme-grim .gf-card #gf-to-menu{background:transparent!important;color:var(--g-bone);box-shadow:inset 0 0 0 1px var(--g-rule)}
#gf-ui.gf-theme-grim .gf-card .gf-count{font:800 clamp(72px,16vw,120px)/1 var(--gf-forge-display);color:var(--g-bone);text-shadow:0 3px 0 #000c,0 0 34px #000e}
#gf-ui.gf-theme-grim .gf-card.count{background:transparent;box-shadow:none}
#gf-ui.gf-theme-grim .gf-card.count h1::after{display:none}
#gf-ui.gf-theme-grim .gf-stick{border:1px solid color-mix(in srgb,var(--g-parch) 60%,transparent);background:radial-gradient(circle,#0000 52%,color-mix(in srgb,var(--g-ink) 55%,transparent) 100%)}
#gf-ui.gf-theme-grim .gf-stick u{background:color-mix(in srgb,var(--g-bone) 62%,transparent);box-shadow:0 0 0 1px #000a}
#gf-ui.gf-theme-grim .gf-touch button{background:color-mix(in srgb,var(--g-ink) 62%,transparent);color:var(--g-bone);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--g-parch) 55%,transparent),0 0 0 1px #0009;font:700 12px/1 var(--gf-forge-serif);letter-spacing:.1em;text-transform:uppercase}
#gf-ui.gf-theme-grim .gf-menubtn{top:max(10px,env(safe-area-inset-top));left:max(10px,env(safe-area-inset-left));border-radius:2px;background:var(--g-shade);box-shadow:inset 0 0 0 1px var(--g-rule),0 0 0 1px #000a;color:var(--g-bone);font-size:0}
#gf-ui.gf-theme-grim #gf-menu-button{background:linear-gradient(var(--g-bone),var(--g-bone)) center 13px/18px 1.5px no-repeat,linear-gradient(var(--g-bone),var(--g-bone)) center 19px/18px 1.5px no-repeat,linear-gradient(var(--g-bone),var(--g-bone)) center 25px/12px 1.5px no-repeat,var(--g-shade)}
#gf-ui.gf-theme-grim .gf-menubtn:hover{filter:none;box-shadow:inset 0 0 0 1px var(--g-bone),0 0 0 1px #000a}
#gf-ui.gf-theme-grim .gf-menubtn.gf-fsbtn{top:auto;left:auto;right:max(10px,env(safe-area-inset-right));bottom:max(10px,env(safe-area-inset-bottom))}
#gf-ui.gf-theme-grim .gf-fsbtn svg{width:18px;height:18px;stroke-width:1.8}
#gf-ui.gf-theme-grim .gf-me{left:max(16px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));background:none;box-shadow:none;border-radius:0;padding:0;min-width:0;max-width:none;gap:5px}
#gf-ui.gf-theme-grim .gf-me-name{font:600 12px/1.2 var(--gf-forge-serif);letter-spacing:.14em;text-transform:uppercase;color:var(--g-dim);text-shadow:var(--g-ts);gap:8px}
#gf-ui.gf-theme-grim .gf-me-name i{width:8px;height:8px;border-radius:1px;transform:rotate(45deg);box-shadow:0 0 0 1px #000c}
#gf-ui.gf-theme-grim .gf-status{border-radius:0;font:700 12px/1.3 var(--gf-forge-serif);letter-spacing:.12em;text-transform:uppercase}
#gf-ui.gf-theme-grim .gf-status.down{background:var(--g-blood)}
#gf-ui.gf-theme-grim .gf-status.out{background:var(--g-ink);box-shadow:inset 0 0 0 1px var(--g-blood)}
#gf-ui.gf-theme-grim .gf-status.safe{background:var(--g-moon);color:var(--g-ink)}
#gf-ui.gf-theme-grim .gf-line{font:600 13px/1.3 var(--gf-forge-serif);text-shadow:var(--g-ts)}
#gf-ui.gf-theme-grim .gf-line span{height:4px;border-radius:0}
#gf-ui.gf-theme-grim .gf-line.chip b{border-radius:0}
#gf-ui.gf-theme-grim .gf-bossbar i{font:700 20px/1.1 var(--gf-forge-display);letter-spacing:.03em}
#gf-ui.gf-theme-grim .gf-bossbar span{height:8px;border-radius:0;box-shadow:0 0 0 1px #000d,0 0 0 2px var(--g-faint)}
#gf-ui.gf-theme-grim .gf-vig{background:radial-gradient(ellipse at center,transparent 55%,color-mix(in srgb,var(--g-blood) 46%,transparent) 100%)}
#gf-ui.gf-theme-grim #gf-menu{color:var(--g-bone)}
#gf-ui.gf-theme-grim #gf-menu.home{background:linear-gradient(90deg,color-mix(in srgb,var(--g-ink) 93%,transparent) 0%,color-mix(in srgb,var(--g-ink) 74%,transparent) 30%,transparent 60%)}
#gf-ui.gf-theme-grim #gf-menu.pause{background:color-mix(in srgb,var(--g-ink) 68%,transparent);backdrop-filter:blur(2px) saturate(.7)}
#gf-ui.gf-theme-grim #gf-menu .gf-col{gap:0;width:min(400px,calc(100vw - 32px));left:max(clamp(16px,6vw,84px),env(safe-area-inset-left));scrollbar-color:var(--g-rule) transparent}
#gf-ui.gf-theme-grim #gf-menu.pause .gf-col{background:var(--g-panel);border-radius:2px;padding:26px 26px 20px;width:min(452px,calc(100vw - 24px));box-shadow:0 0 0 1px #000c,inset 0 0 0 1px var(--g-rule),inset 0 0 0 5px var(--g-ink),inset 0 0 0 6px var(--g-faint),0 18px 60px #000b;left:50%}
#gf-ui.gf-theme-grim #gf-menu h1{font:700 clamp(40px,6.6vw,78px)/.98 var(--gf-forge-display);letter-spacing:0;text-shadow:0 2px 0 #000b,0 0 34px #000c;margin:0 0 4px}
#gf-ui.gf-theme-grim #gf-menu h1::after{content:"";display:block;width:64px;height:2px;margin:16px 0 14px;background:var(--g-ember)}
#gf-ui.gf-theme-grim #gf-menu.pause h1{font-size:34px;text-shadow:none}
#gf-ui.gf-theme-grim #gf-menu.pause h1::after{margin:12px 0 8px}
#gf-ui.gf-theme-grim #gf-menu h2{font:700 28px/1.1 var(--gf-forge-display);margin:0}
#gf-ui.gf-theme-grim #gf-menu .gf-hook{font:500 17px/1.42 var(--gf-forge-serif);color:var(--g-dim);opacity:1;margin:0 0 18px;text-shadow:0 1px 0 #000c,0 0 10px #000b;max-width:36ch}
#gf-ui.gf-theme-grim #gf-menu .gf-note{font:500 14px/1.45 var(--gf-forge-serif);color:var(--g-dim);opacity:1;margin:0 0 8px}
#gf-ui.gf-theme-grim #gf-menu button{font:600 18px/1.15 var(--gf-forge-serif);letter-spacing:.02em}
#gf-ui.gf-theme-grim #gf-menu .gf-btn{border-radius:0;background:transparent;box-shadow:inset 0 -1px 0 var(--g-faint);padding:13px 10px 13px 4px;gap:14px;transition:background .14s,padding .14s,box-shadow .14s}
#gf-ui.gf-theme-grim #gf-menu .gf-btn:hover,#gf-ui.gf-theme-grim #gf-menu .gf-btn:focus-visible{background:linear-gradient(90deg,color-mix(in srgb,var(--g-bone) 9%,transparent),transparent);box-shadow:inset 0 -1px 0 var(--g-parch);padding-left:12px;transform:none}
#gf-ui.gf-theme-grim #gf-menu .gf-btn svg{width:18px;height:18px;color:var(--g-parch);opacity:1;stroke-width:1.7}
#gf-ui.gf-theme-grim #gf-menu .gf-btn small{font:500 12.5px/1.2 var(--gf-forge-serif);letter-spacing:.03em;color:var(--g-dim);opacity:.9;margin-top:4px}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary{background:var(--g-ember);color:var(--g-ink);border-radius:2px;font-size:23px;font-weight:700;letter-spacing:.04em;padding:15px 20px;margin:0 0 8px;box-shadow:inset 0 0 0 1px #0004,0 0 0 1px #000a,0 8px 26px #000a}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary:hover,#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary:focus-visible{background:var(--g-ember);filter:brightness(1.1);padding:15px 20px}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary svg{color:var(--g-ink)}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary small{color:color-mix(in srgb,var(--g-ink) 82%,transparent);opacity:1}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.wallet{margin-top:14px;background:color-mix(in srgb,var(--g-ink) 60%,transparent);box-shadow:inset 0 0 0 1px var(--g-faint);padding:12px 14px}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.wallet.on{box-shadow:inset 0 0 0 1px var(--g-ember)}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.wallet img,#gf-ui.gf-theme-grim #gf-menu .gf-wallets img,#gf-ui.gf-theme-grim #gf-menu .gf-who img{border-radius:2px}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.live svg{color:var(--g-blood)}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.live.on{box-shadow:inset 0 0 0 1px var(--g-blood)}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.voice svg{color:var(--g-moon)}
#gf-ui.gf-theme-grim #gf-menu .gf-btn.voice.on{box-shadow:inset 0 0 0 1px var(--g-moon)}
#gf-ui.gf-theme-grim #gf-menu .gf-head{gap:14px;margin-bottom:14px}
#gf-ui.gf-theme-grim #gf-menu .gf-back{border-radius:2px;background:transparent;box-shadow:inset 0 0 0 1px var(--g-rule);font-size:18px}
#gf-ui.gf-theme-grim #gf-menu .gf-back:hover{box-shadow:inset 0 0 0 1px var(--g-bone)}
#gf-ui.gf-theme-grim #gf-menu .gf-panel{background:color-mix(in srgb,var(--g-ink) 78%,transparent);border-radius:2px;box-shadow:inset 0 0 0 1px var(--g-faint);padding:14px 16px;margin-bottom:10px}
#gf-ui.gf-theme-grim #gf-menu.pause .gf-panel{background:color-mix(in srgb,var(--g-bone) 5%,transparent)}
#gf-ui.gf-theme-grim #gf-menu .gf-keys{font:500 15px/1.3 var(--gf-forge-serif);gap:9px 16px}
#gf-ui.gf-theme-grim #gf-menu .gf-keys kbd{border-radius:2px;background:transparent;box-shadow:inset 0 0 0 1px var(--g-rule);font:700 12px/1.3 var(--gf-forge-serif);letter-spacing:.06em;color:var(--g-bone)}
#gf-ui.gf-theme-grim #gf-menu .gf-goalbox{font:600 16px/1.4 var(--gf-forge-serif)}
#gf-ui.gf-theme-grim #gf-menu .gf-goalbox b{font:600 12px/1.4 var(--gf-forge-serif);letter-spacing:.2em;color:var(--g-ember);opacity:1;margin-bottom:5px}
#gf-ui.gf-theme-grim #gf-menu label.gf-set{font:600 15px/1.3 var(--gf-forge-serif);border-bottom:1px solid var(--g-faint)}
#gf-ui.gf-theme-grim #gf-menu label.gf-set:last-child{border-bottom:0}
#gf-ui.gf-theme-grim #gf-menu label.gf-set input{accent-color:var(--g-ember)}
#gf-ui.gf-theme-grim #gf-menu label.gf-set output{color:var(--g-dim);opacity:1}
#gf-ui.gf-theme-grim #gf-menu .gf-seg{border-radius:2px;background:transparent;box-shadow:inset 0 0 0 1px var(--g-rule);padding:2px}
#gf-ui.gf-theme-grim #gf-menu .gf-seg button{border-radius:1px;font-size:13px;letter-spacing:.06em}
#gf-ui.gf-theme-grim #gf-menu .gf-seg button.on{background:var(--g-ember);color:var(--g-ink)}
#gf-ui.gf-theme-grim #gf-menu .gf-wallets button,#gf-ui.gf-theme-grim #gf-menu .gf-who button,#gf-ui.gf-theme-grim #gf-menu .gf-item button,#gf-ui.gf-theme-grim #gf-menu .gf-boxes button{border-radius:2px;background:transparent;box-shadow:inset 0 0 0 1px var(--g-rule);font-size:14px}
#gf-ui.gf-theme-grim #gf-menu .gf-wallets button:hover,#gf-ui.gf-theme-grim #gf-menu .gf-who button:hover,#gf-ui.gf-theme-grim #gf-menu .gf-item button:hover,#gf-ui.gf-theme-grim #gf-menu .gf-boxes button:hover{background:color-mix(in srgb,var(--g-bone) 8%,transparent);box-shadow:inset 0 0 0 1px var(--g-bone)}
#gf-ui.gf-theme-grim #gf-menu .gf-item{border-radius:2px;background:color-mix(in srgb,var(--g-bone) 5%,transparent)}
#gf-ui.gf-theme-grim #gf-menu .gf-item.on{box-shadow:inset 0 0 0 1px var(--g-ember)}
#gf-ui.gf-theme-grim #gf-menu .gf-item.on button{background:var(--g-ember);color:var(--g-ink);box-shadow:none}
#gf-ui.gf-theme-grim #gf-menu .gf-item .pic{border-radius:2px}
#gf-ui.gf-theme-grim #gf-menu .gf-item em{border-radius:0;letter-spacing:.06em}
#gf-ui.gf-theme-grim #gf-menu .gf-error{color:color-mix(in srgb,var(--g-blood) 60%,#fff)}
#gf-ui.gf-theme-grim #gf-menu .gf-hint{font:500 12.5px/1.3 var(--gf-forge-serif);color:var(--g-dim);opacity:.85}
#gf-ui.gf-theme-grim #gf-menu .gf-room-head{font:600 12px/1.3 var(--gf-forge-serif);letter-spacing:.2em;color:var(--g-dim);opacity:1}
#gf-ui.gf-theme-grim #gf-menu .gf-room-head b{font:800 21px/1 var(--gf-forge-serif);letter-spacing:.2em;color:var(--g-ember)}
#gf-ui.gf-theme-grim #gf-menu .gf-room li{border-radius:0;background:transparent;box-shadow:inset 0 -1px 0 var(--g-faint);padding:3px 8px 3px 2px;font:600 13.5px/1.3 var(--gf-forge-serif)}
#gf-ui.gf-theme-grim #gf-menu .gf-room li i{border-radius:1px;width:8px;height:8px;transform:rotate(45deg)}
#gf-ui.gf-theme-grim #gf-menu .gf-room li.me{box-shadow:inset 0 -1px 0 var(--g-bone)}
#gf-ui.gf-theme-grim #gf-menu .gf-row{margin-top:8px}
#gf-ui.gf-theme-grim #gf-menu .gf-row .gf-btn{box-shadow:inset 0 0 0 1px var(--g-faint);padding:10px 12px;font-size:15px}
@media (min-height:661px) and (max-height:820px){#gf-ui.gf-theme-grim #gf-menu h1{font-size:clamp(34px,min(7vh,6.6vw),60px)}#gf-ui.gf-theme-grim #gf-menu h1::after{margin:10px 0 10px}#gf-ui.gf-theme-grim #gf-menu .gf-hook{font-size:16px;margin:0 0 12px}}
@media (pointer:coarse){#gf-ui.gf-theme-grim #gf-menu .gf-btn{min-height:44px;box-sizing:border-box}#gf-ui.gf-theme-grim #gf-menu .gf-back{min-height:44px}}
@media (max-height:660px){#gf-ui.gf-theme-grim #gf-menu h1{font-size:clamp(30px,5vw,48px)}#gf-ui.gf-theme-grim #gf-menu h1::after{margin:9px 0 8px}#gf-ui.gf-theme-grim #gf-menu .gf-hook{font-size:14px;margin:0 0 8px}#gf-ui.gf-theme-grim #gf-menu .gf-btn{padding:8px 10px 8px 4px;font-size:16px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary{font-size:19px;padding:10px 16px;margin-bottom:4px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary:hover{padding:10px 16px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.wallet{margin-top:8px;padding:8px 12px}#gf-ui.gf-theme-grim #gf-menu.pause .gf-col{padding:16px 18px 12px}#gf-ui.gf-theme-grim #gf-menu.pause h1{font-size:26px}}
@media (max-height:420px){#gf-ui.gf-theme-grim #gf-menu h1{font-size:clamp(24px,4vw,34px)}#gf-ui.gf-theme-grim #gf-menu h1::after{margin:6px 0 5px}#gf-ui.gf-theme-grim #gf-menu .gf-btn{padding:6px 8px 6px 4px;font-size:15px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary{padding:8px 14px;font-size:17px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.primary:hover{padding:8px 14px}#gf-ui.gf-theme-grim #gf-menu .gf-btn.wallet{margin-top:5px;padding:6px 10px}}
@media (max-width:640px){#gf-ui.gf-theme-grim #gf-menu.home{background:linear-gradient(0deg,color-mix(in srgb,var(--g-ink) 96%,transparent) 0%,color-mix(in srgb,var(--g-ink) 78%,transparent) 55%,color-mix(in srgb,var(--g-ink) 12%,transparent) 100%)}#gf-ui.gf-theme-grim #gf-menu.home .gf-col{left:16px;bottom:max(16px,env(safe-area-inset-bottom))}#gf-ui.gf-theme-grim .gf-card{padding:22px 20px 18px}#gf-ui.gf-theme-grim .gf-timer{font-size:12.5px}#gf-ui.gf-theme-grim .gf-goal{font-size:12px}#gf-ui.gf-theme-grim .gf-top{left:50%;transform:translateX(-50%)}#gf-ui.gf-theme-grim .gf-me{top:auto}}
html.gf-theme-grim #gf-forge-unsupported{background:radial-gradient(ellipse at 50% 30%,#1a1e24,var(--gf-forge-ink) 70%)!important;color:var(--gf-forge-bone)!important;font:500 16px/1.5 var(--gf-forge-serif)!important}
html.gf-theme-grim #gf-forge-unsupported h1{font:700 40px/1.05 var(--gf-forge-display)!important}
html.gf-theme-grim #gf-forge-unsupported a{color:var(--gf-forge-accent)!important}
html.gf-theme-grim #gf-forge-unsupported button{border-radius:2px!important;background:var(--gf-forge-accent)!important;color:var(--gf-forge-ink)!important;font:700 16px var(--gf-forge-serif)!important;letter-spacing:.05em}
`;

export const THEMES = {
  grim: {
    id: 'grim',
    css: GRIM_CSS,
    /** The theme's own touch layout: the game's HUD module draws the buttons (ui.js draws none of its own). */
    touch: 'own',
    /** Font files (slots ui.font.*; create copies them from `from`, beside their licence). */
    fonts: [
      { slot: 'ui.font.display', label: 'Display type (titles, banners, the wave)', family: 'GF Grim Display', file: 'assets/fonts/grim-display.woff2', weight: '500 800', from: 'grim-display.woff2', license: { spdx: 'OFL-1.1', author: 'The Grenze Gotisch Project Authors (Omnibus-Type)', url: 'https://github.com/Omnibus-Type/Grenze-Gotisch' } },
      { slot: 'ui.font.text', label: 'Text and number type', family: 'GF Grim Text', file: 'assets/fonts/grim-text.woff2', weight: '400 800', from: 'grim-text.woff2', license: { spdx: 'OFL-1.1', author: 'The Grenze Project Authors (Omnibus-Type)', url: 'https://github.com/Omnibus-Type/Grenze' } },
    ],
    /** config/game.json → ui for a new game with this theme (each a colour slot: ./slots.js). */
    ui: { theme: 'grim', ink: '#0b0d10', bone: '#ece4d0', parchment: '#c9b78e', ember: '#f08a2c', blood: '#c8242c', moon: '#9fc0e6', crosshair: '#f4eedd' },
    /** config/game.json → text: the words the themed HUD says (each a ui.* text slot; a spec's own words win). */
    text: {
      wins: 'It is done', draw: 'The hour is up', lost: 'Fallen',
      health: 'Health', stamina: 'Stamina', wounded: 'Wounded', bleeding: 'Bleeding', lastBreath: 'Last breath', down: 'You are down', friendDown: 'down', friendRising: 'rising',
      wave: 'Wave {n} of {m}', remain: '{n} remain', waveStart: 'Wave {n}', waveStartSub: '{count} come for you', waveClear: 'Wave {n} is broken', waveClearSub: 'Catch your breath',
      bossRises: '{name} rises', reloading: 'Reloading', kills: '{n} felled', critical: 'critical', score: 'Score', coins: 'Coins', loading: 'Loading', preparing: 'Making ready',
    },
    /** The friends page's colours (multiplayer.json → theme: the multiplayer kit's own keys), so the lobby and the
     *  results with friends match. Its page loads no font file: a system serif stands in. */
    mp: { font: `${SERIF}`, bg: '#07080a', panel: '#0f1216', fg: '#ece4d0', muted: '#c9b78e', faint: '#8d8266', line: '#c9b78e55', row: '#ece4d00d', button: '#ece4d014', accent: '#f08a2c', accentFg: '#0b0d10', code: '#f08a2c', ok: '#9fc0e6', radius: '2px' },
  },
};

/** The theme by name, or null (no theme: the kit's own look). */
export const themeOf = name => (name && Object.hasOwn(THEMES, name) ? THEMES[name] : null);

/**
 * Turn a theme on (browser): its class on <html> and on `root` (the UI layer, when it exists yet), its stylesheet once,
 * and (fonts: true) its font files, loaded once in the background through `url` (gf-assets' url(): Studio's swaps
 * apply). A caller that does not know yet whether the game carries the files passes fonts: false (a game made before
 * the theme has none: the system serif stands in, and no request fails). → {name, ready}
 */
export function applyTheme(name, { root = null, url = p => p, fonts = true } = {}) {
  const T = themeOf(name);
  if (!T || typeof document === 'undefined') return { name: null, ready: Promise.resolve([]) };
  document.documentElement.classList.add(`gf-theme-${T.id}`);
  root?.classList.add(`gf-theme-${T.id}`);
  if (!document.getElementById(`gf-theme-${T.id}-css`)) { const s = document.createElement('style'); s.id = `gf-theme-${T.id}-css`; s.textContent = T.css; document.head.append(s); }
  const W = globalThis;
  W.__gfThemeFonts ??= {};
  if (!fonts) return { name: T.id, ready: W.__gfThemeFonts[T.id] ?? Promise.resolve([]) };
  if (!W.__gfThemeFonts[T.id]) {
    W.__gfThemeFonts[T.id] = Promise.all(T.fonts.map(async f => {
      try { const face = new FontFace(f.family, `url(${JSON.stringify(url(f.file))})`, { weight: f.weight, display: 'swap' }); await face.load(); document.fonts.add(face); return { family: f.family, ok: true }; }
      catch (e) { return { family: f.family, ok: false, why: String(e?.message ?? e).slice(0, 120) }; }
    }));
  }
  return { name: T.id, ready: W.__gfThemeFonts[T.id] };
}
