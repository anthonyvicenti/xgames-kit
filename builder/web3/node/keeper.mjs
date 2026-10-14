// The local keeper: a process on the creator's machine that signs a game's frequent decisions with a key file the
// creator made there (`gamesfun economy keeper --new-key <file>`), for games that decide too often for a wallet prompt.
//
//   newKeeperKey(file, { gameDir, kitRoot })   writes a fresh keypair file (0600), outside the game and the kit; returns
//                                              its public address only
//   readKeeperKey(file, { gameDir, kitRoot })  the key, refused inside the game or the kit
//   createKeeper({ gameDir, kitRoot, key, rpc, network })
//       .decide(request)  one request, checked by the same rules as the page (decide.mjs), then signed and sent; every
//                         request, done or refused, is a line in the game's ledger. One at a time, in order.
//       .listen({ port }) a loopback HTTP listener: POST /economy/decide-request (with the token the status file holds)
//       .close()
//   keeperStatus(kitRoot, gameDir), forwardToKeeper(kitRoot, gameDir, request): how the dev server finds and calls it
//
// Requests are claims (decide.mjs): the keeper acts only on decisions the spec gives it ("signedBy": "keeper"), only
// with the proof the spec asks for, and only within its caps. Those rules are the keeper's own: the loot program trusts
// the authority's signature and checks nothing else.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { encodeBase58 } from '../gf-web3/chain/base58.js';
import { explorerUrl } from '../gf-web3/network.js';
import { appendLedger, findDecision, ledgerFile, prepareDecision, readLedger, readRequest } from './decide.mjs';
import { decisionWire, refusalWords } from './decide-flows.mjs';
import { readEconomy } from './economy.mjs';
import { readKeyFile } from './economy-check.mjs';
import { isInside } from './game.mjs';

const MAX_BODY = 8 * 1024;
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '');

/** Why a key file may not live at `file`: inside the game, the kit, or any git checkout. null when it may. */
export function keyPlaceProblem(file, { gameDir, kitRoot }) {
  const full = path.resolve(file);
  if (gameDir && isInside(path.resolve(gameDir), full)) return 'That is inside the game’s folder, which gets shared and published. Keep the key outside it (for example ~/.config/gamesfun/keeper-<game>.json).';
  if (kitRoot && isInside(path.resolve(kitRoot), full)) return 'That is inside the kit’s folder, a git repository. Keep the key outside it (for example ~/.config/gamesfun/keeper-<game>.json).';
  for (let dir = path.dirname(full); ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, '.git'))) return `That is inside a git repository (${dir}). Keep the key outside any repository.`;
    if (path.dirname(dir) === dir) break;
  }
  return null;
}

