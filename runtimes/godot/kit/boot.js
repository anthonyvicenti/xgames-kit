// runtime godot: boot({rules}). A Godot game's page (main.js):
//
//   import { boot } from './gf/godot/boot.js'; import rules from './rules.js'; boot({ rules });
//
// The same shared system as every runtime, with the game's Godot export in place of a renderer the kit owns:
// the configs and slots (gf-assets: Studio's replaced files and values), the shared loading view, then the export
// (build/game.*, gf/godot/engine.js) on the kit's canvas, which says hello through its GF autoload; the boot message
// (config, the map as gf-tilemap-1 reads it, every value slot, this player); gf-audio for every sound; the shared
// UI, HUD and home menu; the round and the friends (net/session.js with gf/godot/players.js: the game draws the
// friends, the page sends the pose and reads back where each friend was drawn); rules.setup(ctx); then the page's
// frame through net.loop (the round, the net and the host's shared world keep going when Godot's frame does not).
//
// What rules.js gets beyond the shared ctx: rules.event(ctx, name, data, 'godot') for every GF.event the game sends,
// on the copy where it happened; ctx.godot.send(name, data) to the game on this copy (GF.message); ctx.godot.game()
// the game's own observation; ctx.world.marks(name) and ctx.world.spawn(seat) from the map, in metres.
// In a live round the host's copy owns the round, the scores and ctx.shared (handed to the game as GF.shared);
// every copy owns its own player.
// Bots: alone, the session seats them (players.bots, ?bots=N) and the game moves them (GfBots2D, GF.report_bot); a bot's
// GF.event_as reaches rules.event with the bot's id as `from`.
// Watch then play and voice (gf/mp): the pause menu's Go live and voice rows are the kit's; a viewer's copy has no
// player of its own and the game's camera follows the streamer (GF.watching, GF.follow; the starters do it).
// Not yet for godot (verify says so): the slot-ID pass over what Godot drew,
// loadouts on the bodies, a 3D profile example.
import * as K from './shared.js';
import KIT from './kit.js';
import { createBridge } from './bridge.js';
import { startEngine } from './engine.js';
import { createFriends, sessionPlayers } from './players.js';
import { worldFor, planFor, pngSize } from './world.js';
import { createTouchLayout } from './touch.js';

export const RUNTIME = 'godot';
export const VERSION = '0.1.0';
const PPM = { pixel: 16, drawn: 128 };
const r2 = v => Math.round(v * 100) / 100;

