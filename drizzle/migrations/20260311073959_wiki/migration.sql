CREATE TYPE "wiki_change_request_status" AS ENUM('draft', 'under_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "wiki_change_request_type" AS ENUM('new_entry', 'change_request');--> statement-breakpoint
CREATE TYPE "wiki_entry_status" AS ENUM('draft', 'submitted', 'under_review', 'published', 'rejected');--> statement-breakpoint
CREATE TYPE "wiki_locale" AS ENUM('de', 'en', 'it', 'fr');--> statement-breakpoint
CREATE TYPE "wiki_visibility" AS ENUM('private', 'public');--> statement-breakpoint
CREATE TABLE "wiki_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"slug" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_categories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_category_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"category_id" uuid NOT NULL,
	"locale" "wiki_locale" NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "wiki_category_translations_unique" UNIQUE("category_id","locale")
);
--> statement-breakpoint
ALTER TABLE "wiki_category_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_change_request_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"change_request_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_change_request_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_change_request_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"change_request_id" uuid NOT NULL,
	"locale" "wiki_locale" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	CONSTRAINT "wiki_cr_translations_unique" UNIQUE("change_request_id","locale")
);
--> statement-breakpoint
ALTER TABLE "wiki_change_request_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entry_id" uuid,
	"type" "wiki_change_request_type" NOT NULL,
	"status" "wiki_change_request_status" DEFAULT 'draft'::"wiki_change_request_status" NOT NULL,
	"submitted_by" uuid NOT NULL,
	"proposed_category_id" uuid,
	"proposed_farm_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"status" "wiki_entry_status" DEFAULT 'draft'::"wiki_entry_status" NOT NULL,
	"visibility" "wiki_visibility" DEFAULT 'private'::"wiki_visibility" NOT NULL,
	"created_by" uuid NOT NULL,
	"farm_id" uuid,
	"category_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_entry_images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entry_id" uuid NOT NULL,
	"storage_path" text NOT NULL,
	"alt_text" text,
	"uploaded_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_entry_images" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_entry_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entry_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "wiki_entry_tags_unique" UNIQUE("entry_id","tag_id")
);
--> statement-breakpoint
ALTER TABLE "wiki_entry_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_entry_translations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"entry_id" uuid NOT NULL,
	"locale" "wiki_locale" NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wiki_entry_translations_entry_locale_unique" UNIQUE("entry_id","locale")
);
--> statement-breakpoint
ALTER TABLE "wiki_entry_translations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_moderators" (
	"user_id" uuid PRIMARY KEY,
	"granted_by" uuid,
	"granted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_moderators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "wiki_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL UNIQUE,
	"slug" text NOT NULL UNIQUE,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "wiki_category_translations_category_id_idx" ON "wiki_category_translations" ("category_id");--> statement-breakpoint
CREATE INDEX "wiki_cr_notes_cr_id_idx" ON "wiki_change_request_notes" ("change_request_id");--> statement-breakpoint
CREATE INDEX "wiki_cr_translations_cr_id_idx" ON "wiki_change_request_translations" ("change_request_id");--> statement-breakpoint
CREATE INDEX "wiki_change_requests_entry_id_idx" ON "wiki_change_requests" ("entry_id");--> statement-breakpoint
CREATE INDEX "wiki_change_requests_status_idx" ON "wiki_change_requests" ("status");--> statement-breakpoint
CREATE INDEX "wiki_entries_status_visibility_idx" ON "wiki_entries" ("status","visibility");--> statement-breakpoint
CREATE INDEX "wiki_entry_images_entry_id_idx" ON "wiki_entry_images" ("entry_id");--> statement-breakpoint
CREATE INDEX "wiki_entry_translations_entry_id_idx" ON "wiki_entry_translations" ("entry_id");--> statement-breakpoint
ALTER TABLE "wiki_category_translations" ADD CONSTRAINT "wiki_category_translations_category_id_wiki_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "wiki_categories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_change_request_notes" ADD CONSTRAINT "wiki_change_request_notes_QBVGKjGMCvHF_fkey" FOREIGN KEY ("change_request_id") REFERENCES "wiki_change_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_change_request_notes" ADD CONSTRAINT "wiki_change_request_notes_author_id_profiles_id_fkey" FOREIGN KEY ("author_id") REFERENCES "profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "wiki_change_request_translations" ADD CONSTRAINT "wiki_change_request_translations_dTw3DZCcHpva_fkey" FOREIGN KEY ("change_request_id") REFERENCES "wiki_change_requests"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ADD CONSTRAINT "wiki_change_requests_entry_id_wiki_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "wiki_entries"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ADD CONSTRAINT "wiki_change_requests_submitted_by_profiles_id_fkey" FOREIGN KEY ("submitted_by") REFERENCES "profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ADD CONSTRAINT "wiki_change_requests_h0iEEVu09dfg_fkey" FOREIGN KEY ("proposed_category_id") REFERENCES "wiki_categories"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ADD CONSTRAINT "wiki_change_requests_proposed_farm_id_farms_id_fkey" FOREIGN KEY ("proposed_farm_id") REFERENCES "farms"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_entries" ADD CONSTRAINT "wiki_entries_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "wiki_entries" ADD CONSTRAINT "wiki_entries_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_entries" ADD CONSTRAINT "wiki_entries_category_id_wiki_categories_id_fkey" FOREIGN KEY ("category_id") REFERENCES "wiki_categories"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "wiki_entry_images" ADD CONSTRAINT "wiki_entry_images_uploaded_by_profiles_id_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_entry_tags" ADD CONSTRAINT "wiki_entry_tags_entry_id_wiki_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "wiki_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_entry_tags" ADD CONSTRAINT "wiki_entry_tags_tag_id_wiki_tags_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "wiki_tags"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_entry_translations" ADD CONSTRAINT "wiki_entry_translations_entry_id_wiki_entries_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "wiki_entries"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_entry_translations" ADD CONSTRAINT "wiki_entry_translations_updated_by_profiles_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_moderators" ADD CONSTRAINT "wiki_moderators_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "wiki_moderators" ADD CONSTRAINT "wiki_moderators_granted_by_profiles_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_tags" ADD CONSTRAINT "wiki_tags_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "authenticated users can read wiki categories" ON "wiki_categories" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can read wiki category translations" ON "wiki_category_translations" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "submitter can read and write notes on own change requests" ON "wiki_change_request_notes" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "wiki_change_requests" wcr
        WHERE wcr.id = "wiki_change_request_notes"."change_request_id"
        AND wcr.submitted_by = auth.uid()
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "wiki_change_requests" wcr
        WHERE wcr.id = "wiki_change_request_notes"."change_request_id"
        AND wcr.submitted_by = auth.uid()
      ) AND "wiki_change_request_notes"."author_id" = auth.uid());--> statement-breakpoint
