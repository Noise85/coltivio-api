CREATE TABLE "plot_journal_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"plot_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	"title" text NOT NULL,
	"date" date NOT NULL,
	"content" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plot_journal_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "plot_journal_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"journal_entry_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plot_journal_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "plot_journal_entries_plot_id_idx" ON "plot_journal_entries" ("plot_id");--> statement-breakpoint
CREATE INDEX "plot_journal_images_entry_id_idx" ON "plot_journal_images" ("journal_entry_id");--> statement-breakpoint
ALTER TABLE "plot_journal_entries" ADD CONSTRAINT "plot_journal_entries_plot_id_plots_id_fkey" FOREIGN KEY ("plot_id") REFERENCES "plots"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "plot_journal_entries" ADD CONSTRAINT "plot_journal_entries_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "plot_journal_entries" ADD CONSTRAINT "plot_journal_entries_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "only farm members" ON "plot_journal_entries" AS PERMISSIVE FOR ALL TO "authenticated" USING ("plot_journal_entries"."farm_id" = (select farm_id())) WITH CHECK ("plot_journal_entries"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "only farm members via journal entry" ON "plot_journal_images" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "plot_journal_entries" e
        WHERE e.id = "plot_journal_images"."journal_entry_id"
        AND e.farm_id = (SELECT farm_id())
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "plot_journal_entries" e
        WHERE e.id = "plot_journal_images"."journal_entry_id"
        AND e.farm_id = (SELECT farm_id())
      ));