// Generate the worker's Prisma client from the ONE schema: backend/prisma/schema.prisma.
// (Prisma writes the client next to the schema's nearest node_modules, so the schema is
// copied into the worker's node_modules first; that copy is never committed and is
// refreshed on every run, so it can't go stale.)
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, '..', 'backend', 'prisma', 'schema.prisma');
if (!existsSync(source)) {
  console.error(`Schema not found: ${source} (run from a full checkout of the repository)`);
  process.exit(1);
}
const dir = join(root, 'node_modules', '.tilli-schema');
mkdirSync(dir, { recursive: true });
copyFileSync(source, join(dir, 'schema.prisma'));
execFileSync('npx', ['prisma', 'generate', '--schema', join(dir, 'schema.prisma')], { cwd: root, stdio: 'inherit' });
