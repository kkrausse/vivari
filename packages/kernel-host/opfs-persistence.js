// OPFS write-behind persistence for the Rust/Wasm VFS (Phase 2 — persistence).
//
// The VFS lives entirely in the File System Worker's wasm linear memory, so a
// reload wipes it. This adapter mirrors the VFS to the Origin Private File
// System (OPFS) so a project + its node_modules survive F5.
//
// Why OPFS: it is a real per-origin filesystem with SYNCHRONOUS access handles
// **inside a Worker** (createSyncAccessHandle) — the same primitive SQLite-wasm
// uses — which matches our worker-based, Atomics-blocking VFS far better than
// IndexedDB's async-only API. It draws from the large per-origin storage quota
// (shared with Cache API), so hundreds of MB of node_modules is fine.
//
// Model — WRITE-BEHIND MIRROR (not a backing store):
//   * The Rust VFS stays the source of truth in RAM (reads never touch OPFS →
//     no latency regression).
//   * FsServer forwards every successful *mutation* here (onWrite/onDelete/
//     onRename). We can't await OPFS from the synchronous syscall path, so we
//     only enqueue a dirty path and drain it on an async loop. Durability is
//     therefore eventual (a few ms behind); flush() forces a drain (page hide).
//   * On boot restore() replays a small manifest back into the VFS BEFORE the
//     worker serves any syscall.
//
// Layout under the origin's OPFS:
//   vv-vfs/
//     files/…            one real OPFS file per VFS file (bytes only)
//     manifest.json      [ [path, {k,m,t}], … ] — the index: kind, mode, and
//                        (for symlinks) target. Dirs/symlinks have no `files/`
//                        entry, so the manifest is what recreates them.
//
// `access` is a small vfs-bound facade injected by the File System Worker
// (read/walk/mkdirp/writeFile/symlink); this module never imports the wasm VFS
// directly, so it stays environment-agnostic and headless never loads it.

