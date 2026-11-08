ALTER TABLE "invoice_settings" DROP CONSTRAINT "invoice_settings_farm_id_key";--> statement-breakpoint
ALTER TABLE "invoice_settings" ADD COLUMN "name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_settings" ADD CONSTRAINT "invoice_settings_farm_name_unique" UNIQUE("farm_id","name");