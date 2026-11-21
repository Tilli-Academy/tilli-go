// No-owner notice finalization vs owner assignment, against a REAL PostgreSQL database
// (row locks, READ COMMITTED). The worker's finalization (worker/src/services/
// deliveryClaims.ts, its own Prisma client = its own connections) runs concurrently with
// the API's real owner change (taskService.update) or with an open transaction that
// holds an owner change uncommitted.
// Runs only when TEST_DATABASE_URL points at a migrated, disposable database:
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

const RM = 'release-management@example.com';
const load = () => ({
  prisma: require('../src/config/prisma'), // the API's client
  taskService: require('../src/services/taskService'),
  claims: require('../../worker/src/services/deliveryClaims'), // the worker's code + client
});

/** Promise state after `ms`: 'pending' if it hasn't settled (i.e. it is blocked on a lock). */
const stateAfter = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

let fixture: { userId: string; projectId: string } | null = null;
let seq = 0;
async function setup() {
  const { prisma } = load();
  if (!fixture) {
    const tag = randomUUID().slice(0, 8);
    const user = await prisma.user.create({ data: { email: `noowner-${tag}@example.com`, name: `Owner ${tag}` } });
    const project = await prisma.project.create({ data: { name: `No-owner race ${tag}`, code: `NOR${tag}`, startAlertsEnabled: true } });
    fixture = { userId: user.id, projectId: project.id };
  }
  return fixture;
}
/** A due task with no owner, optionally with its no-owner notice already recorded. */
async function waitingTask(noticeRecorded = false) {
  const { prisma } = load();
  const { projectId } = await setup();
  const t = await prisma.task.create({ data: { projectId, system: 'FOL', taskName: `Waiting ${++seq}`, sequenceNumber: seq, status: 'Pending' } });
  if (noticeRecorded) await prisma.taskAlert.create({ data: { taskId: t.id, status: 'NO_OWNER', recipient: RM, sentAt: new Date() } });
  return t.id as string;
}
const alertOf = (id: string) => load().prisma.taskAlert.findUnique({ where: { taskId: id } });
const taskOf = (id: string) => load().prisma.task.findUnique({ where: { id } });
/** The invariant this fix is about: an owned task never keeps a "no owner" alert. */
async function assertNoStaleNoOwner(id: string) {
  const [t, a] = await Promise.all([taskOf(id), alertOf(id)]);
  if (t?.assignedUserId) {
    assert.notEqual(a?.status, 'NO_OWNER', 'owned task must not show "no owner"');
    assert.equal(a?.reminderSentAt ?? null, null, 'owned task must not record a no-owner reminder');
  }
}

test('A. owner assigned (committed) before finalization → not recorded, row cleaned up', { skip }, async () => {
  const { claims, taskService } = load();
  const { userId } = await setup();
  const id = await waitingTask();
  const claimedAt = await claims.claimManagerNotice(id, 'notice', RM);
  assert.ok(claimedAt);
  await taskService.update(id, { assignedUserId: userId });
  assert.equal(await claims.completeManagerNotice(id, 'notice', claimedAt, RM), 'owner_assigned');
  assert.equal(await alertOf(id), null);
  await assertNoStaleNoOwner(id);
});

test('B. owner change in progress (uncommitted) → finalization WAITS for it, then does not record', { skip }, async () => {
  const { prisma, claims } = load();
  const { userId } = await setup();
  const id = await waitingTask();
  const claimedAt = await claims.claimManagerNotice(id, 'notice', RM);
  let commit!: () => void;
  const gate = new Promise<void>((r) => { commit = r; });
  // Another transaction assigns the owner and keeps the row locked, uncommitted.
  const assigning = prisma.$transaction(async (tx: any) => {
    await tx.$executeRaw`UPDATE tasks SET assigned_user_id = ${userId}, updated_at = now() WHERE id = ${id}`;
    await gate;
  }, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  const finalizing = claims.completeManagerNotice(id, 'notice', claimedAt, RM);
  assert.equal(await stateAfter(finalizing, 500), 'pending', 'finalization must block on the task row lock');
  commit();
  await assigning;
  assert.equal(await finalizing, 'owner_assigned', 'after the owner change commits, it sees the owner');
  await assertNoStaleNoOwner(id);
});

test('B2. finalization and the real owner change at the same moment (20 rounds) → never "no owner" on an owned task', { skip }, async () => {
  const { claims, taskService } = load();
  const { userId } = await setup();
  const outcomes: Record<string, number> = {};
  for (let i = 0; i < 20; i++) {
    const id = await waitingTask();
    const claimedAt = await claims.claimManagerNotice(id, 'notice', RM);
    const [outcome] = await Promise.all([
      claims.completeManagerNotice(id, 'notice', claimedAt, RM),
      taskService.update(id, { assignedUserId: userId }),
    ]);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    assert.ok(['recorded', 'owner_assigned'].includes(outcome), outcome);
    await assertNoStaleNoOwner(id);
  }
  // Both orders are legitimate; either way the final state is consistent.
  assert.equal((outcomes.recorded ?? 0) + (outcomes.owner_assigned ?? 0), 20, JSON.stringify(outcomes));
});

test('C. reminder vs owner change in progress → waits, reminder not recorded', { skip }, async () => {
  const { prisma, claims, taskService } = load();
  const { userId } = await setup();
  const id = await waitingTask(true);
  const claimedAt = await claims.claimManagerNotice(id, 'reminder', RM);
  assert.ok(claimedAt);
  let commit!: () => void;
  const gate = new Promise<void>((r) => { commit = r; });
  const assigning = prisma.$transaction(async (tx: any) => {
    await tx.$executeRaw`UPDATE tasks SET assigned_user_id = ${userId}, updated_at = now() WHERE id = ${id}`;
    await gate;
  }, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 200));
  const finalizing = claims.completeManagerNotice(id, 'reminder', claimedAt, RM);
  assert.equal(await stateAfter(finalizing, 500), 'pending');
  commit();
  await assigning;
  assert.equal(await finalizing, 'owner_assigned');
  await assertNoStaleNoOwner(id);
  // and the concurrent version with the real owner change, 10 rounds
  for (let i = 0; i < 10; i++) {
    const t = await waitingTask(true);
    const c = await claims.claimManagerNotice(t, 'reminder', RM);
    await Promise.all([claims.completeManagerNotice(t, 'reminder', c, RM), taskService.update(t, { assignedUserId: userId })]);
    await assertNoStaleNoOwner(t);
  }
});

