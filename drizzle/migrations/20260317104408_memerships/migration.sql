CREATE TYPE "donation_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "forum_thread_status" AS ENUM('open', 'closed');--> statement-breakpoint
CREATE TYPE "forum_thread_type" AS ENUM('question', 'feature_request', 'bug_report', 'general');--> statement-breakpoint
CREATE TYPE "membership_payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TABLE "donations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"email" text NOT NULL,
	"stripe_payment_id" text NOT NULL UNIQUE,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'chf' NOT NULL,
	"status" "donation_status" DEFAULT 'pending'::"donation_status" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forum_moderators" (
	"user_id" uuid PRIMARY KEY,
	"granted_by" uuid,
	"granted_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forum_moderators" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forum_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"thread_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forum_replies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "forum_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"type" "forum_thread_type" DEFAULT 'general'::"forum_thread_type" NOT NULL,
	"status" "forum_thread_status" DEFAULT 'open'::"forum_thread_status" NOT NULL,
	"is_pinned" boolean DEFAULT false NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "forum_threads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "handoff_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token" text NOT NULL UNIQUE,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "handoff_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "membership_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"stripe_payment_id" text NOT NULL UNIQUE,
	"stripe_subscription_id" text,
	"amount" integer NOT NULL,
	"currency" text DEFAULT 'chf' NOT NULL,
	"status" "membership_payment_status" DEFAULT 'pending'::"membership_payment_status" NOT NULL,
	"period_end" timestamp NOT NULL,
	"card_last4" text,
	"card_brand" text,
	"card_exp_month" integer,
	"card_exp_year" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "membership_payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL UNIQUE,
	"stripe_subscription_id" text NOT NULL UNIQUE,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "user_trials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL UNIQUE,
	"ends_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_trials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
