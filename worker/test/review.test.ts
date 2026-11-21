// Reviewer follow-up (PR #7): the worker's Pending → Triggered step never overwrites a
// change made meanwhile, and the no-owner notice / reminder are recorded only after the
// email really went out (a failed send is retried). No database or network: faked.
import { test, mock, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from 'bullmq';
import { installFakeDb, LEASE_MS, type FakeState } from './fakeDb';

process.env.EMAIL_DOMAIN = 'tilli.pro';
process.env.ALERT_ALLOWED_DOMAINS = 'tilli.pro';
process.env.ALERT_RELEASE_MANAGER_EMAIL = 'release-management@tilli.pro';

const prisma = require('../src/config/prisma');
const { transporter } = require('../src/services/emailService');
const emailProducer = require('../src/services/emailProducer');
const emailProcessor = require('../src/processors/emailProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;
const taskProcessor = require('../src/processors/taskProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;

const fake = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value, configurable: true });
afterEach(() => mock.restoreAll());
after(async () => {
  await emailProducer.close();
  require('../src/config/redis').disconnect();
});

// ── Pending → Triggered ─────────────────────────────────────────────────────

function triggerDb(row: { status: string; assignedUserId: string | null }) {
  const audit = mock.fn(async () => ({}));
  fake('task', {
    findUnique: async () => ({ ...row, projectId: 'p1', project: { startAlertsEnabled: true } }),
    // The conditional save: only while still Pending with the same owner.
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (row.status !== where.status || row.assignedUserId !== where.assignedUserId) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  });
  fake('taskDependency', { findMany: async () => [] });
  fake('auditLog', { create: audit });
  fake('$transaction', async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  return { row, audit };
}
const triggerJob = { id: 'j', name: 'process-task', data: { taskId: 't1' }, attemptsMade: 0, opts: { attempts: 3 } };

test('trigger: a Pending task becomes Triggered and its alert is queued', async () => {
  const { row, audit } = triggerDb({ status: 'Pending', assignedUserId: 'u1' });
  const add = mock.method(Queue.prototype, 'add', async () => ({}));
  const r = await taskProcessor(triggerJob);
  assert.equal(r.status, 'triggered');
  assert.equal(row.status, 'Triggered');
  assert.equal(audit.mock.callCount(), 1);
  assert.equal(add.mock.callCount(), 1);
});

test('trigger: marked N/A after the worker read it → not overwritten, no alert', async () => {
  const { row, audit } = triggerDb({ status: 'Pending', assignedUserId: 'u1' });
  const add = mock.method(Queue.prototype, 'add', async () => ({}));
  const findUnique = prisma.task.findUnique;
  // The planner marks it N/A right after the worker loaded it (between read and save).
  prisma.task.findUnique = async (...a: unknown[]) => { const t = await findUnique(...a); row.status = 'N/A'; return t; };
  const r = await taskProcessor(triggerJob);
  assert.equal(r.reason, 'changed_meanwhile');
  assert.equal(row.status, 'N/A');
  assert.equal(audit.mock.callCount(), 0, 'no history entry for a change that did not happen');
  assert.equal(add.mock.callCount(), 0, 'no alert queued');
});

test('trigger: reassigned after the worker read it → not triggered for the old owner', async () => {
  const { row } = triggerDb({ status: 'Pending', assignedUserId: 'u1' });
  const add = mock.method(Queue.prototype, 'add', async () => ({}));
  const findUnique = prisma.task.findUnique;
  prisma.task.findUnique = async (...a: unknown[]) => { const t = await findUnique(...a); row.assignedUserId = 'u2'; return t; };
  assert.equal((await taskProcessor(triggerJob)).reason, 'changed_meanwhile');
  assert.equal(row.status, 'Pending');
  assert.equal(add.mock.callCount(), 0);
});

// ── No-owner notice and reminder ────────────────────────────────────────────

const heldTask = {
  id: 't1', sequenceNumber: 4, taskName: 'Deploy release', system: 'Web app', status: 'Pending', assignedTeam: 'Dev',
  plannedStartTime: new Date(), plannedEndTime: new Date(Date.now() + 3600_000), notes: null, description: null, projectId: 'p1',
  assignedUser: null, project: { code: 'REL', name: 'Release', timeZone: 'America/Chicago' }, dependsOn: [],
};
const emailJob = (type: string, attemptsMade = 0) => ({ id: 'j', name: 'send-email', data: { taskId: 't1', type }, attemptsMade, opts: { attempts: 5 } });
const RM = 'release-management@tilli.pro';
const old = () => new Date(Date.now() - LEASE_MS - 1000);

/** Fake database (fakeDb.ts): task t1 is waiting with no owner; `alert` is its task_alerts row. */
function noOwnerDb(alert: Record<string, unknown> | null, task: Record<string, unknown> = {}) {
  const state: FakeState = {
    task: { id: 't1', status: 'Pending', assignedUserId: null, ...task },
    alert: alert && { notifiedUserIds: [], claimUserId: null, claimedAt: null, reminderSentAt: null, ...alert },
    loaded: () => ({ ...heldTask, status: state.task.status }),
  };
  return installFakeDb(prisma, state);
}
// The send takes a moment (like a real mail server), so concurrent jobs really overlap.
const mailbox = () => mock.method(transporter, 'sendMail', async () => { await new Promise((r) => setTimeout(r, 5)); return { messageId: '<m@test>' }; });
const smtpDown = () => mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });

