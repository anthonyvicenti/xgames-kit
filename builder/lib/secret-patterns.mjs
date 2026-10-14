// Key-shaped strings: the kit's general secret scanner (it was scripts/sync-kits.mjs's, which checked the kits it copied
// from games.fun). builder/lib/backend/scan.mjs adds Supabase's own shapes to it; builder/lib/publish/scan.mjs keeps
// its own superset, shared with games.fun's Studio. Pure: no imports.
export const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['OpenAI or Anthropic key', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ['Meshy key', /\bmsy_[A-Za-z0-9_-]{16,}/],
  ['AWS access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['Stripe key', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/],
  ['JSON web token', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{16,}/],
  ['secret assigned a literal', /\b[A-Za-z0-9_]*(?:SECRET|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_TOKEN|SERVICE_ROLE|PASSWORD)[A-Za-z0-9_]*["']?\s*[:=]\s*["'][A-Za-z0-9+/_=.-]{16,}["']/i],
  ['Solana secret key (base58)', /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{86,90}(?![A-Za-z0-9])/],
];
