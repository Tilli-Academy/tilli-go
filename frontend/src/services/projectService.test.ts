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
    expect((await projectService.getProjects()).data.data).toHaveLength(250);
    expect(calls).toHaveLength(3); // pages 1, 2, then an empty page 3 stops it
  });
});