export async function boot({ rules = {}, base = 'build/game' } = {}) {
  const { assets, gf } = K;
  K.startLoading();
  K.listenForHost(window);
  K.listenForLoadout(window);
  const params = new URLSearchParams(location.search);
  const ctx = { kit: { name: 'xgames-kit', runtime: RUNTIME, version: VERSION, shared: KIT.shared }, onFrame: [], time: { now: 0, dt: 0, round: 0, left: 0 }, gf };
  const prints = [], printErrors = [];
  let ui = null;
  try {
    await assets.init({ configs: ['game', 'look', 'world', 'characters'] });
    const game = assets.config('game'), lookCfg = assets.config('look'), worldCfg = assets.config('world');
    ctx.config = game; ctx.assets = assets;
    document.title = game.text?.title ?? game.title ?? document.title;
    for (const s of assets.manifest?.slots ?? []) {
      if (!s.css || s.source?.pointer === undefined) continue;
      let v; try { v = assets.value(s.id, null); } catch { v = null; }
      if (v != null && typeof v !== 'object') document.documentElement.style.setProperty(s.css, s.type === 'text' ? JSON.stringify(String(v)) : String(v));
    }
    const seed = K.seedOf(params.get('seed') ?? K.net.seed ?? params.get('gf_seed') ?? (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 1));
    const rng = K.createRng(seed);
    ctx.rng = rng.fork('rules'); ctx.seed = seed;
    rules = K.seedRules(rules, rng.fork('rules:Math.random'));
    const gameId = assets.manifest?.game ?? 'game';

    // ---- the map (gf-tilemap-1, the slot world.map), read once by the kit's own reader ----
    const M = K.readMap(assets.value('world.map', worldCfg.map));
    if (!M.ok) console.warn(`gf-godot: the map has problems: ${M.problems.join('; ')}`);
    const W = worldFor(M);
    const place3 = s => (game.profile === '3d' ? { x: s.x, y: 0, z: s.z ?? 0 } : { x: s.x, y: s.y, z: 0 });
    ctx.world = { ...worldCfg, map: M, spawns: W.spawns.map(s => { const p = place3(s); return [p.x, p.y, p.z]; }), spawn: i => (W.spawns.length ? place3(W.spawns[((i % W.spawns.length) + W.spawns.length) % W.spawns.length]) : null), marks: name => (W.marks[name] ?? []).map(place3) };
    const style = lookCfg.style === 'drawn' ? 'drawn' : 'pixel';
    // profile 3d: metres in Godot's own axes on the same map seen from above (a place is (x, 0, z)); 2d: the plane's
    const PROFILE = game.profile === '3d' ? '3d' : '2d', is3d = PROFILE === '3d';
    const CAMERA = is3d ? (game.camera ?? 'follow') : M.plane === 'top' ? 'top' : 'side';

    // ---- the canvas and the bridge, then the export ----
    let app = document.getElementById('app');
    if (!app) { app = document.createElement('div'); app.id = 'app'; app.style.cssText = 'position:fixed;inset:0'; document.body.prepend(app); }
    const canvas = document.createElement('canvas');
    canvas.id = 'gf-canvas'; canvas.tabIndex = 0;
    canvas.style.cssText = 'display:block;position:absolute;inset:0;width:100%;height:100%;outline:none';
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    app.append(canvas);
    const bridge = createBridge({
      read: async id => { const path = assets.has(id) ? assets.file(id) : id; return { path, buf: await gf.bytes(path) }; },
      onSound: (id, o) => ctx.audio?.play(id, o),
      // GF.panel(kind, opts): the kit's panels (ui.panels, CONTRACT §6j) for the game's GDScript; a modal one covers
      // the game and takes the player's input, as it does on every runtime. Callbacks come back as panel events.
      onPanel: (kind, o, emit) => {
        const fn = ui?.panels?.[kind];
        if (typeof fn !== 'function' || !['choice', 'shop', 'inventory', 'dialogue', 'input'].includes(kind)) { console.warn(`gf-godot: GF.panel("${kind}"): no such panel (choice, shop, inventory, dialogue, input)`); return null; }
        return fn.call(ui.panels, { ...o, onPick: r => emit('pick', r), onChoose: r => emit('choose', r), onSelect: r => emit('select', r), onAction: r => emit('action', r) });
      },
      onError: (what, e) => console.warn(`gf-godot bridge: ${what}: ${e?.message ?? e}`),
    });
    ctx.bridge = bridge;
    const started = await startEngine({
      base, canvas,
      onPrint: (...a) => { prints.push(a.join(' ')); if (prints.length > 200) prints.shift(); },
      onPrintError: (...a) => {
        const line = a.join(' ');
        printErrors.push(line); if (printErrors.length > 200) printErrors.shift();
        // Godot's own errors and the game's script errors reach the console as errors (gate B counts them)
        if (/^(SCRIPT ERROR|ERROR|USER ERROR)/.test(line)) console.error(`godot: ${line}`); else console.warn(`godot: ${line}`);
      },
    });
    if (!started.ok) return unsupported(ctx, game, started.missing);
    const engine = started.engine;
    const hello = await Promise.race([bridge.hello, new Promise(r => setTimeout(() => r(null), 30000))]);
    if (!hello) throw new Error('the game started but its GF autoload never said hello (project.godot → [autoload] GF="*res://addons/gf/gf.gd")');

    // ---- the event log (window.__game.events): the game's events, the sounds started, the scores that changed ----
    const LOG = { entries: [], next: 0, dropped: 0, plays: {}, refusedSounds: {} };
    const logEvent = (k, name, who = null, extra = {}) => {
      LOG.entries.push({ i: LOG.next++, t: r2(ctx.time.now), w: Math.round(performance.now()), ph: ctx.round?.phase ?? 'lobby', k, part: 'godot', name, who, ...extra });
      if (LOG.entries.length > 2000) { LOG.entries.shift(); LOG.dropped++; }
    };
    // ---- audio: gf-audio for every sound (the game's GF.sound, the kit's own) ----
    const soundList = await gf.sounds();
    const audio = K.createAudio(soundList, { presets: K.audioPresets.presets, storageKey: `gf-godot-${gameId}`, listen: true, fileUrl: gf.url });
    ctx.audio = {
      raw: audio,
      play(id, opts = {}) {
        const o = { ...opts }; delete o.at;
        if (!audio.has(id)) { LOG.refusedSounds.unlisted = (LOG.refusedSounds.unlisted ?? 0) + 1; if (!o.optional) K.refusals.refuse('sound-unlisted', `GF.sound("${id}") / ctx.audio.play("${id}"): no sound with that id in assets.json → sounds → sounds (list it there, or pass { optional: true })`, id); return null; }
        LOG.plays[id] = (LOG.plays[id] ?? 0) + 1; logEvent('sound', id, ctx.me?.id ?? null);
        return audio.play(id, o);
      },
      has: id => audio.has(id), stop: id => audio.stop(id),
    };

    // ---- the shared UI, HUD and menu over the canvas ----
    // the kit's input over the canvas, for touch: the stick (left half) and the HUD's buttons are handed to the game as
    // its actions (bridge 'pad': GF presses move_*, jump and act); keys go to Godot directly. The cursor stays free
    // (a click never takes the pointer lock).
    const input = K.createInput(canvas);
    input.cursorMode = true; input.enabled = false;
    ctx.input = input;
    let lastPad = '';
    ui = K.createUI(ctx, { text: game.text ?? {}, controls: game.controls ?? {}, theme: null });
    ctx.ui = ui;
    let menu = null;
    const openPause = () => { if (!menu || menu.view || !['playing', 'countdown'].includes(ctx.round?.phase)) return; menu.pause(); };
    const hud = K.createHud(ctx, ui, { onMenu: () => openPause() });
    // a phone: the move stick always in sight, only the actions the game has, the HUD laid out to fit (gf/godot/touch.js)
    const phone = createTouchLayout({ ui, input, controls: game.controls ?? {} });
    ctx.hud = K.readOnlyView(hud, ['goalText', 'observe', 'fullscreen'], 'ctx.hud'); ui.goalTo = t => { if (K.refusals.goalCall(t)) hud.goal(t); };
    hud.setGoal(K.refusals.startGoal(game));
    ctx.mechanics = { get: () => null, list: () => [] };
    ctx.mechanicsList = [];
    ctx.aimed = false;

    // ---- the round and the friends ----
    const friends = createFriends({ bridge, net: K.net, ctx, canvas });
    const players = { api: null };
    const place = (seat = 0, pos = null) => { const at = pos ?? ctx.world.spawn(seat) ?? { x: 0, y: 0 }; bridge.send({ k: 'place', x: at.x, y: at.y, z: at.z ?? 0 }); };
    // bots fill the empty seats when playing alone (players.bots, or ?bots=N); a friends round has none (the session's rule)
    const botParam = params.get('bots'), maxPlayers = game.players?.max ?? 4;
    const botCount = botParam !== null ? Math.max(0, Math.min(7, Number(botParam) || 0)) : game.players?.bots === false ? 0 : maxPlayers - 1;
    const session = K.createSession(ctx, { rules, spawnCharacter: null, characterFor: () => ({}), rng, botCount, onPhase: ph => onPhase(ph),
      createPlayers: c => (players.api = sessionPlayers(c, friends, { bridge, place })), engineWorld: null, flow: null });
    ctx.round = {
      get phase() { return session.round.phase; }, get number() { return session.round.number; },
      get winners() { return session.round.winners; }, get reason() { return session.round.reason; },
      end: (reason = 'ended', winners = null) => session.end(reason, winners),
    };
    ctx.fair = K.createFair(ctx);
    await session.start();
    const me = ctx.me;
    me.actions = { primary: { down: false, pressed: false }, secondary: { down: false, pressed: false }, interact: { down: false, pressed: false }, jump: { down: false, pressed: false } };
    ctx.godot = {
      /** To the game on this copy: GF.message(name, data). */
      send: (name, data = {}) => bridge.send({ k: 'send', name: String(name), data }),
      /** The game's own observation (GF.observe), as of its last frame. */
      game: () => bridge.latest.game ?? null,
      engine,
    };

    // ---- the boot message: what GF.boot() waits for ----
    // seen from above: the field as three's flat-2d draws it (soft edges, dressing, set pieces), planned here from the
    // map and the pictures the game has (each picture's size from its file), drawn by GfTilemap2D
    if (M.plane === 'top' && !is3d && M.ok !== false) {
      const has = id => { try { return assets.has(id); } catch { return false; } };
      const kinds = Object.keys(M.kinds ?? {}), art = { tiles: new Set(), edges: new Set(), dress: new Set(), sizes: {}, ppm: PPM[style] };
      for (const k of kinds) for (const [set, id] of [['tiles', `world.tiles.${k}`], ['edges', `world.edges.${k}`], ['dress', `world.dress.${k}`]]) {
        if (!has(id)) continue;
        art[set].add(k);
        try { const s = pngSize(new Uint8Array(await gf.bytes(assets.file(id)))); if (s) art.sizes[id] = s; } catch {}
      }
      W.plan = planFor(M, K.drawPlan, art);
    }
    const values = {}, slots = {};
    for (const s of assets.manifest?.slots ?? []) {
      if (s.source?.pointer !== undefined) { try { values[s.id] = assets.value(s.id, null); } catch { values[s.id] = null; } }
      else if (s.source?.file) slots[s.id] = { type: s.type, file: s.source.file };
    }
    bridge.set('boot', { profile: PROFILE, style, ppm: PPM[style], config: { game, look: lookCfg, world: worldCfg, characters: assets.config('characters') }, world: W, values, slots, me: { id: me.id, name: me.name, color: me.color, seat: me.seat }, host: ctx.host });
    // a value slot changed while the game runs (the studio page, kit/core/live-slots.js): the game hears it at once
    assets.onValue((id, value) => bridge.send({ k: 'value', id, value }));
    K.listenForSlots(ctx, { net: K.net.active ? K.net : null });

    const kitGuard = K.watchKit({ layer: ui.root, items: () => [{ el: ui.root, name: "the kit's layer (#gf-ui)", want: true }, ...hud.kitItems(), ...(menu?.kitItems() ?? [])] });
    if (params.get('gf-ui') === '0') kitGuard.off = true;
    try { await rules.setup?.(ctx); } catch (e) { console.error(e); K.setupFailed('rules', e); throw e; }

    function onPhase(ph) {
      bridge.set('phase', ph);
      if (ph === 'countdown') { menu?.close(); ctx.audio.play('round-countdown', { optional: true }); }
      if (ph === 'playing') {
        ui.cover('results', false); ui.hideCard(); if (menu?.view && !menu.paused) menu.close();
        place(ctx.me?.seat ?? 0);
        ui.banner(game.text?.go ?? 'Go!', 1.2); ctx.audio.play('round-go', { optional: true });
        try { canvas.focus({ preventScroll: true }); } catch {}
      }
      if (ph === 'lobby') { ui.hideCard(); if (!session.live) menu?.home(); }
      if (ph === 'results') {
        menu?.close();
        const w = session.round.winners ?? [];
        if (session.live) { ui.cover('results', true); ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true }); return; }
        const T2 = game.text ?? {};
        const wonNames = w.map(id => ctx.players.get(id)?.name ?? id);
        const meOnly = w.length === 1 && w[0] === ctx.me?.id;
        const title = !w.length ? (T2.draw ?? 'Round over: nobody scored') : meOnly ? (T2.youWin ?? 'You win!') : (T2.wins ?? '{name} wins!').replace('{name}', wonNames.join(' & '));
        ui.results({ title, rows: session.round.rows ?? [], winners: w,
          onAgain: game.round?.replay === false ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.replay(); },
          onMenu: () => { ctx.audio.play('ui-click', { optional: true }); session.toLobby(); } });
        ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true });
      }
    }
    bridge.set('phase', session.round.phase);
    const friendsPage = () => new URL('gf/mp/index.html', location.href).href;
    menu = K.createMenu(ctx, ui, {
      game, live: session.live, world: false, gameId, host: K.pageHost, players: () => ctx.players.list(),
      onPlay: () => { if (session.round.phase === 'lobby') { ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); } },
      onFriends: () => { if (K.pageHost.present && K.pageHost.offers.friends) K.pageHost.friends(); else location.href = friendsPage(); },
      onResume: () => { menu.close(); try { canvas.focus({ preventScroll: true }); } catch {} },
      onLeave: () => { menu.close(); session.toLobby(); },
      onQuality: () => { if (!session.live) location.reload(); },
      room: session.live ? { info: () => K.net.room, leave: () => { menu.close(); K.net.leave(); }, end: () => { menu.close(); session.end('ended', null, true); },
        // watch then play (gf-multiplayer 1.6.0+): Go live from the pause menu, and the stream's state while it is on
        live: () => K.net.live ?? null, goLive: () => { menu.close(); K.net.live?.start?.(); }, showLive: () => { menu.close(); K.net.live?.share?.(); },
        // voice chat on Studio's play page (gf-multiplayer 1.7.4): the row opens Studio's voice panel over the game
        voice: () => K.net.live?.voice ?? null, voiceOpen: () => K.net.live?.voiceOpen?.(), voiceClose: () => K.net.live?.voiceClose?.() } : null,
    });
    if (session.live) K.net.live?.onChange?.(() => menu.redraw?.());
    // a viewer (watch then play) keeps what everyone in the round sees (the clock, the scores, the banner, the goal),
    // never a player's own card, prompts or menu
    const watchStyle = document.createElement('style');
    watchStyle.textContent = '#gf-ui.gf-watching > :not(.gf-plates):not(.gf-bars):not(.gf-fsbtn):not(.gf-top):not(.gf-scores):not(.gf-banner):not(.gf-goal):not(.gf-bossbar){display:none !important}';
    document.head.append(watchStyle);
    ctx.menu = K.readOnlyView(menu, ['view', 'paused', 'observe'], 'ctx.menu');
    if (params.get('gf-ui') === '0') ui.root.style.display = 'none';
    if (session.live) { ui.waiting(); session.arm(); session.ready(); }
    else if (params.get('gf-autoplay') === '1') session.beginCountdown();
    else menu.home();

    // ---- keys: the kit's own (Enter plays, Esc pauses). Godot's canvas marks every key it hears as handled
    // (preventDefault) but lets it reach the window, so these read the key whatever has focus; registered after the
    // menu's own Esc (which closes a view), so one Esc never opens and closes the pause menu at once. While the kit
    // holds input the canvas loses focus and GF takes every action's keys out of the game's input map
    // (addons/gf/gf.gd), so nothing the player presses over a menu, a countdown or the results moves them ----
    let inputOn = null, escFrom = null;
    // what was open when Esc went down, before the menu's own Esc closes it (Godot marks every key handled, so
    // e.defaultPrevented cannot say whether the menu took it)
    addEventListener('keydown', e => { if (e.code === 'Escape') escFrom = menu.view ?? null; }, true);
    addEventListener('keydown', e => {
      if (session.watching) return;
      const a = document.activeElement, onControl = a && (a.tagName === 'BUTTON' || a.tagName === 'INPUT');
      if ((e.code === 'Enter' || e.code === 'Space') && !onControl && session.round.phase === 'lobby' && menu.view === 'home') { if (!K.refusedPress(e, 'Play (Enter)')) { e.preventDefault(); menu.close(); ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); } }
      else if (e.code === 'Escape' && !escFrom && !menu.view && ['playing', 'countdown'].includes(session.round.phase)) { e.preventDefault(); openPause(); }
    });
    canvas.addEventListener('pointerdown', () => { if (inputOn) canvas.focus({ preventScroll: true }); });

    // ---- the observation (window.__game, runtimes/CONTRACT.md §6): the shared names, and the game's own under godot ----
    const notYet = what => ({ ok: false, notYet: `not yet for godot: ${what}` });
    const view = () => bridge.latest.view ?? null;
    /** Metres (y up, the kit's units) to CSS pixels on this screen, from the game's camera as of its last frame. */
    const toScreen = (x, y, z = 0) => {
      const v = view(), r = canvas.getBoundingClientRect();
      if (is3d) {
        // the game's Camera3D: its place, its axes (the basis' columns) and its vertical field of view
        if (!v?.eye) return { x: -1, y: -1, front: false };
        const d = [x - v.eye[0], y - v.eye[1], z - v.eye[2]], dot = a => a[0] * d[0] + a[1] * d[1] + a[2] * d[2];
        const cx = dot(v.x), cy = dot(v.y), cz = -dot(v.z);
        if (cz <= 0.01) return { x: -1, y: -1, front: false };
        const f = 1 / Math.tan((v.fov * Math.PI / 180) / 2), s = r.height / 2;
        return { x: r2(r.left + r.width / 2 + (cx / cz) * f * s), y: r2(r.top + r.height / 2 - (cy / cz) * f * s), front: true };
      }
      if (!v || !Number.isFinite(v.cx)) return { x: -1, y: -1, front: false };
      const k = PPM[style] * (v.zoom ?? 1) * (r.width / (v.w || r.width));
      return { x: r2(r.left + r.width / 2 + (x - v.cx) * k), y: r2(r.top + r.height / 2 - (y - v.cy) * k), front: true };
    };
    const observe = () => ({
      kit: 'xgames-kit', runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: session.round.phase, round: session.round.number, seed, quality: 'standard',
      time: { now: r2(ctx.time.now), round: r2(ctx.time.round), left: r2(ctx.time.left) },
      me: me.id, host: ctx.host, live: session.live, backdrop: params.get('gf-backdrop') === '1', view: menu.view ?? ui.view, paused: menu.paused && !session.live,
      players: ctx.players.list().map(p => ({ id: p.id, name: p.name, score: p.score, alive: p.alive, bot: !!p.isBot, local: p.local, x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), anim: p.anim, color: p.color, seat: p.seat, control: true, down: false, protected: false, pl: null, drawn: !!p.drawn, onScreen: !!p.onScreen })),
      fair: null,
      refusals: K.refusals.list(),
      winners: session.round.winners, reason: session.round.reason, results: session.round.rows,
      shared: ctx.shared.snapshot(),
      rules: (() => { try { return rules.observe?.(ctx) ?? null; } catch { return null; } })(),
      modules: { mechanics: [] },
      net: session.gateBlock(ui.covered),
      watch: session.watching ? { follow: session.watch?.follow ?? null, live: !!session.watch?.live, target: bridge.latest.watch?.target ?? null, camera: CAMERA } : null,
      world: { template: worldCfg.template, plane: M.plane, cols: M.cols, rows: M.rows, ok: M.ok },
      godot: {
        addon: bridge.addon, godot: bridge.addon?.godot ?? null, style, ppm: PPM[style], background: (() => { try { return assets.value('look.background', null); } catch { return null; } })(), frames: bridge.frames, pulls: bridge.pulls, fps, input: inputOn,
        me: bridge.latest.me ?? null, view: view(), friends: friends.list(), game: bridge.latest.game ?? null, panel: bridge.latest.panel ?? null,
        files: bridge.handed(), errors: printErrors.filter(l => /^(SCRIPT ERROR|ERROR|USER ERROR)/.test(l)).slice(-20),
      },
    });
    const copy = v => JSON.parse(JSON.stringify(v));
    window.__game = Object.freeze({
      kit: 'xgames-kit', runtime: RUNTIME, profile: PROFILE, version: VERSION, seed, quality: 'standard',
      get phase() { return session.round.phase; },
      get ready() { return bridge.frames > 0 && !!bridge.latest.me; },
      get players() { return observe().players; },
      snapshot: () => copy(observe()),
      // GAP: Godot draws into its own canvas, so there is no list of drawables with their slots yet; the picture slots
      // the game read are slots() and snapshot().godot.files
      coverage: () => notYet('the slot-ID pass over what Godot drew (measure 4); the picture slots the game read are in slots()'),
      slots: () => copy(Object.fromEntries(bridge.handed().map(f => [f.id, { drawables: null, triangles: null, onScreen: null, read: true, path: f.path, bytes: f.bytes, hash: f.hash }]))),
      sight: async () => notYet('the slot-ID pass (measure 15)'),
      project: (x, y, z = 0) => toScreen(x, y, z),
      camera: () => { const v = view() ?? {}; return copy({ mode: CAMERA, yaw: 0, pitch: 0, eye: is3d ? v.eye ?? [0, 0, 0] : [v.cx ?? 0, v.cy ?? 0, 0], dir: is3d && v.z ? v.z.map(c => -c) : [0, 0, -1], fov: is3d ? v.fov ?? null : null, zoom: v.zoom ?? null, sensitivity: input.lookScale, lookScale: input.lookScale, invertY: input.invertY, cursorMode: 'free', locked: false, lockRefused: false, following: true, fullscreen: hud.fullscreen?.() ?? null }); },
      controls: () => { const m = bridge.latest.me ?? null; return copy({ camera: CAMERA, crosshair: false, controls: game.controls ?? {}, keys: { move_left: ['KeyA', 'ArrowLeft'], move_right: ['KeyD', 'ArrowRight'], move_up: ['KeyW', 'ArrowUp'], move_down: ['KeyS', 'ArrowDown'], jump: ['Space'], act: ['KeyE', 'KeyF'] }, prompt: ui.promptText, viewport: { w: innerWidth, h: innerHeight }, aim: null, landing: null, interactables: [], mechanics: [], me: m ? { x: m.x, y: m.y, z: m.z ?? 0, alive: true, holding: null } : null }); },
      screen: () => ({ dpr: globalThis.devicePixelRatio || 1, css: [innerWidth, innerHeight], buffer: [canvas.width, canvas.height], ratio: r2(canvas.width / Math.max(1, canvas.clientWidth)), budget: null, quality: 'standard', fps, frameMs: fps ? r2(1000 / fps) : null, api: 'webgl2', gpu: null }),
      menu: () => copy(menu.observe()),
      hud: () => copy({ phase: session.round.phase, covered: ui.covered, ...hud.observe() }),
      looks: () => copy({ me: me.id, slots: assets.playerLooks(), players: ctx.players.list().map(p => ({ id: p.id, name: p.name, local: p.local, seat: p.seat, color: p.color, drawn: p.local ? 'self' : (friends.drawn(p.id) ? (is3d ? 'gf-humanoid-1' : 'gf-flat-1') : null) })) }),
      events: ({ since = 0 } = {}) => copy({ entries: LOG.entries.filter(e => e.i >= since), next: LOG.next, dropped: LOG.dropped, kinds: ['event', 'sound', 'score'], me: me.id }),
      sounds: () => copy({ plays: LOG.plays, dropped: LOG.refusedSounds }),
      panels: () => copy(ui.panels.observe()),      // the shared panels (CONTRACT §6j), opened by rules.js or GF.panel
      godot: Object.freeze({
        latest: () => copy(bridge.latest),
        project: id => copy(friends.project(id)),
        prints: () => prints.slice(-50),
        errors: () => printErrors.slice(-50),
        tags: on => { friends.tags(!!on); return !!on; },
      }),
    });

    // ---- the frame: the page's, through net.loop; the game's own frame runs beside it and meets it in the bridge ----
    let last = null, lastShared = '', lastHost = ctx.host, lastPaused = false, lastWatch = { on: false, follow: null };
    const scores = new Map();
    let fps = null, fpsFrames = 0, fpsAt = performance.now();
    session.loop(t => {
      const raw = last === null ? 0 : Math.max(0, (t - last) / 1000);
      if (performance.now() - fpsAt >= 1000) { fps = Math.round((bridge.frames - fpsFrames) * 1000 / (performance.now() - fpsAt)); fpsFrames = bridge.frames; fpsAt = performance.now(); }
      const dt = Math.min(0.1, raw) || 1 / 60; last = t;
      const phase = session.round.phase;
      const paused = menu.paused && !session.live && ['playing', 'countdown'].includes(phase);
      const on = phase === 'playing' && !ui.covered && !menu.view && !paused && !session.watching;
      if (on !== inputOn) {
        inputOn = on; input.enabled = on; bridge.set('input', on);
        try { if (on) canvas.focus({ preventScroll: true }); else if (document.activeElement === canvas) canvas.blur(); } catch {}
      }
      if (ctx.host !== lastHost) { lastHost = ctx.host; bridge.set('host', ctx.host); }
      // watch then play: a viewer's copy has no player of its own; the game follows the streamer (GF.watching, GF.follow)
      const w = session.watching, follow = w ? session.watch?.follow?.id ?? null : null;
      if (w !== lastWatch.on || follow !== lastWatch.follow) {
        lastWatch = { on: w, follow }; bridge.set('watch', { on: w, follow });
        ui.root.classList.toggle('gf-watching', w);
        canvas.style.pointerEvents = w ? 'none' : '';
      }
      // alone, the pause menu pauses the game's scene tree too (bots, falling bodies, the game's own timers)
      if (paused !== lastPaused) { lastPaused = paused; bridge.set('paused', paused); }
      for (const ev of bridge.takeEvents()) {
        if (!ev || typeof ev.n !== 'string') continue;
        // a bot's event (GF.event_as) comes from that bot's id, as a friend's from theirs; this player's from 'godot'
        const who = typeof ev.w === 'string' && ctx.players.get(ev.w)?.isBot ? ev.w : null;
        logEvent('event', ev.n, who ?? me.id, { data: ev.d ?? {} });
        try { rules.event?.(ctx, ev.n, ev.d ?? {}, who ?? 'godot'); } catch (e) { K.frameFailed(`rules.event (${ev.n})`, e); }
      }
      if (!paused) {
        ctx.time.now += dt; ctx.time.dt = dt;
        if (phase === 'countdown') ui.countdown(Math.max(1, Math.ceil(session.round.countdown)));
        session.tick(dt);
        const R = game.round ?? {};
        ctx.time.round = session.round.clock; ctx.time.left = Math.max(0, (R.seconds ?? 60) - session.round.clock);
      }
      input.update();
      if (input.touch) {
        const pad = on ? { x: r2(input.move.x), y: r2(input.move.y), jump: input.actions.jump.down, act: input.actions.primary.down || input.actions.interact.down } : { x: 0, y: 0, jump: false, act: false };
        const k = JSON.stringify(pad);
        if (k !== lastPad) { lastPad = k; bridge.set('pad', pad); }
      }
      friends.update();
      players.api.sync();
      for (const p of ctx.players.list()) { if (scores.get(p.id) !== p.score) { if (scores.has(p.id)) logEvent('score', 'score', p.id, { value: p.score, was: scores.get(p.id) }); scores.set(p.id, p.score); } }
      const sh = JSON.stringify(ctx.shared.snapshot());
      if (sh !== lastShared) { lastShared = sh; bridge.set('shared', JSON.parse(sh)); }
      if (!paused) {
        try { ctx.fair.update?.(dt); } catch (e) { K.frameFailed('fair play', e); }
        try { rules.update?.(ctx, dt); } catch (e) { K.frameFailed('rules.update', e); }
        for (const fn of ctx.onFrame) { try { fn(dt); } catch (e) { K.frameFailed('a ctx.onFrame function', e); } }
        session.send();
      }
      ui.update(paused ? 0 : dt, { left: phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates: [] });
      hud.update(paused ? 0 : dt, { phase, covered: ui.covered || paused });
      phone.update();
      if (!session.watching) kitGuard.tick(performance.now() / 1000);
    });
    return ctx;
  } catch (e) {
    console.error(e);
    fatal(e);
    if (!window.__game) window.__game = Object.freeze({ kit: 'xgames-kit', runtime: RUNTIME, profile: null, version: VERSION, phase: 'error', ready: false, error: { message: String(e?.message ?? e) } });
    throw e;
  }
}

