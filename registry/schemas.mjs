// Every schema of the contracts, loaded into one validator. The schemas refer to each other by $id
// (https://xgames.fun/schemas/<name>/<version>.json: names, not URLs that resolve), so load them through here.
//
//   import { loadSchemas, SCHEMA } from './registry/schemas.mjs';
//   const { ajv, validate } = await loadSchemas();
//   const problems = validate(SCHEMA.spec, spec);   // [] or ['/players/max: must be <= 16', …]
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Each schema's $id by its short name. */
export const SCHEMA = {
  common: 'https://xgames.fun/schemas/common/1.json',
  spec: 'https://xgames.fun/schemas/game-spec/2.json',
  pitch: 'https://xgames.fun/schemas/pitch/2.json',
  ledger: 'https://xgames.fun/schemas/ledger/1.json',
  promises: 'https://xgames.fun/schemas/promises/1.json',
  ladder: 'https://xgames.fun/schemas/ladder/1.json',
  runtime: 'https://xgames.fun/schemas/runtime/1.json',
  loop: 'https://xgames.fun/schemas/loop/1.json',
  mechanic: 'https://xgames.fun/schemas/mechanic/1.json',
  kind: 'https://xgames.fun/schemas/kind/1.json',
  pack: 'https://xgames.fun/schemas/pack/1.json',
  asset: 'https://xgames.fun/schemas/asset/1.json',
  catalog: 'https://xgames.fun/schemas/catalog/1.json',
  verdict: 'https://xgames.fun/schemas/verdict/1.json',
};

/** The folders that hold *.schema.json files. */
export const SCHEMA_DIRS = ['builder/spec', 'builder/loop', 'builder/gates', 'registry/schema', 'library/schema'];

export async function schemaFiles(root = ROOT) {
  const out = [];
  for (const d of SCHEMA_DIRS) {
    for (const f of (await readdir(join(root, d))).sort()) if (f.endsWith('.schema.json')) out.push(join(d, f));
  }
  return out;
}

export async function loadSchemas(root = ROOT) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false, allowUnionTypes: true });
  const files = await schemaFiles(root);
  for (const f of files) ajv.addSchema(JSON.parse(await readFile(join(root, f), 'utf8')));
  // compile each so a broken $ref fails here, not at first use
  for (const id of Object.values(SCHEMA)) if (ajv.getSchema(id) == null) throw new Error(`schema ${id} is not among ${files.join(', ')}`);
  const validate = (id, data) => {
    const v = ajv.getSchema(id);
    if (!v) throw new Error(`unknown schema ${id}`);
    return v(data) ? [] : v.errors.map(e => `${e.instancePath || '/'}: ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}`);
  };
  return { ajv, validate, files };
}
