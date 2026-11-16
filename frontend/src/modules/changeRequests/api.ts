import api from '../../services/api';
import type { ChangeDetail, ChangeListItem, Conflict, CrMeta, CrStatus } from './types';

export interface ListParams { status?: string; product?: string; q?: string; mine?: boolean; conflicts?: boolean }

export const crApi = {
  list: (p: ListParams) =>
    api.get<{ data: ChangeListItem[]; counts: Record<string, number> }>('/change-requests', {
      params: { status: p.status || undefined, product: p.product || undefined, q: p.q || undefined, mine: p.mine ? '1' : undefined, conflicts: p.conflicts ? '1' : undefined },
    }),
  meta: () => api.get<CrMeta>('/change-requests/meta'),
  conflicts: (product: string, date: string, exclude?: string) =>
    api.get<{ conflicts: Conflict[] }>('/change-requests/conflicts', { params: { product, date, exclude } }),
  get: (id: string) => api.get<ChangeDetail>(`/change-requests/${id}`),
  create: (body: Record<string, unknown>) => api.post<{ id: string; number: number }>('/change-requests', body),
  transition: (id: string, to: CrStatus, reason?: string) => api.post(`/change-requests/${id}/transition`, { to, reason }),
  comment: (id: string, message: string) => api.post(`/change-requests/${id}/comments`, { message }),
  createCutover: (id: string) => api.post<{ id: string; code: string }>(`/change-requests/${id}/cutover`),
  upload: (id: string, file: File) =>
    api.post(`/change-requests/${id}/attachments`, file, {
      headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Type': file.type || 'application/octet-stream' },
    }),
  /** Downloads with the auth header, then opens/saves via an object URL. */
  openAttachment: async (id: string, attachmentId: string, fileName: string) => {
    const res = await api.get<Blob>(`/change-requests/${id}/attachments/${attachmentId}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    if (!/^(image\/|application\/pdf)/.test(res.data.type)) a.download = fileName;
    else a.target = '_blank';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
};
