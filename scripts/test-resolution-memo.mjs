// What the module loader remembers about the filesystem (packages/runtime/module.js)
// against a real kernel and a real guest worker. What is guarded is the one rule
// that memory lives by: it is valid for exactly one filesystem epoch, and the
// kernel replaces the epoch on every change of a name or of a file's contents,
// whoever makes it. So:
//   - a change made by the guest itself, by the host, or by a direct VFS writer is
//     seen by the very next resolution (new file, shadowing file, nearer package,
//     edited package.json, removed file, retargeted symlink);
//   - and the memory really is in use, shown by the only way to fool it: a write
//     that bypasses the epoch is NOT seen until some published change follows;
//   - a guest that replaces an `fs` function the loader uses gets no memory at all.
import assert from "node:assert/strict";
import { Worker, MessageChannel } from "node:worker_threads";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createHeadlessFilesystem } from "./lib/kernel-filesystem.mjs";

const deadline = setTimeout(() => { console.error("FAIL: resolution memory deadline"); process.exit(1); }, 120_000);
const workers = new Set();
const filesystem = await createHeadlessFilesystem();
let output = "";
const waiting = [];
const kernel = new Kernel({
  fs: filesystem.fs,
  stdout(text) {
    output += text;
    for (const entry of [...waiting]) if (output.includes(entry.text)) { waiting.splice(waiting.indexOf(entry), 1); entry.resolve(); }
  },
  stderr(text) { output += text; },
  spawnWorker(info) {
    const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
    workers.add(worker);
    worker.on("message", message => info.on[message.type]?.(message));
    worker.on("error", error => { console.error(error); process.exitCode = 1; kernel.stop(info.pid); });
    const { port1, port2 } = new MessageChannel();
    filesystem.server.register(info.pid, info.sab, port2);
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
    const transfer = [port1];
    if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
    worker.postMessage(init, transfer);
    return { postMessage: message => worker.postMessage(message),
      terminate() { void worker.terminate(); filesystem.server.unregister(info.pid); port2.close(); } };
  },
});
kernel.installCoreutils();
const said = text => output.includes(text) ? Promise.resolve() : new Promise(resolve => waiting.push({ text, resolve }));
// A write the epoch never hears about: the VFS's own method, under the wrapper
// FsServer put on the instance. Nothing in the product writes this way.
const vfs = filesystem.server.vfs;
const unpublished = (path, text) => Object.getPrototypeOf(vfs).write_file.call(vfs, path, new TextEncoder().encode(text));

