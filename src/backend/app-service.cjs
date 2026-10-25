const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseJson, normalizeInterval, sanitizeName } = require('./utils.cjs');
const { CancelledError } = require('./task-manager.cjs');
const { FileStore } = require('./file-store.cjs');
const { writeAudioTags } = require('./tag-writer.cjs');
const { buildSyncPlan } = require('./sync-plan.cjs');
const { exportMp3, validateMp3Bitrate } = require('./mp3-export.cjs');

const MAX_TRACK_ATTEMPTS = 2;

class AppService {
  constructor({ db, fileStore, netease, tasks, openPath = async () => '', rootPath, defaultLibraryPath = '', persistLibraryPath = async () => {}, realtimeIntervalMs = 15_000, downloadConcurrency }) {
    this.db = db;
    this.fileStore = fileStore;
    this.netease = netease;
    this.tasks = tasks;
    this.openPath = openPath;
    this.rootPath = rootPath;
    this.defaultLibraryPath = defaultLibraryPath;
    this.persistLibraryPath = persistLibraryPath;
    this.scanning = false;
    this.scanSource = '';
    this.scanStatus = '尚未扫描';
    this.autoTimer = null;
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
    this.realtimeCyclePromise = null;
    this.pendingRealtimeIds = new Set();
    this.realtimeIntervalMs = Math.max(1_000, Number(realtimeIntervalMs) || 15_000);
    const configured = Number(downloadConcurrency ?? this.db.getSettings().downloadConcurrency);
    this.downloadConcurrency = Math.max(1, Math.min(8, Math.floor(configured) || 4));
    this.syncPromise = null;
    this.startupScanPromise = null;
    this.localInventories = new Map();
    this.localInventoryRevision = 0;
    this.localInventoryCheckedAt = 0;
  }

  start() {
    const settings = this.db.getSettings();
    if (!settings.libraryPath) this.db.setSettings({ libraryPath: this.rootPath });
    this.netease.setCookie(settings.cookie);
    if (settings.interruptedTask) this.scanStatus = '上次同步未完成，任务已暂停；请重新发起同步';
    this.configureAutoScan();
    this.configureRealtimeSync(false);
    if (settings.initialized && settings.userId) {
      this.startupScanPromise = this.scanAll('startup').then((result) => {
        const latest = this.db.getSettings();
        if (latest.realtimeSync && result.unsynced > 0 && !this.tasks.active) this.startSync(undefined, 'realtime');
        return result;
      }).catch((error) => {
        this.scanStatus = `启动扫描失败：${error.message}`;
      });
    }
  }

