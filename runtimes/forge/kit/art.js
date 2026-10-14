// gf-forge's art beside the world and the bodies (wave 3, track A2), vendored into a game as gf/forge/art.js (never
// edited there). Two things a fight shows that are neither a piece of the world nor a body, each a slot (CONTRACT §2,
// R1–R5), from research/gf-forge/library (catalog.json):
//
//   the hands on the first-person weapon   a rig a weapon family (catalog `fp.hands.<family>`: the hunter's gauntlets
//                                          posed for a pistol grip, a long gun, an axe's haft, a focus), swapped in
//                                          as the weapon in hand changes. A rig is the renderer's own first-person rig
//                                          (arm_r with socket_grip, arm_l with socket_grip_l: gf/forge/render.js
//                                          `fp.arms`), so the weapon is framed as before and the hands ride its kick,
//                                          sway, reload and raise
//   the pictures on the reward cards       one picture a card (catalog `card.<motif>`: woodcuts in one hand, the
//                                          paper clear), chosen by what the card does: its kind, the value it changes,
//                                          the weapon it gives. gf/forge/cards.js draws it on the card's face
//
// It rides the world's module, which create and the slot tools already call (gf/forge/world.js: `worldConfig` writes
// this block, `slotsFor` declares its slots, `loadWorld` attaches the hands):
//
//   config/world.json → art: { hands: { rigs: { <family>: file }, weapons: { <weapon id>: <family> } },
//                              cards: { <card id>: { file, motif } } }
//   artConfig(forge, catalog)     create's block for a game's filled tables (null: nothing to add)
//   artFiles(forge, catalog)      the library files it names: [{to, from, what}]
//   slotsFor(art, forge)          the slots: a model a rig (character.hands.<family>), a picture a card (card.picture.<id>)
//   attachHands(ctx, art)         the browser: each rig loaded as its slot's bytes; the rig of the weapon in hand set on
//                                 the first-person layer, on the game's own frame (ctx.onFrame)
//   cardPicture(ctx, id)          the browser: a card's picture as a URL (its slot's file; Studio's swap applies), or null
//   cardMotif(card, weapons)      the library picture a card row shows; handsFamily(row): the rig a weapons row is held with
import { heldRoleFor } from './wear.js';

/** A rig's model slot; a card's picture slot. */
export const handsSlot = family => `character.hands.${family}`;
export const cardSlot = id => `card.picture.${id}`;
/** The hands' family by the library's weapon role (gf/forge/wear.js heldRoleFor: a row's preset, else its kind). */
export const FAMILY = { 'weapon.pistol': 'pistol', 'weapon.shotgun': 'long', 'weapon.mg': 'long', 'weapon.melee': 'axe', 'weapon.focus': 'focus', 'weapon.wand': 'focus' };
export const FAMILY_LABEL = { pistol: 'a pistol grip', long: 'a long gun (two hands)', axe: 'an axe\'s haft', focus: 'a focus' };
/** The catalog role of the rig a library weapon role is held with. */
export const handsFor = role => `fp.hands.${FAMILY[role] ?? 'pistol'}`;
/** The family a weapons-table row is held with. */
export const handsFamily = row => FAMILY[heldRoleFor(row)] ?? 'pistol';

/** The card motifs the library draws (catalog `card.<motif>`), and what each is for. */
export const MOTIFS = ['draught', 'scattergun', 'repeater', 'reload', 'bandolier', 'stride', 'feather', 'wind', 'scythe', 'eye', 'rounds', 'heart', 'oath', 'barrels', 'saint', 'whetstone', 'arms'];
/** A perk card's motif (wave 7): the nearest of the library's pictures to what the perk does. */
export const PERK_MOTIF = { blast: 'rounds', burst: 'barrels', shockwave: 'oath', thorns: 'arms', aura: 'heart', fury: 'saint', lifesteal: 'draught', ambush: 'eye', rush: 'stride' };
/**
 * The picture a card shows, by what it does: a heal the draught; a weapon card its weapon (a scattergun, a repeater, else
 * crossed arms); an upgrade by the value it changes (`stat`, a path in spec.forge), a blade's values the scythe, damage
 * paid for with health the glass saint; anything else the whetstone.
 */
