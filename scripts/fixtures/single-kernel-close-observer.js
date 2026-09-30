// Install in a fresh, owned qualification page BEFORE any runtime worker exists.
// Observation only: forward native worker construction/termination unchanged;
// query Web Locks, never request/steal/release them. No runtime message is sent.
(() => {
  if (globalThis.singleKernelCloseObserver) throw new Error("Close observer already installed");
  const NativeWorker = globalThis.Worker;
  const entries = [];
  const records = new WeakMap();
  let next = 0;
  let dropped = 0;
  const now = () => ({ wallMs: Date.now(), monotonicMs: performance.now() });
  const event = (kind, data) => {
    if (entries.length >= 256) { dropped++; return; }
    entries.push({ kind, ...now(), ...data });
  };
  const observedWorker = new Proxy(NativeWorker, {
    construct(target, args, newTarget) {
      const worker = Reflect.construct(target, args, newTarget);
      const url = new URL(String(args[0]), location.href);
      if (url.origin !== new URL(location.href).origin || !/kernel-worker[^/]*\.(?:js|ts)$/.test(url.pathname)) return worker;
      const id = ++next;
      const record = { id, terminateCalls: 0, errors: 0 };
      records.set(worker, record);
      event("kernel-created", { id, url: url.href, opfsDisabled: url.searchParams.has("opfs-disable") });
      const terminate = worker.terminate;
      worker.terminate = function (...values) {
        if (this !== worker) return Reflect.apply(terminate, this, values);
        record.terminateCalls++;
        event("terminate-called", { id, count: record.terminateCalls });
        const result = Reflect.apply(terminate, worker, values);
        event("terminate-returned", { id });
        return result;
      };
      worker.addEventListener("error", () => { record.errors++; event("worker-error", { id }); });
      worker.addEventListener("messageerror", () => { record.errors++; event("worker-messageerror", { id }); });
      worker.addEventListener("message", message => {
        if (message.data?.type !== "ready") return;
        void globalThis.singleKernelCloseObserver.sample(`kernel-${id}-ready`)
          .catch(() => event("lock-query-failed", { id }));
      });
      return worker;
    },
  });
  globalThis.Worker = observedWorker;
  globalThis.singleKernelCloseObserver = {
    entries,
    get dropped() { return dropped; },
    async sample(label) {
      if (!navigator.locks?.query) throw new Error("Web Lock observation unavailable");
      const { held, pending } = await navigator.locks.query();
      const owners = values => values.filter(lock => lock.name === "vivari-vfs-owner")
        .map(({ name, mode, clientId }) => ({ name, mode, clientId }));
      const sample = { kind: "locks", label, ...now(), held: owners(held), pending: owners(pending) };
      if (entries.length < 256) entries.push(sample);
      else dropped++;
      return sample;
    },
    record(worker) { const record = records.get(worker); return record ? { ...record } : null; },
  };
})();
