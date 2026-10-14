#!/usr/bin/env node
// folk.mjs: the pixel kind's villagers. A layered paper doll (body and skin, face, hair, clothes, a hat or a beard)
// drawn at 16 texels a metre into gf-flat-1 body sheets (runtimes/three/profiles/flat-2d/ART-STANDARD.md §2): six
// frames (idle, walk1, walk2, air, act, down), three rows (down, side, up) for a game seen from above and one row
// (side) for a game seen from the side. A cell is 32 x 32; the standing figure is 27 texels tall (1.7 m), with
// Stardew-like proportions: a big head, a short body, small feet. Light from the top left, a one-texel outline in each
// material's own deep colour, at most 32 colours a sheet. Generated, no third-party art, CC0.
//
//   node runtimes/three/tools/pixel/folk.mjs [--out <dir>, default .cache/pixel-folk] [--only <id,id>] [--preview <file.png>]
//   node runtimes/three/tools/pixel/folk.mjs --standins     every sheet as the flat runtime's pixel stand-ins
//                                                          (builder/tools/lib/standin-assets/flat/pixel/folk-*-top.png and -side.png;
//                                                          the player's also as body-top.png and body-side.png)
//
// Every sheet is judged by the flat runtime's own judge before it is written; a sheet that fails is not written and
// the tool exits 1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Roles, outline, toRgba, picture, blit, colourCount, mix, ramp } from './paint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../../..');
const { encodePng } = await import(pathToFileURL(join(REPO, 'builder/art/png.mjs')).href);
const { importLayer } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/kit-import.mjs')).href);
const { repoFileOf } = await import(pathToFileURL(join(REPO, 'builder/tools/lib/paths.mjs')).href);
const { judge } = await importLayer(repoFileOf('gf/three/flat/judge.js'));   // the flat runtime's own judge, as a game's copy imports it

export const CELL = 32;
export const FRAMES = ['idle', 'walk1', 'walk2', 'air', 'act', 'down'];
export const DIRS = ['down', 'side', 'up'];

// ------------------------------------------------------------------------------------------------ colours
// Skin ramps by hand (light, base, shade, line): five tones from pale to deep.
export const SKIN = {
  pale: ['#ffe6d2', '#f7cdb0', '#dca07f', '#8a4a3c'],
  light: ['#fbd9b6', '#eeb88f', '#cc8a64', '#7c4232'],
  tan: ['#ecb788', '#d49866', '#ad7044', '#653a24'],
  brown: ['#c88a5c', '#a96b41', '#82492b', '#4a2618'],
  deep: ['#94603f', '#774729', '#59311b', '#2f1a10'],
};
const hairRamp = base => ramp(base, { light: 0.28, dark: 0.34, line: 0.66 });
const clothRamp = base => ramp(base, { light: 0.3, dark: 0.32, line: 0.64 });
/** The light grey a player's shirt is painted in: the seat colour multiplies it (ART-STANDARD.md §2, Colour). */
export const TINTABLE = ['#f2f2f4', '#d6d6dc', '#a9a9b6', '#55546a'];

