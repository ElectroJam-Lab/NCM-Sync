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

async function fixture(t, prepare = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-mapping-'));
  prepare(root);
  const fileStore = new FileStore(root);
  const db = await new Database(path.join(fileStore.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({ db, fileStore, netease: new NeteaseClient({ mock: true }), tasks, rootPath: root });
  t.after(async () => {
    service.stop();
    if (tasks.active) await service.cancelTask(false);
    assert.ok(path.basename(root).startsWith('ncmsync-mapping-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.setupUser('123456789');
  service.setSyncSelection(service.onlinePlaylists().map((item) => item.id));
  await service.discoverExistingPlaylistFolders();
  return { root, fileStore, db, tasks, service };
}

async function addExisting(service, ids) {
  for (const id of ids) {
    const row = service.onlinePlaylists().find((item) => item.id === id);
    fs.mkdirSync(path.join(service.rootPath, row.name), { recursive: true });
  }
  return service.addLocal(ids);
}

async function sync(service, ids) {
  service.startSync(ids);
  await service.syncPromise;
  assert.equal(service.tasks.getState().error, '');
}

test('递归识别唯一同名子目录并在原目录增量同步', async (t) => {
  const folder = path.join('DJ', 'Breaks', '夜航测试集');
  const { root, service } = await fixture(t, (root) => {
    fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, folder, 'Test Artist - Neon Run.mp3'), 'legacy');
    fs.mkdirSync(path.join(root, 'songs', '收藏节拍'), { recursive: true });
  });
  const item = service.localPlaylists()[0];
  assert.equal(item.folderName, folder);
  assert.equal(item.folderPath, path.join(root, folder));
  assert.equal(item.displayName, '夜航测试集');
  assert.equal(item.existing.length, 1);
  assert.equal(item.added.length, 1);
  assert.equal(service.localPlaylists().length, 1, '实体库下的目录不能被识别为歌单');
  await sync(service);
  assert.equal(fs.readdirSync(path.join(root, folder)).length, 2);
  assert.equal(fs.existsSync(path.join(root, '夜航测试集')), false);
});

test('优先选择根目录同名文件夹；多个同名子目录不能误绑', async (t) => {
  const { service } = await fixture(t, (root) => {
    for (const folder of ['夜航测试集', path.join('A', '夜航测试集'), path.join('B', '收藏节拍'), path.join('C', '收藏节拍')]) fs.mkdirSync(path.join(root, folder), { recursive: true });
  });
  assert.equal(service.localPlaylists().length, 1);
  assert.equal(service.localPlaylists()[0].folderName, '夜航测试集');
  await assert.rejects(service.addLocal(['1002']), /多个同名/);
  assert.equal(service.localPlaylists().length, 1);
});

test('重复在线名称不能自动绑定普通目录，带在线 ID 的目录可以精确识别', async (t) => {
  const { root, service } = await fixture(t);
  const online = service.onlinePlaylists();
  service.storeOnline(online.map((row) => ({ ...row, name: row.id === '1002' ? '夜航测试集' : row.name })));
  fs.mkdirSync(path.join(root, 'A', '夜航测试集'), { recursive: true });
  fs.mkdirSync(path.join(root, 'B', '夜航测试集 [1001]'), { recursive: true });
  await service.discoverExistingPlaylistFolders();
  assert.equal(service.localPlaylists().length, 1);
  assert.equal(service.localPlaylists()[0].onlineId, '1001');
  assert.equal(service.localPlaylists()[0].folderName, path.join('B', '夜航测试集 [1001]'));
});

test('自定义映射支持任意名称和子层级，重映射保留原目录及文件', async (t) => {
  const { root, service, db } = await fixture(t);
  const first = path.join(root, 'sets', 'weekend');
  const second = path.join(root, 'sets', 'new-set');
  fs.mkdirSync(first, { recursive: true }); fs.mkdirSync(second);
  fs.writeFileSync(path.join(first, 'Test Artist - Neon Run.mp3'), 'original-song');
  fs.writeFileSync(path.join(first, 'notes.txt'), 'keep notes');
  const item = await service.mapPlaylist('1001', first);
  assert.equal(item.customMapping, true);
  assert.equal(item.pendingName, null);
  db.setSettings({ renamePolicy: 'auto' });
  await service.scanAll();
  assert.equal(service.localDetail(item.id).folderPath, first);
  await sync(service, [item.id]);
  const moved = await service.mapPlaylist('1001', second, item.id);
  assert.equal(moved.folderPath, second);
  assert.equal(moved.trackCount, 0);
  assert.equal(fs.readFileSync(path.join(first, 'notes.txt'), 'utf8'), 'keep notes');
  assert.equal(fs.existsSync(path.join(first, 'Test Artist - Neon Run.mp3')), true);
  await sync(service, [item.id]);
  assert.equal(fs.readdirSync(second).length, 2);
  assert.equal(fs.existsSync(path.join(root, '夜航测试集')), false);
});

test('映射拒绝库外路径、保留目录、重复来源和重复目录，允许父子目录共存', async (t) => {
  const { root, service } = await fixture(t);
  const target = path.join(root, 'sets', 'mix'); fs.mkdirSync(target, { recursive: true });
  await assert.rejects(service.mapPlaylist('1001', path.dirname(root)), /音乐库内/);
  await assert.rejects(service.mapPlaylist('1001', path.join(root, 'songs')), /实体库/);
  await assert.rejects(service.mapPlaylist('1001', path.join(root, '.cloudmusic')), /应用数据/);
  await service.mapPlaylist('1001', target);
  await assert.rejects(service.mapPlaylist('1002', target), /重复映射/);
  const parent = await service.mapPlaylist('1002', path.join(root, 'sets'));
  assert.equal(parent.folderPath, path.join(root, 'sets'));
  fs.mkdirSync(path.join(target, 'child'));
  const child = await service.mapPlaylist('1999', path.join(target, 'child'));
  assert.equal(child.folderPath, path.join(target, 'child'));
  fs.mkdirSync(path.join(root, 'other'));
  await assert.rejects(service.mapPlaylist('1001', path.join(root, 'other')), /已有本地映射/);
});

test('根目录映射只识别直属歌曲，与子目录映射独立且不能重复占用根目录', async (t) => {
  const { root, service, fileStore, db } = await fixture(t);
  fs.writeFileSync(path.join(root, 'Test Artist - Neon Run.mp3'), 'root-neon');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'unrelated-root-file');
  const child = path.join(root, 'Saved'); fs.mkdirSync(child);
  fs.writeFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'child-saved');
  fs.writeFileSync(path.join(child, 'Demo Unit - Last Train.mp3'), 'not-a-root-song');
  const saved = await service.mapPlaylist('1002', child);
  const item = await service.mapPlaylist('1001', root);
  assert.equal(item.folderName, '.');
  assert.equal(item.libraryRoot, true);
  assert.equal(item.folderPath, root);
  assert.equal(item.displayName, '夜航测试集（音乐库根目录）');
  assert.deepEqual(item.existing.map((track) => track.id), ['501']);
  assert.deepEqual(item.added.map((track) => track.id), ['502']);
  assert.equal(fileStore.relativePlaylistPath(root), '.');
  await assert.rejects(service.mapPlaylist('1999', root), /重复/);
  await assert.rejects(service.mapPlaylist('1999', ''), /请选择/);
  await assert.rejects(fileStore.removePlaylistFolder('.'), /拒绝删除/);
  await assert.rejects(service.syncFolderName(item.id), /根目录不能/);
  await sync(service, [item.id]);
  assert.ok(fs.existsSync(path.join(root, 'Demo Unit - Last Train [502].mp3')));
  assert.equal(fs.readFileSync(path.join(child, 'Demo Unit - Last Train.mp3'), 'utf8'), 'not-a-root-song');
  await service.scanAll();
  assert.equal(service.localDetail(item.id).folderName, '.');
  assert.equal(service.localDetail(saved.id).folderPath, child);
  const retained = fs.readdirSync(root).sort();
  const entities = fs.readdirSync(fileStore.songsPath).sort();
  await service.removeLocal([item.id]);
  assert.deepEqual(fs.readdirSync(root).sort(), retained, '移除根目录映射不能删除根目录文件');
  assert.deepEqual(fs.readdirSync(fileStore.songsPath).sort(), entities, '实体文件也应保留');
  await sync(service, [saved.id]);
  assert.deepEqual(fs.readdirSync(fileStore.songsPath).sort(), entities, '其他歌单同步不能清理已保留的文件');
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'unrelated-root-file');
  assert.ok(fs.existsSync(db.filePath));
  assert.equal(service.localPlaylists().length, 1);
});

test('根目录映射可以先创建，后续同名子目录仍能发现；逐曲删除只删除对应文件', async (t) => {
  const { root, service } = await fixture(t);
  const item = await service.mapPlaylist('1001', root);
  const child = path.join(root, 'sets', '收藏节拍'); fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'child-content');
  fs.writeFileSync(path.join(root, 'unmanaged.mp3'), 'unmanaged');
  await service.scanAll();
  assert.equal(service.localPlaylists().length, 2);
  await sync(service, [item.id]);
  const current = service.localDetail(item.id);
  await service.saveTrackChoices(item.id, current.revision, [{ id: '502', action: 'remove', enabled: true }]);
  await sync(service, [item.id]);
  assert.equal(fs.existsSync(path.join(root, 'Demo Unit - Last Train [502].mp3')), false);
  assert.equal(fs.readFileSync(path.join(root, 'unmanaged.mp3'), 'utf8'), 'unmanaged');
  assert.equal(fs.readFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'utf8'), 'child-content');
  assert.ok(fs.existsSync(path.join(root, '.cloudmusic')));
});

