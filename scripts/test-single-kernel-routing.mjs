// Deterministic diagnostic contract, not browser hang qualification. Real guest
// workers and MessagePort FS doorbells share the Rust VFS with the supervisor.
import assert from "node:assert/strict";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";
import { createSyscallTrace, sampleSyscallClients } from "../packages/kernel-host/syscall-trace.js";
import { makeViews, SAB_BYTES, STATE_REQUEST, OP_SPAWN, OP_SPAWN_ASYNC, isFsOpcode } from "../packages/protocol/syscall.js";

const deadline = setTimeout(() => { console.error("FAIL routing diagnostic deadline"); process.exit(1); }, 20000);
const { ctrl } = makeViews(new SharedArrayBuffer(SAB_BYTES));
const trace = createSyscallTrace();
const untouched = Array.from(ctrl);
for (let n = 0; n < 100; n++) trace.record(1, "test", ctrl, { command: "x".repeat(1000), env: "must-not-retain", args: ["secret"] });
const snapshot = trace.snapshot();
assert.equal(snapshot.capacity, 64);
assert.equal(snapshot.events.length, 64);
assert.deepEqual(snapshot.events.map(e => e.sequence), Array.from({ length: 64 }, (_, n) => n + 37));
assert.equal(snapshot.events[0].command.length, 128);
assert.ok(!JSON.stringify(snapshot).includes("secret"));
assert.ok(!JSON.stringify(snapshot).includes("must-not-retain"));
snapshot.events[0].control.state = 999;
assert.notEqual(trace.snapshot().events[0].control.state, 999);
assert.deepEqual(Array.from(ctrl), untouched);

