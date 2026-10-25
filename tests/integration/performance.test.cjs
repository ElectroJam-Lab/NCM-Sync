const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../../src/backend/database.cjs');
const { FileStore } = require('../../src/backend/file-store.cjs');
const { AppService } = require('../../src/backend/app-service.cjs');
const { NeteaseClient } = require('../../src/backend/netease.cjs');
const { TaskManager } = require('../../src/backend/task-manager.cjs');
const { createServer } = require('../../src/backend/server.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-performance-'));
  const fileStore = new FileStore(root); const db = await new Database(path.join(fileStore.dataPath, 'test.sqlite')).init();
  const netease = new NeteaseClient({ mock: true }); const tasks = new TaskManager();
  const service = new AppService({ db, fileStore, netease, tasks, rootPath: root });
  t.after(async () => { service.stop(); if (tasks.active) await service.cancelTask(false);
    assert.ok(path.basename(root).startsWith('ncmsync-performance-')); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, db, netease, tasks, service };
}

test('未变轮询返回 304 且不重建摘要，设置、任务和扫描变化及时使缓存失效', async (t) => {
  const { service, tasks } = await fixture(t);
  await service.setupUser('123456789');
  let summaries = 0; const original = service.bootstrap.bind(service);
  service.bootstrap = (...args) => { summaries++; return original(...args); };
  const runtime = await createServer({ service, port: 0 });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  let response = await fetch(`${runtime.url}/api/bootstrap`); let etag = response.headers.get('etag');
  assert.equal(response.status, 200); assert.ok(etag); assert.equal(summaries, 1);
  response = await fetch(`${runtime.url}/api/bootstrap`, { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 304); assert.equal(await response.text(), ''); assert.equal(summaries, 1);
  tasks.begin(1); response = await fetch(`${runtime.url}/api/bootstrap`, { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 200); assert.equal((await response.json()).task.active, true); etag = response.headers.get('etag');
  tasks.pause(); response = await fetch(`${runtime.url}/api/bootstrap`, { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 200); assert.equal((await response.json()).task.paused, true); tasks.finish();
  service.updateSettings({ mp3Bitrate: 256 }); response = await fetch(`${runtime.url}/api/bootstrap`);
  assert.equal((await response.json()).settings.mp3Bitrate, 256); etag = response.headers.get('etag');
  service.scanning = true; response = await fetch(`${runtime.url}/api/bootstrap`, { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 200); assert.equal((await response.json()).scanning, true); service.scanning = false;
});

test('逐曲同步减少磁盘导出，同时歌曲和歌单关系可立即从磁盘恢复', async (t) => {
  const { root, service, db, netease } = await fixture(t);
  const detail = netease.getPlaylist.bind(netease);
  netease.getPlaylist = async (...args) => { const result = await detail(...args); return { ...result, tracks: result.tracks.map((track) => ({ ...track, coverUrl: '' })) }; };
  await service.setupUser('123456789'); service.setSyncSelection(['1001']);
  const folder = path.join(root, 'custom'); fs.mkdirSync(folder); await service.mapPlaylist('1001', folder);
  let writes = 0; const save = db.save.bind(db); db.save = () => { writes++; save(); };
  service.startSync(); await service.syncPromise;
  assert.equal(service.tasks.getState().error, ''); assert.ok(writes <= 5, `两首歌曲不应反复导出整库：${writes}`);
  const restored = await new Database(db.filePath).init();
  assert.equal(restored.all('SELECT * FROM songs').length, 2); assert.equal(restored.all('SELECT * FROM playlist_tracks').length, 2);
  assert.equal(restored.getSettings().interruptedTask, false); assert.equal(fs.readdirSync(folder).length, 2);
});

test('某歌单进度改变时复用其他歌单的完整曲目快照', async (t) => {
  const { root, service, db } = await fixture(t);
  await service.setupUser('123456789'); service.setSyncSelection(['1001', '1999']);
  const first = path.join(root, 'first'); const large = path.join(root, 'large'); fs.mkdirSync(first); fs.mkdirSync(large);
  const one = await service.mapPlaylist('1001', first); const many = await service.mapPlaylist('1999', large);
  const old = service.localDetail(many.id); assert.equal(old.onlineTracks.length, 4867);
  db.run('UPDATE local_playlists SET sync_progress=? WHERE id=?', ['正在同步：1/2', one.id], false);
  assert.equal(service.localDetail(one.id).syncProgress, '正在同步：1/2');
  assert.equal(service.localDetail(many.id), old);
  service.updateSettings({ mp3Bitrate: 192 });
  assert.equal(service.localDetail(many.id).onlineTracks, old.onlineTracks);
});
