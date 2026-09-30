// Deterministic transport contract: a notification is not response completion.
// Run with Node worker_threads; no VFS/Wasm, browser, sleeps, or timing cohort.
// VIVARI_TEST_SOURCE selects an unchanged checkout for fails-before validation.
import assert from "node:assert/strict";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const source = process.env.VIVARI_TEST_SOURCE || resolve(import.meta.dirname, "..");
const url = path => pathToFileURL(resolve(source, path)).href;
const p = await import(url("packages/protocol/syscall.js"));
const { I_STATE, I_OPCODE, I_RES_LEN, STATE_REQUEST, STATE_RESPONSE_OK,
  OP_MKDIR, OP_LSTAT, SAB_BYTES, makeViews } = p;
const metadata = { kind: "file", size: 3015 };
const timeout = 5000; // Watchdog only: scheduling is selected by atomic handshakes.

function until(predicate, label) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw Error(`Timeout: ${label}`);
  }
}

if (isMainThread) {
  // Model the browser's kernel worker, rather than blocking Node's main thread
  // (which also owns worker loader and stdio infrastructure).
  const caller = new Worker(new URL(import.meta.url), { workerData: { caller: true } });
  const watchdog = setTimeout(() => {
    console.error("Completion contract watchdog expired");
    process.exit(1);
  }, 30_000);
  caller.on("error", error => { console.error(error); process.exitCode = 1; });
  const code = await new Promise(accept => caller.once("exit", accept));
  clearTimeout(watchdog);
  if (code) process.exitCode = code;
} else if (!workerData?.caller) {
  const { FsServer } = await import(url("packages/kernel-host/fs-server.js"));
  const gate = new Int32Array(workerData.gate);
  const server = new FsServer({
    mkdir() {},
    lstat() {
      if (workerData.error) throw Error("ENOENT");
      return JSON.stringify(metadata);
    },
  });
  const notify = Atomics.notify;
  let delayed = false;
  Atomics.notify = (ctrl, index, count) => {
    // Select the first service's notification by invocation, not OPCODE: the
    // caller may already have overwritten OPCODE after observing RESPONSE_OK.
    if (!delayed) {
      delayed = true;
      // FsServer already wrote RES_LEN=0 and RESPONSE_OK. The client can
      // consume it via wait's not-equal path and submit lstat before this notify.
      until(() => Atomics.load(ctrl, I_OPCODE) === OP_LSTAT &&
        Atomics.load(ctrl, I_STATE) === STATE_REQUEST, "next request published");
      let woke = 0;
      until(() => (woke = notify(ctrl, index, count)) === 1, "next request parked");
      parentPort.postMessage({ staleNotifyWoke: woke,
        state: Atomics.load(ctrl, I_STATE), responseBytes: Atomics.load(ctrl, I_RES_LEN) });
      // Do not service lstat until its caller has returned to the predicate wait.
      // The broken client returns instead; test cleanup releases this gate only
      // after capturing its unfinished response, then closes the worker port.
      until(() => Atomics.load(gate, 0) !== 0, "caller rechecks or test cleanup");
      return woke;
    }
    return notify(ctrl, index, count);
  };
  parentPort.on("message", msg => {
    if (msg.type === "fs-register") server.register(msg.client, msg.sab);
    else if (msg.type === "fs") server.service(msg.client);
    else if (msg.type === "stop") {
      Atomics.notify = notify;
      parentPort.close();
    }
  });
  parentPort.postMessage({ ready: true });
} else {
  const { createKernelFs } = await import(url("packages/kernel-host/kernel-fs.js"));
  const { createSyscalls } = await import(url("packages/runtime/fs-client.js"));
  const failures = [];
  for (const client of ["kernel", "process"]) {
    for (const error of [false, true]) {
      const gate = new Int32Array(new SharedArrayBuffer(4));
      const worker = new Worker(new URL(import.meta.url), { workerData: { gate: gate.buffer, error } });
      // Finish module loading before blocking the caller on the transport.
      await new Promise((accept, reject) => {
        worker.once("message", message => { assert.equal(message.ready, true); accept(); });
        worker.once("error", reject);
      });
      const receipt = new Promise((accept, reject) => {
        worker.once("message", accept);
        worker.once("error", reject);
      });
      let views;
      const handle = { postMessage(msg) {
        if (msg.type === "fs-register") views = makeViews(msg.sab);
        worker.postMessage(msg);
        if (msg.type === "fs" && Atomics.load(views.ctrl, I_OPCODE) === OP_MKDIR) {
          until(() => Atomics.load(views.ctrl, I_STATE) === STATE_RESPONSE_OK, "mkdir response published");
        }
      } };
      let fs;
      if (client === "kernel") fs = createKernelFs(handle).fs;
      else {
        const sab = new SharedArrayBuffer(SAB_BYTES);
        handle.postMessage({ type: "fs-register", client: 1, sab });
        fs = createSyscalls({ ...views, notify() { handle.postMessage({ type: "fs", client: 1 }); } });
      }
      const wait = Atomics.wait;
      let lstatWaits = 0;
      let value, failure;
      Atomics.wait = (ctrl, index, expected) => {
        if (Atomics.load(ctrl, I_OPCODE) === OP_LSTAT && ++lstatWaits === 2) {
          Atomics.store(gate, 0, 1);
        }
        const result = wait(ctrl, index, expected, timeout);
        if (result === "timed-out") throw Error("Transport test watchdog expired");
        return result;
      };
      try {
        if (client === "kernel") fs.mkdirp("/probe");
        else fs.mkdir("/probe", true);
        try { value = fs.lstat("/probe/ordinary.map"); } catch (err) { failure = err; }
      } finally {
        Atomics.wait = wait;
      }
      try {
        const evidence = await receipt;
        console.log(JSON.stringify({ client, errorResponse: error, ...evidence,
          lstatWaits, value, error: failure?.message, code: failure?.code }));
        assert.equal(evidence.staleNotifyWoke, 1);
        assert.equal(evidence.state, STATE_REQUEST);
        assert.equal(evidence.responseBytes, 0);
        assert.ok(lstatWaits >= 2, "must not consume an unfinished response after stale notify");
        if (error) assert.equal(failure?.code, "ENOENT");
        else {
          assert.equal(failure, undefined);
          assert.deepEqual(value, metadata);
        }
      } catch (err) {
        failures.push(`${client}/${error ? "errno" : "metadata"}: ${err.message}`);
      } finally {
        Atomics.store(gate, 0, 2); // release an unfixed caller's worker during cleanup
        const exited = new Promise(accept => worker.once("exit", accept));
        worker.postMessage({ type: "stop" });
        await exited;
      }
    }
  }
  assert.deepEqual(failures, []);
  console.log("PASS kernel/process completion predicates preserve metadata and errno after stale notify");
}
