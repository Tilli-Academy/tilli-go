import * as fs from 'fs';
import * as path from 'path';
import { API_URL, TEST_PASSWORD, uniqueEmail, uniqueName } from './helpers/constants';
import { ApiHelper } from './helpers/api.helper';

/** Path where shared credentials are stored for all spec files. */
export const SHARED_AUTH_PATH = path.resolve(__dirname, '..', '.auth-state.json');

export interface SharedAuth {
  email: string;
  name: string;
  id: string;
  token: string;
}

/**
 * Playwright global setup — runs once before the entire test suite.
 * 1. Signs in the single shared user (avoids rate-limit exhaustion).
 *    The tests create projects and delete tasks, which need the project.manage and
 *    task.delete permissions. New sign-ups don't have them, so set E2E_ADMIN_EMAIL and
 *    E2E_ADMIN_PASSWORD to an account with the admin role. Without them a new user is
 *    registered (as before) and the permission-gated tests fail with 403.
 * 2. Cleans up leftover E2E test projects (prevents pagination overflow).
 */
export default async function globalSetup() {
  // 1. The shared user for the entire test run
  let sharedAuth: SharedAuth;
  let helper: ApiHelper;
  if (process.env.E2E_ADMIN_EMAIL && process.env.E2E_ADMIN_PASSWORD) {
    const login = await ApiHelper.login(process.env.E2E_ADMIN_EMAIL, process.env.E2E_ADMIN_PASSWORD, API_URL);
    helper = login.helper;
    sharedAuth = { email: login.user.email, name: login.user.name, id: login.user.id, token: login.token };
  } else {
    console.warn('[global-setup] E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD not set: registering a plain user (tests needing admin permissions will fail)');
    const email = uniqueEmail();
    const name = uniqueName();
    const reg = await ApiHelper.register(email, TEST_PASSWORD, name, API_URL);
    helper = reg.helper;
    const { token } = await ApiHelper.login(email, TEST_PASSWORD, API_URL);
    sharedAuth = { email, name, id: reg.user.id, token };
  }
  fs.writeFileSync(SHARED_AUTH_PATH, JSON.stringify(sharedAuth));

  // 2. Clean up leftover E2E test projects
  const res = await helper.listProjects();
  const projects = res.data || [];
  const e2eProjects = projects.filter((p) => p.code.startsWith('E2E'));
  let deletedCount = 0;

  for (const project of e2eProjects) {
    try {
      const taskRes = await helper.listTasks(project.id);
      const tasks = taskRes.data || [];
      for (const task of tasks) {
        try { await helper.deleteTask(task.id); } catch { /* skip */ }
      }
      await helper.deleteProject(project.id);
      deletedCount++;
    } catch {
      // Ignore — some projects may have undeletable tasks
    }
  }

  if (deletedCount > 0) {
    console.log(`[global-setup] Cleaned up ${deletedCount} leftover E2E projects`);
  }
}
