// One live connection per VFS pathname; all SQL executes in the kernel owner.
// Process workers use the synchronous SAB; commits acknowledge the persistence of
// their own database file (not the whole mirror queue).
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

export async function createSqliteServer(vfs, persistence, initOptions = {}) {
  const sqlite = await sqlite3InitModule(initOptions);
  const { capi, wasm, oo1 } = sqlite;
  const connections = new Map();
  const owners = new Map();
  const failedPaths = new Set();
  // client -> Set of unsettled request promises; client -> { receipt, error }
  // while release() waits for them. A closing client admits no new request.
  const inflight = new Map();
  const closing = new Map();
  let sequence = 0;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const fail = (message) => { throw new Error(message); };
  const encode = value => typeof value === "bigint" ? ["i", String(value)]
    : typeof value === "number" && !Number.isFinite(value) ? ["n", String(value)]
    : value instanceof Uint8Array ? ["b", Array.from(value)] : ["v", value];
  const decode = ([type, value]) => type === "i" ? BigInt(value)
    : type === "n" ? Number(value)
    : type === "b" ? new Uint8Array(value) : value;

  async function persist(c) {
    if (c.ioError) throw c.ioError;
    if (!c.path || !c.db.pointer || !capi.sqlite3_get_autocommit(c.db.pointer)) return;
    try {
      const bytes = capi.sqlite3_js_db_export(c.db.pointer);
      vfs.write_file(c.path, bytes);
      persistence.onWrite(c.path);
      // Only this database's own file: an unrelated path's OPFS error must not
      // poison the connection.
      await persistence.flushPath(c.path);
    } catch (error) {
      c.poisoned = true; c.ioError = error; failedPaths.add(c.path);
      // The exited owner cannot be told: surface it on its release receipt.
      const state = closing.get(c.client);
      if (state) state.error ??= error;
      throw error;
    }
  }
  function close(id) {
    const c = connections.get(id);
    if (!c) return;
    c.db.close();
    connections.delete(id);
    if (c.path) owners.delete(c.path);
  }
  // Closing a database under a request suspended in persist() would resume it on
  // a freed pointer. Wait for the client's in-flight requests, then close. Returns
  // undefined when nothing was in flight (closed synchronously), else a receipt
  // that settles after the close and rejects with a persistence failure it joined.
  function release(client) {
    const state = closing.get(client);
    if (state) return state.receipt;
    const closeAll = () => { for (const [id, c] of connections) if (c.client === client) close(id); };
    const pending = inflight.get(client);
    if (!pending?.size) { closeAll(); return; }
    const closed = { error: null };
    closed.receipt = Promise.allSettled([...pending]).then(() => {
      try { closeAll(); } finally { closing.delete(client); }
      if (closed.error) throw closed.error;
    });
    closing.set(client, closed);
    return closed.receipt;
  }
  // After any await the owner may have exited: never touch a closed connection
  // or continue a dead process's remaining statements.
  function live(id, c) {
    if (connections.get(id) !== c || closing.has(c.client)) fail("SQLITE_MISUSE: connection closed during request");
  }
  function request(client, input) {
    if (closing.has(client)) return Promise.reject(new Error("SQLITE_MISUSE: process is closing"));
    const task = run(client, input);
    let pending = inflight.get(client);
    if (!pending) inflight.set(client, pending = new Set());
    pending.add(task);
    const settle = () => { pending.delete(task); if (!pending.size && inflight.get(client) === pending) inflight.delete(client); };
    task.then(settle, settle);
    return task;
  }

  async function run(client, input) {
    const req = JSON.parse(dec.decode(vfs.read_file(input)));
    const output = input + ".out";
    let result;
    try {
      if (req.method === "open") {
        const path = req.path;
        if (failedPaths.has(path)) fail("SQLITE_IOERR: database requires kernel restart after persistence failure");
        if (path && (!path.startsWith("/") || path.split("/").some(p => p === ".." || p === "."))) fail("SQLITE_CANTOPEN: noncanonical path");
        if (path && owners.has(path)) fail("SQLITE_BUSY: database already has a live connection");
        if (path && !persistence) fail("SQLITE_CANTOPEN: durable persistence unavailable");
        if (path && !persistence.shouldPersist(path)) fail("SQLITE_CANTOPEN: path is excluded from persistence");
        if (path) {
          const parts = path.split("/").filter(Boolean);
          for (let i = 1; i <= parts.length; i++) {
            const p = "/" + parts.slice(0, i).join("/");
            if (!vfs.exists(p)) { if (i !== parts.length) fail("SQLITE_CANTOPEN: missing directory"); continue; }
            const stat = JSON.parse(vfs.lstat(p));
            if (stat.kind === "symlink" || (i === parts.length && (stat.kind !== "file" || stat.nlink > 1))) fail("SQLITE_CANTOPEN: path aliases unsupported");
          }
        }
        const db = new oo1.DB(":memory:", "c");
        const c = { db, client, path, poisoned: false };
        const id = ++sequence;
        try {
          if (path && vfs.exists(path)) {
            const bytes = vfs.read_file(path);
            if (bytes.length) {
              const pointer = wasm.allocFromTypedArray(bytes);
              const rc = capi.sqlite3_deserialize(db.pointer, "main", pointer, BigInt(bytes.length), BigInt(bytes.length), capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
              if (rc) fail(`SQLITE_DESERIALIZE: ${rc}`);
            }
          }
          // Deserialize uses ATTACH internally; install the authorizer afterwards.
          capi.sqlite3_set_authorizer(db.pointer, (_context, action) =>
            action === capi.SQLITE_ATTACH || action === capi.SQLITE_DETACH ? capi.SQLITE_DENY : capi.SQLITE_OK, 0);
          db.exec(`PRAGMA foreign_keys=${req.foreignKeys === false ? "OFF" : "ON"}`);
          connections.set(id, c);
          if (path) owners.set(path, id);
          await persist(c);
          live(id, c);
          result = { id };
        } catch (error) { close(id); if (db.pointer) db.close(); throw error; }
      } else {
        const c = connections.get(req.id);
        if (!c || c.client !== client) fail("SQLITE_MISUSE: connection not owned by process");
        if (req.method === "close") { close(req.id); result = null; }
        else {
          if (c.poisoned) fail("SQLITE_IOERR: connection requires close after persistence failure");
          if (req.method === "serialize") result = { bytes: Array.from(capi.sqlite3_js_db_export(c.db.pointer)) };
          else if (req.method === "prepare") {
            if (typeof req.sql !== "string") fail("SQLITE_MISUSE: SQL must be a string");
            const stmt = c.db.prepare(req.sql);
            try { result = { parameters: stmt.parameterCount }; } finally { stmt.finalize(); }
          }
          else if (req.method === "execute") {
            if (typeof req.sql !== "string") fail("SQLITE_MISUSE: SQL must be a string");
            const args = req.args?.map(decode) ?? [];
            const rows = [];
            const columns = [];
            const collect = stmt => {
              if (!columns.length) stmt.getColumnNames(columns);
              const row = [];
              for (let i = 0; i < stmt.columnCount; i++) {
                row.push(encode(capi.sqlite3_column_type(stmt.pointer, i) === capi.SQLITE_INTEGER
                  ? capi.sqlite3_column_int64(stmt.pointer, i) : stmt.get(i)));
              }
              rows.push(row);
            };
            try {
              if (req.statement) {
                const stmt = c.db.prepare(req.sql);
                try {
                  if (args.length !== stmt.parameterCount) fail("SQLITE_RANGE: incorrect number of parameters");
                  if (args.length) stmt.bind(args);
                  while (stmt.step()) collect(stmt);
                } finally { stmt.finalize(); }
              } else {
                // SQLite finds boundaries, including triggers and quoted semicolons.
                // Persist autocommits before a later BEGIN hides a committed prefix.
                const text = wasm.allocCString(req.sql);
                const pointers = wasm.alloc(wasm.ptrSizeof * 2);
                let cursor = text;
                try {
                  while (wasm.peek(cursor, "i8")) {
                    wasm.pokePtr(pointers, 0);
                    wasm.pokePtr(pointers + wasm.ptrSizeof, 0);
                    const rc = capi.sqlite3_prepare_v3(c.db.pointer, cursor, -1, 0, pointers, pointers + wasm.ptrSizeof);
                    if (rc) fail(capi.sqlite3_errmsg(c.db.pointer));
                    const statement = wasm.peekPtr(pointers);
                    cursor = wasm.peekPtr(pointers + wasm.ptrSizeof);
                    if (!statement) break;
                    const sql = capi.sqlite3_sql(statement);
                    capi.sqlite3_finalize(statement);
                    c.db.exec({ sql, rowMode: "stmt", callback: collect });
                    await persist(c);
                    live(req.id, c);
                  }
                } finally { wasm.dealloc(pointers); wasm.dealloc(text); }
              }
            } finally {
              try { await persist(c); } catch (error) { c.poisoned = true; throw error; }
            }
            live(req.id, c);
            result = { columns, rows, changes: String(capi.sqlite3_changes64(c.db.pointer)),
              lastInsertRowid: String(capi.sqlite3_last_insert_rowid(c.db.pointer)) };
          } else fail("SQLITE_MISUSE: unsupported method");
        }
      }
      // A released client has no reader left for the response file.
      if (!closing.has(client)) vfs.write_file(output, enc.encode(JSON.stringify({ result })));
    } catch (error) {
      if (!closing.has(client)) vfs.write_file(output, enc.encode(JSON.stringify({ error: String(error.message || error) })));
    }
  }
  return { request, release };
}
