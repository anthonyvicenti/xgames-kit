// Is this module the program Node was started with? `import.meta.main` (Node 24.2+), else a realpath comparison that
// also holds under symlinked folders (macOS /tmp → /private/tmp), where a plain string comparison of process.argv[1]
// with the module's own path silently fails.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(meta) {
  if (typeof meta.main === 'boolean') return meta.main;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return realpathSync(argv1) === realpathSync(fileURLToPath(meta.url)); } catch { return false; }
}
