const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Database } = require('../../src/backend/database.cjs');
const { FileStore } = require('../../src/backend/file-store.cjs');
const { AppService } = require('../../src/backend/app-service.cjs');
const { NeteaseClient } = require('../../src/backend/netease.cjs');
const { TaskManager } = require('../../src/backend/task-manager.cjs');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-nested-'));
  const fileStore = new FileStore(root);
  const db = await new Database(path.join(fileStore.dataPath, 'test.sqlite')).init();
  const netease = new NeteaseClient({ mock: true }); const tasks = new TaskManager();
  const service = new AppService({ db, fileStore, netease, tasks, rootPath: root });
  const parent = path.join(root, 'Parent mix'); const child = path.join(parent, 'Child mix');
  fs.mkdirSync(child, { recursive: true });
  t.after(async () => {
    service.stop(); if (tasks.active) await service.cancelTask(false);
    assert.ok(path.basename(root).startsWith('ncmsync-nested-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await service.setupUser('123456789'); service.setSyncSelection(['1001', '1002']);
  return { root, parent, child, fileStore, db, netease, service };
}

async function mapBoth(service, parent, child, childFirst = false) {
  const mappings = [['1001', parent], ['1002', child]];
  for (const [id, folder] of childFirst ? mappings.reverse() : mappings) await service.mapPlaylist(id, folder);
  return {
    parentItem: service.localPlaylists().find((item) => item.onlineId === '1001'),
    childItem: service.localPlaylists().find((item) => item.onlineId === '1002')
  };
}

for (const childFirst of [false, true]) test(`父子映射互相独立，${childFirst ? '先子后父' : '先父后子'}顺序不影响读取`, async (t) => {
  const { root, parent, child, service } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'Parent only.mp3'), 'parent-content');
  fs.writeFileSync(path.join(child, 'Child only.mp3'), 'child-content');
  const { parentItem, childItem } = await mapBoth(service, parent, child, childFirst);
  assert.equal(parentItem.trackCount, 1); assert.equal(childItem.trackCount, 1);
  assert.deepEqual(parentItem.localTracks.map((track) => track.filename), ['Parent only.mp3']);
  assert.deepEqual(childItem.localTracks.map((track) => track.filename), ['Child only.mp3']);
  await assert.rejects(service.mapPlaylist('1999', child), /不能重复映射同一文件夹/);
  const grandchild = path.join(child, 'Grandchild'); fs.mkdirSync(grandchild);
  const nested = await service.mapPlaylist('1999', grandchild);
  assert.equal(nested.folderPath, grandchild);
  assert.equal(service.localDetail(parentItem.id).folderPath, path.join(root, 'Parent mix'));
});

test('自动发现可同时匹配同名父目录和子目录，父同步不处理未选择子歌单', async (t) => {
  const { root, service, netease } = await fixture(t);
  const parent = path.join(root, '夜航测试集'); const child = path.join(parent, '收藏节拍');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'Child untouched.mp3'), 'child-content');
  const discovered = await service.discoverExistingPlaylistFolders();
  assert.equal(discovered.added, 2);
  const childItem = service.localPlaylists().find((item) => item.onlineId === '1002');
  const childBefore = service.db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]);
  service.setSyncSelection(['1001']);
  const downloads = []; const audio = netease.getAudioResponse.bind(netease);
  netease.getAudioResponse = (...args) => { downloads.push(args[0]); return audio(...args); };
  service.startSync(); await service.syncPromise;
  assert.equal(service.tasks.getState().error, ''); assert.deepEqual(downloads.sort(), ['501', '502']);
  assert.equal(fs.readFileSync(path.join(child, 'Child untouched.mp3'), 'utf8'), 'child-content');
  assert.deepEqual(service.db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]), childBefore);
  assert.equal(service.localPlaylists().find((item) => item.onlineId === '1001').trackCount, 2);
});

