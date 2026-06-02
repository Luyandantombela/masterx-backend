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
  unlinkQuiet,
  UPLOAD_DIR,
  UNDO_DEPTH,
  type SessionMeta,
  type ColQuality,
} from "../lib/session-store.js";
import { logger } from "../lib/logger.js";

const router = Router();

/* ── Versioning helpers (undo/redo) ──────────────────────────────────────
 * Every mutation writes a fresh CSV to a tmp file, then we RENAME it to a new
 * unique version path and remember the previous path for undo. No extra copy
 * is made — the write already produced the new file. Disk usage is bounded to
 * (UNDO_DEPTH + 1) historical versions per session.
 */
function newVersionPath(s: SessionMeta): string {
  return path.join(
    UPLOAD_DIR,
    `${s.sessionId}_v${Date.now()}_${Math.random().toString(36).slice(2, 8)}.csv`,
  );
}

function commitNewVersion(s: SessionMeta, tmpPath: string): void {
  const dest = newVersionPath(s);
  fs.renameSync(tmpPath, dest);
  s.undoStack.push(s.dataPath);
  s.dataPath = dest;
  /* New edit creates a fresh branch — discard any redo history. */
  for (const p of s.redoStack) unlinkQuiet(p);
  s.redoStack = [];
  /* Trim undo history beyond the configured depth. */
  while (s.undoStack.length > UNDO_DEPTH) {
    const old = s.undoStack.shift();
    if (old) unlinkQuiet(old);
  }
  s.version++;
  s.summary = undefined;
  s.sortCache.clear();
}

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

