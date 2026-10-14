// The loop's state: one small JSON file per game, written only by the loop, read by gamesfun_next, a stop guard and
// the studio page. Schema gf-loop/2 (no reader of gf-loop/1: there is no backwards compatibility, 2026-10-13).
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

export const STATE_SCHEMA = 'gf-loop/2';
export const STATE_DIR = '.gf-loop';
export const stateFileOf = game => join(game, STATE_DIR, 'state.json');

/** A fresh state. `kind`: 'build' (from an idea) or 'change' (a game that exists). */
export function newState(kind = 'build') {
  return {
    schema: STATE_SCHEMA, kind, status: 'building', step: 'ledger', why: kind === 'change' ? 'a change request' : 'a new idea',
    prompt: null, references: [], request: null,
    ledger: null, foundation: null, pitch: null, choice: null, lock: null, promises: null,
    handed: null, round: 0, rounds: [], delivery: null,
    verify: null, verifies: 0, kept: null, playtest: null, playtests: 0,
    ladder: null, ladders: [], talk: { sets: [], strong: false },
    change: null, questions: null, waiting: null, answers: [], outcome: null, refusals: [], history: [], updated: null,
    created: null, fresh: false, session: null,
  };
}

/** A store that lives in memory (a test, a host that keeps the state elsewhere). */
export function memoryStore(initial = null) {
  let s = initial ? structuredClone(initial) : null;
  return { file: null, load: async () => (s ? structuredClone(s) : null), save: async v => { s = structuredClone(v); } };
}

/** A store in a file, written to a temporary file and renamed, so a kill leaves the old state or the new one. */
export function fileStore(file) {
  return {
    file,
    async load() {
      try {
        const s = JSON.parse(await readFile(file, 'utf8'));
        return s?.schema === STATE_SCHEMA ? s : null;
      } catch { return null; }
    },
    async save(s) {
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(s, null, 2) + '\n');
      await rename(tmp, file);
    },
  };
}

/**
 * The file store with the truth held in this process: once the loop has saved, load() answers from memory, and a state
 * file that is not what the loop last saved is written again (takeChanged() says so once). The MCP server keeps one per
 * game; builder/lib/loop-seal.mjs seals it for processes that hold nothing in memory.
 */
export function heldStore(file) {
  const base = fileStore(file);
  let held = null, text = null, changed = false;
  return {
    file,
    async load() {
      if (!held) return base.load();
      let disk = null;
      try { disk = await readFile(file, 'utf8'); } catch { /* gone: written again below */ }
      if (disk !== text) { changed = true; await base.save(held); }
      return structuredClone(held);
    },
    async save(s) { await base.save(s); held = structuredClone(s); text = JSON.stringify(s, null, 2) + '\n'; },
    takeChanged() { const c = changed; changed = false; return c; },
  };
}

/**
 * The loop's folder inside a game is not a game asset: gate A's coverage measure fails a file with no slot and no
 * ignore entry, so assets.json gets the ignore entry once. → true when it wrote assets.json (a game without one is left alone).
 */
export async function ignoreStateDir(game) {
  const file = join(game, 'assets.json');
  let m;
  try { m = JSON.parse(await readFile(file, 'utf8')); } catch { return false; }
  if ((m.ignore ?? []).some(g => String(g?.path ?? '').startsWith(STATE_DIR))) return false;
  m.ignore = [...(m.ignore ?? []), { path: `${STATE_DIR}/**`, reason: 'the creation loop\'s own folder (builder/loop), not a game asset' }];
  await writeFile(file, JSON.stringify(m, null, 2) + '\n');
  return true;
}

const SKIP = new Set([STATE_DIR, 'evidence', 'node_modules', '.git']);

/**
 * What a host leaves out when it uploads, shows or publishes a game's files: the loop's own folder (state, checkpoints,
 * the play-tester's and the reader's folders), verify's evidence, node_modules, and every dot name (the kit writes two:
 * `.gf-loop` and create's `.gitignore`; a dot name is never a file the game's page loads). One rule, so every host skips
 * the same things: isHostSkipped(rel) or deliverableFiles(game).
 */
export const HOST_SKIP = Object.freeze([STATE_DIR, 'evidence', 'node_modules']);
export const isHostSkipped = rel => String(rel).split(/[\\/]/).some((part, i) => part.startsWith('.') || (i === 0 && HOST_SKIP.includes(part)) || part === 'node_modules');
/** The game's files a host delivers, relative and sorted (links never followed). */
export async function deliverableFiles(game) {
  const out = [];
  const walk = async (dir, rel) => {
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isHostSkipped(r) || e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(join(dir, e.name), r); else if (e.isFile()) out.push(r);
    }
  };
  await walk(game, '');
  return out.sort();
}
/** One sha256 over every file's path and content, sorted by path. Proof counts only for the files it ran on. */
export async function filesHash(dir) {
  const files = [];
  const walk = async d => {
    let entries = [];
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP.has(e.name) || e.isSymbolicLink()) continue;
      const f = join(d, e.name);
      if (e.isDirectory()) await walk(f);
      else if (e.isFile()) files.push(f);
    }
  };
  await walk(dir);
  files.sort();
  const h = createHash('sha256');
  for (const f of files) h.update(relative(dir, f).split('\\').join('/')).update('\0').update(await readFile(f)).update('\0');
  return h.digest('hex');
}

/** The proof on record against the files now: each 'fresh' | 'stale' | 'none'. */
export function proofOf(s, hashNow) {
  const of = r => (!r ? 'none' : r.hash && r.hash === hashNow ? 'fresh' : 'stale');
  const verify = of(s.verify), playtest = of(s.playtest);
  return { hash: hashNow, verify, playtest, stale: [verify === 'stale' ? 'verify' : null, playtest === 'stale' ? 'playtest' : null].filter(Boolean) };
}

export const sha = text => createHash('sha256').update(String(text)).digest('hex');
