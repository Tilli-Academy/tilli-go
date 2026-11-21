// Permission cache: a change to role_permissions applies on the next check (audit
// follow-up). Run: npm test (no database: Prisma is faked).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.ACK_TOKEN_SECRET ??= 'test-ack-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const prisma = require('../src/config/prisma');
const perms = require('../src/modules/auth/permissions');
const fake = (name: string, methods: Record<string, unknown>) => Object.defineProperty(prisma, name, { value: methods, configurable: true });

// A tiny role_permissions table + the version a database trigger would bump.
const db = { version: 1n, rows: [{ role: 'user', permission: 'task.edit' }], loads: 0 };
fake('permissionVersion', { findUnique: async () => ({ version: db.version }) });
fake('rolePermission', { findMany: async () => { db.loads++; return db.rows.map((r) => ({ ...r })); } });
const change = (rows: typeof db.rows) => { db.rows = rows; db.version++; };
const user = { role: 'user' };

test('revoking a permission applies on the very next check; restoring it too', async () => {
  perms.clearPermissionCache();
  assert.equal(await perms.hasPermission(user, 'task.edit'), true);
  change([]); // admin removes task.edit from "user"
  assert.equal(await perms.hasPermission(user, 'task.edit'), false);
  await assert.rejects(perms.assertPermission(user, 'task.edit'), (e: { status: number }) => e.status === 403);
  change([{ role: 'user', permission: 'task.edit' }]); // and gives it back
  assert.equal(await perms.hasPermission(user, 'task.edit'), true);
});

test('without changes the table is read once (only the version is checked)', async () => {
  perms.clearPermissionCache();
  db.loads = 0;
  for (let i = 0; i < 5; i++) await perms.hasPermission(user, 'task.edit');
  assert.equal(db.loads, 1);
});
