import duckdb from "duckdb";
import { logger } from "./logger.js";

const db = new duckdb.Database(":memory:");

/*
 * Run memory / threading settings sequentially (chained callbacks) so they
 * are guaranteed to complete before the first real query fires.
 * Callers await `dbReady` before running any SQL.
 */
export const dbReady: Promise<void> = new Promise<void>((resolve) => {
  const conn = db.connect();
  const settings = [
    "SET memory_limit='350MB'",
    "SET threads=2",
    "SET preserve_insertion_order=false",
  ];
  let i = 0;
  function next() {
    if (i >= settings.length) {
      conn.close();
      logger.info("DuckDB init settings applied");
      resolve();
      return;
    }
    const sql = settings[i++];
    conn.run(sql, (err: Error | null) => {
      if (err) logger.warn({ sql, err: err.message }, "DuckDB init warning (non-fatal)");
      next();
    });
  }
  next();
});

function fixBigInt(val: unknown): unknown {
  if (typeof val === "bigint") return Number(val);
  if (Array.isArray(val)) return val.map(fixBigInt);
  if (val !== null && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) out[k] = fixBigInt(v);
    return out;
  }
  return val;
}

export async function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  await dbReady;
  return new Promise((resolve, reject) => {
    const conn = db.connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn.all as any)(sql, ...params, (err: Error | null, rows: unknown[]) => {
      conn.close();
      if (err) {
        logger.error({ sql: sql.slice(0, 200), err }, "DuckDB query error");
        reject(err);
      } else {
        resolve(fixBigInt(rows) as T[]);
      }
    });
  });
}

export async function run(sql: string, params: unknown[] = []): Promise<void> {
  await dbReady;
  return new Promise((resolve, reject) => {
    const conn = db.connect();
    conn.run(sql, ...params, (err: Error | null) => {
      conn.close();
      if (err) {
        logger.error({ sql: sql.slice(0, 200), err }, "DuckDB run error");
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export default db;
