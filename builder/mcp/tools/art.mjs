// Art MCP tools: the asset library (find, fill, ingest), who makes a piece of art (and why), the request a session
// draws from, and the intake that checks an answer before it is written through a slot. None of these calls a model.
// gamesfun_art_make and gamesfun_art_generate call a paid service only with the person's own key and only with
// `yes: true`, which the session passes after the person agreed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveGame } from '../../lib/games.mjs';
import { KIT_ROOT } from '../../lib/paths.mjs';
import { chooseMaker, detectAgent, keyState, KINDS, loadProviders } from '../../art/providers.mjs';
import { artMake, artRequest, artTake } from '../../art/session.mjs';
import { loadConfig } from '../../art/config.mjs';
import { fillGame } from '../../art/fill.mjs';
import { generateSlot } from '../../art/generate.mjs';
import { loadLibrary } from '../../art/library.mjs';
import { loadPolicy } from '../../art/policy.mjs';
import { find, loadKind } from '../../art/resolve.mjs';

const inKit = p => (p ? path.resolve(KIT_ROOT, p) : null);
const withLook = async r => {
  const content = [{ type: 'text', text: JSON.stringify(r, null, 2) }];
  if (r.look) { try { content.push({ type: 'image', data: (await readFile(r.look)).toString('base64'), mimeType: 'image/png' }); } catch { /* the text names the file */ } }
  return { content, isError: false };
};

