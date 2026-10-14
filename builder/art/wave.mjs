#!/usr/bin/env node
// wave: make a case's art with Meshy, concept art first, from one style anchor per look (library/COVERAGE.md, "The
// Meshy plan").
//
//   node builder/art/wave.mjs plan <case.json>                         the anchors, items, prompts and credits; no call
//   node builder/art/wave.mjs run <case.json> --out <dir> --yes [--anchors] [--only id,id] [--redo id,id] [--rig-probe <id>] [--jobs 3]
//   node builder/art/wave.mjs ingest <case.json> --out <dir> [--only id,id] [--replace]
//   node builder/art/wave.mjs judge <case.json> --out <dir> [--json]
//
// A case (library/coverage/cases/<id>.json) holds a style target and a wave: `wave.looks` names one anchor per look
// ({<look id>: {keep: [what the look must keep, in our own words], subjects: [what the anchor sheet shows]}}), and each
// item names the look it is drawn from (`look`, else the first). A look's target is the case target's look of that id
// (builder/look/looks.mjs targetOfLook: a level of a game with several), else the whole target.
//
// run spends credits on the person's own Meshy key (MESHY_API_KEY in the environment). Every task goes through the
// kit's Meshy client (builder/tools/lib/char-meshy.mjs): its ledger (GF_MESHY_LEDGER, required here) and the wave's cap
// (the case's wave.cap, checked before every task; GF_MESHY_CAP may only lower it). It resumes: an item whose file is
// already in --out is not made again; --redo sets an item's earlier files aside (<id>.rejected-<n>.*) and makes it again.
// The steps (builder/art/recipe.mjs):
//   1. the anchors: text-to-image from each look's target and words (never a reference image), once a look
//   2. per item, a concept: image-to-image with its look's anchor as the only reference
//   3. a body or prop: image-to-3D from the concept (meshy-prop.mjs: metres, base at 0, lean GLB); a texture: the
//      concept made tileable here (its halves swapped and the seams cross-faded)
//   4. --rig-probe <id>: Meshy's rigging tried once on that body, to record what it does with a non-humanoid
// ingest takes the anchors, the concepts and the made files into the case's private pack (wave.pack; the paid maker's
// licence), a creature rigged on its archetype's standard (autorig), a prop with its collider. judge holds every piece
// to its look's anchor (builder/art/anchor.mjs) and writes <out>/judged.json: the outliers are the ones to --redo.
// The record (<out>/wave-record.json) holds every prompt, task, credit and file.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anchorPrompt, conceptPrompt, recipe, waveCost } from './recipe.mjs';
import { targetOfLook } from '../look/looks.mjs';

export function loadCase(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (!c.wave?.items?.length) throw new Error(`${file}: no wave.items`);
  if (!c.wave.looks || !Object.keys(c.wave.looks).length) throw new Error(`${file}: no wave.looks (one anchor a look: {<id>: {keep, subjects}})`);
  for (const it of c.wave.items) if (it.look && !c.wave.looks[it.look]) throw new Error(`${file}: item ${it.id} names look "${it.look}", which wave.looks does not have`);
  return c;
}

/** The look ids of a case, the first being the default for an item that names none. */
export const looksOf = c => Object.keys(c.wave.looks);
export const lookOfItem = (c, it) => it.look ?? looksOf(c)[0];
/** A look's own target: the case target's look of that id (a level), else the whole target. */
export function lookTarget(c, look) {
  const t = c.target ?? null;
  return t?.looks?.some(L => L.id === look) ? targetOfLook(t, look) : t;
}
export const anchorFileOf = look => `anchor-${look}.png`;

export function planWave(c) {
  const anchors = Object.fromEntries(looksOf(c).map(id => [id, anchorPrompt(lookTarget(c, id), { subjects: c.wave.looks[id].subjects ?? [], keep: c.wave.looks[id].keep ?? null })]));
  const items = c.wave.items.map(it => ({ ...recipe(it, lookTarget(c, lookOfItem(c, it))), look: lookOfItem(c, it), words: it.words, kind: it.kind }));
  return { id: c.wave.id, cap: c.wave.cap, anchors, items, cost: waveCost(c.wave.items, { anchors: looksOf(c).length }) };
}

