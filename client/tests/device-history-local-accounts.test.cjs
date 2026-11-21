'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {identity, sessions} = require('./helpers/platform-session-fixture.cjs');
const {scope} = require('../main/platform-connections/runtime.cjs');
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'soduwork-device-accounts-')),app={getPath:()=>root};
  const a=identity(),b=identity('two');let current=a,store,history;
  const rows=new Map(),session={findBySessionId:()=>null,archivedConversation:async()=>null,
    history:async()=>({ok:true,chats:[...rows.values()]}),archivedHistory:async()=>({ok:true,chats:[]}),
    historyEntry:async(_app,id)=>{
      const row=rows.get(id);
      return row&&fs.existsSync(row.path)?{ok:true,entry:row}:{ok:false,notFound:true};
    }};
  function open() {
    store=require('../main/conversation/replica-store.cjs').createWorker(path.join(root,'history.sqlite'));
    history=require('../main/conversation/shared-history.cjs').create({app,session,store,identityOf:()=>current});
  }
  open();t.after(async()=>{await history.close();fs.rmSync(root,{recursive:true,force:true});});
  async function native(id,backfill=true) {
    const file=path.join(root,'pi-agent','sessions','fixture',id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,[{type:'session',id},{type:'message',message:{role:'user',content:'Synthetic '+id}},
      {type:'message',message:{role:'assistant',content:'Retained answer'}}].map(value=>JSON.stringify(value)).join('\n'));
    const row={id,adapterId:'pi',path:file,count:2,at:1,creator:{account:'one',hub:a.hub},workOwner:scope(a)};
    rows.set(id,row);
    if(backfill){await history.projectRows([row]);await history.backfill(id);}else await history.register([row]);
    return row;
  }
  return {app,root,a,b,native,session,get store(){return store;},get history(){return history;},
    set current(value){current=value;},async restart(){await history.close();open();}};
}
test('real SQLite retains ordinary local bodies and archives across account switches and offline restart',async t=>{
  const f=await fixture(t),ordinary=await f.native('ordinary'),archived=await f.native('archived');
  await f.history.lifecycle('archived','archive');
  const first=await f.history.page(),before=await f.store.catalog();
  f.current=f.b;
  const page=await f.history.page();
  assert.deepEqual(page.chats.map(row=>row.id),['ordinary']);
  assert.deepEqual(page.localCatalog.items.map(row=>row.id),['archived','ordinary']);
  assert.notEqual(page.localCatalog.workspace,first.localCatalog.workspace,'Account-private views keep distinct cache epochs');
  assert.deepEqual((await f.history.list({archived:true})).items.map(row=>row.id),['archived']);
  assert.equal((await f.history.read('ordinary')).items[0].text,'Synthetic ordinary');
  assert.equal((await f.history.read('archived')).items[0].text,'Synthetic archived');
  await assert.rejects(f.history.exportPortable('ordinary'),/账号/,'Device readability grants no cross-account transfer');
  fs.unlinkSync(ordinary.path);fs.unlinkSync(archived.path);await f.restart();
  const recovery=await f.history.prepareContinuation('ordinary');
  assert.equal(recovery.prefix.messages[0].text,'Synthetic ordinary');
  assert.equal(recovery.historyRecovery.nativeArchiveMissing,true);
  const auth=require('../main/device-auth');t.mock.method(auth,'localOwner',()=>scope(f.b));
  f.current={...f.b,session:sessions().expired};
  assert.equal((await f.history.read('ordinary')).items[1].text,'Retained answer');
  assert.deepEqual((await f.history.list({archived:true})).items.map(row=>row.id),['archived']);
  f.current=f.a;
  assert.equal((await f.history.read('ordinary')).items[0].text,'Synthetic ordinary');
  assert.equal((await f.store.get('ordinary')).creator.account,'one','Sharing never rewrites original provenance');
  assert.deepEqual((await f.store.catalog()).items,before.items,'Switching and offline reads never erase local membership');
});
function appendTask(row) {
  fs.appendFileSync(row.path,'\n'+JSON.stringify({type:'custom',customType:'soduwork.task.binding',
    data:{taskId:'private-task',taskTitle:'Private task'}})+'\n'+
    JSON.stringify({type:'message',message:{role:'user',content:'Private newly appended request'}})+'\n');
}
test('fresh Pi task binding protects warm and cold bodies before sidecar or SQLite metadata catches up',async t=>{
  for(const mode of ['cold','first-page','cached-page','background']) await t.test(mode,async t=>{
    const f=await fixture(t),row=await f.native('ordinary',mode!=='cold');
    f.session.historyEntry=require('../main/pi-session/session').historyEntry;
    appendTask(row);
    assert.equal((await f.store.get(row.id)).historyProtection,undefined);
    assert.equal(fs.existsSync(path.join(f.root,'requirement-session-context')),false);
    f.current=f.b;
    const operation=mode==='background'?f.history.backfill(row.id):f.history.read(row.id,{after:mode==='cached-page'?1:0});
    await assert.rejects(operation,error=>error.historyAccessFailure===true&&/账号/.test(error.message));
    const saved=await f.store.deviceHistory(row.id);
    assert.equal(JSON.stringify(saved).includes('Private newly appended request'),false);
  });
});
test('private protection is committed with cached body even if a stale index update loses its revision race',async t=>{
  const f=await fixture(t),row=await f.native('ordinary');
  f.session.historyEntry=require('../main/pi-session/session').historyEntry;appendTask(row);
  const register=f.store.register;
  f.store.register=async(rows,options)=>options?.expectedRevision!==undefined&&rows.some(row=>row.historyProtection==='account')
    ? Promise.all(rows.map(row=>f.store.get(row.id))) : register(rows,options);
  await f.history.backfill(row.id);
  assert.equal((await f.store.get(row.id)).historyProtection,undefined);
  const saved=await f.store.deviceHistory(row.id);
  assert.equal(saved.historyProtection,'account');
  assert.ok(saved.snapshot.messages.some(message=>message.text==='Private newly appended request'));
  fs.unlinkSync(row.path);f.current=f.b;
  await assert.rejects(f.history.read(row.id,{after:1}),error=>error.historyAccessFailure===true&&/账号/.test(error.message));
});
test('task binding appended after the native summary is checked in the actual replayed bytes',async t=>{
  const f=await fixture(t),row=await f.native('ordinary');let calls=0;
  const entry=require('../main/pi-session/session').historyEntry;
  f.session.historyEntry=async(...args)=>{
    const found=await entry(...args);
    if(++calls===2) appendTask(row);
    return found;
  };
  f.current=f.b;
  await assert.rejects(f.history.read(row.id),error=>error.historyAccessFailure===true&&/账号/.test(error.message));
  assert.equal(calls,2,'The task appears after the fresh directory summary and before the transcript read');
  assert.equal(JSON.stringify(await f.store.deviceHistory(row.id)).includes('Private newly appended request'),false);
});
test('fresh protection on a native segment also protects its canonical conversation without task sidecars',async t=>{
  const f=await fixture(t),row=await f.native('segment');appendTask(row);
  f.session.historyEntry=require('../main/pi-session/session').historyEntry;
  await f.history.register([{id:'logical',adapterId:'pi',creator:row.creator,workOwner:scope(f.a),count:2}]);
  await require('../main/conversation/runtime-segments').save(f.app,{version:1,id:'logical',owner:scope(f.a),
    cwd:f.root,prefix:{messages:[],tools:[]},segments:[],active:{sessionId:row.id,adapterId:'pi',path:row.path}});
  f.current=f.b;
  await assert.rejects(f.history.read('logical'),error=>error.historyAccessFailure===true&&/账号/.test(error.message));
  assert.equal(await f.store.deviceHistory('logical'),null);
});
test('device sharing exposes neither catalog identities nor bodies for account-protected or imported records',async t=>{
  const f=await fixture(t);await f.native('ordinary');
  const variants=[{taskId:'private-task'},{deviceTransferId:'transfer'},
    {importedHistory:true},{importDigest:'import-digest'},{sourceSessionId:'foreign-session'},
    {sourceClientId:'foreign-device'},{sourceLocalId:'foreign-original'},
    {location:'cloud'},{locationMode:'remote'},{adapterId:'account-sync'},
    {cached:true},{source:{id:'private-source',account:'one',hub:f.a.hub}},{cloud:true}];
  await f.history.register(variants.map((extra,index)=>({id:'private-'+index,adapterId:'pi',count:2,
    creator:{account:'one',hub:f.a.hub},workOwner:scope(f.a),...extra})));
  f.current=f.b;
  const page=await f.history.page();
  assert.deepEqual(page.chats.map(row=>row.id),['ordinary']);
  assert.deepEqual(page.localCatalog.items.map(row=>row.id),['ordinary']);
  assert.deepEqual((await f.history.indexedRows(false,100)).map(row=>row.id),['ordinary']);
  assert.deepEqual((await f.history.directory(0,100)).items,[],
    'The remote directory keeps account ownership even when the desktop can read ordinary local rows');
  await assert.rejects(f.history.read('ordinary',{accountOnly:true}),/账号/);
  for(let index=0;index<variants.length;index++) {
    assert.equal(await f.history.indexedRow('private-'+index),null);
    await assert.rejects(f.history.read('private-'+index),/不存在/);
  }
  assert.equal((await f.store.catalog()).items.length,variants.length+1);
});
test('strict account reads reject native ownership drift independently of desktop background backfill',async t=>{
  const f=await fixture(t),row=await f.native('ordinary');
  assert.equal((await f.history.read(row.id,{accountOnly:true})).items[0].text,'Synthetic ordinary');
  const entry=f.session.historyEntry;let release,entered,calls=0;
  const started=new Promise(resolve=>{entered=resolve;});
  f.session.historyEntry=async(...args)=>{
    if(++calls===1) {entered();await new Promise(resolve=>{release=resolve;});}
    return entry(...args);
  };
  row.workOwner=scope(f.b);
  const background=assert.rejects(f.history.backfill(row.id),/另一个账号/);await started;
  const strict=assert.rejects(f.history.read(row.id,{accountOnly:true}),/另一个账号/);
  try {
    for(let i=0;i<20&&calls<2;i++) await new Promise(resolve=>setImmediate(resolve));
  } finally {release();}
  await Promise.all([background,strict]);
  assert.equal(calls,2,'Account reads cannot borrow the desktop-only pending backfill');
  row.workOwner=scope(f.a);
  assert.equal((await f.history.read(row.id)).items[0].text,'Synthetic ordinary');
});
