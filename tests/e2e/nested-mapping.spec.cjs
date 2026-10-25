const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('父子文件夹可分别保存映射，删除父歌单后子歌单继续保留', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-nested-'));
  const root = path.join(base, 'library'); const parent = path.join(root, 'Parent mix'); const child = path.join(parent, 'Child mix');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(parent, 'Test Artist - Neon Run.mp3'), 'parent-original');
  fs.writeFileSync(path.join(parent, 'notes.txt'), 'parent-notes');
  fs.writeFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'child-original');
  fs.writeFileSync(path.join(child, 'Child local.mp3'), 'child-local');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(parent);
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    const parentRow = page.locator('.local-pane tbody tr').filter({ has: page.getByText(parent, { exact: true }) });
    await expect(parentRow).toHaveCount(1);
    await page.getByRole('button', { name: /收藏的歌单/ }).click();
    await page.getByLabel('同步歌单：收藏节拍', { exact: true }).check();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(child);
    await expect(page.getByText('可选择音乐库根文件夹或现有子文件夹。每个歌单只管理所选目录的直属音频，父、子文件夹可分别映射；同一文件夹不能重复映射。移除根目录映射会保留全部文件。')).toBeVisible();
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await expect(page.getByRole('heading', { name: '自定义歌单映射', exact: true })).toHaveCount(0);
    const childRow = page.locator('.local-pane tbody tr').filter({ has: page.getByText(child, { exact: true }) });
    await expect(childRow).toHaveCount(1);
    await expect(parentRow.locator('td').nth(2)).toHaveText('1');
    await expect(childRow.locator('td').nth(2)).toHaveText('2');
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'nested-playlist-mappings.png'), fullPage: true });
    await parentRow.dblclick();
    await expect(page.getByTestId('songs-local').locator('header h4')).toHaveText('本地已有 1');
    await page.getByRole('button', { name: '返回', exact: true }).click();
    await parentRow.click();
    await page.getByRole('button', { name: '− 删除本地歌单', exact: true }).click();
    await expect(page.getByText(/只删除所选目录中的直属音频，保留子文件夹及其他文件/)).toBeVisible();
    await page.getByRole('button', { name: '删除本地歌单', exact: true }).click();
    await expect(parentRow).toHaveCount(0); await expect(childRow).toHaveCount(1);
    await page.getByRole('button', { name: /创建的歌单/ }).click();
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).not.toBeChecked();
    await page.getByRole('button', { name: '扫描更新' }).click();
    await expect(parentRow).toHaveCount(0); await expect(childRow).toHaveCount(1);
    expect(fs.readFileSync(path.join(child, 'Friend - Saved Groove.mp3'), 'utf8')).toBe('child-original');
    expect(fs.readFileSync(path.join(child, 'Child local.mp3'), 'utf8')).toBe('child-local');
    expect(fs.readFileSync(path.join(parent, 'notes.txt'), 'utf8')).toBe('parent-notes');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    const resolved = path.resolve(base); const temporary = path.resolve(os.tmpdir());
    if (resolved.startsWith(temporary + path.sep) && path.basename(resolved).startsWith('ncmsync-e2e-nested-')) fs.rmSync(resolved, { recursive: true, force: true });
  }
});
