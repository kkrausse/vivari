// Exact large/binary synchronous child contract over real guest SABs/FS ports.
import assert from "node:assert/strict";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";
import { makeViews, SAB_BYTES, DATA_BYTES, I_STATE, I_RES_LEN, STATE_REQUEST, STATE_RESPONSE_OK, STATE_RESPONSE_ERR, OP_OPEN, decodeBytes } from "../packages/protocol/syscall.js";

const deadline = setTimeout(() => { console.error("FAIL sync capture deadline"); process.exit(1); }, 30000);
const h = await bootSpikeKernel();
try {
  const originalBytes = Uint8Array.from({ length: 1048583 }, (_, i) => i % 251);
  const legacyText = new TextDecoder().decode(originalBytes);
  const legacyFrame = new TextEncoder().encode(JSON.stringify({ code: 0, stdout: legacyText, stderr: "", pid: 9 }));
  assert.ok(legacyFrame.length > DATA_BYTES, "old text/JSON capture provably overflows the fixed SAB");
  assert.notDeepEqual(new TextEncoder().encode(legacyText), originalBytes, "old UTF-8 capture corrupts raw binary");
  // Response boundary is the actual protocol window, not an enlarged test SAB.
  const { ctrl, data } = makeViews(new SharedArrayBuffer(SAB_BYTES));
  const proc = { pid: -1, ctrl, data };
  Atomics.store(ctrl, I_STATE, STATE_REQUEST);
  h.kernel.respondOk(proc, new Uint8Array(DATA_BYTES));
  assert.equal(Atomics.load(ctrl, I_STATE), STATE_RESPONSE_OK);
  assert.equal(Atomics.load(ctrl, I_RES_LEN), DATA_BYTES);
  Atomics.store(ctrl, I_STATE, STATE_REQUEST);
  assert.doesNotThrow(() => h.kernel.respondOk(proc, new Uint8Array(DATA_BYTES + 1)));
  assert.equal(Atomics.load(ctrl, I_STATE), STATE_RESPONSE_ERR);
  assert.equal(decodeBytes(data.slice(0, Atomics.load(ctrl, I_RES_LEN))), "EFBIG");

  writeProject(h.kernel, "/workspace", {
    "binary.cjs": `const n=Number(process.argv[2]),b=Buffer.alloc(n);for(let i=0;i<n;i++)b[i]=i%251;for(let p=0;p<n;p+=65537)process.stdout.write(b.subarray(p,p+65537));if(process.argv[3]==='both')for(let p=0;p<n;p+=65537)process.stderr.write(b.subarray(p,p+65537));`,
    "parent.cjs": `const cp=require('child_process'),fs=require('fs');
const check=(b,n)=>{if(!Buffer.isBuffer(b)||b.length!==n)throw Error('length '+b.length+' vs '+n);for(let i=0;i<n;i++)if(b[i]!==i%251)throw Error('binary byte '+i);};
for(const n of [0,255,700000,800000,1048583]){const r=cp.spawnSync('node',['/workspace/binary.cjs',String(n)],{maxBuffer:2097152});if(r.error||r.status!==0)throw Error('spawn status '+r.error);check(r.stdout,n);}
const both=cp.spawnSync('node',['/workspace/binary.cjs','1048583','both'],{maxBuffer:2097152});if(both.error||both.status!==0)throw Error('both status');check(both.stdout,1048583);check(both.stderr,1048583);
const overflow=cp.spawnSync('node',['/workspace/binary.cjs','1048583']);if(overflow.error?.code!=='ENOBUFS'||overflow.status!==null||overflow.signal!=='SIGTERM')throw Error('overflow result');check(overflow.stdout,1048576);
for(const run of [()=>cp.execSync('node /workspace/binary.cjs 255',{maxBuffer:16}),()=>cp.execFileSync('node',['/workspace/binary.cjs','255'],{maxBuffer:16})]){let error;try{run();}catch(e){error=e;}if(error?.code!=='ENOBUFS')throw Error('missing bounded error');check(error.stdout,16);}
const encoded=cp.execFileSync('node',['/workspace/binary.cjs','255'],{encoding:'latin1',maxBuffer:1000});if(typeof encoded!=='string'||encoded.length!==255||encoded.charCodeAt(200)!==200)throw Error('encoding');
if(fs.readdirSync('/var/run/vv-spawn').length)throw Error('spill not consumed');console.log('capture-boundaries-ok');`,
    // Original Chrome fixture: >1 MiB filesystem read, raw binary shell stdout,
    // allowed 2 MiB maxBuffer. The old tiny child-ok test never exercised this.
    "original.cjs": `const fs=require('node:fs'),cp=require('node:child_process');
const script='/workspace/sync-child.cjs';
fs.writeFileSync(script,\`const fs=require('node:fs');const b=Buffer.alloc(1048583);for(let i=0;i<b.length;i++)b[i]=i%251;fs.mkdirSync('/workspace/child-sync',{recursive:true});fs.writeFileSync('/workspace/child-sync/binary.dat',b);fs.renameSync('/workspace/child-sync/binary.dat','/workspace/child-sync/renamed.dat');fs.symlinkSync('renamed.dat','/workspace/child-sync/link');if(!fs.lstatSync('/workspace/child-sync/link').isSymbolicLink())throw Error('child lstat');process.stdout.write(fs.readFileSync('/workspace/child-sync/link'));\`);
const out=cp.execSync('node '+script,{maxBuffer:2097152});
if(out.length!==1048583)throw Error('execSync child output truncated '+out.length);
for(let i=0;i<out.length;i++)if(out[i]!==i%251)throw Error('execSync child byte corruption');
console.log(JSON.stringify({execSync:true,bytes:out.length,childLink:fs.readlinkSync('/workspace/child-sync/link')}));`,
    "fault.cjs": `const r=require('child_process').spawnSync('node',['/workspace/binary.cjs','1048583'],{maxBuffer:2097152});if(r.error?.code!=='EINVAL')throw Error('publication failure did not settle');console.log('fault-released');`,
    "live-cleanup.cjs": `const cp=require('child_process'),fs=require('fs');
const run=()=>cp.spawnSync('node',['/workspace/binary.cjs','800000','both'],{maxBuffer:2097152});
const first=run();if(!first.error)throw Error('expected initial read fault');fs.writeFileSync('/workspace/initial-ready','ok');
const wait=(path,done)=>{const t=setInterval(()=>{if(!fs.existsSync(path))return;clearInterval(t);done();},10);};
wait('/workspace/release-faults',()=>{for(let i=0;i<4;i++){const r=run();if(r.error?.code!=='EINVAL')throw Error('expected staging fault');}fs.writeFileSync('/workspace/faults-ready','ok');
wait('/workspace/release-success',()=>{const r=run();if(r.error||r.status!==0||r.stdout.length!==800000||r.stderr.length!==800000)throw Error('success capture');fs.writeFileSync('/workspace/success-ready','ok');
wait('/workspace/release-exit',()=>console.log('live-cleanup-ok'));});});`,
  });
  for (const entry of ["parent.cjs", "original.cjs"]) {
    const res = await h.kernel.start("node", ["/workspace/" + entry], { cwd: "/workspace", capture: true, env: entry === "original.cjs" ? { VV_BYTE_STDIO: "1" } : {} });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, entry === "parent.cjs" ? /capture-boundaries-ok/ : /"execSync":true,"bytes":1048583/);
    assert.equal(h.filesystem.server.clients.size, 0);
    assert.equal(h.kernel.spawnOutputOwners.size, 0);
    assert.deepEqual(h.kernel.readdir("/var/run/vv-spawn"), []);
  }
  // Fail the SECOND spill write from the deferred child-exit callback. The first
  // staged file must be reclaimed on parent exit and the guest must not hang.
  const writeFile = h.kernel.writeFile;
  h.kernel.writeFile = function(path, contents) {
    if (path.startsWith("/var/run/vv-spawn/") && path.endsWith("stderr.bin")) throw new Error("injected-stage-fault");
    return writeFile.call(this, path, contents);
  };
  try {
    const res = await h.kernel.start("node", ["/workspace/fault.cjs"], { cwd: "/workspace", capture: true });
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /fault-released/);
    assert.ok(h.kernel.diagnostics().syscallTrace.events.some(e => e.phase === "kernel-dispatch-error" && e.dispatchedOpcode === 20));
    assert.deepEqual(h.kernel.readdir("/var/run/vv-spawn"), []);
  } finally { h.kernel.writeFile = writeFile; }
  // Keep ONE real parent alive across four caught staging faults and a successful
  // capture. A prior invocation's unread stderr spill must survive all rollbacks.
  const waitFile = async path => {
    while (!h.kernel.exists(path)) await new Promise(resolve => setTimeout(resolve, 10));
  };
  const server = h.filesystem.server;
  const dispatch = server.dispatch;
  let readFault = true;
  server.dispatch = function(opcode, flags, fields, clientId) {
    if (readFault && opcode === OP_OPEN && decodeBytes(fields[0]).startsWith('/var/run/vv-spawn/') && decodeBytes(fields[0]).endsWith('stdout.bin')) {
      readFault = false;
      throw new Error('injected-spill-read-fault');
    }
    return dispatch.call(this, opcode, flags, fields, clientId);
  };
  try {
    const result = h.kernel.start('node', ['/workspace/live-cleanup.cjs'], { cwd: '/workspace', capture: true });
    await waitFile('/workspace/initial-ready');
    server.dispatch = dispatch;
    const [parent] = h.kernel.procs.values();
    const [previousPath] = parent.spawnOutputPaths;
    assert.ok(previousPath.endsWith('stderr.bin'));
    assert.equal(parent.spawnOutputPaths.size, 1);
    const previousBytes = h.kernel.readFileBytes(previousPath);
    assert.equal(previousBytes.length, 800000);
    h.kernel.writeFile = function(path, contents) {
      if (path.startsWith('/var/run/vv-spawn/') && path.endsWith('stderr.bin')) throw new Error('repeated-stage-fault');
      return writeFile.call(this, path, contents);
    };
    h.kernel.writeFile('/workspace/release-faults', 'ok');
    await waitFile('/workspace/faults-ready');
    assert.ok(h.kernel.procs.has(parent.pid), 'parent remains live after four caught errors');
    assert.deepEqual([...parent.spawnOutputPaths], [previousPath], 'rollback preserves only the earlier invocation');
    assert.deepEqual([...h.kernel.spawnOutputOwners.keys()], [previousPath]);
    assert.equal(h.kernel.diagnostics().spawnCapture.ownedSpills, 1);
    assert.equal(h.kernel.diagnostics().procs.find(p => p.pid === parent.pid).ownedSpawnSpills, 1);
    assert.deepEqual(h.kernel.readdir('/var/run/vv-spawn'), [previousPath.split('/').at(-1)]);
    assert.deepEqual(h.kernel.readFileBytes(previousPath), previousBytes);
    h.kernel.writeFile = writeFile;
    h.kernel.writeFile('/workspace/release-success', 'ok');
    await waitFile('/workspace/success-ready');
    assert.ok(h.kernel.procs.has(parent.pid), 'successful read/unlink is observed before parent exit');
    assert.deepEqual([...parent.spawnOutputPaths], [previousPath], 'success removes its own ownership records');
    assert.deepEqual([...h.kernel.spawnOutputOwners.keys()], [previousPath]);
    assert.deepEqual(h.kernel.readdir('/var/run/vv-spawn'), [previousPath.split('/').at(-1)]);
    h.kernel.writeFile('/workspace/release-exit', 'ok');
    const completed = await result;
    assert.equal(completed.code, 0, completed.stderr);
    assert.match(completed.stdout, /live-cleanup-ok/);
    assert.equal(h.kernel.spawnOutputOwners.size, 0);
    assert.equal(h.kernel.diagnostics().spawnCapture.ownedSpills, 0);
    assert.deepEqual(h.kernel.readdir('/var/run/vv-spawn'), []);
    h.kernel.releaseSpawnOutput(previousPath); // duplicate receipt is harmless
    assert.equal(h.kernel.spawnOutputOwners.size, 0);
  } finally { server.dispatch = dispatch; h.kernel.writeFile = writeFile; }
  const respondOk = h.kernel.respondOk;
  h.kernel.respondOk = function(proc, bytes) {
    if (proc.spawnOutputPaths?.size) {
      this.signal(proc.pid, "SIGKILL"); // terminate before the guest can read spills
      return;
    }
    return respondOk.call(this, proc, bytes);
  };
  try {
    const res = await h.kernel.start("node", ["/workspace/fault.cjs"], { cwd: "/workspace", capture: true });
    assert.equal(res.signal, "SIGKILL");
    assert.equal(h.filesystem.server.clients.size, 0);
    assert.equal(h.kernel.spawnOutputOwners.size, 0);
    assert.deepEqual(h.kernel.readdir("/var/run/vv-spawn"), []);
  } finally { h.kernel.respondOk = respondOk; }
} finally {
  for (const pid of [...h.kernel.procs.keys()]) h.kernel.signal(pid, "SIGKILL");
  clearTimeout(deadline);
}
console.log("PASS original binary execSync, capture boundaries/errors, repeated live-parent rollback, successful unlink receipts, unrelated spill preservation and exit cleanup");
process.exit(0);