// ------------------------------------------------------------------------------------------------ the people
// skin: a tone; hair: a style and colour; top: a style (tee, long, overalls, dress, vest, apron) and colours; legs,
// shoes, acc (an accent: overalls, a vest, an apron, a cap, a skirt); face: smile, beard. describe is what the library
// manifest says.
export const FOLK = {
  'folk-farmer': { label: 'Farmer', describe: 'a farmer in denim overalls over a red shirt, short brown hair', skin: 'tan', hair: ['short', '#6b4423'], top: 'overalls', shirt: '#c8463a', acc: '#4f6fae', legs: '#4f6fae', shoes: '#5a3a26', smile: true },
  'folk-baker': { label: 'Baker', describe: 'a baker in a long-sleeved cream top and a white apron, a blonde ponytail', skin: 'light', hair: ['ponytail', '#e8c060'], top: 'apron', shirt: '#e9a05a', acc: '#f3eee2', legs: '#6a4a3a', shoes: '#4a3428' },
  'folk-smith': { label: 'Smith', describe: 'a smith in a leather vest over a cream shirt, close black hair and a beard', skin: 'deep', hair: ['short', '#2a2226'], beard: true, top: 'vest', shirt: '#e6d7b8', acc: '#7a4a2e', legs: '#3f3a4a', shoes: '#2e2420' },
  'folk-elder': { label: 'Elder', describe: 'an elder in a purple cardigan, grey hair at the sides and a grey beard', skin: 'pale', hair: ['bald', '#c9c6d8'], beard: true, top: 'long', shirt: '#7a5aa0', legs: '#5d5a52', shoes: '#4a3a30' },
  'folk-fisher': { label: 'Fisher', describe: 'a fisher in a yellow cap and a teal jumper', skin: 'brown', hair: ['cap', '#3a2a22'], top: 'long', shirt: '#2f9a9a', acc: '#f0c040', legs: '#55606e', shoes: '#3a3030', smile: true },
  'folk-gardener': { label: 'Gardener', describe: 'a gardener in a green dress, long red hair', skin: 'pale', hair: ['long', '#c8582c'], top: 'dress', shirt: '#5aa05a', acc: '#4a8a4a', legs: '#f0d8c0', shoes: '#7a4a2a', smile: true },
  'folk-scholar': { label: 'Scholar', describe: 'a scholar in a navy long-sleeved top and grey trousers, a black bob', skin: 'tan', hair: ['bob', '#22202c'], top: 'long', shirt: '#34508a', legs: '#7a7a86', shoes: '#3a2e2a' },
  'folk-rocker': { label: 'Rocker', describe: 'a rocker in a black tee, spiky pink hair', skin: 'light', hair: ['spiky', '#e05aa0'], top: 'tee', shirt: '#3a3446', legs: '#4a5a8a', shoes: '#e8e4dc', smile: true },
  'folk-ranger': { label: 'Ranger', describe: 'a ranger in a green vest over a beige shirt, a dark ponytail', skin: 'brown', hair: ['ponytail', '#3a2418'], top: 'vest', shirt: '#d8c49a', acc: '#4a7a3a', legs: '#6a5a40', shoes: '#4a3022' },
  'folk-courier': { label: 'Courier', describe: 'a courier in an orange tee and blue jeans, a red cap', skin: 'deep', hair: ['cap', '#1e1a1e'], top: 'tee', shirt: '#e8823a', acc: '#c83a3a', legs: '#3d5a9a', shoes: '#f0ece4', smile: true },
  'folk-tailor': { label: 'Tailor', describe: 'a tailor in a plum dress, a brown bob', skin: 'light', hair: ['bob', '#7a4a2a'], top: 'dress', shirt: '#a04a6a', acc: '#8a3a5a', legs: '#3a2a3a', shoes: '#2e2228' },
  'folk-miner': { label: 'Miner', describe: 'a miner in a brown jumper and dark trousers, messy ginger hair', skin: 'pale', hair: ['spiky', '#d0782c'], top: 'long', shirt: '#8a5a3a', legs: '#3a3a44', shoes: '#2a2626' },
  // the runtime's player body: its shirt is the light grey the seat colour takes (one per seat in a game)
  'folk-player': { label: 'Player', describe: 'a villager in a light grey tee that takes the player\'s colour, short brown hair, blue jeans', skin: 'light', hair: ['short', '#7a4a28'], top: 'tee', shirt: null, legs: '#3f5f9a', shoes: '#5a3a26', smile: true, tintable: true },
};

export function paletteOf(v) {
  const S = SKIN[v.skin];
  return {
    skin: S, hair: hairRamp(v.hair[1]), shirt: v.tintable ? TINTABLE : clothRamp(v.shirt),
    pants: clothRamp(v.legs), shoe: clothRamp(v.shoes), acc: clothRamp(v.acc ?? v.shirt ?? '#888888'),
    eye: ['#2b1d2a'], eyew: ['#f6eedc'], blush: [mix(S[1], '#ff6f6f', 0.38)], mouth: [mix(S[3], '#b0403a', 0.35)],
  };
}

// ------------------------------------------------------------------------------------------------ the parts
// Letters: a b c skin (light, base, shade); h i j hair; s t u shirt; p q r trousers; f g shoe; y z Z accent;
// e eye, w eye white, n blush, m mouth. Grids are 16 wide with their left at x = 8 (the figure's middle is x 15.5).
const KEY = {
  a: 'skin:1', b: 'skin:2', c: 'skin:3', h: 'hair:1', i: 'hair:2', j: 'hair:3', s: 'shirt:1', t: 'shirt:2', u: 'shirt:3',
  p: 'pants:1', q: 'pants:2', r: 'pants:3', f: 'shoe:1', g: 'shoe:2', y: 'acc:1', z: 'acc:2', Z: 'acc:3',
  e: 'eye:1', w: 'eyew:1', n: 'blush:1', m: 'mouth:1',
};
const X0 = 8;

