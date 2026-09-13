import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import { gatewayConfigSchema, providerConfigSchema, type ProviderConfig } from "../src/config.js";
import { usageCredits } from "../src/pricing.js";
import { ProviderRegistry } from "../src/providers.js";

const gatewayKey = `tk_live_${"a".repeat(32)}`;
const authorization = { authorization: `Bearer ${gatewayKey}` };
const gangram = { id: "gangram", name: "Gangram", baseUrl: "http://gangram.test/v1/", apiKey: "gangram-secret" };
const second = { id: "second", name: "Second", baseUrl: "http://second.test/v1", apiKey: "second-secret" };
const model = { id: "lab/chat", object: "model", created: 123, owned_by: "lab", context_length: 8192 };
const catalog = { object: "list", data: [model] };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const config = (overrides: Record<string, unknown> = {}) => gatewayConfigSchema.parse({ NODE_ENV: "test", CREDITS_PER_USD: 1000000, FALLBACK_CREDITS_PER_TOKEN: 1, ...overrides });
const resolved = () => json({ creditAccountId: "account", defaultProviderId: null });

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(apps.splice(0).map((app) => app.close())); });
async function appWith(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}, providerConfigs: ProviderConfig[] = [gangram, second]) {
  const app = await buildApp({ config: config(overrides), fetchImpl, providers: providerConfigs });
  apps.push(app);
  return app;
}