/** A square picture made to repeat: swap its halves (the old edges meet in the middle) and cross-fade the seam. */
export async function makeTileable(bytes, { sharp, size = 1024 }) {
  const { data, info } = await sharp(bytes).resize(size, size, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height, C = info.channels, out = Buffer.alloc(data.length);
  const band = Math.round(W * 0.18);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // the shifted copy's edges are the original's middle, so it repeats; keep the original away from the edges
    const sx = (x + W / 2) % W, sy = (y + H / 2) % H;
    const dx = Math.min(x, W - 1 - x), dy = Math.min(y, H - 1 - y);
    const w = Math.min(1, Math.min(dx, dy) / band);          // 0 at the edge (the shifted copy), 1 inside (the original)
    for (let k = 0; k < C; k++) out[(y * W + x) * C + k] = Math.round(data[(y * W + x) * C + k] * w + data[(sy * W + sx) * C + k] * (1 - w));
  }
  return sharp(out, { raw: { width: W, height: H, channels: C } }).png().toBuffer();
}

async function pool(items, jobs, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i], i);
  }));
  return results;
}

const finalOf = (out, it) => path.join(out, `${it.id}.${it.kind === 'texture' || it.kind === 'picture' ? 'png' : 'glb'}`);

/** Set an item's earlier files aside (<id>.rejected-<n>.<ext>, the concept beside it) so run makes it again. → n */
export function setAside(out, it, rec) {
  const files = [finalOf(out, it), path.join(out, 'concepts', `${it.id}.png`)].filter(f => existsSync(f));
  let n = 1;
  while (existsSync(path.join(out, `${it.id}.rejected-${n}.json`))) n++;
  for (const f of files) renameSync(f, f.replace(/\.(png|glb)$/, `.rejected-${n}.$1`));
  const r = rec.items[it.id];
  if (r) { writeFileSync(path.join(out, `${it.id}.rejected-${n}.json`), JSON.stringify(r, null, 1) + '\n'); (rec.redone ??= {})[it.id] = [...(rec.redone[it.id] ?? []), { n, credits: r.credits, why: r.rejectedFor ?? null }]; delete rec.items[it.id]; }
  return n;
}

