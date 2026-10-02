import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { spawn, spawnSync } from 'node:child_process';
import { StreamingAudioDecoder } from '../src/asr/audioDecoder.js';
import { OGG_OPUS } from './fixtures/asrEncoded.js';

const command = process.env.PHOENIX_FFMPEG || 'ffmpeg';
const available = spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
const endOfPage = (offset = 0) => {
  const count = OGG_OPUS[offset + 26];
  return offset + 27 + count + [...OGG_OPUS.subarray(offset + 27, offset + 27 + count)].reduce((a, b) => a + b, 0);
};
const headersEnd = endOfPage(endOfPage());
const thirdPageEnd = endOfPage(headersEnd);
function exitedChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, done) { done(); } });
  child.kill = () => child.emit('close', null, 'SIGTERM');
  return child;
}
const timed = promise => Promise.race([promise, new Promise((_, reject) => {
  const timer = setTimeout(() => reject(new Error('Decoder recovery timed out')), 3000); timer.unref();
})]);

test('early clean exit after three Ogg pages replays every byte once through real ffmpeg', { skip: !available }, async () => {
  const expected = spawnSync(command, ['-hide_banner', '-loglevel', 'error', '-f', 'ogg', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], { input: OGG_OPUS });
  assert.equal(expected.status, 0);
  for (const prefixEnd of [thirdPageEnd, thirdPageEnd + 12]) {
    const first = exitedChild();
    const pcm = []; let launches = 0;
    const decoder = new StreamingAudioDecoder({ encoding: 'OGG_OPUS', onPcm: bytes => pcm.push(bytes), log: {},
      spawnProcess: (...args) => ++launches === 1 ? first : spawn(...args),
    });
    try {
      decoder.start(); decoder.write(OGG_OPUS.subarray(0, prefixEnd));
      assert.equal(decoder.oggPages, 3);
      first.emit('close', 0, null);
      assert.equal(decoder.failed, false);
      decoder.write(OGG_OPUS.subarray(prefixEnd));
      await timed(decoder.finish());
      assert.equal(launches, 2);
      assert.deepEqual(Buffer.concat(pcm), expected.stdout, 'no initial microphone page was dropped or repeated');
    } finally { decoder.abort(); }
  }
});

test('a queued recovery begins without requiring another microphone packet', { skip: !available }, async () => {
  const first = exitedChild(); let launches = 0;
  const decoder = new StreamingAudioDecoder({ encoding: 'OGG_OPUS', log: {},
    spawnProcess: (...args) => ++launches === 1 ? first : spawn(...args),
  });
  try {
    decoder.start(); decoder.write(OGG_OPUS.subarray(0, thirdPageEnd));
    const heard = timed(once(decoder, 'pcm'));
    first.emit('close', 0, null);
    await heard;
    assert.equal(launches, 2);
    assert.ok(decoder.decodedBytes > 0);
    decoder.write(OGG_OPUS.subarray(thirdPageEnd));
    await timed(decoder.finish());
  } finally { decoder.abort(); }
});

test('startup recovery refuses replay after PCM, EOS, prefix loss or two retries', () => {
  for (const change of [
    decoder => { decoder.decodedBytes = 2; },
    decoder => { decoder.oggSawEos = true; },
    decoder => { decoder.oggPrimerComplete = false; },
    decoder => { decoder.oggStartupRestarts = 2; },
    decoder => { decoder.inputEnded = true; },
  ]) {
    const child = exitedChild();
    const decoder = new StreamingAudioDecoder({ encoding: 'OGG_OPUS', spawnProcess: () => child, log: {} });
    decoder.start(); decoder.write(OGG_OPUS.subarray(0, thirdPageEnd));
    change(decoder); child.emit('close', 0, null);
    assert.equal(decoder.failed, true);
    assert.match(decoder.failureError.message, /ended before|no decodable|without an EOS/);
    decoder.abort();
  }
});
