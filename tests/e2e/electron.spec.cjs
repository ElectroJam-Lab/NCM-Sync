const { test, expect, _electron: electron } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('首次设置不操作歌单，勾选后才识别现有同名文件夹', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-default-'));
  const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-e2e-discovery-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-e2e-user-'));
  fs.mkdirSync(path.join(musicRoot, '夜航测试集'));
  fs.writeFileSync(path.join(musicRoot, '夜航测试集', 'Test Artist - Neon Run.mp3'), 'existing-neon-run');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: projectRoot,
    env: { ...process.env, CLOUDMUSIC_ROOT: defaultRoot, CLOUDMUSIC_MOCK: '1' }
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('NCM Sync');
    await expect(page.getByText('如何找到我的用户 ID？')).toHaveCount(0);
    await page.getByTestId('setup-library-path').fill(musicRoot);
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(0);
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await page.getByRole('button', { name: '匹配所选歌单的现有目录' }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(1);
    await expect(page.locator('.local-pane')).toContainText('夜航测试集');
    await expect(page.locator('.local-pane')).toContainText('+1');
    await expect(page.locator('.global-status')).toContainText('1 个所选歌单有更新待同步');
    await expect.poll(() => fs.readdirSync(path.join(musicRoot, 'songs')).length).toBe(1);
  } finally {
    await app.close();
    for (const target of [defaultRoot, musicRoot, userData]) {
      if (/^(cloudmusic|ncmsync)-e2e-/.test(path.basename(target))) fs.rmSync(target, { recursive: true, force: true });
    }
  }
});

