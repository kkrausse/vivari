import { parentPort, workerData } from "node:worker_threads";
import { makeViews } from "../../packages/protocol/syscall.js";
import { createSyscalls } from "../../packages/runtime/fs-client.js";

const { sab, port, path, length } = workerData;
const sys = createSyscalls({ ...makeViews(sab), notify: () => port.postMessage({}) });
let code;
try { sys.readFile(path); } catch (error) { code = error.code; }
parentPort.postMessage({ phase: "rejected", code });
// Parent checks the actual Rust VFS and kernel pin before permitting the retry.
await new Promise(resolve => parentPort.once("message", resolve));
const fd = sys.open(path, 0, 0);
const out = new Uint8Array(length);
let offset = 0;
while (offset < length) {
  const bytes = sys.fdRead(fd, length - offset, offset);
  if (!bytes.length) throw new Error("unexpected EOF during fetched-body retry");
  out.set(bytes, offset);
  offset += bytes.length;
}
for (let i = 0; i < length; i++) if (out[i] !== i % 251) throw new Error(`body mismatch at ${i}`);
parentPort.postMessage({ phase: "read", length: offset });
await new Promise(resolve => parentPort.once("message", resolve));
sys.close(fd);
parentPort.postMessage({ phase: "closed" });
port.close();
