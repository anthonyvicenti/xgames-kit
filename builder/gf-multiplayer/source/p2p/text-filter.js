// What a sign in a persistent world may say (research/worlds/PLAN.md §1 "Signs", §4.1). The play host's world store
// (lib/world-core.mjs) cleans every sign it saves, and the game cleans a sign before its room shares it: the gf-three
// kit vendors a byte-identical copy of this file. So it is pure and imports nothing.
//
//   cleanSignText(text) → {text, changed}
//
// 1. Normalise: NFKC (folds full-width, ligature, maths-alphabet and circled letters to plain ones), line breaks to
//    \n, every other control, zero-width, soft-hyphen and direction character dropped (an emoji keeps its joiners),
//    runs of spaces collapsed to one, each line trimmed.
// 2. At most SIGN_LINES lines and SIGN_CHARS characters in all (code points; line breaks don't count). Empty lines at
//    the end are dropped.
// 3. Slurs and strong profanity are masked with '*', one per character. The match looks through:
//    - case, accents, look-alike Cyrillic and Greek letters, and common digit and symbol swaps ("n1gg3r", "$h!t");
//    - stretched letters ("fuuuck");
//    - letters spaced or dotted apart ("f u c k", "f.u.c.k"), and a word split in two or three ("fu ck").
//    A slur hides its whole word; profanity hides the matched part ("****ing").
//    Words that only contain one by accident stay as written: Scunthorpe, assassin, therapist, spicy, raccoon, Japan,
//    Pakistan, shiitake, sniggering, niggardly, Fukushima, "this hit". Mild words (damn, crap, poop, butt, hell) are fine.
//
// The word list is our own (written for games.fun on 2026-10-09; not copied from any published list). Slurs against
// protected groups come first and are the hard line; strong profanity second; then a few harassment words.
// `changed` is true when the result differs from the input in any way (masking, trimming or normalising).

export const SIGN_LINES = 3, SIGN_CHARS = 60;

// Look-alike letters from other scripts and Latin letters that don't decompose, mapped to the plain letter they mimic.
const GLYPH = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'є': 'e', 'з': '3', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o',
  'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'ф': 'f', 'х': 'x', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ɡ': 'g', 'ɑ': 'a', 'ı': 'i', 'ł': 'l',
  'ø': 'o', 'đ': 'd', 'ħ': 'h', 'ŧ': 't', 'ƒ': 'f', 'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p',
  'τ': 't', 'υ': 'u', 'χ': 'x', 'ω': 'w', 'ϲ': 'c',
  // Armenian and other look-alikes (the play-test of 2026-10-09 got "fսck" past with an Armenian ս)
  'ս': 'u', 'օ': 'o', 'ո': 'n', 'հ': 'h', 'ց': 'g', 'ք': 'p', 'զ': 'q', 'ɩ': 'i', 'ʋ': 'u', 'ɑ': 'a', 'ı': 'i',
};
// What each letter of a listed word may be written as. Every letter may also repeat ("fuuuck").
const CLASSES = { a: 'a@4', b: 'b8', c: 'c¢', e: 'e3€', g: 'g69q', i: 'i1!|l', l: 'l1|!', o: 'o0', s: 's5$', t: 't7+', u: 'uv' };
const WORDISH = /^[\p{L}\p{N}@$!|+€¢]+$/u;     // a character that can be part of a word (symbols that stand in for letters)
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const GENERIC_ENDS = 's|es|z|ed|er|ers|in|ing|y|ie|ies|a|ah|as|az|uh';

const piece = ch => `[${CLASSES[ch] ?? ch}]+`;
const pat = letters => [...letters].map(piece).join('');
const alt = list => list.split('|').map(pat).join('|');

