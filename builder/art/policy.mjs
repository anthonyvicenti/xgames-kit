// The licence policy: which licence class an SPDX id belongs to, whether the library takes it, and what using it asks
// of a game. The classes and the floor are data (library/policy.json); the floor is an open creator decision.
import { readFileSync } from 'node:fs';

export function loadPolicy(file) { return JSON.parse(readFileSync(file, 'utf8')); }

/** The class of a licence id. → { name, rank, duty, allowed } or null when no class names it. */
export function licenceClass(policy, spdx) {
  if (!spdx) return null;
  for (const [name, c] of Object.entries(policy.classes)) {
    if (c.spdx?.includes(spdx) || (c.pattern && new RegExp(c.pattern).test(spdx))) {
      return { name, rank: c.rank, duty: c.duty, allowed: policy.allow.includes(name) };
    }
  }
  return null;
}

/**
 * Can a resolver hand this licence to a game, and on what terms? opts.paid: { yes, keys: [maker…] } from the caller.
 * → { ok, rank, duty, why }
 */
export function usable(policy, licence, { paid = null } = {}) {
  const c = licenceClass(policy, licence?.spdx);
  if (!c) return { ok: false, rank: 9, duty: null, why: `licence ${licence?.spdx ?? '(none)'} is in no class of the policy` };
  if (!c.allowed) return { ok: false, rank: c.rank, duty: c.duty, why: `licence class ${c.name} is outside the policy's floor` };
  if (c.duty === 'key-and-yes') {
    const maker = licence.maker ?? licence.spdx.replace(/^LicenseRef-|-Paid$/g, '').toLowerCase();
    if (!paid?.yes || !(paid.keys ?? []).map(k => k.toLowerCase()).includes(maker)) {
      return { ok: false, rank: c.rank, duty: c.duty, why: `a paid maker's output (${maker}): needs that account's key and the creator's yes` };
    }
  }
  if (c.duty === 'credit' && !licence.credit) return { ok: false, rank: c.rank, duty: c.duty, why: 'an attribution licence with no credit line to write into the game' };
  return { ok: true, rank: c.rank, duty: c.duty, why: null };
}
