const assert = require('node:assert/strict');
const fs = require('node:fs');
fs.mkdirSync('/tmp', { recursive: true });
const dir = fs.mkdtempSync('/tmp/ts-module-');
fs.writeFileSync(dir + '/source.ts', `
export const value: number = 41
export const type = 'ordinary value'
export type OnlyType = { value: number }
`);
fs.writeFileSync(dir + '/entry.ts', `
export * as Namespace from './source'
import { value as renamed, type OnlyType, type as ordinary } from './source'
import * as Values from './source'
export { renamed as answer, type OnlyType, ordinary }
export const later: number = (Values.value as number) + 1
`);
const result = require(dir + '/entry.ts');
assert.equal(result.Namespace.value, 41);
assert.equal(result.answer, 41);
assert.equal(result.ordinary, 'ordinary value');
assert.equal(result.later, 42);
assert.equal('OnlyType' in result, false);
fs.rmSync(dir, { recursive: true });
console.log('TS_MODULE_ALIAS_PASS');
