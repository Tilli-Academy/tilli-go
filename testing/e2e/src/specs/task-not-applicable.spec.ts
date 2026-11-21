import { test, expect } from '../fixtures/auth.fixture';
import { TaskGridPage } from '../page-objects/task-grid.page';
import { uniqueProjectCode, uniqueProjectName } from '../helpers/constants';

// N/A = not needed in this cutover. It counts as done for anything that depends on
// it and is locked like Completed (PR #7 review, item 8).
test.describe('Task status N/A', () => {
  let projectId: string;

  test.beforeEach(async ({ apiHelper }) => {
    const project = await apiHelper.createProject(uniqueProjectName(), uniqueProjectCode());
    projectId = project.id;
  });

  test('a task waiting on an N/A task can start', async ({ apiHelper }) => {
    const optional = await apiHelper.createTask(projectId, 'Optional step');
    const next = await apiHelper.createTask(projectId, 'Next step');
    await apiHelper.updateTask(next.id, { dependencies: [optional.id] });

    const blocked = await apiHelper.updateTaskExpectError(next.id, { status: 'Triggered' });
    expect(blocked.status).toBe(400);

    await apiHelper.setTaskStatus(optional.id, 'N/A');
    const started = await apiHelper.setTaskStatus(next.id, 'Triggered');
    expect(started.status).toBe('Triggered');
  });

  test('an N/A task is locked like Completed', async ({ apiHelper }) => {
    const task = await apiHelper.createTask(projectId, 'Not needed');
    await apiHelper.setTaskStatus(task.id, 'N/A');

    const rename = await apiHelper.updateTaskExpectError(task.id, { taskName: 'Changed' });
    expect(rename.status).toBe(400);
    expect(JSON.stringify(rename.body)).toContain('N/A');

    const reopen = await apiHelper.updateTaskExpectError(task.id, { status: 'Pending' });
    expect(reopen.status).toBe(400);
  });

  test('a started task cannot be marked N/A', async ({ apiHelper }) => {
    const task = await apiHelper.createTask(projectId, 'Already started');
    await apiHelper.setTaskStatus(task.id, 'Triggered');
    await apiHelper.setTaskStatus(task.id, 'Acknowledged');
    const r = await apiHelper.updateTaskExpectError(task.id, { status: 'N/A' });
    expect(r.status).toBe(400);
  });

  test('the grid shows an N/A task as locked', async ({ authenticatedPage, apiHelper }) => {
    const task = await apiHelper.createTask(projectId, 'Skipped in grid');
    await apiHelper.setTaskStatus(task.id, 'N/A');
    await authenticatedPage.evaluate((pid) => localStorage.setItem('selectedProjectId', pid), projectId);
    const grid = new TaskGridPage(authenticatedPage);
    await grid.goto();
    await grid.waitForGrid();
    await expect(authenticatedPage.locator('.ag-row.row-status-completed').first()).toBeVisible();
    expect(await grid.getCellText(0, 'status')).toContain('N/A');
  });
});
