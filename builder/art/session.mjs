// The art flow, in two calls. `artRequest` decides who makes a piece of art (builder/art/providers.mjs) and writes a
// TICKET: what is wanted, at what size, in what style. The asset library comes first after the person's own file: when
// it has something that fits the slot, the ticket names it and `artTake(ticket, { library })` puts it in. `artTake` takes the answer (SVG, a pixel grid, or a file from
// any maker), turns it into a PNG, checks it against the ticket (builder/art/checks.mjs) and only then writes it through
// the slot. When the maker is the session itself, the request is a piece of text the person's own running session
// reads and answers: OUR CODE MAKES NO MODEL CALL, here or anywhere.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { STATE } from '../lib/paths.mjs';
import { findSlot, setFile } from '../lib/slots.mjs';
import { checkArt, conceptCheck, modelCheck } from './checks.mjs';
import { gridProblems, rasteriseGrid, GRID_FORMAT } from './grid.mjs';
import { decodePng, encodePng, isPng, onBackground, scaleDown, scaleUp, tiled } from './png.mjs';
import { chooseMaker, loadProviders } from './providers.mjs';
import { sizeFor, STANDARD } from './standard.mjs';
import { rasteriseSvg, svgProblems } from './svg.mjs';
import { loadPolicy } from './policy.mjs';
import { loadKind, needFromSlot, resolveNeed } from './resolve.mjs';
import { artLibrary, assetFile, findAsset, licenceOf } from './views.mjs';

export const ART_STATE = path.join(STATE, 'art');
const readJson = async (file, fallback = null) => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; } };
const HEX = /^#[0-9a-f]{6}$/i;

/** What kind of art a slot holds, from its id and type (overridable by the caller). */
export function kindOfSlot(slot) {
  if (slot.type === 'model') return 'model';
  if (/^character\.body\./.test(slot.id)) return 'sheet';
  if (/(^|\.)(tiles?|ground|floor|wall)(\.|$)/.test(slot.id)) return 'tile';
  return 'picture';
}

/** A game's style anchor: one style, one palette and one line of direction for every picture in the game. */
export async function styleAnchor(gameDir, { style = null, palette = null, direction = null, stateDir = ART_STATE } = {}) {
  const file = path.join(stateDir, 'games', createHash('sha256').update(path.resolve(gameDir)).digest('hex').slice(0, 12), 'style.json');
  const have = await readJson(file);
  if (have && !style && !palette && !direction) return { ...have, file, fresh: false };
  let guessed = null;
  if (!have && !style) {
    const spec = await readJson(path.join(gameDir, 'spec.json'), {});
    guessed = /pixel/i.test(`${spec.look?.preset ?? ''} ${spec.look?.style ?? ''}`) ? 'pixel' : 'drawn';
  }
  const next = { game: path.basename(gameDir), style: style ?? have?.style ?? guessed, palette: palette ?? have?.palette ?? null, direction: direction ?? have?.direction ?? null, set: new Date().toISOString() };
  if (!STANDARD.styles[next.style]) throw new Error(`style "${next.style}" is not one of ${Object.keys(STANDARD.styles).join(', ')}`);
  if (next.palette && (!Array.isArray(next.palette) || next.palette.some(c => !HEX.test(c)))) throw new Error('palette must be a list of colours (#rrggbb)');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(next, null, 2) + '\n');
  return { ...next, file, fresh: true };
}

