// Reviewer follow-up (PR #7): the worker's Pending → Triggered step never overwrites a
// change made meanwhile, and the no-owner notice / reminder are recorded only after the
// email really went out (a failed send is retried). No database or network: faked.
import { test, mock, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Queue } from 'bullmq';

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

function noOwnerDb(alert: Record<string, unknown> | null) {
  const state = { alert };
  fake('task', { findUnique: async () => heldTask });
  fake('auditLog', { create: async () => ({}) });
  fake('taskAlert', {
    findUnique: async () => state.alert,
    upsert: async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => (state.alert = state.alert ? { ...state.alert, ...update } : create),
    update: async ({ data }: { data: Record<string, unknown> }) => (state.alert = { ...state.alert, ...data }),
  });
  return state;
}

test('no-owner notice: a failed send is NOT recorded and the job retries; the retry sends and records', async () => {
  const db = noOwnerDb(null);
  mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });
  await assert.rejects(emailProcessor(emailJob('no_owner')), /smtp down/);
  assert.equal(db.alert, null, 'nothing recorded, so the retry will send it');
  mock.restoreAll();
  noOwnerDb(db.alert);
  const mail = mock.method(transporter, 'sendMail', async () => ({ messageId: '<m@test>' }));
  assert.equal((await emailProcessor(emailJob('no_owner', 1))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(mail.mock.calls[0]!.arguments[0].to, 'release-management@tilli.pro');
});

test('no-owner reminder: a failed send is NOT recorded and the job retries', async () => {
  const db = noOwnerDb({ status: 'NO_OWNER', reminderSentAt: null });
  mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });
  await assert.rejects(emailProcessor(emailJob('no_owner_reminder')), /smtp down/);
  assert.equal((db.alert as { reminderSentAt: unknown }).reminderSentAt, null);
  mock.restoreAll();
  const mail = mock.method(transporter, 'sendMail', async () => ({ messageId: '<m@test>' }));
  assert.equal((await emailProcessor(emailJob('no_owner_reminder', 1))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.ok((db.alert as { reminderSentAt: unknown }).reminderSentAt instanceof Date);
});
