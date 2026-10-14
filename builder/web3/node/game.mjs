// A game folder as the web3 layer sees it: its gamesfun.json (read, cleaned, written atomically), its pictures (read
// only from inside the folder, by real path, and only PNG, JPEG, WebP or GIF by their bytes), its title, and the
// player looks an item can change (gf-three CONTRACT §6e). Node only; paths are built with node:path.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_FILE, emptyConfig, parseConfig, serializeConfig } from '../gf-web3/config.js';
import { RuleError } from '../gf-web3/rules.js';
import { addKitIgnores } from '../../lib/manifest-ignores.mjs';

/** The biggest picture uploaded for a token, a collection or an item. */
export const MAX_PICTURE_BYTES = 5 * 1024 * 1024;
const MAX_LISTED = 300;
const LIST_DEPTH = 5;
const PICTURE_NAME = /\.(png|jpe?g|webp|gif)$/i;
/** Folders that hold nothing a creator would sell. */
const SKIPPED = new Set(['node_modules', 'gf', 'vendor', 'dist', 'build', 'export', 'evidence', 'docs', 'qa', 'tests', '.git', '.gamesfun']);

/** Is `target` inside `root` (both absolute)? */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The bytes decide the type: PNG, JPEG, GIF or WebP, never SVG or anything a browser would run. */
export function sniffPicture(bytes) {
  const b = bytes;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && String.fromCharCode(...b.subarray(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif';
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** One picture from the game, by its game-relative path. Refuses anything outside the folder or not a picture. */
export async function readPicture(gameDir, rel) {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-z]:/i.test(rel))
    throw new RuleError('Pick a picture inside the game folder.');
  const root = await realpath(gameDir);
  const lexical = path.resolve(root, rel);
  if (!isInside(root, lexical)) throw new RuleError(`${rel} is outside the game folder.`);
  let real;
  try {
    real = await realpath(lexical);
  } catch {
    throw new RuleError(`${rel} is not a file in this game.`);
  }
  if (!isInside(root, real)) throw new RuleError(`${rel} points outside the game folder.`);
  const info = await lstat(real);
  if (!info.isFile()) throw new RuleError(`${rel} is not a file in this game.`);
  if (info.size > MAX_PICTURE_BYTES) throw new RuleError(`${rel} is larger than ${MAX_PICTURE_BYTES / 1024 / 1024} MB.`);
  const bytes = new Uint8Array(await readFile(real));
  const contentType = sniffPicture(bytes);
  if (!contentType) throw new RuleError(`${rel} is not a PNG, JPEG, WebP or GIF picture.`);
  return { path: rel.replaceAll('\\', '/'), bytes, contentType, sha256: sha256Hex(bytes) };
}

/** Pictures a creator can pick, as game-relative paths with forward slashes, shallowest first. */
export async function listPictures(gameDir) {
  const found = [];
  const queue = [{ rel: '', depth: 0 }];
  while (queue.length && found.length < MAX_LISTED) {
    const { rel, depth } = queue.shift();
    const entries = await readdir(path.join(gameDir, ...rel.split('/').filter(Boolean)), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !SKIPPED.has(entry.name) && depth < LIST_DEPTH) queue.push({ rel: child, depth: depth + 1 });
      else if (entry.isFile() && PICTURE_NAME.test(entry.name)) found.push(child);
    }
  }
  return found.slice(0, MAX_LISTED);
}

// ---------------------------------------------------------------- gamesfun.json

export const configPath = (gameDir) => path.join(gameDir, CONFIG_FILE);

/** The game's gamesfun.json, cleaned (an empty setup when the file does not exist). */
export async function readConfig(gameDir) {
  let text;
  try {
    text = await readFile(configPath(gameDir), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return emptyConfig();
    throw error;
  }
  return parseConfig(text);
}

/** Write gamesfun.json atomically (a temp file renamed over it). Refuses anything that looks like a secret. */
export async function writeConfig(gameDir, config) {
  const text = serializeConfig(config);
  const file = configPath(gameDir);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, 'utf8');
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  // gamesfun.json is not a game asset: a gf-three game's manifest must say so, or verify check 1 fails.
  await addKitIgnores(gameDir).catch(() => {});
  return parseConfig(text);
}

const locks = new Map();
/** Read, change and write gamesfun.json, one change at a time per game (in this process). */
export async function updateConfig(gameDir, change) {
  const key = path.resolve(gameDir);
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const mine = new Promise((resolve) => (release = resolve));
  locks.set(key, previous.then(() => mine));
  await previous;
  try {
    const config = await readConfig(gameDir);
    const next = (await change(structuredClone(config))) ?? config;
    return await writeConfig(gameDir, next);
  } finally {
    release();
    if (locks.get(key) === mine) locks.delete(key);
  }
}

// ---------------------------------------------------------------- what the game is

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The game's title: assets.json's, else index.html's <title>, else the folder name. */
export async function gameTitle(gameDir) {
  const assets = (await readJson(path.join(gameDir, 'assets.json'))) ?? (await readJson(path.join(gameDir, 'source', 'assets.json')));
  if (typeof assets?.title === 'string' && assets.title.trim()) return assets.title.trim().slice(0, 80);
  const html = await readFile(path.join(gameDir, 'index.html'), 'utf8').catch(() => '');
  const title = /<title>([^<]{1,80})<\/title>/i.exec(html)?.[1]?.trim();
  return title || path.basename(path.resolve(gameDir));
}

const KIT_LOOKS = {
  'character.tint.player': { label: 'Body colour', type: 'color' },
  'mechanic.projectile.color': { label: 'Shot or stream colour', type: 'color' },
  'character.hat.player': { label: 'Hat', type: 'model' },
  'character.body.player': { label: 'Character', type: 'model' },
};
const LOOK_TYPES = new Set(['color', 'colors', 'enum', 'boolean', 'number', 'integer', 'model', 'texture', 'image']);

/**
 * What an item can change for its owner: the game's player-look slots (`scope: "player"` in assets.json, gf-three
 * CONTRACT §6e), or the kit's default player looks it declares by id. → [{ id, label, type, options?, min?, max? }]
 */
export async function playerLooks(gameDir) {
  const assets = (await readJson(path.join(gameDir, 'assets.json'))) ?? (await readJson(path.join(gameDir, 'source', 'assets.json')));
  const slots = Array.isArray(assets?.slots) ? assets.slots : [];
  const scoped = slots.filter((s) => s?.scope === 'player' && LOOK_TYPES.has(s.type));
  const chosen = scoped.length ? scoped : slots.filter((s) => s && KIT_LOOKS[s.id]);
  return chosen.map((s) => {
    const kit = KIT_LOOKS[s.id];
    const type = s.type === 'colors' ? 'color' : (s.type ?? kit?.type);
    return {
      id: s.id,
      label: kit?.label ?? String(s.label ?? s.id).replace(/\s*\([^)]*\)\s*$/, ''),
      type,
      ...(type === 'enum' ? { options: (s.constraints?.options ?? s.options ?? []).map((o) => ({ value: o?.value ?? o, label: String(o?.label ?? o?.value ?? o) })) } : {}),
      ...(typeof s.constraints?.min === 'number' && type !== 'color' ? { min: s.constraints.min } : {}),
      ...(typeof s.constraints?.max === 'number' && type !== 'color' ? { max: s.constraints.max } : {}),
    };
  });
}

/** Make sure a folder exists (for the kit's local state). */
export const ensureDir = (dir) => mkdir(dir, { recursive: true });
