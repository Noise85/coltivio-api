CREATE TABLE "custom_outdoor_journal_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"category" "animal_category" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_outdoor_journal_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY "any user can create a new farm" ON "farms";--> statement-breakpoint
ALTER TABLE "animals" DROP COLUMN "requires_category_override";--> statement-breakpoint
ALTER TABLE "animals" DROP COLUMN "category_override";--> statement-breakpoint
CREATE INDEX "custom_outdoor_journal_categories_animal_id_idx" ON "custom_outdoor_journal_categories" ("animal_id");--> statement-breakpoint
ALTER TABLE "custom_outdoor_journal_categories" ADD CONSTRAINT "custom_outdoor_journal_categories_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "custom_outdoor_journal_categories" ADD CONSTRAINT "custom_outdoor_journal_categories_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members" ON "custom_outdoor_journal_categories" AS PERMISSIVE FOR ALL TO "authenticated" USING ("custom_outdoor_journal_categories"."farm_id" = farm_id()) WITH CHECK ("custom_outdoor_journal_categories"."farm_id" = farm_id());