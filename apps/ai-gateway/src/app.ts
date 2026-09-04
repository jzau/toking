import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { z, ZodError } from "zod";

import { config as defaultConfig, type GatewayConfig, type ProviderConfig } from "./config.js";
import { CreditClient, type Reservation } from "./credit-client.js";
import { GatewayError, openAiError } from "./errors.js";
import { estimateCredits, estimatePromptTokens, type Usage, usageCredits } from "./pricing.js";
import { ProviderRegistry } from "./providers.js";

const chatCompletionSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.record(z.string(), z.unknown())).min(1),
  stream: z.boolean().optional().default(false),
}).loose();

type ChatCompletionBody = z.infer<typeof chatCompletionSchema>;

function gatewayBearerToken(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new GatewayError(401, "invalid_api_key", "Missing Toking API key", "invalid_request_error");
  }
  const token = authorization.slice(7).trim();
  if (!token.startsWith("tk_live_") || token.length < 20) {
    throw new GatewayError(401, "invalid_api_key", "Invalid Toking API key", "invalid_request_error");
  }
  return token;
  return token;
}

function outputCharacters(payload: unknown): number {
  if (!payload || typeof payload !== "object") return 0;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return 0;
  return choices.reduce((total, choice) => {
    if (!choice || typeof choice !== "object") return total;
    const delta = (choice as { delta?: unknown }).delta;
    if (!delta || typeof delta !== "object") return total;
    const content = (delta as { content?: unknown }).content;
    return total + (typeof content === "string" ? content.length : 0);
  }, 0);
}

function usageFrom(payload: unknown): Usage | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const usage = (payload as { usage?: unknown }).usage;
  return usage && typeof usage === "object" ? usage as Usage : undefined;
}

async function safelyRelease(client: CreditClient, reservationId: string, reason: string) {
  try { await client.release(reservationId, reason); } catch { /* expiry worker is the fallback */ }
}

async function settle(
  client: CreditClient,
  config: GatewayConfig,
  reservation: Reservation,
  providerId: string,
  upstreamModel: string,
  model: string,
  usage: Usage | undefined,
  fallbackCredits: bigint,
  upstreamId?: string,
) {
  const credits = usageCredits(config, usage) ?? fallbackCredits;
  if (credits <= 0n) {
    await client.release(reservation.reservationId, "provider_reported_zero_cost");
    return { credits: 0n, captured: false };
  }
  await client.capture(reservation.reservationId, credits, {
    provider: providerId,
    upstreamModel,
    model,
    upstreamId: upstreamId ?? null,
    usage: usage ?? null,
  });
  return { credits, captured: true };
}

