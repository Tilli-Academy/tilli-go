// Email-link tokens and upload checks (audit fixes). Run: npm test (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.ACK_TOKEN_SECRET ??= 'test-ack-secret';
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';

const { checkLinkToken, ownerMismatch, readLinkParams } = require('../src/utils/emailLink');
const { checkUpload } = require('../src/utils/fileType');

const SECRET = process.env.ACK_TOKEN_SECRET!;
function sign(payload: object, secret = SECRET): string {
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${p}.${crypto.createHmac('sha256', secret).update(p).digest('base64url')}`;
}
const hour = 3600_000;

// ── Email-link tokens ───────────────────────────────────────────────────────
test('a valid link token is accepted', () => {
  const { data, fail } = checkLinkToken('t1', sign({ taskId: 't1', exp: Date.now() + hour, uid: 'u1' }));
  assert.equal(fail, undefined);
  assert.equal(data.uid, 'u1');
});

test('expired, tampered, malformed, wrong-task and missing tokens are refused', () => {
  const good = sign({ taskId: 't1', exp: Date.now() + hour, uid: 'u1' });
  const cases: Array<[string, string | undefined, string]> = [
    ['expired', sign({ taskId: 't1', exp: Date.now() - 1, uid: 'u1' }), 'Token expired'],
    ['signed with another secret', sign({ taskId: 't1', exp: Date.now() + hour, uid: 'u1' }, 'not-the-secret'), 'Invalid token signature'],
    ['payload edited after signing', `${Buffer.from(JSON.stringify({ taskId: 't1', exp: Date.now() + hour, uid: 'attacker' })).toString('base64url')}.${good.split('.')[1]}`, 'Invalid token signature'],
    ['malformed', 'not-a-token', 'Malformed token'],
    ['for another task', sign({ taskId: 't2', exp: Date.now() + hour, uid: 'u1' }), 'Token task ID mismatch'],
  ];
  for (const [name, token, error] of cases) {
    const { fail } = checkLinkToken('t1', token);
    assert.equal(fail?.status, 403, name);
    assert.equal(fail?.body.error, error, name);
  }
  assert.equal(checkLinkToken('t1', undefined).fail.status, 400);
});

test('a link must name the current owner (owner-less and old-owner links are refused)', () => {
  assert.equal(ownerMismatch({ taskId: 't1', exp: 0 }, 'u1')?.status, 403);
  assert.match(ownerMismatch({ taskId: 't1', exp: 0, uid: 'old' }, 'u1')?.body.error, /previous owner/);
  assert.equal(ownerMismatch({ taskId: 't1', exp: 0, uid: 'u1' }, 'u1'), null);
});

test('the token is read from the X-Link-Token header or the POST body, not only the URL', () => {
  const req = (headers: Record<string, string>, body?: object, query: object = {}) =>
    ({ get: (h: string) => headers[h.toLowerCase()], body, query }) as never;
  assert.deepEqual(readLinkParams(req({ 'x-link-token': 'H' }, undefined, { task_id: 't1' })), { taskId: 't1', token: 'H' });
  assert.deepEqual(readLinkParams(req({}, { task_id: 't1', token: 'B' })), { taskId: 't1', token: 'B' });
  assert.deepEqual(readLinkParams(req({}, undefined, { task_id: 't1', token: 'Q' })), { taskId: 't1', token: 'Q' }); // old emails still work
});

// ── Uploads ─────────────────────────────────────────────────────────────────
const bytes = (...parts: Array<string | number[]>) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

test('real files of allowed types are accepted, with the type taken from the file', () => {
  assert.equal(checkUpload('plan.pdf', bytes('%PDF-1.7\n...')), 'application/pdf');
  assert.equal(checkUpload('shot.PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(checkUpload('a.jpg', bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(checkUpload('a.webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(checkUpload('runbook.docx', bytes([0x50, 0x4b, 0x03, 0x04, 0])), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(checkUpload('old.xls', bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'application/vnd.ms-excel');
  assert.equal(checkUpload('notes.txt', bytes('step 1\nstep 2\n')), 'text/plain');
  assert.equal(checkUpload('hosts.csv', bytes('name,ip\n')), 'text/csv');
});

test('executables, scripts and unknown types are refused with 415', () => {
  for (const name of ['setup.exe', 'run.sh', 'page.html', 'image.svg', 'x.js', 'macro.docm', 'noextension']) {
    assert.throws(() => checkUpload(name, bytes('hello')), (e: { statusCode?: number; status?: number }) => (e.statusCode ?? e.status) === 415, name);
  }
});

test('a file renamed to an allowed type is refused when its content does not match', () => {
  const exe = bytes('MZ', [0x90, 0, 3, 0, 0, 0]);
  for (const name of ['setup.pdf', 'setup.png', 'setup.jpg', 'setup.txt', 'setup.docx', 'setup.zip']) {
    assert.throws(() => checkUpload(name, exe), /doesn't look like a real/, name);
  }
  assert.throws(() => checkUpload('fake.png', bytes('%PDF-1.4')), /real \.png/);
});
