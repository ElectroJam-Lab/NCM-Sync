const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('映射弹窗直接使用音乐库根文件夹，同步后移除映射保留文件', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-root-'));
  const root = path.join(base, 'library'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'Test Artist - Neon Run.mp3'), 'existing-root-song');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'keep notes');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByRole('button', { name: '使用音乐库文件夹', exact: true }).click();
    await expect(page.getByLabel('映射的本地文件夹')).toHaveValue(root);
    await expect(page.getByRole('button', { name: '保存映射', exact: true })).toBeEnabled();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'library-root-mapping.png'), fullPage: true });
    await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await expect(page.locator('.local-pane .playlist-path')).toHaveText(root);
    await expect(page.locator('.local-pane')).toContainText('音乐库根目录');
    await page.getByRole('button', { name: '同步所选', exact: false }).click();
    await expect.poll(() => fs.existsSync(path.join(root, 'Demo Unit - Last Train [502].mp3'))).toBe(true);
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).toBeEnabled();
    const files = fs.readdirSync(root).sort();
    const entities = fs.readdirSync(path.join(root, 'songs')).sort();
    await page.locator('.local-pane tbody tr').click();
    await page.getByRole('button', { name: '− 移除映射', exact: true }).click();
    await expect(page.getByText('移除音乐库根目录的歌单映射，保留音乐库中的全部文件。')).toBeVisible();
    await page.getByRole('button', { name: '移除映射', exact: true }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(0);
    expect(fs.readdirSync(root).sort()).toEqual(files);
    expect(fs.readdirSync(path.join(root, 'songs')).sort()).toEqual(entities);
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('keep notes');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    if (path.basename(base).startsWith('ncmsync-e2e-root-')) fs.rmSync(base, { recursive: true, force: true });
  }
});
