// Concrete OP_FETCH_ASYNC dead-owner regression. Controlled worker/FS/network
// leaves, real SAB dispatch + Kernel + built SDK. No browser or live guest claim.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
const kernelPath = resolve(process.argv[2] || 'packages/kernel-host/kernel.js');
const sdkPath = resolve(process.argv[3] || 'packages/core/dist/host.js');
const { Kernel } = await import(pathToFileURL(kernelPath));
const { launch } = await import(pathToFileURL(sdkPath));
const p = await import(pathToFileURL(resolve(dirname(kernelPath), '../protocol/syscall.js')));
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };
const turn = () => new Promise(setImmediate);
const drain = async stream => { for await (const _ of stream) {} };
function fixture({ write, unlink } = {}) {
  const workers = new Map(), listeners = new Set(), executions = new Map();
  const files = new Map([['/bin/node.js', new Uint8Array()], ['/fixture.js', new Uint8Array()]]);
  const writes = [], starts = [], deliveries = [];
  const kernel = new Kernel({ fs: {
    exists: path => files.has(path), isFile: path => files.has(path), mkdirp() {},
    async writeLarge(path, bytes) { writes.push(path); files.set(path, bytes.slice()); await write?.(path); },
    async unlink(path) { await unlink?.(path); files.delete(path); },
  }, spawnWorker(info) { workers.set(info.pid, info); return { terminate() {}, postMessage(m) { deliveries.push({ pid: info.pid, m }); } }; }, stdout() {}, stderr() {} });
  kernel.fetchConcurrency = 1;
  const gates = new Map();
  kernel.fetcher = async (url, init) => {
    starts.push({ url, signal: init.signal });
    await gates.get(url)?.promise; // deliberately ignores abort
    return { status: 200, ok: true, headers: {}, body: new Uint8Array([1, 2, 3]) };
  };
  const emit = m => { for (const listener of [...listeners]) listener(m); };
  kernel.onProcExit = (pid, result) => emit({ type: 'proc-exit', execId: executions.get(pid), ...result });
  const host = { nextExecution: 1, async request() { return { exists: true, isDir: false }; },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    post(type, m) {
      if (type === 'proc-spawn') {
        const pid = kernel.launch(m.command, m.args, { cwd: m.cwd, env: m.env }); executions.set(pid, m.execId);
        emit({ type: 'proc-started', execId: m.execId });
      } else if (type === 'proc-kill') kernel.stop([...executions].find(([, id]) => id === m.execId)[0]);
    } };
  const spawn = async () => { const execution = await launch(host, { entry: '/fixture.js' }); const pid = [...executions.keys()].at(-1); return { execution, pid }; };
  function request(pid, id, suffix) {
    const worker = workers.get(pid), { ctrl, data } = p.makeViews(worker.sab);
    const bytes = p.encodeRequest([p.encodeString(JSON.stringify({ fetchId: id, url: 'https://fixture.invalid/' + suffix }))]);
    data.set(bytes); Atomics.store(ctrl, p.I_OPCODE, p.OP_FETCH_ASYNC); Atomics.store(ctrl, p.I_REQ_LEN, bytes.length); Atomics.store(ctrl, p.I_STATE, p.STATE_REQUEST);
    worker.on.syscall(); assert.equal(Atomics.load(ctrl, p.I_STATE), p.STATE_RESPONSE_OK);
  }
  function hold(suffix) { const gate = deferred(); gates.set('https://fixture.invalid/' + suffix, gate); return gate; }
  return { kernel, spawn, request, hold, writes, starts, files, deliveries };
}

// Original schedule: first backend held, second queued, then SDK stop. The
// successful stop must stay pending until the ignored-abort backend really ends.
{
  const f = fixture(), first = f.hold('first'), { execution, pid } = await f.spawn();
  f.request(pid, 1, 'first'); f.request(pid, 2, 'second');
  await turn(); // select the original active=1, queued=1 cohort before stop
  assert.equal(f.kernel.diagnostics().fetch.active, 1);
  assert.equal(f.kernel.diagnostics().fetch.queued, 1);
  let stopped = false;
  const stop = execution.stop().then(() => stopped = true);
  const duplicate = execution.stop();
  await turn();
  assert.equal(f.kernel.procs.size, 0); assert.equal(stopped, false);
  assert.equal(f.starts[0].signal.aborted, true); assert.equal(f.starts.length, 1);
  assert.equal(f.kernel.diagnostics().fetch.queued, 0);
  first.resolve(); await Promise.all([stop, duplicate, drain(execution.stdout), drain(execution.stderr)]);
  assert.equal(f.starts.length, 1); assert.equal(f.writes.length, 0);
  assert.equal(f.kernel.diagnostics().fetch.pinnedBodies, 0);
  assert.equal(f.deliveries.filter(x => x.m.type === 'fetch-done').length, 0);
  console.log('PASS held backend + dead queued owner + duplicate SDK stop');
}