export function cardMotif(card = {}, weapons = []) {
  const kind = card.kind ?? 'upgrade';
  if (kind === 'heal') return 'draught';
  const rowOf = id => (Array.isArray(weapons) ? weapons.find(w => w?.id === id) : null) ?? null;
  if (kind === 'weapon') return { 'weapon.shotgun': 'scattergun', 'weapon.mg': 'repeater' }[heldRoleFor(rowOf(card.weapon))] ?? 'arms';
  // wave 7 (builds): a perk card by its perk, from the motifs the library has (a slot each: a game replaces it)
  if (kind === 'perk') return PERK_MOTIF[card.perk] ?? 'whetstone';
  const s1 = String(card.stat ?? ''), s2 = String(card.stat2 ?? ''), parts = s1.split('.');
  const key = parts.slice(parts[0] === 'weapons' ? 2 : 1).join('.');
  const melee = parts[0] === 'weapons' && parts[1] !== '*' && heldRoleFor(rowOf(parts[1])) === 'weapon.melee';
  if (key === 'reload') return 'reload';
  if (key === 'magazine') return 'bandolier';
  if (/^(walk|sprint|speed|accelTime)$/.test(key)) return 'stride';
  if (/evade/i.test(key)) return 'feather';
  if (/^stamina\./.test(key)) return 'wind';
  if (/^crit/.test(key)) return 'eye';
  if (/^(pellets|spread)$/.test(key)) return 'barrels';
  if (/^revive\.|^armor$/.test(key)) return 'oath';
  if (/^(health|hurt\.)/.test(key)) return 'heart';
  if (melee || /^melee\./.test(key)) return 'scythe';
  if (/^(damage|knockback|range|fireInterval)$/.test(key)) return s2 === 'player.health' && Number(card.mul2 ?? 1) < 1 ? 'saint' : 'rounds';
  return 'whetstone';
}

const roleFile = (catalog, role) => catalog?.roles?.[role]?.file ?? null;

/** config/world.json → art for a game whose filled tables are `forge` (create). null when the library has neither. */
export function artConfig(forge = {}, catalog = null) {
  const weapons = (forge.weapons ?? []).filter(w => w?.id), cards = (forge.cards ?? []).filter(c => c?.id);
  const out = {};
  // hands: only the families this game's weapons are held with, and only those the library has a rig for
  const fam = {}, rigs = {};
  for (const w of weapons) { const f = handsFamily(w); if (!roleFile(catalog, `fp.hands.${f}`)) continue; fam[w.id] = f; rigs[f] = `assets/models/fp-hands-${f}.glb`; }
  if (Object.keys(rigs).length) out.hands = { rigs, weapons: fam };
  const pics = {};
  for (const c of cards) { const motif = cardMotif(c, weapons); if (roleFile(catalog, `card.${motif}`)) pics[c.id] = { file: `assets/cards/${c.id}.png`, motif }; }
  if (Object.keys(pics).length) out.cards = pics;
  return Object.keys(out).length ? out : null;
}

/** The library files `artConfig` names: [{to, from (a path in research/gf-forge/library), what}]. */
export function artFiles(forge = {}, catalog = null) {
  const cfg = artConfig(forge, catalog), out = [];
  for (const [f, to] of Object.entries(cfg?.hands?.rigs ?? {})) out.push({ to, from: roleFile(catalog, `fp.hands.${f}`), what: `the hands on the first-person weapon: ${FAMILY_LABEL[f] ?? f}` });
  const names = Object.fromEntries((forge.cards ?? []).map(c => [c.id, c.name || c.id]));
  for (const [id, c] of Object.entries(cfg?.cards ?? {})) out.push({ to: c.file, from: roleFile(catalog, `card.${c.motif}`), what: `the picture on the card ${names[id] ?? id}` });
  return out;
}