test('删除父歌单仅删直属音频，保留子映射、子文件和非音频文件', async (t) => {
  const { parent, child, service } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'Test Artist - Neon Run.mp3'), 'parent-original');
  fs.writeFileSync(path.join(parent, 'notes.txt'), 'parent-notes');
  fs.writeFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'child-original');
  const { parentItem, childItem } = await mapBoth(service, parent, child);
  const before = service.db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]);
  await service.removeLocal([parentItem.id]);
  assert.equal(fs.existsSync(path.join(parent, 'Test Artist - Neon Run.mp3')), false);
  assert.equal(fs.readFileSync(path.join(parent, 'notes.txt'), 'utf8'), 'parent-notes');
  assert.equal(fs.readFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'utf8'), 'child-original');
  assert.equal(service.localDetail(childItem.id).offline, false);
  assert.deepEqual(service.db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]), before);
  assert.deepEqual(service.db.getSettings().syncPlaylistIds, ['1002']);
  await service.scanAll();
  assert.equal(service.localPlaylists().some((item) => item.onlineId === '1001'), false, '保留父目录不能导致已移除歌单重新自动映射');
  assert.equal(service.db.get('SELECT * FROM songs WHERE track_id=?', ['501']), null);
  assert.ok(service.db.get('SELECT * FROM songs WHERE track_id=?', ['503']));
});

test('删除子歌单保留父歌曲；同时删除父子时能清理空目录', async (t) => {
  const { parent, child, service } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'Parent only.mp3'), 'parent-original');
  fs.writeFileSync(path.join(child, 'Child only.mp3'), 'child-original');
  let { parentItem, childItem } = await mapBoth(service, parent, child);
  await service.removeLocal([childItem.id]);
  assert.equal(fs.existsSync(child), false);
  assert.equal(fs.readFileSync(path.join(parent, 'Parent only.mp3'), 'utf8'), 'parent-original');
  assert.equal(service.localDetail(parentItem.id).trackCount, 1);
  fs.mkdirSync(child); fs.writeFileSync(path.join(child, 'Child again.mp3'), 'child-again');
  childItem = await service.mapPlaylist('1002', child);
  await service.removeLocal([parentItem.id, childItem.id]);
  assert.equal(fs.existsSync(parent), false); assert.equal(service.localPlaylists().length, 0);
});

test('父歌单改名仅移动直属音频，子路径与本地排除方案保持', async (t) => {
  const { root, parent, child, service, db } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'Test Artist - Neon Run.mp3'), 'parent-original');
  fs.writeFileSync(path.join(parent, 'Local excluded.mp3'), 'excluded-original');
  fs.writeFileSync(path.join(parent, 'notes.txt'), 'parent-notes');
  fs.writeFileSync(path.join(child, 'Child only.mp3'), 'child-original');
  const { parentItem, childItem } = await mapBoth(service, parent, child);
  const excluded = parentItem.localTracks.find((track) => track.localOnly);
  await service.saveTrackChoices(parentItem.id, parentItem.revision, [{ id: excluded.id, action: 'keep', enabled: false }]);
  const childBefore = db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]);
  db.run('UPDATE local_playlists SET name=? WHERE id=?', ['Renamed parent', parentItem.id]);
  await service.syncFolderName(parentItem.id);
  const renamed = service.localDetail(parentItem.id);
  assert.equal(renamed.folderPath, path.join(root, 'Renamed parent'));
  assert.equal(renamed.localTracks.find((track) => track.filename === 'Local excluded.mp3').syncSelected, false);
  assert.equal(fs.existsSync(path.join(parent, 'Local excluded.mp3')), false);
  assert.equal(fs.readFileSync(path.join(renamed.folderPath, 'Local excluded.mp3'), 'utf8'), 'excluded-original');
  assert.equal(fs.readFileSync(path.join(parent, 'notes.txt'), 'utf8'), 'parent-notes');
  assert.equal(fs.readFileSync(path.join(child, 'Child only.mp3'), 'utf8'), 'child-original');
  assert.equal(service.localDetail(childItem.id).folderPath, child);
  assert.deepEqual(db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]), childBefore);
});

