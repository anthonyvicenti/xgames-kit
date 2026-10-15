// gf-three core: boot({rules}) for the vista engine (CONTRACT §8 vista; research/super-scenic/PLAN.md §3, THIN_E2E.md).
//
//   import { boot } from './gf/three/core/boot-vista.js'; import rules from './rules.js'; boot({ rules });   (main.js)
//
// The same system as boot-forge.js, with the vista core (gf/vista/core: a vendored WebGPU engine, MIT, credited in gf/vista/UPSTREAM.json)
// in place of the Rust core: the configs and assets.json (kit/assets/core.js, no three.js), the shared loading view,
// then a WebGPU probe BEFORE any core module loads (gf/vista/kit/gpu.js has no import: a browser without WebGPU gets the
// kit's own "open in a browser with WebGPU" screen with the game's link, never a blank canvas, and a minimal
// window.__game); then the core through gf/vista/kit/host.js with ui: false (nothing of the upstream game's own
// interface or name reaches the page) and every file it reads through gf-assets (Studio's swaps and overrides); the
// look from config/look.json; the data tables (config/game.json → vista, gf/vista/kit/tables) and the game bridge
// (gf/vista/kit/game.js: the core's fishing, selling, shop and boat as events); the shared UI, HUD and home menu with
// vista's own HUD parts (gf/vista/hud) in the HUD layer; the round and the net (kit/net/session.js with
// gf/vista/kit/players.js: friends drawn as gf-humanoid-1 bodies from config/characters.json → vista, each a slot);
// rules.setup(ctx); then the frame loop through net.loop (the core's own App.frame, never its own loop).
//
// What rules.js gets (prompts/build-vista.md): ctx.vista ({state, sell, buy, look, tables, app}), the game's events in
// rules.event(ctx, name, data, 'vista') on the copy where they happened (bite hooked catch lost sold bought board
// leave), ctx.me.score (each copy's own player: a joiner's score reaches the host, which owns the results), and
// ctx.finish(reason) to end the session for everyone with the results (a calm game's goal: a host ends it at once, a
// joiner asks the host).
// In a live round the host's copy owns the time of day and the sea state (they ride in the round's own world message)
// and the round's clock; every copy owns its own walker, fishing, cooler and money.
// Islands (gf-vista wave 3 track H): config/world.json → islands ([{ name, seed, words, places }], gf/vista/kit/config.js
// islandsConfig): the core boots island 1, the game bridge sails between them (gf/vista/kit/islands.js), rules.canHop(ctx,
// to, info) gates a trip ("buy the boat keys first"), rules.event gets 'hop-start' and 'hop-done'. The host's copy
// decides a hop (its island rides in the world message: every copy rebuilds the same island and arrives aboard); a
// joiner sailing out asks the host; a player who joins mid-trip lands on the current island.
// Watch then play (gf-multiplayer 1.6.0+; CONTRACT §4 "Watch, voice"): a player in a room goes live from the game's own
// menu (#gf-live: the same button and calls as boot.js and boot-forge.js) or from the friends page, and the menu's Voice
// chat row opens Studio's voice panel where Studio's page is above the game (the mic is only ever Studio's). A page
// opened as the stream's viewer (net.watching) is a copy with no player of its own: its player is a ghost in no list,
// nothing is sent, input and the menu are off, and its camera is the streamer's eyes (gf/vista/kit/watch.js: the core's
// own free camera placed where the streamer's camera was, their body hidden, their boat with them). The viewer keeps
// what everyone in the round sees (names, the clock, the scores, banners, the goal), never a player's own HUD.
// Not yet for vista (verify says so): the slot-ID pass (coverage, sight), a lost device, bots, loadouts on the bodies
// (a player's own colour from the wallet); on a viewer's screen the streamer's rod, line and catch (the core draws one
// rod, the local player's: runtimes/vista/CORE-NOTES.md).
import * as gf from '../../gf-assets.js';
import { createAudio } from '../../../audio/audio.js';
import audioPresets from '../../../audio/presets.json' with { type: 'json' };
import KIT from '../kit.js';
import { assets } from '../assets/core.js';
import { createRng, seedOf } from './rng.js';
import { createUI } from '../ui/ui.js';
import { createHud } from '../ui/hud.js';
import { createMenu, loadSettings } from '../ui/menu.js';
import { startLoading } from '../ui/loading.js';
import { listenForHost, host as pageHost } from '../net/host.js';
import { createSession } from '../net/session.js';
import { listenForLoadout } from '../net/looks.js';
import { createFair } from './fair.js';
import * as refusals from './refusals.js';
import { seedRules, readOnlyView, refusedPress, watchKit, setupFailed, frameFailed } from './guard.js';
import { createEventLog } from './events.js';
import { createPlay } from './play.js';
import { stepAsked, createStepper } from './step.js';
import { net } from '../../mp/net.js';
import { probeWebGPU, noWebGPUScreen } from '../../vista/kit/gpu.js';
import { createWatchCamera, watchCss } from '../../vista/kit/watch.js';

export const VERSION = KIT.version;
/** The runtime and its profile as the observation names them (runtimes/CONTRACT.md §6.1): vista has no profiles. */
export const RUNTIME = 'vista', PROFILE = null, KIT_NAME = 'xgames-kit';
/** The quality tier: vista draws one tier (its render scale is the core's own setting). */
const QUALITY = 'high';
/** The game's events (gf/vista/kit/game.js, interface I2) that reach rules.event. */
export const EVENTS = ['bite', 'hooked', 'catch', 'lost', 'sold', 'bought', 'board', 'leave', 'hop-start', 'hop-done'];
/** The core's own keys that are never a game's: its free camera (F) and its time switch (T). */
const CORE_KEYS_OFF = ['KeyF', 'KeyT'];

