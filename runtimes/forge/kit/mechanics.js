// gf-forge: the shared mechanics that run on forge (components/<id>/impl/forge, vendored into a game as
// gf/three/mechanics/<id>/impl/forge/), loaded by the boot (gf/three/core/boot-forge.js). Vendored as
// gf/forge/mechanics.js (never edited there).
//
// A mechanic on forge is the same behaviour as on three (its manifest: params, slots, events, host ownership), played
// with what forge has: the core's players, health and enemies, its rule events, the renderer's instances for anything
// the mechanic draws, and ctx.shared for what the host owns. A mechanic with no forge implementation stays a stand-in:
// its params in config for the rules, as before.
//
//   const mech = await loadMechanics(game);               // before the tables load: the dynamic imports
//   const tables = forgeTables.fill(mech.tables(game.forge ?? {}));   // a mechanic may shape the tables (waves)
//   const list = mech.create(ctx);                        // after ctx.forge, ctx.render, ctx.ui and ctx.hud exist
//   await mech.setup(ctx);                                // after the session (ctx.players, ctx.shared, ctx.me)
//   (every frame: each instance's update(dt) rides ctx.onFrame; mech.observe() for the observation)
//
// An implementation module exports `id`, `create(ctx, params) → instance` and, if it shapes the core's tables,
// `tables(forgeTables, params) → forgeTables`. Its params are config/game.json → mechanics[i].params (create filled the
// defaults from the manifest), read live through the mechanic's slots where it has them (Studio's changes). The third
// argument of create and tables is this file's helpers (HELP below), so an implementation imports nothing of forge.
import { FEEL_OP } from './feel.js';
import { KIND } from './host.js';

/** The forge implementation of each mechanic the game names, or null for a stand-in. → {id, as, params, mod}[] */
export async function loadMechanics(game = {}, { load = id => import(`../three/mechanics/${id}/impl/forge/index.js`) } = {}) {
  const specs = Array.isArray(game.mechanics) ? game.mechanics : [];
  const found = [];
  for (const spec of specs) {
    if (!spec || typeof spec.id !== 'string') continue;
    let mod = null;
    if (/^[a-z0-9-]+$/.test(spec.id)) {
      try { mod = await load(spec.id); } catch { mod = null; }
      if (mod && (typeof mod.create !== 'function' || mod.id !== spec.id)) mod = null;
    }
    found.push({ id: spec.id, as: spec.as, params: { ...(spec.params ?? {}) }, mod });
  }
  const list = [];
  return {
    found,
    /** The forge tables as the game's mechanics shape them (spec tables the game wrote itself always win: a mechanic
     *  only adds what the tables leave empty). */
    tables(base = {}) {
      let t = base;
      for (const f of found) if (f.mod && typeof f.mod.tables === 'function') { try { t = f.mod.tables(t, f.params, HELP) ?? t; } catch (e) { console.warn(`gf-forge: mechanic ${f.id}.tables: ${e?.message ?? e}`); } }
      return t;
    },
    /** The instances, in the game's order (a stand-in is {id, as, params, standin: true}). */
    create(ctx) {
      for (const f of found) {
        let inst = null;
        if (f.mod) { try { inst = f.mod.create(ctx, f.params, HELP) ?? {}; } catch (e) { console.error(e); inst = null; } }
        const m = inst ?? {};
        m.id = f.id; m.as = f.as; m.params = { ...f.params }; m.standin = !inst; m.runtime = inst ? 'forge' : null;
        list.push(m);
        if (inst && typeof inst.update === 'function' && Array.isArray(ctx.onFrame)) ctx.onFrame.push(dt => { try { inst.update(dt); } catch (e) { console.error(`gf-forge: mechanic ${f.id}.update`, e); } });
      }
      return list;
    },
    async setup(ctx) {
      for (const m of list) { if (m.standin || typeof m.setup !== 'function') continue; try { await m.setup(ctx); } catch (e) { console.error(`gf-forge: mechanic ${m.id}.setup`, e); } }
    },
    /** What each running mechanic says of itself (window.__game.forge.mechanics()). */
    observe() {
      return list.map(m => ({ id: m.id, standin: m.standin, ...(m.standin || typeof m.observe !== 'function' ? {} : (() => { try { return { state: m.observe() }; } catch (e) { return { error: String(e?.message ?? e) }; } })()) }));
    },
  };
}

