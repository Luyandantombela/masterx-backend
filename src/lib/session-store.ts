import path from "path";
import os from "os";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

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
}

const sessions = new Map<string, SessionMeta>();
const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 h

export const UPLOAD_DIR = path.join(os.tmpdir(), "masterx-sessions");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export function createSession(
  fields: Omit<SessionMeta, "sessionId" | "createdAt" | "lastUsed" | "sortCache">,
): SessionMeta {
  const session: SessionMeta = {
    ...fields,
    sessionId: uuidv4(),
    createdAt: Date.now(),
    lastUsed:  Date.now(),
    sortCache: new Map(),
  };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(id: string): SessionMeta | undefined {
  const s = sessions.get(id);
  if (s) s.lastUsed = Date.now();
  return s;
}

export function deleteSession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    try { fs.unlinkSync(s.dataPath); } catch {}
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