export const tools = [
  {
    name: 'gamesfun_art_find',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Search the asset library (every pack in library/packs and the person\'s private packs) by words, before making anything: "wooden bridge", "skeleton warrior", "grass path corner". Ranked by the words, the kind\'s packs first (`kind`: silly, blocky, lofi, scenic, dark, calm, pixel, drawn), the device budgets and the licence policy. Each result has its ref (<pack>/<id>, what a spec\'s fill.asset or "library:<ref>" names), its licence and a preview path.',
    inputSchema: { type: 'object', required: ['words'], properties: { words: { type: 'string' }, kind: { type: 'string' }, dimension: { type: 'string', enum: ['3d', '2d', 'audio'] }, category: { type: 'string' }, devices: { type: 'array', items: { type: 'string' } }, limit: { type: 'number' } } },
    async handler({ words, kind, dimension, category, devices, limit }) {
      const config = loadConfig(), lib = loadLibrary(config);
      return find(lib, words, { kindPreset: kind ? loadKind(kind, config.kindsDir) : null, policy: loadPolicy(config.policyFile), devices: devices ?? ['desktop'], dimension, category, limit: limit ?? 10 });
    },
  },
  {
    name: 'gamesfun_art_fill',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Fill a game\'s file slots from the asset library by need and fit (the art order\'s library step). `write: false` (the default) only plans: each slot with the asset it would take and why, and the slots nothing fits (their next step: a connection, gamesfun_art_generate). `provided` names slots the person gave a file for (left alone). With `write: true` the files are copied into the game; add each credit line it returns to the game\'s ATTRIBUTION.md.',
    inputSchema: { type: 'object', properties: { game: { type: 'string' }, kind: { type: 'string' }, provided: { type: 'array', items: { type: 'string' } }, write: { type: 'boolean' }, slots: { type: 'array', items: { type: 'string' }, description: 'Only these slot ids (default: every file slot)' } } },
    async handler({ game, kind, provided, write, slots }) {
      const dir = await resolveGame(game, { cwd: KIT_ROOT });
      const m = JSON.parse(await readFile(path.join(dir, 'assets.json'), 'utf8'));
      const list = (m.slots ?? []).filter(s => !slots || slots.includes(s.id));
      return fillGame({ config: loadConfig(), game: dir, slots: list, kind: kind ?? null, provided: provided ?? [], write: write === true });
    },
  },
  {
    name: 'gamesfun_art_ingest',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Take files into the asset library: a file, a folder, a zip or a URL into a pack. Each file is optimized, previewed, validated (rig-check for bodies, the flat judge for 2D, the sound gate for sounds), measured and given a manifest; a file already in the library by its hash is skipped. A pack that does not exist yet needs its licence (`licence`: { spdx, author, url, credit }); a file with no licence record goes to quarantine, never the index. `private: true` keeps a new pack in the private packs folder (never pushed).',
    inputSchema: { type: 'object', required: ['input', 'pack'], properties: { input: { type: 'string' }, pack: { type: 'string' }, licence: { type: 'object' }, private: { type: 'boolean' }, include: { type: 'array', items: { type: 'string' } }, category: { type: 'string' }, style: { type: 'string', enum: ['pixel', 'drawn'] }, describe: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } } },
    async handler(a) {
      const { ingest } = await import('../../art/ingest.mjs');
      const input = /^https?:\/\//.test(a.input) ? a.input : inKit(a.input);
      return ingest(input, { config: loadConfig(), pack: a.pack, include: a.include, category: a.category, style: a.style, describe: a.describe, tags: a.tags, licence: a.licence ?? null, newPack: { visibility: a.private ? 'private' : 'public', owner: a.private ? 'own' : 'third-party' } });
    },
  },
  {
    name: 'gamesfun_art_generate',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: 'Make a new model for a game\'s slot with a paid maker (Meshy, on the person\'s own key): the art order\'s connection step, for a spec\'s fill.from "generate" and the build loop\'s generate rung. Without `yes` nothing is called: it returns the plan and the cost. With `yes: true` (only after the person agreed to the spend) the model is made, taken into the game\'s private pack through ingest (validated: rig-check for a body), and put in the slot. Search the library first (gamesfun_art_find): what it has costs nothing.',
    inputSchema: { type: 'object', required: ['slot', 'words'], properties: { game: { type: 'string' }, slot: { type: 'string' }, words: { type: 'string', description: 'What to make, in a sentence' }, maker: { type: 'string', enum: ['meshy'] }, yes: { type: 'boolean' } } },
    async handler({ game, slot, words, maker, yes }, ctx) { return generateSlot({ game: await resolveGame(game, { cwd: KIT_ROOT }), slot, words, maker: maker ?? 'meshy', yes: yes === true, log: m => ctx.progress?.(m) }); },
  },
  {
    name: 'gamesfun_art_makers',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Which maker each kind of art (picture, sheet, tile, model) would come from on this machine now, and why, with the makers passed over. The order is fixed: art the person provided → the asset library (when it has something that fits the slot; gamesfun_art_find) → a connection they offered (a key in the environment, or GF_ART_<KIND>=connection:<name>) → your own session → the kit\'s stand-ins. `table: true` adds every maker\'s cost and licence note (quoted and dated: re-read before relying on them).',
    inputSchema: { type: 'object', properties: { style: { type: 'string', enum: ['pixel', 'drawn'] }, table: { type: 'boolean' } } },
    async handler({ style, table }, ctx) {
      const data = loadProviders(), agent = detectAgent({ client: ctx.client });
      const out = { agent, order: data.order, choice: KINDS.map(kind => { const c = chooseMaker({ kind, style: style ?? null, agent: agent ?? undefined, data }); return { kind, maker: c.maker.id, name: c.connection ? `connection "${c.connection}"` : c.maker.name, why: c.why, passedOver: c.passedOver }; }) };
      if (table) out.makers = data.providers.map(p => ({ id: p.id, name: p.name, tier: p.tier, kinds: p.kinds, styles: p.styles ?? null, reach: p.reach.via === 'env' ? { key: p.reach.env, set: keyState(p).set } : { via: p.reach.via }, can: p.can, cost: p.cost, licence: p.licence, run: p.run }));
      return out;
    },
  },
  {
    name: 'gamesfun_art_request',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Start a piece of 2D art (or a 3D model) for a game\'s slot. Decides the maker by the fixed order and returns a ticket. When the asset library has something that fits, the ticket names it (`pick`): take it with gamesfun_art_take {library: true}, or ask again with fresh: true for a new one. When YOU (the session) are the maker, `request` is the exact brief to draw from: answer it yourself as one SVG (drawn style) or a pixel grid (pixel style), then call gamesfun_art_take with the ticket. When the maker is a paid service, it returns the cost: tell the person and ask before gamesfun_art_make. The first request for a game fixes its style, palette and one line of art direction; later requests reuse them.',
    inputSchema: {
      type: 'object', required: ['subject'],
      properties: {
        game: { type: 'string', description: 'The game folder, relative to the kit root. Optional when there is only one game.' },
        slot: { type: 'string', description: 'The slot to fill (an image or model file slot), e.g. character.body.player' },
        out: { type: 'string', description: 'Instead of game and slot: a file to write, relative to the kit root (needs kind)' },
        subject: { type: 'string', description: 'What to draw, in a sentence' },
        kind: { type: 'string', enum: KINDS, description: 'Normally read from the slot' },
        style: { type: 'string', enum: ['pixel', 'drawn'] },
        plane: { type: 'string', enum: ['side', 'top'], description: 'For a body sheet: how the game sees the character (default side)' },
        palette: { type: 'array', items: { type: 'string' }, description: 'Colours as #rrggbb' },
        direction: { type: 'string', description: 'One line of art direction for every picture in this game' },
        provided: { type: 'string', description: 'A file the person gave for this (a path): then it is used, whatever else is connected' },
        fresh: { type: 'boolean', description: 'Make a new one even when the asset library has something that fits' },
      },
    },
    async handler(a, ctx) {
      const game = a.out && !a.slot ? null : await resolveGame(a.game, { cwd: KIT_ROOT });
      return artRequest({ game, slot: a.slot ?? null, out: inKit(a.out), kind: a.kind ?? null, style: a.style ?? null, plane: a.plane ?? 'side', subject: a.subject, palette: a.palette ?? null, direction: a.direction ?? null, provided: a.provided ?? null, fresh: a.fresh === true, agent: detectAgent({ client: ctx.client }) ?? undefined });
    },
  },
  {
    name: 'gamesfun_art_take',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    description: 'Hand back the answer for an art ticket: `svg` (the SVG text), `grid` (the pixel grid JSON text) or `file` (a PNG or GLB path, e.g. from your own image tool, a connection or the person). It is drawn to a PNG, checked against the ticket (size, see-through ground, the six frames, feet and centre, seams, triangle budget) and only when it passes written through the slot. A refusal lists what to change: redraw and call again with the same ticket. The result includes the picture: LOOK at it; the checks do not see whether it is good.',
    inputSchema: { type: 'object', required: ['ticket'], properties: { ticket: { type: 'string' }, svg: { type: 'string' }, grid: { type: 'string' }, file: { type: 'string' }, library: { type: ['boolean', 'string'], description: 'true: the asset library\'s pick the ticket names; or a <pack>/<id>' }, write: { type: 'boolean', description: 'false checks and shows without writing (default true)' } } },
    async handler({ ticket, svg, grid, file, library, write }) { return withLook(await artTake(ticket, { svg: svg ?? null, grid: grid ?? null, file: inKit(file), library: library ?? null, write: write !== false })); },
  },
  {
    name: 'gamesfun_art_make',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    description: 'Make a ticket\'s art with a key-based maker (the person\'s own key, from their environment). Without `yes` nothing is called: it returns the request that would be sent and the cost, as a step for the person. Pass `yes: true` only after the person agreed to the spend. For a 3D model, `image` is a concept picture: it is checked first, and a bad one stops the call before anything is paid for.',
    inputSchema: { type: 'object', required: ['ticket'], properties: { ticket: { type: 'string' }, yes: { type: 'boolean' }, image: { type: 'string' } } },
    async handler({ ticket, yes, image }, ctx) { return withLook(await artMake(ticket, { yes: yes === true, image: inKit(image), log: m => ctx.progress(m) })); },
  },
];
