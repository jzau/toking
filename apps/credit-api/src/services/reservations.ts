import { and, eq, lte } from "drizzle-orm";

import { config } from "../config.js";
import { db } from "../db/client.js";
import { creditAccounts, reservations } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";
import { resolveGatewayApiKey } from "./credit-accounts.js";
import {
  ensureSystemLedgerAccount,
  ensureWalletLedgerAccount,
  postJournal,
  SYSTEM_ACCOUNTS,
} from "./ledger.js";

export async function createReservation(input: {
  gatewayApiKey: string;
  gatewayRequestId: string;
  estimatedCredits: bigint;
}) {
  if (input.estimatedCredits <= 0n) {
    throw new AppError(400, "invalid_estimated_credits", "Estimated Credits must be positive");
  }

  return db.transaction(async (tx) => {
    const resolved = await resolveGatewayApiKey(tx, input.gatewayApiKey);
    const existing = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.gatewayRequestId, input.gatewayRequestId))
      .limit(1);
    if (existing[0]) {
      if (
        existing[0].gatewayApiKeyId !== resolved.apiKeyId ||
        existing[0].estimatedCredits !== input.estimatedCredits
      ) {
        throw new AppError(
          409,
          "gateway_request_conflict",
          "Gateway request ID was already used with different data",
        );
      }
      return reservationResponse(existing[0], resolved.postedBalance, resolved.reservedBalance);
    }

    const accounts = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, resolved.creditAccountId))
      .for("update")
      .limit(1);
    const account = accounts[0];
    if (!account || account.status !== "active") {
      throw new AppError(403, "credit_account_unavailable", "Credit Account is unavailable");
    }

    const available = account.postedBalance - account.reservedBalance;
    if (available <= 0n || available < input.estimatedCredits) {
      throw new AppError(402, "insufficient_credits", "Insufficient available Credits");
    }

    const id = newId();
    const expiresAt = new Date(Date.now() + config.RESERVATION_TTL_SECONDS * 1000);
    const reservedBalance = account.reservedBalance + input.estimatedCredits;
    await tx.insert(reservations).values({
      id,
      creditAccountId: account.id,
      gatewayApiKeyId: resolved.apiKeyId,
      gatewayRequestId: input.gatewayRequestId,
      estimatedCredits: input.estimatedCredits,
      expiresAt,
    });
    await tx
      .update(creditAccounts)
      .set({ reservedBalance, updatedAt: new Date() })
      .where(eq(creditAccounts.id, account.id));

    return {
      reservationId: id,
      status: "reserved" as const,
      creditAccountId: account.id,
      reservedCredits: input.estimatedCredits,
      postedBalance: account.postedBalance,
      reservedBalance,
      availableBalance: account.postedBalance - reservedBalance,
      defaultProviderId: account.defaultProviderId,
      expiresAt,
    };
  });
}

export async function captureReservation(input: {
  reservationId: string;
  capturedCredits: bigint;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}) {
  if (input.capturedCredits <= 0n) {
    throw new AppError(400, "invalid_captured_credits", "Captured Credits must be positive");
  }

  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, input.reservationId))
      .for("update")
      .limit(1);
    const reservation = rows[0];
    if (!reservation) throw new AppError(404, "reservation_not_found", "Reservation not found");

    const accounts = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, reservation.creditAccountId))
      .for("update")
      .limit(1);
    const account = accounts[0];
    if (!account) throw new AppError(404, "credit_account_not_found", "Credit Account not found");

    if (reservation.status === "captured") {
      if (reservation.capturedCredits !== input.capturedCredits) {
        throw new AppError(
          409,
          "capture_conflict",
          "Reservation was captured with a different amount",
        );
      }
      return captureResponse(reservation, account.postedBalance, account.reservedBalance);
    }
    if (reservation.status !== "reserved") {
      throw new AppError(
        409,
        "reservation_not_capturable",
        `Reservation is ${reservation.status}`,
      );
    }

    const walletLedgerId = await ensureWalletLedgerAccount(tx, account.id);
    const clearingLedgerId = await ensureSystemLedgerAccount(
      tx,
      SYSTEM_ACCOUNTS.aiConsumptionClearing,
      "AI consumption clearing",
    );
    const journalId = await postJournal(tx, {
      type: "ai_credit_capture",
      sourceReference: reservation.id,
      idempotencyKey: `capture:${reservation.id}:${input.idempotencyKey}`,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      entries: [
        { ledgerAccountId: walletLedgerId, amount: -input.capturedCredits },
        { ledgerAccountId: clearingLedgerId, amount: input.capturedCredits },
      ],
    });

    const postedBalance = account.postedBalance - input.capturedCredits;
    const reservedBalance = account.reservedBalance - reservation.estimatedCredits;
    const capturedAt = new Date();
    await tx
      .update(creditAccounts)
      .set({ postedBalance, reservedBalance, updatedAt: capturedAt })
      .where(eq(creditAccounts.id, account.id));
    await tx
      .update(reservations)
      .set({ status: "captured", capturedCredits: input.capturedCredits, capturedAt })
      .where(eq(reservations.id, reservation.id));

    return {
      transactionId: journalId,
      reservationId: reservation.id,
      status: "captured" as const,
      reservedCredits: reservation.estimatedCredits,
      capturedCredits: input.capturedCredits,
      postedBalance,
      reservedBalance,
      availableBalance: postedBalance - reservedBalance,
      canReserve: postedBalance - reservedBalance > 0n,
      capturedAt,
    };
  });
}

