// Manifests are checked against the contract's schemas (library/schema/pack.schema.json and asset.schema.json, with
// registry/schema/common.schema.json for the shared definitions). XGAMES_SCHEMAS points at another root that has those
// folders (the contracts stream's staging copy until the layout lands).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from './config.mjs';

const require = createRequire(import.meta.url);
export const PACK_SCHEMA = 'https://xgames.fun/schemas/pack/1.json';
export const ASSET_SCHEMA = 'https://xgames.fun/schemas/asset/1.json';

let cached = null;
/** The schema validator: → { validatePack(p), validateAsset(a) } each returning [] or problem lines. null when the schemas are not here. */
export function schemas({ root = process.env.XGAMES_SCHEMAS ?? REPO_ROOT } = {}) {
  if (cached?.root === root) return cached.api;
  const dirs = ['registry/schema', 'library/schema'].map(d => path.join(root, d));
  const files = dirs.filter(d => existsSync(d)).flatMap(d => readdirSync(d).filter(f => f.endsWith('.schema.json')).map(f => path.join(d, f)));
  const need = ['common.schema.json', 'pack.schema.json', 'asset.schema.json'];
  if (!need.every(n => files.some(f => path.basename(f) === n))) { cached = { root, api: null }; return null; }
  const Ajv2020 = require('ajv/dist/2020.js').default ?? require('ajv/dist/2020.js');
  const ajv = new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true });
  for (const f of files) {
    const s = JSON.parse(readFileSync(f, 'utf8'));
    if (s.$id && !ajv.getSchema(s.$id)) ajv.addSchema(s);
  }
  const run = id => data => {
    const v = ajv.getSchema(id);
    return v(data) ? [] : v.errors.map(e => `${e.instancePath || '/'}: ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  };
  const api = { validatePack: run(PACK_SCHEMA), validateAsset: run(ASSET_SCHEMA) };
  cached = { root, api };
  return api;
}

/** Cut a description at a word under the schema's 200 characters. */
export function clip(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[,;:\s]+$/, '')}…`;
}

const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Tags as the schema takes them: lower case words with dashes, unique, at most 24. */
export function cleanTags(tags) {
  const out = [];
  for (const t of tags ?? []) {
    const k = String(t).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
    if (TAG.test(k) && !out.includes(k)) out.push(k);
  }
  return out.slice(0, 24);
}
