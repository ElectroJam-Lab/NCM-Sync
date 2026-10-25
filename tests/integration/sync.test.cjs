const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Database } = require('../../src/backend/database.cjs');
const { FileStore } = require('../../src/backend/file-store.cjs');
const { NeteaseClient, MOCK_COVER } = require('../../src/backend/netease.cjs');
const { TaskManager } = require('../../src/backend/task-manager.cjs');
const { AppService } = require('../../src/backend/app-service.cjs');

test('从在线歌单到 SQLite、实体文件和歌单硬链接的完整同步', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-integration-'));
  const root = path.join(base, 'library-old');
  fs.mkdirSync(root);
  t.after(() => {
    assert.ok(path.basename(base).startsWith('cloudmusic-integration-'));
    fs.rmSync(base, { recursive: true, force: true });
  });
  const store = new FileStore(root);
  const downloadTrack = store.downloadTrack.bind(store);
  let concurrentDownloads = 0;
  let maxConcurrentDownloads = 0;
  store.downloadTrack = async (...args) => {
    concurrentDownloads += 1;
    maxConcurrentDownloads = Math.max(maxConcurrentDownloads, concurrentDownloads);
    try { return await downloadTrack(...args); }
    finally { concurrentDownloads -= 1; }
  };
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({ db, fileStore: store, netease: new NeteaseClient({ mock: true }), tasks, rootPath: root, downloadConcurrency: 2 });
  service.start();
  t.after(() => service.stop());

  const setup = await service.setupUser('123456789');
  assert.equal(setup.online.length, 3);
  const result = await selectExisting(service, ['1001']);
  assert.equal(result.local[0].added.length, 2);
  assert.equal(fs.existsSync(path.join(root, '夜航测试集')), true);

  const manualTask = service.startSync();
  assert.equal(manualTask.source, 'manual');
  assert.equal(manualTask.concurrency, 2);
  await waitFor(() => !tasks.active);
  assert.equal(maxConcurrentDownloads, 2, '同一歌单中的歌曲应进行受控并发下载');
  const local = service.localPlaylists()[0];
  assert.equal(local.trackCount, 2);
  assert.equal(local.added.length, 0);
  assert.equal(local.status, 'synced');
  assert.deepEqual(local.existing.map((track) => track.name).sort(), ['Last Train', 'Neon Run']);
  assert.deepEqual(local.existing.map((track) => track.artists[0]).sort(), ['Demo Unit', 'Test Artist']);

  const entityFiles = fs.readdirSync(path.join(root, 'songs'));
  for (const file of entityFiles) {
    assert.ok(fs.readFileSync(path.join(root, 'songs', file)).includes(MOCK_COVER), '新下载的歌曲应嵌入封面');
  }
  for (const trackId of ['501', '502']) {
    const song = db.get('SELECT * FROM songs WHERE track_id=?', [trackId]);
    assert.equal(song.cover_embedded, 1);
    assert.match(song.cover_url, /mock\.test/);
  }

  db.run('UPDATE songs SET cover_embedded=0 WHERE track_id=?', ['502']);
  service.startSync();
  await waitFor(() => !tasks.active);
  assert.equal(db.get('SELECT * FROM songs WHERE track_id=?', ['502']).cover_embedded, 1, '缺封面的已下载歌曲应在同步时回填');

  const renamedDetail = await service.netease.getPlaylist('1001');
  await service.adoptAndDiff(local.id, { ...renamedDetail, name: '在线新名称' });
  assert.equal(service.localPlaylists()[0].displayName, '在线新名称（夜航测试集）');
  await service.syncFolderName(local.id);
  assert.equal(service.localPlaylists()[0].displayName, '在线新名称');
  fs.renameSync(path.join(root, '在线新名称'), path.join(root, '手动目录名'));
  await service.scan();
  assert.equal(service.localPlaylists()[0].status, 'offline');
  assert.equal(service.localPlaylists()[0].displayName, '手动目录名');
  await service.redirectLocal(local.id, '1001');
  assert.equal(service.localPlaylists()[0].displayName, '夜航测试集（手动目录名）');
  await service.syncFolderName(local.id);
  assert.equal(service.localPlaylists()[0].displayName, '夜航测试集');

  const entities = fs.readdirSync(path.join(root, 'songs'));
  const links = fs.readdirSync(path.join(root, '夜航测试集'));
  assert.equal(entities.length, 2);
  assert.equal(links.length, 2);
  assert.ok(fs.statSync(path.join(root, 'songs', entities[0])).nlink >= 2);

  const migratedRoot = path.join(base, 'library-migrated');
  let persistedPath = '';
  service.persistLibraryPath = async (value) => { persistedPath = value; };
  await service.changeLibrary(migratedRoot, true);
  assert.equal(service.rootPath, migratedRoot);
  assert.equal(persistedPath, migratedRoot);
  assert.equal(fs.existsSync(path.join(migratedRoot, '夜航测试集')), true);
  assert.equal(fs.readdirSync(path.join(migratedRoot, 'songs')).length, 2);
  const migratedEntity = fs.readdirSync(path.join(migratedRoot, 'songs'))[0];
  assert.ok(fs.statSync(path.join(migratedRoot, 'songs', migratedEntity)).nlink >= 2);

  const resetRoot = path.join(base, 'library-reset');
  await service.changeLibrary(resetRoot, false);
  assert.equal(fs.readdirSync(path.join(migratedRoot, 'songs')).length, 2, '不迁移时旧音乐保留');
  assert.equal(fs.readdirSync(path.join(resetRoot, 'songs')).length, 0);
  assert.equal(service.localPlaylists()[0].status, 'offline');
  await service.scan();
  assert.equal(service.localPlaylists()[0].added.length, 0);
  assert.equal(fs.existsSync(path.join(resetRoot, '夜航测试集')), false, '切换音乐库不能自动创建占位歌单目录');

  service.setLocalPaused([local.id], true);
  assert.equal(service.localPlaylists()[0].status, 'paused');
  await service.removeLocal([local.id]);
  assert.equal(service.localPlaylists().length, 0);
  assert.equal(fs.existsSync(path.join(resetRoot, '夜航测试集')), false);
  assert.equal(fs.readdirSync(path.join(resetRoot, 'songs')).length, 0);
});

