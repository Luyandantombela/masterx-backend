import { Router, Request, Response } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import readline from "readline";
import { query, run } from "../lib/duck.js";
import {
  createSession,
  getSession,
  deleteSession,
  UPLOAD_DIR,
} from "../lib/session-store.js";
import { logger } from "../lib/logger.js";

const router = Router();

/* ── Multer: accept CSV and JSON, store to UPLOAD_DIR ── */
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok =
      /\.(csv|json)$/i.test(file.originalname) ||
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
  return `read_csv('${p}', header=true, all_varchar=true, max_line_size=1048576, ignore_errors=true)`;
}

/* ── Minimal JS CSV line parser (handles quoted fields) ── */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur.trim());
      cur = "";
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
    rl.on("close", () => {
      if (!done) resolve([]);
    });
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
        if (buf[i] === 10) lines++;
      }
    });
    stream.on("end", () => resolve(Math.max(0, lines - 1)));
    stream.on("error", reject);
  });
}

/* ── Minimal JS CSV writer (for JSON-body uploads from XLSX) ── */
function rowsToCsv(headers: string[], rows: Record<string, unknown>[]): string {
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return s.includes(",") ||
      s.includes('"') ||
      s.includes("\n") ||
      s.includes("\r")
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  };
  const lines: string[] = [headers.map(esc).join(",")];
  for (const row of rows) lines.push(headers.map((h) => esc(row[h])).join(","));
  return lines.join("\n");
}

/* ── Refresh session headers/count after structural changes ── */
async function refreshSessionMeta(
  s: Awaited<ReturnType<typeof getSession>> & object,
): Promise<void> {
  const [newHeaders, newRowCount] = await Promise.all([
    readCsvHeader(s.dataPath),
    countCsvRows(s.dataPath),
  ]);
  s.headers = newHeaders;
  s.rowCount = newRowCount;
  s.colCount = newHeaders.length;
  const kept: Record<string, string> = {};
  for (const h of newHeaders) kept[h] = s.colTypes[h] ?? "VARCHAR";
  s.colTypes = kept;
  s.sortCache.clear();
}

