// Small word helpers the checks share. None of them routes on a word of the idea: they hold the agent's own writing to
// the creator's words (a quote is a quote, a card names what it keeps) and to plain honesty (no reply narrows the idea).
const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'with', 'you', 'your', 'it', 'its', 'is', 'are', 'by', 'for', 'from', 'each', 'every', 'that', 'as', 'at', 'no', 'not', 'yet']);
const stem = w => w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '');
const content = t => new Set(String(t ?? '').toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w)).map(stem));
const flat = s => String(s ?? '').toLowerCase().replace(/[‘’]/g, '\'').replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/** Is `quote` the creator's own words (any case, any spacing), in one of `sources`? */
export const quoted = (quote, ...sources) => {
  const q = flat(quote);
  return q.length >= 2 && sources.some(s => flat(s).includes(q));
};

/** Does `text` name `feature`? Half its content words (at least one, at most three). */
export function names(text, feature) {
  const f = [...content(feature)], t = content(text);
  if (!f.length) return false;
  const need = Math.min(3, Math.max(1, Math.ceil(f.length / 2)));
  return f.filter(w => t.has(w)).length >= need;
}

/** Words that narrow an idea to the kit ("Not in this kit yet: …"): never said to a creator (2026-10-12). */
export const NARROWING = /\b(not\s+in\s+(this|the)\s+kit(\s+yet)?|(is|are)n[’']?t\s+(supported|in\s+the\s+kit)\s+yet|not\s+(supported|built)\s+yet|(this|the)\s+kit\s+(can[’']?t|cannot|does\s+not|doesn[’']?t|lacks|has\s+no)|missing\s+from\s+(this|the)\s+kit|the\s+closest\s+(this|the)\s+kit\s+(has|can))\b/i;
/** The reply says building something new takes longer. */
export const LONGER = /\b(longer|more\s+time|extra\s+time|slower|adds?\s+(some\s+|a\s+few\s+|several\s+)?(time|minutes)|(few|several|some)\s+(more|extra)\s+minutes|takes?\s+(a\s+(bit|little)\s+)?(more|longer))\b/i;
/** A build line's `how` says what will be written. */
export const HOW_BUILD = /\b(rules(\.js)?|modules?|engine|overrid\w*|shaders?|generat\w*|systems?|code|writ(e|es|ten|ing)|scripts?|config|components?|files?|tables?|src\/)/i;

export const list = (xs, n = 4) => {
  const a = xs.slice(0, n).map(x => `"${x}"`);
  return xs.length > n ? `${a.join(', ')} and ${xs.length - n} more` : a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : a.join('');
};
