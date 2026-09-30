// Offline fork-owned compatibility contracts, executed in real guest workers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Worker, MessageChannel } from "node:worker_threads";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createHeadlessFilesystem } from "./lib/kernel-filesystem.mjs";

const contracts = {
  "worker-uncloneable": "WORKER_UNCLONEABLE_PASS",
  "ts-module-alias": "TS_MODULE_ALIAS_PASS",
  "fs-permissions": "FS_PERMISSIONS_PASS",
  "package-self": "PACKAGE_SELF_PASS",
  "esm-export-comments": "ESM_EXPORT_COMMENTS_PASS",
  brotli: "BROTLI_PASS",
  "net-backpressure": "NET_BACKPRESSURE_PASS",
  "node-entry": "NODE_ENTRY_PASS",
  "fs-remove": "FS_REMOVE_PASS",
  "fs-native-realpath": "FS_NATIVE_REALPATH_PASS",
  "shell-quoting": "SHELL_QUOTING_PASS",
  "stream-consumers": "STREAM_CONSUMERS_PASS",
  "vm-import": "VM_IMPORT_PASS",
  "process-warning": "PROCESS_WARNING_PASS",
  sea: "SEA_NON_EXECUTABLE_PASS",
};
const selected = process.argv.slice(2);
for (const name of selected) assert.ok(Object.hasOwn(contracts, name), `Unknown contract: ${name}`);
const workers = new Set();
const deadline = setTimeout(() => {
  console.error("Runtime contracts timed out");
  process.exit(1);
}, 60_000);
try {
  const filesystem = await createHeadlessFilesystem();
  const bridge = { fs: filesystem.fs };
  const kernel = new Kernel({
    fs: bridge.fs,
    stdout: text => process.stdout.write(text),
    stderr: text => process.stderr.write(text),
    spawnWorker(info) {
      const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
      workers.add(worker);
      worker.on("message", message => info.on[message.type]?.(message));
      worker.on("error", error => {
        console.error(error);
        process.exitCode = 1;
        kernel.stop(info.pid);
      });
      const { port1, port2 } = new MessageChannel();
      filesystem.server.register(info.pid, info.sab, port2);
      const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
      const transfer = [port1];
      if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
      worker.postMessage(init, transfer);
      return {
        postMessage: message => worker.postMessage(message),
        terminate() {
          // Keep the worker in the set so final cleanup awaits termination.
          void worker.terminate();
          filesystem.server.unregister(info.pid);
          port2.close();
        },
      };
    },
  });
  kernel.installCoreutils();
  kernel.mkdirp("/contracts");
  for (const name of selected.length ? selected : Object.keys(contracts)) {
    const entry = `/contracts/${name}.cjs`;
    kernel.writeFile(entry, readFileSync(new URL(`./fixtures/runtime-contracts/${name}.cjs`, import.meta.url)));
    const result = await kernel.start("node", [entry], { cwd: "/contracts", env: { PATH: "/bin" }, capture: true });
    const output = result.stdout + result.stderr;
    assert.equal(result.code, 0, output);
    assert.ok(output.includes(contracts[name]), `Missing completion checkpoint: ${name}\n${output}`);
    console.log(`PASS ${name}`);
  }
} finally {
  await Promise.all([...workers].map(worker => worker.terminate()));
  clearTimeout(deadline);
}