function buildPredicates(
  conditions: Array<{ col: string; op: string; value: string }>,
  searchQ: string,
  headers: string[],
): string[] {
  const parts: string[] = [];
  for (const { col, op, value } of conditions) {
    if (!headers.includes(col)) continue;
    const c = `"${col.replace(/"/g, '""')}"`;
    const v = String(value ?? "").replace(/'/g, "''");
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
      case "ge":
        parts.push(`TRY_CAST(${c} AS DOUBLE) >= ${parseFloat(v) || 0}`);
        break;
      case "le":
        parts.push(`TRY_CAST(${c} AS DOUBLE) <= ${parseFloat(v) || 0}`);
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
  return parts;
}

function buildWhere(
  conditions: Array<{ col: string; op: string; value: string }>,
  searchQ: string,
  headers: string[],
): string {
  const parts = buildPredicates(conditions, searchQ, headers);
  return parts.length ? `WHERE ${parts.join(" AND ")}` : "";
}

/* ── Unified windowed-view composition ──────────────────────────────────
 * Builds the CTE/WHERE/ORDER BY fragments shared by POST /mx/view and the
 * filtered branch of GET /mx/export. All ops run on the backend; the browser
 * only ever receives a single on-screen window plus aggregate summaries.
 */
interface ViewParams {
  cols?: string[];
  search?: string;
  conditions?: Array<{ col: string; op: string; value: string }>;
  sort?: { col: string; dir?: string; type?: string } | null;
  dupesOnly?: boolean;
  blanksOnly?: boolean;
  rowRange?: { from?: unknown; to?: unknown } | null;
  withDupFlag?: boolean;
}

interface ComposedView {
  cteSql: string;
  tbl: string;
  where: string;
  orderBy: string;
  selCols: string[];
  needDup: boolean;
}

function quoteCol(c: string): string {
  return `"${c.replace(/"/g, '""')}"`;
}

function composeView(s: SessionMeta, p: ViewParams): ComposedView {
  const src = srcExpr(s.dataPath);
  const selCols =
    Array.isArray(p.cols) && p.cols.length
      ? p.cols.filter((c) => s.headers.includes(c))
      : s.headers.slice();

  const needDup = !!(p.withDupFlag || p.dupesOnly) && s.headers.length > 0;

  /* Case-insensitive, trimmed full-row signature — matches the client's
   * dedupe semantics (first occurrence kept, rest flagged as duplicates). */
  const sig = s.headers.map((c) => `lower(trim(${quoteCol(c)}))`).join(", ");

  let cteSql: string;
  let tbl: string;
  if (needDup) {
    cteSql =
      `base AS (SELECT *, (row_number() OVER ()) - 1 AS _mxidx FROM ${src}), ` +
      `flagged AS (SELECT *, (row_number() OVER (PARTITION BY ${sig} ORDER BY _mxidx) > 1) AS _isdup FROM base)`;
    tbl = "flagged";
  } else {
    cteSql = `base AS (SELECT *, (row_number() OVER ()) - 1 AS _mxidx FROM ${src})`;
    tbl = "base";
  }

  const preds = buildPredicates(
    p.conditions ?? [],
    p.search ?? "",
    s.headers,
  );

  if (p.blanksOnly) {
    const bp = selCols.map((c) => {
      const q = quoteCol(c);
      return `(${q} IS NULL OR ${q} = '')`;
    });
    if (bp.length) preds.push(`(${bp.join(" OR ")})`);
  }

  if (p.rowRange) {
    const f = parseInt(String(p.rowRange.from), 10);
    const t = parseInt(String(p.rowRange.to), 10);
    if (!isNaN(f)) preds.push(`(_mxidx + 1) >= ${f}`);
    if (!isNaN(t)) preds.push(`(_mxidx + 1) <= ${t}`);
  }

  if (p.dupesOnly) preds.push(`_isdup`);

  const where = preds.length ? `WHERE ${preds.join(" AND ")}` : "";

  let orderBy = "ORDER BY _mxidx";
  if (p.sort && p.sort.col && s.headers.includes(p.sort.col)) {
    const sc = quoteCol(p.sort.col);
    const dir = String(p.sort.dir).toLowerCase() === "desc" ? "DESC" : "ASC";
    let expr = sc;
    if (p.sort.type === "number") expr = `TRY_CAST(${sc} AS DOUBLE)`;
    else if (p.sort.type === "date") expr = `TRY_CAST(${sc} AS DATE)`;
    orderBy = `ORDER BY ${expr} ${dir} NULLS LAST, _mxidx`;
  }

  return { cteSql, tbl, where, orderBy, selCols, needDup };
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
    commitNewVersion(s, tmpPath);
    logger.info(
      { sessionId: s.sessionId, row: rowIdx, col, value: safeVal },
      `BACKEND: edited cell — column "${col}", row ${rowIdx}`,
    );
    res.json({
      ok: true,
      version: s.version,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
    });
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
        /* Accept a single `col` or a `cols` array so deleting several columns
         * is one atomic op = one undo step. */
        const reqCols = Array.isArray(params.cols)
          ? params.cols
          : params.col != null
            ? [params.col]
            : [];
        const toDelete = reqCols.filter((c: string) => s.headers.includes(c));
        if (!toDelete.length) {
          res.status(400).json({ error: "Column not found" });
          return;
        }
        const delSet = new Set(toDelete);
        const remaining = s.headers.filter((h) => !delSet.has(h));
        if (!remaining.length) {
          res.status(400).json({ error: "Cannot delete all columns" });
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

      case "dedupe": {
        /* Keep the FIRST occurrence of each full-row signature (case-insensitive,
         * trimmed) — matches the client's dedupe semantics. */
        if (!s.headers.length) {
          res.status(400).json({ error: "No columns to dedupe" });
          return;
        }
        const sig = s.headers
          .map((h) => `lower(trim("${h.replace(/"/g, '""')}"))`)
          .join(", ");
        const allCols = s.headers
          .map((h) => `"${h.replace(/"/g, '""')}"`)
          .join(", ");
        sql = `COPY (
          SELECT ${allCols} FROM (
            SELECT *, row_number() OVER (PARTITION BY ${sig} ORDER BY _mxidx) AS _dn
            FROM (SELECT *, (row_number() OVER ()) - 1 AS _mxidx FROM ${src})
          ) WHERE _dn = 1
        ) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        rowCountChange = true;
        break;
      }

      /* ── Whole-file one-pass clean (blank-fill + casing/number/date/email
       * normalization per column) — a single COPY so "Fix All" is one undo
       * step regardless of column count. ── */
      case "clean-all": {
        const casing = String(params.casing ?? "title");
        const decRaw = parseInt(String(params.decimals ?? 2));
        const decimals = Math.max(0, Math.min(10, isNaN(decRaw) ? 2 : decRaw));
        const duckFmt = String(params.dateFormat ?? "YYYY-MM-DD")
          .replace("YYYY", "%Y")
          .replace("MM", "%m")
          .replace("DD", "%d")
          .replace(/'/g, "''");
        const defaults = (params.defaults ?? {}) as Record<string, unknown>;
        const colTypes = (params.colTypes ?? {}) as Record<string, string>;
        const defText = String(defaults.text ?? "N/A").replace(/'/g, "''");
        const defNum = String(defaults.number ?? "0").replace(/'/g, "''");
        const defDate = String(defaults.date ?? "0000-00-00").replace(
          /'/g,
          "''",
        );
        const defEmail = String(defaults.email ?? "N/A").replace(/'/g, "''");
        const blankDefaults = (params.blankDefaults ?? {}) as Record<
          string,
          unknown
        >;

        if (!s.headers.length) {
          res.status(400).json({ error: "No columns to clean" });
          return;
        }

        const replaceExprs = s.headers.map((h) => {
          const q = `"${h.replace(/"/g, '""')}"`;
          const type = String(colTypes[h] ?? "text");
          let dflt = defText;
          if (type === "number") dflt = defNum;
          else if (type === "date") dflt = defDate;
          else if (type === "email") dflt = defEmail;
          if (Object.prototype.hasOwnProperty.call(blankDefaults, h))
            dflt = String(blankDefaults[h] ?? "").replace(/'/g, "''");
          /* Transform the real (non-blank) value, then COALESCE to the
           * default so the fill value is inserted verbatim (e.g. "N/A" is
           * never itself title-cased to "N/a"). */
          const base = `NULLIF(trim(${q}), '')`;
          let t: string;
          if (type === "number") {
            t = `CASE WHEN TRY_CAST(${base} AS DOUBLE) IS NOT NULL THEN printf('%.${decimals}f', TRY_CAST(${base} AS DOUBLE)) ELSE ${base} END`;
          } else if (type === "date") {
            t = `CASE WHEN TRY_CAST(${base} AS DATE) IS NOT NULL THEN strftime(TRY_CAST(${base} AS DATE), '${duckFmt}') ELSE ${base} END`;
          } else if (type === "email") {
            t = `lower(${base})`;
          } else if (casing === "upper") {
            t = `upper(${base})`;
          } else if (casing === "lower") {
            t = `lower(${base})`;
          } else {
            t = `array_to_string(list_transform(string_split(lower(${base}), ' '), x -> upper(x[1:1]) || x[2:]), ' ')`;
          }
          return `COALESCE(${t}, '${dflt}') AS ${q}`;
        });

        sql = `COPY (SELECT * REPLACE (${replaceExprs.join(", ")}) FROM ${src}) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        break;
      }

      /* ── Delete every row matching the active view (filters/search/dupes/
       * blanks/rowRange). Keeps the complement. Refuses an unfiltered call so
       * we never wipe the whole file. ── */
      case "delete-matching": {
        const vp = (params.view ?? {}) as ViewParams;
        const viewParams: ViewParams = {
          search: typeof vp.search === "string" ? vp.search : "",
          conditions: Array.isArray(vp.conditions) ? vp.conditions : [],
          dupesOnly: !!vp.dupesOnly,
          blanksOnly: !!vp.blanksOnly,
          rowRange: vp.rowRange ?? null,
          withDupFlag: !!vp.dupesOnly,
        };
        const cv = composeView(s, viewParams);
        if (!cv.where) {
          res.status(400).json({
            error: "Refusing to delete the entire file; apply a filter first",
          });
          return;
        }
        const allCols = s.headers
          .map((h) => `"${h.replace(/"/g, '""')}"`)
          .join(", ");
        sql = `COPY (WITH ${cv.cteSql} SELECT ${allCols} FROM ${cv.tbl} WHERE _mxidx NOT IN (SELECT _mxidx FROM ${cv.tbl} ${cv.where})) TO '${tmpSafe}' (FORMAT CSV, HEADER true)`;
        rowCountChange = true;
        break;
      }

      default:
        res.status(400).json({ error: `Unknown operation: ${operation}` });
        return;
    }

    await run(sql);
    commitNewVersion(s, tmpPath);

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
      version: s.version,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
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
    commitNewVersion(s, tmpPath);
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
      version: s.version,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
    });
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/view ──
 *  Unified windowed read. Returns a single on-screen window of rows plus the
 *  total matching count, computed entirely on the backend (DuckDB). Each row
 *  carries a stable `_mxidx` (file-order index) and, when requested, `_isdup`.
 *
 *  Body: {
 *    session, from, limit, cols?, search?, conditions?[],
 *    sort?:{col,dir,type}, dupesOnly?, blanksOnly?, rowRange?:{from,to},
 *    withDupFlag?
 *  }
 */