const files = {
  "/t/main.js": `
const fs = require('fs'), assert = require('assert');
const resolve = (request, from = '/t/app/src') => require('module').createRequire(from + '/x.js').resolve(request);
const missing = (request, from) => { try { resolve(request, from); return false; } catch (e) { return e.code === 'MODULE_NOT_FOUND'; } };
const go = name => new Promise(done => { const timer = setInterval(() => { if (fs.existsSync('/t/' + name)) { clearInterval(timer); done(); } }, 2); });
(async () => {
  // 1. A file created by this process is importable at once.
  assert.ok(missing('./fresh'));
  fs.writeFileSync('/t/app/src/fresh.js', 'module.exports = "fresh";');
  assert.equal(require('/t/app/src/fresh'), 'fresh');

  // 2. A file that shadows the remembered answer (.js before .json) wins.
  assert.equal(resolve('./shadow'), '/t/app/src/shadow.json');
  assert.equal(resolve('./shadow'), '/t/app/src/shadow.json');
  fs.writeFileSync('/t/app/src/shadow.js', '');
  assert.equal(resolve('./shadow'), '/t/app/src/shadow.js');

  // 3. A package installed nearer than the remembered one wins; removing it restores the other.
  assert.equal(resolve('dep'), '/t/node_modules/dep/index.js');
  fs.mkdirSync('/t/app/node_modules/dep', { recursive: true });
  fs.writeFileSync('/t/app/node_modules/dep/index.js', '');
  assert.equal(resolve('dep'), '/t/app/node_modules/dep/index.js');
  fs.rmSync('/t/app/node_modules', { recursive: true });
  assert.equal(resolve('dep'), '/t/node_modules/dep/index.js');

  // 4. package.json: created, then edited in place (main, then exports with conditions).
  fs.writeFileSync('/t/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib.js' }));
  assert.equal(resolve('dep'), '/t/node_modules/dep/lib.js');
  fs.writeFileSync('/t/node_modules/dep/package.json', JSON.stringify({ name: 'dep', main: 'lib.js', exports: { '.': { import: './esm.js', require: './cjs.js' }, './sub/*': './lib/*.js' } }));
  assert.equal(resolve('dep'), '/t/node_modules/dep/cjs.js');
  assert.equal(resolve('dep/sub/a'), '/t/node_modules/dep/lib/a.js');
  // ...through an open file descriptor as well (no create, no truncate).
  const text = JSON.stringify({ name: 'dep', main: 'lib.js' }).padEnd(fs.statSync('/t/node_modules/dep/package.json').size);
  const fd = fs.openSync('/t/node_modules/dep/package.json', 'r+');
  fs.writeSync(fd, text, 0);
  fs.closeSync(fd);
  assert.equal(resolve('dep'), '/t/node_modules/dep/lib.js');

  // 5. Removed and renamed files.
  fs.renameSync('/t/app/src/shadow.js', '/t/app/src/moved.js');
  assert.equal(resolve('./shadow'), '/t/app/src/shadow.json');
  assert.equal(resolve('./moved'), '/t/app/src/moved.js');
  fs.unlinkSync('/t/app/src/shadow.json');
  assert.ok(missing('./shadow'));

  // 6. Symlinks: a module is one module under its real path, and a retargeted link is followed.
  fs.symlinkSync('/t/real', '/t/app/linked');
  assert.equal(resolve('../linked/one'), '/t/real/one.js');
  assert.equal(require('/t/app/linked/one'), require('/t/real/one'));
  assert.deepEqual(Object.keys(require.cache).filter(k => k.endsWith('/one.js')), ['/t/real/one.js']);
  fs.unlinkSync('/t/app/linked');
  fs.symlinkSync('/t/other', '/t/app/linked');
  assert.equal(resolve('../linked/one'), '/t/other/one.js');
  assert.notEqual(require('/t/app/linked/one'), require('/t/real/one'));
  assert.equal(require('/t/app/linked/one').dir, '/t/other');

  // 7. The memory is real: a write the epoch does not hear about is not seen...
  assert.equal(resolve('./stale'), '/t/app/src/stale.json');
  assert.ok(missing('./absent'));
  console.log('STEP unpublished');
  await go('go-unpublished');
  assert.equal(resolve('./stale'), '/t/app/src/stale.json', 'remembered');
  assert.ok(missing('./absent'), 'remembered listing');
  // ...until any published change, however unrelated.
  fs.writeFileSync('/t/unrelated.txt', '');
  assert.equal(resolve('./stale'), '/t/app/src/stale.js');
  assert.equal(resolve('./absent'), '/t/app/src/absent.js');

  // 8. A change made by the host through the kernel is published.
  assert.ok(missing('./hosted'));
  assert.equal(resolve('host-dep'), '/t/node_modules/host-dep/index.js');
  console.log('STEP host');
  await go('go-host');
  assert.equal(resolve('./hosted'), '/t/app/src/hosted.js');
  assert.equal(resolve('host-dep'), '/t/node_modules/host-dep/main.js');

  // 9. A guest that replaces an fs function the loader uses gets no memory:
  //    even an unpublished write is seen at once.
  const original = fs.statSync;
  fs.statSync = function (...args) { return original.apply(this, args); };
  assert.equal(resolve('./patched'), '/t/app/src/patched.json');
  console.log('STEP patched');
  await go('go-patched');
  assert.equal(resolve('./patched'), '/t/app/src/patched.js');
  console.log('GUEST DONE');
})().catch(error => { console.log('GUEST FAILED ' + (error && error.stack || error)); process.exit(1); });
`,
  "/t/app/src/shadow.json": "{}",
  "/t/app/src/stale.json": "{}",
  "/t/app/src/patched.json": "{}",
  "/t/node_modules/dep/index.js": "",
  "/t/node_modules/dep/lib.js": "",
  "/t/node_modules/dep/cjs.js": "",
  "/t/node_modules/dep/esm.js": "",
  "/t/node_modules/dep/lib/a.js": "",
  "/t/node_modules/host-dep/index.js": "",
  "/t/node_modules/host-dep/main.js": "",
  "/t/real/one.js": "module.exports = { dir: __dirname };",
  "/t/other/one.js": "module.exports = { dir: __dirname };",
};

