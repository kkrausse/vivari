// The module plan cache (packages/runtime/module-plan-cache.js) against a real
// kernel and real guest workers. What is guarded: a remembered plan must only ever
// be applied to the exact source, path and transpiler that made it; a damaged
// record must be ignored; and a module must behave the same from a record as it
// did when planned (top-level await, a thrown error, a plain synchronous module).
import assert from "node:assert/strict";
import { Worker, MessageChannel } from "node:worker_threads";
import { Kernel } from "../packages/kernel-host/kernel.js";
import { createHeadlessFilesystem } from "./lib/kernel-filesystem.mjs";
import { transpileEsm } from "../packages/runtime/esm.js";

const deadline = setTimeout(() => { console.error("FAIL: module plan cache deadline"); process.exit(1); }, 120_000);
const workers = new Set();
const filesystem = await createHeadlessFilesystem();
const kernel = new Kernel({
  fs: filesystem.fs, stdout() {}, stderr() {},
  spawnWorker(info) {
    const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
    workers.add(worker);
    worker.on("message", message => info.on[message.type]?.(message));
    worker.on("error", error => { console.error(error); process.exitCode = 1; kernel.stop(info.pid); });
    const { port1, port2 } = new MessageChannel();
    filesystem.server.register(info.pid, info.sab, port2);
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
    const transfer = [port1];
    if (info.threadPort) { init.threadPort = info.threadPort; transfer.push(info.threadPort); }
    worker.postMessage(init, transfer);
    return { postMessage: message => worker.postMessage(message),
      terminate() { void worker.terminate(); filesystem.server.unregister(info.pid); port2.close(); } };
  },
});
kernel.installCoreutils();
kernel.mkdirp("/plans");
const PLANS = "/var/lib/vivari/module-plans";
const records = () => kernel.exists(PLANS) ? kernel.readdir(PLANS).map(name => `${PLANS}/${name}`) : [];
const run = async (entry, env = {}) => {
  const result = await kernel.start("node", [entry], { cwd: "/plans", env: { PATH: "/bin", ...env }, capture: true });
  return { code: result.code, output: result.stdout + result.stderr };
};
// Over the cache's 2 MiB threshold: a small real body plus a padding comment.
const big = (body, pad = "x") => `import { basename } from 'node:path';\nexport const name = basename(import.meta.url);\n/*${pad.repeat(2_200_000)}*/\n${body}\n`;

