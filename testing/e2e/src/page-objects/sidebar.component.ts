import type { Page, Locator } from '@playwright/test';

export class SidebarComponent {
  readonly page: Page;
  readonly sidebar: Locator;
  readonly dashboardLink: Locator;
  readonly changeRequestsLink: Locator;
  readonly timelineLink: Locator;
  readonly profileLink: Locator;
  readonly logoutButton: Locator;
  readonly collapseButton: Locator;
  readonly brand: Locator;

  constructor(page: Page) {
    this.page = page;
    this.sidebar = page.locator('aside');
    this.dashboardLink = this.sidebar.getByRole('link', { name: 'Dashboard' });
    this.changeRequestsLink = this.sidebar.getByRole('link', { name: 'Change Requests' });
    this.timelineLink = this.sidebar.getByRole('link', { name: 'Timeline' });
    this.profileLink = this.sidebar.getByRole('link', { name: 'Profile' });
    this.logoutButton = this.sidebar.getByRole('button', { name: /logout/i });
    this.collapseButton = this.sidebar.getByLabel(/collapse sidebar|expand sidebar/i);
    this.brand = this.sidebar.getByText('Tilli-go');
  }

  /** Get the active (highlighted) navigation link. */
  getActiveLink(): Locator {
    return this.sidebar.locator('a.dfs-item-active');
  }

  async navigateTo(target: 'Change Requests' | 'Timeline' | 'Dashboard' | 'Profile') {
    const links: Record<string, Locator> = {
      'Change Requests': this.changeRequestsLink,
      Timeline: this.timelineLink,
      Dashboard: this.dashboardLink,
      Profile: this.profileLink,
    };
    await links[target].click();
  }

  async toggleCollapse() {
    await this.collapseButton.click();
  }

  async logout() {
    await this.logoutButton.click();
  }
}
