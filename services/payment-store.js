const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const session = require('express-session');

function createPaymentStore(filename = process.env.PAYMENTS_DB_PATH || path.join(__dirname, '../data/runtime/payments.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, owner TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
    CREATE INDEX IF NOT EXISTS records_owner ON records(kind,owner);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT);
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const read = db.prepare('SELECT owner,data FROM records WHERE kind=? AND id=?');
  const write = db.prepare('INSERT INTO records(kind,id,owner,data) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET owner=excluded.owner,data=excluded.data');
  const store = {
    db,
    get(kind, id, owner) {
      const row = read.get(kind, id);
      return row && (owner === undefined || row.owner === owner) ? JSON.parse(row.data) : undefined;
    },
    put(kind, id, owner, value) { write.run(kind, id, owner, JSON.stringify(value)); return value; },
    list(kind, owner) {
      return (owner === undefined ? db.prepare('SELECT data FROM records WHERE kind=?').all(kind) : db.prepare('SELECT data FROM records WHERE kind=? AND owner=?').all(kind, owner)).map(row => JSON.parse(row.data));
    },
    update(kind, id, owner, transform) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const previous = store.get(kind, id, owner);
        if (!previous) throw Object.assign(new Error('Record not found.'), { status: 404 });
        const result = transform(previous);
        store.put(kind, id, owner, result);
        db.exec('COMMIT');
        return result;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    operation(id) {
      const row = db.prepare('SELECT state,data FROM operations WHERE id=?').get(id);
      return row ? { state: row.state, data: row.data ? JSON.parse(row.data) : undefined } : undefined;
    },
    claim(id, retryDeclined = false) {
      if (db.prepare("INSERT OR IGNORE INTO operations(id,state) VALUES(?,'processing')").run(id).changes) return true;
      return retryDeclined && Boolean(db.prepare("UPDATE operations SET state='processing',data=NULL WHERE id=? AND state='declined'").run(id).changes);
    },
    finish(id, state, data) { db.prepare('UPDATE operations SET state=?,data=? WHERE id=?').run(state, JSON.stringify(data ?? null), id); },
    lock(id) {
      const token = randomBytes(16).toString('hex');
      const changed = db.prepare('INSERT INTO locks(id,token,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,expires=excluded.expires WHERE locks.expires<?').run(id, token, Date.now() + 120000, Date.now()).changes;
      return changed ? token : undefined;
    },
    unlock(id, token) { db.prepare('DELETE FROM locks WHERE id=? AND token=?').run(id, token); },
    secret() {
      let record = store.get('setting', 'session-secret');
      if (!record) record = store.put('setting', 'session-secret', '', { value: randomBytes(48).toString('hex') });
      return record.value;
    },
    close() { db.close(); },
  };
  class PersistentSessionStore extends session.Store {
    get(id, callback) {
      try { const row = db.prepare('SELECT data FROM sessions WHERE id=? AND expires>?').get(id, Date.now()); callback(null, row ? JSON.parse(row.data) : null); }
      catch (error) { callback(error); }
    }
    set(id, value, callback = () => {}) {
      try {
        db.prepare('INSERT INTO sessions(id,data,expires) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires=excluded.expires').run(id, JSON.stringify(value), value.cookie.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 30 * 86400000);
        db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
        callback();
      } catch (error) { callback(error); }
    }
    destroy(id, callback = () => {}) { try { db.prepare('DELETE FROM sessions WHERE id=?').run(id); callback(); } catch (error) { callback(error); } }
    touch(id, value, callback) { this.set(id, value, callback); }
  }
  store.sessions = new PersistentSessionStore();
  return store;
}

module.exports = { createPaymentStore };
