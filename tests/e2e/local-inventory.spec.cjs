const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('本地栏显示全部文件，未匹配歌曲可搜索、保存选择和撤回删除', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-inventory-'));
  const root = path.join(base, 'library');
  const folder = path.join(root, 'DJ', 'Existing mix'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'Test Artist - Neon Run.mp3'), 'neon-original');
  fs.writeFileSync(path.join(folder, 'Demo Unit - Last Train.mp3'), 'train-original');
  for (let index = 1; index <= 63; index++) fs.writeFileSync(path.join(folder, `Local Set ${String(index).padStart(3, '0')}.mp3`), `local-original-${index}`);
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'keep-notes');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(folder);
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    const row = page.locator('.local-pane tbody tr').filter({ hasText: 'Existing mix' });
    await expect(row.locator('td').nth(2)).toHaveText('65');
    await row.dblclick();
    const online = page.getByTestId('songs-online'); const local = page.getByTestId('songs-local');
    await expect(online.locator('header h4')).toHaveText('在线歌单 2');
    await expect(local.locator('header h4')).toHaveText('本地已有 65');
    expect(await local.locator('.comparison-song-row').count()).toBeLessThan(40);
    await page.getByLabel('搜索歌单歌曲').fill('Local Set 063');
    await expect(online.locator('.comparison-song-row')).toHaveCount(0);
    await expect(local.locator('.comparison-song-row')).toHaveCount(1);
    await expect(local).toContainText('仅本地文件');
    const checkbox = page.getByLabel('已有歌曲：Local Set 063', { exact: true });
    await checkbox.uncheck();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await row.dblclick();
    await page.getByLabel('搜索歌单歌曲').fill('Local Set 063');
    await expect(checkbox).not.toBeChecked();
    await page.getByRole('button', { name: 'Local Set 063：删除', exact: true }).click();
    await expect(local.locator('.comparison-song-row')).toHaveClass(/scheduled-removal/);
    await page.getByRole('button', { name: '撤回', exact: true }).click();
    await expect(local.locator('.comparison-song-row')).not.toHaveClass(/scheduled-removal/);
    await expect(checkbox).not.toBeChecked();
    await page.getByLabel('搜索歌单歌曲').fill('');
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'all-local-files.png'), fullPage: true });
    await page.getByRole('button', { name: '返回', exact: true }).click();
    fs.writeFileSync(path.join(folder, 'Added externally.aiff'), 'new-local');
    await expect(row.locator('td').nth(2)).toHaveText('66');
    await row.dblclick();
    await expect(local.locator('header h4')).toHaveText('本地已有 66');
    await page.getByLabel('搜索歌单歌曲').fill('Added externally');
    await expect(local.locator('.comparison-song-row')).toHaveCount(1);
    expect(fs.readFileSync(path.join(folder, 'Local Set 063.mp3'), 'utf8')).toBe('local-original-63');
    expect(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8')).toBe('keep-notes');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    const resolved = path.resolve(base); const temporary = path.resolve(os.tmpdir());
    if (resolved.startsWith(temporary + path.sep) && path.basename(resolved).startsWith('ncmsync-e2e-inventory-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
});