const HEAD = {
  down: [
    '....bbbbbbbb....',
    '...abbbbbbbbc...',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '..abwebbbbewbc..',
    '..abwebbbbewbc..',
    '..abnbbbbbbnbc..',
    '..abbbbMMbbbbc..',
    '...cbbbbbbbbc...',
    '....ccbbbbcc....',
  ],
  side: [
    '......bbbbbb....',
    '....abbbbbbbb...',
    '...abbbbbbbbbb..',
    '...abbbbbbbbbb..',
    '...abbbcbbbebb..',
    '...abbbcbbbebbb.',
    '...abbbbbbbnbb..',
    '...abbbbbbbbbM..',
    '....cbbbbbbbbc..',
    '.....ccbbbbbc...',
  ],
  up: [
    '....bbbbbbbb....',
    '...abbbbbbbbc...',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '..abbbbbbbbbbc..',
    '...cbbbbbbbbc...',
    '....ccbbbbcc....',
  ],
};
const HEAD_Y = 6;

// hair: rows from y = 5. A style with no grid for a direction draws nothing there.
const HAIR = {
  short: {
    down: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiijiiiijiiij.',
      '.hj..........jj.',
      '.hj..........jj.',
      '..j..........j..',
    ],
    side: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hiiiiiiiiiij..',
      '..hiiiiiiiiiiij.',
      '..iiiiiiiiij.ij.',
      '..iiiiij........',
      '..jiiij.........',
      '...jj...........',
    ],
    up: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '..iiiiiiiiiiij..',
      '..jiijiiiijiij..',
      '...jj.jjjj.jj...',
    ],
  },
  long: {
    down: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiijiiiiiij.',
      '.hi..........ij.',
      '.hi..........ij.',
      '.hi..........ij.',
      '.hi..........ij.',
      '.hj..........jj.',
      '.ij..........jj.',
      '.ij..........jj.',
      '.ij..........jj.',
      '..j..........j..',
    ],
    side: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hiiiiiiiiiij..',
      '..hiiiiiiiiiiij.',
      '.hiiiiiiiiij.ij.',
      '.hiiiiij........',
      '.hiiiij.........',
      '.hiiiij.........',
      '.iiiij..........',
      '.iiiij..........',
      '.iiiij..........',
      '..ijj...........',
      '..jj............',
    ],
    up: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.iiiiiiiiiiiijj.',
      '..iiiiiiiiiijj..',
      '..iiijiiiijiij..',
      '...jj.jjjj.jj...',
    ],
  },
  bob: {
    down: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hi..........ij.',
      '.hi..........ij.',
      '.ij..........jj.',
      '..j..........j..',
    ],
    side: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hiiiiiiiiiij..',
      '..hiiiiiiiiiiij.',
      '.hiiiiiiiiiiiij.',
      '.hiiiiij....j...',
      '.hiiiij.........',
      '.iiiij..........',
      '.jjij...........',
    ],
    up: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.iiiiiiiiiiiijj.',
      '.jjiijjjjijjjjj.',
    ],
  },
  ponytail: {
    down: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '..hiiiiiiiiiij..',
      '..hiij....jiij..',
      '..hj........j...',
    ],
    side: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hiiiiiiiiiij..',
      '.hhiiiiiiiiiiij.',
      'hiiiiiiiiiij.ij.',
      'hiiiiij.........',
      'iiijij..........',
      'iij.............',
      'ij..............',
      'j...............',
    ],
    up: [
      '.....hiiiij.....',
      '...hhiiiiiiij...',
      '..hhiiiiiiiiij..',
      '..hiiiiiiiiiij..',
      '..hiiiiiiiiiij..',
      '..hiiiiiiiiiij..',
      '..iiiiiijiiiij..',
      '..jiiihiiiiijj..',
      '...jjhiiijjj....',
      '......hij.......',
      '......iij.......',
      '......iij.......',
      '......ij........',
      '.......j........',
    ],
  },
  spiky: {
    down: [
      '..h..hi.ij..i...',
      '..hhhiiiiiijii..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiji.iiji.ijij.',
      '.hj..........jj.',
      '..j..........j..',
    ],
    side: [
      '...h.hi.ij.i....',
      '..hhhiiiiiiiij..',
      '.hiiiiiiiiiiij..',
      '.hiiiiiiiiiiiijj',
      'hiiiiiiiiij.ij..',
      '.iiiiij.........',
      '.jiiij..........',
      '..jj............',
    ],
    up: [
      '..h..hi.ij..i...',
      '..hhhiiiiiijii..',
      '.hhiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '..iiiiiiiiiiij..',
      '..jiijiiiijiij..',
      '...j..jjjj..j...',
    ],
  },
  // a cap: the crown and brim are the accent; hair shows under it
  cap: {
    down: [
      '.....yzzzzZ.....',
      '...yyzzzzzzZZ...',
      '..yyzzzzzzzzZZ..',
      '..yzzzzzzzzzzZ..',
      '.ZZZZZZZZZZZZZZ.',
      '.ij..........jj.',
      '..j..........j..',
    ],
    side: [
      '.....yzzzzZ.....',
      '...yyzzzzzzZZ...',
      '..yzzzzzzzzzzZ..',
      '..yzzzzzzzzzzZ..',
      '..iiiiiiiiZZZZZZ',
      '..iiiiij........',
      '..jiiij.........',
      '...jj...........',
    ],
    up: [
      '.....yzzzzZ.....',
      '...yyzzzzzzZZ...',
      '..yyzzzzzzzzZZ..',
      '..yzzzzzzzzzzZ..',
      '..ZZZZZZZZZZZZ..',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '..iiiiiiiiiiij..',
      '..jiijiiiijiij..',
      '...jj.jjjj.jj...',
    ],
  },
  // little on top: grey at the sides and the back
  bald: {
    down: [
      '................',
      '................',
      '................',
      '.h............j.',
      '.hi..........ij.',
      '.hi..........ij.',
      '.hj..........jj.',
      '..j..........j..',
    ],
    side: [
      '................',
      '................',
      '................',
      '..h.............',
      '..hiij..........',
      '..iiiij.........',
      '..iiij..........',
      '...jj...........',
    ],
    up: [
      '................',
      '................',
      '................',
      '.h............j.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '.hiiiiiiiiiiijj.',
      '..iiiiiiiiiiij..',
      '..jiijiiiijiij..',
      '...jj.jjjj.jj...',
    ],
  },
};
const HAIR_Y = 5;
// where the light catches the crown, by direction (absolute texels)
const SHEEN = {
  down: [[12, 6], [13, 6], [14, 6], [11, 7], [12, 7], [10, 8], [11, 8], [15, 9], [16, 9]],
  side: [[12, 6], [13, 6], [14, 6], [11, 7], [12, 7], [10, 8], [16, 7], [17, 8]],
  up: [[12, 6], [13, 6], [14, 6], [11, 7], [12, 7], [10, 8], [11, 8], [14, 10], [15, 11], [16, 12]],
};

