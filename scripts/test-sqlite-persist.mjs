// SQLite persistence rule against the real SQLite server, Rust VFS and
// write-behind mirror, over an in-memory OPFS/Web Locks twin. Two failure modes
// are guarded: a change that is acknowledged but not in the mirror (durability),
// and a read that rewrites the whole image (the cost this rule removes). Real
// OPFS and Chrome are not qualified here.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createSqliteServer } from "../packages/kernel-host/sqlite-server.js";
import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";

const require = createRequire(import.meta.url);
const { VirtualFileSystem } = require("../packages/vfs/pkg-node/vivari_vfs.js");
const wasmBinary = readFileSync(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm"));
const deadline = setTimeout(() => { console.error("FAIL: sqlite persist deadline"); process.exit(1); }, 30000);
const dec = new TextDecoder(), enc = new TextEncoder();

// OPFS twin: directories, writable streams (the drain) and sync access handles
// (the restore). `writes` counts completed rewrites of one file.
function memoryOpfs() {
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
        return {
          async createWritable() {
            let staged;
            return { async write(bytes) { staged = bytes.slice(); }, async close() { file.bytes = staged; file.writes++; }, async abort() {} };
          },
          async createSyncAccessHandle() {
            return { getSize: () => file.bytes.length, read(buffer) { buffer.set(file.bytes); }, close() {} };
          },
        };
      },
      async removeEntry(name) { if (!entries.delete(name)) throw missing(); },
    };
  };
  return directory();
}
function memoryLocks() {
  const held = new Set(), queues = new Map();
  const grant = name => {
    const next = queues.get(name)?.shift();
    if (!next) return;
    held.add(name);
    Promise.resolve().then(() => next.callback({ name })).then(next.resolve, next.reject).finally(() => { held.delete(name); grant(name); });
  };
  return { request(name, options, callback) {
    return new Promise((resolve, reject) => {
      if (!queues.has(name)) queues.set(name, []);
      queues.get(name).push({ callback, resolve, reject });
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
  walk: path => [path], mkdirp: path => { try { vfs.mkdir(path, true); } catch { /* exists */ } },
  writeFile: (path, bytes) => vfs.write_file(path, bytes), symlink() {},
});
const browser = { locks: memoryLocks(), storage: null };
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: browser });

const DB = "/data/app.db";
let roots = 0;
// One "kernel": a fresh VFS restored from `root`, the mirror and the SQLite server.
// `compression` matches the browser kernel, which turns VFS compression on.
async function boot(root, rootName) {
  browser.storage = { getDirectory: async () => root };
  const vfs = new VirtualFileSystem();
  vfs.set_compression(true);
  const persistence = await createOpfsPersistence({ access: vfsAccess(vfs), rootName });
  await persistence.restore();
  for (const dir of ["/tmp", "/data"]) try { vfs.mkdir(dir, true); } catch { /* restored */ }
  const sqlite = await createSqliteServer(vfs, persistence, { wasmBinary });
  let sequence = 0;
  async function call(req) {
    const input = `/tmp/vv-sqlite-1-${++sequence}`;
    vfs.write_file(input, enc.encode(JSON.stringify(req)));
    await sqlite.request(1, input);
    const response = JSON.parse(dec.decode(vfs.read_file(input + ".out")));
    for (const file of [input, input + ".out"]) vfs.unlink(file); // as the guest does
    if (response.error) throw new Error(response.error);
    return response.result;
  }
  const stored = async () => (await (await (await root.getDirectoryHandle(rootName)).getDirectoryHandle("files")).getDirectoryHandle("data")).entries.get("app.db");
  // The invariant: outside a transaction, the mirror holds exactly the live database.
  async function durable(id, context) {
    const live = Uint8Array.from((await call({ method: "serialize", id })).bytes);
    const file = await stored();
    assert.deepEqual(Buffer.from(file.bytes).equals(Buffer.from(live)), true, `mirror differs from the live database after: ${context}`);
    assert.deepEqual(Buffer.from(vfs.read_file(DB)).equals(Buffer.from(live)), true, `VFS file differs from the live database after: ${context}`);
  }
  const shutdown = async () => { await sqlite.release(1); await persistence.flush(); persistence.releaseOwnership(); await new Promise(setImmediate); };
  return { vfs, call, stored, durable, shutdown };
}
const newRoot = () => ({ root: memoryOpfs(), name: `sqlite-persist-${++roots}` });
const exec = (k, id, sql) => k.call({ method: "execute", id, sql });
const run = (k, id, sql, args = []) => k.call({ method: "execute", id, sql, statement: true, args: args.map(v => ["v", v]) });
const count = async (k, id) => Number((await run(k, id, "SELECT count(*) FROM t")).rows[0][0][1]);

// 1. Every statement kind, through both request shapes, on a new database and on
//    one reloaded from the mirror: the mirror equals the live database whenever
//    the connection is back in autocommit. `tx` marks statements after which a
//    transaction is open (no persist is due, and none is checked); `refused`
//    marks one the server rejects, which must leave the invariant intact.
const battery = [
  ["CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT UNIQUE)"], ["INSERT INTO t(b) VALUES ('one')"], ["SELECT * FROM t"],
  ["PRAGMA journal_mode = WAL"], ["PRAGMA synchronous = NORMAL"], ["PRAGMA busy_timeout = 5000"], ["PRAGMA cache_size = -2000"],
  ["PRAGMA wal_checkpoint(PASSIVE)"], ["PRAGMA foreign_keys = ON"], ["PRAGMA user_version = 7"], ["PRAGMA user_version"],
  ["PRAGMA application_id = 99"], ["CREATE TABLE IF NOT EXISTS t(a INTEGER PRIMARY KEY, b TEXT UNIQUE)"], ["CREATE TABLE u(x)"],
  ["UPDATE t SET b = 'none' WHERE a = 999"], ["UPDATE t SET b = 'uno' WHERE a = 1"], ["CREATE INDEX i ON u(x)"], ["INSERT INTO u VALUES (1), (2), (3)"],
  ["ANALYZE"], ["REINDEX"], ["DELETE FROM u WHERE x = 2"], ["PRAGMA auto_vacuum = 1"], ["PRAGMA page_size = 8192"],
  // VACUUM attaches a scratch database, which this server's authorizer denies.
  ["VACUUM", "refused"],
  ["CREATE TRIGGER g AFTER INSERT ON u BEGIN INSERT INTO t(b) VALUES ('from trigger ' || new.x); END"], ["INSERT INTO u VALUES (10)"],
  ["BEGIN", "tx"], ["INSERT INTO t(b) VALUES ('in transaction')", "tx"], ["SELECT * FROM t", "tx"], ["COMMIT"],
  ["BEGIN IMMEDIATE", "tx"], ["INSERT INTO t(b) VALUES ('rolled back')", "tx"], ["ROLLBACK"],
  ["SAVEPOINT s", "tx"], ["INSERT INTO t(b) VALUES ('savepoint')", "tx"], ["RELEASE s"],
  ["BEGIN", "tx"], ["SELECT * FROM t", "tx"], ["COMMIT"],
  ["DROP INDEX i"], ["PRAGMA optimize"], ["PRAGMA incremental_vacuum"], ["PRAGMA integrity_check"], ["ALTER TABLE u ADD COLUMN y"],
  ["DROP TABLE u"], ["PRAGMA journal_mode = DELETE"], ["INSERT INTO t(b) VALUES ('last')"],
];
for (const shape of ["exec", "statement"]) {
  for (const reloaded of [false, true]) {
    const { root, name } = newRoot();
    let k = await boot(root, name);
    let { id } = await k.call({ method: "open", path: DB });
    if (reloaded) {
      await exec(k, id, "CREATE TABLE seed(v); INSERT INTO seed VALUES (1)");
      await k.shutdown();
      k = await boot(root, name);
      ({ id } = await k.call({ method: "open", path: DB }));
    }
    await k.durable(id, "open");
    for (const [sql, mark] of battery) {
      const request = shape === "exec" ? exec(k, id, sql) : run(k, id, sql);
      if (mark === "refused") await assert.rejects(request, /SQLITE_AUTH/); else await request;
      if (mark !== "tx") await k.durable(id, `${sql} (${shape}, ${reloaded ? "reloaded" : "new"} database)`);
    }
    assert.equal(await count(k, id), 5);
    await k.shutdown();
  }
}
console.log(`PASS mirror equals the live database after each of ${battery.length} statement kinds (exec and prepared, new and reloaded database)`);

// 2. What does and does not rewrite the image.
{
  const { root, name } = newRoot();
  let k = await boot(root, name);
  let { id } = await k.call({ method: "open", path: DB });
  const writes = async () => (await k.stored()).writes;
  const expect = async (delta, label, action) => {
    const before = await writes();
    await action();
    assert.equal(await writes() - before, delta, label);
  };
  assert.equal(await writes(), 1, "opening a new database creates its file once");
  await expect(1, "a one-statement exec persists once, not twice", () => exec(k, id, "CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT UNIQUE);"));
  await expect(1, "a prepared write persists once", () => run(k, id, "INSERT INTO t(b) VALUES (?)", ["one"]));
  await expect(0, "prepare does not persist", () => k.call({ method: "prepare", id, sql: "SELECT * FROM t" }));
  await expect(0, "a prepared read does not persist", () => run(k, id, "SELECT * FROM t WHERE b = ?", ["one"]));
  await expect(0, "an exec read does not persist", () => exec(k, id, "SELECT * FROM t; SELECT count(*) FROM t"));
  await expect(0, "connection PRAGMAs do not persist", () => exec(k, id, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA cache_size = -2000; PRAGMA foreign_keys = ON; PRAGMA wal_checkpoint(PASSIVE)"));
  await expect(0, "CREATE TABLE IF NOT EXISTS on an existing table does not persist", () => run(k, id, "CREATE TABLE IF NOT EXISTS t(a INTEGER PRIMARY KEY, b TEXT UNIQUE)"));
  await expect(1, "PRAGMA user_version = N persists", () => run(k, id, "PRAGMA user_version = 3"));
  await expect(1, "DDL persists", () => run(k, id, "CREATE INDEX ib ON t(b)"));
  await expect(2, "each autocommit statement of an exec persists, with no extra one at the end", () => exec(k, id, "INSERT INTO t(b) VALUES ('two'); INSERT INTO t(b) VALUES ('three')"));
  await expect(0, "statements inside a transaction do not persist", async () => { await exec(k, id, "BEGIN"); await run(k, id, "INSERT INTO t(b) VALUES ('four')"); await run(k, id, "SELECT * FROM t"); });
  await expect(1, "COMMIT persists the transaction once", () => exec(k, id, "COMMIT"));
  await expect(0, "a rolled-back transaction does not persist", () => exec(k, id, "BEGIN; INSERT INTO t(b) VALUES ('gone'); ROLLBACK"));
  await expect(0, "a read-only transaction does not persist", () => exec(k, id, "BEGIN; SELECT * FROM t; COMMIT"));
  assert.equal(await count(k, id), 4);
  await k.durable(id, "the persist-count sequence");

  // A statement that fails after changing data: OR FAIL keeps the rows written
  // before the conflict and autocommit commits them. They must be in the mirror.
  await expect(1, "rows committed by a failing statement are persisted", () =>
    assert.rejects(run(k, id, "INSERT OR FAIL INTO t(b) VALUES ('five'), ('one'), ('never')"), /UNIQUE/));
  assert.equal(await count(k, id), 5);
  await k.durable(id, "a failing INSERT OR FAIL");
  await expect(0, "a statement that fails without changing data does not persist", () =>
    assert.rejects(run(k, id, "INSERT INTO t(b) VALUES ('one')"), /UNIQUE/));

  // A committed prefix must reach the mirror before a later BEGIN in the same
  // exec leaves the connection inside a transaction.
  await expect(1, "the committed prefix of an exec that ends inside a transaction is persisted", () =>
    exec(k, id, "INSERT INTO t(b) VALUES ('prefix'); BEGIN; INSERT INTO t(b) VALUES ('uncommitted')"));
  const acknowledged = Uint8Array.from((await k.stored()).bytes);
  // The database is the only body of 4 KiB or more in this VFS, and it is mostly
  // empty pages: held compressed, physical bytes would be well under logical.
  const raw = vfs => vfs.mem_bytes() === vfs.logical_mem_bytes();
  assert.equal(raw(k.vfs), true, "a persisted image is held raw in the VFS, not zlib-compressed on every commit");

  // The kernel goes away with that transaction still open (its connection is
  // closed uncommitted). A new kernel restores the mirror.
  k = await (async () => { await k.shutdown(); return boot(root, name); })();
  assert.equal(raw(k.vfs), false, "the boot restore still compresses the image like any other file");
  ({ id } = await k.call({ method: "open", path: DB }));
  assert.equal((await k.stored()).bytes.length, acknowledged.length);
  assert.deepEqual((await run(k, id, "SELECT b FROM t ORDER BY a")).rows.map(row => row[0][1]), ["one", "two", "three", "four", "five", "prefix"],
    "every acknowledged autocommit change survives a restart; the uncommitted one does not");
  assert.deepEqual((await run(k, id, "PRAGMA user_version")).rows, [[["i", "3"]]]);
  const before = (await k.stored()).writes;
  await run(k, id, "SELECT * FROM t");
  assert.equal((await k.stored()).writes, before, "opening and reading an existing database rewrites nothing");
  assert.equal(raw(k.vfs), false, "a compressed body is opened and read in place");
  await run(k, id, "INSERT INTO t(b) VALUES ('after restart')");
  assert.equal((await k.stored()).writes, before + 1);
  assert.equal(raw(k.vfs), true, "the first write replaces a compressed body with a raw one");
  await k.durable(id, "a write after restart");
  await k.shutdown();
  console.log("PASS reads, prepares, connection PRAGMAs, no-op DDL and rollbacks rewrite nothing; each committed change is persisted once and survives a restart");
}

clearTimeout(deadline);
process.exit(0);
