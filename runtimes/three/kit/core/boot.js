// gf-three core: boot({rules}) — everything a game needs around its rules.js (CONTRACT §3).
//
//   import { boot } from './gf/three/core/boot.js'; import rules from './rules.js'; boot({ rules });
//
// Order: configs and assets.json → quality tier → renderer and look → Rapier → world → audio → UI → mechanics →
// players (and bots) → rules.setup(ctx) → the home menu (alone: kit/ui/menu.js) or net.ready() (live) → the frame loop
// through net.loop,
// which never pauses. Real modules (look, world, character, mechanics) are used when gf/three/kit.js lists them;
// until tracks L, C and K2 land, the stand-ins in core/standins/ take their place.
// Profiles (CONTRACT §8): kit.js `runtime` is 'three' and `profile` is 'standard-3d' (this kit's own look and world),
// 'scenic-3d' (the scenic look and world, vendored beside this copy as gf/scenic/) or 'flat-2d' (kit.js modules.flat: the
// flat look, world, bodies and controller); everything else is this kit's, whichever the profile.
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import * as gf from '../../gf-assets.js';
import { createAudio } from '../../../audio/audio.js';
import audioPresets from '../../../audio/presets.json' with { type: 'json' };
import KIT from '../kit.js';
import { assets } from '../assets/assets.js';
import { createRng, seedOf } from './rng.js';
import { pickQuality, deviceFacts, drawsOnCard } from './quality.js';
import { pixelRatioFor, watchPixelRatio, createGovernor, PIXEL_BUDGET } from './resolution.js';
import { createInput } from './input.js';
import { runShow } from './show.js';
import { createUI } from '../ui/ui.js';
import { applyKindHud } from '../ui/kind-hud.js';
import { createHud } from '../ui/hud.js';
import { createMenu, loadSettings } from '../ui/menu.js';
import { listenForHost, host } from '../net/host.js';
import { createSession, seatPalette } from '../net/session.js';
import { createPlayers } from '../net/players.js';
import { listenForLoadout, pageLoadout, onPageLoadout } from '../net/looks.js';
import { listenForSlots } from './live-slots.js';
import { createBrain, createBots, defaultBot } from '../bots/bots.js';
import { createFair } from './fair.js';
import { rayCylinder, BODY_RADIUS } from './aim.js';
import { sight } from './sight.js';
import * as refusals from './refusals.js';
import { seedRules, guardCamera, readOnlyView, refusedPress, watchKit, setupFailed, frameFailed } from './guard.js';
import { net } from '../../mp/net.js';
import { createPresence } from '../../mp/presence.js';
import { createPresenceView } from '../ui/presence.js';
import { RIG_DEFAULTS } from '../controller/camera-rig.js';
import { AIM_HEIGHT } from './aim.js';
import { stepAsked, createStepper, fixedCameraPlace } from './step.js';
import { createEventLog } from './events.js';

export const VERSION = KIT.version;
const H = 1 / 60;

export const RUNTIME = KIT.runtime ?? 'three';
export const PROFILE = KIT.profile ?? 'standard-3d';

async function loadModules(worldCfg = {}, used = null) {
  const m = KIT.modules ?? {};
  const scenic = PROFILE === 'scenic-3d';
  // a voxel world (CONTRACT §9, worlds) is its own world module, whichever profile draws the rest
  const voxel = worldCfg?.template === 'voxel';
  // a flat (2D) game (kit.js modules.flat: 'top' | 'side') takes the flat look, world and body, and brings its own
  // controller (kit/flat/): everything else is this kit's, as for a 3D game
  const flat = m.flat ?? null;
  const [look, world, character, controller] = await Promise.all([
    flat ? import('../flat/look.js') : scenic ? import('../../scenic/look/look.js') : m.look ? import('../look/look.js') : import('./standins/look.js'),
    flat ? import('../flat/world.js') : voxel ? import('../world/voxel/world.js') : scenic ? import('../../scenic/world/world.js') : m.world ? import('../world/world.js') : import('./standins/world.js'),
    flat ? import('../flat/character.js') : m.character ? import('../character/character.js') : import('./standins/character.js'),
    flat ? import('../flat/controller.js') : null,
  ]);
  const mechanics = new Map();
  // only the mechanics this game uses (kit.js lists every one the kit carries; a phone in a post loads less)
  for (const id of m.mechanics ?? []) if (!used || used.has(id)) mechanics.set(id, await import(`../mechanics/${id}/index.js`));
  return { look, world, character, controller, flat, mechanics, runtime: RUNTIME, profile: PROFILE, voxel, standins: { look: !flat && !scenic && !m.look, world: !flat && !scenic && !voxel && !m.world, character: !flat && !m.character } };
}

