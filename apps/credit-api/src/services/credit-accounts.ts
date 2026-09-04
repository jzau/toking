import { and, eq } from "drizzle-orm";

import type { DbExecutor } from "../db/client.js";
import { creditAccounts, gatewayApiKeys } from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { generateSecret, sha256 } from "../lib/crypto.js";
import { newId } from "../lib/ids.js";
import { ensureWalletLedgerAccount } from "./ledger.js";

export async function createCreditAccount(
  executor: DbExecutor,
  input: { ownerType: "anonymous" | "user"; userId?: string },
): Promise<string> {
  if (input.ownerType === "user" && !input.userId) {
    throw new Error("A user-owned Credit Account requires a user ID");
  }

  if (input.ownerType === "user" && input.userId) {
    const existing = await executor
      .select({ id: creditAccounts.id })
      .from(creditAccounts)
      .where(
        and(
          eq(creditAccounts.ownerType, "user"),
          eq(creditAccounts.userId, input.userId),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id;
  }

  const id = newId();
  await executor.insert(creditAccounts).values({
    id,
    ownerType: input.ownerType,
    userId: input.userId,
  });
  await ensureWalletLedgerAccount(executor, id);
  return id;
}
export async function createGatewayApiKey(
  executor: DbExecutor,
  creditAccountId: string,
  name = "Default",
): Promise<{ id: string; rawKey: string; prefix: string }> {
  const secret = generateSecret("tk_live");
  const id = newId();

  await executor.insert(gatewayApiKeys).values({
    id,
    creditAccountId,
    name,
    keyPrefix: secret.visiblePrefix,
    keyHash: secret.hash,
  });

  return { id, rawKey: secret.raw, prefix: secret.visiblePrefix };
}

export async function resolveGatewayApiKey(executor: DbExecutor, rawKey: string) {
  const rows = await executor
    .select({
      apiKeyId: gatewayApiKeys.id,
      creditAccountId: gatewayApiKeys.creditAccountId,
      keyStatus: gatewayApiKeys.status,
      accountStatus: creditAccounts.status,
      postedBalance: creditAccounts.postedBalance,
      reservedBalance: creditAccounts.reservedBalance,
      defaultProviderId: creditAccounts.defaultProviderId,
    })
    .from(gatewayApiKeys)
    .innerJoin(creditAccounts, eq(gatewayApiKeys.creditAccountId, creditAccounts.id))
    .where(eq(gatewayApiKeys.keyHash, sha256(rawKey)))
    .limit(1);

  const resolved = rows[0];
  if (!resolved || resolved.keyStatus !== "active") {
    throw new AppError(401, "invalid_gateway_api_key", "Invalid Toking API key");
  }
  if (resolved.accountStatus !== "active") {
    throw new AppError(403, "credit_account_suspended", "Credit Account is suspended");
  }
  return resolved;
}