try {
  for (const [path, text] of Object.entries(files)) {
    kernel.mkdirp(path.slice(0, path.lastIndexOf("/")));
    kernel.writeFile(path, text);
  }
  const epochNow = () => Atomics.load(filesystem.server.fsEpoch, 0);
  const epochs = {};
  const finished = kernel.start("node", ["/t/main.js"], { cwd: "/t", env: { PATH: "/bin" } });
  const guest = step => Promise.race([said(`STEP ${step}`), said("GUEST FAILED")]);

  await guest("unpublished");
  epochs.before = epochNow();
  unpublished("/t/app/src/stale.js", "");
  unpublished("/t/app/src/absent.js", "");
  unpublished("/t/go-unpublished", "");
  assert.equal(epochNow(), epochs.before, "a write under the wrapper is not published");

  await guest("host");
  epochs.before = epochNow();
  kernel.writeFile("/t/app/src/hosted.js", "");
  kernel.writeFile("/t/node_modules/host-dep/package.json", JSON.stringify({ main: "main.js" }));
  assert.ok(epochNow() > epochs.before, "a host write through the kernel is published");
  unpublished("/t/go-host", "");

  await guest("patched");
  unpublished("/t/app/src/patched.js", "");
  unpublished("/t/go-patched", "");

  const result = await finished;
  assert.equal(output.includes("GUEST FAILED"), false, output);
  assert.match(output, /GUEST DONE/, output);
  assert.equal(result.code, 0, output);

  // The epoch moves for every way of changing a name or contents, and for nothing else.
  const server = filesystem.server;
  const moves = (label, run, expected = true) => {
    const before = epochNow();
    run();
    assert.equal(epochNow() !== before, expected, `${label} ${expected ? "advances" : "does not advance"} the epoch`);
    assert.notEqual(epochNow(), 0, "the published epoch is never 0");
  };
  const bytes = new TextEncoder().encode("x");
  moves("write_file", () => vfs.write_file("/t/e1", bytes));
  moves("mkdir", () => vfs.mkdir("/t/e-dir", false));
  moves("rename", () => vfs.rename("/t/e1", "/t/e2"));
  moves("symlink", () => vfs.symlink("/t/e2", "/t/e-link"));
  moves("link", () => vfs.link("/t/e2", "/t/e-hard"));
  let fd;
  moves("open for reading", () => { fd = vfs.open("/t/e2", 0, 0); }, false);
  moves("close", () => vfs.close(fd), false);
  moves("open with O_CREAT", () => { fd = vfs.open("/t/e3", 0o102, 0o644); });
  moves("fd_write", () => vfs.fd_write(fd, bytes, -1));
  moves("ftruncate", () => vfs.ftruncate(fd, 0));
  vfs.close(fd);
  moves("unlink", () => vfs.unlink("/t/e3"));
  moves("rmdir", () => vfs.rmdir("/t/e-dir"));
  moves("stat", () => vfs.stat("/t/e2"), false);
  moves("readdir", () => vfs.readdir("/t"), false);
  moves("read_file", () => vfs.read_file("/t/e2"), false);
  moves("set_mode", () => vfs.set_mode("/t/e2", 0o600, true), false);
  moves("a failed unlink", () => { try { vfs.unlink("/t/none"); } catch { /* ENOENT */ } });
  Atomics.store(server.fsEpoch, 0, 0x7fffffff);
  moves("write at the largest epoch", () => vfs.write_file("/t/e4", bytes));
  assert.equal(epochNow(), 1, "the epoch wraps to 1, not 0");
  console.log("PASS resolution memory: every published change is seen by the next resolution; an unpublished one is not, until the epoch moves; a patched fs is never remembered");
} finally {
  await Promise.all([...workers].map(worker => worker.terminate()));
  clearTimeout(deadline);
}
process.exit(process.exitCode ?? 0);