// a beard (hair colour) over the lower face, from y = 12
const BEARD = {
  down: ['..i..........i..', '..iihiiiiiihii..', '...iiiiiiiiij...', '....iiiiiiij....', '.....jiiiij.....'],
  side: ['................', '.........hiiii..', '........iiiiij..', '.......iiiiij...', '........jjij....'],
};

// the torso, from y = 16: shoulders, chest, the hem
const TORSO = {
  down: [
    '....sttbbttu....',
    '...sstttttttu...',
    '....sttttttu....',
    '....sttttttu....',
    '....sttttttu....',
    '....sttttttu....',
    '....sttttttu....',
    '....uuuuuuuu....',
  ],
  side: [
    '.....sttttu.....',
    '.....stttttu....',
    '.....stttttu....',
    '.....stttttu....',
    '.....stttttu....',
    '.....stttttu....',
    '.....stttttu....',
    '.....uuuuuuu....',
  ],
  up: [
    '....sttttttu....',
    '...sstttttttu...',
    '....sttttttu....',
    '....sttttttu....',
    '....stttuttu....',
    '....sttttttu....',
    '....sttttttu....',
    '....uuuuuuuu....',
  ],
};
const TORSO_Y = 16;

// what a top style lays over the torso (accent letters), from y = 16
const OVER = {
  overalls: {
    down: ['................', '................', '.....y....Z.....', '.....yyzzzZ.....', '.....yzzzzZ.....', '.....yzzzzZ.....', '.....yzzzzZ.....', '....yzzzzzzZ....'],
    side: ['................', '................', '.......y........', '.......yzzZ.....', '......yzzzzZ....', '......yzzzzZ....', '......yzzzzZ....', '.....yzzzzzzZ...'],
    up: ['................', '................', '......y..Z......', '.......yZ.......', '......yzzZ......', '.....yzzzzZ.....', '.....yzzzzZ.....', '....yzzzzzzZ....'],
  },
  vest: {
    down: ['................', '...yy......ZZ...', '....yz....zZ....', '....yz....zZ....', '....yz....zZ....', '....yz....zZ....', '....yz....zZ....', '....yz....zZ....'],
    side: ['................', '.....yz.........', '.....yzz........', '.....yzz........', '.....yzz........', '.....yzz........', '.....yzz........', '.....yzz........'],
    up: ['................', '...yyzzzzzzZZ...', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....'],
  },
  apron: {
    down: ['................', '................', '.....yzzzzZ.....', '.....yzzzzZ.....', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....'],
    side: ['................', '................', '..........y.....', '..........yz....', '.........yzz....', '.........yzz....', '.........yzz....', '.........yzz....'],
    up: ['................', '................', '................', '................', '....ZZZZZZZZ....', '................', '................', '................'],
  },
};
// below the hem: the apron and the skirt go on over the legs (rows from y = 24)
const SKIRT = {
  dress: {
    down: ['....sttttttu....', '...ssttttttuu...', '...stttttttuu...', '..sstttttttuuu..'],
    side: ['.....sttttttu...', '....sstttttuu...', '....stttttttuu..', '...sstttttttuu..'],
    up: ['....sttttttu....', '...ssttttttuu...', '...stttttttuu...', '..sstttttttuuu..'],
  },
  apron: {
    down: ['....yzzzzzzZ....', '....yzzzzzzZ....', '....yzzzzzzZ....'],
    side: ['.........yzz....', '.........yzz....', '.........yzz....'],
    up: null,
  },
};
const SLEEVE = { tee: 3, long: 5, overalls: 3, dress: 3, vest: 5, apron: 5 };

// ------------------------------------------------------------------------------------------------ limbs
const key = (L, at) => (ch) => KEY[ch];

/** A line of texels from (x0, y0) to (x1, y1), each row `w` wide, painted by paint(i, row, n) → role (i: 0..w-1). */
function limb(g, x0, y0, x1, y1, w, paint) {
  const n = Math.max(1, Math.abs(y1 - y0) + 1);
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1), y = Math.round(y0 + (y1 - y0) * t), x = Math.round(x0 + (x1 - x0) * t);
    for (let i = 0; i < w; i++) g.set(x + i, y, paint(i, k, n));
  }
}

