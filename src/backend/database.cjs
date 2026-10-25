const fs = require('node:fs');
const path = require('node:path');
const initSqlJs = require('sql.js');

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
    this.revision = 0;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const data = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : undefined;
    this.db = new SQL.Database(data);
    this.db.run('PRAGMA foreign_keys = ON;');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS online_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_id TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        track_count INTEGER NOT NULL DEFAULT 0,
        kind TEXT NOT NULL,
        cover_url TEXT,
        raw_json TEXT,
        fetched_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS local_playlists (
        id TEXT PRIMARY KEY,
        online_id TEXT,
        name TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT 0,
        track_count INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0,
        offline INTEGER NOT NULL DEFAULT 0,
        previous_name TEXT,
        pending_name TEXT,
        added_at INTEGER NOT NULL,
        last_sync_at INTEGER,
        last_scan_at INTEGER,
        added_json TEXT NOT NULL DEFAULT '[]',
        removed_json TEXT NOT NULL DEFAULT '[]',
        existing_json TEXT NOT NULL DEFAULT '[]',
        sync_progress TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS songs (
        track_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        artists TEXT NOT NULL DEFAULT '[]',
        album TEXT NOT NULL DEFAULT '',
        duration INTEGER NOT NULL DEFAULT 0,
        entity_path TEXT NOT NULL,
        extension TEXT NOT NULL DEFAULT 'mp3',
        size INTEGER NOT NULL DEFAULT 0,
        cover_url TEXT NOT NULL DEFAULT '',
        cover_embedded INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        filename TEXT NOT NULL,
        linked_at INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES local_playlists(id) ON DELETE CASCADE,
        FOREIGN KEY (track_id) REFERENCES songs(track_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
      CREATE TABLE IF NOT EXISTS track_choices (
        playlist_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK(action IN ('add','remove','keep')),
        PRIMARY KEY (playlist_id, track_id),
        FOREIGN KEY (playlist_id) REFERENCES local_playlists(id) ON DELETE CASCADE
      );
    `);
    this.migrateSongs();
    const localColumns = new Set(this.all('PRAGMA table_info(local_playlists)').map((row) => row.name));
    if (!localColumns.has('custom_mapping')) this.db.run('ALTER TABLE local_playlists ADD COLUMN custom_mapping INTEGER NOT NULL DEFAULT 0');
    if (!localColumns.has('online_tracks_json')) this.db.run("ALTER TABLE local_playlists ADD COLUMN online_tracks_json TEXT NOT NULL DEFAULT '[]'");
    const choiceColumns = new Set(this.all('PRAGMA table_info(track_choices)').map((row) => row.name));
    if (!choiceColumns.has('enabled')) {
      this.db.run('ALTER TABLE track_choices ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1');
      this.db.run(`UPDATE track_choices SET enabled=0 WHERE action<>'add' AND NOT EXISTS
        (SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id=track_choices.playlist_id AND pt.track_id=track_choices.track_id)`);
    }
    const defaults = {
      userId: '', initialized: false, autoScan: false, autoSync: false, realtimeSync: false,
      scanHours: 1, scanMinutes: 0, deleteRemoved: false, downloadConcurrency: 4, mp3Bitrate: 0,
      renamePolicy: 'ask', cancelDeleteDownloaded: false,
      cancelDontAsk: false, removeLocalDontAsk: false, cookie: '', interruptedTask: false,
      lastGlobalStatus: '', libraryPath: '', lastScanAt: null, lastSyncAt: null, syncPlaylistIds: []
    };
    for (const [key, value] of Object.entries(defaults)) {
      this.db.run('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)', [key, JSON.stringify(value)]);
    }
    this.save();
    return this;
  }

  migrateSongs() {
    const columns = new Set(this.all('PRAGMA table_info(songs)').map((row) => row.name));
    if (!columns.has('cover_url')) {
      this.db.run(`ALTER TABLE songs ADD COLUMN cover_url TEXT NOT NULL DEFAULT ''`);
    }
    if (!columns.has('cover_embedded')) {
      this.db.run(`ALTER TABLE songs ADD COLUMN cover_embedded INTEGER NOT NULL DEFAULT 0`);
    }
    this.save();
  }

  save() {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, Buffer.from(this.db.export()));
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
    fs.renameSync(tempPath, this.filePath);
  }

  run(sql, params = [], save = true) {
    this.db.run(sql, params);
    this.revision += 1;
    if (save) this.save();
  }

  all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  get(sql, params = []) { return this.all(sql, params)[0] || null; }

  transaction(callback) {
    this.db.run('BEGIN');
    try {
      const result = callback();
      this.db.run('COMMIT');
      this.revision += 1;
      this.save();
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  getSettings() {
    const output = {};
    for (const row of this.all('SELECT key, value FROM settings')) {
      try { output[row.key] = JSON.parse(row.value); } catch { output[row.key] = row.value; }
    }
    return output;
  }

  setSettings(values) {
    this.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        this.db.run('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, JSON.stringify(value)]);
      }
    });
  }
}

module.exports = { Database };
