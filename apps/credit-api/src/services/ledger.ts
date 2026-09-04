import { eq } from "drizzle-orm";

import type { DbExecutor } from "../db/client.js";
import {
  ledgerAccounts,
  ledgerEntries,
  ledgerJournals,
} from "../db/schema.js";
import { AppError } from "../lib/errors.js";
import { newId } from "../lib/ids.js";

export const SYSTEM_ACCOUNTS = {
  giftCardClearing: "system:gift-card-clearing",
  aiConsumptionClearing: "system:ai-consumption-clearing",
  adminAdjustmentClearing: "system:admin-adjustment-clearing",
} as const;

export interface JournalEntryInput {
  ledgerAccountId: string;
  amount: bigint;
}
export async function ensureSystemLedgerAccount(
  executor: DbExecutor,
  code: string,
  name: string,
): Promise<string> {
  const existing = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, code))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const id = newId();
  await executor
    .insert(ledgerAccounts)
    .values({ id, code, name, kind: "system" })
    .onConflictDoNothing({ target: ledgerAccounts.code });

  const created = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.code, code))
    .limit(1);

  if (!created[0]) throw new Error(`Unable to create ledger account ${code}`);
  return created[0].id;
}

export async function ensureWalletLedgerAccount(
  executor: DbExecutor,
  creditAccountId: string,
): Promise<string> {
  const existing = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.creditAccountId, creditAccountId))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const id = newId();
  await executor
    .insert(ledgerAccounts)
    .values({
      id,
      code: `wallet:${creditAccountId}`,
      name: `Credit Account ${creditAccountId}`,
      kind: "wallet",
      creditAccountId,
    })
    .onConflictDoNothing({ target: ledgerAccounts.code });

  const created = await executor
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(eq(ledgerAccounts.creditAccountId, creditAccountId))
    .limit(1);

  if (!created[0]) throw new Error("Unable to create wallet ledger account");
  return created[0].id;
}

export async function postJournal(
  executor: DbExecutor,
  input: {
    type: string;
    sourceReference: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
    entries: JournalEntryInput[];
  },
): Promise<string> {
  if (input.entries.length < 2) {
    throw new AppError(500, "unbalanced_journal", "A journal requires at least two entries");
  }

  const total = input.entries.reduce((sum, entry) => sum + entry.amount, 0n);
  if (total !== 0n) {
    throw new AppError(500, "unbalanced_journal", "Journal entries must sum to zero");
  }

  if (input.entries.some((entry) => entry.amount === 0n)) {
    throw new AppError(500, "zero_ledger_entry", "Ledger entries cannot be zero");
  }

  const existing = await executor
    .select({ id: ledgerJournals.id })
    .from(ledgerJournals)
    .where(eq(ledgerJournals.idempotencyKey, input.idempotencyKey))
    .limit(1);

  if (existing[0]) return existing[0].id;

  const journalId = newId();
  await executor.insert(ledgerJournals).values({
    id: journalId,
    type: input.type,
    sourceReference: input.sourceReference,
    idempotencyKey: input.idempotencyKey,
    metadata: input.metadata ?? {},
  });

  await executor.insert(ledgerEntries).values(
    input.entries.map((entry) => ({
      id: newId(),
      journalId,
      ledgerAccountId: entry.ledgerAccountId,
      amount: entry.amount,
    })),
  );

  return journalId;
}
