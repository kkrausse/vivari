const assert = require('node:assert/strict');
const http = require('node:http');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const total = 32 * 1024 * 1024;
let produced = 0, drained = 0, disconnected = false;
const server = http.createServer((req, res) => {
  res.on('error', () => {});
  res.on('close', () => { disconnected = true; });
  const chunk = Buffer.alloc(65536, 173);
  function pump() {
    while (produced < total) {
      produced += chunk.length;
      if (!res.write(chunk)) { res.once('drain', () => { drained++; pump(); }); return; }
    }
    res.end();
  }
  pump();
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const response = await new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, resolve);
    req.on('error', reject);
  });
  await delay(150);
  assert.ok(produced < total, `slow reader did not stop producer: ${produced}`);
  let received = 0;
  for await (const chunk of response) {
    received += chunk.length;
    assert.ok(chunk.every(byte => byte === 173), 'binary corruption');
  }
  assert.equal(received, total);
  assert.ok(drained > 0, 'no drain events');
  produced = 0; disconnected = false;
  const aborted = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, agent: false }, resolve).on('error', reject);
  });
  await delay(50);
  aborted.destroy();
  for (let i = 0; i < 100 && !disconnected; i++) await delay(10);
  assert.ok(disconnected, 'cancel did not close server response');
  await new Promise(resolve => server.close(resolve));
  console.log('NET_BACKPRESSURE_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
