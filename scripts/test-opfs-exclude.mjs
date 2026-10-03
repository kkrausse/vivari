// Roots installed with `persist: false` leave the OPFS mirror, and nothing else
// does. Real VFS, FsServer, install-tree and write-behind mirror over an
// in-memory OPFS/Web Locks twin; real OPFS and Chrome are not qualified here.
// Guards the one thing this exclusion could cost: a path that lives only in the
// mirror (workspace source, server state, the module-plan cache) being dropped.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { FsServer } from "../packages/kernel-host/fs-server.js";
import { installTree } from "../packages/kernel-host/install-tree.js";
import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";

const { VirtualFileSystem } = createRequire(import.meta.url)("../packages/vfs/pkg-node/vivari_vfs.js");
const enc = new TextEncoder(), dec = new TextDecoder();
const sha = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");

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
        if (!entries.has(name)) { if (!create) throw missing(); entries.set(name, { bytes: new Uint8Array() }); }
        const file = entries.get(name);
        return {
          async createWritable() { let staged; return { async write(bytes) { staged = bytes.slice(); }, async close() { file.bytes = staged; }, async abort() {} }; },
          async createSyncAccessHandle() { return { getSize: () => file.bytes.length, read(buffer) { buffer.set(file.bytes); }, close() {} }; },
        };
      },
      async removeEntry(name) { if (!entries.delete(name)) throw missing(); },
    };
  };
  return directory();
}
const opfs = memoryOpfs();
const locks = { held: Promise.resolve(), request(_name, _options, callback) { return callback({}); } };
Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { locks, storage: { getDirectory: async () => opfs } } });

const vfsAccess = vfs => ({
  read(path) {
    let m;
    try { m = JSON.parse(vfs.lstat(path)); } catch { return null; }
    return m.kind === "dir" ? { kind: "dir", mode: m.mode } : { kind: "file", mode: m.mode, bytes: vfs.read_file(path) };
  },
  walk: path => [path], mkdirp: path => { try { vfs.mkdir(path, true); } catch { /* exists */ } },
  writeFile: (path, bytes) => vfs.write_file(path, bytes), symlink() {},
});
// One "kernel": a fresh VFS restored from the shared twin.
async function boot() {
  const vfs = new VirtualFileSystem();
  const persistence = await createOpfsPersistence({ access: vfsAccess(vfs), rootName: "exclude" });
  const restored = await persistence.restore();
  const server = new FsServer(vfs, persistence);
  const write = (path, text) => {
    try { vfs.mkdir(path.slice(0, path.lastIndexOf("/")), true); } catch { /* exists */ }
    vfs.write_file(path, enc.encode(text)); persistence.onWrite(path);
  };
  const text = path => { try { return dec.decode(vfs.read_file(path)); } catch { return undefined; } };
  return { vfs, persistence, server, restored, write, text, close: () => { persistence.releaseOwnership(); vfs.free(); } };
}
const mirrored = async path => {
  let node = await (await opfs.getDirectoryHandle("exclude")).getDirectoryHandle("files");
  for (const part of path.split("/").filter(Boolean)) { node = node.entries?.get(part); if (!node) return undefined; }
  return node.bytes ? dec.decode(node.bytes) : "<dir>";
};
const indexed = async () => JSON.parse(dec.decode((await opfs.getDirectoryHandle("exclude")).entries.get("manifest.json").bytes)).map(([path]) => path);
const roots = ["/app", "/workspace/.browser-editor-backends"];
const tree = async (persist, version) => ({ roots, ...(persist === undefined ? {} : { persist }), entries: [
  { kind: "directory", path: "/app", mode: 0o755 },
  { kind: "file", path: "/app/server.js", mode: 0o644, bytes: enc.encode("server " + version), sha256: await sha(enc.encode("server " + version)) },
  { kind: "directory", path: "/workspace/.browser-editor-backends", mode: 0o755 },
  { kind: "file", path: "/workspace/.browser-editor-backends/t.tgz", mode: 0o644, bytes: enc.encode("archive " + version), sha256: await sha(enc.encode("archive " + version)) },
] });
const kept = { "/workspace/src/app.ts": "edited in the browser", "/workspace/.server/state.json": "{\"session\":1}",
  "/var/lib/vivari/module-plans/plan": "plan", "/workspace/.browser-editor-cache/vite/deps/_metadata.json": "{}" };

