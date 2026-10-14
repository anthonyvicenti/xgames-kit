// mechanic: carve, its pure parts (no three.js, no ctx): the crater an explosion makes, and the edit feed a copy that is
// not the host keeps (edits arrive numbered; a gap asks the host for what is missing; a new round starts the count again).

/** The crater radius for a blast: the param when it is set, else the shot's splash times `scale`, held to [min, max]. 0: none. */
export function craterRadius({ radius = 0, scale = 1, minRadius = 0.6, maxRadius = 8 } = {}, splash = 0) {
  const r = radius > 0 ? radius : splash * scale;
  if (!(r > 0)) return 0;
  return Math.min(maxRadius, Math.max(minRadius, r));
}

/**
 * The feed of a copy that is not the host. take(round, i, edit) → 'apply' (the next one: apply it), 'old' (had it), or
 * 'gap' (one or more are missing: ask from `next`); round is the host's count of resets: a new one starts the feed again
 * (the caller resets its ground first: `fresh` says so).
 */
export function createFeed() {
  const f = {
    round: 0, next: 0, fresh: false,
    take(round, i, e) {
      f.fresh = false;
      if (round !== f.round) { f.round = round; f.next = 0; f.fresh = true; }
      if (i < f.next) return 'old';
      if (i > f.next) return 'gap';
      f.next++;
      return e ? 'apply' : 'old';
    },
    /** A log from `from` on: the edits to apply, in order (any it already had are skipped). */
    takeLog(round, from, list) {
      const out = [];
      f.fresh = false;
      if (round !== f.round) { f.round = round; f.next = 0; f.fresh = true; }
      for (let k = 0; k < list.length; k++) { const i = from + k; if (i === f.next) { out.push(list[k]); f.next++; } }
      return out;
    },
    reset(round = f.round) { f.round = round; f.next = 0; f.fresh = false; },
  };
  return f;
}

/** Split a log into messages of about `bytes` each (the net's messages stay small): [[from, [edits]]]. */
export function chunksOf(list, from = 0, bytes = 3000) {
  const out = [];
  let batch = [], start = from, size = 0;
  list.forEach((e, k) => {
    const n = JSON.stringify(e).length + 1;
    if (batch.length && size + n > bytes) { out.push([start, batch]); batch = []; size = 0; start = from + k; }
    batch.push(e); size += n;
  });
  if (batch.length) out.push([start, batch]);
  return out;
}
