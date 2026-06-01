import duckdb from "duckdb";
import { logger } from "./logger.js";

/* ── Single shared in-memory DuckDB instance ───────────────────── */
const db = new duckdb.Database(":memory:");

/* Recursively convert BigInt values to Number so JSON.stringify works */
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
    conn.all(sql, ...params, (err: Error | null, rows: T[]) => {
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

/* ── Read a Parquet file and return a windowed result ───────────── */
export async function readParquetWindow(opts: {
  parquetPath: string;
  cols: string[];       // column names to fetch (empty = all up to 50)
  from: number;
  limit: number;
  allHeaders: string[];
}): Promise<Record<string, unknown>[]> {
  const { parquetPath, from, limit, allHeaders } = opts;

  const cols = opts.cols.length > 0
    ? opts.cols.filter(c => allHeaders.includes(c))
    : allHeaders.slice(0, 50);

  const colList = cols.map(c => `"${c.replace(/"/g, '""')}"`).join(", ");
  const sql = `SELECT ${colList} FROM read_parquet('${parquetPath.replace(/'/g, "''")}') LIMIT ${limit} OFFSET ${from}`;
  return query(sql);
}

/* ── Export DuckDB instance for advanced use ────────────────────── */
export default db;
