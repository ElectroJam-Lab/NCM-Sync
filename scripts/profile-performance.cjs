// Reproducible renderer measurements; synthetic account and temporary library only.
const { _electron: electron, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const project = path.resolve(__dirname, '..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-profile-'));
  const root = path.join(base, 'library'); const folder = path.join(root, 'Large mix'); fs.mkdirSync(folder, { recursive: true });
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: project,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    await app.evaluate(({ app }) => {
      const requireModule = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const { NeteaseClient } = requireModule('./src/backend/netease.cjs');
      const original = NeteaseClient.prototype.getUserPlaylists;
      NeteaseClient.prototype.getUserPlaylists = async function (id) {
        return [...await original.call(this, id), ...Array.from({ length: 600 }, (_, index) => ({
          id: `profile-${index}`, name: `Performance Playlist ${index}`, creatorId: '123456789',
          createdAt: index, trackCount: 20, kind: 'created', coverUrl: ''
        }))];
      };
    });
    const page = await app.firstWindow();
    await page.getByTestId('setup-user-id').fill('123456789'); await page.getByRole('button', { name: '验证并继续' }).click();
    const cdp = await page.context().newCDPSession(page); await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(({ name, value }) => [name, value]));
    const measure = async (selector, dragging = false) => {
      const before = await metrics();
      const timings = await page.evaluate(async ({ selector, dragging }) => {
        const list = document.querySelector(selector);
        const max = list.scrollHeight - list.clientHeight; const frames = []; let last = performance.now();
        const transfer = new DataTransfer(); transfer.setData('application/x-ncmsync-track', '{}');
        const columns = [...document.querySelectorAll('.comparison-column')];
        for (let i = 0; i < 90; i++) {
          await new Promise(requestAnimationFrame); const now = performance.now(); frames.push(now - last); last = now;
          list.scrollTop = Math.round(max * ((i % 30) / 29));
          if (dragging) {
            columns[i % 2].dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
            columns[i % 2].dispatchEvent(new DragEvent('dragleave', { bubbles: true, dataTransfer: transfer }));
          }
        }
        return frames.sort((a, b) => a - b);
      }, { selector, dragging });
      const after = await metrics();
      return { scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
        taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
        frameP95Ms: Math.round(timings[Math.floor(timings.length * .95)]),
        domRows: await page.locator(dragging ? '.comparison-song-row' : '.online-pane tbody tr:not(.virtual-spacer)').count() };
    };
    const result = { playlistScroll: await measure('.online-pane .table-wrap') };
    await page.locator('.online-pane .table-wrap').evaluate((node) => { node.scrollTop = 0; });
    await page.getByLabel('同步歌单：超大歌单测试', { exact: true }).check();
    await page.locator('.online-pane tbody tr').filter({ hasText: '超大歌单测试' }).click();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(folder); await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await page.locator('.local-pane tbody tr').dblclick();
    await expect(page.getByTestId('songs-online')).toBeVisible();
    result.songScrollAndDrag = await measure('.comparison-song-list', true);
    const idleBefore = await metrics(); await page.waitForTimeout(4000); const idleAfter = await metrics();
    result.idle4SecondsScriptMs = Math.round((idleAfter.ScriptDuration - idleBefore.ScriptDuration) * 1000);
    result.gpu = await app.evaluate(({ app }) => app.getGPUFeatureStatus().gpu_compositing);
    console.log(JSON.stringify(result, null, 2));
    if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2));
  } finally {
    await app.close();
    if (path.basename(base).startsWith('ncmsync-profile-') && !path.relative(os.tmpdir(), base).startsWith('..')) fs.rmSync(base, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
