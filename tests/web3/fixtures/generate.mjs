// Maintainers only: regenerates the golden fixtures that tests/web3-*.test.mjs compare the kit's dependency-free
// Solana code against. It loads the reference libraries from a SEPARATE install, never the kit's own dependencies
// (the kit has none for this; @solana/web3.js pulls in LGPL code), and reads devnet for real account bytes.
//
//   mkdir ref && cd ref && npm init -y && npm i @solana/web3.js@1.99.0 @solana/spl-token@0.4.15 \
//     @meteora-ag/dynamic-bonding-curve-sdk@1.5.12 @irys/bundles@0.0.5 bn.js@5.2.5
//   node tests/web3/fixtures/generate.mjs --ref <ref dir> --loot-client <games.fun>/launchpad/loot/client/loot.mjs
//
// The loot client is games.fun's own (launchpad/loot/client/loot.mjs), which its devnet end-to-end runs exercised.
import { createHash, generateKeyPairSync, sign as edSign, createPrivateKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
if (!args.ref || !args['loot-client']) throw new Error('usage: --ref <dir> --loot-client <path to loot.mjs>');
const require = createRequire(path.join(path.resolve(args.ref), 'package.json'));
const web3 = require('@solana/web3.js');
const spl = require('@solana/spl-token');
const dbcSdk = require('@meteora-ag/dynamic-bonding-curve-sdk');
const BN = require('bn.js');
const L = await import(pathToFileURL(path.resolve(args['loot-client'])).href);
const here = path.dirname(fileURLToPath(import.meta.url));
const { PublicKey, Keypair, TransactionMessage, VersionedTransaction, Transaction, Connection, ComputeBudgetProgram, SystemProgram } = web3;

const hex = (b) => Buffer.from(b).toString('hex');
const ixJson = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: hex(ix.data),
});
// Deterministic keys from fixed seeds, so the fixtures are stable.
const seeded = (label) => Keypair.fromSeed(createHash('sha256').update(`gamesfun-kit fixture ${label}`).digest());
const key = (label) => seeded(label).publicKey;
const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const out = {};