/** Front or back legs. lift: [left, right] texels a foot is off the ground; top: the hips' row. */
function legsFront(g, v, { top, lift = [0, 0], tuck = 0, dir }) {
  const dress = v.top === 'dress', trousers = (x, light) => (light === 0 ? 'pants:1' : light === 2 ? 'pants:3' : 'pants:2');
  // the hips: two rows the width of the body
  if (!dress) for (let y = top; y < top + 2; y++) for (let x = 12; x <= 19; x++) g.set(x, y, x === 12 ? 'pants:1' : x === 19 ? 'pants:3' : 'pants:2');
  const legs = [{ x: 12, lift: lift[0] }, { x: 17, lift: lift[1] }];
  for (const L of legs) {
    const bottom = 31 - L.lift - tuck, shoeTop = bottom - 1;
    const w = dress ? 2 : 3, x = dress ? L.x + 1 : L.x;
    for (let y = top + 2; y < shoeTop; y++) for (let i = 0; i < w; i++) g.set(x + i, y, dress ? (i === 0 ? 'pants:1' : 'pants:2') : trousers(x + i, i === 0 ? 0 : i === w - 1 ? 2 : 1));
    // shoes: a toe cap seen from the front, a heel from behind
    for (let i = 0; i < 3; i++) { g.set(L.x + i, shoeTop, i === 0 && dir === 'down' ? 'shoe:1' : 'shoe:2'); g.set(L.x + i, bottom, i === 2 ? 'shoe:3' : 'shoe:2'); }
  }
}

