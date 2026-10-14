// A pack's own files, kept in step with its assets: pack.json (counts, dimension, validators, the pack signature),
// sources.json (what each manifest leaves out: the old location, full descriptions, the measured signature in full and
// each validator's whole report) and LICENSE.txt (the licence, its text and every credit line).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { contractPackSignature } from './analyze.mjs';
import { packDir } from './config.mjs';
import { packSignature } from './signature.mjs';

const json = v => JSON.stringify(v, null, 1) + '\n';
const readJson = f => JSON.parse(readFileSync(f, 'utf8'));
export const clean = o => JSON.parse(JSON.stringify(o, (k, v) => (v === null || v === undefined || (Array.isArray(v) && !v.length && k !== 'tags') ? undefined : v)));

/** The pack's sources.json (or an empty one). */
export function readSources(dir) {
  const f = path.join(dir, 'sources.json');
  return existsSync(f) ? readJson(f) : { about: SOURCES_ABOUT, assets: {} };
}
export const SOURCES_ABOUT = 'Beside the manifests: where each asset was before the library, the full description when the manifest cuts it at 200 characters, roles and labels, fields no manifest field holds, the measured signature in full and each validator\'s whole report.';

export async function writeSources(dir, sources) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'sources.json'), json({ ...sources, about: SOURCES_ABOUT }));
}

/**
 * Rewrite pack.json and LICENSE.txt from the pack's definition and the assets on disk.
 * def: the pack manifest fields (packVersion, id, title, licence, source, owner, visibility, describe, validators, notes)
 * opts: { licenceText, licenceFile (a file whose text is appended), validate (schema check) }
 */
export async function refreshPack(config, def, { licenceText = null, licenceFile = null, validate = null } = {}) {
  const dir = packDir(config, def);
  const adir = path.join(dir, 'assets');
  const manifests = existsSync(adir) ? readdirSync(adir).filter(f => f.endsWith('.json')).sort().map(f => readJson(path.join(adir, f))) : [];
  const sources = readSources(dir);
  const assets = manifests.map(m => ({ ...m, signature: sources.assets?.[m.id]?.signature ?? null }));
  const dims = [...new Set(manifests.map(m => m.dimension))];
  const sig = packSignature(assets);
  const pack = clean({
    packVersion: 1, ...def,
    licence: { ...def.licence, file: def.visibility === 'private' ? undefined : `library/packs/${def.id}/LICENSE.txt` },
    dimension: dims.length === 1 ? dims[0] : dims.length ? 'mixed' : def.dimension ?? '3d',
    signature: contractPackSignature(sig, assets),
    assets: manifests.length,
    validators: def.validators ?? [...new Set(manifests.flatMap(m => (m.validated ?? []).map(v => v.by)))].slice(0, 6),
    notes: def.notes ?? (def.visibility === 'private' ? 'Private: kept in the private packs folder, never pushed.' : undefined),
  });
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'pack.json'), json(pack));
  // the licence text and any licence files given now or on an earlier run (each kept once)
  const before = sources.pack ?? {};
  const appendices = [...(before.licenceFiles ?? [])];
  if (licenceFile && existsSync(licenceFile)) { const t = readFileSync(licenceFile, 'utf8').trim(); if (!appendices.includes(t)) appendices.push(t); }
  sources.pack = clean({ signature: sig, licenceText: licenceText ?? before.licenceText, licenceFiles: appendices });
  await writeSources(dir, sources);
  await writeLicence(dir, pack, manifests, sources.pack.licenceText, appendices);
  return { pack, problems: validate ? validate(pack) : [] };
}

async function writeLicence(dir, p, assets, text, appendices = []) {
  const lines = [p.title, '', `Licence: ${p.licence.spdx}${p.licence.author ? `, ${p.licence.author}` : ''}${p.licence.url ? ` (${p.licence.url})` : ''}`];
  if (p.source.repo) lines.push(`Source: ${p.source.repo} at ${p.source.commit}`);
  else if (p.source.download) lines.push(`Source: ${p.source.download} (sha256 ${p.source.sha256})`);
  else if (p.source.page) lines.push(`Source: ${p.source.page}${p.source.kind === 'collection' ? ' (each asset pins its own page and file)' : ''}`);
  if (text) lines.push('', text);
  const credits = assets.filter(a => a.licence?.credit).map(a => `- ${a.id}: ${a.licence.credit}`);
  if (credits.length) lines.push('', 'Credit lines (a game that uses one writes it into its credits):', ...credits);
  const other = assets.filter(a => a.licence && !a.licence.credit && a.licence.spdx !== p.licence.spdx).map(a => `- ${a.id}: ${a.licence.spdx}${a.licence.author ? `, ${a.licence.author}` : ''}`);
  if (other.length) lines.push('', 'Assets under another licence than the pack\'s:', ...other);
  const authors = [...new Map(assets.filter(a => a.source?.author && a.source.author !== p.licence.author).map(a => [a.source.author, a.source.page])).entries()];
  if (authors.length) lines.push('', 'Authors (each asset\'s manifest names its own):', ...authors.map(([a, u]) => `- ${a}${u ? ` (${u})` : ''}`));
  for (const t of appendices) lines.push('', '---', '', t);
  await writeFile(path.join(dir, 'LICENSE.txt'), lines.join('\n') + '\n');
}
