import type { FastifyInstance } from "fastify";
import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import { z } from "zod";

import { config } from "../config.js";
import { db } from "../db/client.js";
import {
  auditEvents,
  clientApiKeys,
  creditAccounts,
  giftCardRedemptions,
  giftCards,
  ledgerAccounts,
  ledgerEntries,
  ledgerJournals,
  reservations,
} from "../db/schema.js";
import { safeEqual } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import {
  bearerToken,
  createAdminSession,
  requireAdmin,
  requireInternalService,
} from "./auth.js";
import { CLIENT_API_SCOPES, authenticateClient, createClientApiKey, createIntegrationClient } from "../services/clients.js";
import { authenticateUser, logoutUser, requestOtp, verifyOtp } from "../services/identity.js";
import {
  createGiftCardBatch,
  generateGiftCards,
  redeemGiftCard,
} from "../services/gift-cards.js";
import {
  captureReservation,
  createReservation,
  releaseReservation,
} from "../services/reservations.js";
import { recordAudit } from "../services/audit.js";
import { resolveGatewayApiKey } from "../services/credit-accounts.js";
import {
  createAiProvider,
  internalAiProviders,
  listAiProviders,
  providerBaseUrlSchema,
  providerIdSchema,
  testAiProvider,
  updateAiProvider,
} from "../services/ai-providers.js";

const idempotencyHeader = z.string().min(8).max(200);
const positiveCredits = z.coerce.bigint().positive();

