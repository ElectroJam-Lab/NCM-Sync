const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const MP3_BITRATES = [0, 128, 192, 256, 320];

function validateMp3Bitrate(value) {
  if (typeof value !== 'number' || !MP3_BITRATES.includes(value)) throw new Error('MP3 码率请选择保留源音质、128、192、256 或 320 kbps');
  return value;
}

function encoderPath() {
  const bundled = require('ffmpeg-static');
  if (!bundled) throw new Error('当前平台没有可用的 MP3 编码器');
  const executable = bundled.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  if (!fs.existsSync(executable)) throw new Error('MP3 编码器缺失，请重新安装应用或选择保留源音质');
  return executable;
}

async function exportMp3(downloaded, bitrate, control) {
  validateMp3Bitrate(bitrate);
  if (!bitrate) return downloaded;
  await control.waitIfPaused();
  control.throwIfCancelled();
  const executable = encoderPath();
  const destination = path.join(path.dirname(downloaded.entityPath), `${path.parse(downloaded.filename).name}.mp3`);
  const staging = `${destination}.${randomUUID()}.encoding`;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(executable, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', downloaded.entityPath, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame',
        '-b:a', `${bitrate}k`, '-ar', '44100', '-threads', '1', '-f', 'mp3', staging],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
      let spawnError;
      const cancel = () => child.kill();
      control.signal?.addEventListener('abort', cancel, { once: true });
      if (control.signal?.aborted) cancel();
      child.once('error', (error) => { spawnError = error; });
      child.once('close', (code) => {
        control.signal?.removeEventListener('abort', cancel);
        try { control.throwIfCancelled(); } catch (error) { return reject(error); }
        if (spawnError || code !== 0) return reject(new Error('MP3 转码失败，请重试或选择保留源音质'));
        resolve();
      });
    });
    await control.waitIfPaused();
    control.throwIfCancelled();
    const stat = await fsp.stat(staging);
    if (!stat.size) throw new Error('MP3 转码结果为空');
    await fsp.rename(staging, destination);
    if (downloaded.entityPath !== destination) await fsp.rm(downloaded.entityPath, { force: true });
    return { ...downloaded, entityPath: destination, filename: path.basename(destination), extension: 'mp3', size: stat.size };
  } finally {
    await fsp.rm(staging, { force: true });
  }
}

module.exports = { exportMp3, validateMp3Bitrate };
