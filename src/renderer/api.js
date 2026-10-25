import { reconcileSnapshot } from './snapshot.mjs';

let bootstrapSnapshot;
let bootstrapEtag;

async function bootstrap() {
  const response = await fetch('/api/bootstrap', { cache: 'no-store', headers: bootstrapEtag ? { 'If-None-Match': bootstrapEtag } : {} });
  if (response.status === 304 && bootstrapSnapshot) return bootstrapSnapshot;
  const next = await response.json();
  if (!response.ok) throw new Error(next.error || `请求失败（${response.status}）`);
  bootstrapEtag = response.headers.get('ETag');
  bootstrapSnapshot = reconcileSnapshot(bootstrapSnapshot, next);
  return bootstrapSnapshot;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

export const api = {
  bootstrap,
  setup: (userId, changing = false) => request('/api/setup', { method: 'POST', body: JSON.stringify({ userId, changing }) }),
  setupLater: () => request('/api/setup/later', { method: 'POST' }),
  refresh: () => request('/api/online/refresh', { method: 'POST' }),
  detail: (id) => request(`/api/online/${id}`),
  localDetail: (id) => request(`/api/local/${id}`),
  mapPlaylist: (onlineId, folderPath, localId) => request('/api/local/map', { method: 'POST', body: JSON.stringify({ onlineId, folderPath, localId }) }),
  saveChoices: (id, revision, changes) => request(`/api/local/${id}/choices`, { method: 'PUT', body: JSON.stringify({ revision, changes }) }),
  addLocal: (onlineIds) => request('/api/local', { method: 'POST', body: JSON.stringify({ onlineIds }) }),
  scan: () => request('/api/scan', { method: 'POST' }),
  sync: (ids) => request('/api/sync', { method: 'POST', body: JSON.stringify({ ids }) }),
  selectPlaylists: (onlineIds) => request('/api/sync/selection', { method: 'PUT', body: JSON.stringify({ onlineIds }) }),
  pauseLocal: (ids, paused) => request('/api/local/pause', { method: 'POST', body: JSON.stringify({ ids, paused }) }),
  removeLocal: (ids) => request('/api/local/remove', { method: 'POST', body: JSON.stringify({ ids }) }),
  redirect: (id, onlineId) => request(`/api/local/${id}/redirect`, { method: 'POST', body: JSON.stringify({ onlineId }) }),
  renameFolder: (id) => request(`/api/local/${id}/rename-folder`, { method: 'POST' }),
  openFolder: (id) => request(`/api/local/${id}/open`, { method: 'POST' }),
  openLibrary: () => request('/api/library/open', { method: 'POST' }),
  changeLibrary: (path, migrate, removeEmptySource = false) => request('/api/library/change', { method: 'POST', body: JSON.stringify({ path, migrate, removeEmptySource }) }),
  saveSettings: (values) => request('/api/settings', { method: 'PUT', body: JSON.stringify(values) }),
  pauseTask: () => request('/api/task/pause', { method: 'POST' }),
  resumeTask: () => request('/api/task/resume', { method: 'POST' }),
  cancelTask: (deleteDownloaded) => request('/api/task/cancel', { method: 'POST', body: JSON.stringify({ deleteDownloaded }) })
};
