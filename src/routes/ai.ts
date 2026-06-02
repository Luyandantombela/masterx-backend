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
  return `read_csv_auto('${p}', header=true, max_line_size=1048576, ignore_errors=true)`;
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

  return `You are a DuckDB SQL expert inside MasterX, a data transformation tool.
The user wants to transform "${fileName}" which has ${rowCount.toLocaleString()} rows.

Column schema:
${colDefs}
${histCtx}
Write a DuckDB SQL SELECT statement that transforms the data as the user requests.

RULES:
1. Respond in EXACTLY this JSON (no markdown, no code fences):
{"type":"transform","sql":"SELECT ...","explanation":"Here is what this transform does..."}
2. The source table is always named "data" — always use FROM data (or WITH data AS ...).
3. Your SQL must be a SELECT that produces the COMPLETE desired output table.
4. Available DuckDB functions: initcap(), lower(), upper(), trim(), concat(), strftime(),
   TRY_CAST(), printf(), string_split(), string_split_regex(), regexp_replace(),
   coalesce(), nullif(), starts_with(), ends_with(), left(), right(), length(), substr().
5. To rename a column: include it as "old_col" AS "new_col" in your SELECT list.
6. To delete a column: SELECT only the columns you want to keep (omit the deleted one).
7. To add a new column: SELECT *, (expression) AS "new_col_name" FROM data.
8. To reformat dates: strftime(TRY_CAST("col" AS DATE), '%Y-%m-%d') etc.
9. To standardize numbers: printf('%.2f', TRY_CAST("col" AS DOUBLE)).
10. Use CASE WHEN col IS NULL OR col = '' THEN default ELSE col END for null-safety.
11. Never use DELETE, DROP, INSERT, UPDATE, CREATE — SELECT only.
12. If the request is ambiguous, do the most reasonable interpretation and explain.
13. If impossible or dangerous, return sql:"" and explain in "explanation".`;
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
 *   { ok:true, type:"transform", sql, explanation, tokensUsed, creditsUsed }
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

    let parsed: { type?: string; sql?: string; explanation?: string };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      res.json({ ok: true, type: mode, answer: rawText, sql: "", rows: [], tokensUsed: totalTokens, creditsUsed });
      return;
    }

    /* ── Transform response — return SQL for the frontend to confirm + apply ── */
    if (mode === "transform" || parsed.type === "transform") {
      logger.info({ sessionId: session, mode: "transform", tokensUsed: totalTokens, creditsUsed }, "AI transform SQL generated");
      res.json({
        ok:          true,
        type:        "transform",
        sql:         parsed.sql ?? "",
        explanation: parsed.explanation ?? "",
        tokensUsed:  totalTokens,
        creditsUsed,
      });
      return;
    }

    /* ── Query response — run the SQL ── */
    const { sql, explanation } = parsed;
    let rows: Record<string, unknown>[] = [];

    if (sql && sql.trim().length > 0) {
      const wrappedSql = `WITH data AS (SELECT * FROM ${srcExpr(s.dataPath)}) ${sql}`;
      try {
        rows = await query(wrappedSql);
      } catch (sqlErr) {
        logger.warn({ sql, err: sqlErr }, "AI-generated SQL failed");
        res.json({
          ok:     true,
          type:   "query",
          answer: `${explanation}\n\n⚠️ Note: The generated query could not run — ${(sqlErr as Error).message}`,
          sql,
          rows:   [],
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
