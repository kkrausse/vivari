// Real Web Streams and MessagePorts, public createEndpoint; transport only is a
// fixture. Not a kernel/OPFS/browser teardown or live TODO JSON regression.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier.endsWith('.js') && context.parentURL?.includes('/host-sdk/')) {
    const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(ts)) return next(ts.href, context);
  }
  return next(specifier, context);
} });
const { createEndpoint } = await import(process.argv[2] ? pathToFileURL(process.argv[2]).href : '../packages/core/src/host-sdk/index.ts');
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return {promise, resolve}; };
const turn = () => new Promise(resolve => setImmediate(resolve));
globalThis.location = new URL('http://fixture.invalid/');
try {
  for (const mode of ['abort-held', 'unlisten-held', 'cancel-reject', 'response-cancel', 'normal-eof', 'upload-read-reject', 'response-overflow']) {
    const gate = deferred(), started = deferred(), reading = deferred();
    let cancels = 0, sourceClosed = false, notify;
    const body = new ReadableStream({
      pull(controller) {
        reading.resolve();
        if (mode === 'upload-read-reject') controller.error(Error('source read rejected'));
        if (mode === 'normal-eof') controller.close();
      },
      async cancel() { cancels++; started.resolve(); await gate.promise; if (mode === 'cancel-reject') throw Error('source cancel rejected'); sourceClosed = true; },
    });
    const peers = [];
    const host = { listeners: new Map([[5173, 'fixture']]), on(fn) { notify = fn; return () => {}; }, post(type, _, ports) {
      assert.equal(type, 'workspace-http-stream');
      const peer = ports[0]; peers.push(peer);
      peer.onmessage = ({data}) => {
        if (data.op === 'upload-end' && mode === 'normal-eof') { peer.postMessage({op:'headers',status:200,headers:[]}); peer.postMessage({op:'end'}); }
        if (data.op === 'pull') peer.postMessage({op:'data',bytes: new Uint8Array(mode === 'response-overflow' ? 65537 : 1)});
      };
      peer.start(); peer.postMessage({op:'upload-credit'});
      if (mode === 'response-cancel' || mode === 'response-overflow') peer.postMessage({op:'headers',status:200,headers:[]});
    } };
    const lifetime = new AbortController();
    const endpoint = createEndpoint(host, 5173, 'fixture', lifetime.signal);
    let joined = false;
    const receipt = endpoint.settled.then(() => { joined = true; });
    void receipt.catch(() => {});
    const request = endpoint.fetch('/', {method:'POST',body,duplex:'half'});
    void request.catch(() => {});
    try {
      await reading.promise;
      if (mode === 'normal-eof') { assert.equal(await (await request).text(), ''); endpoint.dispose(); await receipt; }
      else {
        let cancelled;
        if (mode === 'response-cancel' || mode === 'response-overflow') {
          const reader = (await request).body.getReader();
          if (mode === 'response-overflow') await assert.rejects(reader.read(), /Invalid HTTP/);
          else { await reader.read(); cancelled = reader.cancel(); void cancelled.catch(() => {}); }
        }
        if (mode === 'unlisten-held') { host.listeners.delete(5173); notify({type:'unlisten',listenerId:'fixture'}); await endpoint.closed; assert.equal(joined,false); }
        endpoint.dispose(); endpoint.dispose(); lifetime.abort();
        await endpoint.closed;
        if (!['response-cancel','response-overflow'].includes(mode)) await assert.rejects(request);
        if (mode !== 'upload-read-reject') await started.promise;
        await turn(); assert.equal(joined,false, `${mode}: cleanup cannot overtake held cancellation`);
        gate.resolve();
        if (mode === 'cancel-reject' || mode === 'upload-read-reject') await assert.rejects(receipt, /Endpoint cleanup failed/);
        else { await receipt; assert.equal(sourceClosed,true); }
        if (cancelled) await cancelled;
      }
      assert.equal(cancels, mode === 'normal-eof' || mode === 'upload-read-reject' ? 0 : 1);
      console.log(`PASS ${mode}: public endpoint cleanup receipt`);
    } finally { gate.resolve(); endpoint.dispose(); for (const peer of peers) peer.close(); }
  }
} finally { delete globalThis.location; hooks.deregister(); }
