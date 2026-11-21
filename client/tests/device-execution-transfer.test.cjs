'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { create } = require('../main/conversation/device-transfer.cjs');
const fileTools = require('../main/conversation/device-transfer-files.cjs');

async function scenario(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'device-transfer-test-'));
  const state = { handle:null, reject:false, loseAck:false, imports:0, expectedFiles:['kept.txt'] };
  t.after(async () => {
    state.A?.close();
    state.B?.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const workspace = path.join(root,'work');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace,'kept.txt'),'finished action');
  await fs.writeFile(path.join(workspace,'private.txt'),'exclude by default');
  const sid = 'local-chat-1', identity = device=>({hub:'https://example.invalid',clientId:device,
    session:Buffer.from(JSON.stringify({typ:'device',cid:device,uid:'owner'})).toString('base64url')+'.fixture'});
  const keys = Object.fromEntries(['A','B'].map(device=>[device,crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'})]));
  const input = {sessionId:sid,targetDeviceId:'B'};
  const bundle = {schema:'soduwork.device-history/v1',conversation:{id:sid,taskId:'same-task',title:'Work',creator:{account:'owner',hub:'https://example.invalid'}},
    snapshot:{messages:[{role:'user',text:'continue'}],tools:[{id:'first-action',state:'completed'}]},
    coverage:{complete:true}};
  bundle.sha256=fileTools.hash(Buffer.from(JSON.stringify(bundle)));
  const deps = {};
  for (const device of ['A','B']) {
    const userData = path.join(root,device);
    await fs.mkdir(userData);
    deps[device] = {app:{getPath:()=>userData},identityOf:()=>identity(device),
      session:{findBySessionId:()=>device === 'A' ? state.handle : null},
      history:{resolve:async()=>device === 'A' ? {id:sid,title:'Work'} : null,
        exportPortable:async()=>bundle,importPortable:async(value,options)=>{
          assert.equal(device,'B');
          assert.equal(value.conversation.taskId,'same-task');
          assert.equal(value.snapshot.tools[0].id,'first-action');
          assert.deepEqual(await fs.readdir(options.cwd),state.expectedFiles);
          if (state.expectedFiles.length) assert.equal(await fs.readFile(path.join(options.cwd,'kept.txt'),'utf8'),'finished action');
          state.imports++; return {ok:true};
        }},
      peer:{peers:()=>[{deviceId:'B',role:'desktop'}],
        grantIdentity:target=>({deviceId:target || device,accountId:'owner',role:'desktop',
          publicKey:keys[target || device].publicKey.export({type:'spki',format:'der'}).toString('base64')}),
        signGrant:text=>crypto.sign('sha256',Buffer.from('soduwork-device-grant/v1\0'+text),keys[device].privateKey).toString('base64'),
        verifyGrant:(remote,text,sig)=>crypto.verify('sha256',Buffer.from('soduwork-device-grant/v1\0'+text),remote.publicKey,Buffer.from(sig,'base64')),
        request:async({peerId,method,params})=>{
          assert.equal(peerId,'B');
          const op = method.slice('migration.'.length);
          if (state.offline || (op === 'chunk' && state.disconnectBeforeData)) {
            state.offline = true;
            throw Error('connection interrupted');
          }
          const reply = await state.B.receive({peer:{deviceId:'A',role:'desktop',accountId:'owner',
            publicKey:keys.A.publicKey,assertCurrent:()=>{}},operation:op,args:params});
          if (op === 'grant' && state.loseAck) throw Error('lost acknowledgement');
          return reply;
        }},
      verifySource:()=>{},available:async()=>{},confirmReceive:async()=>!state.reject};
  }
  state.handle = {sessionId:sid,cwd:workspace,adapterId:'pi',snapshot:()=>({}),
    close:async()=>{state.handle=null;return true;}};
  state.A = create(deps.A); state.B = create(deps.B);
  return {state,input,bundle,reopen:()=>{state.A.close();state.B.close();state.A=create(deps.A);state.B=create(deps.B);}};
}

test('a lost grant reply survives both restarts, never restores source execution, and imports exactly once',async t=>{
  const {state,input,reopen} = await scenario(t);
  const preview = await state.A.preview(input), selected = {...input,operationId:preview.operationId,selectedPaths:['kept.txt']};
  state.loseAck = true;
  await assert.rejects(state.A.start(selected),/lost acknowledgement/);
  assert.equal((await state.A.status(selected)).state,'released');
  assert.throws(()=>state.A.admit(input.sessionId),/执行权/);
  assert.equal(state.imports,1);
  reopen();state.loseAck=false;
  assert.equal(state.A.blocked(input.sessionId),true);
  assert.equal(state.B.blocked(input.sessionId),false);
  await assert.rejects(state.A.cancel(selected),/执行权/);
  assert.equal((await state.A.resume(selected)).state,'done');
  assert.equal(state.imports,1);
});
test('refusing the offer preserves the running handle and releases the local fence',async t=>{
  const {state,input}=await scenario(t);
  state.reject=true;
  const p=await state.A.preview(input);
  await assert.rejects(state.A.start({...input,operationId:p.operationId,selectedPaths:[]}),/未接受/);
  assert.ok(state.handle);
  assert.equal(state.A.blocked(input.sessionId),false);
});
test('admission of an earlier message blocks handoff until its outcome is known',async t=>{
  const {state,input}=await scenario(t);
  const end=state.A.admit(input.sessionId), p=await state.A.preview(input);
  await assert.rejects(state.A.start({...input,operationId:p.operationId,selectedPaths:['kept.txt']}),/正在|仍在/);
  end();
  assert.ok(state.handle);
});
test('incoming file lists reject paths outside the staged workspace before writing anything',()=>{
  const packet={ version:1,history:{conversation:{id:'abc'},coverage:{complete:true}},
    files:[{path:'../escape',size:0,sha256:fileTools.hash(Buffer.alloc(0)),data:''}] };
  const bytes=Buffer.from(JSON.stringify(packet));
  assert.throws(()=>fileTools.parse(bytes,{sid:'abc',bytes:bytes.length,digest:fileTools.hash(bytes),meta:'{"fileCount":1,"totalBytes":0}'}),/路径/);
});

test('history can transfer after a working directory disappears, without selecting files',async t=>{
  const {state,input}=await scenario(t);
  state.handle.cwd=path.join(state.handle.cwd,'removed');
  state.expectedFiles=[];
  const preview=await state.A.preview(input);
  assert.deepEqual(preview.files,[]);
  assert.match(preview.workspaceNotice,/仅迁移会话历史/);
  assert.equal((await state.A.start({...input,operationId:preview.operationId,selectedPaths:[]})).state,'done');
  assert.equal(state.imports,1);
});

test('an unresolved older tool receipt prevents takeover even when the live snapshot looks idle',async t=>{
  const {state,input,bundle}=await scenario(t);
  bundle.snapshot.tools[0].state='running';
  const preview=await state.A.preview(input);
  await assert.rejects(state.A.start({...input,operationId:preview.operationId,selectedPaths:[]}),/结果未确认/);
  assert.equal(state.A.blocked(input.sessionId),false);
  assert.ok(state.handle);
  assert.equal(state.imports,0);
});

test('a cancelled disconnected offer is cleaned at the target before a new online handoff',async t=>{
  const {state,input,reopen}=await scenario(t), handle=state.handle;
  const preview=await state.A.preview(input), selected={...input,operationId:preview.operationId,selectedPaths:['kept.txt']};
  state.disconnectBeforeData=true;
  await assert.rejects(state.A.start(selected),/interrupted/);
  assert.equal((await state.A.cancel(selected)).state,'aborted');
  reopen();
  assert.equal(state.A.blocked(input.sessionId),false);
  assert.equal(state.B.blocked(input.sessionId),true);
  state.handle=handle;
  state.disconnectBeforeData=false; state.offline=false;
  const next=await state.A.preview(input);
  assert.equal((await state.A.start({...selected,operationId:next.operationId})).state,'done');
  assert.equal(state.imports,1);
});

test('interrupted workspace staging is repeatable and cancelling never removes a published workspace',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'device-transfer-stage-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const op=crypto.randomUUID(), staging=path.join(root,'incoming',op);
  const contents=Buffer.from('reviewed data');
  const files=[{path:'review/item',data:contents.toString('base64'),size:contents.length,sha256:fileTools.hash(contents)}];
  await fs.mkdir(staging,{recursive:true});
  await fs.writeFile(path.join(staging,'partial'),'interrupted previous attempt');
  await fileTools.prepare(root,op,files);
  const workspace=await fileTools.activate(root,op,files);
  assert.equal(await fs.readFile(path.join(workspace,'review/item'),'utf8'),'reviewed data');
  await fileTools.discard(root,op);
  assert.equal(await fileTools.activate(root,op,files),workspace);
  await fs.writeFile(path.join(workspace,'review/item'),'modified data');
  await assert.rejects(fileTools.activate(root,op,files),/文件已变化/);
  assert.equal(await fs.readFile(path.join(workspace,'review/item'),'utf8'),'modified data');
});

test('only read-only catalog cursor movement preserves a returning predecessor',()=>{
  const {historyStamp,matchesHistory}=require('../main/conversation/device-transfer-store.cjs');
  const saved={digest:'original'}, row={id:'sid',title:'original',taskId:'task',revision:8,replicaRevision:2};
  const stamp=historyStamp(row,saved,'transfer');
  assert.ok(matchesHistory(stamp,{...row,revision:10},saved));
  assert.equal(matchesHistory(stamp,{...row,replicaRevision:3},saved),false);
  assert.equal(matchesHistory(stamp,{...row,title:'revised'},saved),false);
  assert.equal(matchesHistory(stamp,row,{digest:'changed'}),false);
});
