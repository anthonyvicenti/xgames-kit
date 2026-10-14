// Recipes for new art: concept art first, one style anchor per look (library/COVERAGE.md, "The Meshy plan").
//
//   anchorPrompt(target, { subjects, keep }) → the words for the look's style anchor: one picture, written from the
//                                          style target's facts and our own words (`keep`; never from a reference image),
//                                          that conditions every asset made for it. A game with several looks (levels)
//                                          has one anchor per look (wave.mjs `wave.looks`)
//   conceptPrompt(item, target)          → the words for one asset's concept, drawn in the anchor's style
//   recipe(item, target)                 → { steps: [{ step, endpoint, credits }], credits, rig, archetype, ingest, next }
//   waveCost(items)                      → { credits, byStep }
//
// An item is one thing to make: { id, kind: 'body' | 'prop' | 'texture' | 'picture', archetype?, words, size?, held?, tile?,
// look? (the anchor it is drawn from), polycount? (a big set piece takes more), collider? (a prop's: COLLIDERS) }.
// The steps (Meshy, on the creator's own key; credits from builder/tools/lib/char-meshy.mjs COST):
//   anchor   text-to-image, once per look (6)
//   concept  image-to-image with the anchor as the only reference (6): the subject alone, in the anchor's style
//   3D       image-to-3D from the concept, textured, remeshed (30)
//   rig      rigging, only for a humanoid body (5): Meshy's auto-rig puts a biped skeleton on whatever it gets
//   autorig  any other archetype (worm, blob, quadruped, flyer): the kit's own autorig fits that archetype's skeleton
//            to the mesh on this machine (builder/art/rig/autorig.mjs, no credits), and rig-check judges it
// A texture or a picture stops after its concept. The legal line (LOOKS-BRIEF): a reference screenshot is never an
// input to any step; the anchor is our own picture, made from words.
export const COST = { 'text-to-image': 6, 'image-to-image': 6, 'image-to-3d': 30, rigging: 5, autorig: 0 };
/** Archetype → its rig standard (runtimes/three/kit/character/archetypes.js RIG_OF). */
export const RIG_OF = { humanoid: 'gf-humanoid-1', worm: 'gf-worm-1', blob: 'gf-blob-1', quadruped: 'gf-quadruped-1', flyer: 'gf-flyer-1' };
/** How a body of each archetype is drawn for its concept: a pose that lets the mesh be rigged (limbs apart, the parts
 *  that move clear of the body). */
export const POSE_OF = {
  humanoid: 'standing in an A-pose, arms away from the body, facing the viewer',
  blob: 'standing on its base, a little turned toward the viewer, any small feet or arm nubs clear of the body',
  worm: 'its whole length in view, standing up in a gentle S or lying along the ground, the head clearly at one end',
  quadruped: 'standing on all four legs, the legs apart and straight, seen from the side and a little in front',
  flyer: 'wings spread wide open to the sides, seen from the front and a little above, legs (if any) hanging below',
};

import { familyOf, hsl } from './signature.mjs';

/** A prop longer than this (metres) is a set piece: it stands on the world's ground (builder/look/pitch.mjs SET_PIECE). */
export const SET_PIECE = 2.5;

const LEVEL_WORD = { none: 'no', low: 'light', mid: 'medium', high: 'bold' };
const FAMILY_WORD = { grey: 'grey', brown: 'brown', red: 'red', orange: 'orange', yellow: 'yellow', green: 'green', cyan: 'turquoise', blue: 'blue', purple: 'purple', pink: 'pink' };
/** A colour in words a picture model reads (it may draw a hex code as text): "light turquoise", "deep brown". */
export function colourWords(hex) {
  const n = parseInt(hex.slice(1), 16), [h, s, l] = hsl((n >> 16) & 255, (n >> 8) & 255, n & 255);
  const fam = familyOf(h, s, l);
  if (fam === 'grey') return l < 0.2 ? 'near-black ink' : l > 0.85 ? 'white' : l < 0.45 ? 'dark grey' : 'light grey';
  const tone = l > 0.68 ? 'light ' : l < 0.3 ? 'deep ' : '';
  const vivid = s > 0.75 && l >= 0.3 && l <= 0.75 ? 'vivid ' : s < 0.3 ? 'dusty ' : '';
  return `${vivid}${tone}${FAMILY_WORD[fam]}`.trim();
}
const listOf = xs => (xs ?? []).filter(Boolean).join(', ');

