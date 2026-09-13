CREATE TABLE "integration_customer_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"external_user_id" text NOT NULL,
	"credit_account_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_customer_accounts" ADD CONSTRAINT "integration_customer_accounts_client_id_integration_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."integration_clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_customer_accounts" ADD CONSTRAINT "integration_customer_accounts_credit_account_id_credit_accounts_id_fk" FOREIGN KEY ("credit_account_id") REFERENCES "public"."credit_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_customer_accounts_client_user_unique" ON "integration_customer_accounts" USING btree ("client_id","external_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_customer_accounts_credit_account_unique" ON "integration_customer_accounts" USING btree ("credit_account_id");
