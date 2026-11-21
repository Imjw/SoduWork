'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mergeNativeEvidence}=require('../main/conversation/history-evidence.cjs');
test('native evidence only adds privacy restrictions and preserves canonical attribution and aliases',()=>{
  const indexed={id:'logical',creator:{account:'original'},workOwner:'original-owner',
    historyAliasIds:['first'],historyProtection:'account',taskIds:['retained-task']};
  const merged=mergeNativeEvidence(indexed,{id:'next',creator:{account:'replacement'},workOwner:'new-owner',
    historyAliasIds:['last'],historyProtection:'',taskIds:[]});
  assert.equal(merged.id,'logical');assert.deepEqual(merged.creator,indexed.creator);
  assert.equal(merged.workOwner,'original-owner');assert.deepEqual(merged.historyNativeOwners,['original-owner','new-owner']);
  assert.equal(merged.historyProtection,'account');assert.deepEqual(merged.taskIds,['retained-task']);
  assert.deepEqual(merged.historyAliasIds,['first','last','next']);assert.deepEqual(indexed.historyAliasIds,['first']);
});
test('every fresh task or cloud protection signal restricts an older ordinary index',()=>{
  for(const signal of [{taskId:'task'},{taskRef:'ref'},{taskIds:['task']},{taskBindings:[{taskId:'task'}]},
    {activeTaskId:'task'},{historyProtection:'account'},{acceptanceReview:true},{requirementContext:{}},
    {cloud:true},{remoteProjection:true},{accountProjection:true},{accountConversation:true}]) {
    assert.equal(mergeNativeEvidence({id:'ordinary'},signal).historyProtection,'account',JSON.stringify(signal));
  }
});
test('fresh origin evidence cannot be cleared or converted back into an ordinary device chat',()=>{
  for(const signal of [{source:{id:'source'}},{sourceLocalId:'old'},{sourceClientId:'device'},
    {sourceSessionId:'session'},{deviceTransferId:'transfer'},{importedHistory:true},{importDigest:'digest'},
    {cached:true},{adapterId:'account-sync'},{locationMode:'remote'},{location:'cloud'}]) {
    const merged=mergeNativeEvidence({id:'ordinary'},signal);
    const cleared=Object.fromEntries(Object.keys(signal).map(key=>[key,'']));
    assert.deepEqual(mergeNativeEvidence(merged,cleared),merged);
  }
  assert.throws(()=>mergeNativeEvidence({id:'ordinary'},{historyAliasIds:'malformed'}),
    error=>error.historyAccessFailure===true);
  assert.throws(()=>mergeNativeEvidence({id:'ordinary',historyAliasIds:'malformed'},{}),
    error=>error.historyAccessFailure===true);
});