// [letters, kind, endings, beginnings]. kind 'any': hidden wherever it appears inside a word; 'word': only as a whole
// word with one of the listed endings (or beginnings). Slurs hide the whole word.
const SLURS = [
  ['nigger', 'any'], ['nigga', 'any'], ['nigguh', 'any'], ['fagg', 'any'], ['fag', 'word', 's|ot|ots'], ['dyke', 'word', 's|y', 'bull'],
  ['tranny', 'word', 's'], ['trannie', 'word', 's'], ['shemale', 'any'], ['lesbo', 'word', 's'], ['homo', 'word', 's'],
  ['poofter', 'word', 's'], ['fudgepacker', 'any'], ['kike', 'word', 's'], ['kyke', 'word', 's'], ['yid', 'word', 's'],
  ['heeb', 'word', 's'], ['hymie', 'word', 's'], ['chink', 'word', 's|y'], ['gook', 'word', 's'], ['spic', 'word', 's|k|ks'],
  ['wetback', 'any'], ['beaner', 'word', 's'], ['coon', 'word', 's'], ['jigaboo', 'any'], ['jiggaboo', 'any'],
  ['zipperhead', 'any'], ['raghead', 'any'], ['towelhead', 'any'], ['paki', 'word', 's'], ['jap', 'word', 's'],
  ['dago', 'word', 's|es'], ['wop', 'word', 's'], ['wog', 'word', 's', 'golli'], ['sambo', 'word', 's'], ['darkie', 'word', 's'],
  ['darky', 'word'], ['honky', 'word'], ['honkey', 'word', 's'], ['honkie', 'word', 's'], ['redskin', 'word', 's'],
  ['injun', 'word', 's'], ['squaw', 'word', 's'], ['chinaman', 'word'], ['chinamen', 'word'], ['slanteye', 'any'],
  ['muzzie', 'word', 's'], ['pikey', 'word', 's'], ['gyppo', 'word', 's'], ['gypo', 'word', 's'],
  ['retard', 'word', 's|ed|o|os'], ['tard', 'word', 's'], ['spaz', 'word', 'es|y|ed|ing'], ['mongoloid', 'word', 's'],
];
const PROFANITY = [
  ['fuck', 'any'], ['phuck', 'any'], ['fuk', 'word', 's|ing|in|ed|er|ers|off|wit'], ['fuq', 'word', 's|ing|in|ed|er|ers'],
  ['fck', 'word', 's|ing|in|ed|er|ers'], ['fcuk', 'word', 's|ing|in|ed|er|ers'], ['shit', 'any'], ['cunt', 'any'],
  ['asshole', 'any'], ['arsehole', 'any'], ['bitch', 'any'], ['whore', 'any'], ['slut', 'any'], ['twat', 'any'],
  ['cocksucker', 'any'], ['dickhead', 'any'], ['wanker', 'any'], ['wank', 'word', 's|ed|ing|y'], ['jizz', 'any'], ['jism', 'word', 's'],
];
// "kill yourself" is found as one word run together across the spaces (the split-word pass), like "fu ck"
const HARASSMENT = [['kys', 'word'], ['rape', 'word', 's|d'], ['raping', 'word'], ['rapist', 'word', 's'],
  ['killyourself', 'any'], ['killurself', 'any'], ['killyoself', 'any'], ['killyaself', 'any']];
// Whole words that contain a listed word by accident.
const KEEP = new RegExp(`^(?:${alt('snigger|sniggers|sniggered|sniggering|sniggerer|niggard|niggards|niggardly|niggardliness|'
  + 'shiitake|shiitakes|shitake|shitakes|mishit|mishits|mishitting|shittim|scunthorpe')})$`, 'u');

const RULES = [...SLURS.map(r => [r, true]), ...PROFANITY.map(r => [r, false]), ...HARASSMENT.map(r => [r, true])]
  .map(([[letters, kind, ends = '', starts = ''], whole]) => ({
    any: kind === 'any' ? new RegExp(pat(letters), 'gu') : null,
    word: new RegExp(`^${starts ? `(?:${alt(starts)})?` : ''}${pat(letters)}${kind === 'any' || ends ? `(?:${alt(kind === 'any' ? GENERIC_ENDS : ends)})?` : ''}$`, 'u'),
    join: kind === 'any' ? letters.length >= 4 : letters.length >= 5,   // may be found split across two or three words
    whole,
  }));

/** The letters a character stands for: '' for a combining mark (it belongs to the letter before it). */
function skeleton(ch) {
  const s = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let out = '';
  for (const c of s) out += GLYPH[c] ?? c;
  return out;
}

// Spans [start, end) of `s` (one word's letters) to hide. `joined`: `s` is two or three words run together, so only a
// whole-word match counts (so "this hit" stays).
function findIn(s, joined = false) {
  if (KEEP.test(s)) return [];
  const spans = [];
  let lead = 0, trail = s.length;                      // the word without symbols at its ends ("slut!" → "slut")
  while (lead < trail && !LETTER_OR_DIGIT.test(s[lead])) lead++;
  while (trail > lead && !LETTER_OR_DIGIT.test(s[trail - 1])) trail--;
  const core = s.slice(lead, trail);
  for (const r of RULES) {
    if (joined) { if (r.join && r.word.test(s)) spans.push([0, s.length]); continue; }
    if (r.any) {
      for (const m of s.matchAll(r.any)) spans.push(r.whole ? [0, s.length] : [m.index, m.index + m[0].length]);
    } else if (r.word.test(s)) spans.push([0, s.length]);
    else if (core !== s && core && r.word.test(core)) spans.push([lead, trail]);
  }
  return spans;
}