const h = await bootSpikeKernel();
const spawning = [];
const spawnWorker = h.kernel.spawnWorker;
h.kernel.spawnWorker = info => {
  spawning.push(h.kernel.syscallTrace.snapshot());
  return spawnWorker(info); // observe, never substitute/skip the real worker
};
try {
  writeProject(h.kernel, "/app", {
    "child.js": `const fs=require('fs'); if(fs.readFileSync('/app/existing','utf8')!=='fixture') throw Error('fixture'); fs.writeFileSync('/app/child-done','ok'); process.stdout.write('child-ok');`,
    "existing": "fixture",
  });
  for (const mode of ["async", "spawnSync", "execSync"]) {
    const command = mode === "execSync" ? "sh" : "node";
    const opcode = mode === "async" ? OP_SPAWN_ASYNC : OP_SPAWN;
    let release, entered;
    const gate = new Promise(resolve => { release = resolve; });
    const atGate = new Promise(resolve => { entered = resolve; });
    h.kernel.registerLazyProgram(command, () => { entered(); return gate; });
    const common = `const fs=require('fs');fs.writeFileSync('/app/parent-before','ok');const cp=require('child_process');`;
    const action = mode === "async"
      ? `const child=cp.spawn('node',['/app/child.js']);let out='';child.stdout.on('data',x=>out+=x);child.on('close',code=>{if(code!==0||out!=='child-ok')throw Error('async result');console.log('parent-ok');});`
      : mode === "spawnSync"
        ? `const r=cp.spawnSync('node',['/app/child.js']);if(r.error||r.status!==0||String(r.stdout)!=='child-ok')throw Error('sync result');console.log('parent-ok');`
        : `const r=cp.execSync('node /app/child.js',{maxBuffer:65536});if(String(r)!=='child-ok')throw Error('exec result');console.log('parent-ok');`;
    h.kernel.writeFile("/app/parent.js", common + action);
    const result = h.kernel.start("node", ["/app/parent.js"], { cwd: "/app", capture: true });
    await atGate;
    // Observe after serviceSyscall has returned, with the actual guest parked.
    await new Promise(resolve => setImmediate(resolve));
    const [proc] = h.kernel.procs.values();
    const before = new Uint8Array(proc.ctrl.buffer).slice();
    const diag = h.kernel.diagnostics();
    const clients = sampleSyscallClients(h.kernel, h.filesystem.server);
    assert.equal(clients.length, 1);
    assert.equal(clients[0].sameSab, true);
    assert.deepEqual(clients[0].filesystemControl, clients[0].kernelControl);
    assert.equal(diag.procs[0].syscallControl.state, STATE_REQUEST);
    assert.equal(diag.procs[0].syscallControl.opcode, opcode);
    assert.deepEqual(new Uint8Array(proc.ctrl.buffer), before, "diagnostics leave the entire guest SAB untouched");
    const events = diag.syscallTrace.events.filter(e => e.pid === proc.pid);
    const prefix = mode === "async" ? "spawn-async" : "spawn";
    const phases = events.map(e => e.phase);
    for (const phase of ["fs-doorbell", "fs-dispatch-before", "kernel-doorbell", "kernel-dispatch-before", `${prefix}-enter`, `${prefix}-load-before`, "kernel-dispatch-after"]) assert.ok(phases.includes(phase), `${mode}: missing ${phase}`);
    assert.ok(!phases.includes(`${prefix}-load-after`), "gate continuation cannot run before release");
    assert.ok(events.filter(e => e.phase === "fs-doorbell").every(e => isFsOpcode(e.control.opcode)));
    assert.equal(events.findLast(e => e.phase === "kernel-doorbell").control.opcode, opcode);
    assert.equal(events.findLast(e => e.phase === "kernel-dispatch-before").dispatchedOpcode, opcode);
    assert.equal(events.findLast(e => e.phase === `${prefix}-load-before`).lazy, true);
    assert.equal(events.findLast(e => e.phase === "kernel-dispatch-after").pending, true);
    // The same helper detects mismatched registration without repairing/mutating it.
    assert.equal(sampleSyscallClients(h.kernel, { clients: new Map([[proc.pid, { ctrl }]]) })[0].sameSab, false);
    release();
    const completed = await result;
    assert.equal(completed.code, 0, completed.stderr);
    assert.match(completed.stdout, /parent-ok/);
    assert.equal(h.kernel.readFile("/app/child-done"), "ok");
    assert.equal(h.filesystem.server.clients.size, 0);
    assert.equal(sampleSyscallClients(h.kernel, h.filesystem.server).length, 0);
    assert.ok(spawning.some(s => s.events.some(e => e.pid === proc.pid && e.phase === `${prefix}-load-after`)), "real child creation observes the gate continuation");
    assert.ok(spawning.some(s => s.events.some(e => e.pid === proc.pid && e.phase === `${prefix}-create-before`)), "real child worker path observes creation dispatch");
  }
  // Select an unexpected kernel dispatch throw while a real guest is parked;
  // its existing errno release must still work with diagnostics installed.
  h.kernel.writeFile("/app/error.js", `const r=require('child_process').spawnSync('node',['/app/child.js']);if(!r.error||r.error.code!=='EINVAL')throw Error('expected errno');console.log('error-ok');`);
  const dispatch = h.kernel.dispatchSyscall;
  h.kernel.dispatchSyscall = () => { throw new Error("routing-test-dispatch-fault"); };
  try {
    const res = await h.kernel.start("node", ["/app/error.js"], { cwd: "/app", capture: true });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /error-ok/);
    const phases = h.kernel.diagnostics().syscallTrace.events.filter(e => e.pid === res.pid).map(e => e.phase);
    assert.ok(phases.includes("kernel-dispatch-error"));
    assert.ok(phases.includes("kernel-response-error-before"));
  } finally {
    h.kernel.dispatchSyscall = dispatch;
  }
} finally {
  for (const pid of [...h.kernel.procs.keys()]) h.kernel.signal(pid, "SIGKILL");
  clearTimeout(deadline);
}
console.log("PASS bounded read-only syscall routing diagnostics; real guest async/spawnSync/execSync and FS ports");
process.exit(0);
