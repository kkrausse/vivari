// A bounded bun:ffi facade for explicitly built wasm32 reactors. No native loader.
// ABI declarations belong to the artifact; this module knows no consumer symbols.
const aliases = {
  char: 'i8', int8_t: 'i8', uint8_t: 'u8', int16_t: 'i16', uint16_t: 'u16',
  int32_t: 'i32', int: 'i32', uint32_t: 'u32', int64_t: 'i64', uint64_t: 'u64',
  double: 'f64', float: 'f32', pointer: 'ptr', function: 'ptr', callback: 'ptr',
};
const kinds = ['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f32', 'f64', 'bool', 'ptr', 'void'];
const numericTypes = ['i8', 'i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'f64', 'f32', 'bool', 'ptr', 'void', 'cstring', 'i64_fast', 'u64_fast', 'ptr'];
const fail = message => { throw new Error(`Vivari WASM FFI: ${message}`); };
function type(t = 'void') {
  if (typeof t === 'number') t = numericTypes[t] || t;
  t = aliases[t] || t;
  if (!kinds.includes(t)) fail(`unsupported type ${String(t)}`);
  return t;
}
function signature(def) {
  if (!def || typeof def !== 'object') fail('expected function definition');
  for (const key of Object.keys(def)) {
    if (!['args', 'returns', 'threadsafe', 'ptr'].includes(key)) fail(`unsupported signature option ${key}`);
  }
  if (def.threadsafe || def.ptr != null) fail('threadsafe callbacks and pointer overrides are unsupported');
  const args = (def.args || []).map(type), returns = type(def.returns);
  if (args.includes('void')) fail('void argument');
  return { args, returns };
}
const leb = n => { const a = []; do { const b = n & 127; n >>>= 7; a.push(b | (n ? 128 : 0)); } while (n); return a; };
const section = (id, a) => [id, ...leb(a.length), ...a];
const code = t => t === 'i64' || t === 'u64' ? 126 : t === 'f32' ? 125 : t === 'f64' ? 124 : 127;
// Typed import/export trampoline: the engine checks exported WASM signatures at
// dlopen, and makes ordinary JS functions usable in an indirect function table.
function typedFunction(fn, sig) {
  const bytes = [0,97,115,109,1,0,0,0,
    ...section(1, [1,96,...leb(sig.args.length),...sig.args.map(code), ...(sig.returns === 'void' ? [0] : [1,code(sig.returns)])]),
    ...section(2, [1,1,109,1,102,0,0]),
    ...section(7, [1,1,102,0,0])];
  return new WebAssembly.Instance(new WebAssembly.Module(new Uint8Array(bytes)), { m: { f: fn } }).exports.f;
}
function integer(n, max, label) {
  if (!Number.isSafeInteger(n) || n < 0 || n > max) fail(`invalid ${label}`);
  return n;
}

// Reflection for core WASM function types (the JS Module API omits signatures).
// Parse only typed sections, never code; reject GC/recursive/memory64 profiles.
function exportSignatures(bytes) {
  let at = 8;
  const byte = () => { if (at >= bytes.length) fail('truncated WASM type metadata'); return bytes[at++]; };
  const u32 = () => {
    let n = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const b = byte(); n += (b & 127) * 2 ** shift;
      if (!(b & 128)) return integer(n, 0xffffffff, 'WASM integer');
    }
    fail('invalid WASM integer');
  };
  const name = () => { const n = u32(); const s = new TextDecoder().decode(bytes.subarray(at, at + n)); at += n; return s; };
  const vec = read => Array.from({length: u32()}, read);
  const limits = () => { const flags = byte(); if (flags > 1) fail('unsupported WASM limits'); u32(); if (flags) u32(); };
  const types = [], funcs = [], exports = [];
  while (at < bytes.length) {
    const id = byte(), length = u32(), end = at + length;
    if (end > bytes.length) fail('truncated WASM section');
    if (id === 1) types.push(...vec(() => {
      if (byte() !== 96) fail('unsupported WASM function type');
      return {args: vec(byte), results: vec(byte)};
    }));
    if (id === 2) vec(() => {
      name(); name(); const kind = byte();
      if (kind === 0) funcs.push(u32());
      else if (kind === 1) { byte(); limits(); }
      else if (kind === 2) limits();
      else if (kind === 3) { byte(); byte(); }
      else fail('unsupported WASM import kind');
    });
    if (id === 3) funcs.push(...vec(u32));
    if (id === 7) exports.push(...vec(() => ({name: name(), kind: byte(), index: u32()})));
    if (at > end) fail('invalid WASM section length');
    at = end;
  }
  return Object.fromEntries(exports.filter(e => e.kind === 0).map(e => [e.name, types[funcs[e.index]]]));
}

