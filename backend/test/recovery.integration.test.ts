// Start-alert recovery query against a REAL PostgreSQL database (the SQL itself is what
// is being tested). Runs only when TEST_DATABASE_URL points at a migrated, disposable
// database; skipped otherwise. It creates its own users/project/tasks and removes them.
//   TEST_DATABASE_URL=postgresql://... npm test
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const url = process.env.TEST_DATABASE_URL;
if (url) process.env.DATABASE_URL = url;
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.ACK_TOKEN_SECRET ??= 'test-ack-secret';

const skip = url ? false : 'set TEST_DATABASE_URL to a migrated test database to run';

test('recovery picks exactly the start alerts that were lost', { skip }, async () => {
  const prisma = require('../src/config/prisma');
  const { findLostStartAlerts, NOTIFY_LEASE_MS } = require('../src/services/schedulerService');
  const tag = randomUUID().slice(0, 8);
  const [priya, rahul] = await Promise.all(['priya', 'rahul'].map((n) =>
    prisma.user.create({ data: { email: `rec-${n}-${tag}@example.com`, name: `${n} ${tag}` } })));
  const on = await prisma.project.create({ data: { name: `Recovery on ${tag}`, code: `RON${tag}`, startAlertsEnabled: true } });
  const off = await prisma.project.create({ data: { name: `Recovery off ${tag}`, code: `ROF${tag}`, startAlertsEnabled: false } });
  let seq = 0;
  const ago = (ms: number) => new Date(Date.now() - ms);
  const MIN = 60_000;

  /** A task, its updated_at forced (Prisma would set "now"), and optionally its alert row. */
  async function task(name: string, o: { project?: string; owner?: string | null; status?: string; updatedAgo: number; alert?: Record<string, unknown> }) {
    const t = await prisma.task.create({
      data: { projectId: o.project ?? on.id, system: 'FOL', taskName: name, sequenceNumber: ++seq, status: o.status ?? 'Triggered', assignedUserId: o.owner === undefined ? priya.id : o.owner },
    });
    await prisma.$executeRaw`UPDATE tasks SET updated_at = ${ago(o.updatedAgo)} WHERE id = ${t.id}`;
    if (o.alert) {
      const { updatedAgo = 10 * MIN, ...alert } = o.alert as { updatedAgo?: number };
      const a = await prisma.taskAlert.create({ data: { taskId: t.id, status: 'SENT', ...alert } });
      await prisma.$executeRaw`UPDATE task_alerts SET updated_at = ${ago(updatedAgo)} WHERE id = ${a.id}`;
    }
    return { name, id: t.id };
  }

  try {
    const expected = [
      await task('no row, queue insert failed 6 min ago', { updatedAgo: 6 * MIN }),
      await task('reassigned: new owner not emailed', { owner: rahul.id, updatedAgo: 10 * MIN, alert: { notifiedUserIds: [priya.id] } }),
      await task('claim abandoned by a crashed worker', { updatedAgo: 10 * MIN, alert: { status: 'SENDING', claimUserId: priya.id, claimedAt: ago(6 * MIN) } }),
      await task('retries used up while another worker held the claim', { updatedAgo: 10 * MIN, alert: { status: 'RETRYING' } }),
    ];
    const excluded = [
      await task('no row, but only 1 min old (job may still be queued)', { updatedAgo: 1 * MIN }),
      await task('no row, triggered 2 days ago (before alerts existed)', { updatedAgo: 2 * 24 * 60 * MIN }),
      await task('alerts switched off', { project: off.id, updatedAgo: 6 * MIN }),
      await task('no owner', { owner: null, updatedAgo: 6 * MIN }),
      await task('not ready (Pending)', { status: 'Pending', updatedAgo: 6 * MIN }),
      await task('owner already emailed', { updatedAgo: 10 * MIN, alert: { notifiedUserIds: [priya.id] } }),
      await task('someone is sending right now (live claim)', { updatedAgo: 10 * MIN, alert: { status: 'SENDING', claimUserId: priya.id, claimedAt: ago(1 * MIN) } }),
      await task('final: FAILED', { updatedAgo: 10 * MIN, alert: { status: 'FAILED', recipient: 'x' } }),
      await task('final: outside the company', { updatedAgo: 10 * MIN, alert: { status: 'BLOCKED_DOMAIN' } }),
      await task('alert row changed less than a lease ago', { updatedAgo: 10 * MIN, alert: { status: 'RETRYING', updatedAgo: 1 * MIN } }),
    ];

    const found = (await findLostStartAlerts(new Date())) as Array<{ task_id: string; owner_id: string }>;
    const ours = new Map(found.map((r) => [r.task_id, r.owner_id]));
    for (const t of expected) assert.ok(ours.has(t.id), `should be recovered: ${t.name}`);
    for (const t of excluded) assert.ok(!ours.has(t.id), `should NOT be recovered: ${t.name}`);
    assert.equal(ours.get(expected[1]!.id), rahul.id, 'the reassigned task is recovered for its NEW owner');
    assert.ok(NOTIFY_LEASE_MS === 5 * MIN);
  } finally {
    await prisma.project.deleteMany({ where: { id: { in: [on.id, off.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [priya.id, rahul.id] } } });
  }
});

after(async () => {
  if (!url) return;
  const q = require('../src/services/queueService');
  await Promise.allSettled([q.taskQueue.close(), q.emailQueue.close(), require('../src/config/prisma').$disconnect()]);
});