test('自动同步父目录名称也不能移动或更改未选择子歌单', async (t) => {
  const { root, service, netease, db } = await fixture(t);
  const parent = path.join(root, '夜航测试集'); const child = path.join(parent, '收藏节拍');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, 'Test Artist - Neon Run.mp3'), 'parent-original');
  fs.writeFileSync(path.join(child, 'Child only.mp3'), 'child-original');
  await service.discoverExistingPlaylistFolders();
  const parentItem = service.localPlaylists().find((item) => item.onlineId === '1001');
  const childItem = service.localPlaylists().find((item) => item.onlineId === '1002');
  const before = db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]);
  service.setSyncSelection(['1001']); service.updateSettings({ renamePolicy: 'auto' });
  const original = netease.getPlaylist.bind(netease);
  netease.getPlaylist = async (...args) => ({ ...await original(...args), name: 'Auto renamed parent' });
  await service.scan();
  assert.equal(service.localDetail(parentItem.id).folderPath, path.join(root, 'Auto renamed parent'));
  assert.equal(fs.readFileSync(path.join(child, 'Child only.mp3'), 'utf8'), 'child-original');
  assert.deepEqual(db.get('SELECT * FROM local_playlists WHERE id=?', [childItem.id]), before);
});

test('子映射先创建时迁移父子目录只搬一次，目标冲突在移动源文件前拒绝', async (t) => {
  const { root, parent, child, service, fileStore, db } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'Test Artist - Neon Run.mp3'), 'parent-original');
  fs.writeFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'child-original');
  fs.writeFileSync(path.join(child, 'Child local.mp3'), 'child-local');
  const { parentItem, childItem } = await mapBoth(service, parent, child, true);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-nested-target-'));
  t.after(() => { assert.ok(path.basename(destination).startsWith('ncmsync-nested-target-')); fs.rmSync(destination, { recursive: true, force: true }); });
  const targetParent = path.join(destination, path.relative(root, parent));
  const targetChild = path.join(destination, path.relative(root, child));
  fs.mkdirSync(targetParent, { recursive: true }); fs.writeFileSync(path.join(targetParent, 'Conflict.mp3'), 'target-content');
  const entities = fs.readdirSync(fileStore.songsPath).sort();
  await assert.rejects(service.changeLibrary(destination, true), /目标目录不是空目录/);
  assert.deepEqual(fs.readdirSync(fileStore.songsPath).sort(), entities);
  assert.equal(fs.readFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'utf8'), 'child-original');
  fs.unlinkSync(path.join(targetParent, 'Conflict.mp3'));
  await service.changeLibrary(destination, true);
  assert.equal(service.localDetail(parentItem.id).folderPath, targetParent);
  assert.equal(service.localDetail(childItem.id).folderPath, targetChild);
  assert.equal(fs.readFileSync(path.join(targetChild, 'Child local.mp3'), 'utf8'), 'child-local');
  assert.equal(fs.existsSync(parent), false);
  for (const [id, folder, filename] of [['501', targetParent, 'Test Artist - Neon Run.mp3'], ['503', targetChild, 'Friend - Saved Groove.mp3']]) {
    const song = db.get('SELECT * FROM songs WHERE track_id=?', [id]);
    assert.equal(fs.statSync(path.join(folder, filename)).ino, fs.statSync(song.entity_path).ino);
  }
});

test('父目录改名途中写入失败会恢复已移动音频，子目录保持原样', async (t) => {
  const { parent, child, fileStore, root } = await fixture(t);
  fs.writeFileSync(path.join(parent, 'a.mp3'), 'first-original');
  fs.writeFileSync(path.join(parent, 'b.mp3'), 'second-original');
  fs.writeFileSync(path.join(child, 'Child only.mp3'), 'child-original');
  const original = fsp.link;
  t.mock.method(fsp, 'link', async (source, target) => {
    if (source === path.join(parent, 'b.mp3')) throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
    return original(source, target);
  });
  await assert.rejects(fileStore.renamePlaylistFolder(path.relative(root, parent), 'Failed rename'), /simulated disk failure/);
  assert.equal(fs.readFileSync(path.join(parent, 'a.mp3'), 'utf8'), 'first-original');
  assert.equal(fs.readFileSync(path.join(parent, 'b.mp3'), 'utf8'), 'second-original');
  assert.equal(fs.readFileSync(path.join(child, 'Child only.mp3'), 'utf8'), 'child-original');
  assert.equal(fs.existsSync(path.join(root, 'Failed rename')), false);
});
