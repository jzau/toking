import { z } from "zod";

export const providerConfigSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  adapter: z.literal("openai-compatible").default("openai-compatible"),
  baseUrl: z.string().url().refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, "Provider URL must use HTTP(S) without credentials, a query, or a fragment"),
  apiKey: z.string().default(""),
  enabled: z.boolean().default(true),
}).refine((provider) => !provider.enabled || provider.apiKey.trim().length > 0, "Enabled providers require an API key");

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export const gatewayConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(3200),
  CREDIT_SERVICE_BASE_URL: z.string().url().default("http://127.0.0.1:3100"),
  INTERNAL_SERVICE_SECRET: z.string().min(32).default("development-internal-secret-change-me-now"),
  PROVIDER_CONFIG_TTL_MS: z.coerce.number().int().nonnegative().default(30_000),
  MODEL_CATALOG_TTL_MS: z.coerce.number().int().nonnegative().default(60_000),
  MODEL_CATALOG_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  CREDITS_PER_USD: z.coerce.number().positive().default(1_000_000),
  DEFAULT_RESERVATION_CREDITS: z.coerce.bigint().positive().default(1000n),
  FALLBACK_CREDITS_PER_TOKEN: z.coerce.number().positive().default(1),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
});

export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export const config = gatewayConfigSchema.parse(process.env);

if (config.NODE_ENV === "production") {
  if (config.INTERNAL_SERVICE_SECRET.startsWith("development-")) {
    throw new Error("INTERNAL_SERVICE_SECRET must be explicitly configured in production");
  }
}
