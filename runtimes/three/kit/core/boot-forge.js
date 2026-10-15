// gf-three core: boot({rules}) for the forge engine (CONTRACT §8 forge; research/rust-engine/PLAN.md §3).
//
//   import { boot } from './gf/three/core/boot-forge.js'; import rules from './rules.js'; boot({ rules });   (main.js)
//
// The same system as boot.js, with the Rust core in place of three.js's look, world, characters and Rapier: the
// configs and assets.json (kit/assets/core.js, no three.js), the quality tier and the screen's pixels, the forge host
// (gf/forge/host.js: the wasm, its input, its state, its drawing), the forge look and world (gf/forge/look.js,
// world.js), audio, the input, the UI, the HUD and the home menu, the round and the net (kit/net/session.js with
// gf/forge/players.js), fair play, rules.setup(ctx), then the frame loop through net.loop. boot.js links three.js and
// Rapier statically, so a forge game (which vendors neither) starts here instead; everything below the renderer is the
// shared kit's.
//
// No WebGPU adapter (PLAN §3.4): the kit's own "open in your browser" screen, never a blank canvas.
// Wave 1a: the data tables (config/game.json → forge, gf/forge/tables) load into the core before the world; the core's
// events are routed by the host each frame (sounds to gf-audio by name, rule events to rules.event(ctx, name, data,
// 'forge')); the input's buttons go out as the core's BTN bits (fire, alt, interact, jump; Shift evades, R reloads,
// V melee, 1-4 and the wheel pick a weapon). A mechanic runs on forge where it has a forge implementation
// (components/<id>/impl/forge, loaded by gf/forge/mechanics.js); the others keep their params in config for the rules.
// Live co-op (track S; CONTRACT §8 forge "Live co-op"; forge-core net.rs): the host's core owns the world and replays
// each joiner's inputs (gf/forge/players.js spawns them); its snapshot rides in the round's own net.world message,
// taken only when that message is due so none of its events is lost; a joiner sends its inputs to the host about 20
// times a second ('fi'), predicts its own player, applies each new snapshot (replicas, reconciliation) and draws the
// others as their bodies (gf/forge/wear.js) with nameplates.
// Track F: gf/forge/feel.js draws the feel's DOM side (numbers, combo, red edge, low-health stages, crosshair,
// ammunition, the death recap) and verify reads it through window.__game.forge.feel().
// The wave 1b integration (research/gf-forge/INTEGRATION.md): one boot loads all four tracks' kit modules. ctx.render
// (gf/forge/render.js, track R) is made with the host, so the world's AI (gf/forge/ai.js, track A) and the players
// (gf/forge/players.js, track S) give their bodies to the renderer that skins them; gf/forge/fight.js registers the
// first-person arms and weapons, a kill's pieces, the coin and the effect pictures; the look is packed for the
// quality tier.
// The first view (wave 3, track M; research/rust-engine/PLAN.md §5: the arena behind a menu that works, under 5 s on
// a phone). In the order things start: the page itself starts the wasm's download and compile and asks for every
// module at once (index.html, written by create); the loading view asks for assets.json (ui/loading.js); here the
// arena's files are asked for the moment the configs are in, while the core starts, and each file is fetched once
// (eagerAssets below); nothing of a fight is fetched before the menu. Once the menu has been drawn the steps of
// gf/forge/first.js run: `first` (the first wave's bodies, the starting weapon, a kill's pieces; the director waits for
// it) and then `later` (later waves, the boss, the weapons cards give).
// Watch then play (wave 4, track V; CONTRACT §9b; research/watch/PLAN.md). A player in a room goes live from the
// game's own menu (#gf-live: the same button and calls as boot.js) or from the friends page. A page opened as the
// stream's viewer (net.watching: the friends page loads it with gf_mode=watch) is a copy with no player of its own:
// the core's role is `viewer`, every player in the stream is a replica from the host's snapshots, nothing is sent,
// input and the menu are off. The camera is the streamer's eyes (first person, as boot.js does for a first-person
// game, and as the stream is watched on the other engines: what the streamer sees): the core looks through the
// streamer's replica (gf/forge/players.js `follow`), with their weapon in the hand as the host says it moves, their
// crosshair, their hits' numbers and their red edge. A player's own things stay off a viewer's screen (the card,
// the menu, prompts, rounds, touch buttons): WATCH_KEEPS below is what stays. Until the streamer is in the core's
// world the camera circles the arena.
import * as gf from '../../gf-assets.js';
import { createAudio } from '../../../audio/audio.js';
import audioPresets from '../../../audio/presets.json' with { type: 'json' };
import KIT from '../kit.js';
import { assets } from '../assets/core.js';
import { createRng, seedOf } from './rng.js';
import { pickQuality, deviceFacts, drawsOnCard } from './quality.js';
import { pixelRatioFor, watchPixelRatio, PIXEL_BUDGET } from './resolution.js';
import { createInput } from './input.js';
import { createUI } from '../ui/ui.js';
import { createHud } from '../ui/hud.js';
import { createMenu, loadSettings } from '../ui/menu.js';
import { startLoading } from '../ui/loading.js';
import { listenForHost, host as pageHost } from '../net/host.js';
import { createSession, seatPalette } from '../net/session.js';
import { listenForLoadout, pageLoadout } from '../net/looks.js';
import { createFair } from './fair.js';
import * as refusals from './refusals.js';
import { seedRules, readOnlyView, refusedPress, watchKit, setupFailed, frameFailed } from './guard.js';
import { createEventLog } from './events.js';
import { createPlay } from './play.js';
import { stepAsked, createStepper } from './step.js';
import { net } from '../../mp/net.js';
import { createHost, BTN, KIND, ENTITY_FLAG, BUILD_SHA256, VERSION as FORGE_VERSION } from '../../forge/host.js';
import * as forgeTables from '../../forge/tables/index.js';
import * as forgeLook from '../../forge/look.js';
import * as forgeWorld from '../../forge/world.js';
import { createForgePlayers, project } from '../../forge/players.js';
import { runForgeShow } from '../../forge/show.js';
import { createFeel } from '../../forge/feel.js';
import { createRender } from '../../forge/render.js';
import { loadFight } from '../../forge/fight.js';
import { createCards } from '../../forge/cards.js';
import { createShop } from '../../forge/shop.js';
import { createGovernor, lookFor, QUALITY, loadChoice, saveChoice, settingsRow } from '../../forge/governor.js';
import { forgePart, frameMeter, aimOf } from '../../forge/observe.js';
import { loadMechanics } from '../../forge/mechanics.js';

export const VERSION = KIT.version;
/** The runtime and its profile as the observation names them (runtimes/CONTRACT.md §6.1): forge has no profiles. */
export const RUNTIME = 'forge', PROFILE = null, KIT_NAME = 'xgames-kit';
/** What of the HUD a stream's viewer keeps (direct children of #gf-ui): what everyone in the round sees (names, the
 *  wave with its clock, goal and boss, banners, everyone's health, who is down and who is choosing a card) and what
 *  the streamer's own screen shows of the fight (their crosshair, their hits' numbers, their combo, the red edge and
 *  the low-health stages). Never a player's own card, menu, prompts, rounds or touch buttons. */
export const WATCH_KEEPS = ['.gf-plates', '.gf-bars', '.gf-fsbtn', '.gf-top', '.gf-scores', '.gf-banner', '.gf-goal', '.gf-bossbar',
  '.gf-feel-edge', '.gf-feel-low', '.gf-feel-nums', '.gf-feel-cross', '.gf-feel-combo', '.gf-fh-friends', '#gf-forge-reward', '.gf-forge-down'];