function maskOnce(text) {
  const cps = Array.from(text), skel = cps.map(skeleton);
  const tokens = [];   // {start, end, s, at: the code point behind each letter of s, gap: separators before it}
  let cur = null;
  for (let i = 0; i < cps.length; i++) {
    const k = skel[i];
    if (k === '') { if (cur) cur.end = i; continue; }
    if (!WORDISH.test(k)) { cur = null; continue; }
    if (!cur) {
      const prev = tokens[tokens.length - 1];
      tokens.push(cur = { start: i, end: i, s: '', at: [], gap: prev ? i - prev.end - 1 : Infinity });
    }
    cur.end = i;
    for (const c of k) { cur.s += c; cur.at.push(i); }
  }
  const hidden = new Array(cps.length).fill(false);
  const hide = (tok, a, b) => {
    let i = tok.at[a];
    const last = tok.at[b - 1];
    for (; i <= last; i++) hidden[i] = true;
    for (; i <= tok.end && skel[i] === ''; i++) hidden[i] = true;   // marks on the last hidden letter
  };
  for (const tok of tokens) for (const [a, b] of findIn(tok.s)) hide(tok, a, b);
  // Letters spaced or dotted apart: "f u c k".
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && tokens[j].s.length === 1 && (j === i || tokens[j].gap <= 3)) j++;
    if (j - i >= 2) {
      const run = tokens.slice(i, j), s = run.map(t => t.s).join('');
      for (const [a, b] of findIn(s)) for (let k = a; k < b; k++) hide(run[k], 0, 1);
    }
    i = Math.max(j, i + 1);
  }
  // A word split in two or three: "fu ck", "nig ger".
  for (let i = 0; i < tokens.length; i++) {
    let s = tokens[i].s;
    for (let n = 1; n < 3 && i + n < tokens.length && tokens[i + n].gap <= 3; n++) {
      s += tokens[i + n].s;
      if (findIn(s, true).length) for (let k = i; k <= i + n; k++) hide(tokens[k], 0, tokens[k].s.length);
    }
  }
  return cps.map((c, i) => (hidden[i] ? (skel[i] === '' ? '' : '*') : c)).join('');
}

// Hiding a word can never reveal another, but run it until nothing changes so cleaning twice gives the same text.
function mask(text) {
  for (let i = 0; i < 4; i++) { const next = maskOnce(text); if (next === text) return text; text = next; }
  return text;
}

// Invisible characters: soft hyphen, joiners, direction marks and isolates, variation selectors, fillers, tags.
const INVISIBLE = /[\u{AD}\u{34F}\u{61C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{3164}\u{FE00}-\u{FE0F}\u{FEFF}\u{FFA0}\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const EMOJI_BEFORE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\u{FE0F}]$/u;
const JOINER = '\u{200D}', EMOJI_STYLE = '\u{FE0F}';   // kept inside an emoji (family, skin tone, red heart)

function lines(text, limitChars) {
  let left = limitChars;
  const out = text.split('\n').slice(0, SIGN_LINES).map(line => {
    const cps = Array.from(line.replace(/ {2,}/g, ' ').trim()).slice(0, Math.max(0, left));
    left -= cps.length;
    return cps.join('').trimEnd();
  });
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** A sign's text as it may be shown: normalised, at most 3 lines and 60 characters, slurs and strong profanity masked. */
export function cleanSignText(input) {
  const raw = typeof input === 'string' ? input : '';
  let t = raw.slice(0, 1000).normalize('NFKC')
    .replace(/\r\n?|[\u{85}\u{2028}\u{2029}]/gu, '\n')
    .replace(INVISIBLE, (m, at, all) => ((m === JOINER || m === EMOJI_STYLE) && EMOJI_BEFORE.test(all.slice(Math.max(0, at - 2), at)) ? m : ''))
    .replace(/[^\S\n]/g, ' ')
    .replace(/[\p{Cc}\p{Cs}]/gu, m => (m === '\n' ? m : ''));
  t = mask(lines(t, Infinity));        // masked before it is cut, so a cut can't leave half a word showing
  t = mask(lines(t, SIGN_CHARS));
  return { text: t, changed: t !== input };
}
