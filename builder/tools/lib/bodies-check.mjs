// verify check 19, "bodies hold their shape" (creator, 2026-10-07: "We need to work on a model judge for 3 models. We need
// to look at face, body, arms, legs, hands, and feet. We also need to make sure any animation does not distort these. We
// just made a game where the models look good, but the hand is crooked"). Static, no browser, runs in --quick and alone
// (`--check 19`).
//
// Every character body the game ships (assets.json → slots `character.body.*`, the file each slot loads) goes through
// the model judge's measuring tier (body-judge.mjs) with the game's own retarget (its vendored gf/three/character/rig.js)
// and its own clip file (slot `character.clips`): face, body, arms, hands, legs and feet, at rest and in the clips that
// role plays. A body any part of which fails fails the check. Token Call Centre as delivered fails it: on its kit copy
// the player's Quaternius hands fold at the palm and bend their fingers sideways in idle.
//
// The clips a role plays (2026-10-08, after the creator's roguelike lost four generated enemies to a face that stretched
// in `swim`, which no enemy of that game played): the player every clip but swim, sit, crouch and the emotes; any other
// role what enemies play (body-judge.mjs ENEMY_CLIPS); and for every role, the clips the game's own code plays
// (clipsInCode: rules.js and the files beside it).
//
// A body on one of the archetype standards beside gf-humanoid-1 (its slot's constraints.archetype, or the file's own
// gf_body extras: worm, blob, quadruped, flyer; kit/character/CREATURES.md) has no clips to be posed by: the creature
// judge (creature-judge.mjs) poses it through every action with the kit's own procedural motion and measures its body,
// head and limbs the same way (stretched, squeezed or folded skin, a part flying off, sinking or never touching the
// ground). Gate A widened for the archetypes (2026-10-14), no new measure.
//
//   const r = await checkBodies('<game dir>');   // { ok, detail, bodies: [{role, file, ok, parts, errors}], notes }
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { judgeBody, judgeSummary, PARTS, PART_LABEL, DEV_RIG, DEFAULT_CLIPS } from './body-judge.mjs';
import { flatOf } from './flat-reads.mjs';
import { decodePng } from './flat-png.mjs';
import { judgeCreature, creatureSummary } from './creature-judge.mjs';
import { io } from './char-deps.mjs';

/** The archetype a body file names in its gf_body extras (a creature), else null. */
async function creatureOf(file) {
  try {
    const doc = await (await io()).read(file);
    const x = doc.getRoot().listNodes().find(n => n.getName() === 'gf_body')?.getExtras() ?? {};
    const a = x.gfArchetype ?? { 'gf-worm-1': 'worm', 'gf-blob-1': 'blob', 'gf-quadruped-1': 'quadruped', 'gf-flyer-1': 'flyer' }[x.gfRig];
    return a && a !== 'humanoid' ? a : null;
  } catch { return null; }
}

/**
 * The clip names the game's own code plays: in its top-level .js files (rules.js and its siblings) and src/ (never gf/, vendor/
 * or audio/), comments left out, a name quoted as `….play('x'` / `play?.('x'` (not `audio.play`), `act('x'` or after
 * `anim:`, `fireAnim:` or `clip:`. (A sound called "throw" is not a clip the game plays.)
 */