  stop() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.autoTimer = null;
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
  }

  configureAutoScan() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    this.autoTimer = null;
    const settings = this.db.getSettings();
    if (!settings.autoScan) return;
    const interval = normalizeInterval(settings.scanHours, settings.scanMinutes).totalMinutes * 60_000;
    this.autoTimer = setInterval(() => this.runAutomaticCycle('auto', this.db.getSettings().autoSync), interval);
    this.autoTimer.unref?.();
  }

  configureRealtimeSync(runImmediately = true) {
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.realtimeTimer = null;
    this.realtimeKickTimer = null;
    const settings = this.db.getSettings();
    if (!settings.realtimeSync || !settings.initialized || !settings.userId) return;
    this.realtimeTimer = setInterval(() => this.runAutomaticCycle('realtime', true), this.realtimeIntervalMs);
    this.realtimeTimer.unref?.();
    if (runImmediately) this.scheduleRealtimeCycle(0);
  }

  scheduleRealtimeCycle(delay = 0) {
    if (!this.db.getSettings().realtimeSync) return;
    if (this.realtimeKickTimer) clearTimeout(this.realtimeKickTimer);
    this.realtimeKickTimer = setTimeout(() => {
      this.realtimeKickTimer = null;
      this.runAutomaticCycle('realtime', true);
    }, delay);
    this.realtimeKickTimer.unref?.();
  }

  runAutomaticCycle(source, shouldSync) {
    if (this.realtimeCyclePromise || this.scanning || this.tasks.active || this.tasks.paused) return this.realtimeCyclePromise;
    if (source === 'realtime' && !this.db.getSettings().realtimeSync) return null;
    const cycle = (async () => {
      try {
        const result = await this.scanAll(source);
        const stillEnabled = source !== 'realtime' || this.db.getSettings().realtimeSync;
        if (shouldSync && stillEnabled && result.unsynced > 0 && !this.tasks.active) this.startSync(undefined, source);
        return result;
      } catch (error) {
        this.scanStatus = `${source === 'realtime' ? '实时同步检测' : '自动扫描'}失败：${error.message}`;
        return null;
      } finally {
        if (this.realtimeCyclePromise === cycle) this.realtimeCyclePromise = null;
      }
    })();
    this.realtimeCyclePromise = cycle;
    return cycle;
  }

  bootstrapRevision() {
    this.refreshLocalInventories();
    return JSON.stringify([this.db.revision, this.localInventoryRevision, this.rootPath, this.scanning, this.scanSource, this.scanStatus, this.tasks.getState()]);
  }

  bootstrap({ summary = false } = {}) {
    const settings = this.db.getSettings();
    return {
      settings: { ...settings, cookie: settings.cookie ? '••••••••' : '' },
      initialized: Boolean(settings.initialized),
      online: this.onlinePlaylists(),
      local: this.localPlaylists({ summary }),
      scanning: this.scanning,
      scanSource: this.scanSource,
      scanStatus: this.scanStatus,
      task: this.tasks.getState(),
      rootPath: this.rootPath,
      lastScanAt: settings.lastScanAt || null,
      lastSyncAt: settings.lastSyncAt || null
    };
  }

  onlinePlaylists() {
    return this.db.all('SELECT * FROM online_playlists ORDER BY created_at DESC').map((row) => ({
      id: row.id, name: row.name, creatorId: row.creator_id, createdAt: row.created_at,
      trackCount: row.track_count, kind: row.kind, coverUrl: row.cover_url || ''
    }));
  }

  localPlaylists({ summary = false } = {}) {
    this.refreshLocalInventories();
    if (this.localCache?.revision !== this.db.revision || this.localCache?.rootPath !== this.rootPath || this.localCache?.inventoryRevision !== this.localInventoryRevision) {
      const tracks = groupBy(this.db.all(`SELECT pt.playlist_id,pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
        FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id`), 'playlist_id');
      const choices = groupBy(this.db.all('SELECT * FROM track_choices'), 'playlist_id');
      const rows = this.db.all('SELECT * FROM local_playlists ORDER BY added_at DESC');
      const deleteRemoved = this.db.getSettings().deleteRemoved;
      const previous = this.localCache?.rootPath === this.rootPath ? this.localCache.entries : null;
      const entries = new Map();
      const mapped = rows.map((row) => {
        const trackRows = tracks.get(row.id) || []; const decisions = choices.get(row.id) || [];
        const inventory = this.localInventories.get(row.id);
        const old = previous?.get(row.id);
        const unchanged = old && old.inventory === inventory && old.deleteRemoved === deleteRemoved && sameSqlRows([old.row], [row])
          && sameSqlRows(old.tracks, trackRows) && sameSqlRows(old.choices, decisions);
        const item = unchanged ? old.item : this.mapLocal(row, trackRows, decisions, deleteRemoved, inventory);
        entries.set(row.id, { row, tracks: trackRows, choices: decisions, deleteRemoved, inventory, item });
        return item;
      });
      this.localCache = { revision: this.db.revision, rootPath: this.rootPath, inventoryRevision: this.localInventoryRevision, entries, rows: mapped };
    }
    if (!summary) return this.localCache.rows;
    return this.localCache.rows.map(({ added, removed, existing, onlineTracks, localTracks, ...row }) => row);
  }

  refreshLocalInventories(id) {
    const now = Date.now();
    const rowsChanged = this.localInventoryDbRevision !== this.db.revision || this.localInventoryRoot !== this.rootPath;
    if (!id && !rowsChanged && now - this.localInventoryCheckedAt < 1_000) return;
    const rows = id ? this.db.all('SELECT id,folder_name FROM local_playlists WHERE id=?', [id])
      : this.db.all('SELECT id,folder_name FROM local_playlists');
    for (const row of rows) {
      const previous = this.localInventories.get(row.id);
      // Progress changes do not require another directory read for every other playlist.
      if (!id && previous?.rootPath === this.rootPath && previous.folderName === row.folder_name && now - previous.checkedAt < 1_000) continue;
      let stamp, files = [], error = '';
      try {
        const folder = this.fileStore.playlistPath(row.folder_name);
        const stat = fs.statSync(folder, { bigint: true });
        if (!stat.isDirectory()) throw new Error('本地歌单文件夹不存在');
        stamp = `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (previous?.rootPath === this.rootPath && previous.folderName === row.folder_name && previous.stamp === stamp) { previous.checkedAt = now; continue; }
        files = this.fileStore.listAudioFiles(row.folder_name);
      } catch (failure) {
        error = failure.code === 'ENOENT' ? '本地歌单文件夹不存在' : failure.message;
        stamp = `error:${error}`;
        if (previous?.rootPath === this.rootPath && previous.folderName === row.folder_name && previous.stamp === stamp) { previous.checkedAt = now; continue; }
      }
      this.localInventories.set(row.id, { rootPath: this.rootPath, folderName: row.folder_name, stamp, files, error, checkedAt: now });
      this.localInventoryRevision++;
    }
    if (!id) {
      const ids = new Set(rows.map((row) => row.id));
      for (const key of this.localInventories.keys()) if (!ids.has(key)) { this.localInventories.delete(key); this.localInventoryRevision++; }
      this.localInventoryDbRevision = this.db.revision;
      this.localInventoryRoot = this.rootPath;
      this.localInventoryCheckedAt = now;
    }
  }

  mapLocal(row, trackRows, choices, deleteRemoved, inventory) {
    const files = inventory?.files || [];
    const byFilename = new Map(files.map((file) => [fileKey(file.name), file]));
    const claimed = new Set();
    const localTracks = [];
    for (const track of trackRows) {
      const key = fileKey(track.filename);
      if (!byFilename.has(key) || claimed.has(key)) continue;
      claimed.add(key);
      localTracks.push({ ...dbTrack(track), filename: byFilename.get(key).name });
    }
    for (const file of files) {
      if (claimed.has(fileKey(file.name))) continue;
      localTracks.push({ id: localFileId(row, file.name), name: path.parse(file.name).name, filename: file.name,
        artists: [], album: '', duration: 0, localOnly: true });
    }
    const { added, removed, existing, needsSync } = buildSyncPlan(row, localTracks, choices, deleteRemoved);
    const decisions = new Map([...added, ...removed, ...existing].map((track) => [track.id, track]));
    const snapshot = parseJson(row.online_tracks_json, []);
    const removedIds = new Set(parseJson(row.removed_json, []).map((track) => String(track.id)));
    const onlineTracks = [...new Map((snapshot.length ? snapshot : [...parseJson(row.added_json, []), ...parseJson(row.existing_json, [])]
      .filter((track) => !removedIds.has(String(track.id)))).map((track) => [String(track.id), track])).values()]
      .map((track) => ({ ...decisions.get(String(track.id)), ...track, id: String(track.id) }));
    let status = 'synced';
    if (row.paused) status = 'paused';
    else if (row.offline) status = 'offline';
    else if (needsSync || row.pending_name || row.error) status = 'pending';
    const libraryRoot = row.folder_name === '.';
    const basename = libraryRoot ? '音乐库根目录' : path.basename(row.folder_name);
    const displayName = sanitizeName(row.name) === basename ? row.name : `${row.name}（${basename}）`;
    let folderPath;
    let pathError = inventory?.error || '';
    try { folderPath = this.fileStore.playlistPath(row.folder_name); }
    catch (error) { folderPath = path.resolve(this.rootPath, row.folder_name); pathError = error.message; }
    if (pathError && !row.paused) status = 'offline';
    const revision = crypto.createHash('sha256').update(JSON.stringify([this.rootPath, row.online_id, row.folder_name, row.added_json, row.removed_json, row.online_tracks_json, trackRows, files.map((file) => file.name), choices, deleteRemoved])).digest('hex');
    return {
      id: row.id, onlineId: row.online_id, name: row.name, folderName: row.folder_name,
      displayName,
      folderPath, createdAt: row.created_at,
      trackCount: localTracks.length, paused: Boolean(row.paused), offline: Boolean(row.offline || pathError),
      previousName: row.previous_name, pendingName: row.pending_name,
      added, removed, existing, addedCount: added.length, removedCount: removed.length, existingCount: existing.length,
      onlineTracks, localTracks: localTracks.map((track) => decisions.get(track.id)),
      needsSync, revision, customMapping: Boolean(row.custom_mapping), libraryRoot,
      lastSyncAt: row.last_sync_at, lastScanAt: row.last_scan_at,
      syncProgress: row.sync_progress, error: pathError || row.error, status
    };
  }

  localDetail(id) {
    this.refreshLocalInventories(id);
    const item = this.localPlaylists().find((row) => row.id === id);
    if (!item) throw new Error('本地歌单不存在');
    return item;
  }

  assertEditable() {
    if (this.tasks.active || this.scanning) throw new Error('请等待扫描或同步任务结束后再修改');
  }

  selectedOnlineIds() {
    return new Set(this.db.getSettings().syncPlaylistIds || []);
  }

  setSyncSelection(onlineIds) {
    this.assertEditable();
    if (!Array.isArray(onlineIds)) throw new Error('歌单选择格式不正确');
    const available = new Set(this.onlinePlaylists().map((item) => item.id));
    const ids = [...new Set(onlineIds.map(String))];
    if (ids.some((id) => !available.has(id))) throw new Error('选择中包含不可访问的在线歌单，请先刷新列表');
    this.db.setSettings({ syncPlaylistIds: ids });
    if (ids.length) this.scheduleRealtimeCycle();
    return this.bootstrap({ summary: true });
  }

  async saveTrackChoices(id, revision, changes) {
    this.assertEditable();
    const item = this.localDetail(id);
    if (revision !== item.revision) throw new Error('歌单内容已改变，请重新打开详情后编辑');
    if (!Array.isArray(changes)) throw new Error('歌曲方案格式不正确');
    const knownTracks = new Map([...item.added, ...item.removed, ...item.existing].map((track) => [track.id, track]));
    for (const choice of changes) {
      if (!choice || !knownTracks.has(String(choice.id)) || !['add', 'remove', 'keep'].includes(choice.action)) throw new Error('歌曲或操作无效');
      if (knownTracks.get(String(choice.id)).localOnly && choice.action === 'add') throw new Error('仅本地歌曲只能留存或删除');
      if (Object.hasOwn(choice, 'enabled') && typeof choice.enabled !== 'boolean') throw new Error('歌曲勾选格式不正确');
    }
    this.db.transaction(() => {
      const statement = this.db.db.prepare(`INSERT INTO track_choices(playlist_id,track_id,action,enabled) VALUES (?,?,?,?)
        ON CONFLICT(playlist_id,track_id) DO UPDATE SET action=excluded.action,enabled=excluded.enabled`);
      try {
        for (const choice of changes) statement.run([id, String(choice.id), choice.action,
          (choice.enabled ?? (choice.action === 'add' || knownTracks.get(String(choice.id)).local)) ? 1 : 0]);
      } finally { statement.free(); }
    });
    return this.localDetail(id);
  }

  validateMapping(folderName, exceptId = '') {
    const target = this.fileStore.playlistPath(folderName);
    for (const row of this.db.all('SELECT id,name,folder_name FROM local_playlists')) {
      if (row.id === exceptId) continue;
      const other = path.resolve(this.rootPath, row.folder_name);
      if (this.mappingPathsOverlap(target, other)) throw new Error(`目标文件夹已映射到“${row.name}”（${row.folder_name}），不能重复映射同一文件夹`);
    }
    return target;
  }

  mappingPathsOverlap(left, right) {
    // Each mapping owns direct audio files only, so parent and child directories are independent.
    return path.relative(left, right) === '';
  }

  async mapPlaylist(onlineId, folderPath, localId = '') {
    this.assertEditable();
    const mappingRoot = this.rootPath;
    onlineId = String(onlineId || '');
    const online = this.db.get('SELECT * FROM online_playlists WHERE id=?', [onlineId]);
    if (!online) throw new Error('在线歌单不存在');
    const row = localId ? this.db.get('SELECT * FROM local_playlists WHERE id=?', [localId]) : null;
    if (localId && !row) throw new Error('本地歌单不存在');
    if (this.db.get('SELECT id FROM local_playlists WHERE online_id=? AND id<>?', [onlineId, localId])) throw new Error('该在线歌单已有本地映射');
    const folderName = this.fileStore.relativePlaylistPath(folderPath);
    const target = this.validateMapping(folderName, localId);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('请选择已存在的本地文件夹');
    const detail = await this.netease.getPlaylist(onlineId);
    this.assertEditable();
    if (this.rootPath !== mappingRoot) throw new Error('音乐库位置已改变，请重新选择映射目录');
    const current = localId ? this.db.get('SELECT * FROM local_playlists WHERE id=?', [localId]) : null;
    if (row && (!current || current.folder_name !== row.folder_name || current.online_id !== row.online_id)) throw new Error('映射已改变，请重新打开映射设置');
    if (this.db.get('SELECT id FROM local_playlists WHERE online_id=? AND id<>?', [onlineId, localId])) throw new Error('该在线歌单已有本地映射');
    this.validateMapping(folderName, localId);
    if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('映射的本地文件夹不存在');
    const id = row?.id || crypto.randomUUID();
    this.db.transaction(() => {
      if (row) {
        if (row.folder_name !== folderName) this.db.db.run('DELETE FROM playlist_tracks WHERE playlist_id=?', [id]);
        if (row.online_id !== onlineId) this.db.db.run('DELETE FROM track_choices WHERE playlist_id=?', [id]);
        this.db.db.run(`UPDATE local_playlists SET online_id=?,name=?,folder_name=?,custom_mapping=1,pending_name=NULL,
          created_at=?,offline=0,error=NULL WHERE id=?`, [onlineId, online.name, folderName, online.created_at, id]);
      } else this.db.db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,custom_mapping,created_at,added_at)
        VALUES (?,?,?,?,1,?,?)`, [id, onlineId, online.name, folderName, online.created_at, Date.now()]);
    });
    await this.adoptAndDiff(id, detail);
    return this.localDetail(id);
  }

  async setupUser(userId, changing = false) {
    const normalized = String(userId || '').trim();
    if (!/^\d+$/.test(normalized)) throw new Error('用户 ID 只能包含数字');
    const current = this.db.getSettings();
    const playlists = await this.netease.getUserPlaylists(normalized);
    if (changing && current.userId && current.userId !== normalized) {
      this.db.run('UPDATE local_playlists SET offline=1, error=?', ['用户 ID 已更换，请重定向歌单']);
    }
    this.db.setSettings({ userId: normalized, initialized: true, lastScanAt: Date.now(),
      ...(current.userId && current.userId !== normalized ? { syncPlaylistIds: [] } : {}) });
    this.storeOnline(playlists);
    const hadLocalPlaylists = Boolean(this.db.get('SELECT COUNT(*) AS count FROM local_playlists')?.count);
    const discovered = !current.userId ? await this.discoverExistingPlaylistFolders() : { matched: 0, added: 0, ids: [] };
    if (hadLocalPlaylists) await this.scan('setup');
    else if (discovered.matched) this.scanStatus = `已获取 ${playlists.length} 个在线歌单，并从音乐库识别 ${discovered.matched} 个本地歌单`;
    else this.scanStatus = `已获取 ${playlists.length} 个在线歌单`;
    this.configureRealtimeSync();
    return this.bootstrap();
  }

  dismissSetup() {
    this.db.setSettings({ initialized: true });
    this.scanStatus = '当前未设置用户 ID，请先设置用户 ID 后使用同步功能';
    return this.bootstrap();
  }

  async refreshOnline(markScan = true) {
    const { userId } = this.db.getSettings();
    if (!userId) throw new Error('当前未设置用户 ID');
    if (markScan) this.db.setSettings({ lastScanAt: Date.now() });
    const playlists = await this.netease.getUserPlaylists(userId);
    this.storeOnline(playlists);
    if (markScan) this.db.setSettings({ lastScanAt: Date.now() });
    this.scanStatus = `已刷新 ${playlists.length} 个在线歌单`;
    return playlists;
  }

  async scanAll(source = 'manual', localIds) {
    if (this.scanning) throw new Error('扫描已在进行中');
    if (this.tasks.active) throw new Error('同步任务进行中，暂时不能扫描');
    this.scanning = true;
    this.scanSource = source;
    this.scanStatus = scanMessage(source);
    this.db.setSettings({ lastScanAt: Date.now() });
    try {
      await this.refreshOnline(false);
      await this.discoverExistingPlaylistFolders({ onlyNew: true, localIds });
      return await this.scan(source, true, localIds);
    } finally {
      this.scanning = false;
      this.scanSource = '';
    }
  }

  storeOnline(playlists) {
    const now = Date.now();
    this.db.transaction(() => {
      const ids = playlists.map((item) => item.id);
      if (ids.length) {
        const placeholders = ids.map(() => '?').join(',');
        this.db.db.run(`DELETE FROM online_playlists WHERE id NOT IN (${placeholders})`, ids);
      } else this.db.db.run('DELETE FROM online_playlists');
      for (const item of playlists) {
        this.db.db.run(`INSERT INTO online_playlists(id,name,creator_id,created_at,track_count,kind,cover_url,raw_json,fetched_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,creator_id=excluded.creator_id,
          created_at=excluded.created_at,track_count=excluded.track_count,kind=excluded.kind,cover_url=excluded.cover_url,fetched_at=excluded.fetched_at`,
        [item.id, item.name, item.creatorId, item.createdAt, item.trackCount, item.kind, item.coverUrl, '{}', now]);
      }
    });
  }

  async playlistDetail(id) { return this.netease.getPlaylist(id); }

  async addLocal(onlineIds) {
    this.assertEditable();
    this.scanning = true;
    this.scanSource = 'manual';
    this.scanStatus = '正在匹配所选歌单的现有目录…';
    let result;
    try {
      const unique = [...new Set((onlineIds || []).map(String))];
      const added = [];
      const unmatched = [];
      const scope = this.selectedOnlineIds();
      const folders = indexFolders(await this.fileStore.listPlaylistFolders());
      for (const onlineId of unique) {
        if (!scope.has(onlineId)) continue;
        if (this.db.get('SELECT id FROM local_playlists WHERE online_id=?', [onlineId])) continue;
        const online = this.db.get('SELECT * FROM online_playlists WHERE id=?', [onlineId]);
        if (!online) throw new Error(`在线歌单 ${onlineId} 不存在`);
        const id = crypto.randomUUID();
        const rows = this.db.all('SELECT id,folder_name FROM local_playlists');
        const sameNameCount = this.db.all('SELECT name FROM online_playlists').filter((item) => sanitizeName(item.name).toLowerCase() === sanitizeName(online.name).toLowerCase()).length;
        const match = this.resolvePlaylistFolder(online, folders, rows, null, sameNameCount === 1);
        if (match.ambiguous) throw new Error('存在多个同名文件夹，请使用自定义映射选择目录');
        if (!match.folder) { unmatched.push(online.name); continue; }
        const folderName = match.folder;
        this.validateMapping(folderName);
        const detail = await this.netease.getPlaylist(onlineId);
        if (!fs.existsSync(this.fileStore.playlistPath(folderName))) throw new Error('映射目录已不存在，请重新选择');
        this.db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,created_at,track_count,added_at,added_json,removed_json,existing_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [id, onlineId, online.name, folderName, online.created_at, 0, Date.now(), '[]', '[]', '[]']);
        await this.adoptAndDiff(id, detail);
        added.push(id);
      }
      result = { added, unmatched, local: this.localPlaylists() };
    } finally {
      this.scanning = false;
      this.scanSource = '';
    }
    if (result.added.length && this.db.getSettings().realtimeSync) {
      if (!this.tasks.active) this.startSync(result.added, 'realtime');
      else for (const id of result.added) this.pendingRealtimeIds.add(id);
    }
    this.scanStatus = result.unmatched.length ? `${result.unmatched.length} 个所选歌单未找到目录，请自定义映射` : '所选歌单匹配完成';
    return result;
  }

  resolvePlaylistFolder(online, folders, localRows, local, allowBase = true) {
    if (local?.custom_mapping && this.fileStore.isLibraryFolder(local.folder_name)) return { folder: '.' };
    const available = folders.byPath;
    if (local?.folder_name && available.has(local.folder_name.toLowerCase())) return { folder: available.get(local.folder_name.toLowerCase()) };
    if (local?.custom_mapping) return {};
    const base = sanitizeName(online.name);
    const names = [`${base} [${online.id}]`, ...(allowBase ? [base] : [])];
    const groups = names.map((name) => (folders.byName.get(name.toLowerCase()) || [])
      .filter((folder) => !localRows.some((row) => row.id !== local?.id && this.mappingPathsOverlap(this.fileStore.playlistPath(folder), path.resolve(this.rootPath, row.folder_name)))));
    for (const matches of groups) {
      const direct = matches.find((folder) => path.dirname(folder) === '.');
      if (direct) return { folder: direct };
    }
    for (const matches of groups) {
      if (matches.length === 1) return { folder: matches[0] };
      if (matches.length > 1) return { ambiguous: true };
    }
    return {};
  }

  async discoverExistingPlaylistFolders({ onlyNew = false, localIds } = {}) {
    const scope = this.selectedOnlineIds();
    if (!scope.size) return { matched: 0, added: 0, ids: [] };
    const limited = localIds === undefined ? null : new Set(localIds.map(String));
    const folders = indexFolders(await this.fileStore.listPlaylistFolders());
    if (!folders.byPath.size) return { matched: 0, added: 0, ids: [] };
    const onlineRows = this.db.all('SELECT * FROM online_playlists ORDER BY created_at DESC');
    const localRows = this.db.all('SELECT * FROM local_playlists');
    const localsByOnlineId = new Map(localRows.filter((row) => row.online_id).map((row) => [String(row.online_id), row]));
    const baseNameCounts = new Map();
    for (const online of onlineRows) {
      const key = sanitizeName(online.name).toLowerCase();
      baseNameCounts.set(key, (baseNameCounts.get(key) || 0) + 1);
    }
    const result = { matched: 0, added: 0, ids: [] };
    for (const online of onlineRows) {
      const onlineId = String(online.id);
      const local = localsByOnlineId.get(onlineId);
      if (!scope.has(onlineId) || (limited && !limited.has(local?.id))) continue;
      if (onlyNew && local) continue;
      const baseName = sanitizeName(online.name);
      const { folder: folderName } = this.resolvePlaylistFolder(online, folders, localRows, local, baseNameCounts.get(baseName.toLowerCase()) === 1);
      if (!folderName) continue;
      let localId = local?.id;
      if (local) {
        this.db.run(`UPDATE local_playlists SET name=?,folder_name=?,created_at=?,offline=0,error=NULL WHERE id=?`,
          [online.name, folderName, online.created_at, local.id]);
      } else {
        localId = crypto.randomUUID();
        this.db.run(`INSERT INTO local_playlists(id,online_id,name,folder_name,created_at,track_count,added_at,added_json,removed_json,existing_json)
          VALUES (?,?,?,?,?,?,?,?,?,?)`, [localId, onlineId, online.name, folderName, online.created_at, 0, Date.now(), '[]', '[]', '[]']);
        localsByOnlineId.set(onlineId, { id: localId, online_id: onlineId, folder_name: folderName });
        localRows.push({ id: localId, online_id: onlineId, folder_name: folderName });
        result.added += 1;
      }
      try {
        const detail = await this.netease.getPlaylist(onlineId);
        await this.adoptAndDiff(localId, detail);
      } catch (error) {
        this.db.run('UPDATE local_playlists SET error=? WHERE id=?', [`识别文件夹后读取歌单失败：${error.message}`, localId]);
      }
      result.matched += 1;
      result.ids.push(localId);
    }
    return result;
  }

  async adoptAndDiff(localId, detail) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [localId]);
    const knownRows = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [localId]);
    const missing = knownRows.filter((item) => !fs.existsSync(path.join(this.fileStore.playlistPath(row.folder_name), item.filename)));
    if (missing.length) this.db.transaction(() => {
      for (const item of missing) this.db.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [localId, item.track_id]);
    });
    const missingIds = new Set(missing.map((item) => item.track_id));
    const known = new Set(knownRows.filter((item) => !missingIds.has(item.track_id)).map((item) => item.track_id));
    const files = this.fileStore.listAudioFiles(row.folder_name);
    const claimed = new Set(knownRows.filter((item) => !missingIds.has(item.track_id)).map((item) => path.join(this.fileStore.playlistPath(row.folder_name), item.filename)));
    const adoptedTracks = [];
    for (const track of detail.tracks) {
      if (known.has(track.id)) continue;
      const match = this.fileStore.findLegacyMatch(track, files, claimed);
      if (!match) continue;
      const adopted = await this.fileStore.adoptLegacyFile(track, match);
      adoptedTracks.push({ track, adopted });
      known.add(track.id);
    }
    this.db.transaction(() => {
      for (const { track, adopted } of adoptedTracks) {
        this.db.db.run(`INSERT OR IGNORE INTO songs(track_id,name,artists,album,duration,entity_path,extension,size,created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [track.id, track.name, JSON.stringify(track.artists), track.album, track.duration, adopted.entityPath, adopted.extension, adopted.size, Date.now()]);
        this.db.db.run('INSERT OR IGNORE INTO playlist_tracks(playlist_id,track_id,filename,linked_at) VALUES (?,?,?,?)', [localId, track.id, adopted.filename, Date.now()]);
        const choice = this.db.get('SELECT action,enabled FROM track_choices WHERE playlist_id=? AND track_id=?', [localId, localFileId(row, adopted.filename)]);
        if (choice) this.db.db.run('INSERT OR IGNORE INTO track_choices(playlist_id,track_id,action,enabled) VALUES (?,?,?,?)', [localId, track.id, choice.action, choice.enabled]);
      }
      for (const track of detail.tracks) {
        if (!track.coverUrl) continue;
        this.db.db.run('UPDATE songs SET cover_url=? WHERE track_id=? AND cover_url=?', [track.coverUrl, track.id, '']);
      }
    });
    const remoteIds = new Set(detail.tracks.map((item) => item.id));
    const current = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [localId]);
    const currentIds = new Set(current.map((item) => item.track_id));
    const added = detail.tracks.filter((item) => !currentIds.has(item.id));
    const removed = current.filter((item) => !remoteIds.has(item.track_id)).map(dbTrack);
    const existing = current.filter((item) => remoteIds.has(item.track_id)).map(dbTrack);
    const nameChanged = row.name !== detail.name;
    let folderName = row.folder_name;
    const targetFolderName = sanitizeName(detail.name);
    let pendingName = row.custom_mapping || path.basename(folderName) === targetFolderName ? null : detail.name;
    if (pendingName && this.db.getSettings().renamePolicy === 'auto') {
      try {
        folderName = await this.renameMappedFolder(row, detail.name);
        pendingName = null;
      } catch { /* 保留提示，让用户处理同名冲突 */ }
    }
    this.db.run(`UPDATE local_playlists SET name=?,previous_name=?,pending_name=?,offline=0,error=NULL,
      folder_name=?,added_json=?,removed_json=?,existing_json=?,online_tracks_json=?,track_count=?,last_scan_at=? WHERE id=?`, [
      detail.name, nameChanged ? row.name : row.previous_name, pendingName, folderName,
      JSON.stringify(added), JSON.stringify(removed), JSON.stringify(existing), JSON.stringify(detail.tracks), current.length, Date.now(), localId
    ]);
    return { added, removed, existing };
  }

  async scan(source = 'manual', withinScanAll = false, localIds) {
    if (!withinScanAll && this.scanning) throw new Error('扫描已在进行中');
    if (!withinScanAll && this.tasks.active) throw new Error('同步任务进行中，暂时不能扫描');
    if (!withinScanAll) {
      this.scanning = true;
      this.scanSource = source;
    }
    this.scanStatus = scanMessage(source);
    this.db.setSettings({ lastScanAt: Date.now() });
    let unsynced = 0;
    try {
      const scope = this.selectedOnlineIds();
      const limited = localIds === undefined ? null : new Set(localIds.map(String));
      const rows = this.db.all('SELECT * FROM local_playlists WHERE paused=0')
        .filter((row) => scope.has(row.online_id) && (!limited || limited.has(row.id)));
      const onlineIds = new Set(this.onlinePlaylists().map((item) => item.id));
      const managedFolders = this.db.all('SELECT folder_name FROM local_playlists').map((item) => item.folder_name);
      let folders;
      for (const row of rows) {
        let folderPath;
        try { folderPath = this.fileStore.playlistPath(row.folder_name); }
        catch (error) { this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', [error.message, row.id]); continue; }
        if (!fs.existsSync(folderPath)) {
          const filenames = this.db.all('SELECT filename FROM playlist_tracks WHERE playlist_id=?', [row.id]).map((item) => item.filename);
          folders ||= await this.fileStore.listPlaylistFolders();
          const moved = await this.fileStore.detectMovedFolder(row.folder_name, filenames, managedFolders, folders);
          if (moved) this.db.run('UPDATE local_playlists SET name=?,folder_name=?,previous_name=?,pending_name=NULL,offline=1,error=? WHERE id=?', [path.basename(moved), moved, row.name, '检测到本地文件夹已重命名，请重定向后恢复同步', row.id]);
          else this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', ['本地歌单文件夹不存在', row.id]);
          continue;
        }
        if (!row.online_id || !onlineIds.has(row.online_id)) {
          this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', ['在线歌单不可访问', row.id]);
          continue;
        }
        try {
          const detail = await this.netease.getPlaylist(row.online_id);
          await this.adoptAndDiff(row.id, detail);
          if (this.localDetail(row.id).needsSync || row.name !== detail.name) unsynced += 1;
        } catch (error) {
          this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', [error.message, row.id]);
        }
      }
      const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
      this.scanStatus = scope.size ? `所选歌单扫描完成，${unsynced} 个歌单未同步，扫描时间：${timestamp}` : '歌单列表已刷新，请勾选需要同步的歌单';
      this.db.setSettings({ lastScanAt: Date.now() });
      return { unsynced, status: this.scanStatus, local: this.localPlaylists() };
    } finally {
      if (!withinScanAll) {
        this.scanning = false;
        this.scanSource = '';
      }
    }
  }

  startSync(ids, source = 'manual') {
    if (this.scanning) throw new Error('扫描进行中，暂时不能同步');
    if (ids !== undefined && !Array.isArray(ids)) throw new Error('歌单选择格式不正确');
    const selected = ids === undefined ? null : new Set(ids.map(String));
    const scope = this.selectedOnlineIds();
    const rows = this.db.all('SELECT * FROM local_playlists WHERE paused=0 AND offline=0')
      .filter((row) => scope.has(row.online_id))
      .filter((row) => !selected || selected.has(row.id))
      .filter((row) => this.isSyncable(row))
      .filter((row) => source === 'manual' || this.localDetail(row.id).needsSync);
    if (!rows.length) {
      if (source !== 'manual') return this.tasks.getState();
      throw new Error(scope.size ? '所选歌单没有可用映射，请选择现有本地文件夹' : '请先勾选需要同步的在线歌单');
    }
    const control = this.tasks.begin(rows.length, source, this.downloadConcurrency);
    control.mp3Bitrate = this.db.getSettings().mp3Bitrate;
    this.db.setSettings({ interruptedTask: true });
    this.syncPromise = this.runSync(rows, control).catch(() => {});
    return this.tasks.getState();
  }

  async syncSelected(ids) {
    if (ids !== undefined && !Array.isArray(ids)) throw new Error('歌单选择格式不正确');
    this.assertEditable();
    if (!this.selectedOnlineIds().size) throw new Error('请先勾选需要同步的在线歌单');
    await this.scanAll('manual', ids);
    return this.startSync(ids);
  }

  isSyncable(row) {
    try {
      if (!row.online_id || !this.db.get('SELECT id FROM online_playlists WHERE id=?', [row.online_id])) throw new Error('在线歌单未匹配或不可访问');
      if (this.db.get('SELECT id FROM local_playlists WHERE online_id=? AND id<>?', [row.online_id, row.id])) throw new Error('在线歌单存在重复映射');
      const target = this.validateMapping(row.folder_name, row.id);
      if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error('映射的本地文件夹不存在');
      return true;
    } catch (error) {
      this.db.run('UPDATE local_playlists SET offline=1,error=? WHERE id=?', [error.message, row.id]);
      return false;
    }
  }

  async runSync(rows, control) {
    let finalError = '';
    const allFailures = [];
    try {
      for (let index = 0; index < rows.length; index += 1) {
        control.throwIfCancelled();
        await control.waitIfPaused();
        const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [rows[index].id]);
        if (!row || !this.selectedOnlineIds().has(row.online_id) || row.paused || row.offline || !this.isSyncable(row)) continue;
        if (!row.last_scan_at) {
          const detail = await this.netease.getPlaylist(row.online_id);
          await this.adoptAndDiff(row.id, detail);
        }
        const added = this.localDetail(row.id).added.filter((track) => track.syncSelected && !track.local);
        this.tasks.update({ current: index + 1, playlistId: row.id, downloaded: 0, downloadTotal: added.length, error: '' });
        if (added.length) this.db.run('UPDATE local_playlists SET sync_progress=?,error=NULL WHERE id=?', [`正在同步：0/${added.length}`, row.id], false);
        const failures = await this.syncTracksConcurrently(row, added, control);
        await this.applyRemovals(row);
        await this.ensureTrackCovers(row, control);
        allFailures.push(...failures);
        const latest = this.db.get('SELECT * FROM local_playlists WHERE id=?', [row.id]);
        const currentTracks = this.db.all(`SELECT pt.track_id,pt.filename,s.name,s.artists,s.album,s.duration
          FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id WHERE pt.playlist_id=?`, [row.id]).map(dbTrack);
        const currentIds = new Set(currentTracks.map((track) => track.id));
        const remainingAdded = parseJson(latest.added_json, []).filter((track) => !currentIds.has(String(track.id)));
        const remainingRemoved = parseJson(latest.removed_json, []).filter((track) => currentIds.has(String(track.id)));
        this.db.transaction(() => {
          this.db.db.run(`UPDATE local_playlists SET added_json=?,removed_json=?,existing_json=?,track_count=?,last_sync_at=?,sync_progress=NULL,error=NULL WHERE id=?`, [
            JSON.stringify(remainingAdded), JSON.stringify(remainingRemoved), JSON.stringify(currentTracks), currentTracks.length, Date.now(), row.id
          ]);
          this.db.db.run(`UPDATE track_choices SET action='keep' WHERE playlist_id=? AND action='add'
            AND track_id IN (SELECT track_id FROM playlist_tracks WHERE playlist_id=?)`, [row.id, row.id]);
        });
      }
      finalError = '';
      this.db.setSettings({ interruptedTask: false, lastSyncAt: Date.now() });
      this.scanStatus = allFailures.length
        ? `同步完成，${allFailures.length} 首下载失败已跳过`
        : '同步完成';
    } catch (error) {
      if (!(error instanceof CancelledError)) finalError = error.message;
      if (error instanceof CancelledError) this.scanStatus = '同步任务已取消';
    } finally {
      this.tasks.finish(finalError);
      this.syncPromise = null;
      if (this.db.getSettings().realtimeSync && this.pendingRealtimeIds.size) {
        const queued = [...this.pendingRealtimeIds];
        this.pendingRealtimeIds.clear();
        queueMicrotask(() => {
          try { this.startSync(queued, 'realtime'); }
          catch { for (const id of queued) this.pendingRealtimeIds.add(id); }
        });
      }
    }
  }

  async syncTracksConcurrently(row, tracks, control) {
    if (!tracks.length) return [];
    const failures = [];
    let nextIndex = 0;
    let completed = 0;
    let activeDownloads = 0;
    const worker = async () => {
      while (true) {
        await control.waitIfPaused();
        control.throwIfCancelled();
        const trackIndex = nextIndex;
        nextIndex += 1;
        if (trackIndex >= tracks.length) return;
        const track = tracks[trackIndex];
        let countedActive = false;
        try {
          await control.waitIfPaused();
          control.throwIfCancelled();
          activeDownloads += 1;
          countedActive = true;
          this.tasks.update({ activeDownloads });
          let lastError = null;
          for (let attempt = 0; attempt < MAX_TRACK_ATTEMPTS; attempt += 1) {
            try {
              await this.syncTrack(row, track, control);
              completed += 1;
              this.tasks.update({ downloaded: completed, error: '' });
              this.db.run('UPDATE local_playlists SET sync_progress=?,error=NULL WHERE id=?', [`正在同步：${completed}/${tracks.length}`, row.id], false);
              lastError = null;
              break;
            } catch (error) {
              if (error instanceof CancelledError || error.name === 'AbortError') throw new CancelledError();
              lastError = error;
            }
          }
          if (lastError) failures.push({ track, error: lastError });
        } finally {
          if (countedActive) {
            activeDownloads = Math.max(0, activeDownloads - 1);
            this.tasks.update({ activeDownloads });
          }
        }
      }
    };
    const workerCount = Math.min(this.downloadConcurrency, tracks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return failures;
  }

  async fetchCover(track, control) {
    const url = track?.coverUrl || track?.cover_url;
    if (!url) return null;
    try {
      const bytes = await this.netease.getCover(url, control?.signal);
      return Buffer.isBuffer(bytes) && bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  async writeTrackTags(entityPath, extension, track, source = {}) {
    const artists = Array.isArray(track.artists) ? track.artists : parseJson(track.artists, []);
    const meta = {
      title: source.metadata?.musicName || track.name,
      artist: flattenArtists(source.metadata?.artist) || artists.join(', '),
      album: source.metadata?.album || track.album || '',
      cover: source.cover || null
    };
    if (entityPath && (extension === 'mp3' || extension === 'flac')) {
      await writeAudioTags(entityPath, extension, meta);
    }
    return Boolean(meta.cover);
  }

  async ensureTrackCovers(row, control) {
    const item = this.localDetail(row.id);
    const selectedTracks = new Set([...item.added, ...item.removed, ...item.existing].filter((track) => track.syncSelected).map((track) => track.id));
    const pending = this.db.all(`SELECT s.track_id,s.name,s.artists,s.album,s.entity_path,s.extension,s.cover_url
      FROM playlist_tracks pt JOIN songs s ON s.track_id=pt.track_id
      WHERE pt.playlist_id=? AND s.cover_url != '' AND s.cover_embedded = 0`, [row.id]).filter((track) => selectedTracks.has(track.track_id));
    if (!pending.length) return;
    let nextIndex = 0;
    let updated = false;
    const worker = async () => {
      while (true) {
        await control.waitIfPaused();
        control.throwIfCancelled();
        const index = nextIndex;
        nextIndex += 1;
        if (index >= pending.length) return;
        const song = pending[index];
        try {
          const bytes = await this.netease.getCover(song.cover_url, control.signal);
          if (!Buffer.isBuffer(bytes) || !bytes.length) continue;
          const coverEmbedded = await this.writeTrackTags(song.entity_path, song.extension, song, { cover: bytes });
          const size = fs.statSync(song.entity_path).size;
          this.db.run('UPDATE songs SET cover_embedded=?,size=? WHERE track_id=?', [coverEmbedded ? 1 : 0, size, song.track_id], false);
          updated = true;
        } catch (error) {
          if (error instanceof CancelledError || error.name === 'AbortError') throw new CancelledError();
          // 封面失败跳过，下次同步重试
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.downloadConcurrency, pending.length) }, () => worker()));
    if (updated) this.db.save();
  }

  async syncTrack(row, track, control) {
    let song = this.db.get('SELECT * FROM songs WHERE track_id=?', [track.id]);
    let downloaded;
    let songValues;
    let needsCover = false;
    if (!song || !fs.existsSync(song.entity_path) || fs.statSync(song.entity_path).size === 0) {
      const response = await this.netease.getAudioResponse(track.id, control.signal);
      downloaded = await this.fileStore.downloadTrack(track, response, control);
      if (downloaded.encrypted) {
        downloaded = await this.fileStore.finishNcm(track, downloaded.ncmPath);
      }
      downloaded = await exportMp3(downloaded, control.mp3Bitrate ?? this.db.getSettings().mp3Bitrate, control);
      const coverEmbedded = await this.writeTrackTags(downloaded.entityPath, downloaded.extension, track, { ...downloaded, cover: downloaded.cover || null });
      downloaded.size = fs.statSync(downloaded.entityPath).size;
      songValues = [
        track.id, track.name, JSON.stringify(track.artists), track.album, track.duration, downloaded.entityPath,
        downloaded.extension, downloaded.size, track.coverUrl || '', coverEmbedded ? 1 : 0, Date.now()
      ];
      needsCover = !coverEmbedded && Boolean(track.coverUrl);
    }
    const entityPath = downloaded?.entityPath || song.entity_path;
    const filename = path.basename(entityPath);
    await this.fileStore.createPlaylistLink(entityPath, row.folder_name, filename);
    this.db.transaction(() => {
      if (songValues) {
        this.db.db.run(`INSERT INTO songs(track_id,name,artists,album,duration,entity_path,extension,size,cover_url,cover_embedded,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(track_id) DO UPDATE SET name=excluded.name,artists=excluded.artists,album=excluded.album,
          duration=excluded.duration,entity_path=excluded.entity_path,extension=excluded.extension,size=excluded.size,
          cover_url=excluded.cover_url,cover_embedded=excluded.cover_embedded`, songValues);
        song = this.db.get('SELECT * FROM songs WHERE track_id=?', [track.id]);
      }
      this.db.db.run('INSERT OR REPLACE INTO playlist_tracks(playlist_id,track_id,filename,linked_at) VALUES (?,?,?,?)', [row.id, track.id, filename, Date.now()]);
    });
    this.tasks.recordArtifact({ playlistId: row.id, trackId: track.id, folderName: row.folder_name, filename, entityPath: song.entity_path, createdEntity: Boolean(downloaded?.created) });
    if (needsCover) {
      const fetched = await this.fetchCover(track, control);
      if (fetched) {
        await this.writeTrackTags(song.entity_path, song.extension, song, { cover: fetched });
        this.db.run('UPDATE songs SET cover_embedded=1,size=? WHERE track_id=?', [fs.statSync(song.entity_path).size, track.id]);
      }
    }
  }

  async applyRemovals(row) {
    const removedTrackIds = [];
    for (const track of this.localDetail(row.id).removed.filter((track) => track.syncSelected && track.local)) {
      if (track.localOnly) {
        // Unmatched files are never removed merely because they are absent online.
        const choice = this.db.get('SELECT action,enabled FROM track_choices WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
        if (choice?.action === 'remove' && choice.enabled) {
          await this.fileStore.removePlaylistLink(row.folder_name, track.filename);
          this.db.run('DELETE FROM track_choices WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
        }
        continue;
      }
      const link = this.db.get('SELECT filename FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
      if (link) await this.fileStore.removePlaylistLink(row.folder_name, link.filename);
      this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [row.id, track.id]);
      removedTrackIds.push(track.id);
    }
    await this.pruneOrphanedSongs(removedTrackIds);
  }

  async pruneOrphanedSongs(trackIds = []) {
    const ids = [...new Set(trackIds.map(String).filter(Boolean))];
    if (!ids.length) return;
    const songs = this.db.all(`SELECT * FROM songs WHERE track_id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const song of songs) {
      const references = this.db.get('SELECT COUNT(*) AS count FROM playlist_tracks WHERE track_id=?', [song.track_id]);
      if (Number(references?.count) > 0) continue;
      await this.fileStore.removeSongEntity(song.entity_path);
      this.db.run('DELETE FROM songs WHERE track_id=?', [song.track_id]);
    }
  }

  setLocalPaused(ids, paused) {
    for (const id of ids || []) this.db.run('UPDATE local_playlists SET paused=? WHERE id=?', [paused ? 1 : 0, id]);
    if (!paused && this.db.getSettings().realtimeSync) {
      const resumable = (ids || []).filter((id) => {
        const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
        return row && !row.offline && (parseJson(row.added_json, []).length || (this.db.getSettings().deleteRemoved && parseJson(row.removed_json, []).length));
      });
      if (resumable.length && !this.tasks.active && !this.scanning) this.startSync(resumable, 'realtime');
      else for (const id of resumable) this.pendingRealtimeIds.add(id);
    }
    return this.localPlaylists();
  }

  async removeLocal(ids) {
    this.assertEditable();
    const removedTrackIds = [];
    const rows = [...new Set(ids || [])].map((id) => this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]))
      .filter(Boolean).sort((left, right) => right.folder_name.length - left.folder_name.length);
    for (const row of rows) {
      const id = row.id;
      if (!this.fileStore.isLibraryFolder(row.folder_name)) {
        removedTrackIds.push(...this.db.all('SELECT track_id FROM playlist_tracks WHERE playlist_id=?', [id]).map((track) => track.track_id));
        await this.fileStore.removePlaylistFolder(row.folder_name);
      }
      this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=?', [id]);
      this.db.run('DELETE FROM local_playlists WHERE id=?', [id]);
    }
    const removedOnlineIds = new Set(rows.map((row) => row.online_id));
    this.db.setSettings({ syncPlaylistIds: [...this.selectedOnlineIds()].filter((id) => !removedOnlineIds.has(id)) });
    await this.pruneOrphanedSongs(removedTrackIds);
    return this.localPlaylists();
  }

  async redirectLocal(id, onlineId) {
    this.assertEditable();
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    const online = this.db.get('SELECT * FROM online_playlists WHERE id=?', [String(onlineId)]);
    if (!row || !online) throw new Error('歌单不存在');
    const conflict = this.db.get('SELECT id FROM local_playlists WHERE online_id=? AND id<>?', [String(onlineId), id]);
    if (conflict) throw new Error('该在线歌单已经在本地列表中');
    const pendingName = this.fileStore.isLibraryFolder(row.folder_name) || row.folder_name === sanitizeName(online.name) ? null : online.name;
    this.db.run('UPDATE local_playlists SET online_id=?,name=?,previous_name=?,pending_name=?,offline=0,error=NULL WHERE id=?', [String(onlineId), online.name, row.name, pendingName, id]);
    const detail = await this.netease.getPlaylist(onlineId);
    this.db.run('DELETE FROM track_choices WHERE playlist_id=?', [id]);
    await this.adoptAndDiff(id, detail);
    return this.localPlaylists();
  }

  async syncFolderName(id) {
    this.assertEditable();
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    if (!row) throw new Error('歌单不存在');
    const newName = await this.renameMappedFolder(row, row.name);
    this.db.run('UPDATE local_playlists SET folder_name=?,custom_mapping=0,previous_name=NULL,pending_name=NULL WHERE id=?', [newName, id]);
    return this.localPlaylists();
  }

  async renameMappedFolder(row, name) {
    if (this.fileStore.isLibraryFolder(row.folder_name)) throw new Error('音乐库根目录不能随歌单重命名');
    this.validateMapping(path.join(path.dirname(row.folder_name), sanitizeName(name)), row.id);
    const folderName = await this.fileStore.renamePlaylistFolder(row.folder_name, name);
    this.db.transaction(() => {
      // Local-only choices are tied to their directory; retain them when its audio files move.
      for (const file of this.fileStore.listAudioFiles(folderName)) {
        const previousId = localFileId(row, file.name);
        const nextId = localFileId({ ...row, folder_name: folderName }, file.name);
        if (previousId === nextId) continue;
        const choice = this.db.get('SELECT action,enabled FROM track_choices WHERE playlist_id=? AND track_id=?', [row.id, previousId]);
        if (!choice) continue;
        this.db.db.run(`INSERT INTO track_choices(playlist_id,track_id,action,enabled) VALUES (?,?,?,?)
          ON CONFLICT(playlist_id,track_id) DO UPDATE SET action=excluded.action,enabled=excluded.enabled`, [row.id, nextId, choice.action, choice.enabled]);
        this.db.db.run('DELETE FROM track_choices WHERE playlist_id=? AND track_id=?', [row.id, previousId]);
      }
      this.db.db.run('UPDATE local_playlists SET folder_name=? WHERE id=?', [folderName, row.id]);
    });
    return folderName;
  }

  async openLocal(id) {
    const row = this.db.get('SELECT * FROM local_playlists WHERE id=?', [id]);
    if (!row) throw new Error('歌单不存在');
    const folder = this.fileStore.playlistPath(row.folder_name);
    if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error('本地目录不存在，请重新映射现有文件夹');
    const result = await this.openPath(this.fileStore.playlistPath(row.folder_name));
    if (result) throw new Error(result);
  }

  async openLibrary() {
    const result = await this.openPath(this.rootPath);
    if (result) throw new Error(result);
  }

  async changeLibrary(newPath, migrate, removeEmptySource = false) {
    if (this.tasks.active || this.scanning) throw new Error('请等待当前任务结束后再修改音乐库位置');
    const rawPath = String(newPath || '').trim();
    if (!path.isAbsolute(rawPath)) throw new Error('音乐库位置必须是绝对路径');
    const targetPath = path.resolve(rawPath);
    if (targetPath === this.rootPath) return this.bootstrap();
    if (fs.existsSync(targetPath) && !fs.statSync(targetPath).isDirectory()) throw new Error('目标音乐库位置不是文件夹');
    const oldStore = this.fileStore;
    const oldDbPath = this.db.filePath;
    const targetStore = new FileStore(targetPath);
    const playlists = this.db.all('SELECT * FROM local_playlists');
    if (migrate) {
      const songs = this.db.all('SELECT * FROM songs');
      const relations = this.db.all(`SELECT pt.*,lp.folder_name FROM playlist_tracks pt
        JOIN local_playlists lp ON lp.id=pt.playlist_id`);
      await oldStore.migrateManagedLibrary(targetStore, playlists, songs, relations);
      this.db.transaction(() => {
        this.db.db.run(`DELETE FROM track_choices WHERE track_id LIKE 'local-file:%' AND playlist_id IN
          (SELECT id FROM local_playlists WHERE folder_name='.')`);
        for (const song of songs) {
          this.db.db.run('UPDATE songs SET entity_path=? WHERE track_id=?', [path.join(targetStore.songsPath, path.basename(song.entity_path)), song.track_id]);
        }
      });
    } else {
      this.db.transaction(() => {
        this.db.db.run("DELETE FROM track_choices WHERE track_id LIKE 'local-file:%'");
        this.db.db.run('DELETE FROM playlist_tracks');
        this.db.db.run('DELETE FROM songs');
        this.db.db.run(`UPDATE local_playlists SET track_count=0,added_json='[]',removed_json='[]',existing_json='[]',online_tracks_json='[]',
          last_scan_at=NULL,last_sync_at=NULL,offline=1,sync_progress=NULL,error='音乐库位置已更改，请选择现有目录重新映射'`);
      });
    }
    this.fileStore = targetStore;
    this.rootPath = targetPath;
    this.db.filePath = path.join(targetStore.dataPath, 'cloudmusic.sqlite');
    this.db.setSettings({ libraryPath: targetPath, lastScanAt: migrate ? this.db.getSettings().lastScanAt : null, lastSyncAt: migrate ? this.db.getSettings().lastSyncAt : null });
    const discovered = await this.discoverExistingPlaylistFolders();
    this.scanStatus = migrate
      ? `音乐库已迁移到新位置${discovered.added ? `，另识别 ${discovered.added} 个本地歌单` : ''}`
      : discovered.matched
        ? `音乐库位置已更改，已识别 ${discovered.matched} 个本地歌单`
        : '音乐库位置已更改，请扫描后重新同步';
    await this.persistLibraryPath(targetPath);
    if (path.resolve(oldDbPath) !== path.resolve(this.db.filePath)) await fs.promises.rm(oldDbPath, { force: true });
    if (removeEmptySource && this.defaultLibraryPath && path.resolve(oldStore.rootPath) === path.resolve(this.defaultLibraryPath)) {
      await oldStore.removeEmptyManagedRoot(this.defaultLibraryPath);
    }
    if (this.db.getSettings().realtimeSync && discovered.ids.length && !this.tasks.active) this.startSync(discovered.ids, 'realtime');
    return this.bootstrap();
  }

  updateSettings(values) {
    const current = this.db.getSettings();
    const allowed = ['autoScan','autoSync','realtimeSync','scanHours','scanMinutes','deleteRemoved','downloadConcurrency','mp3Bitrate','renamePolicy','cancelDeleteDownloaded','cancelDontAsk','removeLocalDontAsk','cookie'];
    const next = {};
    for (const key of allowed) if (Object.hasOwn(values, key)) next[key] = values[key];
    if (next.cookie === '••••••••') delete next.cookie;
    if (Object.hasOwn(next, 'mp3Bitrate')) next.mp3Bitrate = validateMp3Bitrate(next.mp3Bitrate);
    const interval = normalizeInterval(next.scanHours ?? current.scanHours, next.scanMinutes ?? current.scanMinutes);
    next.scanHours = interval.hours; next.scanMinutes = interval.minutes;
    if (Object.hasOwn(next, 'downloadConcurrency')) {
      next.downloadConcurrency = Math.max(1, Math.min(8, Math.floor(Number(next.downloadConcurrency) || 4)));
      this.downloadConcurrency = next.downloadConcurrency;
    }
    this.db.setSettings(next);
    this.netease.setCookie(this.db.getSettings().cookie);
    this.configureAutoScan();
    this.configureRealtimeSync();
    return this.bootstrap();
  }

  async cancelTask(deleteDownloaded = false) {
    this.tasks.cancel();
    const running = this.syncPromise;
    if (running) await running;
    if (deleteDownloaded) {
      const artifacts = this.tasks.takeArtifacts().reverse();
      const removedTrackIds = [];
      for (const artifact of artifacts) {
        await this.fileStore.removePlaylistLink(artifact.folderName, artifact.filename);
        this.db.run('DELETE FROM playlist_tracks WHERE playlist_id=? AND track_id=?', [artifact.playlistId, artifact.trackId]);
        removedTrackIds.push(artifact.trackId);
      }
      await this.pruneOrphanedSongs(removedTrackIds);
    } else this.tasks.takeArtifacts();
    this.db.setSettings({ interruptedTask: false });
    return this.tasks.getState();
  }
}