/** The words a session reads. Everything a maker needs and nothing about how our tools work inside. */
export function requestText(t, standard = STANDARD) {
  const st = standard.styles[t.style], [w, h] = t.size, L = [];
  const what = { sheet: 'a character body sheet', tile: 'a ground tile', picture: 'a picture of one thing' }[t.kind];
  L.push(`Draw ${what}: ${t.subject}`);
  L.push(`Style: ${st.label}. ${st.note}`);
  if (t.direction) L.push(`This game's art direction (the same for every picture in it): ${t.direction}`);
  if (t.palette?.length) L.push(`Palette (use these colours${t.style === 'pixel' ? ' only' : ' and shades between them'}): ${t.palette.join(' ')}`);
  if (t.kind === 'sheet') {
    const S = standard.sheet, c = t.cell;
    L.push(`Layout: ${S.frames.length} square cells of ${c}x${c} in one row, left to right: ${S.frames.map(f => `${f} (${S.meaning[f]})`).join('; ')}. The whole picture is ${w}x${h}.`);
    L.push(`View: ${S.planes[t.plane]}`);
    L.push(t.plane === 'side'
      ? `Size and place: the standing figure is about ${Math.floor(c * S.fill)} of ${c} pixels tall (never over ${Math.floor(c * S.overfill)}), centred left to right in its cell, and its feet are in the bottom ${Math.max(1, Math.floor(c * S.feet))} rows of the cell in every frame but "air" (which may rise, staying in the bottom ${Math.floor(c * S.airFeet)} rows).${st.margin ? ` Keep ${st.margin} pixels clear at the left, right and top of every cell.` : ''}`
      : `Size and place: the figure sits on the centre of its cell in every frame (within ${Math.floor(c * S.centre)} pixels).${st.margin ? ` Keep ${st.margin} pixels clear at the left, right and top of every cell.` : ''}`);
    L.push('It is the SAME character in every cell: same proportions, same colours, same outline. "walk1" and "walk2" differ (the legs swap); "air" differs from "idle".');
    L.push(`Colour: ${S.tint}`);
    L.push('Nothing behind the character: the ground is see-through.');
  } else {
    L.push(`Size: ${w}x${h} pixels. ${standard.kinds[t.kind].note}`);
  }
  L.push('');
  if (t.answer === 'grid') {
    L.push(`Answer with a pixel grid, as JSON (format "${GRID_FORMAT}"): { "format": "${GRID_FORMAT}", "size": [${t.kind === 'sheet' ? `${t.cell}, ${t.cell}` : `${w}, ${h}`}], "palette": { ".": null, "a": "#rrggbb", … }, "frames": { ${t.kind === 'sheet' ? standard.sheet.frames.map(f => `"${f}": [rows]`).join(', ') : '"picture": [rows]'} } }`);
    L.push(`One character is one pixel; "size" is one ${t.kind === 'sheet' ? 'cell' : 'picture'}; every frame has ${t.kind === 'sheet' ? t.cell : h} rows of exactly ${t.kind === 'sheet' ? t.cell : w} characters; null in the palette is see-through. Use at most ${st.colours} colours.`);
  } else if (t.answer === 'svg') {
    L.push(`Answer with one SVG document: <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">…</svg> (one unit is one pixel${t.kind === 'sheet' ? `; cell k starts at x = k x ${t.cell}` : ''}).`);
    L.push('Shapes only: path, rect, circle, ellipse, polygon, line, g, defs, use, gradients, clipPath. No <text>, no <image>, no script, no links to anything outside the SVG, no filters that need a font or a file. Draw shared parts once in <defs> and place them with <use> so every frame is the same character.');
    if (t.kind === 'tile') L.push('No background outside the tile and no see-through pixel inside it: start with a <rect> that fills the whole viewBox.');
  } else {
    L.push(`Make it with ${t.makerName}, save it as a PNG${t.kind === 'model' ? ' or GLB' : ''} file and hand back the file's path. ${t.kind === 'model' ? '' : `Ask for a transparent background${t.kind === 'tile' ? ' OFF (a tile is opaque)' : ''} and a square picture; it is shrunk to ${w}x${h} here.`}`);
  }
  L.push('Then hand it back with the ticket below. It is drawn, checked and shown to you: LOOK at the picture it returns before you call it done, and redraw if it does not read as what was asked.');
  return L.join('\n');
}

/** What the asset library has for a game's slot and these words: a resolver pick ({ ref, describe, licence, alternates }) or null. */
export async function libraryPick(game, slotRow, subject) {
  const need = needFromSlot(slotRow);
  if (!need) return null;
  const L = artLibrary(), spec = await readJson(path.join(game, 'spec.json'), {});
  const r = resolveNeed(L.lib, { ...need, words: `${subject} ${need.words}`, head: subject }, { kindPreset: spec.kind ? loadKind(spec.kind, L.config.kindsDir) : null, policy: loadPolicy(L.config.policyFile), devices: ['phone', 'desktop'] });
  return r.status === 'found' ? { ref: r.pick.ref, describe: r.pick.describe, licence: r.pick.licence, credit: r.pick.credit, alternates: r.alternates.slice(0, 4).map(a => ({ ref: a.ref, describe: a.describe })), findings: r.findings } : null;
}

/**
 * Start a piece of art. Either a game's slot ({ game, slot }) or a bare file ({ out, kind }). `fresh`: the person wants
 * a new one made, so the library is passed over.
 * → { ticket, maker, why, passedOver, answer, request, size, next }
 */