/** The look in words a picture model can follow: palette, light, surfaces, shapes, ink. No names, no games. */
export function styleWords(target, { ink = true } = {}) {
  if (!target) return 'chunky, readable stylised game art with clear shapes and bold colours';
  const t = target, out = [];
  const cols = (t.palette?.colors ?? []).slice(0, 8).map(c => `${colourWords(c.hex)}${c.role ? ` ${c.role}` : ''}`);
  if (cols.length) out.push(`palette: ${cols.join(', ')}`);
  const sat = t.palette?.saturation?.mean;
  if (sat != null) out.push(sat > 0.6 ? 'candy-saturated colours' : sat > 0.35 ? 'clear, moderately saturated colours' : 'muted colours');
  if (t.materials?.shading) out.push(`${t.materials.shading} shading${t.materials.bands ? ` with ${t.materials.bands} light bands` : ''}`);
  if (t.materials?.texture && t.materials.texture !== 'none') out.push(`${t.materials.texture} surfaces`);
  if (t.materials?.gloss && t.materials.gloss !== 'none') out.push(`${t.materials.gloss} glossy highlights`);
  if (ink && t.edges?.outline && t.edges.outline !== 'none') out.push(`${LEVEL_WORD[t.edges.outline]} dark outlines`);
  if (t.shapes?.language?.length) out.push(`shapes: ${listOf(t.shapes.language)}`);
  if (t.shapes?.chunkiness != null) out.push(t.shapes.chunkiness > 0.6 ? 'big simple chunky masses' : 'fine detail');
  if (t.lighting?.time) out.push(`${t.lighting.time} light${t.lighting.key ? ` (a ${colourWords(t.lighting.key)} sun)` : ''}`);
  return out.join('; ');
}

/** The style anchor: one sheet that sets the look (a few sample subjects on one plain background). */
export function anchorPrompt(target, { subjects = [], keep = null } = {}) {
  // what the look must keep, in our own words. A target measured from reference frames reads them in words that
  // describe the reference's own art (its characters, its buildings): those never go to a maker, so such a target's
  // anchor says only what `keep` says
  const lines = keep ?? (/refs/.test(target?.from ?? '') ? [] : target?.reads ?? []);
  const reads = lines.slice(0, 4).map(r => r.replace(/\.$/, '')).join('; ');
  // what the legal line keeps out is for us, not for the picture model (it has never seen the reference)
  const avoid = (target?.avoid ?? []).filter(a => !/reference/i.test(a)).slice(0, 3).join('; ');
  return [
    'An original style sheet of concept art for a new video game, our own design.',
    `The style: ${styleWords(target)}.`,
    reads ? `What the look must keep: ${reads}.` : '',
    subjects.length ? `Show, spaced apart on a plain light background: ${subjects.join('; ')}.` : '',
    'Clean game-ready concept art, every object whole and clearly separated, no text, no logos, no user interface, no frame.',
    avoid ? `Avoid: ${avoid}.` : '',
  ].filter(Boolean).join(' ').slice(0, 1500);
}

/** One asset's concept, drawn in the anchor's style (the anchor is the image-to-image reference). */
export function conceptPrompt(item, target) {
  const what = item.words;
  if (item.kind === 'texture') {
    return [`A seamless, tileable square texture: ${what}.`, 'Seen straight on, filling the whole frame edge to edge, no perspective, no objects on top, no shadows from outside, no border.',
      `Painted in exactly the art style of the reference sheet (${styleWords(target)}).`, 'No text, no logos.'].join(' ').slice(0, 1500);
  }
  // a held thing (a weapon, a tool) floats with no stand: "on its own base" gave the pilot's launcher a plinth
  // a set piece (a castle, a mesa) stands on the world's own ground: a base or a chunk of land under it would float or sink
  const pose = item.kind === 'body' ? POSE_OF[item.archetype ?? 'humanoid'] ?? 'in a neutral standing pose, three-quarter view'
    : item.held ? 'seen from the side and slightly above, floating, with no base, stand or plinth'
    : (item.size ?? 1) > SET_PIECE ? 'three-quarter view from slightly above, standing straight, its bottom flat and level, with no base, plinth, island or chunk of ground under it'
    : 'three-quarter view from slightly above, standing on its own base';
  // a concept that becomes a 3D model carries no drawn ink: the game draws outlines; painted lines would bake into it
  return [`A single ${item.kind === 'body' ? 'game character' : '3D game prop'}: ${what}.`, `The whole ${item.kind === 'body' ? 'body' : 'object'} in view, ${pose}, centred.`,
    `In exactly the art style of the reference sheet: the same palette, shading and proportions (${styleWords(target, { ink: false })}).`,
    'Rendered as a clean 3D-looking model with no drawn outlines. Only this one subject, none of the other things on the sheet. Even soft lighting, plain white background, no floor, no shadow, no text or logos.'].join(' ').slice(0, 1500);
}