function parseCols(
  colsParam: string | undefined,
  allHeaders: string[],
): string[] {
  if (!colsParam) return [];
  return colsParam
    .split(",")
    .map((c) => c.trim())
    .filter((c) => allHeaders.includes(c));
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
      case "eq":
        parts.push(`${c} = '${v}'`);
        break;
      case "neq":
        parts.push(`${c} != '${v}'`);
        break;
      case "contains":
        parts.push(`${c} ILIKE '%${v}%'`);
        break;
      case "ncontains":
        parts.push(`${c} NOT ILIKE '%${v}%'`);
        break;
      case "starts":
        parts.push(`${c} ILIKE '${v}%'`);
        break;
      case "ends":
        parts.push(`${c} ILIKE '%${v}'`);
        break;
      case "gt":
        parts.push(`TRY_CAST(${c} AS DOUBLE) > ${parseFloat(v) || 0}`);
        break;
      case "lt":
        parts.push(`TRY_CAST(${c} AS DOUBLE) < ${parseFloat(v) || 0}`);
        break;
      case "blank":
        parts.push(`(${c} IS NULL OR ${c} = '')`);
        break;
      case "nblank":
        parts.push(`(${c} IS NOT NULL AND ${c} != '')`);
        break;
    }
  }
  if (searchQ.trim()) {
    const sq = searchQ.replace(/'/g, "''");
    const searchParts = headers
      .slice(0, 20)
      .map((h) => `"${h.replace(/"/g, '""')}" ILIKE '%${sq}%'`);
    if (searchParts.length) parts.push(`(${searchParts.join(" OR ")})`);
  }
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

/* ── POST /api/mx/upload ── */
router.post(
  "/mx/upload",
  upload.single("file"),
  async (req: Request, res: Response) => {
    try {
      let headers: string[] = [];
      let rowCount = 0;
      let fileName = "upload.csv";
      let csvPath: string;

      if (req.file) {
        /* ── CSV multipart upload ── */
        fileName = req.file.originalname;
        csvPath = req.file.path + ".csv";
        fs.renameSync(req.file.path, csvPath);

        /* Read header + count rows with plain Node.js — no DuckDB, no OOM risk */
        headers = await readCsvHeader(csvPath);
        rowCount = await countCsvRows(csvPath);
      } else if (req.body && Array.isArray(req.body.rows)) {
        /* ── JSON upload (XLSX converted in browser) ── */
        const {
          rows,
          headers: hdrs,
          fileName: fn,
        } = req.body as {
          rows: Record<string, unknown>[];
          headers: string[];
          fileName?: string;
        };
        headers = hdrs ?? (rows[0] ? Object.keys(rows[0]) : []);
        rowCount = rows.length;
        fileName = fn ?? "upload.csv";
        csvPath = path.join(UPLOAD_DIR, `${Date.now()}.csv`);

        /* Write CSV directly — no DuckDB needed */
        fs.writeFileSync(csvPath, rowsToCsv(headers, rows), "utf8");
      } else {
        res.status(400).json({
          error: "Provide a CSV file (multipart) or JSON body {headers, rows}",
        });
        return;
      }

      if (!headers.length) {
        res.status(400).json({
          error:
            "Could not read column headers from the file. Is it a valid CSV?",
        });
        return;
      }

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

      logger.info(
        {
          sessionId: session.sessionId,
          rowCount,
          cols: headers.length,
          fileName,
        },
        "Session created",
      );
      res.json({
        sessionId: session.sessionId,
        rowCount,
        colCount: headers.length,
        headers,
        colTypes,
        fileName,
      });
    } catch (err) {
      logger.error(err, "Upload failed");
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

/* ── GET /api/mx/meta ── */
router.get("/mx/meta", (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  res.json({
    sessionId: s.sessionId,
    fileName: s.fileName,
    rowCount: s.rowCount,
    colCount: s.colCount,
    headers: s.headers,
    colTypes: s.colTypes,
  });
});

/* ── GET /api/mx/rows ── */
router.get("/mx/rows", async (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const from = Math.max(0, parseInt(req.query.from as string) || 0);
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(req.query.limit as string) || 100),
  );
  const cols = parseCols(req.query.cols as string, s.headers);
  const selCols = cols.length > 0 ? cols : s.headers.slice(0, 50);
  const colList = selCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");

  try {
    const rows = await query(
      `SELECT ${colList} FROM ${srcExpr(s.dataPath)} LIMIT ${limit} OFFSET ${from}`,
    );
    res.json({ rows, total: s.rowCount, from, limit, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/sort ── */
router.get("/mx/sort", async (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const col = req.query.col as string;
  const dir =
    (req.query.dir as string)?.toLowerCase() === "desc" ? "DESC" : "ASC";
  const from = Math.max(0, parseInt(req.query.from as string) || 0);
  const limit = Math.min(
    1000,
    Math.max(1, parseInt(req.query.limit as string) || 100),
  );
  const cols = parseCols(req.query.cols as string, s.headers);
  const selCols = cols.length > 0 ? cols : s.headers.slice(0, 50);

  if (!s.headers.includes(col)) {
    res.status(400).json({ error: `Column "${col}" not found` });
    return;
  }

  const colList = selCols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
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
  const {
    session,
    conditions = [],
    searchQ = "",
    from = 0,
    limit = 100,
    cols,
  } = req.body;
  const s = getSession(session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const selCols =
    cols && Array.isArray(cols) && cols.length > 0
      ? cols.filter((c: string) => s.headers.includes(c))
      : s.headers.slice(0, 50);
  const colList = selCols
    .map((c: string) => `"${c.replace(/"/g, '""')}"`)
    .join(", ");
  const where = buildWhere(conditions, searchQ, s.headers);
  const safeFrom = Math.max(0, parseInt(from) || 0);
  const safeLimit = Math.min(1000, Math.max(1, parseInt(limit) || 100));
  const src = srcExpr(s.dataPath);

  try {
    const countRes = await query<{ total: number }>(
      `SELECT COUNT(*) as total FROM ${src} ${where}`,
    );
    const total = Number(countRes[0]?.total ?? 0);
    const rows = await query(
      `SELECT ${colList} FROM ${src} ${where} LIMIT ${safeLimit} OFFSET ${safeFrom}`,
    );
    res.json({ rows, total, from: safeFrom, limit: safeLimit, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── PATCH /api/mx/cell ── */
router.patch("/mx/cell", async (req: Request, res: Response) => {
  const { session, row, col, value } = req.body;
  const s = getSession(session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!s.headers.includes(col)) {
    res.status(400).json({ error: `Column "${col}" not found` });
    return;
  }

  const rowIdx = parseInt(row);
  if (isNaN(rowIdx) || rowIdx < 0 || rowIdx >= s.rowCount) {
    res.status(400).json({ error: "Invalid row index" });
    return;
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
    logger.info(
      { sessionId: s.sessionId, row: rowIdx, col, value: safeVal },
      `BACKEND: edited cell — column "${col}", row ${rowIdx}`,
    );
    res.json({ ok: true });
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/bulk-transform ── */
router.post("/mx/bulk-transform", async (req: Request, res: Response) => {
  const { session, operation, params } = req.body;
  const s = getSession(session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const src = srcExpr(s.dataPath);
  const tmpPath = s.dataPath.replace(".csv", "_tmp.csv");
  const tmpSafe = tmpPath.replace(/'/g, "''");

  /* Track whether we need to re-read headers/count after the op */
  let structuralChange = false;
  let rowCountChange = false;

  try {
    let sql = "";

    switch (operation) {
      /* ── Value transforms (column values changed, schema unchanged) ── */

      case "fill-blanks": {
        const { col, fillValue } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""'),
          v = String(fillValue ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (COALESCE(NULLIF(trim("${c}"), ''), '${v}') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "find-replace": {
        const { col, find, replace } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const f = String(find ?? "")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/'/g, "''");
        const r = String(replace ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (regexp_replace("${c}", '${f}', '${r}', 'g') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "trim": {
        const { col } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (trim("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "lowercase": {
        const { col } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (lower("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "uppercase": {
        const { col } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (upper("${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "capitalize": {
        const { col } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (array_to_string(list_transform(string_split(lower("${c}"), ' '), x -> upper(x[1:1]) || x[2:]), ' ') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "prefix-add": {
        const { col, prefix, space } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const sep = space ? " " : "";
        const pfx = String(prefix ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (concat('${pfx}${sep}', "${c}") AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "prefix-remove": {
        const { col, prefix, space } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const sep = space ? " " : "";
        const pfxFull = String(prefix ?? "") + sep;
        const pfxSafe = pfxFull.replace(/'/g, "''");
        const pfxLen = pfxFull.length;
        sql = `COPY (SELECT * REPLACE (
          CASE WHEN starts_with("${c}", '${pfxSafe}')
          THEN substr("${c}", ${pfxLen + 1})
          ELSE "${c}" END AS "${c}"
        ) FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "suffix-add": {
        const { col, suffix, space } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const sep = space ? " " : "";
        const sfx = String(suffix ?? "").replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (concat("${c}", '${sep}${sfx}') AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "suffix-remove": {
        const { col, suffix, space } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const sep = space ? " " : "";
        const sfxFull = sep + String(suffix ?? "");
        const sfxSafe = sfxFull.replace(/'/g, "''");
        const sfxLen = sfxFull.length;
        sql = `COPY (SELECT * REPLACE (
          CASE WHEN ends_with("${c}", '${sfxSafe}')
          THEN left("${c}", length("${c}") - ${sfxLen})
          ELSE "${c}" END AS "${c}"
        ) FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "date-format": {
        const { col, outputFmt } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        /* Convert user format tokens to DuckDB strftime format */
        const duckFmt = String(outputFmt ?? "YYYY-MM-DD")
          .replace("YYYY", "%Y")
          .replace("MM", "%m")
          .replace("DD", "%d")
          .replace(/'/g, "''");
        sql = `COPY (SELECT * REPLACE (
          CASE WHEN TRY_CAST("${c}" AS DATE) IS NOT NULL
          THEN strftime(TRY_CAST("${c}" AS DATE), '${duckFmt}')
          ELSE "${c}" END AS "${c}"
        ) FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "number-format": {
        const { col, decimals } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const c = col.replace(/"/g, '""');
        const d = Math.max(
          0,
          Math.min(10, parseInt(String(decimals ?? 2)) || 0),
        );
        sql = `COPY (SELECT * REPLACE (
          CASE WHEN TRY_CAST("${c}" AS DOUBLE) IS NOT NULL
          THEN printf('%.${d}f', TRY_CAST("${c}" AS DOUBLE))
          ELSE "${c}" END AS "${c}"
        ) FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      case "change-type": {
        const { col, toType } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const allowed = [
          "VARCHAR",
          "INTEGER",
          "BIGINT",
          "DOUBLE",
          "FLOAT",
          "DATE",
          "BOOLEAN",
          "TIMESTAMP",
        ];
        const t = String(toType ?? "VARCHAR").toUpperCase();
        if (!allowed.includes(t)) {
          res
            .status(400)
            .json({ error: `Type must be one of: ${allowed.join(", ")}` });
          return;
        }
        const c = col.replace(/"/g, '""');
        sql = `COPY (SELECT * REPLACE (TRY_CAST("${c}" AS ${t}) AS "${c}") FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      /* ── Structural transforms (schema changes — headers refreshed after) ── */

      case "rename-column": {
        const { col, newName } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const newNameStr = String(newName ?? "").trim();
        if (!newNameStr || s.headers.includes(newNameStr)) {
          res.status(400).json({ error: "Invalid or duplicate column name" });
          return;
        }
        const newSafe = newNameStr.replace(/"/g, '""');
        const colList = s.headers
          .map((h) => {
            const hSafe = h.replace(/"/g, '""');
            return h === col ? `"${hSafe}" AS "${newSafe}"` : `"${hSafe}"`;
          })
          .join(", ");
        sql = `COPY (SELECT ${colList} FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        structuralChange = true;
        break;
      }

      case "delete-column": {
        const { col } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const remaining = s.headers.filter((h) => h !== col);
        if (!remaining.length) {
          res.status(400).json({ error: "Cannot delete the only column" });
          return;
        }
        const colList = remaining
          .map((h) => `"${h.replace(/"/g, '""')}"`)
          .join(", ");
        sql = `COPY (SELECT ${colList} FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        structuralChange = true;
        break;
      }

      case "delete-rows": {
        /* indices / rowIdxs: 0-based row indices to delete (relative to UNFILTERED file) */
        const indices = params.rowIdxs ?? params.indices;
        if (!Array.isArray(indices) || !indices.length) {
          res.status(400).json({ error: "No row indices provided" });
          return;
        }
        const notIn = [...new Set<number>(indices.map(Number))]
          .map((i) => i + 1)
          .join(", ");
        const allCols = s.headers
          .map((h) => `"${h.replace(/"/g, '""')}"`)
          .join(", ");
        sql = `COPY (
          SELECT ${allCols} FROM (
            SELECT *, row_number() OVER () AS _rn FROM ${src}
          ) t WHERE _rn NOT IN (${notIn})
        ) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        rowCountChange = true;
        break;
      }

      case "split": {
        /* splitters: string[] — sequential delimiters to split the column by */
        const { col, splitters } = params;
        if (!s.headers.includes(col)) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        if (!Array.isArray(splitters) || !splitters.length) {
          res.status(400).json({ error: "No splitters provided" });
          return;
        }
        const c = col.replace(/"/g, '""');

        /* Build a regex that matches any of the splitters */
        const delimRegex = (splitters as string[])
          .map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("|");
        const delimSafe = delimRegex.replace(/'/g, "''");

        /* Generate N+1 unique new column names */
        const newColNames: string[] = [];
        for (let i = 0; i <= splitters.length; i++) {
          let name = "split_" + (i + 1);
          let cnt = 0;
          while (s.headers.includes(name) || newColNames.includes(name))
            name = `split_${i + 1}_${++cnt}`;
          newColNames.push(name);
        }

        const allExisting = s.headers
          .map((h) => `"${h.replace(/"/g, '""')}"`)
          .join(", ");
        const splitExprs = newColNames
          .map((nc, i) => {
            const ncSafe = nc.replace(/"/g, '""');
            return `string_split_regex("${c}", '${delimSafe}')[${i + 1}] AS "${ncSafe}"`;
          })
          .join(", ");
        sql = `COPY (SELECT ${allExisting}, ${splitExprs} FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        structuralChange = true;
        break;
      }

      case "add-column": {
        const rawName = params.newName ?? params.newColName;
        const rawExpr = params.expr ?? params.expression;
        const ncStr = String(rawName ?? "").trim();
        if (!ncStr || s.headers.includes(ncStr)) {
          res.status(400).json({ error: "Invalid or duplicate column name" });
          return;
        }
        const ncSafe = ncStr.replace(/"/g, '""');
        const expr = String(rawExpr ?? "''");
        sql = `COPY (SELECT *, (${expr}) AS "${ncSafe}" FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        structuralChange = true;
        break;
      }

      default:
        res.status(400).json({ error: `Unknown operation: ${operation}` });
        return;
    }

    await run(sql);
    fs.renameSync(tmpPath, s.dataPath);
    s.sortCache.clear();

    /* Refresh session metadata if schema or row count changed */
    if (structuralChange || rowCountChange) {
      await refreshSessionMeta(s);
    }

    logger.info(
      {
        sessionId: s.sessionId,
        operation,
        column: params?.col ?? params?.newName ?? params?.newColName ?? null,
        rowCount: s.rowCount,
        colCount: s.colCount,
      },
      `BACKEND: bulk-transform "${operation}"${params?.col ? ` on column "${params.col}"` : ""} — ${s.rowCount} rows`,
    );

    res.json({
      ok: true,
      rowCount: s.rowCount,
      colCount: s.colCount,
      headers: s.headers,
      colTypes: s.colTypes,
    });
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/apply-sql ──
 *  Execute a user-supplied or AI-generated SELECT statement and write the
 *  result back as the session's CSV.  The SQL must be a SELECT only — we wrap
 *  it in a COPY ... TO statement and execute it against the session file.
 *
 *  Body: { session, sql }   — sql should be a SELECT (not a COPY/DDL).
 */
router.post("/mx/apply-sql", async (req: Request, res: Response) => {
  const { session, sql } = req.body;
  if (
    !sql ||
    typeof sql !== "string" ||
    !sql.trim().toUpperCase().startsWith("SELECT")
  ) {
    res.status(400).json({ error: "sql must be a SELECT statement" });
    return;
  }

  const s = getSession(session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const tmpPath = s.dataPath.replace(".csv", "_tmp.csv");
  const tmpSafe = tmpPath.replace(/'/g, "''");

  /* Wrap the user SELECT in a CTE so "FROM data" resolves to the session CSV */
  const wrappedSql = `COPY (WITH data AS (SELECT * FROM ${srcExpr(s.dataPath)}) ${sql.trim()}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;

  try {
    await run(wrappedSql);
    fs.renameSync(tmpPath, s.dataPath);
    await refreshSessionMeta(s);
    logger.info(
      {
        sessionId: s.sessionId,
        sql: sql.trim(),
        rowCount: s.rowCount,
        colCount: s.colCount,
      },
      `BACKEND: applied SQL transform — ${s.rowCount} rows, ${s.colCount} columns`,
    );
    res.json({
      ok: true,
      rowCount: s.rowCount,
      colCount: s.colCount,
      headers: s.headers,
      colTypes: s.colTypes,
    });
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/export ──
 *  Stream the stored CSV file directly — no DuckDB needed, instant start.
 */
router.get("/mx/export", (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const safeName =
    s.fileName.replace(/"/g, "").replace(/\.[^.]+$/, "") + "_export.csv";
  const size = (() => {
    try {
      return fs.statSync(s.dataPath).size;
    } catch {
      return 0;
    }
  })();

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
  if (!getSession(id)) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  deleteSession(id);
  res.json({ ok: true });
});

export default router;
