// verify gate A, measure 2: the kit copies in a game are the kit's releases. gf/three (and the runtime's gf/scenic,
// gf/forge or gf/vista) against the kit's own release manifests (tools/lib/kit-release.mjs, gf-three/
// kit-releases, and the kit as this checkout has it), never against the list inside the game's gf/three/kit.js: an
// unknown kit fails; gf/mp through the multiplayer kit's own checkKitReleased (any released gf-multiplayer version,
// unedited; a note when it is not the current one); audio/ and gf/gf-assets.js against their frozen SHA256SUMS;
// vendor/ against the pinned sources create copied from.
// Declared overrides (tools/lib/overrides.mjs, CONTRACT §1.7): a kit file the game changed on purpose is held to its
// release through the override's base: it passes when the base is the release's file, and fails, named, when the edit is
// undeclared or the base is wrong. A file that is never overridable (the guard, its refusals, a licence, gf/mp, forge's
// prebuilt core) fails when it is declared. The result's `edits` are the game paths changed without a good declaration
// (kitEditsOverlay hands them to the guard in verify's pages, which then counts them as the game's code).
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GF_AUDIO, walk, sha256 } from './paths.mjs';
import { matchRelease } from './kit-release.mjs';
import { KIT_VERSION as MP_VERSION, checkKitReleased } from '../../multiplayer/party/manifest.mjs';
import { addonClosure, pinnedSource } from './vendor.mjs';
import { readOverrides, withBases, neverWhy, partOf, undeclaredWords, wrongBaseWords } from './overrides.mjs';

async function sums(file) {
  const out = new Map();
  for (const line of (await readFile(file, 'utf8')).split('\n')) { const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim()); if (m) out.set(m[2], m[1]); }
  return out;
}

