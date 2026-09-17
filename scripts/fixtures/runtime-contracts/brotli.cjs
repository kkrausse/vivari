// Fixed native-Node Brotli vectors: this same contract runs natively and in workers.
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Writable } = require('node:stream');

async function decodeStream(input, options = {}) {
  const chunks = [];
  await pipeline(
    Readable.from(Array.from(input, byte => Buffer.from([byte]))),
    zlib.createBrotliDecompress({ chunkSize: 64, ...options }),
    new Writable({ write(chunk, encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
  );
  return Buffer.concat(chunks);
}

(async () => {
  const vectors = [
    ['Ow==', ''],
    ['CwmAaGVsbG8gQnJvdGxpIOS4lueVjAM=', 'hello Brotli 世界'],
    ['W//hhF8eHENt1vDjwRhA1WwCQGJR88jq2Xs=', '0123456789abcdef'.repeat(20000)],
  ];
  for (const [base64, text] of vectors) {
    const input = Buffer.from(base64, 'base64');
    const expected = Buffer.from(text);
    for (const chunkSize of [64, 16384]) {
      const result = zlib.brotliDecompressSync(input, { chunkSize, info: true });
      assert.deepEqual(result.buffer, expected);
      assert.equal(result.engine.bytesWritten, input.length);
    }
    assert.deepEqual(await new Promise((resolve, reject) => {
      zlib.brotliDecompress(input, { chunkSize: 64 }, (err, result) => err ? reject(err) : resolve(result));
    }), expected);
    assert.deepEqual(await decodeStream(input), expected);
    assert.deepEqual(zlib.brotliDecompressSync(Buffer.concat([input, Buffer.from('trailing')])), expected);
  }
  const bad = Buffer.from([255, 255, 255, 255]);
  const invalid = { code: 'ERR__ERROR_FORMAT_PADDING_2', errno: -15 };
  const truncated = { code: 'Z_BUF_ERROR', errno: -5 };
  for (const [input, error] of [[bad, invalid], [Buffer.alloc(0), truncated],
    [Buffer.from(vectors[2][0], 'base64').subarray(0, -1), truncated]]) {
    assert.throws(() => zlib.brotliDecompressSync(input), error);
    await assert.rejects(new Promise((resolve, reject) => {
      zlib.brotliDecompress(input, (err, result) => err ? reject(err) : resolve(result));
    }), error);
    await assert.rejects(decodeStream(input), error);
  }
  assert.throws(() => zlib.brotliDecompressSync(Buffer.from(vectors[2][0], 'base64'),
    { maxOutputLength: 100 }), { code: 'ERR_BUFFER_TOO_LARGE' });
  const reset = zlib.createBrotliDecompress();
  const resetChunks = [];
  reset.on('data', chunk => resetChunks.push(chunk));
  await new Promise((resolve, reject) => reset.write(Buffer.from([0x0b]), err => err ? reject(err) : resolve()));
  reset.reset();
  await new Promise((resolve, reject) => {
    reset.once('error', reject);
    reset.once('end', resolve);
    reset.end(Buffer.from(vectors[1][0], 'base64'));
  });
  assert.equal(Buffer.concat(resetChunks).toString(), vectors[1][1]);
  console.log('BROTLI_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
