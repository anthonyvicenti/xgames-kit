// The art order's connection step for generated art: a slot that asks for something made (a spec's `fill.from:
// generate`, the build loop's generate rung, the Studio worker) calls a maker, the result goes through ingest into the
// game's own private pack, and the slot is filled from that pack. So a made model is an asset like any other: a
// manifest, a preview, its validator's verdict, its licence, its bytes in the store by hash, and never in the
// repository (a private pack lives in the private packs folder, library.json).
//
//   generateSlot({ game, slot, words, maker = 'meshy', yes, size, style, makers, config, renderer, log })
//     style: { anchor: <png>, target, loose } draws a prop from a look's style anchor (the looks wave's recipe), so a
//     made model sits in the game's look (loose: a thing players get, drawn with no base); left out, the words alone
//     → { ok, paid, plan | { ref, file, credits, validated, problems }, next }
//
// Without `yes` nothing is called and nothing is spent: it returns the plan and the cost, a step for the person (or the
// loop's ladder) to approve. With `yes` the maker runs on the person's own key (Meshy: MESHY_API_KEY in the environment,
// never written anywhere by us; its credit ledger and cap are the maker's own, builder/tools/lib/char-meshy.mjs).
// A made file that fails its validator is kept in the pack (marked failed, so the resolver never offers it) and the slot
// keeps what it had: the result says so plainly.
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findSlot, setFile } from '../lib/slots.mjs';
import { loadConfig } from './config.mjs';
import { loadLibrary } from './library.mjs';
import { lazyRenderer } from './render.mjs';
import { exportAsset } from './store.mjs';

const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'x';

/** The makers this step can call: each plans (no cost) and makes (paid) one file for a slot. */
export const MAKERS = {
  meshy: {
    name: 'Meshy',
    kinds: ['body', 'prop'],
    licence: { spdx: 'LicenseRef-Meshy-Paid', author: 'Meshy AI, generated on the creator\'s paid account', url: 'https://www.meshy.ai' },
    licenceText: 'Meshy output generated on the creator\'s paid Meshy plan (the creator, 2026-10-10: "They are paid"); under Meshy\'s paid-plan terms the output belongs to the account holder. A private pack: never pushed.',
    // a creature's body (archetype worm, blob, quadruped or flyer: CREATURES.md) is made like a prop, unrigged (Meshy's
    // rigging fits bipeds only), and rigged on its archetype's standard by the kit's autorig when it is taken in
    async plan({ kind, words, size, archetype = 'humanoid', style = null }) {
      if (kind === 'body' && archetype === 'humanoid') { const { generateCharacter } = await import('../tools/meshy-character.mjs'); return generateCharacter({ prompt: words, out: path.join(os.tmpdir(), 'plan.glb'), dryRun: true }); }
      const { generateProp } = await import('../tools/meshy-prop.mjs');
      // drawn from a look's anchor: the concept is image-to-image (the same 6 credits as text-to-image), then the model
      if (style?.anchor && kind === 'prop') { const { conceptPrompt } = await import('./recipe.mjs'); return { ...(await generateProp({ prompt: words, image: style.anchor, out: path.join(os.tmpdir(), 'plan.glb'), size, dryRun: true })), conceptPrompt: conceptPrompt({ kind: 'prop', words, size, held: !!style.loose }, style.target ?? null), anchor: path.basename(style.anchor) }; }
      return generateProp({ prompt: words, out: path.join(os.tmpdir(), 'plan.glb'), size, dryRun: true });
    },
    async make({ kind, words, size, out, log, archetype = 'humanoid', style = null }) {
      const onProgress = m => log(m);
      if (kind === 'body' && archetype === 'humanoid') { const { generateCharacter } = await import('../tools/meshy-character.mjs'); return generateCharacter({ prompt: words, describe: words, out, onProgress }); }
      if (kind === 'body') { const { POSE_OF } = await import('./recipe.mjs'); words = `${words}, ${POSE_OF[archetype] ?? ''}`; }
      const { generateProp } = await import('../tools/meshy-prop.mjs');
      if (style?.anchor && kind === 'prop') return makeFromAnchor({ words, size, out, style, onProgress, generateProp });
      return generateProp({ prompt: words, describe: words, out, size, onProgress });
    },
  },
};

/**
 * A prop drawn in a look's style, as the looks wave makes its pieces (builder/art/wave.mjs): a concept by image-to-image
 * with the look's style anchor as the only reference (builder/art/recipe.mjs conceptPrompt: the one subject, in the
 * sheet's palette, shading and proportions), then image-to-3D from that concept. Every task goes through the kit's Meshy
 * client (its ledger and the wave's cap). → generateProp's result, its credits counting the concept
 */
async function makeFromAnchor({ words, size, out, style, onProgress, generateProp }) {
  const meshy = await import('../tools/lib/char-meshy.mjs');
  const { conceptPrompt } = await import('./recipe.mjs');
  const { readFileSync } = await import('node:fs');
  const id = path.basename(out, '.glb');
  // a loose thing (a pickup, a carried item) is drawn with no base or plinth under it, as the wave draws a held one
  const prompt = conceptPrompt({ kind: 'prop', words, size, held: !!style.loose }, style.target ?? null);
  const body = { ai_model: 'nano-banana-2', prompt, reference_image_urls: [meshy.dataUri(readFileSync(style.anchor), 'image/png')], aspect_ratio: '1:1', remove_background: true };
  const task = await meshy.create('image-to-image', '/v1/image-to-image', body, `${id} prop-concept (anchor ${path.basename(style.anchor)})`);
  const t = await meshy.wait('/v1/image-to-image', task, `${id} prop-concept`, { onProgress });
  const concept = path.join(path.dirname(out), `${id}-concept.png`);
  await meshy.download(t.image_urls[0], concept);
  const g = await generateProp({ image: concept, concept: false, out, id, describe: words, size, onProgress });
  return { ...g, credits: (g.credits ?? 0) + (t.consumed_credits ?? 0), tasks: { concept: { id: task, endpoint: 'image-to-image', credits: t.consumed_credits ?? null, prompt }, ...(g.tasks ?? {}) }, concept };
}

