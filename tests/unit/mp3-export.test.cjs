const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exportMp3 } = require('../../src/backend/mp3-export.cjs');
const { TaskManager } = require('../../src/backend/task-manager.cjs');
const { wavFixture, assertMp3Bitrate } = require('../audio-fixture.cjs');

function fixture(t, content = wavFixture()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-mp3-'));
  t.after(() => { assert.ok(path.basename(root).startsWith('ncmsync-mp3-')); fs.rmSync(root, { recursive: true, force: true }); });
  const entityPath = path.join(root, 'test.wav'); fs.writeFileSync(entityPath, content);
  return { root, downloaded: { entityPath, filename: 'test.wav', extension: 'wav', created: true }, content };
}

test('保留源音质不转码，四种 MP3 码率均输出真实固定码率音频', async (t) => {
  const { root, downloaded, content } = fixture(t);
  const tasks = new TaskManager(); const control = tasks.begin(1);
  assert.equal(await exportMp3(downloaded, 0, control), downloaded);
  assert.deepEqual(fs.readFileSync(downloaded.entityPath), content);
  for (const bitrate of [128,192,256,320]) {
    fs.writeFileSync(downloaded.entityPath, content);
    const result = await exportMp3(downloaded, bitrate, control);
    assert.equal(result.extension, 'mp3');
    assert.equal(result.filename, 'test.mp3');
    assert.ok(result.size > 0);
    assertMp3Bitrate(fs.readFileSync(result.entityPath), bitrate);
    assert.equal(fs.existsSync(downloaded.entityPath), false);
  }
  assert.deepEqual(fs.readdirSync(root), ['test.mp3']);
});

test('转码失败保留源文件并清理未完成输出', async (t) => {
  const { root, downloaded, content } = fixture(t, Buffer.from('invalid audio'));
  await assert.rejects(exportMp3(downloaded, 192, new TaskManager().begin(1)), /转码失败/);
  assert.deepEqual(fs.readFileSync(downloaded.entityPath), content);
  assert.deepEqual(fs.readdirSync(root), ['test.wav']);
});

test('取消编码终止进程，保留源文件并清理暂存文件', async (t) => {
  const { root, downloaded, content } = fixture(t, wavFixture(60));
  const tasks = new TaskManager(); const control = tasks.begin(1);
  const timer = setTimeout(() => tasks.cancel(), 20);
  try { await assert.rejects(exportMp3(downloaded, 320, control), { name: 'CancelledError' }); }
  finally { clearTimeout(timer); }
  assert.deepEqual(fs.readFileSync(downloaded.entityPath), content);
  assert.deepEqual(fs.readdirSync(root), ['test.wav']);
});
