CREATE TABLE "animal_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"animal_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"content" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "animal_journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "animal_journal_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"journal_entry_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "animal_journal_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "animal_journal_entries_animal_id_idx" ON "animal_journal_entries" ("animal_id");--> statement-breakpoint
CREATE INDEX "animal_journal_images_entry_id_idx" ON "animal_journal_images" ("journal_entry_id");--> statement-breakpoint
ALTER TABLE "animal_journal_entries" ADD CONSTRAINT "animal_journal_entries_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_journal_entries" ADD CONSTRAINT "animal_journal_entries_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_journal_entries" ADD CONSTRAINT "animal_journal_entries_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "only farm members" ON "animal_journal_entries" AS PERMISSIVE FOR ALL TO "authenticated" USING ("animal_journal_entries"."farm_id" = (select farm_id())) WITH CHECK ("animal_journal_entries"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members via journal entry" ON "animal_journal_images" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "animal_journal_entries" e
        WHERE e.id = "animal_journal_images"."journal_entry_id"
        AND e.farm_id = (SELECT farm_id())
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "animal_journal_entries" e
        WHERE e.id = "animal_journal_images"."journal_entry_id"
        AND e.farm_id = (SELECT farm_id())
      ));