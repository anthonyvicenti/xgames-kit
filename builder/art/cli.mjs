#!/usr/bin/env node
// art: the asset library from a terminal.
//
//   art ingest <path|url> --pack <id> [options]        take files (a file, a folder, a zip, a URL) into a pack
//   art find "<words>" [--kind <k>] [--3d|--2d|--audio] [--category <c>] [--devices phone,desktop] [--all] [--json]
//   art fill <game folder | assets.json> [--kind <k>] [--runtime three] [--devices …] [--provided a,b] [--write] [--json]
//   art objectives <game folder> [--yes] [--maker meshy] [--json]
//                                                      what the game's objectives draw (a pickup, a carried item, a goal),
//                                                      each slot filled by meaning: the library, else a maker in the look's
//                                                      style (paid: only with --yes), else the stand-in and why (objectives.mjs)
//   art fetch <pack>/<asset> [--to <file>]              the asset's bytes: the store, the kit's default set, a mirror, or
//                                                      rebuilt from the pack's pinned source
//   art check                                          every manifest against the schemas, every binary on this machine
//   art autorig <mesh.glb> --archetype worm|blob|quadruped|flyer --out <body.glb> [--height m] [--turn deg] [--id id]
//                                                      a plain mesh rigged on that archetype's standard, then judged
//                                                      (builder/art/rig/autorig.mjs, rig-check; CREATURES.md)
//   art coverage [--case <file>] [--kind <k>] [--json]   what the library holds for a look: by pack, then every need of
//                                                      library/coverage/needs.json (or a case's) as have / off-style /
//                                                      missing / code, against a case's look target or a kind
//   art harmonize --pack <id> --look <target.json | config/look.json | game | kind> [--level <id>] [--style pixel|drawn]
//                 [--into <pack>] [--only a,b] [--public] [--dry] [--json]
//                                                      the style pass baked: the pack's assets moved toward one look as NEW
//                                                      assets in a derived pack (provenance in each one's `harmonized`),
//                                                      the originals untouched; before and after measured (harmonize.mjs)
//
// ingest options: --include <glob> (repeat) --exclude <glob> --category <c> --style pixel|drawn --plane side|top
//   --tile-set blend|connect|dress (a 2D tile that is a kind's 16 edges or its dressing strip, gf-flat-1 §4b)
//   --texels <n> --tags a,b --describe "…" --from "…" --id <id> --id-from name|path --as-is --ktx2 --max-texture <px>
//   --replace (make an asset of the same id again in place) --retarget <id> --fix <id> (builder/art/rig) --peak <dBFS>
//   --autorig worm|blob|quadruped|flyer (a plain mesh rigged on that archetype's standard; --height m, --turn deg)
//   --collider box|cylinder|trunk|none (a prop's collider fitted to its measured size)
//   to start a pack: --licence <spdx> --author "…" --url <u> --credit "…" --licence-file <f> --title "…"
//   --owner own|third-party|generated --private --source-kind zip|git|maker|own|collection --download <u> --zip-sha256 <h>
//   --repo <u> --commit <c> --page <u> --maker <m>
import { readFileSync, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { fillGame } from './fill.mjs';
import { allAssets, loadLibrary } from './library.mjs';
import { schemas } from './manifest.mjs';
import { loadPolicy } from './policy.mjs';
import { lazyRenderer } from './render.mjs';
import { find, loadKind } from './resolve.mjs';
import { fetchAsset, localPath } from './store.mjs';
import { copyFileWritable } from '../lib/writable.mjs';

export function parse(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2), v = argv[i + 1];
    if (['3d', '2d', 'audio', 'all', 'json', 'as-is', 'ktx2', 'private', 'write', 'replace', 'public', 'dry', 'yes'].includes(k) || v === undefined || v.startsWith('--')) { o[k] = true; continue; }
    if (k === 'include' || k === 'exclude') (o[k] ??= []).push(v); else o[k] = v;
    i++;
  }
  return { pos, o };
}

