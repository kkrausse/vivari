// Thin synchronous facades over the shared FS-worker SQLite WASM backend.
export function createSqlite({ fs, path, process, syscalls, Buffer }) {
  let sequence = 0;
  function exchange(req) {
    const input = `/tmp/vv-sqlite-${process.pid}-${++sequence}`;
    try {
      fs.writeFileSync(input, JSON.stringify(req));
      syscalls.sqlite(input);
      const response = JSON.parse(fs.readFileSync(input + ".out", "utf8"));
      if (response.error) throw new Error(response.error);
      return response.result;
    } finally {
      for (const file of [input, input + ".out"]) if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
  function encode(v) {
    if (typeof v === "bigint") {
      if (v < -(1n << 63n) || v >= 1n << 63n) throw new RangeError("SQLite integer out of range");
      return ["i", String(v)];
    }
    if (v instanceof Uint8Array) return ["b", Array.from(v)];
    if (typeof v === "number" && !Number.isFinite(v)) return ["n", String(v)];
    if (v === null || typeof v === "string" || typeof v === "number") return ["v", v];
    throw new TypeError("Unsupported SQLite parameter type");
  }
  function integer(value, big) {
    const n = BigInt(value);
    if (big) return n;
    const num = Number(n);
    if (!Number.isSafeInteger(num)) throw new RangeError("SQLite integer requires BigInt reads");
    return num;
  }
  class Statement {
    constructor(db, sql) {
      this.db = db; this.sql = sql; this.big = false; this.arrays = false;
      db.request({ method: "prepare", sql });
    }
    setReadBigInts(value) { this.big = !!value; }
    setReturnArrays(value) { this.arrays = !!value; }
    safeIntegers(value = true) { this.big = !!value; return this; }
    execute(args) { return this.db.request({ method: "execute", statement: true, sql: this.sql, args: args.map(encode) }); }
    rows(result, arrays) {
      return result.rows.map(row => {
        const values = row.map(([type, value]) => type === "i" ? integer(value, this.big)
          : type === "b" ? Buffer.from(value) : value);
        for (let i = 0; i < row.length; i++) if (row[i][0] === "n") values[i] = Number(row[i][1]);
        return arrays ? values : Object.assign(Object.create(null), Object.fromEntries(result.columns.map((key, i) => [key, values[i]])));
      });
    }
    all(...args) { return this.rows(this.execute(args), this.arrays); }
    values(...args) { return this.rows(this.execute(args), true); }
    get(...args) { return this.all(...args)[0]; }
    run(...args) {
      const r = this.execute(args);
      return { changes: integer(r.changes, this.big), lastInsertRowid: integer(r.lastInsertRowid, this.big) };
    }
    finalize() { this.db = null; }
  }
  class DatabaseSync {
    constructor(filename = ":memory:", options = {}) {
      if (typeof filename !== "string") throw new TypeError("SQLite filename must be a string");
      for (const key of Object.keys(options)) {
        if (options[key] === undefined || (key === "open" && options[key] === true)
          || (key === "readOnly" && options[key] === false) || (key === "timeout" && options[key] === 0)
          || (key === "allowExtension" && options[key] === false)) continue;
        if (key !== "enableForeignKeyConstraints") throw new Error(`Unsupported SQLite option: ${key}`);
      }
      this.id = exchange({ method: "open", path: filename === ":memory:" ? null : path.resolve(process.cwd(), filename), foreignKeys: options.enableForeignKeyConstraints }).id;
    }
    request(req) {
      if (!this.id) throw new Error("SQLite database is closed");
      return exchange({ ...req, id: this.id });
    }
    prepare(sql) { return new Statement(this, sql); }
    exec(sql) { this.request({ method: "execute", sql }); }
    close() { if (this.id) { this.request({ method: "close" }); this.id = null; } }
    loadExtension() { throw new Error("SQLite native extensions are unsupported"); }
    [Symbol.dispose]() { this.close(); }
  }
  class Database extends DatabaseSync {
    constructor(filename = ":memory:", options = {}) {
      for (const [key, value] of Object.entries(options)) {
        if (value === undefined || (key === "readonly" && value === false)
          || (["readwrite", "create"].includes(key) && value === true)) continue;
        throw new Error(`Unsupported bun:sqlite option: ${key}`);
      }
      super(filename);
    }
    query(sql) { return this.prepare(sql); }
    run(sql, ...args) { return this.prepare(sql).run(...args); }
    serialize() { return Buffer.from(this.request({ method: "serialize" }).bytes); }
  }
  return { node: { DatabaseSync }, bun: { Database, default: Database } };
}
