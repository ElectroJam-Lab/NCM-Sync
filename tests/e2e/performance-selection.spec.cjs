const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('长在线列表只渲染可见行，滚动到尾部仍能选择，全选涵盖未渲染歌单', async () => {
  const project = path.resolve(__dirname, '../..'); const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-performance-table-'));
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: project,
    env: { ...process.env, CLOUDMUSIC_ROOT: path.join(base, 'library'), CLOUDMUSIC_MOCK: '1' } });
  try {
    await app.evaluate(({ app }) => {
      const requireModule = process.getBuiltinModule('node:module').createRequire(process.getBuiltinModule('node:path').join(app.getAppPath(), 'package.json'));
      const { NeteaseClient } = requireModule('./src/backend/netease.cjs'); const original = NeteaseClient.prototype.getUserPlaylists;
      NeteaseClient.prototype.getUserPlaylists = async function (id) { return [...await original.call(this, id), ...Array.from({ length: 120 }, (_, i) => ({
        id: `performance-${i}`, name: `Performance Playlist ${i}`, creatorId: '123456789', createdAt: i, trackCount: 0, kind: 'created', coverUrl: ''
      }))]; };
    });
    const page = await app.firstWindow();
    await page.getByTestId('setup-user-id').fill('123456789'); await page.getByRole('button', { name: '验证并继续' }).click();
    expect(await page.locator('.online-pane tr[data-playlist-id]').count()).toBeLessThan(40);
    await page.getByLabel('选择当前列表的全部歌单', { exact: true }).check();
    await expect(page.locator('.playlist-selection-toolbar')).toContainText('122');
    const table = page.locator('.online-pane .table-wrap');
    await table.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const last = page.getByLabel('同步歌单：Performance Playlist 0', { exact: true });
    await expect(last).toBeVisible(); await expect(last).toBeChecked(); await last.uncheck();
    const scope = await page.evaluate(() => fetch('/api/bootstrap').then((res) => res.json()).then((value) => value.settings.syncPlaylistIds));
    expect(scope).toHaveLength(121); expect(scope).toContain('performance-119'); expect(scope).not.toContain('performance-0');
    const unchanged = page.waitForResponse((response) => response.url().endsWith('/api/bootstrap') && response.status() === 304);
    await unchanged;
    await table.evaluate((node) => { node.scrollTop = 0; });
    await expect(page.getByLabel('同步歌单：夜航测试集', { exact: true })).toBeVisible();
  } finally { await app.close(); if (path.basename(base).startsWith('ncmsync-e2e-performance-')) fs.rmSync(base, { recursive: true, force: true }); }
});

test('长歌单虚拟滚动、整行点击、Shift 跨页选择/取消和撤回，保存后只下载选择歌曲', async () => {
  const project = path.resolve(__dirname, '../..'); const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-performance-'));
  const root = path.join(base, 'library'); const folder = path.join(root, 'Large mix'); fs.mkdirSync(folder, { recursive: true });
  for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(folder, `Artist ${i} - Large Track ${i + 1}.mp3`), `unchanged-${i}`);
  const app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(base, 'user')}`], cwd: project,
    env: { ...process.env, CLOUDMUSIC_ROOT: root, CLOUDMUSIC_MOCK: '1' } });
  try {
    const page = await app.firstWindow(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.getByTestId('setup-user-id').fill('123456789'); await page.getByRole('button', { name: '验证并继续' }).click();
    await page.getByLabel('同步歌单：超大歌单测试', { exact: true }).check();
    await page.locator('.online-pane tbody tr').filter({ hasText: '超大歌单测试' }).click();
    await page.getByRole('button', { name: '自定义映射到本地文件夹', exact: true }).click();
    await page.getByLabel('映射的本地文件夹').fill(folder); await page.getByRole('button', { name: '保存映射', exact: true }).click();
    await page.locator('.local-pane tbody tr').dblclick();
    const online = page.getByTestId('songs-online'); const local = page.getByTestId('songs-local');
    const row = (n, column = online) => column.locator(`[data-track-id="large-${n}"]`);
    expect(await online.locator('.comparison-song-row').count()).toBeLessThan(40);
    await row(1).locator('strong').click(); await row(5).locator('.comparison-song-artist').click({ modifiers: ['Shift'] });
    for (let i = 1; i <= 5; i++) await expect(row(i).getByRole('checkbox')).not.toBeChecked();
    await expect(row(6).getByRole('checkbox')).toBeChecked();
    await online.getByRole('button', { name: '下一页', exact: true }).click();
    await row(101).locator('.comparison-song-duration').click({ modifiers: ['Shift'] });
    await expect(row(101).getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: '撤回', exact: true }).click(); await expect(row(101).getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: '重做', exact: true }).click(); await expect(row(101).getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    let detail = await page.evaluate(() => fetch('/api/bootstrap').then((res) => res.json()).then(async (summary) => (await fetch(`/api/local/${summary.local[0].id}`)).json()));
    expect(detail.onlineTracks.slice(0, 101).every((track) => !track.syncSelected)).toBe(true);
    expect(detail.onlineTracks[101].syncSelected).toBe(true);
    // Right-column anchors are independent and change the same shared song choices.
    await row(2, local).locator('.comparison-song-number').click();
    await row(6, local).locator('strong').click({ modifiers: ['Shift'] });
    for (let i = 2; i <= 6; i++) await expect(row(i, local).getByRole('checkbox')).toBeChecked();
    await row(2, local).getByRole('checkbox').click(); await row(6, local).locator('strong').click({ modifiers: ['Shift'] });
    for (let i = 2; i <= 6; i++) await expect(row(i, local).getByRole('checkbox')).not.toBeChecked();
    await page.getByLabel('全选全部歌曲', { exact: true }).check(); await page.getByLabel('全选全部歌曲', { exact: true }).uncheck();
    await online.getByRole('button', { name: '上一页', exact: true }).click();
    await online.locator('.comparison-song-list').evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(row(100)).toBeVisible(); expect(await online.locator('.comparison-song-row').count()).toBeLessThan(40);
    await row(100).locator('strong').click(); await expect(row(100).getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: '撤回', exact: true }).click(); await expect(row(100).getByRole('checkbox')).not.toBeChecked();
    await page.getByLabel('搜索歌单歌曲').fill('Large Track 4867'); await row(4867).locator('strong').click();
    await expect(row(4867).getByRole('checkbox')).toBeChecked();
    await page.getByRole('button', { name: '应用方案', exact: true }).click();
    await page.screenshot({ path: path.join(project, 'test-results', 'virtual-list-selection.png'), fullPage: true });
    await page.getByRole('button', { name: '应用并同步', exact: true }).click();
    await expect.poll(() => fs.readdirSync(folder).length).toBe(13);
    for (let i = 0; i < 12; i++) expect(fs.readFileSync(path.join(folder, `Artist ${i} - Large Track ${i + 1}.mp3`), 'utf8')).toBe(`unchanged-${i}`);
    expect(errors).toEqual([]);
  } finally { await app.close(); if (path.basename(base).startsWith('ncmsync-e2e-performance-')) fs.rmSync(base, { recursive: true, force: true }); }
});