async function streamCompletion(input: {
  reply: FastifyReply;
  upstream: Response;
  controller: AbortController;
  creditClient: CreditClient;
  config: GatewayConfig;
  reservation: Reservation;
  providerId: string;
  upstreamModel: string;
  body: ChatCompletionBody;
  promptTokens: number;
}) {
  const { reply, upstream, controller, creditClient, config, reservation, providerId, upstreamModel, body, promptTokens } = input;
  if (!upstream.body) {
    await safelyRelease(creditClient, reservation.reservationId, "empty_provider_stream");
    throw new GatewayError(502, "empty_provider_response", "AI provider returned an empty stream");
  }

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-toking-request-id": reservation.reservationId,
  });

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let characters = 0;
  let usage: Usage | undefined;
  let upstreamId: string | undefined;
  let settled = false;
  let stoppedForBalance = false;
  let providerFailed = false;
  const spendableCredits = BigInt(reservation.postedBalance);

  reply.raw.once("close", () => { if (!settled) controller.abort(); });

  const handleEvent = (event: string) => {
    const dataLine = event.split(/\r?\n/).find((line) => line.startsWith("data:"));
    if (!dataLine) { reply.raw.write(`${event}\n\n`); return false; }
    const data = dataLine.slice(5).trim();
    if (data === "[DONE]") return true;
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      if (payload.error) {
        providerFailed = true;
        reply.raw.write(`data: ${JSON.stringify(openAiError(new GatewayError(502, "provider_error", "AI provider stream failed")))}\n\n`);
        controller.abort();
        return true;
      }
      characters += outputCharacters(payload);
      usage = usageFrom(payload) ?? usage;
      if (typeof payload.id === "string") upstreamId = payload.id;
      if (typeof payload.model === "string") {
        payload.model = body.model;
        event = event.split(/\r?\n/).map((line) => line === dataLine ? `data: ${JSON.stringify(payload)}` : line).join("\n");
      }
    } catch { /* forward provider extensions unchanged */ }
    reply.raw.write(`${event}\n\n`);
    return false;
  };

  try {
    let sawDone = false;
    while (!sawDone) {
      const chunk = await reader.read();
      if (chunk.done) break;
      pending += decoder.decode(chunk.value, { stream: true });
      const events = pending.split(/\r?\n\r?\n/);
      pending = events.pop() ?? "";
      for (const event of events) {
        if (!event) continue;
        sawDone = handleEvent(event);
        const estimated = estimateCredits(config, promptTokens, characters);
        if (!usage && estimated > spendableCredits) {
          stoppedForBalance = true;
          sawDone = true;
          controller.abort();
          break;
        }
        if (sawDone) break;
      }
    }

    if (pending.trim() && !sawDone) sawDone = handleEvent(pending.trim());
    if (!sawDone) throw new GatewayError(502, "provider_stream_incomplete", "AI provider stream ended before completion");
    const fallbackCredits = estimateCredits(config, promptTokens, characters);
    if (providerFailed && characters === 0 && !usage) {
      await safelyRelease(creditClient, reservation.reservationId, "provider_stream_failed_before_output");
    } else {
      await settle(creditClient, config, reservation, providerId, upstreamModel, body.model, usage, fallbackCredits, upstreamId);
    }
    settled = true;

    if (stoppedForBalance && !reply.raw.destroyed) {
      reply.raw.write(`data: ${JSON.stringify(openAiError(new GatewayError(402, "insufficient_credits", "The response stopped because the Credit Account balance was exhausted", "insufficient_quota")))}\n\n`);
    }
    if (!reply.raw.destroyed) reply.raw.end("data: [DONE]\n\n");
  } catch (error) {
    if (!settled) {
      const fallbackCredits = estimateCredits(config, promptTokens, characters);
      try {
        if (characters > 0) await settle(creditClient, config, reservation, providerId, upstreamModel, body.model, usage, fallbackCredits, upstreamId);
        else await safelyRelease(creditClient, reservation.reservationId, "stream_failed_before_output");
      } catch { /* the reservation expiry worker remains the final fallback */ }
    }
    if (!reply.raw.destroyed) {
      const normalized = error instanceof GatewayError ? error : new Error("Streaming failed");
      reply.raw.end(`data: ${JSON.stringify(openAiError(normalized))}\n\ndata: [DONE]\n\n`);
    }
  } finally {
    controller.abort();
    reader.releaseLock();
  }
}

