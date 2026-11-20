// Review follow-up: N/A in the worker's dependency check (item 8), one start alert per
// task per owner + email the new owner after a reassignment (item 3), and the single
// no-owner reminder (item 2). No database or network: Prisma and mail are faked.
import { test, mock, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from './fakeDb';

process.env.EMAIL_DOMAIN = 'tilli.pro';
process.env.ALERT_ALLOWED_DOMAINS = 'tilli.pro';
process.env.ALERT_REPLY_TO = 'release-management@tilli.pro';
process.env.ALERT_RELEASE_MANAGER_EMAIL = 'release-management@tilli.pro';

const prisma = require('../src/config/prisma');
const { transporter } = require('../src/services/emailService');
const emailProducer = require('../src/services/emailProducer');
const { canTaskExecute } = require('../src/services/dependencyChecker');
const emailProcessor = require('../src/processors/emailProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;
const taskProcessor = require('../src/processors/taskProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;

const fake = (name: string, methods: Record<string, unknown>) => Object.defineProperty(prisma, name, { value: methods, configurable: true });
const sent = () => mock.method(transporter, 'sendMail', async () => ({ messageId: '<m@test>' }));
afterEach(() => mock.restoreAll());
after(async () => {
  await emailProducer.close();
  require('../src/config/redis').disconnect();
});

const owner = (id: string) => ({ id, email: `${id}@tilli.pro`, name: `Person ${id}` });
const task = (over: Record<string, unknown> = {}) => ({
  id: 't1', sequenceNumber: 4, taskName: 'Deploy release', system: 'Web app', status: 'Triggered', assignedTeam: 'Dev',
  plannedStartTime: new Date(), plannedEndTime: new Date(Date.now() + 3600_000), notes: null, description: null, projectId: 'p1',
  assignedUser: owner('u2'), project: { code: 'REL', name: 'Release', timeZone: 'America/Chicago' }, dependsOn: [], ...over,
});
const job = (data: Record<string, unknown>, name = 'send-email') => ({ id: 'j', name, data, attemptsMade: 0, opts: { attempts: 5 } });

test('worker dependency check: N/A counts as done, Pending does not', async () => {
  for (const [status, executable] of [['N/A', true], ['Completed', true], ['Pending', false]] as const) {
    fake('task', { findUnique: async () => ({ id: 'B', projectId: 'P' }) });
    fake('taskDependency', { findMany: async () => [{ dependsOn: { id: 'A', taskName: 'Optional', status, projectId: 'P' } }] });
    assert.equal((await canTaskExecute('B')).executable, executable, status);
  }
});

/** The fake database (fakeDb.ts): task t1 is Triggered and owned by u2; u1 was emailed before. */
function reassignedDb() {
  const state = { task: { id: 't1', status: 'Triggered', assignedUserId: 'u2' }, alert: { status: 'SENT', recipient: 'u1@tilli.pro', notifiedUserIds: ['u1'], claimUserId: null, claimedAt: null } as Record<string, any>, loaded: () => task() };
  return installFakeDb(prisma, state);
}

test('reassigned ready task: the new owner gets the start alert', async () => {
  const db = reassignedDb();
  const mail = sent();
  const r = await emailProcessor(job({ taskId: 't1', type: 'triggered', ownerId: 'u2' }));
  assert.equal(r.status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(mail.mock.calls[0]!.arguments[0].to, 'u2@tilli.pro');
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1', 'u2']);
  assert.equal(db.alert!.status, 'SENT');
});

test('two workers handling the same alert at once send ONE email (audit fix)', async () => {
  const db = reassignedDb();
  const mail = sent();
  // The others either see "already alerted" or, while the winner is still sending,
  // fail with "being sent by another worker" so BullMQ retries them later.
  const results = await Promise.allSettled([1, 2, 3].map(() => emailProcessor(job({ taskId: 't1', type: 'triggered', ownerId: 'u2' }))));
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.status === 'sent').length, 1);
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1', 'u2']);
});

test('a failed send gives the claim back so the retry can send', async () => {
  const db = reassignedDb();
  mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });
  await assert.rejects(emailProcessor(job({ taskId: 't1', type: 'triggered', ownerId: 'u2' })));
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1']);
  assert.equal(db.alert!.claimUserId, null);
  mock.restoreAll();
});

