const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
fs.mkdirSync(require('node:os').tmpdir(), { recursive: true });
const directory = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'node-entry-'));
async function child(name, source) {
  const entry = path.join(directory, name);
  fs.writeFileSync(entry, source);
  const process = cp.spawn('node', [entry], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  process.stdout.on('data', bytes => stdout += bytes);
  process.stderr.on('data', bytes => stderr += bytes);
  const code = await new Promise((resolve, reject) => { process.on('error', reject); process.on('close', resolve); });
  return { code, stdout, stderr };
}
(async () => {
  const complete = await child('complete.mjs', `await new Promise(resolve => setTimeout(resolve, 5)); console.log('ENTRY_COMPLETE');`);
  assert.equal(complete.code, 0, complete.stderr);
  assert.match(complete.stdout, /ENTRY_COMPLETE/);
  const rejected = await child('reject.mjs', `export {}; await Promise.resolve(); throw Error('ENTRY_REJECTED');`);
  assert.notEqual(rejected.code, 0);
  assert.match(rejected.stderr, /ENTRY_REJECTED/);
  const main = await child('main.cjs', `if (require.main !== module) throw Error('not main'); console.log('MAIN_IDENTITY');`);
  assert.equal(main.code, 0, main.stderr);
  assert.match(main.stdout, /MAIN_IDENTITY/);
  console.log('NODE_ENTRY_PASS');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
