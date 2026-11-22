// node:sqlite dressed up as a D1 binding: prepare/bind/first/all/run
// plus batch, which D1 runs as one transaction and this runs the same
// way, D1's limit of 100 bound parameters a statement, and its limit on
// the terms of a compound SELECT. Shared by every worker suite in this
// folder.

// D1 refuses a SELECT joined from six UNION terms ("too many terms in
// compound SELECT") where plain sqlite takes 500, and two are known to
// pass; five is the most this lets through.
const COMPOUND_TERMS = 5;
function compoundCheck(sql) {
  const terms = (String(sql).match(/\b(UNION|INTERSECT|EXCEPT)\b/gi) || []).length + 1;
  if (terms > COMPOUND_TERMS) throw new Error('D1_ERROR: too many terms in compound SELECT: SQLITE_ERROR');
}

export function d1Shim(raw) {
  function statement(sql) {
    compoundCheck(sql);
    return {
      _sql: sql, _args: [],
      // D1 refuses a statement with more than 100 bound parameters,
      // and plain sqlite takes thousands, so a list that grows with the
      // data passes every suite and fails on the day without this
      bind(...args) {
        if (args.length > 100) throw new Error('D1_ERROR: too many SQL variables (' + args.length + ', D1 takes 100)');
        this._args = args; return this;
      },
      async first() { return raw.prepare(this._sql).get(...this._args) ?? null; },
      // D1 says how big the database is after every query
      async all() {
        const results = raw.prepare(this._sql).all(...this._args);
        const size = raw.prepare('PRAGMA page_count').get().page_count * raw.prepare('PRAGMA page_size').get().page_size;
        return { results, meta: { size_after: size } };
      },
      async run() {
        const res = raw.prepare(this._sql).run(...this._args);
        return { meta: { last_row_id: Number(res.lastInsertRowid), changes: res.changes } };
      }
    };
  }
  return {
    prepare: statement,
    // Run without a single await inside, so two requests in flight
    // at once cannot interleave their statements: D1 runs one batch to
    // the end before it starts another, and that is what the
    // exactly-once checks lean on.
    async batch(stmts) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of stmts) {
          // a read answers its rows, as D1's batch does
          if (/^\s*(SELECT|WITH)\b/i.test(s._sql) && !/\bRETURNING\b/i.test(s._sql)) {
            out.push({ results: raw.prepare(s._sql).all(...s._args).map(r => Object.assign({}, r)), meta: { changes: 0 } });
            continue;
          }
          const res = raw.prepare(s._sql).run(...s._args);
          out.push({ meta: { last_row_id: Number(res.lastInsertRowid), changes: res.changes } });
        }
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    }
  };
}