export async function artRequest({ game = null, slot = null, out = null, kind = null, style = null, plane = 'side', subject, palette = null, direction = null, provided = null, fresh = false, role = null, env = process.env, agent = undefined, client = null, stateDir = ART_STATE, data = null } = {}) {
  if (!subject || typeof subject !== 'string') throw new Error('say what to draw: subject (a sentence)');
  if (!game && !out) throw new Error('give a game and a slot, or an out path for a bare file');
  let slotRow = null, size = null, current = null;
  if (game) {
    if (!slot) throw new Error('which slot? (npx gamesfun slots list --all)');
    slotRow = await findSlot(game, slot);
    if (!slotRow.source?.file || slotRow.source.pointer) throw new Error(`${slot} is a value slot: set it with gamesfun slots set, not with art`);
    kind ??= kindOfSlot(slotRow);
    const ext = path.posix.extname(slotRow.source.file).toLowerCase();
    if (kind !== 'model' && ext !== '.png') throw new Error(`${slot} holds a ${ext} file; art made here is PNG. Give the slot a PNG first, or swap it by hand with gamesfun slots set --file`);
    if (kind === 'model' && ext !== '.glb') throw new Error(`${slot} holds a ${ext} file; a model is a GLB`);
    const file = path.join(game, ...slotRow.source.file.split('/'));
    if (kind !== 'model' && existsSync(file)) { try { const p = decodePng(await readFile(file)); current = [p.width, p.height]; } catch { /* a stand-in we cannot read: use the standard's size */ } }
  }
  if (!kind) throw new Error('kind: picture, sheet, tile or model');
  const anchor = kind === 'model' ? { style: null, palette: null, direction } : game ? await styleAnchor(game, { style, palette, direction, stateDir }) : { style: style ?? 'drawn', palette, direction };
  if (kind !== 'model') {
    const std = sizeFor(kind, anchor.style);
    // the stand-in in the slot is already the size the game draws: keep it when it has the right shape
    size = current && (kind !== 'sheet' ? current[0] === current[1] : current[0] === current[1] * STANDARD.sheet.frames.length) ? current : std;
  }
  if (typeof agent === 'undefined' && client) agent = (await import('./providers.mjs')).detectAgent({ env, client });
  const library = fresh ? false : slotRow && !provided ? await libraryPick(game, slotRow, subject) : null;
  const choice = chooseMaker({ kind, style: anchor.style, provided, library, env, agent, data: data ?? loadProviders() });
  const m = choice.maker;
  const answer = m.reach.via === 'session' && m.answers.includes('svg') ? STANDARD.styles[anchor.style].answer : 'file';
  const id = `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString('hex')}`;
  const ticket = {
    schema: 'gamesfun-art-ticket/1', id, made: new Date().toISOString(), game: game ? path.resolve(game) : null, slot, out: out ? path.resolve(out) : null,
    kind, style: anchor.style, plane, subject, palette: anchor.palette, direction: anchor.direction, size, cell: kind === 'sheet' ? size[1] : null, role: role ?? (kind === 'model' ? (/^character\./.test(slot ?? '') ? 'body' : 'prop') : null),
    maker: m.id, makerName: choice.connection ? `your "${choice.connection}" connection` : m.name, connection: choice.connection ?? null, why: choice.why, answer, licence: m.licence.note, standard: STANDARD.id, state: 'asked',
    ...(choice.pick ? { pick: choice.pick } : {}),
  };
  await mkdir(path.join(stateDir, 'tickets'), { recursive: true });
  await writeFile(path.join(stateDir, 'tickets', `${id}.json`), JSON.stringify(ticket, null, 2) + '\n');
  const res = { ticket: id, maker: m.id, makerName: ticket.makerName, why: choice.why, passedOver: choice.passedOver, kind, style: anchor.style, size, answer };
  if (m.tier === 'library') return { ...res, pick: choice.pick, next: `The asset library has it: art take ${id} --library (or --library <pack>/<id> for one of the alternates). To have a new one made instead, ask again with fresh.` };
  if (m.tier === 'stand-in') return { ...res, next: kind === 'model' ? 'Nothing to make: use a library model (gamesfun catalog bodies props), give a file, or connect a 3D maker (docs/ART.md).' : 'Nothing to make: the stand-in stays. Give a file or connect a maker (docs/ART.md).' };
  if (m.tier === 'provided') return { ...res, next: `Hand the file over: art take ${id} --file <path>` };
  if (m.reach.via === 'env') return { ...res, estimate: m.estimate ?? null, cost: m.cost.note, next: `This maker is paid for with the person's own key (${m.reach.env.join(', ')}). Tell the person the cost and ask; when they say yes: art make ${id} --yes` };
  return { ...res, request: requestText(ticket), next: answer === 'file' ? `Hand the file back: art take ${id} --file <path>` : `Hand your ${answer === 'svg' ? 'SVG' : 'grid'} back: art take ${id} --${answer} <file>` };
}

