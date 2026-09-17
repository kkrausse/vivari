const assert = require('node:assert/strict');
const {Readable} = require('node:stream');
const consumers = require('node:stream/consumers');
(async () => {
  const utf8 = Buffer.from('a€𐍈');
  assert.equal(await consumers.text(Readable.from([utf8.subarray(0, 2), utf8.subarray(2, 5), utf8.subarray(5)])), 'a€𐍈');
  assert.equal(await consumers.text(Readable.from([Buffer.from([0xe2])])), '�');
  for (const method of ['arrayBuffer', 'buffer', 'bytes', 'blob']) {
    const result = await consumers[method](Readable.from([Buffer.from([0,255]), Buffer.from([128,1])]));
    const value = method === 'blob' ? new Uint8Array(await result.arrayBuffer()) : method === 'arrayBuffer' ? new Uint8Array(result) : result;
    assert.deepEqual(Array.from(value), [0,255,128,1]);
  }
  assert.deepEqual(await consumers.json(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{"ok":true}'));c.close()}})), {ok:true});
  await assert.rejects(consumers.json(Readable.from(['invalid'])), SyntaxError);
  await assert.rejects(consumers.text((async function*(){yield 'prefix';throw Error('stream failed')})()), /stream failed/);
  console.log('STREAM_CONSUMERS_PASS utf8/binary/web-stream/json/error');
})().catch(e=>{console.error(e);process.exitCode=1});