export function clipsInCode(text) {
  const code = String(text).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const out = new Set();
  for (const m of code.matchAll(/([\w$?.\]\)]{0,40})\bplay\??\.?\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) if (!/audio|sound|sfx/i.test(m[1])) out.add(m[2]);
  for (const m of code.matchAll(/\bact\??\.?\(\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) out.add(m[1]);
  for (const m of code.matchAll(/\b(?:fireAnim|anim|clip)\s*:\s*['"`]([a-z][a-z0-9_]*)['"`]/g)) out.add(m[1]);
  return [...out];
}
async function namedInCode(dir) {
  const out = new Set();
  // the root's .js files (rules.js and its siblings) and the game's own modules under src/ (CONTRACT §1.7)
  const src = (await readdir(join(dir, 'src'), { recursive: true }).catch(() => [])).filter(f => /\.m?js$/.test(f)).map(f => join('src', f));
  for (const f of [...(await readdir(dir)).filter(f => f.endsWith('.js')), ...src]) for (const n of clipsInCode(await readFile(join(dir, f), 'utf8').catch(() => ''))) out.add(n);
  return [...out];
}

export async function checkBodies(dir) {
  const notes = [];
  const manifest = JSON.parse(await readFile(join(dir, 'assets.json'), 'utf8'));
  const slots = manifest.slots ?? [];
  const fileOf = s => s?.source?.file ?? s?.default?.file ?? s?.file ?? null;
  const bodies = slots.filter(s => /^character\.body\./.test(s.id) && fileOf(s));
  const rig = existsSync(join(dir, 'gf/three/character/rig.js')) ? join(dir, 'gf/three/character/rig.js') : DEV_RIG;
  if (rig === DEV_RIG) notes.push('no gf/three/character/rig.js in the game: judged with the dev kit\'s retarget');
  const clipsFile = fileOf(slots.find(s => s.id === 'character.clips'));
  const clips = clipsFile && existsSync(join(dir, clipsFile)) ? join(dir, clipsFile) : DEFAULT_CLIPS;
  if (!bodies.length) return { ok: true, detail: 'no character bodies (nothing to judge)', bodies: [], notes };
  // a flat game's body is a picture sheet: its own judge (gf/three/flat/index.js → bodyReport), never the model judge
  const flat = await flatOf(dir);
  const seen = new Map(), out = [];
  const named = await namedInCode(dir);
  for (const s of bodies) {
    const role = s.id.split('.').slice(2).join('.'), rel = fileOf(s);
    if (!existsSync(join(dir, rel))) { out.push({ role, file: rel, ok: false, errors: [`${rel} is missing`], parts: {} }); continue; }
    if (flat && s.type === 'image') {
      const r = flat.part.bodyReport(decodePng(await readFile(join(dir, rel))), { style: s.constraints?.sheet?.style ?? 'pixel', plane: flat.plane });
      out.push({ role, file: rel, ok: r.ok, picture: true, summary: r.summary, errors: r.errors, parts: {}, worst: {}, warnings: r.warnings.length, stats: r.stats });
      if (r.warnings.length) notes.push(`${role} (${rel}): ${r.warnings.slice(0, 3).join(' | ')}`);
      continue;
    }
    // a creature: its slot says its archetype, or the body file does
    const creature = s.constraints?.archetype && s.constraints.archetype !== 'humanoid' ? s.constraints.archetype : await creatureOf(join(dir, rel));
    if (creature) {
      const key = `${rel}|${creature}`;
      if (!seen.has(key)) seen.set(key, await judgeCreature(join(dir, rel), { archetype: creature }));
      const r = seen.get(key);
      const warns = r.warnings ?? [];
      out.push({ role, file: rel, ok: r.ok, creature: r.archetype, rig: r.rig, summary: r.ok ? '' : creatureSummary(r), errors: r.errors,
        parts: Object.fromEntries(Object.entries(r.parts ?? {}).map(([p, v]) => [p, v.na ? 'n/a' : v.ok ? 'pass' : 'fail'])), worst: Object.fromEntries(Object.entries(r.parts ?? {}).filter(([, v]) => v.worst).map(([p, v]) => [p, v.worst])),
        warnings: warns.length, stats: { poses: r.poses?.length ?? 0 } });
      if (warns.length) notes.push(`${role} (${rel}): ${warns.slice(0, 3).join(' | ')}${warns.length > 3 ? ` (+${warns.length - 3} more)` : ''}`);
      continue;
    }
    const as = role === 'player' ? 'player' : 'enemy', key = `${rel}|${as}`;
    if (!seen.has(key)) seen.set(key, await judgeBody(join(dir, rel), { rig, clips, role: as, extraClips: named }));
    const r = seen.get(key);
    const warns = PARTS.flatMap(p => r.parts[p].warnings.map(w => `${PART_LABEL[p]}: ${w}`));
    out.push({ role, file: rel, ok: r.ok, summary: r.ok ? '' : judgeSummary(r), errors: r.errors,
      parts: Object.fromEntries(PARTS.map(p => [p, r.parts[p].na ? 'n/a' : r.parts[p].ok ? 'pass' : 'fail'])),
      worst: Object.fromEntries(PARTS.filter(p => r.parts[p].worst).map(p => [p, r.parts[p].worst])),
      warnings: warns.length, stats: r.stats });
    if (warns.length) notes.push(`${role} (${rel}): ${warns.slice(0, 3).join(' | ')}${warns.length > 3 ? ` (+${warns.length - 3} more)` : ''}`);
  }
  const ok = out.every(b => b.ok);
  const detail = out.map(b => `${b.role} (${b.file}): ${b.ok && b.creature ? `a ${b.creature} on ${b.rig} whose body, head and limbs hold their shape in all ${b.stats.poses} actions of its procedural motion` : b.ok && b.picture ? `a picture sheet of ${b.stats.frames} frames in ${b.stats.rows} row${b.stats.rows === 1 ? '' : 's'} (cells of ${[].concat(b.stats.cell).join(' x ')} px) that holds the gf-flat-1 standard` : b.ok ? `face, body, arms, hands, legs and feet hold their shape in the ${b.stats?.clips ?? '?'} clips it plays` : `FAIL ${b.summary || b.errors.join('; ')}`}`).join(' · ');
  return { ok, detail: ok ? detail : `${detail} (${out.some(b => b.picture && !b.ok) ? 'node gf-three/tools/flat-judge.mjs <file.png> --kind body shows a picture body\'s rules; ' : ''}${out.some(b => b.creature && !b.ok) ? 'npx gamesfun rig-check <file> --archetype <its archetype> shows a creature\'s every action, and npx gamesfun art autorig <mesh.glb> --archetype <it> rigs a plain mesh again (CREATURES.md); ' : ''}${out.some(b => !b.creature && !b.picture && !b.ok) ? 'node gf-three/tools/model-judge.mjs <file> --rig gf/three/character/rig.js shows every part; a body from the library: pick one that passes, or the kit\'s retarget is wrong for it' : 'a body from the library: pick one that passes'})`, bodies: out, notes };
}