export function makeWasmFfi({ require }) {
  let active = null;
  // Explicit, opt-in profiling. No arguments, buffer contents or prompts recorded.
  let profiling = false;
  const clock = () => performance.now();
  const current = () => active || fail('no open library (ptr requires an explicit memory owner)');
  const FFIType = Object.fromEntries([...kinds, ...Object.keys(aliases)].map(t => [t, numericTypes.indexOf(type(t))]));
  Object.assign(FFIType, {char: 0, i8: 1, int8_t: 1, function: 17, callback: 17});
  function ptr(value, offset = 0) { return current().pin(value, offset); }
  function toArrayBuffer(pointer, offset = 0, length) {
    return current().mirror(pointer, offset, length);
  }
  const read = {};
  for (const [t, method, size] of [['u8','getUint8',1],['i8','getInt8',1],['u16','getUint16',2],['i16','getInt16',2],['u32','getUint32',4],['i32','getInt32',4],['u64','getBigUint64',8],['i64','getBigInt64',8],['f32','getFloat32',4],['f64','getFloat64',8],['ptr','getUint32',4]]) {
    read[t] = (p, offset = 0) => {
      const lib = current(), at = lib.range(p, offset, size);
      lib.syncIn();
      return new DataView(lib.memory.buffer)[method](at, true);
    };
  }
  class JSCallback {
    constructor(fn, def) {
      if (typeof fn !== 'function') fail('callback must be a function');
      const lib = current(), sig = signature(def);
      if (!(lib.table instanceof WebAssembly.Table)) fail('artifact must export __indirect_function_table for callbacks');
      let index;
      try { index = lib.table.grow(1); }
      catch { fail('callback table cannot grow; build with an imported growable table'); }
      let closed = false;
      const wrapped = typedFunction((...args) => {
        if (closed) fail('callback is closed');
        lib.syncOut();
        try {
          const result = fn(...args.map((v, i) => lib.output(v, sig.args[i])));
          if (result && typeof result.then === 'function') fail('async callbacks are unsupported');
          return lib.input(result, sig.returns);
        } finally { lib.syncIn(); }
      }, sig);
      lib.table.set(index, wrapped);
      this.threadsafe = false;
      Object.defineProperty(this, 'ptr', { get: () => closed ? null : index });
      this.close = () => {
        if (closed) return;
        closed = true;
        lib.table.set(index, null);
        lib.callbacks.delete(this);
      };
      lib.callbacks.add(this);
    }
  }
  function dlopen(path, definitions) {
    if (active) fail('only one open linear-memory library per process is supported');
    const fs = require('fs'), paths = require('path');
    if (path instanceof URL) path = require('url').fileURLToPath(path);
    if (typeof path !== 'string' || !path.endsWith('.ffi.json')) fail('dlopen requires an explicit .ffi.json artifact manifest; native binaries are unsupported');
    const manifest = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (manifest.abi !== 'vivari-wasm32-flat-v1') fail('unsupported artifact ABI');
    if (typeof manifest.wasm !== 'string' || !manifest.wasm.endsWith('.wasm')) fail('manifest requires a WASM asset');
    const sigs = Object.fromEntries(Object.entries(definitions).map(([name, def]) => [name, signature(def)]));
    const bytes = fs.readFileSync(paths.resolve(paths.dirname(path), manifest.wasm));
    const module = new WebAssembly.Module(bytes);
    const actual = exportSignatures(bytes);
    const { WASI } = require('wasi');
    const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: { '/': '/' } });
    const imports = { wasi_snapshot_preview1: wasi.wasiImport };
    if (manifest.tableInitial !== undefined) {
      integer(manifest.tableInitial, 65536, 'initial table size');
      imports.env = { __indirect_function_table: new WebAssembly.Table({element: 'anyfunc', initial: manifest.tableInitial}) };
    }
    const instance = new WebAssembly.Instance(module, imports);
    const e = instance.exports;
    if (!(e.memory instanceof WebAssembly.Memory) || typeof e.ffi_alloc !== 'function' || typeof e.ffi_free !== 'function') fail('artifact requires memory, ffi_alloc(u32)->ptr and ffi_free(ptr,u32)');
    if (!(e.memory.buffer instanceof ArrayBuffer)) fail('shared linear memory is unsupported');
    const alloc = typedFunction(e.ffi_alloc, { args: ['u32'], returns: 'ptr' });
    const free = typedFunction(e.ffi_free, { args: ['ptr','u32'], returns: 'void' });
    const functions = {};
    for (const [name, sig] of Object.entries(sigs)) {
      if (typeof e[name] !== 'function') fail(`missing export ${name}`);
      try {
        const want = sig.args.map(code), got = actual[name];
        if (!got || got.args.length !== want.length || got.args.some((t, i) => t !== want[i])) throw Error('argument ABI differs from artifact');
        // Native FFI permits a void declaration to discard a scalar return. WASM
        // imports require exact signatures, so make that discard explicit here.
        if (sig.returns === 'void' && got.results.length === 1 && [127,126,125,124].includes(got.results[0])) {
          functions[name] = (...args) => { e[name](...args); };
        } else functions[name] = typedFunction(e[name], sig);
      }
      catch (error) { fail(`signature mismatch for ${name} (${sig.args.join(',')})->${sig.returns}: ${error.message}`); }
    }
    wasi.initialize(instance);
    const pins = new Map(), owners = new WeakMap();
    let pinnedBytes = 0;
    let metrics;
    const resetMetrics = () => { metrics = { calls: 0, syncInMs: 0, syncOutMs: 0, syncInBytes: 0, syncOutBytes: 0, nativeMs: 0, allocations: 0, allocatedBytes: 0, symbols: {} }; };
    resetMetrics();
    let closed = false, depth = 0;
    const lib = {
      memory: e.memory, table: e.__indirect_function_table || imports.env?.__indirect_function_table, callbacks: new Set(),
      stats: () => ({ profiling, pins: pins.size, pinnedBytes, wasmBytes: e.memory.buffer.byteLength, ...JSON.parse(JSON.stringify(metrics)) }),
      resetMetrics,
      mirror(p, offset, length) {
        const at = lib.range(p, offset, length);
        if (!length) fail('empty external buffer');
        for (const record of pins.values()) {
          if (at === record.p && length === record.bytes.byteLength) return record.bytes.buffer;
          if (at < record.p + record.bytes.byteLength && record.p < at + length) fail('overlapping external ArrayBuffer aliases are unsupported');
        }
        if (pinnedBytes + length > 64 * 1024 * 1024) fail('process pin budget exceeds 64 MiB');
        const bytes = new Uint8Array(e.memory.buffer, at, length).slice();
        const record = {p: at, bytes, borrowed: true, baseline: bytes.slice()};
        pins.set(at, record); owners.set(bytes.buffer, record); pinnedBytes += length;
        return bytes.buffer;
      },
      range(p, offset, length) {
        if (closed) fail('library is closed');
        integer(p, 0xffffffff, 'pointer'); integer(offset, 0xffffffff, 'offset'); integer(length, 0xffffffff, 'length');
        if (!p || p + offset + length > e.memory.buffer.byteLength) fail('memory range is outside linear memory');
        return p + offset;
      },
      pin(value, offset = 0) {
        if (closed) fail('library is closed');
        const view = ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? new Uint8Array(value) : fail('ptr expects ArrayBuffer or view');
        if (!(view.buffer instanceof ArrayBuffer)) fail('shared pointer buffers are unsupported');
        integer(offset, view.byteLength, 'buffer offset');
        if (!view.byteLength || offset === view.byteLength) fail('empty pointer range');
        if (view.buffer === e.memory.buffer) return view.byteOffset + offset;
        // Pin the whole backing buffer, preserving overlapping view aliasing.
        let record = owners.get(view.buffer);
        if (!record) {
          const bytes = new Uint8Array(view.buffer);
          if (pinnedBytes + bytes.byteLength > 64 * 1024 * 1024) fail('process pin budget exceeds 64 MiB');
          const p = alloc(bytes.byteLength) >>> 0;
          if (!p) fail('allocation failed');
          lib.range(p, 0, bytes.byteLength);
          record = { p, bytes };
          pinnedBytes += bytes.byteLength;
          if (profiling) { metrics.allocations++; metrics.allocatedBytes += bytes.byteLength; }
          owners.set(view.buffer, record); pins.set(p, record);
        }
        return record.p + view.byteOffset + offset;
      },
      syncIn() {
        const start = profiling ? clock() : 0;
        for (const {p, bytes, borrowed, baseline} of pins.values()) {
          if (!bytes.byteLength) fail('pinned buffer was detached');
          const memory = new Uint8Array(e.memory.buffer, p, bytes.byteLength);
          // An unchanged native-owned mirror is never an instruction to write.
          // Native code may have freed/reused its allocation since the last call.
          if (borrowed) {
            for (let i = 0; i < bytes.length; i++) if (bytes[i] !== baseline[i]) memory[i] = bytes[i];
            baseline.set(bytes);
          } else memory.set(bytes);
        }
        if (profiling) { metrics.syncInMs += clock() - start; metrics.syncInBytes += pinnedBytes; }
      },
      syncOut() {
        const start = profiling ? clock() : 0;
        for (const {p, bytes, baseline} of pins.values()) {
          bytes.set(new Uint8Array(e.memory.buffer, p, bytes.byteLength));
          baseline?.set(bytes);
        }
        if (profiling) { metrics.syncOutMs += clock() - start; metrics.syncOutBytes += pinnedBytes; }
      },
      input(v, t) {
        if (t === 'void') return undefined;
        if (t === 'ptr') return v == null ? 0 : typeof v === 'number' ? integer(v, 0xffffffff, 'pointer') : lib.pin(v);
        if (t === 'i64' || t === 'u64') {
          if (typeof v !== 'bigint') fail(`${t} requires bigint`);
          return t === 'i64' ? BigInt.asIntN(64, v) : BigInt.asUintN(64, v);
        }
        if (t === 'bool') return v ? 1 : 0;
        if (typeof v !== 'number') fail(`${t} requires number`);
        if (t === 'i8') return v << 24 >> 24;
        if (t === 'u8') return v & 255;
        if (t === 'i16') return v << 16 >> 16;
        if (t === 'u16') return v & 65535;
        return v;
      },
      output(v, t) { return t === 'bool' ? !!v : t === 'ptr' ? (v >>> 0) || null : t === 'u32' ? v >>> 0 : t === 'u64' ? BigInt.asUintN(64, v) : v; },
    };
    const symbols = Object.fromEntries(Object.entries(functions).map(([name, fn]) => [name, (...args) => {
      if (closed) fail('library is closed');
      const sig = sigs[name];
      if (args.length !== sig.args.length) fail(`${name} expects ${sig.args.length} arguments`);
      const input = args.map((v, i) => lib.input(v, sig.args[i]));
      if (profiling) {
        const start = clock();
        lib.syncIn(); depth++;
        const nativeStart = clock();
        let nativeMs;
        try { return lib.output(fn(...input), sig.returns); }
        finally {
          nativeMs = clock() - nativeStart;
          depth--; lib.syncOut();
          const row = metrics.symbols[name] ||= { calls: 0, totalMs: 0, nativeMs: 0 };
          row.calls++; row.totalMs += clock() - start; row.nativeMs += nativeMs;
          metrics.calls++; metrics.nativeMs += nativeMs;
        }
      }
      lib.syncIn(); depth++;
      try { return lib.output(fn(...input), sig.returns); }
      finally { depth--; lib.syncOut(); }
    }]));
    active = lib;
    return { symbols, close() {
      if (closed) return;
      if (depth) fail('cannot close library during a call');
      for (const cb of [...lib.callbacks]) cb.close();
      for (const {p, bytes, borrowed} of pins.values()) if (!borrowed) free(p, bytes.byteLength);
      pins.clear(); closed = true; active = null;
    } };
  }
  return { dlopen, ptr, toArrayBuffer, JSCallback, FFIType, read, suffix: 'wasm',
    vivariStats: () => active?.stats() ?? null,
    vivariProfile(enabled = true) { profiling = !!enabled; active?.resetMetrics(); },
    CString: class CString { constructor() { fail('CString is unsupported'); } },
    linkSymbols() { fail('linkSymbols is unsupported'); },
    cc() { fail('runtime C compilation is unsupported'); },
  };
}

