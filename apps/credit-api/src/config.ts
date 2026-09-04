import { z } from "zod";

const corsOriginsSchema = z.preprocess(
  (value) => typeof value === "string"
    ? value.split(",").map((origin) => origin.trim()).filter(Boolean)
    : value,
  z.array(z.string().url()),
);

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3100),
  DATABASE_URL: z
    .string()
    .default("postgresql://jie@127.0.0.1:5432/toking"),
  ADMIN_PASSWORD: z.string().min(8).default("development-admin"),
  ADMIN_SESSION_SECRET: z
    .string()
    .min(32)
    .default("development-admin-session-secret-change-me"),
  INTERNAL_SERVICE_SECRET: z
    .string()
    .min(32)
    .default("development-internal-secret-change-me-now"),
  PROVIDER_CREDENTIAL_SECRET: z
    .string()
    .min(32)
    .default("development-provider-credential-secret"),
  DEV_OTP_CODE: z.string().regex(/^\d{6}$/).default("123456"),
  TOKING_GATEWAY_BASE_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:3200/v1"),
  CORS_ORIGINS: corsOriginsSchema.default([]),
  RESERVATION_TTL_SECONDS: z.coerce.number().int().positive().default(900),
});

export const config = environmentSchema.parse(process.env);

if (config.NODE_ENV === "production") {
  const unsafeDefaults = [
    config.ADMIN_PASSWORD === "development-admin",
    config.ADMIN_SESSION_SECRET.startsWith("development-"),
    config.INTERNAL_SERVICE_SECRET.startsWith("development-"),
    config.PROVIDER_CREDENTIAL_SECRET.startsWith("development-"),
  ];

  if (unsafeDefaults.some(Boolean)) {
    throw new Error("Production secrets must be explicitly configured");
  }
}
