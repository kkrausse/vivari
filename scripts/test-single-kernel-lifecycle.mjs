// Close-path regressions against the real Kernel, FsServer, SQLite server and
// Rust VFS. Process workers and OPFS are controlled leaves: requests are driven
// straight into the PID's SAB; persistence is either a gated fixture or the real
// write-behind module over an in-memory OPFS/Web Locks twin. Nothing here
// qualifies Chrome Web Locks, real OPFS or worker target destruction.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { FsServer } from "../packages/kernel-host/fs-server.js";
import { createDirectKernelFs } from "../packages/kernel-host/direct-kernel-fs.js";
import { createSqliteServer } from "../packages/kernel-host/sqlite-server.js";
import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";
import * as p from "../packages/protocol/syscall.js";

const require = createRequire(import.meta.url);
const { VirtualFileSystem } = require("../packages/vfs/pkg-node/vivari_vfs.js");
const wasmBinary = readFileSync(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"));
const deadline = setTimeout(() => { console.error("FAIL: lifecycle deadline"); process.exit(1); }, 20000);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(setImmediate);
const dec = new TextDecoder(), enc = new TextEncoder();

// In-memory twin of the OPFS directory/file handle surface the mirror uses.
// `fails(name)` makes writing that file reject, like a name or quota OPFS refuses.
function memoryOpfs(fails = () => false) {
  const missing = () => Object.assign(new Error("not found"), { name: "NotFoundError" });
  const directory = () => {
    const entries = new Map();
    return { entries,
      async getDirectoryHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw missing(); entries.set(name, directory()); }
        return entries.get(name);
      },
      async getFileHandle(name, { create } = {}) {
        if (!entries.has(name)) { if (!create) throw missing(); entries.set(name, { bytes: new Uint8Array(), writes: 0 }); }
        const file = entries.get(name);
        return { async createWritable() {
          let staged;
          return { async write(bytes) { if (fails(name)) throw new Error("write refused"); staged = bytes.slice(); },
            async close() { file.bytes = staged; file.writes++; }, async abort() {} };
        } };
      },
      async removeEntry(name) { if (!entries.delete(name)) throw missing(); },
    };
  };
  return directory();
}
// Web Locks twin: FIFO exclusive locks with ifAvailable and AbortSignal.
function memoryLocks() {
  const held = new Set(), queues = new Map();
  const grant = name => {
    const next = queues.get(name)?.shift();
    if (!next) return;
    held.add(name);
    next.signal?.removeEventListener("abort", next.abort);
    Promise.resolve().then(() => next.callback({ name })).then(next.resolve, next.reject)
      .finally(() => { held.delete(name); grant(name); });
  };
  return { held, queues, request(name, options, callback) {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(options.signal.reason); return; }
      if (options.ifAvailable && held.has(name)) { Promise.resolve(callback(null)).then(resolve, reject); return; }
      const entry = { callback, resolve, reject, signal: options.signal };
      entry.abort = () => { const queue = queues.get(name); queue.splice(queue.indexOf(entry), 1); reject(options.signal.reason); };
      options.signal?.addEventListener("abort", entry.abort, { once: true });
      if (!queues.has(name)) queues.set(name, []);
      queues.get(name).push(entry);
      if (!held.has(name)) grant(name);
    });
  } };
}
const vfsAccess = vfs => ({
  read(path) {
    let m;
    try { m = JSON.parse(vfs.lstat(path)); } catch { return null; }
    return m.kind === "dir" ? { kind: "dir", mode: m.mode } : { kind: "file", mode: m.mode, bytes: vfs.read_file(path) };
  },
  walk: path => [path], mkdirp: path => vfs.mkdir(path, true), writeFile: (path, bytes) => vfs.write_file(path, bytes), symlink() {},
});
const browser = { locks: memoryLocks(), storage: null };
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: browser });

async function fixture(persistence, vfs = new VirtualFileSystem()) {
  for (const dir of ["/bin", "/tmp", "/data"]) vfs.mkdir(dir, true);
  vfs.write_file("/bin/node.js", new Uint8Array());
  const server = new FsServer(vfs, persistence);
  server.sqlite = await createSqliteServer(vfs, persistence, { wasmBinary });
  const workers = new Map(), exits = new Map();
  const kernel = new Kernel({ fs: createDirectKernelFs(server), stdout() {}, stderr() {}, spawnWorker(info) {
    workers.set(info.pid, info);
    server.register(info.pid, info.sab);
    return { terminate: () => server.unregister(info.pid), postMessage() {} };
  } });
  kernel.onProcExit = (pid, result) => exits.set(pid, result);
  let sequence = 0;
  const spawn = () => kernel.launch("/bin/node.js", ["/fixture.js"], { cwd: "/" });
  // One guest SQLite exchange: request file, OP_SQLITE in the PID's own SAB.
  function send(pid, req) {
    const input = `/tmp/vv-sqlite-${pid}-${++sequence}`, { ctrl, data } = p.makeViews(workers.get(pid).sab);
    vfs.write_file(input, enc.encode(JSON.stringify(req)));
    const bytes = p.encodeRequest([p.encodeString(input)]);
    data.set(bytes); Atomics.store(ctrl, p.I_OPCODE, p.OP_SQLITE); Atomics.store(ctrl, p.I_REQ_LEN, bytes.length); Atomics.store(ctrl, p.I_STATE, p.STATE_REQUEST);
    server.service(pid);
    return { input, ctrl, state: () => Atomics.load(ctrl, p.I_STATE),
      read() { const response = JSON.parse(dec.decode(vfs.read_file(input + ".out"))); if (response.error) throw new Error(response.error); return response.result; } };
  }
  async function call(pid, req) {
    const sent = send(pid, req);
    while (sent.state() === p.STATE_REQUEST) await turn();
    assert.equal(sent.state(), p.STATE_RESPONSE_OK);
    return sent.read();
  }
  return { vfs, server, kernel, exits, spawn, send, call };
}

