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

async function fixture(t, rootMapping = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-inventory-'));
  const fileStore = new FileStore(root);
  const db = await new Database(path.join(fileStore.dataPath, 'test.sqlite')).init();
  const netease = new NeteaseClient({ mock: true });
  const service = new AppService({ db, fileStore, netease, tasks: new TaskManager(), rootPath: root });
  t.after(async () => {
    service.stop();
    if (service.tasks.active) await service.cancelTask(false);
    assert.ok(path.basename(root).startsWith('ncmsync-inventory-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.setupUser('123456789');
  service.setSyncSelection(['1001']);
  const folder = rootMapping ? root : path.join(root, 'DJ', 'Existing mix');
  fs.mkdirSync(folder, { recursive: true });
  return { root, folder, db, fileStore, netease, service };
}

const tracks = (item) => [...item.added, ...item.removed, ...item.existing];
async function retainOnlyLocal(service, item, changes = []) {
  return service.saveTrackChoices(item.id, item.revision, [
    ...tracks(item).map((track) => ({ id: track.id, action: 'keep', enabled: false })), ...changes
  ]);
}

test('在线只有五首也展示文件夹全部六十五首，未匹配文件不导入实体库', async (t) => {
  const { folder, netease, service, db } = await fixture(t);
  const online = Array.from({ length: 5 }, (_, index) => ({
    id: String(501 + index), name: `Online Track ${index + 1}`, artists: ['Fixture Artist'], album: '', duration: 180000
  }));
  netease.getPlaylist = async () => ({ id: '1001', name: '夜航测试集', tracks: online, trackCount: online.length });
  for (const track of online) fs.writeFileSync(path.join(folder, `Fixture Artist - ${track.name}.mp3`), 'matched-audio');
  for (let index = 0; index < 60; index++) fs.writeFileSync(path.join(folder, `Local Set ${index + 1}.${index === 0 ? 'AIFF' : 'mp3'}`), 'unmatched-audio');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'unrelated');
  fs.mkdirSync(path.join(folder, 'child'));
  fs.writeFileSync(path.join(folder, 'child', 'nested.mp3'), 'other-folder');
  const item = await service.mapPlaylist('1001', folder);
  assert.equal(item.onlineTracks.length, 5);
  assert.equal(item.trackCount, 65);
  assert.equal(item.localTracks.length, 65);
  assert.equal(new Set(item.localTracks.map((track) => track.filename)).size, 65);
  assert.equal(item.localTracks.filter((track) => track.localOnly).length, 60);
  assert.equal(item.localTracks.every((track) => track.local && track.action === 'keep'), true);
  assert.equal(item.needsSync, false);
  assert.equal(service.bootstrap({ summary: true }).local[0].trackCount, 65);
  assert.equal(db.all('SELECT * FROM playlist_tracks').length, 5);
  assert.equal(db.all('SELECT * FROM songs').length, 5);
});

test('仅本地文件取消选择在扫描和重启后保留，同步不下载、改名或删除它们', async (t) => {
  const { folder, service, db, fileStore, netease, root } = await fixture(t);
  const filename = 'Original local edit.mp3'; fs.writeFileSync(path.join(folder, filename), 'original-content');
  const item = await service.mapPlaylist('1001', folder);
  const local = item.localTracks[0];
  await retainOnlyLocal(service, item);
  service.updateSettings({ deleteRemoved: true });
  netease.getAudioResponse = async () => { throw new Error('Excluded songs must not download'); };
  await service.scanAll();
  service.startSync(); await service.syncPromise;
  assert.equal(service.tasks.getState().error, '');
  assert.equal(fs.readFileSync(path.join(folder, filename), 'utf8'), 'original-content');
  assert.deepEqual(fs.readdirSync(folder), [filename]);
  const restoredDb = await new Database(db.filePath).init();
  const restored = new AppService({ db: restoredDb, fileStore, netease, tasks: new TaskManager(), rootPath: root });
  t.after(() => restored.stop());
  const restoredLocal = restored.localDetail(item.id).localTracks[0];
  assert.equal(restoredLocal.id, local.id);
  assert.equal(restoredLocal.syncSelected, false);
  assert.equal(restoredLocal.action, 'keep');
  assert.equal(restored.localDetail(item.id).needsSync, false);
  assert.equal(restoredDb.all('SELECT * FROM songs').length, 0);
});

test('仅本地文件删除必须明确选择并同步，应用方案和撤销删除保持文件原样', async (t) => {
  const { folder, service } = await fixture(t);
  fs.writeFileSync(path.join(folder, 'Keep local.mp3'), 'keep-content');
  fs.writeFileSync(path.join(folder, 'Remove local.mp3'), 'remove-content');
  const item = await service.mapPlaylist('1001', folder);
  const local = item.localTracks.find((track) => track.filename === 'Remove local.mp3');
  let saved = await retainOnlyLocal(service, item, [{ id: local.id, action: 'remove', enabled: true }]);
  assert.equal(saved.needsSync, true);
  assert.equal(fs.existsSync(path.join(folder, local.filename)), true);
  saved = await service.saveTrackChoices(item.id, saved.revision, [{ id: local.id, action: 'keep', enabled: true }]);
  service.startSync(); await service.syncPromise;
  assert.equal(fs.existsSync(path.join(folder, local.filename)), true);
  saved = service.localDetail(item.id);
  await service.saveTrackChoices(item.id, saved.revision, [{ id: local.id, action: 'remove', enabled: true }]);
  service.startSync(); await service.syncPromise;
  assert.equal(service.tasks.getState().error, '');
  assert.equal(fs.existsSync(path.join(folder, local.filename)), false);
  assert.equal(fs.readFileSync(path.join(folder, 'Keep local.mp3'), 'utf8'), 'keep-content');
  assert.equal(service.localDetail(item.id).trackCount, 1);
});

test('磁盘增删即时反映在详情并拒绝旧方案，主列表缓存会自动失效', async (t) => {
  const { folder, service } = await fixture(t);
  fs.writeFileSync(path.join(folder, 'Local first.mp3'), 'first');
  const item = await service.mapPlaylist('1001', folder);
  const runtime = await createServer({ service, port: 0 });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  let response = await fetch(`${runtime.url}/api/bootstrap`);
  const etag = response.headers.get('etag');
  assert.equal((await response.json()).local[0].trackCount, 1);
  fs.writeFileSync(path.join(folder, 'Local second.mp3'), 'second');
  await new Promise((resolve) => setTimeout(resolve, 1050));
  response = await fetch(`${runtime.url}/api/bootstrap`, { headers: { 'If-None-Match': etag } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).local[0].trackCount, 2);
  const detail = service.localDetail(item.id);
  assert.equal(detail.localTracks.length, 2);
  await assert.rejects(service.saveTrackChoices(item.id, item.revision, []), /内容已改变/);
  fs.unlinkSync(path.join(folder, 'Local first.mp3'));
  assert.equal(service.localDetail(item.id).localTracks.length, 1);
  assert.equal(service.bootstrap({ summary: true }).local[0].trackCount, 1);
});

test('根目录仅列直属音频，子目录和实体库不混入', async (t) => {
  const { root, folder, service, fileStore } = await fixture(t, true);
  fs.writeFileSync(path.join(folder, 'Root local.opus'), 'root-local');
  fs.mkdirSync(path.join(root, 'child'));
  fs.writeFileSync(path.join(root, 'child', 'Child local.mp3'), 'child-local');
  fs.writeFileSync(path.join(fileStore.songsPath, 'Entity.mp3'), 'entity-local');
  const item = await service.mapPlaylist('1001', folder);
  assert.deepEqual(item.localTracks.map((track) => track.filename), ['Root local.opus']);
  await assert.rejects(service.saveTrackChoices(item.id, item.revision, [{ id: item.localTracks[0].id, action: 'add' }]), /只能留存或删除/);
  assert.equal(fs.readFileSync(path.join(root, 'child', 'Child local.mp3'), 'utf8'), 'child-local');
});

test('仅本地文件后来匹配在线歌曲，仍保留之前取消同步的选择', async (t) => {
  const { folder, service, netease } = await fixture(t);
  const filename = 'Fixture Artist - Future Track.mp3';
  fs.writeFileSync(path.join(folder, filename), 'original-content');
  const item = await service.mapPlaylist('1001', folder);
  await retainOnlyLocal(service, item);
  const original = netease.getPlaylist.bind(netease);
  netease.getPlaylist = async (...args) => {
    const detail = await original(...args);
    return { ...detail, tracks: [...detail.tracks, { id: '600', name: 'Future Track', artists: ['Fixture Artist'], album: '', duration: 1000 }] };
  };
  await service.scanAll();
  const current = service.localDetail(item.id);
  assert.equal(current.localTracks.length, 1);
  assert.equal(current.localTracks[0].id, '600');
  assert.equal(current.localTracks[0].syncSelected, false);
  assert.equal(fs.readFileSync(path.join(folder, filename), 'utf8'), 'original-content');
});

test('不迁移切换音乐库时，旧目录的本地删除方案不能作用于新目录同名文件', async (t) => {
  const { root, folder, service } = await fixture(t);
  const filename = 'Local original.mp3';
  fs.writeFileSync(path.join(folder, filename), 'old-library-content');
  const item = await service.mapPlaylist('1001', folder);
  await retainOnlyLocal(service, item, [{ id: item.localTracks[0].id, action: 'remove', enabled: true }]);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-inventory-target-'));
  t.after(() => { assert.ok(path.basename(target).startsWith('ncmsync-inventory-target-')); fs.rmSync(target, { recursive: true, force: true }); });
  const targetFolder = path.join(target, path.relative(root, folder)); fs.mkdirSync(targetFolder, { recursive: true });
  fs.writeFileSync(path.join(targetFolder, filename), 'new-library-content');
  await service.changeLibrary(target, false);
  const current = service.localDetail(item.id);
  assert.equal(current.localTracks.length, 1);
  assert.equal(current.localTracks[0].action, 'keep');
  assert.equal(current.removed.length, 0);
  assert.equal(fs.readFileSync(path.join(folder, filename), 'utf8'), 'old-library-content');
  assert.equal(fs.readFileSync(path.join(targetFolder, filename), 'utf8'), 'new-library-content');
});
