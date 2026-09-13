import { eq, sql as drizzleSql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { db, sql } from "../src/db/client.js";
import { aiProviders, ledgerAccounts, ledgerEntries, ledgerJournals } from "../src/db/schema.js";
import { newId } from "../src/lib/ids.js";

const unique = Date.now().toString();
const phone = `+8613${unique.slice(-9)}`;

describe("Credit Service V1 flow", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let adminToken: string;
  let clientApiKey: string;
  let giftCodes: string[];

  beforeAll(async () => {
    app = await buildApp();

    const login = await app.inject({
      method: "POST",
      url: "/v1/admin/login",
      payload: { password: "development-admin" },
    });
    expect(login.statusCode).toBe(200);
    adminToken = login.json().token;

    const client = await app.inject({
      method: "POST",
      url: "/v1/admin/clients",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `Gift website ${unique}` },
    });
    expect(client.statusCode).toBe(201);

    const credential = await app.inject({
      method: "POST",
      url: `/v1/admin/clients/${client.json().id}/api-keys`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        name: "Test redemption key",
        scopes: ["gift-cards:redeem-anonymously", "gift-cards:redeem"],
      },
    });
    expect(credential.statusCode).toBe(201);
    clientApiKey = credential.json().rawKey;

    const batch = await app.inject({
      method: "POST",
      url: "/v1/admin/gift-card-batches",
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { name: `Test batch ${unique}` },
    });
    expect(batch.statusCode).toBe(201);

    const cards = await app.inject({
      method: "POST",
      url: `/v1/admin/gift-card-batches/${batch.json().id}/cards`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { quantity: 5, creditAmount: "1000" },
    });
    expect(cards.statusCode).toBe(201);
    giftCodes = cards.json().map((card: { code: string }) => card.code);
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("redeems anonymously, over-captures, and blocks the next reservation", async () => {
    const redemption = await app.inject({
      method: "POST",
      url: "/v1/client/gift-cards/redeem-anonymously",
      headers: {
        authorization: `Bearer ${clientApiKey}`,
        "idempotency-key": `anonymous-${unique}`,
      },
      payload: { code: giftCodes[0] },
    });
    expect(redemption.statusCode).toBe(200);
    expect(redemption.json()).toMatchObject({
      credited: "1000",
      balanceAfter: "1000",
      baseUrl: "http://127.0.0.1:3200/v1",
      modelsUrl: "http://127.0.0.1:3200/v1/models",
      chatCompletionsUrl: "http://127.0.0.1:3200/v1/chat/completions",
    });
    const gatewayApiKey = redemption.json().apiKey;

    const resolvedGatewayKey = await app.inject({
      method: "POST",
      url: "/internal/v1/gateway-api-keys/resolve",
      headers: { "x-toking-internal-secret": "development-internal-secret-change-me-now" },
      payload: { gatewayApiKey },
    });
    expect(resolvedGatewayKey.statusCode).toBe(200);
    expect(resolvedGatewayKey.json()).toMatchObject({
      creditAccountId: redemption.json().creditAccountId,
      defaultProviderId: null,
    });

    const retriedRedemption = await app.inject({
      method: "POST",
      url: "/v1/client/gift-cards/redeem-anonymously",
      headers: {
        authorization: `Bearer ${clientApiKey}`,
        "idempotency-key": `anonymous-${unique}`,
      },
      payload: { code: giftCodes[0] },
    });
    expect(retriedRedemption.statusCode).toBe(200);
    expect(retriedRedemption.json().apiKey).toBe(gatewayApiKey);

    const reservation = await app.inject({
      method: "POST",
      url: "/internal/v1/reservations",
      headers: { "x-toking-internal-secret": "development-internal-secret-change-me-now" },
      payload: {
        gatewayApiKey,
        gatewayRequestId: `gateway-${unique}`,
        estimatedCredits: "800",
      },
    });
    expect(reservation.statusCode).toBe(201);
    expect(reservation.json()).toMatchObject({ availableBalance: "200" });

    const capture = await app.inject({
      method: "POST",
      url: `/internal/v1/reservations/${reservation.json().reservationId}/capture`,
      headers: {
        "x-toking-internal-secret": "development-internal-secret-change-me-now",
        "idempotency-key": `capture-${unique}`,
      },
      payload: { capturedCredits: "1200", metadata: { model: "test/model" } },
    });
    expect(capture.statusCode).toBe(200);
    expect(capture.json()).toMatchObject({
      postedBalance: "-200",
      reservedBalance: "0",
      availableBalance: "-200",
      canReserve: false,
    });

    const blocked = await app.inject({
      method: "POST",
      url: "/internal/v1/reservations",
      headers: { "x-toking-internal-secret": "development-internal-secret-change-me-now" },
      payload: {
        gatewayApiKey,
        gatewayRequestId: `blocked-${unique}`,
        estimatedCredits: "1",
      },
    });
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json().error.code).toBe("insufficient_credits");
  });

  it("creates a phone user and redeems into the user's wallet", async () => {
    const requested = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/request",
      payload: { phone },
    });
    expect(requested.statusCode).toBe(202);

    const verified = await app.inject({
      method: "POST",
      url: "/v1/auth/otp/verify",
      payload: { challengeId: requested.json().challengeId, code: "123456" },
    });
    expect(verified.statusCode).toBe(200);
    const userToken = verified.json().accessToken;

    const redemption = await app.inject({
      method: "POST",
      url: "/v1/gift-cards/redeem",
      headers: {
        authorization: `Bearer ${userToken}`,
        "idempotency-key": `user-${unique}`,
      },
      payload: { code: giftCodes[1] },
    });
    expect(redemption.statusCode).toBe(200);
    expect(redemption.json()).toMatchObject({ credited: "1000", balanceAfter: "1000" });

    const wallet = await app.inject({
      method: "GET",
      url: "/v1/wallet",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(wallet.statusCode).toBe(200);
    expect(wallet.json()).toMatchObject({
      postedBalance: "1000",
      reservedBalance: "0",
      availableBalance: "1000",
      canReserve: true,
    });
  });

  it("resolves one wallet per third-party user and credits later cards to it", async () => {
    const redeemFor = (code: string, externalUserId: string, key: string) =>
      app.inject({
        method: "POST",
        url: "/v1/client/gift-cards/redeem",
        headers: {
          authorization: `Bearer ${clientApiKey}`,
          "idempotency-key": key,
        },
        payload: { code, externalUserId },
      });

    const first = await redeemFor(giftCodes[2], "gangram-user-42", `linked-first-${unique}`);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      walletCreated: true,
      credited: "1000",
      balanceAfter: "1000",
    });
    expect(first.json().apiKey).toMatch(/^tk_live_/);

    const topUp = await redeemFor(giftCodes[3], "gangram-user-42", `linked-topup-${unique}`);
    expect(topUp.statusCode).toBe(200);
    expect(topUp.json()).toMatchObject({
      creditAccountId: first.json().creditAccountId,
      walletCreated: false,
      credited: "1000",
      balanceAfter: "2000",
    });
    expect(topUp.json()).not.toHaveProperty("apiKey");

    const otherUser = await redeemFor(giftCodes[4], "gangram-user-99", `linked-other-${unique}`);
    expect(otherUser.statusCode).toBe(200);
    expect(otherUser.json().walletCreated).toBe(true);
    expect(otherUser.json().creditAccountId).not.toBe(first.json().creditAccountId);

    const mappings = await sql`
      select external_user_id
      from integration_customer_accounts
      where credit_account_id in (${first.json().creditAccountId}, ${otherUser.json().creditAccountId})
    `;
    expect(mappings).toHaveLength(2);
    expect(mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ external_user_id: "gangram-user-42" }),
      expect.objectContaining({ external_user_id: "gangram-user-99" }),
    ]));
  });

  it("keeps every posted journal balanced", async () => {
    const result = await db.execute<{ journal_id: string; total: string }>(drizzleSql`
      select journal_id, sum(amount)::text as total
      from ledger_entries
      group by journal_id
      having sum(amount) <> 0
    `);
    expect(result).toHaveLength(0);
  });

  it("serves the admin dashboard data", async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const [overview, batches, clients, accounts, audit] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/admin/overview", headers }),
      app.inject({ method: "GET", url: "/v1/admin/gift-card-batches", headers }),
      app.inject({ method: "GET", url: "/v1/admin/clients", headers }),
      app.inject({ method: "GET", url: "/v1/admin/credit-accounts", headers }),
      app.inject({ method: "GET", url: "/v1/admin/audit-events", headers }),
    ]);

    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ ledgerImbalanceCount: 0 });
    expect(batches.json().some((batch: { name: string }) => batch.name === `Test batch ${unique}`)).toBe(true);
    expect(clients.json().some((client: { name: string }) => client.name === `Gift website ${unique}`)).toBe(true);
    expect(accounts.json().length).toBeGreaterThanOrEqual(2);
    expect(audit.json().some((event: { action: string }) => event.action === "gift_cards.generated")).toBe(true);
  });

  it("manages encrypted AI provider credentials through the admin plane", async () => {
    const headers = { authorization: `Bearer ${adminToken}` };
    const id = `test-${unique}`;
    const rawKey = `provider-secret-${unique}`;
    const created = await app.inject({
      method: "POST",
      url: "/v1/admin/ai-providers",
      headers,
      payload: { id, name: "Test provider", baseUrl: "http://provider.test/v1/", apiKey: rawKey, enabled: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id, baseUrl: "http://provider.test/v1", enabled: true });
    expect(created.body).not.toContain(rawKey);

    const [stored] = await db.select().from(aiProviders).where(eq(aiProviders.id, id)).limit(1);
    expect(stored?.apiKeyCiphertext).not.toContain(rawKey);

    const listed = await app.inject({ method: "GET", url: "/v1/admin/ai-providers", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).not.toContain(rawKey);
    expect(listed.json().some((provider: { id: string }) => provider.id === id)).toBe(true);

    const internal = await app.inject({
      method: "GET",
      url: "/internal/v1/ai-providers",
      headers: { "x-toking-internal-secret": "development-internal-secret-change-me-now" },
    });
    expect(internal.statusCode).toBe(200);
    expect(internal.json().find((provider: { id: string }) => provider.id === id).apiKey).toBe(rawKey);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/v1/admin/ai-providers/${id}`,
      headers,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    const active = await app.inject({
      method: "GET",
      url: "/internal/v1/ai-providers",
      headers: { "x-toking-internal-secret": "development-internal-secret-change-me-now" },
    });
    expect(active.json().some((provider: { id: string }) => provider.id === id)).toBe(false);
  });

  it("rejects an unbalanced journal at the database boundary", async () => {
    const accounts = await db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).limit(1);
    expect(accounts[0]).toBeDefined();

    await expect(
      db.transaction(async (tx) => {
        const journalId = newId();
        await tx.insert(ledgerJournals).values({
          id: journalId,
          type: "invalid_test",
          sourceReference: `test-${unique}`,
          idempotencyKey: `invalid-${unique}`,
        });
        await tx.insert(ledgerEntries).values({
          id: newId(),
          journalId,
          ledgerAccountId: accounts[0]!.id,
          amount: 1n,
        });
      }),
    ).rejects.toThrow(/not balanced/);
  });

  it("prevents changes to posted ledger entries", async () => {
    const entries = await db.select({ id: ledgerEntries.id }).from(ledgerEntries).limit(1);
    expect(entries[0]).toBeDefined();
    let caught: unknown;
    try {
      await db
        .update(ledgerEntries)
        .set({ amount: 999n })
        .where(eq(ledgerEntries.id, entries[0]!.id));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    expect((caught as { cause?: Error }).cause?.message).toMatch(/immutable/);
  });
});
