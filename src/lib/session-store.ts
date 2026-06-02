import path from "path";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

export interface ColQuality {
  type:           string;
  casingPattern?: string;  // dominant text-casing pattern (text cols)
  casingIssues?:  number;  // non-blank cells not matching the dominant pattern
  dateFormat?:    string;  // dominant date format (date cols)
  dateIssues?:    number;  // non-blank cells not matching the dominant format
  emailIssues?:   number;  // invalid emails (email cols)
}

export interface SummaryCache {
  version:       number;
  colTypesKey:   string;   // JSON of colTypes used; recompute when it changes
  dupCount:      number;
  totalBlanks:   number;
  blanksByCol:   Record<string, number>;
  casingTotal:   number;
  dateTotal:     number;
  emailTotal:    number;
  qualityByCol:  Record<string, ColQuality>;
}

export interface SessionMeta {
  sessionId: string;
  fileName:  string;
  dataPath:  string;   // path to the stored CSV file on disk
  rowCount:  number;
  colCount:  number;
  headers:   string[];
  colTypes:  Record<string, string>;
  createdAt: number;
  lastUsed:  number;
  sortCache: Map<string, number[]>;
  /* ── Versioning for undo/redo ──
   * Each mutation renames the freshly-written CSV to a new unique path and
   * pushes the previous dataPath onto undoStack (no extra copy — the write
   * already happened). Disk use is bounded to (UNDO_DEPTH+1) × file size.
   */
  version:   number;
  undoStack: string[];   // older versions (most-recent last)
  redoStack: string[];   // undone versions available to redo
  /* Cached whole-file quality summary, keyed by version */
  summary?:  SummaryCache;
}

/* Max number of historical versions kept on disk per session for undo.
 * Snapshot-based: each level costs ~one CSV copy on disk, so this is a
 * deliberate cap (deep history × multi-million-row files would exhaust disk). */
export const UNDO_DEPTH = 25;

const sessions = new Map<string, SessionMeta>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

export const UPLOAD_DIR = path.join(os.tmpdir(), "masterx-sessions");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function createSession(
  fields: Omit<
    SessionMeta,
    | "sessionId"
    | "createdAt"
    | "lastUsed"
    | "sortCache"
    | "version"
    | "undoStack"
    | "redoStack"
    | "summary"
  >,
): SessionMeta {
  const session: SessionMeta = {
    ...fields,
    sessionId: uuidv4(),
    createdAt: Date.now(),
    lastUsed:  Date.now(),
    sortCache: new Map(),
    version:   0,
    undoStack: [],
    redoStack: [],
  };
  sessions.set(session.sessionId, session);
  return session;
}

/* Best-effort delete of a version file (never throws). */
export function unlinkQuiet(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}

export function getSession(id: string): SessionMeta | undefined {
  const s = sessions.get(id);
  if (s) s.lastUsed = Date.now();
  return s;
}

export function deleteSession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    unlinkQuiet(s.dataPath);
    for (const p of s.undoStack) unlinkQuiet(p);
    for (const p of s.redoStack) unlinkQuiet(p);
    sessions.delete(id);
  }
}

/* Evict sessions idle for more than SESSION_TTL_MS */
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastUsed > SESSION_TTL_MS) {
      deleteSession(id);
    }
  }
}, 10 * 60 * 1000);
