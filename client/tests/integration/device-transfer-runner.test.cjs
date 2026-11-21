'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const {createRunnerRuntimeAdapter} = require('../../main/agent-runtime/runner-adapter');
const {createPiSessionBridge} = require('../../main/agent-runtime/pi-session-bridge');
const catalog = require('../../main/agent-runtime/runtime-catalog');
const transferFactory = require('../../main/conversation/device-transfer.cjs');
const files = require('../../main/conversation/device-transfer-files.cjs');
const delay = require('node:timers/promises').setTimeout;
const terminal = ref => ({ok:true,data:{ok:true,ref,status:'done',seq:0,items:[],
  deviceTransfer:{schemaVersion:1,quiescent:true}}});
async function fixture(t,{fresh=false}={}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-transfer-runner-'));
  const profile = path.join(root,'profile'), workspace = path.join(root,'work');
  fs.mkdirSync(profile); fs.mkdirSync(workspace);
  const app = {getPath:()=>profile}, calls = [], ref = 'owned-runner-archive';
  const identity = {hub:'https://peer.invalid',clientId:'A',session:Buffer.from(JSON.stringify({
    typ:'device',cid:'A',uid:'owner'})).toString('base64url')+'.fixture'};
  let reply = terminal(ref), read;
  const runtime = {async rpc(operation,params) {
    calls.push({operation,params});
    if (operation === 'runtime.detect') return {ok:true,data:{}};
    if (operation === 'job.session') return params.limit === 1 ? read ? read(params) : reply : terminal(ref);
    if (operation === 'job.comment') return {ok:true,data:{ok:true,ref}};
    if (operation === 'job.stop') return {ok:true,data:{ok:true}};
    throw Error('Unexpected local RPC '+operation);
  }};
  const adapter = createRunnerRuntimeAdapter({app,runnerRuntime:runtime,runtimeSpec:catalog.runtime('qwen'),
    modelConfig:{fetchModel:async()=>({ok:true,model:{id:'fixture'}})}});
  const bridge = createPiSessionBridge({app,sessionModule:{open:async()=>{throw Error('Pi was not requested');},
    probe:async()=>({ok:true})},runnerAdapters:[adapter]});
  const result = await bridge.open({app,identity,cwd:workspace,ref:'runner-transfer-view',adapterId:'qwen',
    ...(fresh ? {} : {resumePath:ref})});
  assert.equal(result.ok,true,result.reason);
  const handle = result.session;
  for (let n=0;handle.inFlight() && n<200;n++) await delay(5);
  assert.equal(handle.inFlight(),false);
  t.after(async()=>{await bridge.dispose();fs.rmSync(root,{recursive:true,force:true});});
  return {app,identity,bridge,handle,calls,workspace,ref,setReply:value=>{reply=value;},setRead:value=>{read=value;}};
}
function assertNoStop(f) { assert.equal(f.calls.filter(call=>call.operation==='job.stop').length,0); }

