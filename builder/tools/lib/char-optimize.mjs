// Size work for bodies: Meshy's emissive copy of the albedo removed, textures capped (JPEG unless alpha is used),
// dedup/prune/weld, then quantize + meshopt (three's GLTFLoader needs setMeshoptDecoder, which the kit's loader has).
import './char-node.mjs';
import { gltfFn, MeshoptEncoder, sharp } from './char-deps.mjs';

export async function optimizeDoc(doc, { textureSize = 1024, quality = 84, meshopt = true, roughness } = {}) {
  const root = doc.getRoot();
  const notes = [];
  for (const m of root.listMaterials()) {
    const em = m.getEmissiveTexture(), base = m.getBaseColorTexture();
    if (em && (em === base || (base && Buffer.compare(Buffer.from(em.getImage()), Buffer.from(base.getImage())) === 0))) {
      m.setEmissiveTexture(null).setEmissiveFactor([0, 0, 0]); notes.push(`${m.getName()}: emissive copy of the albedo removed`);
    }
    if (roughness != null) m.setRoughnessFactor(roughness).setMetallicFactor(0);
  }
  for (const t of root.listTextures()) {
    const img = Buffer.from(t.getImage());
    const meta = await sharp(img).metadata();
    let alpha = false;
    if (meta.hasAlpha) { const st = await sharp(img).stats(); alpha = st.channels[3] && st.channels[3].min < 250; }
    const big = Math.max(meta.width, meta.height) > textureSize;
    let pipe = sharp(img);
    if (big) pipe = pipe.resize({ width: textureSize, height: textureSize, fit: 'inside' });
    const out = alpha ? await pipe.png({ compressionLevel: 9 }).toBuffer() : await pipe.removeAlpha().jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length < img.length || big) {
      t.setImage(new Uint8Array(out)).setMimeType(alpha ? 'image/png' : 'image/jpeg');
      if (t.getURI()) t.setURI(t.getURI().replace(/\.\w+$/, alpha ? '.png' : '.jpg'));
      notes.push(`texture ${meta.width}x${meta.height} ${(img.length / 1024).toFixed(0)}KB → ${big ? textureSize : meta.width}px ${alpha ? 'png' : 'jpeg'} ${(out.length / 1024).toFixed(0)}KB`);
    }
  }
  await MeshoptEncoder.ready;
  const steps = [gltfFn.dedup(), gltfFn.prune({ keepLeaves: true }), gltfFn.weld()];
  if (meshopt) steps.push(gltfFn.meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  await doc.transform(...steps);
  return notes;
}