function idempotencyKey(headers: Record<string, unknown>): string {
  return idempotencyHeader.parse(headers["idempotency-key"]);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => {
    await db.execute(drizzleSql`select 1`);
    return { status: "ok", service: "toking-credit-api" };
  });

  app.post("/v1/auth/otp/request", async (request, reply) => {
    const body = z.object({ phone: z.string() }).parse(request.body);
    return reply.code(202).send(await requestOtp(body.phone));
  });

  app.post("/v1/auth/otp/verify", async (request) => {
    const body = z
      .object({ challengeId: z.string().uuid(), code: z.string().regex(/^\d{6}$/) })
      .parse(request.body);
    return verifyOtp(body);
  });

  app.post("/v1/auth/logout", async (request, reply) => {
    await logoutUser(bearerToken(request));
    return reply.code(204).send();
  });

  app.get("/v1/wallet", async (request) => {
    const user = await authenticateUser(bearerToken(request));
    const rows = await db
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, user.creditAccountId))
      .limit(1);
    const account = rows[0];
    if (!account) throw new AppError(404, "wallet_not_found", "Wallet not found");
    return {
      creditAccountId: account.id,
      postedBalance: account.postedBalance,
      reservedBalance: account.reservedBalance,
      availableBalance: account.postedBalance - account.reservedBalance,
      canReserve: account.postedBalance - account.reservedBalance > 0n,
      defaultProviderId: account.defaultProviderId,
      status: account.status,
    };
  });

  app.get("/v1/wallet/transactions", async (request) => {
    const user = await authenticateUser(bearerToken(request));
    return db
      .select({
        transactionId: ledgerJournals.id,
        type: ledgerJournals.type,
        sourceReference: ledgerJournals.sourceReference,
        amount: ledgerEntries.amount,
        metadata: ledgerJournals.metadata,
        postedAt: ledgerJournals.postedAt,
      })
      .from(ledgerEntries)
      .innerJoin(ledgerAccounts, eq(ledgerEntries.ledgerAccountId, ledgerAccounts.id))
      .innerJoin(ledgerJournals, eq(ledgerEntries.journalId, ledgerJournals.id))
      .where(eq(ledgerAccounts.creditAccountId, user.creditAccountId))
      .orderBy(desc(ledgerJournals.postedAt))
      .limit(100);
  });

  app.post("/v1/gift-cards/redeem", async (request) => {
    const user = await authenticateUser(bearerToken(request));
    const body = z.object({ code: z.string().min(10).max(100) }).parse(request.body);
    return redeemGiftCard({
      code: body.code,
      idempotencyKey: idempotencyKey(request.headers),
      creditAccountId: user.creditAccountId,
      anonymous: false,
    });
  });

  app.post("/v1/client/gift-cards/redeem-anonymously", async (request) => {
    const client = await authenticateClient(
      db,
      bearerToken(request),
      "gift-cards:redeem-anonymously",
    );
    const body = z.object({ code: z.string().min(10).max(100) }).parse(request.body);
    return redeemGiftCard({
      code: body.code,
      idempotencyKey: idempotencyKey(request.headers),
      clientId: client.clientId,
      anonymous: true,
    });
  });

  app.post("/v1/client/gift-cards/redeem", async (request) => {
    const client = await authenticateClient(db, bearerToken(request), "gift-cards:redeem");
    const body = z
      .object({
        code: z.string().min(10).max(100),
        externalUserId: z.string().trim().min(1).max(200),
      })
      .parse(request.body);
    return redeemGiftCard({
      code: body.code,
      idempotencyKey: idempotencyKey(request.headers),
      clientId: client.clientId,
      externalUserId: body.externalUserId,
      anonymous: false,
    });
  });

  app.post("/v1/admin/login", async (request) => {
    const body = z.object({ password: z.string() }).parse(request.body);
    if (!safeEqual(body.password, config.ADMIN_PASSWORD)) {
      throw new AppError(401, "invalid_admin_password", "Invalid admin password");
    }
    return createAdminSession();
  });

  app.post("/v1/admin/clients", async (request, reply) => {
    requireAdmin(request);
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    const client = await createIntegrationClient(db, body.name);
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "client.created",
      targetType: "integration_client",
      targetId: client.id,
      metadata: { name: body.name },
    });
    return reply.code(201).send(client);
  });

  app.post("/v1/admin/clients/:id/api-keys", async (request, reply) => {
    requireAdmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(1).max(120),
        scopes: z.array(z.enum(CLIENT_API_SCOPES)).min(1),
      })
      .parse(request.body);
    const key = await createClientApiKey(db, {
        clientId: params.id,
        name: body.name,
        scopes: body.scopes,
      });
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "client_api_key.created",
      targetType: "integration_client",
      targetId: params.id,
      metadata: { keyId: key.id, scopes: body.scopes },
    });
    return reply.code(201).send(key);
  });

  app.post("/v1/admin/gift-card-batches", async (request, reply) => {
    requireAdmin(request);
    const body = z
      .object({ name: z.string().min(1).max(120), expiresAt: z.coerce.date().optional() })
      .parse(request.body);
    const batch = await createGiftCardBatch(db, {
        name: body.name,
        ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}),
      });
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "gift_card_batch.created",
      targetType: "gift_card_batch",
      targetId: batch.id,
      metadata: { name: body.name },
    });
    return reply.code(201).send(batch);
  });

  app.post("/v1/admin/gift-card-batches/:id/cards", async (request, reply) => {
    requireAdmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({ quantity: z.coerce.number().int(), creditAmount: positiveCredits })
      .parse(request.body);
    const cards = await generateGiftCards(db, {
        batchId: params.id,
        quantity: body.quantity,
        creditAmount: body.creditAmount,
      });
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "gift_cards.generated",
      targetType: "gift_card_batch",
      targetId: params.id,
      metadata: { quantity: body.quantity, creditAmount: body.creditAmount.toString() },
    });
    return reply.code(201).send(cards);
  });

  app.get("/v1/admin/overview", async (request) => {
    requireAdmin(request);
    const rows = await db.execute<{
      totalIssued: string;
      totalRedeemed: string;
      activeCards: number;
      redeemedCards: number;
      creditAccounts: number;
      negativeAccounts: number;
      integrationClients: number;
      activeReservations: number;
      ledgerImbalanceCount: number;
    }>(drizzleSql`
      select
        coalesce((select sum(credit_amount) from gift_cards), 0)::text as "totalIssued",
        coalesce((select sum(credit_amount) from gift_cards where status = 'redeemed'), 0)::text as "totalRedeemed",
        (select count(*)::int from gift_cards where status = 'active') as "activeCards",
        (select count(*)::int from gift_cards where status = 'redeemed') as "redeemedCards",
        (select count(*)::int from credit_accounts) as "creditAccounts",
        (select count(*)::int from credit_accounts where posted_balance < 0) as "negativeAccounts",
        (select count(*)::int from integration_clients where status = 'active') as "integrationClients",
        (select count(*)::int from reservations where status = 'reserved') as "activeReservations",
        (select count(*)::int from (
          select journal_id from ledger_entries group by journal_id having sum(amount) <> 0
        ) imbalanced) as "ledgerImbalanceCount"
    `);
    return rows[0];
  });

  app.get("/v1/admin/gift-card-batches", async (request) => {
    requireAdmin(request);
    return db.execute(drizzleSql`
      select
        b.id,
        b.name,
        b.status,
        b.expires_at as "expiresAt",
        b.created_at as "createdAt",
        count(c.id)::int as "cardCount",
        count(c.id) filter (where c.status = 'active')::int as "activeCount",
        count(c.id) filter (where c.status = 'redeemed')::int as "redeemedCount",
        coalesce(sum(c.credit_amount), 0)::text as "issuedCredits"
      from gift_card_batches b
      left join gift_cards c on c.batch_id = b.id
      group by b.id
      order by b.created_at desc
      limit 100
    `);
  });

  app.get("/v1/admin/gift-card-batches/:id/cards", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return db
      .select({
        id: giftCards.id,
        codePrefix: giftCards.codePrefix,
        creditAmount: giftCards.creditAmount,
        status: giftCards.status,
        expiresAt: giftCards.expiresAt,
        redeemedAt: giftCards.redeemedAt,
        creditAccountId: giftCards.redeemedCreditAccountId,
        createdAt: giftCards.createdAt,
      })
      .from(giftCards)
      .where(eq(giftCards.batchId, params.id))
      .orderBy(desc(giftCards.createdAt))
      .limit(500);
  });

  app.get("/v1/admin/clients", async (request) => {
    requireAdmin(request);
    return db.execute(drizzleSql`
      select
        c.id,
        c.name,
        c.status,
        c.created_at as "createdAt",
        count(k.id)::int as "keyCount",
        count(k.id) filter (where k.status = 'active')::int as "activeKeyCount"
      from integration_clients c
      left join client_api_keys k on k.client_id = c.id
      group by c.id
      order by c.created_at desc
      limit 100
    `);
  });

  app.get("/v1/admin/credit-accounts", async (request) => {
    requireAdmin(request);
    return db.execute(drizzleSql`
      select
        a.id,
        a.owner_type as "ownerType",
        a.user_id as "userId",
        a.posted_balance::text as "postedBalance",
        a.reserved_balance::text as "reservedBalance",
        (a.posted_balance - a.reserved_balance)::text as "availableBalance",
        a.default_provider_id as "defaultProviderId",
        a.status,
        a.created_at as "createdAt",
        count(distinct k.id)::int as "apiKeyCount"
      from credit_accounts a
      left join gateway_api_keys k on k.credit_account_id = a.id and k.status = 'active'
      group by a.id
      order by a.created_at desc
      limit 200
    `);
  });

  app.patch("/v1/admin/credit-accounts/:id/provider", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ providerId: z.string().min(1).max(120).nullable() }).parse(request.body);
    const updated = await db
      .update(creditAccounts)
      .set({ defaultProviderId: body.providerId, updatedAt: new Date() })
      .where(eq(creditAccounts.id, params.id))
      .returning({ id: creditAccounts.id, defaultProviderId: creditAccounts.defaultProviderId });
    if (!updated[0]) throw new AppError(404, "credit_account_not_found", "Credit Account not found");
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "credit_account.provider_changed",
      targetType: "credit_account",
      targetId: params.id,
      metadata: { providerId: body.providerId },
    });
    return updated[0];
  });

  app.get("/v1/admin/audit-events", async (request) => {
    requireAdmin(request);
    return db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(100);
  });

  app.get("/v1/admin/ai-providers", async (request) => {
    requireAdmin(request);
    return listAiProviders(db);
  });

  app.post("/v1/admin/ai-providers", async (request, reply) => {
    requireAdmin(request);
    const body = z.object({
      id: providerIdSchema,
      name: z.string().min(1).max(120),
      baseUrl: providerBaseUrlSchema,
      apiKey: z.string().min(1).max(1000),
      enabled: z.boolean().default(true),
    }).parse(request.body);
    const provider = await createAiProvider(db, body);
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "ai_provider.created",
      targetType: "ai_provider",
      targetId: provider.id,
      metadata: { name: provider.name, baseUrl: provider.baseUrl, enabled: provider.enabled },
    });
    return reply.code(201).send(provider);
  });

  app.patch("/v1/admin/ai-providers/:id", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: providerIdSchema }).parse(request.params);
    const body = z.object({
      name: z.string().min(1).max(120).optional(),
      baseUrl: providerBaseUrlSchema.optional(),
      apiKey: z.string().min(1).max(1000).optional(),
      enabled: z.boolean().optional(),
    }).refine((value) => Object.keys(value).length > 0, "At least one change is required")
      .parse(request.body);
    const provider = await updateAiProvider(db, params.id, body);
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "ai_provider.updated",
      targetType: "ai_provider",
      targetId: provider.id,
      metadata: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.baseUrl !== undefined ? { baseUrl: body.baseUrl } : {}),
        ...(body.apiKey !== undefined ? { credentialRotated: true } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      },
    });
    return provider;
  });

  app.post("/v1/admin/ai-providers/:id/test", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: providerIdSchema }).parse(request.params);
    const result = await testAiProvider(db, params.id);
    await recordAudit(db, {
      actorType: "admin",
      actorId: "v1-admin",
      action: "ai_provider.tested",
      targetType: "ai_provider",
      targetId: params.id,
      metadata: { modelCount: result.modelCount },
    });
    return result;
  });

  app.get("/internal/v1/ai-providers", async (request) => {
    requireInternalService(request);
    return internalAiProviders(db);
  });

  app.post("/internal/v1/gateway-api-keys/resolve", async (request) => {
    requireInternalService(request);
    const body = z.object({ gatewayApiKey: z.string().min(20) }).parse(request.body);
    const resolved = await resolveGatewayApiKey(db, body.gatewayApiKey);
    return { creditAccountId: resolved.creditAccountId, defaultProviderId: resolved.defaultProviderId };
  });

  app.post("/internal/v1/reservations", async (request, reply) => {
    requireInternalService(request);
    const body = z
      .object({
        gatewayApiKey: z.string().min(20),
        gatewayRequestId: z.string().min(8).max(200),
        estimatedCredits: positiveCredits,
      })
      .parse(request.body);
    return reply.code(201).send(await createReservation(body));
  });

  app.post("/internal/v1/reservations/:id/capture", async (request) => {
    requireInternalService(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z
      .object({
        capturedCredits: positiveCredits,
        metadata: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(request.body);
    return captureReservation({
      reservationId: params.id,
      capturedCredits: body.capturedCredits,
      idempotencyKey: idempotencyKey(request.headers),
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
  });

  app.post("/internal/v1/reservations/:id/release", async (request) => {
    requireInternalService(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({ reason: z.string().min(1).max(500) }).parse(request.body);
    return releaseReservation({ reservationId: params.id, reason: body.reason });
  });

  app.get("/internal/v1/reservations/:id", async (request) => {
    requireInternalService(request);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const rows = await db
      .select()
      .from(reservations)
      .where(eq(reservations.id, params.id))
      .limit(1);
    if (!rows[0]) throw new AppError(404, "reservation_not_found", "Reservation not found");
    return rows[0];
  });
}
