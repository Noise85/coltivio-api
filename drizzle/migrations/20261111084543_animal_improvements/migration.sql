CREATE TABLE "animal_heats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"mated" boolean DEFAULT false NOT NULL,
	"sire_id" uuid,
	"sire_name" text,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "animal_heats" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "animal_weights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"date" date NOT NULL,
	"weight_kg" real NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "animal_weights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "breeding_reminder_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"heat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reminder_date" date NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "breeding_reminder_notifications_heat_id_user_id_reminder_date_unique" UNIQUE("heat_id","user_id","reminder_date")
);
--> statement-breakpoint
ALTER TABLE "breeding_reminder_notifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "farm_gestation_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"animal_type" "animal_type" NOT NULL,
	"gestation_days" integer NOT NULL,
	CONSTRAINT "farm_gestation_settings_farm_type_unique" UNIQUE("farm_id","animal_type")
);
--> statement-breakpoint
ALTER TABLE "farm_gestation_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "animal_treatments" ADD COLUMN "animal_weight_kg" real;--> statement-breakpoint
ALTER TABLE "animal_treatments" ADD COLUMN "effective_dose_value" real;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "breeding_reminder_days_before1" integer;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "breeding_reminder_days_before2" integer;--> statement-breakpoint
ALTER TABLE "ear_tags" ADD CONSTRAINT "ear_tags_farm_id_number_unique" UNIQUE("farm_id","number");--> statement-breakpoint
CREATE INDEX "animal_heats_animal_id_idx" ON "animal_heats" ("animal_id");--> statement-breakpoint
CREATE INDEX "animal_heats_farm_id_date_idx" ON "animal_heats" ("farm_id","date");--> statement-breakpoint
CREATE INDEX "animal_weights_animal_id_date_idx" ON "animal_weights" ("animal_id","date");--> statement-breakpoint
ALTER TABLE "animal_heats" ADD CONSTRAINT "animal_heats_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_heats" ADD CONSTRAINT "animal_heats_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_heats" ADD CONSTRAINT "animal_heats_sire_id_animals_id_fkey" FOREIGN KEY ("sire_id") REFERENCES "animals"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "animal_heats" ADD CONSTRAINT "animal_heats_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "animal_weights" ADD CONSTRAINT "animal_weights_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_weights" ADD CONSTRAINT "animal_weights_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_weights" ADD CONSTRAINT "animal_weights_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "breeding_reminder_notifications" ADD CONSTRAINT "breeding_reminder_notifications_heat_id_animal_heats_id_fkey" FOREIGN KEY ("heat_id") REFERENCES "animal_heats"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "breeding_reminder_notifications" ADD CONSTRAINT "breeding_reminder_notifications_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "farm_gestation_settings" ADD CONSTRAINT "farm_gestation_settings_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "animal_heats" AS PERMISSIVE FOR ALL TO "authenticated" USING ("animal_heats"."farm_id" = (select farm_id())) WITH CHECK ("animal_heats"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "animal_weights" AS PERMISSIVE FOR ALL TO "authenticated" USING ("animal_weights"."farm_id" = (select farm_id())) WITH CHECK ("animal_weights"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members" ON "farm_gestation_settings" AS PERMISSIVE FOR ALL TO "authenticated" USING ("farm_gestation_settings"."farm_id" = (select farm_id())) WITH CHECK ("farm_gestation_settings"."farm_id" = (select farm_id()));