describe("provider discovery and routing", () => {
  it("requires a redeemed customer key for model discovery", async () => {
    let called = false;
    const app = await appWith(async () => { called = true; return json({}); });
    const response = await app.inject({
      url: "/v1/models",
      headers: { authorization: `Bearer tci_live_${"b".repeat(32)}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_api_key");
    expect(called).toBe(false);
  });

  it("loads provider credentials from the authenticated Credit Service endpoint", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const app = await buildApp({ config: config(), fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push({ url, headers: new Headers(init?.headers) });
      if (url.endsWith("/gateway-api-keys/resolve")) return resolved();
      if (url.endsWith("/internal/v1/ai-providers")) return json([gangram]);
      if (url.endsWith("/models")) return json(catalog);
      throw new Error(`Unexpected call: ${url}`);
    }});
    apps.push(app);
    const response = await app.inject({ url: "/v1/models", headers: authorization });
    expect(response.statusCode).toBe(200);
    const registryCall = calls.find((call) => call.url.endsWith("/internal/v1/ai-providers"));
    expect(registryCall?.headers.get("x-toking-internal-secret")).toBe("development-internal-secret-change-me-now");
    expect(response.body).not.toContain("gangram-secret");
  });

  it("authenticates every catalog read, caches providers, namespaces duplicate models, and never reserves credits", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const app = await appWith(async (input, init) => {
      const url = String(input); calls.push({ url, init });
      if (url.endsWith("/gateway-api-keys/resolve")) return resolved();
      if (url.endsWith("/models")) return json({ ...catalog, data: [{ ...model, internal_secret: "hidden" }] });
      throw new Error(`Unexpected call: ${url}`);
    });
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ url: "/v1/models", headers: authorization });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ object: "list", data: [
        { ...model, id: "gangram/lab/chat", provider: "gangram" },
        { ...model, id: "second/lab/chat", provider: "second" },
      ] });
    }
    expect(calls.filter((call) => call.url.endsWith("/models"))).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith("/resolve"))).toHaveLength(2);
    const upstream = calls.find((call) => call.url === "http://gangram.test/v1/models")!;
    expect(new Headers(upstream.init?.headers).get("authorization")).toBe("Bearer gangram-secret");
    expect(JSON.stringify(upstream)).not.toContain(gatewayKey);
    expect(calls.some((call) => call.url.includes("reservations"))).toBe(false);
  });

  it.each([401, 403])("rejects invalid or suspended accounts (%s) without querying providers", async (status) => {
    const calls: string[] = [];
    const app = await appWith(async (input) => {
      calls.push(String(input));
      return json({ error: { code: "account_rejected", message: "Rejected" } }, status);
    });
    const response = await app.inject({ url: "/v1/models", headers: authorization });
    expect(response.statusCode).toBe(status);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/gateway-api-keys/resolve");
  });

  it("returns a partial catalog during an outage and never queries disabled providers", async () => {
    const app = await appWith(async (input) => {
      const url = String(input);
      if (url.endsWith("/resolve")) return resolved();
      if (url.startsWith(gangram.baseUrl)) return json(catalog);
      if (url.startsWith(second.baseUrl)) return json({ error: "private failure" }, 500);
      throw new Error(`Unexpected call: ${url}`);
    }, {}, [gangram, second, { ...gangram, id: "disabled", enabled: false, apiKey: "" }]);
    const response = await app.inject({ url: "/v1/models", headers: authorization });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().toking).toEqual({ unavailable_providers: ["second"] });
    expect(response.body).not.toContain("private failure");
  });

  it("fails closed when all catalogs are malformed or unavailable", async () => {
    const app = await appWith(async (input) => String(input).endsWith("/resolve") ? resolved() : json({ data: [{ id: "incomplete" }] }));
    const response = await app.inject({ url: "/v1/models", headers: authorization });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("provider_catalog_unavailable");
  });

  it.each(["missing/lab/chat", "gangram/unknown", "lab/chat"])("rejects unroutable model %s before a credit reservation", async (id) => {
    const calls: string[] = [];
    const app = await appWith(async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/resolve")) return resolved();
      if (url.endsWith("/models")) return json(catalog);
      throw new Error(`Unexpected call: ${url}`);
    });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: authorization, payload: { model: id, messages: [{ role: "user", content: "Hi" }] } });
    expect(response.statusCode).toBe(404);
    expect(calls.some((url) => url.includes("reservations"))).toBe(false);
  });

  it("routes to the second provider with only its credentials and records provider attribution", async () => {
    let capture: Record<string, unknown> | undefined;
    let completion: { url: string; init?: RequestInit } | undefined;
    const app = await appWith(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/resolve")) return resolved();
      if (url.endsWith("/models")) return json(catalog);
      if (url.endsWith("/reservations")) return json({ reservationId: "reservation-id", postedBalance: "10000", reservedCredits: "1000", availableBalance: "9000" });
      if (url.endsWith("/capture")) { capture = JSON.parse(String(init?.body)); return json({}); }
      if (url.endsWith("/chat/completions")) {
        completion = { url, init };
        return json({ id: "upstream-id", object: "chat.completion", model: "lab/chat", choices: [{ message: { content: "Hello" } }], usage: { cost: "0.001" } });
      }
      throw new Error(`Unexpected call: ${url}`);
    });
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { ...authorization, "x-toking-provider": "gangram" }, payload: { model: "second/lab/chat", messages: [{ role: "user", content: "Hi" }] } });
    expect(response.statusCode).toBe(200);
    expect(response.json().model).toBe("second/lab/chat");
    expect(completion?.url).toBe("http://second.test/v1/chat/completions");
    const headers = new Headers(completion?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer second-secret");
    expect(headers.get("x-toking-request-id")).toBe("reservation-id");
    expect(headers.has("x-toking-provider")).toBe(false);
    expect(JSON.stringify(completion)).not.toContain(gatewayKey);
    expect(JSON.parse(String(completion?.init?.body)).model).toBe("lab/chat");
    expect(capture).toMatchObject({ capturedCredits: "1000", metadata: { provider: "second", upstreamModel: "lab/chat", model: "second/lab/chat", upstreamId: "upstream-id" } });
  });

  it("refreshes expired catalogs, coalesces concurrent reads, and rejects removed models", async () => {
    vi.useFakeTimers();
    let count = 0;
    const registry = new ProviderRegistry(config({ MODEL_CATALOG_TTL_MS: 100 }), async () => {
      count++;
      return json(count === 1 ? catalog : { object: "list", data: [] });
    }, async () => [gangram]);
    await Promise.all([registry.catalog(), registry.catalog()]);
    expect(count).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    await expect(registry.resolve("gangram/lab/chat")).rejects.toMatchObject({ code: "model_not_found" });
    expect(count).toBe(2);
  });

  it("times out provider discovery", async () => {
    const registry = new ProviderRegistry(config({ MODEL_CATALOG_TIMEOUT_MS: 10 }), async (_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    }), async () => [gangram]);
    await expect(registry.catalog()).rejects.toMatchObject({ statusCode: 503 });
  });

  it("rejects missing keys and unsafe provider URL schemes", () => {
    for (const provider of [{ ...gangram, apiKey: "" }, { ...gangram, baseUrl: "file:///tmp/models" }]) {
      expect(() => providerConfigSchema.parse(provider)).toThrow();
    }
  });

  it("does not confuse absent or malformed cost with explicit zero-cost usage", () => {
    for (const cost of [null, "", " ", false, {}, -1, "invalid"]) {
      expect(usageCredits(config(), { total_tokens: 7, cost } as never)).toBe(7n);
    }
    expect(usageCredits(config(), { cost: "0" })).toBe(0n);
    expect(usageCredits(config(), {})).toBeNull();
  });
});

describe("provider response conformance", () => {
  async function fixture(upstream: () => Response) {
    const settlements: Array<{ kind: string; body: unknown }> = [];
    const app = await appWith(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/resolve")) return resolved();
      if (url.endsWith("/models")) return json(catalog);
      if (url.endsWith("/reservations")) return json({ reservationId: "reservation-id", postedBalance: "10000", reservedCredits: "1000", availableBalance: "9000" });
      if (url.endsWith("/capture") || url.endsWith("/release")) {
        settlements.push({ kind: url.split("/").pop()!, body: JSON.parse(String(init?.body)) });
        return json({});
      }
      if (url.endsWith("/chat/completions")) return upstream();
      throw new Error(`Unexpected call: ${url}`);
    });
    return { app, settlements };
  }
  const request = (stream = false) => ({ method: "POST" as const, url: "/v1/chat/completions", headers: authorization, payload: { model: "gangram/lab/chat", stream, messages: [{ role: "user", content: "Hi" }] } });
  const sse = (chunks: string[]) => new Response(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });

  it.each(["invalid-shape", "provider-authentication", "wrong-stream-type"])("releases credit for %s and hides private errors", async (mode) => {
    const { app, settlements } = await fixture(() => mode === "provider-authentication"
      ? json({ error: { message: "gangram-secret private diagnostic" } }, 401)
      : json({ unexpected: true }));
    const response = await app.inject(request(mode === "wrong-stream-type"));
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("gangram-secret");
    expect(settlements.map((entry) => entry.kind)).toEqual(["release"]);
  });

  it("handles CRLF split across network chunks, rewrites models, and settles final usage", async () => {
    const { app, settlements } = await fixture(() => sse([
      'data: {"id":"stream-id","model":"lab/chat","choices":[{"delta":{"content":"Hello"}}]}\r',
      '\n\r',
      '\ndata: {"id":"stream-id","choices":[],"usage":{"cost":"0.0001"}}\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]));
    const response = await app.inject(request(true));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('"model":"gangram/lab/chat"');
    expect(response.body.match(/data: \[DONE\]/g)).toHaveLength(1);
    expect(settlements).toMatchObject([{ kind: "capture", body: { capturedCredits: "100", metadata: { provider: "gangram", upstreamId: "stream-id" } } }]);
  });

  it("sanitizes an early provider stream error and releases credit", async () => {
    const { app, settlements } = await fixture(() => sse(['data: {"error":{"message":"gangram-secret private diagnostic"}}\n\n']));
    const response = await app.inject(request(true));
    expect(response.body).toContain("provider_error");
    expect(response.body).not.toContain("gangram-secret");
    expect(settlements.map((entry) => entry.kind)).toEqual(["release"]);
  });

  it("reports a truncated stream and captures only estimated partial usage", async () => {
    const { app, settlements } = await fixture(() => sse(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n']));
    const response = await app.inject(request(true));
    expect(response.body).toContain("provider_stream_incomplete");
    expect(settlements.map((entry) => entry.kind)).toEqual(["capture"]);
  });
});

 it("prices $100 at 10,000 Credits with the new default denomination", () => {
  const rates = gatewayConfigSchema.parse({ NODE_ENV: "test" });
  expect(usageCredits(rates, { cost: 100 })).toBe(10000n);
  expect(usageCredits(rates, { cost: 0.026624735 })).toBe(3n);
  expect(rates.DEFAULT_RESERVATION_CREDITS).toBe(1n);
});
