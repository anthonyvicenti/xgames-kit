#!/usr/bin/env node
// The kit's releases: the hash manifests verify holds a game's kit copy to (gate A, measure 2; builder/GATES.md).
//
// Until 2026-10-12 measure 2 compared a game's gf/three with the hash list inside the game's own gf/three/kit.js, a file
// in the game: an edit to a kit file and to that list together passed. Now the list belongs to the kit, as gf/mp's
// SHA256SUMS belong to gf-multiplayer's frozen releases: gf-three/kit-releases/<part>-<id>.json, one file a
// release, each the sha256 of every file of that part of the kit (`three` → gf/three, `scenic` → gf/scenic, `forge` →
// gf/forge, `vista` → gf/vista). A game's copy passes when one release holds every file it has with the same hash (a
// game carries a subset: the mechanics and modules it uses); a file no release holds is an edit or not a kit file, and
// an unknown kit is a failure, never a note. The kit as it is in this checkout is always a release too (the live one),
// so a game create made a moment ago passes before anyone records it.
//
//   node builder/tools/lib/kit-release.mjs                 list the releases and the live kit
//   node builder/tools/lib/kit-release.mjs --record        record the live kit of every part (regress.mjs --record does)
//   node builder/tools/lib/kit-release.mjs --from <game>   record the kit a game's kit.js says create copied
//                                                                     (an older game made before a release was recorded)
// A release file is written once and never edited (its id is the hash of its list).
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GF3, REPO, KIT_VERSION } from './paths.mjs';
import { kitSourceFiles, scenicFiles, forgeFiles, vistaFiles } from './vendor.mjs';
import { isMain } from './main.mjs';

export const RELEASES = join(GF3, 'kit-releases');
export const PARTS = { three: 'gf/three', scenic: 'gf/scenic', forge: 'gf/forge', vista: 'gf/vista' };

/** A list's id: the first 12 hex of the sha256 of its sorted "sha  path" lines. */
export const releaseId = files => createHash('sha256').update(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([r, h]) => `${h}  ${r}`).join('\n')).digest('hex').slice(0, 12);

/** The live kit of one part, as this checkout has it: {rel: sha256}. */
export async function liveFiles(part) {
  return part === 'three' ? kitSourceFiles() : part === 'scenic' ? scenicFiles() : part === 'forge' ? forgeFiles() : part === 'vista' ? vistaFiles() : {};
}

/** Where releases are read from: the kit's own folder, and any GF_KIT_RELEASES names (a test's scratch folder, a
 *  machine that keeps older releases elsewhere; ':'-separated). */
export const releaseDirs = () => [RELEASES, ...String(process.env.GF_KIT_RELEASES ?? '').split(':').filter(Boolean)];

/** Every recorded release of one part, and the live kit: [{id, part, version, source, files}]. */
export async function releasesOf(part) {
  const out = [];
  const live = await liveFiles(part);
  if (Object.keys(live).length) out.push({ id: releaseId(live), part, version: part === 'three' ? KIT_VERSION : null, source: 'live', files: live });
  for (const dir of releaseDirs()) if (existsSync(dir)) for (const f of (await readdir(dir)).filter(n => n.startsWith(`${part}-`) && n.endsWith('.json')).sort()) {
    try { const r = JSON.parse(await readFile(join(dir, f), 'utf8')); if (r.part === part && r.files && !out.some(x => x.id === r.id)) out.push(r); } catch {}
  }
  return out;
}

/**
 * Hold a game's copy of one part (its files: {rel: sha256}) to the releases. → {ok, release (id) | null, source,
 * closest: {id, differ: [rel], extra: [rel], want: {rel: the release's sha256}} | null, releases: n}
 */
export async function matchRelease(part, have) {
  const rels = await releasesOf(part);
  let best = null;
  for (const r of rels) {
    const differ = [], extra = [], want = {};
    for (const [rel, h] of Object.entries(have)) { const w = r.files[rel]; if (w === undefined) extra.push(rel); else if (w !== h) { differ.push(rel); want[rel] = w; } }
    const score = differ.length + extra.length;
    if (!score) return { ok: true, release: r.id, version: r.version ?? null, source: r.source ?? null, closest: null, releases: rels.length };
    if (!best || score < best.differ.length + best.extra.length) best = { id: r.id, version: r.version ?? null, source: r.source ?? null, differ, extra, want };
  }
  return { ok: false, release: null, closest: best, releases: rels.length };
}

/** Write a release of one part (once: an id already there is kept as it is). → {id, file, wrote} */
export async function recordRelease(part, files, { source = 'live', version = null, at = new Date().toISOString(), dir = RELEASES } = {}) {
  const id = releaseId(files), file = join(dir, `${part}-${id}.json`);
  if (existsSync(file)) return { id, file, wrote: false };
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ schema: 'gf-three-kit-release/1', part, id, version, source, recorded: at, about: 'A kit release: the sha256 of every file of this part of the kit. tools/lib/kit-check.mjs (verify gate A, measure 2) holds a game\'s copy to the releases. Written once by tools/lib/kit-release.mjs; never edited.', files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))) }, null, 1) + '\n');
  return { id, file, wrote: true };
}

/** Record the live kit of every part. → [{part, id, wrote}] */
export async function recordLive() {
  const out = [];
  for (const part of Object.keys(PARTS)) { const files = await liveFiles(part); if (Object.keys(files).length) out.push({ part, ...(await recordRelease(part, files, { source: 'live', version: part === 'three' ? KIT_VERSION : null })) }); }
  return out;
}

/** Record the kit a game's own kit.js says create copied (an older game, made before a release was recorded). */
export async function recordFromGame(gameDir) {
  const text = await readFile(join(gameDir, 'gf/three/kit.js'), 'utf8');
  const rec = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  const source = `game: ${relative(REPO, resolve(gameDir)) || gameDir}`;
  const out = [{ part: 'three', ...(await recordRelease('three', rec.files ?? {}, { source, version: rec.version ?? null })) }];
  for (const part of ['scenic', 'forge', 'vista']) if (rec[part]?.files) out.push({ part, ...(await recordRelease(part, rec[part].files, { source, version: rec[part].version ?? null })) });
  return out;
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2);
  if (a.includes('--record')) for (const r of await recordLive()) console.log(`${r.wrote ? 'recorded' : 'already there'} ${r.part}-${r.id}`);
  else if (a.includes('--from')) { const g = a[a.indexOf('--from') + 1]; if (!g) { console.error('usage: kit-release.mjs --from <game>'); process.exit(2); } for (const r of await recordFromGame(resolve(g))) console.log(`${r.wrote ? 'recorded' : 'already there'} ${r.part}-${r.id} (from ${g})`); }
  else for (const part of Object.keys(PARTS)) { const rs = await releasesOf(part); console.log(`${part}: ${rs.map(r => `${r.id}${r.source === 'live' ? ' (live)' : ` (${r.source})`} ${Object.keys(r.files).length} files`).join(', ') || 'none'}`); }
}
