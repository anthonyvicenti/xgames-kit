// The files this kit adds to a game that are not game assets (the agent's guide files, scratch folders, the web3
// settings) are listed in builder/lib/manifest-ignore.json. gf-three reads that list itself: builder/lib/run-tool.mjs names the file in
// GF_MANIFEST_IGNORE, so create, `slots --write` and upgrade write the entries into assets.json and keep them.
//
// What is left here is for a game that already has an assets.json when a new file arrives: builder/web3/node/game.mjs adds
// gamesfun.json to an existing game and calls addKitIgnores, so check 1 passes before the next `slots write`.
import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MANIFEST_IGNORE_FILE = fileURLToPath(new URL('./manifest-ignore.json', import.meta.url));
export const KIT_IGNORES = JSON.parse(readFileSync(MANIFEST_IGNORE_FILE, 'utf8'));

/** The manifest with the kit's ignore entries present (in order, once each). Pure. */
export function withKitIgnores(manifest) {
  const ignore = Array.isArray(manifest.ignore) ? [...manifest.ignore] : [];
  for (const e of KIT_IGNORES) if (!ignore.some(x => x?.path === e.path)) ignore.push({ ...e });
  return { ...manifest, ignore };
}

/** Add the entries to <game>/assets.json in place (gf-three's formatting: two spaces, trailing newline). → changed */
export async function addKitIgnores(gameDir) {
  const file = path.join(gameDir, 'assets.json');
  const text = await readFile(file, 'utf8');
  const next = JSON.stringify(withKitIgnores(JSON.parse(text)), null, 2) + '\n';
  if (next === text) return false;
  await writeFile(file, next);
  return true;
}
