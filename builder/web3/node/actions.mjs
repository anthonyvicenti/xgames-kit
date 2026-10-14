// What the web3 CLI and the MCP tools do, shared: each action returns { text, data, approve? }. Drafts (items,
// boxes, the shop's currency, linking a token) change gamesfun.json directly. Anything that signs or spends
// (launching a token, putting the shop on sale) becomes a request the creator approves in the studio's Economy tab
// with their own wallet: `approve` says where. Nothing here signs or holds a key.
import path from 'node:path';
import { findItem } from '../gf-web3/config.js';
import { fromUnits, gamePath, ticker, text } from '../gf-web3/rules.js';
import { launchPlan } from './flows.mjs';
import { chainStatus } from './chain.mjs';
import { linkToken, removeBox, removeItem, saveBox, saveItem, setCurrency, unlinkToken } from './drafts.mjs';
import { readConfig, readPicture } from './game.mjs';
import { KIT_ROOT, resolveGame, studioUrl } from './game-dir.mjs';
import { listRequests, queueRequest } from './requests.mjs';
import { chainContext, maskRpcUrl, readSettings, writeSettings } from './settings.mjs';

export async function web3Action(action, sub, values, { kitRoot = KIT_ROOT, cwd = process.cwd(), env = process.env, from = 'cli', fetchImpl } = {}) {
  if (action === 'settings') {
    if (values['clear-rpc']) await writeSettings(kitRoot, {});
    else if (values.rpc) await writeSettings(kitRoot, { rpcUrl: values.rpc });
    const settings = await readSettings(kitRoot);
    const shown = env.GAMESFUN_RPC_URL ? `${maskRpcUrl(env.GAMESFUN_RPC_URL)} (from GAMESFUN_RPC_URL)` : settings.rpcUrl ? maskRpcUrl(settings.rpcUrl) : 'the public devnet RPC';
    return { text: `RPC: ${shown} (network: devnet)`, data: { rpc: shown, network: 'devnet' } };
  }
  const gameDir = await resolveGame(values.game, { kitRoot, cwd });
  const inside = path.relative(kitRoot, gameDir);
  const rel = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside : gameDir;
  const chain = await chainContext(kitRoot, { env, fetchImpl });
  const ctx = { gameDir, rpc: chain.rpc, network: chain.network };
  const approve = async (kind, input, summary) => {
    const request = await queueRequest(kitRoot, { kind, gameDir, input, from, summary });
    // The Economy tab shows both requests (a token launch is one part of the economy; the shop is part of it too).
    const tab = 'economy';
    const url = await studioUrl({ gameDir, kitRoot, env });
    const where = url ? `${url}#economy (the Economy tab)` : `the studio's Economy tab (start it with: npx gamesfun dev ${rel})`;
    return {
      approve: { requestId: request.id, url, tab, step: `Open ${where} and press "Review and approve". Your wallet shows every step before anything is signed.` },
      text: `${summary}\nWaiting for your approval: open ${where} and press "Review and approve". Nothing is signed until you approve it in your wallet.`,
    };
  };
  const show = (config) => describe(config, chain.network);

  switch (action) {
    case 'status': {
      const config = await readConfig(gameDir);
      let status = null;
      if (!values.offline) status = await chainStatus(chain.rpc, chain.network, config, { pictureHash: (p) => readPicture(gameDir, p).then((x) => x.sha256).catch(() => null) }).catch((e) => ({ error: e.message }));
      const requests = await listRequests(kitRoot, gameDir);
      return { text: [`Game: ${rel} (devnet, RPC ${chain.shown})`, ...show(config), ...statusLines(status), ...(requests.length ? [`Waiting for your approval: ${requests.map((r) => r.kind).join(', ')} (studio)`] : [])].join('\n'), data: { game: rel, config, chain: status, requests } };
    }
    case 'launch': {
      const input = {
        name: text(values.name, 'Token name', { maxBytes: 32 }),
        symbol: ticker(values.symbol),
        picture: gamePath(values.picture, 'Picture'),
        description: values.description ?? '',
        pair: values.pair ?? chain.network.launchpad.defaultPair,
        initialBuy: values.buy ?? '',
        ...(values['sol-usd'] ? { solUsd: values['sol-usd'] } : {}),
        ...(values['start-cap'] ? { startCap: values['start-cap'] } : {}),
        ...(values['graduation-cap'] ? { graduationCap: values['graduation-cap'] } : {}),
      };
      await readPicture(gameDir, input.picture);
      const config = await readConfig(gameDir);
      if (config.token) throw new Error(`This game already has a token ($${config.token.symbol}).`);
      // The pair, the curve and the first buy are checked now (no wallet yet), so a request is never one that fails.
      const plan = await launchPlan(ctx, input, null);
      const { split } = chain.network.launchpad;
      return approve('launch', input, `Launch $${input.symbol} (${input.name}) on a Meteora curve of its own, paired with ${plan.pair.symbol}${input.initialBuy ? `, buying ${input.initialBuy} ${plan.pair.symbol} at launch` : ''}. You keep ${split.creatorTradingFeePercentage}% of its trading fees; games.fun gets ${split.partnerLockedLp}%.`);
    }
    case 'link': {
      const config = await linkToken(ctx, { mint: values.mint });
      return { text: `This game now uses $${config.token.symbol} (${config.token.mint}). A token launched anywhere works with every part of an economy; games.fun takes nothing from its trading fees (only the program's flat per-action fees apply).`, data: { token: config.token } };
    }
    case 'unlink':
      await unlinkToken(ctx);
      return { text: 'This game no longer uses a token.', data: {} };
    case 'currency': {
      const config = await setCurrency(ctx, { currency: sub ?? values.mint });
      return { text: `The shop is priced in ${config.shop.currency.symbol}.`, data: { currency: config.shop.currency } };
    }
    case 'item': {
      const fields = itemFields(values);
      if (sub === 'add' || sub === 'set') {
        if (sub === 'set' && !values.id) throw new Error('item set needs --id.');
        const onChain = sub === 'set' ? (await chainStatus(chain.rpc, chain.network, await readConfig(gameDir)).catch(() => null))?.shop?.items?.[Number(values.id)] : null;
        const { item } = await saveItem(ctx, { ...(sub === 'set' ? { id: values.id } : {}), ...fields }, { issued: onChain?.issued ?? 0, out: onChain?.out ?? 0 });
        return { text: `${sub === 'add' ? 'Added' : 'Saved'} item ${item.id}: ${item.name} (${item.rarity}). It goes on sale with \`gamesfun web3 shop publish\`.`, data: { item } };
      }
      if (sub === 'remove') {
        await removeItem(ctx, { id: values.id });
        return { text: `Removed item ${values.id}.`, data: {} };
      }
      const config = await readConfig(gameDir);
      return { text: show(config).filter((l) => /^ {2}(item|Items)|^Items/.test(l)).join('\n') || 'No items yet.', data: { items: config.shop?.items ?? [] } };
    }
    case 'box': {
      if (sub === 'add' || sub === 'set') {
        if (sub === 'set' && !values.id) throw new Error('box set needs --id.');
        const input = { ...(sub === 'set' ? { id: values.id } : {}), ...(values.name !== undefined ? { name: values.name } : {}), ...(values.price !== undefined ? { price: values.price } : {}), ...(values.odds !== undefined ? { odds: values.odds } : {}) };
        const { box } = await saveBox(ctx, input);
        return { text: `${sub === 'add' ? 'Added' : 'Saved'} loot box ${box.id}: ${box.name}.`, data: { box } };
      }
      if (sub === 'remove') {
        await removeBox(ctx, { id: values.id });
        return { text: `Removed loot box ${values.id}.`, data: {} };
      }
      const config = await readConfig(gameDir);
      return { text: show(config).filter((l) => /box/i.test(l)).join('\n') || 'No loot boxes yet.', data: { boxes: config.shop?.boxes ?? [] } };
    }
    case 'shop': {
      const config = await readConfig(gameDir);
      if (sub === 'publish') {
        if (!config.shop?.items?.length) throw new Error('Add an item first: gamesfun web3 item add --name … --picture …');
        return approve('publish', {}, `Put ${config.shop.name} on sale: ${config.shop.items.length} item(s), ${config.shop.boxes.length} loot box(es).`);
      }
      return { text: show(config).join('\n'), data: { shop: config.shop ?? null } };
    }
    case 'requests': {
      const requests = await listRequests(kitRoot, gameDir);
      return { text: requests.length ? requests.map((r) => `${r.kind}: ${r.summary || JSON.stringify(r.input)} (${r.createdAt})`).join('\n') : 'Nothing is waiting for your approval.', data: { requests } };
    }
    default:
      throw new Error(`Unknown action "${action}". Run gamesfun web3 --help.`);
  }
}

