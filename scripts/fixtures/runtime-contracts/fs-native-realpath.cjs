const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync(require('node:os').tmpdir(), { recursive: true });
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'native-realpath-'));
const cwd = process.cwd();
const realpath = (file, options) => new Promise((resolve, reject) => fs.realpath.native(file, options, (error, value) => error ? reject(error) : resolve(value)));
(async () => {
  try {
    fs.mkdirSync(root + '/store/pkg/node_modules/dep', { recursive: true });
    fs.mkdirSync(root + '/node_modules');
    fs.writeFileSync(root + '/store/pkg/package.json', '{"name":"pkg"}');
    fs.writeFileSync(root + '/store/pkg/node_modules/dep/package.json', '{"name":"dep"}');
    fs.symlinkSync('../store/pkg', root + '/node_modules/pkg');
    fs.symlinkSync('node_modules/pkg', root + '/chain');
    fs.symlinkSync(root + '/chain', root + '/absolute');
    const canonicalRoot = fs.realpathSync(root);
    for (const entry of ['/node_modules/pkg', '/chain', '/absolute']) {
      assert.equal(fs.realpathSync.native(root + entry), canonicalRoot + '/store/pkg');
      assert.equal(await realpath(root + entry), canonicalRoot + '/store/pkg');
      assert.equal(fs.realpathSync.native(root + entry + '/package.json'), canonicalRoot + '/store/pkg/package.json');
    }
    // Canonical package scope is required to find its private dependency closure.
    const pkg = fs.realpathSync.native(root + '/node_modules/pkg/package.json');
    assert.equal(JSON.parse(fs.readFileSync(path.dirname(pkg) + '/node_modules/dep/package.json')).name, 'dep');
    const bytes = fs.realpathSync.native(Buffer.from(root + '/chain'), { encoding: 'buffer' });
    assert.ok(Buffer.isBuffer(bytes));
    assert.equal(bytes.toString(), canonicalRoot + '/store/pkg');
    assert.ok(Buffer.isBuffer(await realpath(root + '/chain', 'buffer')));
    process.chdir(root);
    assert.equal(fs.realpathSync.native('./chain/..'), canonicalRoot + '/store');
    fs.symlinkSync('missing', root + '/dangling');
    fs.symlinkSync('loop', root + '/loop');
    for (const [entry, code] of [['missing', 'ENOENT'], ['dangling', 'ENOENT'], ['loop', 'ELOOP'], ['chain/package.json/child', 'ENOTDIR']]) {
      assert.throws(() => fs.realpathSync.native(root + '/' + entry), { code });
      await assert.rejects(realpath(root + '/' + entry), { code });
    }
    console.log('FS_NATIVE_REALPATH_PASS');
  } finally { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
