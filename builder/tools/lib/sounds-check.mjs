// verify check 18, "sounds play" (creator on Token Call Centre, 2026-10-07: "I asked audio to be added to the game but it
// wasn't added at all. Why is that?"). Static, no browser, runs in --quick and alone (`--check 18`).
//
// The game loads one sound list: assets.json → sounds → sounds (gf-audio's manifest, read by gf/gf-assets.js `sounds()`).
// A sound anywhere else is never loaded, and the kit's mechanics play their sounds with `optional: true`, so a missing id
// is silent: no console warning, nothing for check 3 or the play-tester to see. That is how the creator's four zombie death
// sounds were lost: the build agent put them in assets.json → sounds beside `version` and `sounds`, and its rules played
// `enemy-death-${n}` in place of the kit's `enemy-down`, so every zombie died in silence.
//
//   const r = await checkSounds('<game dir>');   // { ok, problems: [...], notes: [...], stats, detail }
//
// It fails when:
//   stray     assets.json → sounds holds a key other than version, buses and sounds (a sound put one level too high)
//   missing   a listed sound plays a file the game does not have
//   unplayed  an audio file in the game (an upload under assets/) that no listed sound plays and no game code names
//   unknown   game code (rules.js and the game's own scripts, not the kit copies) plays a sound id, or an id pattern from a
//             template string, that no listed sound has
// and notes (not failed yet) when a mechanic in config/game.json names a sound (soundCollect, soundHit, …) that is not
// listed: four delivered games have one (their pickups name "coin", which spec-config never lists), older than this check.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export const AUDIO_EXT = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.opus', '.webm']);
const SECTION_KEYS = new Set(['version', 'buses', 'sounds']);
// the kit's and the build's own folders: never the game's code
const SKIP = new Set(['gf', 'audio', 'vendor', 'evidence', 'node_modules', 'assets']);
const WHERE = 'assets.json → sounds → sounds';

const srcLeaves = src => (Array.isArray(src) ? src : [src]).flatMap(s => (s?.layers ? s.layers : [s])).filter(Boolean);

async function walk(dir, root, out, pred, skip = null) {
  let ents = [];
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = join(dir, e.name);
    // a folder whose name starts with a dot is the loop's or a tool's own (the loop's state, the look's option copies,
    // .verify), never the game's code (T8 run 1, 2026-10-14: the look step's copies inside the game failed measure 18)
    if (e.isDirectory()) { if (!e.name.startsWith('.') && !(skip && dir === root && skip.has(e.name))) await walk(p, root, out, pred, skip); }
    else if (pred(e.name)) out.push(relative(root, p).split('\\').join('/'));
  }
  return out;
}

/** The ids a piece of game code plays: `play('id'…)`, `play("id"…)` and `play(\`id-${n}\`…)` (a template is a pattern). */
export function playedIds(code) {
  const out = [];
  const re = /\bplay\s*\(\s*(?:(['"])([^'"\n]+)\1|`([^`\n]*)`)/g;
  for (let m; (m = re.exec(code));) {
    if (m[2] !== undefined) out.push({ text: m[2], test: id => id === m[2] });
    else {
      const t = m[3];
      if (!t.includes('${')) { out.push({ text: t, test: id => id === t }); continue; }
      const rx = new RegExp(`^${t.split(/\$\{[^}]*\}/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+')}$`);
      out.push({ text: t.replace(/\$\{[^}]*\}/g, '${…}'), test: id => rx.test(id) });
    }
  }
  return out;
}

export async function checkSounds(dir) {
  const problems = [], notes = [];
  const add = (rule, message) => problems.push({ rule, message });
  const played = new Set();
  let ids = [], manifest;
  try { manifest = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8')); }
  catch (e) { add('stray', `assets.json could not be read: ${e.message}`); return finish(); }
  const section = manifest.sounds ?? {};
  const listed = section.sounds && typeof section.sounds === 'object' && !Array.isArray(section.sounds) ? section.sounds : {};
  ids = Object.keys(listed);

  // stray: a sound one level too high is never loaded
  for (const [k, v] of Object.entries(section)) {
    if (SECTION_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && 'src' in v) add('stray', `"${k}" sits in assets.json → sounds, beside "sounds", so the game never loads it: move it into ${WHERE}`);
    else add('stray', `assets.json → sounds has the key "${k}"; only version, buses and sounds are read`);
  }

  // missing: a listed sound's file
  for (const [id, s] of Object.entries(listed)) for (const leaf of srcLeaves(s?.src)) {
    if (typeof leaf.file !== 'string') continue;
    const f = leaf.file.replace(/^\.\//, '');
    played.add(f);
    if (!existsSync(join(dir, f))) add('missing', `sound "${id}" plays ${f}, which the game does not have`);
  }

  // the game's own code (not the kit copies)
  const codeFiles = await walk(dir, dir, [], n => /\.(m?js)$/.test(n), SKIP);
  const code = [];
  for (const f of codeFiles) code.push({ f, text: await readFile(join(dir, f), 'utf8').catch(() => '') });

  // unplayed: an audio file nothing plays
  const audioFiles = await walk(join(dir, 'assets'), join(dir, 'assets'), [], n => AUDIO_EXT.has(extname(n).toLowerCase()));
  for (const a of audioFiles.map(f => `assets/${f}`)) {
    if (played.has(a)) continue;
    if (code.some(c => c.text.includes(a))) { notes.push(`${a} is named in game code, not in the sound list`); continue; }
    add('unplayed', `${a} is never played: no sound in ${WHERE} uses it`);
  }

  // unknown: an id game code plays that is not listed
  for (const { f, text } of code) for (const p of playedIds(text)) {
    if (!ids.some(p.test)) add('unknown', `${f} plays "${p.text}", but no sound in ${WHERE} ${p.text.includes('${…}') ? 'matches it' : 'has that id'}`);
  }

  // a mechanic's sound param that names no listed sound: a note for now (see the header)
  try {
    const game = JSON.parse(await readFile(join(dir, 'config/game.json'), 'utf8'));
    for (const m of game.mechanics ?? []) for (const [k, v] of Object.entries(m?.params ?? {})) {
      if (/^sound[A-Z]/.test(k) && typeof v === 'string' && v && !ids.includes(v)) notes.push(`config/game.json mechanic "${m.id ?? m.type}" ${k} is "${v}", which is not in ${WHERE} (silent)`);
    }
  } catch { /* no config: nothing to check here */ }

  return finish();

  function finish() {
    const stats = { sounds: ids.length, files: [...played].length };
    const ok = problems.length === 0;
    const detail = ok
      ? `${ids.length} sounds listed, ${stats.files} from files; every file and every id the game plays is in ${WHERE}`
      : `${problems.length} problem${problems.length > 1 ? 's' : ''}: ${[...new Set(problems.map(p => p.rule))].map(rule => {
          const of = problems.filter(p => p.rule === rule);
          return of.length > 1 ? `${of[0].message} (and ${of.length - 1} more like it)` : of[0].message;
        }).join(' | ')}`;   // one of each kind, so the detail names every way a sound was lost
    return { ok, problems, notes, stats, detail };
  }
}
