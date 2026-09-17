// Verified disposable trees are installed on the VFS-owning thread. No per-file
// syscall, guest process, or main-thread round trip is needed. Call before launch;
// this replaces the supplied roots and is not a transactional live-tree update.
export async function installTree(server, { roots, entries }) {
  const started = performance.now();
  const validPath = (p) => typeof p === "string" && p.startsWith("/") && p !== "/"
    && !p.split("/").slice(1).some(part => !part || part === "." || part === ".." || /[\\\0]/.test(part));
  if (!Array.isArray(roots) || !roots.length || roots.some(r => !validPath(r))
    || roots.some((r, i) => roots.some((s, j) => i !== j && (r === s || r.startsWith(s + "/"))))) throw Error("Invalid tree roots");
  const rootFor = p => roots.find(r => p === r || p.startsWith(r + "/"));
  const paths = new Map();
  for (const e of entries) {
    if (!validPath(e.path) || !rootFor(e.path) || paths.has(e.path)) throw Error("Invalid tree path");
    if (e.kind === "file") {
      if (!(e.bytes instanceof Uint8Array) || !/^[a-f0-9]{64}$/.test(e.sha256)) throw Error("Invalid tree file");
    } else if (e.kind === "symlink") {
      if (typeof e.target !== "string" || !e.target || e.target.startsWith("/") || /[\\\0]/.test(e.target)) throw Error("Invalid tree symlink");
    } else if (e.kind !== "directory") throw Error("Invalid tree entry");
    if (e.kind !== "symlink" && (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o777)) throw Error("Invalid tree mode");
    paths.set(e.path, e);
  }
  for (const root of roots) if (paths.has(root) && paths.get(root).kind !== "directory") throw Error("Tree root must be a directory");
  for (const e of entries) if (!roots.includes(e.path) && paths.get(e.path.slice(0, e.path.lastIndexOf("/")))?.kind !== "directory") throw Error("Missing tree parent");
  function follow(path, seen = new Set()) {
    const parts = path.split("/").slice(1), resolved = [];
    while (parts.length) {
      const part = parts.shift();
      if (!part || part === ".") continue;
      if (part === "..") { resolved.pop(); continue; }
      resolved.push(part);
      const current = "/" + resolved.join("/");
      const entry = paths.get(current);
      if (entry?.kind === "symlink") {
        if (seen.has(current)) throw Error("Cyclic tree symlink");
        const target = follow(current.slice(0, current.lastIndexOf("/")) + "/" + entry.target, new Set(seen).add(current));
        resolved.splice(0, resolved.length, ...target.split("/").slice(1));
      }
    }
    return "/" + resolved.join("/");
  }
  for (const e of entries) if (e.kind === "symlink" && rootFor(follow(e.path)) !== rootFor(e.path)) throw Error("Escaping tree symlink");
  const digest = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  const hashes = new Map(), files = entries.filter(e => e.kind === "file");
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(8, files.length) }, async () => {
    while (next < files.length) {
      const e = files[next++];
      let ranges = hashes.get(e.bytes.buffer);
      if (!ranges) hashes.set(e.bytes.buffer, ranges = new Map());
      const key = `${e.bytes.byteOffset}:${e.bytes.byteLength}`;
      let hash = ranges.get(key);
      if (!hash) ranges.set(key, hash = digest(e.bytes));
      if (await hash !== e.sha256) throw Error(`Tree integrity failure: ${e.path}`);
    }
  }));
  const failed = results.find(r => r.status === "rejected");
  if (failed) throw failed.reason;
  const verified = performance.now();
  const vfs = server.vfs, persistence = server.persistence;
  for (const root of roots) {
    const parts = root.split("/").slice(1);
    for (let i = 1; i < parts.length; i++) {
      const parent = "/" + parts.slice(0, i).join("/");
      let stat;
      try { stat = JSON.parse(vfs.lstat(parent)); } catch (error) {
        if (!String(error).includes("ENOENT")) throw error;
      }
      if (stat && stat.kind !== "dir") throw Error(`Invalid tree root parent: ${parent}`);
    }
  }
  function remove(path) {
    let stat;
    try { stat = JSON.parse(vfs.lstat(path)); } catch (error) {
      if (String(error).includes("ENOENT")) return;
      throw error;
    }
    if (stat.kind === "dir") {
      for (const name of vfs.readdir(path)) remove(path + "/" + name);
      vfs.rmdir(path);
    } else vfs.unlink(path);
    persistence?.onDelete(path);
  }
  for (const root of roots) remove(root);
  const directories = entries.filter(e => e.kind === "directory").sort((a, b) => a.path.length - b.path.length);
  for (const e of directories) { vfs.mkdir(e.path, true); persistence?.onWrite(e.path); }
  for (const e of files) { vfs.write_file(e.path, e.bytes); persistence?.onWrite(e.path); }
  for (const e of entries) if (e.kind === "symlink") { vfs.symlink(e.target, e.path); persistence?.onWrite(e.path); }
  for (const e of [...files, ...directories.reverse()]) vfs.set_mode(e.path, e.mode, true);
  for (const root of roots) server.notifyWatch(root, "rename");
  const installed = performance.now();
  for (const e of files) if (e.verifyReadback && await digest(vfs.read_file(e.path)) !== e.sha256) throw Error(`Installed tree integrity failure: ${e.path}`);
  return { files: files.length, verifyMs: verified - started, installMs: installed - verified, readbackMs: performance.now() - installed };
}
