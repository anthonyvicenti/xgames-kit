// Shared by the tests: temporary folders and games outside the repository.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../builder/lib/create.mjs';

export async function tempDir(prefix = 'gamesfun-test-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A fresh game made from the example, in a temp folder. → { dir, root, cleanup } */
export async function tempGame(example = 'soak-squad') {
  const t = await tempDir();
  const dir = path.join(t.dir, 'game');
  await createGame(dir, { from: example });
  return { dir, root: t.dir, cleanup: t.cleanup };
}
