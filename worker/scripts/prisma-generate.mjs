// Generate the worker's Prisma client from the ONE schema: backend/prisma/schema.prisma.
//
// Prisma writes the client next to the schema's nearest node_modules, so the schema is
// copied into the worker's node_modules first (never committed, refreshed every run, so
// it can't go stale). The locally installed Prisma CLI is run with the current Node
// binary - no shell and no npx, so it works the same on Windows and Linux.
//
// Schema source: ../backend/prisma (a normal checkout), or ./prisma when running inside
// the worker Docker image, where the Dockerfile copies backend/prisma there.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [join(root, '..', 'backend', 'prisma', 'schema.prisma'), join(root, 'prisma', 'schema.prisma')];
const source = candidates.find((p) => existsSync(p));
if (!source) {
  console.error(`Prisma schema not found. Looked in:\n  ${candidates.join('\n  ')}\nRun from a full checkout of the repository.`);
  process.exit(1);
}

const dir = join(root, 'node_modules', '.tilli-schema');
mkdirSync(dir, { recursive: true });
const schema = join(dir, 'schema.prisma');
copyFileSync(source, schema);

// The worker's own Prisma CLI (same version as @prisma/client in package.json).
const require = createRequire(join(root, 'package.json'));
const pkg = require('prisma/package.json');
const cli = join(dirname(require.resolve('prisma/package.json')), pkg.bin.prisma);
execFileSync(process.execPath, [cli, 'generate', '--schema', schema], { cwd: root, stdio: 'inherit' });
