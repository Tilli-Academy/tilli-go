import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import api from './api';
import { projectService } from './projectService';

type Params = { page?: number; limit?: number };
type Page = { data: { data: Array<{ id: string }>; total: number; page: number; limit: number }; status: number };
type FakeGet = (url: string, config?: { params?: Params }) => Promise<Page>;

/** A fake API holding `count` projects, answering GET /projects?page&limit like the real one. */
function apiWith(count: number): FakeGet {
  const projects = Array.from({ length: count }, (_, i) => ({ id: `p${i + 1}` }));
  return async (_url, config) => {
    const { page = 1, limit = 100 } = config?.params ?? {};
    const start = (page - 1) * limit;
    return { data: { data: projects.slice(start, start + limit), total: count, page, limit }, status: 200 };
  };
}

let fake: FakeGet;
let calls: Params[];
beforeEach(() => {
  calls = [];
  jest.spyOn(api, 'get').mockImplementation(((url: string, config?: { params?: Params }) => {
    calls.push(config?.params ?? {});
    return fake(url, config);
  }) as never);
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('projectService.getProjects', () => {
  test('returns every project, not only the first 100', async () => {
    fake = apiWith(450);
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(450);
    expect(res.data.total).toBe(450);
    expect(res.data.data[449]?.id).toBe('p450');
    expect(calls).toEqual([{ page: 1, limit: 200 }, { page: 2, limit: 200 }, { page: 3, limit: 200 }]);
  });

  test('one request when everything fits in one page', async () => {
    fake = apiWith(120);
    expect((await projectService.getProjects()).data.data).toHaveLength(120);
    expect(calls).toHaveLength(1);
  });

  test('no projects', async () => {
    fake = apiWith(0);
    expect((await projectService.getProjects()).data.data).toEqual([]);
  });

  test('a project returned twice (e.g. one created while paging) is listed once', async () => {
    const real = apiWith(250);
    fake = async (url, config) => {
      const res = await real(url, config);
      if (config?.params?.page === 2) res.data.data.unshift({ id: 'p200' }); // repeated across pages
      return res;
    };
    const ids = (await projectService.getProjects()).data.data.map((p) => p.id);
    expect(ids).toHaveLength(250);
    expect(new Set(ids).size).toBe(250);
  });

  test('stops when a page comes back empty (projects deleted while paging)', async () => {
    const real = apiWith(250);
    fake = async (url, config) => {
      const res = await real(url, config);
      if (config?.params?.page === 1) res.data.total = 900; // the count was taken before some were deleted
      return res;
    };
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(250);
    expect(calls).toHaveLength(3); // pages 1, 2, then an empty page 3 stops it
    // Metadata describes what was actually loaded, not the stale count of 900.
    expect(res.data.total).toBe(250);
    expect(res.data.limit).toBe(250);
    expect(res.data.page).toBe(1);
  });

  test('exactly 200 projects: one request', async () => {
    fake = apiWith(200);
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(200);
    expect(calls).toEqual([{ page: 1, limit: 200 }]);
  });

  test('201 projects: exactly two requests', async () => {
    fake = apiWith(201);
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(201);
    expect(res.data.data[200]?.id).toBe('p201');
    expect(calls).toEqual([{ page: 1, limit: 200 }, { page: 2, limit: 200 }]);
  });

  test('a later page failing rejects with that request\'s error (no partial list)', async () => {
    const real = apiWith(450);
    const boom = new Error('Network Error');
    fake = async (url, config) => {
      if (config?.params?.page === 2) throw boom;
      return real(url, config);
    };
    await expect(projectService.getProjects()).rejects.toBe(boom);
    expect(calls).toHaveLength(2); // stopped at the failing page
  });

  test('more projects than the app can load (500 pages × 200): clear error, not a partial list, no extra requests', async () => {
    fake = apiWith(500 * 200 + 1);
    await expect(projectService.getProjects()).rejects.toThrow(/Too many projects to load: 100001 \(the app loads at most 100000\)/);
    expect(calls).toHaveLength(1); // decided from the first page's total
  });

  test('exactly at the limit (100 000 projects): all loaded', async () => {
    fake = apiWith(500 * 200);
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(100_000);
    expect(calls).toHaveLength(500);
  });

  test('a project added while loading: metadata still matches the projects returned', async () => {
    const real = apiWith(250);
    fake = async (url, config) => {
      const res = await real(url, config);
      if (config?.params?.page === 2) res.data.data.push({ id: 'p-new' }); // created after page 1 was read
      return res;
    };
    const res = await projectService.getProjects();
    expect(res.data.data).toHaveLength(251);
    expect(res.data.total).toBe(251);
    expect(res.data.limit).toBe(251);
  });
});
