// Diagnostic reads only: never decode payloads, write a guest SAB, or await a
// worker. Samples are individual atomic reads, not a transactional wire snapshot.
import { I_STATE, I_OPCODE, I_REQ_LEN, I_RES_LEN } from "../protocol/syscall.js";

export function sampleSyscallControl(ctrl) {
  if (!ctrl) return null;
  return {
    state: Atomics.load(ctrl, I_STATE),
    opcode: Atomics.load(ctrl, I_OPCODE),
    requestBytes: Atomics.load(ctrl, I_REQ_LEN),
    responseBytes: Atomics.load(ctrl, I_RES_LEN),
  };
}

export function createSyscallTrace() {
  const capacity = 64;
  const entries = new Array(capacity);
  let sequence = 0;
  return {
    record(pid, phase, ctrl = null, details = {}) {
      // Only explicit scalar metadata crosses this diagnostic boundary. No env,
      // argv, filesystem request fields, guest data, stacks, or transferables are retained.
      const entry = { sequence: ++sequence, pid, phase, control: sampleSyscallControl(ctrl) };
      for (const key of ["command", "childPid", "dispatchedOpcode", "lazy", "pending", "errorName"]) {
        const value = details[key];
        if (typeof value === "string") entry[key] = value.slice(0, 128);
        else if (typeof value === "number" || typeof value === "boolean") entry[key] = value;
      }
      entries[(sequence - 1) % capacity] = entry;
    },
    snapshot() {
      const events = [];
      for (let n = Math.max(1, sequence - capacity + 1); n <= sequence; n++) {
        const entry = entries[(n - 1) % capacity];
        events.push({ ...entry, control: entry.control && { ...entry.control } });
      }
      return { version: "single-kernel-routing-diagnostic-1", capacity, total: sequence, events };
    },
  };
}

export function sampleSyscallClients(kernel, server) {
  return [...server.clients].map(([pid, client]) => {
    const proc = kernel.procs.get(pid);
    return {
      pid,
      filesystemControl: sampleSyscallControl(client.ctrl),
      kernelControl: sampleSyscallControl(proc?.ctrl),
      sameSab: proc ? client.ctrl.buffer === proc.ctrl.buffer : null,
    };
  });
}
