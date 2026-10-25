const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { sanitizeName, trackFilename, normalizeText, isPathInside } = require('./utils.cjs');
const { decodeNcm } = require('./ncm-decoder.cjs');

class FileStore {
  constructor(rootPath) {
    this.rootPath = path.resolve(rootPath);
    this.songsPath = path.join(this.rootPath, 'songs');
    this.dataPath = path.join(this.rootPath, '.cloudmusic');
    fs.mkdirSync(this.songsPath, { recursive: true });
    fs.mkdirSync(this.dataPath, { recursive: true });
  }

  playlistPath(folderName) {
    const name = String(folderName || '').trim();
    if (!name) throw new Error('请选择音乐库内的文件夹');
    const target = path.resolve(this.rootPath, name);
    const relative = path.relative(this.rootPath, target);
    const first = relative.split(path.sep)[0].toLowerCase();
    if (!isPathInside(this.rootPath, target) || ['songs', '.cloudmusic'].includes(first)) {
      throw new Error('歌单目录必须位于音乐库内，且不能使用实体库或应用数据目录');
    }
    let current = this.rootPath;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      let stat;
      try { stat = fs.lstatSync(current); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (stat?.isSymbolicLink()) throw new Error('歌单目录不能包含符号链接或目录联接');
    }
    return target;
  }

  relativePlaylistPath(folderPath) { return path.relative(this.rootPath, this.playlistPath(folderPath)) || '.'; }

  isLibraryFolder(folderName) { return path.relative(this.rootPath, this.playlistPath(folderName)) === ''; }

