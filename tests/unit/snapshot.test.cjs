const test = require('node:test');
const assert = require('node:assert/strict');

test('不变摘要复用对象，任务进度变化保留歌单数组；单行变化和排序正确更新', async () => {
  const { reconcileSnapshot } = await import('../../src/renderer/snapshot.mjs');
  const original = { initialized: true, online: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }],
    local: [{ id: 'local', syncProgress: null }], settings: { mp3Bitrate: 0, syncPlaylistIds: ['one'] }, task: { downloaded: 0 } };
  const copy = () => JSON.parse(JSON.stringify(original));
  assert.equal(reconcileSnapshot(original, copy()), original);
  const progress = copy(); progress.task.downloaded = 1;
  const changed = reconcileSnapshot(original, progress);
  assert.equal(changed.online, original.online); assert.equal(changed.local, original.local); assert.equal(changed.settings, original.settings);
  assert.equal(changed.task.downloaded, 1);
  const renamed = copy(); renamed.online[0].name = 'Renamed';
  const renameResult = reconcileSnapshot(original, renamed);
  assert.equal(renameResult.online[1], original.online[1]); assert.equal(renameResult.online[0].name, 'Renamed');
  const reordered = copy(); reordered.online.reverse();
  const reorderResult = reconcileSnapshot(original, reordered);
  assert.equal(reorderResult.online[0], original.online[1]);
  const scope = copy(); scope.settings.syncPlaylistIds = [];
  assert.deepEqual(reconcileSnapshot(original, scope).settings.syncPlaylistIds, []);
});
