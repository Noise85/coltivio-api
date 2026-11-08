CREATE TABLE "farm_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "farm_role" DEFAULT 'member'::"farm_role" NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "farm_members_farm_user_unique" UNIQUE("farm_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "farm_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "farm_members" ADD CONSTRAINT "farm_members_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "farm_members" ADD CONSTRAINT "farm_members_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE INDEX "farm_members_user_id_idx" ON "farm_members" ("user_id");--> statement-breakpoint
-- Backfill: carry over each profile's existing single farm assignment as its first membership row.
INSERT INTO "farm_members" ("farm_id", "user_id", "role")
SELECT "farm_id", "id", "farm_role" FROM "profiles"
WHERE "farm_id" IS NOT NULL AND "farm_role" IS NOT NULL;--> statement-breakpoint
CREATE POLICY "user can read own memberships and farm co-members" ON "farm_members" AS PERMISSIVE FOR SELECT TO "authenticated" USING (("farm_members"."user_id" = (select auth.uid()) or "farm_members"."farm_id" = (select farm_id())));--> statement-breakpoint
-- Must happen before the profiles.farm_id column is dropped below: the old policy body
-- references farm_id directly, and Postgres refuses to drop a column a live policy depends on.
ALTER POLICY "members of same farm can read each others profile and owners can read their own profile" ON "profiles" TO "authenticated" USING ((EXISTS (SELECT 1 FROM farm_members WHERE farm_id = (select farm_id()) AND user_id = "profiles"."id") or (select auth.uid()) = "profiles"."id"));--> statement-breakpoint
ALTER TABLE "profiles" DROP CONSTRAINT "profiles_farm_id_farms_id_fk";--> statement-breakpoint
ALTER TABLE "farm_member_permissions" DROP CONSTRAINT "farm_member_permissions_user_feature_unique";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "farm_id";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "farm_role";--> statement-breakpoint
ALTER TABLE "farm_member_permissions" ADD CONSTRAINT "farm_member_permissions_farm_user_feature_unique" UNIQUE("farm_id","user_id","feature");
