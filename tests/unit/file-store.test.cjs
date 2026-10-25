const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FileStore } = require('../../src/backend/file-store.cjs');
const { CORE_KEY, META_KEY, buildKeyBox, cryptAudioChunk } = require('../../src/backend/ncm-decoder.cjs');

test('直接下载的 FLAC 保留正确格式和文件扩展名', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-flac-'));
  t.after(() => { assert.ok(path.basename(root).startsWith('cloudmusic-flac-')); fs.rmSync(root, { recursive: true, force: true }); });
  const audio = Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(100)]);
  const downloaded = await new FileStore(root).downloadTrack({ id: '9', name: 'Lossless', artists: ['Artist'] }, new Response(audio), {
    waitIfPaused: async () => {}, throwIfCancelled: () => {}
  });
  assert.equal(downloaded.extension, 'flac');
  assert.match(downloaded.filename, /\.flac$/);
  assert.deepEqual(fs.readFileSync(downloaded.entityPath), audio);
});

test('内置 NCM 解码器将 VIP 歌曲纯解码为标准 MP3，并保留容器封面与元数据', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-ncm-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('cloudmusic-ncm-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const audio = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(4096, 7)]);
  const cover = createJpegFixture();
  const response = new Response(createNcmFixture(audio, {
    metadata: { musicName: 'VIP Track', artist: [['Artist']], album: 'Album', format: 'mp3' },
    cover
  }));
  const store = new FileStore(root);
  const track = { id: '7', name: 'VIP Track', artists: ['Artist'] };
  const downloaded = await store.downloadTrack(track, response, {
    waitIfPaused: async () => {}, throwIfCancelled: () => {}
  });
  assert.equal(downloaded.encrypted, true);
  const decoded = await store.finishNcm(track, downloaded.ncmPath);
  assert.equal(decoded.extension, 'mp3');
  assert.deepEqual(fs.readFileSync(decoded.entityPath), audio);
  assert.deepEqual(decoded.cover, cover);
  assert.equal(decoded.metadata.musicName, 'VIP Track');
  assert.equal(fs.existsSync(downloaded.ncmPath), false);
});

test('内置 NCM 解码器将 VIP FLAC 歌曲纯解码为 flac，并保留容器封面', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudmusic-ncm-flac-'));
  t.after(() => {
    assert.ok(path.basename(root).startsWith('cloudmusic-ncm-flac-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const audioFrames = Buffer.alloc(2048, 0xaa);
  const audio = Buffer.concat([Buffer.from('fLaC', 'ascii'), encodeFlacBlock(0, Buffer.alloc(34), true), audioFrames]);
  const cover = createJpegFixture();
  const response = new Response(createNcmFixture(audio, {
    metadata: { musicName: 'VIP FLAC', artist: [['Artist']], album: 'Album', format: 'flac' },
    cover
  }));
  const store = new FileStore(root);
  const track = { id: '8', name: 'VIP FLAC', artists: ['Artist'] };
  const downloaded = await store.downloadTrack(track, response, {
    waitIfPaused: async () => {}, throwIfCancelled: () => {}
  });
  assert.equal(downloaded.encrypted, true);
  const decoded = await store.finishNcm(track, downloaded.ncmPath);
  assert.equal(decoded.extension, 'flac');
  assert.deepEqual(fs.readFileSync(decoded.entityPath), audio);
  assert.deepEqual(decoded.cover, cover);
  assert.equal(decoded.metadata.musicName, 'VIP FLAC');
});

function createNcmFixture(audio, { metadata = null, cover = null } = {}) {
  const audioKey = Buffer.from('test-audio-key');
  const plainKey = Buffer.concat([Buffer.from('neteasecloudmusic'), audioKey]);
  const cipher = crypto.createCipheriv('aes-128-ecb', CORE_KEY, null);
  const encryptedKey = Buffer.concat([cipher.update(plainKey), cipher.final()]);
  for (let index = 0; index < encryptedKey.length; index += 1) encryptedKey[index] ^= 0x64;
  const keyLength = Buffer.alloc(4); keyLength.writeUInt32LE(encryptedKey.length);

  let metaLength = Buffer.alloc(4);
  let metaSection = Buffer.alloc(0);
  if (metadata) {
    const plainMeta = Buffer.concat([Buffer.from('music:', 'ascii'), Buffer.from(JSON.stringify(metadata), 'utf8')]);
    const metaCipher = crypto.createCipheriv('aes-128-ecb', META_KEY, null);
    const encryptedMeta = Buffer.concat([metaCipher.update(plainMeta), metaCipher.final()]);
    const encoded = Buffer.concat([Buffer.alloc(22), Buffer.from(encryptedMeta.toString('base64'), 'ascii')]);
    for (let index = 0; index < encoded.length; index += 1) encoded[index] ^= 0x63;
    metaLength = Buffer.alloc(4); metaLength.writeUInt32LE(encoded.length);
    metaSection = encoded;
  }

  let coverLength = Buffer.alloc(4);
  let coverSection = Buffer.alloc(0);
  if (cover) {
    coverLength = Buffer.alloc(4); coverLength.writeUInt32LE(cover.length);
    coverSection = cover;
  }

  const encryptedAudio = cryptAudioChunk(audio, buildKeyBox(audioKey));
  return Buffer.concat([
    Buffer.from('CTENFDAM'), Buffer.alloc(2), keyLength, encryptedKey,
    metaLength, metaSection, Buffer.alloc(9), coverLength, coverSection, encryptedAudio
  ]);
}

function createJpegFixture() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x2d, 0x00, 0x40, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    0xff, 0xd9
  ]);
}

function encodeFlacBlock(type, data, last) {
  const header = Buffer.alloc(4);
  header[0] = (type & 0x7f) | (last ? 0x80 : 0);
  header[1] = (data.length >>> 16) & 0xff;
  header[2] = (data.length >>> 8) & 0xff;
  header[3] = data.length & 0xff;
  return Buffer.concat([header, data]);
}
