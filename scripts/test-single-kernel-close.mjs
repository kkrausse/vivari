// Offline characterization of the shipped host/endpoint/response-cancel boundary.
// A real Node thread substitutes for Chrome's Kernel Worker; its tiny protocol
// fixture is NOT the kernel, OPFS, a Web Lock, or a Chrome target-lifecycle oracle.
import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { Worker as NodeWorker, MessageChannel } from "node:worker_threads";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith(".js") && context.parentURL?.includes("/packages/core/src/host-sdk/")) {
      const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(ts)) return next(ts.href, context);
    }
    return next(specifier, context);
  },
});
const { Host } = await import("../packages/core/src/host-sdk/host.ts");
const { createEndpoint } = await import("../packages/core/src/host-sdk/browser/endpoint.ts");
const originals = new Map();
function replace(name, value) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}
const workers = [];
replace("location", { href: "http://owned.invalid/" });
replace("crossOriginIsolated", true);
replace("MessageChannel", MessageChannel);
replace("fetch", async () => Response.json({ abi: "workspace-v2-sab6-sqlite39", version: "fixture",
  kernelWorker: "kernel-worker-fixture.js", serviceWorker: "sw.js",
  features: ["install-tree-v1", "http-stream-v1", "workspace-flush-v1"] }));
replace("Worker", class {
  constructor(url) {
    assert.equal(url.searchParams.has("opfs-disable"), true);
    this.thread = new NodeWorker(new URL("./fixtures/host-close-worker.mjs", import.meta.url), { execArgv: [] });
    this.exited = once(this.thread, "exit");
    this.terminations = 0;
    this.thread.on("message", data => this.onmessage?.({ data }));
    this.thread.on("error", error => this.onerror?.({ message: error.message }));
    workers.push(this);
  }
  postMessage(message, transfer) {
    // Browser MessageEvent.ports has no Node twin: name the transferred port.
    if (message.type === "workspace-http-stream") message = { ...message, channel: transfer[0] };
    this.thread.postMessage(message, transfer);
  }
  terminate() { this.terminations++; void this.thread.terminate(); }
  addEventListener(type, listener) {
    if (type === "error") this.thread.on("error", listener);
    if (type === "message") this.thread.on("message", data => listener({ data }));
  }
});
replace("navigator", { locks: { async query() { return { held: [], pending: [] }; } } });
originals.set("singleKernelCloseObserver", Object.getOwnPropertyDescriptor(globalThis, "singleKernelCloseObserver"));
await import("./fixtures/single-kernel-close-observer.js");
const observer = globalThis.singleKernelCloseObserver;
assert.deepEqual((await observer.sample("before-boot")).held, []);
const deadline = setTimeout(() => { console.error("FAIL close boundary timed out"); process.exit(1); }, 10000);
try {
  for (const mode of ["abort-before-headers", "cancel-after-data", "normal-eof"]) {
    const host = await Host.open({ assetBaseUrl: "/runtime/", version: "fixture" });
    host.listeners.set(3211, "fixture-listener");
    const endpoint = createEndpoint(host, 3211, "fixture-listener", new AbortController().signal);
    const abort = new AbortController();
    const response = endpoint.fetch(mode === "abort-before-headers" ? "/never" : "/open", { signal: abort.signal });
    if (mode === "abort-before-headers") {
      const reason = new Error("intentional abort");
      abort.abort(reason);
      await assert.rejects(response, error => error === reason);
    } else {
      const reader = (await response).body.getReader();
      assert.deepEqual((await reader.read()).value, Uint8Array.of(0, 255, 128, 65));
      if (mode === "cancel-after-data") await reader.cancel("intentional reader cancellation");
      else assert.equal((await reader.read()).done, true);
    }
    // Separate request acts as a worker protocol barrier after stream completion.
    const state = await host.request("fixture-state");
    assert.equal(state.channels, 0, `${mode}: fixture channel released`);
    assert.equal(state.cancellations, mode === "normal-eof" ? 0 : 1);
    await host.flush();
    const pending = host.request("fixture-pending");
    const rejected = assert.rejects(pending, error => error.code === "CLOSED");
    host.destroy();
    await rejected;
    await endpoint.closed;
    assert.equal(host.worker.terminations, 1, `${mode}: termination requested exactly once`);
    await host.worker.exited;
    assert.equal(host.pending.size, 0);
    assert.equal(host.handlers.size, 0);
    assert.throws(() => host.post("anything"), error => error.code === "CLOSED");
    host.destroy();
    assert.equal(host.worker.terminations, 1, "destroy is idempotent");
    assert.equal(observer.record(host.worker).terminateCalls, 1, "browser observer forwards one native termination");
    console.log(`PASS ${mode}: stream release, pending rejection, exactly-once termination and real thread exit`);
  }
  assert.equal(observer.entries.filter(event => event.kind === "kernel-created").length, 3);
  assert.equal(observer.entries.filter(event => event.kind === "terminate-called").length, 3);
  assert.equal(observer.entries.filter(event => event.kind === "terminate-returned").length, 3);
  assert.equal(observer.dropped, 0);
} finally {
  clearTimeout(deadline);
  await Promise.all(workers.map(worker => worker.thread.terminate()));
  hooks.deregister();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
  }
}
