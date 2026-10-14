// Map: paint the level. A flat (2D) game's tile map is painted cell by cell over the preview (world.map); a 3D world's
// props are moved on a view from above (world.<template>.layout). Both write through slots, so the level survives a
// rebuild, a friend sees it and verify checks it. The logic is in builder/studio/lib/editors/ (paint.js, layout.js).
import { useStyles } from '../lib/editors/ui.js';

export default {
  id: 'map',
  label: 'Map',
  order: 6,
  async mount(root, ctx) {
    useStyles();
    const r = await ctx.api('game/slots?all=1');
    const mapSlot = r.slots.find(s => s.id === 'world.map' && s.constraints?.editor === 'tilemap');
    if (mapSlot) return (await import('../lib/editors/map-flat.js')).mountPainter(root, ctx, r);
    const layout = r.slots.find(s => /^world\.[a-z0-9-]+\.layout$/.test(s.id) && s.type === 'json');
    if (layout) return (await import('../lib/editors/map-layout.js')).mountLayout(root, ctx, r, layout);
    const empty = document.createElement('p');
    empty.className = 'muted empty';
    empty.textContent = 'This game has no map the studio can edit yet (no world.map or world.<template>.layout slot). Ask your session to change the world.';
    root.replaceChildren(empty);
  },
};
