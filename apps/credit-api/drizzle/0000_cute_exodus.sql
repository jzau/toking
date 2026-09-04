CREATE TYPE "public"."integration_client_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credit_account_owner_type" AS ENUM('anonymous', 'user');--> statement-breakpoint
CREATE TYPE "public"."credit_account_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."gift_card_batch_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."gift_card_status" AS ENUM('active', 'redeemed', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."ledger_account_kind" AS ENUM('system', 'wallet');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'captured', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'suspended');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "client_api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "credit_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_type" "credit_account_owner_type" NOT NULL,
	"user_id" uuid,
	"posted_balance" bigint DEFAULT 0 NOT NULL,
	"reserved_balance" bigint DEFAULT 0 NOT NULL,
	"default_provider_id" text,
	"status" "credit_account_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gateway_api_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "gift_card_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "gift_card_batch_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_card_redemptions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"gift_card_id" uuid NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"client_id" uuid,
	"ledger_journal_id" uuid NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_cards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"code_prefix" text NOT NULL,
	"code_hash" text NOT NULL,
	"credit_amount" bigint NOT NULL,
	"status" "gift_card_status" DEFAULT 'active' NOT NULL,
	"expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_credit_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"completed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_clients" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"status" "integration_client_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "ledger_account_kind" NOT NULL,
	"credit_account_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"ledger_account_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_journals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"source_reference" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"gateway_api_key_id" uuid NOT NULL,
	"gateway_request_id" text NOT NULL,
	"estimated_credits" bigint NOT NULL,
	"captured_credits" bigint,
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"captured_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" text NOT NULL,
	"phone_verified_at" timestamp with time zone NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "client_api_keys" ADD CONSTRAINT "client_api_keys_client_id_integration_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."integration_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_api_keys" ADD CONSTRAINT "gateway_api_keys_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_gift_card_id_gift_cards_id_fk" FOREIGN KEY ("gift_card_id") REFERENCES "public"."gift_cards"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_client_id_integration_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."integration_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_card_redemptions" ADD CONSTRAINT "gift_card_redemptions_ledger_journal_id_ledger_journals_id_fk" FOREIGN KEY ("ledger_journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_batch_id_gift_card_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."gift_card_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_cards" ADD CONSTRAINT "gift_cards_redeemed_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("redeemed_credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_accounts" ADD CONSTRAINT "ledger_accounts_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_journal_id_ledger_journals_id_fk" FOREIGN KEY ("journal_id") REFERENCES "public"."ledger_journals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_ledger_account_id_ledger_accounts_id_fk" FOREIGN KEY ("ledger_account_id") REFERENCES "public"."ledger_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_gateway_api_key_id_gateway_api_keys_id_fk" FOREIGN KEY ("gateway_api_key_id") REFERENCES "public"."gateway_api_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "client_api_keys_hash_unique" ON "client_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "client_api_keys_client_idx" ON "client_api_keys" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_accounts_user_id_unique" ON "credit_accounts" USING btree ("user_id") WHERE "credit_accounts"."owner_type" = 'user';--> statement-breakpoint
CREATE INDEX "credit_accounts_status_idx" ON "credit_accounts" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_api_keys_hash_unique" ON "gateway_api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "gateway_api_keys_credit_account_idx" ON "gateway_api_keys" USING btree ("credit_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_card_redemptions_card_unique" ON "gift_card_redemptions" USING btree ("gift_card_id");--> statement-breakpoint
CREATE INDEX "gift_card_redemptions_account_idx" ON "gift_card_redemptions" USING btree ("credit_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gift_cards_code_hash_unique" ON "gift_cards" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "gift_cards_batch_idx" ON "gift_cards" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "gift_cards_status_idx" ON "gift_cards" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_scope_key_unique" ON "idempotency_records" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_clients_name_unique" ON "integration_clients" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_code_unique" ON "ledger_accounts" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_accounts_credit_account_unique" ON "ledger_accounts" USING btree ("credit_account_id") WHERE "ledger_accounts"."kind" = 'wallet';--> statement-breakpoint
CREATE INDEX "ledger_entries_journal_idx" ON "ledger_entries" USING btree ("journal_id");--> statement-breakpoint
CREATE INDEX "ledger_entries_account_idx" ON "ledger_entries" USING btree ("ledger_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_journals_idempotency_unique" ON "ledger_journals" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "ledger_journals_source_reference_idx" ON "ledger_journals" USING btree ("source_reference");--> statement-breakpoint
CREATE INDEX "otp_challenges_phone_idx" ON "otp_challenges" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "reservations_gateway_request_unique" ON "reservations" USING btree ("gateway_request_id");--> statement-breakpoint
CREATE INDEX "reservations_account_status_idx" ON "reservations" USING btree ("credit_account_id","status");--> statement-breakpoint
CREATE INDEX "reservations_expiry_idx" ON "reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_sessions_token_hash_unique" ON "user_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_phone_e164_unique" ON "users" USING btree ("phone_e164");