// Focused reproduction for OpenCode's ripgrep process-consumption shape inside
// Vivari. Pass an ordinary installed ripgrep@0.3.1 package directory.
//
//   node scripts/probe-opencode-spawn-lifecycle.mjs \
//     /path/to/node_modules/ripgrep /path/to/node_modules
import { MessageChannel, Worker } from "node:worker_threads";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";

const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
let onKernelFsMessage = () => {};
await new Promise((resolve) => fsWorker.on("message", (message) => {
  if (message.type === "ready") resolve();
  else onKernelFsMessage(message);
}));
const kernelFs = createKernelFs(fsWorker);
onKernelFsMessage = kernelFs.onMessage;
const workers = new Set();
const spawnWorker = (info) => {
  const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
  workers.add(worker);
  worker.on("message", (message) => info.on[message.type]?.(message));
  worker.on("exit", () => workers.delete(worker));
  const { port1, port2 } = new MessageChannel();
  fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
  const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
  if (info.threadPort) init.threadPort = info.threadPort;
  worker.postMessage(init, initTransferList(info, port1));
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => {
      void worker.terminate();
      fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
    },
  };
};
let parentOutput = "";
const output = (chunk) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
  parentOutput += text;
  process.stdout.write(text);
};
const kernel = new Kernel({
  fs: kernelFs.fs,
  spawnWorker,
  fetcher: async () => ({ ok: false, status: 404, headers: {}, body: new Uint8Array() }),
  stdout: output,
  stderr: output,
});
kernel.installCoreutils();

const packageDirectory = process.argv[2];
const callerNodeModules = process.argv[3];
if (!packageDirectory || (await stat(packageDirectory).catch(() => null))?.isDirectory() !== true) {
  throw new Error("Pass the installed ripgrep@0.3.1 package directory");
}
if (!callerNodeModules || (await stat(callerNodeModules).catch(() => null))?.isDirectory() !== true) {
  throw new Error("Pass a node_modules directory containing cross-spawn@7.0.6");
}
const metadata = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
if (metadata.name !== "ripgrep" || metadata.version !== "0.3.1") throw new Error("Expected ripgrep@0.3.1");
async function mountDirectory(source, destination) {
  kernel.mkdirp(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = `${destination}/${entry.name}`;
    if (entry.isDirectory()) await mountDirectory(from, to);
    else if (entry.isFile()) kernel.writeFile(to, await readFile(from));
  }
}
await mountDirectory(packageDirectory, "/app/node_modules/ripgrep");
for (const name of ["cross-spawn", "path-key", "shebang-command", "shebang-regex", "which", "isexe"]) {
  await mountDirectory(join(callerNodeModules, name), `/app/node_modules/${name}`);
}
kernel.mkdirp("/app/node_modules/.bin");
kernelFs.fs.symlink("../ripgrep/lib/rg.mjs", "/app/node_modules/.bin/rg");
kernel.mkdirp("/workspace");
kernel.writeFile("/workspace/landing.txt", "landing page\n");
kernel.writeFile("/workspace/many-landings.txt", "landing\n".repeat(20_000));
kernel.mkdirp("/workspace/src");
kernel.writeFile("/workspace/src/landing.ts", "export const landing = true\n");
kernel.writeFile("/workspace/parent.js", `
const spawn = require('/app/node_modules/cross-spawn');
const { PassThrough } = require('stream');

const started = Date.now();
const stage = (mode, name, data = {}) => console.log('STAGE ' + JSON.stringify({ elapsedMs: Date.now() - started, mode, name, ...data }));
async function consume(readable, mode, channel) {
  const buffer = new PassThrough();
  readable.on('error', error => buffer.destroy(error));
  readable.pipe(buffer);
  let bytes = 0;
  for await (const chunk of buffer) bytes += chunk.length;
  stage(mode, channel + '-end', { bytes });
  return bytes;
}
async function consumeLimited(readable, mode, limit) {
  const buffer = new PassThrough();
  readable.on('error', error => buffer.destroy(error));
  readable.pipe(buffer);
  let bytes = 0;
  let lines = 0;
  for await (const chunk of buffer) {
    bytes += chunk.length;
    lines += chunk.toString().split('\\n').length - 1;
    if (lines >= limit) break;
  }
  // OpenCode's fromReadable finalizer destroys the source when take(limit + 1)
  // ends before the subprocess output stream ends.
  readable.destroy();
  stage(mode, 'stdout-truncated', { bytes, lines });
  return { bytes, lines };
}
async function run(mode, args, limit) {
  stage(mode, 'before-spawn');
  const child = spawn('/app/node_modules/.bin/rg', args, { cwd: '/workspace', stdio: ['ignore', 'pipe', 'pipe'] });
  const lifecycle = [];
  stage(mode, 'spawn-returned', { pid: child.pid });
  child.on('spawn', () => { lifecycle.push('spawn'); stage(mode, 'spawn-event'); });
  child.on('exit', (code, signal) => { lifecycle.push('exit'); stage(mode, 'exit-event', { code, signal }); });
  child.on('close', (code, signal) => { lifecycle.push('close'); stage(mode, 'close-event', { code, signal }); });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const stderr = consume(child.stderr, mode, 'stderr');
  // This ordering is OpenCode's: consume stdout to EOF, then await exit code,
  // then join the concurrently draining stderr fiber.
  const stdout = limit ? await consumeLimited(child.stdout, mode, limit) : { bytes: await consume(child.stdout, mode, 'stdout') };
  const stdoutBytes = stdout.bytes;
  if (limit) {
    stage(mode, 'release-kill');
    child.kill('SIGTERM');
  }
  stage(mode, 'await-close');
  const result = await closed;
  stage(mode, 'close-awaited', result);
  const stderrBytes = await stderr;
  const expectedExit = limit ? result.code === null && result.signal === 'SIGTERM' : result.code === 0 && result.signal === null;
  if (!expectedExit || stdoutBytes === 0 || stderrBytes !== 0) {
    throw new Error(mode + ' unexpected result: ' + JSON.stringify({ result, stdoutBytes, stderrBytes, lifecycle }));
  }
  return { mode, stdoutBytes, stderrBytes, lifecycle };
}

Promise.all([
  run('grep', ['--no-config', '--json', '--hidden', '--no-messages', '--glob=!**/.git/**', '--', 'landing', '.']),
  run('files', ['--no-config', '--files', '--hidden', '--glob=*landing*', '--glob=!**/.git/**', '.']),
  run('grep-truncated', ['--no-config', '--json', '--hidden', '--no-messages', '--glob=!**/.git/**', '--', 'landing', 'many-landings.txt'], 102),
]).then(results => {
  console.log('OPENCODE_SPAWN_LIFECYCLE_PASS ' + JSON.stringify(results));
}, error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
`);

const parent = kernel.start("node", ["/workspace/parent.js"], { cwd: "/workspace", capture: false });
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Host timed out waiting for OpenCode lifecycle probe")), 15000));
let result;
try {
  result = await Promise.race([parent, timeout]);
  if (result.code !== 0 || !parentOutput.includes("OPENCODE_SPAWN_LIFECYCLE_PASS")) {
    throw new Error(`Probe failed (${result.code}); last output: ${parentOutput.slice(-2000)}`);
  }
  console.log(`HOST PASS ripgrep=${metadata.version} package=${basename(packageDirectory)}`);
} finally {
  for (const pid of [...kernel.procs.keys()]) kernel.stop(pid);
  await Promise.allSettled([...workers].map((worker) => worker.terminate()));
  await fsWorker.terminate();
}
