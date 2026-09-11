// Node.js v24.18.0 lib/stream/consumers.js, wrapped for the builtin loader.
// https://github.com/nodejs/node/blob/v24.18.0/lib/stream/consumers.js
export default function(exports, require, module, process, internalBinding, primordials) {
'use strict';
const { JSONParse, Uint8Array } = primordials;
const { TextDecoder } = require('internal/encoding');
const { Blob } = require('internal/blob');
const { Buffer } = require('buffer');
async function blob(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new Blob(chunks);
}
async function arrayBuffer(stream) {
  const ret = await blob(stream);
  return ret.arrayBuffer();
}
async function buffer(stream) { return Buffer.from(await arrayBuffer(stream)); }
async function bytes(stream) { return new Uint8Array(await arrayBuffer(stream)); }
async function text(stream) {
  const dec = new TextDecoder();
  let str = '';
  for await (const chunk of stream) {
    if (typeof chunk === 'string') str += chunk;
    else str += dec.decode(chunk, { stream: true });
  }
  str += dec.decode(undefined, { stream: false });
  return str;
}
async function json(stream) { return JSONParse(await text(stream)); }
module.exports = { arrayBuffer, blob, buffer, bytes, text, json };
}
