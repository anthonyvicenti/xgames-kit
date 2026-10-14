// Blinding: a judge never learns which arm, loop, kit or model made the game it reads. The plan gives every run an
// opaque bundle id; the bundle holds only what the case says and what the witness saw; the map from bundle id to run
// is written into sealed/ and no judge process is given that path.

/** A small seeded random number generator (mulberry32): the same seed gives the same plan on any machine. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A shuffled copy (Fisher-Yates with the seeded generator). */
export function shuffle(list, seed) {
  const r = rng(seed), out = [...list];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

const ALPHABET = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** One opaque id per key: 'J' + 6 characters, unique, from the seed. → {key: id} */
export function blindIds(keys, seed) {
  const r = rng(seed ^ 0x5bd1e995), ids = {}, used = new Set();
  for (const k of keys) {
    let id;
    do { id = 'J' + Array.from({ length: 6 }, () => ALPHABET[Math.floor(r() * ALPHABET.length)]).join(''); } while (used.has(id));
    used.add(id); ids[k] = id;
  }
  return ids;
}

/**
 * Names that would tell a reader which arm made a game: the kits, the products, the loops and the models. The witness
 * never knows the arm either, so this is a second line; everyday words (a car's engine, a garden gate) are left alone.
 * The game's own screens are not scrubbed: they are the game.
 */
export const ARM_WORDS = [
  'gf-three', 'gf-scenic', 'gf-forge', 'gf-vista', 'gf-flat', 'gamesfun-kit', 'gamesfun', 'games.fun', 'xgames-kit',
  'xgames', 'studio-worker', 'studio v2', 'creator studio', 'old loop', 'new loop', 'old arm', 'new arm',
  'claude', 'opus', 'sonnet', 'haiku', 'fable',
];

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Text with every arm word (and any extra) replaced by [hidden], whole words only, any case. */
export function scrub(text, extra = []) {
  let out = String(text ?? '');
  for (const w of [...ARM_WORDS, ...extra].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\w-])${escape(w)}s?(?![\\w-])`, 'gi'), '[hidden]');
  }
  return out;
}

/**
 * The bundle a reader gets for one run: the case's own words and the witness's evidence, nothing else.
 * kase: the case file. witness: {log: text, captures: [{file, t, what, screen}], probe: {summary}} from the runner.
 * For a run that delivered nothing, witness is null and lastWords (what the loop said) goes in, scrubbed.
 */
export function bundleFor({ blindId, kase, delivered, witness, lastWords = '' }) {
  const b = {
    schema: 'xgk-eval-bundle/1', blindId, set: kase.set,
    prompt: kase.prompt,
    images: (kase.images ?? []).map(i => ({ label: i.label, file: `images/${i.label}${i.ext ?? ''}`, describe: i.describe ?? '' })),
    control: { text: kase.control.text },
    delivered,
  };
  if (kase.ledger) b.ledger = kase.ledger.map(({ id, about, core, words, means }) => ({ id, about, core, words, means }));
  if (kase.musts) b.musts = kase.musts.map(({ id, type, must }) => ({ id, type, must }));
  if (kase.policy) b.policy = [...kase.policy];
  if (kase.multiplayer) b.multiplayer = { ...kase.multiplayer };
  if (delivered) {
    b.witness = { log: 'witness.md', captures: (witness?.captures ?? []).map(({ file, t, what, screen }) => ({ file, t, what: scrub(what), screen })) };
    b.twoPlayer = witness?.probe ? { summary: scrub(witness.probe.summary) } : null;
  } else {
    b.lastWords = scrub(lastWords);
  }
  return b;
}

/** The witness's log as the reader gets it. */
export const witnessText = log => scrub(log);

/** Problems if a bundle could tell its reader the arm: any record field that names it, or an arm word left in. */
export function leaks(bundle, record) {
  const text = JSON.stringify(bundle).toLowerCase(), p = [];
  for (const key of ['arm', 'runKey', 'loop', 'model', 'setHash', 'caseHash', 'pass']) if (key in bundle) p.push(`field ${key} is in the bundle`);
  const tells = [record?.loop?.name, record?.loop?.commit, record?.runKey, ...(record?.model?.used ?? [])].filter(Boolean);
  for (const t of tells) if (text.includes(String(t).toLowerCase())) p.push(`the bundle contains "${t}"`);
  for (const w of ARM_WORDS) if (new RegExp(`(?<![\\w-])${escape(w)}(?![\\w-])`, 'i').test(scrubFree(bundle))) p.push(`arm word "${w}" left in`);
  return p;
}
// The bundle's free text (witness captions, the probe summary, last words); the case's own words are not checked,
// because they are the same for both arms.
const scrubFree = b => [b.lastWords, b.twoPlayer?.summary, ...(b.witness?.captures ?? []).map(c => c.what)].filter(Boolean).join('\n');