/** What a slot is made as: a body (a character.body.* model) or a prop (any other model slot). null: no maker here. */
export function kindOfSlot(slot) {
  if (slot.type !== 'model') return null;
  return /^character\.body\./.test(slot.id) ? 'body' : 'prop';
}

/** The game's private pack id: generated art for this game, by its folder name. */
export const gamePack = game => `game-${slug(path.basename(path.resolve(game)))}`;

export async function generateSlot({ game, slot: slotId, words, maker = 'meshy', yes = false, size = null, style = null, makers = MAKERS, config = null, renderer = null, log = () => {} } = {}) {
  if (!game || !slotId) throw new Error('generate: give a game and a slot');
  if (!words || typeof words !== 'string') throw new Error('generate: say what to make (words)');
  const m = makers[maker];
  if (!m) throw new Error(`generate: no maker "${maker}" (${Object.keys(makers).join(', ')})`);
  const slot = await findSlot(game, slotId);
  const kind = kindOfSlot(slot);
  if (!kind || !m.kinds.includes(kind)) return { ok: false, paid: false, problems: [`${slotId} holds a ${slot.type}; ${m.name} makes ${m.kinds.join(' and ')} models`], next: 'Use another maker for this slot (gamesfun art makers), or a library asset (gamesfun art find).' };
  const sz = size ?? (Array.isArray(slot.constraints?.size) ? Math.max(...slot.constraints.size) : 1);
  const archetype = kind === 'body' ? slot.constraints?.archetype ?? 'humanoid' : null;
  if (!yes) {
    const plan = await m.plan({ kind, words, size: sz, archetype, style });
    return { ok: false, paid: false, plan, next: `Not run. ${m.name} makes this on the person's own key and costs about ${plan.estimate ?? '?'} credits. Run it again with yes once that is agreed.` };
  }
  config ??= loadConfig();
  // the preview and the measures are drawn on the graphics card (headless Chrome), opened only when needed
  const ownRenderer = renderer ? null : lazyRenderer();
  renderer ??= ownRenderer;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'art-generate-'));
  try {
    const id = slug(`${slotId.split('.').pop()}-${words}`).slice(0, 40);
    const out = path.join(tmp, `${id}.glb`);
    log(`${m.name}: making ${kind} "${words}" for ${slotId}`);
    const made = await m.make({ kind, words, size: sz, out, log, archetype, style });
    if (!made?.file || !existsSync(made.file)) return { ok: false, paid: true, problems: [`${m.name} made no file`], next: 'Nothing was put in the slot. Try again, or another maker.' };
    // the game's private pack: generated, private, the maker's licence (a paid maker's output: policy class paid-maker)
    const pack = gamePack(game);
    const { ingest } = await import('./ingest.mjs');
    const r = await ingest(made.file, {
      config, pack, renderer, category: kind, id, describe: words.slice(0, 200), tags: ['generated', maker, kind, ...(archetype && archetype !== 'humanoid' ? [archetype] : [])],
      ...(archetype && archetype !== 'humanoid' ? { autorig: archetype } : {}),
      from: `${m.name}${made.tasks ? ` tasks ${Object.values(made.tasks).map(t => t.id).filter(Boolean).join(', ')}` : ''}`,
      licence: m.licence, licenceText: m.licenceText,
      newPack: { title: `${path.basename(path.resolve(game))}: generated art`, describe: `Art generated for the game ${path.basename(path.resolve(game))}, by slot.`, owner: 'generated', visibility: 'private', source: { kind: 'maker', maker } },
    });
    const ref = r.added[0] ?? r.duplicates[0]?.of ?? null;
    if (!ref) return { ok: false, paid: true, credits: made.credits ?? null, problems: [`ingest took nothing in: ${[...r.quarantined, ...r.skipped].map(x => x.why).join('; ') || 'no reason given'}`], next: 'Nothing was put in the slot.' };
    const failed = r.failed.find(f => f.ref === ref);
    if (failed) return { ok: false, paid: true, ref, credits: made.credits ?? null, problems: failed.problems, next: `The made model is kept in the private pack ${pack} but failed its validator, so the slot keeps its file. Fix the words and generate again.` };
    const asset = loadLibrary(config).find(p => p.pack.id === pack)?.assets.find(a => `${a.pack}/${a.id}` === ref);
    const file = path.join(tmp, 'fill.glb');
    await exportAsset(config, asset, file);
    const w = await setFile(game, slotId, { from: file, name: `${asset.id}.glb` });
    return { ok: true, paid: true, ref, slot: slotId, file: w.file, credits: made.credits ?? null, validated: asset.validated, licence: m.licence, next: `In slot ${slotId} (the private pack ${pack}). Add a line to the game's ATTRIBUTION.md: made with ${m.name}; ${m.licence.spdx}.` };
  } finally { await ownRenderer?.close(); await rm(tmp, { recursive: true, force: true }); }
}