// A PID exits while its SQLite request is suspended in persist(). The database
// must stay open until that request settles, and the exit receipt must wait.
for (const failure of [null, new Error("OPFS write failed")]) {
  let gate = null, flushes = 0;
  const f = await fixture({ shouldPersist: () => true, onWrite() {}, onDelete() {}, onRename() {},
    async flushPath(path) { assert.equal(path, "/data/app.db"); flushes++; await gate?.promise; } });
  const pid = f.spawn();
  const { id } = await f.call(pid, { method: "open", path: "/data/app.db" });
  gate = deferred();
  const before = flushes;
  const sent = f.send(pid, { method: "execute", id, sql: "CREATE TABLE t(v); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)" });
  await turn();
  assert.equal(flushes, before + 1, "request is suspended in its first persistence wait");
  assert.equal(sent.state(), p.STATE_REQUEST);
  const receipt = f.kernel.stop(pid);
  assert.equal(typeof receipt?.then, "function", "exit receipt joins the in-flight SQLite request");
  void receipt.catch(() => {});
  assert.equal(f.kernel.procs.size, 0);
  assert.equal(f.server.clients.size, 0);
  await assert.rejects(f.server.sqlite.request(pid, sent.input), /process is closing/, "closing client admits no new request");
  await turn();
  assert.equal(f.exits.has(pid), false, "exit receipt waits for the OPFS write");
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  if (failure) gate.reject(failure); else gate.resolve();
  gate = null;
  if (failure) await assert.rejects(receipt, error => error === failure);
  else await receipt;
  await turn();
  process.off("unhandledRejection", onUnhandled);
  assert.deepEqual(unhandled, []);
  assert.equal(f.exits.get(pid).cleanupError, failure ? failure.message : undefined);
  assert.equal(sent.state(), p.STATE_REQUEST, "no reply is written into the dead PID's SAB");
  assert.equal(f.vfs.exists(sent.input + ".out"), false, "no response file for a dead reader");
  if (!failure) {
    // Ownership was released only after the request settled; the dead PID's
    // remaining statements did not run on a closed (or any) connection.
    const other = f.spawn();
    const reopened = await f.call(other, { method: "open", path: "/data/app.db" });
    const rows = await f.call(other, { method: "execute", id: reopened.id, sql: "SELECT count(*) FROM t", statement: true });
    assert.deepEqual(rows.rows, [[["i", "0"]]]);
    await f.call(other, { method: "close", id: reopened.id });
    assert.equal(f.kernel.stop(other), undefined, "idle PID still finalizes synchronously");
    assert.equal(f.exits.has(other), true);
  }
  console.log(`PASS PID exit joins SQLite request suspended in persist (${failure ? "persistence failure reported as cleanup error" : "no closed-DB use, no dead reply"})`);
}

// One path OPFS refuses used to fail the global flush every SQLite commit awaited,
// poisoning every database for the kernel's lifetime.
{
  const root = memoryOpfs(name => name === "refused.txt" || name === "refused.db");
  browser.storage = { getDirectory: async () => root };
  const vfs = new VirtualFileSystem();
  const persistence = await createOpfsPersistence({ access: vfsAccess(vfs), rootName: "lifecycle-poison" });
  const f = await fixture(persistence, vfs);
  vfs.write_file("/data/refused.txt", enc.encode("x"));
  persistence.onWrite("/data/refused.txt");
  await assert.rejects(persistence.flush(), /refused\.txt: Error: write refused/, "global flush still reports every failed path");
  const pid = f.spawn();
  const { id } = await f.call(pid, { method: "open", path: "/data/app.db" });
  await f.call(pid, { method: "execute", id, sql: "CREATE TABLE t(v); INSERT INTO t VALUES (7)" });
  const rows = await f.call(pid, { method: "execute", id, sql: "SELECT v FROM t", statement: true });
  assert.deepEqual(rows.rows, [[["i", "7"]]], "unrelated path error does not poison the connection");
  const stored = (await (await (await root.getDirectoryHandle("lifecycle-poison")).getDirectoryHandle("files")).getDirectoryHandle("data")).entries;
  assert.deepEqual(stored.get("app.db").bytes, vfs.read_file("/data/app.db"), "acknowledged commit is in the mirror");
  assert.match(dec.decode((await root.getDirectoryHandle("lifecycle-poison")).entries.get("manifest.json").bytes), /\/data\/app\.db/);
  await assert.rejects(persistence.flush(), /refused\.txt/, "the unrelated error is still visible to global flush");
  // The database's own path failing still fails (and poisons) that database only.
  await assert.rejects(f.call(pid, { method: "open", path: "/data/refused.db" }), /refused\.db: Error: write refused/);
  await f.call(pid, { method: "execute", id, sql: "INSERT INTO t VALUES (8)" });
  await f.call(pid, { method: "close", id });
  f.kernel.stop(pid);
  persistence.releaseOwnership();
  console.log("PASS unrelated OPFS path error does not poison SQLite; own-path error still fails; global flush unchanged");
}

clearTimeout(deadline);
process.exit(0);
