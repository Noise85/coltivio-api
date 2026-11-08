CREATE TABLE "forum_thread_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"thread_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"subscribed" boolean NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "forum_thread_subscriptions_thread_user_unique" UNIQUE("thread_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "forum_thread_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forum_thread_subscriptions" ADD CONSTRAINT "forum_thread_subscriptions_thread_id_forum_threads_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "forum_threads"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forum_thread_subscriptions" ADD CONSTRAINT "forum_thread_subscriptions_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "user can manage own forum thread subscriptions" ON "forum_thread_subscriptions" AS PERMISSIVE FOR ALL TO "authenticated" USING ("forum_thread_subscriptions"."user_id" = (select auth.uid())) WITH CHECK ("forum_thread_subscriptions"."user_id" = (select auth.uid()));--> statement-breakpoint
-- Subscribe authors and repliers of threads that predate notifications, matching createThread and addReply
INSERT INTO "forum_thread_subscriptions" ("thread_id", "user_id", "subscribed")
SELECT "id", "created_by", true FROM "forum_threads" WHERE "created_by" IS NOT NULL
UNION
SELECT "thread_id", "created_by", true FROM "forum_replies" WHERE "created_by" IS NOT NULL
ON CONFLICT ("thread_id", "user_id") DO NOTHING;
