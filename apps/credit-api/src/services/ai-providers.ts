import { eq } from "drizzle-orm";
import { z } from "zod";

import { config } from "../config.js";
import type { DbExecutor } from "../db/client.js";
import { aiProviders } from "../db/schema.js";
import { decryptJson, encryptJson } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";

export const providerIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
export const providerBaseUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  return ["http:", "https:"].includes(url.protocol)
    && !url.username
    && !url.password
    && !url.search
    && !url.hash
    && (config.NODE_ENV !== "production" || url.protocol === "https:");
}, "Provider URL must be HTTPS in production and contain no credentials, query, or fragment");

const catalogSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({ id: z.string().min(1) }).passthrough()),
});

type ProviderSecret = { apiKey: string };

function publicProvider(provider: typeof aiProviders.$inferSelect) {
  return {
    id: provider.id,
    name: provider.name,
    adapter: provider.adapter,
    baseUrl: provider.baseUrl,
    apiKeyPrefix: provider.apiKeyPrefix,
    enabled: provider.enabled,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
  };
}

export async function listAiProviders(executor: DbExecutor) {
  const rows = await executor.select().from(aiProviders).orderBy(aiProviders.createdAt);
  return rows.map(publicProvider);
}

export async function createAiProvider(
  executor: DbExecutor,
  input: { id: string; name: string; baseUrl: string; apiKey: string; enabled: boolean },
) {
  const existing = await executor.select({ id: aiProviders.id }).from(aiProviders)
    .where(eq(aiProviders.id, input.id)).limit(1);
  if (existing[0]) throw new AppError(409, "provider_exists", "AI provider ID already exists");
  const [created] = await executor.insert(aiProviders).values({
    id: input.id,
    name: input.name,
    baseUrl: input.baseUrl.replace(/\/+$/, ""),
    apiKeyCiphertext: encryptJson({ apiKey: input.apiKey }, config.PROVIDER_CREDENTIAL_SECRET),
    apiKeyPrefix: input.apiKey.slice(0, 8),
    enabled: input.enabled,
  }).returning();
  return publicProvider(created!);
}

export async function updateAiProvider(
  executor: DbExecutor,
  id: string,
  input: {
    name?: string | undefined;
    baseUrl?: string | undefined;
    apiKey?: string | undefined;
    enabled?: boolean | undefined;
  },
) {
  const values: Partial<typeof aiProviders.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) values.name = input.name;
  if (input.baseUrl !== undefined) values.baseUrl = input.baseUrl.replace(/\/+$/, "");
  if (input.enabled !== undefined) values.enabled = input.enabled;
  if (input.apiKey !== undefined) {
    values.apiKeyCiphertext = encryptJson({ apiKey: input.apiKey }, config.PROVIDER_CREDENTIAL_SECRET);
    values.apiKeyPrefix = input.apiKey.slice(0, 8);
  }
  const [updated] = await executor.update(aiProviders).set(values)
    .where(eq(aiProviders.id, id)).returning();
  if (!updated) throw new AppError(404, "provider_not_found", "AI provider not found");
  return publicProvider(updated);
}

export async function internalAiProviders(executor: DbExecutor) {
  const rows = await executor.select().from(aiProviders).where(eq(aiProviders.enabled, true));
  return rows.map((provider) => ({
    id: provider.id,
    name: provider.name,
    adapter: "openai-compatible" as const,
    baseUrl: provider.baseUrl,
    apiKey: decryptJson<ProviderSecret>(provider.apiKeyCiphertext, config.PROVIDER_CREDENTIAL_SECRET).apiKey,
    enabled: true,
  }));
}

export async function testAiProvider(executor: DbExecutor, id: string) {
  const [provider] = await executor.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
  if (!provider) throw new AppError(404, "provider_not_found", "AI provider not found");
  const { apiKey } = decryptJson<ProviderSecret>(provider.apiKeyCiphertext, config.PROVIDER_CREDENTIAL_SECRET);
  let response: Response;
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, "x-toking-provider-contract": "1" },
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new AppError(502, "provider_unreachable", "AI provider could not be reached");
  }
  if (!response.ok) {
    throw new AppError(502, "provider_rejected", `AI provider returned HTTP ${response.status}`);
  }
  try {
    const catalog = catalogSchema.parse(await response.json());
    return { status: "ok", modelCount: catalog.data.length };
  } catch {
    throw new AppError(502, "provider_invalid_catalog", "AI provider returned an invalid OpenAI-compatible model catalog");
  }
}
