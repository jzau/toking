import { and, eq, sql } from "drizzle-orm";

import { config } from "../config.js";
import { db, type DbExecutor } from "../db/client.js";
import {
  creditAccounts,
  gatewayApiKeys,
  giftCardBatches,
  giftCardRedemptions,
  giftCards,
  idempotencyRecords,
} from "../db/schema.js";
import {
  decryptJson,
  encryptJson,
  generateGiftCardCode,
  sha256,
} from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { createCreditAccount, createGatewayApiKey } from "./credit-accounts.js";
import {
  ensureSystemLedgerAccount,
  ensureWalletLedgerAccount,
  postJournal,
  SYSTEM_ACCOUNTS,
} from "./ledger.js";

export async function createGiftCardBatch(
  executor: DbExecutor,
  input: { name: string; expiresAt?: Date },
) {
  const id = newId();
  await executor.insert(giftCardBatches).values({
    id,
    name: input.name,
    expiresAt: input.expiresAt,
  });
  return { id, name: input.name, expiresAt: input.expiresAt ?? null };
}

export async function generateGiftCards(
  executor: DbExecutor,
  input: { batchId: string; quantity: number; creditAmount: bigint },
) {
  if (input.quantity < 1 || input.quantity > 1000) {
    throw new AppError(400, "invalid_quantity", "Quantity must be between 1 and 1000");
  }
  if (input.creditAmount <= 0n) {
    throw new AppError(400, "invalid_credit_amount", "Credit amount must be positive");
  }

  const batch = await executor
    .select()
    .from(giftCardBatches)
    .where(eq(giftCardBatches.id, input.batchId))
    .limit(1);
  if (!batch[0]) throw new AppError(404, "batch_not_found", "Gift-card batch not found");
  if (batch[0].status !== "active") {
    throw new AppError(409, "batch_disabled", "Gift-card batch is disabled");
  }

  const generated = Array.from({ length: input.quantity }, () => {
    const code = generateGiftCardCode();
    return {
      id: newId(),
      batchId: input.batchId,
      code,
      codePrefix: code.slice(0, 10),
      codeHash: sha256(code),
      creditAmount: input.creditAmount,
      expiresAt: batch[0]?.expiresAt ?? undefined,
    };
  });

  await executor.insert(giftCards).values(
    generated.map(({ code: _code, ...record }) => record),
  );

  return generated.map(({ id, code, creditAmount }) => ({ id, code, creditAmount }));
}

interface RedeemResult {
  transactionId: string;
  creditAccountId: string;
  credited: bigint;
  balanceAfter: bigint;
  baseUrl: string;
  modelsUrl: string;
  chatCompletionsUrl: string;
  apiKey?: string;
  apiKeyPrefix?: string;
}

