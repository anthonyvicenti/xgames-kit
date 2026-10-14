// runtime godot's create adapter (runtimes/CONTRACT.md §2): create({spec, out, catalog, kit}) → {files, slots, record}.
// Until builder's shared create lands this writes the whole game (tools/create.mjs); INTEGRATION.md §2 says which
// part moves to the shared create and which stays here.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { create as createGame } from './tools/create.mjs';

export default async function create({ spec, out, exportNow = true }) {
  const r = await createGame(spec, out, { exportNow });
  if (!r.ok) throw new Error(`runtime godot refused the spec: ${r.problems.join('; ')}`);
  return { files: r.kitFiles, slots: r.slotList, record: JSON.parse(await readFile(join(r.dir, 'xgames.json'), 'utf8')), notes: r.notes };
}