test('no-owner notice: a failed send is NOT recorded and the job retries; the retry sends and records', async () => {
  const db = noOwnerDb(null);
  smtpDown();
  await assert.rejects(emailProcessor(emailJob('no_owner')), /smtp down/);
  assert.notEqual(db.alert!.status, 'NO_OWNER', 'not recorded as told');
  assert.equal(db.alert!.claimUserId, null, 'claim released for the retry');
  mock.restoreAll();
  const mail = mailbox();
  assert.equal((await emailProcessor(emailJob('no_owner', 1))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(mail.mock.calls[0]!.arguments[0].to, RM);
  assert.equal(db.alert!.status, 'NO_OWNER');
});

test('no-owner reminder: a failed send is NOT recorded and the job retries; the retry sends', async () => {
  const db = noOwnerDb({ status: 'NO_OWNER', sentAt: new Date() });
  smtpDown();
  await assert.rejects(emailProcessor(emailJob('no_owner_reminder')), /smtp down/);
  assert.equal(db.alert!.reminderSentAt, null);
  mock.restoreAll();
  const mail = mailbox();
  assert.equal((await emailProcessor(emailJob('no_owner_reminder', 1))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.ok(db.alert!.reminderSentAt instanceof Date);
});

test('two notice jobs at the same moment: Release Management is told once', async () => {
  const db = noOwnerDb(null);
  const mail = mailbox();
  const results = await Promise.allSettled([1, 2, 3].map(() => emailProcessor(emailJob('no_owner'))));
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.status === 'sent').length, 1);
  assert.equal(db.alert!.status, 'NO_OWNER');
});

test('two reminder jobs at the same moment: one reminder', async () => {
  noOwnerDb({ status: 'NO_OWNER', sentAt: new Date() });
  const mail = mailbox();
  await Promise.allSettled([1, 2, 3].map(() => emailProcessor(emailJob('no_owner_reminder'))));
  assert.equal(mail.mock.callCount(), 1);
});

test('a claim left by a crashed worker is taken over after the lease; a live one makes the job retry', async () => {
  let db = noOwnerDb({ status: 'SENDING', claimUserId: 'release-manager:no-owner', claimedAt: new Date() });
  let mail = mailbox();
  await assert.rejects(emailProcessor(emailJob('no_owner')), /another worker/);
  assert.equal(mail.mock.callCount(), 0);
  mock.restoreAll();
  db = noOwnerDb({ status: 'SENDING', claimUserId: 'release-manager:no-owner', claimedAt: old() });
  mail = mailbox();
  assert.equal((await emailProcessor(emailJob('no_owner'))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(db.alert!.status, 'NO_OWNER');
});

test('email sent but recording fails: not thrown (no immediate resend), and the claim protects for the lease', async () => {
  const db = noOwnerDb(null);
  db.failRecord = true;
  const mail = mailbox();
  assert.equal((await emailProcessor(emailJob('no_owner'))).status, 'sent', 'no throw, so BullMQ does not resend it');
  assert.equal(mail.mock.callCount(), 1);
  // A second job right away sees the live claim and retries later instead of sending.
  await assert.rejects(emailProcessor(emailJob('no_owner')), /another worker/);
  assert.equal(mail.mock.callCount(), 1);
});

test('an owner assigned meanwhile: no notice', async () => {
  noOwnerDb(null, { assignedUserId: 'u1' });
  const mail = mailbox();
  const r = await emailProcessor(emailJob('no_owner'));
  assert.equal(r.status, 'skipped');
  assert.equal(mail.mock.callCount(), 0);
});

test('start-alert path with no owner uses the same claimed notice (sent first, then recorded)', async () => {
  const db = noOwnerDb(null, { status: 'Triggered' });
  smtpDown();
  await assert.rejects(emailProcessor(emailJob('triggered')), /smtp down/);
  assert.notEqual(db.alert!.status, 'NO_OWNER', 'a failed send is not recorded');
  mock.restoreAll();
  const mail = mailbox();
  assert.equal((await emailProcessor(emailJob('triggered', 1))).reason, 'no_owner');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(db.alert!.status, 'NO_OWNER');
});

// ── Link types in the emails the worker sends ───────────────────────────────

test('start-time email links are typed "ack", completion email links "complete" (and name the owner)', () => {
  const { buildCompleteUrl } = require('../src/services/emailService');
  const { buildStartAlert } = require('../src/services/alertEmail');
  const decode = (url: string) => JSON.parse(Buffer.from(new URL(url.replace('#/', '')).searchParams.get('token')!.split('.')[0]!, 'base64url').toString());
  const alert = buildStartAlert({ ...heldTask, status: 'Triggered', assignedUser: { id: 'u1', email: 'u1@tilli.pro', name: 'U1' } });
  const ackUrl = (alert.html as string).match(/https?:[^"']*acknowledge\?[^"']*/)![0].replace(/&amp;/g, '&');
  const ack = decode(ackUrl);
  assert.equal(ack.kind, 'ack');
  assert.equal(ack.uid, 'u1');
  const complete = decode(buildCompleteUrl('t1', 'u1', new Date()));
  assert.equal(complete.kind, 'complete');
  assert.equal(complete.uid, 'u1');
});

// ── No-owner notice finalization (ownership race) ───────────────────────────

/** A mail server that runs `during` while the email is being sent (between claim and record). */
const mailboxDuring = (during: () => void) =>
  mock.method(transporter, 'sendMail', async () => { during(); await new Promise((r) => setTimeout(r, 5)); return { messageId: '<m@test>' }; });

test('owner assigned while the notice is being sent: NOT recorded as "no owner", claim released', async () => {
  const db = noOwnerDb(null);
  const mail = mailboxDuring(() => { db.task.assignedUserId = 'u1'; });
  const r = await emailProcessor(emailJob('no_owner'));
  assert.equal(mail.mock.callCount(), 1, 'the email did go out');
  assert.equal(r.reason, 'owner_assigned_meanwhile');
  assert.notEqual(db.alert!.status, 'NO_OWNER', 'no "on hold, no owner" status for a task that has an owner');
  assert.equal(db.alert!.claimUserId, null, 'claim released, so a start alert for the new owner is not blocked');
  assert.equal(db.alert!.claimedAt, null);
});

test('owner assigned while the reminder is being sent: reminder not recorded, claim released', async () => {
  const db = noOwnerDb({ status: 'NO_OWNER', sentAt: new Date() });
  mailboxDuring(() => { db.task.assignedUserId = 'u1'; });
  assert.equal((await emailProcessor(emailJob('no_owner_reminder'))).reason, 'owner_assigned_meanwhile');
  assert.equal(db.alert!.reminderSentAt, null);
  assert.equal(db.alert!.claimUserId, null);
});

test('still no owner at the end: the notice is recorded (normal case)', async () => {
  const db = noOwnerDb(null);
  mailboxDuring(() => { /* nothing changes */ });
  assert.equal((await emailProcessor(emailJob('no_owner'))).status, 'sent');
  assert.equal(db.alert!.status, 'NO_OWNER');
  assert.equal(db.alert!.recipient, RM);
  assert.equal(db.alert!.claimUserId, null);
});

test('our claim was taken over by another worker during the send: their claim is left untouched', async () => {
  const db = noOwnerDb(null);
  const theirs = new Date(Date.now() + 1000);
  // Another worker took the (expired) claim over while ours was still sending.
  mailboxDuring(() => { db.alert!.claimUserId = 'release-manager:no-owner'; db.alert!.claimedAt = theirs; });
  await emailProcessor(emailJob('no_owner'));
  assert.equal(db.alert!.claimUserId, 'release-manager:no-owner');
  assert.equal((db.alert!.claimedAt as Date).getTime(), theirs.getTime(), 'their claim is not released or overwritten');
  assert.notEqual(db.alert!.status, 'NO_OWNER', 'we did not record over their claim');
});

test('a start-alert claim is never overwritten by a no-owner notice', async () => {
  // Owner assigned + task triggered: the start alert for u1 holds the claim during our send.
  const db = noOwnerDb(null);
  mailboxDuring(() => {
    db.task.assignedUserId = 'u1';
    Object.assign(db.alert!, { claimUserId: 'u1', claimedAt: new Date(Date.now() + 1000), status: 'SENDING', recipient: 'u1@tilli.pro' });
  });
  await emailProcessor(emailJob('no_owner'));
  assert.equal(db.alert!.claimUserId, 'u1', 'the start-alert claim is intact');
  assert.equal(db.alert!.recipient, 'u1@tilli.pro');
  assert.equal(db.alert!.status, 'SENDING');
  // and a notice job that starts while a start-alert claim is live doesn't send at all
  mock.restoreAll();
  const db2 = noOwnerDb({ status: 'SENDING', claimUserId: 'u1', claimedAt: new Date() });
  const mail = mailboxDuring(() => {});
  await assert.rejects(emailProcessor(emailJob('no_owner')), /another worker/);
  assert.equal(mail.mock.callCount(), 0);
  assert.equal(db2.alert!.claimUserId, 'u1');
});
