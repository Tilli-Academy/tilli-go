import api from '../../services/api';
import type { ChangeDetail, ChangeListItem, Conflict, CrMeta, CrStatus, DecisionKey } from './types';

export interface ListParams { status?: string; product?: string; q?: string; mine?: boolean; conflicts?: boolean; project?: string }

export const crApi = {
  list: (p: ListParams) =>
    api.get<{ data: ChangeListItem[]; counts: Record<string, number> }>('/change-requests', {
      params: { status: p.status || undefined, product: p.product || undefined, q: p.q || undefined, mine: p.mine ? '1' : undefined, conflicts: p.conflicts ? '1' : undefined, project: p.project || undefined },
    }),
  meta: () => api.get<CrMeta>('/change-requests/meta'),
  conflicts: (productIds: string[], date: string, exclude?: string) =>
    api.get<{ conflicts: Conflict[] }>('/change-requests/conflicts', { params: { products: productIds.join(','), date, exclude } }),
  get: (id: string) => api.get<ChangeDetail>(`/change-requests/${id}`),
  create: (body: Record<string, unknown>) => api.post<{ id: string; number: number }>('/change-requests', body),
  update: (id: string, body: Record<string, unknown>) => api.patch(`/change-requests/${id}`, body),
  transition: (id: string, to: CrStatus, reason?: string) => api.post(`/change-requests/${id}/transition`, { to, reason }),
  decide: (id: string, decision: DecisionKey, reason?: string, datePresented?: string) =>
    api.post(`/change-requests/${id}/decision`, { decision, reason: reason || undefined, datePresented: datePresented || undefined }),
  setDocument: (id: string, typeId: string, body: { attachmentId: string } | { url: string }) =>
    api.put(`/change-requests/${id}/documents/${typeId}`, body),
  removeDocument: (id: string, typeId: string) => api.delete(`/change-requests/${id}/documents/${typeId}`),
  addLink: (id: string, number: number) => api.post(`/change-requests/${id}/links`, { number }),
  removeLink: (id: string, otherId: string) => api.delete(`/change-requests/${id}/links/${otherId}`),
  comment: (id: string, message: string) => api.post(`/change-requests/${id}/comments`, { message }),
  /** Pick a project (null = none) or create one; a project can hold several change requests. */
  setProject: (id: string, body: { projectId: string | null } | { create: { name: string; code: string; timeZone: string } }) =>
    api.put<{ project: { id: string; code: string } | null }>(`/change-requests/${id}/project`, body),
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
