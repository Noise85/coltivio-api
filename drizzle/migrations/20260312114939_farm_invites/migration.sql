CREATE TYPE "farm_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "farm_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"email" text NOT NULL,
	"code" text NOT NULL UNIQUE,
	"created_by" uuid,
	"expires_at" timestamp NOT NULL,
	"used_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "farm_invites" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "farm_role" "farm_role";--> statement-breakpoint
CREATE INDEX "farm_invites_code_idx" ON "farm_invites" ("code");--> statement-breakpoint
ALTER TABLE "farm_invites" ADD CONSTRAINT "farm_invites_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "farm_invites" ADD CONSTRAINT "farm_invites_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "only farm members" ON "farm_invites" AS PERMISSIVE FOR ALL TO "authenticated" USING ("farm_invites"."farm_id" = farm_id()) WITH CHECK ("farm_invites"."farm_id" = farm_id());
UPDATE "profiles" SET "farm_role" = 'owner' WHERE "farm_id" IS NOT NULL;