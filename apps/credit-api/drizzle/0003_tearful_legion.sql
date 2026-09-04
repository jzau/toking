CREATE TABLE "ai_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"adapter" text DEFAULT 'openai-compatible' NOT NULL,
	"base_url" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_prefix" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_providers_adapter_check" CHECK ("ai_providers"."adapter" = 'openai-compatible')
);
--> statement-breakpoint
CREATE INDEX "ai_providers_enabled_idx" ON "ai_providers" USING btree ("enabled");