// ---------------------------------------------------------------- base58, curve, PDAs, ATAs
out.base58 = Array.from({ length: 12 }, (_, i) => {
  const bytes = i < 2 ? Buffer.concat([Buffer.alloc(i + 1), createHash('sha256').update(`b58 ${i}`).digest().subarray(i + 1)]) : key(`b58 ${i}`).toBytes();
  return { hex: hex(bytes), text: new PublicKey(bytes).toBase58() };
});
out.curve = [
  ...Array.from({ length: 24 }, (_, i) => key(`curve key ${i}`).toBytes()),
  ...Array.from({ length: 120 }, (_, i) => createHash('sha256').update(`curve ${i}`).digest()),
  Buffer.alloc(32),
  Buffer.alloc(32, 0xff),
  Buffer.from([1, ...new Array(30).fill(0), 0x80]),
].map((b) => ({ hex: hex(b), onCurve: PublicKey.isOnCurve(b) }));
const programs = [L.LOOT_PROGRAM_ID, new PublicKey('dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'), new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL')];
out.pdas = [];
for (let i = 0; i < 12; i++) {
  const seeds = [Buffer.from(`seed${i}`), key(`pda ${i}`).toBuffer(), Buffer.from([i, 0, 0, 0])].slice(0, 1 + (i % 3));
  const program = programs[i % programs.length];
  const [address, bump] = PublicKey.findProgramAddressSync(seeds, program);
  out.pdas.push({ seeds: seeds.map(hex), program: program.toBase58(), address: address.toBase58(), bump });
}
out.atas = [];
for (let i = 0; i < 6; i++) {
  const owner = i % 2 ? L.pda.game(key(`col ${i}`)) : key(`owner ${i}`);
  const mint = i === 0 ? spl.NATIVE_MINT : key(`mint ${i}`);
  const program = i === 5 ? spl.TOKEN_2022_PROGRAM_ID : spl.TOKEN_PROGRAM_ID;
  out.atas.push({ owner: owner.toBase58(), mint: mint.toBase58(), program: program.toBase58(), address: spl.getAssociatedTokenAddressSync(mint, owner, true, program).toBase58() });
}
out.metadataPda = { mint: key('meta mint').toBase58(), address: dbcSdk.deriveMintMetadata(key('meta mint')).toBase58() };

// ---------------------------------------------------------------- loot program and Core
const creator = key('creator'), player = key('player'), collection = key('collection'), mint = key('game mint');
const game = L.pda.game(collection);
const nonce = 1234567890123n;
const clientSeed = createHash('sha256').update('client seed').digest();
out.loot = {
  inputs: { creator: creator.toBase58(), player: player.toBase58(), collection: collection.toBase58(), mint: mint.toBase58(), nonce: String(nonce), clientSeed: hex(clientSeed) },
  pdas: {
    platform: L.pda.platform().toBase58(),
    game: game.toBase58(),
    item7: L.pda.item(game, 7).toBase58(),
    box3: L.pda.box(game, 3).toBase58(),
    order: L.pda.order(game, player, nonce).toBase58(),
    vrfIdentity: L.pda.vrfIdentity().toBase58(),
  },
  createGame: ixJson(L.createGameIx({ authority: creator, collection, mint, treasury: L.ata(creator, mint), burnBps: 0 })),
  upsertItem: ixJson(L.upsertItemIx({ admin: creator, game, itemId: 7, kind: 'Collectible', rarity: 3, soulbound: true, name: 'Golden Hat', uri: 'https://devnet.irys.xyz/abc', maxSupply: 100, price: 2500000n, active: true })),
  upsertBox: ixJson(L.upsertBoxIx({ admin: creator, game, boxId: 3, price: 1000000n, active: true, entries: [{ itemId: 7, weight: 60 }, { itemId: 8, weight: 40 }] })),
  buyItem: L.buyItemIxs({ player, game, mint, itemId: 7, nonce }).ixs.map(ixJson),
  openBox: L.openBoxIxs({ player, game, mint, boxId: 3, box: { entries: [{ item_id: 7 }, { item_id: 8 }] }, nonce, clientSeed }).ixs.map(ixJson),
  settle: L.settleIxs({
    signer: player,
    order: L.pda.order(game, player, nonce),
    orderAcc: { game, player, item_id: 7 },
    gameAcc: { mint, treasury: L.ata(creator, mint), collection },
    platformAcc: { fee_wallet: new PublicKey('8yPDcNeKHwfSmyx9MPNpgqU8o1W4xiCHxzYty7w3rnNV') },
  }).map(ixJson),
  refund: ixJson(L.refundIx({ signer: player, order: L.pda.order(game, player, nonce), orderAcc: { game, player }, gameAcc: { mint } })),
  createCollection: ixJson(L.createCollectionIx({ collection, updateAuthority: creator, payer: creator, name: 'Bean Brawl Items', uri: 'https://devnet.irys.xyz/col', royaltyBps: 500 })),
};
// SOL wrap order, from spl-token's own builders (games.fun launchpad/loot/api.mjs withSolWrap)
const wsol = spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, player);
out.solWrap = [
  spl.createAssociatedTokenAccountIdempotentInstruction(player, wsol, player, spl.NATIVE_MINT),
  SystemProgram.transfer({ fromPubkey: player, toPubkey: wsol, lamports: 2500000n }),
  spl.createSyncNativeInstruction(wsol),
  spl.createCloseAccountInstruction(wsol, player, player),
  ComputeBudgetProgram.setComputeUnitLimit({ units: 450000 }),
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000 }),
].map(ixJson);