export async function boot({ rules = {} } = {}) {
  startLoading({ theme: 'grim' });   // track U: the kit's loading view (ui/loading.js), up until window.__game exists
  listenForHost(window);
  listenForLoadout(window);
  const params = new URLSearchParams(location.search);
  const subject = params.get('gf-show');
  const backdrop = params.get('gf-backdrop') === '1' && !net.active;
  // a stream's viewer (CONTRACT §9b): the friends page's watch mode loads this page for a round being streamed; it is a
  // viewer from its first frame to its last (Join opens the room's own link: another page)
  const viewer = net.active && !!net.watching;
  const ctx = { kit: { name: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, forge: FORGE_VERSION }, onFrame: [], time: { now: 0, dt: 0, round: 0, left: 0 }, gf: eagerAssets(gf) };
  let ui = null;
  try {
    await assets.init({ configs: ['game', 'look', 'world', 'characters'] });
    // The lobby's backdrop (the waiting room draws the world behind it) is left out on a machine that draws on its
    // processor, as boot.js leaves it out (the first CI runs of gamesfun-kit, 2026-10-11: two pages drawing a world in
    // software took both processors of a runner and a friend's join ran into the kit's 20 s limit). The lobby keeps
    // its seat colours. A round is never a backdrop, and the forge loader shows its own screen for a round that has
    // only software to draw with.
    if (backdrop && !drawsOnCard()) {
      net.describe?.({ colors: seatPalette(assets).slice(0, 8).map(String) });
      document.documentElement.dataset.gfBackdrop = 'off';
      return;
    }
    const game = assets.config('game'), lookCfg = assets.config('look'), worldCfg = assets.config('world');
    ctx.config = game; ctx.assets = assets;
    ctx.fair = createFair(ctx);
    document.title = game.text?.title ?? game.title ?? document.title;
    // the css slots, from the configs already here (gf.applyCss asks for a slot's file again for every such slot: the
    // same config/game.json five more times, one after another, before anything else could start)
    for (const s of assets.manifest?.slots ?? []) {
      if (!s.css || s.source?.pointer === undefined) continue;
      let v; try { v = assets.value(s.id, null); } catch { v = null; }
      if (v != null && typeof v !== 'object') document.documentElement.style.setProperty(s.css, s.type === 'text' ? JSON.stringify(String(v)) : String(v));
    }
    // the arena's files, asked for now: they come in while the core's wasm compiles and its device is made
    if (!subject) ctx.gf.want(arenaFiles(assets, worldCfg, assets.config('characters')));
    const worldMode = game.round?.mode === 'world';
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
    // the pixels drawn (CONTRACT §6i): set before the engine starts, so its first frame is the screen's own size
    const budget = quality.pixelBudget ?? PIXEL_BUDGET[quality.name] ?? PIXEL_BUDGET.high;
    // The governor (gf/forge/governor.js; wave 3, track M): when frames stay short for a few seconds the game draws
    // less (the scene's render scale, particles, a kill's pieces, shadowed fires) and takes it back when there is room.
    // The canvas keeps its pixels (the HUD and the text stay sharp): the shared kit's guard, which sized the canvas
    // down and never up, is not used here. The player's own toggle in Settings; ?gf-governor=1|0 for QA; and off
    // under automation unless asked for, so a verify run's pictures do not change with the machine's load.
    const choice = loadChoice(gameId);
    const gov = createGovernor();
    gov.on = params.get('gf-res') === 'fixed' ? false : params.get('gf-governor') !== null ? params.get('gf-governor') !== '0' : choice.governor !== false && !globalThis.navigator?.webdriver;
    const res = { target: 1, ratio: 1, budget };
    let forge = null;
    const size = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      res.target = pixelRatioFor({ dpr, width: innerWidth, height: innerHeight, budget });
      res.ratio = Math.max(Math.min(dpr, 1), res.target);
      const max = forge?.maxDimension?.() ?? 8192;
      canvas.width = Math.max(1, Math.min(max, Math.round(innerWidth * res.ratio)));
      canvas.height = Math.max(1, Math.min(max, Math.round(innerHeight * res.ratio)));
      forge?.resize(canvas.width, canvas.height);
    };
    size();

    // ---- the engine: the Rust core on WebGPU, or the kit's own screen when the browser has none ----
    // the wasm the page began to download and compile with its first bytes (index.html), when it did
    // (it is one build's: the loader takes it only when that is the build it picks for this device)
    const earlyWasm = globalThis.__gfEarly?.wasm ?? null;
    const early = await (earlyWasm?.module ?? Promise.resolve(null)).catch(() => null);
    try { forge = await createHost(canvas, early ? { early: { backend: earlyWasm.backend ?? 'webgpu', module: early } } : undefined); }
    catch (e) { if (e?.name === 'NoWebGPU') return unsupported(ctx, game, e); throw e; }
    ctx.forge = forge;
    // the renderer from JS (track R): bodies, held items, the first-person layer, effects
    ctx.render = createRender(forge);
    const resize = () => { size(); if (gov.level) applyLook(); };   // a governor's step is a share of this canvas
    addEventListener('resize', resize); watchPixelRatio(globalThis, resize); size();
    ctx.resolution = res;
    // the slot table: every slot an index the core draws with; coverage and sight read the indices back
    const slotIds = assets.ids(), slotIdx = new Map(slotIds.map((id, i) => [id, i]));
    ctx.slotIds = slotIds; ctx.slotIndex = id => slotIdx.get(id) ?? 0xffffffff;
    // the data tables (spec.forge, filled by create; every value a slot, so Studio's overrides are in `game` already)
    // the shared mechanics that run on forge (gf/forge/mechanics.js: components/<id>/impl/forge); one may shape the tables
    const mech = await loadMechanics(game);
    const tables = forgeTables.fill(mech.tables(game.forge ?? {}));
    ctx.tables = tables;
    forge.loadTables(forgeTables.pack(tables));
    const camCfg = game.controller?.camera?.first ?? {};
    // packed for the quality tier (look.js TIERS: a low tier's shadow map, lights a frame, AA and particle budget)
    // with the governor's step: the render scale never under one CSS pixel of this screen
    const applyLook = () => {
      const floor = Math.min(1, Math.min(globalThis.devicePixelRatio || 1, 1) / (res.ratio || 1));
      forge.setLook(forgeLook.pack(lookFor(lookCfg, quality.name, gov.step, { TIERS: forgeLook.TIERS, floor, width: canvas.width }), quality.name));
      forge.lens(Number(tables.player?.fov) || Number(camCfg.fov) || 68, 0.05, 200);
    };
    applyLook();
    /** The governor's level, everywhere it reaches: the look's values, and the pieces a kill leaves (forge-feel). */
    const applyLevel = () => { applyLook(); forge.cmd.raw(QUALITY, [], [gov.step.rest, gov.step.flying]); };
    const torch = forgeLook.torch(lookCfg);
    const lightsAt = t => (ctx.world?.lights ?? []).map(l => ({ x: l.at[0], y: l.at[1], z: l.at[2], range: torch.range, color: torch.color, intensity: torch.intensity * forgeLook.flicker(t, l.seed ?? 1, torch.flicker) }));

    if (subject) {
      if (pageLoadout().loadout != null) assets.setLoadout('show', pageLoadout().loadout);
      return await runForgeShow(ctx, subject, { worldCfg, lightsAt, observe: { coverage: () => coverageReport(), slots: () => slotsReport() } });
    }
    // what waits for the menu (gf/forge/first.js): the kit's loaders hand their jobs over, `first` runs once the menu
    // has been drawn and `later` after it (runSteps, from the frame loop)
    const steps = { first: [], later: [] }, stepState = { started: false, first: false, later: false, ms: {} };
    // QA (?gf-load=all): everything before the menu, as wave 2 loaded, to measure what the steps save
    if (params.get('gf-load') !== 'all') ctx.after = (step, fn) => { (steps[step] ?? steps.later).push(fn); };
    const runSteps = async () => {
      if (stepState.started) return;
      stepState.started = true;
      const t0 = performance.now();
      for (const k of ['first', 'later']) {
        await Promise.all(steps[k].splice(0).map(fn => Promise.resolve().then(fn).catch(e => console.warn(`gf-forge: a ${k} load failed (${e?.message ?? e})`))));
        stepState[k] = true; stepState.ms[k] = Math.round(performance.now() - t0);
      }
      // the downloads kept for whoever asks twice are let go (a later asker fetches its own)
      setTimeout(() => ctx.gf.forget(), 15000);
    };
    // the rules, for the world's AI (gf/forge/ai.js calls rules.bot and rules.reward; track A)
    ctx.rules = rules;
    ctx.world = await forgeWorld.loadWorld(ctx, worldCfg);
    // what a fight draws beside bodies and the world (gf/forge/fight.js): the first-person arms and weapons by row, a
    // kill's pieces, the coin, weapon pickups, target dummies, the effect pictures
    ctx.fight = await loadFight(ctx);
    const C = game.controller ?? {}, cam = C.camera?.first ?? {};

    // ---- audio, input, UI ----
    const audio = createAudio(await gf.sounds(), { presets: audioPresets.presets, storageKey: backdrop ? undefined : `gf3-${gameId}`, listen: !backdrop, fileUrl: gf.url });
    if (backdrop) audio.muted = true;
    ctx.audio = {
      raw: audio,
      /** play(soundId, {at: {x, y, z}, gainDb, pitch, optional}): at → quieter with distance from the eyes. */
      play(id, opts = {}) {
        const o = { ...opts };
        if (o.at && ![o.at.x, o.at.y ?? 0, o.at.z].every(Number.isFinite)) delete o.at;   // a place not known yet plays unplaced
        if (o.at) { const e = forge.eye(); const d = Math.hypot(o.at.x - e.x, (o.at.y ?? e.y) - e.y, o.at.z - e.z); o.gainDb = (o.gainDb ?? 0) - Math.min(18, Math.max(0, (d - 4) * 0.6)); delete o.at; }
        if (!audio.has(id)) { if (!o.optional) refusals.refuse('sound-unlisted', `ctx.audio.play("${id}"): no sound with that id in assets.json → sounds → sounds (list it there, or pass { optional: true })`, id); return null; }
        return audio.play(id, o);
      },
      has: id => audio.has(id), stop: id => audio.stop(id),
    };
    const input = createInput(canvas);
    ctx.input = input;
    ui = createUI(ctx, { text: game.text ?? {}, controls: game.controls ?? {}, theme: 'grim' });   // track U: the forge theme (ui/theme.js)
    ctx.ui = ui;
    if (worldMode) { ui.timer(false); ui.score([]); }
    let menu = null;
    const openPause = () => { if (!menu || menu.view || !['playing', 'countdown'].includes(ctx.round?.phase)) return; menu.pause(); try { document.exitPointerLock?.(); } catch {} };
    const hud = createHud(ctx, ui, { onMenu: () => openPause() });
    // ctx.hud first: the forge HUD (made by the feel) tells it which widgets it draws itself (hud.drawnBy, measure 21)
    ctx.hud = readOnlyView(hud, ['goalText', 'observe', 'fullscreen', 'drawnBy'], 'ctx.hud'); ui.goalTo = t => { if (refusals.goalCall(t)) hud.goal(t); };
    // the feel's DOM side (track F: damage numbers, combo, the red edge, low-health stages, crosshair, ammunition, the death recap)
    ctx.feel = createFeel(ctx);
    hud.setGoal(refusals.startGoal(game));

    // ---- mechanics: those with a forge implementation run (gf/forge/mechanics.js); the rest keep their params for the rules ----
    const list = mech.create(ctx);
    ctx.mechanics = { get: id => list.find(m => m.id === id) ?? null, list: () => list.slice() };
    ctx.mechanicsList = list;
    ctx.aimed = false;

    // ---- players and the round: the shared session over the core's players, bots among them (forge-ai) ----
    const T = game.text ?? {};
    const players = { api: null };
    // live co-op: the host's snapshot goes out with the round's world message at its rate (12 a second at most), and
    // only then is it taken; a joiner's page load is an epoch (the host restarts its input queue on a reload)
    const WORLD_MS = 1000 / 12 + 0.5;
    let lastSnap = -1e9;
    const coreWorld = () => { const t = performance.now(); if (t - lastSnap < WORLD_MS) return null; lastSnap = t; return { f: forge.snapshotB64() }; };
    const epoch = globalThis.crypto?.getRandomValues?.(new Uint32Array(1))[0] ?? ((Math.random() * 2 ** 32) >>> 0);
    // bots fill seats when playing alone, as boot.js does (?bots=N, else players.max − 1 unless players.bots is false);
    // forge bots are core players driven by forge-ai (gf/forge/ai.js sets ctx.makeBot; track A). A friends round has
    // no bots (the session's rule)
    const botParam = params.get('bots'), maxPlayers = Math.max(1, game.players?.max ?? 4);
    // the flow (kit/loops/<id>, as boot.js loads it): config/game.json → round.flow names how the round is played; a
    // forge game naming none runs the timed round (the session's default). gf-forge wave 6: an endless run (no clock;
    // the rules end it when everyone has fallen)
    const flowId = game.round?.flow;
    const flowMod = typeof flowId === 'string' && flowId !== 'round' ? await import(`../loops/${flowId}/index.js`) : null;
    const botCount = backdrop ? 0 : botParam !== null ? Math.max(0, Math.min(7, Number(botParam) || 0)) : game.players?.bots === false ? 0 : maxPlayers - 1;
    // (a viewer: the players are told whom the stream follows; the HUD's wave rides the stream's key frames, so a
    // viewer who tunes in mid-wave knows which it is)
    const watchState = { session: null };
    ctx.watching = () => !!watchState.session?.watching;
    ctx.watched = () => players.api?.watched?.() ?? null;
    const session = createSession(ctx, { rules, spawnCharacter: null, characterFor: () => ({}), rng, botCount, onPhase: ph => onPhase(ph),
      createPlayers: c => (players.api = createForgePlayers(c, { host: forge, live: net.active, epoch, watching: viewer, follow: () => watchState.session?.watch?.follow?.id ?? null })),
      coreWorld: net.active && !viewer ? coreWorld : null,
      coreWatch: { key: () => ctx.forgeHud?.watchKey?.() ?? null, take: d => ctx.forgeHud?.watchStart?.(d) }, flow: flowMod });
    watchState.session = session;
    // QA only (the live gate: multiplayer.json check.query, which create writes for a forge game): with ?gf-gate=1 the
    // rules end no round, so the gate's later steps find it running; the clock and the host's End round still end it
    const gateRound = params.get('gf-gate') === '1';
    ctx.round = {
      get phase() { return session.round.phase; }, get number() { return session.round.number; },
      get winners() { return session.round.winners; }, get reason() { return session.round.reason; },
      end: (reason = 'ended', winners = null) => (gateRound ? undefined : session.end(reason, winners)),
    };
    await session.start();
    const me = ctx.me;
    me.actions = input.actions;
    ctx.fight?.sleeve?.();
    // the run (wave 2, track G; gf/forge/cards.js): the reward between waves with its inspector, over the core's cards
    ctx.cards = createCards(ctx);
    // the pedlar's cart and the paid revive (gf-forge wave 7, track P; gf/forge/shop.js), over the core's purse and cart
    ctx.shop = createShop(ctx);
    // the host replays each joiner's inputs (forge-core net.rs); a joiner's batches come as 'fi' (base64), to the host only
    if (net.active && ctx.host) net.on('fi', (b, from) => { const n = players.api.nid(from); if (n && typeof b === 'string') forge.net.pushInputs(n, b); });
    let lastLatest = null, lastInputs = -1e9;
    // the core's recent events for the observation (hits, kills, spawns, rule events): what F, A and R make, as verify sees it
    const eventLog = [];
    forge.on('*', e => { if (['sound', 'motion', 'camera', 'light', 'particles', 'ui'].includes(e.kind)) return; eventLog.push({ t: Math.round(ctx.time.now * 1000) / 1000, ...e }); if (eventLog.length > 256) eventLog.splice(0, eventLog.length - 256); });
    forge.tick(0); players.api.fromCore();
    ui.crosshair(false);
    ctx.fair.setup();
    // the kit's own elements (CONTRACT §6g) are kept as the kit means them from here on (kit/core/guard.js)
    const kitGuard = watchKit({ layer: ui.root, items: () => [{ el: ui.root, name: "the kit's layer (#gf-ui)", want: true }, ...hud.kitItems(), ...(menu?.kitItems() ?? [])] });
    if (params.get('gf-ui') === '0' || backdrop) kitGuard.off = true;
    // the kit's event log (gf/three/core/events.js; gates C and D): every press, score and sound, and the core's hits,
    // kills and the rule events that name a player, as the part `forge` (gf/forge/observe.js)
    const forgeEvents = forgePart(forge, { playerOf: n => (n > 0 ? players.api.byNid(n) : null) });
    const kitLog = createEventLog(ctx, { list: [forgeEvents], modules: new Map([['forge', { manifest: forgeEvents.manifest }]]) });
    ctx.events = Object.freeze({ count: kitLog.count });
    // the play feed (gf/three/core/play.js; builder/play): the same numbers as every runtime's, from the kit's event log
    const playFeed = createPlay(ctx, { log: kitLog, list: [forgeEvents, ...list], modules: new Map([['forge', { manifest: forgeEvents.manifest }]]), rows: () => session.round.rows });
    await mech.setup(ctx);
    try { await rules.setup?.(ctx); } catch (e) { console.error(e); setupFailed('rules', e); throw e; }

    function onPhase(ph) {
      for (const p of ctx.players.owned()) if (p.controller) p.controller.enabled = ph === 'playing';
      if (ph === 'countdown') { menu?.close(); ctx.audio.play('round-countdown', { optional: true }); }
      if (ph === 'playing' && worldMode) { ui.hideCard(); if (menu?.view && !menu.paused) menu.close(); if (T.welcome) ui.banner(T.welcome, 2); canvas.focus(); return; }
      if (ph === 'playing') { ui.cover('results', false); ui.hideCard(); if (menu?.view && !menu.paused) menu.close(); ui.banner(T.go ?? 'Go!', 1.2); ctx.audio.play('round-go', { optional: true }); canvas.focus(); }
      if (ph === 'lobby') { ui.hideCard(); if (!session.live) menu?.home(); else if (worldMode) menu?.close(); try { document.exitPointerLock?.(); } catch {} }
      if (ph === 'results') {
        menu?.close();
        const w = session.round.winners ?? [];
        if (session.live) { ui.cover('results', true); ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true }); try { document.exitPointerLock?.(); } catch {} return; }
        const names = w.map(id => ctx.players.get(id)?.name ?? id);
        const title = names.length ? (T.wins ?? '{name} wins!').replace('{name}', names.join(' & ')) : session.round.reason === 'lost' ? (T.lost ?? 'Defeated') : (T.draw ?? 'Round over');
        ui.results({ title, rows: session.round.rows ?? [], winners: w,
          onAgain: session.live || game.round?.replay === false ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.replay(); },
          onMenu: session.live ? null : () => { ctx.audio.play('ui-click', { optional: true }); session.toLobby(); } });
        ctx.audio.play(w.includes(ctx.me?.id) ? 'round-win' : 'round-end', { optional: true });
        try { document.exitPointerLock?.(); } catch {}
      }
    }
    const friendsPage = () => new URL('gf/mp/index.html', location.href).href;
    menu = createMenu(ctx, ui, {
      game, live: session.live, world: worldMode, gameId, host: pageHost, players: () => ctx.players.list(),
      onPlay: () => { if (session.round.phase === 'lobby') { ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); } },
      onFriends: () => { if (pageHost.present && pageHost.offers.friends) pageHost.friends(); else location.href = friendsPage(); },
      onResume: () => { menu.close(); canvas.focus(); },
      onLeave: () => { menu.close(); session.toLobby(); },
      onQuality: () => { if (!session.live) location.reload(); },
      room: session.live ? { info: () => net.room, leave: () => { menu.close(); net.leave(); }, end: worldMode ? null : () => { menu.close(); session.end('ended'); canvas.focus(); },
        // watch then play (gf-multiplayer 1.6.0; wave 4): Go live, and the stream's state while it is on, as boot.js
        // (net.live is undefined on a gf/mp older than 1.6.0: the menu then offers no Go live)
        live: () => net.live ?? null, goLive: () => { menu.close(); canvas.focus(); net.live?.start?.(); }, showLive: () => { menu.close(); canvas.focus(); net.live?.share?.(); },
        // voice chat on Studio's play page (gf-multiplayer 1.7.4): the row opens Studio's voice panel over the game
        voice: () => net.live?.voice ?? null, voiceOpen: () => net.live?.voiceOpen?.(), voiceClose: () => net.live?.voiceClose?.() } : null,
    });
    ctx.menu = readOnlyView(menu, ['view', 'paused', 'observe'], 'ctx.menu');      // read-only for rules
    if (session.live) net.live?.onChange?.(() => menu.redraw?.());
    if (params.get('gf-ui') === '0' || backdrop) ui.root.style.display = 'none';
    if (backdrop) { input.enabled = false; canvas.tabIndex = -1; }
    // a viewer keeps what WATCH_KEEPS lists and nothing else of the HUD; its canvas takes no clicks (no pointer lock
    // with nothing to look round with)
    const watchStyle = document.createElement('style');
    watchStyle.textContent = `#gf-ui.gf-watching > ${WATCH_KEEPS.map(s => `:not(${s})`).join('')}{display:none !important}
      #gf-ui.gf-watch-overview > :not(.gf-fsbtn){display:none !important}`;
    document.head.append(watchStyle);
    const watchUi = on => { if (ui.root.classList.contains('gf-watching') !== on) { ui.root.classList.toggle('gf-watching', on); canvas.style.pointerEvents = on ? 'none' : ''; } };
    if (viewer) watchUi(true);
    if (session.live && worldMode) { session.arm(); session.ready(); }
    else if (session.live) { ui.waiting(); session.arm(); session.ready(); }
    else if (params.get('gf-autoplay') === '1') session.beginCountdown();
    else menu.home();
    addEventListener('keydown', e => {
      if (backdrop || session.watching) return;
      const a = document.activeElement, onControl = a && (a.tagName === 'BUTTON' || a.tagName === 'INPUT');
      if ((e.code === 'Enter' || e.code === 'Space') && !onControl && session.round.phase === 'lobby' && menu.view === 'home') { if (refusedPress(e, 'Play (Enter)')) return; e.preventDefault(); menu.close(); ctx.audio.play('ui-click', { optional: true }); session.beginCountdown(); }
      if (e.code === 'Escape' && !e.defaultPrevented && !menu.view && ['playing', 'countdown'].includes(session.round.phase)) { e.preventDefault(); openPause(); }
    });
    // The mouse lost while playing (review of Zombie Town v8, 2026-10-12): with the mouse captured a browser keeps the
    // first Esc for itself and only frees the mouse, so "Esc: menu" took two presses. When the browser lets the capture
    // go (its Esc, the tab or window left) and nothing of the page let it go (a script's exitPointerLock: the cart, the
    // reward, the results, the menu, a tool), the pause menu opens at once in a game played alone: one Esc pauses. In a
    // friends round nothing pauses and the menu carries End round, so there the line below says to click instead (Esc
    // then opens the menu). A touch screen never has the capture. Forge only: the shared menu is as it was elsewhere.
    let hadLock = false, letGo = -1e9;
    const pageExit = document.exitPointerLock;
    if (typeof pageExit === 'function') document.exitPointerLock = function (...a) { letGo = performance.now(); return pageExit.apply(this, a); };
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement === canvas) { hadLock = true; return; }
      if (!hadLock) return;
      hadLock = false;
      if (performance.now() - letGo < 1000 || session.live) return;
      if (backdrop || session.watching || input.touch || menu.view || ui.covered || !['playing', 'countdown'].includes(session.round.phase)) return;
      openPause();
    });
    // "Click to fight": back in a fight with the mouse free after it was captured (the cart closed on its clock, Resume,
    // a lost capture), a line in the middle says the first click takes the mouse back (it never fires; review of v8:
    // "the first click only re-takes the mouse")
    const relockEl = document.createElement('div'); relockEl.className = 'gf-forge-relock'; relockEl.id = 'gf-relock';
    const relockCss = document.createElement('style');
    relockCss.textContent = '#gf-ui .gf-forge-relock{position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);display:none;padding:10px 22px;border-radius:3px;background:rgba(12,9,7,.82);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--gf-forge-accent,#d3a446) 60%,transparent);font:700 20px/1.2 var(--gf-forge-serif,Georgia,serif);letter-spacing:.04em;color:var(--gf-forge-parchment,#e4d2b7);pointer-events:none;white-space:nowrap;z-index:6}#gf-ui .gf-forge-relock.on{display:block}';
    document.head.append(relockCss); ui.root.append(relockEl);
    let everLocked = false;
    const relock = () => {
      if (document.pointerLockElement === canvas) everLocked = true;
      const on = everLocked && !document.pointerLockElement && !input.touch && input.cursorMode === false && !input.lockRefused && !backdrop && !session.watching && !menu.view && !ui.covered && session.round.phase === 'playing';
      if (on) { const t = T.clickToFight ?? 'Click to fight'; if (relockEl.textContent !== t) relockEl.textContent = t; }
      relockEl.classList.toggle('on', on);
    };

    // ---- the observation (CONTRACT §5, §8 forge): the same names verify reads, from what the core drew ----
    const watchCam = { on: null, a: 0, seen: null };
    const overview = () => (backdrop || session.watching) && watchCam.on !== true;
    const r2 = v => Math.round(v * 100) / 100;
    // (track W: `backend` is the build that draws on this device, 'webgpu' | 'webgl2', and `wasm` that build's hash)
    const forgeState = () => ({ version: FORGE_VERSION, backend: forge.backend ?? 'webgpu', wasm: forge.wasmSha256 ?? BUILD_SHA256, after: { ...stepState, ms: { ...stepState.ms } }, frames: forge.frames(), draws: forge.draws(), ticks: Number(forge.forge.ticks()),
      hz: forge.hz, steps: Number(forge.forge.steps()), droppedSeconds: Math.round(forge.forge.dropped_seconds() * 1000) / 1000, plugins: forge.plugins(), tables: forge.forge.tables_version(),
      recoveries: forge.recoveries(), lost: forge.lost(), timing: forge.timing, info: forge.info(), render: ctx.render.stats(), fight: ctx.fight?.observe?.() ?? null });
    const observe = () => ({
      kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: session.round.phase, round: session.round.number, seed, quality: quality.name,
      time: { now: r2(ctx.time.now), round: r2(ctx.time.round), left: r2(ctx.time.left) },
      me: me.id, host: ctx.host, live: session.live, backdrop, view: menu.view ?? ui.view, paused: menu.paused && !session.live,
      players: ctx.players.list().map(p => ({ id: p.id, name: p.name, score: p.score, alive: p.alive, bot: p.isBot, local: p.local, x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z), anim: p.anim, color: p.color, ring: null, ...ctx.fair.observe(p) })),
      fair: ctx.fair.summary(),
      refusals: refusals.list(),
      winners: session.round.winners, reason: session.round.reason, results: session.round.rows,
      shared: ctx.shared.snapshot(),
      rules: (() => { try { return rules.observe?.(ctx) ?? null; } catch { return null; } })(),
      modules: { standins: { look: false, world: false, character: !forge.drawsBodies() }, mechanics: list.map(m => ({ id: m.id, standin: m.standin })) },
      net: session.gateBlock(ui.covered),
      // watch then play (CONTRACT §9b): a viewer's copy, whom it follows and whether the camera has them (the core
      // holds the streamer and looks through their eyes)
      watch: session.watching ? { follow: session.watch?.follow ?? null, live: !!session.watch?.live, target: players.api.watched()?.id ?? null, camera: overview() ? 'overview' : 'first' } : null,
      world: null,
      forge: { ...forgeState(), net: forge.net.stats(), bodies: players.api.bodies() },
    });
    const r3 = v => Math.round(v * 1000) / 1000;
    const lensFov = () => Number(tables.player?.fov) || Number(camCfg.fov) || 68;
    // (`dir`: where the view looks, check 34: a viewer sees as the streamer does. A viewer's yaw and pitch are the
    // watched player's, as drawn)
    const cameraOf = () => {
      const c = forge.drawnCamera(), cp = Math.cos(c.pitch), seen = session.watching ? players.api.watched() : null;
      return { mode: overview() ? 'overview' : 'first', fov: lensFov(), yaw: overview() ? c.yaw + Math.PI : (seen ?? me).yaw ?? null, pitch: overview() ? c.pitch : (seen ?? me).pitch ?? null, cursorMode: !!input.cursorMode, cursor: input.cursorMode || null, aimFree: !!input.aimFree,
        eye: [c.x, c.y, c.z].map(r3), dir: [-Math.sin(c.yaw) * cp, Math.sin(c.pitch), -Math.cos(c.yaw) * cp].map(r3), sensitivity: cam.sensitivity ?? 0.0024, lookScale: input.lookScale ?? 1, invertY: !!input.invertY,
        crosshair: !!ui.crosshairOn, lockRefused: !!input.lockRefused, locked: !!input.locked, following: !!input.following, fullscreen: hud.fullscreen?.() ?? null };
    };
    /** Where a world point is on this screen, in CSS pixels (check 34: a viewer's nameplates sit over the characters). */
    const screenOf = (x, y, z) => { const v = project(forge.drawnCamera(), { x, y, z }, innerWidth / innerHeight); return v ? { x: r2((v.x * 0.5 + 0.5) * innerWidth), y: r2((-v.y * 0.5 + 0.5) * innerHeight), front: true } : { x: -1, y: -1, front: false }; };
    // stepped time (QA only, gf/three/core/step.js): asked for in the address, alone; never in a live round or a backdrop
    const stepped = stepAsked(params, { live: session.live, backdrop });
    const stepper = stepped ? createStepper({ frame: f => frame(0, f) }) : null;
    const meter = frameMeter();
    window.__game = Object.freeze({
      kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, seed, quality: quality.name,
      get phase() { return session.round.phase; },
      get ready() { return true; },
      get players() { return observe().players; },
      snapshot: () => JSON.parse(JSON.stringify(observe())),
      coverage: () => coverageReport(),
      slots: () => slotsReport(),
      controls: () => JSON.parse(JSON.stringify(controlsReport())),
      // which sounds played, by id, as the audio kit counted them; dropped: plays the kit did not start, by reason
      sounds: () => JSON.parse(JSON.stringify({ plays: audio.stats?.plays ?? {}, dropped: audio.stats?.dropped ?? {} })),
      panels: () => JSON.parse(JSON.stringify(ui.panels?.observe?.() ?? { open: [], covered: false, opened: 0, closed: 0, refused: 0, last: null })),
      events: o => JSON.parse(JSON.stringify(kitLog.read(o ?? {}))),     // the event log (gf/three/core/events.js; gates C and D)
      play: () => JSON.parse(JSON.stringify(playFeed.read())),             // the play feed (gf/three/core/play.js; gate D's play leg)
      menu: () => JSON.parse(JSON.stringify(menu.observe())),
      hud: () => JSON.parse(JSON.stringify({ phase: session.round.phase, covered: ui.covered, ...hud.observe() })),
      looks: () => JSON.parse(JSON.stringify({ me: me.id, local: ctx.looks?.observe?.() ?? null, slots: assets.playerLooks(),
        players: ctx.players.list().map(p => { const r = assets.loadout(p.id); return { id: p.id, name: p.name, bot: p.isBot, local: p.local, seat: p.seat, color: p.color, key: r?.key ?? '', advertised: r?.advertised ?? '', values: r?.loadout.values ?? {}, files: r?.loadout.files ?? {}, dropped: [...(r?.dropped ?? [])], drawn: players.api.drawnLook(p), shots: null }; }) })),
      camera: () => JSON.parse(JSON.stringify(cameraOf())),
      project: (x, y, z) => screenOf(x, y, z),
      sight: ids => sightReport(ids),
      // the screen (runtimes/CONTRACT.md §6.1): its pixels, the frame cost, the graphics API that draws; forge's governor too
      screen: () => JSON.parse(JSON.stringify({ dpr: globalThis.devicePixelRatio || 1, css: [innerWidth, innerHeight], buffer: [canvas.width, canvas.height], ratio: res.ratio, target: res.target, budget: res.budget, quality: quality.name,
        ...meter.observe(), api: forge.backend ?? 'webgpu', gpu: String(forge.gl?.renderer ?? forge.info?.() ?? '').slice(0, 160), slow: gov.observe().last, guard: gov.on, governor: gov.observe() })),
      // stepped time (QA only, gf/three/core/step.js): present only when the address carries ?gf-step=1 and the round is not live
      ...(stepped ? { stepped: true, step: (ms, opts) => JSON.parse(JSON.stringify({ ...stepper.step(ms, opts), now: ctx.time.now, round: ctx.time.round, phase: session.round.phase })) } : {}),
      // forge's own (runtimes/CONTRACT.md §6.4): what the core holds, under names tracks R, F and A fill
      forge: Object.freeze({ state: () => forgeState(), mechanics: () => JSON.parse(JSON.stringify(mech.observe())), loseDevice: () => forge.loseDevice(), net: () => forge.net.stats(), events: (since = 0) => JSON.parse(JSON.stringify(eventLog.filter(e => e.t >= since))),
        bodies: () => JSON.parse(JSON.stringify(bodiesReport())),
        enemies: () => JSON.parse(JSON.stringify(enemiesReport())),
        hits: (since = 0) => JSON.parse(JSON.stringify(eventLog.filter(e => (e.kind === 'hit' || e.kind === 'kill') && e.t >= since))),
        wave: () => JSON.parse(JSON.stringify(waveReport())),
        entities: () => forge.entities(), players: () => forge.players(), project: (x, y, z) => project(forge.drawnCamera(), { x, y, z }, innerWidth / innerHeight),
        // track F: the feel's DOM side as shown, the core's stats and the death recap
        feel: () => JSON.parse(JSON.stringify({ shown: ctx.feel?.observe() ?? null, stats: ctx.feel?.stats() ?? null, recap: ctx.feel?.recap() ?? null })),
        // track R, as the wave 1b integration drives it: what the last frame drew (render.js STATS: actors, rigid
        // models, particles, flashes, the first-person layer and its muzzle flash), how one body was drawn (its hit
        // flash, eye glow and tint), and the first-person weapon's sockets
        drawn: () => JSON.parse(JSON.stringify(ctx.render.stats())),
        actor: net => JSON.parse(JSON.stringify(ctx.render.look(net))),
        fp: () => JSON.parse(JSON.stringify(ctx.render.fp.sockets())),
        // track G (wave 2): the run's facts (the reward, everyone's cards, who is down, the revive under way), the
        // reward screen as shown, down and revive as shown, a table value as this player's cards leave it, and how
        // many entities of each kind the core holds (resting debris among them)
        run: () => JSON.parse(JSON.stringify(ctx.cards?.facts() ?? null)),
        cards: () => JSON.parse(JSON.stringify(ctx.cards?.observe() ?? null)),
        // wave 7 (track P): the pedlar's cart as shown, each player's purse, the paid revive's prompt
        shop: () => JSON.parse(JSON.stringify(ctx.shop?.observe() ?? null)),
        down: () => JSON.parse(JSON.stringify(players.api.down?.() ?? null)),
        value: (path, player) => ctx.cards?.value(path, player) ?? null,
        counts: () => forge.entityCounts(),
        // wave 3 (track M): the governor as it stands; QA: governor(level) goes to a level now
        governor: level => { if (level !== undefined && level !== null) { gov.force(level); applyLevel(); } return JSON.parse(JSON.stringify(gov.observe())); },
        // QA only (like loseDevice): turn this copy's own player to look at a point, as a player would with the mouse
        face: (x, y, z) => { const e = forge.eye(), dx = x - e.x, dy = y - e.y, dz = z - e.z; forge.cmd.look(players.api.nid(me.id), Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz))); } }),
    });
    /** controls() (runtimes/CONTRACT.md §6.1): the camera, the HUD's controls and prompt, and what the crosshair is on:
     *  the nearest enemy, world box or ground along the view (gf/forge/observe.js aimOf; the core has no ray query).
     *  No thrown things on forge (landing null); a friend who is down, near enough to raise, is the one thing to use. */
    function controlsReport() {
      const c = forge.drawnCamera(), cp = Math.cos(c.pitch), eye = [c.x, c.y, c.z], dir = [-Math.sin(c.yaw) * cp, Math.sin(c.pitch), -Math.cos(c.yaw) * cp];
      const a = aimOf(eye, dir, { enemies: enemiesReport(), colliders: worldCfg.colliders ?? [] });
      const near = ctx.players.list().filter(p => p.down && !p.local).map(p => ({ kind: 'revive', id: p.id, name: p.name, at: { x: r2(p.position.x), y: r2(p.position.y), z: r2(p.position.z) }, dist: r2(Math.hypot(p.position.x - me.position.x, p.position.z - me.position.z)) }));
      return {
        camera: 'first', crosshair: !!ui.crosshairOn, aimed: !!ui.crosshairOn, controls: game.controls ?? {}, prompt: ui.promptText, viewport: { w: innerWidth, h: innerHeight },
        aim: { dir: dir.map(r3), dist: a.dist, point: a.point, hit: a.hit, ...(a.net != null ? { net: a.net } : {}), onSelf: false, screen: screenOf(a.point.x, a.point.y, a.point.z) },
        landing: null, interactables: near, mechanics: [],
        me: { x: r2(me.position.x), y: r2(me.position.y), z: r2(me.position.z), alive: me.alive !== false, holding: 0 },
      };
    }
    /** Every body the core animates: who, its slot, its colour, what it holds, drawn by whom (R's skinned renderer or the stand-in). */
    function bodiesReport() {
      const out = [];
      for (const e of forge.entities()) {
        if (!(e.flags & ENTITY_FLAG.ANIMATED)) continue;
        const w = forge.wearOf(e.net), p = e.kind === KIND.PLAYER ? players.api.byNid(e.net) : null;
        const sc = project(forge.drawnCamera(), { x: e.x, y: e.y + 1.0, z: e.z }, innerWidth / innerHeight);
        out.push({ net: e.net, kind: e.kind === KIND.PLAYER ? 'player' : e.kind === KIND.ENEMY ? 'enemy' : String(e.kind), player: p?.id ?? null, slot: w && w.body >= 0 ? ctx.slotIds[w.body] ?? null : null,
          color: w?.color ?? null, held: w && w.held < 255 ? (ctx.tables?.weapons?.[w.held]?.id ?? w.held) : null, hidden: !!w?.hidden, bones: e.boneCount, at: [r2(e.x), r2(e.y), r2(e.z)],
          onScreen: p ? players.api.visible(p, ui.covered) : !!sc && Math.abs(sc.x) < 1 && Math.abs(sc.y) < 1, renderer: forge.drawsBodies() ? 'skinned' : p ? 'standin' : 'none' });
      }
      return out;
    }
    /** Every enemy the core holds (forge-ai's on the host, replicas on a joiner). */
    function enemiesReport() {
      return forge.entities().filter(e => e.kind === KIND.ENEMY).map(e => ({ net: e.net, type: e.type, typeId: ctx.tables?.enemies?.[e.type]?.id ?? null, at: [r2(e.x), r2(e.y), r2(e.z)], hp: r2(e.hp), dead: !!(e.flags & ENTITY_FLAG.DEAD), replica: !!(e.flags & ENTITY_FLAG.REPLICA), speed: r2(e.speed) }));
    }
    /** The wave (forge-ai's director): its own forge-web `ai_wave()` (JSON) when it has one, else the last RULE "wave" (a: number, b: left, c: state). */
    function waveReport() {
      if (typeof forge.forge.ai_wave === 'function') { try { return JSON.parse(forge.forge.ai_wave()); } catch { return null; } }
      const w = [...eventLog].reverse().find(e => e.kind === 'rule' && e.name === 'wave');
      return w ? { number: w.a, left: w.b, state: w.c, t: w.t, from: 'rule' } : null;
    }

    // ---- the frame ----
    const forgeButtons = buttonMapper();
    let last = null, recovering = false, drawn = 0;
    // Follow the streamer's eyes only during play. Between games (and while the next one loads), keep the arena
    // moving instead of holding their last death pose. The initial lobby backdrop uses the same overhead camera.
    const watchCamera = dt => {
      const watch = session.watch;
      const between = ['lobby', 'results', 'loading', 'countdown'].includes(watch?.phase);
      const playing = !backdrop && session.round.phase === 'playing' && !between && watch?.live !== false
        && (watch?.round == null || watch.round === net.round);
      const seen = playing ? players.api.watched() : null;
      if (seen !== watchCam.seen) { watchCam.seen = seen; if (seen?.color) ctx.render?.fp?.sleeve?.(seen.color); }
      if (!!seen !== watchCam.on) { watchCam.on = !!seen; forge.eyes(!!seen); }
      ui.root.classList.toggle('gf-watch-overview', !seen);
      if (seen) return;
      ctx.render?.fp?.visible?.(false);
      const b = ctx.world?.bounds, cx = b ? (b.min.x + b.max.x) / 2 : 0, cz = b ? (b.min.z + b.max.z) / 2 : 0;
      const R = b ? Math.max(6, Math.min(b.max.x - b.min.x, b.max.z - b.min.z) * 0.3) : 8, h = 5.5;
      watchCam.a += dt * 0.12;
      const x = cx + Math.sin(watchCam.a) * R, z = cz + Math.cos(watchCam.a) * R, dx = cx - x, dz = cz - z, dy = 1.2 - h;
      forge.pose(x, h, z, Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    };
    // one frame. In play `t` is the browser's frame time; a stepped frame (gf/three/core/step.js) brings its own dt, one
    // fixed 60 Hz step, and says whether it is drawn (the frames inside a step are not: the core ticks, nothing is drawn)
    const frame = (t, fixed = null) => {
      const raw = fixed ? fixed.dt : last === null ? 0 : Math.max(0, (t - last) / 1000);
      const dt = Math.min(0.1, raw); if (!fixed) last = t;
      const present = !fixed || fixed.draw;
      if (!fixed) meter.frame(raw);
      // the menu has been drawn twice: now what a fight needs, then what later waves need (first.js)
      if (++drawn === 3) runSteps();
      // device loss (a driver reset, a long background tab): a new device gets everything again; no frame meanwhile
      if (forge.lost()) {
        if (!recovering) { recovering = true; forge.recover().then(() => { size(); applyLook(); }).catch(e => console.error(`gf-forge: the device could not be recovered: ${e?.message ?? e}`)).finally(() => { recovering = false; }); }
        return;
      }
      if (gov.frame(raw, { active: session.round.phase === 'playing' && !document.hidden && !menu.view })) applyLevel();
      // Settings: the forge rows beside the kit's own (gf/forge/governor.js settingsRow; the panel is drawn afresh each
      // time it opens)
      if (menu.view === 'settings') {
        settingsRow('gf-governor', 'Lower the quality when the game slows down', { value: gov.on, set: v => { gov.on = v; saveChoice(gameId, { governor: v }); applyLevel(); } });
        ctx.forgeHud?.settings?.(settingsRow, { choice: () => loadChoice(gameId), save: patch => saveChoice(gameId, patch) });
      }
      if (menu.paused && !session.live && ['playing', 'countdown'].includes(session.round.phase)) {
        input.enabled = false; input.update();
        hud.update(0, { phase: session.round.phase, covered: true });
        relock();
        ui.update(0, { left: session.round.phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates: [] });
        kitGuard.tick(performance.now() / 1000);
        if (present) { forge.setLights(lightsAt(ctx.time.now)); forge.render(ctx.time.now); }
        return;
      }
      ctx.time.now += dt; ctx.time.dt = dt;
      const phase = session.round.phase;
      const watching = session.watching;
      input.enabled = phase === 'playing' && !ui.covered && !backdrop && !watching;
      watchUi(watching);
      input.update();
      if (phase === 'countdown') ui.countdown(Math.max(1, Math.ceil(session.round.countdown)));
      session.tick(dt);
      // a joiner: each new world from the host carries the core's snapshot (replicas move toward it; its own player is
      // reconciled), applied before this frame's steps
      if (net.active && !ctx.host) {
        const w = net.shared();
        if (w?.latest && w.latest !== lastLatest) { lastLatest = w.latest; if (typeof w.latest.f === 'string') { try { forge.applyB64(w.latest.f); } catch (e) { console.warn(`gf-forge: a snapshot could not be applied (${e?.message ?? e})`); } } }
      }
      const R = game.round ?? {};
      // the clock the HUD shows is the flow's when it has its own (endless: Infinity, none), else the round's
      ctx.time.round = session.round.clock; ctx.time.left = session.flow?.hudLeft ? session.flow.hudLeft() : Math.max(0, (R.seconds ?? 120) - session.round.clock);
      // the local player's input → the core (looking in radians; the menu's sensitivity is the input's lookScale)
      const n = players.api.nid(me.id), k = cam.sensitivity ?? 0.0024;
      const { held, pressed } = forgeButtons(input), tb = ctx.feel?.touch?.() ?? { held: 0, pressed: 0 };   // track U: the touch buttons' bits (gf/forge/hud.js)
      const gyro = ctx.forgeHud?.gyro?.() ?? { dx: 0, dy: 0 };   // wave 3: gyro aim (gf/forge/hud.js), radians, when the player turned it on
      // (a viewer has no player: no input goes to the core, and nothing to the host)
      if (!watching) forge.cmd.input(n, { mx: input.move.x, mz: input.move.y, dx: input.look.dx * k + gyro.dx, dy: input.look.dy * k + gyro.dy, held: held | tb.held, pressed: pressed | tb.pressed, enabled: !!me.controller?.enabled && input.enabled });
      forge.tick(dt);
      players.api.fromCore();
      if (watching || backdrop) watchCamera(dt);
      // a joiner: this frame's steps of its own player's input, to the host about 20 times a second
      if (net.active && !ctx.host && !watching && t - lastInputs >= 50) { lastInputs = t; const b = forge.net.takeInputs(); if (b) net.send('fi', b, 'host'); }
      // the core's events: sounds by name (declared in assets.json from the tables), rule events to rules.event, the
      // rest to whoever listens (ctx.forge.on). A viewer hears as the streamer does: their own sounds at full level
      forge.route(ctx, rules, { local: watching ? players.api.nid(players.api.watched()?.id) ?? 0 : n });
      try { ctx.feel?.update(dt); } catch (e) { frameFailed('the forge feel', e); }
      try { ctx.cards?.update(dt); } catch (e) { frameFailed('the forge cards', e); }
      try { ctx.shop?.update(dt); } catch (e) { frameFailed('the forge shop', e); }
      try { ctx.fair.update(dt); } catch (e) { frameFailed('fair play', e); }
      try { rules.update?.(ctx, dt); } catch (e) { frameFailed('rules.update', e); }
      for (const fn of ctx.onFrame) fn(dt);
      session.send();
      ui.update(dt, { left: phase === 'playing' && Number.isFinite(ctx.time.left) ? ctx.time.left : null, players: ctx.players.list(), plates: players.api.plates(ui.covered) });
      hud.update(dt, { phase, covered: ui.covered });
      if (!watching) kitGuard.tick(performance.now() / 1000);
      relock();
      if (present) { forge.setLights(lightsAt(ctx.time.now)); forge.render(ctx.time.now); }
    };
    // Stepped time (QA only): the browser's frames only redraw what is there, and time moves when step(ms) is called.
    // The loop still goes through net.loop (gf/mp is not ours to change); alone it is requestAnimationFrame. The first
    // runs one frame of no time, so the menu's view and the HUD are placed.
    let primed = false;
    if (stepped) session.loop(() => { if (forge.lost()) return; if (primed) { forge.setLights(lightsAt(ctx.time.now)); forge.render(ctx.time.now); } else { primed = true; frame(0, { dt: 0, draw: true }); } });
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

  // ---- what the core drew, under the observation's names ----
  function coverageReport() {
    const rep = ctx.forge.report().filter(r => r.visible), untagged = [], unknown = new Set();
    let tagged = 0;
    for (const r of rep) {
      if (r.slot < 0) { if (untagged.length < 50) untagged.push({ name: `instance ${r.i}`, path: `forge/instances/${r.i}`, type: 'forge-instance' }); continue; }
      const id = ctx.slotIds[r.slot];
      if (!id || !ctx.assets.has(id)) unknown.add(String(id ?? r.slot));
      tagged++;
    }
    return { meshes: rep.length, tagged, exempt: 0, untagged, unknownSlots: [...unknown], objects: rep.map(r => ({ slot: ctx.slotIds[r.slot] ?? null, area: Math.round(r.area), onScreen: r.onScreen })) };
  }
  function slotsReport() {
    const out = {};
    for (const r of ctx.forge.report()) {
      if (!r.visible || r.slot < 0) continue;
      const o = (out[ctx.slotIds[r.slot]] ??= { drawables: 0, triangles: 0, onScreen: false, area: 0 });
      o.drawables++; o.triangles += r.triangles; o.onScreen ||= r.onScreen; o.area += Math.round(r.area);
    }
    // a texture slot is drawn where the models it paints are (the world's stone over its walls, floor and pillars)
    const tx = ctx.world?.texture;
    if (tx?.slot && tx.id >= 0) for (const id of tx.on) {
      const m = out[id]; if (!m) continue;
      const o = (out[tx.slot] ??= { drawables: 0, triangles: 0, onScreen: false, area: 0, texture: true });
      o.drawables += m.drawables; o.triangles += m.triangles; o.onScreen ||= m.onScreen; o.area += m.area;
    }
    return out;
  }
  /** verify check 15 (CONTRACT §5): the share of the player's view the slots fill, from the core's slot-ID pass. */
  async function sightReport(ids) {
    const want = new Set(ids), idx = ids.map(id => ctx.slotIndex(id)).filter(i => i !== 0xffffffff);
    const mine = ctx.forge.report().filter(r => r.visible && want.has(ctx.slotIds[r.slot]));
    const w = 192, h = 108;
    if (!idx.length || !mine.length) return { share: 0, pixels: 0, open: 0, drawables: 0, rect: null, center: null, size: null, distance: null, w, h };
    const s = await ctx.forge.sight(idx);
    const hit = new Set(idx.map(i => i + 1));
    let n = 0, open = 0, x0 = s.w, y0 = s.h, x1 = -1, y1 = -1;
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
      const k = y * s.w + x;
      if (hit.has(s.only[k])) open++;
      if (!hit.has(s.all[k])) continue;
      n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const lo = [0, 1, 2].map(a => Math.min(...mine.map(r => r.min[a]))), hi = [0, 1, 2].map(a => Math.max(...mine.map(r => r.max[a])));
    const center = { x: (lo[0] + hi[0]) / 2, y: (lo[1] + hi[1]) / 2, z: (lo[2] + hi[2]) / 2 }, size = { x: hi[0] - lo[0], y: hi[1] - lo[1], z: hi[2] - lo[2] };
    const e = ctx.forge.drawnCamera(), all = s.w * s.h, rr = v => Math.round(v * 100) / 100;
    return { share: n / all, pixels: n, open: open / all, drawables: mine.length, rect: n ? [rr(x0 / s.w), rr(y0 / s.h), rr((x1 + 1) / s.w), rr((y1 + 1) / s.h)] : null, center, size, distance: rr(Math.hypot(center.x - e.x, center.y - e.y, center.z - e.z)), w: s.w, h: s.h };
  }
}

