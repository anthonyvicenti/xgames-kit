// The body steps ingest can run before it optimizes a GLB, each named in a pack's rebuild line:
//   --retarget <id>   another rig's body onto gf-humanoid-1 (RETARGETS)
//   --fix <id>        a body already on gf-humanoid-1, corrected (FIXES)
// Each is (bytes, { id }) → { bytes, did: plain words for the manifest's `from` }.
import { kenneyBlockyToHumanoid } from './kenney-blocky.mjs';
import { restThumbs } from './thumbs.mjs';

export const RETARGETS = {
  'kenney-blocky': async (bytes, { id }) => ({ bytes: await kenneyBlockyToHumanoid(bytes, { id }), did: ['put on gf-humanoid-1 (builder/art/rig/kenney-blocky.mjs: T-posed, rigid toy segments, 1.62 m)'] }),
};
export const FIXES = {
  thumbs: async bytes => { const r = await restThumbs(bytes); return { bytes: r.bytes, did: [r.turned.length ? `thumbs re-rested along the standard's (${r.turned.map(t => `${t.side.toLowerCase()} ${t.degrees}°`).join(', ')}; builder/art/rig/thumbs.mjs)` : 'thumbs already along the standard\'s'] }; },
};