CREATE INDEX "forum_replies_thread_id_idx" ON "forum_replies" ("thread_id");--> statement-breakpoint
CREATE INDEX "forum_threads_status_idx" ON "forum_threads" ("status");--> statement-breakpoint
CREATE INDEX "forum_threads_type_idx" ON "forum_threads" ("type");--> statement-breakpoint
ALTER TABLE "donations" ADD CONSTRAINT "donations_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "forum_moderators" ADD CONSTRAINT "forum_moderators_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forum_moderators" ADD CONSTRAINT "forum_moderators_granted_by_profiles_id_fkey" FOREIGN KEY ("granted_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_thread_id_forum_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forum_replies" ADD CONSTRAINT "forum_replies_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "forum_threads" ADD CONSTRAINT "forum_threads_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "handoff_tokens" ADD CONSTRAINT "handoff_tokens_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "membership_payments" ADD CONSTRAINT "membership_payments_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_subscriptions" ADD CONSTRAINT "user_subscriptions_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_trials" ADD CONSTRAINT "user_trials_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE VIEW "profile_names" AS (SELECT id, full_name FROM profiles);--> statement-breakpoint
GRANT SELECT ON "profile_names" TO authenticated;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "locale" text DEFAULT 'de' NOT NULL;--> statement-breakpoint
CREATE POLICY "authenticated users can read forum moderators" ON "forum_moderators" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can read forum replies" ON "forum_replies" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can create forum replies" ON "forum_replies" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("forum_replies"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can update own forum replies" ON "forum_replies" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("forum_replies"."created_by" = (select auth.uid())) WITH CHECK ("forum_replies"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can delete own forum replies" ON "forum_replies" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("forum_replies"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "authenticated users can read forum threads" ON "forum_threads" AS PERMISSIVE FOR SELECT TO "authenticated" USING (true);--> statement-breakpoint
CREATE POLICY "authenticated users can create forum threads" ON "forum_threads" AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK ("forum_threads"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can update own forum threads" ON "forum_threads" AS PERMISSIVE FOR UPDATE TO "authenticated" USING ("forum_threads"."created_by" = (select auth.uid())) WITH CHECK ("forum_threads"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "creator can delete own forum threads" ON "forum_threads" AS PERMISSIVE FOR DELETE TO "authenticated" USING ("forum_threads"."created_by" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "user can read own payments" ON "membership_payments" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("membership_payments"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "user can read own subscription" ON "user_subscriptions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("user_subscriptions"."user_id" = (select auth.uid()));--> statement-breakpoint
CREATE POLICY "user can read own trial" ON "user_trials" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("user_trials"."user_id" = (select auth.uid()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "animal_treatments" TO "authenticated" USING ("animal_treatments"."farm_id" = (select farm_id())) WITH CHECK ("animal_treatments"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "animals" TO "authenticated" USING ("animals"."farm_id" = (select farm_id())) WITH CHECK ("animals"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "contacts" TO "authenticated" USING ("contacts"."farm_id" = (select farm_id())) WITH CHECK ("contacts"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_families" TO "authenticated" USING ("crop_families"."farm_id" = (select farm_id())) WITH CHECK ("crop_families"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_protection_application_presets" TO "authenticated" USING ("crop_protection_application_presets"."farm_id" = (select farm_id())) WITH CHECK ("crop_protection_application_presets"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_protection_applications" TO "authenticated" USING ("crop_protection_applications"."farm_id" = (select farm_id())) WITH CHECK ("crop_protection_applications"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_protection_products" TO "authenticated" USING ("crop_protection_products"."farm_id" = (select farm_id())) WITH CHECK ("crop_protection_products"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_rotation_yearly_recurrences" TO "authenticated" USING ("crop_rotation_yearly_recurrences"."farm_id" = (select farm_id())) WITH CHECK ("crop_rotation_yearly_recurrences"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crop_rotations" TO "authenticated" USING ("crop_rotations"."farm_id" = (select farm_id())) WITH CHECK ("crop_rotations"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "crops" TO "authenticated" USING ("crops"."farm_id" = (select farm_id())) WITH CHECK ("crops"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "custom_outdoor_journal_categories" TO "authenticated" USING ("custom_outdoor_journal_categories"."farm_id" = (select farm_id())) WITH CHECK ("custom_outdoor_journal_categories"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "drug_treatment" TO "authenticated" USING ((SELECT current_setting('request.farm_id')::uuid) IN (SELECT farm_id FROM "drugs" WHERE id = "drug_treatment"."drug_id"));--> statement-breakpoint
ALTER POLICY "only farm members" ON "drugs" TO "authenticated" USING ("drugs"."farm_id" = (select farm_id())) WITH CHECK ("drugs"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "ear_tags" TO "authenticated" USING ("ear_tags"."farm_id" = (select farm_id())) WITH CHECK ("ear_tags"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "farm_invites" TO "authenticated" USING ("farm_invites"."farm_id" = (select farm_id())) WITH CHECK ("farm_invites"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members can read" ON "farms" TO "authenticated" USING ((select farm_id()) = "farms"."id");--> statement-breakpoint
ALTER POLICY "only farm members can update" ON "farms" TO "authenticated" USING ((select farm_id()) = "farms"."id") WITH CHECK ((select farm_id()) = "farms"."id");--> statement-breakpoint
ALTER POLICY "only farm members can delete" ON "farms" TO "authenticated" USING ((select farm_id()) = "farms"."id");--> statement-breakpoint
ALTER POLICY "only farm members" ON "fertilizer_application_presets" TO "authenticated" USING ("fertilizer_application_presets"."farm_id" = (select farm_id())) WITH CHECK ("fertilizer_application_presets"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "fertilizer_applications" TO "authenticated" USING ("fertilizer_applications"."farm_id" = (select farm_id())) WITH CHECK ("fertilizer_applications"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "fertilizers" TO "authenticated" USING ("fertilizers"."farm_id" = (select farm_id())) WITH CHECK ("fertilizers"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "harvest_presets" TO "authenticated" USING ("harvest_presets"."farm_id" = (select farm_id())) WITH CHECK ("harvest_presets"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "harvests" TO "authenticated" USING ("harvests"."farm_id" = (select farm_id())) WITH CHECK ("harvests"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "herd_memberships" TO "authenticated" USING ("herd_memberships"."farm_id" = (select farm_id())) WITH CHECK ("herd_memberships"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "herds" TO "authenticated" USING ("herds"."farm_id" = (select farm_id())) WITH CHECK ("herds"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "order_items" TO "authenticated" USING ("order_items"."farm_id" = (select farm_id())) WITH CHECK ("order_items"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "orders" TO "authenticated" USING ("orders"."farm_id" = (select farm_id())) WITH CHECK ("orders"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "outdoor_schedule_recurrences" TO "authenticated" USING ("outdoor_schedule_recurrences"."farm_id" = (select farm_id())) WITH CHECK ("outdoor_schedule_recurrences"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "outdoor_shedules" TO "authenticated" USING ("outdoor_shedules"."farm_id" = (select farm_id())) WITH CHECK ("outdoor_shedules"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "parcels" TO "authenticated" USING ("parcels"."farm_id" = (select farm_id())) WITH CHECK ("parcels"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "payments" TO "authenticated" USING ("payments"."farm_id" = (select farm_id())) WITH CHECK ("payments"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "plots" TO "authenticated" USING ("plots"."farm_id" = (select farm_id())) WITH CHECK ("plots"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "products" TO "authenticated" USING ("products"."farm_id" = (select farm_id())) WITH CHECK ("products"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "members of same farm can read each others profile and owners can read their own profile" ON "profiles" TO "authenticated" USING (((("profiles"."farm_id" is not null) and "profiles"."farm_id" = (select farm_id())) or (select auth.uid()) = "profiles"."id"));--> statement-breakpoint
ALTER POLICY "only farm members" ON "sponsorship_programs" TO "authenticated" USING ("sponsorship_programs"."farm_id" = (select farm_id())) WITH CHECK ("sponsorship_programs"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "sponsorships" TO "authenticated" USING ("sponsorships"."farm_id" = (select farm_id())) WITH CHECK ("sponsorships"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "task_checklist_items" TO "authenticated" USING ("task_checklist_items"."farm_id" = (select farm_id())) WITH CHECK ("task_checklist_items"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "task_links" TO "authenticated" USING ("task_links"."farm_id" = (select farm_id())) WITH CHECK ("task_links"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "task_recurrences" TO "authenticated" USING ("task_recurrences"."farm_id" = (select farm_id())) WITH CHECK ("task_recurrences"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "tasks" TO "authenticated" USING ("tasks"."farm_id" = (select farm_id())) WITH CHECK ("tasks"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "tillage_presets" TO "authenticated" USING ("tillage_presets"."farm_id" = (select farm_id())) WITH CHECK ("tillage_presets"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "tillages" TO "authenticated" USING ("tillages"."farm_id" = (select farm_id())) WITH CHECK ("tillages"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "only farm members" ON "treatments" TO "authenticated" USING ("treatments"."farm_id" = (select farm_id())) WITH CHECK ("treatments"."farm_id" = (select farm_id()));--> statement-breakpoint
ALTER POLICY "submitter can read and write notes on own change requests" ON "wiki_change_request_notes" TO "authenticated" USING ((SELECT auth.uid()) IN (SELECT submitted_by FROM "wiki_change_requests" WHERE id = "wiki_change_request_notes"."change_request_id")) WITH CHECK ((SELECT auth.uid()) IN (SELECT submitted_by FROM "wiki_change_requests" WHERE id = "wiki_change_request_notes"."change_request_id") AND "wiki_change_request_notes"."author_id" = (SELECT auth.uid()));--> statement-breakpoint
ALTER POLICY "follow change request access for cr translations" ON "wiki_change_request_translations" TO "authenticated" USING ((SELECT auth.uid()) IN (SELECT submitted_by FROM "wiki_change_requests" WHERE id = "wiki_change_request_translations"."change_request_id")) WITH CHECK ((SELECT auth.uid()) IN (SELECT submitted_by FROM "wiki_change_requests" WHERE id = "wiki_change_request_translations"."change_request_id"));--> statement-breakpoint
ALTER POLICY "authenticated users can read wiki entries" ON "wiki_entries" TO "authenticated" USING (("wiki_entries"."status" = 'published'::wiki_entry_status AND "wiki_entries"."visibility" = 'public'::wiki_visibility) OR "wiki_entries"."created_by" = (SELECT auth.uid()) OR ("wiki_entries"."farm_id" IS NOT NULL AND "wiki_entries"."farm_id" = (SELECT current_setting('request.farm_id', TRUE)::uuid)));--> statement-breakpoint
ALTER POLICY "follow entry access for images" ON "wiki_entry_images" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_images"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR (SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_images"."entry_id")
        OR (SELECT current_setting('request.farm_id', TRUE)::uuid) IN (SELECT farm_id FROM "wiki_entries" WHERE id = "wiki_entry_images"."entry_id" AND farm_id IS NOT NULL)
      ) WITH CHECK ((SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_images"."entry_id"));--> statement-breakpoint
ALTER POLICY "follow entry access for entry tags" ON "wiki_entry_tags" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_tags"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR (SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_tags"."entry_id")
        OR (SELECT current_setting('request.farm_id', TRUE)::uuid) IN (SELECT farm_id FROM "wiki_entries" WHERE id = "wiki_entry_tags"."entry_id" AND farm_id IS NOT NULL)
      ) WITH CHECK ((SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_tags"."entry_id"));--> statement-breakpoint
ALTER POLICY "follow entry access for translations" ON "wiki_entry_translations" TO "authenticated" USING (
        EXISTS (SELECT 1 FROM "wiki_entries" we WHERE we.id = "wiki_entry_translations"."entry_id" AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR (SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_translations"."entry_id")
        OR (SELECT current_setting('request.farm_id', TRUE)::uuid) IN (SELECT farm_id FROM "wiki_entries" WHERE id = "wiki_entry_translations"."entry_id" AND farm_id IS NOT NULL)
      ) WITH CHECK ((SELECT auth.uid()) IN (SELECT created_by FROM "wiki_entries" WHERE id = "wiki_entry_translations"."entry_id"));