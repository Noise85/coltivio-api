CREATE TYPE "farm_permission_feature" AS ENUM('animals', 'field_calendar', 'commerce', 'tasks');--> statement-breakpoint
CREATE TABLE "farm_invite_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"invite_id" uuid NOT NULL,
	"feature" "farm_permission_feature" NOT NULL,
	"access" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "farm_invite_permissions_invite_feature_unique" UNIQUE("invite_id","feature")
);
--> statement-breakpoint
ALTER TABLE "farm_invite_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "farm_member_permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"feature" "farm_permission_feature" NOT NULL,
	"access" text DEFAULT 'none' NOT NULL,
	CONSTRAINT "farm_member_permissions_user_feature_unique" UNIQUE("user_id","feature")
);
--> statement-breakpoint
ALTER TABLE "farm_member_permissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "farm_invites" ADD COLUMN "role" "farm_role" DEFAULT 'member'::"farm_role" NOT NULL;--> statement-breakpoint
ALTER TABLE "farm_invite_permissions" ADD CONSTRAINT "farm_invite_permissions_invite_id_farm_invites_id_fkey" FOREIGN KEY ("invite_id") REFERENCES "farm_invites"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "farm_member_permissions" ADD CONSTRAINT "farm_member_permissions_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "farm_member_permissions" ADD CONSTRAINT "farm_member_permissions_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "only farm members via invite" ON "farm_invite_permissions" AS PERMISSIVE FOR ALL TO "authenticated" USING ("farm_invite_permissions"."invite_id" IN (SELECT id FROM farm_invites WHERE farm_id = farm_id())) WITH CHECK ("farm_invite_permissions"."invite_id" IN (SELECT id FROM farm_invites WHERE farm_id = farm_id()));--> statement-breakpoint
CREATE POLICY "farm members can read permissions" ON "farm_member_permissions" AS PERMISSIVE FOR SELECT TO "authenticated" USING ("farm_member_permissions"."farm_id" = (select farm_id()));--> statement-breakpoint
CREATE POLICY "farm members can manage permissions" ON "farm_member_permissions" AS PERMISSIVE FOR ALL TO "authenticated" USING ("farm_member_permissions"."farm_id" = (select farm_id())) WITH CHECK ("farm_member_permissions"."farm_id" = (select farm_id()));