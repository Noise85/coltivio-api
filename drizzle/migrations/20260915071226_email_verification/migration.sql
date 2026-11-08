CREATE TABLE "email_verification_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token" text NOT NULL UNIQUE,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "verification_handled_at" timestamp;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "welcome_email_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
-- Drizzle does not model column grants. A column REVOKE is a no-op while the table grant stands.
REVOKE UPDATE ON public.profiles FROM authenticated;--> statement-breakpoint
GRANT UPDATE (full_name) ON public.profiles TO authenticated;--> statement-breakpoint
-- Supabase changes the address only once the new one is confirmed, so it stays verified. Clearing
-- verification_handled_at lets the next API request finish the change.
CREATE OR REPLACE FUNCTION public.update_profile()
RETURNS trigger
SET search_path = ''
AS $$
BEGIN
  UPDATE public.profiles
  SET (email, full_name) = (NEW.email, NEW.raw_user_meta_data->>'full_name')
  WHERE id = NEW.id;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.profiles
    SET email_verified = true, verification_handled_at = NULL
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;--> statement-breakpoint
-- Otherwise the first request after the deploy would treat every verified account as a finished address change
UPDATE public.profiles SET verification_handled_at = now() WHERE email_verified;