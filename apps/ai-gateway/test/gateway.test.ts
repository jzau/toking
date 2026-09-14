import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { gatewayConfigSchema } from "../src/config.js";

const gatewayKey = `tk_live_${"a".repeat(32)}`;
const providers = [{ id: "gangram", name: "Gangram", baseUrl: "http://gangram.test/v1", apiKey: "gangram-test-key", adapter: "openai-compatible" as const, enabled: true }];

function testConfig(overrides: Record<string, unknown> = {}) {
  return gatewayConfigSchema.parse({
    NODE_ENV: "test",
    CREDIT_SERVICE_BASE_URL: "http://credit.test",
    INTERNAL_SERVICE_SECRET: "test-internal-service-secret-that-is-long",
    CREDITS_PER_USD: 1_000_000,
    DEFAULT_RESERVATION_CREDITS: 1000,
    FALLBACK_CREDITS_PER_TOKEN: 1,
    ...overrides,
  });
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function reservation(postedBalance = "10000") {
  return {
    reservationId: "019c1234-1234-7000-8000-000000000001",
    creditAccountId: "019c1234-1234-7000-8000-000000000002",
    reservedCredits: "1000",
    postedBalance,
    reservedBalance: "1000",
    availableBalance: String(Number(postedBalance) - 1000),
    defaultProviderId: null,
  };
}

describe("Toking AI Gateway", () => {
  const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
  afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

  it("returns wallet balance and paginated transactions for a customer API key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith("/internal/v1/wallet")) {
        return json({ postedBalance: "2000", reservedBalance: "100", availableBalance: "1900", canReserve: true, status: "active" });
      }
      if (url.endsWith("/internal/v1/wallet/transactions")) {
        return json({ data: [{ transactionId: "019c1234-1234-7000-8000-000000000001", type: "gift_card_redemption", amount: "2000", metadata: {}, postedAt: "2026-08-28T09:30:00.000Z" }], nextCursor: "next-page" });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = await buildApp({ config: testConfig(), fetchImpl, providers }); apps.push(app);

    const wallet = await app.inject({ method: "GET", url: "/v1/wallet", headers: { authorization: `Bearer ${gatewayKey}` } });
    const history = await app.inject({ method: "GET", url: "/v1/wallet/transactions?limit=10&cursor=current-page", headers: { authorization: `Bearer ${gatewayKey}` } });

    expect(wallet.statusCode).toBe(200);
    expect(wallet.json()).toMatchObject({ availableBalance: "1900", canReserve: true });
    expect(wallet.headers["cache-control"]).toBe("no-store");
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ data: [{ amount: "2000" }], nextCursor: "next-page" });
    expect(history.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "http://credit.test/internal/v1/wallet", body: { gatewayApiKey: gatewayKey } }),
      expect.objectContaining({ url: "http://credit.test/internal/v1/wallet/transactions", body: { gatewayApiKey: gatewayKey, limit: 10, cursor: "current-page" } }),
    ]));
  });

  it("reserves, proxies, and captures an Gangram chat completion", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ url, body });
      if (url.endsWith("/gateway-api-keys/resolve")) return json({ creditAccountId: "account-test", defaultProviderId: null });
      if (url.endsWith("/models")) return json({ object: "list", data: ["openai/gpt-4o-mini", "test/model", "missing/model"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) });
      if (url.endsWith("/internal/v1/reservations")) return json(reservation());
      if (url.includes("/capture")) return json({ status: "captured" });
      if (url.endsWith("/chat/completions")) {
        return json({
          id: "chatcmpl-test",
          object: "chat.completion",
          model: "openai/gpt-4o-mini",
          choices: [{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, cost: 0.0015 },
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = await buildApp({ config: testConfig(), fetchImpl, providers }); apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "x-request-id": "gateway-request-123",
        "x-toking-task-id": "task-42",
        "x-toking-task-name": "Southeast Asia launch plan",
      },
      payload: { model: "gangram/openai/gpt-4o-mini", messages: [{ role: "user", content: "Hello" }] },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe("Hello");
    expect(calls.find((call) => call.url.endsWith("/internal/v1/reservations"))?.body).toMatchObject({ gatewayApiKey: gatewayKey, gatewayRequestId: "gateway-request-123", estimatedCredits: "1000" });
    expect(calls.find((call) => call.url.includes("/capture"))?.body).toMatchObject({ capturedCredits: "1500", metadata: { provider: "gangram", upstreamModel: "openai/gpt-4o-mini", model: "gangram/openai/gpt-4o-mini", task: { id: "task-42", name: "Southeast Asia launch plan" } } });
    expect(response.json().model).toBe("gangram/openai/gpt-4o-mini");
    expect(calls.find((call) => call.url.endsWith("/chat/completions"))).toMatchObject({ url: "http://gangram.test/v1/chat/completions", body: { model: "openai/gpt-4o-mini" } });
  });

  it("releases the reservation when Gangram rejects a request", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith("/gateway-api-keys/resolve")) return json({ creditAccountId: "account-test", defaultProviderId: null });
      if (url.endsWith("/models")) return json({ object: "list", data: ["openai/gpt-4o-mini", "test/model", "missing/model"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) });
      if (url.endsWith("/internal/v1/reservations")) return json(reservation());
      if (url.endsWith("/release")) return json({ status: "released" });
      if (url.endsWith("/chat/completions")) return json({ error: { message: "Unknown model", type: "invalid_request_error", code: "model_not_found" } }, 400);
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = await buildApp({ config: testConfig(), fetchImpl, providers }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${gatewayKey}` }, payload: { model: "gangram/missing/model", messages: [{ role: "user", content: "Hello" }] } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("provider_error");
    expect(calls.some((url) => url.endsWith("/release"))).toBe(true);
    expect(calls.some((url) => url.includes("/capture"))).toBe(false);
  });

  it("passes streaming chunks through and captures final reported usage", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const stream = [
      'data: {"id":"chatcmpl-stream","model":"openai/gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"id":"chatcmpl-stream","model":"openai/gpt-4o-mini","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n',
      'data: {"id":"chatcmpl-stream","model":"openai/gpt-4o-mini","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7,"cost":0.002}}\n\n',
      "data: [DONE]\n\n",
    ];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/gateway-api-keys/resolve")) return json({ creditAccountId: "account-test", defaultProviderId: null });
      if (url.endsWith("/models")) return json({ object: "list", data: ["openai/gpt-4o-mini", "test/model", "missing/model"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) });
      if (url.endsWith("/internal/v1/reservations")) return json(reservation());
      if (url.includes("/capture")) { captured.push(JSON.parse(String(init?.body))); return json({ status: "captured" }); }
      if (url.endsWith("/chat/completions")) {
        return new Response(new ReadableStream({ start(controller) { for (const event of stream) controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = await buildApp({ config: testConfig(), fetchImpl, providers }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${gatewayKey}` }, payload: { model: "gangram/openai/gpt-4o-mini", stream: true, messages: [{ role: "user", content: "Hello".repeat(12000) }] } });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain('"content":"Hello"');
    expect(response.body).toContain("data: [DONE]");
    expect(response.body).toContain('"model":"gangram/openai/gpt-4o-mini"');
    expect(captured[0]).toMatchObject({ capturedCredits: "2000" });
  });

  it("caps unpriced incomplete stream charges at the reservation", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/gateway-api-keys/resolve")) return json({ creditAccountId: "account-test", defaultProviderId: null });
      if (url.endsWith("/models")) return json({ object: "list", data: ["openai/gpt-4o-mini", "test/model", "missing/model"].map((id) => ({ id, object: "model", created: 0, owned_by: "test" })) });
      if (url.endsWith("/internal/v1/reservations")) return json({ ...reservation("5"), reservedCredits: "5", reservedBalance: "5", availableBalance: "0" });
      if (url.includes("/capture")) { captured.push(JSON.parse(String(init?.body))); return json({ status: "captured" }); }
      if (url.endsWith("/chat/completions")) {
        const event = `data: ${JSON.stringify({ id: "chatcmpl-cutoff", choices: [{ index: 0, delta: { content: "This response is long enough to exceed the tiny wallet." } }] })}\n\n`;
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const app = await buildApp({ config: testConfig({ DEFAULT_RESERVATION_CREDITS: 5 }), fetchImpl, providers }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${gatewayKey}` }, payload: { model: "gangram/test/model", stream: true, messages: [{ role: "user", content: "Hi" }] } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("provider_stream_incomplete");
    expect(response.body).not.toContain("insufficient_credits");
    expect(captured[0]).toMatchObject({ capturedCredits: "5", metadata: { billingBasis: "capped_estimate" } });
  });

  it("rejects malformed Toking API keys before reserving credit", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => { called = true; return json({}); };
    const app = await buildApp({ config: testConfig(), fetchImpl, providers }); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: "Bearer invalid" }, payload: { model: "gangram/test/model", messages: [{ role: "user", content: "Hi" }] } });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_api_key");
    expect(called).toBe(false);
  });
});
