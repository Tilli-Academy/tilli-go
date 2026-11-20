import { API_URL, BASE_URL } from './constants';

/** Raw API call for API-level specs (status + JSON body). `viaApp` goes through Nginx. */
export type Res = { status: number; data: any };
export async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
  viaApp = false,
): Promise<Res> {
  const raw = Buffer.isBuffer(body);
  const res = await fetch(`${viaApp ? BASE_URL : API_URL}/api${path}`, {
    method,
    headers: {
      'Content-Type': raw ? 'application/octet-stream' : 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : raw ? (body as Buffer) : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* empty or non-JSON body */ }
  return { status: res.status, data };
}

/** Create a change request with valid managed-list values (optionally in a project). */
export async function createChangeRequest(token: string, title: string, projectId?: string): Promise<any> {
  const lists = (await call('GET', '/lists', token)).data.lists;
  const pick = (list: string, label: string) => lists[list].find((v: { label: string }) => v.label === label)?.id;
  const me = (await call('GET', '/auth/me', token)).data;
  const myId = (me.user ?? me).id;
  const cr = await call('POST', '/change-requests', token, {
    title, description: 'created by an e2e spec', productIds: [lists.product[0].id],
    changeTypeId: pick('change_type', 'Product Enhancement'), releaseTypeId: pick('release_type', 'Minor'), priorityId: pick('priority', 'Low'),
    impact: 'LOW', risk: 'LOW', plannedGoLive: '2031-03-01T21:00:00-05:00', assigneeId: myId, reporterId: myId,
    ...(projectId ? { projectId } : {}),
  });
  if (cr.status !== 201) throw new Error(`create CR failed: ${cr.status} ${JSON.stringify(cr.data)}`);
  return cr.data;
}

/** A real (stored) ZIP archive with these files - for Office / ZIP upload checks. */
export function zip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name);
    const d = Buffer.from(text);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(d.length, 18); local.writeUInt32LE(d.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(d.length, 20); central.writeUInt32LE(d.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, d);
    centrals.push(central, n);
    offset += 30 + n.length + d.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  const count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
