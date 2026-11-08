ALTER TABLE "donations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user can read own donations" ON "donations" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("donations"."user_id" = (select auth.uid()));--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "payment_method_type" text;--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "card_last4" text;--> statement-breakpoint
ALTER TABLE "donations" ADD COLUMN "card_brand" text;