test('删除歌单曲目后只清理不再属于任何本地歌单的歌曲实体', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-orphan-cleanup-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('ncmsync-orphan-cleanup-'));
    fs.rmSync(root, { recursive: true, force: true });
  });

  const store = new FileStore(root);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({ db, fileStore: store, netease: new NeteaseClient({ mock: true }), tasks, rootPath: root });
  service.start();
  t.after(() => service.stop());

  await service.setupUser('123456789');
  await selectExisting(service, ['1001']);
  service.startSync();
  await waitFor(() => !tasks.active);

  const original = service.localPlaylists()[0];
  const sharedSong = db.get('SELECT * FROM songs WHERE track_id=?', ['501']);
  const sharedId = 'local-shared-track';
  db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,created_at,track_count,added_at,added_json,removed_json,existing_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [sharedId, 'shared', '共享曲目歌单', '共享曲目歌单', 0, 1, Date.now(), '[]', '[]', '[]']);
  fs.mkdirSync(path.join(root, '共享曲目歌单'));
  await store.createPlaylistLink(sharedSong.entity_path, '共享曲目歌单', path.basename(sharedSong.entity_path));
  db.run('INSERT INTO playlist_tracks(playlist_id,track_id,filename,linked_at) VALUES (?,?,?,?)', [sharedId, '501', path.basename(sharedSong.entity_path), Date.now()]);

  db.setSettings({ deleteRemoved: true });
  db.run('UPDATE local_playlists SET removed_json=? WHERE id=?', [JSON.stringify([{ id: '501' }]), original.id]);
  service.startSync([original.id]);
  await waitFor(() => !tasks.active);

  assert.ok(fs.existsSync(sharedSong.entity_path), '歌曲仍被另一份本地歌单引用时必须保留实体');
  assert.equal(fs.existsSync(path.join(root, original.folderName, path.basename(sharedSong.entity_path))), false);
  assert.equal(fs.existsSync(path.join(root, '共享曲目歌单', path.basename(sharedSong.entity_path))), true);

  await service.removeLocal([sharedId]);
  assert.equal(db.get('SELECT COUNT(*) AS count FROM playlist_tracks WHERE track_id=?', ['501']).count, 0, '数据库关系应在删除本地歌单时级联清理');
  assert.equal(fs.existsSync(sharedSong.entity_path), false, '最后一个本地歌单引用被删除后应清理实体');
  assert.equal(db.get('SELECT * FROM songs WHERE track_id=?', ['501']), null);
  assert.equal(fs.readdirSync(path.join(root, 'songs')).length, 1, '未被删除的其他歌曲实体应保留');
});

