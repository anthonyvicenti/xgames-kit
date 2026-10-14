// verify check 4, second half: nothing the game's own code draws is built in code (the creator's question 19, open
// builder wave 8, track V).
//
// "Everything visible is a slot" (check 4's rule) was held by one reading: every mesh on screen carries a slot id.
// The held-out-mechanic experiment (research/open-builder/findings/x1-held-out-mechanic.md) built one tag game nine
// times; four builds drew the marker over whoever is it as a cone made in rules.js, gave it a slot id (a colour's),
// and passed check 4 with 100% coverage. A cone made in code has no file: a creator can recolour it at best, never
// replace it, and six builds of one spec showed the it six different ways.
//
// What this reads: the game's own scripts, i.e. every .js file of the game folder that is not the kit's copy (gf/),
// a pinned library (vendor/), the audio kit (audio/) or evidence. In them, with comments taken out, any `new` of a
// geometry, a mesh, a sprite, points or a line (`new THREE.Mesh(…)`, `new T.ConeGeometry(…)`, `new Sprite(…)`);
// what is inside a quoted string is not code either.
// What a game draws comes from a slot's file (a prop the world places, ctx.assets.model) or from a kit part (a
// mechanic's own marker, kit/vfx, the HUD and nameplates): none of those needs the game to construct geometry.
//
// It is a reading of the source, not of the running scene: a mesh the rules build and never show is still named, and
// code that hides the constructor behind another name is not seen. It is narrow on purpose: on the nine X1 games it
// names the four that drew in code and none of the other five; on the corpus it names nothing.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Folders of a game that are not the game's own code. */
export const NOT_THE_GAMES = ['gf', 'vendor', 'audio', 'evidence', 'assets', 'node_modules', 'tests', 'config'];
/** What may not be constructed in the game's own code: [class name pattern, what it is]. */
const BUILT = /\bnew\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?([A-Z]\w*Geometry|Mesh|InstancedMesh|SkinnedMesh|Sprite|Points|Line|LineSegments|LineLoop)\s*\(/g;

/**
 * Source with comments and the insides of quoted strings blanked (line structure kept): a constructor named in a
 * comment or in a message is not code. A template literal is left as it is: its ${…} parts are code.
 */
export function stripComments(src) {
  let out = '', i = 0, q = null;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (q) {
      const keep = q === '`';
      if (c === '\\') { out += keep ? c + (d ?? '') : '  '; i += 2; continue; }
      if (c === q) { q = null; out += c; i++; continue; }
      out += keep || c === '\n' ? c : ' '; i++; continue;
    }
    if (c === '"' || c === '\'' || c === '`') { q = c; out += c; i++; continue; }
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    out += c; i++;
  }
  return out;
}

/** The game's own scripts, relative paths (the root's .js files and any folder that is not the kit's, a library or data). */
export async function ownScripts(dir) {
  const out = [];
  const walk = async rel => {
    for (const e of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!rel && NOT_THE_GAMES.includes(e.name)) continue; if (e.name.startsWith('.')) continue; await walk(r); }
      else if (/\.m?js$/.test(e.name)) out.push(r);
    }
  };
  await walk('');
  return out.sort();
}

/** Every place the game's own code builds something to draw. → [{file, line, what, text}] */
export async function improvised(dir) {
  const found = [];
  for (const file of await ownScripts(dir)) {
    const src = stripComments(await readFile(join(dir, file), 'utf8').catch(() => '')), lines = src.split('\n');
    lines.forEach((l, i) => { for (const m of l.matchAll(BUILT)) found.push({ file, line: i + 1, what: m[1], text: l.trim().slice(0, 110) }); });
  }
  return found;
}

/** Check 4's words for what was found. */
export function improvisedLine(found) {
  if (!found.length) return '';
  const places = found.filter((f, i) => found.findIndex(x => x.file === f.file && x.line === f.line) === i);   // one a line: the first thing built there
  return `built in code, not from a slot's file or a kit part: ${places.slice(0, 4).map(f => `${f.file}:${f.line} new ${f.what}`).join(', ')}${places.length > 4 ? ` and ${places.length - 4} more` : ''}. A shape made in the game's own code has no file a creator can replace, whatever slot id it carries: place a prop (config/world.json, or a mechanic's prop param), use the kit part that draws it (a mechanic's own marker, ctx.vfx, ctx.ui and the nameplate), or say in the delivery that the kit lacks the part`;
}