export async function readTicket(id, stateDir = ART_STATE) {
  if (!/^[0-9a-f-]{10,40}$/.test(String(id))) throw new Error(`"${id}" is not a ticket id`);
  const t = await readJson(path.join(stateDir, 'tickets', `${id}.json`));
  if (!t) throw new Error(`no ticket ${id}: start with an art request`);
  return t;
}

/** A picture a person or a session can look at: on a dark ground, pixel art enlarged, a tile repeated 3x3. */
export function lookPicture(pic, t) {
  let p = t.kind === 'tile' ? tiled(pic, 3, 3) : pic;
  const k = Math.max(1, Math.floor(768 / Math.max(p.width, p.height)));
  if (k > 1) p = scaleUp(p, Math.min(k, 16));
  return onBackground(p);
}

/**
 * Take an answer for a ticket: { svg } or { grid } (text or object) or { file } (a PNG or GLB path).
 * Checks it, and when it passes writes it through the slot (or to the ticket's out path).
 * → { ok, problems, warnings, facts, look (a PNG to look at), written }
 */
export async function artTake(id, { svg = null, grid = null, file = null, library = null, write = true, stateDir = ART_STATE, launch = null } = {}) {
  const t = await readTicket(id, stateDir);
  const dir = path.join(stateDir, 'tickets', id);
  await mkdir(dir, { recursive: true });
  const fail = async (problems, extra = {}) => { await saveTicket(t, { state: 'refused', problems }, stateDir); return { ok: false, ticket: id, problems, warnings: [], written: null, next: 'Fix what the problems name and hand it back again with the same ticket.', ...extra }; };

  // the asset library's file: validated when it entered the library, put in as it is, with its own licence
  if (library) {
    const ref = typeof library === 'string' ? library : t.pick?.ref;
    const a = ref ? findAsset(ref) : null;
    if (!a) return fail([`no asset ${ref ?? '(the ticket names no library pick)'} in the asset library`]);
    const bytes = await readFile(await assetFile(a));
    const l = licenceOf(a);
    t.licence = `${l.spdx}${l.author ? `, ${l.author}` : ''}${l.credit ? ` (credit: ${l.credit})` : ''} (library:${ref})`;
    t.makerName = `the asset library (${ref})`;
    return keep(t, bytes, path.extname(a.file).slice(1), { ok: true, problems: [], warnings: [], facts: { ref } }, { write, stateDir, dir, source: null });
  }
  if (t.kind === 'model') {
    if (!file) return fail(['a model is handed back as a GLB file']);
    const bytes = await readFile(file);
    const r = modelCheck(bytes, { role: t.role ?? 'prop' });
    if (!r.ok) return fail(r.problems, { facts: r.facts });
    return keep(t, bytes, 'glb', r, { write, stateDir, dir, source: null });
  }

  let pic, source = null;
  if (grid != null) {
    let g = grid;
    if (typeof g === 'string') { try { g = JSON.parse(g); } catch (e) { return fail([`the grid is not JSON: ${e.message}`]); } }
    const frames = t.kind === 'sheet' ? STANDARD.sheet.frames : null;
    const bad = gridProblems(g, { frames, size: t.kind === 'sheet' ? [t.cell, t.cell] : t.size });
    if (bad.length) return fail(bad);
    pic = rasteriseGrid(g, { frames });
    source = { name: 'source.grid.json', text: JSON.stringify(g) };
  } else if (svg != null) {
    const bad = svgProblems(svg, { box: t.size });
    if (bad.length) return fail(bad);
    pic = await rasteriseSvg(svg, t.size[0], t.size[1], { launch });
    source = { name: 'source.svg', text: svg };
  } else if (file) {
    const bytes = await readFile(file);
    if (!isPng(bytes)) return fail([`${path.basename(file)} is not a PNG: convert it to PNG first`]);
    try { pic = decodePng(bytes); } catch (e) { return fail([`${path.basename(file)}: ${e.message}`]); }
    // a maker's picture is usually bigger than the slot: shrink it when it has the slot's shape (never pixel art)
    if (t.style === 'drawn' && pic.width > t.size[0] && pic.width * t.size[1] === pic.height * t.size[0]) pic = scaleDown(pic, t.size[0], t.size[1]);
  } else return fail([`hand back ${t.answer === 'file' ? 'a file' : t.answer === 'svg' ? 'an SVG' : 'a pixel grid'}`]);

  const r = checkArt(t.kind, pic, t.kind === 'sheet' ? { plane: t.plane, style: t.style, cell: t.cell } : { size: t.size, style: t.style });
  const look = path.join(dir, 'look.png');
  await writeFile(look, encodePng(lookPicture(pic, t)));
  if (!r.ok) return fail(r.problems, { warnings: r.warnings, facts: r.facts, look });
  return keep(t, encodePng(pic), 'png', r, { write, stateDir, dir, source, look });
}

