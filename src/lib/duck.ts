import duckdb from "duckdb";
import { logger } from "./logger.js";

const db = new duckdb.Database(":memory:");

/* ── One-time memory / performance settings ── */
(function initDb() {
  const conn = db.connect();
  const settings = [
    "SET memory_limit='350MB'",
    "SET threads=2",
    "SET preserve_insertion_order=false",
    "SET temp_directory='/tmp/duckdb_tmp'",
  ];
  for (const sql of settings) {
    conn.run(sql, (err: Error | null) => {
      if (err) logger.warn({ sql, err: err.message }, "DuckDB init setting failed");
    });
  }
  conn.close();
})();

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

export function query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
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

export function run(sql: string, params: unknown[] = []): Promise<void> {
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
