// The host paints for itself and for the joiner; both copies decode the same grid; a repaint moves cells between owners.
export default async function scenario({ H, J, ev, check, until, sleep }) {
  const info = P => ev(P, () => window.__fx.info());
  const same = (a, b) => a.coverage.length === b.coverage.length && a.coverage.every(c => b.coverage.some(d => d.owner === c.owner && d.cells === c.cells));
  await ev(H, () => { window.__fx.splatFor('me', -4, -2); window.__fx.splatFor('other', 4, 2); });
  await until(async () => { const [a, b] = [await info(H), await info(J)]; return a.coverage.length === 2 && same(a, b) ? [a, b] : null; }, 6000, 'the grids to agree').then(([a, b]) => check('both-copies-hold-the-same-grid', true, JSON.stringify(a.coverage)), () => check('both-copies-hold-the-same-grid', false, 'grids differ'));
  const [a1, b1] = [await info(H), await info(J)];
  check('coverage-is-per-owner', a1.coverage.length === 2 && a1.coverage.every(c => c.cells > 3), JSON.stringify(a1.coverage));
  const hostCells = a1.coverage.find(c => c.owner === a1.me)?.cells ?? 0;
  await ev(H, () => window.__fx.splatFor('other', -4, -2));   // paint over the host's patch
  await until(async () => { const [a, b] = [await info(H), await info(J)]; const h = a.coverage.find(c => c.owner === a.me)?.cells ?? 0; return h < hostCells && same(a, b) ? true : null; }, 6000, 'the repaint').then(() => check('repaint-takes-cells-over-on-both', true), () => check('repaint-takes-cells-over-on-both', false, 'no change'));
}