/** Side legs, facing right: the far leg first (in shade), then the near one. feet: [near x, far x]; lift: [near, far]. */
function legsSide(g, v, { top, feet = [15, 15], lift = [0, 0], tuck = 0 }) {
  const dress = v.top === 'dress';
  if (!dress) for (let y = top; y < top + 2; y++) for (let x = 13; x <= 18; x++) g.set(x, y, x === 13 ? 'pants:1' : x === 18 ? 'pants:3' : 'pants:2');
  const draw = (fx, up, far) => {
    const bottom = 31 - up - tuck, hipX = 14.5;
    const w = dress ? 2 : 3, ox = dress ? 0.5 : 0;
    limb(g, Math.round(hipX + ox), top + 2, Math.round(fx - 1 + ox), bottom - 2, w, i => (far ? (i === w - 1 ? 'pants:3' : 'pants:3') : i === 0 ? 'pants:1' : i === w - 1 ? 'pants:3' : 'pants:2'));
    // the shoe points the way the body faces: two texels past the leg
    for (let i = -1; i <= 3; i++) { g.set(fx - 1 + i, bottom - 1, i === 3 ? null : far ? 'shoe:3' : i === -1 ? 'shoe:2' : 'shoe:1'); g.set(fx - 1 + i, bottom, far ? 'shoe:3' : i === 3 ? 'shoe:3' : 'shoe:2'); }
  };
  draw(feet[1], lift[1], true);
  draw(feet[0], lift[0], false);
}

/** An arm drawn on its own and given its own line where it lies over the body, so it reads as an arm and not a patch of
 *  shirt. The line outside the body is left to the figure's outline (never a double line). */
function withLine(g, draw) {
  const L = new Roles(CELL, CELL);
  draw(L);
  const O = outline(L, { prefer: ['skin', 'shirt'] });
  for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
    const v = L.get(x, y);
    if (v) g.set(x, y, v);
    else if (O.get(x, y) && g.get(x, y)) g.set(x, y, O.get(x, y));
  }
}

/** An arm from (x0, y0) at the shoulder to (x1, y1) at the hand, two texels wide; the last two rows are the hand. */
function arm(L, v, x0, y0, x1, y1, { light = true, far = false, across = false } = {}) {
  const sleeve = SLEEVE[v.top] ?? 3, n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1;
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : k / (n - 1), x = Math.round(x0 + (x1 - x0) * t), y = Math.round(y0 + (y1 - y0) * t);
    const hand = k >= n - 2 || (k >= sleeve && n > sleeve + 2), m = hand ? 'skin' : 'shirt';
    const a = far ? 3 : light ? 1 : 2, b = far ? 3 : light ? 2 : 3;
    if (across) { L.set(x, y, `${m}:${a}`); L.set(x, y + 1, `${m}:${b}`); }
    else { L.set(x, y, `${m}:${a}`); L.set(x + 1, y, `${m}:${b}`); }
  }
}

/** A front or back arm. side: -1 left, 1 right; pose: 'hang' (dy: a swing), 'cheer' (up and out), 'wave' (one hand up). */
function armFront(g, v, { side, top, dy = 0, pose = 'hang' }) {
  const light = side < 0, sx = side < 0 ? 9 : 21;
  withLine(g, L => {
    if (pose === 'cheer') arm(L, v, sx, top + 1, sx + side * 3, top - 5, { light });
    else if (pose === 'wave') arm(L, v, sx, top + 1, sx + side * 2, top - 6, { light });
    else { arm(L, v, sx, top + 1 + dy, sx, top + 7 + dy, { light }); if (dy < 0) { L.set(sx, top, `shirt:${light ? 1 : 2}`); L.set(sx + 1, top, `shirt:${light ? 2 : 3}`); } }
  });
}

