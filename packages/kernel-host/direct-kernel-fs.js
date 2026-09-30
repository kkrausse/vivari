// The supervisor owns FsServer. Its housekeeping never parks on a SAB or waits
// for a message to itself. Mutations use the same dispatch/persistence/watch path
// as guest syscalls; reads are direct and are not limited by the guest SAB window.
import {
  encodeString, FLAG_RECURSIVE, OP_WRITE_FILE, OP_MKDIR, OP_SYMLINK,
  OP_UNLINK, OP_RMDIR, OP_RENAME,
} from "../protocol/syscall.js";

export function createDirectKernelFs(server, depCache = null) {
  const vfs = server.vfs;
  const bytes = value => typeof value === "string" ? encodeString(value) : value;
  function checked(run) {
    try { return run(); }
    catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.code ||= error.message;
      throw error;
    }
  }
  const mutate = (op, fields, flags = 0) => checked(() =>
    server.dispatch(op, flags, fields.map(bytes), 0));
  const read = path => checked(() => {
    const result = vfs.read_file(path);
    if (path.startsWith("/var/cache/vv-fetch/")) server.onBodyConsumed?.(path);
    return result;
  });
  return {
    readFile: path => new TextDecoder().decode(read(path)),
    readFileBytes: read,
    writeFile: (path, contents) => mutate(OP_WRITE_FILE, [path, contents]),
    mkdirp: path => mutate(OP_MKDIR, [path], FLAG_RECURSIVE),
    readdir: path => checked(() => Array.from(vfs.readdir(path))),
    stat: path => checked(() => JSON.parse(vfs.stat(path))),
    lstat: path => checked(() => JSON.parse(vfs.lstat(path))),
    symlink: (target, path) => mutate(OP_SYMLINK, [target, path]),
    readlink: path => checked(() => vfs.readlink(path)),
    isFile(path) { try { return this.stat(path).kind === "file"; } catch { return false; } },
    exists: path => checked(() => vfs.exists(path)),
    unlink: path => mutate(OP_UNLINK, [path]),
    rmdir: path => mutate(OP_RMDIR, [path]),
    rename: (from, to) => mutate(OP_RENAME, [from, to]),
    async writeLarge(path, body) { checked(() => server.writeLarge(path, bytes(body))); },
    async writeFilesBatch(files) {
      // Same parent creation and mutation notifications as FsServer.writeBatch,
      // without concatenating/copying an entire package tree for a local call.
      const dirs = new Set();
      for (const file of files) {
        const parent = file.path.slice(0, file.path.lastIndexOf("/"));
        if (parent && !dirs.has(parent)) {
          vfs.mkdir(parent, true);
          dirs.add(parent);
        }
        checked(() => server.writeLarge(file.path, bytes(file.bytes ?? file.contents)));
      }
      return files.length;
    },
    async depCacheHas(key) { return depCache ? depCache.has(key) : false; },
    async depCacheSave(key, dir, aliases = []) { return depCache ? depCache.save(key, dir, aliases) : null; },
    async depCacheRestore(key, dir) {
      return depCache ? depCache.restore(key, dir,
        server.persistence ? path => server.persistence.onWrite(path) : undefined) : 0;
    },
    async depCacheImport(key, archive, aliases = []) {
      return depCache ? depCache.importArchive(key, archive, aliases, { shipped: true }) : null;
    },
    setBodyConsumedHandler(fn) { server.onBodyConsumed = fn; },
    setUnlinkHandler(fn) { server.onUnlink = fn; },
  };
}
