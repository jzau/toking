import { z } from "zod";

import type { GatewayConfig, ProviderConfig } from "./config.js";
import { GatewayError } from "./errors.js";

// Only explicitly supported catalog fields cross the public gateway boundary.
const modelSchema = z.object({
  id: z.string().min(1).max(500),
  object: z.literal("model"),
  created: z.number().int().nonnegative(),
  owned_by: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  context_length: z.number().int().positive().optional(),
  supported_parameters: z.array(z.string()).optional(),
});
const catalogSchema = z.object({ object: z.literal("list"), data: z.array(modelSchema) });
type ProviderModel = z.infer<typeof modelSchema>;

export interface AiProvider {
  readonly id: string;
  readonly name: string;
  models(): Promise<ProviderModel[]>;
  complete(body: Record<string, unknown>, signal: AbortSignal, requestId: string): Promise<Response>;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly id: string;
  readonly name: string;
  private cache?: { expiresAt: number; models: ProviderModel[] };
  private pending?: Promise<ProviderModel[]>;

  constructor(
    private readonly provider: ProviderConfig,
    private readonly config: GatewayConfig,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.id = provider.id;
    this.name = provider.name;
  }

  private url(path: string) { return `${this.provider.baseUrl.replace(/\/+$/, "")}${path}`; }
  private headers() {
    return {
      authorization: `Bearer ${this.provider.apiKey}`,
      "content-type": "application/json",
      "x-toking-provider-contract": "1",
    };
  }

  async models(): Promise<ProviderModel[]> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.models;
    if (this.pending) return this.pending;
    this.pending = this.loadModels();
    try { return await this.pending; } finally { this.pending = undefined; }
  }

  private async loadModels(): Promise<ProviderModel[]> {
    try {
      const response = await this.fetchImpl(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.config.MODEL_CATALOG_TIMEOUT_MS),
        redirect: "error",
      });
      if (!response.ok) throw new Error("Catalog request failed");
      const { data } = catalogSchema.parse(await response.json());
      if (new Set(data.map((model) => model.id)).size !== data.length) throw new Error("Duplicate model IDs");
      this.cache = { models: data, expiresAt: Date.now() + this.config.MODEL_CATALOG_TTL_MS };
      return data;
    } catch {
      throw new GatewayError(503, "provider_catalog_unavailable", `Model catalog for ${this.id} is unavailable`);
    }
  }

  complete(body: Record<string, unknown>, signal: AbortSignal, requestId: string) {
    return this.fetchImpl(this.url("/chat/completions"), {
      method: "POST",
      headers: { ...this.headers(), "x-toking-request-id": requestId },
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    });
  }
}

export class ProviderRegistry {
  readonly providers: AiProvider[];

  constructor(config: GatewayConfig, fetchImpl: typeof fetch) {
    this.providers = config.AI_PROVIDERS.filter((provider) => provider.enabled)
      .map((provider) => new OpenAiCompatibleProvider(provider, config, fetchImpl));
  }

  async catalog() {
    if (!this.providers.length) throw new GatewayError(503, "provider_not_configured", "No AI providers are configured");
    const results = await Promise.allSettled(this.providers.map(async (provider) =>
      (await provider.models()).map((model) => ({ ...model, id: `${provider.id}/${model.id}`, provider: provider.id })),
    ));
    if (results.every((result) => result.status === "rejected")) {
      throw new GatewayError(503, "provider_catalog_unavailable", "All AI provider catalogs are unavailable");
    }
    const unavailable = results.flatMap((result, index) => result.status === "rejected" ? [this.providers[index]!.id] : []);
    return {
      object: "list" as const,
      data: results.flatMap((result) => result.status === "fulfilled" ? result.value : []),
      ...(unavailable.length ? { toking: { unavailable_providers: unavailable } } : {}),
    };
  }

  async resolve(model: string) {
    if (!this.providers.length) throw new GatewayError(503, "provider_not_configured", "No AI providers are configured");
    const separator = model.indexOf("/");
    const provider = this.providers.find((candidate) => candidate.id === model.slice(0, separator));
    const upstreamModel = model.slice(separator + 1);
    if (separator < 1 || !provider || !upstreamModel) {
      throw new GatewayError(404, "model_not_found", "Use a model ID returned by GET /v1/models", "invalid_request_error");
    }
    if (!(await provider.models()).some((candidate) => candidate.id === upstreamModel)) {
      throw new GatewayError(404, "model_not_found", "The selected provider does not offer this model", "invalid_request_error");
    }
    return { provider, upstreamModel };
  }
}
