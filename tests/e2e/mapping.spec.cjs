const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('子目录映射、固定两栏拖拽、撤回重做与明确删除完整流程', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-mapping-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-mapping-user-'));
  const original = path.join(musicRoot, 'DJ', '夜航测试集');
  const target = path.join(musicRoot, 'DJ', 'Custom mix');
  fs.mkdirSync(original, { recursive: true }); fs.mkdirSync(target);
  fs.writeFileSync(path.join(original, 'Test Artist - Neon Run.mp3'), 'legacy-track');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: musicRoot, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(0);
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '匹配所选歌单的现有目录' }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(original);
    await page.getByRole('button', { name: '修改映射', exact: true }).click();
    await expect(page.getByLabel('映射的网易云歌单')).toHaveValue('1001');
    await page.getByLabel('映射的本地文件夹').fill(target);
    fs.mkdirSync(path.join(projectRoot, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-mapping.png'), fullPage: true });
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(target);
    const other = path.join(musicRoot, 'Saved'); fs.mkdirSync(other);
    const response = await page.evaluate((folderPath) => fetch('/api/local/map', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ onlineId: '1002', folderPath }) }).then((res) => res.json()), other);
    expect(response.onlineId).toBe('1002');
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(2);
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-paths.png'), fullPage: true });
    const row = page.locator('.local-pane tbody tr').filter({ hasText: 'Custom mix' });
    await row.dblclick();
    const online = page.getByTestId('songs-online');
    const local = page.getByTestId('songs-local');
    await expect(online.locator('.comparison-song-row')).toHaveCount(2);
    await expect(local.locator('.comparison-song-row')).toHaveCount(0);
    const neon = online.locator('[data-track-id="501"]');
    const neonCheckbox = page.getByLabel('在线歌曲：Neon Run', { exact: true });
    await expect(neon).toHaveAttribute('draggable', 'true');
    await neonCheckbox.uncheck();
    await neon.dragTo(local, { sourcePosition: { x: 70, y: 12 }, targetPosition: { x: 80, y: 90 } });
    await expect(neonCheckbox).toBeChecked();
    await expect(online.locator('.comparison-song-row')).toHaveCount(2);
    await expect(local.locator('.comparison-song-row')).toHaveCount(0);
    await page.locator('.playlist-editor').press('Control+z');
    await expect(neonCheckbox).not.toBeChecked();
    await page.getByRole('button', { name: '重做', exact: true }).click();
    await expect(neonCheckbox).toBeChecked();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    expect(fs.readdirSync(target)).toHaveLength(0);
    await neonCheckbox.uncheck();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'playlist-editor.png'), fullPage: true });
    await page.getByRole('button', { name: '应用并同步', exact: true }).click();
    await expect(page.locator('.dialog')).toHaveCount(0);
    await expect.poll(() => fs.readdirSync(target).length).toBe(1);
    expect(fs.readdirSync(other)).toHaveLength(0);
    expect(fs.readdirSync(original)).toHaveLength(1);
    await expect(row.locator('.status-badge')).toHaveText('同步');
    await row.dblclick();
    await expect(online.locator('.comparison-song-row')).toHaveCount(2);
    await expect(local.locator('[data-track-id="502"]')).toBeVisible();
    await local.getByRole('button', { name: 'Last Train：删除', exact: true }).click();
    await expect(local.locator('[data-track-id="502"]')).toHaveClass(/scheduled-removal/);
    expect(fs.readdirSync(target)).toHaveLength(1);
    await page.getByRole('button', { name: '应用并同步', exact: true }).click();
    await expect.poll(() => fs.readdirSync(target).length).toBe(0);
    expect(fs.readdirSync(original)).toHaveLength(1);
    await page.getByRole('button', { name: '扫描更新' }).click();
    await row.dblclick();
    await expect(online.locator('.comparison-song-row')).toHaveCount(2);
    await expect(local.locator('.comparison-song-row')).toHaveCount(0);
    await expect(page.getByLabel('在线歌曲：Last Train', { exact: true })).not.toBeChecked();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    for (const target of [musicRoot, userData]) {
      if (path.basename(target).startsWith('ncmsync-e2e-mapping-')) fs.rmSync(target, { recursive: true, force: true });
    }
  }
});