/**
 * gf-assets with every file's bytes fetched once. `want(files)` starts downloads before anyone asks (the arena's,
 * while the core starts); bytes(file) hands a download to the first asker and a copy of it to any other (the clip
 * file is asked for by the enemies, the players and the target dummy); forget() lets the kept downloads go.
 */
function eagerAssets(gf) {
  const got = new Map();   // file → {p: Promise<ArrayBuffer>, taken}
  // A request the network drops is asked for again, twice, a moment apart. A file fetched after the menu (a wave's
  // bodies, a weapon a card gives) that failed once was never asked for again: its enemies had no body for the rest of
  // the visit. An answer that is an error (a file that is not there) is not asked for again. (The wave 3 merge: a
  // joiner's first-wave bodies failed to fetch once in verify's two-player check.)
  const again = async f => { for (let k = 0; ; k++) { try { return await gf.bytes(f); } catch (e) { if (k >= 2 || !(e instanceof TypeError)) throw e; await new Promise(r => setTimeout(r, 400 * (k + 1))); } } };
  const fetchOnce = f => { const e = { p: again(f), taken: false }; got.set(f, e); e.p.catch(() => { if (got.get(f) === e) got.delete(f); }); return e; };
  return {
    ...gf,
    bytes(file) {
      const f = String(file), e = got.get(f) ?? fetchOnce(f);
      if (!e.taken) { e.taken = true; return e.p; }
      return e.p.then(b => b.slice(0));
    },
    want(files) { for (const f of files ?? []) if (f && !got.has(f)) fetchOnce(String(f)); },
    forget() { got.clear(); },
  };
}