export async function releaseReservation(input: {
  reservationId: string;
  reason: string;
}) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(reservations)
      .where(eq(reservations.id, input.reservationId))
      .for("update")
      .limit(1);
    const reservation = rows[0];
    if (!reservation) throw new AppError(404, "reservation_not_found", "Reservation not found");

    const accounts = await tx
      .select()
      .from(creditAccounts)
      .where(eq(creditAccounts.id, reservation.creditAccountId))
      .for("update")
      .limit(1);
    const account = accounts[0];
    if (!account) throw new AppError(404, "credit_account_not_found", "Credit Account not found");

    if (reservation.status === "released") {
      return releaseResponse(reservation, account.postedBalance, account.reservedBalance);
    }
    if (reservation.status !== "reserved") {
      throw new AppError(409, "reservation_not_releasable", `Reservation is ${reservation.status}`);
    }

    const releasedAt = new Date();
    const reservedBalance = account.reservedBalance - reservation.estimatedCredits;
    await tx
      .update(creditAccounts)
      .set({ reservedBalance, updatedAt: releasedAt })
      .where(eq(creditAccounts.id, account.id));
    await tx
      .update(reservations)
      .set({ status: "released", releasedAt })
      .where(eq(reservations.id, reservation.id));

    return {
      reservationId: reservation.id,
      status: "released" as const,
      reason: input.reason,
      postedBalance: account.postedBalance,
      reservedBalance,
      availableBalance: account.postedBalance - reservedBalance,
      releasedAt,
    };
  });
}

export async function expireReservations(limit = 100): Promise<number> {
  const candidates = await db
    .select({ id: reservations.id })
    .from(reservations)
    .where(and(eq(reservations.status, "reserved"), lte(reservations.expiresAt, new Date())))
    .limit(limit);

  let expired = 0;
  for (const candidate of candidates) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(reservations)
        .where(eq(reservations.id, candidate.id))
        .for("update")
        .limit(1);
      const reservation = rows[0];
      if (!reservation || reservation.status !== "reserved" || reservation.expiresAt > new Date()) {
        return;
      }
      const accounts = await tx
        .select()
        .from(creditAccounts)
        .where(eq(creditAccounts.id, reservation.creditAccountId))
        .for("update")
        .limit(1);
      const account = accounts[0];
      if (!account) throw new Error("Reservation references a missing Credit Account");
      const reservedBalance = account.reservedBalance - reservation.estimatedCredits;
      const now = new Date();
      await tx
        .update(creditAccounts)
        .set({ reservedBalance, updatedAt: now })
        .where(eq(creditAccounts.id, account.id));
      await tx
        .update(reservations)
        .set({ status: "expired", releasedAt: now })
        .where(eq(reservations.id, reservation.id));
      expired += 1;
    });
  }
  return expired;
}

function reservationResponse(
  reservation: typeof reservations.$inferSelect,
  postedBalance: bigint,
  reservedBalance: bigint,
) {
  return {
    reservationId: reservation.id,
    status: reservation.status,
    creditAccountId: reservation.creditAccountId,
    reservedCredits: reservation.estimatedCredits,
    postedBalance,
    reservedBalance,
    availableBalance: postedBalance - reservedBalance,
    defaultProviderId: null,
    expiresAt: reservation.expiresAt,
  };
}

function captureResponse(
  reservation: typeof reservations.$inferSelect,
  postedBalance: bigint,
  reservedBalance: bigint,
) {
  return {
    reservationId: reservation.id,
    status: reservation.status,
    reservedCredits: reservation.estimatedCredits,
    capturedCredits: reservation.capturedCredits,
    postedBalance,
    reservedBalance,
    availableBalance: postedBalance - reservedBalance,
    canReserve: postedBalance - reservedBalance > 0n,
    capturedAt: reservation.capturedAt,
  };
}

function releaseResponse(
  reservation: typeof reservations.$inferSelect,
  postedBalance: bigint,
  reservedBalance: bigint,
) {
  return {
    reservationId: reservation.id,
    status: reservation.status,
    postedBalance,
    reservedBalance,
    availableBalance: postedBalance - reservedBalance,
    releasedAt: reservation.releasedAt,
  };
}
