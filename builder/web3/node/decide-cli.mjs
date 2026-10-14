// `gamesfun economy decide` and `gamesfun economy keeper` (builder/commands/economy.mjs calls these).
//   decide   checks one decision against the economy's rules and prints the studio link where the creator's wallet signs
//            it. Never signs.
//   keeper   the local keeper (builder/web3/node/keeper.mjs): signs the game's frequent decisions with a key file the creator
//            made on this machine; --new-key <file> makes that file (outside the game and the kit) and prints only its
//            public address.
import path from 'node:path';
import { printJson, UsageError } from '../../lib/cli.mjs';
import { resolveGame } from '../../lib/games.mjs';
import { decodeLoot, LootAccount } from '../gf-web3/chain/loot.js';
import { ledgerFile, linkParams, prepareDecision, readLedger, readRequest } from './decide.mjs';
import { readEconomy } from './economy.mjs';
import { KIT_ROOT, studioUrl } from './game-dir.mjs';
import { createKeeper, keeperStatus, newKeeperKey, readKeeperKey } from './keeper.mjs';
import { chainContext } from './settings.mjs';

export const decideOptions = {
  decision: { type: 'string' }, to: { type: 'string' }, amount: { type: 'string' }, percent: { type: 'string' }, side: { type: 'string' },
  asset: { type: 'string' }, attempt: { type: 'string' }, id: { type: 'string' }, open: { type: 'boolean' }, 'new-key': { type: 'string' }, port: { type: 'string' },
};

export const decideUsage = `  decide      One of the authority's decisions, checked against the economy's rules (amount, pool, receiver, proof, caps),
              and the studio link where your wallet signs it (this never signs)
              --decision <key | contest:<key> | hold:<key>> [--to <wallet>] [--amount <n> | --percent <n>] [--side <n>]
              [--asset <held collectible>] [--attempt <the attempt's payment signature>] [--id <the game's result id>] [--open]
  keeper      The local keeper: signs the game's frequent decisions with a key file you made on this machine
              --key <file> (or GAMESFUN_KEEPER_KEY=<file>) [--port <n>]; it listens on 127.0.0.1 for the studio
              --new-key <file>: make that key file (0600, outside the game and the kit); prints only its address.
              Then "Let my keeper decide" in the Economy tab hands it the game's decisions (one wallet approval).`;

/** `economy decide`: the check in words and the link. */
export async function decide(target, values) {
  const dir = await resolveGame(target);
  const request = readRequest({ decision: values.decision, to: values.to, amount: values.amount, percent: values.percent, side: values.side, asset: values.asset, attempt: values.attempt, id: values.id, open: values.open });
  const { economy } = await readEconomy(dir);
  if (!economy) throw new Error(`${path.basename(dir)}'s gamesfun.json has no "economy" section yet.`);
  const chain = await chainContext(KIT_ROOT);
  const ledger = economy.live?.game ? await readLedger(ledgerFile(KIT_ROOT, economy.live.game)) : [];
  const p = await prepareDecision({ economy, request, rpc: chain.rpc, signer: null, ledger, by: 'page' });
  const base = await studioUrl({ gameDir: dir, kitRoot: KIT_ROOT });
  let link = null;
  if (base) {
    const u = new URL(base);
    u.hash = `economy?${new URLSearchParams(linkParams(request)).toString()}`;
    link = u.toString();
  }
  if (values.json) {
    printJson({ ok: p.ok, says: p.says, refusals: p.refusals, notes: p.notes, numbers: p.numbers, link, params: linkParams(request) });
    return p.ok ? 0 : 1;
  }
  const lines = [p.ok ? `${p.says}.` : `Not possible as asked: ${p.says}.`, ...p.numbers.map(([k, v]) => `  ${k}: ${v}`), ...p.refusals.map((r) => `✗ ${r.message}\n    Fix: ${r.fix}`), ...p.notes.map((n) => `  ${n}`)];
  if (p.ok) lines.push(link ? `Sign it in your wallet: ${link}` : `Sign it in your wallet from the studio's Economy tab (start it with: npx gamesfun dev ${path.relative(process.cwd(), dir) || '.'}), with ${new URLSearchParams(linkParams(request))}.`, 'Nothing was signed here.');
  console.log(lines.join('\n'));
  return p.ok ? 0 : 1;
}

/** `economy keeper`: make a key, or run the keeper until Ctrl-C. */
export async function keeper(target, values) {
  if (values['new-key']) {
    const dir = target ? await resolveGame(target).catch(() => null) : await resolveGame(undefined).catch(() => null);
    const made = await newKeeperKey(values['new-key'], { gameDir: dir, kitRoot: KIT_ROOT });
    if (values.json) printJson({ address: made.address, file: made.file });
    else
      console.log([
        `A new keeper key: ${made.address}`,
        `Written to ${made.file} (only you can read it). It is never printed, sent or stored anywhere else; back it up like a wallet.`,
        'Next: send it a little devnet SOL for its fees (about 0.000015 SOL a decision, plus about 0.002 SOL the first time a player receives SOL: their SOL account), start the keeper with --key, and press "Let my keeper decide" in the Economy tab.',
      ].join('\n'));
    return 0;
  }
  const file = values.key ?? process.env.GAMESFUN_KEEPER_KEY;
  if (!file) throw new UsageError(`Name the keeper's key file: --key <file> or GAMESFUN_KEEPER_KEY=<file>. Make one with --new-key <file>.\n\n${decideUsage}`);
  const dir = await resolveGame(target);
  const { key, warnings } = await readKeeperKey(file, { gameDir: dir, kitRoot: KIT_ROOT });
  for (const w of warnings) console.log(`! ${w}`);
  const running = await keeperStatus(KIT_ROOT, dir);
  if (running.running) throw new Error(`A keeper already runs for ${path.basename(dir)} (${running.url}, key ${running.address}). Stop it first.`);
  const chain = await chainContext(KIT_ROOT);
  const { economy } = await readEconomy(dir);
  if (!economy?.live?.game) throw new Error(`${path.basename(dir)}'s economy is not live yet. Put it live first (npx gamesfun economy publish).`);
  const [account] = await chain.rpc.accounts([economy.live.game]);
  const authority = account ? decodeLoot(LootAccount.Game, account.data).authority : null;
  const k = createKeeper({ gameDir: dir, kitRoot: KIT_ROOT, key, rpc: chain.rpc, network: chain.network, log: (t) => console.log(`${new Date().toISOString()} ${t}`) });
  const { url } = await k.listen({ port: values.port ? Number(values.port) : 0 });
  console.log([
    `Keeper for ${path.basename(dir)}: key ${key.address}, listening on ${url} (this machine only).`,
    authority === key.address ? 'It is the game’s authority: it decides.' : `It is not the game’s authority yet (that is ${authority}): press "Let my keeper decide" in the Economy tab. Until then it refuses every request.`,
    `Every decision is logged to ${ledgerFile(KIT_ROOT, economy.live.game)}. Its caps and proof are its own rules, not the program's. Ctrl-C stops it.`,
  ].join('\n'));
  await new Promise((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await k.close();
  return 0;
}