const ROOT_DIR = "vv-vfs";
const FILES_DIR = "files";
const MANIFEST = "manifest.json";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createOpfsPersistence({ access, shouldPersist = () => true, rootName = ROOT_DIR }) {
  if (!navigator.locks) throw new Error("OPFS ownership requires Web Locks");
  let releaseOwnership = () => {};
  await new Promise((resolve, reject) => {
    navigator.locks.request(rootName === ROOT_DIR ? "vivari-vfs-owner" : `vivari-vfs-owner:${rootName}`, { ifAvailable: true }, lock => {
      if (!lock) { reject(new Error("OPFS already owned by another Vivari kernel")); return; }
      resolve();
      return new Promise(resolve => { releaseOwnership = resolve; });
    }).catch(reject);
  });
  let base, filesBase;
  try {
    const origin = await navigator.storage.getDirectory();
    base = await origin.getDirectoryHandle(rootName, { create: true });
    filesBase = await base.getDirectoryHandle(FILES_DIR, { create: true });
  } catch (error) {
    releaseOwnership();
    throw error;
  }

  // path (VFS absolute) -> { k:'file'|'dir'|'symlink', m:mode, t:target? }
  const meta = new Map();
  // path -> 'w' (write/create) | 'd' (delete) | 'r' (delete subtree, then
  // recreate from the current VFS). Insertion order = drain order. A root
  // removed and recreated before the async drain runs must retain its delete:
  // replacing 'd' with 'w' would leave old descendants in OPFS and the manifest.
  const pending = new Map();
  let draining = false;
  let manifestDirty = false;
  const errors = new Map();
  // The path the drain is writing right now, and resolvers woken after each
  // drained path, so flushPath() can wait for ONE path instead of the queue.
  let active = null;
  let stepWaiters = [];
  // The manifest is the WHOLE index serialized in one go, so its cost is O(paths
  // persisted) — and drain() used to rewrite it every time the queue emptied. When
  // OPFS is fast enough to keep up, the queue empties after almost every write, which
  // makes the total manifest bytes quadratic in the number of paths. Measured on a cold
  // Starlight install: 12,847 rewrites totalling ~2.1 GB, to index ~3,000 paths.
  // Coalescing to at most one rewrite per second collapses that to a handful with no
  // durability change that matters: this is an explicitly write-behind mirror (a few ms
  // to a second behind), file bytes are already on disk before the manifest names them,
  // and flush() on page-hide always forces a final write.
  const MANIFEST_MIN_INTERVAL_MS = 1000;
  let lastManifestWrite = 0;
  let manifestTimer = null;

  const parts = (p) => p.split("/").filter(Boolean);

  // ---- low-level OPFS helpers (all async: handle acquisition is async) -------
  async function dirFor(path, create) {
    let h = filesBase;
    for (const part of parts(path)) h = await h.getDirectoryHandle(part, { create });
    return h;
  }
  async function parentFor(path, create) {
    const ps = parts(path);
    const name = ps.pop();
    let h = filesBase;
    for (const part of ps) h = await h.getDirectoryHandle(part, { create });
    return [h, name];
  }
  async function writeBytes(path, bytes) {
    const [dir, name] = await parentFor(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const stream = await fh.createWritable();
    try {
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      try { await stream.abort(); } catch { /* retain original error */ }
      throw error;
    }
  }
  async function readBytes(path) {
    const [dir, name] = await parentFor(path, false);
    const fh = await dir.getFileHandle(name);
    const ah = await fh.createSyncAccessHandle();
    try {
      const size = ah.getSize();
      const buf = new Uint8Array(size);
      if (size) ah.read(buf, { at: 0 });
      return buf;
    } finally {
      ah.close();
    }
  }
  async function removePath(path) {
    try {
      const [dir, name] = await parentFor(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
    }
  }
  async function writeManifest() {
    const arr = [...meta.entries()];
    const fh = await base.getFileHandle(MANIFEST, { create: true });
    const stream = await fh.createWritable();
    try {
      const bytes = enc.encode(JSON.stringify(arr));
      await stream.write(bytes);
      await stream.close();
    } catch (error) {
      try { await stream.abort(); } catch { /* retain original error */ }
      throw error;
    }
  }

  // ---- the write-behind queue ----------------------------------------------
  function onWrite(path) {
    if (!shouldPersist(path)) return;
    pending.set(path, pending.get(path) === "d" || pending.get(path) === "r" ? "r" : "w");
    kick();
  }
  function onDelete(path) {
    if (!shouldPersist(path)) return;
    // Drop any queued writes under this subtree — they're moot now.
    const pre = path + "/";
    for (const k of [...pending.keys()]) if (k === path || k.startsWith(pre)) pending.delete(k);
    pending.set(path, "d");
    kick();
  }
  function onRename(from, to) {
    // rename already moved the subtree in the VFS. Mirror it as: delete the old
    // path (recursive on disk) + re-enqueue every path now living under `to`.
    if (shouldPersist(from)) onDelete(from);
    if (shouldPersist(to)) for (const p of access.walk(to)) onWrite(p);
  }

  function kick() {
    if (!draining) drain();
  }

  async function drain() {
    draining = true;
    try {
      while (pending.size) {
        const path = pending.keys().next().value;
        const op = pending.get(path);
        pending.delete(path);
        active = path;
        try {
          if (op === "d" || op === "r") {
            await removePath(path);
            meta.delete(path);
            const pre = path + "/";
            for (const k of [...meta.keys()]) if (k.startsWith(pre)) meta.delete(k);
            manifestDirty = true;
          }
          if (op === "w" || op === "r") {
            const e = access.read(path); // current truth from the VFS
            if (!e) continue; // vanished between enqueue and drain
            if (e.kind === "file") await writeBytes(path, e.bytes);
            else if (e.kind === "dir") await dirFor(path, true);
            // symlink: nothing on disk, manifest carries the target
            meta.set(path, { k: e.kind, m: e.mode | 0, t: e.target });
            manifestDirty = true;
          }
          errors.delete(path);
        } catch (error) {
          errors.set(path, error);
        } finally {
          active = null;
          const waiters = stepWaiters;
          stepWaiters = [];
          for (const wake of waiters) wake();
        }
      }
      if (manifestDirty) await maybeWriteManifest(false);
    } finally {
      draining = false;
      if (pending.size) drain(); // work arrived while we were finishing
    }
  }

  // Write the manifest, unless one went out less than MANIFEST_MIN_INTERVAL_MS ago —
  // in which case arm a timer so the index still lands promptly once writes stop.
  // `force` (flush / page-hide) always writes.
  async function maybeWriteManifest(force) {
    if (!manifestDirty) return;
    const since = Date.now() - lastManifestWrite;
    if (!force && since < MANIFEST_MIN_INTERVAL_MS) {
      if (!manifestTimer && typeof setTimeout === "function") {
        manifestTimer = setTimeout(() => {
          manifestTimer = null;
          void maybeWriteManifest(true);
        }, MANIFEST_MIN_INTERVAL_MS - since);
      }
      return;
    }
    if (manifestTimer) {
      clearTimeout(manifestTimer);
      manifestTimer = null;
    }
    // Best-effort: a transient OPFS hiccup here must not escape as an unhandled
    // rejection. Leave manifestDirty set so the next drain retries.
    try {
      await writeManifest();
      manifestDirty = false;
      lastManifestWrite = Date.now();
      errors.delete(MANIFEST);
    } catch (error) {
      errors.set(MANIFEST, error);
    }
  }

  // Force everything queued to hit disk (best-effort; used on page hide).
  async function flush() {
    if (draining) {
      // wait for the in-flight drain to settle, then ensure a final pass
      while (draining) await new Promise((r) => setTimeout(r, 0));
    }
    if (pending.size) await drain();
    // Unconditionally force the manifest: drain() only coalesces it, so a debounced
    // write may still be outstanding even with an empty queue. This is the one place
    // durability is promised, so it must not be skipped.
    await maybeWriteManifest(true);
    if (errors.size) throw new Error("OPFS persistence failed: " + [...errors].map(([p, e]) => `${p}: ${e}`).join("; "));
  }

  // Durability for ONE path (SQLite commits): wait until `path` is neither queued
  // nor being written, force the manifest that indexes it, and fail only on this
  // path's own error or the manifest's. An unrelated path's failure stays in
  // `errors` for flush() but does not fail this caller.
  async function flushPath(path) {
    while (pending.has(path) || active === path) {
      kick();
      await new Promise((resolve) => stepWaiters.push(resolve));
    }
    await maybeWriteManifest(true);
    const error = errors.get(path) ?? errors.get(MANIFEST);
    if (error) throw new Error(`OPFS persistence failed: ${errors.has(path) ? path : MANIFEST}: ${error}`);
  }

  // ---- boot restore --------------------------------------------------------
  // Replay the manifest into the VFS. Returns the number of entries restored (0
  // = nothing persisted yet). Runs BEFORE the FS worker serves any syscall, and
  // calls the VFS directly (via `access`), so it never re-enters the queue.
  async function restore(onProgress) {
    let arr;
    try {
      arr = JSON.parse(dec.decode(await (async () => {
        const fh = await base.getFileHandle(MANIFEST);
        const ah = await fh.createSyncAccessHandle();
        try {
          const size = ah.getSize();
          const buf = new Uint8Array(size);
          if (size) ah.read(buf, { at: 0 });
          return buf;
        } finally {
          ah.close();
        }
      })()));
    } catch (error) {
      if (error.name === "NotFoundError") return 0;
      throw error;
    }
    if (!Array.isArray(arr) || arr.length === 0) return 0;

    // Drop anything `shouldPersist` now rejects. Older builds mirrored
    // node_modules file-by-file; replaying it here is the dominant cold-reopen
    // cost, and it's sourced from the dependency-cache snapshot now. Seeding
    // `meta` with kept paths only also drops the stale entries from the manifest
    // on the next drain (writeManifest serializes `meta`).
    const keep = [];
    const drop = [];
    for (const e of arr) (shouldPersist(e[0]) ? keep : drop).push(e);
    for (const [path, m] of keep) meta.set(path, m);

    // Best-effort: reclaim OPFS space from legacy node_modules blobs that are no
    // longer referenced. Delete each distinct top-level node_modules subtree
    // once, OFF the boot path (non-blocking) so it never delays serving syscalls.
    const pruneRoots = new Set();
    for (const [path] of drop) {
      const i = path.indexOf("/node_modules");
      if (i >= 0) pruneRoots.add(path.slice(0, i + "/node_modules".length));
    }
    if (pruneRoots.size) {
      void (async () => {
        for (const r of pruneRoots) await removePath(r);
        manifestDirty = true;
        try {
          await writeManifest();
          manifestDirty = false;
        } catch {
          /* a later drain will rewrite the manifest */
        }
      })();
    }

    // Recreate in a safe order: dirs (shallow → deep), then files, then symlinks
    // (a symlink's target may live anywhere in the tree).
    const order = { dir: 0, file: 1, symlink: 2 };
    const sorted = [...keep].sort((a, b) => {
      const ka = order[a[1].k] ?? 1;
      const kb = order[b[1].k] ?? 1;
      if (ka !== kb) return ka - kb;
      return parts(a[0]).length - parts(b[0]).length; // shallower first
    });

    const total = sorted.length;
    let n = 0;
    if (typeof onProgress === "function") onProgress(0, total);
    // Sequential replay. An earlier attempt to overlap the per-file OPFS reads
    // with bounded concurrency stalled near the end of a large restore: opening
    // many `createSyncAccessHandle`s at once runs into OPFS's exclusive-lock /
    // handle-count limits and some acquisitions never settle, wedging boot. The
    // durable speed-up for a big node_modules is the lockfile-keyed dependency
    // cache (restore a single snapshot), not parallelizing this per-file loop.
    for (const [path, m] of sorted) {
      try {
        if (m.k === "dir") {
          access.mkdirp(path);
        } else if (m.k === "file") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.writeFile(path, await readBytes(path));
        } else if (m.k === "symlink") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.symlink(m.t, path);
        }
        n++;
        // Report roughly every 5% (min every 200 entries) so a big node_modules
        // restore shows a moving count instead of a long silent stall.
        if (typeof onProgress === "function" && n % Math.max(200, Math.ceil(total / 20)) === 0)
          onProgress(n, total);
      } catch (error) {
        throw new Error(`OPFS restore failed for ${path}: ${error}`);
      }
    }
    if (typeof onProgress === "function") onProgress(n, total);
    return n;
  }

  return { onWrite, onDelete, onRename, flush, flushPath, restore, shouldPersist, releaseOwnership };
}
