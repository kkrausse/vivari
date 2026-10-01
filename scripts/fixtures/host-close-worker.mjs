import { parentPort } from "node:worker_threads";
const channels = new Set();
let cancellations = 0;
parentPort.on("message", message => {
  if (message.type === "init") parentPort.postMessage({ type: "ready" });
  else if (message.type === "workspace-http-stream") {
    const channel = message.channel;
    channels.add(channel);
    let sent = false;
    channel.on("message", frame => {
      if (frame.op === "cancel") {
        cancellations++;
        channels.delete(channel); channel.close();
      } else if (frame.op === "pull") {
        if (!sent) { sent = true; channel.postMessage({ op: "data", bytes: Uint8Array.of(0, 255, 128, 65) }); }
        else { channel.postMessage({ op: "end" }); channels.delete(channel); channel.close(); }
      }
    });
    if (message.request.path !== "/never") channel.postMessage({ op: "headers", status: 200, headers: [] });
  } else if (message.type === "vv-stat") parentPort.postMessage({ type: "vv-reply", reqId: message.reqId, ok: true, exists: true, isDir: false });
  else if (message.type === "proc-spawn") parentPort.postMessage({ type: "proc-started", execId: message.execId });
  else if (message.type === "workspace-flush") parentPort.postMessage({ type: "vv-reply", reqId: message.reqId, ok: true });
  else if (message.type === "fixture-state") {
    // A parentPort message and a transferred-port message have no total order.
    // Wait for the fixture's actual close predicate, not a delay as an oracle.
    const reply = () => {
      if (channels.size) { setImmediate(reply); return; }
      parentPort.postMessage({ type: "vv-reply", reqId: message.reqId, channels: channels.size, cancellations });
    };
    reply();
  }
});