/** The slots (CONTRACT §2.2): a model a hands rig, an image a card's picture. `forge`: the filled tables (names). */
export function slotsFor(art, forge = {}) {
  const out = [];
  for (const [f, file] of Object.entries(art?.hands?.rigs ?? {})) {
    const ids = Object.entries(art.hands.weapons ?? {}).filter(([, v]) => v === f).map(([k]) => k);
    out.push({ id: handsSlot(f), group: 'characters', label: `First-person hands: ${FAMILY_LABEL[f] ?? f}`, type: 'model', source: { file }, constraints: { maxBytes: 4194304 }, tier: 'advanced', facet: 'look', rank: 43,
      description: `Your hands on the weapon in first person, posed for ${FAMILY_LABEL[f] ?? f} (${ids.join(', ')}). A first-person rig in camera space: arm_r holds the right hand and socket_grip (how the weapon is turned and how large), arm_l the left hand and socket_grip_l (set on a long gun's second grip)`,
      generate: { prompt: 'a monster hunter\'s armoured gauntlet, a closed fist and forearm, dark leather and riveted iron', style: 'stylised low-poly, hand-painted, dark fantasy' } });
  }
  const names = Object.fromEntries((forge?.cards ?? []).map(c => [c.id, c.name || c.id]));
  for (const [id, c] of Object.entries(art?.cards ?? {})) out.push({ id: cardSlot(id), group: 'mechanics', label: `Card ${names[id] ?? id}: picture`, type: 'image', source: { file: c.file }, constraints: { maxBytes: 524288 }, tier: 'advanced', facet: 'look', rank: 31,
    description: 'The picture on the card\'s face (drawn square over the card\'s parchment; a clear background lets the parchment show through)',
    generate: { prompt: `${names[id] ?? id}: one bold subject, a rough woodcut in black ink`, style: 'hand-cut woodcut print, black ink, transparent background' } });
  return out;
}

/**
 * The browser: the hands. Each family's rig is loaded as its slot's bytes (Studio's swaps apply) and the rig of the
 * weapon in hand is the first-person layer's arms (gf/forge/render.js fp.arms), set when the core's feel view names
 * another weapons row. It runs on the game's own frame (ctx.onFrame): no loop of its own. → {observe()} or null.
 */
export async function attachHands(ctx, art) {
  const R = ctx.render, A = ctx.assets, host = ctx.forge, rows = Array.isArray(ctx.tables?.weapons) ? ctx.tables.weapons : [];
  if (!R?.fp || !host?.forge?.feel_view || !art?.hands || !Array.isArray(ctx.onFrame)) return null;
  const rigs = new Map(), problems = [];
  await Promise.all(Object.keys(art.hands.rigs ?? {}).map(async f => {
    const slot = handsSlot(f);
    if (!A.has(slot)) return;
    try { const m = await host.model(await ctx.gf.bytes(A.file(slot))); rigs.set(f, { id: m.id, slot: ctx.slotIndex(slot), triangles: m.triangles }); } catch (e) { problems.push(`${slot}: ${e?.message ?? e}`); }
  }));
  if (!rigs.size) return { observe: () => ({ families: [], shown: null, problems }) };
  const byRow = rows.map(r => art.hands.weapons?.[r.id] ?? null);
  let F = null, row = -2, shown = null, swaps = 0;
  ctx.onFrame.push(() => {
    const v = host.forge.feel_view();
    F ??= Object.fromEntries(host.forge.feel_view_names().split(',').map((n, i) => [n, i]));
    const now = Math.round(v[F.weapon]);
    if (now === row) return;
    row = now;
    const f = byRow[row] ?? null, rig = f ? rigs.get(f) : null;
    if (!rig || f === shown) return;
    R.fp.arms(rig.id, rig.slot); shown = f; swaps++;
  });
  return { observe: () => ({ families: [...rigs.keys()], weapons: { ...(art.hands.weapons ?? {}) }, row, shown, swaps, problems }) };
}

/** The browser: a card's picture as a URL (its slot's file through gf-assets, so an override or a swap applies). */
export function cardPicture(ctx, id) {
  const A = ctx?.assets, slot = cardSlot(id);
  try { return A?.has?.(slot) ? A.url(slot) : null; } catch { return null; }
}