try {
  // 1. A module with top-level await: planned and remembered on the first start,
  //    applied on the second, with the same result.
  const tla = big("const value = await Promise.resolve('tla-ok');\nconsole.log(name, value, typeof __oc_meta);");
  kernel.writeFile("/plans/tla.mjs", tla);
  assert.deepEqual(records(), []);
  const first = await run("/plans/tla.mjs");
  assert.equal(first.code, 0, first.output);
  assert.match(first.output, /tla\.mjs tla-ok object/);
  assert.equal(records().length, 1, "one record for the large module");
  const recordPath = records()[0];
  const record = JSON.parse(kernel.readFile(recordPath));
  assert.equal(record.async, true, "top-level await is remembered as needing the async wrapper");
  assert.equal(record.filename, "/plans/tla.mjs");
  assert.equal(record.chars, tla.length);
  assert.equal(record.head + record.edits.reduce((out, [start, end, text], i, all) =>
    out + tla.slice(i ? all[i - 1][1] : 0, start) + text, "") + tla.slice(record.edits.at(-1)[1]) + record.tail,
    transpileEsm(tla, "/plans/tla.mjs"), "the stored plan reproduces the transpiler's output exactly");
  const second = await run("/plans/tla.mjs");
  assert.deepEqual(second, first, "a start from the record behaves like the start that made it");

  // 2. The record really is what the second start used: a marker planted in its
  //    head runs. (This is also what makes the misses below observable.)
  const marked = { ...record, head: "console.log('FROM-RECORD');" + record.head };
  kernel.writeFile(recordPath, JSON.stringify(marked));
  assert.match((await run("/plans/tla.mjs")).output, /FROM-RECORD\ntla\.mjs tla-ok/, "a valid record is applied");

  // 3. Misses. Same path and same length but different content; the same content
  //    at another path; a record from another transpiler; a damaged record; an
  //    edit list that does not fit the source; the cache switched off.
  const sameLength = big("const value = await Promise.resolve('tla-OK');\nconsole.log(name, value, typeof __oc_meta);");
  assert.equal(sameLength.length, tla.length);
  kernel.writeFile("/plans/tla.mjs", sameLength);
  const changed = await run("/plans/tla.mjs");
  assert.equal(changed.output.includes("FROM-RECORD"), false, "changed content of equal length does not reuse the record");
  assert.match(changed.output, /tla\.mjs tla-OK object/);
  kernel.writeFile("/plans/tla.mjs", tla);

  kernel.writeFile("/plans/other.mjs", tla);
  const other = await run("/plans/other.mjs");
  assert.equal(other.output.includes("FROM-RECORD"), false, "the same content at another path does not reuse the record");
  assert.match(other.output, /other\.mjs tla-ok object/, "and gets its own import.meta");

  for (const [label, damage] of [
    ["another transpiler version", JSON.stringify({ ...marked, version: "0-0" })],
    ["a truncated record", JSON.stringify(marked).slice(0, 2000)],
    ["a record for another length", JSON.stringify({ ...marked, chars: marked.chars + 1 })],
    ["an out-of-range edit", JSON.stringify({ ...marked, edits: [...marked.edits, [marked.chars - 1, marked.chars + 5, ""]] })],
    ["unordered edits", JSON.stringify({ ...marked, edits: [...marked.edits].reverse() })],
  ]) {
    kernel.writeFile(recordPath, damage);
    const result = await run("/plans/tla.mjs");
    assert.equal(result.output.includes("FROM-RECORD"), false, `${label} is not applied`);
    assert.deepEqual(result, first, `${label}: the module loads as if there were no record`);
    assert.deepEqual(JSON.parse(kernel.readFile(recordPath)), record, `${label} is replaced by a good record`);
  }
  kernel.writeFile(recordPath, JSON.stringify(marked));
  const off = await run("/plans/tla.mjs", { VV_NO_MODULE_PLAN_CACHE: "1" });
  assert.deepEqual(off, first, "VV_NO_MODULE_PLAN_CACHE=1 bypasses a record");
  kernel.writeFile(recordPath, JSON.stringify(record));

  // 4. A record that wrongly says "async" (it cannot be made by the cache; forced
  //    here) on a module that uses `await` as an identifier, which only compiles
  //    as a plain function: the async compile fails and the ordinary sequence runs.
  const sloppy = big("var await = 'identifier';\nconsole.log(name, await);");
  kernel.writeFile("/plans/sloppy.mjs", sloppy);
  const sloppyFirst = await run("/plans/sloppy.mjs");
  assert.match(sloppyFirst.output, /sloppy\.mjs identifier/);
  const sloppyPath = records().find(path => JSON.parse(kernel.readFile(path)).filename === "/plans/sloppy.mjs");
  const sloppyRecord = JSON.parse(kernel.readFile(sloppyPath));
  assert.equal(sloppyRecord.async, false, "a module that compiles as a plain function is remembered as such");
  kernel.writeFile(sloppyPath, JSON.stringify({ ...sloppyRecord, async: true }));
  assert.deepEqual(await run("/plans/sloppy.mjs"), sloppyFirst, "a wrong async hint falls back to the plain compile");

  // 5. Errors are reported the same from a record: a throw before and after a
  //    top-level await, and a syntax error (never stored, reported identically).
  for (const [file, body, expected] of [
    ["throws.mjs", "throw new Error('sync-boom');", /sync-boom/],
    ["rejects.mjs", "await null;\nthrow new Error('late-boom');", /late-boom/],
    ["syntax.mjs", "const = 1;", /SyntaxError|Unexpected/],
  ]) {
    kernel.writeFile(`/plans/${file}`, big(body));
    const before = records().length;
    const a = await run(`/plans/${file}`), b = await run(`/plans/${file}`);
    assert.notEqual(a.code, 0, file);
    assert.match(a.output, expected, file);
    assert.deepEqual(b, a, `${file}: the second start fails exactly like the first`);
    assert.equal(records().length - before, file === "syntax.mjs" ? 0 : 1, `${file}: a module that does not compile is not remembered`);
  }

  // 6. Ordinary modules are not touched: nothing is hashed, read or written.
  const before = records().length;
  kernel.writeFile("/plans/small.mjs", "const value = await Promise.resolve('small-ok');\nconsole.log(value);\n");
  assert.match((await run("/plans/small.mjs")).output, /small-ok/);
  assert.equal(records().length, before, "a module under the size threshold leaves no record");
  console.log("PASS module plan cache: records are applied only to the exact source, path and transpiler; damaged records are replaced; results and errors match the uncached load");
} finally {
  await Promise.all([...workers].map(worker => worker.terminate()));
  clearTimeout(deadline);
}
process.exit(process.exitCode ?? 0);
