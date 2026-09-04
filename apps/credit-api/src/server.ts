import { buildApp } from "./app.js";
import { config } from "./config.js";
import { sql } from "./db/client.js";

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await sql.end();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ host: config.HOST, port: config.PORT });
