import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { config } from "../config.js";
import * as schema from "./schema.js";

export const sql = postgres(config.DATABASE_URL, {
  max: config.NODE_ENV === "test" ? 4 : 10,
  prepare: false,
});

export const db = drizzle(sql, { schema });

export type Database = typeof db;
export type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbExecutor = Database | DbTransaction;
