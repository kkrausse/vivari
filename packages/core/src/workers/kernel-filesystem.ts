// @ts-nocheck — authored in TS for Vite's native worker bundling, but not strictly
// type-checked: it imports the generated wasm VFS + untyped kernel-host JS. esbuild
// (via Vite) is the compiler; strict typing is a separate, larger effort.
// Kernel-owned VFS and persistence. This is a module, never a worker entry.
// Guests ring FsServer's MessagePorts while parked on their own SAB. Kernel
// housekeeping uses a direct facade and can never wait for itself. OPFS restore
// and SQLite initialization complete before this factory exposes the service.

import initKernel, { VirtualFileSystem } from "../../../vfs/pkg/vivari_vfs.js";
import { FsServer } from "../../../kernel-host/fs-server.js";
import { createOpfsPersistence } from "../../../kernel-host/opfs-persistence.js";
import { createDepCache } from "../../../kernel-host/dep-cache.js";
import { createSqliteServer } from "../../../kernel-host/sqlite-server.js";
import { installTree, installTreeImage } from "../../../kernel-host/install-tree.js";

import { createDirectKernelFs } from "../../../kernel-host/direct-kernel-fs.js";
import { initializeKernelBackends } from "../../../kernel-host/kernel-backends.js";

export async function createKernelFilesystem({ emit, compression = true }) {
const post = (type, extra) => emit({ type, ...extra });

let server = null;
let vfsRef = null; // the live VFS, set as soon as it's constructed (pre-restore)
let depCache = null; // lockfile-keyed node_modules snapshot cache (P1)
let accessRef = null; // the vfs-bound facade, shared by persistence + dep cache
let compressionOn = compression;
let persistenceState = { status: "opening" };

// Apply the current compression gate to the VFS. Guarded so an older wasm build
// without set_compression simply ignores the flag instead of throwing.
function applyCompression() {
  if (vfsRef && typeof vfsRef.set_compression === "function") {
    try {
      vfsRef.set_compression(compressionOn);
    } catch {
      /* older build — no-op */
    }
  }
}

function handle(msg) {
  switch (msg.type) {
    case "workspace-install-tree":
      installTree(server, msg).then(
        result => post("vv-reply", { reqId: msg.reqId, ok: true, ...result }),
        error => post("vv-reply", { reqId: msg.reqId, ok: false, error: String(error?.message || error) }),
      );
      break;
    case "workspace-install-tree-image":
      installTreeImage(server, msg).then(
        result => post("vv-reply", { reqId: msg.reqId, ok: true, ...result }),
        error => post("vv-reply", { reqId: msg.reqId, ok: false, error: String(error?.message || error) }),
      );
      break;
    case "workspace-read":
      try { post("vv-reply", { reqId: msg.reqId, ok: true, bytes: server.vfs.read_file(msg.path) }); }
      catch (error) { post("vv-reply", { reqId: msg.reqId, ok: false, error: String(error?.message || error) }); }
      break;
    case "workspace-flush":
      (async () => {
        try {
          if (!server.persistence) throw new Error(persistenceState.error || "OPFS is unavailable");
          await server.persistence.flush();
          post("vv-reply", { reqId: msg.reqId, ok: true });
        } catch (error) {
          persistenceState = { status: "failed", error: String(error?.message || error) };
          post("workspace-persistence", persistenceState);
          post("vv-reply", { reqId: msg.reqId, ok: false, error: persistenceState.error });
        }
      })();
      break;
    case "workspace-persistence":
      post("vv-reply", { reqId: msg.reqId, ok: true, persistence: persistenceState });
      break;
    case "fs-flush": // page is hiding — best-effort force the mirror to disk
      if (server && server.persistence) server.persistence.flush().catch(error => post("log", { line: String(error) }));
      break;
    case "fs-set-compression":
      compressionOn = !!msg.on;
      applyCompression();
      break;
  }
}


// A small vfs-bound facade the OPFS adapter uses to read current state and to
// replay a restore. Keeps the adapter free of any wasm-VFS dependency.
function buildAccess(vfs) {
  return {
    // Current truth for one path (following nothing: lstat, so symlinks report
    // as symlinks). Returns null if the path is gone.
    read(path) {
      let m;
      try {
        m = JSON.parse(vfs.lstat(path));
      } catch {
        return null;
      }
      if (m.kind === "dir") return { kind: "dir", mode: m.mode };
      if (m.kind === "symlink") return { kind: "symlink", mode: m.mode, target: vfs.readlink(path) };
      return { kind: "file", mode: m.mode, bytes: vfs.read_file(path) };
    },
    // Every path under `path` (inclusive), used to re-mirror a renamed subtree.
    walk(path) {
      const out = [];
      const rec = (p) => {
        let m;
        try {
          m = JSON.parse(vfs.lstat(p));
        } catch {
          return;
        }
        out.push(p);
        if (m.kind === "dir") {
          let kids = [];
          try {
            kids = vfs.readdir(p);
          } catch {
            /* not a dir anymore */
          }
          for (const k of kids) rec(p === "/" ? "/" + k : p + "/" + k);
        }
      };
      rec(path);
      return out;
    },
    mkdirp(path) {
      try {
        vfs.mkdir(path, true);
      } catch {
        /* exists */
      }
    },
    writeFile(path, bytes) {
      vfs.write_file(path, bytes);
    },
    symlink(target, path) {
      try {
        vfs.symlink(target, path);
      } catch {
        /* exists */
      }
    },
  };
}

// System/volatile dirs we never persist: coreutils are re-installed each boot,
// and /tmp, /proc, /dev are ephemeral by definition. Everything else (your
// /app, node_modules, /data, the package-manager caches under /home/user/.cache,
// …) is mirrored.
// /etc and /usr are re-seeded by the VFS constructor every boot (os-release, ldd),
// so persisting them is redundant and would let a stale copy shadow a changed seed.
// /var/cache holds the kernel's transient outbound-fetch buffer (vv-fetch): its
// in-memory index is rebuilt per session and never read back across reloads, so
// persisting those tarball bodies is pure dead weight — the durable, reusable copy
// is npm/yarn/pnpm's own content-addressed cache under /home/user/.cache.
const IGNORE = ["/bin", "/tmp", "/proc", "/dev", "/etc", "/usr", "/var/cache", "/var/run/vv-spawn"];

// Volatile paths INSIDE an otherwise-persisted package-manager cache. The cache
// itself is deliberately durable (see npm_config_cache in kernel-worker) — these
// two shapes are not, and mirroring them dominated the whole install:
//
//   _logs/…      npm appends to its debug log on every log line. Every append
//                re-enqueues the path, and drain() rewrites the file IN FULL each
//                time, so a log that grows to ~1.5 MB gets rewritten thousands of
//                times. Measured on a cold Starlight install: 3,800 enqueues of
//                one log file, and that single file accounted for essentially all
//                of the ~2.7 GB of mirrored file bytes. It is a diagnostic that
//                nothing reads back across reloads.
//   …/tmp/…      cacache (and yarn) write content to a staging file and then
//                rename it into place, so every one of these is written to OPFS
//                and deleted moments later. Pure waste: 820 renames on the same
//                install. The renamed-to path IS persisted, so nothing is lost.
//
// Kept deliberately narrow: only under a `.cache` directory, so a user's own
// `_logs/` or `tmp/` in their project is still mirrored.
const isVolatileCachePath = (p) => {
  if (!p.includes("/.cache/")) return false;
  return p.includes("/_logs/") || p.endsWith("/_logs") || p.includes("/tmp/") || p.endsWith("/tmp");
};

const shouldPersist = (p) => {
  // node_modules is NOT mirrored file-by-file: it's large (thousands of files),
  // which made the per-file OPFS restore the dominant cold-reopen cost. Instead
  // it's persisted as a single lockfile-keyed snapshot by the dependency cache
  // (dep-cache.js) and restored in one pass on project open/run. Excluding it
  // here also turns dep-cache.restore()'s per-path mirror callback into a no-op,
  // so a restored node_modules isn't re-mirrored (no double storage).
  if (p.endsWith("/node_modules") || p.includes("/node_modules/")) return false;
  for (const pre of IGNORE) if (p === pre || p.startsWith(pre + "/")) return false;
  if (isVolatileCachePath(p)) return false;
  return true;
};

// OPFS-backed blob store for the dependency cache (P1). Snapshots live under a
// SEPARATE origin dir (vv-depcache/) from the VFS mirror (vv-vfs/), one flat
// file per key (the key is percent-encoded so it's a safe filename). Sync access
// handles are available here (a Worker), the same primitive the VFS mirror uses.
async function createOpfsDepStorage() {
  const origin = await navigator.storage.getDirectory();
  const base = await origin.getDirectoryHandle("vv-depcache", { create: true });
  const nameFor = (key) => encodeURIComponent(key);
  return {
    async get(key) {
      try {
        const fh = await base.getFileHandle(nameFor(key));
        const ah = await fh.createSyncAccessHandle();
        try {
          const size = ah.getSize();
          const buf = new Uint8Array(size);
          if (size) ah.read(buf, { at: 0 });
          return buf;
        } finally {
          ah.close();
        }
      } catch {
        return null; // absent
      }
    },
    async put(key, bytes) {
      const fh = await base.getFileHandle(nameFor(key), { create: true });
      const ah = await fh.createSyncAccessHandle();
      try {
        ah.truncate(0);
        if (bytes && bytes.length) ah.write(bytes, { at: 0 });
        ah.flush();
      } finally {
        ah.close();
      }
    },
    async delete(key) {
      try {
        await base.removeEntry(nameFor(key));
      } catch {
        /* already gone */
      }
    },
  };
}

  // Pass the wasm URL explicitly instead of relying on the glue's default
  // `new URL('..._bg.wasm', import.meta.url)`. When this worker is bundled the
  // glue is inlined here, so its default would resolve next to the bundle
  // and 404. The sibling-dir "../../../vfs/pkg/" form is correct both in the
  // Vite dev server and in the studio build.
  post("log", { line: "  [boot] initializing virtual file system…", cls: "muted" });
  await initKernel(new URL("../../../vfs/pkg/vivari_vfs_bg.wasm", import.meta.url));
  const vfs = new VirtualFileSystem();
  // Honor a compression flag that may have arrived before the VFS existed, so it
  // is in force before the OPFS restore below.
  vfsRef = vfs;
  applyCompression();

  // Best-effort OPFS persistence. If the API is missing or throws (private
  // mode, quota, older engine), we run exactly like before — purely in RAM.
  let persistence = null;
  accessRef = buildAccess(vfs);
  try {
    if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.getDirectory) {
      persistence = await createOpfsPersistence({ access: accessRef, shouldPersist });
      // Restoring a saved project (esp. its node_modules) can take a while — the
      // VFS is re-hydrated entry-by-entry. Report progress so the user knows the
      // "stall" is real work, not a hang. Only chatter when there's a lot to do.
      const t0 = Date.now();
      let announced = false;
      const n = await persistence.restore((done, total) => {
        // Structured progress for the host UI (relayed by the kernel worker as
        // `boot-progress`). Always emitted — even for small projects — so a
        // progress bar can fill and settle instead of never appearing.
        post("boot-progress", { phase: "restore", done, total });
        if (total < 400) return; // small project: restore is instant, stay quiet
        if (!announced) {
          post("log", { line: `  [opfs] restoring saved project (${total} entries)…`, cls: "muted" });
          announced = true;
        } else if (done && done < total) {
          post("log", { line: `  [opfs] restoring… ${done}/${total}`, cls: "muted" });
        }
      });
      persistenceState = { status: "durable" };
      if (n > 0)
        post("log", {
          line: `  [opfs] restored ${n} entries from a previous session (${Date.now() - t0}ms)`,
          cls: "muted",
        });
    }
  } catch (err) {
    persistence?.releaseOwnership();
    post("log", { line: "  [opfs] persistence unavailable: " + (err?.message || err), cls: "muted" });
    persistenceState = { status: "failed", error: String(err?.message || err) };
    persistence = null;
  }

  // Durable snapshots share the VFS owner lock. Never open shared cache storage
  // after ownership refusal or a restore failure that released that lock.
  const backends = await initializeKernelBackends(persistence, {
    async openDepCache() {
      const storage = await createOpfsDepStorage();
      const cache = await createDepCache({ access: accessRef, storage });
      post("log", { line: "  [depcache] ready", cls: "muted" });
      return cache;
    },
    openSqlite: () => createSqliteServer(vfs, persistence),
    onDepCacheError: err => post("log", { line: "  [depcache] unavailable: " + (err?.message || err), cls: "muted" }),
  });
  depCache = backends.depCache;

  server = new FsServer(vfs, persistence);
  server.sqlite = backends.sqlite;
  server.onMutation = (path) => post("vv-fs-changed", { path });
  if (persistenceState.status === "opening") persistenceState = { status: "ephemeral", reason: "OPFS unavailable" };
  post("workspace-persistence", persistenceState);
  // Tell the kernel when a fetched response body has been fully read, so it can
  // drop its reference and reclaim the scratch file. These bodies live in Wasm
  // memory that never shrinks, so holding them past their single read is a direct
  // cost to peak residency — and the kernel cannot see the read, which happens
  // here over the SAB.
  server.onBodyConsumed = (path) => post("fetch-body-consumed", { path });
  const fs = createDirectKernelFs(server, depCache);
  return { server, fs, handle };
}
