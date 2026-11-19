import { useEffect, useState } from 'react';
import api from '../services/api';

// What the signed-in user may do. The UI hides what they can't; the API enforces it.
let cache: { token: string; perms: Promise<string[]> } | null = null;

export function usePermissions() {
  const token = localStorage.getItem('token') ?? '';
  const [perms, setPerms] = useState<string[] | null>(null);
  useEffect(() => {
    if (!token) return;
    if (!cache || cache.token !== token) {
      cache = { token, perms: api.get<{ permissions: string[] }>('/auth/permissions').then((r) => r.data.permissions) };
    }
    let alive = true;
    cache.perms.then((p) => alive && setPerms(p)).catch(() => { cache = null; });
    return () => { alive = false; };
  }, [token]);
  return { loaded: perms !== null, can: (p: string) => !!perms?.includes(p) };
}
