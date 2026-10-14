// The look judge's HUD tile: the kit's own HUD layer (builder/ui/ui.js) over a frame of the kind's world,
// in the kind's HUD (a theme, or the tokens through builder/ui/kind-hud.js), showing what a round shows: the
// clock, the scoreboard, a health and a second meter, a banner, a toast, a prompt and nameplates.
// ?kind=<id>&bg=<frame url>&font=<font file url>
import { createUI } from '/kit/ui/ui.js';
import { applyKindHud } from '/kit/ui/kind-hud.js';

const Q = new URLSearchParams(location.search);
const S = window.__sheet = { ready: false, errors: [], info: {} };
addEventListener('error', e => S.errors.push(String(e.message)));
const kind = await (await fetch(`/xk/kinds/${Q.get('kind')}.json`)).json();
const hud = kind.hud ?? {};
document.body.style.backgroundImage = `url(${JSON.stringify(Q.get('bg'))})`;
if (hud.pixel || kind.look?.three?.style === 'pixel' || kind.look?.three?.values?.post?.lofi) document.body.style.imageRendering = 'pixelated';
await new Promise(r => { const i = new Image(); i.onload = i.onerror = r; i.src = Q.get('bg'); });

// a theme's fonts come from its own folder (the forge HUD's, beside their licences)
const fontDir = '/forge-fonts/';
const ctx = { config: { camera: kind.camera?.default ?? 'third', text: {} }, gf: { url: p => fontDir + p.split('/').pop() }, assets: { has: () => true } };
const ui = createUI(ctx, { theme: hud.theme ?? null, text: {}, controls: { primary: 'act', jump: 'jump' } });
const fontReady = applyKindHud(hud, { fontUrl: Q.get('font') });       // after the kit's own sheet, so it wins
const pal = ['#ff5e6c', '#3fa9f5', '#f5d33f', '#8ad13f'];
const grim = hud.theme === 'grim';
ui.timer(true);
const players = [{ name: 'You', score: 12, color: pal[0], local: true }, { name: 'Mia', score: 15, color: pal[1] }, { name: 'Theo', score: 9, color: pal[2] }, { name: 'Ana', score: 6, color: pal[3] }];
const hp = ui.meter('health', { label: grim ? 'Health' : 'Health', value: 7, max: 10, color: grim ? null : '#ff5e6c' });
ui.meter('stamina', { label: grim ? 'Stamina' : 'Energy', value: 4, max: 10, color: grim ? null : '#3fa9f5' });
if (grim) ui.banner('Wave 2', 999, { sub: '9 come for you', tone: 'ember' }); else ui.banner('Round 2', 999);
ui.toast('Mia joined the game');
ui.prompt('E  pick up');
const W = innerWidth, H = innerHeight;
ui.update(0.016, { left: 83, players, plates: [{ id: 'a', text: 'Mia', color: pal[1], x: W * 0.36, y: H * 0.47, visible: true }, { id: 'b', text: 'Theo', color: pal[2], x: W * 0.62, y: H * 0.5, visible: true }] });
S.info.font = await fontReady;
await document.fonts.ready;
await new Promise(r => setTimeout(r, 450));
S.ready = true;
