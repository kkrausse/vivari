import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { FsServer } from '../packages/kernel-host/fs-server.js';
import { installTree } from '../packages/kernel-host/install-tree.js';

test('bulk tree installs binary files and links; verifies before reset and preserves source', { timeout: 10000 }, async () => {
  const worker = new Worker(new URL('./fs-worker.mjs', import.meta.url));
  let sequence = 0;
  const pending = new Map();
  worker.on('message', m => {
    if (m.type !== 'vv-reply') return;
    const request = pending.get(m.reqId);
    pending.delete(m.reqId);
    m.ok ? request.resolve(m) : request.reject(Error(m.error));
  });
  const request = (type, data) => new Promise((resolve, reject) => {
    const reqId = ++sequence;
    pending.set(reqId, { resolve, reject });
    worker.postMessage({ type, reqId, ...data });
  });
  const bytes = Uint8Array.from({ length: 1_100_003 }, (_, i) => i % 251);
  const hash = b => createHash('sha256').update(b).digest('hex');
  const directory = path => ({ kind: 'directory', path, mode: 0o750 });
  const file = (path, data = bytes) => ({ kind: 'file', path, bytes: data, sha256: hash(data), mode: 0o751, verifyReadback: true });
  const install = (roots, entries) => request('workspace-install-tree', { roots, entries });
  const read = async path => (await request('workspace-read', { path })).bytes;
  try {
    await install(['/workspace'], [directory('/workspace'), file('/workspace/source', new TextEncoder().encode('keep edits'))]);
    const entries = [directory('/workspace/node_modules'), file('/workspace/node_modules/binary'),
      { kind: 'symlink', path: '/workspace/node_modules/link', target: 'binary' }];
    const result = await install(['/workspace/node_modules'], entries);
    assert.equal(result.files, 1);
    assert.deepEqual(await read('/workspace/node_modules/link'), bytes);
    assert.equal(new TextDecoder().decode(await read('/workspace/source')), 'keep edits');
    await assert.rejects(install(['/workspace/node_modules'], [entries[0], { ...entries[1], sha256: '0'.repeat(64) }]), /integrity failure/);
    assert.deepEqual(await read('/workspace/node_modules/binary'), bytes);
    await assert.rejects(install(['/workspace/node_modules'], [entries[0], { ...entries[2], target: '../source' }]), /Escaping/);
    await assert.rejects(install(['/workspace/node_modules'], [entries[0], file('/workspace/source')]), /Invalid tree path/);
    await install(['/workspace/node_modules'], [entries[0], file('/workspace/node_modules/new', bytes.subarray(123, 456))]);
    await assert.rejects(read('/workspace/node_modules/link'), /ENOENT/);
    assert.deepEqual(await read('/workspace/node_modules/new'), bytes.subarray(123, 456));
    console.log('bulk-tree-worker-complete');
  } finally { await worker.terminate(); }
});

test('tree metadata and root invalidations use the real VFS and preserve symlink targets during reset', async () => {
  const { VirtualFileSystem } = createRequire(import.meta.url)('../packages/vfs/pkg-node/vivari_vfs.js');
  const vfs = new VirtualFileSystem(), server = new FsServer(vfs);
  const mutations = [];
  server.onMutation = path => mutations.push(path);
  vfs.mkdir('/workspace', true);
  vfs.write_file('/workspace/source', new TextEncoder().encode('saved'));
  vfs.mkdir('/workspace/deps', true);
  vfs.symlink('../source', '/workspace/deps/old-link');
  const bytes = new TextEncoder().encode('executable');
  const tree = { roots: ['/workspace/deps'], entries: [
    { kind: 'directory', path: '/workspace/deps', mode: 0o750 },
    { kind: 'file', path: '/workspace/deps/bin', mode: 0o751, bytes, sha256: createHash('sha256').update(bytes).digest('hex') },
  ] };
  try {
    await installTree(server, tree);
    assert.equal(JSON.parse(vfs.lstat('/workspace/deps')).mode & 0o777, 0o750);
    assert.equal(JSON.parse(vfs.lstat('/workspace/deps/bin')).mode & 0o777, 0o751);
    assert.equal(new TextDecoder().decode(vfs.read_file('/workspace/source')), 'saved');
    assert.deepEqual(mutations, ['/workspace/deps']);
    vfs.symlink('/workspace', '/redirect');
    await assert.rejects(installTree(server, { roots: ['/redirect/deps'], entries: [] }), /root parent/);
    assert.deepEqual(vfs.read_file('/workspace/deps/bin'), bytes);
  } finally { vfs.free(); }
});