/** An arm seen from the side (facing right), from the shoulder. reach: 'hang', 'fwd', 'back', 'out', 'up'. */
function armSide(g, v, { top, reach = 'hang', far = false }) {
  const sx = 14, sy = top + 1;
  const end = { hang: [14, top + 7], fwd: [17, top + 6], back: [11, top + 6], out: [21, top + 2], up: [20, top - 2] }[reach];
  if (far) { const L = new Roles(CELL, CELL); arm(L, v, sx + 1, sy, end[0] + 1, end[1], { far: true, across: Math.abs(end[0] - sx) > Math.abs(end[1] - sy) }); g.over(L); return; }
  withLine(g, L => arm(L, v, sx, sy, end[0], end[1], { across: Math.abs(end[0] - sx) > Math.abs(end[1] - sy) }));
}

// ------------------------------------------------------------------------------------------------ a frame
/** One frame of one person in one direction, in roles (32 x 32, before the outline). */
export function figure(v, dir, frame, { closed = false } = {}) {
  const g = new Roles(CELL, CELL);
  const air = frame === 'air', bob = air ? -2 : 0, act = frame === 'act';
  const top = 24 + bob, tuck = air ? 1 : 0;
  const hair = HAIR[v.hair[0]]?.[dir];
  const face = (ch) => (ch === 'M' ? (v.smile || act ? KEY.m : KEY.b) : (closed && (ch === 'w')) ? KEY.b : closed && ch === 'e' ? 'skin:3' : KEY[ch]);
  const side = dir === 'side';
  const walk = frame === 'walk1' ? 1 : frame === 'walk2' ? -1 : 0;

  // the far arm (side view) and the legs first
  if (side) armSide(g, v, { top: TORSO_Y + bob, reach: act ? 'hang' : walk === 1 ? 'back' : walk === -1 ? 'fwd' : air ? 'back' : 'hang', far: true });
  if (side) {
    const feet = walk === 1 ? [19, 11] : walk === -1 ? [11, 19] : air ? [18, 12] : act ? [17, 13] : [16, 15];
    legsSide(g, v, { top, feet, lift: air ? [1, 0] : [0, 0], tuck });
  } else {
    // seen from the front or the back: a step lifts one foot; the leg on the near side of the screen is the left
    const lift = walk === 1 ? [2, 0] : walk === -1 ? [0, 2] : air ? [1, 1] : [0, 0];
    legsFront(g, v, { top, lift: dir === 'up' ? [lift[1], lift[0]] : lift, tuck, dir });
  }
  // what goes over the legs: a skirt, an apron
  const skirt = SKIRT[v.top]?.[dir];
  if (skirt) g.grid(skirt, X0, top, key());
  // the torso, the top's accent over it
  g.grid(TORSO[dir], X0, TORSO_Y + bob, ch => (ch === 'b' ? (dir === 'down' ? 'skin:3' : 'shirt:2') : KEY[ch]));
  const over = OVER[v.top]?.[dir];
  if (over) g.grid(over, X0, TORSO_Y + bob, key());
  // arms seen from the front or back (behind the long hair)
  if (!side) {
    const raise = act ? (dir === 'up' ? -1 : 1) : 0;
    armFront(g, v, { side: -1, top: TORSO_Y + bob, dy: walk === 1 ? 1 : walk === -1 ? -1 : 0, pose: air ? 'cheer' : raise < 0 ? 'wave' : 'hang' });
    armFront(g, v, { side: 1, top: TORSO_Y + bob, dy: walk === 1 ? -1 : walk === -1 ? 1 : 0, pose: air ? 'cheer' : raise > 0 ? 'wave' : 'hang' });
  }
  // the head, the hair, a beard
  g.grid(HEAD[dir], X0, HEAD_Y + bob, face);
  if (v.beard && BEARD[dir]) g.grid(BEARD[dir], X0, 12 + bob, key());
  if (hair) {
    g.grid(hair, X0, HAIR_Y + bob, key());
    // a sheen across the crown, toward the light: the hair's light shade where the crown curves (not on a cap)
    if (v.hair[0] !== 'cap' && v.hair[0] !== 'bald') for (const [x, y] of SHEEN[dir]) if (g.get(x, y + bob) === 'hair:2') g.set(x, y + bob, 'hair:1');
  }
  // a belt where the top meets the trousers (a dress, overalls or an apron have none)
  if (['tee', 'long', 'vest'].includes(v.top)) for (let x = side ? 13 : 12; x <= (side ? 19 : 19); x++) if (g.get(x, TORSO_Y + 7 + bob)) g.set(x, TORSO_Y + 7 + bob, x === (side ? 18 : 15) ? 'shoe:1' : 'shoe:3');
  // the near arm, over everything, seen from the side
  if (side) armSide(g, v, { top: TORSO_Y + bob, reach: act ? 'out' : walk === 1 ? 'fwd' : walk === -1 ? 'back' : air ? 'up' : 'hang' });
  return g;
}

