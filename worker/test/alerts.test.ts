// Regression tests for PR #7 review items 3 and 4, and reviewer decision 2.
// Run: npm test   (Node's built-in test runner via tsx; no database or network needed)
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.EMAIL_DOMAIN = 'tilli.pro';
process.env.ALERT_ALLOWED_DOMAINS = 'tilli.pro';
process.env.ALERT_REPLY_TO = 'release-management@tilli.pro';
process.env.MICROSOFT_CLIENT_ID = 'test-client';
process.env.MICROSOFT_CLIENT_SECRET = 'test-secret';
process.env.MICROSOFT_TENANT_ID = 'test-tenant';
process.env.MICROSOFT_MAIL_FROM = 'notifications@tilli.pro';

test('Microsoft 365 send includes reply-to (review item 4)', async () => {
  // Same (CommonJS) axios instance the service uses, so the mock is always in place and
  // the test never reaches the network.
  const axios = require('axios');
  const posted: Array<{ url: string; body: unknown }> = [];
  mock.method(axios, 'post', async (url: string, body: unknown) => {
    posted.push({ url, body });
    return url.includes('login.microsoftonline.com')
      ? { data: { access_token: 'token', expires_in: 3600 } }
      : { data: {} };
  });
  const { sendEmailViaGraph } = require('../src/services/graphEmailService');

  await sendEmailViaGraph('owner@tilli.pro', 'Subject', '<p>Hi</p>', 'release-management@tilli.pro');

  const sendMail = posted.find((p) => p.url.includes('/sendMail'));
  assert.ok(sendMail, 'sendMail was called');
  const message = (sendMail.body as { message: { replyTo?: Array<{ emailAddress: { address: string } }> } }).message;
  assert.deepEqual(message.replyTo, [{ emailAddress: { address: 'release-management@tilli.pro' } }]);
  mock.restoreAll();
});

test('a database error after a successful send does not cause a second email (review item 3)', async () => {
  const prisma = require('../src/config/prisma');
  const { transporter } = require('../src/services/emailService');
  const processor = require('../src/processors/emailProcessor') as (job: unknown) => Promise<{ status: string }>;
  // Prisma builds its model helpers on the fly, so swap in plain objects for this test.
  const fake = (name: string, methods: Record<string, unknown>) => Object.defineProperty(prisma, name, { value: methods, configurable: true });

  const task = {
    id: 't1', sequenceNumber: 4, taskName: 'Run database migration', system: 'SAP S4', status: 'Triggered',
    assignedTeam: 'DBA', plannedStartTime: new Date(), plannedEndTime: new Date(Date.now() + 3600_000),
    notes: null, description: null, projectId: 'p1',
    assignedUser: { id: 'u1', email: 'owner@tilli.pro', name: 'Priya Nair' },
    project: { code: 'Q3', name: 'Q3 release' },
    dependsOn: [],
  };
  // The claim (before sending) works; the status save after sending fails.
  const update = mock.fn(async () => { throw new Error('database unavailable'); });
  fake('task', { findUnique: async () => task });
  fake('taskAlert', { findUnique: async () => null, createMany: async () => ({ count: 1 }), update });
  fake('$executeRaw', async () => 1);
  fake('auditLog', { create: async () => ({}) });
  const sendMail = mock.method(transporter, 'sendMail', async () => ({ messageId: '<m1@test>' }));

  const job = { id: 'j1', data: { taskId: 't1', type: 'triggered' }, attemptsMade: 0, opts: { attempts: 5 } };
  const result = await processor(job); // must not throw → BullMQ will not retry

  assert.equal(result.status, 'sent');
  assert.equal(sendMail.mock.callCount(), 1, 'email sent exactly once');
  assert.equal(update.mock.callCount(), 1, 'status save attempted once, failure only logged');
  mock.restoreAll();
});

test('a due task with no owner is held, not started (reviewer decision 2)', async () => {
  const prisma = require('../src/config/prisma');
  const processor = require('../src/processors/taskProcessor') as (job: unknown) => Promise<{ status: string; reason?: string }>;
  const update = mock.fn(async () => ({}));
  Object.defineProperty(prisma, 'task', {
    value: { findUnique: async () => ({ status: 'Pending', assignedUserId: null, project: { startAlertsEnabled: true } }), update },
    configurable: true,
  });

  const result = await processor({ id: 'j2', name: 'process-task', data: { taskId: 't2' } });

  assert.equal(result.status, 'held');
  assert.equal(result.reason, 'no_owner');
  assert.equal(update.mock.callCount(), 0, 'status not changed');
  mock.restoreAll();
  // The processor loads the email queue; close its Redis connections so the test run can exit.
  await require('../src/services/emailProducer').close();
  require('../src/config/redis').disconnect();
});
