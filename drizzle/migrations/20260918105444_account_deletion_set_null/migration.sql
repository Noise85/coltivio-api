ALTER TABLE "fertilizer_applications" DROP CONSTRAINT "fertilizer_applications_created_by_profiles_id_fk";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_replies" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "forum_threads" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "membership_payments" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_request_notes" ALTER COLUMN "author_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" ALTER COLUMN "submitted_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wiki_entries" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ADD CONSTRAINT "fertilizer_applications_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "forum_replies" DROP CONSTRAINT "forum_replies_created_by_profiles_id_fkey", ADD CONSTRAINT "forum_replies_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "forum_threads" DROP CONSTRAINT "forum_threads_created_by_profiles_id_fkey", ADD CONSTRAINT "forum_threads_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "membership_payments" DROP CONSTRAINT "membership_payments_user_id_profiles_id_fkey", ADD CONSTRAINT "membership_payments_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_request_notes" DROP CONSTRAINT "wiki_change_request_notes_author_id_profiles_id_fkey", ADD CONSTRAINT "wiki_change_request_notes_author_id_profiles_id_fkey" FOREIGN KEY ("author_id") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_change_requests" DROP CONSTRAINT "wiki_change_requests_submitted_by_profiles_id_fkey", ADD CONSTRAINT "wiki_change_requests_submitted_by_profiles_id_fkey" FOREIGN KEY ("submitted_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "wiki_entries" DROP CONSTRAINT "wiki_entries_created_by_profiles_id_fkey", ADD CONSTRAINT "wiki_entries_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;