/** Knocked down: the standing figure with its eyes shut, turned to lie on the ground, feet at the bottom middle. */
function lying(v, dir) {
  const up = figure(v, dir, 'idle', { closed: true });
  const t = up.turn(dir !== 'side');
  const b = t.bounds(), g = new Roles(CELL, CELL);
  g.over(t, Math.round(15.5 - (b.x0 + b.x1) / 2), 30 - b.y1);
  return g;
}

const PREFER = ['hair', 'acc', 'shirt', 'pants', 'shoe', 'skin', 'eye', 'eyew', 'blush', 'mouth'];
/** A frame with its outline. */
export function cell(v, dir, frame) {
  return outline(frame === 'down' ? lying(v, dir) : figure(v, dir, frame), { prefer: PREFER });
}

/** The 3-row sheet (down, side, up) seen from above, or the 1-row sheet (side) for a game seen from the side. */
export function sheet(id, { rows = 3 } = {}) {
  const v = FOLK[id], P = paletteOf(v), dirs = rows === 3 ? DIRS : ['side'];
  const pic = picture(CELL * 6, CELL * dirs.length);
  dirs.forEach((dir, r) => FRAMES.forEach((f, c) => blit(pic, toRgba(cell(v, dir, f), P), c * CELL, r * CELL)));
  return pic;
}

// ------------------------------------------------------------------------------------------------ main
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), opt = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const standins = argv.includes('--standins');
  const out = standins ? join(REPO, 'builder/tools/lib/standin-assets/flat/pixel') : opt('--out', join(REPO, '.cache/pixel-folk'));
  const only = opt('--only')?.split(',') ?? Object.keys(FOLK);
  mkdirSync(out, { recursive: true });
  let bad = 0;
  const made = [];
  for (const id of only) {
    for (const [rows, plane, suffix] of [[3, 'top', 'top'], [1, 'side', 'side']]) {
      const pic = sheet(id, { rows });
      const j = judge('body', { width: pic.width, height: pic.height, data: new Uint8Array(pic.data.buffer, pic.data.byteOffset, pic.data.length) }, { style: 'pixel', plane });
      const n = colourCount(pic);
      const file = join(out, `${id}-${suffix}.png`);
      if (!j.ok) { bad++; console.error(`${id}-${suffix}: FAILS the flat judge: ${j.errors.map(e => `${e.rule} ${e.frame ?? ''} ${e.message}`).join('; ')}`); continue; }
      writeFileSync(file, encodePng(pic));
      if (standins && id === 'folk-player') writeFileSync(join(out, `body-${suffix}.png`), encodePng(pic));
      made.push({ id, suffix, pic });
      console.log(`${id}-${suffix}.png  ${pic.width}x${pic.height}  ${n} colours  judge ok${j.warnings.length ? ` (${j.warnings.map(w => w.rule).join(', ')})` : ''}`);
    }
  }
  const pv = opt('--preview');
  if (pv) {
    // every sheet at 4x on a grass green, one under the other
    const k = 4, gap = 8, rowsH = made.reduce((s, m) => s + m.pic.height * k + gap, gap), W = CELL * 6 * k + gap * 2;
    const P = picture(W, rowsH);
    for (let i = 0; i < P.data.length; i += 4) { P.data[i] = 0x7c; P.data[i + 1] = 0xb8; P.data[i + 2] = 0x5c; P.data[i + 3] = 255; }
    let y = gap;
    for (const m of made) {
      for (let yy = 0; yy < m.pic.height * k; yy++) for (let xx = 0; xx < m.pic.width * k; xx++) {
        const s = ((Math.floor(yy / k)) * m.pic.width + Math.floor(xx / k)) * 4;
        if (m.pic.data[s + 3] < 128) continue;
        m.pic.data.copy(P.data, ((y + yy) * W + gap + xx) * 4, s, s + 4);
      }
      y += m.pic.height * k + gap;
    }
    writeFileSync(pv, encodePng(P));
    console.log(`preview → ${pv}`);
  }
  process.exit(bad ? 1 : 0);
}
