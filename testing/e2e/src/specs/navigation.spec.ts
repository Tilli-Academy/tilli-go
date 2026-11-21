import { test, expect } from '../fixtures/auth.fixture';
import { SidebarComponent } from '../page-objects/sidebar.component';
import { HeaderComponent } from '../page-objects/header.component';

test.describe('Navigation', () => {
  let sidebar: SidebarComponent;
  let header: HeaderComponent;

  test.beforeEach(async ({ authenticatedPage }) => {
    sidebar = new SidebarComponent(authenticatedPage);
    header = new HeaderComponent(authenticatedPage);
    await authenticatedPage.goto('/#/dashboard');
    await expect(sidebar.sidebar).toBeVisible();
  });

  test('sidebar Dashboard link navigates to /dashboard', async ({ authenticatedPage }) => {
    await sidebar.navigateTo('Change Requests');
    await expect(authenticatedPage).toHaveURL(/#\/change-requests/);

    await sidebar.navigateTo('Dashboard');
    await expect(authenticatedPage).toHaveURL(/#\/dashboard/);
  });

  test('sidebar Change Requests link navigates to /change-requests', async ({ authenticatedPage }) => {
    await sidebar.navigateTo('Change Requests');
    await expect(authenticatedPage).toHaveURL(/#\/change-requests/);
  });

  test('sidebar Timeline link navigates to /timeline', async ({ authenticatedPage }) => {
    await sidebar.navigateTo('Timeline');
    await expect(authenticatedPage).toHaveURL(/#\/timeline/);
  });

  test('Projects and Tasks are not sidebar items (opened from a change request)', async () => {
    await expect(sidebar.sidebar.getByRole('link', { name: 'Projects' })).toHaveCount(0);
    await expect(sidebar.sidebar.getByRole('link', { name: 'Tasks' })).toHaveCount(0);
  });

  test('sidebar Profile link navigates to /profile', async ({ authenticatedPage }) => {
    await sidebar.navigateTo('Profile');
    await expect(authenticatedPage).toHaveURL(/#\/profile/);
  });

  test('active link is highlighted', async ({ authenticatedPage }) => {
    await sidebar.navigateTo('Timeline');
    await expect(authenticatedPage).toHaveURL(/#\/timeline/);

    const activeLink = sidebar.getActiveLink();
    await expect(activeLink).toContainText('Timeline');
  });

  test('sidebar collapse persists on reload', async ({ authenticatedPage }) => {
    // Collapse sidebar
    await sidebar.toggleCollapse();

    // Verify collapsed state is stored
    const collapsed = await authenticatedPage.evaluate(() => localStorage.getItem('sidebarCollapsed'));
    expect(collapsed).toBe('true');

    // Reload
    await authenticatedPage.reload();

    // Should still be collapsed
    const collapsedAfter = await authenticatedPage.evaluate(() => localStorage.getItem('sidebarCollapsed'));
    expect(collapsedAfter).toBe('true');

    // Expand it back for other tests
    await sidebar.toggleCollapse();
  });

  test('header shows correct page title for each route', async ({ authenticatedPage }) => {
    // Dashboard
    await sidebar.navigateTo('Dashboard');
    await expect(header.pageTitle).toHaveText('Dashboard');

    // Change Requests
    await sidebar.navigateTo('Change Requests');
    await expect(header.pageTitle).toHaveText('Change Requests');

    // Timeline
    await sidebar.navigateTo('Timeline');
    await expect(header.pageTitle).toHaveText('Cutover Timeline');

    // Profile
    await sidebar.navigateTo('Profile');
    await expect(header.pageTitle).toHaveText('Profile');
  });
});