test('根目录映射迁移仅迁移已管理歌曲，保留原音乐库的无关文件和目录', async (t) => {
  const { root, service, db } = await fixture(t);
  fs.writeFileSync(path.join(root, 'Test Artist - Neon Run.mp3'), 'root-original');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'keep notes');
  fs.mkdirSync(path.join(root, 'unmanaged'));
  fs.writeFileSync(path.join(root, 'unmanaged', 'sample.wav'), 'keep sample');
  const item = await service.mapPlaylist('1001', root);
  await sync(service, [item.id]);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-mapping-migrate-'));
  t.after(() => {
    assert.ok(path.basename(destination).startsWith('ncmsync-mapping-migrate-'));
    fs.rmSync(destination, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(destination, 'Test Artist - Neon Run.mp3'), 'existing-target');
  await assert.rejects(service.changeLibrary(destination, true), /已存在同名歌曲/);
  assert.equal(fs.readFileSync(path.join(root, 'Test Artist - Neon Run.mp3'), 'utf8').includes('root-original'), true);
  assert.equal(fs.readFileSync(path.join(destination, 'Test Artist - Neon Run.mp3'), 'utf8'), 'existing-target');
  fs.rmSync(path.join(destination, 'Test Artist - Neon Run.mp3'));
  await service.changeLibrary(destination, true);
  assert.equal(service.localDetail(item.id).folderPath, destination);
  assert.equal(service.localDetail(item.id).trackCount, 2);
  assert.equal(fs.existsSync(path.join(root, 'Test Artist - Neon Run.mp3')), false);
  assert.equal(fs.existsSync(path.join(root, 'Demo Unit - Last Train [502].mp3')), false);
  assert.equal(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8'), 'keep notes');
  assert.equal(fs.readFileSync(path.join(root, 'unmanaged', 'sample.wav'), 'utf8'), 'keep sample');
  assert.ok(fs.existsSync(db.filePath));
});

test('目录联接不被递归读取，也不能作为手动映射和删除目标', async (t) => {
  const { root, service, fileStore } = await fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-mapping-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(outside, '夜航测试集'));
  const junction = path.join(root, 'linked');
  fs.symlinkSync(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  const folders = await fileStore.listPlaylistFolders();
  assert.equal(folders.some((folder) => folder.startsWith('linked')), false);
  await assert.rejects(service.mapPlaylist('1001', path.join(junction, '夜航测试集')), /符号链接|目录联接/);
  await assert.rejects(fileStore.removePlaylistFolder('linked'), /符号链接|目录联接/);
  assert.equal(fs.existsSync(path.join(outside, '夜航测试集')), true);
});

test('被目录联接替换的映射进入离线状态，不影响其他歌单和后续修复', async (t) => {
  const { root, service } = await fixture(t);
  await addExisting(service, ['1001', '1002']);
  const item = service.localPlaylists().find((row) => row.onlineId === '1001');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-mapping-external-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.rmdirSync(item.folderPath);
  fs.symlinkSync(outside, item.folderPath, process.platform === 'win32' ? 'junction' : 'dir');
  await service.scanAll();
  assert.equal(service.localDetail(item.id).offline, true);
  await sync(service);
  assert.equal(service.localPlaylists().find((row) => row.onlineId === '1002').trackCount, 1);
  assert.equal(fs.readdirSync(outside).length, 0);
  const repaired = path.join(root, 'repaired'); fs.mkdirSync(repaired);
  await service.mapPlaylist('1001', repaired, item.id);
  await sync(service, [item.id]);
  assert.equal(service.localDetail(item.id).trackCount, 2);
});

test('逐曲方案保存不修改文件；留存、跳过、删除在扫描和重启后保持，且只作用于当前歌单', async (t) => {
  const { service, root, db, fileStore } = await fixture(t);
  await addExisting(service, ['1001', '1002']);
  const item = service.localPlaylists().find((row) => row.onlineId === '1001');
  let saved = await service.saveTrackChoices(item.id, item.revision, [{ id: '502', action: 'keep' }]);
  assert.equal(fs.readdirSync(saved.folderPath).length, 0, '保存方案不能下载或删除');
  await sync(service, [item.id]);
  assert.equal(fs.readdirSync(saved.folderPath).length, 1);
  assert.equal(service.localPlaylists().find((row) => row.onlineId === '1002').trackCount, 0);
  await service.scanAll();
  assert.equal(service.localDetail(item.id).added.length, 0, '忽略的在线曲目不能因重新扫描而重新下载');
  const restartedDb = await new Database(db.filePath).init();
  const restarted = new AppService({ db: restartedDb, fileStore, netease: service.netease, tasks: new TaskManager(), rootPath: root });
  assert.equal(restarted.localDetail(item.id).existing.some((track) => track.id === '502' && !track.local), true);
  saved = await service.saveTrackChoices(item.id, service.localDetail(item.id).revision, [{ id: '501', action: 'remove' }, { id: '502', action: 'add' }]);
  assert.equal(fs.readdirSync(saved.folderPath).length, 1, '保存删除方案不能立即删除文件');
  await sync(service, [item.id]);
  assert.equal(db.get('SELECT * FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [item.id, '501']), null);
  assert.equal(db.get('SELECT * FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [item.id, '502']).track_id, '502');
  await service.scanAll();
  await sync(service, [item.id]);
  assert.equal(service.localDetail(item.id).trackCount, 1, '被明确删除的在线歌曲不能在后续同步自动加回');
});

test('明确留存覆盖全局删除开关，保存旧版本和任务中修改被拒绝', async (t) => {
  const { service, db } = await fixture(t);
  await addExisting(service, ['1001']); await sync(service);
  const item = service.localPlaylists()[0];
  db.setSettings({ deleteRemoved: true });
  const detail = await service.netease.getPlaylist('1001');
  await service.adoptAndDiff(item.id, { ...detail, tracks: detail.tracks.filter((track) => track.id !== '501') });
  const before = service.localDetail(item.id);
  const saved = await service.saveTrackChoices(item.id, before.revision, [{ id: '501', action: 'keep' }]);
  await assert.rejects(service.saveTrackChoices(item.id, before.revision, [{ id: '501', action: 'remove' }]), /内容已改变/);
  await sync(service);
  assert.ok(db.get('SELECT * FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [item.id, '501']));
  service.tasks.begin(1);
  await assert.rejects(service.saveTrackChoices(item.id, saved.revision, []), /任务结束/);
  await assert.rejects(service.mapPlaylist('1001', saved.folderPath, item.id), /任务结束/);
  service.tasks.finish();
});

test('一键同步只处理有效一对一映射，空选择不能扩大到所有歌单', async (t) => {
  const { service, db } = await fixture(t);
  await addExisting(service, ['1001', '1002']);
  const first = service.localPlaylists().find((row) => row.onlineId === '1001');
  const second = service.localPlaylists().find((row) => row.onlineId === '1002');
  assert.throws(() => service.startSync([]), /没有可用映射/);
  db.run('UPDATE local_playlists SET online_id=? WHERE id=?', ['missing-online', second.id]);
  await sync(service);
  assert.equal(service.localDetail(first.id).trackCount, 2);
  assert.equal(service.localDetail(second.id).trackCount, 0);
  assert.equal(service.localDetail(second.id).offline, false, '未勾选的来源不能被同步任务修改');
  fs.rmSync(first.folderPath, { recursive: true });
  assert.throws(() => service.startSync([first.id]), /没有可用映射/);
  assert.equal(fs.existsSync(first.folderPath), false, '同步不能自动新建丢失的映射目录');
});

test('轮询摘要不携带数千首歌曲，详情按需读取且静态轮询复用缓存', async (t) => {
  const { service, db } = await fixture(t);
  await addExisting(service, ['1999']);
  const item = service.localPlaylists()[0];
  const full = service.bootstrap();
  const summary = service.bootstrap({ summary: true });
  assert.equal(summary.local[0].addedCount, 4867);
  assert.equal(Object.hasOwn(summary.local[0], 'added'), false);
  assert.equal(Object.hasOwn(summary.local[0], 'onlineTracks'), false);
  assert.equal(Object.hasOwn(summary.local[0], 'localTracks'), false);
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 20);
  const originalAll = db.all.bind(db); let reads = 0;
  db.all = (...args) => { reads += 1; return originalAll(...args); };
  service.localPlaylists(); service.localPlaylists();
  assert.equal(reads, 0);
  const runtime = await createServer({ service, port: 0 });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  const response = await fetch(`${runtime.url}/api/local/${item.id}`);
  assert.equal((await response.json()).added.length, 4867);
  const rejected = await fetch(`${runtime.url}/api/local/${item.id}/choices`, { method: 'PUT', headers: { Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: item.revision, changes: [] }) });
  assert.equal(rejected.status, 403);
});
