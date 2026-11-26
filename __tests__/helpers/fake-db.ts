/**
 * A minimal stand-in for the Drizzle handle returned by lib/db/client.getDb().
 *
 * Every query builder method (`select`, `from`, `where`, `orderBy`, `limit`,
 * `insert`, `values`, `update`, `set`, `delete`, `returning`, `leftJoin`,
 * `offset`, `onConflictDoNothing`, `onConflictDoUpdate`) returns the same
 * chain, and awaiting the chain resolves with the next queued result.
 * `db.execute()` also consumes the queue and resolves `{ rows }`.
 *
 *   const db = createFakeDb();
 *   db.queue([{ id: "loan-1" }]);        // first query resolves to this
 *   db.queue([]);                        // second query resolves to []
 *
 * Results are consumed in the order the code awaits them. Use `db.calls` to
 * assert which builder methods ran and with what arguments.
 */

type Call = { method: string; args: unknown[] };

export interface FakeDb {
  queue(result: unknown): FakeDb;
  /** Results that will be handed out, in order. */
  pending: unknown[];
  calls: Call[];
  reset(): void;
  // Chain entry points
  select: (...args: unknown[]) => FakeChain;
  insert: (...args: unknown[]) => FakeChain;
  update: (...args: unknown[]) => FakeChain;
  delete: (...args: unknown[]) => FakeChain;
  execute: (...args: unknown[]) => Promise<{ rows: unknown[] }>;
  transaction: <T>(callback: (tx: FakeDb) => Promise<T>) => Promise<T>;
}

export interface FakeChain extends PromiseLike<unknown> {
  [key: string]: unknown;
}

const CHAIN_METHODS = [
  "from",
  "where",
  "orderBy",
  "limit",
  "offset",
  "leftJoin",
  "innerJoin",
  "values",
  "set",
  "returning",
  "onConflictDoNothing",
  "onConflictDoUpdate",
  "groupBy",
  "for",
];

export function createFakeDb(): FakeDb {
  const db: FakeDb = {
    pending: [],
    calls: [],
    queue(result: unknown) {
      db.pending.push(result);
      return db;
    },
    reset() {
      db.pending = [];
      db.calls = [];
    },
    select: (...args) => chain("select", args),
    insert: (...args) => chain("insert", args),
    update: (...args) => chain("update", args),
    delete: (...args) => chain("delete", args),
    execute: async (...args) => {
      db.calls.push({ method: "execute", args });
      const next = db.pending.shift();
      return { rows: Array.isArray(next) ? next : next === undefined ? [] : [next] };
    },
    transaction: async <T>(callback: (tx: FakeDb) => Promise<T>) => {
      db.calls.push({ method: "transaction", args: [] });
      return await callback(db);
    },
  };

  function chain(method: string, args: unknown[]): FakeChain {
    db.calls.push({ method, args });
    const c: FakeChain = {
      then(onFulfilled, onRejected) {
        const next = db.pending.shift();
        return Promise.resolve(next === undefined ? [] : next).then(onFulfilled, onRejected);
      },
    };
    for (const m of CHAIN_METHODS) {
      c[m] = (...a: unknown[]) => {
        db.calls.push({ method: m, args: a });
        return c;
      };
    }
    return c;
  }

  return db;
}
