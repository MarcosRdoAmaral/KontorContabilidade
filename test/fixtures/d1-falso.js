// Banco D1 falso para os testes: a mesma interface do Cloudflare (prepare/bind/first/all/run/batch) sobre node:sqlite.
import { DatabaseSync } from 'node:sqlite';

export function d1Falso() {
  const db = new DatabaseSync(':memory:');
  const exec = (sql, args, modo) => {
    const st = db.prepare(sql);
    if (modo === 'first') return st.get(...args) ?? null;
    if (modo === 'all') return { results: st.all(...args) };
    const r = st.run(...args);
    return { meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } };
  };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => exec(sql, args, 'first'),
    all: async () => exec(sql, args, 'all'),
    run: async () => exec(sql, args, 'run'),
  });
  return {
    _db: db,
    prepare: (sql) => stmt(sql),
    batch: async (lista) => {
      db.exec('BEGIN');
      try { const r = lista.map((s) => exec(s.sql, s.args, 'run')); db.exec('COMMIT'); return r; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
