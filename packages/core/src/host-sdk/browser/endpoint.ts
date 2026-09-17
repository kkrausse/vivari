import type { Host } from "../host.js";
import { attachEndpointPreview } from "./preview.js";
import { fetchHttpStream } from "./http-stream.js";
import { WorkspaceError, type Endpoint } from "../types.js";

export function createEndpoint(host: Host, port: number, listenerId: string, runtimeSignal: AbortSignal): Endpoint {
  if (host.listeners.get(port) !== listenerId) throw new WorkspaceError("CLOSED", "Listener closed before endpoint attachment");
  let reason: string | undefined;
  let disposed = false, active = 0;
  let close!: (value: { reason: string }) => void;
  const closed = new Promise<{ reason: string }>(resolve => { close = resolve; });
  const lifetime = new AbortController();
  const check = () => {
    if (reason || host.listeners.get(port) !== listenerId) throw new WorkspaceError("CLOSED", reason ?? "Listener closed");
  };
  const dispose = (why = "Endpoint disposed") => {
    if (disposed) return;
    disposed = true;
    reason ??= why; off(); runtimeSignal.removeEventListener("abort", stop);
    lifetime.abort(new WorkspaceError("CLOSED", why)); close({ reason });
  };
  const stop = () => dispose("Runtime stopped");
  const off = host.on(m => {
    if (m.type === "unlisten" && m.listenerId === listenerId) {
      // Node server.close stops accepting, but accepted responses may still drain.
      reason ??= "Listener closed"; close({ reason });
      if (!active) dispose(reason);
    }
    if (m.type === "host-error" || (m.type === "listen" && m.port === port && m.listenerId !== listenerId)) dispose("Listener closed");
  });
  runtimeSignal.addEventListener("abort", stop, { once: true });
  const endpoint: Endpoint = {
    url: new URL(`/preview/${port}/?__vv_listener=${encodeURIComponent(listenerId)}`, location.href).href,
    port, closed, dispose,
    attachPreview(iframe, options) { return attachEndpointPreview(iframe, endpoint, { host, check }, options); },
    async fetch(input, init = {}) {
      check();
      const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;
      signal.throwIfAborted();
      const url = new URL(input, `http://workspace.invalid/`);
      if (url.origin !== "http://workspace.invalid" && url.origin !== new URL(endpoint.url).origin) throw new Error("Endpoint.fetch accepts relative paths or its own preview URL");
      let path = url.pathname + url.search;
      if (url.origin !== "http://workspace.invalid") {
        const prefix = `/preview/${port}/`;
        if (!url.pathname.startsWith(prefix)) throw new Error("URL belongs to another endpoint");
        // Preserve unrelated bare query flags (Vite distinguishes ?url from ?url=).
        url.search = url.search.slice(1).split('&').filter(part => part.split('=')[0] !== '__vv_listener').join('&');
        path = "/" + url.pathname.slice(prefix.length) + url.search;
      }
      const request = new Request("http://workspace.invalid" + path, { ...init, signal, duplex: "half" } as RequestInit);
      const metadata = { path, method: request.method, headers: Object.fromEntries(request.headers) };
      if (JSON.stringify(metadata).length > 65536) throw new RangeError("HTTP request metadata exceeds 64 KiB");
      const { port1, port2 } = new MessageChannel();
      try {
        host.post("workspace-http-stream", { port, listenerId, request: metadata }, [port2]);
        active++;
        return fetchHttpStream(port1, request, () => { active--; if (reason && !active) dispose(reason); });
      } catch (error) { port1.close(); port2.close(); throw error; }
    },
  };
  return endpoint;
}