// ---------------------------------------------------------------- messages (v0 byte-exact; legacy for decompiling)
const blockhash = key('blockhash').toBase58();
const buy = L.buyItemIxs({ player, game, mint, itemId: 7, nonce });
const table = { address: key('table').toBase58(), addresses: [L.pda.platform(), spl.TOKEN_PROGRAM_ID, game, L.ata(game, mint), mint, key('unused')].map((k) => k.toBase58()) };
const tableAccount = new web3.AddressLookupTableAccount({ key: new PublicKey(table.address), state: { deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: table.addresses.map((a) => new PublicKey(a)) } });
const v0 = (ixs, tables = []) => hex(new TransactionMessage({ payerKey: player, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(tables).serialize());
out.messages = {
  payer: player.toBase58(),
  blockhash,
  table,
  v0Buy: v0(buy.ixs),
  v0BuyWithTable: v0(buy.ixs, [tableAccount]),
  legacyBuy: hex(new Transaction({ feePayer: player, recentBlockhash: blockhash }).add(...buy.ixs).compileMessage().serialize()),
};

// ---------------------------------------------------------------- real devnet account bytes
const NET = { config: 'FZpLG3faLrRdrFn2n1SU7MDLmmzgyL69g4Rbr21kibTi', quoteMint: '4ikj24Byduo7WZGhnxNYkqstpm9xUVeZH7eLQbjGDL7N', usdc: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', e2eGame: '8ZEuFCLj9jLFUGFoJCvL4ZrH4185JKBTSv94Rcta5Dvq', e2eCollection: 'BT3Po8rB7Deq7HxWkFNbXQmc3mnBPfij7M89UEfuKGLx' };
const raw = async (a) => {
  const info = await conn.getAccountInfo(new PublicKey(a), 'confirmed');
  return info ? { address: a, owner: info.owner.toBase58(), data: info.data.toString('base64') } : null;
};
const client = new dbcSdk.DynamicBondingCurveClient(conn, 'confirmed');
const poolConfig = await client.state.getPoolConfig(NET.config);
out.accounts = {
  poolConfig: { ...(await raw(NET.config)), expect: {
    quoteMint: poolConfig.quoteMint.toBase58(), feeClaimer: poolConfig.feeClaimer.toBase58(), activationType: poolConfig.activationType,
    tokenDecimal: poolConfig.tokenDecimal, tokenType: poolConfig.tokenType, quoteTokenFlag: poolConfig.quoteTokenFlag,
    baseFeeMode: poolConfig.poolFees.baseFee.baseFeeMode,
    migrationQuoteThreshold: poolConfig.migrationQuoteThreshold.toString(), preMigrationTokenSupply: poolConfig.preMigrationTokenSupply.toString(),
    postMigrationTokenSupply: poolConfig.postMigrationTokenSupply.toString(), enableFirstSwapWithMinFee: Boolean(poolConfig.enableFirstSwapWithMinFee),
  } },
  mainMint: await raw(NET.quoteMint),
  mainMetadata: await raw(dbcSdk.deriveMintMetadata(new PublicKey(NET.quoteMint)).toBase58()),
  usdcMint: await raw(NET.usdc),
  lootGame: await raw(NET.e2eGame),
  lootPlatform: await raw(L.pda.platform().toBase58()),
};
const mainUnpacked = spl.unpackMint(new PublicKey(NET.quoteMint), { ...(await conn.getAccountInfo(new PublicKey(NET.quoteMint))), }, spl.TOKEN_PROGRAM_ID);
out.accounts.mainMint.expect = { decimals: mainUnpacked.decimals, supply: mainUnpacked.supply.toString(), mintAuthority: mainUnpacked.mintAuthority?.toBase58() ?? null, freezeAuthority: mainUnpacked.freezeAuthority?.toBase58() ?? null };
const toPlain = (v) => (v && typeof v.toBase58 === 'function' ? v.toBase58() : typeof v === 'bigint' ? v.toString() : Buffer.isBuffer(v) ? hex(v) : Array.isArray(v) ? v.map(toPlain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)])) : v);
out.accounts.lootGame.expect = toPlain(await L.fetchGame(conn, NET.e2eGame));
out.accounts.lootPlatform.expect = toPlain(await L.fetchPlatform(conn));
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const inCollection = await conn.getProgramAccounts(CORE, { commitment: 'confirmed', filters: [{ memcmp: { offset: 0, bytes: '2' } }, { memcmp: { offset: 34, bytes: NET.e2eCollection } }] });
if (inCollection[0]) {
  const a = L.parseCoreAsset(inCollection[0].account.data);
  out.accounts.coreAsset = { address: inCollection[0].pubkey.toBase58(), owner: CORE.toBase58(), data: inCollection[0].account.data.toString('base64'), expect: toPlain(a) };
}
const items = await L.fetchAll(conn, 'ItemDef', [{ memcmp: { offset: 8, bytes: NET.e2eGame } }]);
if (items[0]) out.accounts.lootItem = { ...(await raw(items[0].pubkey.toBase58())), expect: toPlain(Object.fromEntries(Object.entries(items[0]).filter(([k]) => k !== 'pubkey'))) };
const boxes = await L.fetchAll(conn, 'LootBox', [{ memcmp: { offset: 8, bytes: NET.e2eGame } }]);
if (boxes[0]) out.accounts.lootBox = { ...(await raw(boxes[0].pubkey.toBase58())), expect: toPlain(Object.fromEntries(Object.entries(boxes[0]).filter(([k]) => k !== 'pubkey'))) };

