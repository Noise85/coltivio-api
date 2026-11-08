DROP POLICY "authenticated users can create wiki entries" ON "wiki_entries";--> statement-breakpoint
DROP POLICY "creator can update own wiki entries" ON "wiki_entries";--> statement-breakpoint
DROP POLICY "creator can delete own private wiki entries" ON "wiki_entries";--> statement-breakpoint
ALTER TABLE "wiki_entries" ALTER COLUMN "farm_id" SET NOT NULL;--> statement-breakpoint
CREATE POLICY "farm members can create wiki entries" ON "wiki_entries" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("wiki_entries"."created_by" = (SELECT auth.uid()) AND "wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid));--> statement-breakpoint
CREATE POLICY "farm members can update private wiki entries" ON "wiki_entries" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND "wiki_entries"."visibility" = 'private'::wiki_visibility) WITH CHECK ("wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND "wiki_entries"."visibility" = 'private'::wiki_visibility);--> statement-breakpoint
CREATE POLICY "farm members can delete private wiki entries" ON "wiki_entries" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND "wiki_entries"."visibility" = 'private'::wiki_visibility);--> statement-breakpoint
ALTER POLICY "authenticated users can read wiki entries" ON "wiki_entries" TO "authenticated" USING (("wiki_entries"."status" = 'published'::wiki_entry_status AND "wiki_entries"."visibility" = 'public'::wiki_visibility) OR "wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid));--> statement-breakpoint
ALTER POLICY "follow entry access for images" ON "wiki_entry_images" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_images"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_images"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      ) WITH CHECK (EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_images"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid)));--> statement-breakpoint
ALTER POLICY "follow entry access for entry tags" ON "wiki_entry_tags" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_tags"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_tags"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      ) WITH CHECK (EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_tags"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid)));--> statement-breakpoint
ALTER POLICY "follow entry access for translations" ON "wiki_entry_translations" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_translations"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_translations"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      ) WITH CHECK (EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_translations"."entry_id" AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid)));