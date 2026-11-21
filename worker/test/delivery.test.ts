// Recoverable email delivery: crash recovery (abandoned claims), concurrent workers,
// reassignment during processing, retries. No database or network: see fakeDb.ts.
import { test, mock, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb, LEASE_MS, type FakeState } from './fakeDb';

process.env.EMAIL_DOMAIN = 'tilli.pro';
process.env.ALERT_ALLOWED_DOMAINS = 'tilli.pro';
process.env.ALERT_REPLY_TO = 'release-management@tilli.pro';
process.env.ALERT_RELEASE_MANAGER_EMAIL = 'release-management@tilli.pro';

const prisma = require('../src/config/prisma');
const { transporter } = require('../src/services/emailService');
const emailProcessor = require('../src/processors/emailProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;
const { LEASE_MS: REAL_LEASE } = require('../src/services/deliveryClaims');

afterEach(() => mock.restoreAll());
after(() => require('../src/config/redis').disconnect());

const owner = (id: string) => ({ id, email: `${id}@tilli.pro`, name: `Person ${id}` });
const loadedTask = (status: string, ownerId: string) => ({
  id: 't1', sequenceNumber: 4, taskName: 'Deploy release', system: 'Web app', status, assignedTeam: 'Dev',
  plannedStartTime: new Date(), plannedEndTime: new Date(Date.now() - 60_000), notes: null, description: null, projectId: 'p1',
  assignedUser: owner(ownerId), project: { code: 'REL', name: 'Release', timeZone: 'America/Chicago' }, dependsOn: [],
});
const job = (type: string, attemptsMade = 0) => ({ id: 'j', name: 'send-email', data: { taskId: 't1', type, ownerId: 'u1' }, attemptsMade, opts: { attempts: 5 } });
const mailbox = () => mock.method(transporter, 'sendMail', async (m: { to: string }) => ({ messageId: `<${m.to}>` }));
const old = () => new Date(Date.now() - LEASE_MS - 1000);

function alertDb(over: { task?: Record<string, unknown>; alert?: Record<string, unknown> | null } = {}): FakeState {
  const state: FakeState = {
    task: { id: 't1', status: 'Triggered', assignedUserId: 'u1', ...over.task },
    alert: over.alert === null ? null : { status: 'SENDING', recipient: 'u1@tilli.pro', notifiedUserIds: [], claimUserId: null, claimedAt: null, ...over.alert },
    loaded: () => loadedTask(state.task.status, 'u1'),
  };
  return installFakeDb(prisma, state);
}
function completionDb(task: Record<string, unknown> = {}): FakeState {
  const state: FakeState = {
    task: { id: 't1', status: 'Acknowledged', assignedUserId: 'u1', completionEmailSentAt: null, completionEmailStatus: null, completionEmailClaimedAt: null, ...task },
    alert: null,
    loaded: () => loadedTask('Acknowledged', 'u1'),
  };
  return installFakeDb(prisma, state);
}

test('the lease used by the tests is the real one', () => assert.equal(REAL_LEASE, LEASE_MS));

// ── Start-time alert ────────────────────────────────────────────────────────

test('start alert: recorded as sent only after the provider accepted it', async () => {
  const db = alertDb({ alert: null });
  const mail = mailbox();
  assert.equal((await emailProcessor(job('triggered'))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1']);
  assert.equal(db.alert!.status, 'SENT');
  assert.equal(db.alert!.claimUserId, null);
});

test('start alert: a claim left by a crashed worker is taken over after the lease', async () => {
  const db = alertDb({ alert: { claimUserId: 'u1', claimedAt: old() } }); // crashed mid-send
  const mail = mailbox();
  assert.equal((await emailProcessor(job('triggered'))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1']);
});

test('start alert: a live claim held by another worker makes this job retry, not skip', async () => {
  alertDb({ alert: { claimUserId: 'u1', claimedAt: new Date() } });
  const mail = mailbox();
  await assert.rejects(emailProcessor(job('triggered')), /another worker/);
  assert.equal(mail.mock.callCount(), 0);
});

test('start alert: 5 workers at once send one email', async () => {
  const db = alertDb({ alert: null });
  const mail = mailbox();
  const results = await Promise.allSettled([1, 2, 3, 4, 5].map(() => emailProcessor(job('triggered'))));
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(results.filter((r) => r.status === 'fulfilled' && r.value.status === 'sent').length, 1);
  assert.deepEqual(db.alert!.notifiedUserIds, ['u1']);
});

test('start alert: reassigned after the task was loaded → the old owner is not emailed', async () => {
  const db = alertDb();
  const mail = mailbox();
  const run = emailProcessor(job('triggered'));
  db.task.assignedUserId = 'u2'; // reassigned while the worker is working
  const r = await run;
  assert.equal(r.reason, 'owner_changed');
  assert.equal(mail.mock.callCount(), 0);
  assert.equal(db.alert!.claimUserId, null, 'no claim left behind');
});

test('start alert: a failed send releases the claim; the retry sends', async () => {
  const db = alertDb();
  mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });
  await assert.rejects(emailProcessor(job('triggered')));
  assert.equal(db.alert!.claimUserId, null);
  assert.equal(db.alert!.status, 'RETRYING');
  mock.restoreAll();
  const mail = mailbox();
  assert.equal((await emailProcessor(job('triggered', 1))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
});

// ── Completion email ────────────────────────────────────────────────────────

test('completion: recorded as SENT only after the provider accepted it', async () => {
  const db = completionDb();
  const mail = mailbox();
  assert.equal((await emailProcessor(job('completion'))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(db.task.completionEmailStatus, 'SENT');
  assert.ok(db.task.completionEmailSentAt instanceof Date);
  assert.equal(db.task.completionEmailClaimedAt, null);
});

test('completion: a crash after claiming is recovered after the lease (not lost)', async () => {
  const db = completionDb({ completionEmailStatus: 'SENDING', completionEmailClaimedAt: old() });
  const mail = mailbox();
  assert.equal((await emailProcessor(job('completion'))).status, 'sent');
  assert.equal(mail.mock.callCount(), 1);
  assert.equal(db.task.completionEmailStatus, 'SENT');
});

test('completion: a live claim makes the job retry; nothing is sent twice', async () => {
  completionDb({ completionEmailStatus: 'SENDING', completionEmailClaimedAt: new Date() });
  const mail = mailbox();
  await assert.rejects(emailProcessor(job('completion')), /another worker/);
  assert.equal(mail.mock.callCount(), 0);
});

test('completion: 5 workers at once send one email', async () => {
  completionDb();
  const mail = mailbox();
  await Promise.allSettled([1, 2, 3, 4, 5].map(() => emailProcessor(job('completion'))));
  assert.equal(mail.mock.callCount(), 1);
});

test('completion: reassigned after loading → not sent to the old owner (retried with fresh data)', async () => {
  const db = completionDb();
  const mail = mailbox();
  const run = emailProcessor(job('completion'));
  db.task.assignedUserId = 'u2';
  await assert.rejects(run, /fresh data/);
  assert.equal(mail.mock.callCount(), 0);
  assert.equal(db.task.completionEmailClaimedAt, null);
  assert.equal(db.task.completionEmailStatus, null);
});

test('completion: failed send is released for the retry; FAILED after the last attempt', async () => {
  const db = completionDb();
  mock.method(transporter, 'sendMail', async () => { throw new Error('smtp down'); });
  await assert.rejects(emailProcessor(job('completion', 0)));
  assert.equal(db.task.completionEmailStatus, null);
  assert.equal(db.task.completionEmailClaimedAt, null);
  await assert.rejects(emailProcessor(job('completion', 4))); // 5th of 5 attempts
  assert.equal(db.task.completionEmailStatus, 'FAILED');
  mock.restoreAll();
  const mail = mailbox();
  assert.equal((await emailProcessor(job('completion', 0))).reason, 'already_sent', 'FAILED is final: no automatic resend');
  assert.equal(mail.mock.callCount(), 0);
});