async function saveTicket(t, patch, stateDir) {
  Object.assign(t, patch, { updated: new Date().toISOString() });
  await writeFile(path.join(stateDir, 'tickets', `${t.id}.json`), JSON.stringify(t, null, 2) + '\n');
}

async function keep(t, bytes, ext, r, { write, stateDir, dir, source, look = null }) {
  const made = path.join(dir, `made.${ext}`);
  await writeFile(made, bytes);
  if (source) await writeFile(path.join(dir, source.name), source.text);
  let written = null;
  if (write) {
    if (t.game) { const w = await setFile(t.game, t.slot, { bytes, name: `made.${ext}` }); written = { slot: t.slot, file: w.file, bytes: w.bytes }; }
    else { await mkdir(path.dirname(t.out), { recursive: true }); await writeFile(t.out, bytes); written = { file: t.out, bytes: bytes.length }; }
    await appendFile(path.join(stateDir, 'ledger.jsonl'), JSON.stringify({ at: new Date().toISOString(), ticket: t.id, game: t.game, slot: t.slot, out: t.out, kind: t.kind, style: t.style, maker: t.maker, connection: t.connection, licence: t.licence, sha256: createHash('sha256').update(bytes).digest('hex') }) + '\n');
  }
  await saveTicket(t, { state: write ? 'kept' : 'checked', problems: [] }, stateDir);
  return {
    ok: true, ticket: t.id, problems: [], warnings: r.warnings ?? [], facts: r.facts, made, look, written,
    next: `${look ? `LOOK at ${look} (the checks see size, place and emptiness, not whether it is good). ` : ''}${write ? `It is in ${written.slot ? `slot ${written.slot}` : written.file}. Add a line to the game's ATTRIBUTION.md: made by ${t.makerName}; ${t.licence}.` : 'Checked, not written (write was off).'}`,
  };
}

/**
 * Make a ticket's art with a key-based maker (an adapter). Paid: refuses without `yes`. Then the same checks as any
 * other art. A concept picture (`image`) for a 3D model is checked BEFORE anything is paid for.
 */
export async function artMake(id, { yes = false, image = null, env = process.env, fetch = globalThis.fetch, stateDir = ART_STATE, write = true, adapters = null, log = () => {} } = {}) {
  const t = await readTicket(id, stateDir);
  const row = loadProviders().providers.find(p => p.id === t.maker);
  if (!row?.adapter) throw new Error(`ticket ${id} is for "${t.makerName}", which is not a key-based maker: hand its answer back with art take`);
  if (image) {
    const c = conceptCheck(decodePng(await readFile(image)));
    if (!c.ok) return { ok: false, ticket: id, paid: false, problems: c.problems.map(p => `the concept picture: ${p}`), next: 'Nothing was paid for. Fix the concept picture first: a model made from it would be the wrong thing.' };
  }
  const adapter = adapters?.[row.adapter] ?? await import(new URL(`./adapters/${row.adapter}.mjs`, import.meta.url).href);
  const plan = adapter.plan(t, row, { image });
  if (!yes) return { ok: false, ticket: id, paid: false, plan, problems: [], next: `Not run. This calls ${row.name} with the person's own key and costs: ${row.estimate?.note ?? row.cost.note}. Ask the person; when they say yes, run it again with yes.` };
  const dir = path.join(stateDir, 'tickets', id);
  await mkdir(dir, { recursive: true });
  const made = await adapter.make(t, row, { env, fetch, dir, image, log });
  await appendFile(path.join(stateDir, 'spend.jsonl'), JSON.stringify({ at: new Date().toISOString(), ticket: id, maker: row.id, cost: made.cost ?? null }) + '\n');
  const r = await artTake(id, { file: made.file, write, stateDir });
  return { ...r, paid: true, cost: made.cost ?? null };
}