export async function checkKitCopies(gameDir) {
  const problems = [], notes = [], edits = [];
  let forgeGame = false, vistaGame = false;
  // the declared overrides: their form, the files that are never overridable, and each one's file on disk
  const { overrides, problems: formProblems } = await readOverrides(gameDir);
  problems.push(...formProblems);
  for (const [path, o] of overrides) {
    const never = neverWhy(path);
    if (never) { problems.push(`${path}: declared as an override, but ${never} is never overridable. Put the kit's file back (creating the game again does) and remove the override; build what the game needs in its own src/ modules`); edits.push(path); continue; }
    if (!partOf(path)) problems.push(`gf-three.json → overrides["${path}"]: not in any kit copy (gf/three, gf/scenic, gf/forge, gf/vista, gf/gf-assets.js, audio/, vendor/)`);
    else if (!existsSync(join(gameDir, path))) problems.push(`${path}: declared as an override, but the game has no such file (remove the override, or restore the file)`);
    else if (/^gf\/three\/core\/boot[\w-]*\.js$/.test(path) && !/from\s+['"]\.\/guard\.js['"]/.test(await readFile(join(gameDir, path), 'utf8'))) problems.push(`${path}: an override of a boot must still import './guard.js' (the guard is never overridable, and the boot is what installs it)`);
    notes.push(`${path}: a declared override (${o.why})`);
  }
  const held = (path, have, want, what) => {     // a file outside the release parts (audio, gf-assets, vendor) with one known hash
    const o = overrides.get(path);
    if (have === want) return true;
    if (o && !neverWhy(path)) { if (o.base === want) return true; problems.push(wrongBaseWords(path, o.base, want, what)); edits.push(path); return false; }
    problems.push(undeclaredWords(path, want, `${what} has other bytes`)); edits.push(path); return false;
  };
  // gf/three: every file in kit.js, unchanged, and nothing else
  const kitJs = join(gameDir, 'gf/three/kit.js');
  if (!existsSync(kitJs)) problems.push('gf/three/kit.js is missing (re-run create)');
  else {
    const text = await readFile(kitJs, 'utf8');
    let rec = null;
    try { rec = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch { problems.push('gf/three/kit.js does not parse'); }
    if (rec) {
      // each part of the kit (gf/three, and gf/scenic, gf/forge or gf/vista for its runtime and profile) is held to the kit's
      // RELEASES (tools/lib/kit-release.mjs: hash manifests that belong to the kit, never a list in the game): one
      // release must hold every file the game has, byte for byte. kit.js's own list must name what is there (other
      // tools read it), but it vouches for nothing: an edit made to a file and to kit.js together still fails
      forgeGame = rec.runtime === 'forge'; vistaGame = rec.runtime === 'vista';
      const parts = [['three', 'gf/three', rec.files ?? {}, `kit ${rec.version}`, 'runtimes/three/kit'],
        ...(rec.profile === 'scenic-3d' ? [['scenic', 'gf/scenic', rec.scenic?.files ?? null, `gf-scenic ${rec.scenic?.version}`, 'runtimes/three/profiles/scenic-3d/kit']] : []),
        ...(forgeGame ? [['forge', 'gf/forge', rec.forge?.files ?? null, `gf-forge ${rec.forge?.version}`, 'runtimes/forge/kit']] : []),
        ...(vistaGame ? [['vista', 'gf/vista', rec.vista?.files ?? null, `gf-vista ${rec.vista?.version}`, 'runtimes/vista']] : [])];
      for (const [part, sub, listed, name, src] of parts) {
        if (!listed) { problems.push(`gf/three/kit.js says the game runs on ${rec.profile ? `${rec.runtime}/${rec.profile}` : rec.runtime} but lists no ${sub} files (re-run create)`); continue; }
        const disk = {};
        for (const rel of (await walk(join(gameDir, sub))).filter(r => !(part === 'three' && r === 'kit.js'))) disk[rel] = sha256(await readFile(join(gameDir, sub, rel)));
        for (const rel of Object.keys(listed)) if (!(rel in disk)) problems.push(`${sub}/${rel}: missing (gf/three/kit.js lists it)`);
        // a declared override is held to the release through its base (the file as the release has it)
        const { have, declared } = withBases(`${sub}/`, disk, overrides);
        const m = await matchRelease(part, have);
        if (m.ok) { if (m.source !== 'live') notes.push(`${sub} is ${name}, the kit release ${part}-${m.release} (${m.source}); ${src} has moved on since (creating the game again moves it onto it)`); continue; }
        const c = m.closest;
        if (!c) { problems.push(`${sub}: no release of this part of the kit is known (gf-three/kit-releases)`); continue; }
        const closest = `the closest, ${part}-${c.id}${c.source === 'live' ? ', the kit as it is now' : ''}`;
        for (const rel of c.differ) edits.push(`${sub}/${rel}`);
        for (const rel of c.differ.slice(0, 8)) {
          const path = `${sub}/${rel}`, never = neverWhy(path);
          if (never) { if (!overrides.has(path)) problems.push(`${path}: edited (it matches no kit release; ${closest}, has other bytes), and ${never} is never overridable. Undo the edit (creating the game again puts the kit's file back); build what the game needs in its own src/ modules`); }
          else problems.push(declared.has(rel) ? wrongBaseWords(path, declared.get(rel).base, c.want?.[rel], `any kit release (${closest})`) : undeclaredWords(path, c.want?.[rel], `it matches no kit release; ${closest}, has other bytes`));
        }
        for (const rel of c.extra.slice(0, 8)) problems.push(`${sub}/${rel}: not a kit file (no kit release has it). A new module of the game's own goes in its src/ folder, imported by rules.js`);
        if (c.differ.length + c.extra.length > 16) problems.push(`${sub}: ${c.differ.length} edited and ${c.extra.length} unknown files in all`);
      }
      if (forgeGame && rec.forge?.files && rec.forge?.wasm && rec.forge.files['wasm/forge_web_bg.wasm'] !== rec.forge.wasm) problems.push(`gf/forge/wasm/forge_web_bg.wasm is not the build kit.js names (${String(rec.forge.wasm).slice(0, 12)})`);
      // gf/vista: the core's licence and attribution must travel with it
      if (vistaGame && rec.vista?.files) for (const need of ['core/LICENSE', 'core/ATTRIBUTION.md']) if (!(need in rec.vista.files)) problems.push(`gf/vista/${need}: the core's ${need.endsWith('LICENSE') ? 'licence' : 'attribution'} must travel with it (re-run create)`);
    }
  }
  // gf/mp
  const mp = await checkKitReleased(gameDir);
  for (const f of mp.missing) problems.push(`gf/mp/${f}: missing`);
  for (const f of mp.changed) problems.push(`gf/mp/${f}: differs from gf-multiplayer ${mp.version}`);
  for (const f of mp.extra) problems.push(`gf/mp/${f}: not a kit file`);
  if (mp.ok && !mp.latest) notes.push(`gf/mp is gf-multiplayer ${mp.version}, unedited; the current kit is ${MP_VERSION} (creating the game again moves it onto it)`);
  // audio/ and gf/gf-assets.js
  const audio = await sums(join(GF_AUDIO, 'SHA256SUMS'));
  for (const [f, h] of audio) { const cur = await readFile(join(gameDir, 'audio', f)).catch(() => null); if (!cur) problems.push(`audio/${f}: missing`); else held(`audio/${f}`, sha256(cur), h, 'gf-audio 1.5.0'); }
  for (const f of await walk(join(gameDir, 'audio'))) if (!audio.has(f)) problems.push(`audio/${f}: not a gf-audio 1.5.0 file`);
  const assetsSums = await sums(join(GF_AUDIO, '../gf-assets/SHA256SUMS'));
  const ga = await readFile(join(gameDir, 'gf/gf-assets.js')).catch(() => null);
  if (!ga) problems.push('gf/gf-assets.js: missing'); else held('gf/gf-assets.js', sha256(ga), assetsSums.get('gf-assets.js'), 'gf-assets 1.3.0');
  // vendor/: byte-identical to the pinned sources
  const pinned = pinnedSource;
  for (const rel of (await walk(join(gameDir, 'vendor'))).map(r => `vendor/${r}`)) {
    const src = pinned(rel);
    if (!src || !existsSync(src)) { problems.push(`${rel}: not a pinned library file`); continue; }
    held(rel, sha256(await readFile(join(gameDir, rel))), sha256(await readFile(src)), 'the pinned copy');
  }
  // a forge or vista game vendors no library: vendor/ must be empty, and nothing of three.js is imported
  if (forgeGame || vistaGame) return { ok: problems.length === 0, problems, notes, edits: [...new Set(edits)] };
  // every three.js addon the kit, the libraries and rules.js import is there
  const texts = [];
  for (const sub of ['gf/three', 'gf/scenic']) for (const rel of await walk(join(gameDir, sub))) if (/\.m?js$/.test(rel)) texts.push(await readFile(join(gameDir, sub, rel), 'utf8'));
  for (const f of ['vendor/n8ao/N8AO.js', 'vendor/postprocessing/postprocessing.module.js', 'rules.js', ...(await walk(join(gameDir, 'src'))).filter(r => /\.m?js$/.test(r)).map(r => `src/${r}`)]) texts.push(await readFile(join(gameDir, f), 'utf8').catch(() => ''));
  try { for (const a of await addonClosure(texts)) if (!existsSync(join(gameDir, 'vendor/three/examples/jsm', a))) problems.push(`vendor/three/examples/jsm/${a}: imported but not vendored (re-run create)`); }
  catch (e) { problems.push(e.message); }
  return { ok: problems.length === 0, problems, notes, edits: [...new Set(edits)] };
}

/**
 * verify's server overlay for a game with kit files changed and not declared (or declared with a wrong base): its
 * index.html with `globalThis.__GF_KIT_EDITS` set before any module runs, so the kit's guard counts those files as the
 * game's code (a pointer-lock call in an edited input module is then refused like one in rules.js). → Map | null (none)
 */
export async function kitEditsOverlay(gameDir, edits = null) {
  edits ??= (await checkKitCopies(gameDir).catch(() => ({ edits: [] }))).edits ?? [];
  if (!edits.length) return null;
  const html = await readFile(join(gameDir, 'index.html'), 'utf8').catch(() => null);
  if (html === null) return null;
  const tag = `<script>globalThis.__GF_KIT_EDITS=${JSON.stringify([...new Set(edits)]).replace(/</g, '\\u003c')};</script>`;
  const out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => `${m}\n${tag}`) : `${tag}\n${html}`;
  return new Map([['index.html', Buffer.from(out)]]);
}