/** The ingest options a command line gives (also what a pack's rebuild line gives: rebuild.mjs). */
export function ingestOptions(o) {
  const sourceKind = o['source-kind'];
  return {
    pack: o.pack, include: o.include, exclude: o.exclude, category: o.category, style: o.style, plane: o.plane, tileSet: o['tile-set'],
    texelsPerMetre: o.texels ? Number(o.texels) : undefined, tags: o.tags?.split(','), describe: o.describe, from: o.from, rig: o.rig, role: o.role, id: o.id, idFrom: o['id-from'],
    replace: !!o.replace, retarget: o.retarget, fix: o.fix, peak: o.peak !== undefined ? Number(o.peak) : undefined,
    autorig: o.autorig, height: o.height ? Number(o.height) : undefined, turn: o.turn ? Number(o.turn) : undefined,
    collider: o.collider,
    asIs: !!o['as-is'], ktx2: !!o.ktx2, maxTexture: o['max-texture'] ? Number(o['max-texture']) : undefined,
    licence: o.licence ? Object.fromEntries(Object.entries({ spdx: o.licence, author: o.author, url: o.url, credit: o.credit }).filter(([, v]) => v)) : null,
    licenceFile: o['licence-file'], licenceText: o['licence-text'],
    newPack: { title: o.title, describe: o['pack-describe'], owner: o.owner, visibility: o.private ? 'private' : 'public', source: sourceKind ? Object.fromEntries(Object.entries({ kind: sourceKind, page: o.page, download: o.download, sha256: o['zip-sha256'], repo: o.repo, commit: o.commit, maker: o.maker, store: o.store, retrieved: new Date().toISOString().slice(0, 10) }).filter(([, v]) => v)) : undefined },
  };
}

const out = (o, data, text) => console.log(o.json ? JSON.stringify(data, null, 1) : text());

async function cmdIngest(pos, o, config) {
  if (!pos[0] || !o.pack) throw new Error('usage: art ingest <path|url> --pack <id> [options]');
  const renderer = o['no-render'] ? null : lazyRenderer();
  try {
    const { ingest } = await import('./ingest.mjs');     // sharp and gltf-transform load only for ingest
    const r = await ingest(pos[0], { config, renderer, ...ingestOptions(o) });
    out(o, r, () => [`art ingest → ${r.pack}: ${r.added.length} added, ${r.duplicates.length} already in the library, ${r.skipped.length} skipped, ${r.quarantined.length} quarantined, ${r.failed.length} failed their validator`,
      ...r.quarantined.slice(0, 5).map(q => `  quarantined ${q.file}: ${q.why}`), ...r.failed.slice(0, 10).map(f => `  failed ${f.ref}: ${f.problems.slice(0, 2).join('; ')}`), ...r.schemaProblems.slice(0, 10).map(p => `  schema: ${p}`)].join('\n'));
    if (r.quarantined.length && !r.added.length) process.exitCode = 2;
  } finally { await renderer?.close(); }
}

function kindOf(o, config) { return o.kind ? loadKind(o.kind, config.kindsDir) : null; }

async function cmdFind(pos, o, config) {
  const query = pos.join(' ');
  const lib = loadLibrary(config);
  const kindPreset = kindOf(o, config);
  const r = find(lib, query, { kindPreset, policy: loadPolicy(config.policyFile), devices: o.devices?.split(',') ?? ['desktop'], dimension: o['3d'] ? '3d' : o['2d'] ? '2d' : o.audio ? 'audio' : undefined, category: o.category, limit: o.all ? 50 : Number(o.limit ?? 10) });
  if (kindPreset?.missing) r.findings.unshift(`no kind preset "${o.kind}" in ${config.kindsDir}`);
  out(o, r, () => [`art find "${query}"${o.kind ? ` --kind ${o.kind}` : ''}: ${r.results.length} shown`,
    ...r.results.map((x, i) => `${String(i + 1).padStart(2)}. ${x.ref}  ${x.describe}\n    ${x.licence.spdx}${x.credit ? ` (credit: ${x.credit})` : ''}; ${x.why.join('; ')}`),
    ...r.findings.map(f => `  finding: ${f}`)].join('\n'));
}