/** A mechanic's value: its slot (Studio's change) when the game has it, else its params, else the fallback. */
export function valueOf(ctx, id, params, key, fallback) {
  const sid = `mechanic.${id}.${key.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
  try { if (ctx.assets?.has?.(sid)) return ctx.assets.value(sid, params[key] ?? fallback); } catch {}
  return params[key] ?? fallback;
}

/** Listeners: on(fn) → off(); emit(payload) calls each, one failing never stops the rest. */
export function listeners(name) {
  const fns = [];
  return {
    on: fn => { fns.push(fn); return () => { const i = fns.indexOf(fn); if (i >= 0) fns.splice(i, 1); }; },
    emit: payload => { for (const fn of [...fns]) { try { fn(payload); } catch (e) { console.error(`gf-forge: a ${name} listener`, e); } } },
    get size() { return fns.length; },
  };
}

/** The players the core holds, by core id, and the kit's player for one: {nid → p}. */
export const coreIdOf = (ctx, p) => (p ? ctx.players?.nid?.(p.id) ?? null : null);
export const playerOfCore = (ctx, n) => ctx.players?.byNid?.(n) ?? ctx.players?.list?.().find(p => coreIdOf(ctx, p) === n) ?? null;

/**
 * Things a mechanic lays in the world (a pickup's spots, loot on the ground), drawn as renderer instances of one model
 * slot: the slot's model fitted to `size` metres, turning and bobbing, tinted toward `tint` (mix 0: its own colours).
 * Every copy draws its own from the host's shared rows. The model loads once, in the background; until it is there
 * nothing is drawn (never a model from outside a slot).
 *
 *   const marks = createMarks(ctx, { slot: 'fight.coin', size: 0.5, tint: '#ff4d6a', mix: 0.6, spin: 1.6, bob: 0.08 });
 *   marks.set(i, { x, y, z, on });  marks.tick(t);  marks.observe()
 */
export function createMarks(ctx, { slot, size = 0.5, tint = null, mix = 0, spin = 1.6, bob = 0.08, lift = 0.9 } = {}) {
  const host = ctx.forge, A = ctx.assets, gf = ctx.gf;
  const shown = new Map();       // i → {inst, x, y, z, on, phase}
  let model = null, loading = null, problem = null;
  const load = () => (loading ??= (async () => {
    try {
      if (!slot || !A?.has?.(slot)) throw new Error(`no slot ${slot}`);
      const m = await host.model(await gf.bytes(A.file(slot)));
      const [x0, y0, z0, x1, y1, z1] = m.bounds, longest = Math.max(x1 - x0, y1 - y0, z1 - z0, 1e-4);
      model = { id: m.id, k: size / longest, c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] };
    } catch (e) { problem = String(e?.message ?? e); }
  })());
  const place = (s, t) => {
    const a = t * spin + s.phase, k = model.k, y = s.y + lift + (bob ? Math.sin(t * 2.2 + s.phase) * bob : 0);
    const cs = Math.cos(a), sn = Math.sin(a), [cx, cy, cz] = model.c;
    // the model's centre on the spot, turned `a` about Y
    return { at: [s.x - (cs * cx + sn * cz) * k, y - cy * k, s.z - (-sn * cx + cs * cz) * k], rot: (a * 180) / Math.PI, scale: k };
  };
  let clock = 0;
  return {
    get slot() { return slot; },
    set(i, { x, y = 0, z, on = true }) {
      load();
      const s = shown.get(i) ?? { inst: null, phase: (i * 2.399) % (Math.PI * 2) };
      Object.assign(s, { x, y, z, on: !!on });
      shown.set(i, s);
    },
    drop(i) { const s = shown.get(i); if (s) { s.on = false; if (s.inst != null) host.visible(s.inst, false); } },
    tick(dt) {
      clock += Number.isFinite(dt) ? dt : 0;
      if (!model) return;
      for (const s of shown.values()) {
        if (s.inst == null && s.on) { s.inst = host.instance(model.id, ctx.slotIndex?.(slot) ?? 0xffffffff, place(s, clock)); if (tint) host.tint(s.inst, tint, mix); }
        if (s.inst == null) continue;
        host.visible(s.inst, s.on);
        if (s.on) host.move(s.inst, place(s, clock));
      }
    },
    observe: () => ({ slot, loaded: !!model, problem, drawn: [...shown.values()].filter(s => s.on && s.inst != null).length }),
  };
}

/** What an implementation gets beside ctx and its params. */
export const HELP = Object.freeze({ valueOf, listeners, coreIdOf, playerOfCore, createMarks, FEEL_OP, KIND });
