import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import readline from "readline";
import { query, run } from "../lib/duck.js";
import { createSession, getSession, deleteSession, UPLOAD_DIR } from "../lib/session-store.js";
import { logger } from "../lib/logger.js";

const router = Router();

/* ── Multer: accept CSV and JSON, store to UPLOAD_DIR ── */
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok = /\.(csv|json)$/i.test(file.originalname) ||
               ["text/csv", "application/json", "text/plain"].includes(file.mimetype);
    cb(null, ok);
  },
});

/* ── DuckDB reader expression for a stored CSV ──
 *  max_line_size=1048576 (1 MB) — prevents the 2 GB buffer allocation
 *  that the old 128 MB setting caused on memory-constrained servers.
 */
function srcExpr(dataPath: string): string {
  const p = dataPath.replace(/'/g, "''");
  return `read_csv_auto('${p}', header=true, max_line_size=1048576, ignore_errors=true)`;
}

/* ── Minimal JS CSV line parser (handles quoted fields) ── */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  // Strip UTF-8 BOM if present
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur.trim()); cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

/* ── Read just the first line of a CSV to get headers ── */
async function readCsvHeader(filePath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });
    let done = false;
    rl.on("line", (line) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(parseCsvLine(line));
    });
    rl.on("error", reject);
    rl.on("close", () => { if (!done) resolve([]); });
  });
}

/* ── Count data rows in a CSV (fast newline scan, subtracts header) ── */
async function countCsvRows(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let lines = 0;
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => {
      const buf = chunk as Buffer;
      for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 10) lines++; // count \n chars
      }
    });
    stream.on("end", () => resolve(Math.max(0, lines - 1))); // -1 for header
    stream.on("error", reject);
  });
}

/* ── Minimal JS CSV writer (for JSON-body uploads from XLSX) ── */
function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const lines: string[] = [headers.map(esc).join(",")];
  for (const row of rows) lines.push(headers.map(h => esc(row[h])).join(","));
  return lines.join("\n");
}

function parseCols(colsParam: string | undefined, allHeaders: string[]): string[] {
  if (!colsParam) return [];
  return colsParam.split(",").map(c => c.trim()).filter(c => allHeaders.includes(c));
}

