// gf-three vfx: effect STYLES. Pure data and one pure reader. A style says how this game's blasts, hits, smoke, trails
// and damage numbers are drawn, as lists of the presets in presets.js; the mechanics never name a preset for it, they
// call the part (index.js): vfx.blast(at, {radius}), vfx.hit(at, {dir}), vfx.trail(object), vfx.damage(at, amount).
// A game's style is config/game.json → fx ({style, blast, hit, trail, numbers, scale, outline}, one json slot `vfx.style`),
// written by create from the spec's look target (spec.look.target.vfx: styleFromFacts) and the presets it lists are
// copied into config/game.json → vfx like any other (each a slot).
//
//   cartoon   clusters of solid round puffs, chunky low-poly rocks and little bright puffs thrown far, a shock ring,
//             star sparks, big inked damage numbers that pop (the candy-cartoon artillery look)
//   fiery     a rolling fireball (a CC BY flipbook, credited), soft wispy smoke, stretched sparks, small rising numbers
//   pixel     square bits and square smoke, no stretching, small numbers
//   soft      the kit's party default: a puff of smoke, a spark pop, a flash (what a game with no style draws)

/** The styles, as preset lists. `numbers`: comic | float | none (the HUD's .gf-pop look, kind-hud.js numbers token). */
export const STYLES = Object.freeze({
  cartoon: { label: 'Cartoon puffs', blast: ['blast-puffs', 'blast-core', 'blast-chunks', 'blast-bits', 'impact-ring'], hit: ['hit-stars', 'hit-puff'], trail: 'trail-puffs', numbers: 'comic' },
  fiery: { label: 'Fire and smoke', blast: ['fireball', 'smoke-wisp', 'spark-burst', 'blast-shards'], hit: ['spark-burst', 'impact-flash'], trail: 'trail-smoke', numbers: 'float' },
  pixel: { label: 'Pixel bits', blast: ['pixel-burst', 'pixel-smoke'], hit: ['pixel-sparks'], trail: 'pixel-trail', numbers: 'float' },
  soft: { label: 'Soft party', blast: ['smoke-puff', 'spark-burst', 'impact-flash'], hit: ['impact-flash'], trail: null, numbers: 'float' },
});
export const STYLE_NAMES = Object.freeze(Object.keys(STYLES));

const SMOKE = { puffs: 'blast-puffs', wispy: 'smoke-wisp' };
const DEBRIS = { chunks: 'blast-chunks', shards: 'blast-shards', sparks: 'spark-burst' };
const SPARKS = { stars: 'hit-stars', streaks: 'spark-burst', dots: 'blast-bits' };
const TRAIL = { puffs: 'trail-puffs', ribbon: 'trail-smoke', streak: 'trail-smoke' };
const SCALE = { none: 0.6, low: 0.8, mid: 1, high: 1.35 };
const SMOKES = new Set(Object.values(SMOKE)), DEBRISES = new Set(Object.values(DEBRIS)), SPARKSET = new Set(Object.values(SPARKS));
const uniq = xs => [...new Set(xs.filter(Boolean))];

/**
 * A look target's effect facts (spec.look.target.vfx: explosion, smoke, debris, sparks, rings, numbers, trail, scale,
 * palette, outline) → config/game.json → fx. The explosion picks the style; each other fact swaps its own part of the
 * style's lists, so a target that says "puffs, but shards" gets exactly that. Pure.
 */
export function styleFromFacts(v = {}) {
  const e = v.explosion ?? null;
  const style = e === 'puffs' || e === 'ink' ? 'cartoon' : e === 'fireball' || e === 'realistic' ? 'fiery' : e === 'pixel' ? 'pixel' : e === 'flash' ? 'soft'
    : v.smoke === 'puffs' ? 'cartoon' : v.smoke === 'wispy' ? 'fiery' : 'soft';
  const S = STYLES[style];
  let blast = [...S.blast], hit = [...S.hit];
  if (e === 'none') blast = [];
  if (v.smoke && v.smoke !== 'none' && SMOKE[v.smoke]) blast = [SMOKE[v.smoke], ...blast.filter(x => !SMOKES.has(x))];
  if (v.smoke === 'none') blast = blast.filter(x => !SMOKES.has(x));
  if (v.debris) blast = [...blast.filter(x => !DEBRISES.has(x) || x === SMOKE[v.smoke]), ...(DEBRIS[v.debris] ? [DEBRIS[v.debris]] : [])];
  if (v.rings === false) blast = blast.filter(x => x !== 'impact-ring');
  if (v.rings === true && !blast.includes('impact-ring')) blast.push('impact-ring');
  if (v.sparks) hit = v.sparks === 'none' ? hit.filter(x => !SPARKSET.has(x)) : uniq([SPARKS[v.sparks], ...hit.filter(x => !SPARKSET.has(x))]);
  const trail = v.trail === 'none' ? null : TRAIL[v.trail] ?? S.trail;
  const out = { style, blast: uniq(blast), hit: uniq(hit), trail, numbers: v.numbers ?? S.numbers, scale: SCALE[v.scale] ?? 1 };
  if (v.outline) out.outline = v.outline;
  if (v.palette?.length) out.palette = v.palette.slice(0, 4);
  return out;
}

/** Every preset a style block uses (what create copies into config/game.json → vfx). */
export const presetsOf = fx => uniq([...(fx?.blast ?? []), ...(fx?.hit ?? []), fx?.trail ?? null]);
