// The engine's version: a hash of the geometry code (src/core) and the locked
// dependencies. The result cache keys on it, and the cloud worker refuses jobs
// from an app built with a different one, so all three run the same engine.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function engineHash(root: string): string {
  const h = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else (h.update(path.slice(root.length)), h.update(readFileSync(path)));
    }
  };
  walk(join(root, 'src/core'));
  if (existsSync(join(root, 'package-lock.json'))) h.update(readFileSync(join(root, 'package-lock.json')));
  return h.digest('hex').slice(0, 16);
}
