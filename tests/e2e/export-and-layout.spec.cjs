const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('MP3 设置保存四种码率，超大歌单双栏分页和批量选择保持紧凑', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-export-'));
  const root = path.join(base, 'library'); const folder = path.join(root, 'Large mix'); fs.mkdirSync(folder, { recursive: true });
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789'); await page.getByRole('button', { name: '验证并继续' }).click();
    for (const rate of ['128', '192', '256', '320', '0']) {
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const bitrate = page.getByLabel('MP3 导出码率');
      await expect(bitrate.locator('option')).toHaveCount(5);
      await bitrate.selectOption(rate);
      await page.getByRole('button', { name: '保存设置', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await expect(page.getByLabel('MP3 导出码率')).toHaveValue(rate);
      if (rate === '192') await page.screenshot({ path: path.join(projectRoot, 'test-results', 'mp3-export-settings.png'), fullPage: true });
      await page.getByRole('button', { name: '取消', exact: true }).click();
    }
    await page.getByLabel('同步歌单：超大歌单测试', { exact: true }).check();
    await page.locator('.online-pane tbody tr').filter({ hasText: '超大歌单测试' }).click();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(folder);
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 680));
    await page.locator('.local-pane tbody tr').dblclick();
    const online = page.getByTestId('songs-online'); const local = page.getByTestId('songs-local');
    await expect(online.locator('.comparison-song-row').first()).toContainText('Large Track 1');
    expect(await online.locator('.comparison-song-row').count()).toBeLessThan(40);
    await expect(local.locator('.comparison-song-row')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: '在线歌曲分页' })).toContainText('1 / 49 · 4867 首');
    await expect.poll(() => online.locator('.comparison-song-row').first().evaluate((row) => Math.round(row.getBoundingClientRect().height))).toBe(32);
    const layout = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.comparison-song-row')];
      const list = document.querySelector('.comparison-song-list').getBoundingClientRect();
      const dialog = document.querySelector('.dialog');
      return { visible: rows.filter((row) => row.getBoundingClientRect().bottom <= list.bottom).length,
        heights: rows.map((row) => Math.round(row.getBoundingClientRect().height)), overflow: dialog.scrollWidth > dialog.clientWidth };
    });
    expect(layout.visible).toBeGreaterThanOrEqual(8); expect(layout.overflow).toBe(false);
    expect(layout.heights.every((height) => height === 32)).toBe(true);
    await page.getByLabel('全选全部歌曲', { exact: true }).uncheck();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await page.getByRole('button', { name: '扫描更新' }).click();
    await page.locator('.local-pane tbody tr').dblclick();
    await expect(page.getByLabel('全选全部歌曲', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '下一页', exact: true }).click();
    await expect(online.locator('.comparison-song-row').first()).toContainText('Large Track 101');
    await expect(online.locator('.comparison-song-row input:checked')).toHaveCount(0);
    await page.getByLabel('搜索歌单歌曲').fill('Large Track 4867');
    await expect(online.locator('.comparison-song-row')).toHaveCount(1);
    await expect(online.locator('.comparison-song-row input')).not.toBeChecked();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'compact-two-column-minimum.png'), fullPage: true });
    expect(fs.readdirSync(folder)).toHaveLength(0); expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (path.basename(base).startsWith('ncmsync-e2e-export-')) fs.rmSync(base, { recursive: true, force: true });
  }
});