test('NCM Sync 首次设置、扫描、排序、同步和安全删除完整桌面流程', async () => {
  const projectRoot = path.resolve(__dirname, '../..');
  const defaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmsync-e2e-default-'));
  const musicRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-e2e-music-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-e2e-user-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`],
    cwd: projectRoot,
    env: {
      ...process.env,
      CLOUDMUSIC_ROOT: defaultRoot,
      CLOUDMUSIC_MOCK: '1',
      CLOUDMUSIC_MOCK_AUDIO_DELAY_MS: '80',
      CLOUDMUSIC_DOWNLOAD_CONCURRENCY: '2',
      CLOUDMUSIC_REALTIME_INTERVAL_MS: '60000'
    }
  });
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveTitle('NCM Sync');
    await expect(page.locator('.brand')).toContainText('NCM Sync');
    await expect(page.locator('.brand')).toContainText('网易云音乐本地同步工具');
    await expect(page.locator('.brand .logo')).toHaveAttribute('src', /ncmsync-logo-256/);
    await expect(page.locator('.topbar')).toHaveCSS('-webkit-app-region', 'drag');
    await expect(page.getByText('连接你的网易云音乐')).toBeVisible();
    await expect(page.getByTestId('setup-user-id')).toHaveValue('');
    await expect(page.getByTestId('setup-user-id')).toHaveAttribute('placeholder', '请输入网易云用户 ID');
    await expect(page.getByTestId('setup-library-path')).toHaveValue(defaultRoot);
    await page.getByTestId('setup-library-path').fill(musicRoot);
    await page.getByTestId('setup-user-id').fill('123456789');
    await page.getByRole('button', { name: '验证并继续' }).click();
    await expect.poll(() => fs.existsSync(defaultRoot)).toBe(false);
    await expect(page.locator('.global-status')).not.toContainText('上次扫描 从未');
    await expect(page.locator('.online-pane tbody tr')).toHaveCount(2);
    await expect(page.locator('.online-pane .tabs')).toContainText('创建的歌单 2');
    await expect(page.locator('.online-pane .tabs')).toContainText('收藏的歌单 1');
    const createdTab = page.locator('.online-pane .tabs button').filter({ hasText: '创建的歌单' });
    const savedTab = page.locator('.online-pane .tabs button').filter({ hasText: '收藏的歌单' });
    await expect(createdTab.locator('small')).toHaveText('已选：0');
    await expect(createdTab.locator('small')).toHaveCSS('opacity', '1');
    await expect(savedTab.locator('small')).toHaveText('已选：0');
    await expect(savedTab.locator('small')).toHaveCSS('opacity', '0');
    const initialTabHeights = await page.locator('.online-pane .tabs button').evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().height)));
    await page.locator('.online-pane tbody tr').first().click();
    await expect(createdTab.locator('small')).toHaveText('已选：0');
    await page.getByLabel('同步歌单：夜航测试集', { exact: true }).check();
    await expect(createdTab.locator('small')).toHaveText('已选：1');
    await savedTab.click();
    await expect(createdTab.locator('small')).toHaveText('已选：1');
    await expect(createdTab.locator('small')).toHaveCSS('opacity', '0');
    await expect(savedTab.locator('small')).toHaveText('已选：0');
    await expect(savedTab.locator('small')).toHaveCSS('opacity', '1');
    expect(await page.locator('.online-pane .tabs button').evaluateAll((tabs) => tabs.map((tab) => Math.round(tab.getBoundingClientRect().height)))).toEqual(initialTabHeights);
    await createdTab.click();
    await expect(createdTab.locator('small')).toHaveText('已选：1');
    await expect(createdTab.locator('small')).toHaveCSS('opacity', '1');
    await expect(savedTab.locator('small')).toHaveCSS('opacity', '0');
    await expect(page.locator('.online-pane .cover-placeholder')).toHaveCount(0);
    const onlineHeaders = await page.locator('.online-pane thead th').evaluateAll((headers) => headers.map((header) => header.textContent.replace(/[↑↓]/g, '').trim()));
    expect(onlineHeaders).toEqual(['', '名称', '歌曲数', '创建日期']);
    await expect(page.locator('.local-pane .pane-heading .library-location')).toBeVisible();
    const headerDate = await page.locator('.status-times').textContent();
    expect(headerDate).toMatch(/\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}/);
    await expect(page.locator('.status-times')).toHaveCSS('font-size', '10px');
    await expect(page.locator('.library-location > span')).toHaveCSS('font-size', '11px');
    await expect(page.locator('.library-location code')).toHaveCSS('font-size', '10px');
    await expect(page.locator('.topbar')).toHaveCSS('height', '72px');
    await expect(page.locator('.window-controls')).toHaveCSS('height', '38px');
    const windowControlsRightMargin = await page.locator('.window-controls').evaluate((node) => Math.round(innerWidth - node.getBoundingClientRect().right));
    expect(windowControlsRightMargin).toBe(16);
    const componentHeights = await page.locator('.brand .logo, .global-status, .scan-button, .topbar > .icon-button').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
    expect(componentHeights).toEqual([42, 47, 38, 38]);
    const headingAlignment = await page.locator('.local-pane .pane-heading-line > h2, .local-pane .library-location').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2)));
    expect(Math.abs(headingAlignment[0] - headingAlignment[1])).toBeLessThanOrEqual(1);
    const localHeadingRows = await page.locator('.local-pane .pane-heading > small, .local-pane .pane-heading-line > h2').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()));
    expect(localHeadingRows[0].bottom).toBeLessThanOrEqual(localHeadingRows[1].top);
    const minimizeButton = page.getByRole('button', { name: '最小化' });
    const maximizeButton = page.getByRole('button', { name: '最大化或还原' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable');
    await cdp.send('CSS.enable');
    const { root: documentNode } = await cdp.send('DOM.getDocument');
    for (const [selector, button] of [['.window-minimize', minimizeButton], ['.window-maximize', maximizeButton]]) {
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector });
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
      await expect(button).toHaveCSS('background-color', 'rgb(37, 48, 68)');
      await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
    }
    await cdp.detach();
    const topButtonColors = await page.locator('.scan-button, .topbar .icon-button').evaluateAll((buttons) => buttons.map((button) => {
      const style = getComputedStyle(button);
      return [style.backgroundColor, style.borderColor, style.color];
    }));
    expect(topButtonColors[0]).toEqual(topButtonColors[1]);
    for (const name of ['名称', '创建日期', '歌曲数']) {
      await page.locator('.online-pane').getByRole('columnheader', { name: new RegExp(name) }).click();
      await expect(page.locator('.online-pane').getByRole('columnheader', { name: new RegExp(name) })).toContainText(/[↑↓]/);
    }
    await page.getByText('超大歌单测试', { exact: true }).dblclick();
    await expect(page.getByRole('navigation', { name: '曲目分页' })).toContainText('1 / 25 · 4867 首');
    await expect(page.locator('.dialog .track-list > div[data-track-id]').first()).toContainText('Large Track 1');
    expect(await page.locator('.dialog .track-list > div[data-track-id]').count()).toBeLessThan(40);
    fs.mkdirSync(path.join(projectRoot, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'ncmsync-large-playlist-e2e.png'), fullPage: true });
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.dialog .track-list > div[data-track-id]').first()).toContainText('Large Track 201');
    await page.getByRole('button', { name: '关闭' }).click();
    await page.getByRole('button', { name: '设置' }).click();
    await page.getByTestId('acquire-account').click();
    await expect(page.getByText(/已获取账号.*ID 123456789.*和 Cookie/)).toBeVisible();
    const cookieInput = page.getByLabel('登录 Cookie（可选，用于受限音源）');
    await expect(cookieInput).toHaveValue('••••••••');
    await expect(cookieInput).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '显示 Cookie' }).click();
    await expect(cookieInput).toHaveValue('MUSIC_U=mock-login-cookie');
    await expect(cookieInput).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: '隐藏 Cookie' }).click();
    await expect(cookieInput).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.locator('.online-pane tbody tr').first().click();
    fs.mkdirSync(path.join(musicRoot, '夜航测试集'));
    await page.getByRole('button', { name: '匹配所选歌单的现有目录' }).click();
    await expect(page.locator('.local-pane tbody tr')).toHaveCount(1);
    await expect(page.locator('.local-pane')).toContainText('+2');

    await page.getByRole('button', { name: '同步所选' }).click();
    await expect(page.getByRole('button', { name: /暂停任务/ })).toBeEnabled();
    await page.getByRole('button', { name: /暂停任务/ }).click();
    await expect(page.getByRole('button', { name: /继续任务/ })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: '同步进度' })).toBeVisible();
    await page.getByRole('button', { name: /继续任务/ }).click();
    await expect.poll(() => fs.readdirSync(path.join(musicRoot, 'songs')).length).toBe(2);
    await expect.poll(() => fs.readdirSync(path.join(musicRoot, '夜航测试集')).length).toBe(2);
    const firstEntity = fs.readdirSync(path.join(musicRoot, 'songs'))[0];
    expect(fs.statSync(path.join(musicRoot, 'songs', firstEntity)).nlink).toBeGreaterThanOrEqual(2);
    await expect(page.locator('.local-pane .status-badge.synced')).toHaveText('同步');

    await page.locator('.local-pane tbody tr').first().dblclick();
    await expect(page.locator('.song-comparison > section')).toHaveCount(2);
    await expect(page.getByTestId('songs-online')).toContainText('Neon Run');
    await expect(page.getByTestId('songs-local')).toContainText('Test Artist');
    const sectionTops = await page.locator('.song-comparison > section').evaluateAll((sections) => sections.map((section) => Math.round(section.getBoundingClientRect().top)));
    expect(new Set(sectionTops).size).toBe(1);
    fs.mkdirSync(path.join(projectRoot, 'test-results'), { recursive: true });
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'cloudmusic-detail-e2e.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.locator('.global-status')).toContainText('上次同步');
    await expect(page.locator('.global-status')).not.toContainText('上次同步 从未');

    fs.renameSync(path.join(musicRoot, '夜航测试集'), path.join(musicRoot, '手动目录名'));
    await expect(page.getByRole('button', { name: '扫描更新' })).toHaveCount(1);
    await expect(page.locator('.pane-heading .icon-button')).toHaveCount(0);
    await page.getByRole('button', { name: '扫描更新' }).click();
    await expect(page.locator('.local-pane .status-badge.offline')).toHaveText('离线');
    await expect(page.locator('.local-pane')).toContainText('手动目录名');
    await page.locator('.local-pane tbody tr').first().click({ button: 'right' });
    await page.getByRole('button', { name: /重定向到在线歌单/ }).click();
    await expect(page.locator('.redirect-browser .tabs')).toContainText('创建的歌单 2');
    await expect(page.locator('.redirect-list > button')).toHaveCount(2);
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'cloudmusic-redirect-e2e.png'), fullPage: true });
    await page.locator('.redirect-list > button').first().click();
    await page.getByRole('button', { name: '确认重定向' }).click();
    await expect(page.locator('.local-pane')).toContainText('夜航测试集（手动目录名）');
    await page.getByRole('button', { name: '同步文件夹名称' }).click();
    await expect(page.locator('.local-pane')).not.toContainText('（手动目录名）');
    await expect.poll(() => fs.existsSync(path.join(musicRoot, '夜航测试集'))).toBe(true);
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'cloudmusic-e2e.png'), fullPage: true });

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1080, 680));
    await page.waitForTimeout(150);
    const minimumGaps = await page.evaluate(() => {
      const online = document.querySelector('.online-pane').getBoundingClientRect();
      const ring = document.querySelector('.sync-progress-ring').getBoundingClientRect();
      const local = document.querySelector('.local-pane').getBoundingClientRect();
      return { left: Math.round(ring.left - online.right), right: Math.round(local.left - ring.right) };
    });
    expect(minimumGaps.left).toBeGreaterThanOrEqual(10);
    expect(minimumGaps.right).toBeGreaterThanOrEqual(10);
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'ncmsync-min-width-e2e.png'), fullPage: true });

    await page.locator('.local-pane tbody tr').first().click();
    await page.getByRole('button', { name: /暂停同步/ }).click();
    await expect(page.locator('.local-pane .status-badge.paused')).toHaveText('暂停');
    await page.getByRole('columnheader', { name: /状态/ }).click();
    await expect(page.getByRole('columnheader', { name: /状态/ })).toContainText('↑');
    for (const name of ['名称', '歌曲数', '更新', '创建日期']) {
      await page.locator('.local-pane').getByRole('columnheader', { name: new RegExp(name) }).click();
    }
    const actionWidths = await page.locator('.local-pane .pane-actions button').evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().width)));
    expect(Math.abs(actionWidths[0] - actionWidths[1])).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: '− 删除本地歌单' }).click();
    await expect(page.getByText('“删除本地歌单”只删除所选目录中的直属音频，保留子文件夹及其他文件；目录为空时一并移除。如果想保留全部歌曲，请使用“暂停同步”。')).toBeVisible();
    await page.getByLabel('下次不再询问').check();
    await page.getByRole('button', { name: '删除本地歌单', exact: true }).click();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(0);
    expect(fs.existsSync(path.join(musicRoot, '夜航测试集'))).toBe(false);
    await page.getByRole('button', { name: '设置' }).click();
    await expect(page.getByText('删除本地歌单时不再询问')).toBeVisible();
    await expect(page.getByText('删除本地歌单时不再询问').locator('..').getByRole('checkbox')).toBeChecked();
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'ncmsync-settings-min-e2e.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭' }).click();
    await expect(page.getByRole('heading', { name: '设置' })).toHaveCount(0);

    const realtimeSwitch = page.getByRole('checkbox', { name: '实时同步' });
    const realtimePositions = await page.locator('.realtime-switch, .sync-progress-ring').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().top));
    expect(realtimePositions[0]).toBeLessThan(realtimePositions[1]);
    await page.locator('.realtime-switch').click();
    await expect(realtimeSwitch).toBeChecked();
    await expect(page.locator('.sync-button strong')).toHaveText('同步所选');
    await expect(page.locator('.sync-progress-ring')).toHaveClass(/realtime/);
    expect(fs.existsSync(path.join(musicRoot, '夜航测试集'))).toBe(false, '实时同步不能重建被删除的歌单目录');
    await page.screenshot({ path: path.join(projectRoot, 'test-results', 'ncmsync-realtime-e2e.png'), fullPage: true });
    await expect(page.getByRole('button', { name: '扫描更新' })).toBeEnabled();
    await savedTab.click();
    fs.mkdirSync(path.join(musicRoot, '收藏节拍'));
    await page.getByLabel('同步歌单：收藏节拍', { exact: true }).check();
    await expect(page.locator('.local-pane tbody tr:not(.empty-row)')).toHaveCount(1);
    await expect(page.locator('.global-status')).toContainText('实时同步');
    await expect(page.locator('.local-pane .local-name small')).toContainText('正在同步：');
    await expect(page.getByRole('button', { name: /暂停任务/ })).toBeEnabled();
    await expect(page.locator('.local-pane .status-badge.synced')).toHaveText('同步', { timeout: 10000 });
    await expect(page.locator('.global-status')).toContainText('实时同步正在监测');
  } finally {
    await app.close();
    for (const target of [defaultRoot, musicRoot, userData]) {
      if (/^(cloudmusic|ncmsync)-e2e-/.test(path.basename(target))) fs.rmSync(target, { recursive: true, force: true });
    }
  }
});