router.post("/mx/view", async (req: Request, res: Response) => {
  const body = req.body ?? {};
  const s = getSession(body.session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const safeFrom = Math.max(0, parseInt(String(body.from), 10) || 0);
  const safeLimit = Math.min(
    5000,
    Math.max(1, parseInt(String(body.limit), 10) || 100),
  );

  const params: ViewParams = {
    cols: Array.isArray(body.cols) ? body.cols : undefined,
    search: typeof body.search === "string" ? body.search : "",
    conditions: Array.isArray(body.conditions) ? body.conditions : [],
    sort: body.sort && body.sort.col ? body.sort : null,
    dupesOnly: !!body.dupesOnly,
    blanksOnly: !!body.blanksOnly,
    rowRange: body.rowRange ?? null,
    withDupFlag: !!body.withDupFlag,
  };

  const hasFilter = viewHasFilter(params, s);

  try {
    /* Fast path: no filter/sort/dup → stream scan with LIMIT/OFFSET, which
     * short-circuits the streaming row_number() window. Total is known. */
    if (!hasFilter && !params.withDupFlag) {
      const selCols =
        params.cols && params.cols.length
          ? params.cols.filter((c) => s.headers.includes(c))
          : s.headers.slice();
      const colList = selCols.map((c) => quoteCol(c)).join(", ");
      const selectExpr = colList ? `${colList}, ` : "";
      const rows = await query(
        `SELECT ${selectExpr}(row_number() OVER ()) - 1 AS _mxidx ` +
          `FROM ${srcExpr(s.dataPath)} LIMIT ${safeLimit} OFFSET ${safeFrom}`,
      );
      res.json({
        rows,
        total: s.rowCount,
        from: safeFrom,
        limit: safeLimit,
        cols: selCols,
      });
      return;
    }

    /* General path: filter/sort/dup require a full scan + ORDER BY for stable
     * pagination (preserve_insertion_order is off, so order must be explicit). */
    const { cteSql, tbl, where, orderBy, selCols, needDup } = composeView(
      s,
      params,
    );
    const colList = selCols.map((c) => quoteCol(c)).join(", ");
    const selectExpr = colList ? `${colList}, ` : "";
    const flagSel = needDup ? ", _isdup" : "";

    const countRes = await query(
      `WITH ${cteSql} SELECT COUNT(*) AS total FROM ${tbl} ${where}`,
    );
    const total = Number(countRes[0]?.total ?? 0);

    const rows = await query(
      `WITH ${cteSql} SELECT ${selectExpr}_mxidx${flagSel} FROM ${tbl} ${where} ${orderBy} ` +
        `LIMIT ${safeLimit} OFFSET ${safeFrom}`,
    );

    res.json({ rows, total, from: safeFrom, limit: safeLimit, cols: selCols });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── Quality-detection SQL (mirrors the client's JS rules exactly) ──
 * These run over the FULL file on the backend so the browser never inspects
 * more than its on-screen window. `q` is an already-quoted column reference.
 */

/* Text-casing pattern of a value: 'upper' | 'lower' | 'title' | 'mixed'
 * (matches getCasingPattern in masterx_updated.html). */
function casingPatternSql(q: string): string {
  return `CASE
      WHEN trim(${q}) = upper(trim(${q})) AND regexp_matches(trim(${q}), '[A-Z]') THEN 'upper'
      WHEN trim(${q}) = lower(trim(${q})) THEN 'lower'
      WHEN list_aggregate(list_transform(string_split_regex(trim(${q}), '\\s+'),
            w -> ((w = upper(w) AND length(w) <= 3)
                  OR (left(w, 1) = upper(left(w, 1)) AND substr(w, 2) = lower(substr(w, 2))))
          ), 'bool_and') THEN 'title'
      ELSE 'mixed'
    END`;
}

/* Date format of a value: 'YYYY/MM/DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'unknown'
 * (matches detectDateFormat in masterx_updated.html). */
function dateFormatSql(q: string): string {
  return `CASE
      WHEN regexp_matches(trim(${q}), '^\\d{4}[-/]\\d{2}[-/]\\d{2}$') THEN 'YYYY/MM/DD'
      WHEN regexp_matches(trim(${q}), '^\\d{2}[-/]\\d{2}[-/]\\d{4}$') THEN
        CASE WHEN TRY_CAST(split_part(replace(trim(${q}), '-', '/'), '/', 1) AS INTEGER) > 12
             THEN 'DD/MM/YYYY' ELSE 'MM/DD/YYYY' END
      ELSE 'unknown'
    END`;
}

/* Boolean: value is a non-blank invalid email (matches isInvalidEmail). */
function emailInvalidSql(q: string): string {
  const e = `lower(trim(${q}))`;
  return `(${q} IS NOT NULL AND trim(${q}) <> '' AND (
      ${e} IN ('none', 'null', 'n/a', 'na')
      OR position('@' IN ${e}) = 0
      OR ${e} LIKE '@%'
      OR ${e} LIKE '%@'
      OR NOT regexp_matches(split_part(${e}, '@', 2), '\\.[a-z]{2,}$')
    ))`;
}

/* Dominant value + count-of-mismatches over a grouped {value,count} result.
 * Returns issues = 0 when there is only a single distinct group (matches the
 * client, which reports inconsistencies only when >1 distinct pattern). */
function dominantAndIssues(
  rows: Array<Record<string, unknown>>,
  valueKey: string,
): { dominant: string; issues: number } {
  let total = 0;
  let maxCount = -1;
  let dominant = "";
  for (const r of rows) {
    const c = Number(r.c ?? 0);
    total += c;
    if (c > maxCount) {
      maxCount = c;
      dominant = String(r[valueKey] ?? "");
    }
  }
  const issues = rows.length > 1 ? total - maxCount : 0;
  return { dominant, issues };
}

/* ── POST /api/mx/summary ──
 *  Whole-file quality aggregates computed entirely on the backend:
 *  duplicate count, blank counts per column, plus per-column casing / date /
 *  email issue counts (driven by the client-supplied semantic `colTypes`).
 *  Cached on the session and invalidated on every mutation (via version) or
 *  whenever the column types change.
 *
 *  Body: { session, colTypes?: { [col]: 'text'|'number'|'date'|'email'|... } }
 */
router.post("/mx/summary", async (req: Request, res: Response) => {
  const s = getSession(req.body?.session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const colTypes: Record<string, string> =
    req.body?.colTypes && typeof req.body.colTypes === "object"
      ? (req.body.colTypes as Record<string, string>)
      : {};
  const colTypesKey = JSON.stringify(colTypes);

  const respond = (sum: typeof s.summary, cached: boolean) => {
    if (!sum) return;
    res.json({
      ok: true,
      rowCount: s.rowCount,
      colCount: s.colCount,
      dupCount: sum.dupCount,
      totalBlanks: sum.totalBlanks,
      blanksByCol: sum.blanksByCol,
      casingTotal: sum.casingTotal,
      dateTotal: sum.dateTotal,
      emailTotal: sum.emailTotal,
      qualityByCol: sum.qualityByCol,
      cached,
    });
  };

  if (
    s.summary &&
    s.summary.version === s.version &&
    s.summary.colTypesKey === colTypesKey
  ) {
    respond(s.summary, true);
    return;
  }

  const cols = s.headers;
  if (!cols.length) {
    s.summary = {
      version: s.version,
      colTypesKey,
      dupCount: 0,
      totalBlanks: 0,
      blanksByCol: {},
      casingTotal: 0,
      dateTotal: 0,
      emailTotal: 0,
      qualityByCol: {},
    };
    respond(s.summary, false);
    return;
  }

  const src = srcExpr(s.dataPath);
  const sig = cols.map((c) => `lower(trim(${quoteCol(c)}))`).join(", ");

  try {
    /* Duplicate rows (full-row, case-insensitive, first occurrence kept). */
    const dupRes = await query(
      `WITH base AS (SELECT *, (row_number() OVER ()) - 1 AS _mxidx FROM ${src}), ` +
        `f AS (SELECT (row_number() OVER (PARTITION BY ${sig} ORDER BY _mxidx) > 1) AS d FROM base) ` +
        `SELECT COUNT(*) AS dupCount FROM f WHERE d`,
    );
    const dupCount = Number(dupRes[0]?.dupCount ?? 0);

    /* Blanks per column + invalid-email counts for email columns: one pass. */
    const aggExprs = cols.map((c, i) => {
      const q = quoteCol(c);
      const parts = [
        `SUM(CASE WHEN ${q} IS NULL OR ${q} = '' THEN 1 ELSE 0 END) AS b${i}`,
      ];
      if (colTypes[c] === "email") {
        parts.push(`SUM(CASE WHEN ${emailInvalidSql(q)} THEN 1 ELSE 0 END) AS e${i}`);
      }
      return parts.join(", ");
    });
    const aggRes = await query(`SELECT ${aggExprs.join(", ")} FROM ${src}`);
    const row0 = (aggRes[0] ?? {}) as Record<string, unknown>;

    const blanksByCol: Record<string, number> = {};
    const qualityByCol: Record<string, ColQuality> = {};
    let totalBlanks = 0;
    let emailTotal = 0;
    cols.forEach((c, i) => {
      const n = Number(row0["b" + i] ?? 0);
      blanksByCol[c] = n;
      totalBlanks += n;
      if (colTypes[c] === "email") {
        const ei = Number(row0["e" + i] ?? 0);
        emailTotal += ei;
        qualityByCol[c] = { type: "email", emailIssues: ei };
      }
    });

    /* Per-column casing (text) and date (date) — grouped pattern queries.
     * Each is over non-blank values only, matching the client. */
    let casingTotal = 0;
    let dateTotal = 0;
    for (const c of cols) {
      const t = colTypes[c];
      const q = quoteCol(c);
      const nonBlank = `${q} IS NOT NULL AND trim(${q}) <> ''`;
      if (t === "text") {
        const gr = await query(
          `SELECT pat, COUNT(*) AS c FROM ` +
            `(SELECT ${casingPatternSql(q)} AS pat FROM ${src} WHERE ${nonBlank}) ` +
            `GROUP BY pat`,
        );
        const { dominant, issues } = dominantAndIssues(gr, "pat");
        casingTotal += issues;
        qualityByCol[c] = { type: "text", casingPattern: dominant, casingIssues: issues };
      } else if (t === "date") {
        const gr = await query(
          `SELECT fmt, COUNT(*) AS c FROM ` +
            `(SELECT ${dateFormatSql(q)} AS fmt FROM ${src} WHERE ${nonBlank}) ` +
            `GROUP BY fmt`,
        );
        const { dominant, issues } = dominantAndIssues(gr, "fmt");
        dateTotal += issues;
        qualityByCol[c] = { type: "date", dateFormat: dominant, dateIssues: issues };
      }
    }

    s.summary = {
      version: s.version,
      colTypesKey,
      dupCount,
      totalBlanks,
      blanksByCol,
      casingTotal,
      dateTotal,
      emailTotal,
      qualityByCol,
    };
    respond(s.summary, false);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── POST /api/mx/undo and /api/mx/redo ──
 *  Restore the previous / next stored version (file-swap, no data copy).
 */
async function restoreVersion(
  s: SessionMeta,
  from: "undo" | "redo",
): Promise<void> {
  if (from === "undo") {
    const prev = s.undoStack.pop()!;
    s.redoStack.push(s.dataPath);
    s.dataPath = prev;
  } else {
    const next = s.redoStack.pop()!;
    s.undoStack.push(s.dataPath);
    s.dataPath = next;
  }
  s.version++;
  s.summary = undefined;
  await refreshSessionMeta(s);
}

router.post("/mx/undo", async (req: Request, res: Response) => {
  const s = getSession(req.body?.session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!s.undoStack.length) {
    res.status(400).json({ error: "Nothing to undo" });
    return;
  }
  try {
    await restoreVersion(s, "undo");
    res.json({
      ok: true,
      rowCount: s.rowCount,
      colCount: s.colCount,
      headers: s.headers,
      colTypes: s.colTypes,
      version: s.version,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.post("/mx/redo", async (req: Request, res: Response) => {
  const s = getSession(req.body?.session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }
  if (!s.redoStack.length) {
    res.status(400).json({ error: "Nothing to redo" });
    return;
  }
  try {
    await restoreVersion(s, "redo");
    res.json({
      ok: true,
      rowCount: s.rowCount,
      colCount: s.colCount,
      headers: s.headers,
      colTypes: s.colTypes,
      version: s.version,
      canUndo: s.undoStack.length > 0,
      canRedo: s.redoStack.length > 0,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/* ── GET /api/mx/export ──
 *  Default: stream the stored CSV file directly — no DuckDB needed, instant.
 *  Filtered: pass ?q=<url-encoded JSON view params> to export only the rows
 *  matching the active search/filter/sort/dupes/blanks/rowRange view. The
 *  filtered result is materialized by DuckDB to a temp file, streamed, then
 *  deleted.
 */
function viewHasFilter(p: ViewParams, s: SessionMeta): boolean {
  return !!(
    (p.conditions && p.conditions.length) ||
    (p.search && String(p.search).trim()) ||
    (p.sort && p.sort.col) ||
    p.dupesOnly ||
    p.blanksOnly ||
    (p.rowRange &&
      (String(p.rowRange.from ?? "") !== "" ||
        String(p.rowRange.to ?? "") !== "")) ||
    (Array.isArray(p.cols) && p.cols.length > 0 && p.cols.length < s.headers.length)
  );
}

router.get("/mx/export", async (req: Request, res: Response) => {
  const s = getSession(req.query.session as string);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired" });
    return;
  }

  const safeName =
    s.fileName.replace(/"/g, "").replace(/\.[^.]+$/, "") + "_export.csv";

  let viewParams: ViewParams | null = null;
  if (req.query.q) {
    try {
      viewParams = JSON.parse(String(req.query.q)) as ViewParams;
    } catch {
      viewParams = null;
    }
  }

  /* ── Filtered export path: materialize subset via DuckDB, then stream ── */
  if (viewParams && viewHasFilter(viewParams, s)) {
    const { cteSql, tbl, where, orderBy, selCols } = composeView(s, viewParams);
    const colList = (selCols.length ? selCols : s.headers)
      .map((c) => quoteCol(c))
      .join(", ");
    const outPath = path.join(
      UPLOAD_DIR,
      `${s.sessionId}_export_${Date.now()}.csv`,
    );
    const outSafe = outPath.replace(/'/g, "''");
    const copySql = `COPY (WITH ${cteSql} SELECT ${colList} FROM ${tbl} ${where} ${orderBy}) TO '${outSafe}' (FORMAT CSV, HEADER true)`;
    try {
      await run(copySql);
      const size = (() => {
        try {
          return fs.statSync(outPath).size;
        } catch {
          return 0;
        }
      })();
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeName}"`,
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      if (size > 0) res.setHeader("Content-Length", size.toString());
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      const cleanup = () => unlinkQuiet(outPath);
      stream.on("error", () => {
        cleanup();
        res.end();
      });
      stream.on("close", cleanup);
      res.on("close", cleanup);
    } catch (err) {
      unlinkQuiet(outPath);
      if (!res.headersSent) {
        res.status(500).json({ error: (err as Error).message });
      } else {
        res.end();
      }
    }
    return;
  }

  /* ── Fast path: stream the whole stored CSV verbatim ── */
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