// Boot 1, as before this option: managed roots are mirrored like anything else.
let k = await boot();
assert.equal(k.restored, 0);
for (const [path, body] of Object.entries(kept)) k.write(path, body);
await installTree(k.server, await tree(undefined, 1));
await k.persistence.flush();
assert.equal(await mirrored("/app/server.js"), "server 1");
assert.equal(await mirrored("/workspace/.browser-editor-backends/t.tgz"), "archive 1");
k.close();

// Boot 2: an existing origin. The old copies are restored once more, then the
// install drops them from the mirror and keeps them out.
k = await boot();
assert.equal(k.text("/app/server.js"), "server 1");
await installTree(k.server, await tree(false, 2));
assert.equal(k.text("/app/server.js"), "server 2");
assert.equal(k.persistence.shouldPersist("/app/server.js"), false);
assert.equal(k.persistence.shouldPersist("/application/x"), true);
// A later write under an excluded root (a guest syscall) is not mirrored; one outside is.
k.write("/app/later.txt", "not mirrored");
k.write("/workspace/src/new.ts", "written after the install");
// A second install in the same kernel (runtime restart) changes nothing.
await installTree(k.server, await tree(false, 3));
await k.persistence.flush();
assert.equal(await mirrored("/app"), undefined);
assert.equal(await mirrored("/workspace/.browser-editor-backends"), undefined);
assert.deepEqual((await indexed()).filter(path => roots.some(root => path === root || path.startsWith(root + "/"))), []);
for (const [path, body] of Object.entries(kept)) assert.equal(await mirrored(path), body, path);
assert.equal(await mirrored("/workspace/src/new.ts"), "written after the install");
assert.equal(k.text("/app/server.js"), "server 3");
k.close();

// Boot 3: only what the mirror alone holds comes back; the roots are absent until installed.
k = await boot();
for (const [path, body] of Object.entries(kept)) assert.equal(k.text(path), body, path);
assert.equal(k.text("/workspace/src/new.ts"), "written after the install");
assert.equal(k.text("/app/server.js"), undefined);
assert.equal(k.text("/workspace/.browser-editor-backends/t.tgz"), undefined);
// `persist: true` (the off switch) mirrors them again.
await installTree(k.server, await tree(true, 4));
await k.persistence.flush();
assert.equal(await mirrored("/app/server.js"), "server 4");
k.close();

// Boot 5: a kernel that died in the middle of a delete. The queue removes bytes before
// the manifest forgets them, so the manifest can list files that are gone (seen live:
// a tab reloaded while the first `persist: false` install was dropping the old /app,
// after which every open failed with "OPFS restore failed for /app/…: NotFoundError").
// The boot must come up with everything else and stop listing what is gone.
const files = await (await opfs.getDirectoryHandle("exclude")).getDirectoryHandle("files");
await files.removeEntry("app");
(await (await files.getDirectoryHandle("workspace")).getDirectoryHandle("src")).entries.delete("new.ts");
assert.ok((await indexed()).includes("/app/server.js"));
k = await boot();
for (const [path, body] of Object.entries(kept)) assert.equal(k.text(path), body, path);
assert.equal(k.text("/app/server.js"), undefined);
assert.equal(k.text("/workspace/src/new.ts"), undefined);
await k.persistence.flush();
assert.deepEqual((await indexed()).filter(path => path === "/app/server.js" || path === "/workspace/src/new.ts"), []);
k.close();
console.log("PASS opfs exclude: managed roots leave the mirror, everything else stays");
