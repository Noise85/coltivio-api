CREATE TABLE "invoice_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL UNIQUE,
	"sender_name" text DEFAULT '' NOT NULL,
	"street" text DEFAULT '' NOT NULL,
	"zip" text DEFAULT '' NOT NULL,
	"city" text DEFAULT '' NOT NULL,
	"phone" text,
	"email" text,
	"website" text,
	"iban" text,
	"bank_name" text,
	"payment_terms_days" integer DEFAULT 30 NOT NULL,
	"intro_text" text,
	"closing_text" text,
	"logo_data" bytea,
	"logo_mime_type" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoice_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_settings" ADD CONSTRAINT "invoice_settings_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "invoice_settings" AS PERMISSIVE FOR ALL TO "authenticated" USING ("invoice_settings"."farm_id" = (select farm_id())) WITH CHECK ("invoice_settings"."farm_id" = (select farm_id()));