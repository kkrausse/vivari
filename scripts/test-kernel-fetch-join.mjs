// Local native adapter regression: abort propagation must not detach body reads
// or a sibling alias request. Controlled fetch leaves; no network/browser.
import assert from 'node:assert/strict';
import { doFetch } from '../packages/core/src/workers/kernel-fetch.ts';
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const turn = () => new Promise(setImmediate);
const originalFetch = globalThis.fetch, originalSelf = globalThis.self;
globalThis.self = { location: { origin: 'https://fixture.invalid', hostname: 'fixture.invalid' } };
try {
  const body = deferred(), reading = deferred(), controller = new AbortController();
  globalThis.fetch = async (_url, opts) => {
    assert.equal(opts.signal, controller.signal);
    return { ok: true, status: 200, headers: new Headers(), async arrayBuffer() { reading.resolve(); await body.promise; return new Uint8Array([3]).buffer; } };
  };
  let settled = false; const work = doFetch('https://fixture.invalid/body', { signal: controller.signal });
  work.then(() => settled = true); await reading.promise; controller.abort(); await turn();
  assert.equal(settled, false); body.resolve(); assert.deepEqual([...new Uint8Array((await work).body)], [3]);
  console.log('PASS actual adapter propagates signal and joins ignored-abort body');

  const sibling = deferred(), siblingRead = deferred(), abort = new AbortController();
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url); assert.equal(opts.signal, abort.signal);
    return { ok: true, status: 200, headers: new Headers(), async arrayBuffer() {
      if (url.endsWith('/bcrypt')) throw Error('source body failed');
      siblingRead.resolve(); await sibling.promise; return new TextEncoder().encode('{}').buffer;
    } };
  };
  settled = false;
  const alias = doFetch('https://registry.npmjs.org/bcrypt', { signal: abort.signal });
  alias.then(() => settled = true, () => settled = true);
  await siblingRead.promise; abort.abort(); await turn(); assert.equal(settled, false);
  sibling.resolve(); await assert.rejects(alias, { name: 'AbortError' });
  assert.equal(calls.length, 2, 'aborted alias does not launch fallback');
  console.log('PASS remap sibling native body joined before failure; no aborted fallback');
} finally { globalThis.fetch = originalFetch; globalThis.self = originalSelf; }
