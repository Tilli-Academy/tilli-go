import { useCallback, useEffect, useState } from 'react';
import api from '../services/api';
import type { Lists } from '../modules/changeRequests/types';

// Managed lists (Admin → Lists). Pickers use active values only; the admin page
// asks for everything (all = true) including usage counts.
let cached: Promise<Lists> | null = null;

export function invalidateLists(): void {
  cached = null;
}

export function useLists(all = false) {
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    const p = all
      ? api.get<{ lists: Lists }>('/lists', { params: { all: '1' } }).then((r) => r.data.lists)
      : (cached ??= api.get<{ lists: Lists }>('/lists').then((r) => r.data.lists));
    p.then(setLists).catch((e) => { cached = null; setError(String(e?.message ?? e)); });
  }, [all]);
  useEffect(load, [load]);
  return { lists, error, reload: () => { invalidateLists(); load(); } };
}
