import type { Endpoint, PreviewAttachment, PreviewOptions } from "../types.js";
import type { Host } from "../host.js";
export type { PreviewAttachment, PreviewOptions } from "../types.js";
/** Compatibility helper: the endpoint owns attachment, including across package copies. */
export function attachPreview(iframe: HTMLIFrameElement, endpoint: Endpoint, options: PreviewOptions = {}): PreviewAttachment {
  return endpoint.attachPreview(iframe, options);
}
/** Internal implementation, invoked only by the endpoint that owns the transport. */
export function attachEndpointPreview(iframe: HTMLIFrameElement, endpoint: Endpoint, internal: { host: Host; check(): void }, options: PreviewOptions = {}): PreviewAttachment {
  const paths = options.hostPaths ?? [];
  if (paths.length > 32 || paths.some(path => !/^\/[A-Za-z0-9_/-]+$/.test(path) || path.includes("//") || path.endsWith("/"))) throw Error("hostPaths must be up to 32 root-absolute segment prefixes, without trailing slash");
  const previewUrl = new URL(endpoint.url);
  if (paths.length) previewUrl.searchParams.set("__vv_host_paths", JSON.stringify(paths));
  internal.check();
  const { host } = internal;
  const origin = new URL(endpoint.url).origin;
  const connections = new Map<string, string>();
  const connectionPrefix = crypto.randomUUID() + ":";
  let disposed = false;
  const receive = (event: MessageEvent) => {
    if (disposed || event.source !== iframe.contentWindow || event.origin !== origin) return;
    const d = event.data;
    if (!d || d.dir !== "out" || !["vv-ws", "vv-sse"].includes(d.type) || typeof d.connId !== "string") return;
    try { internal.check(); } catch { dispose(); return; }
    if (d.sub === "open") {
      if (connections.has(d.connId) || connections.size >= 128) return;
      connections.set(d.connId, d.type);
    } else if (connections.get(d.connId) !== d.type) return;
    host.post(d.type, { msg: { ...d, connId: connectionPrefix + d.connId } });
    if (d.sub === "close") connections.delete(d.connId);
  };
  const off = host.on(m => {
    if (m.type !== "vv-ws" && m.type !== "vv-sse") return;
    const message = m.msg as { connId?: string; sub?: string } | undefined;
    if (!message?.connId?.startsWith(connectionPrefix)) return;
    const connId = message.connId.slice(connectionPrefix.length);
    if (connections.get(connId) !== m.type) return;
    iframe.contentWindow?.postMessage({ ...message, connId, type: m.type, dir: "in" }, origin);
    if (message.sub === "close") connections.delete(connId);
  });
  function dispose() {
    if (disposed) return;
    disposed = true; window.removeEventListener("message", receive); off();
    for (const [connId, type] of connections) {
      try { host.post(type, { msg: { type, dir: "out", sub: "close", connId: connectionPrefix + connId } }); } catch { /* host closed */ }
    }
    connections.clear();
    iframe.src = "about:blank";
  }
  window.addEventListener("message", receive);
  // Preview registration is lazy; programmatic Endpoint.fetch needs no SW.
  iframe.src = "about:blank";
  void host.registerPreview().then(() => {
    if (disposed) return;
    try { internal.check(); } catch { dispose(); return; }
    iframe.src = previewUrl.href;
  }).catch(error => {
    if (disposed) return;
    dispose();
    iframe.dispatchEvent(new ErrorEvent("error", { error, message: String(error) }));
  });
  void endpoint.closed.then(dispose);
  return { dispose };
}