// Experimental Node FFI's scalar/pointer API, sharing exactly the same memory
// owner as bun:ffi. This is needed by consumers which detect Node via versions.
export function makeNodeWasmFfi(bun) {
  const pointer = p => {
    if (typeof p !== 'bigint' || p < 0n || p > 0xffffffffn) fail('Node pointer must be a wasm32-range bigint');
    return Number(p);
  };
  function sig(def) {
    for (const key of Object.keys(def)) if (!['arguments','return'].includes(key)) fail(`unsupported Node signature option ${key}`);
    return signature({args: def.arguments, returns: def.return});
  }
  const incoming = (v, t) => t === 'ptr' && typeof v === 'bigint' ? pointer(v) : v;
  const outgoing = (v, t) => t === 'ptr' ? BigInt(v || 0) : v;
  return {
    suffix: bun.suffix,
    getRawPointer(buffer) {
      if (!(buffer instanceof ArrayBuffer)) fail('getRawPointer expects ArrayBuffer');
      return BigInt(bun.ptr(buffer));
    },
    toArrayBuffer(p, length, copy = false) {
      const buffer = bun.toArrayBuffer(pointer(p), 0, length);
      return copy ? buffer.slice(0) : buffer;
    },
    dlopen(path, definitions) {
      const sigs = Object.fromEntries(Object.entries(definitions).map(([name, def]) => [name, sig(def)]));
      const library = bun.dlopen(path, sigs), callbacks = new Map();
      let closed = false;
      return {
        functions: Object.fromEntries(Object.entries(library.symbols).map(([name, fn]) => [name, (...args) => outgoing(fn(...args.map((v, i) => incoming(v, sigs[name].args[i]))), sigs[name].returns)])),
        lib: {
          registerCallback(def, callback) {
            if (closed) fail('library is closed');
            const s = sig(def);
            const cb = new bun.JSCallback((...args) => incoming(callback(...args.map((v, i) => outgoing(v, s.args[i]))), s.returns), s);
            const p = BigInt(cb.ptr); callbacks.set(p, cb); return p;
          },
          unregisterCallback(p) {
            pointer(p);
            const cb = callbacks.get(p);
            if (!cb) fail('unknown callback');
            cb.close(); callbacks.delete(p);
          },
          close() { if (!closed) { library.close(); closed = true; callbacks.clear(); } },
        },
      };
    },
  };
}
