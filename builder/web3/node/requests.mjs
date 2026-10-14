// Requests an agent (the CLI or an MCP tool) leaves for the creator: "launch this token", "put the economy live".
// Agents prepare; humans approve. A request is a small file of public inputs in the git-ignored
// `<kit>/.gamesfun/web3/requests/`, which the studio's Economy tab shows with Review and Dismiss. Nothing in a
// request can sign or spend: approving runs the normal flow, where the creator sees every step in their wallet.
import { randomBytes } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureDir } from './game.mjs';

export const REQUEST_KINDS = Object.freeze(['launch', 'publish', 'economy']);
const ID = /^[A-Za-z0-9_-]{16}$/;
const TTL_MS = 24 * 60 * 60_000;
const MAX_REQUESTS = 50;
const MAX_BYTES = 8 * 1024;

export const requestsDir = (kitRoot) => path.join(kitRoot, '.gamesfun', 'web3', 'requests');
const sameGame = (a, b) => path.resolve(a) === path.resolve(b);

/** Leave a request for the creator. Returns it, with its id. */
export async function queueRequest(kitRoot, { kind, gameDir, input = {}, from = 'agent', summary = '' }) {
  if (!REQUEST_KINDS.includes(kind)) throw new Error(`Unknown request kind ${kind}.`);
  const request = { id: randomBytes(12).toString('base64url'), kind, game: path.resolve(gameDir), input, from: String(from).slice(0, 40), summary: String(summary).slice(0, 300), createdAt: new Date().toISOString() };
  const text = JSON.stringify(request, null, 2);
  if (text.length > MAX_BYTES) throw new Error('That request is too large.');
  const dir = requestsDir(kitRoot);
  await ensureDir(dir);
  if ((await readdir(dir).catch(() => [])).length >= MAX_REQUESTS) throw new Error('Too many requests are waiting. Approve or dismiss some in the studio first.');
  await writeFile(path.join(dir, `${request.id}.json`), `${text}\n`, 'utf8');
  return request;
}

async function readRequest(kitRoot, id) {
  if (!ID.test(String(id))) return null;
  try {
    const request = JSON.parse(await readFile(path.join(requestsDir(kitRoot), `${id}.json`), 'utf8'));
    return request && request.id === id && REQUEST_KINDS.includes(request.kind) ? request : null;
  } catch {
    return null;
  }
}

/** The waiting requests for one game, newest first. Old ones (a day) are cleared. */
export async function listRequests(kitRoot, gameDir) {
  const dir = requestsDir(kitRoot);
  const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.json'));
  const out = [];
  for (const name of names) {
    const request = await readRequest(kitRoot, name.slice(0, -5));
    if (!request) continue;
    if (Date.parse(request.createdAt) < Date.now() - TTL_MS) {
      await rm(path.join(dir, name), { force: true });
      continue;
    }
    if (!gameDir || sameGame(request.game, gameDir)) out.push(request);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** One request for this game, or null. */
export async function getRequest(kitRoot, gameDir, id) {
  const request = await readRequest(kitRoot, id);
  return request && sameGame(request.game, gameDir) ? request : null;
}

export async function removeRequest(kitRoot, id) {
  if (ID.test(String(id))) await rm(path.join(requestsDir(kitRoot), `${id}.json`), { force: true });
}
