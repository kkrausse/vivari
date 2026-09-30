// Real guest workers against a local, Rust-backed kernel filesystem. Deadline
// makes a self-wait/execSync callback cycle a failure instead of an endless run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bootSpikeKernel, writeProject, waitListen } from "./lib/spike-harness.mjs";

const deadline = setTimeout(() => { console.error("FAIL: single-kernel deadline"); process.exit(1); }, 20000);
const source = readFileSync(new URL("../packages/core/src/workers/kernel-worker.ts", import.meta.url), "utf8");
const roles = [...source.matchAll(/new Worker\(new URL\("([^\"]+)"/g)].map(m => m[1]);
assert.deepEqual(roles, ["./process-worker.ts"], "only PID-owned guest workers may be nested under the kernel");
assert.ok(!source.includes("createKernelFs("));
const directSource = readFileSync(new URL("../packages/kernel-host/direct-kernel-fs.js", import.meta.url), "utf8");
assert.ok(!directSource.includes("Atomics.wait"));

const h = await bootSpikeKernel();
const { kernel, filesystem } = h;
const direct = h.kernelFs.fs;
assert.equal(filesystem.server.vfs, h.filesystem.server.vfs);
kernel.mkdirp("/app");
const binary = Uint8Array.from({ length: 2 * 1024 * 1024 + 17 }, (_, i) => i % 251);
await direct.writeLarge("/app/large.bin", binary);
assert.deepEqual(direct.readFileBytes("/app/large.bin"), binary, "local reads bypass SAB limit");
kernel.writeFile("/app/new\nline", "name");
assert.ok(direct.readdir("/app").includes("new\nline"), "local readdir preserves newline names");

writeProject(kernel, "/app", {
  "child.js": `const fs=require('fs'); const bytes=fs.readFileSync('/app/large.bin'); if(bytes.length!==${binary.length} || bytes[1048579]!==1048579%251) throw Error('binary'); if(!fs.readdirSync('/app').includes('new\\nline')) throw Error('newline entry'); fs.writeFileSync('/app/from-child','child'); process.stdout.write('child-ok');`,
  "parent.js": `const cp=require('child_process'); const fs=require('fs'); const out=cp.execFileSync('node',['/app/child.js']); if(String(out)!=='child-ok') throw Error('child stdout'); if(fs.readFileSync('/app/from-child','utf8')!=='child') throw Error('child fs'); console.log('parent-ok');`,
  "server.js": `const http=require('http'); const fs=require('fs'); http.createServer((req,res)=> { const value=fs.readFileSync('/app/host-value','utf8'); fs.writeFileSync('/app/handler-value',value); res.end(value); }).listen(3210);`,
  "sqlite.js": `const {Database}=require('bun:sqlite'); const db=new Database(':memory:'); db.exec("CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('ok')"); if(db.query('SELECT v FROM t').get().v!=='ok') throw Error('sqlite'); db.close(); console.log('sqlite-ok');`,
});
const parent = await kernel.start("node", ["/app/parent.js"], { cwd: "/app", capture: true });
assert.equal(parent.code, 0, parent.stderr);
assert.match(parent.stdout, /parent-ok/);
assert.equal(filesystem.server.clients.size, 0, "exited parents and children release local registrations");
const sql = await kernel.start("bun", ["/app/sqlite.js"], { cwd: "/app", capture: true });
assert.equal(sql.code, 0, sql.stderr);
assert.match(sql.stdout, /sqlite-ok/);
assert.equal(await waitListen(h, { dir: "/app", port: 3210, argv: ["server.js"] }), true);
for (let i = 0; i < 12; i++) {
  await direct.writeFilesBatch([{ path: "/app/host-value", contents: `host-${i}` }]);
  const response = await kernel.handleHttpRequest(3210, { method: "GET", url: "/", headers: {}, body: "" });
  assert.equal(response.status, 200);
  assert.equal(response.body, `host-${i}`);
  assert.equal(direct.readFile("/app/handler-value"), `host-${i}`);
}
for (const pid of [...kernel.procs.keys()]) kernel.signal(pid, "SIGKILL");
assert.equal(filesystem.server.clients.size, 0);
clearTimeout(deadline);
console.log("PASS single-kernel topology, >1MiB local/guest binary, execSync child FS, SQLite, HTTP synchronous FS with host writes, lifecycle cleanup");
process.exit(0);
