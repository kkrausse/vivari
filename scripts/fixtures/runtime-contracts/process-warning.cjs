const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const warnings=[];
process.on('warning', w=>warnings.push(w));
const emitter=new EventEmitter();
for(let i=0;i<11;i++)emitter.on('data',()=>{});
assert.equal(warnings.length,0);
process.emitWarning('probe',{type:'ProbeWarning',code:'PROBE',detail:'detail'});
assert.throws(()=>process.emitWarning(42),TypeError);
process.nextTick(()=>{
  assert.equal(warnings.length,2);
  assert.equal(warnings[0].name,'MaxListenersExceededWarning');
  assert.equal(warnings[0].emitter,emitter);
  assert.equal(warnings[0].count,11);
  assert.equal(warnings[1].code,'PROBE');
  assert.equal(warnings[1].detail,'detail');
  console.log('PROCESS_WARNING_PASS deferred/metadata/listener-limit/validation');
});
