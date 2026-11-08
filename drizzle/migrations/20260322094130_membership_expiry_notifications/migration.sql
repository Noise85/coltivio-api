CREATE TYPE "membership_expiry_notification_type" AS ENUM('payment_failed', 'expiry_reminder', 'access_lost', 'membership_ended');--> statement-breakpoint
CREATE TABLE "membership_expiry_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"period_end_date" date NOT NULL,
	"type" "membership_expiry_notification_type" NOT NULL,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "membership_expiry_notifications_user_id_type_period_end_date_unique" UNIQUE("user_id","type","period_end_date")
);
--> statement-breakpoint
ALTER TABLE "membership_expiry_notifications" ADD CONSTRAINT "membership_expiry_notifications_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;