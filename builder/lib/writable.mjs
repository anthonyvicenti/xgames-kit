// A game's files are its owner's, whatever mode the kit's own copy has. Studio's worker runs the kit from a read-only
// release snapshot (files 0444), and a plain copy keeps the source's mode: a game made from it could not be edited,
// refreshed by a later `create` or deleted. Every step that copies kit files into a game copies through here, so what
// lands in the game is user-writable (a file gains u+w, 0444 → 0644; a folder u+rwx, 0555 → 0755).
import { chmodSync, copyFileSync, lstatSync, readdirSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

const fileMode = m => (m & 0o7777) | 0o200;
const dirMode = m => (m & 0o7777) | 0o700;

/** Make a file, or a folder and everything under it, writable by its owner (a symbolic link is left as it is). */
export async function makeWritable(p) {
  const s = await lstat(p);
  if (s.isDirectory()) {
    if ((s.mode & 0o700) !== 0o700) await chmod(p, dirMode(s.mode));
    for (const e of await readdir(p)) await makeWritable(path.join(p, e));
  } else if (s.isFile() && !(s.mode & 0o200)) await chmod(p, fileMode(s.mode));
}

export function makeWritableSync(p) {
  const s = lstatSync(p);
  if (s.isDirectory()) {
    if ((s.mode & 0o700) !== 0o700) chmodSync(p, dirMode(s.mode));
    for (const e of readdirSync(p)) makeWritableSync(path.join(p, e));
  } else if (s.isFile() && !(s.mode & 0o200)) chmodSync(p, fileMode(s.mode));
}

/** copyFile, and the copy is writable. */
export async function copyFileWritable(from, to) { await copyFile(from, to); await makeWritable(to); }
export function copyFileWritableSync(from, to) { copyFileSync(from, to); makeWritableSync(to); }

/** fs.cp (a file or a folder, recursive), and everything copied is writable. */
export async function cpWritable(from, to, opts = {}) { await cp(from, to, opts); await makeWritable(to); }
