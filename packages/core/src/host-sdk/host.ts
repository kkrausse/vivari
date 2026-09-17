import { WorkspaceError, type Distribution } from "./types.js";
import type { diagnosticReporter } from "./diagnostics.js";
import type { PersistenceState, InstallTreeEntry, TreeInstallResult } from "./types.js";

// Private transport boundary. Worker protocol never escapes to consumers.
export type Message = { type: string; [key: string]: unknown };
type Listener = (message: Message) => void;
export class Host {
  readonly listeners = new Map<number, string>();
  readonly worker: Worker;
  private handlers = new Set<Listener>();
  private pending = new Map<number, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private sequence = 1;
  private dead = false;
  private cleanup: (() => void)[] = [];
  nextExecution = 1;
  readonly features = new Set<string>();
  readonly serviceWorkerUrl: string;
  private constructor(workerUrl: string, serviceWorkerUrl: string) {
    this.serviceWorkerUrl = serviceWorkerUrl;
    this.worker = new Worker(workerUrl, { type: "module", name: "Workspace storage supervisor" });
    this.worker.onmessage = ({ data: m }: MessageEvent<Message>) => {
      if (m.type === "listen") this.listeners.set(Number(m.port), String(m.listenerId));
      if (m.type === "unlisten") this.listeners.delete(Number(m.port));
      if (m.type === "vv-reply") {
        const p = this.pending.get(Number(m.reqId));
        this.pending.delete(Number(m.reqId));
        if (m.ok === false) p?.reject(new Error(String(m.error)));
        else p?.resolve(m);
      }
      for (const h of this.handlers) h(m);
    };
    this.worker.onerror = (event) => this.destroy(new Error(event.message));
    this.worker.onmessageerror = () => this.destroy(new Error("Workspace worker message could not be decoded"));
  }
  static async open(distribution: Distribution, signal?: AbortSignal, diagnostics?: ReturnType<typeof diagnosticReporter>): Promise<Host> {
    signal?.throwIfAborted();
    if (!globalThis.crossOriginIsolated) throw new WorkspaceError("BACKEND_UNAVAILABLE", "Workspace requires COOP same-origin and COEP require-corp");
    const base = new URL(distribution.assetBaseUrl.replace(/\/?$/, "/"), location.href);
    diagnostics?.emit("manifest.fetch", { version: distribution.version });
    const response = await fetch(new URL("distribution.json", base), { signal });
    if (!response.ok) throw new Error(`Distribution manifest: HTTP ${response.status}`);
    const manifest = await response.json() as { abi: string; version: string; kernelWorker: string; serviceWorker: string; features?: string[] };
    if (manifest.abi !== "workspace-v2-sab6-sqlite39" || manifest.version !== distribution.version
      || !["install-tree-v1", "http-stream-v1", "workspace-flush-v1"].every(feature => manifest.features?.includes(feature))) throw new WorkspaceError("DISTRIBUTION_MISMATCH", "Distribution ABI/version/features mismatch");
    diagnostics?.emit("worker.create");
    const host = new Host(new URL(manifest.kernelWorker, base).href, new URL(manifest.serviceWorker, base).href);
    for (const feature of manifest.features ?? []) host.features.add(feature);
    try {
      await new Promise<void>((resolve, reject) => {
        const milestones = new Set<string>();
        const timer = setTimeout(() => done(new Error("Workspace boot timed out")), 120_000);
        const abort = () => done(signal?.reason ?? new Error("Aborted"));
        const off = host.on(m => {
          // Classify boot output without forwarding arbitrary worker text or paths.
          if (m.type === "log") {
            const category = /\b(opfs|restore|wasm|kernel|mount|snapshot)\b/i.exec(String(m.line))?.[1]?.toLowerCase();
            if (category && !milestones.has(category)) { milestones.add(category); diagnostics?.emit(`worker.log.${category}`); }
          }
          if (m.type === "workspace-persistence") diagnostics?.emit("worker.persistence", { status: m.status });
          if (m.type === "ready") done();
          if (m.type === "host-error") done(new Error(String(m.error)));
          if (m.type === "log" && String(m.line).startsWith("kernel worker boot failed:")) done(new Error(String(m.line)));
        });
        function done(error?: Error) { clearTimeout(timer); off(); signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(); }
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        diagnostics?.emit("worker.init.sent");
        host.post("init", { compress: true });
      });
      diagnostics?.emit("worker.ready");
      return host;
    } catch (error) { host.destroy(); throw error; }
  }
  on(listener: Listener): () => void { this.handlers.add(listener); return () => { this.handlers.delete(listener); }; }
  async persistence(): Promise<PersistenceState> { return (await this.request("workspace-persistence")).persistence as PersistenceState; }
  async flush(): Promise<void> { await this.request("workspace-flush"); }
  async readFile(path: string): Promise<Uint8Array> { return (await this.request("workspace-read", { path })).bytes as Uint8Array; }
  async writeFile(path: string, bytes: string | Uint8Array): Promise<void> { await this.request("workspace-write", { path, bytes }); }
  async mkdir(path: string): Promise<void> { await this.request("vv-mkdirp", { path }); }
  async rename(from: string, to: string): Promise<void> { await this.request("vv-rename", { from, to }); }
  async remove(path: string): Promise<void> { await this.request("vv-rm", { path }); }
  async stat(path: string): Promise<{ exists: boolean; isDirectory: boolean; isFile: boolean; size: number }> {
    const m = await this.request("vv-stat", { path });
    return { exists: !!m.exists, isDirectory: !!m.isDir, isFile: !!m.exists && !m.isDir, size: Number(m.size) };
  }
  async readdir(path: string): Promise<string[]> {
    return ((await this.request("vv-readdir", { path })).entries as { name: string }[]).map(e => e.name);
  }
  async installTree(tree: { roots: string[]; entries: InstallTreeEntry[] }): Promise<TreeInstallResult> {
    if (!this.features.has("install-tree-v1")) throw new Error("Runtime lacks verified tree installation");
    const result = await this.request("workspace-install-tree", tree);
    return { files: Number(result.files), verifyMs: Number(result.verifyMs), installMs: Number(result.installMs), readbackMs: Number(result.readbackMs) };
  }
  onMutation(listener: (path: string) => void): () => void {
    return this.on(m => { if (m.type === "vv-fs-changed") listener(String(m.path)); });
  }
  onPersistence(listener: (state: PersistenceState) => void): () => void {
    return this.on(m => { if (m.type === "workspace-persistence") listener(m as unknown as PersistenceState); });
  }
  waitForListener(port: number, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const cleanup = () => { off(); signal.removeEventListener("abort", abort); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const finish = (id: string) => { cleanup(); resolve(id); };
      const off = this.on(m => {
        if (m.type === "listen" && m.port === port) finish(String(m.listenerId));
        if (m.type === "host-error") { cleanup(); reject(new Error(String(m.error))); }
      });
      signal.addEventListener("abort", abort, { once: true });
      const existing = this.listeners.get(port);
      if (this.dead) { cleanup(); reject(new WorkspaceError("CLOSED", "Workspace host closed")); }
      else if (existing) finish(existing);
    });
  }
  post(type: string, data: Record<string, unknown> = {}, transfer: Transferable[] = []): void {
    if (this.dead) throw new WorkspaceError("CLOSED", "Workspace host is closed");
    this.worker.postMessage({ type, ...data }, transfer);
  }
  request(type: string, data: Record<string, unknown> = {}): Promise<Message> {
    return new Promise((resolve, reject) => {
      const reqId = this.sequence++;
      this.pending.set(reqId, { resolve, reject });
      try { this.post(type, { ...data, reqId }); } catch (e) { this.pending.delete(reqId); reject(e); }
    });
  }
  private swReady?: Promise<void>;
  registerPreview(): Promise<void> {
    return this.swReady ??= (async () => {
      await navigator.serviceWorker.register(this.serviceWorkerUrl, { scope: "/" });
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise<void>((resolve, reject) => {
        const done = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener("controllerchange", done); resolve(); };
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener("controllerchange", done); reject(new Error("Service worker did not take control")); }, 10_000);
        navigator.serviceWorker.addEventListener("controllerchange", done);
      });
      const announce = () => {
        navigator.serviceWorker.controller?.postMessage({ type: "vv-kernel-host" });
        navigator.serviceWorker.controller?.postMessage({ type: "vv-devtools", enabled: false });
      };
      const relay = (event: MessageEvent) => {
        if (event.data?.type === "vv-http" && event.ports[0]) this.post("vv-http", { req: event.data.req }, [event.ports[0]]);
      };
      navigator.serviceWorker.addEventListener("message", relay);
      navigator.serviceWorker.addEventListener("controllerchange", announce);
      this.cleanup.push(() => { navigator.serviceWorker.removeEventListener("message", relay); navigator.serviceWorker.removeEventListener("controllerchange", announce); });
      announce();
    })();
  }
  destroy(error: Error = new WorkspaceError("CLOSED", "Workspace closed")): void {
    if (this.dead) return;
    this.dead = true;
    for (const h of this.handlers) h({ type: "host-error", error: error.message });
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear(); this.handlers.clear();
    for (const cleanup of this.cleanup) cleanup();
  }
}
