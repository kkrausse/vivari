import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { Worker, MessageChannel } from "node:worker_threads";
import { createServer } from "vite";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { SAB_BYTES } from "../packages/protocol/syscall.js";
import { createHeadlessFilesystem } from "./lib/kernel-filesystem.mjs";
import { initializeKernelBackends } from "../packages/kernel-host/kernel-backends.js";

const deadline = setTimeout(() => { console.error("FAIL review contracts timed out"); process.exit(1); }, 20000);
let worker;
let vite;
try {
  // Exercise Vite's real source-mode worker URL transformation without building
  // or touching dist. Its existing query must survive the SQLite opt-out flag.
  const root = new URL("../packages/core", import.meta.url).pathname;
  vite = await createServer({ root, configFile: root + "/vite.config.ts", server: { middlewareMode: true }, appType: "custom" });
  const transformed = await vite.transformRequest("/src/workers/kernel-worker.ts?worker&url");
  const exported = transformed.code.match(/export default ("[^"]+"|'[^']+')/);
  assert.ok(exported, transformed.code);
  const devUrl = new URL(JSON.parse(exported[1]), "http://localhost:3000");
  devUrl.searchParams.set("opfs-disable", "");
  assert.equal(devUrl.searchParams.get("worker_file"), "");
  assert.equal(devUrl.searchParams.get("type"), "module");
  assert.equal(devUrl.searchParams.has("opfs-disable"), true);
  const sourceWorker = await vite.transformRequest(devUrl.pathname + devUrl.search);
  assert.ok(sourceWorker.code.includes("createKernelFilesystem"), "dev worker request remains valid");
  const bridge = readFileSync(new URL("../packages/core/src/bridge.ts", import.meta.url), "utf8");
  assert.match(bridge, /kernelUrl\.searchParams\.set\("opfs-disable", ""\)/);
  const builtUrl = new URL("/assets/kernel-worker-EXAMPLE.js", "http://localhost:3000");
  builtUrl.searchParams.set("opfs-disable", "");
  assert.equal(builtUrl.searchParams.has("opfs-disable"), true);
  await vite.close(); vite = null;

  // Missing/refused ownership or failed restore (represented by null) must not
  // touch the shared durable dependency-cache namespace at all.
  let opened = 0, released = 0;
  const persistence = { releaseOwnership: () => released++ };
  const sqlite = {};
  const openDepCache = async () => { opened++; return {}; };
  const unavailable = await initializeKernelBackends(null, { openDepCache, openSqlite: async () => sqlite });
  assert.equal(opened, 0);
  assert.equal(unavailable.depCache, null);
  const owned = await initializeKernelBackends(persistence, { openDepCache, openSqlite: async () => sqlite });
  assert.equal(opened, 1);
  assert.equal(owned.sqlite, sqlite);
  assert.equal(released, 0, "successful kernel retains ownership");
  await assert.rejects(initializeKernelBackends(persistence, {
    openDepCache, openSqlite: async () => { throw new Error("sqlite init failed"); },
  }), /sqlite init failed/);
  assert.equal(released, 1, "required backend rejection releases durable ownership");

  // Real Rust VFS + real guest sync client + immediate local kernel reclamation.
  const filesystem = await createHeadlessFilesystem();
  const length = 2 * 1024 * 1024 + 43;
  const body = Uint8Array.from({ length }, (_, i) => i % 251);
  const kernel = new Kernel({ fs: filesystem.fs, spawnWorker: () => { throw new Error("unused"); },
    fetcher: async () => ({ ok: true, status: 200, headers: {}, body }) });
  kernel.fetchCacheMaxBytes = 0;
  // These controlled reader PIDs own the two private fixture requests. Admission
  // no longer accepts a PID absent from the process table.
  kernel.procs.set(77, { pid: 77 });
  kernel.procs.set(78, { pid: 78 });
  const result = await kernel._fetchIntoVfs(77, { url: "https://example.test/oversized-body" });
  await kernel._fetchIntoVfs(78, { url: "https://example.test/evict-previous" });
  assert.ok(kernel._fetchBodyOrphans.has(result.path), "zero cache cap evicts pinned body");
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const { port1, port2 } = new MessageChannel();
  filesystem.server.register(77, sab, port2);
  worker = new Worker(new URL("./fixtures/fetch-body-retry-worker.mjs", import.meta.url), {
    workerData: { sab, port: port1, path: result.path, length }, transferList: [port1],
  });
  worker.on("error", error => { console.error(error); process.exit(1); });
  const [rejected] = await once(worker, "message");
  assert.equal(rejected.phase, "rejected");
  assert.match(rejected.code, /^EFBIG/);
  assert.equal(filesystem.server.vfs.exists(result.path), true, "rejected whole-file read must retain body");
  assert.equal(kernel._fetchBodyPins.get(result.path).length, 1, "EFBIG must not consume a pin");
  worker.postMessage("retry");
  const [read] = await once(worker, "message");
  assert.deepEqual(read, { phase: "read", length });
  assert.equal(filesystem.server.vfs.exists(result.path), true, "chunked body remains until fd close");
  worker.postMessage("close");
  const [closed] = await once(worker, "message");
  assert.equal(closed.phase, "closed");
  assert.equal(filesystem.server.vfs.exists(result.path), false, "successful fd close releases evicted body");
  assert.equal(kernel._fetchBodyPins.has(result.path), false);
  filesystem.server.unregister(77); port2.close();
  await worker.terminate(); worker = null;
  console.log("PASS query-safe Vite source worker, durable-cache owner gating, SQLite initialization cleanup, oversized fetched-body EFBIG/chunked retry/close reclamation");
} finally {
  if (worker) await worker.terminate();
  if (vite) await vite.close();
  clearTimeout(deadline);
}
// Vite's dependency optimizer can retain native background handles after close;
// all owned Vite/guest services above were explicitly closed and joined.
process.exit(0);
