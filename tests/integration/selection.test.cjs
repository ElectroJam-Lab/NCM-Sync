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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-selection-'));
  const fileStore = new FileStore(root);
  const db = await new Database(path.join(fileStore.dataPath, 'test.sqlite')).init();
  const netease = new NeteaseClient({ mock: true });
  const tasks = new TaskManager();
  const service = new AppService({ db, fileStore, netease, tasks, rootPath: root });
  const details = [];
  const getPlaylist = netease.getPlaylist.bind(netease);
  netease.getPlaylist = async (id) => { details.push(id); return getPlaylist(id); };
  t.after(async () => {
    service.stop();
    if (tasks.active) await service.cancelTask(false);
    assert.ok(path.basename(root).startsWith('ncmsync-selection-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, fileStore, db, netease, tasks, service, details };
}

test('首次设置、刷新和所有自动入口默认不操作未勾选歌单', async (t) => {
  const { root, service, details, db } = await fixture(t);
  for (const folder of ['夜航测试集', '收藏节拍']) fs.mkdirSync(path.join(root, 'DJ', folder), { recursive: true });
  await service.setupUser('123456789');
  assert.deepEqual(service.bootstrap().settings.syncPlaylistIds, []);
  assert.equal(service.localPlaylists().length, 0);
  await service.refreshOnline();
  await service.scanAll();
  db.setSettings({ realtimeSync: true });
  await service.runAutomaticCycle('realtime', true);
  await service.runAutomaticCycle('auto', true);
  assert.deepEqual(details, []);
  assert.equal(service.tasks.active, false);
  assert.throws(() => service.startSync(), /请先勾选/);
  assert.equal(fs.readdirSync(fileStorePath(root)).length, 0);
  service.setSyncSelection(['1001']);
  await service.syncSelected(); await service.syncPromise;
  assert.ok(details.length > 0 && details.every((id) => id === '1001'));
  assert.equal(service.localPlaylists().length, 1);
  assert.equal(fs.readdirSync(path.join(root, 'DJ', '夜航测试集')).length, 2);
  assert.equal(fs.readdirSync(path.join(root, 'DJ', '收藏节拍')).length, 0);
  assert.equal(fs.existsSync(path.join(root, '夜航测试集')), false);
  const reopened = await new Database(service.db.filePath).init();
  assert.deepEqual(reopened.getSettings().syncPlaylistIds, ['1001']);
});

function fileStorePath(root) { return path.join(root, 'songs'); }

test('缺失目录不能因匹配、同步、打开或硬链接写入被自动创建', async (t) => {
  const { root, service, fileStore } = await fixture(t);
  await service.setupUser('123456789');
  service.setSyncSelection(['1001']);
  const added = await service.addLocal(['1001']);
  assert.deepEqual(added.added, []);
  assert.deepEqual(added.unmatched, ['夜航测试集']);
  await assert.rejects(service.syncSelected(), /没有可用映射/);
  assert.equal(fs.existsSync(path.join(root, '夜航测试集')), false);
  const folder = path.join(root, 'manual'); fs.mkdirSync(folder);
  const item = await service.mapPlaylist('1001', folder);
  fs.rmdirSync(folder);
  await assert.rejects(service.openLocal(item.id), /目录不存在/);
  await assert.rejects(fileStore.createPlaylistLink('missing-song', 'manual', 'song.mp3'), /文件夹不存在/);
  assert.equal(fs.existsSync(folder), false);
});

test('已有映射取消勾选后，手动、指定 ID、自动和启动都不能修改它', async (t) => {
  const { root, service, details, db, fileStore, netease } = await fixture(t);
  await service.setupUser('123456789');
  for (const id of ['1001', '1002']) {
    const folder = path.join(root, id); fs.mkdirSync(folder);
    await service.mapPlaylist(id, folder);
  }
  const excluded = service.localPlaylists().find((item) => item.onlineId === '1002');
  const before = db.get('SELECT * FROM local_playlists WHERE id=?', [excluded.id]);
  service.setSyncSelection(['1001']); details.length = 0;
  await service.syncSelected(); await service.syncPromise;
  assert.throws(() => service.startSync([excluded.id]), /没有可用映射/);
  await service.runAutomaticCycle('auto', true);
  const restarted = new AppService({ db, fileStore, netease, tasks: new TaskManager(), rootPath: root });
  restarted.start(); await restarted.startupScanPromise; restarted.stop();
  assert.ok(details.every((id) => id === '1001'));
  assert.deepEqual(db.get('SELECT * FROM local_playlists WHERE id=?', [excluded.id]), before);
  assert.equal(fs.readdirSync(excluded.folderPath).length, 0);
});

test('歌曲取消勾选持久化，既不下载也不删除或补写封面', async (t) => {
  const { root, service, db, netease } = await fixture(t);
  await service.setupUser('123456789'); service.setSyncSelection(['1001']);
  const folder = path.join(root, 'manual'); fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'untouched');
  const item = await service.mapPlaylist('1001', folder);
  await service.saveTrackChoices(item.id, item.revision, [
    { id: '501', action: 'remove', enabled: false }, { id: '502', action: 'add', enabled: false }
  ]);
  let audioCalls = 0; let coverCalls = 0;
  const audio = netease.getAudioResponse.bind(netease);
  const cover = netease.getCover.bind(netease);
  netease.getAudioResponse = (...args) => { audioCalls += 1; return audio(...args); };
  netease.getCover = (...args) => { coverCalls += 1; return cover(...args); };
  await service.syncSelected(); await service.syncPromise;
  assert.equal(audioCalls, 0); assert.equal(coverCalls, 0);
  assert.equal(fs.readFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'utf8'), 'untouched');
  assert.equal(fs.readdirSync(folder).length, 1);
  await service.scanAll();
  const reopened = await new Database(db.filePath).init();
  assert.equal(reopened.all('SELECT * FROM track_choices').every((row) => row.enabled === 0), true);
  const current = service.localDetail(item.id);
  await service.saveTrackChoices(item.id, current.revision, [{ id: '502', action: 'add', enabled: true }]);
  await service.syncSelected(); await service.syncPromise;
  assert.equal(audioCalls, 1);
  assert.equal(fs.readdirSync(folder).length, 2);
  assert.equal(fs.readFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'utf8'), 'untouched');
});

test('选择 API 拒绝无效来源、跨站写入与任务中的范围更改', async (t) => {
  const { service } = await fixture(t);
  await service.setupUser('123456789');
  const runtime = await createServer({ service, port: 0 });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));
  const put = (onlineIds, origin = runtime.url) => fetch(`${runtime.url}/api/sync/selection`, {
    method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ onlineIds })
  });
  assert.equal((await put(['missing'])).status, 400);
  assert.equal((await put(['1001'], 'https://untrusted.example')).status, 403);
  assert.equal((await put(['1001'])).status, 200);
  service.tasks.begin(1);
  assert.equal((await put([])).status, 400);
  assert.deepEqual(service.bootstrap().settings.syncPlaylistIds, ['1001']);
  service.tasks.finish();
});