export async function boot({ rules = {} } = {}) {
  listenForHost(window);           // the page hosting the game: wallet, items, friends (CONTRACT §6g)
  listenForLoadout(window);        // the page's loadout for this player (CONTRACT §6e): listen before anything loads
  const params = new URLSearchParams(location.search);
  const calm = Number(params.get('gf-calm') ?? 0) || 0;   // QA only (verify's walk test); never set in real play
  const subject = params.get('gf-show');
  // the friends lobby's backdrop (multiplayer.json live.backdrop, gf-multiplayer 1.4.0): this game's world behind the
  // waiting room, the camera circling a character; silent, no menu or HUD, no bots, nothing saved. Never in a round.
  const backdrop = params.get('gf-backdrop') === '1' && !net.active;
  const ctx = { THREE, kit: { name: 'gf-three', runtime: RUNTIME, profile: PROFILE, version: VERSION }, onFrame: [], time: { now: 0, dt: 0, round: 0, left: 0 } };
  let ui = null;
  try {
    await assets.init({ configs: ['game', 'look', 'world', 'characters'] });
    // A backdrop is decoration, and on a machine that draws on its processor (no graphics card: a virtual machine, a
    // remote desktop, a CI runner) it is left out: the host's page and a friend's each drawing the world in software
    // took both processors of such a machine, the pages stopped answering, and the friend's join ran into the kit's
    // 20 s limit ("Could not connect to the host"; the first CI runs of gamesfun-kit, 2026-10-11, on Linux and
    // Windows runners; without the backdrop the same join took 1.6 s). The lobby keeps its seat colours and stands on
    // the party page's own background. Nothing of a round is touched: a round is never a backdrop.
    if (backdrop && !drawsOnCard()) {
      net.describe?.({ colors: seatPalette(assets).slice(0, 8).map(String) });
      document.documentElement.dataset.gfBackdrop = 'off';
      return;
    }
    // the prop catalog belongs to a layout world; a voxel world (CONTRACT §9) has none, so it is never asked for
    if (KIT.modules?.world && assets.config('world')?.template !== 'voxel') await assets.addConfig('props');
    const game = assets.config('game'), lookCfg = assets.config('look'), charsCfg = assets.config('characters');
    ctx.config = game; ctx.assets = assets;
    // fair play (CONTRACT §6c): kit-owned and on by default; mechanics, players and bots ask it before a hit counts
    ctx.fair = createFair(ctx);
    ctx.bots = createBots(ctx);
    document.title = game.text?.title ?? game.title ?? document.title;
    await gf.applyCss();
    // the look's palette, when it has one, owns the accent colour (one slot per idea)
    if (lookCfg.palette?.accent) document.documentElement.style.setProperty('--gf-accent', lookCfg.palette.accent);
    const mods = await loadModules(assets.config('world'), new Set((game.mechanics ?? []).map(x => x.id)));
    // a world (CONTRACT §9): no rounds; players drop in and out; the world is saved on the play host
    const worldMode = game.round?.mode === 'world';
    ctx.modules = mods;

    // ---- seed, quality, renderer, scene, camera ----
    const seed = seedOf(params.get('seed') ?? net.seed ?? params.get('gf_seed') ?? (globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 1));
    const rng = createRng(seed);
    ctx.rng = rng.fork('rules'); ctx.seed = seed;
    // Math.random inside a rules hook draws from the game's seeded stream too (kit/core/guard.js seedRules)
    rules = seedRules(rules, rng.fork('rules:Math.random'));
    const gameId = assets.manifest?.game ?? 'game', saved = loadSettings(gameId);
    const quality = pickQuality(params.get('quality') ?? (saved.quality !== 'auto' ? saved.quality : null), deviceFacts());
    ctx.quality = quality;
    const canvas = document.createElement('canvas'); canvas.id = 'gf-canvas'; canvas.tabIndex = 0;
    canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none';
    document.body.style.cssText = 'margin:0;overflow:hidden;background:#000';
    document.body.append(canvas);
    const lookValues = lookCfg.values ?? lookCfg;
    const renderer = mods.look.createRenderer(canvas, lookValues, quality);
    // a look may need to finish setting up its renderer first (WebGPURenderer.init(): the scenic-3d profile, CONTRACT §8)
    await mods.look.ready?.(renderer);
    assets.setRenderer(renderer);
    // the camera is the look's when it brings one (a flat game's orthographic camera), else the kit's perspective one
    const scene = new THREE.Scene(), camera = mods.look.createCamera?.(lookValues) ?? new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 600);
    Object.assign(ctx, { scene, renderer }); guardCamera(ctx, camera);      // ctx.camera: the kit's; assigning another is refused
    const look = mods.look.applyLook(ctx, lookValues) ?? {};
    ctx.look = look;
    // the pixels drawn (kit/core/resolution.js, CONTRACT §6i): the screen's real pixels within the tier's budget, again
    // on every resize and zoom; a game that cannot keep up draws fewer (the governor), never under one CSS pixel.
    // ?gf-res=fixed (QA) keeps the full ratio.
    const budget = quality.pixelBudget ?? PIXEL_BUDGET[quality.name] ?? PIXEL_BUDGET.high;
    const governor = params.get('gf-res') === 'fixed' ? null : createGovernor();
    const res = { target: 1, ratio: 1, budget };
    const applyRatio = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      res.target = pixelRatioFor({ dpr, width: innerWidth, height: innerHeight, budget });
      res.ratio = Math.max(Math.min(dpr, 1), res.target * (governor?.scale ?? 1));
      renderer.setPixelRatio(res.ratio);
    };
    const resize = () => { governor?.reset(); applyRatio(); renderer.setSize(innerWidth, innerHeight, false); if (camera.isPerspectiveCamera) { camera.aspect = innerWidth / Math.max(1, innerHeight); camera.updateProjectionMatrix(); } else mods.look.resizeCamera?.(camera, innerWidth, innerHeight, renderer); look.resize?.(innerWidth, innerHeight); };
    addEventListener('resize', resize); watchPixelRatio(globalThis, resize); resize();
    ctx.resolution = res;

    // ---- physics and the world ----
    await RAPIER.init();
    const world = new RAPIER.World({ x: 0, y: -(game.gravity ?? 20), z: 0 });
    world.timestep = H;
    ctx.physics = world; ctx.RAPIER = RAPIER;     // CONTRACT §3: physics is the Rapier world (the kit steps it)
    ctx.world = await mods.world.loadWorld(ctx, assets.config('world'));

    const characterFor = role => ({ bodySlot: `character.body.${role}`, height: charsCfg.roles?.[role]?.height ?? 1.7 });
    // a preview subject wears the page's loadout, so Studio can render an item's look (?gf-show=character.player)
    if (subject) { if (pageLoadout().loadout != null) assets.setLoadout('show', pageLoadout().loadout); return await showMode(ctx, subject, mods, characterFor, look); }

    // ---- audio, input, UI ----
    const audio = createAudio(await gf.sounds(), { presets: audioPresets.presets, storageKey: backdrop ? undefined : `gf3-${assets.manifest.game ?? 'game'}`, listen: !backdrop, fileUrl: gf.url });
    if (backdrop) audio.muted = true;          // not saved: no storage key
    const v1 = new THREE.Vector3();
    ctx.audio = {
      raw: audio,
      /** play(soundId, {at: {x, y, z}, gainDb, pitch, optional}): at → panned and quieter with distance from the camera. */
      play(id, opts = {}) {
        const o = { ...opts };
        if (o.at) {
          v1.set(o.at.x, o.at.y ?? 0, o.at.z).applyMatrix4(camera.matrixWorldInverse);
          // an orthographic camera hangs far from the plane: how far a sound is, is its distance across the screen
          const d = camera.isOrthographicCamera ? Math.hypot(v1.x, v1.y) : v1.length();
          o.pan = Math.max(-0.8, Math.min(0.8, v1.x / Math.max(3, d)));
          o.gainDb = (o.gainDb ?? 0) - Math.min(18, Math.max(0, (d - 4) * 0.6));
          delete o.at;
        }
        if (!audio.has(id)) { if (!o.optional) refusals.refuse('sound-unlisted', `ctx.audio.play("${id}"): no sound with that id in assets.json → sounds → sounds (list it there, or pass { optional: true })`, id); return null; }
        return audio.play(id, o);
      },
      has: id => audio.has(id), stop: id => audio.stop(id),
    };
    const input = createInput(canvas);
    ctx.input = input;
    ui = createUI(ctx, { text: game.text ?? {}, controls: game.controls ?? {}, theme: game.ui?.theme ?? null });
    if (game.ui?.style) applyKindHud({ ...game.ui.style, accent: game.ui.accent }, { fontUrl: game.ui.style.fontFile ? gf.url(game.ui.style.fontFile) : null });   // the kind's HUD style (ui/kind-hud.js)
    ctx.ui = ui;
    if (worldMode) { ui.timer(false); ui.score([]); }      // a world has no clock and no scores
    // the kit's HUD (CONTRACT §6g): the player's own state from the mechanics; the rules add to it, never take it away
    let menu = null;
    const openPause = () => { if (!menu || menu.view || !['playing', 'countdown'].includes(ctx.round?.phase)) return; menu.pause(); try { document.exitPointerLock?.(); } catch {} };
    const hud = createHud(ctx, ui, { onMenu: () => openPause() });
    ctx.hud = readOnlyView(hud, ['goalText', 'observe', 'fullscreen'], 'ctx.hud'); ui.goalTo = t => { if (refusals.goalCall(t)) hud.goal(t); };
    hud.setGoal(refusals.startGoal(game));

    // ---- mechanics: the real module when present, else its params alone (the rules read them) ----
    const list = [];
    ctx.mechanics = { get: id => list.find(m => m.id === id) ?? null, list: () => list.slice() };
    for (const spec of game.mechanics ?? []) {
      const mod = mods.mechanics.get(spec.id);
      const inst = mod ? mod.create(ctx, spec.params ?? {}) : {};
      inst.id = spec.id; inst.as = spec.as; inst.params = { ...(spec.params ?? {}) }; inst.standin = !mod;
      list.push(inst);
    }
    ctx.mechanicsList = list;
    // where a player is, when a part holds the body and gives the player a mark instead (it owns player.control: a
    // board's cursor). The part says so itself, presence(p) → { x, y, z }; null → the body. Read by the observation
    // (snapshot().players[].mark, controls().mark) and by the block the two-player gate reads (kit/net/session.js).
    ctx.presenceOf = p => { for (const m of list) { if (m.standin || typeof m.presence !== 'function') continue; try { const q = m.presence(p); if (q && Number.isFinite(q.x) && Number.isFinite(q.z)) return q; } catch (e) { frameFailed(`mechanic ${m.id}.presence`, e); } } return null; };
    // an aimed mechanic (projectile; carry with a throw action) means a crosshair, and the shooter turns to the aim while
    // firing (CONTRACT §6d); rules may still call ui.crosshair themselves
    ctx.aimed = list.some(m => !m.standin && m.aimed === true);

    // ---- players, bots and the round ----
    const botParam = params.get('bots');
    const max = game.players?.max ?? 4;
    // the flow (open builder M4-C; kit/loops/<id>): config/game.json → round.flow names how the round is played; a game
    // that names none runs the timed round, the session's own default. Alone, bots fill the seats the flow says (a
    // turn-taking game seats the fewest it can be played with, not every seat); ?bots=N asks for a number outright.
    const flowId = game.round?.flow;
    const flowMod = typeof flowId === 'string' && flowId !== 'round' && !worldMode ? await import(`../loops/${flowId}/index.js`) : null;
    const botCount = backdrop ? 0 : botParam !== null ? Math.max(0, Math.min(7, Number(botParam) || 0)) : game.players?.bots === false ? 0 : flowMod?.botsAlone?.(game.players ?? {}) ?? max - 1;
    const T = game.text ?? {};
    ctx.makeBot = p => createBrain(ctx, p, rng.fork(`bot:${p.id}`));
    const session = createSession(ctx, { rules, spawnCharacter: mods.character.spawnCharacter, characterFor, rng, botCount, onPhase: ph => onPhase(ph), createPlayers, flow: flowMod });
    ctx.round = {
      get phase() { return session.round.phase; }, get number() { return session.round.number; },
      get winners() { return session.round.winners; }, get reason() { return session.round.reason; },
      end: (reason = 'ended', winners = null) => session.end(reason, winners),
    };
    await session.start();
    const me = ctx.me;
    me.actions = input.actions;              // the local player's actions are the input's (edges included)
    if ((game.camera ?? 'third') === 'first') me.character.object3d.visible = false;
    // the reticle in the middle of the screen is for the third and first cameras; with 'follow' the mouse cursor itself
    // aims (CONTRACT §8), drawn as a crosshair cursor
    const camMode = game.camera ?? 'third';
    ui.crosshair((camMode === 'third' || camMode === 'first') && ctx.aimed);
    // first person in a world (CONTRACT §9): the reticle while the middle of the screen aims (the lock taken, or not yet
    // asked for); none while the cursor or a finger aims (a post on X, a phone), where the outline shows the block
    const firstWorld = worldMode && camMode === 'first';
    if (camMode === 'follow') canvas.style.cursor = 'crosshair';
    // mechanics that need players, ctx.shared or ctx.me get them here (create() runs before the session exists)
    ctx.fair.setup();
    // how a friend is seen when the players are not characters (gf/mp/presence.js; config/game.json → players.presence,
    // which create chose from multiplayer.together and the parts that hold the body): a seat card, an avatar that
    // reacts, a pointer and every move on a shared board; each friend's board live beside yours on own boards
    const presenceShape = game.players?.presence ?? 'character';
    if (presenceShape === 'seats' || presenceShape === 'boards') {
      const model = createPresence({ shape: presenceShape, me: () => ctx.me?.id ?? null, send: (type, d) => ctx.net.send(type, d, 'all') });
      ctx.net.on('presence:me', (d, from) => model.receive(d, from));
      const words = Object.fromEntries(['waiting', 'thinking', 'placed', 'won', 'lost', 'away'].map(k => [k, T[`mood${k[0].toUpperCase()}${k.slice(1)}`]]));
      const view = backdrop ? null : createPresenceView(ctx, ui, { shape: presenceShape, model, text: words, avatar: assets.has('ui.avatar') ? assets.url('ui.avatar') : null });
      ctx.presence = Object.freeze({
        shape: presenceShape,
        /** This player's own presence, sent to every friend: {pointer: [c, r], mood, moves, last: [c, r], board: {cols, rows, g}, score}. */
        set: patch => model.set(patch),
        /** What this copy knows of a player's presence (a friend's as they sent it). */
        of: id => model.of(id),
        frame: dt => { model.frame(dt); view?.frame(dt); },
        observe: () => ({ ...(view?.observe() ?? { shape: presenceShape, seats: [] }), me: model.local }),
      });
    }
    // the kit's own elements (CONTRACT §6g) are kept as the kit means them from here on (kit/core/guard.js)
    const kitGuard = watchKit({ layer: ui.root, items: () => [{ el: ui.root, name: "the kit's layer (#gf-ui)", want: true }, ...hud.kitItems(), ...(menu?.kitItems() ?? [])] });
    if (params.get('gf-ui') === '0' || backdrop) kitGuard.off = true;
    for (const m of list) { try { await m.setup?.(ctx); } catch (e) { console.error(e); setupFailed(`mechanic ${m.id}`, e); } }
    // the event log (kit/core/events.js; verify gates C and D): every mechanic event, score, press and sound, read-only
    const eventLog = createEventLog(ctx, { list, modules: mods.mechanics });
    ctx.events = Object.freeze({ count: eventLog.count });
    try { await rules.setup?.(ctx); } catch (e) { console.error(e); setupFailed('rules', e); throw e; }
    // the studio page changes a value slot while the game runs (dev only: kit/core/live-slots.js)
    if (!backdrop) listenForSlots(ctx, { win: window, net });

    function onPhase(ph) {
      for (const p of ctx.players.owned()) if (p.controller) p.controller.enabled = ph === 'playing';
      if (ph === 'countdown') { menu?.close(); ctx.audio.play('round-countdown', { optional: true }); }
      if (ph === 'playing' && worldMode) { ui.hideCard(); if (menu?.view && !menu.paused) menu.close(); if (T.welcome) ui.banner(T.welcome, 2); ctx.audio.play('world-enter', { optional: true }); canvas.focus(); return; }
      if (ph === 'playing') { ui.cover('results', false); ui.hideCard(); if (menu?.view && !menu.paused) menu.close(); ui.banner(T.go ?? 'Go!', 1.2); ctx.audio.play('round-go', { optional: true }); canvas.focus(); }
      if (ph === 'lobby') { ui.hideCard(); if (!session.live) menu?.home(); else if (worldMode) menu?.close(); try { document.exitPointerLock?.(); } catch {} }
      if (ph === 'results') {
        menu?.close();
        const w = session.round.winners ?? [];
        // with friends the party page's results card is the one result screen (gf-multiplayer 1.4.0): every player in
        // their colour with their own score, Play again for the host. Two cards that disagreed (one counting bots) was
        // the creator's "Final scores seem to always be the same regardless".
        if (session.live) { ui.cover('results', true); ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true }); try { document.exitPointerLock?.(); } catch {} return; }
        const names = w.map(id => ctx.players.get(id)?.name ?? id);
        // a run lost together (everyone down: the levels mechanic ends with 'lost') says so, not "nobody scored"
        const title = names.length ? (T.wins ?? '{name} wins!').replace('{name}', names.join(' & ')) : session.round.reason === 'lost' ? (T.lost ?? 'Defeated') : (T.draw ?? 'Round over');
        ui.results({ title, rows: session.round.rows ?? [], winners: w,
          onAgain: session.live || game.round?.replay === false ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.replay(); },
          onMenu: session.live ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.toLobby(); } });
        ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true });
        try { document.exitPointerLock?.(); } catch {}
      }
    }
    // the home menu (CONTRACT §6g): every game opens on it alone; in a live round the party page is the lobby, and the
    // menu is the pause menu (the round keeps going)
    const friendsPage = () => new URL('gf/mp/index.html', location.href).href;
    menu = createMenu(ctx, ui, {
      game, live: session.live, world: worldMode, gameId, host, players: () => ctx.players.list(),
      onPlay: () => { if (session.round.phase === 'lobby') { ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); } },
      onFriends: () => { if (host.present && host.offers.friends) host.friends(); else location.href = friendsPage(); },
      onResume: () => { menu.close(); canvas.focus(); },
      onLeave: () => { menu.close(); session.toLobby(); },
      onQuality: () => { if (!session.live) location.reload(); },
      // with friends the pause menu carries the room (gf-multiplayer 1.4.0, live.hud "game"): code, invite, leave, end round
      // End round goes through this game's own round end (the host owns it), so every copy reports its real score
      room: session.live ? { info: () => net.room, leave: () => { menu.close(); net.leave(); }, end: worldMode ? null : () => { menu.close(); session.end('ended', null, true); canvas.focus(); },
        // watch then play (gf-multiplayer 1.6.0): Go live, and the stream's state while it is on
        // (net.live is undefined on a gf/mp older than 1.6.0: the menu then offers no Go live)
        live: () => net.live ?? null, goLive: () => { menu.close(); canvas.focus(); net.live?.start?.(); }, showLive: () => { menu.close(); canvas.focus(); net.live?.share?.(); },
        // voice chat on Studio's play page (gf-multiplayer 1.7.4): the row opens Studio's voice panel over the game
        voice: () => net.live?.voice ?? null, voiceOpen: () => net.live?.voiceOpen?.(), voiceClose: () => net.live?.voiceClose?.() } : null,
    });
    ctx.menu = readOnlyView(menu, ['view', 'paused', 'observe'], 'ctx.menu');      // read-only for rules
    if (session.live) net.live?.onChange?.(() => menu.redraw?.());
    // QA and capture only (never in real play): ?gf-autoplay=1 skips the menu alone; ?gf-ui=0 hides the HUD; ?gf-calm=N stills bots for N s;
    // ?gf-step=1 (alone only) stops the clock until window.__game.step(ms) (kit/core/step.js)
    if (params.get('gf-ui') === '0' || backdrop) ui.root.style.display = 'none';
    if (backdrop) { input.enabled = false; canvas.tabIndex = -1; }
    // a world with friends: the party page's world card is the home menu; the game shows its world behind it
    if (session.live && worldMode) { session.arm(); session.ready(); }
    else if (session.live) { ui.waiting(); session.arm(); session.ready(); }
    else if (params.get('gf-autoplay') === '1') session.beginCountdown();
    else menu.home();
    const watchStyle = document.createElement('style');
    // a viewer keeps what everyone in the round sees (names, bars, the clock, the scores, the banner, the goal, a boss),
    // never the streamer-less player's own card, prompts, menu or touch buttons (play-test 1: no clock, scores or winner)
    watchStyle.textContent = '#gf-ui.gf-watching > :not(.gf-plates):not(.gf-bars):not(.gf-fsbtn):not(.gf-top):not(.gf-scores):not(.gf-banner):not(.gf-goal):not(.gf-bossbar){display:none !important}';
    document.head.append(watchStyle);
    addEventListener('keydown', e => {
      if (backdrop || session.watching) return;
      const a = document.activeElement, onControl = a && (a.tagName === 'BUTTON' || a.tagName === 'INPUT');
      if ((e.code === 'Enter' || e.code === 'Space') && !onControl && session.round.phase === 'lobby' && menu.view === 'home') { if (refusedPress(e, 'Play (Enter)')) return; e.preventDefault(); menu.close(); ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); }
      if (e.code === 'Escape' && !e.defaultPrevented && !menu.view && ['playing', 'countdown'].includes(session.round.phase)) { e.preventDefault(); openPause(); }
    });

    // ---- the observation (CONTRACT §5): read-only ----
    const r2 = v => Math.round(v * 100) / 100;
    // the colour a player's ring is drawn in (verify: one colour per player, the room's)
    const ringColor = p => { const m = p.character?.object3d.getObjectByName('ring')?.material; return m?.color ? `#${m.color.getHexString()}` : null; };
    const observe = () => ({
      kit: 'gf-three', runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: session.round.phase, round: session.round.number, seed, quality: quality.name,
      time: { now: r2(ctx.time.now), round: r2(ctx.time.round), left: r2(ctx.time.left) },
      me: me.id, host: ctx.host, live: session.live, backdrop, view: menu.view ?? ui.view, paused: menu.paused && !session.live,
      players: ctx.players.list().map(p => ({ id: p.id, name: p.name, score: p.score, alive: p.alive, bot: p.isBot, local: p.local, x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), anim: p.anim,
        color: p.color, ring: ringColor(p), ...ctx.fair.observe(p), ...(m => (m ? { mark: { x: r2(m.x), z: r2(m.z) } } : {}))(ctx.presenceOf(p)) })),
      fair: ctx.fair.summary(),
      refusals: refusals.list(),
      winners: session.round.winners, reason: session.round.reason, results: session.round.rows,
      shared: ctx.shared.snapshot(),
      rules: (() => { try { return rules.observe?.(ctx) ?? null; } catch { return null; } })(),
      modules: { standins: mods.standins, mechanics: list.map(m => ({ id: m.id, standin: m.standin })) },
      // with friends, what this screen shows of each of them when the players are not characters (the presence part)
      net: (b => (b && ctx.presence ? { ...b, presence: ctx.presence.observe() } : b))(session.gateBlock(ui.covered)),
      presence: ctx.presence?.observe() ?? null,
      // a flow that publishes what it does (kit/loops/<id>: whose turn, turns taken): what the checks read as its sign
      ...(session.flow.observe ? { flow: session.flow.observe() } : {}),
      // watch then play (gf-multiplayer 1.6.0): a viewer's copy, who it follows and whether the camera has them
      watch: session.watching ? { follow: session.watch?.follow ?? null, live: !!session.watch?.live, target: watchCam.target, camera: camMode } : null,
      world: worldMode ? { status: net.status ?? null, voxel: ctx.world.voxel?.stats?.() ?? null } : null,
    });
    // stepped time (QA only, kit/core/step.js): asked for in the address, alone; never in a live round or a backdrop
    const stepped = stepAsked(params, { live: session.live, backdrop });
    const stepper = stepped ? createStepper({ frame: f => frame(0, f) }) : null;
    window.__game = Object.freeze({
      kit: 'gf-three', version: VERSION, seed, quality: quality.name,
      get phase() { return session.round.phase; },
      get ready() { return true; },
      get players() { return observe().players; },
      snapshot: () => JSON.parse(JSON.stringify(observe())),
      coverage: () => coverageReport(scene),
      slots: () => assets.stats(scene, camera),
      controls: () => JSON.parse(JSON.stringify(controlsReport())),
      // which sounds played, by id, as the audio kit counted them (verify check 7, research/audio/qa-gate-v5.mjs:
      // the listed sounds are heard, not only something loud enough); dropped: plays the kit did not start, by reason
      sounds: () => JSON.parse(JSON.stringify({ plays: audio.stats?.plays ?? {}, dropped: audio.stats?.dropped ?? {} })),
      panels: () => JSON.parse(JSON.stringify(ui.panels.observe())),      // the shared panels (CONTRACT §6j)
      events: o => JSON.parse(JSON.stringify(eventLog.read(o ?? {}))),     // the event log (kit/core/events.js; gates C and D)
      menu: () => JSON.parse(JSON.stringify(menu.observe())),      // verify checks 20 and 22 (CONTRACT §6g)
      hud: () => JSON.parse(JSON.stringify({ phase: session.round.phase, covered: ui.covered, ...hud.observe() })),   // verify check 21
      looks: () => JSON.parse(JSON.stringify(looksReport())),
      // verify check 24 (a post's frame that refuses the pointer lock): the camera, its heading, the lock and full screen
      // (worlds' checks also read the pitch, the input's cursor mode by name and whether the aim follows the pointer)
      camera: () => JSON.parse(JSON.stringify({ mode: camMode, yaw: me.controller?.rig?.yaw ?? null, pitch: me.controller?.rig?.pitch ?? null, cursorMode: !!input.cursorMode,
        cursor: input.cursorMode || null, aimFree: !!input.aimFree, eye: [camera.position.x, camera.position.y, camera.position.z].map(v => Math.round(v * 1000) / 1000),
        dir: camera.getWorldDirection(new THREE.Vector3()).toArray().map(v => Math.round(v * 1000) / 1000),      // where the view looks (check 34: a viewer sees as the streamer does)
        sensitivity: me.controller?.rig?.settings?.sensitivity ?? null, lookScale: input.lookScale ?? 1, invertY: !!input.invertY,
        crosshair: !!ui.crosshairOn, lockRefused: !!input.lockRefused, locked: !!input.locked, following: !!input.following, fullscreen: hud.fullscreen?.() ?? null })),
      sight: ids => sight({ renderer, scene, camera }, ids),       // verify check 15: a slot's share of this player's view
      // where a world point is on this screen (verify check 34: a viewer's nameplates sit over the characters)
      project: (x, y, z) => screenOf({ x, y, z }),
      // verify check 31 (sharp on every screen, CONTRACT §6i): the screen, the canvas's drawing buffer, the ratio drawn
      // and the one the screen gets (they differ only when the frame-rate guard lowered it, and `slow` says why)
      screen: () => { const c = renderer.domElement; return JSON.parse(JSON.stringify({ dpr: globalThis.devicePixelRatio || 1, css: [innerWidth, innerHeight], buffer: [c.width, c.height],
        ratio: res.ratio, target: res.target, budget: res.budget, quality: quality.name, slow: governor?.last ?? null, guard: !!governor })); },
      // worlds (CONTRACT §9; verify's world checks): the cells, the build tools' state, and where a point is on screen
      ...(ctx.world.voxel ? {
        voxelAt: (x, y, z) => ctx.world.voxel.grid.get(x, y, z),
        topAt: (x, z) => ctx.world.voxel.grid.top(x, z),
        signAt: (x, y, z) => ctx.world.voxel.signs.get(ctx.world.voxel.grid.index(x, y, z)),
        protectedAt: (x, y, z) => ctx.world.voxel.protectedAt(x, y, z),
        build: () => JSON.parse(JSON.stringify(list.find(m => m.id === 'build')?.observe?.() ?? null)),
        shove: () => JSON.parse(JSON.stringify(list.find(m => m.id === 'shove')?.observe?.() ?? null)),
        world: () => JSON.parse(JSON.stringify(ctx.world.voxel.stats())),
        project: (x, y, z) => screenOf({ x, y, z }),
      } : {}),
      // stepped time (QA only, kit/core/step.js): present only when the address carries ?gf-step=1 and the round is not live
      ...(stepped ? { stepped: true, step: (ms, opts) => JSON.parse(JSON.stringify({ ...stepper.step(ms, opts), now: ctx.time.now, round: ctx.time.round, phase: session.round.phase })) } : {}),
    });

    // ---- the looks observation (CONTRACT §6e; verify check 5's loadout leg): what this copy draws each player in ----
    function looksReport() {
      const prj = list.find(m => m.id === 'projectile' && !m.standin);
      return {
        me: me.id, local: ctx.looks?.observe?.() ?? null, slots: assets.playerLooks(),
        players: ctx.players.list().map(p => {
          const r = assets.loadout(p.id), look = p.character?.look ?? null;
          return {
            id: p.id, name: p.name, bot: p.isBot, local: p.local, seat: p.seat, color: p.color,
            key: r?.key ?? '', advertised: r?.advertised ?? '', values: r?.loadout.values ?? {}, files: r?.loadout.files ?? {},
            dropped: [...(r?.dropped ?? []), ...[...(r?.rejected ?? new Map())].map(([slot, why]) => ({ slot, why }))],
            drawn: look ? { ...look, visible: !!p.character.object3d.visible } : null,
            shots: prj?.lookOf?.(p) ?? null,
          };
        }),
      };
    }

    // ---- the controls observation (verify check 13): what the local player's own screen shows of each control ----
    const sv = new THREE.Vector3();
    const screenOf = q => { if (!q) return null; sv.set(q.x, q.y, q.z).project(camera); return { x: r2((sv.x * 0.5 + 0.5) * innerWidth), y: r2((-sv.y * 0.5 + 0.5) * innerHeight), front: sv.z < 1 && sv.z > -1 }; };
    const hiddenBySelf = q => {
      if (!q || (game.camera ?? 'third') !== 'third') return false;
      const from = camera.position, dx = q.x - from.x, dy = q.y - from.y, dz = q.z - from.z, d = Math.hypot(dx, dy, dz) || 1;
      const t = rayCylinder(from, { x: dx / d, y: dy / d, z: dz / d }, me.position, me.character?.height ?? 1.7, BODY_RADIUS);
      return t !== null && t < d - 0.3;
    };
    function controlsReport() {
      const pt = q => (q ? { x: r2(q.x), y: r2(q.y), z: r2(q.z) } : null);
      const prj = list.find(m => m.id === 'projectile' && !m.standin);
      const land = prj?.landing?.(me) ?? null, aimP = me.aimPoint ?? null;
      const inter = [];
      for (const m of list) { if (m.standin || typeof m.interactables !== 'function') continue; try { for (const it of m.interactables()) inter.push({ ...it, x: r2(it.x), y: r2(it.y ?? 0), z: r2(it.z), d: r2(Math.hypot(it.x - me.position.x, it.z - me.position.z)) }); } catch (e) { frameFailed(`mechanic ${m.id}.interactables`, e); } }
      inter.sort((a, b) => a.d - b.d);
      // what a part lets the player point at and click now (a board with a cursor: the cells of a legal move), in CSS pixels
      const points = [];
      for (const m of list) { if (m.standin || typeof m.points !== 'function') continue; try { for (const it of m.points()) points.push({ ...it, x: Math.round(it.x), y: Math.round(it.y) }); } catch (e) { frameFailed(`mechanic ${m.id}.points`, e); } }
      const mark = ctx.presenceOf(me);
      return {
        points, mark: mark ? { x: r2(mark.x), z: r2(mark.z) } : null, held: me.controller ? me.controller.enabled === false : false,
        camera: game.camera ?? 'third', crosshair: ui.crosshairOn, aimed: !!ctx.aimed, controls: game.controls ?? {}, prompt: ui.promptText,
        viewport: { w: innerWidth, h: innerHeight },
        aim: { dir: (me.aim ?? []).map(r2), dist: Number.isFinite(me.aimDist) ? r2(me.aimDist) : null, point: pt(aimP), hit: me.aimHit ?? null, onSelf: !!me.aimOnSelf, screen: screenOf(aimP) },
        landing: land ? { point: pt(land), age: r2(ctx.time.now - (land.at ?? ctx.time.now)), screen: screenOf(land), hiddenBySelf: hiddenBySelf(land), fromAim: aimP ? r2(Math.hypot(land.x - aimP.x, land.z - aimP.z)) : null } : null,
        interactables: inter,
        mechanics: list.filter(m => !m.standin).map(m => ({ id: m.id, aimed: !!m.aimed, interacts: !!m.interacts, ...(m.stats ? { stats: m.stats } : {}) })),
        me: { x: r2(me.position.x), y: r2(me.position.y), z: r2(me.position.z), alive: me.alive !== false, holding: list.find(m => m.id === 'carry' && !m.standin)?.heldCount?.(me) ?? 0 },
      };
    }

    // ---- the frame ----
    let last = null, acc = 0;
    const draw = () => { if (look.render) look.render(camera); else renderer.render(scene, camera); };
    const plate = new THREE.Vector3();
    const orbit = { a: 0, v: new THREE.Vector3(), at: new THREE.Vector3(), dir: new THREE.Vector3(), right: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };
    // one frame. In play `t` is the browser's frame time; a stepped frame (kit/core/step.js) brings its own dt, exactly
    // one fixed step, and says whether it is drawn (the frames inside a step are not: they cost no drawing)
    const frame = (t, fixed = null) => {
      const raw = fixed ? fixed.dt : last === null ? 0 : Math.max(0, (t - last) / 1000);
      const dt = Math.min(0.1, raw); if (!fixed) last = t;
      const drawn = !fixed || fixed.draw;
      // the frame-rate guard: sampled while playing in view; it lowers the ratio, never under one CSS pixel
      if (governor) {
        const floor = Math.min(1, Math.min(globalThis.devicePixelRatio || 1, 1) / res.target);
        if (governor.frame(raw, { active: session.round.phase === 'playing' && !document.hidden && !menu.view, floor })) {
          applyRatio(); renderer.setSize(innerWidth, innerHeight, false); look.resize?.(innerWidth, innerHeight);
        }
      }
      // alone, the pause menu stops the game where it is (with friends the round keeps going: CONTRACT §3)
      if (menu.paused && !session.live && ['playing', 'countdown'].includes(session.round.phase)) {
        input.enabled = false; input.update();
        hud.update(0, { phase: session.round.phase, covered: true });
        ui.update(0, { left: session.round.phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates: [] });
        kitGuard.tick(performance.now() / 1000);
        if (drawn) draw();
        return;
      }
      ctx.time.now += dt; ctx.time.dt = dt;
      const phase = session.round.phase;
      input.enabled = phase === 'playing' && !ui.covered && !backdrop && !session.watching;
      // a viewer (gf-multiplayer 1.6.x): no HUD and no menu of its own, only names and bars over the stream's players
      if (ui.root.classList.contains('gf-watching') !== session.watching) {
        ui.root.classList.toggle('gf-watching', session.watching);
        canvas.style.pointerEvents = session.watching ? 'none' : '';      // a viewer's click takes nothing (no pointer lock with nothing to look at)
      }
      input.update();
      if (phase === 'countdown') ui.countdown(Math.max(1, Math.ceil(session.round.countdown)));
      session.tick(dt);
      const R = game.round ?? {};
      // the clock the HUD shows is the flow's when it has its own (a turn's; Infinity: none), else the round's
      ctx.time.round = session.round.clock; ctx.time.left = session.flow.hudLeft ? session.flow.hudLeft() : Math.max(0, (R.seconds ?? 120) - session.round.clock);
      // bots (the host's)
      if (ctx.host) for (const p of ctx.players.bots()) {
        if (!p.owned || !p.bot) continue;
        p.bot.begin();
        // QA only: ?gf-calm=<seconds> keeps bots still at the start of each round, so a scripted walk can't be knocked over
        // a flow may hold a bot (a turn-taking game's bot acts on its own turn only): flow.bot → false
        if (session.round.phase === 'playing' && !(calm > 0 && session.round.clock < calm)) { try { if (session.flow.bot && !session.flow.bot(p, dt)) { /* held, or the flow played for it */ } else if (rules.bot) rules.bot(ctx, p, dt); else defaultBot(ctx, p); } catch (e) { frameFailed(rules.bot ? 'rules.bot' : 'the kit bot', e); } }
        else p.bot.stop();
        p.bot.finish(dt);
      }
      // physics at a fixed 60 Hz
      acc += dt; let steps = 0;
      const owned = ctx.players.owned().filter(p => p.controller);
      while (acc >= H && steps < 6) { for (const p of owned) p.controller.fixedStep(); world.step(); for (const p of owned) p.controller.postStep(); acc -= H; steps++; }
      if (acc > H) acc = 0;
      for (const p of owned) { p.controller.update(dt, acc / H); p.position.copy(p.controller.feet); p.yaw = p.controller.state.facing; p.anim = p.controller.anim; }
      if (firstWorld) { const on = session.round.phase === 'playing' && !input.aimFree && !menu?.view; if (on !== ui.crosshairOn) ui.crosshair(on); }
      try { ctx.fair.update(dt); } catch (e) { frameFailed('fair play', e); }      // who is down or protected, before any hit this frame
      for (const m of list) { try { m.update?.(dt); } catch (e) { frameFailed(`mechanic ${m.id}.update`, e); } }
      try { rules.update?.(ctx, dt); } catch (e) { frameFailed('rules.update', e); }
      for (const fn of ctx.onFrame) { try { fn(dt); } catch (e) { frameFailed('a ctx.onFrame function', e); } }
      session.send();
      ctx.world.update?.(dt);
      // a viewer's camera goes where the streamer is before anything reads it (nameplates, the look's light and shadow):
      // the hidden player's own rig set it this frame already
      if (session.watching) { watchCam.was = true; watchCamera(dt); }
      const followed = session.watching && watchCam.target ? ctx.players.get(watchCam.target) : null;
      look.update?.(dt, followed?.position ?? me.position);
      // nameplates over everyone else
      const w = innerWidth, h = innerHeight, plates = [];
      for (const p of ctx.players.list()) {
        if (p.local || (p.id === watchCam.target && camMode === 'first')) continue;     // a viewer in first person sees from the streamer's eyes
        const shown = (p.owned || p.drawn) && p.character?.object3d.visible;
        // a body may say where its name goes (seen from above, "over the head" is up the screen, not +Y)
        const po = p.character?.plateOffset ?? null;
        if (po) plate.set(p.position.x + po.x, p.position.y + po.y, p.position.z + po.z).project(camera); else
        plate.set(p.position.x, p.position.y + (p.character?.height ?? 1.7) + 0.3, p.position.z).project(camera);
        const vis = !!shown && plate.z > -1 && plate.z < 1 && Math.abs(plate.x) < 1.05 && Math.abs(plate.y) < 1.05;
        plates.push({ id: p.id, text: p.name, color: p.color, x: (plate.x * 0.5 + 0.5) * w, y: (-plate.y * 0.5 + 0.5) * h, visible: vis });
      }
      ui.update(dt, { left: phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates });
      hud.update(dt, { phase, covered: ui.covered });
      if (ctx.presence) { try { ctx.presence.frame(dt); } catch (e) { frameFailed('the presence part (gf/three/ui/presence.js)', e); } }
      if (!session.watching) kitGuard.tick(performance.now() / 1000);
      // the home menu: the camera circles the player's character, which stands right of the menu column; a world
      // drifts over the island instead (behind the kit's menu alone, behind the party page's world card with friends)
      if (session.watching) { /* the camera was set above */ }
      else {
        // a viewer who joined: their own body is theirs again (first person keeps it hidden), the streamer's too
        if (watchCam.was) { watchCam.was = false; watchCam.on = false; watchCam.target = null; if (camMode !== 'first' && me.character?.object3d) me.character.object3d.visible = true; if (watchCam.hidden?.character?.object3d) watchCam.hidden.character.object3d.visible = true; watchCam.hidden = null; }
        if (phase === 'lobby' && worldMode) worldCamera(dt);
        else if (phase === 'lobby' && menu.view && !session.live && (game.camera ?? 'third') !== 'first' && !me.controller?.rig?.place) homeCamera(dt);      // a rig that places itself (a flat game's) keeps the menu over the field as it is
      }
      // an undrawn stepped frame still leaves every matrix as a drawn one does (the renderer updates them when it
      // draws): the next frame's aim, sounds and observation read the scene and the camera where they are now
      if (drawn) draw(); else { scene.updateMatrixWorld(); camera.updateMatrixWorld(); }
    };
    // Stepped time (QA only): the browser's frames only redraw what is there, and time moves when step(ms) is called.
    // The loop still goes through net.loop (gf/mp is not ours to change); alone it is requestAnimationFrame.
    // (the first of them runs one frame of no time, so the menu's camera and the HUD are placed)
    let primed = false;
    if (stepped) session.loop(() => { if (primed) draw(); else { primed = true; frame(0, { dt: 0, draw: true }); } });
    else session.loop(frame);
    // Watch then play (gf-multiplayer 1.6.0): a viewer sees the stream as the streamer does, from their pose: their eyes
    // in first person, behind them along their aim in third, the game's fixed angle in follow or top. Its own player
    // stays hidden. Until the streamer is drawn, the world drifts (a world) or the camera circles the arena.
    const watchCam = { was: false, at: new THREE.Vector3(), pos: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), want: new THREE.Vector3(), wdir: new THREE.Vector3(), pivot: new THREE.Vector3(), back: new THREE.Vector3(), point: new THREE.Vector3(), cur: 0, on: false, target: null, hidden: null };
    function watchCamera(dt) {
      if (me.character?.object3d) me.character.object3d.visible = false;
      const f = session.watch?.follow;
      const id = f ? (worldMode ? f.cid ?? f.id : f.id) : null;
      const p = id ? ctx.players.get(id) : null;
      if (watchCam.hidden && watchCam.hidden !== p) { if (watchCam.hidden.character?.object3d && watchCam.hidden.drawn) watchCam.hidden.character.object3d.visible = true; watchCam.hidden = null; }
      if (!p || !p.drawn) { watchCam.target = null; watchCam.on = false; if (me.controller?.rig?.place) me.controller.rig.place({ x: 0, y: 0, z: 0 }, 0); else if (worldMode) worldCamera(dt); else { orbit.a += dt * 0.05; camera.position.set(Math.sin(orbit.a) * 18, 12, Math.cos(orbit.a) * 18); camera.lookAt(0, 0, 0); } return; }
      watchCam.target = p.id;
      // a rig that places itself over a point (a flat game's): a viewer sees the field over the streamer, as the streamer does
      if (me.controller?.rig?.place) { me.controller.rig.place(p.position, watchCam.on ? dt : 0); watchCam.on = true; return; }
      const C = { ...(RIG_DEFAULTS[camMode] ?? RIG_DEFAULTS.third), ...(me.controller?.rig?.settings ?? {}) };
      const h = p.character?.height ?? 1.7, a = Array.isArray(p.aim) && p.aim.length === 3 ? p.aim : null;
      watchCam.wdir.set(a ? a[0] : Math.sin(p.yaw ?? 0), a ? a[1] : 0, a ? a[2] : Math.cos(p.yaw ?? 0));
      if (watchCam.wdir.lengthSq() < 1e-6) watchCam.wdir.set(Math.sin(p.yaw ?? 0), 0, Math.cos(p.yaw ?? 0));
      watchCam.wdir.normalize();
      // the pose's aim runs from the aim origin (kit/core/aim.js, below the eyes) to the point under the crosshair: look
      // from the eyes at that point, or a viewer near a wall looks at the sky (play-test 1: 0 against 48.8 degrees)
      const eyeY = p.position.y + (camMode === 'first' ? (C.height ?? 1.55) : (C.height ?? 1.6)) * (h / 1.7);
      let pointed = false;
      if (a && Number.isFinite(p.aimDist) && p.aimDist > 0.05) {
        watchCam.at.set(p.position.x + a[0] * p.aimDist, p.position.y + AIM_HEIGHT + a[1] * p.aimDist, p.position.z + a[2] * p.aimDist);
        watchCam.point.copy(watchCam.at); pointed = true;
        watchCam.at.sub(watchCam.want.set(p.position.x, eyeY, p.position.z));
        if (watchCam.at.lengthSq() > 1e-4) watchCam.wdir.copy(watchCam.at).normalize();
      }
      const k = watchCam.on ? 1 - Math.exp(-dt * 12) : 1;
      if (camMode === 'first') {
        if (p.character?.object3d) { p.character.object3d.visible = false; watchCam.hidden = p; }   // their eyes: their own body is not in view
        watchCam.want.set(p.position.x, eyeY, p.position.z);
        watchCam.pos.lerp(watchCam.want, k); watchCam.dir.lerp(watchCam.wdir, k).normalize();
        camera.position.copy(watchCam.pos);
        camera.lookAt(watchCam.pos.x + watchCam.dir.x, watchCam.pos.y + watchCam.dir.y, watchCam.pos.z + watchCam.dir.z);
      } else if (camMode === 'follow' || camMode === 'top') {
        // the rig's own place (kit/controller/camera-rig.js): opposite its heading, raised by its pitch. Until
        // 2026-10-10 this stood on the heading's side, so a viewer of a follow game looked from the far side of the
        // streamer (check 34 on every scenic game: 45 m and 84 degrees off)
        watchCam.pivot.set(p.position.x, p.position.y + (C.height ?? 0.9), p.position.z);
        fixedCameraPlace(C, watchCam.pivot, watchCam.want);
        watchCam.pos.lerp(watchCam.want, k);
        camera.position.copy(watchCam.pos); camera.lookAt(watchCam.pivot);
      } else if (camMode === 'third' && pointed) {
        // third: the streamer's own rig (kit/controller/camera-rig.js), found again from the point under their
        // crosshair. Their camera sits behind a pivot at head height, `shoulder` metres to their right, and looks
        // through it at that point: the head, the shoulder and the point give the view's yaw and pitch. (Until
        // 2026-10-10 the viewer looked from the head at the point, with no shoulder: about 10 degrees off across a
        // room, 44 with a desk in front of the streamer.)
        const D = C.distance ?? 5.2, lo = C.collisionMin ?? C.minDistance ?? 0.8;
        if (!watchCam.on || !(watchCam.cur > 0)) watchCam.cur = D;
        const s = (C.shoulder ?? 0) * Math.min(1, watchCam.cur / D), hy = p.position.y + (C.height ?? 1.7);
        const vx = watchCam.point.x - p.position.x, vz = watchCam.point.z - p.position.z;
        const L = Math.sqrt(Math.max(0.01, vx * vx + vz * vz - s * s));
        const wyaw = Math.atan2(vx, vz) + Math.atan2(s, L);
        const wpitch = Math.max((C.minPitchDeg ?? -30) * Math.PI / 180, Math.min((C.maxPitchDeg ?? 65) * Math.PI / 180, Math.atan2(hy - watchCam.point.y, L)));
        watchCam.wdir.set(Math.sin(wyaw) * Math.cos(wpitch), -Math.sin(wpitch), Math.cos(wyaw) * Math.cos(wpitch));
        watchCam.dir.lerp(watchCam.wdir, k).normalize();
        const flat = Math.hypot(watchCam.dir.x, watchCam.dir.z) || 1;
        watchCam.pivot.set(p.position.x - watchCam.dir.z / flat * s, hy, p.position.z + watchCam.dir.x / flat * s);
        watchCam.back.copy(watchCam.dir).negate();
        // a wall pulls the camera in at once and lets it out slowly, as the rig does (its ball stops 0.05 m short)
        let d = D;
        const hit = ctx.world?.raycast?.(watchCam.pivot, watchCam.back, D);
        if (hit && Number.isFinite(hit.distance)) d = Math.max(lo, hit.distance - (C.collisionRadius ?? 0.22) - 0.05);
        watchCam.cur = d < watchCam.cur ? d : watchCam.cur + (d - watchCam.cur) * (1 - Math.exp(-dt * 2.5));
        camera.position.copy(watchCam.pivot).addScaledVector(watchCam.back, watchCam.cur);
        if (camera.position.y < p.position.y + 0.3) camera.position.y = p.position.y + 0.3;
        camera.lookAt(watchCam.pivot);
      } else {
        // orbit, and third while the streamer has no crosshair point: behind them, along their aim, a little above; a
        // wall pulls the camera in
        watchCam.dir.lerp(watchCam.wdir, k).normalize();
        const pitch = Math.max(5, Math.min(45, (C.pitchDeg ?? 16) - Math.asin(Math.max(-1, Math.min(1, watchCam.dir.y))) * 180 / Math.PI * 0.6)) * Math.PI / 180;
        const flat = Math.hypot(watchCam.dir.x, watchCam.dir.z) || 1;
        watchCam.pivot.set(p.position.x, p.position.y + (C.height ?? 1.6) * (h / 1.7), p.position.z);
        watchCam.back.set(-watchCam.dir.x / flat * Math.cos(pitch), Math.sin(pitch), -watchCam.dir.z / flat * Math.cos(pitch)).normalize();
        let d = C.distance ?? 5;
        const hit = ctx.world?.raycast?.(watchCam.pivot, watchCam.back, d);
        if (hit && Number.isFinite(hit.distance)) d = Math.max(0.8, hit.distance - 0.3);
        camera.position.copy(watchCam.pivot).addScaledVector(watchCam.back, d);
        camera.lookAt(watchCam.pivot.x + watchCam.dir.x * 2, watchCam.pivot.y + watchCam.dir.y * 2, watchCam.pivot.z + watchCam.dir.z * 2);
      }
      watchCam.on = true;
      camera.updateMatrixWorld();         // nameplates are placed with it this frame (play-test 1: tags off the characters)
    }
    function worldCamera(dt) {
      orbit.a += dt * 0.05;
      const W = ctx.world, b = W.bounds, cx = (b.min.x + b.max.x) / 2, cz = (b.min.z + b.max.z) / 2;
      const pz = W.zone?.('plaza')?.at, ty = pz ? pz.y : (W.voxel?.water ?? 0) + 3;
      const R = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.62;
      camera.position.set(cx + Math.sin(orbit.a) * R, ty + R * 0.42, cz + Math.cos(orbit.a) * R);
      camera.lookAt(pz ? pz.x : cx, ty + 2, pz ? pz.z : cz);
    }
    function homeCamera(dt) {
      orbit.a += dt * 0.16;
      const h = me.character?.height ?? 1.7;
      orbit.at.set(me.position.x, me.position.y + h * 0.62, me.position.z);
      const yaw = (me.yaw ?? 0) + Math.PI * 0.18 + Math.sin(orbit.a) * 0.55;
      orbit.dir.set(Math.sin(yaw), 0.32, Math.cos(yaw)).normalize();
      let r = 3.9 + h * 0.6;
      const hit = ctx.world?.raycast?.(orbit.at, orbit.dir, r);
      if (hit && Number.isFinite(hit.distance)) r = Math.max(1.6, hit.distance - 0.35);
      camera.position.copy(orbit.at).addScaledVector(orbit.dir, r);
      // look a little to the character's right, so it stands right of the menu column (centre on a narrow screen)
      orbit.right.crossVectors(orbit.dir, orbit.up).normalize();
      const side = innerWidth > 640 ? Math.min(1.5, r * 0.34) : 0;
      orbit.v.copy(orbit.at).addScaledVector(orbit.right, side);
      if (innerWidth <= 640) orbit.v.y += h * 0.32;
      camera.lookAt(orbit.v);
    }
    return ctx;
  } catch (e) {
    console.error(e);
    fatal(e);
    throw e;
  }
}

