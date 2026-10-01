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
const { launch } = await import("../packages/core/src/host-sdk/execution.ts");
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
  {
    // A throwing handler used to skip terminate() and leave later destroy() calls as no-ops.
    const host = await Host.open({ assetBaseUrl: "/runtime/", version: "fixture" });
    const boom = new Error("handler boom");
    let later = 0, cleaned = 0;
    host.on(() => { throw boom; });
    host.on(m => { if (m.type === "host-error") later++; });
    host.cleanup.push(() => { throw new Error("cleanup boom"); }, () => { cleaned++; });
    const rejected = assert.rejects(host.request("fixture-pending"), error => error.code === "CLOSED");
    assert.throws(() => host.destroy(), error => error === boom, "first handler error reaches the caller");
    assert.equal(host.worker.terminations, 1, "throwing handler still terminates");
    assert.equal(later, 1, "later handlers still run");
    assert.equal(cleaned, 1, "later cleanup still runs");
    await rejected;
    await host.worker.exited;
    assert.equal(host.pending.size, 0);
    assert.equal(host.handlers.size, 0);
    host.destroy();
    assert.equal(host.worker.terminations, 1);
    console.log("PASS throwing destroy handler: unconditional termination, cleanup and first error preserved");
  }
  for (const deliberate of [true, false]) {
    // A deliberate close used to stamp cleanupError, so stop() threw CLEANUP_FAILED.
    const host = await Host.open({ assetBaseUrl: "/runtime/", version: "fixture" });
    const execution = await launch(host, { entry: "/fixture.js" });
    if (deliberate) host.destroy(); else host.destroy(new Error("worker fault"));
    const exit = await execution.exited;
    assert.equal(exit.signal, "SIGTERM");
    if (deliberate) {
      assert.equal("cleanupError" in exit, false, "deliberate close is not a cleanup failure");
      await execution.stop();
    } else {
      assert.equal(exit.cleanupError, "worker fault");
      await assert.rejects(execution.stop(), error => error.code === "CLEANUP_FAILED");
    }
    await host.worker.exited;
    console.log(`PASS ${deliberate ? "deliberate close" : "worker fault"}: execution cleanup classification`);
  }
  {
    // The caller-supplied owner-lock bound reaches the kernel's init message; invalid values never start a worker.
    const created = workers.length;
    for (const lockTimeoutMs of [-1, Infinity, NaN, "250"]) {
      await assert.rejects(Host.open({ assetBaseUrl: "/runtime/", version: "fixture" }, undefined, undefined, { lockTimeoutMs }), RangeError);
    }
    assert.equal(workers.length, created);
    for (const [options, expected] of [[{ lockTimeoutMs: 250 }, { type: "init", compress: true, lockTimeoutMs: 250 }], [undefined, { type: "init", compress: true }]]) {
      let init;
      const inits = workers.length;
      const opening = Host.open({ assetBaseUrl: "/runtime/", version: "fixture" }, undefined, undefined, options);
      while (workers.length === inits) await new Promise(setImmediate);
      workers.at(-1).thread.on("message", m => { if (m.type === "ready") init = m.init; });
      const host = await opening;
      assert.deepEqual(init, expected);
      host.destroy();
      await host.worker.exited;
    }
    console.log("PASS Host.open lockTimeoutMs: validated, carried on init, omitted by default");
  }
  for (const mode of ["clean", "errors", "silent", "destroyed"]) {
    // Host.close: terminate only after the shutdown acknowledgement; never resolve an unproven close.
    const host = await Host.open({ assetBaseUrl: "/runtime/", version: "fixture" });
    await host.request("fixture-shutdown-mode", { mode });
    const execution = await launch(host, { entry: "/fixture.js" });
    if (mode === "destroyed") host.destroy();
    const closing = host.close({ timeoutMs: 200 });
    assert.equal(host.close(), closing, "concurrent close returns the same promise");
    if (mode !== "destroyed") assert.equal(host.worker.terminations, 0, "no termination before the acknowledgement");
    if (mode === "clean") {
      await closing;
      assert.equal("cleanupError" in await execution.exited, false);
    } else if (mode === "errors") {
      await assert.rejects(closing, error => error.code === "CLEANUP_FAILED" && error.message === "flush failed");
      assert.equal((await execution.exited).cleanupError, "flush failed");
    } else if (mode === "silent") {
      await assert.rejects(closing, error => error.code === "CLEANUP_FAILED" && /not acknowledged within 200ms/.test(error.message));
    } else await assert.rejects(closing, error => error.code === "CLOSED", "a hard-killed host cannot prove a graceful close");
    assert.equal(host.worker.terminations, 1, `${mode}: terminated exactly once`);
    await host.worker.exited;
    assert.equal(host.close(), closing, "repeat close returns the same promise");
    assert.equal(host.pending.size, 0);
    assert.throws(() => host.post("anything"), error => error.code === "CLOSED");
    console.log(`PASS Host.close ${mode}: ${mode === "clean" ? "resolves after acknowledgement, then terminates" : "terminates and rejects"}`);
  }
  assert.equal(observer.entries.filter(event => event.kind === "kernel-created").length, workers.length);
  assert.equal(observer.entries.filter(event => event.kind === "terminate-called").length, workers.length);
  assert.equal(observer.entries.filter(event => event.kind === "terminate-returned").length, workers.length);
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
