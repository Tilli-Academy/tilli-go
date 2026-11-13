import type { Page, Locator } from '@playwright/test';

export class HeaderComponent {
  readonly page: Page;
  readonly header: Locator;
  readonly pageTitle: Locator;
  readonly projectDropdown: Locator;
  readonly userEmail: Locator;

  constructor(page: Page) {
    this.page = page;
    this.header = page.locator('header');
    this.pageTitle = page.locator('header h1');
    // Custom combobox (ProjectSelect) labelled "Select project"
    this.projectDropdown = page.getByRole('combobox', { name: /select project/i });
    this.userEmail = this.header.locator('a[href*="profile"]');
  }

  async selectProject(projectCodeOrName: string) {
    await this.projectDropdown.click();
    await this.page.getByRole('option', { name: new RegExp(projectCodeOrName) }).click();
  }

  async getSelectedProjectText(): Promise<string> {
    // Selected value renders as "CODE — Name"
    return await this.projectDropdown.locator('.dfh-ps-value').textContent() || '';
  }

  async getPageTitleText(): Promise<string> {
    return await this.pageTitle.textContent() || '';
  }
}
