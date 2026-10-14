// gf-three voxel world: signs. A sign is a cell holding the sign block plus its words and the side it faces
// (PLAN §4.1: face 0-5 = −x, +x, −y, +y, −z, +z; only the four sides are used). It hangs flat on the block behind it
// when there is one, else it stands on a post. The board is drawn with the sign block's own texture slot; the words are
// the players' (text, not art: CONTRACT §2), in the world.voxel.sign-ink colour on a panel of world.voxel.sign-paper
// (play-test 2026-10-09: dark brown words straight on brown wood were hard to read beyond a few blocks), on a small
// canvas per sign.
import * as THREE from 'three';
import { FACE_DIRS } from './grid.mjs';

const TEXT_W = 512, TEXT_H = 320;

export function createSigns(ctx, { grid, boardTexture = null, boardSlot, ink = '#2b1d12', inkSlot = 'world.voxel.sign-ink', paper = '#f6ecd6', font = '800 72px system-ui, -apple-system, "Segoe UI", sans-serif' }) {
  const group = new THREE.Group(); group.name = 'gf-voxel-signs';
  const map = new Map();          // cell index → {text, face, root, canvas, texture}
  const boardMat = new THREE.MeshStandardMaterial({ color: boardTexture ? '#ffffff' : '#b98a55', map: boardTexture, roughness: 0.85 });
  const boardGeo = new THREE.BoxGeometry(0.92, 0.6, 0.07);
  const postGeo = new THREE.BoxGeometry(0.1, 0.5, 0.1);
  const textGeo = new THREE.PlaneGeometry(0.86, 0.54);

  function draw(canvas, text) {
    const c = canvas.getContext('2d');
    c.clearRect(0, 0, TEXT_W, TEXT_H);
    // the panel: a light card inset on the board, its wood showing round the edge
    if (paper) {
      c.fillStyle = paper; c.beginPath();
      if (c.roundRect) c.roundRect(14, 14, TEXT_W - 28, TEXT_H - 28, 18); else c.rect(14, 14, TEXT_W - 28, TEXT_H - 28);
      c.fill();
    }
    c.fillStyle = ink; c.textAlign = 'center'; c.textBaseline = 'middle';
    let lines = String(text ?? '').split('\n').slice(0, 3);
    // a long line is split at the space nearest its middle while there is room for another line, so the words stay big
    // rather than shrinking to fit (readable from a few blocks away)
    for (let guard = 0; guard < 3 && lines.length < 3; guard++) {
      let worst = -1, w = 0;
      lines.forEach((l, i) => { const m = measure(c, l, 72); if (m > TEXT_W - 64 && m > w && l.includes(' ')) { worst = i; w = m; } });
      if (worst < 0) break;
      const l = lines[worst], mid = l.length / 2;
      let cut = -1; for (let i = 0; i < l.length; i++) if (l[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
      lines = [...lines.slice(0, worst), l.slice(0, cut), l.slice(cut + 1), ...lines.slice(worst + 1)];
    }
    let size = 72;
    c.font = font;
    // shrink a long line to fit
    for (const l of lines) { while (size > 30 && measure(c, l, size) > TEXT_W - 64) size -= 2; }
    c.font = font.replace(/\d+px/, `${size}px`);
    const lh = size * 1.18, y0 = TEXT_H / 2 - (lines.length - 1) * lh / 2;
    lines.forEach((l, i) => c.fillText(l, TEXT_W / 2, y0 + i * lh));
  }
  const measure = (c, l, size) => { c.font = font.replace(/\d+px/, `${size}px`); return c.measureText(l).width; };

  function build(index, s) {
    const [x, y, z] = grid.cellOf(index);
    const face = [0, 1, 4, 5].includes(s.face) ? s.face : 5;
    const d = FACE_DIRS[face];
    const root = new THREE.Group();
    root.position.set(x + 0.5, y, z + 0.5);
    root.rotation.y = Math.atan2(d[0], d[2]);          // the board's front (+z) faces the sign's face
    // flat on the block behind it, else on a post
    const behind = grid.solidAt(x - d[0], y, z - d[2]);
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.castShadow = true; board.receiveShadow = true;
    ctx.assets?.tag?.(board, boardSlot);
    if (behind) board.position.set(0, 0.55, -0.5 + 0.036);
    else {
      board.position.set(0, 0.72, 0);
      const post = new THREE.Mesh(postGeo, boardMat); post.position.set(0, 0.25, 0); post.castShadow = true;
      ctx.assets?.tag?.(post, boardSlot);
      root.add(post);
    }
    root.add(board);
    const canvas = document.createElement('canvas'); canvas.width = TEXT_W; canvas.height = TEXT_H;
    draw(canvas, s.text);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    const words = new THREE.Mesh(textGeo, new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    words.position.copy(board.position); words.position.z += 0.037;
    words.renderOrder = 2;
    ctx.assets?.tag?.(words, inkSlot);
    root.add(words);
    // a sign on a post reads from both sides (one on a wall only from the front)
    if (!behind) {
      const back = new THREE.Mesh(textGeo, words.material);
      back.position.copy(board.position); back.position.z -= 0.037; back.rotation.y = Math.PI; back.renderOrder = 2;
      ctx.assets?.tag?.(back, inkSlot);
      root.add(back);
    }
    root.userData.gfSign = index;
    group.add(root);
    return { text: s.text, face, root, canvas, texture, words };
  }
  function drop(e) { e.root.removeFromParent(); e.texture.dispose(); e.words.material.dispose(); }

  return {
    group,
    /** Put up, change or take down the sign at a cell index ({text, face} or null). */
    set(index, s) {
      const old = map.get(index);
      if (!s) { if (old) { drop(old); map.delete(index); } return; }
      if (old && old.face === s.face) { if (old.text !== s.text) { old.text = s.text; draw(old.canvas, s.text); old.texture.needsUpdate = true; } return; }
      if (old) drop(old);
      map.set(index, build(index, s));
    },
    /** The block behind a sign changed: rebuild it (flat on a wall ↔ on a post). */
    refresh(index) { const e = map.get(index); if (e) { const s = { text: e.text, face: e.face }; drop(e); map.set(index, build(index, s)); } },
    get(index) { const e = map.get(index); return e ? { text: e.text, face: e.face } : null; },
    has: index => map.has(index),
    list: () => [...map].map(([i, e]) => ({ index: i, text: e.text, face: e.face })),
    get size() { return map.size; },
    dispose() { for (const e of map.values()) drop(e); map.clear(); boardGeo.dispose(); postGeo.dispose(); textGeo.dispose(); boardMat.dispose(); group.removeFromParent(); },
  };
}