async function cmdFill(pos, o, config) {
  if (!pos[0]) throw new Error('usage: art fill <game folder | assets.json> [--kind <k>] [--write]');
  const file = existsSync(path.join(pos[0], 'assets.json')) ? path.join(pos[0], 'assets.json') : pos[0];
  const assets = JSON.parse(readFileSync(file, 'utf8'));
  const game = path.dirname(path.resolve(file));
  const r = await fillGame({ config, game, slots: assets.slots ?? assets, kind: o.kind ?? null, runtime: o.runtime ?? 'three', devices: o.devices?.split(',') ?? ['phone', 'desktop'], provided: o.provided?.split(',') ?? [], write: !!o.write });
  out(o, r, () => [`art fill ${pos[0]}${o.kind ? ` --kind ${o.kind}` : ''}: ${r.written.length} slots filled${o.write ? ' and written' : ' (plan; --write copies the files)'}, ${r.next.length} left for the next step`,
    ...(r.kindMissing ? [`  no kind preset "${o.kind}" in ${config.kindsDir}: ranked without a kind`] : []),
    ...r.written.map(w => `  ${w.slot.padEnd(34)} ${w.ref}`),
    ...r.next.map(n => `  ${n.slot.padEnd(34)} — ${n.findings.join('; ')} → next: ${n.next}`),
    ...r.findings.slice(0, 20).map(f => `  finding: ${f}`)].join('\n'));
  if (r.next.some(n => !n.optional)) process.exitCode = 1;
}

async function cmdObjectives(pos, o, config) {
  if (!pos[0]) throw new Error('usage: art objectives <game folder> [--yes] [--maker meshy] [--json]');
  const { objectiveArt } = await import('./objectives.mjs');
  const r = await objectiveArt(pos[0], { yes: !!o.yes, maker: o.maker ?? 'meshy', config, log: o.json ? () => {} : m => console.log(`  ${m}`) });
  out(o, r, () => [`art objectives ${pos[0]}: ${r.items.length} objective prop${r.items.length === 1 ? '' : 's'}${r.credits ? `, ${r.credits} credits` : ''}`,
    ...r.items.map(i => `  ${i.slot.padEnd(24)} ${i.now.padEnd(9)} ${i.ref ?? i.was ?? ''}${i.why ? `  — ${i.why}` : ''}`), ...r.notes.map(n => `  note: ${n}`)].join('\n'));
  if (r.items.some(i => i.now === 'standin')) process.exitCode = 1;
}

async function cmdFetch(pos, o, config) {
  const [packId, id] = String(pos[0] ?? '').split('/');
  const lib = loadLibrary(config);
  const p = lib.find(x => x.pack.id === packId), a = p?.assets.find(x => x.id === id);
  if (!a) throw new Error(`no asset ${pos[0]}`);
  const r = await fetchAsset(config, a, p.pack);
  if (o.to) { await mkdir(path.dirname(path.resolve(o.to)), { recursive: true }); await copyFileWritable(r.path, o.to); }
  out(o, { ...r, to: o.to ?? null }, () => `${pos[0]}: ${o.to ?? r.path} (from ${r.from})`);
}

async function cmdCheck(pos, o, config) {
  const lib = loadLibrary(config);
  const S = schemas();
  const problems = [], missing = [];
  for (const p of lib) {
    if (S) for (const x of S.validatePack(p.pack)) problems.push(`${p.pack.id}: ${x}`);
    for (const a of p.assets) {
      if (S) for (const x of S.validateAsset(a)) problems.push(`${p.pack.id}/${a.id}: ${x}`);
      if (!localPath(config, a.sha256)) missing.push(`${p.pack.id}/${a.id}`);
      if (a.preview && !existsSync(path.join(p.dir, a.preview))) problems.push(`${p.pack.id}/${a.id}: no preview file ${a.preview}`);
    }
  }
  const n = allAssets(lib).length;
  out(o, { packs: lib.length, assets: n, schemas: !!S, problems, notInStore: missing }, () => [`art check: ${lib.length} packs, ${n} assets${S ? '' : ' (schemas not found: XGAMES_SCHEMAS)'}; ${problems.length} problems; ${missing.length} binaries not on this machine (art fetch brings them)`, ...problems.slice(0, 20).map(x => `  ${x}`), ...missing.slice(0, 10).map(x => `  not here: ${x}`)].join('\n'));
  if (problems.length) process.exitCode = 1;
}

