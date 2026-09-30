// Private companion to Vivari's runtime HTTP stream v1. Credits cover messages
// in transit as well as queued bytes: at most one 64 KiB chunk each direction.
const CHUNK_BYTES = 64 * 1024;
export function fetchHttpStream(channel: MessagePort, request: Request, onClose: () => void = () => {}, onCleanup: (settled: Promise<void>) => void = () => {}): Promise<Response> {
  let finish!: () => void, failed!: (reason: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => { finish = resolve; failed = reject; });
  // Observe without changing the exported receipt's rejected state.
  void settled.catch(() => {});
  onCleanup(settled);
  return new Promise((resolve, reject) => {
    let closed = false, receivedHeaders = false, pulling = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    let pulled: (() => void) | undefined;
    let upload: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try { upload = request.body?.getReader(); }
    catch (error) { channel.close(); failed(error); onClose(); reject(error); return; }
    let pending: Uint8Array | undefined, offset = 0, uploading = false;
    const tasks = new Set<Promise<void>>();
    const failures: unknown[] = [];
    const send = (op: string, extra = {}) => channel.postMessage({ op, ...extra });
    const cleanup = () => {
      if (closed) return settled;
      closed = true;
      request.signal.removeEventListener("abort", abort);
      try { channel.close(); } catch (error) { failures.push(error); }
      pending = undefined;
      pulled?.(); pulled = undefined;
      try { onClose(); } catch (error) { failures.push(error); }
      // Cancel promptly, then join read continuations as well as source cancel.
      // A read task may call fail/cleanup: it must never await its own receipt.
      const cancellation = Promise.resolve().then(() => upload?.cancel());
      void (async () => {
        const results = await Promise.allSettled([cancellation, ...tasks]);
        for (const result of results) if (result.status === "rejected") failures.push(result.reason);
        try { upload?.releaseLock(); } catch (error) { failures.push(error); }
        if (failures.length) failed(new AggregateError(failures, "HTTP source cleanup failed"));
        else finish();
      })();
      return settled;
    };
    const fail = (reason: unknown) => {
      if (closed) return;
      try { send("cancel"); } catch (error) { failures.push(error); }
      reject(reason);
      controller.error(reason);
      cleanup();
    };
    const abort = () => fail(request.signal.reason);
    const body = new ReadableStream<Uint8Array>({
      start(value) { controller = value; },
      pull() {
        if (closed) return;
        pulling = true;
        send("pull");
        return new Promise<void>(resolve => { pulled = resolve; });
      },
      cancel(reason) { fail(reason ?? new Error("HTTP response cancelled")); return settled; },
    }, { highWaterMark: 0 });
    const writeUpload = async () => {
      if (closed) return;
      if (uploading) throw new Error("Duplicate HTTP upload credit");
      uploading = true;
      try {
        while (!pending || offset === pending.byteLength) {
          const next = await upload?.read();
          if (closed) return;
          if (!next || next.done) { send("upload-end"); return; }
          pending = next.value; offset = 0;
        }
        const bytes = pending.slice(offset, offset + CHUNK_BYTES);
        offset += bytes.byteLength;
        send("upload", { bytes });
      } finally { uploading = false; }
    };
    channel.onmessage = ({ data: message }) => {
      if (closed) return;
      try {
        if (message.op === "headers") {
          if (receivedHeaders) throw new Error("Duplicate HTTP headers");
          receivedHeaders = true;
          const headers = new Headers();
          for (let i = 0; i < message.headers.length; i += 2) headers.append(message.headers[i], message.headers[i + 1]);
          const noBody = request.method === "HEAD" || [204, 205, 304].includes(message.status);
          resolve(new Response(noBody ? null : body, { status: message.status, statusText: message.statusText, headers }));
          // Drain EOF for bodyless responses even though Fetch exposes no stream.
           if (noBody) void body.cancel().catch(() => {}); // failure remains in settled
        } else if (message.op === "upload-credit") {
          // Register before invoking user-source read: pull may abort reentrantly.
          const task = Promise.resolve().then(writeUpload);
          tasks.add(task);
          void task.then(() => tasks.delete(task), error => {
            // Keep a rejected task until cleanup snapshots it, including late reads.
            fail(error);
          });
        } else if (message.op === "data") {
          if (!receivedHeaders || !pulling || !(message.bytes instanceof Uint8Array) || message.bytes.byteLength > CHUNK_BYTES) throw new Error("Invalid HTTP response chunk/credit");
          pulling = false;
          controller.enqueue(message.bytes);
          pulled?.(); pulled = undefined;
        } else if (message.op === "end") {
          if (!receivedHeaders) throw new Error("HTTP response ended before headers");
          controller.close(); cleanup();
        } else if (message.op === "error") fail(new Error(message.error));
        else throw new Error("Unknown HTTP stream message");
      } catch (error) { fail(error); }
    };
    channel.onmessageerror = () => fail(new Error("HTTP channel failed"));
    channel.start();
    request.signal.addEventListener("abort", abort, { once: true });
    if (request.signal.aborted) abort();
  });
}