// ---------------------------------------------------------------- DBC launch instructions, from the SDK
const baseMint = key('base mint');
const launchCreator = key('launch creator');
const createParam = { name: 'Bean Brawl', symbol: 'BEAN', uri: 'https://devnet.irys.xyz/tokenjson', payer: launchCreator, poolCreator: launchCreator, config: new PublicKey(NET.config), baseMint };
const created = await client.creator.createPool(createParam);
const withBuy = await client.creator.createPoolWithFirstBuy({ createPoolParam: createParam, firstBuyParam: { buyer: launchCreator, buyAmount: new BN('1000000000'), minimumAmountOut: new BN('47000000000000'), referralTokenAccount: null } });
out.dbc = {
  input: { configAddress: NET.config, baseMint: baseMint.toBase58(), creator: launchCreator.toBase58(), name: createParam.name, symbol: createParam.symbol, uri: createParam.uri, amountIn: '1000000000', minimumAmountOut: '47000000000000' },
  pool: dbcSdk.deriveDbcPoolAddress(new PublicKey(NET.quoteMint), baseMint, new PublicKey(NET.config)).toBase58(),
  createPool: created.instructions.map(ixJson),
  createPoolWithFirstBuy: withBuy.instructions.map(ixJson),
};

// ---------------------------------------------------------------- Irys ANS-104 data items (signature type 4)
const bundles = require('@irys/bundles');
const wallet = seeded('irys wallet');
const walletKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(wallet.secretKey.subarray(0, 32))]), format: 'der', type: 'pkcs8' });
// What a Wallet Standard wallet does for Irys's HexInjectedSolanaSigner: sign the hex text of the message.
const hexSigner = {
  signatureType: 4, signatureLength: 64, ownerLength: 32, publicKey: Buffer.from(wallet.publicKey.toBytes()),
  sign: async (message) => edSign(null, Buffer.from(Buffer.from(message).toString('hex')), walletKey),
};
out.irys = [];
for (const [i, item] of [
  { data: Buffer.from('{"name":"Golden Hat"}'), tags: [{ name: 'Content-Type', value: 'application/json' }, { name: 'App-Name', value: 'games.fun' }] },
  { data: createHash('sha512').update('picture').digest(), tags: [{ name: 'Content-Type', value: 'image/png' }] },
  { data: Buffer.from('no tags'), tags: [] },
].entries()) {
  const anchor = createHash('sha256').update(`anchor ${i}`).digest();
  const di = bundles.createData(item.data, hexSigner, { tags: item.tags, anchor });
  const signatureData = await di.getSignatureData();
  await di.sign(hexSigner);
  out.irys.push({ owner: wallet.publicKey.toBase58(), data: hex(item.data), tags: item.tags, anchor: hex(anchor), signatureData: hex(signatureData), raw: hex(di.getRaw()), id: di.id, valid: await di.isValid() });
}

writeFileSync(path.join(here, 'chain.json'), `${JSON.stringify(out, null, 1)}\n`);
console.log('wrote', path.join(here, 'chain.json'));