export async function runWave(c, { out, only = null, redo = [], rigProbe = null, jobs = 3, anchorsOnly = false, log = m => process.stderr.write(`${m}\n`) }) {
  if (!process.env.MESHY_API_KEY) throw new Error('MESHY_API_KEY is not set: the wave runs on the person\'s own key');
  if (!process.env.GF_MESHY_LEDGER) throw new Error('GF_MESHY_LEDGER is not set: every paid task must be counted somewhere');
  // the wave's own budget, before the Meshy client reads it
  process.env.GF_MESHY_WAVE = c.wave.id;
  const cap = Math.min(c.wave.cap, Number(process.env.GF_MESHY_CAP) || Infinity);
  process.env.GF_MESHY_CAP = String(cap);
  const meshy = await import('../tools/lib/char-meshy.mjs');
  const { generateProp } = await import('../tools/meshy-prop.mjs');
  const { sharp } = await import('./deps.mjs');
  mkdirSync(out, { recursive: true });
  const recFile = path.join(out, 'wave-record.json');
  const rec = existsSync(recFile) ? JSON.parse(readFileSync(recFile, 'utf8')) : { wave: c.wave.id, case: c.id, cap, started: new Date().toISOString(), anchors: {}, items: {} };
  const save = () => writeFileSync(recFile, JSON.stringify(rec, null, 1) + '\n');
  rec.balance ??= { before: await meshy.balance() };
  for (const id of redo) { const it = c.wave.items.find(x => x.id === id); if (it) log(`${id}: set aside as rejected-${setAside(out, it, rec)}`); }
  save();

  // --only picks the items; --redo alone makes only the redone ones again
  const items = c.wave.items.filter(it => (only ? only.includes(it.id) : redo.length ? redo.includes(it.id) : true));
  // 1. the anchors (only the looks this run's items need; every look with --anchors, to see them before the items)
  const anchors = {};
  for (const look of anchorsOnly ? looksOf(c) : [...new Set(items.map(it => lookOfItem(c, it)))]) {
    const file = path.join(out, anchorFileOf(look));
    if (!existsSync(file)) {
      const L = c.wave.looks[look];
      const prompt = anchorPrompt(lookTarget(c, look), { subjects: L.subjects ?? [], keep: L.keep ?? null });
      const id = await meshy.create('text-to-image', '/v1/text-to-image', { ai_model: 'nano-banana-2', prompt, aspect_ratio: '16:9' }, `${c.wave.id}:anchor-${look}`);
      const t = await meshy.wait('/v1/text-to-image', id, `${c.wave.id}:anchor-${look}`, { onProgress: () => {} });
      await meshy.download(t.image_urls[0], file);
      rec.anchors[look] = { prompt, task: id, credits: t.consumed_credits ?? null, file: path.basename(file) };
      save();
      log(`anchor ${look}: ${file}`);
    }
    anchors[look] = meshy.dataUri(readFileSync(file), 'image/png');
  }

  await pool(anchorsOnly ? [] : items, jobs, async it => {
    const look = lookOfItem(c, it), target = lookTarget(c, look);
    const r = rec.items[it.id] ??= { kind: it.kind, look, archetype: it.archetype ?? null, words: it.words, tasks: {}, credits: 0 };
    const final = finalOf(out, it);
    try {
      if (existsSync(final)) { log(`${it.id}: already made`); return; }
      // 2. the concept, in its look's anchor's style
      const conceptFile = path.join(out, 'concepts', `${it.id}.png`);
      if (!existsSync(conceptFile)) {
        const prompt = conceptPrompt(it, target);
        const body = { ai_model: 'nano-banana-2', prompt, reference_image_urls: [anchors[look]], aspect_ratio: it.kind === 'body' ? '3:4' : '1:1', ...(it.kind === 'texture' ? {} : { remove_background: true }) };
        const id = await meshy.create('image-to-image', '/v1/image-to-image', body, `${it.id}:concept`);
        const t = await meshy.wait('/v1/image-to-image', id, `${it.id}:concept`, { onProgress: () => {} });
        await meshy.download(t.image_urls[0], conceptFile);
        r.tasks.concept = { id, credits: t.consumed_credits ?? null, prompt };
        r.credits += t.consumed_credits ?? 0; save();
        log(`${it.id}: concept`);
      }
      // 3. the model, or the tile
      if (it.kind === 'texture') {
        writeFileSync(final, await makeTileable(readFileSync(conceptFile), { sharp }));
      } else if (it.kind === 'picture') {
        writeFileSync(final, readFileSync(conceptFile));
      } else {
        const g = await generateProp({ image: conceptFile, concept: false, out: final, id: it.id, describe: it.words, size: it.size ?? 1, polycount: it.polycount ?? 6000, onProgress: () => {} });
        r.tasks.to3d = g.tasks.to3d; r.credits += g.credits ?? 0; r.report = g.report; save();
        if (rigProbe === it.id) {
          try {
            const id = await meshy.create('rigging', '/v1/rigging', { input_task_id: g.tasks.to3d.id, height_meters: it.size ?? 1 }, `${it.id}:rig-probe`);
            const t = await meshy.wait('/v1/rigging', id, `${it.id}:rig-probe`, { onProgress: () => {} });
            const url = t.result?.rigged_character_glb_url;
            if (url) await meshy.download(url, path.join(out, `${it.id}.rig-probe.glb`));
            r.rigProbe = { id, status: t.status, credits: t.consumed_credits ?? null, file: url ? `${it.id}.rig-probe.glb` : null };
            r.credits += t.consumed_credits ?? 0;
          } catch (e) { r.rigProbe = { status: 'FAILED', error: String(e.message).slice(0, 400) }; }
          save();
        }
      }
      r.file = path.basename(final); save();
      log(`${it.id}: made (${r.credits} credits)`);
    } catch (e) {
      r.error = String(e.message).slice(0, 400); save();
      log(`${it.id}: FAILED ${r.error}`);
    }
  });
  rec.spent = meshy.spent(c.wave.id);
  rec.balance.after = await meshy.balance();
  rec.finished = new Date().toISOString();
  save();
  return rec;
}

