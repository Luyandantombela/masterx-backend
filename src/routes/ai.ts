import { Router, Request, Response } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "../lib/session-store.js";
import { query } from "../lib/duck.js";
import { logger } from "../lib/logger.js";

const router = Router();

const CREDITS_PER_100_TOKENS = 1;
const MIN_CREDITS_REQUIRED = 5;

function getClient(): Anthropic {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not configured on this server.");
  return new Anthropic({ apiKey });
}

/* ── DuckDB reader expression for stored CSV ── */
function srcExpr(dataPath: string): string {
  const p = dataPath.replace(/'/g, "''");
  return `read_csv_auto('${p}', header=true, max_line_size=134217728, ignore_errors=true)`;
}

function buildQueryPrompt(
  headers: string[],
  colTypes: Record<string, string>,
  rowCount: number,
  fileName: string,
  msgHistory: Array<{ role: string; content: string }>,
): string {
  const colDefs = headers.map(h => `  - "${h}" (${colTypes[h] ?? "VARCHAR"})`).join("\n");
  const histCtx = msgHistory.length
    ? `\nConversation so far:\n${msgHistory.map(m => `${m.role === "user" ? "User" : "AI"}: ${m.content}`).join("\n")}\n`
    : "";

  return `You are a conversational data analyst assistant inside MasterX, a data grid tool.
The user has uploaded "${fileName}" with ${rowCount.toLocaleString()} rows.

Column schema:
${colDefs}
${histCtx}
Answer the user's question by writing a DuckDB SQL query and explaining the result in plain English.

RULES:
1. Respond in EXACTLY this JSON (no markdown, no code fences):
{"type":"query","sql":"SELECT ... FROM data LIMIT 100","explanation":"Here is what I found..."}
2. Table name is always "data".
3. LIMIT SQL to 200 rows unless asked for more.
4. Use DuckDB syntax (ILIKE, TRY_CAST, STRFTIME, etc.).
5. If the question needs no SQL (chitchat, clarification), set "sql":"" and answer in "explanation".
6. Never DROP, DELETE, INSERT, UPDATE — read-only only.
7. Quote column names that have spaces or special chars with double quotes.`;
}

function buildTransformPrompt(
  headers: string[],
  colTypes: Record<string, string>,
  rowCount: number,
  fileName: string,
  msgHistory: Array<{ role: string; content: string }>,
): string {
  const colDefs = headers.map(h => `  - "${h}" (${colTypes[h] ?? "VARCHAR"})`).join("\n");
  const histCtx = msgHistory.length
    ? `\nConversation so far:\n${msgHistory.map(m => `${m.role === "user" ? "User" : "AI"}: ${m.content}`).join("\n")}\n`
    : "";

  return `You are a Python data transformation expert inside MasterX, a data grid tool.
The user has "${fileName}" with ${rowCount.toLocaleString()} rows.

Column schema:
${colDefs}
${histCtx}
Write Python code to transform the data as requested.

RULES:
1. Respond in EXACTLY this JSON (no markdown, no code fences):
{"type":"transform","python_code":"...","explanation":"Here is what the code does..."}
2. Variable "df" is already a pandas DataFrame with all data — do NOT recreate it.
3. At the end you MUST assign: result = {"headers": df.columns.tolist(), "rows": df.to_dict("records")}
4. Available: pandas (pd), numpy (np), re, json, math, string, datetime, itertools, collections.
5. FORBIDDEN: os, sys, subprocess, shutil, socket, urllib, requests, open(), exec(), eval(), compile(), __import__.
6. Handle missing values gracefully (fillna, dropna).
7. If the request is ambiguous, do the most reasonable interpretation.
8. If the request is impossible or dangerous, leave df unchanged and explain in "explanation".`;
}

/*
 * POST /api/mx/ai
 *
 * Body:
 *   session   — MasterX session ID
 *   message   — user's natural-language question or instruction
 *   credits   — user's current credit balance
 *   mode      — "query" (default) | "transform"
 *   history   — optional [{role,content}] for conversation context
 *
 * Query response:
 *   { ok:true, type:"query", answer, sql, rows, tokensUsed, creditsUsed }
 *
 * Transform response:
 *   { ok:true, type:"transform", code, explanation, tokensUsed, creditsUsed }
 */
router.post("/mx/ai", async (req: Request, res: Response) => {
  const {
    session,
    message,
    credits,
    mode = "query",
    history = [],
  } = req.body as {
    session: string;
    message: string;
    credits: number;
    mode?: "query" | "transform";
    history?: Array<{ role: string; content: string }>;
  };

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    res.status(400).json({ error: "message is required" });
    return;
  }

  const creditsAvailable = Number(credits ?? 0);
  if (creditsAvailable < MIN_CREDITS_REQUIRED) {
    res.status(402).json({
      error: "insufficient_credits",
      creditsRequired: MIN_CREDITS_REQUIRED,
      creditsAvailable,
    });
    return;
  }

  const s = getSession(session);
  if (!s) {
    res.status(404).json({ error: "Session not found or expired. Please re-upload your file." });
    return;
  }

  let client: Anthropic;
  try {
    client = getClient();
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  const msgHistory = Array.isArray(history) ? history.slice(-6) : [];
  const systemPrompt = mode === "transform"
    ? buildTransformPrompt(s.headers, s.colTypes, s.rowCount, s.fileName, msgHistory)
    : buildQueryPrompt(s.headers, s.colTypes, s.rowCount, s.fileName, msgHistory);

  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: "user", content: message.trim() }],
    });

    const inputTokens  = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const totalTokens  = inputTokens + outputTokens;
    const creditsUsed  = Math.max(MIN_CREDITS_REQUIRED, Math.ceil(totalTokens / 100) * CREDITS_PER_100_TOKENS);

    const rawText = response.content
      .filter(b => b.type === "text")
      .map(b => (b as { type: "text"; text: string }).text)
      .join("");

    let parsed: { type?: string; sql?: string; explanation?: string; python_code?: string };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      res.json({ ok: true, type: mode, answer: rawText, sql: "", code: "", rows: [], tokensUsed: totalTokens, creditsUsed });
      return;
    }

    /* ── Transform response ── */
    if (mode === "transform" || parsed.type === "transform") {
      logger.info({ sessionId: session, mode: "transform", tokensUsed: totalTokens, creditsUsed }, "AI transform completed");
      res.json({
        ok: true,
        type: "transform",
        code: parsed.python_code ?? "",
        explanation: parsed.explanation ?? "",
        tokensUsed: totalTokens,
        creditsUsed,
      });
      return;
    }

    /* ── Query response — run the SQL ── */
    const { sql, explanation } = parsed;
    let rows: Record<string, unknown>[] = [];

    if (sql && sql.trim().length > 0) {
      /* Wrap with a CTE so the AI's "FROM data" works against the CSV */
      const wrappedSql = `WITH data AS (SELECT * FROM ${srcExpr(s.dataPath)}) ${sql}`;
      try {
        rows = await query(wrappedSql);
      } catch (sqlErr) {
        logger.warn({ sql, err: sqlErr }, "AI-generated SQL failed");
        res.json({
          ok: true,
          type: "query",
          answer: `${explanation}\n\n⚠️ Note: The generated query could not run — ${(sqlErr as Error).message}`,
          sql,
          rows: [],
          tokensUsed: totalTokens,
          creditsUsed,
        });
        return;
      }
    }

    logger.info(
      { sessionId: session, mode: "query", tokensUsed: totalTokens, creditsUsed, rowsReturned: rows.length },
      "AI query completed",
    );
    res.json({ ok: true, type: "query", answer: explanation, sql, rows, tokensUsed: totalTokens, creditsUsed });

  } catch (err) {
    logger.error(err, "AI endpoint error");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
