// gf-forge's fight on the screen (the wave 1b integration), vendored into a game as gf/forge/fight.js (never edited
// there): what forge-feel (track F) simulates that the renderer (track R) draws once it is given the art, each piece
// a slot (gf/forge/wear.js names them; config/characters.json → forge):
//
//   the first-person layer   the arms (slot character.arms.player) and the model of every weapons row (slots
//                            character.held.<id>: the same file a friend sees in a fist), registered with the renderer
//                            by row; the core's feel view then says which is in hand and how it moves (forge-web
//                            glue.rs: kick, sway, bob, reload, raise, swing). The sleeves take the player's colour.
//                            A gun's hidden flash_muzzle node shows for three frames a shot, and the shot's sparks and
//                            smoke are born at its socket_muzzle.
//   a kill's pieces          forge-feel's debris entities (piece types skull, ribcage, bone, short bone, chip) as the
//                            slots fight.debris.*, fitted to each piece's size; the coin (fight.coin), turning
//   weapons on the ground    forge-feel's pickups: the row's own model, turning and bobbing at chest height
//   target dummies           forge-feel's dummies as a skinned body (slot fight.target) standing in its idle clip
//   the effect pictures      each particle kind's picture (slots fx.<kind>); without one the renderer draws a shape
//
//   const fight = await loadFight(ctx);     // ctx.render (gf/forge/render.js), ctx.forge, ctx.assets, ctx.gf, ctx.tables
//   fight.observe()                         // for verify: what was registered
import { KIND } from './host.js';
import { fitTo } from './render.js';
import { ARMS, COIN, CLIPS, TARGET, DEBRIS, heldSlot, debrisSlot, fxSlot } from './wear.js';
import { firstWeaponRows } from './first.js';

/** forge-feel's entity kinds beside the core's (forge_feel::kinds). */
export const FEEL_KIND = { COIN: 16, TARGET: 17 };
/**
 * The weapon in hand on an upright screen (wave 4). A hold is where the grip sits in camera space, metres right of
 * the eye, and the first-person view's height is fixed (look.fp.fov): on a screen taller than it is wide the view is
 * a fraction as wide, so a grip 20 cm to the right at 42 cm is past the right edge (on 390 × 844: 1.8 half-widths
 * out, where a 16:9 screen has it at 0.46) and only the weapon's tip showed.
 *
 * Narrower than square, the whole weapon moves left until its muzzle is as far right of the crosshair, as a share of
 * the screen's width, as it is on a square screen: x − muzzle × (1 − aspect). The muzzle is what points at the aim,
 * so the weapon comes in from the lower right as it always did and never covers the crosshair (moved in by its grip
 * alone, a long gun's barrels stood on it). `muzzle` is the muzzle's own x under the catalog's hold, measured from the
 * renderer the first time the weapon rests in the hand; until then it is taken as FP_MUZZLE of the hold's x (the
 * library's weapons measure 0.63 to 0.80). At square or wider the hold is the catalog's own, to the last digit.
 */
export const FP_MUZZLE = 0.7;
export function holdFor(hold, aspect, muzzle = null) {
  const a = Number(aspect);
  if (!Array.isArray(hold) || !(a > 0) || a >= 1) return hold;
  const m = Number.isFinite(muzzle) ? muzzle : hold[0] * FP_MUZZLE;
  return [hold[0] - m * (1 - a), hold[1], hold[2]];
}
const mimeOf = f => (/\.jpe?g$/i.test(f) ? 'image/jpeg' : /\.webp$/i.test(f) ? 'image/webp' : 'image/png');