export async function redeemGiftCard(input: {
  code: string;
  idempotencyKey: string;
  creditAccountId?: string;
  clientId?: string;
  anonymous: boolean;
}): Promise<RedeemResult> {
  const normalizedCode = input.code.trim().toUpperCase();
  const codeHash = sha256(normalizedCode);
  const idempotencyScope = input.anonymous
    ? `gift-redemption:client:${input.clientId ?? "unknown"}`
    : `gift-redemption:account:${input.creditAccountId ?? "unknown"}`;
  const requestHash = sha256(
    [codeHash, input.creditAccountId ?? "", input.clientId ?? "", String(input.anonymous)].join(":"),
  );

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${idempotencyScope}:${input.idempotencyKey}`}, 0))`,
    );
    const existingIdempotency = await tx
      .select()
      .from(idempotencyRecords)
      .where(
        and(
          eq(idempotencyRecords.scope, idempotencyScope),
          eq(idempotencyRecords.key, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existingIdempotency[0]) {
      if (existingIdempotency[0].requestHash !== requestHash) {
        throw new AppError(
          409,
          "idempotency_conflict",
          "Idempotency key was already used with different request data",
        );
      }
      const encrypted = existingIdempotency[0].responseBody?.encrypted;
      if (existingIdempotency[0].completed && typeof encrypted === "string") {
        const replay = decryptJson<Omit<RedeemResult, "credited" | "balanceAfter"> & {
          credited: string;
          balanceAfter: string;
        }>(encrypted, config.INTERNAL_SERVICE_SECRET);
        return {
          ...replay,
          credited: BigInt(replay.credited),
          balanceAfter: BigInt(replay.balanceAfter),
        };
      }
    }

    const cards = await tx
      .select()
      .from(giftCards)
      .where(eq(giftCards.codeHash, codeHash))
      .for("update")
      .limit(1);
    const card = cards[0];
    if (!card) throw new AppError(404, "gift_card_not_found", "Gift card is invalid");
    if (card.status !== "active") {
      throw new AppError(409, "gift_card_unavailable", "Gift card is not available");
    }
    if (card.expiresAt && card.expiresAt <= new Date()) {
      throw new AppError(409, "gift_card_expired", "Gift card has expired");
    }

    const creditAccountId = input.anonymous
      ? await createCreditAccount(tx, { ownerType: "anonymous" })
      : input.creditAccountId;
    if (!creditAccountId) {
      throw new AppError(401, "user_account_required", "A user Credit Account is required");
    }

    const account = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, creditAccountId))
      .for("update")
      .limit(1);
    if (!account[0]) throw new AppError(404, "credit_account_not_found", "Credit Account not found");
    if (account[0].status !== "active") {
      throw new AppError(409, "credit_account_suspended", "Credit Account is suspended");
    }

    const walletLedgerId = await ensureWalletLedgerAccount(tx, creditAccountId);
    const clearingLedgerId = await ensureSystemLedgerAccount(
      tx,
      SYSTEM_ACCOUNTS.giftCardClearing,
      "Gift-card clearing",
    );
    const journalId = await postJournal(tx, {
      type: "gift_card_redemption",
      sourceReference: card.id,
      idempotencyKey: `gift-card:${card.id}`,
      metadata: { clientId: input.clientId ?? null },
      entries: [
        { ledgerAccountId: walletLedgerId, amount: card.creditAmount },
        { ledgerAccountId: clearingLedgerId, amount: -card.creditAmount },
      ],
    });

    const balanceAfter = account[0].postedBalance + card.creditAmount;
    await tx
      .update(creditAccounts)
      .set({ postedBalance: balanceAfter, updatedAt: new Date() })
      .where(eq(creditAccounts.id, creditAccountId));
    await tx
      .update(giftCards)
      .set({
        status: "redeemed",
        redeemedAt: new Date(),
        redeemedCreditAccountId: creditAccountId,
      })
      .where(eq(giftCards.id, card.id));
    await tx.insert(giftCardRedemptions).values({
      id: newId(),
      giftCardId: card.id,
      creditAccountId,
      clientId: input.clientId,
      ledgerJournalId: journalId,
    });

    let key: Awaited<ReturnType<typeof createGatewayApiKey>> | undefined;
    if (input.anonymous) {
      key = await createGatewayApiKey(tx, creditAccountId);
    } else {
      const existingKey = await tx
        .select({ id: gatewayApiKeys.id, prefix: gatewayApiKeys.keyPrefix })
        .from(gatewayApiKeys)
        .where(
          and(
            eq(gatewayApiKeys.creditAccountId, creditAccountId),
            eq(gatewayApiKeys.status, "active"),
          ),
        )
        .limit(1);
      if (!existingKey[0]) key = await createGatewayApiKey(tx, creditAccountId);
    }

    const gatewayBaseUrl = config.TOKING_GATEWAY_BASE_URL.replace(/\/+$/, "");
    const result: RedeemResult = {
      transactionId: journalId,
      creditAccountId,
      credited: card.creditAmount,
      balanceAfter,
      baseUrl: gatewayBaseUrl,
      modelsUrl: `${gatewayBaseUrl}/models`,
      chatCompletionsUrl: `${gatewayBaseUrl}/chat/completions`,
      ...(key ? { apiKey: key.rawKey, apiKeyPrefix: key.prefix } : {}),
    };
    await tx.insert(idempotencyRecords).values({
      id: newId(),
      scope: idempotencyScope,
      key: input.idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseBody: {
        encrypted: encryptJson(result, config.INTERNAL_SERVICE_SECRET),
      },
      completed: true,
    });
    return result;
  });
}