test('production Runner bridge rejects a stale idle view when the current local job is running, offline or ambiguous',async t=>{
  const f = await fixture(t);
  assert.equal(f.handle.snapshot().status,'idle');
  const receipts = [
    {...terminal(f.ref),data:{...terminal(f.ref).data,status:'running'}},
    {ok:false,error:'offline'},
    {ok:true,data:{ok:true,ref:f.ref,status:'done'}},
    {...terminal(f.ref),data:{...terminal(f.ref).data,ref:'different-job'}},
    {...terminal(f.ref),data:{...terminal(f.ref).data,deviceTransfer:{schemaVersion:1,quiescent:false}}},
    ...[{pendingPermissions:[{requestId:'pending'}]},{stopPending:true},{detached:true},{canStop:true},
      {taskGoal:{status:'working'}}].map(change=>({ok:true,data:{...terminal(f.ref).data,...change}})),
  ];
  for (const reply of receipts) {
    f.setReply(reply);
    await assert.rejects(f.handle.closeForDeviceTransfer(),{code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
    assert.equal(f.bridge.findBySessionId(f.handle.sessionId),f.handle);
    assert.equal(f.handle.snapshot().status,'idle');
    assertNoStop(f);
  }
  f.setRead(()=>{throw Error('disconnected private pipe');});
  await assert.rejects(f.handle.closeForDeviceTransfer(),{code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
  assertNoStop(f);
});

test('confirmed native terminal disposes the production registry handle without requesting stop',async t=>{
  const f = await fixture(t);
  const reads = f.calls.filter(call=>call.operation==='job.session').length;
  assert.equal(await f.handle.closeForDeviceTransfer(),true);
  assert.equal(f.calls.filter(call=>call.operation==='job.session').length,reads+1);
  assert.equal(f.bridge.findBySessionId(f.handle.sessionId),null);
  assert.equal(f.bridge.get(f.handle.ref),null);
  assertNoStop(f);
});

test('a never-dispatched Runner segment can close passively without stopping or inventing a native job',async t=>{
  const f = await fixture(t,{fresh:true});
  assert.equal(await f.handle.closeForDeviceTransfer(),true);
  assert.equal(f.calls.filter(call=>call.operation==='job.session').length,0);
  assertNoStop(f);
});

test('an externally controlled task cannot hide behind an idle host snapshot',async t=>{
  const f = await fixture(t);
  f.handle.taskExecutionChanged({taskId:'external-active',status:'running'});
  f.handle.taskExecutionChanged({taskId:'other-terminal',status:'done'});
  assert.equal(f.handle.snapshot().status,'idle');
  await assert.rejects(f.handle.closeForDeviceTransfer(),{code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
  assert.equal(f.bridge.findBySessionId(f.handle.sessionId),f.handle);
  assertNoStop(f);
});

test('a separate turn completed during the proof invalidates the earlier close observation',async t=>{
  const f = await fixture(t); let release;
  f.setRead(()=>new Promise(resolve=>{release=resolve;}));
  const pending = f.handle.closeForDeviceTransfer();
  for (let n=0;!release && n<100;n++) await delay(1);
  const sent = f.handle.submit('An explicit separate round',[]);
  assert.equal(sent.accepted,true);
  assert.equal((await sent.completion).ok,true);
  assert.equal(f.handle.inFlight(),false);
  release(terminal(f.ref));
  await assert.rejects(pending,{code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
  assert.equal(f.bridge.findBySessionId(f.handle.sessionId),f.handle);
  assertNoStop(f);
});

test('failed authority confirmation leaves the real source fenced on disk and never emits a grant',async t=>{
  const f = await fixture(t), sid = f.handle.sessionId, requests = [];
  const keys = Object.fromEntries(['A','B'].map(device=>[device,crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'})]));
  const bundle = {schema:'soduwork.device-history/v1',conversation:{id:sid,title:'Retained history',
    creator:{hub:f.identity.hub,account:'owner'}},snapshot:{messages:[{role:'user',text:'retain original'}],tools:[]},coverage:{complete:true}};
  bundle.sha256=files.hash(Buffer.from(JSON.stringify(bundle)));
  const options = {app:f.app,identityOf:()=>f.identity,session:f.bridge,verifySource:()=>{},
    history:{resolve:async()=>({id:sid,title:'Retained history'}),exportPortable:async()=>bundle},
    peer:{peers:()=>[{deviceId:'B',role:'desktop'}],
      grantIdentity:device=>({deviceId:device || 'A',accountId:'owner',role:'desktop',
        publicKey:keys[device || 'A'].publicKey.export({type:'spki',format:'der'}).toString('base64')}),
      signGrant:()=>{throw Error('Unconfirmed execution must not be signed');},
      request:async input=>{requests.push(input);return {ok:true,offset:0};}}};
  let transfer = transferFactory.create(options);
  try {
    f.setReply({ok:true,data:{...terminal(f.ref).data,status:'running',deviceTransfer:{schemaVersion:1,quiescent:false}}});
    const preview = await transfer.preview({sessionId:sid,targetDeviceId:'B'});
    await assert.rejects(transfer.start({...preview,selectedPaths:[]}),{code:'DEVICE_TRANSFER_EXECUTION_UNCONFIRMED'});
    assert.equal((await transfer.status(preview)).state,'packing');
    assert.equal(f.bridge.findBySessionId(sid),f.handle);
    assertNoStop(f);
    assert.deepEqual(requests.map(value=>value.method),['migration.offer','migration.abort']);
    transfer.close(); transfer=transferFactory.create(options);
    assert.equal(transfer.blocked(sid),true);
    assert.throws(()=>transfer.admit(sid),/执行权/);
    assert.equal((await transfer.cancel(preview)).state,'aborted');
    assert.equal(transfer.blocked(sid),false);
    assertNoStop(f);
  } finally { transfer.close(); }
});