/** What one item costs and what happens to it after. */
export function recipe(item, target = null) {
  const steps = [{ step: 'concept', endpoint: '/v1/image-to-image', credits: COST['image-to-image'] }];
  let rig = null, next = null;
  if (item.kind === 'body' || item.kind === 'prop') steps.push({ step: '3d', endpoint: '/v1/image-to-3d', credits: COST['image-to-3d'] });
  if (item.kind === 'body') {
    const arch = item.archetype ?? 'humanoid';
    rig = RIG_OF[arch] ?? null;
    if (arch === 'humanoid') steps.push({ step: 'rig', endpoint: '/v1/rigging', credits: COST.rigging });
    else if (rig) { steps.push({ step: 'autorig', endpoint: 'local: gamesfun art autorig --archetype ' + arch, credits: COST.autorig }); next = `ingest with --autorig ${arch}: rig-check judges it on ${rig}`; }
    else next = `a ${arch} body: no rig standard for that archetype (${Object.keys(RIG_OF).join(', ')})`;
  }
  const ingest = item.kind === 'texture' ? { category: 'texture', tile: item.tile !== false } : item.kind === 'picture' ? { category: 'picture' }
    : { category: item.kind, size: item.size ?? 1, ...(item.kind === 'prop' ? { collider: item.collider ?? (item.held ? 'none' : 'box') } : {}) };
  return { id: item.id, look: item.look ?? null, steps, credits: steps.reduce((a, s) => a + s.credits, 0), rig, archetype: item.archetype ?? null, polycount: item.polycount ?? 6000, prompt: conceptPrompt(item, target), ingest, next };
}

/** A wave's cost: the anchor once, then every item. */
export function waveCost(items, { anchors = 1 } = {}) {
  const byStep = { anchor: anchors * COST['text-to-image'] };
  for (const it of items) for (const s of recipe(it).steps) byStep[s.step] = (byStep[s.step] ?? 0) + s.credits;
  return { credits: Object.values(byStep).reduce((a, b) => a + b, 0), byStep };
}

/** Frames a flat (2D) body takes as separate pictures: standing, moving, acting, hit. */
export const FLAT_BODY_FRAMES = 4;
/**
 * The items a whole art set for one look would take, every piece made new in the look's one style: each body, prop,
 * texture and picture a need list counts (library/coverage/needs.json), plus `setPieces` set pieces (a level's
 * landmarks: two levels of six by default). Fonts and sounds are not a maker's, and a need a runtime part draws (`code`)
 * stays code. A flat look's bodies, props and set pieces are pictures (a body FLAT_BODY_FRAMES of them).
 * → items for waveCost; `looks` anchors go with them (one a level).
 */
export function setItems(needs, { flat = false, setPieces = 12 } = {}) {
  const out = [];
  const add = (n, k, it) => { for (let i = 0; i < k; i++) out.push({ id: `${n.id}-${i + 1}`, words: n.words, ...it }); };
  for (const n of needs) {
    const k = n.count ?? 1;
    if (n.code || ['font', 'sound', 'clip'].includes(n.category)) continue;
    if (n.category === 'body') add(n, flat ? k * FLAT_BODY_FRAMES : k, flat ? { kind: 'picture' } : { kind: 'body', archetype: n.archetype ?? 'humanoid' });
    else if (n.category === 'prop') add(n, k, { kind: flat ? 'picture' : 'prop' });
    else if (n.category === 'texture') add(n, k, { kind: 'texture' });
    else add(n, k, { kind: 'picture' });
  }
  add({ id: 'set-piece', words: 'a level landmark' }, setPieces, { kind: flat ? 'picture' : 'prop' });
  return out;
}