/** No WebGL2 or WebAssembly: the kit's own screen with the game's link, never a blank canvas. */
function unsupported(ctx, game, missing) {
  const title = game.text?.title ?? game.title ?? 'This game';
  const d = document.createElement('div');
  d.id = 'gf-unsupported';
  d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0e18;color:#fff;font:16px/1.45 system-ui,sans-serif;padding:24px;text-align:center';
  d.innerHTML = `<div style="max-width:440px"><h1 style="font-size:26px;margin:0 0 10px"></h1><p style="margin:0 0 14px;opacity:.9">This game needs a browser with WebGL 2 and WebAssembly. Open this link in a current Chrome, Edge, Firefox or Safari:</p><p style="word-break:break-all"><a style="color:#9cf"></a></p></div>`;
  d.querySelector('h1').textContent = title;
  const a = d.querySelector('a'); a.href = location.href; a.textContent = location.href;
  document.body.append(d);
  console.warn(`gf-godot: this browser lacks ${missing.join(', ')}`);
  window.__game = Object.freeze({
    kit: 'xgames-kit', runtime: RUNTIME, profile: '2d', version: VERSION, phase: 'unsupported', ready: true,
    unsupported: { reason: missing.join(', '), kind: 'webgl2', shown: true, link: location.href },
    snapshot: () => ({ kit: 'xgames-kit', runtime: RUNTIME, profile: '2d', version: VERSION, phase: 'unsupported', unsupported: { reason: missing.join(', ') }, players: [] }),
  });
  return ctx;
}

function fatal(e) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;padding:12px 16px;background:#3a1020;color:#fff;font:14px system-ui;border-radius:10px;z-index:1001';
  d.textContent = `The game could not start: ${e?.message ?? e}`;
  document.body.append(d);
}