  async listPlaylistFolders() {
    if (!fs.existsSync(this.rootPath)) return [];
    const reserved = new Set([path.basename(this.songsPath), path.basename(this.dataPath)].map((name) => name.toLowerCase()));
    const folders = [];
    const pending = [''];
    while (pending.length) {
      const parent = pending.pop();
      let entries;
      try { entries = await fsp.readdir(path.join(this.rootPath, parent), { withFileTypes: true }); }
      catch (error) { if (['EACCES', 'EPERM', 'ENOENT'].includes(error.code)) continue; throw error; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || (!parent && reserved.has(entry.name.toLowerCase()))) continue;
        const relative = path.join(parent, entry.name);
        folders.push(relative);
        pending.push(relative);
      }
    }
    return folders;
  }

  ensurePlaylistFolder(folderName) {
    const folderPath = this.playlistPath(folderName);
    if (folderPath === this.rootPath) {
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new Error('音乐库目录不存在');
      return folderPath;
    }
    fs.mkdirSync(folderPath, { recursive: true });
    return folderPath;
  }

  chooseFolderName(name, playlistId, rows = []) {
    const base = sanitizeName(name, `歌单-${playlistId}`);
    const owned = rows.find((row) => row.folder_name.toLowerCase() === base.toLowerCase());
    if (owned) return owned.id === String(playlistId) ? base : `${base} [${playlistId}]`;
    const full = this.playlistPath(base);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) return base;
    return `${base} [${playlistId}]`;
  }

  listAudioFiles(folderName) {
    const folderPath = this.playlistPath(folderName);
    if (!fs.existsSync(folderPath)) return [];
    return fs.readdirSync(folderPath, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(mp3|flac|wav|m4a|aac|ogg|opus|aif|aiff|aifc|wma)$/i.test(entry.name))
      .map((entry) => ({ name: entry.name, path: path.join(folderPath, entry.name), normalized: normalizeText(path.parse(entry.name).name.replace(/\[\d+\]$/, '')) }));
  }

  async detectMovedFolder(expectedName, knownFilenames, managedFolders = [], folders) {
    if (!knownFilenames.length) return null;
    const excluded = new Set(['songs', '.cloudmusic', expectedName, ...managedFolders].map((name) => String(name).toLowerCase()));
    const candidates = (folders || await this.listPlaylistFolders())
      .filter((name) => !excluded.has(name.toLowerCase()))
      .map((name) => {
        const names = new Set(fs.readdirSync(this.playlistPath(name), { withFileTypes: true }).filter((item) => item.isFile()).map((item) => item.name.toLowerCase()));
        const matches = knownFilenames.filter((name) => names.has(name.toLowerCase())).length;
        return { name, matches };
      }).filter((item) => item.matches > 0).sort((a, b) => b.matches - a.matches);
    if (!candidates.length || (candidates[1] && candidates[0].matches === candidates[1].matches)) return null;
    return candidates[0].name;
  }

  findLegacyMatch(track, files, claimed = new Set()) {
    const title = normalizeText(track.name);
    const artists = (track.artists || []).map(normalizeText).filter(Boolean);
    const candidates = files.filter((file) => !claimed.has(file.path)).map((file) => {
      const normalized = file.normalized ?? normalizeText(path.parse(file.name).name.replace(/\[\d+\]$/, ''));
      let score = title && normalized.includes(title) ? 5 : 0;
      if (artists.some((artist) => normalized.includes(artist))) score += 2;
      if (normalized === normalizeText(`${artists[0] || ''}${title}`) || normalized === normalizeText(`${title}${artists[0] || ''}`)) score += 4;
      return { file, score };
    }).filter((item) => item.score >= 5).sort((a, b) => b.score - a.score);
    if (!candidates.length || (candidates[1] && candidates[0].score === candidates[1].score && candidates[0].score < 9)) return null;
    claimed.add(candidates[0].file.path);
    return candidates[0].file;
  }

  async adoptLegacyFile(track, legacyFile) {
    const extension = path.extname(legacyFile.name).slice(1).toLowerCase() || 'mp3';
    const entityName = trackFilename(track, extension);
    const entityPath = path.join(this.songsPath, entityName);
    if (!fs.existsSync(entityPath)) {
      try { await fsp.link(legacyFile.path, entityPath); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        await fsp.copyFile(legacyFile.path, entityPath, fs.constants.COPYFILE_EXCL);
      }
    }
    const stat = await fsp.stat(entityPath);
    return { entityPath, filename: legacyFile.name, extension, size: stat.size };
  }

  async createPlaylistLink(entityPath, folderName, filename) {
    const folderPath = this.playlistPath(folderName);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) throw new Error('映射的本地文件夹不存在，请重新选择');
    const targetPath = path.join(folderPath, filename);
    if (path.basename(filename) !== filename || !isPathInside(folderPath, targetPath)) throw new Error('歌曲文件名不安全');
    if (fs.existsSync(targetPath)) {
      if (fs.lstatSync(targetPath).isSymbolicLink()) throw new Error('歌曲路径不能是符号链接');
      return targetPath;
    }
    try { await fsp.link(entityPath, targetPath); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      await fsp.copyFile(entityPath, targetPath, fs.constants.COPYFILE_EXCL);
    }
    return targetPath;
  }

  async downloadTrack(track, response, taskControl) {
    const filename = trackFilename(track, 'mp3');
    const finalPath = path.join(this.songsPath, filename);
    const ncmPath = `${finalPath}.ncm`;
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).size > 0) {
      const stat = fs.statSync(finalPath);
      return { entityPath: finalPath, filename, extension: 'mp3', size: stat.size, created: false };
    }
    if (fs.existsSync(ncmPath) && fs.statSync(ncmPath).size > 0) {
      return { encrypted: true, ncmPath, created: true };
    }
    const partialPath = `${finalPath}.partial`;
    const handle = await fsp.open(partialPath, 'w');
    let size = 0;
    let first = Buffer.alloc(0);
    try {
      const reader = response.body.getReader();
      while (true) {
        await taskControl.waitIfPaused();
        taskControl.throwIfCancelled();
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (first.length < 16) first = Buffer.concat([first, chunk]).subarray(0, 16);
        await handle.write(chunk);
        size += chunk.length;
      }
    } catch (error) {
      await handle.close();
      await fsp.rm(partialPath, { force: true });
      throw error;
    }
    await handle.close();
    if (!size) {
      await fsp.rm(partialPath, { force: true });
      throw new Error('下载结果为空');
    }
    if (first.subarray(0, 8).toString('ascii') === 'CTENFDAM') {
      await fsp.rename(partialPath, ncmPath);
      return { encrypted: true, ncmPath, created: true };
    }
    const extension = first.subarray(0, 4).toString('ascii') === 'fLaC' ? 'flac' : 'mp3';
    const audioFilename = trackFilename(track, extension);
    const audioPath = path.join(this.songsPath, audioFilename);
    await fsp.rename(partialPath, audioPath);
    return { entityPath: audioPath, filename: audioFilename, extension, size, created: true };
  }

  async removePlaylistFolder(folderName) {
    const folderPath = this.playlistPath(folderName);
    if (!isPathInside(this.rootPath, folderPath) || folderPath === this.rootPath) throw new Error('拒绝删除不安全的目录');
    if (!fs.existsSync(folderPath)) return;
    for (const file of this.listAudioFiles(folderName)) await this.removePlaylistLink(folderName, file.name);
    // Child playlists, unrelated directories, sidecars and symbolic links remain untouched.
    if ((await fsp.readdir(folderPath)).length === 0) await fsp.rmdir(folderPath);
  }

  async renamePlaylistFolder(oldName, newName) {
    const from = this.playlistPath(oldName);
    if (from === this.rootPath) throw new Error('音乐库根目录不能随歌单重命名');
    const to = this.playlistPath(path.join(path.dirname(oldName), sanitizeName(newName)));
    if (!isPathInside(this.rootPath, from) || !isPathInside(this.rootPath, to)) throw new Error('目录名称不安全');
    if (fs.existsSync(to)) throw new Error('目标文件夹已存在');
    const entries = await fsp.readdir(from, { withFileTypes: true });
    if (entries.some((entry) => entry.isDirectory() || entry.isSymbolicLink())) {
      // Renaming a parent playlist moves its own audio, leaving child paths unchanged.
      await fsp.mkdir(to);
      const moved = [];
      try {
        for (const file of this.listAudioFiles(oldName)) {
          const target = path.join(to, file.name);
          await moveFileExclusive(file.path, target);
          moved.push({ source: file.path, target });
        }
      } catch (error) {
        for (const file of moved.reverse()) await moveFileExclusive(file.target, file.source);
        if ((await fsp.readdir(to)).length === 0) await fsp.rmdir(to);
        throw error;
      }
    } else await fsp.rename(from, to);
    return path.relative(this.rootPath, to);
  }

  async removePlaylistLink(folderName, filename) {
    const folderPath = this.playlistPath(folderName);
    const target = path.join(folderPath, filename);
    if (path.basename(filename) !== filename || !isPathInside(folderPath, target)) throw new Error('歌曲路径不安全');
    await fsp.rm(target, { force: true });
  }

  async removeSongEntity(entityPath) {
    const target = path.resolve(entityPath);
    if (!isPathInside(this.songsPath, target) || target === this.songsPath) {
      throw new Error('拒绝删除音乐库外的歌曲实体');
    }
    await fsp.rm(target, { force: true });
  }

  async finishNcm(track, ncmPath) {
    const baseName = path.parse(trackFilename(track, 'mp3')).name;
    const decoded = await decodeNcm(ncmPath, path.join(this.songsPath, baseName));
    const finalPath = decoded.outputPath;
    await fsp.rm(ncmPath, { force: true });
    const stat = await fsp.stat(finalPath);
    return {
      entityPath: finalPath,
      filename: path.basename(finalPath),
      extension: decoded.extension,
      metadata: decoded.metadata,
      cover: decoded.cover,
      size: stat.size,
      created: true
    };
  }

  async migrateManagedLibrary(targetStore, playlists, songs, playlistTracks) {
    if (path.resolve(targetStore.rootPath) === this.rootPath) return;
    if (isPathInside(this.rootPath, targetStore.rootPath) || isPathInside(targetStore.rootPath, this.rootPath)) {
      throw new Error('新旧音乐库位置不能互相嵌套');
    }
    const rootRelations = playlistTracks.filter((relation) => this.isLibraryFolder(relation.folder_name));
    for (const relation of rootRelations) {
      const source = path.join(this.rootPath, relation.filename);
      const target = path.join(targetStore.rootPath, relation.filename);
      if (path.basename(relation.filename) !== relation.filename || !isPathInside(this.rootPath, source) || !isPathInside(targetStore.rootPath, target)) throw new Error('歌曲路径不安全');
      if (fs.existsSync(target)) throw new Error(`目标音乐库中已存在同名歌曲：${relation.filename}`);
      if (fs.existsSync(source) && fs.lstatSync(source).isSymbolicLink()) throw new Error('歌曲路径不能是符号链接');
    }
    // Move an outer mapped tree once, irrespective of parent/child insertion order.
    const folders = playlists.filter((playlist) => !this.isLibraryFolder(playlist.folder_name))
      .map((playlist) => playlist.folder_name).sort((left, right) => left.length - right.length);
    const outerFolders = [];
    for (const folder of folders) {
      const source = this.playlistPath(folder);
      if (outerFolders.some((parent) => isPathInside(this.playlistPath(parent), source))) continue;
      const target = targetStore.playlistPath(folder);
      if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || (await fsp.readdir(target)).length)) {
        throw new Error(`目标目录不是空目录：${target}`);
      }
      outerFolders.push(folder);
    }
    await moveDirectory(this.songsPath, targetStore.songsPath);
    for (const folder of outerFolders) await moveDirectory(this.playlistPath(folder), targetStore.playlistPath(folder));
    const songPaths = new Map(songs.map((song) => [song.track_id, path.join(targetStore.songsPath, path.basename(song.entity_path))]));
    for (const relation of playlistTracks) {
      const entityPath = songPaths.get(relation.track_id);
      if (!entityPath || !fs.existsSync(entityPath)) continue;
      const folderPath = targetStore.ensurePlaylistFolder(relation.folder_name);
      const linkPath = path.join(folderPath, relation.filename);
      const inRoot = this.isLibraryFolder(relation.folder_name);
      if (!inRoot) await fsp.rm(linkPath, { force: true });
      await targetStore.createPlaylistLink(entityPath, relation.folder_name, relation.filename);
      if (inRoot) await this.removePlaylistLink(relation.folder_name, relation.filename);
    }
  }

  async removeEmptyManagedRoot(expectedRoot) {
    const expected = path.resolve(expectedRoot);
    if (expected !== this.rootPath) throw new Error('拒绝清理非预期的音乐库目录');
    for (const directory of [this.songsPath, this.dataPath]) {
      if (!fs.existsSync(directory)) continue;
      if ((await fsp.readdir(directory)).length === 0) await fsp.rmdir(directory);
    }
    if (fs.existsSync(this.rootPath) && (await fsp.readdir(this.rootPath)).length === 0) {
      await fsp.rmdir(this.rootPath);
      return true;
    }
    return false;
  }
}

async function moveFileExclusive(source, target) {
  try { await fsp.link(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
  }
  try { await fsp.unlink(source); }
  catch (error) { await fsp.unlink(target); throw error; }
}

async function moveDirectory(source, target) {
  if (!fs.existsSync(source)) { await fsp.mkdir(target, { recursive: true }); return; }
  if (fs.existsSync(target)) {
    const entries = await fsp.readdir(target);
    if (entries.length) throw new Error(`目标目录不是空目录：${target}`);
    await fsp.rm(target, { recursive: true, force: true });
  }
  await fsp.mkdir(path.dirname(target), { recursive: true });
  try { await fsp.rename(source, target); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fsp.cp(source, target, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    await fsp.rm(source, { recursive: true, force: true });
  }
}

module.exports = { FileStore };