async function cmdCoverage(pos, o, config) {
  const { coverageReport } = await import('./coverage.mjs');
  const r = coverageReport({ config, kind: o.kind ?? null, casePath: o.case ?? null });
  out(o, r, () => [`art coverage: ${r.inventory.totals.packs} packs, ${r.inventory.totals.assets} assets (${Object.entries(r.inventory.totals.byVisibility).map(([k, n]) => `${n} ${k}`).join(', ')})`,
    ...r.views.flatMap(v => [`\n${v.title}: ${Object.entries(v.totals).map(([k, n]) => `${n} ${k}`).join(', ')}`,
      ...v.needs.map(n => `  ${n.status.padEnd(9)} ${n.id.padEnd(20)} ${n.have}/${n.count}${n.best[0] ? `  ${n.best[0].ref}` : ''}${n.gap ? `  — ${n.gap}` : ''}`)])].join('\n'));
}

async function cmdAutorig(pos, o) {
  if (!pos[0] || !o.archetype || !o.out) throw new Error('usage: art autorig <mesh.glb> --archetype worm|blob|quadruped|flyer --out <body.glb> [--height m] [--turn deg] [--id id]');
  const { autorig } = await import('./rig/autorig.mjs');
  const r = await autorig(readFileSync(pos[0]), { archetype: o.archetype, id: o.id ?? path.basename(o.out).replace(/\.glb$/i, ''), height: o.height ? Number(o.height) : null, turn: o.turn ? Number(o.turn) : 0 });
  await mkdir(path.dirname(path.resolve(o.out)), { recursive: true });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(o.out, r.bytes);
  const { rigCheck } = await import('../tools/rig-check.mjs');
  const j = await rigCheck(path.resolve(o.out), { archetype: o.archetype });
  out(o, { file: o.out, ...r, bytes: r.bytes.length, check: { ok: j.ok, errors: j.errors, warnings: j.warnings } }, () => [`art autorig → ${o.out}: ${r.report.rig}, ${r.report.bones.length} bones (${r.report.bones.join(', ')}), ${(r.bytes.length / 1024).toFixed(0)} KB`,
    `  ${j.ok ? 'PASS' : 'FAIL'} rig-check${j.errors.length ? `: ${j.errors.slice(0, 4).join('; ')}` : ''}`, ...j.warnings.slice(0, 4).map(w => `  warn: ${w}`)].join('\n'));
  if (!j.ok) process.exitCode = 1;
}

async function cmdHarmonize(pos, o, config) {
  if (!o.pack || !o.look) throw new Error('usage: art harmonize --pack <id> --look <target.json | config/look.json | game folder | kind> [--level <id>] [--style pixel|drawn] [--into <pack>] [--only a,b] [--public] [--dry] [--json]');
  const { harmonizePack } = await import('./harmonize.mjs');
  const renderer = o['no-render'] ? null : lazyRenderer();
  try {
    const r = await harmonizePack(config, o.pack, o.look, { level: o.level, style: o.style, into: o.into, only: o.only?.split(','), visibility: o.public ? 'public' : 'private', renderer, dry: !!o.dry, log: o.json ? null : console.log });
    const n = x => (x == null ? '—' : x);
    out(o, { ...r, added: r.added.map(({ files, ...a }) => ({ ...a, before: a.before && { distance: a.before.distance, fit: a.before.fit }, after: a.after && { distance: a.after.distance, fit: a.after.fit } })) }, () => [
      `art harmonize ${o.pack} → ${r.pack} (look ${r.look})${r.dry ? ' (dry: nothing written)' : ''}: ${r.added.length} harmonised, ${r.skipped.length} skipped`,
      ...r.added.map(a => `  ${a.from.padEnd(40)} ${a.did.join(', ')}; distance to the look ${n(a.before?.distance?.palette)} → ${n(a.after?.distance?.palette)}; style fit ${n(a.before?.fit?.fit)} → ${n(a.after?.fit?.fit)}`),
      ...r.skipped.slice(0, 12).map(x => `  skipped ${x.ref}: ${x.why}`),
      ...[...new Set(r.findings)].slice(0, 12).map(f => `  finding: ${f}`)].join('\n'));
  } finally { await renderer?.close(); }
}

const COMMANDS = { harmonize: cmdHarmonize, ingest: cmdIngest, find: cmdFind, fill: cmdFill, objectives: cmdObjectives, fetch: cmdFetch, check: cmdCheck, coverage: cmdCoverage, autorig: cmdAutorig };

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!COMMANDS[cmd]) { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 29).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exitCode = cmd ? 1 : 0; return; }
  const { pos, o } = parse(rest);
  await COMMANDS[cmd](pos, o, loadConfig());
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(`art: ${e.message}`); process.exit(1); });
