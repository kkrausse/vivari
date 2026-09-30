// Headless twin of the browser kernel's local ownership, not an FS worker.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { FsServer } from "../../packages/kernel-host/fs-server.js";
import { createDirectKernelFs } from "../../packages/kernel-host/direct-kernel-fs.js";
import { createSqliteServer } from "../../packages/kernel-host/sqlite-server.js";
import { createDepCache } from "../../packages/kernel-host/dep-cache.js";

const require = createRequire(import.meta.url);
export async function createHeadlessFilesystem() {
  const { VirtualFileSystem } = require("../../packages/vfs/pkg-node/vivari_vfs.js");
  const vfs = new VirtualFileSystem();
  const server = new FsServer(vfs);
  server.sqlite = await createSqliteServer(vfs, null, {
    wasmBinary: readFileSync(require.resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm")),
  });
  const access = {
    read(path) {
      let m;
      try { m = JSON.parse(vfs.lstat(path)); } catch { return null; }
      if (m.kind === "dir") return { kind: "dir", mode: m.mode };
      if (m.kind === "symlink") return { kind: "symlink", mode: m.mode, target: vfs.readlink(path) };
      return { kind: "file", mode: m.mode, bytes: vfs.read_file(path) };
    },
    walk(path) {
      const out = [];
      const visit = path => {
        const m = access.read(path);
        if (!m) return;
        out.push(path);
        if (m.kind === "dir") for (const name of vfs.readdir(path)) visit((path === "/" ? "" : path) + "/" + name);
      };
      visit(path);
      return out;
    },
    mkdirp: path => vfs.mkdir(path, true),
    writeFile: (path, bytes) => vfs.write_file(path, bytes),
    symlink: (target, path) => vfs.symlink(target, path),
  };
  const snapshots = new Map();
  const depCache = await createDepCache({ access, storage: {
    async get(key) { return snapshots.get(key) ?? null; },
    async put(key, value) { snapshots.set(key, value); },
    async delete(key) { snapshots.delete(key); },
  } });
  return { server, fs: createDirectKernelFs(server, depCache) };
}
