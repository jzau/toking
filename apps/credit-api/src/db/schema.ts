import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

export const userStatus = pgEnum("user_status", ["active", "suspended"]);
export const creditAccountOwnerType = pgEnum("credit_account_owner_type", [
  "anonymous",
  "user",
]);
export const creditAccountStatus = pgEnum("credit_account_status", [
  "active",
  "suspended",
]);
export const ledgerAccountKind = pgEnum("ledger_account_kind", ["system", "wallet"]);
export const giftCardBatchStatus = pgEnum("gift_card_batch_status", [
  "active",
  "disabled",
]);
export const giftCardStatus = pgEnum("gift_card_status", [
  "active",
  "redeemed",
  "disabled",
]);
export const clientStatus = pgEnum("integration_client_status", ["active", "disabled"]);
export const credentialStatus = pgEnum("credential_status", ["active", "revoked"]);
export const reservationStatus = pgEnum("reservation_status", [
  "reserved",
  "captured",
  "released",
  "expired",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    phoneE164: text("phone_e164").notNull(),
    phoneVerifiedAt: timestamp("phone_verified_at", { withTimezone: true }).notNull(),
    status: userStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("users_phone_e164_unique").on(table.phoneE164)],
);

export const creditAccounts = pgTable(
  "credit_accounts",
  {
    id: uuid("id").primaryKey(),
    ownerType: creditAccountOwnerType("owner_type").notNull(),
    userId: uuid("user_id").references(() => users.id),
    postedBalance: bigint("posted_balance", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    reservedBalance: bigint("reserved_balance", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    defaultProviderId: text("default_provider_id"),
    status: creditAccountStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("credit_accounts_user_id_unique")
      .on(table.userId)
      .where(sql`${table.ownerType} = 'user'`),
    index("credit_accounts_status_idx").on(table.status),
    check(
      "credit_accounts_owner_check",
      sql`(${table.ownerType} = 'user' AND ${table.userId} IS NOT NULL) OR (${table.ownerType} = 'anonymous' AND ${table.userId} IS NULL)`,
    ),
    check("credit_accounts_reserved_nonnegative", sql`${table.reservedBalance} >= 0`),
  ],
);

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: uuid("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: ledgerAccountKind("kind").notNull(),
    creditAccountId: uuid("credit_account_id").references(() => creditAccounts.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_accounts_code_unique").on(table.code),
    uniqueIndex("ledger_accounts_credit_account_unique")
      .on(table.creditAccountId)
      .where(sql`${table.kind} = 'wallet'`),
  ],
);

export const ledgerJournals = pgTable(
  "ledger_journals",
  {
    id: uuid("id").primaryKey(),
    type: text("type").notNull(),
    sourceReference: text("source_reference").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ledger_journals_idempotency_unique").on(table.idempotencyKey),
    index("ledger_journals_source_reference_idx").on(table.sourceReference),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: uuid("id").primaryKey(),
    journalId: uuid("journal_id")
      .notNull()
      .references(() => ledgerJournals.id),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    amount: bigint("amount", { mode: "bigint" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("ledger_entries_journal_idx").on(table.journalId),
    index("ledger_entries_account_idx").on(table.ledgerAccountId),
    check("ledger_entries_amount_nonzero", sql`${table.amount} <> 0`),
  ],
);

export const integrationClients = pgTable(
  "integration_clients",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    status: clientStatus("status").notNull().default("active"),
    ...timestamps,
  },
  (table) => [uniqueIndex("integration_clients_name_unique").on(table.name)],
);

export const clientApiKeys = pgTable(
  "client_api_keys",
  {
    id: uuid("id").primaryKey(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => integrationClients.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    status: credentialStatus("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("client_api_keys_hash_unique").on(table.keyHash),
    index("client_api_keys_client_idx").on(table.clientId),
  ],
);

export const gatewayApiKeys = pgTable(
  "gateway_api_keys",
  {
    id: uuid("id").primaryKey(),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references(() => creditAccounts.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    status: credentialStatus("status").notNull().default("active"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("gateway_api_keys_hash_unique").on(table.keyHash),
    index("gateway_api_keys_credit_account_idx").on(table.creditAccountId),
  ],
);

export const giftCardBatches = pgTable("gift_card_batches", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  status: giftCardBatchStatus("status").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  ...timestamps,
});

export const giftCards = pgTable(
  "gift_cards",
  {
    id: uuid("id").primaryKey(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => giftCardBatches.id),
    codePrefix: text("code_prefix").notNull(),
    codeHash: text("code_hash").notNull(),
    creditAmount: bigint("credit_amount", { mode: "bigint" }).notNull(),
    status: giftCardStatus("status").notNull().default("active"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    redeemedCreditAccountId: uuid("redeemed_credit_account_id").references(
      () => creditAccounts.id,
    ),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gift_cards_code_hash_unique").on(table.codeHash),
    index("gift_cards_batch_idx").on(table.batchId),
    index("gift_cards_status_idx").on(table.status),
    check("gift_cards_credit_amount_positive", sql`${table.creditAmount} > 0`),
  ],
);

export const giftCardRedemptions = pgTable(
  "gift_card_redemptions",
  {
    id: uuid("id").primaryKey(),
    giftCardId: uuid("gift_card_id")
      .notNull()
      .references(() => giftCards.id),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references(() => creditAccounts.id),
    clientId: uuid("client_id").references(() => integrationClients.id),
    ledgerJournalId: uuid("ledger_journal_id")
      .notNull()
      .references(() => ledgerJournals.id),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gift_card_redemptions_card_unique").on(table.giftCardId),
    index("gift_card_redemptions_account_idx").on(table.creditAccountId),
  ],
);

export const otpChallenges = pgTable(
  "otp_challenges",
  {
    id: uuid("id").primaryKey(),
    phoneE164: text("phone_e164").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("otp_challenges_phone_idx").on(table.phoneE164),
    check("otp_challenges_attempts_range", sql`${table.attempts} >= 0 AND ${table.attempts} <= 5`),
  ],
);

export const userSessions = pgTable(
  "user_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("user_sessions_token_hash_unique").on(table.tokenHash),
    index("user_sessions_user_idx").on(table.userId),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey(),
    creditAccountId: uuid("credit_account_id")
      .notNull()
      .references(() => creditAccounts.id),
    gatewayApiKeyId: uuid("gateway_api_key_id")
      .notNull()
      .references(() => gatewayApiKeys.id),
    gatewayRequestId: text("gateway_request_id").notNull(),
    estimatedCredits: bigint("estimated_credits", { mode: "bigint" }).notNull(),
    capturedCredits: bigint("captured_credits", { mode: "bigint" }),
    status: reservationStatus("status").notNull().default("reserved"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("reservations_gateway_request_unique").on(table.gatewayRequestId),
    index("reservations_account_status_idx").on(table.creditAccountId, table.status),
    index("reservations_expiry_idx").on(table.status, table.expiresAt),
    check("reservations_estimated_positive", sql`${table.estimatedCredits} > 0`),
    check(
      "reservations_captured_positive",
      sql`${table.capturedCredits} IS NULL OR ${table.capturedCredits} > 0`,
    ),
  ],
);

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: uuid("id").primaryKey(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseBody: jsonb("response_body").$type<Record<string, unknown>>(),
    completed: boolean("completed").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idempotency_scope_key_unique").on(table.scope, table.key)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_events_target_idx").on(table.targetType, table.targetId)],
);