/** A fresh keypair file (a 64-byte JSON array, as the Solana CLI writes them), mode 0600. Returns { address, file }. */
export async function newKeeperKey(file, { gameDir, kitRoot } = {}) {
  const full = path.resolve(file);
  const problem = keyPlaceProblem(full, { gameDir, kitRoot });
  if (problem) throw new Error(`Not written: ${problem}`);
  if (existsSync(full)) throw new Error(`Not written: ${full} already exists. Name a new file; an existing key is never overwritten.`);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d, 'base64url');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
  await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
  await writeFile(full, `${JSON.stringify([...seed, ...pub])}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  seed.fill(0);
  return { address: encodeBase58(new Uint8Array(pub)), file: full };
}

/** The keeper's key from its file: refused inside the game or the kit; a file others can read is named in `warnings`. */
export async function readKeeperKey(file, { gameDir, kitRoot } = {}) {
  const full = path.resolve(file);
  const problem = keyPlaceProblem(full, { gameDir, kitRoot });
  if (problem) throw new Error(`The keeper will not use that key: ${problem} Make a new one outside: npx gamesfun economy keeper --new-key <file>, then move the game’s decisions to it.`);
  const warnings = [];
  const info = await stat(full).catch(() => null);
  if (info && process.platform !== 'win32' && info.mode & 0o077) warnings.push(`${full} can be read by other users of this machine (chmod 600 ${full}).`);
  return { key: await readKeyFile(full), warnings };
}

// ---------------------------------------------------------------- where a running keeper is

const keeperDir = (kitRoot) => path.join(kitRoot, '.gamesfun', 'web3', 'keeper');
const statusFile = (kitRoot, gameDir) => path.join(keeperDir(kitRoot), `${encodeURIComponent(path.resolve(gameDir)).replace(/%/g, '_').slice(-120)}.json`);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** The keeper running for this game: { running, address, url, startedAt } (never its token to a page), or { running: false }. */
export async function keeperStatus(kitRoot, gameDir, { withToken = false } = {}) {
  try {
    const s = JSON.parse(await readFile(statusFile(kitRoot, gameDir), 'utf8'));
    if (!s.pid || !alive(s.pid)) return { running: false, address: s.address ?? null };
    return { running: true, address: s.address, url: s.url, startedAt: s.startedAt, ...(withToken ? { token: s.token } : {}) };
  } catch {
    return { running: false, address: null };
  }
}

/** Hands a request to the game's keeper (the dev server's POST /economy/decide-request). */
export async function forwardToKeeper(kitRoot, gameDir, request, { fetchImpl = globalThis.fetch } = {}) {
  const s = await keeperStatus(kitRoot, gameDir, { withToken: true });
  if (!s.running) {
    const error = new Error('No keeper is running for this game, so nothing decides by itself. Start one: npx gamesfun economy keeper --key <your keeper key file>. Or decide from the Economy tab.');
    error.status = 409;
    throw error;
  }
  const res = await fetchImpl(`${s.url}/economy/decide-request`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gamesfun-keeper': s.token }, body: JSON.stringify(request) });
  return res.json();
}

// ---------------------------------------------------------------- the keeper

/**
 * ctx: { gameDir, kitRoot, key ({ address, sign }), rpc, network, log?, now? }. Returns { address, decide, listen, close }.
 * decide(request) → { ok, decided, says, signature?, explorer?, refusals?, text }: a refusal is an answer, not an error.
 */
export function createKeeper({ gameDir, kitRoot, key, rpc, network, log = () => {}, now = () => Math.floor(Date.now() / 1000) }) {
  let queue = Promise.resolve();
  let server = null;
  let token = null;

  async function decideNow(input) {
    const at = new Date().toISOString();
    const { economy } = await readEconomy(gameDir);
    const ledgerPath = ledgerFile(kitRoot, economy?.live?.game ?? 'not-live');
    const refused = async (refusals, extra = {}) => {
      const text = refusalWords(refusals);
      await appendLedger(ledgerPath, { at, by: 'keeper', verdict: 'refused', reasons: refusals.map((r) => r.code), text, ...extra });
      log(`refused: ${text}`);
      return { ok: false, decided: false, refusals, text };
    };
    let request;
    try {
      request = readRequest(input);
    } catch (error) {
      return refused([{ code: 'D-REQUEST', message: error.message, fix: 'Send the request in the shape the keeper takes (web3/economy/README.md, Decisions).' }]);
    }
    const summary = { decision: request.decision, requestId: request.id ?? null, to: request.to ?? null, attempt: request.attempt ?? null, claim: request.says ?? null };
    if (!economy) return refused([{ code: 'D-NOT-LIVE', message: 'This game has no economy.', fix: 'Write one and put it live.' }], summary);
    const rule = findDecision(economy, request.decision, request);
    if (rule && rule.signedBy !== 'keeper')
      return refused([{ code: 'D-NOT-KEEPER', message: `The economy says ${rule.signedBy === 'server' ? 'the game’s server' : 'you, from the studio page,'} sign “${rule.when}”, not the keeper.`, fix: `Set "signedBy": "keeper" on that decision if the keeper should sign it.` }], summary);
    const p = await prepareDecision({ economy, request, rpc, signer: key.address, ledger: await readLedger(ledgerPath), by: 'keeper', now: now() });
    if (!p.ok) return refused(p.refusals, { ...summary, says: p.says });
    const { blockhash, lastValidBlockHeight } = await rpc.latestBlockhash();
    const wire = decisionWire({ payer: key.address, blockhash, instructions: p.instructions, signers: [key, ...p.signers] });
    let signature;
    try {
      signature = await rpc.send(wire);
      await rpc.confirm(signature, { lastValidBlockHeight });
    } catch (error) {
      await appendLedger(ledgerPath, { at, ...p.record, verdict: 'failed', signature: signature ?? null, text: error.message });
      log(`failed: ${p.says}: ${error.message}`);
      return { ok: false, decided: false, says: p.says, refusals: [{ code: 'D-SEND', message: `The network refused it: ${error.message}`, fix: 'Look at the logs; nothing was paid.' }], text: error.message, signature: signature ?? null };
    } finally {
      for (const k of p.signers) k.drop?.();
    }
    await appendLedger(ledgerPath, { at, ...p.record, verdict: 'done', signature });
    const explorer = explorerUrl(network, 'tx', signature);
    log(`decided: ${p.says} ${explorer}`);
    return { ok: true, decided: true, says: p.says, signature, explorer, text: `${p.says}. ${explorer}` };
  }

  /** One request at a time, in the order they came: two claims on one attempt can never both pass. */
  function decide(request) {
    const run = queue.then(() => decideNow(request));
    queue = run.catch(() => {});
    return run;
  }

  async function listen({ port = 0, host = '127.0.0.1' } = {}) {
    token = randomBytes(24).toString('base64url');
    server = http.createServer(async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      try {
        if (req.headers['x-gamesfun-keeper'] !== token) return send(403, { error: 'Refused: this keeper only takes requests from this machine’s studio (the token in its status file).' });
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (req.method === 'GET' && url.pathname === '/status') return send(200, { address: key.address, game: path.basename(gameDir) });
        if (req.method !== 'POST' || url.pathname !== '/economy/decide-request') return send(404, { error: 'Not here.' });
        const chunks = [];
        let size = 0;
        for await (const c of req) {
          size += c.length;
          if (size > MAX_BODY) return send(413, { error: 'Too large.' });
          chunks.push(c);
        }
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return send(400, { error: 'Send JSON.' });
        }
        send(200, await decide(body));
      } catch (error) {
        log(`error: ${error.message}`);
        send(500, { error: error.message });
      }
    });
    await new Promise((resolve, reject) => server.once('error', reject).listen(port, host, resolve));
    const url = `http://${host}:${server.address().port}`;
    await mkdir(keeperDir(kitRoot), { recursive: true, mode: 0o700 });
    await writeFile(statusFile(kitRoot, gameDir), `${JSON.stringify({ address: key.address, url, token, pid: process.pid, game: path.resolve(gameDir), startedAt: new Date().toISOString() }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { url };
  }

  async function close() {
    if (server) await new Promise((r) => (server.closeAllConnections?.(), server.close(r)));
    server = null;
    await rm(statusFile(kitRoot, gameDir), { force: true });
    await queue;
  }

  return { address: key.address, decide, listen, close, short: short(key.address) };
}
