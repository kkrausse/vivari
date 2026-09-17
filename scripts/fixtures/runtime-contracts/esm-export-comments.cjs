const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
fs.mkdirSync('/tmp', { recursive: true });
const dir = fs.mkdtempSync('/tmp/esm-comments-');
const file = path.join(dir, 'exports.mjs');
fs.writeFileSync(file, `
const value = 42;
export {
  /** A link {@link value}, quoted "}", and unmatched { in a comment. */
  value as answer,
  // another } must not terminate the list
  value as second
};
export const later = 'still evaluated';
export function read() { return value; }
`);
(async () => {
  const loaded = await import(require('node:url').pathToFileURL(file).href);
  assert.equal(loaded.answer, 42);
  assert.equal(loaded.second, 42);
  assert.equal(loaded.later, 'still evaluated');
  assert.equal(loaded.read(), 42);
  fs.rmSync(dir, { recursive: true });
  console.log('ESM_EXPORT_COMMENTS_PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