function buildWhere(
  conditions: Array<{ col: string; op: string; value: string }>,
  searchQ: string,
  headers: string[],
): string {
  const parts: string[] = [];
  for (const { col, op, value } of conditions) {
    if (!headers.includes(col)) continue;
    const c = `"${col.replace(/"/g, '""')}"`;
    const v = value.replace(/'/g, "''");
    switch (op) {
      case "eq":       parts.push(`${c} = '${v}'`); break;
      case "neq":      parts.push(`${c} != '${v}'`); break;
      case "contains": parts.push(`${c} ILIKE '%${v}%'`); break;
      case "starts":   parts.push(`${c} ILIKE '${v}%'`); break;
      case "ends":     parts.push(`${c} ILIKE '%${v}'`); break;
      case "gt":       parts.push(`TRY_CAST(${c} AS DOUBLE) > ${parseFloat(v) || 0}`); break;
      case "lt":       parts.push(`TRY_CAST(${c} AS DOUBLE) < ${parseFloat(v) || 0}`); break;
      case "blank":    parts.push(`(${c} IS NULL OR ${c} = '')`); break;
      case "notblank": parts.push(`(${c} IS NOT NULL AND ${c} != '')`); break;
    }
  }
  if (searchQ) {
    const q = searchQ.replace(/'/g, "''");
    const sp = headers.slice(0, 20).map(h => `"${h.replace(/"/g, '""')}" ILIKE '%${q}%'`);
    if (sp.length) parts.push(`(${sp.join(" OR ")})`);
  }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

/* ─────────────────────────────────────────────────────────────────────────
   POST /api/mx/upload
   ─────────────────────────────────────────────────────────────────────────
   Accepts:
     a) multipart/form-data field "file" (CSV or JSON)
     b) JSON body { headers, rows, fileName }  ← from XLSX converted in-browser

   Strategy:
   • Store data as a plain CSV on disk — NO Parquet conversion.
   • Parse headers + row count with Node.js (no DuckDB during upload).
     This eliminates the 2 GB buffer-pool allocation that DuckDB triggers
     when reading a large CSV for the first time.
   • DuckDB is only used for queries (rows/sort/filter/AI), which use LIMIT
     and stream from disk without large allocations.
   ───────────────────────────────────────────────────────────────────────── */
router.post("/mx/upload", upload.single("file"), async (req: Request, res: Response) => {
  try {
    const { v4: uuidv4 } = await import("uuid");
    const fileId  = uuidv4();
    const csvPath = path.join(UPLOAD_DIR, `${fileId}.csv`);
    let fileName  = "upload";
    let headers: string[] = [];
    let rowCount  = 0;

    if (req.file) {
      /* ── Multipart file (CSV or JSON) ── */
      fileName = req.file.originalname;
      const tmpPath = req.file.path;

      if (/\.json$/i.test(fileName)) {
        /* JSON → write as CSV via DuckDB (JSON files are typically small) */
        const jsonSafe = tmpPath.replace(/'/g, "''");
        await run(
          `COPY (SELECT * FROM read_json_auto('${jsonSafe}'))` +
          ` TO '${csvPath.replace(/'/g, "''")}' (FORMAT CSV, HEADER true)`,
        );
        fs.unlinkSync(tmpPath);
      } else {
        /* CSV → rename temp file to permanent path */
        fs.renameSync(tmpPath, csvPath);
      }

      /* Introspect with Node.js — no DuckDB, no memory spike */
      [headers, rowCount] = await Promise.all([
        readCsvHeader(csvPath),
        countCsvRows(csvPath),
      ]);

    } else if (req.body?.headers && req.body?.rows) {
      /* ── JSON body (XLSX parsed in-browser) ── */
      fileName = req.body.fileName || "data";
      const { headers: h, rows } = req.body as {
        headers: string[];
        rows: Record<string, unknown>[];
      };

      if (!Array.isArray(h) || !Array.isArray(rows)) {
        res.status(400).json({ error: "Invalid body: headers and rows must be arrays" });
        return;
      }

      headers  = h;
      rowCount = rows.length;
      /* Write CSV directly — no DuckDB needed */
      fs.writeFileSync(csvPath, rowsToCsv(headers, rows), "utf8");

    } else {
      res.status(400).json({ error: "Provide a CSV file (multipart) or JSON body {headers, rows}" });
      return;
    }

    if (!headers.length) {
      res.status(400).json({ error: "Could not read column headers from the file. Is it a valid CSV?" });
      return;
    }

    /* All columns default to VARCHAR — DuckDB will coerce at query time */
    const colTypes: Record<string, string> = {};
    for (const h of headers) colTypes[h] = "VARCHAR";

    const session = createSession({
      fileName,
      dataPath: csvPath,
      rowCount,
      colCount: headers.length,
      headers,
      colTypes,
    });

    logger.info({ sessionId: session.sessionId, rowCount, cols: headers.length, fileName }, "Session created");
    res.json({ sessionId: session.sessionId, rowCount, colCount: headers.length, headers, colTypes, fileName });

  } catch (err) {
    logger.error(err, "Upload failed");
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/meta ── */
router.get("/mx/meta", (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }
  res.json({ sessionId: s.sessionId, fileName: s.fileName, rowCount: s.rowCount, colCount: s.colCount, headers: s.headers, colTypes: s.colTypes });
});

/* ── GET /api/mx/rows ── */
router.get("/mx/rows", async (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }

  const from    = Math.max(0, parseInt(req.query.from as string) || 0);
  const limit   = Math.min(1000, Math.max(1, parseInt(req.query.limit as string) || 100));
  const cols    = parseCols(req.query.cols as string, s.headers);
  const selCols = cols.length > 0 ? cols : s.headers.slice(0, 50);
  const colList = selCols.map(c => `"${c.replace(/"/g, '""')}"`).join(", ");

  try {
    const rows = await query(`SELECT ${colList} FROM ${srcExpr(s.dataPath)} LIMIT ${limit} OFFSET ${from}`);
    res.json({ rows, total: s.rowCount, from, limit, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/sort ── */
router.get("/mx/sort", async (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }

  const col     = req.query.col as string;
  const dir     = (req.query.dir as string)?.toLowerCase() === "desc" ? "DESC" : "ASC";
  const from    = Math.max(0, parseInt(req.query.from as string) || 0);
  const limit   = Math.min(1000, Math.max(1, parseInt(req.query.limit as string) || 100));
  const cols    = parseCols(req.query.cols as string, s.headers);
  const selCols = cols.length > 0 ? cols : s.headers.slice(0, 50);

  if (!s.headers.includes(col)) { res.status(400).json({ error: `Column "${col}" not found` }); return; }

  const colList = selCols.map(c => `"${c.replace(/"/g, '""')}"`).join(", ");
  const sortCol = `"${col.replace(/"/g, '""')}"`;

  try {
    const rows = await query(
      `SELECT ${colList} FROM ${srcExpr(s.dataPath)} ORDER BY ${sortCol} ${dir} NULLS LAST LIMIT ${limit} OFFSET ${from}`,
    );
    res.json({ rows, total: s.rowCount, from, limit, col, dir, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/filter ── */
router.post("/mx/filter", async (req: Request, res: Response) => {
  const { session, conditions = [], searchQ = "", from = 0, limit = 100, cols } = req.body;
  const s = getSession(session);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }

  const selCols   = (cols && Array.isArray(cols) && cols.length > 0)
    ? cols.filter((c: string) => s.headers.includes(c))
    : s.headers.slice(0, 50);
  const colList   = selCols.map((c: string) => `"${c.replace(/"/g, '""')}"`).join(", ");
  const where     = buildWhere(conditions, searchQ, s.headers);
  const safeFrom  = Math.max(0, parseInt(from) || 0);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 100));
  const src       = srcExpr(s.dataPath);

  try {
    const countRes = await query<{ total: number }>(`SELECT COUNT(*) as total FROM ${src} ${where}`);
    const total    = Number(countRes[0]?.total ?? 0);
    const rows     = await query(`SELECT ${colList} FROM ${src} ${where} LIMIT ${safeLimit} OFFSET ${safeFrom}`);
    res.json({ rows, total, from: safeFrom, limit: safeLimit, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── PATCH /api/mx/cell ── */
router.patch("/mx/cell", async (req: Request, res: Response) => {
  const { session, row, col, value } = req.body;
  const s = getSession(session);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }
  if (!s.headers.includes(col)) { res.status(400).json({ error: `Column "${col}" not found` }); return; }

  const rowIdx = parseInt(row);
  if (isNaN(rowIdx) || rowIdx < 0 || rowIdx >= s.rowCount) {
    res.status(400).json({ error: "Invalid row index" }); return;
  }

  const safeCol = col.replace(/"/g, '""');
  const safeVal = String(value ?? "").replace(/'/g, "''");
  const tmpPath = s.dataPath.replace(".csv", "_tmp.csv");

  try {
    await run(
      `COPY (
         SELECT * REPLACE (
           CASE WHEN row_number() OVER () = ${rowIdx + 1} THEN '${safeVal}' ELSE "${safeCol}" END AS "${safeCol}"
         )
         FROM ${srcExpr(s.dataPath)}
       ) TO '${tmpPath.replace(/'/g, "''")}' (FORMAT CSV, HEADER true)`,
    );
    fs.renameSync(tmpPath, s.dataPath);
    s.sortCache.clear();
    res.json({ ok: true });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/bulk-transform ── */
router.post("/mx/bulk-transform", async (req: Request, res: Response) => {
  const { session, operation, params } = req.body;
  const s = getSession(session);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }

  const src     = srcExpr(s.dataPath);
  const tmpPath = s.dataPath.replace(".csv", "_tmp.csv");
  const tmpSafe = tmpPath.replace(/'/g, "''");

  try {
    let sql = "";
    switch (operation) {
      case "fill-blanks": {
        const { col, fillValue } = params;
        if (!s.headers.includes(col)) { res.status(400).json({ error: "Column not found" }); return; }
        const c = col.replace(/"/g, '""'), v = String(fillValue ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (COALESCE(NULLIF("${c}", ''), '${v}') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }
      case "find-replace": {
        const { col, find, replace } = params;
        if (!s.headers.includes(col)) { res.status(400).json({ error: "Column not found" }); return; }
        const c = col.replace(/"/g, '""'), f = String(find ?? "").replace(/'/g, "''"), r = String(replace ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (regexp_replace("${c}", '${f}', '${r}', 'g') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }
      case "trim": {
        const { col } = params;
        if (!s.headers.includes(col)) { res.status(400).json({ error: "Column not found" }); return; }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (trim("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }
      case "lowercase": {
        const { col } = params;
        if (!s.headers.includes(col)) { res.status(400).json({ error: "Column not found" }); return; }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (lower("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }
      case "uppercase": {
        const { col } = params;
        if (!s.headers.includes(col)) { res.status(400).json({ error: "Column not found" }); return; }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (upper("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }
      default:
        res.status(400).json({ error: `Unknown operation: ${operation}` }); return;
    }

    await run(sql);
    fs.renameSync(tmpPath, s.dataPath);
    s.sortCache.clear();

    /* Re-count rows after transform */
    const countRes = await query<{ total: number }>(`SELECT COUNT(*) as total FROM ${srcExpr(s.dataPath)}`);
    res.json({ ok: true, affected: Number(countRes[0]?.total ?? 0) });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/export ──
 *  Stream the stored CSV file directly — no DuckDB needed, instant start.
 */
router.get("/mx/export", (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) { res.status(404).json({ error: "Session not found or expired" }); return; }

  const safeName = s.fileName.replace(/"/g, "").replace(/\.[^.]+$/, "") + "_export.csv";
  const size = (() => { try { return fs.statSync(s.dataPath).size; } catch { return 0; } })();

  res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  if (size > 0) res.setHeader("Content-Length", size.toString());

  const stream = fs.createReadStream(s.dataPath);
  stream.pipe(res);
  stream.on("error", () => res.end());
});

/* ── DELETE /api/mx/session ── */
router.delete("/mx/session", (req: Request, res: Response) => {
  const id = req.query.session as string;
  if (!getSession(id)) { res.status(404).json({ error: "Session not found" }); return; }
  deleteSession(id);
  res.json({ ok: true });
});

export default router;
