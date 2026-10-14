#!/usr/bin/env node
// The Godot toolchain of runtime godot: the pinned editor (run headless to import and export a game's project) and the
// one web template a game is exported with (toolchain/toolchain.json). Installed only when a game picks runtime godot:
// create, export and dev call ensureToolchain(); nothing else in the kit ever does.
//
//   node runtimes/godot/tools/install.mjs [--from <dir>] [--json]
//     --from <dir>   take the files from a folder that already has them (another checkout's cache, an offline copy);
//                    each is used only when its sha256 is the pinned one
//
// Where: $XGAMES_GODOT_HOME, else ~/.cache/xgames-kit/godot/<version>/. A file already there with the pinned hash is
// kept; anything else is fetched again and checked. The template comes out of Godot's 1.25 GB template archive by
// HTTP range requests (only its central directory and the one entry are read, about 9 MB).
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { isMain, TOOLCHAIN } from './lib.mjs';

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');
const fileSha = async p => (existsSync(p) ? sha256(await readFile(p)) : null);

export function platformKey(platform = process.platform, arch = process.arch) {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : platform;
  return `${os}-${arch === 'x64' ? 'x64' : arch}`;
}

export function toolchainDir(tc = TOOLCHAIN) {
  return process.env.XGAMES_GODOT_HOME || join(homedir(), '.cache', 'xgames-kit', 'godot', tc.version);
}

/** What is installed and what is missing, without fetching anything. */
export async function status(tc = TOOLCHAIN) {
  const dir = toolchainDir(tc), key = platformKey(), ed = tc.platforms[key]?.editor ?? null;
  const editor = ed ? join(dir, ed.file) : null, template = join(dir, tc.template.file);
  return {
    dir, platform: key, supported: !!ed,
    editor: editor && (await fileSha(editor)) === ed.fileSha256 ? editor : null,
    template: (await fileSha(template)) === tc.template.fileSha256 ? template : null,
  };
}

async function fetchBytes(url, headers = {}) {
  const r = await fetch(url, { headers, redirect: 'follow' });
  if (!r.ok && r.status !== 206) throw new Error(`${url}: HTTP ${r.status}`);
  if (headers.Range && r.status !== 206) throw new Error(`${url}: the server did not answer the range request (HTTP ${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

function findIn(cd, count, wanted) {
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory');
    const method = cd.readUInt16LE(p + 10), csize = cd.readUInt32LE(p + 20), size = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32), local = cd.readUInt32LE(p + 42);
    const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
    if (name === wanted || name.endsWith('/' + wanted.split('/').pop())) return { name, method, csize, size, local };
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${wanted} is not in the archive`);
}

const unpack = (e, data) => (e.method === 0 ? data : e.method === 8 ? inflateRawSync(data) : (() => { throw new Error(`zip method ${e.method} is not read here`); })());

/** An entry of a zip in memory (the editor archive). */
export function extract(buf, wanted) {
  const at = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error('not a zip (no end of central directory)');
  const count = buf.readUInt16LE(at + 10), cdSize = buf.readUInt32LE(at + 12), cdOff = buf.readUInt32LE(at + 16);
  const e = findIn(buf.subarray(cdOff, cdOff + cdSize), count, wanted);
  const nlen = buf.readUInt16LE(e.local + 26), xlen = buf.readUInt16LE(e.local + 28), start = e.local + 30 + nlen + xlen;
  return unpack(e, buf.subarray(start, start + e.csize));
}

/** An entry of a large remote zip, by range requests: its tail, its central directory, then the entry alone. */
export async function extractRemote(url, total, wanted) {
  const tailLen = Math.min(total, 65536 + 22);
  const tail = await fetchBytes(url, { Range: `bytes=${total - tailLen}-${total - 1}` });
  const at = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (at < 0) throw new Error('the template archive has no end of central directory in its last 64 KB');
  const cdSize = tail.readUInt32LE(at + 12), cdOff = tail.readUInt32LE(at + 16), count = tail.readUInt16LE(at + 10);
  const cd = await fetchBytes(url, { Range: `bytes=${cdOff}-${cdOff + cdSize - 1}` });
  const e = findIn(cd, count, wanted);
  const head = await fetchBytes(url, { Range: `bytes=${e.local}-${e.local + 29}` });
  const nlen = head.readUInt16LE(26), xlen = head.readUInt16LE(28), start = e.local + 30 + nlen + xlen;
  return unpack(e, await fetchBytes(url, { Range: `bytes=${start}-${start + e.csize - 1}` }));
}

async function put(path, buf, want, what) {
  const got = sha256(buf);
  if (got !== want) throw new Error(`${what}: sha256 ${got}, the pinned one is ${want} (nothing was installed)`);
  await writeFile(path + '.part', buf);
  await rename(path + '.part', path);
}

/** Make sure the editor and the template are in place, fetching what is missing. → status() */
export async function ensureToolchain({ from = null, log = () => {}, tc = TOOLCHAIN } = {}) {
  const st = await status(tc);
  if (!st.supported) throw new Error(`runtime godot: no pinned Godot editor for ${st.platform} yet (pinned: ${Object.keys(tc.platforms).join(', ')}); the web template is the same everywhere, but exporting needs the editor`);
  if (st.editor && st.template) return st;
  await mkdir(st.dir, { recursive: true });
  const ed = tc.platforms[st.platform].editor, T = tc.template;
  const editorPath = join(st.dir, ed.file), templatePath = join(st.dir, T.file);
  const seed = async (name, want) => {
    if (!from) return false;
    const p = join(from, name);
    if ((await fileSha(p)) !== want) return false;
    await copyFile(p, join(st.dir, name) + '.part'); await rename(join(st.dir, name) + '.part', join(st.dir, name));
    log(`took ${name} from ${from} (sha256 matches)`);
    return true;
  };
  if (!st.editor && !(await seed(ed.file, ed.fileSha256))) {
    log(`fetching the Godot ${tc.version} editor (${ed.url})`);
    const zip = await fetchBytes(ed.url);
    if (sha256(zip) !== ed.sha256) throw new Error(`the editor archive's sha256 is ${sha256(zip)}, the pinned one is ${ed.sha256}`);
    await put(editorPath, extract(zip, ed.entry), ed.fileSha256, 'the Godot editor');
  }
  await chmod(editorPath, 0o755);
  if (!st.template && !(await seed(T.file, T.fileSha256))) {
    log(`fetching the web template from ${T.url} (range requests: about 9 MB of ${(T.bytes / 1e9).toFixed(2)} GB)`);
    await put(templatePath, await extractRemote(T.url, T.bytes, T.entry), T.fileSha256, 'the web template');
  }
  await rm(join(st.dir, 'install.json'), { force: true });
  await writeFile(join(st.dir, 'install.json'), JSON.stringify({ version: tc.version, platform: st.platform, installed: new Date().toISOString(), editor: ed.fileSha256, template: T.fileSha256 }, null, 2) + '\n');
  return status(tc);
}

if (isMain(import.meta)) {
  const a = process.argv.slice(2), i = a.indexOf('--from');
  try {
    const st = await ensureToolchain({ from: i >= 0 ? a[i + 1] : null, log: m => { if (!a.includes('--json')) console.log(m); } });
    console.log(a.includes('--json') ? JSON.stringify(st, null, 2) : `Godot ${TOOLCHAIN.version} ready in ${st.dir}\n  editor   ${st.editor}\n  template ${st.template}`);
  } catch (e) { console.error(`install: ${e.message}`); process.exit(1); }
}
