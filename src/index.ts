import app from "./app.js";
import { logger } from "./lib/logger.js";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required.");

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) throw new Error(`Invalid PORT: "${rawPort}"`);

app.listen(port, (err?: Error) => {
  if (err) { logger.error({ err }, "Error starting server"); process.exit(1); }
  logger.info({ port }, "Server listening");
});
