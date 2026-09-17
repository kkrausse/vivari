const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
fs.mkdirSync('/tmp', { recursive: true });
const dir = fs.mkdtempSync('/tmp/package-self-');
function write(name, text) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
write('package.json', JSON.stringify({ name: '@contract/self', exports: { '.': './entry.cjs', './feature': './feature.cjs' } }));
write('entry.cjs', 'module.exports = "self-root"');
write('feature.cjs', 'module.exports = "self-feature"');
write('private.cjs', 'module.exports = "private"');
write('node_modules/@contract/self/package.json', '{"main":"index.cjs"}');
write('node_modules/@contract/self/index.cjs', 'module.exports = "shadow"');
const local = createRequire(path.join(dir, 'src', 'caller.cjs'));
assert.equal(local('@contract/self'), 'self-root');
assert.equal(local('@contract/self/feature'), 'self-feature');
assert.equal(local.resolve('@contract/self/feature'), fs.realpathSync(path.join(dir, 'feature.cjs')));
assert.throws(() => local('@contract/self/private.cjs'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
write('nested/package.json', '{"name":"nested"}');
assert.equal(createRequire(path.join(dir, 'nested', 'caller.cjs'))('@contract/self'), 'shadow');
write('node_modules/unscoped/caller.cjs', 'module.exports = require("@contract/self")');
assert.equal(local('unscoped/caller.cjs'), 'shadow');
fs.rmSync(dir, { recursive: true });
console.log('PACKAGE_SELF_PASS');