test('one alert per task per owner: an owner already emailed is not emailed again', async () => {
  fake('task', { findUnique: async () => task({ assignedUser: owner('u1') }) }); // reassigned back to u1
  fake('taskAlert', { findUnique: async () => ({ status: 'SENT', recipient: 'u2@tilli.pro', notifiedUserIds: ['u1', 'u2'] }), upsert: async () => ({}) });
  fake('auditLog', { create: async () => ({}) });
  const mail = sent();
  const r = await emailProcessor(job({ taskId: 't1', type: 'triggered', ownerId: 'u1' }));
  assert.equal(r.reason, 'already_alerted');
  assert.equal(mail.mock.callCount(), 0);
});

test('reassignment job: only for a ready task with alerts on, for the current owner', async () => {
  const { Queue } = require('bullmq');
  const add = mock.method(Queue.prototype, 'add', async () => ({}));
  const cases: [Record<string, unknown>, string][] = [
    [{ status: 'Triggered', assignedUserId: 'u2', project: { startAlertsEnabled: true } }, 'triggered'],
    [{ status: 'Triggered', assignedUserId: 'u2', project: { startAlertsEnabled: false } }, 'alerts_off'],
    [{ status: 'Pending', assignedUserId: 'u2', project: { startAlertsEnabled: true } }, 'not_ready'],
    [{ status: 'Triggered', assignedUserId: 'u3', project: { startAlertsEnabled: true } }, 'owner_changed_again'],
  ];
  for (const [row, expected] of cases) {
    fake('task', { findUnique: async () => row });
    const r = await taskProcessor(job({ taskId: 't1', assignedUserId: 'u2' }, 'process-reassigned'));
    assert.equal(r.reason ?? r.status, expected, JSON.stringify(row));
  }
  assert.equal(add.mock.callCount(), 1, 'email queued only in the first case');
  const [name, data, opts] = add.mock.calls[0]!.arguments as [string, unknown, { jobId: string }];
  assert.equal(name, 'send-email');
  assert.deepEqual(data, { taskId: 't1', type: 'triggered', ownerId: 'u2' });
  assert.equal(opts.jobId, 'email-t1-triggered-u2', 'one job per task per owner');
});

test('no-owner reminder: sent once, never after an owner is assigned', async () => {
  const update = mock.fn(async () => ({}));
  fake('auditLog', { create: async () => ({}) });
  // still no owner, first reminder → sent to Release Management
  fake('task', { findUnique: async () => task({ status: 'Pending', assignedUser: null }) });
  fake('taskAlert', { findUnique: async () => ({ status: 'NO_OWNER', reminderSentAt: null }), update });
  let mail = sent();
  assert.equal((await emailProcessor(job({ taskId: 't1', type: 'no_owner_reminder' }))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(mail.mock.calls[0]!.arguments[0].to, 'release-management@tilli.pro');
  assert.match(mail.mock.calls[0]!.arguments[0].subject, /Reminder/);
  assert.equal(update.mock.callCount(), 1, 'reminder time saved');
  mock.restoreAll();
  // already reminded → nothing
  fake('taskAlert', { findUnique: async () => ({ status: 'NO_OWNER', reminderSentAt: new Date() }), update });
  mail = sent();
  assert.equal((await emailProcessor(job({ taskId: 't1', type: 'no_owner_reminder' }))).reason, 'already_reminded');
  assert.equal(mail.mock.callCount(), 0);
  mock.restoreAll();
  // owner assigned meanwhile → nothing
  fake('task', { findUnique: async () => task({ status: 'Pending', assignedUser: owner('u1') }) });
  mail = sent();
  assert.equal((await emailProcessor(job({ taskId: 't1', type: 'no_owner_reminder' }))).reason, 'owner_assigned');
  assert.equal(mail.mock.callCount(), 0);
});