export async function loadFight(ctx) {
  const host = ctx.forge, R = ctx.render, A = ctx.assets, gf = ctx.gf;
  const cfg = A.config?.('characters')?.forge ?? null;
  const rows = Array.isArray(ctx.tables?.weapons) ? ctx.tables.weapons : [];
  const done = { arms: false, weapons: [], debris: [], coin: false, pickups: [], fx: [], problems: [], first: false, later: false };
  if (!R || !cfg) return { observe: () => done };
  const model = async slot => { try { return A.has(slot) ? await host.model(await gf.bytes(A.file(slot))) : null; } catch (e) { done.problems.push(`${slot}: ${e?.message ?? e}`); return null; } };
  // What is fetched when (wave 3, track M; gf/forge/first.js): before the menu only the effect pictures (the fires
  // behind it smoke); once it is drawn, `first` (the weapon a player starts with, a kill's pieces, the coin), then
  // `later` (the weapons a card gives). A page with no such steps (a tool's own) loads everything at once, as before.
  const jobs = [], first = [], later = [];
  const start = new Set(firstWeaponRows(ctx.tables));
  const after = ctx.after ?? ((_step, fn) => fn());
  // ---- the effect pictures: every kind with a slot ----
  for (const kind of Object.keys(cfg.fight?.fx ?? {})) jobs.push((async () => {
    const slot = fxSlot(kind);
    if (!A.has(slot)) return;
    try { const f = A.file(slot); if (await R.fxPicture(kind, await gf.bytes(f), mimeOf(f))) done.fx.push(kind); } catch (e) { done.problems.push(`${slot}: ${e?.message ?? e}`); }
  })());
  // ---- the first-person arms, and every weapons row's model by its row ----
  if (cfg.fp?.arms) first.push(async () => { const m = await model(ARMS); if (m) { R.fp.arms(m.id, ctx.slotIndex(ARMS)); done.arms = true; } });
  // each row's registration is kept: a screen that turns upright (or back) is given every hold again for its shape
  const held = [], aspect = () => (globalThis.innerWidth || 16) / Math.max(1, globalThis.innerHeight || 9);
  const register = h => R.fp.weapon(h.i, h.model, h.slot, holdFor(h.hold, aspect(), h.muzzle), h.two);
  globalThis.addEventListener?.('resize', () => { for (const h of held) register(h); });
  // on an upright screen: each weapon's muzzle, measured once from the renderer while the weapon rests in the hand
  // (no kick, sway, raise, reload or swing moving it), then the hold given again from it (holdFor)
  let F = null;
  ctx.onFrame?.push?.(() => {
    if (aspect() >= 1 || !held.some(h => h.muzzle === null) || typeof host.forge?.feel_view !== 'function') return;
    const v = host.forge.feel_view();
    F ??= Object.fromEntries(host.forge.feel_view_names().split(',').map((n, i) => [n, i]));
    const h = held.find(x => x.i === Math.round(v[F.weapon]));
    if (!h || h.muzzle !== null) return;
    if (Math.abs(v[F.swayX]) > 1e-3 || Math.abs(v[F.swayY]) > 1e-3 || v[F.viewKick] > 1e-3 || v[F.raise] > 0 || v[F.reloading] > 0 || v[F.swing] >= 0 || v[F.down] > 0 || v[F.dead] > 0) return;
    const s = R.fp.sockets(), m = s.muzzle ?? s.tip;
    if (!s.grip) return;                               // not drawn yet
    if (!m) { h.muzzle = undefined; return; }          // a weapon with no muzzle to measure: the usual share stands
    h.muzzle = h.hold[0] + (m.cam[0] - s.grip.cam[0]);
    register(h);
  });
  rows.forEach((row, i) => (start.has(i) ? first : later).push(async () => {
    const slot = heldSlot(row.id), m = await model(slot);
    if (!m) return;
    const w = cfg.weapons?.[row.id] ?? {};
    const h = { i, model: m.id, slot: ctx.slotIndex(slot), hold: w.hold ?? [0.13, -0.17, -0.34], two: !!w.twoHanded, muzzle: null };
    held.push(h); register(h);
    done.weapons.push(row.id);
    // the same model lying in the world as a pickup (forge-feel's PICKUP entity, its type the row), at chest height
    const fit = fitTo(m.bounds, { size: 0.55 }); fit[13] += 0.85;
    R.entityModel(KIND.PICKUP, i, m.id, ctx.slotIndex(slot), { fit, spin: 1.8, bob: 0.06 });
    done.pickups.push(row.id);
    // the quick melee's weapon when the tables have a melee row is that row's (forge-feel); with none, the first blade
    // registered here would be swung: there is none to register, so the gun only dips
  }));
  // ---- a kill's pieces and the coin ----
  for (const [piece, d] of Object.entries(DEBRIS)) first.push(async () => {
    const slot = debrisSlot(piece), m = await model(slot);
    if (!m) return;
    // a long bone lies along Z in the core (forge-feel kills.rs `piece_for`: its box is longest there)
    for (const [type, size] of d.types) R.entityModel(KIND.DEBRIS, type, m.id, ctx.slotIndex(slot), { fit: fitTo(m.bounds, { size, alongZ: type >= 2 }) });
    done.debris.push(piece);
  });
  if (cfg.fight?.coin) first.push(async () => { const m = await model(COIN); if (m) { R.entityModel(FEEL_KIND.COIN, null, m.id, ctx.slotIndex(COIN), { fit: fitTo(m.bounds, { size: Number(cfg.fight.coinSize) || 0.22 }), spin: 6 }); done.coin = true; } });
  // ---- target dummies (forge-feel's: a test room, verify check 16's staged hit): the dummy's body, animated by the
  // core (its hit regions ride its bones, a hit flinches the bone it lands on) and drawn skinned like any body ----
  let target = null;
  const targetBody = () => (target ??= (async () => {
    if (!A.has(TARGET) || !A.has(CLIPS)) return null;
    try { const [b, clips] = await Promise.all([R.body(await gf.bytes(A.file(TARGET)), ctx.slotIndex(TARGET)), host.animClips(await gf.bytes(A.file(CLIPS)))]); return { ...b, clips }; }
    catch (e) { done.problems.push(`${TARGET}: ${e?.message ?? e}`); return null; }
  })());
  host.on('spawn', e => {
    if (e.entityKind !== FEEL_KIND.TARGET) return;
    targetBody().then(b => { if (b && host.animate(e.id, b.body, b.clips, { hurt: cfg.fight?.targetHurt !== false })) { host.animPlay(e.id, cfg.fight?.targetClip ?? 'idle', { fade: 0, loop: true }); done.targets = (done.targets ?? 0) + 1; } });
  });
  const run = list => Promise.all(list.map(fn => fn().catch(e => { done.problems.push(String(e?.message ?? e)); })));
  const steps = Promise.all([after('first', () => run(first).then(() => { done.first = true; })), after('later', () => run(later).then(() => { done.later = true; }))]);
  // with the boot's steps this is the effect pictures alone; without them (after ran each at once) everything
  await Promise.all(ctx.after ? jobs : [...jobs, steps]);
  // the sleeves in the local player's colour, once it has one
  const sleeve = () => { const c = ctx.me?.color; if (typeof c === 'string') R.fp.sleeve(c); };
  sleeve();
  // (`holds`: each weapon's hold as registered for this screen's shape, beside the catalog's own)
  return { observe: () => JSON.parse(JSON.stringify({ ...done, aspect: Math.round(aspect() * 1000) / 1000, holds: held.map(h => ({ row: h.i, catalog: h.hold, muzzle: h.muzzle ?? null, drawn: holdFor(h.hold, aspect(), h.muzzle) })) })), sleeve };
}
