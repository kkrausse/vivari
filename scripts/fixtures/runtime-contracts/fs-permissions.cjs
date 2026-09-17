const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

async function main() {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-permissions-'));
  const file = path.join(root, 'file');
  const hard = path.join(root, 'hard');
  const sym = path.join(root, 'sym');
  const missing = path.join(root, 'missing');
  const mode = p => fs.statSync(p).mode & 0o7777;
  const callback = (method, ...args) => new Promise((resolve, reject) => {
    let returned = false;
    fs[method](...args, error => {
      try { assert.ok(returned, `${method} callback must be deferred`); }
      catch (e) { reject(e); return; }
      error ? reject(error) : resolve();
    });
    returned = true;
  });
  try {
    fs.writeFileSync(file, 'permission metadata');
    assert.equal(typeof process.getuid, 'function');
    assert.equal(typeof process.getgid, 'function');
    assert.equal(fs.statSync(file).uid, process.getuid());
    assert.equal(fs.statSync(file).gid, process.getgid());
    assert.equal(process.geteuid(), process.getuid());
    assert.equal(process.getegid(), process.getgid());
    assert.ok(process.getgroups().includes(process.getgid()));
    fs.chmodSync(file, 0o751);
    assert.equal(mode(file), 0o751, 'chmod must change stat mode');
    assert.ok(fs.statSync(file).isFile());
    fs.linkSync(file, hard);
    fs.symlinkSync('file', sym);
    const linkMode = fs.lstatSync(sym).mode;
    fs.chmodSync(sym, '640');
    assert.equal(mode(file), 0o640);
    assert.equal(mode(hard), 0o640, 'hard links share inode permissions');
    assert.equal(fs.lstatSync(sym).mode, linkMode, 'chmod follows symlink');
    const fd = fs.openSync(file, 'r');
    try {
      fs.renameSync(file, path.join(root, 'renamed'));
      fs.writeFileSync(file, 'replacement');
      fs.chmodSync(file, 0o600);
      fs.fchmodSync(fd, 0o705);
      assert.equal(fs.fstatSync(fd).mode & 0o7777, 0o705);
      assert.equal(mode(hard), 0o705, 'fchmod follows inode after rename');
      assert.equal(mode(file), 0o600, 'fchmod must not resolve the old path');
      await callback('fchmod', fd, 0o750);
      assert.equal(mode(hard), 0o750);
    } finally { fs.closeSync(fd); }
    assert.throws(() => fs.fchmodSync(fd, 0o777), { code: 'EBADF' });
    await assert.rejects(callback('fchmod', fd, 0o777), { code: 'EBADF' });
    assert.throws(() => fs.chmodSync(missing, 0o777), { code: 'ENOENT' });
    await assert.rejects(callback('chmod', missing, 0o777), { code: 'ENOENT' });
    await assert.rejects(fs.promises.chmod(missing, 0o777), { code: 'ENOENT' });
    await callback('chmod', hard, 0o711);
    assert.equal(mode(hard), 0o711);
    await fs.promises.chmod(hard, 0o700);
    assert.equal(mode(hard), 0o700);
    const handle = await fs.promises.open(hard, 'r');
    try {
      await handle.chmod(0o754);
      assert.equal((await handle.stat()).mode & 0o7777, 0o754);
    } finally { await handle.close(); }
    fs.chmodSync(root, 0o1755);
    assert.equal(mode(root), 0o1755);
    assert.ok(fs.statSync(root).isDirectory());
    console.log('FS_PERMISSIONS_PASS');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