/** The files the arena is drawn from (config/world.json: the ground, the pieces, the props, the pictures over them) and
 *  the effect pictures its fires use: what is on screen behind the menu. */
function arenaFiles(assets, world, characters) {
  const out = new Set(), add = slot => { if (slot && assets.has(slot)) { try { out.add(assets.file(slot)); } catch { /* a value slot */ } } };
  add(world?.ground?.slot);
  for (const p of world?.pieces ?? []) add(p.slot);
  for (const p of world?.props ?? []) add(`prop.${p.prop}`);
  for (const t of [world?.texture, ...(world?.textures ?? [])]) add(t?.slot);
  for (const kind of Object.keys(characters?.forge?.fight?.fx ?? {})) add(`fx.${kind}`);
  return [...out];
}

/**
 * The shared input → the core's buttons (gf/forge/host.js BTN; forge-core cmd::BTN_*): held this frame, and pressed
 * (went down) this frame. primary fires, secondary is the alternate fire, interact, jump; Shift evades (its press), R
 * reloads, V is a quick melee, 1-4 pick a weapon slot, the wheel the next or previous weapon.
 */
function buttonMapper() {
  let prevSprint = false;
  return input => {
    const a = input.actions, kd = c => !!input.keyDown?.(c), kp = c => !!input.keyPressed?.(c);
    let held = 0, pressed = 0;
    const on = (bit, down, press) => { if (down) held |= bit; if (press) pressed |= bit; };
    on(BTN.JUMP, a.jump.down, a.jump.pressed);
    on(BTN.FIRE, a.primary.down, a.primary.pressed);
    on(BTN.ALT, a.secondary.down, a.secondary.pressed);
    on(BTN.INTERACT, a.interact.down, a.interact.pressed);
    on(BTN.EVADE, !!input.sprint, !!input.sprint && !prevSprint);
    prevSprint = !!input.sprint;
    on(BTN.RELOAD, kd('KeyR'), kp('KeyR'));
    on(BTN.MELEE, kd('KeyV'), kp('KeyV'));
    for (let s = 1; s <= 4; s++) on(BTN.SLOT1 << (s - 1), kd(`Digit${s}`), kp(`Digit${s}`));
    if (input.wheel > 0) pressed |= BTN.PREV;
    if (input.wheel < 0) pressed |= BTN.NEXT;
    return { held, pressed };
  };
}

