import * as crypto from 'crypto';
import { test, expect } from '../fixtures/auth.fixture';
import { TEST_PASSWORD, uniqueEmail, uniqueName, uniqueProjectCode, uniqueProjectName } from '../helpers/constants';
import { call, createChangeRequest, zip } from '../helpers/http';

/**
 * API-level guards from the PR #7 code audit:
 *   - permissions are enforced by the server (a plain user can't do admin things)
 *   - a task that later steps wait for can't be deleted
 *   - uploads: allowed types only, checked against the file's content
 *   - email links: must name the current owner; double clicks save once
 * The email-link tests sign their own links, so they need ACK_TOKEN_SECRET (the
 * same value the API uses); without it they are skipped.
 */
test.describe('Security guards (API)', () => {
  let projectId: string;
  let admin: string;

  test.beforeEach(async ({ apiHelper }) => {
    admin = apiHelper.getToken();
    projectId = (await apiHelper.createProject(uniqueProjectName(), uniqueProjectCode())).id;
  });

  test.afterEach(async ({ apiHelper }) => {
    await apiHelper.deleteProject(projectId).catch(() => {});
  });

  test('a plain user cannot use admin-only actions', async ({ apiHelper }) => {
    const reg = await call('POST', '/auth/register', undefined, { email: uniqueEmail(), password: TEST_PASSWORD, name: uniqueName() });
    expect(reg.status).toBe(201);
    const user = reg.data.token as string;
    const task = await apiHelper.createTask(projectId, 'Permission probe');

    const perms = await call('GET', '/auth/permissions', user);
    expect(JSON.stringify(perms.data)).not.toContain('task.delete');
    expect((await call('POST', '/projects', user, { name: 'nope', code: uniqueProjectCode() })).status).toBe(403);
    expect((await call('DELETE', `/tasks/${task.id}`, user)).status).toBe(403);
    expect((await call('POST', '/lists/team', user, { label: 'nope' })).status).toBe(403);
    // what a plain user IS allowed to do still works
    expect((await call('PUT', `/tasks/${task.id}`, user, { notes: 'edited by a user' })).status).toBe(200);
    // no token at all
    expect((await call('GET', '/projects')).status).toBe(401);
  });

  test('a task that a later step waits for cannot be deleted', async ({ apiHelper }) => {
    const a = await apiHelper.createTask(projectId, 'Step A');
    const b = await call('POST', '/tasks', admin, { projectId, system: 'FOL', taskName: 'Step B', dependencies: [a.id] });
    expect(b.status).toBe(201);

    const refused = await call('DELETE', `/tasks/${a.id}`, admin);
    expect(refused.status).toBe(409);
    expect(refused.data.error).toContain('Step B');
    expect((await call('GET', `/tasks/${a.id}`, admin)).status).toBe(200);

    expect((await call('PUT', `/tasks/${b.data.id}`, admin, { status: 'N/A' })).status).toBe(200);
    expect((await call('DELETE', `/tasks/${a.id}`, admin)).status).toBe(204);
  });

  test('uploads accept real files of allowed types only', async () => {
    const cr = await createChangeRequest(admin, `E2E uploads ${Date.now()}`, projectId);
    const up = (name: string, data: Buffer, type?: string, viaApp = false) =>
      call('POST', `/change-requests/${cr.id}/attachments`, admin, data, { 'X-File-Name': encodeURIComponent(name), ...(type ? { 'X-File-Type': type } : {}) }, viaApp);
    const pdfBytes = (size = 0) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(size, 0x61), Buffer.from('\n%%EOF\n')]);

    const pdf = await up('runbook.pdf', pdfBytes(), 'text/html');
    expect(pdf.status).toBe(201);
    expect(pdf.data.mimeType).toBe('application/pdf'); // from the file, not the browser's claim
    const docx = await up('plan.docx', zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' }));
    expect(docx.status).toBe(201);

    const exe = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    expect((await up('setup.exe', exe)).status).toBe(415);
    expect((await up('setup.pdf', exe)).status).toBe(415); // renamed executable
    expect((await up('page.html', Buffer.from('<script>alert(1)</script>'))).status).toBe(415);
    expect((await up('logo.svg', Buffer.from('<svg onload="x()"/>'))).status).toBe(415);
    expect((await up('notes.docx', zip({ 'notes.txt': 'any zip' }))).status).toBe(415); // ZIP renamed to .docx
    expect((await up('cut.pdf', Buffer.from('%PDF-1.4\n1 0 obj'))).status).toBe(415); // truncated PDF

    // Through the web server (Nginx) like the browser: 2 MB works, over 10 MB is refused with 413
    expect((await up('big.pdf', pdfBytes(2 * 1024 * 1024), undefined, true)).status).toBe(201);
    expect((await up('huge.pdf', pdfBytes(11 * 1024 * 1024), undefined, true)).status).toBe(413);

    // Downloads: need a login, and the attachment must belong to the CR in the URL
    expect((await call('GET', `/change-requests/${cr.id}/attachments/${pdf.data.id}`)).status).toBe(401);
    const other = await createChangeRequest(admin, `E2E other ${Date.now()}`, projectId);
    expect((await call('GET', `/change-requests/${other.id}/attachments/${pdf.data.id}`, admin)).status).toBe(404);
    for (const id of [cr.id, other.id]) await call('POST', `/change-requests/${id}/transition`, admin, { to: 'CANCELLED', reason: 'e2e cleanup' });
  });

  test.describe('email links', () => {
    const secret = process.env.ACK_TOKEN_SECRET;
    test.skip(!secret, 'set ACK_TOKEN_SECRET (same as the API) to run the email-link tests');
    const link = (taskId: string, uid?: string, exp = Date.now() + 3_600_000) => {
      const p = Buffer.from(JSON.stringify(uid ? { taskId, exp, uid } : { taskId, exp })).toString('base64url');
      return `${p}.${crypto.createHmac('sha256', secret!).update(p).digest('base64url')}`;
    };

    test('links must name the current owner and not be expired or edited', async ({ apiHelper, testUser }) => {
      const task = await apiHelper.createTask(projectId, 'Link checks');
      await apiHelper.setTaskStatus(task.id, 'Triggered');
      const good = link(task.id, testUser.id);

      expect((await call('GET', `/acknowledge/preview?task_id=${task.id}`, undefined, undefined, { 'X-Link-Token': good })).status).toBe(200);
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id) })).status).toBe(403); // no owner
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id, '00000000-0000-0000-0000-000000000000') })).status).toBe(403); // old owner
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: link(task.id, testUser.id, Date.now() - 1000) })).data.error).toBe('Token expired');
      expect((await call('POST', '/acknowledge', undefined, { task_id: task.id, token: `${good.slice(0, -3)}xyz` })).status).toBe(403);
      expect((await apiHelper.getTask(task.id)).status).toBe('Triggered');
    });

    test('several clicks at the same moment are saved once', async ({ apiHelper, testUser }) => {
      const task = await apiHelper.createTask(projectId, 'Double click');
      await apiHelper.setTaskStatus(task.id, 'Triggered');
      const token = link(task.id, testUser.id);

      const acks = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/acknowledge', undefined, { task_id: task.id, token })));
      expect(acks.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(acks.filter((r) => r.data.message === 'Task acknowledged successfully')).toHaveLength(1);

      const done = await Promise.all([1, 2, 3, 4].map(() => call('POST', '/complete', undefined, { task_id: task.id, token })));
      expect(done.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(done.filter((r) => r.data.message !== 'Task already completed')).toHaveLength(1);
      expect((await apiHelper.getTask(task.id)).status).toBe('Completed');
    });
  });
});
