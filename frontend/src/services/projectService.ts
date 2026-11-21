import type { AxiosResponse } from 'axios';
import api from './api';
import type { Project, PaginatedResponse, CreateProjectInput } from '../types';

/** The API returns at most this many projects per page. */
const PAGE_SIZE = 200;
/** Safety stop (100 000 projects): beyond this, getProjects fails clearly instead of loading on and on. */
const MAX_PAGES = 500;

/**
 * Every project, not just the first page: the API pages its results (100 by default),
 * so a plain GET /projects silently hid projects after the 100th from the project
 * picker and the Projects page. Pages are fetched one after another until `total`.
 *
 * The result has the usual PaginatedResponse shape, describing ONE page that holds
 * everything loaded: `data` = all projects, `total` = `limit` = data.length, `page` = 1.
 * (`total` is what was actually loaded, so it always matches `data`, even if projects
 * were added or deleted while the pages were being fetched.)
 *
 * More projects than MAX_PAGES × PAGE_SIZE: rejects with a clear error instead of
 * returning an incomplete list. A failed page request rejects with that request's error.
 */
async function getAllProjects(): Promise<AxiosResponse<PaginatedResponse<Project>>> {
  const first = await api.get<PaginatedResponse<Project>>('/projects', { params: { page: 1, limit: PAGE_SIZE } });
  const pages = Math.ceil(first.data.total / PAGE_SIZE);
  if (pages > MAX_PAGES) {
    throw new Error(
      `Too many projects to load: ${first.data.total} (the app loads at most ${MAX_PAGES * PAGE_SIZE}). Please contact support.`,
    );
  }
  const byId = new Map(first.data.data.map((p) => [p.id, p]));
  for (let page = 2; page <= pages; page++) {
    const next = await api.get<PaginatedResponse<Project>>('/projects', { params: { page, limit: PAGE_SIZE } });
    if (next.data.data.length === 0) break; // fewer projects than `total` said (e.g. some were deleted meanwhile)
    for (const p of next.data.data) byId.set(p.id, p);
  }
  const all = [...byId.values()];
  return { ...first, data: { ...first.data, data: all, total: all.length, page: 1, limit: all.length } };
}

export const projectService = {
  getProjects: getAllProjects,

  createProject: (data: CreateProjectInput): Promise<AxiosResponse<Project>> =>
    api.post('/projects', data),

  deleteProject: (id: string): Promise<AxiosResponse<void>> =>
    api.delete(`/projects/${id}`),

  batchDeleteProjects: (ids: string[]): Promise<AxiosResponse<{ deleted: number }>> =>
    api.post('/projects/batch-delete', { ids }),
};