/** R3 plus: every slot id in the scene must exist in assets.json. */
function coverageReport(scene) {
  const r = assets.coverage(scene);
  const unknown = new Set();
  scene.traverse(o => { const id = o.userData?.gfSlot; if (id && !assets.has(id)) unknown.add(id); });
  return { ...r, unknownSlots: [...unknown] };
}

async function showMode(ctx, subject, mods, characterFor, look) {
  const state = await runShow(ctx, subject, { spawnCharacter: mods.character.spawnCharacter, characterFor, mechanics: new Map() });
  // a try-on: the page hands a new loadout while the subject shows (the Skins tab's colour or body), and the subject
  // wears it in place, with no reload (the editors' request 7)
  onPageLoadout(raw => { const r = assets.setLoadout('show', raw ?? null); if (r.changed) state.restyle?.(); });
  window.__game = Object.freeze({
    kit: 'gf-three', runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'show', subject,
    get ready() { return state.ready; },
    snapshot: () => ({ kit: 'gf-three', version: VERSION, phase: 'show', subject, ready: state.ready, look: { key: assets.loadout('show')?.key ?? '', restyled: state.restyled ?? 0 } }),
    coverage: () => coverageReport(ctx.scene),
    slots: () => assets.stats(ctx.scene, ctx.camera),
  });
  let last = null;
  net.loop(t => {
    const dt = last === null ? 0 : Math.max(0, Math.min(0.1, (t - last) / 1000)); last = t;
    for (const fn of ctx.onFrame) fn(dt);
    // a look that frames the preview itself (a flat game is seen straight on, never from the turntable's orbit)
    mods.look.frameSubject?.(ctx, state, subject);
    ctx.world.update?.(dt);
    look.update?.(dt, { x: 0, y: 0, z: 0 });
    if (look.render) look.render(ctx.camera); else ctx.renderer.render(ctx.scene, ctx.camera);
  });
  return ctx;
}

function fatal(e) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;padding:12px 16px;background:#3a1020;color:#fff;font:14px system-ui;border-radius:10px;z-index:9';
  d.textContent = `The game could not start: ${e?.message ?? e}`;
  document.body.append(d);
}
