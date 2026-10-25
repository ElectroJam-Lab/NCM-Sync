const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../../src/backend/server.cjs');

test('本地 API 设置安全响应头并拒绝跨来源写操作', async (t) => {
  const service = {
    bootstrapRevision: () => 'unchanged',
    bootstrap: () => ({ ok: true }),
    dismissSetup: () => ({ initialized: true })
  };
  const runtime = await createServer({ service, port: 0 });
  t.after(() => new Promise((resolve) => runtime.server.close(resolve)));

  const bootstrap = await fetch(`${runtime.url}/api/bootstrap`);
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(bootstrap.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(bootstrap.headers.get('x-content-type-options'), 'nosniff');

  const rejected = await fetch(`${runtime.url}/api/setup/later`, {
    method: 'POST',
    headers: { Origin: 'https://untrusted.example' }
  });
  assert.equal(rejected.status, 403);

  const accepted = await fetch(`${runtime.url}/api/setup/later`, {
    method: 'POST',
    headers: { Origin: runtime.url }
  });
  assert.equal(accepted.status, 200);
});