export async function boot({ rules = {} } = {}) {
  startLoading();
  listenForHost(window);
  listenForLoadout(window);
  const params = new URLSearchParams(location.search);
  const subject = params.get('gf-show');
  const ctx = { kit: { name: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, vista: KIT.vista?.version ?? null }, onFrame: [], time: { now: 0, dt: 0, round: 0, left: 0 }, gf };
  let ui = null;
  try {
    await assets.init({ configs: ['game', 'look', 'world', 'characters'] });
    const game = assets.config('game'), lookCfg = assets.config('look'), worldCfg = assets.config('world'), chars = assets.config('characters');
    ctx.config = game; ctx.assets = assets; ctx.world = worldCfg;
    ctx.fair = createFair(ctx);
    document.title = game.text?.title ?? game.title ?? document.title;
    for (const s of assets.manifest?.slots ?? []) {
      if (!s.css || s.source?.pointer === undefined) continue;
      let v; try { v = assets.value(s.id, null); } catch { v = null; }
      if (v != null && typeof v !== 'object') document.documentElement.style.setProperty(s.css, s.type === 'text' ? JSON.stringify(String(v)) : String(v));
    }
    const seed = seedOf(params.get('seed') ?? net.seed ?? params.get('gf_seed') ?? (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 1));
    const rng = createRng(seed);
    ctx.rng = rng.fork('rules'); ctx.seed = seed;
    // Math.random inside a rules hook draws from the game's seeded stream too (kit/core/guard.js seedRules)
    rules = seedRules(rules, rng.fork('rules:Math.random'));
    const gameId = assets.manifest?.game ?? 'game';

    // ---- WebGPU first: without it the kit's screen, and no core module is ever loaded ----
    const gpu = params.get('gf-vista-nowebgpu') === '1' ? { ok: false, kind: 'missing', why: 'asked for by ?gf-vista-nowebgpu=1 (QA)' } : await probeWebGPU();
    if (!gpu.ok) return unsupported(ctx, game, gpu);
    if (!document.getElementById('app')) { const d = document.createElement('div'); d.id = 'app'; d.style.cssText = 'position:fixed;inset:0'; document.body.prepend(d); }
    const [H, T, G, HUD, P, HM, C, O, PL] = await Promise.all([
      import('../../vista/kit/host.js'), import('../../vista/kit/tables/index.js'), import('../../vista/kit/game.js'), import('../../vista/hud/index.js'),
      import('../../vista/kit/players.js'), import('../../vista/kit/humanoid.js'), import('../../vista/kit/config.js'), import('../../vista/kit/observe.js'),
      import('../../vista/kit/world/places.js'),
    ]);

    // ---- the core: no DOM of its own, every file read through gf-assets ----
    const CORE = 'gf/vista/core/public/';
    const readPath = p => (/^(assets|gf|config)\//.test(p) ? p : CORE + p);   // the core reads audio/, clouds/, models/, textures/ under its own public folder
    const reader = p => fetch(gf.url(readPath(p)));
    const look = { preset: lookCfg.preset, ...C.bootLook(lookCfg) };
    if (!(look.preset in C.presets)) delete look.preset;
    // the sky-pro clouds only when this game ships them (gf/three/kit.js lists every gf/vista file; the open-source
    // kit's copy of the core leaves them out and draws the core's own MIT clouds)
    const clouds = KIT.vista?.files?.['core/src/sky/SkyProClouds.js'] ? 'volumetric' : 'basic';
    // what the core adds to its scene remembers which core module added it (gf/vista/kit/coverage.js: coverage and slots
    // read every drawn thing's slot from it; the core itself is not edited)
    const [CV, { Object3D }] = await Promise.all([import('../../vista/kit/coverage.js'), import('../../vista/core/src/engine/scene/Object3D.js')]);
    CV.stampAdds(Object3D);
    // the islands (config/world.json → islands): the core builds the first; none listed, the core's own island
    const islands = C.islandRecipes?.(worldCfg) ?? [];
    const vista = await H.createVista({ ui: false, panel: false, start: false, reader, look, clouds, place: islands[0]?.recipe ?? null });
    const app = vista.app;
    CV.nameOcean(app);
    ctx.coverage = () => CV.coverage(app.scene, { has: id => assets.has(id) });
    ctx.slotsDrawn = () => CV.slots(app.scene, app.camera);
    const sightOf = ids => CV.sight({ scene: app.scene, camera: app.camera, canvas: app.engine.canvas }, [].concat(ids ?? []));
    // the kit's own canvas name (boot.js, boot-forge.js): tools and checks find, focus and lock it as #gf-canvas
    if (!document.getElementById('gf-canvas')) { app.engine.canvas.id = 'gf-canvas'; app.engine.canvas.tabIndex = 0; }
    const canvas = app.engine.canvas;
    ctx.vistaHost = vista;

    // ---- the data tables and the game bridge (I1, I2) ----
    const tables = T.fill(game.vista ?? {});
    const vgame = await G.createVistaGame(vista, tables, { saveKey: `gf-vista:${gameId}`, words: game.text ?? {},
      ...(islands.length > 1 ? {
        islands,
        decides: () => !net.active || !!ctx.host,
        ask: to => ctx.net?.send('vista-hop', { to }, 'host'),
        seat: () => ctx.me?.seat ?? 0,
        gate: rules.canHop ? (to, info) => rules.canHop(ctx, to, info) : null,
      } : {}) });
    ctx.tables = tables;
    ctx.vista = {
      app, look: vista.look, tables, game: vgame,
      state: () => vgame.state(), sell: () => vgame.sell(), buy: id => vgame.buy(id),
    };

    // ---- a preview subject (?gf-show=world | look): the island, no menu, no players ----
    if (subject) return showSubject(ctx, { vista, C, subject, worldCfg });

    // ---- audio, input, UI ----
    // the core's own sounds (assets.json → sounds, engine 'vista-core') are played by its soundscape, routed into this
    // kit's sfx bus before the first gesture (gf/vista/kit/audio.js, core patch #2); the kit plays the rest
    const VA = await import('../../vista/kit/audio.js');
    const soundList = await gf.sounds();
    const audio = createAudio(VA.splitSounds(soundList).kit, { presets: audioPresets.presets, storageKey: `gf3-${gameId}`, listen: true, fileUrl: gf.url });
    ctx.vistaAudio = VA.attachVistaAudio(vista, audio, { manifest: soundList, game: vgame });
    ctx.audio = {
      raw: audio,
      play(id, opts = {}) {
        const o = { ...opts }; delete o.at;
        if (!audio.has(id)) { if (!o.optional) refusals.refuse('sound-unlisted', `ctx.audio.play("${id}"): no sound with that id in assets.json → sounds → sounds (list it there, or pass { optional: true })`, id); return null; }
        return audio.play(id, o);
      },
      has: id => audio.has(id), stop: id => audio.stop(id),
    };
    // the core reads its own keyboard and mouse (core/src/core/Input.js); the shared settings reach it through this
    const input = { lookScale: 1, invertY: false, touch: false, lockRefused: false, enabled: false, press() {}, stickState: () => null, get locked() { return !!app.input.locked; } };
    ctx.input = input;
    ui = createUI(ctx, { text: game.text ?? {}, controls: game.controls ?? {}, theme: null });
    ctx.ui = ui;
    let menu = null;
    // a vista panel (the cooler, a stall: gf/vista/kit/game.js 'panel') takes the mouse on purpose; while one is open, or
    // in the moment its Esc closes it, letting go of the mouse is not a pause (two overlays at once, and a stray click
    // on the pause menu's "Close the room" ended the game for everyone: verify check 5, 2026-10-12)
    let vistaPanel = null, vistaPanelShut = 0;
    vgame.on('panel', p => { if (vistaPanel && !p.panel) vistaPanelShut = performance.now(); vistaPanel = p.panel ?? null; });
    const panelBusy = () => !!vistaPanel || performance.now() - vistaPanelShut < 250;
    const openPause = () => { if (!menu || menu.view || panelBusy() || !['playing', 'countdown'].includes(ctx.round?.phase)) return; menu.pause(); try { document.exitPointerLock?.(); } catch {} };
    const hud = createHud(ctx, ui, { onMenu: () => openPause() });
    ctx.hud = readOnlyView(hud, ['goalText', 'observe', 'fullscreen'], 'ctx.hud'); ui.goalTo = t => { if (refusals.goalCall(t)) hud.goal(t); };
    hud.setGoal(refusals.startGoal(game));
    // vista's own HUD parts (I3: money, the cooler, the rod, the bite, the fight, the catch card, the stalls) in the HUD layer
    const layer = document.createElement('div');
    layer.id = 'gf-vista-hud'; layer.style.cssText = 'position:absolute;inset:0;pointer-events:none';
    ui.root.append(layer);
    const vhud = HUD.createVistaHud(layer, vgame, { words: game.text ?? {} });
    ctx.vistaHud = vhud;
    // the core takes the mouse on a click into the game (core/src/App.js): never while the menu, a card or the results
    // are up (its own check reads window.__ui.isPointerOverUI)
    window.__ui = { get isPointerOverUI() { return ctx.round?.phase !== 'playing' || !!menu?.view || !!ui?.covered; } };

    // ---- mechanics: none runs on vista (the core plays the fishing and the boat) ----
    const list = [];
    ctx.mechanics = { get: () => null, list: () => [] };
    ctx.mechanicsList = list;
    ctx.aimed = false;

    // ---- friends and the round: the shared session over the core's walker; friends drawn by gf/vista/kit/players.js ----
    const V = chars.vista ?? { bodies: [], clips: C.CLIPS_FILE };
    const seatOfPeer = peer => { const s = net.players?.find?.(x => x.id === peer.id)?.seat; return Number.isInteger(s) ? s : Math.max(0, (parseInt(String(peer.id).replace(/\D+/g, ''), 10) || 1) - 1); };
    const bodyFor = seat => { const n = Math.max(1, V.bodies.length), i = ((seat % n) + n) % n, b = V.bodies[i] ?? {}, slot = C.bodySlot(i); return { file: assets.has(slot) ? assets.file(slot) : b.file, height: b.height ?? 1.75, slot }; };
    const clipsFile = assets.has(C.CLIPS) ? assets.file(C.CLIPS) : V.clips;
    async function makeBody(a, peer) {
      const b = bodyFor(seatOfPeer(peer));
      const h = await HM.loadHumanoid(a, { body: b.file, clips: clipsFile, height: b.height, tint: peer.color ?? null, add: false });
      if (h.group?.userData) h.group.userData.gfSlot = b.slot;   // a friend's body is its seat's body slot (coverage)
      return {
        kind: 'gf-humanoid-1', slot: b.slot, group: h.group, clips: h.clips, info: h.info,
        update: dt => h.update(dt), setTransform: (pos, yaw) => h.setTransform(pos, yaw),
        play: (clip, o = {}) => h.play(clip, { fade: 0.25, speed: o.speed ?? 1 }),
        rate: r => { const l = h.model?.layers?.find(x => x.target === 1); if (l) l.speed = r; },
        speed: clip => h.speed(clip), dispose: () => h.dispose(),
      };
    }
    // (a viewer: the streamer's body is not drawn; their eyes are the camera)
    const watchState = { session: null };
    const following = () => watchState.session?.watch?.follow?.id ?? null;
    const friends = P.createPlayers(vista, net, { makeBody: V.bodies.length ? makeBody : undefined, follow: following });
    vista.players = friends;
    const start = tables.start ?? C.START_DEFAULT;
    /** This copy's walker at its seat's start place (or at pos): on its feet, still, looking where the seat faces. */
    function placeLocal(seat = 0, pos = null, yaw = null) {
      const at = pos ? { x: pos.x, z: pos.z, yaw: yaw ?? app.player.yaw } : C.placeOf(worldCfg, start, seat, vgame.island?.() ?? null);
      const p = app.player;
      if (app.freeCam) app.setFreeCam(false);
      p.mode = 'walk';
      p.velocity?.set?.(0, 0, 0);
      const ground = Math.max(app.terrainData.heightAt(at.x, at.z), app.colliders?.groundHeightAt?.(at.x, at.z, 50) ?? -Infinity);
      p.position.set(at.x, ground, at.z);
      p.yaw = at.yaw; p.pitch = -0.06; p.grounded = false;
    }
    const players = { api: null };
    const lookShared = () => ({ h: Math.round(vista.look.state.hour * 1000) / 1000, s: vista.look.state.sea });
    const session = createSession(ctx, { rules, spawnCharacter: null, characterFor: () => ({}), rng, botCount: 0, onPhase: ph => onPhase(ph),
      createPlayers: c => (players.api = P.sessionPlayers(c, friends, { vista, placeLocal })),
      // the host's copy owns the light and the sea: they ride in every world message (the pier sandbox's way)
      coreWorld: net.active ? () => ({ v: lookShared(), ...(vgame.trip ? { isl: vgame.trip.shared() } : {}) }) : null, flow: null });
    watchState.session = session;
    ctx.round = {
      get phase() { return session.round.phase; }, get number() { return session.round.number; },
      get winners() { return session.round.winners; }, get reason() { return session.round.reason; },
      end: (reason = 'ended', winners = null) => session.end(reason, winners),
    };
    // ctx.finish: a calm game's goal ends the session for everyone with the results; a joiner asks the host
    ctx.finish = (reason = 'goal', winners = null) => {
      if (session.round.phase !== 'playing') return false;
      if (ctx.host) { session.end(reason, winners ?? [ctx.me.id]); return true; }
      ctx.net.send('vista-finish', { reason: String(reason).slice(0, 40) }, 'host');
      return true;
    };
    // each island's own time and weather (its words, gf/vista/kit/config.js islandLook): the copy that owns the light
    // sets it on arrival (it rides to the others in the world message); an island with none takes the game's look
    vgame.on('hop-done', d => {
      if (net.active && !ctx.host) return;
      const own = C.islandLook(worldCfg, d.to);
      vista.look.set(d.to === 0 ? C.bootLook(lookCfg) : { ...C.bootLook({ preset: lookCfg.preset }), ...(own ?? {}) });
    });
    // a joiner out at sea asks the host to set sail (the host's copy decides: its own gate's game rules, not its helm)
    ctx.net.on('vista-hop', (d, from) => { if (ctx.host && vgame.trip) vgame.hop(d?.to, { force: true, by: from }); });
    ctx.net.on('vista-finish', (d, from) => { if (ctx.host && session.round.phase === 'playing') session.end(String(d?.reason ?? 'goal').slice(0, 40), [from]); });
    // each copy's own score reaches the host, which owns the results (every player fishes on their own copy)
    ctx.net.on('vista-score', (d, from) => { const p = ctx.players.get(from); if (ctx.host && p && Number.isFinite(d?.score)) p.score = d.score; });
    let sentScore = null;
    await session.start();
    const me = ctx.me;
    me.actions = { primary: { down: false, pressed: false }, secondary: { down: false, pressed: false }, interact: { down: false, pressed: false }, jump: { down: false, pressed: false } };
    ctx.fair.setup?.();
    placeLocal(me.seat ?? 0);
    // the game's events → rules.event (and anyone listening through ctx.vista.on)
    for (const name of EVENTS) vgame.on(name, data => { try { rules.event?.(ctx, name, data, 'vista'); } catch (e) { frameFailed(`rules.event (${name})`, e); } });
    ctx.vista.on = (name, fn) => vgame.on(name, fn);
    // the kit's own elements (CONTRACT §6g) are kept as the kit means them from here on (kit/core/guard.js)
    const kitGuard = watchKit({ layer: ui.root, items: () => [{ el: ui.root, name: "the kit's layer (#gf-ui)", want: true }, ...hud.kitItems(), ...(menu?.kitItems() ?? [])] });
    if (params.get('gf-ui') === '0') kitGuard.off = true;
    // the kit's event log (gf/three/core/events.js; gates C and D): every press, score and sound the kit plays, and the
    // game's events as the part `vista` (gf/vista/kit/observe.js), each this copy's own player's
    const vistaEvents = O.vistaPart(vgame, ctx);
    const kitLog = createEventLog(ctx, { list: [vistaEvents], modules: new Map([['vista', { manifest: vistaEvents.manifest }]]) });
    ctx.events = Object.freeze({ count: kitLog.count });
    // the play feed (gf/three/core/play.js; builder/play): the same numbers as every runtime's, from the kit's event log
    const playFeed = createPlay(ctx, { log: kitLog, list: [vistaEvents], modules: new Map([['vista', { manifest: vistaEvents.manifest }]]), rows: () => session.round.rows });
    try { await rules.setup?.(ctx); } catch (e) { console.error(e); setupFailed('rules', e); throw e; }

    function onPhase(ph) {
      if (ph === 'countdown') { menu?.close(); ctx.audio.play('round-countdown', { optional: true }); }
      if (ph === 'playing') {
        ui.cover('results', false); ui.hideCard(); if (menu?.view && !menu.paused) menu.close();
        if (!session.watching) placeLocal(ctx.me?.seat ?? 0);
        app.audio?.resume?.();
        ui.banner(game.text?.go ?? 'Go!', 1.2); ctx.audio.play('round-go', { optional: true });
      }
      if (ph === 'lobby') { ui.hideCard(); if (!session.live) menu?.home(); try { document.exitPointerLock?.(); } catch {} }
      if (ph === 'results') {
        menu?.close();
        const w = session.round.winners ?? [];
        try { document.exitPointerLock?.(); } catch {}
        if (session.live) { ui.cover('results', true); ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true }); return; }
        const T2 = game.text ?? {};
        // the results say who won: the goal's winner, or when the clock ran out whoever scored most. Only a session in
        // which nobody scored at all has no winner ("You wins!" with 0 fish, T7 run 1; "no winner on the card", T7 in
        // Studio, 2026-10-12). Alone, the player is "You": "You win!"
        const scoreOf = id => ctx.players.get(id)?.score ?? 0;
        const won = (session.round.reason ?? 'time') === 'time' ? w.filter(id => scoreOf(id) > 0) : w;
        const wonNames = won.map(id => ctx.players.get(id)?.name ?? id);
        const meOnly = won.length === 1 && won[0] === ctx.me?.id;
        const title = !won.length ? (T2.timeUp ?? 'The session is over: nobody scored')
          : meOnly ? (T2.youWin ?? 'You win!')
          : (T2.wins ?? '{name} wins!').replace('{name}', wonNames.join(' & '));
        ui.results({ title, rows: session.round.rows ?? [], winners: w,
          onAgain: game.round?.replay === false ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.replay(); },
          onMenu: () => { ctx.audio.play('ui-click', { optional: true }); session.toLobby(); } });
        ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true });
      }
    }
    const friendsPage = () => new URL('gf/mp/index.html', location.href).href;
    menu = createMenu(ctx, ui, {
      game, live: session.live, world: false, gameId, host: pageHost, players: () => ctx.players.list(),
      onPlay: () => { if (session.round.phase === 'lobby') { ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); } },
      onFriends: () => { if (pageHost.present && pageHost.offers.friends) pageHost.friends(); else location.href = friendsPage(); },
      onResume: () => { menu.close(); app.engine?.domElement?.focus?.(); },
      onLeave: () => { menu.close(); session.toLobby(); },
      onQuality: () => { if (!session.live) location.reload(); },
      // a room's menu: leave it, and the host ends the round
      room: session.live ? { info: () => net.room, leave: () => { menu.close(); net.leave(); }, end: () => { menu.close(); session.end('ended', null, true); },
        // watch then play (gf-multiplayer 1.6.0): Go live, and the stream's state while it is on, as boot.js
        live: () => net.live ?? null, goLive: () => { menu.close(); canvas.focus(); net.live?.start?.(); }, showLive: () => { menu.close(); canvas.focus(); net.live?.share?.(); },
        // voice chat on Studio's play page (gf-multiplayer 1.7.4): the row opens Studio's voice panel over the game
        voice: () => net.live?.voice ?? null, voiceOpen: () => net.live?.voiceOpen?.(), voiceClose: () => net.live?.voiceClose?.() } : null,
    });
    if (session.live) net.live?.onChange?.(() => menu.redraw?.());
    ctx.menu = readOnlyView(menu, ['view', 'paused', 'observe'], 'ctx.menu');      // read-only for rules
    if (params.get('gf-ui') === '0') ui.root.style.display = 'none';
    // a viewer keeps what everyone in the round sees and nothing else of the HUD (gf/vista/kit/watch.js WATCH_KEEPS); its
    // canvas takes no clicks (no pointer lock: there is nothing of its own to look round with)
    const watchStyle = document.createElement('style');
    watchStyle.textContent = watchCss();
    document.head.append(watchStyle);
    const watchUi = on => { if (ui.root.classList.contains('gf-watching') !== on) { ui.root.classList.toggle('gf-watching', on); canvas.style.pointerEvents = on ? 'none' : ''; } };
    // the viewer's camera: the streamer's eyes, or over the bay from the beach while they are not drawn
    const bay = C.placeOf(worldCfg, 'beach', 0);
    const watchCam = createWatchCamera(app, friends, { follow: following, overview: { x: bay.x + 6, y: 4.5, z: bay.z + 14, yaw: Math.atan2(-(55 - bay.x - 6), -(20 - bay.z - 14)), pitch: -0.08 } });
    if (session.live) { ui.waiting(); session.arm(); session.ready(); }
    else if (params.get('gf-autoplay') === '1') session.beginCountdown();
    else menu.home();
    addEventListener('keydown', e => {
      if (session.watching) return;
      const a = document.activeElement, onControl = a && (a.tagName === 'BUTTON' || a.tagName === 'INPUT');
      if ((e.code === 'Enter' || e.code === 'Space') && !onControl && session.round.phase === 'lobby' && menu.view === 'home') { if (refusedPress(e, 'Play (Enter)')) return; e.preventDefault(); menu.close(); ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); }
      if (e.code === 'Escape' && !e.defaultPrevented && !menu.view && ['playing', 'countdown'].includes(session.round.phase)) { e.preventDefault(); openPause(); }
    });
    // Esc while the core holds the mouse: the browser takes the key to let the mouse go, and the page may never see it;
    // letting go of the mouse in a round opens the pause menu instead
    // Only a lock that stays lost is a pause: a tool (or the browser) that lets go and takes the mouse back within a
    // moment (tools/lib/lock.mjs turnBy re-centres that way) is not a player stepping away (the T7 play-tester's look
    // steps opened the pause menu, 2026-10-12)
    let held = false, lostAt = 0;
    document.addEventListener('pointerlockchange', () => {
      const now = !!document.pointerLockElement;
      if (held && !now) {
        const t = lostAt = performance.now();
        setTimeout(() => { if (lostAt === t && !document.pointerLockElement && !menu.view && !panelBusy() && session.round.phase === 'playing') openPause(); }, 250);
      }
      if (now) lostAt = 0;
      held = now;
    });

    // ---- the observation (CONTRACT §5, §8 vista): the names verify reads, kit/observe.js's and the session's ----
    const r2 = v => Math.round(v * 100) / 100;
    const observe = () => ({
      kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: session.round.phase, round: session.round.number, seed, quality: QUALITY,
      time: { now: r2(ctx.time.now), round: r2(ctx.time.round), left: r2(ctx.time.left) },
      me: me.id, host: ctx.host, live: session.live, backdrop: false, view: menu.view ?? ui.view, paused: menu.paused && !session.live,
      players: ctx.players.list().map(p => ({ id: p.id, name: p.name, score: p.score, alive: p.alive, bot: false, local: p.local, x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), anim: p.anim, mode: p.mode, color: p.color, drawn: !!p.drawn, onScreen: !!p.onScreen, ...(ctx.fair.observe?.(p) ?? {}) })),
      fair: ctx.fair.summary?.() ?? null,
      refusals: refusals.list(),
      winners: session.round.winners, reason: session.round.reason, results: session.round.rows,
      shared: ctx.shared.snapshot(),
      rules: (() => { try { return rules.observe?.(ctx) ?? null; } catch { return null; } })(),
      modules: { standins: { look: false, world: false, character: false }, mechanics: [] },
      net: session.gateBlock(ui.covered),
      // watch then play: a viewer's copy, whom it follows and whether the camera has them (their eyes)
      watch: session.watching ? { follow: session.watch?.follow ?? null, live: !!session.watch?.live, target: watchCam.target, camera: watchCam.camera } : null,
      // the island the core built (its key: gates F reads it against the spec's islands; never the reference island)
      world: { template: worldCfg.template, start, island: vgame.island(), islands: Math.max(1, vgame.islands().length), names: (worldCfg.islands ?? []).map(i => i.name), place: PL.builtPlace() },
      vista: { ...vista.observe.snapshot(), friends: friends.list(), game: (() => { try { return vgame.state(); } catch (e) { return { error: e.message }; } })(), input: { enabled: !!app.input.enabled, locked: !!app.input.locked } },
    });
    // stepped time (QA only, gf/three/core/step.js): asked for in the address, alone; every stepped frame is the core's
    // whole frame (it draws as it simulates), only the clock is the caller's
    const stepped = stepAsked(params, { live: session.live, backdrop: false });
    const stepper = stepped ? createStepper({ frame: f => frame(0, f) }) : null;
    const meter = O.frameMeter();
    const heightAt = (x, z) => Math.max(app.terrainData.heightAt(x, z), app.colliders?.groundHeightAt?.(x, z, 50) ?? -Infinity);
    window.__game = Object.freeze({
      kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, seed, quality: QUALITY,
      get phase() { return session.round.phase; },
      get ready() { return true; },
      get players() { return observe().players; },
      snapshot: () => JSON.parse(JSON.stringify(observe())),
      coverage: () => JSON.parse(JSON.stringify(ctx.coverage())),
      slots: () => JSON.parse(JSON.stringify(ctx.slotsDrawn())),
      sight: ids => sightOf(ids),
      controls: () => JSON.parse(JSON.stringify(controlsReport())),
      // which sounds the kit played, by id (the core's soundscape plays through gf-audio's bus on its own: kit/audio.js)
      sounds: () => JSON.parse(JSON.stringify({ plays: audio.stats?.plays ?? {}, dropped: audio.stats?.dropped ?? {}, core: ctx.vistaAudio?.observe?.() ?? null })),
      panels: () => JSON.parse(JSON.stringify(ui.panels?.observe?.() ?? { open: [], covered: false, opened: 0, closed: 0, refused: 0, last: null })),
      events: o => JSON.parse(JSON.stringify(kitLog.read(o ?? {}))),     // the event log (gf/three/core/events.js; gates C and D)
      play: () => JSON.parse(JSON.stringify(playFeed.read())),             // the play feed (gf/three/core/play.js; gate D's play leg)
      ...(stepped ? { stepped: true, step: (ms, opts) => JSON.parse(JSON.stringify({ ...stepper.step(ms, opts), now: ctx.time.now, round: ctx.time.round, phase: session.round.phase })) } : {}),
      menu: () => JSON.parse(JSON.stringify(menu.observe())),
      hud: () => JSON.parse(JSON.stringify({ phase: session.round.phase, covered: ui.covered, ...hud.observe(), vista: { layer: !!layer.isConnected, children: layer.childElementCount } })),
      looks: () => JSON.parse(JSON.stringify({ me: me.id, local: ctx.looks?.observe?.() ?? null, slots: assets.playerLooks(), vista: { state: vista.look.state, config: lookCfg, values: vista.observe.looks },
        players: ctx.players.list().map(p => ({ id: p.id, name: p.name, bot: false, local: p.local, seat: p.seat, color: p.color, drawn: p.local ? null : (friends.list().find(f => f.id === p.id)?.body ?? null) })) })),
      camera: () => JSON.parse(JSON.stringify({ mode: 'first', ...vista.observe.camera(), lookScale: input.lookScale ?? 1, invertY: !!input.invertY, cursorMode: false, cursor: null, aimFree: false, crosshair: false,
        locked: !!app.input.locked, lockRefused: false, following: false, fullscreen: hud.fullscreen?.() ?? null })),
      screen: () => JSON.parse(JSON.stringify({ ...vista.observe.screen(), quality: QUALITY, ...meter.observe() })),
      project: (x, y, z) => { app.camera.updateMatrixWorld(); const v = new app.camera.position.constructor(x, y, z).applyMatrix4(app.camera.matrixWorldInverse); if (v.z > -app.camera.near) return { x: -1, y: -1, front: false }; v.applyMatrix4(app.camera.projectionMatrix); return { x: r2((v.x * 0.5 + 0.5) * innerWidth), y: r2((0.5 - v.y * 0.5) * innerHeight), front: true }; },
      vista: Object.freeze({
        look: () => JSON.parse(JSON.stringify({ state: vista.look.state, config: lookCfg })),
        game: () => JSON.parse(JSON.stringify(vgame.state())),
        friends: () => JSON.parse(JSON.stringify(friends.list())),
        // where a friend's body is on this screen ({front, onScreen, rect} in CSS pixels; gf/vista/kit/players.js)
        project: id => { app.camera.updateMatrixWorld(); return JSON.parse(JSON.stringify(friends.project(id))); },
        // QA only (verify check 5's vista leg): the frames the core has drawn; a friend's body hidden and shown again,
        // and the name tags off, so a check can see the core's own pixels of a friend; the look set as Studio would
        frames: () => app.engine?.frame ?? null,
        showFriend: (id, on) => { const b = friends.body(id); if (b?.group) b.group.visible = !!on; return !!b; },
        tags: on => { friends.tags(!!on); return !!on; },
        setLook: v => JSON.parse(JSON.stringify(vista.look.set(v))),
        // QA only (gate F's islands leg, tools/hop-friends.mjs): go to island i without the sail-out. Alone or on the
        // host's copy, the way a joiner's copy follows its host (no game gate; in a live game the island rides to the
        // others in the world message); on a joiner's copy, the joiner's ask to the host (the host's copy decides, as when
        // a joiner sails out). Resolves with the hop-done event once the island is built ({ok: false} when it cannot go)
        hop: i => new Promise(res => {
          const off = vgame.on('hop-done', d => { if (d.to !== i) return; off(); clearTimeout(t); res(JSON.parse(JSON.stringify({ ok: true, ...d }))); });
          const t = setTimeout(() => { off(); res({ ok: false, why: `island ${i} was not reached in 60 s` }); }, 60000);
          if (net.active && !ctx.host) ctx.net.send('vista-hop', { to: i }, 'host');
          else if (!vgame.follow(i)) { off(); clearTimeout(t); res({ ok: false, why: `no hop to island ${i}` }); }
        }),
      }),
    });

    /** controls() (runtimes/CONTRACT.md §6.1): the camera, the controls and prompt, what the view is on (the island's
     *  ground or the sea: gf/vista/kit/observe.js aimOf), where the cast line is in the water, and the stall or boat in
     *  reach (E). */
    function controlsReport() {
      const c = vista.observe.camera(), a = O.aimOf(heightAt, c.eye, c.dir);
      let st = null; try { st = vgame.state(); } catch { /* the game bridge's own */ }
      const bob = app.game?.rod?.lineInWater ? app.game.rod.bobber ?? null : null;
      return { camera: 'first', crosshair: false, aimed: false, controls: game.controls ?? {}, keys: vista.observe.controls, prompt: ui.promptText ?? st?.prompt?.text ?? null, viewport: { w: innerWidth, h: innerHeight },
        aim: { dir: c.dir, dist: a.dist, point: a.point, hit: a.hit, onSelf: false, screen: window.__game.project(a.point.x, a.point.y, a.point.z) },
        landing: bob && Number.isFinite(bob.x) ? { point: { x: r2(bob.x), y: r2(bob.y ?? 0), z: r2(bob.z) }, rod: st?.rod ?? null, screen: window.__game.project(bob.x, bob.y ?? 0, bob.z) } : null,
        interactables: st?.near ? [{ kind: st.near, prompt: st.prompt ?? null }] : [], mechanics: [],
        me: { x: r2(app.player.position.x), y: r2(app.player.position.y), z: r2(app.player.position.z), mode: app.player.mode, alive: true, holding: st?.cooler?.count ?? 0 } };
    }

    // ---- the frame: the core's own App.frame, driven by net.loop (a background host keeps the world going) ----
    let last = null, lastTakenWorld = null;
    // one frame. In play `t` is the browser's frame time; a stepped frame (gf/three/core/step.js) brings its own dt
    const frame = (t, fixed = null) => {
      const raw = fixed ? fixed.dt : last === null ? 0 : Math.max(0, (t - last) / 1000);
      const dt = Math.min(0.1, raw) || 1 / 60; if (!fixed) { last = t; meter.frame(raw); }
      app.engine.frame = (app.engine.frame ?? 0) + 1;
      const phase = session.round.phase;
      const paused = menu.paused && !session.live && ['playing', 'countdown'].includes(phase);
      // input: only in a round, with nothing over the game (a viewer never has any)
      const watching = session.watching;
      watchUi(watching);
      const on = phase === 'playing' && !ui.covered && !menu.view && !paused && !watching;
      input.enabled = on;
      app.input.enabled = on;
      for (const k of CORE_KEYS_OFF) app.input.pressed?.delete?.(k);
      if (!on) { app.input.consumeLook?.(); app.input.mouseDown = false; app.input.rightDown = false; }
      else {
        // the menu's sensitivity and invert reach the core's look (its own scale is 0.0022 a pixel)
        app.input.look.x *= input.lookScale || 1;
        app.input.look.y *= (input.lookScale || 1) * (input.invertY ? -1 : 1);
      }
      if (!paused) {
        ctx.time.now += dt; ctx.time.dt = dt;
        if (phase === 'countdown') ui.countdown(Math.max(1, Math.ceil(session.round.countdown)));
        session.tick(dt);
        // a joiner: the host's light and sea
        if (net.active && !ctx.host) {
          const w = net.shared();
          if (w?.latest && w.latest !== lastTakenWorld && w.latest.v) {
            lastTakenWorld = w.latest;
            const st = vista.look.state, L = w.latest.v;
            if (typeof L.s === 'string' && L.s !== st.sea) vista.look.set({ sea: L.s });
            if (Number.isFinite(L.h) && Math.abs(L.h - st.hour) > 0.004) vista.look.set({ hour: L.h });
          }
          // the host's island: every copy sails with it (a joiner who came in mid-trip lands there too)
          const isl = w?.latest?.isl;
          if (isl && vgame.trip && isl.i !== vgame.island()) vgame.follow(isl.i, isl.s);
        }
        const R = game.round ?? {};
        ctx.time.round = session.round.clock; ctx.time.left = Math.max(0, (R.seconds ?? 600) - session.round.clock);
      }
      friends.update(dt);
      // a viewer looks out of the streamer's eyes from this frame's poses, before the core draws it
      if (watching) watchCam.frame();
      app.frame(dt);
      friends.after();
      players.api.sync();
      if (!paused) {
        try { vhud.update(dt); } catch (e) { frameFailed('the vista HUD', e); }
        try { ctx.fair.update?.(dt); } catch (e) { frameFailed('fair play', e); }
        try { rules.update?.(ctx, dt); } catch (e) { frameFailed('rules.update', e); }
        for (const fn of ctx.onFrame) { try { fn(dt); } catch (e) { frameFailed('a ctx.onFrame function', e); } }
        // this copy's score to the host, when it changes (the host's own is already there)
        if (session.live && !ctx.host && !watching && me.score !== sentScore && phase === 'playing') { sentScore = me.score; ctx.net.send('vista-score', { score: me.score }, 'host'); }
        session.send();
      }
      ui.update(paused ? 0 : dt, { left: phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates: friends.plates(!watching && (ui.covered || !!menu.view)) });
      hud.update(paused ? 0 : dt, { phase, covered: ui.covered || paused });
      if (!watching) kitGuard.tick(performance.now() / 1000);
    };
    // stepped time: the browser's frames do nothing until step(ms) is called (the first runs one frame of no time,
    // so the menu's view is placed); otherwise the frame loop is the browser's
    let primed = false;
    if (stepped) session.loop(() => { if (!primed) { primed = true; frame(0, { dt: 1 / 60, draw: true }); } });
    else session.loop(frame);
    return ctx;
  } catch (e) {
    console.error(e);
    fatal(e);
    // a boot that throws still says so to the gates and the play-tester (runtimes/CONTRACT.md §6)
    if (!window.__game) window.__game = Object.freeze({ kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'error', ready: false, error: { message: String(e?.message ?? e).slice(0, 500) },
      snapshot: () => ({ kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'error', error: { message: String(e?.message ?? e).slice(0, 500) }, players: [] }) });
    throw e;
  }
}

