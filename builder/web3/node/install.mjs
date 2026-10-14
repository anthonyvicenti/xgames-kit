// Put the in-game kit gf-web3 into a game: a copy of builder/web3/gf-web3/ at <game>/gf/web3/ (next to gf-three's gf/three
// and gf/mp; assets.json already ignores gf/**), refreshed whole on every create and upgrade, and a gamesfun.json stub
// when the game has none (so the kit's fetch never 404s and the dev server knows the network). The game imports it
// only when it uses web3:  import gfWeb3 from './gf/web3/index.js';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, emptyConfig, serializeConfig } from '../gf-web3/config.js';
import { VERSION } from '../gf-web3/version.js';

export const GF_WEB3_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gf-web3');
export const GF_WEB3_IN_GAME = ['gf', 'web3'];

/** The gf-web3 version a game carries (its gf/web3/version.js), or null when it has none. */
export async function gfWeb3VersionIn(gameDir) {
  const text = await readFile(path.join(gameDir, ...GF_WEB3_IN_GAME, 'version.js'), 'utf8').catch(() => '');
  return /export const VERSION = '([^']+)'/.exec(text)?.[1] ?? null;
}

/** Copy gf-web3 into the game (replacing an older copy) and add a gamesfun.json stub. → { dir, version, previous, stub } */
export async function installGfWeb3(gameDir) {
  const target = path.join(gameDir, ...GF_WEB3_IN_GAME);
  const previous = await gfWeb3VersionIn(gameDir);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(GF_WEB3_SOURCE, target, { recursive: true });
  const config = path.join(gameDir, CONFIG_FILE);
  let stub = false;
  if (!(await stat(config).catch(() => null))) {
    await writeFile(config, serializeConfig(emptyConfig()), 'utf8');
    stub = true;
  }
  return { dir: target, version: VERSION, previous, stub };
}
