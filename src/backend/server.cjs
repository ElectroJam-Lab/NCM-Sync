const express = require('express');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

function createServer({ service, staticPath, port = 0, rendererOrigin = '' }) {
  const app = express();
  const allowedOrigins = new Set();
  const sessionId = randomUUID();
  let bootstrapCache;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isAllowedMutation(req, allowedOrigins)) {
      return res.status(403).json({ error: '拒绝来自其他来源的请求' });
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/bootstrap', (req, res) => {
    const revision = service.bootstrapRevision();
    if (bootstrapCache?.revision !== revision) {
      const etag = `"${createHash('sha256').update(sessionId + revision).digest('hex')}"`;
      bootstrapCache = { revision, etag, body: JSON.stringify(service.bootstrap({ summary: true })) };
    }
    res.setHeader('ETag', bootstrapCache.etag);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (req.get('if-none-match') === bootstrapCache.etag) return res.status(304).end();
    return res.type('json').send(bootstrapCache.body);
  });
  app.get('/api/local/:id', asyncHandler(async (req, res) => res.json(service.localDetail(req.params.id))));
  app.post('/api/local/map', asyncHandler(async (req, res) => res.json(await service.mapPlaylist(req.body.onlineId, req.body.folderPath, req.body.localId))));
  app.put('/api/local/:id/choices', asyncHandler(async (req, res) => res.json(await service.saveTrackChoices(req.params.id, req.body.revision, req.body.changes))));
  app.post('/api/setup', asyncHandler(async (req, res) => res.json(await service.setupUser(req.body.userId, Boolean(req.body.changing)))));
  app.post('/api/setup/later', (_req, res) => res.json(service.dismissSetup()));
  app.post('/api/online/refresh', asyncHandler(async (_req, res) => res.json({ online: await service.refreshOnline() })));
  app.get('/api/online/:id', asyncHandler(async (req, res) => res.json(await service.playlistDetail(req.params.id))));
  app.post('/api/local', asyncHandler(async (req, res) => res.json(await service.addLocal(req.body.onlineIds))));
  app.post('/api/scan', asyncHandler(async (_req, res) => res.json(await service.scanAll())));
  app.put('/api/sync/selection', asyncHandler(async (req, res) => res.json(service.setSyncSelection(req.body.onlineIds))));
  app.post('/api/sync', asyncHandler(async (req, res) => { res.status(202).json(await service.syncSelected(req.body.ids)); }));
  app.post('/api/local/pause', asyncHandler(async (req, res) => res.json({ local: service.setLocalPaused(req.body.ids, req.body.paused) })));
  app.post('/api/local/remove', asyncHandler(async (req, res) => res.json({ local: await service.removeLocal(req.body.ids) })));
  app.post('/api/local/:id/redirect', asyncHandler(async (req, res) => res.json({ local: await service.redirectLocal(req.params.id, req.body.onlineId) })));
  app.post('/api/local/:id/rename-folder', asyncHandler(async (req, res) => res.json({ local: await service.syncFolderName(req.params.id) })));
  app.post('/api/local/:id/open', asyncHandler(async (req, res) => { await service.openLocal(req.params.id); res.json({ ok: true }); }));
  app.post('/api/library/open', asyncHandler(async (_req, res) => { await service.openLibrary(); res.json({ ok: true }); }));
  app.post('/api/library/change', asyncHandler(async (req, res) => res.json(await service.changeLibrary(req.body.path, Boolean(req.body.migrate), Boolean(req.body.removeEmptySource)))));
  app.put('/api/settings', asyncHandler(async (req, res) => res.json(service.updateSettings(req.body))));
  app.post('/api/task/pause', (_req, res) => { service.tasks.pause(); res.json(service.tasks.getState()); });
  app.post('/api/task/resume', (_req, res) => { service.tasks.resume(); res.json(service.tasks.getState()); });
  app.post('/api/task/cancel', asyncHandler(async (req, res) => res.json(await service.cancelTask(Boolean(req.body.deleteDownloaded)))));

  if (staticPath) {
    app.use(express.static(staticPath));
    app.get('/{*splat}', (_req, res) => res.sendFile(path.join(staticPath, 'index.html')));
  }

  app.use((error, _req, res, _next) => {
    const status = /不存在|未找到|失效/.test(error.message) ? 404 : 400;
    res.status(status).json({ error: error.message || '未知错误' });
  });

  const server = app.listen(port, '127.0.0.1');
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => {
      const address = server.address();
      const url = `http://127.0.0.1:${address.port}`;
      allowedOrigins.add(url);
      if (rendererOrigin) {
        try { allowedOrigins.add(new URL(rendererOrigin).origin); }
        catch { /* 无效开发地址不会被信任 */ }
      }
      resolve({ app, server, url });
    });
  });
}

function isAllowedMutation(req, allowedOrigins) {
  const origin = req.get('origin');
  if (origin) return allowedOrigins.has(origin);
  return req.get('sec-fetch-site') !== 'cross-site';
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = { createServer, isAllowedMutation };