// ---------------------------------------------------------------- ingest: the wave into its private pack
/** The ingest options of one made file (an anchor, a concept, an item). */
export function ingestPlan(c, out) {
  const w = c.wave, plan = [];
  const tags = (...xs) => [...new Set(xs.flat().filter(Boolean).flatMap(x => String(x).toLowerCase().split(/[^a-z0-9]+/)).filter(x => x.length > 1))];
  for (const look of looksOf(c)) {
    const file = path.join(out, anchorFileOf(look));
    plan.push({ file, opts: { id: `style-anchor-${look}`, category: 'picture', describe: `the style anchor of the look "${look}": the sheet every piece of the look is drawn from`, tags: tags('anchor', 'style', look, w.tags ?? []), from: `Meshy text-to-image from the look's words (wave ${w.id})` } });
  }
  for (const it of w.items) {
    const look = lookOfItem(c, it), r = recipe(it), at = finalOf(out, it), concept = path.join(out, 'concepts', `${it.id}.png`);
    if (it.kind === 'body' || it.kind === 'prop') plan.push({ file: concept, opts: { id: `${it.id}-concept`, category: 'picture', describe: `concept: ${it.words}`, tags: tags('concept', it.id, w.tags ?? []), from: `Meshy image-to-image from the anchor of "${look}" (wave ${w.id})` } });
    const arch = it.kind === 'body' ? it.archetype ?? 'humanoid' : null;
    plan.push({ item: it.id, file: at, opts: {
      // tags say what the piece is (its id's words), never its look's name: a "castle" look must not make its palm a castle
      id: it.id, category: r.ingest.category, describe: it.words, tags: tags(it.id, it.tags ?? [], w.tags ?? [], it.kind === 'body' ? ['creature', arch] : []),
      from: `${it.kind === 'body' || it.kind === 'prop' ? 'Meshy image-to-3D from its concept' : 'Meshy image-to-image, made tileable'} (wave ${w.id}, look "${look}")`,
      ...(arch && arch !== 'humanoid' ? { autorig: arch, height: it.size ?? null } : {}),
      ...(r.ingest.collider ? { collider: r.ingest.collider } : {}),
    } });
  }
  return plan;
}

export async function ingestWave(c, { out, only = null, replace = false, log = m => process.stderr.write(`${m}\n`) }) {
  const { loadConfig } = await import('./config.mjs');
  const { lazyRenderer } = await import('./render.mjs');
  const { ingest } = await import('./ingest.mjs');
  const config = loadConfig(), renderer = lazyRenderer();
  const P = c.wave.pack;
  const licence = { spdx: 'LicenseRef-Meshy-Paid', author: 'Meshy AI, generated on the creator\'s paid account', url: 'https://www.meshy.ai' };
  const newPack = { title: c.wave.packTitle ?? P, describe: c.wave.packDescribe, owner: 'generated', visibility: 'private', source: { kind: 'maker', maker: 'meshy', retrieved: new Date().toISOString().slice(0, 10) } };
  const results = [];
  try {
    for (const step of ingestPlan(c, out)) {
      const id = step.opts.id;
      if (only && !only.some(o => step.opts.id === o || step.opts.id === `${o}-concept` || step.opts.id === `style-anchor-${o}`)) continue;
      if (!existsSync(step.file)) { results.push({ id, skipped: 'not made' }); continue; }
      const r = await ingest(step.file, { config, renderer, pack: P, licence, newPack, replace, ...step.opts });
      results.push({ id: step.opts.id, added: r.added, duplicates: r.duplicates, failed: r.failed, schemaProblems: r.schemaProblems });
      log(`${step.opts.id}: ${r.added.length ? 'in' : r.duplicates.length ? `already in (${r.duplicates[0].of})` : 'NOT taken in'}${r.failed.length ? `; failed ${r.failed.map(f => f.problems.slice(0, 2).join('; ')).join(' | ')}` : ''}${r.schemaProblems.length ? `; schema: ${r.schemaProblems.slice(0, 2).join('; ')}` : ''}`);
    }
  } finally { await renderer?.close(); }
  return results;
}