CREATE POLICY "follow change request access for cr translations" ON "wiki_change_request_translations" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "wiki_change_requests" wcr
        WHERE wcr.id = "wiki_change_request_translations"."change_request_id"
        AND wcr.submitted_by = auth.uid()
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "wiki_change_requests" wcr
        WHERE wcr.id = "wiki_change_request_translations"."change_request_id"
        AND wcr.submitted_by = auth.uid()
      ));--> statement-breakpoint
CREATE POLICY "submitter can read own change requests" ON "wiki_change_requests" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("wiki_change_requests"."submitted_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "authenticated can create change requests" ON "wiki_change_requests" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("wiki_change_requests"."submitted_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "submitter can update own draft change requests" ON "wiki_change_requests" AS PERMISSIVE FOR UPDATE TO "authenticated" USING (("wiki_change_requests"."submitted_by" = (select auth.uid()) and "wiki_change_requests"."status" = 'draft'::wiki_change_request_status)) WITH CHECK ("wiki_change_requests"."submitted_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "authenticated users can read wiki entries" ON "wiki_entries" AS PERMISSIVE FOR SELECT TO "authenticated" USING (("wiki_entries"."status" = 'published'::wiki_entry_status AND "wiki_entries"."visibility" = 'public'::wiki_visibility) OR "wiki_entries"."created_by" = auth.uid() OR ("wiki_entries"."farm_id" IS NOT NULL AND "wiki_entries"."farm_id" = current_setting('request.farm_id', TRUE)::uuid));--> statement-breakpoint
CREATE POLICY "authenticated users can create wiki entries" ON "wiki_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("wiki_entries"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can update own wiki entries" ON "wiki_entries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("wiki_entries"."created_by" = (select auth.uid())) WITH CHECK ("wiki_entries"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can delete own private wiki entries" ON "wiki_entries" AS PERMISSIVE FOR DELETE TO "authenticated" USING (("wiki_entries"."created_by" = (select auth.uid()) and "wiki_entries"."visibility" = 'private'::wiki_visibility));--> statement-breakpoint
CREATE POLICY "follow entry access for images" ON "wiki_entry_images" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_images"."entry_id"
        AND (
          (we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
          OR we.created_by = auth.uid()
          OR (we.farm_id IS NOT NULL AND we.farm_id = current_setting('request.farm_id', TRUE)::uuid)
        )
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_images"."entry_id"
        AND we.created_by = auth.uid()
      ));--> statement-breakpoint
CREATE POLICY "follow entry access for entry tags" ON "wiki_entry_tags" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_tags"."entry_id"
        AND (
          (we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
          OR we.created_by = auth.uid()
          OR (we.farm_id IS NOT NULL AND we.farm_id = current_setting('request.farm_id', TRUE)::uuid)
        )
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_tags"."entry_id"
        AND we.created_by = auth.uid()
      ));--> statement-breakpoint
CREATE POLICY "follow entry access for translations" ON "wiki_entry_translations" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_translations"."entry_id"
        AND (
          (we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
          OR we.created_by = auth.uid()
          OR (we.farm_id IS NOT NULL AND we.farm_id = current_setting('request.farm_id', TRUE)::uuid)
        )
      )) WITH CHECK (EXISTS (
        SELECT 1 FROM "wiki_entries" we
        WHERE we.id = "wiki_entry_translations"."entry_id"
        AND we.created_by = auth.uid()
      ));--> statement-breakpoint
CREATE POLICY "authenticated users can read wiki moderators" ON "wiki_moderators" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can read wiki tags" ON "wiki_tags" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can create wiki tags" ON "wiki_tags" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (true);