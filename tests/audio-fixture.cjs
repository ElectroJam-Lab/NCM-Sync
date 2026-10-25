const assert = require('node:assert/strict');

function wavFixture(seconds = 1) {
  const sampleRate = 24000;
  const count = Math.floor(sampleRate * seconds);
  const wave = Buffer.alloc(44 + count * 2);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8);
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24); wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wave.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / sampleRate) * 6000), 44 + i * 2);
  return wave;
}

function assertMp3Bitrate(audio, bitrate) {
  let start = 0;
  if (audio.subarray(0, 3).toString() === 'ID3') {
    start = 10 + ((audio[6] & 127) << 21 | (audio[7] & 127) << 14 | (audio[8] & 127) << 7 | audio[9] & 127);
  }
  const bitrates = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
  let frames = 0;
  for (let offset = start; offset + 4 <= audio.length;) {
    if (audio[offset] !== 255 || (audio[offset + 1] & 254) !== 250) break;
    const rate = bitrates[audio[offset + 2] >> 4];
    assert.equal(rate, bitrate, 'MPEG 音频帧必须使用所选固定码率');
    assert.equal((audio[offset + 2] >> 2) & 3, 0, '固定码率导出使用 44.1 kHz');
    offset += Math.floor(144 * rate * 1000 / 44100) + ((audio[offset + 2] >> 1) & 1);
    frames += 1;
  }
  assert.ok(frames > 3, '应包含真实可解析的连续 MP3 音频帧');
}

module.exports = { wavFixture, assertMp3Bitrate };