// ---------------------------------------------------------------- judge: every piece against its look's anchor
export async function judgeWave(c, { out }) {
  const { loadConfig } = await import('./config.mjs');
  const { loadLibrary } = await import('./library.mjs');
  const { sharp } = await import('./deps.mjs');
  const { anchorSignature, anchorTarget, judgePieces } = await import('./anchor.mjs');
  const lib = loadLibrary(loadConfig());
  const pack = lib.find(p => p.pack.id === c.wave.pack);
  if (!pack) throw new Error(`no pack ${c.wave.pack} on this machine: run ingest first`);
  const byId = new Map(pack.assets.map(a => [a.id, a]));
  const anchors = {};
  for (const look of looksOf(c)) {
    const file = path.join(out, anchorFileOf(look));
    if (!existsSync(file)) continue;
    const { data, info } = await sharp(readFileSync(file)).ensureAlpha().resize(512, null).raw().toBuffer({ resolveWithObject: true });
    const sig = anchorSignature({ width: info.width, height: info.height, data });
    anchors[look] = { sig, target: anchorTarget(sig, lookTarget(c, look)) };
  }
  const pieces = c.wave.items.filter(it => byId.has(it.id) && anchors[lookOfItem(c, it)])
    .map(it => ({ id: it.id, look: lookOfItem(c, it), asset: byId.get(it.id), anchor: anchors[lookOfItem(c, it)].target, target: lookTarget(c, lookOfItem(c, it)) }));
  const rows = judgePieces(pieces);
  const missing = c.wave.items.filter(it => !byId.has(it.id)).map(it => it.id);
  const verdict = { wave: c.wave.id, judged: new Date().toISOString(), anchors: Object.fromEntries(Object.entries(anchors).map(([k, v]) => [k, { colors: v.sig.colors, saturation: v.sig.palette.saturation, lightness: v.sig.palette.lightness, subjectShare: v.sig.subjectShare }])), pieces: rows, missing };
  writeFileSync(path.join(out, 'judged.json'), JSON.stringify(verdict, null, 1) + '\n');
  return verdict;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, file, ...rest] = process.argv.slice(2);
  const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const list = k => opt(k)?.split(',').filter(Boolean) ?? null;
  try {
    if (!file || !['plan', 'run', 'ingest', 'judge'].includes(cmd)) throw new Error('usage: wave.mjs plan|run|ingest|judge <case.json> [--out dir --yes --anchors --only a,b --redo a,b --rig-probe id --jobs n --replace --json]');
    const c = loadCase(file);
    const out = opt('--out') ?? path.join(os.homedir(), '.xgames', 'waves', c.wave.id);
    if (cmd === 'plan' || (cmd === 'run' && !rest.includes('--yes'))) {
      const p = planWave(c);
      console.log(JSON.stringify(p, null, 1));
      if (cmd === 'run') console.error(`Not run: about ${p.cost.credits} credits (cap ${c.wave.cap}). Add --yes once that is agreed.`);
    } else if (cmd === 'run') {
      const rec = await runWave(c, { out, only: list('--only'), redo: list('--redo') ?? [], rigProbe: opt('--rig-probe') ?? null, jobs: Number(opt('--jobs') ?? 3), anchorsOnly: rest.includes('--anchors') });
      console.log(JSON.stringify({ out, spent: rec.spent, balance: rec.balance, failed: Object.entries(rec.items).filter(([, r]) => r.error).map(([id, r]) => `${id}: ${r.error}`) }, null, 1));
    } else if (cmd === 'ingest') {
      const r = await ingestWave(c, { out, only: list('--only'), replace: rest.includes('--replace') });
      if (rest.includes('--json')) console.log(JSON.stringify(r, null, 1));
    } else {
      const v = await judgeWave(c, { out });
      if (rest.includes('--json')) console.log(JSON.stringify(v, null, 1));
      else for (const p of v.pieces) console.log(`${p.ok ? 'ok     ' : 'REDO   '} ${p.look.padEnd(22)} ${p.id.padEnd(24)} anchor ${p.fit} (colour ${p.colour}, shape ${p.shape})  level ${p.levelFit}${p.why.length ? `  — ${p.why.join('; ')}` : ''}`);
      if (v.missing.length) console.log(`not in the pack: ${v.missing.join(', ')}`);
    }
  } catch (e) { console.error(`wave: ${e.message}`); process.exit(1); }
}
