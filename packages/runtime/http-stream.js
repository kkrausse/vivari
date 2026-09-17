// Runtime-owned HTTP in the listener's existing process. One 64 KiB chunk per
// credit in each direction; upload credit acknowledges Node write consumption.
export const HTTP_CHUNK_BYTES = 64 * 1024;
export function createHttpStreamBridge({ http, Buffer, send, liveness }) {
  const requests = new Map();
  return (message) => {
    const { id, op } = message;
    if (op === "open") {
      if (requests.has(id)) return;
      const state = { request: null, response: null, credit: false, uploading: false, uploadEnded: false, closed: false };
      const emit = (op, data = {}) => send({ type: "http-stream-out", id, op, ...data });
      const finish = (error) => {
        if (state.closed) return;
        state.closed = true;
        requests.delete(id);
        liveness.active = requests.size;
        emit(error ? "error" : "end", error ? { error: String(error.message || error) } : {});
        state.response?.destroy();
        state.request?.destroy();
      };
      state.finish = finish;
      state.pump = () => {
        const response = state.response;
        if (!response || state.closed) return;
        response.read(0);
        if (!state.credit || !response.readableLength) return;
        const chunk = response.read(Math.min(response.readableLength, HTTP_CHUNK_BYTES));
        if (chunk === null) return;
        state.credit = false;
        emit("data", { bytes: new Uint8Array(chunk) });
      };
      requests.set(id, state);
      liveness.active = requests.size;
      try {
        const headers = { ...message.headers, connection: "close" };
        delete headers["transfer-encoding"];
        delete headers["upgrade"];
        state.request = http.request({
          hostname: "127.0.0.1", port: message.port, path: message.path,
          method: message.method, headers, agent: false, maxHeaderSize: 65536,
        }, response => {
          state.response = response;
          emit("headers", { status: response.statusCode, statusText: response.statusMessage, headers: response.rawHeaders });
          response.on("readable", state.pump);
          response.on("end", () => finish());
          response.on("error", finish);
          response.on("close", () => { if (!response.complete) finish(new Error("HTTP response closed before EOF")); });
          state.pump();
        });
        state.request.on("error", finish);
        state.request.on("close", () => { if (!state.closed && !state.response?.complete) finish(new Error("HTTP connection closed")); });
        state.request.flushHeaders();
        emit("upload-credit");
      } catch (error) { finish(error); }
      return;
    }
    const state = requests.get(id);
    if (!state) return;
    if (op === "cancel") { state.finish(new Error("HTTP request cancelled")); return; }
    if (op === "pull") {
      if (state.credit) { state.finish(new Error("Duplicate HTTP response credit")); return; }
      state.credit = true;
      state.pump();
    } else if (op === "upload") {
      const bytes = message.bytes;
      if (state.uploading || state.uploadEnded || !(bytes instanceof Uint8Array) || bytes.byteLength > HTTP_CHUNK_BYTES || !bytes.byteLength) {
        state.finish(new Error("Invalid HTTP upload credit/chunk")); return;
      }
      state.uploading = true;
      state.request.write(Buffer.from(bytes), error => {
        state.uploading = false;
        if (error) state.finish(error);
        else if (!state.closed) send({ type: "http-stream-out", id, op: "upload-credit" });
      });
    } else if (op === "upload-end") {
      if (state.uploading || state.uploadEnded) { state.finish(new Error("Invalid HTTP upload EOF")); return; }
      state.uploadEnded = true;
      state.request.end();
    } else state.finish(new Error("Unknown HTTP stream operation"));
  };
}