test('自动扫描和实时同步复用可见任务状态，新添加歌单会立即并发下载', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-realtime-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('ncmsync-realtime-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new FileStore(root);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({
    db,
    fileStore: store,
    netease: new NeteaseClient({ mock: true }),
    tasks,
    rootPath: root,
    downloadConcurrency: 2,
    realtimeIntervalMs: 1_000
  });
  service.start();
  t.after(() => service.stop());

  await service.setupUser('123456789');
  await selectExisting(service, ['1001']);
  const automaticCycle = service.runAutomaticCycle('auto', true);
  assert.equal(service.bootstrap().scanning, true);
  assert.equal(service.bootstrap().scanSource, 'auto');
  assert.match(service.bootstrap().scanStatus, /自动扫描/);
  await automaticCycle;
  assert.equal(tasks.getState().active, true);
  assert.equal(tasks.getState().source, 'auto');
  assert.equal(tasks.getState().concurrency, 2);
  await waitFor(() => service.localPlaylists()[0].syncProgress?.startsWith('正在同步：'));
  await waitFor(() => !tasks.active);

  db.setSettings({ realtimeSync: true });
  const added = await selectExisting(service, ['1002']);
  assert.equal(added.added.length, 1);
  assert.equal(tasks.getState().active, true);
  assert.equal(tasks.getState().source, 'realtime');
  await waitFor(() => service.localPlaylists().some((playlist) => playlist.syncProgress === '正在同步：0/1'));
  await waitFor(() => !tasks.active);
  assert.equal(service.localPlaylists().find((playlist) => playlist.onlineId === '1002').status, 'synced');
});

