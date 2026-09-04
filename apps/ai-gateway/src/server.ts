import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();
const shutdown = async () => { await app.close(); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ host: config.HOST, port: config.PORT });