function dbTrack(row) {
  return { id: row.track_id, name: row.name, artists: parseJson(row.artists, []), album: row.album, duration: row.duration };
}

function fileKey(filename) { return process.platform === 'win32' ? filename.toLowerCase() : filename; }

function localFileId(row, filename) {
  return `local-file:${crypto.createHash('sha256').update(JSON.stringify([row.id, fileKey(row.folder_name), fileKey(filename)])).digest('hex')}`;
}

function sameSqlRows(left, right) {
  if (left.length !== right.length) return false;
  if (!right.length) return true;
  const keys = Object.keys(right[0]);
  return left.every((row, index) => keys.every((key) => row[key] === right[index][key]));
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
}

function indexFolders(folders) {
  const byPath = new Map(folders.map((folder) => [folder.toLowerCase(), folder]));
  const byName = new Map();
  for (const folder of folders) {
    const name = path.basename(folder).toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(folder);
  }
  return { byPath, byName };
}

function flattenArtists(artist) {
  if (!Array.isArray(artist)) return '';
  return artist
    .map((entry) => (Array.isArray(entry) ? entry[0] : entry))
    .filter(Boolean)
    .join(' / ');
}

function scanMessage(source) {
  return {
    auto: '自动扫描正在检查歌单更新…',
    realtime: '实时同步正在检测歌单更新…',
    startup: '启动扫描正在检查歌单更新…',
    setup: '正在扫描新账号的歌单更新…',
    manual: '正在扫描本地与在线歌单差异…'
  }[source] || '正在扫描本地与在线歌单差异…';
}

module.exports = { AppService };
