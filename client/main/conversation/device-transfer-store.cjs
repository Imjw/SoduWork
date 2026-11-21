'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { assertNoLinks } = require('../plugin-resources');

const { historyStamp, matchesHistory } = require('./device-transfer-receipt.cjs');

// A released source is fenced even if its final RPC response never arrived.
// State and the reusable signed grant are committed in the same local transaction.
function open(app) {
  const home = app.getPath('userData'), root = path.join(home, 'device-transfers');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, 'transfers.sqlite');
  assertNoLinks(home, file);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS transfers (
      op TEXT PRIMARY KEY, scope TEXT NOT NULL, sid TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL,
      gen INTEGER NOT NULL, direction TEXT NOT NULL, state TEXT NOT NULL, meta TEXT NOT NULL,
      digest TEXT NOT NULL DEFAULT '', bytes INTEGER NOT NULL DEFAULT 0, proof TEXT NOT NULL DEFAULT '', body BLOB);
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_transfer ON transfers(scope,sid)
      WHERE state IN ('packing','sending','released','receiving','ready','activating');
    CREATE TABLE IF NOT EXISTS previous_history(op TEXT PRIMARY KEY REFERENCES transfers(op), stamp TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transfer_lineage(op TEXT PRIMARY KEY REFERENCES transfers(op),
      ancestors TEXT NOT NULL, grant_text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS aborted_receipts(op TEXT PRIMARY KEY REFERENCES transfers(op));
    CREATE TABLE IF NOT EXISTS aliases(op TEXT REFERENCES transfers(op),sid TEXT NOT NULL,PRIMARY KEY(op,sid));
    CREATE INDEX IF NOT EXISTS alias_id ON aliases(sid);
    CREATE TABLE IF NOT EXISTS chunks(op TEXT NOT NULL REFERENCES transfers(op), pos INTEGER NOT NULL,
      data BLOB NOT NULL, PRIMARY KEY(op,pos));`);
  const get = op => db.prepare('SELECT op,scope,sid,source,target,gen,direction,state,meta,digest,bytes,proof FROM transfers WHERE op=?').get(op);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    root, get, transaction, close: () => db.close(),
    latest: (scope, sid) => db.prepare("SELECT op,direction,state,gen,target,source FROM transfers WHERE scope=? AND sid=? AND state!='aborted' ORDER BY gen DESC LIMIT 1").get(scope,sid),
    fence: sid => db.prepare("SELECT direction,state FROM transfers WHERE (sid=? OR op IN(SELECT op FROM aliases WHERE sid=?)) AND state!='aborted' ORDER BY gen DESC LIMIT 1").get(sid,sid),
    rememberHistory(op,stamp) { db.prepare('INSERT OR REPLACE INTO previous_history VALUES(?,?)').run(op,JSON.stringify(stamp)); },
    historyStamp(op) { const row = db.prepare('SELECT stamp FROM previous_history WHERE op=?').get(op); return row && JSON.parse(row.stamp); },
    rememberLineage(op,ancestors,grant) {
      db.prepare('INSERT INTO transfer_lineage VALUES(?,?,?)').run(op,JSON.stringify(ancestors),JSON.stringify(grant));
    },
    lineage(op) {
      const row = db.prepare('SELECT ancestors,grant_text FROM transfer_lineage WHERE op=?').get(op);
      return row && {ancestors:JSON.parse(row.ancestors),grant:JSON.parse(row.grant_text)};
    },
    pendingAborts(scope, sid, target) {
      return db.prepare("SELECT op,target FROM transfers WHERE scope=? AND sid=? AND target=? AND direction='out' AND state='aborted' AND op NOT IN (SELECT op FROM aborted_receipts)").all(scope,sid,target);
    },
    confirmAbort(op) { db.prepare('INSERT OR IGNORE INTO aborted_receipts VALUES(?)').run(op); },
    aliases(op,ids) { for (const id of ids) db.prepare('INSERT INTO aliases VALUES(?,?)').run(op,id); },
    insert(r) { db.prepare('INSERT INTO transfers(op,scope,sid,source,target,gen,direction,state,meta,digest,bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.op,r.scope,r.sid,r.source,r.target,r.gen,r.direction,r.state,JSON.stringify(r.meta),r.digest || '',r.bytes || 0); },
    state(op, before, after, proof = '') {
      if (db.prepare("UPDATE transfers SET state=?,proof=CASE WHEN ?='' THEN proof ELSE ? END WHERE op=? AND state=?")
        .run(after,proof,proof,op,before).changes !== 1) throw Error('交接状态已变化，请刷新');
    },
    stage(op, body, digest) {
      if (db.prepare("UPDATE transfers SET body=?,bytes=?,digest=?,state='sending' WHERE op=? AND state='packing'")
        .run(body,body.length,digest,op).changes !== 1) throw Error('迁移已取消');
    },
    part(op, offset, size) { return Buffer.from(db.prepare('SELECT substr(body,?,?) AS part FROM transfers WHERE op=?').get(offset+1,size,op).part); },
    append(op, offset, bytes) {
      const previous = db.prepare('SELECT data FROM chunks WHERE op=? AND pos=?').get(op,offset);
      if (previous) {
        if (!Buffer.from(previous.data).equals(bytes)) throw Error('分块内容与已接收记录不一致');
        return;
      }
      if (this.offset(op) !== offset) throw Error('迁移分块顺序不一致');
      db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(op,offset,bytes);
    },
    offset(op) { return db.prepare('SELECT COALESCE(MAX(pos+length(data)),0) AS n FROM chunks WHERE op=?').get(op).n; },
    assemble(op) { return Buffer.concat(db.prepare('SELECT data FROM chunks WHERE op=? ORDER BY pos').all(op).map(row=>Buffer.from(row.data))); },
    clear(op) { db.prepare('DELETE FROM chunks WHERE op=?').run(op); db.prepare('UPDATE transfers SET body=NULL WHERE op=?').run(op); },
  };
}
module.exports = { open, historyStamp, matchesHistory };
