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
  const { data, fail } = checkLinkToken('t1', sign({ taskId: 't1', kind: 'ack', exp: Date.now() + hour, uid: 'u1' }), 'ack');
  assert.equal(fail, undefined);
  assert.equal(data.uid, 'u1');
});

test('expired, tampered, malformed, wrong-task and missing tokens are refused', () => {
  const good = sign({ taskId: 't1', kind: 'ack', exp: Date.now() + hour, uid: 'u1' });
  const cases: Array<[string, string | undefined, string]> = [
    ['expired', sign({ taskId: 't1', kind: 'ack', exp: Date.now() - 1, uid: 'u1' }), 'Token expired'],
    ['signed with another secret', sign({ taskId: 't1', kind: 'ack', exp: Date.now() + hour, uid: 'u1' }, 'not-the-secret'), 'Invalid token signature'],
    ['payload edited after signing', `${Buffer.from(JSON.stringify({ taskId: 't1', exp: Date.now() + hour, uid: 'attacker' })).toString('base64url')}.${good.split('.')[1]}`, 'Invalid token signature'],
    ['malformed', 'not-a-token', 'Malformed token'],
    ['for another task', sign({ taskId: 't2', kind: 'ack', exp: Date.now() + hour, uid: 'u1' }), 'Token task ID mismatch'],
  ];
  for (const [name, token, error] of cases) {
    const { fail } = checkLinkToken('t1', token, 'ack');
    assert.equal(fail?.status, 403, name);
    assert.equal(fail?.body.error, error, name);
  }
  assert.equal(checkLinkToken('t1', undefined, 'ack').fail.status, 400);
});

test('an acknowledge link cannot be used to complete, and vice versa', () => {
  const ack = sign({ taskId: 't1', kind: 'ack', exp: Date.now() + hour, uid: 'u1' });
  const complete = sign({ taskId: 't1', kind: 'complete', exp: Date.now() + hour, uid: 'u1' });
  const untyped = sign({ taskId: 't1', exp: Date.now() + hour, uid: 'u1' });
  assert.equal(checkLinkToken('t1', ack, 'ack').fail, undefined);
  assert.equal(checkLinkToken('t1', complete, 'complete').fail, undefined);
  assert.match(checkLinkToken('t1', ack, 'complete').fail.body.error, /for acknowledging/);
  assert.match(checkLinkToken('t1', complete, 'ack').fail.body.error, /for marking the task completed/);
  assert.equal(checkLinkToken('t1', untyped, 'ack').fail.status, 403, 'links without a type are refused');
  assert.equal(checkLinkToken('t1', untyped, 'complete').fail.status, 403);
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
/** A real (stored, uncompressed) ZIP archive with these files. */
function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name); const d = Buffer.from(text);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, d); centrals.push(central, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const DOCX = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
const PDF_OK = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n', 'latin1');

const bytes = (...parts: Array<string | number[]>) => Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'latin1') : Buffer.from(p))));

test('real files of allowed types are accepted, with the type taken from the file', () => {
  assert.equal(checkUpload('plan.pdf', PDF_OK), 'application/pdf');
  assert.equal(checkUpload('shot.PNG', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  assert.equal(checkUpload('a.jpg', bytes([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(checkUpload('a.webp', bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(checkUpload('runbook.docx', DOCX), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(checkUpload('plan.xlsx', zip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' })), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(checkUpload('deck.pptx', zip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<p/>' })), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
  assert.equal(checkUpload('logs.zip', zip({ 'a.log': 'hello' })), 'application/zip');
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

test('Office files must be real Office packages, not any ZIP renamed', () => {
  const plainZip = zip({ 'readme.txt': 'not a document' });
  assert.throws(() => checkUpload('report.docx', plainZip), /real \.docx/);
  assert.throws(() => checkUpload('report.xlsx', DOCX), /real \.xlsx/, 'a Word file renamed to .xlsx');
  assert.throws(() => checkUpload('macro.docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w/>', 'word/vbaProject.bin': 'x' })), /real \.docx/, 'VBA macros');
});

test('malformed files are refused', () => {
  assert.throws(() => checkUpload('cut.pdf', Buffer.from('%PDF-1.7\n1 0 obj')), /real \.pdf/, 'truncated PDF (no end marker)');
  assert.throws(() => checkUpload('broken.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0])), /real \.zip/, 'ZIP without a directory');
  assert.throws(() => checkUpload('broken.docx', DOCX.subarray(0, DOCX.length - 10)), /real \.docx/, 'cut-off Office file');
  assert.throws(() => checkUpload('../../etc/passwd.txt', Buffer.from([0, 1, 2])), /real \.txt/, 'binary content in a .txt');
});