// A natively exited child with outstanding egress is still in its parent's
// owned subtree, even though it no longer appears in the live PID table.
{
  const f = fixture(), gate = f.hold('child');
  const a = await f.spawn(), b = await f.spawn();
  f.kernel.procs.get(b.pid).parentPid = a.pid;
  f.request(b.pid, 1, 'child'); await turn(); f.kernel.finalize(b.pid, 0);
  let settled = false; const stop = a.execution.stop().then(() => settled = true);
  await turn(); assert.equal(settled, false); gate.resolve(); await stop;
  assert.equal(f.writes.length, 0);
  console.log('PASS parent joins natively exited child pending egress');
}

// Shared interests survive both active and queued original-owner death. Stop
// joins this owner's continuation without aborting the remaining live owner.
for (const queued of [false, true]) {
  const f = fixture(), shared = f.hold('shared'), blocker = f.hold('blocker');
  const a = await f.spawn(), b = await f.spawn();
  if (queued) f.request(b.pid, 10, 'blocker');
  f.request(a.pid, 1, 'shared'); f.request(b.pid, 2, 'shared');
  await turn();
  const stop = a.execution.stop(); await turn();
  if (queued) { blocker.resolve(); await turn(); }
  assert.equal(f.starts.find(x => x.url.endsWith('shared')).signal.aborted, false);
  shared.resolve(); await stop; await turn();
  const done = f.deliveries.find(x => x.pid === b.pid && x.m.fetchId === 2);
  assert.ok(done?.m.ok); assert.deepEqual(f.kernel._fetchBodyPins.get(done.m.meta.path), [b.pid]);
  assert.deepEqual([...f.files.get(done.m.meta.path)], [1, 2, 3]);
  // Cache hit has its own pin; eviction must retain both unread live handoffs.
  f.request(b.pid, 3, 'shared'); await turn();
  f.kernel.fetchCacheMaxBytes = 0; f.request(b.pid, 4, 'evict'); await turn();
  assert.ok(f.files.has(done.m.meta.path));
  f.kernel.releaseFetchBody(done.m.meta.path); assert.ok(f.files.has(done.m.meta.path));
  f.kernel.releaseFetchBody(done.m.meta.path); await turn(); assert.equal(f.files.has(done.m.meta.path), false);
  await b.execution.stop();
  console.log(`PASS shared ${queued ? 'queued' : 'active'} + cache hit/eviction reader pins`);
}

// Death during an admitted asynchronous VFS write joins the write and exact-path
// rollback. A failed rollback rejects stop, including every subsequent stop.
for (const fail of [false, true]) {
  const written = deferred(), releaseWrite = deferred(), releaseUnlink = deferred();
  const f = fixture({ write() { written.resolve(); return releaseWrite.promise; },
    async unlink() { await releaseUnlink.promise; if (fail) throw Error('fixture unlink failed'); } });
  const a = await f.spawn(); f.request(a.pid, 1, 'write'); await written.promise;
  let settled = false; const stop = a.execution.stop(); stop.then(() => settled = true, () => settled = true);
  releaseWrite.resolve(); await turn(); assert.equal(settled, false);
  releaseUnlink.resolve();
  if (fail) { await assert.rejects(stop, /fixture unlink failed/); await assert.rejects(a.execution.stop(), /fixture unlink failed/); }
  else { await stop; assert.equal(f.files.has(f.writes[0]), false); }
  assert.equal(f.kernel.diagnostics().fetch.pinnedBodies, 0);
  console.log(`PASS in-progress write rollback ${fail ? 'failure retained' : 'joined'}`);
}