export async function buildApp(options: { config?: GatewayConfig; fetchImpl?: typeof fetch; providers?: ProviderConfig[] } = {}) {
  const config = options.config ?? defaultConfig;
  const fetchImpl = options.fetchImpl ?? fetch;
  const creditClient = new CreditClient(config, fetchImpl);
  const providers = new ProviderRegistry(
    config,
    fetchImpl,
    options.providers ? async () => options.providers! : () => creditClient.providers(),
  );
  const app = Fastify({ logger: config.NODE_ENV !== "test", trustProxy: true, requestIdHeader: "x-request-id" });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof GatewayError) return reply.code(error.statusCode).send(openAiError(error, request.id));
    if (error instanceof ZodError) {
      return reply.code(400).send(openAiError(new GatewayError(400, "invalid_request", "Request validation failed", "invalid_request_error"), request.id));
    }
    request.log.error(error);
    return reply.code(500).send(openAiError(new Error("An unexpected gateway error occurred"), request.id));
  });

  app.get("/health", async () => ({
    status: "ok", service: "toking-ai-gateway",
    providers: await providers.configured(),
  }));

  app.get("/v1/models", async (request, reply) => {
    await creditClient.authenticate(gatewayBearerToken(request));
    reply.header("cache-control", "no-store");
    return providers.catalog();
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const gatewayApiKey = gatewayBearerToken(request);
    const body = chatCompletionSchema.parse(request.body);
    await creditClient.authenticate(gatewayApiKey);
    const { provider, upstreamModel } = await providers.resolve(body.model);
    const suppliedIdempotencyKey = request.headers["idempotency-key"];
    const gatewayRequestId = typeof suppliedIdempotencyKey === "string" && suppliedIdempotencyKey.length >= 8
      ? suppliedIdempotencyKey
      : request.id.length >= 8 ? request.id : randomUUID();
    const promptTokens = estimatePromptTokens(body.messages);
    const reservation = await creditClient.reserve(gatewayApiKey, gatewayRequestId, config.DEFAULT_RESERVATION_CREDITS);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.UPSTREAM_TIMEOUT_MS);
    let upstream: Response;

    try {
      upstream = await provider.complete({
        ...body,
        model: upstreamModel,
        ...(body.stream ? { stream_options: { ...(body.stream_options as object | undefined), include_usage: true } } : {}),
      }, controller.signal, reservation.reservationId);
    } catch (error) {
      clearTimeout(timeout);
      await safelyRelease(creditClient, reservation.reservationId, "provider_request_failed");
      const message = error instanceof Error && error.name === "AbortError" ? "AI provider request timed out" : "AI provider could not be reached";
      throw new GatewayError(502, "provider_unavailable", message);
    }

    if (!upstream.ok) {
      clearTimeout(timeout);
      await safelyRelease(creditClient, reservation.reservationId, `provider_http_${upstream.status}`);
      await upstream.body?.cancel().catch(() => {});
      const status = [400, 404, 429].includes(upstream.status) ? upstream.status : 502;
      request.log.warn({ provider: provider.id, upstreamStatus: upstream.status }, "Provider rejected completion");
      // Provider credentials and private error details must never be returned to clients.
      return reply.code(status).send(openAiError(new GatewayError(status, "provider_error", "AI provider rejected the request"), request.id));
    }

    if (body.stream) {
      if (!upstream.body || !upstream.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) {
        clearTimeout(timeout);
        await upstream.body?.cancel().catch(() => {});
        await safelyRelease(creditClient, reservation.reservationId, "provider_response_invalid");
        throw new GatewayError(502, "provider_response_invalid", "AI provider did not return an event stream");
      }
      void streamCompletion({ reply, upstream, controller, creditClient, config, reservation, providerId: provider.id, upstreamModel, body, promptTokens }).finally(() => clearTimeout(timeout));
      return reply;
    }

    let payload: Record<string, unknown>;
    try {
      payload = z.object({
        id: z.string().min(1),
        object: z.literal("chat.completion"),
        choices: z.array(z.object({ message: z.object({ content: z.unknown().optional() }).loose() }).loose()),
      }).loose().parse(await upstream.json());
    } catch {
      clearTimeout(timeout);
      await safelyRelease(creditClient, reservation.reservationId, "provider_response_invalid");
      throw new GatewayError(502, "provider_response_invalid", "AI provider returned an invalid response");
    }
    clearTimeout(timeout);
    const usage = usageFrom(payload);
    const content = ((payload.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content);
    const fallback = estimateCredits(config, promptTokens, typeof content === "string" ? content.length : 0);
    await settle(creditClient, config, reservation, provider.id, upstreamModel, body.model, usage, fallback, typeof payload.id === "string" ? payload.id : undefined);
    payload.model = body.model;
    reply.header("x-toking-reservation-id", reservation.reservationId);
    return payload;
  });

  return app;
}
