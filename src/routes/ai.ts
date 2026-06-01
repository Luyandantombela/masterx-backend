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
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not configured on this server.");
  }
  return new Anthropic({ apiKey });
}

function buildSystemPrompt(headers: string[], colTypes: Record<string, string>, rowCount: number, fileName: string): string {
  const colDefs = headers
    .map(h => `  - "${h}" (${colTypes[h] ?? "VARCHAR"})`)
    .join("\n");

  return `You are a data analyst assistant for MasterX, a high-performance data grid tool.
The user has uploaded a dataset called "${fileName}" with ${rowCount.toLocaleString()} rows.

Column schema:
${colDefs}

Your job is to answer the user's question by writing a DuckDB SQL query, then explain the result in plain English.

Rules:
1. ALWAYS respond in this exact JSON format (no markdown, no code fences):
{
  "sql": "SELECT ... FROM data LIMIT 100",
  "explanation": "Here is what I found..."
}
2. The table name is always "data" — use it exactly.
3. LIMIT your SQL to 200 rows maximum unless the user explicitly asks for more.
4. Use DuckDB SQL syntax (ILIKE, TRY_CAST, STRFTIME, etc.).
5. If the question cannot be answered with SQL (e.g. it's a general question), set "sql" to "" and answer in "explanation".
6. Never DROP, DELETE, INSERT, UPDATE or modify data — read-only queries only.
7. Column names with spaces or special chars must be double-quoted.`;
}

/*
 * POST /api/mx/ai
 *
 * Body:
 *   session    — MasterX session ID
 *   message    — user's natural-language question
 *   credits    — user's current credit balance (passed from Bubble)
 *
 * Success response:
 *   { ok: true, answer, sql, rows, tokensUsed, creditsUsed }
 *
 * Credit-gate response (HTTP 402):
 *   { error: "insufficient_credits", creditsRequired: N, creditsAvailable: N }
 *
 * Error response (HTTP 4xx/5xx):
 *   { error: "..." }
 */
router.post("/mx/ai", async (req: Request, res: Response) => {
  const { session, message, credits } = req.body as {
    session: string;
    message: string;
    credits: number;
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

  const systemPrompt = buildSystemPrompt(s.headers, s.colTypes, s.rowCount, s.fileName);

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

    let parsed: { sql: string; explanation: string };
    try {
      parsed = JSON.parse(rawText);
    } catch {
      res.json({
        ok: true,
        answer: rawText,
        sql: "",
        rows: [],
        tokensUsed: totalTokens,
        creditsUsed,
      });
      return;
    }

    const { sql, explanation } = parsed;
    let rows: Record<string, unknown>[] = [];

    if (sql && sql.trim().length > 0) {
      const parquetPath = s.parquetPath.replace(/'/g, "''");
      const wrappedSql = `WITH data AS (SELECT * FROM read_parquet('${parquetPath}')) ${sql}`;
      try {
        rows = await query(wrappedSql);
      } catch (sqlErr) {
        logger.warn({ sql, err: sqlErr }, "AI-generated SQL failed");
        res.json({
          ok: true,
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
      { sessionId: session, tokensUsed: totalTokens, creditsUsed, rowsReturned: rows.length },
      "AI query completed"
    );

    res.json({
      ok: true,
      answer: explanation,
      sql,
      rows,
      tokensUsed: totalTokens,
      creditsUsed,
    });
  } catch (err) {
    logger.error(err, "AI endpoint error");
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