/** No WebGPU (CONTRACT §8 forge, PLAN §3.4): the kit's own screen, saying where the game plays, never a blank canvas. */
function unsupported(ctx, game, e) {
  const title = game.text?.title ?? game.title ?? 'This game';
  const d = document.createElement('div');
  d.id = 'gf-forge-unsupported';
  d.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#0b0e18;color:#fff;font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px;z-index:20;text-align:center';
  const link = location.href;
  d.innerHTML = `<div style="max-width:440px"><h1 style="margin:0 0 10px;font-size:28px;font-weight:850"></h1><p style="margin:0 0 14px;opacity:.9">This game draws with WebGPU or WebGL2, and this browser offers neither here. Open it in a current Chrome, Edge, Safari or Firefox.</p><p style="margin:0 0 16px"><a id="gf-forge-open" style="color:#ffb27a;word-break:break-all"></a></p><button id="gf-forge-copy" style="font:700 16px system-ui;padding:12px 18px;border-radius:12px;border:0;background:#ff7a59;color:#fff;cursor:pointer">Copy the link</button></div>`;
  d.querySelector('h1').textContent = title;
  const a = d.querySelector('#gf-forge-open'); a.href = link; a.textContent = link; a.target = '_blank'; a.rel = 'noopener';
  d.querySelector('#gf-forge-copy').onclick = () => navigator.clipboard?.writeText(link).catch(() => {});
  document.body.append(d);
  const why = String(e?.message ?? e).slice(0, 300);
  console.warn(`gf-forge: ${why}`);
  window.__game = Object.freeze({
    kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'unsupported', ready: true,
    unsupported: { reason: why, kind: 'no-graphics', shown: true, link },
    snapshot: () => ({ kit: KIT_NAME, runtime: RUNTIME, profile: PROFILE, version: VERSION, phase: 'unsupported', unsupported: { reason: why, kind: 'no-graphics', link }, players: [] }),
    screen: () => { const c = document.getElementById('gf-canvas'); return { dpr: globalThis.devicePixelRatio || 1, css: [innerWidth, innerHeight], buffer: [c?.width ?? 0, c?.height ?? 0], unsupported: true }; },
  });
  return ctx;
}

function fatal(e) {
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;padding:12px 16px;background:#3a1020;color:#fff;font:14px system-ui;border-radius:10px;z-index:9';
  d.textContent = `The game could not start: ${e?.message ?? e}`;
  document.body.append(d);
}