test('D. another worker took the claim over → our finalization and release leave it untouched', { skip }, async () => {
  const { prisma, claims } = load();
  const id = await waitingTask();
  const ours = await claims.claimManagerNotice(id, 'notice', RM);
  const theirs = new Date(ours.getTime() + 60_000);
  await prisma.$executeRaw`UPDATE task_alerts SET claimed_at = ${theirs} WHERE task_id = ${id}`; // their newer claim
  assert.equal(await claims.completeManagerNotice(id, 'notice', ours, RM), 'claim_lost');
  await claims.releaseManagerNotice(id, 'notice', ours);
  const a = await alertOf(id);
  assert.equal(a.claimUserId, 'release-manager:no-owner');
  assert.equal(a.claimedAt.getTime(), theirs.getTime());
  assert.notEqual(a.status, 'NO_OWNER');
});

test('E. after the owner is assigned, the start alert can claim at once and is never overwritten', { skip }, async () => {
  const { prisma, claims, taskService } = load();
  const { userId } = await setup();
  const id = await waitingTask();
  const noticeClaim = await claims.claimManagerNotice(id, 'notice', RM);
  await taskService.update(id, { assignedUserId: userId });
  assert.equal(await claims.completeManagerNotice(id, 'notice', noticeClaim, RM), 'owner_assigned');
  await prisma.$executeRaw`UPDATE tasks SET status = 'Triggered' WHERE id = ${id}`;
  const startClaim = await claims.claimStartAlert(id, userId, 'owner@example.com');
  assert.ok(startClaim, 'start alert claims immediately (no leftover no-owner claim)');
  // Late calls with the old no-owner claim change nothing.
  assert.equal(await claims.completeManagerNotice(id, 'notice', noticeClaim, RM), 'claim_lost');
  await claims.releaseManagerNotice(id, 'notice', noticeClaim);
  const a = await alertOf(id);
  assert.equal(a.claimUserId, userId);
  assert.equal(a.claimedAt.getTime(), startClaim.getTime());
  assert.equal(a.status, 'SENDING');
  // A new no-owner claim can't take it either (task has an owner, and the claim is live).
  assert.equal(await claims.claimManagerNotice(id, 'notice', RM), null);
});

test('F. task marked N/A (no owner) during the send → task_no_longer_eligible, not owner_assigned', { skip }, async () => {
  const { claims, taskService } = load();
  const id = await waitingTask();
  const claimedAt = await claims.claimManagerNotice(id, 'notice', RM);
  await taskService.update(id, { status: 'N/A' });
  assert.equal(await claims.completeManagerNotice(id, 'notice', claimedAt, RM), 'task_no_longer_eligible');
  assert.equal(await alertOf(id), null);
});

test('G. failed send: our claim is released and the retry can claim and record', { skip }, async () => {
  const { claims } = load();
  const id = await waitingTask();
  const first = await claims.claimManagerNotice(id, 'notice', RM);
  await claims.releaseManagerNotice(id, 'notice', first); // what the processor does when the send throws
  const retry = await claims.claimManagerNotice(id, 'notice', RM);
  assert.ok(retry, 'the BullMQ retry can claim again');
  assert.equal(await claims.completeManagerNotice(id, 'notice', retry, RM), 'recorded');
  const a = await alertOf(id);
  assert.equal(a.status, 'NO_OWNER');
  assert.equal(a.claimUserId, null);
});

test('recorded then assigned (the other legitimate order) → the owner change clears "no owner"', { skip }, async () => {
  const { claims, taskService } = load();
  const { userId } = await setup();
  const id = await waitingTask();
  const claimedAt = await claims.claimManagerNotice(id, 'notice', RM);
  assert.equal(await claims.completeManagerNotice(id, 'notice', claimedAt, RM), 'recorded');
  assert.equal((await alertOf(id)).status, 'NO_OWNER');
  await taskService.update(id, { assignedUserId: userId });
  assert.equal(await alertOf(id), null);
});

after(async () => {
  if (!url) return;
  const { prisma } = load();
  if (fixture) {
    await prisma.project.deleteMany({ where: { id: fixture.projectId } });
    await prisma.user.deleteMany({ where: { id: fixture.userId } });
  }
  const q = require('../src/services/queueService');
  await Promise.allSettled([q.taskQueue.close(), q.emailQueue.close(), prisma.$disconnect(), require('../../worker/src/config/prisma').$disconnect()]);
});