function itemFields(values) {
  const out = {};
  if (values.name !== undefined) out.name = values.name;
  if (values.picture !== undefined) out.picture = values.picture;
  if (values.rarity !== undefined) out.rarity = values.rarity;
  if (values.price !== undefined) out.price = values.price;
  if (values.description !== undefined) out.description = values.description;
  if (values.supply !== undefined) out.maxSupply = values.supply;
  if (values.soulbound !== undefined) out.soulbound = values.soulbound;
  if (values.look !== undefined) {
    try {
      out.look = JSON.parse(values.look);
    } catch {
      throw new Error('--look must be JSON, like \'{"values":{"character.tint.player":"#ffcc00"}}\'.');
    }
  }
  return out;
}

/** Plain lines about a game's setup. */
export function describe(config, network) {
  const lines = [];
  const t = config.token;
  lines.push(t ? `Token: $${t.symbol} ${t.name} (${t.source}) ${t.mint}` : 'Token: none (optional; a shop does not need one)');
  const s = config.shop;
  if (!s) return [...lines, 'Shop: none yet. Add an item to start one.'];
  const unit = s.currency ? s.currency.symbol : 'not chosen yet';
  const fmt = (units) => (s.currency ? `${fromUnits(units, s.currency.decimals)} ${s.currency.symbol}` : `${units} (base units)`);
  lines.push(`Shop: ${s.name}, priced in ${unit}${s.collection ? `, collection ${s.collection}` : ' (not on sale yet)'}`);
  lines.push(`Items (${s.items.length}):`);
  for (const i of s.items) {
    const look = Object.keys({ ...(i.look?.values ?? {}), ...(i.look?.files ?? {}) });
    lines.push(`  item ${i.id}: ${i.name} · ${i.rarity} · ${i.price === '0' ? 'loot boxes only' : fmt(i.price)}${look.length ? ` · changes ${look.join(', ')}` : ''}${i.listed ? ' · listed' : ' · draft'}${i.picture ? '' : i.image ? '' : ' · needs a picture'}`);
  }
  lines.push(`Loot boxes (${s.boxes.length}):`);
  for (const b of s.boxes) {
    const total = b.entries.reduce((n, e) => n + e.weight, 0);
    lines.push(`  box ${b.id}: ${b.name} · ${fmt(b.price)} · ${b.entries.map((e) => `${findItem(config, e.item)?.name ?? e.item} ${((e.weight / total) * 100).toFixed(1)}%`).join(', ')}${b.listed ? ' · listed' : ' · draft'}`);
  }
  return lines;
}

function statusLines(status) {
  if (!status) return [];
  if (status.error) return [`Chain: could not read (${status.error})`];
  const lines = [];
  if (status.token) lines.push(`Chain: token ${status.token.exists ? 'found' : 'not found'}${status.token.pool ? `, curve ${status.token.pool.isMigrated ? 'graduated' : 'live'}` : ''}`);
  if (status.shop) {
    const items = Object.values(status.shop.items);
    const count = (state) => items.filter((i) => i.state === state).length;
    lines.push(`Chain: shop ${status.shop.exists ? 'live' : 'not live'}; items ${count('published')} on sale, ${count('changed')} changed, ${count('draft')} draft`);
  }
  return lines;
}