test('首次修改音乐库会清理空默认目录，登录与启动扫描都会更新时间', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-library-'));
  const defaultRoot = path.join(base, 'Music', 'music library');
  const selectedRoot = path.join(base, 'selected-library');
  t.after(() => {
    assert.ok(path.basename(base).startsWith('ncmsync-library-'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  const store = new FileStore(defaultRoot);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({
    db,
    fileStore: store,
    netease: new NeteaseClient({ mock: true }),
    tasks,
    rootPath: defaultRoot,
    defaultLibraryPath: defaultRoot
  });
  service.start();
  t.after(() => service.stop());

  const setup = await service.setupUser('123456789');
  assert.ok(setup.lastScanAt, '首次登录后应记录扫描时间');
  await service.changeLibrary(selectedRoot, false, true);
  assert.equal(fs.existsSync(defaultRoot), false, '空的默认 music library 应被删除');
  assert.equal(fs.existsSync(selectedRoot), true);

  db.setSettings({ lastScanAt: null });
  service.stop();
  const restarted = new AppService({
    db,
    fileStore: service.fileStore,
    netease: new NeteaseClient({ mock: true }),
    tasks: new TaskManager(),
    rootPath: selectedRoot,
    defaultLibraryPath: defaultRoot
  });
  restarted.start();
  await restarted.startupScanPromise;
  assert.ok(restarted.bootstrap().lastScanAt, '应用启动扫描后应记录扫描时间');
  restarted.updateSettings({ removeLocalDontAsk: true });
  assert.equal(restarted.bootstrap().settings.removeLocalDontAsk, true);
  restarted.stop();
});

test('明确选择后识别同名目录，切换音乐库不能创建缺失歌单目录', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-discovery-'));
  const defaultRoot = path.join(base, 'default-library');
  const selectedRoot = path.join(base, 'selected-library');
  const nextRoot = path.join(base, 'next-library');
  fs.mkdirSync(path.join(selectedRoot, '夜航测试集'), { recursive: true });
  fs.writeFileSync(path.join(selectedRoot, '夜航测试集', 'Test Artist - Neon Run.mp3'), 'existing-neon-run');
  fs.mkdirSync(path.join(selectedRoot, '与歌单无关的文件夹'), { recursive: true });
  fs.mkdirSync(path.join(nextRoot, '收藏节拍'), { recursive: true });
  fs.writeFileSync(path.join(nextRoot, '收藏节拍', 'Friend - Saved Groove.mp3'), 'existing-saved-groove');
  t.after(() => {
    assert.ok(path.basename(base).startsWith('ncmsync-discovery-'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  const store = new FileStore(defaultRoot);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({
    db,
    fileStore: store,
    netease: new NeteaseClient({ mock: true }),
    tasks,
    rootPath: defaultRoot,
    defaultLibraryPath: defaultRoot
  });
  service.start();
  t.after(() => service.stop());

  await service.changeLibrary(selectedRoot, false, true);
  const setup = await service.setupUser('123456789');
  assert.equal(setup.local.length, 0, '首次设置只获取歌单列表');
  service.setSyncSelection(['1001', '1002']);
  await service.scanAll();
  const selected = service.bootstrap();
  assert.equal(selected.local.length, 1);
  assert.equal(selected.local[0].onlineId, '1001');
  assert.equal(selected.local[0].folderName, '夜航测试集');
  assert.deepEqual(selected.local[0].existing.map((track) => track.name), ['Neon Run']);
  assert.deepEqual(selected.local[0].added.map((track) => track.name), ['Last Train']);
  assert.equal(fs.readdirSync(path.join(selectedRoot, 'songs')).length, 1, '识别出的歌曲应被吸收到实体库');
  assert.equal(selected.local.some((playlist) => playlist.folderName === '与歌单无关的文件夹'), false);

  const changed = await service.changeLibrary(nextRoot, false);
  assert.match(changed.scanStatus, /已识别 1 个本地歌单/);
  assert.equal(changed.local.length, 2, '新位置中尚未管理的在线歌单文件夹也应直接加入本地列表');
  const saved = changed.local.find((playlist) => playlist.onlineId === '1002');
  assert.ok(saved);
  assert.equal(saved.status, 'synced');
  assert.deepEqual(saved.existing.map((track) => track.name), ['Saved Groove']);
  assert.equal(fs.existsSync(path.join(nextRoot, '夜航测试集')), false, '没有现有文件夹的原本地歌单不能创建空目录占位');
});

test('单曲下载失败时跳过该曲目并继续下载其余歌曲', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-skip-fail-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('ncmsync-skip-fail-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new FileStore(root);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const netease = new NeteaseClient({ mock: true });
  const originalGetAudio = netease.getAudioResponse.bind(netease);
  netease.getAudioResponse = async (trackId, signal) => {
    if (String(trackId) === '502') {
      throw new Error('歌曲无可用音源：音源代码 404。请确认会员或数字专辑权限，或稍后重试');
    }
    return originalGetAudio(trackId, signal);
  };
  const service = new AppService({ db, fileStore: store, netease, tasks, rootPath: root, downloadConcurrency: 2 });
  service.start();
  t.after(() => service.stop());

  await service.setupUser('123456789');
  await selectExisting(service, ['1001']);
  service.startSync();
  await waitFor(() => !tasks.active);

  const local = service.localPlaylists()[0];
  assert.equal(local.existing.length, 1, '可用的曲目应已下载');
  assert.equal(local.existing[0].id, '501');
  assert.equal(local.added.length, 1, '失败曲目应保留在待下载列表');
  assert.equal(local.added[0].id, '502');
  assert.equal(db.get('SELECT COUNT(*) AS c FROM songs WHERE track_id=?', ['501']).c, 1);
  assert.equal(db.get('SELECT COUNT(*) AS c FROM songs WHERE track_id=?', ['502']).c, 0);
  assert.match(service.bootstrap().scanStatus, /1 首下载失败已跳过/);
  assert.equal(tasks.getState().paused, false, '单曲失败不应暂停整个任务');
});

test('设置中的下载并发数会应用到下次同步', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-concurrency-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('ncmsync-concurrency-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const store = new FileStore(root);
  const db = await new Database(path.join(store.dataPath, 'test.sqlite')).init();
  const tasks = new TaskManager();
  const service = new AppService({ db, fileStore: store, netease: new NeteaseClient({ mock: true }), tasks, rootPath: root });
  service.start();
  t.after(() => service.stop());

  assert.equal(service.downloadConcurrency, 4, '默认并发应为 4');
  service.updateSettings({ downloadConcurrency: 6 });
  assert.equal(service.downloadConcurrency, 6);
  await service.setupUser('123456789');
  await selectExisting(service, ['1001']);
  const task = service.startSync();
  assert.equal(task.concurrency, 6, '下次同步应使用设置中的并发');
  await waitFor(() => !tasks.active);
});

async function selectExisting(service, ids) {
  service.setSyncSelection([...service.selectedOnlineIds(), ...ids]);
  for (const id of ids) {
    const row = service.onlinePlaylists().find((item) => item.id === id);
    fs.mkdirSync(path.join(service.rootPath, row.name), { recursive: true });
  }
  return service.addLocal(ids);
}

async function waitFor(predicate, timeout = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('等待任务完成超时');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