/** A preview subject (?gf-show=world | look; assets.json → showcase): the island from the beach toward the pier, no
 *  menu and no players, drawn by the core's own loop. */
function showSubject(ctx, { vista, C, subject, worldCfg }) {
  const app = vista.app;
  const at = C.placeOf(worldCfg, 'beach', 0);
  app.setFreeCam(true);
  app.fly.velocity?.set?.(0, 0, 0);
  const cam = { x: at.x + 6, y: 4.5, z: at.z + 14 }, tx = 55 - cam.x, tz = 20 - cam.z;
  app.fly.setPose(new app.camera.position.constructor(cam.x, cam.y, cam.z), Math.atan2(-tx, -tz), -0.08);
  app.input.enabled = false;
  app.start();
  window.__game = Object.freeze({
    kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'show', ready: true, subject,
    snapshot: () => ({ kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'show', subject, vista: vista.observe.snapshot() }),
    coverage: () => JSON.parse(JSON.stringify(ctx.coverage())),
    slots: () => JSON.parse(JSON.stringify(ctx.slotsDrawn())),
    camera: () => ({ mode: 'show', ...vista.observe.camera() }),
    screen: () => ({ ...vista.observe.screen(), quality: QUALITY }),
    vista: Object.freeze({ look: () => JSON.parse(JSON.stringify({ state: vista.look.state, config: ctx.assets.config('look') })) }),
  });
  return ctx;
}

/** No WebGPU (CONTRACT §8 vista, PLAN §1.3): the kit's own screen with the game's link, never a blank canvas. */
function unsupported(ctx, game, gpu) {
  const title = game.text?.title ?? game.title ?? 'This game';
  const link = location.href.replace(/([?&])gf-vista-nowebgpu=1&?/, '$1').replace(/[?&]$/, '');
  noWebGPUScreen(gpu.why, { title, link, kind: gpu.kind });
  console.warn(`gf-vista: ${gpu.why}`);
  window.__game = Object.freeze({
    kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'unsupported', ready: true,
    unsupported: { reason: gpu.why, kind: gpu.kind, shown: true, link },
    snapshot: () => ({ kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'unsupported', unsupported: { reason: gpu.why, kind: gpu.kind, link }, players: [] }),
    screen: () => ({ dpr: globalThis.devicePixelRatio || 1, css: [innerWidth, innerHeight], unsupported: true }),
  });
  return ctx;
}

function fatal(e) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;padding:12px 16px;background:#3a1020;color:#fff;font:14px system-ui;border-radius:10px;z-index:1001';
  d.textContent = `The game could not start: ${e?.message ?? e}`;
  document.body.append(d);
}
