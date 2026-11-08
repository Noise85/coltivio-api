CREATE TYPE "animal_category" AS ENUM('A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'B1', 'B2', 'B3', 'C1', 'C2', 'D1', 'D2', 'D3', 'E1', 'E2', 'E3', 'E4', 'F1', 'F2');--> statement-breakpoint
CREATE TYPE "animal_sex" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "animal_type" AS ENUM('goat', 'sheep', 'cow', 'horse', 'donkey', 'pig', 'deer');--> statement-breakpoint
CREATE TYPE "animal_usage" AS ENUM('milk', 'other');--> statement-breakpoint
CREATE TYPE "crop_protection_application_unit" AS ENUM('load', 'bag', 'total_amount', 'amount_per_hectare', 'other');--> statement-breakpoint
CREATE TYPE "death_reason" AS ENUM('died', 'slaughtered');--> statement-breakpoint
CREATE TYPE "dose_per_unit" AS ENUM('kg', 'animal', 'day', 'total_amount');--> statement-breakpoint
CREATE TYPE "drug_dose_unit" AS ENUM('tablet', 'capsule', 'patch', 'dose', 'mg', 'mcg', 'g', 'ml', 'drop');--> statement-breakpoint
CREATE TYPE "fertilizer_application_unit" AS ENUM('load', 'bag', 'total_amount', 'amount_per_hectare', 'other');--> statement-breakpoint
CREATE TYPE "frequency" AS ENUM('weekly', 'monthly', 'yearly');--> statement-breakpoint
CREATE TYPE "harvest_unit" AS ENUM('load', 'square_bale', 'round_bale', 'crate', 'total_amount', 'other');--> statement-breakpoint
CREATE TYPE "order_status" AS ENUM('pending', 'confirmed', 'fulfilled', 'cancelled');--> statement-breakpoint
CREATE TYPE "outdoor_schedule_type" AS ENUM('pasture', 'exercise_yard');--> statement-breakpoint
CREATE TYPE "payment_method" AS ENUM('cash', 'bank_transfer', 'twint', 'card', 'other');--> statement-breakpoint
CREATE TYPE "preferred_communication" AS ENUM('email', 'phone', 'whatsapp');--> statement-breakpoint
CREATE TYPE "product_category" AS ENUM('meat', 'vegetables', 'dairy', 'eggs', 'other');--> statement-breakpoint
CREATE TYPE "product_unit" AS ENUM('kg', 'g', 'piece', 'bunch', 'liter');--> statement-breakpoint
CREATE TYPE "weekday" AS ENUM('MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU');--> statement-breakpoint
ALTER TYPE "forage_conservation_method" RENAME TO "conservation_method";--> statement-breakpoint
CREATE TABLE "animal_treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"animal_id" uuid NOT NULL,
	"treatment_id" uuid NOT NULL,
	"farm_id" uuid NOT NULL,
	CONSTRAINT "animal_treatments_unique" UNIQUE("animal_id","treatment_id")
);
--> statement-breakpoint
ALTER TABLE "animal_treatments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "animal_type" NOT NULL,
	"usage" "animal_usage" NOT NULL,
	"requires_category_override" boolean DEFAULT false NOT NULL,
	"category_override" "animal_category",
	"sex" "animal_sex" NOT NULL,
	"date_of_birth" date NOT NULL,
	"registered" boolean DEFAULT false NOT NULL,
	"ear_tag_id" uuid,
	"mother_id" uuid,
	"father_id" uuid,
	"date_of_death" date,
	"death_reason" "death_reason",
	"herd_id" uuid
);
--> statement-breakpoint
ALTER TABLE "animals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"street" text,
	"city" text,
	"zip" text,
	"phone" text,
	"email" text,
	"preferred_communication" "preferred_communication",
	"labels" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crop_families" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"waiting_time_in_years" integer DEFAULT 0 NOT NULL,
	"additional_notes" text
);
--> statement-breakpoint
ALTER TABLE "crop_families" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crop_protection_application_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"method" "crop_protection_application_method",
	"unit" "crop_protection_application_unit" NOT NULL,
	"custom_unit" text,
	"amount_per_unit" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crop_protection_application_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "crop_rotation_yearly_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"crop_rotation_id" uuid NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"until" date
);
--> statement-breakpoint
ALTER TABLE "crop_rotation_yearly_recurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drug_treatment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"drug_id" uuid NOT NULL,
	"animal_type" "animal_type" NOT NULL,
	"dose_unit" "drug_dose_unit" NOT NULL,
	"dose_value" real NOT NULL,
	"dose_per_unit" "dose_per_unit" NOT NULL,
	"milk_waiting_days" integer NOT NULL,
	"meat_waiting_days" integer NOT NULL,
	"organs_waiting_days" integer NOT NULL,
	CONSTRAINT "drug_treatment_drug_animal_unique" UNIQUE("drug_id","animal_type")
);
--> statement-breakpoint
ALTER TABLE "drug_treatment" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "drugs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"critical_antibiotic" boolean NOT NULL,
	"received_from" text NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "drugs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ear_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"number" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ear_tags" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "fertilizer_application_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"fertilizer_id" uuid NOT NULL,
	"unit" "fertilizer_application_unit" NOT NULL,
	"method" "fertilization_method",
	"amount_per_unit" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fertilizer_application_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "harvest_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" "harvest_unit" NOT NULL,
	"kilos_per_unit" real NOT NULL,
	"conservation_method" "conservation_method"
);
--> statement-breakpoint
ALTER TABLE "harvest_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "herd_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"herd_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date
);
--> statement-breakpoint
ALTER TABLE "herd_memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "herds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "herds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"quantity" real NOT NULL,
	"unit_price" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" "order_status" DEFAULT 'pending'::"order_status" NOT NULL,
	"order_date" date NOT NULL,
	"shipping_date" date,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outdoor_schedule_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"outdoor_schedule_id" uuid NOT NULL,
	"frequency" "frequency" NOT NULL,
	"interval" integer DEFAULT 1 NOT NULL,
	"by_weekday" "weekday"[],
	"by_month_day" integer,
	"until" date,
	"count" integer
);
--> statement-breakpoint
ALTER TABLE "outdoor_schedule_recurrences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outdoor_shedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"herd_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"type" "outdoor_schedule_type" NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "outdoor_shedules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"sponsorship_id" uuid,
	"order_id" uuid,
	"date" date NOT NULL,
	"amount" real NOT NULL,
	"currency" text DEFAULT 'CHF' NOT NULL,
	"method" "payment_method" NOT NULL,
	"notes" text
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"category" "product_category" NOT NULL,
	"unit" "product_unit" NOT NULL,
	"price_per_unit" real NOT NULL,
	"description" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sponsorship_programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"yearly_cost" real NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sponsorship_programs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sponsorships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"sponsorship_program_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"notes" text,
	"preferred_communication" "preferred_communication"
);
--> statement-breakpoint
ALTER TABLE "sponsorships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "tillage_presets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"name" text NOT NULL,
	"reason" "tillage_reason",
	"action" "tillage_action" NOT NULL,
	"custom_action" text
);
--> statement-breakpoint
ALTER TABLE "tillage_presets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "treatments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"farm_id" uuid NOT NULL,
	"drug_id" uuid,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"drug_dose_unit" "drug_dose_unit",
	"drug_dose_value" real,
	"drug_dose_per_unit" "dose_per_unit",
	"drug_received_from" text,
	"critical_antibiotic" boolean NOT NULL,
	"antibiogram_available" boolean NOT NULL,
	"milk_usable_date" date,
	"meat_usable_date" date,
	"organs_usable_date" date,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "treatments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "forage_harvests" RENAME TO "harvests";--> statement-breakpoint
DROP POLICY "only farm members" ON "crop_protection_equipment";--> statement-breakpoint
DROP POLICY "only farm members" ON "fertilizer_spreaders";--> statement-breakpoint
DROP POLICY "only farm members" ON "harvesting_machinery";--> statement-breakpoint
DROP POLICY "only farm members" ON "tillage_equipment";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" DROP CONSTRAINT "crop_protection_applications_equipment_id_crop_protection_equip";--> statement-breakpoint
ALTER TABLE "crop_protection_products" DROP CONSTRAINT "crop_protection_products_default_equipment_id_crop_protection_e";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" DROP CONSTRAINT "fertilizer_applications_spreader_id_fertilizer_spreaders_id_fk";--> statement-breakpoint
ALTER TABLE "fertilizers" DROP CONSTRAINT "fertilizers_default_spreader_id_fertilizer_spreaders_id_fk";--> statement-breakpoint
ALTER TABLE "harvests" DROP CONSTRAINT "forage_harvests_machinery_id_harvesting_machinery_id_fk";--> statement-breakpoint
ALTER TABLE "tillages" DROP CONSTRAINT "tillages_equipment_id_tillage_equipment_id_fk";--> statement-breakpoint
DROP TABLE "crop_protection_equipment";--> statement-breakpoint
DROP TABLE "fertilizer_spreaders";--> statement-breakpoint
DROP TABLE "harvesting_machinery";--> statement-breakpoint
DROP TABLE "tillage_equipment";--> statement-breakpoint
-- ALTER TABLE "federal_farm_plots" RENAME COLUMN "area" TO "size";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" ADD COLUMN "amount_per_unit" real NOT NULL;--> statement-breakpoint
ALTER TABLE "crop_protection_applications" ADD COLUMN "number_of_units" real NOT NULL;--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "family_id" uuid;--> statement-breakpoint
ALTER TABLE "crops" ADD COLUMN "waiting_time_in_years" integer;--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ADD COLUMN "amount_per_unit" real NOT NULL;--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ADD COLUMN "number_of_units" real NOT NULL;--> statement-breakpoint
ALTER TABLE "harvests" ADD COLUMN "unit" "harvest_unit" NOT NULL;--> statement-breakpoint
ALTER TABLE "harvests" ADD COLUMN "number_of_units" real NOT NULL;--> statement-breakpoint
ALTER TABLE "tillages" ADD COLUMN "custom_action" text;--> statement-breakpoint
ALTER TABLE "tillages" ALTER COLUMN "action" SET DATA TYPE text;--> statement-breakpoint
-- DROP TYPE "tillage_action";--> statement-breakpoint
-- CREATE TYPE "tillage_action" AS ENUM('plowing', 'tilling', 'harrowing', 'rolling', 'rotavating', 'weed_harrowing', 'hoeing', 'flame_weeding', 'custom');--> statement-breakpoint
ALTER TYPE "tillage_action" ADD VALUE 'custom';
ALTER TABLE "tillages" ALTER COLUMN "action" SET DATA TYPE "tillage_action" USING "action"::"tillage_action";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" DROP COLUMN "equipment_id";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" DROP COLUMN "amount_per_application";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" DROP COLUMN "number_of_applications";--> statement-breakpoint
-- ALTER TABLE "federal_farm_plots" DROP COLUMN "a_usages";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" DROP COLUMN "amount_per_application";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" DROP COLUMN "number_of_applications";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" DROP COLUMN "spreader_id";--> statement-breakpoint
ALTER TABLE "harvests" DROP COLUMN "processing_type";--> statement-breakpoint
ALTER TABLE "harvests" DROP COLUMN "produced_units";--> statement-breakpoint
ALTER TABLE "harvests" DROP COLUMN "machinery_id";--> statement-breakpoint
ALTER TABLE "tillages" DROP COLUMN "equipment_id";--> statement-breakpoint
ALTER TABLE "crop_protection_products" DROP COLUMN "default_equipment_id";--> statement-breakpoint
ALTER TABLE "fertilizers" DROP COLUMN "default_spreader_id";--> statement-breakpoint
ALTER TABLE "plots" DROP COLUMN "additional_usages";--> statement-breakpoint
ALTER TABLE "crop_protection_applications" ALTER COLUMN "method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crop_protection_applications" ALTER COLUMN "unit" SET DATA TYPE "crop_protection_application_unit" USING "unit"::text::"crop_protection_application_unit";--> statement-breakpoint
ALTER TABLE "crop_rotations" ALTER COLUMN "to_date" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ALTER COLUMN "unit" SET DATA TYPE "fertilizer_application_unit" USING "unit"::text::"fertilizer_application_unit";--> statement-breakpoint
ALTER TABLE "fertilizer_applications" ALTER COLUMN "method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "harvests" ALTER COLUMN "conservation_method" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "tillages" ALTER COLUMN "reason" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "animal_treatments_animal_id_idx" ON "animal_treatments" ("animal_id");--> statement-breakpoint
CREATE INDEX "animal_treatments_treatment_id_idx" ON "animal_treatments" ("treatment_id");--> statement-breakpoint
CREATE INDEX "drug_treatment_drug_id_idx" ON "drug_treatment" ("drug_id");--> statement-breakpoint
CREATE INDEX "herd_memberships_animal_id_idx" ON "herd_memberships" ("animal_id");--> statement-breakpoint
CREATE INDEX "herd_memberships_herd_id_idx" ON "herd_memberships" ("herd_id");--> statement-breakpoint
CREATE INDEX "treatments_drug_id_idx" ON "treatments" ("drug_id");--> statement-breakpoint
CREATE INDEX "treatments_date_idx" ON "treatments" ("start_date");--> statement-breakpoint
ALTER TABLE "animal_treatments" ADD CONSTRAINT "animal_treatments_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_treatments" ADD CONSTRAINT "animal_treatments_treatment_id_treatments_id_fkey" FOREIGN KEY ("treatment_id") REFERENCES "treatments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animal_treatments" ADD CONSTRAINT "animal_treatments_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_ear_tag_id_ear_tags_id_fkey" FOREIGN KEY ("ear_tag_id") REFERENCES "ear_tags"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_herd_id_herds_id_fkey" FOREIGN KEY ("herd_id") REFERENCES "herds"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_mother_fk" FOREIGN KEY ("mother_id") REFERENCES "animals"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_father_fk" FOREIGN KEY ("father_id") REFERENCES "animals"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_families" ADD CONSTRAINT "crop_families_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_protection_application_presets" ADD CONSTRAINT "crop_protection_application_presets_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_yearly_recurrences" ADD CONSTRAINT "crop_rotation_yearly_recurrences_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crop_rotation_yearly_recurrences" ADD CONSTRAINT "crop_rotation_yearly_recurrences_8wTBnwqBsUgZ_fkey" FOREIGN KEY ("crop_rotation_id") REFERENCES "crop_rotations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "crops" ADD CONSTRAINT "crops_family_id_crop_families_id_fkey" FOREIGN KEY ("family_id") REFERENCES "crop_families"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "drug_treatment" ADD CONSTRAINT "drug_treatment_drug_id_drugs_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drugs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drugs" ADD CONSTRAINT "drugs_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ear_tags" ADD CONSTRAINT "ear_tags_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fertilizer_application_presets" ADD CONSTRAINT "fertilizer_application_presets_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "fertilizer_application_presets" ADD CONSTRAINT "fertilizer_application_presets_S9oxn23jSRLF_fkey" FOREIGN KEY ("fertilizer_id") REFERENCES "fertilizers"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "harvest_presets" ADD CONSTRAINT "harvest_presets_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "herd_memberships" ADD CONSTRAINT "herd_memberships_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "herd_memberships" ADD CONSTRAINT "herd_memberships_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "herd_memberships" ADD CONSTRAINT "herd_memberships_herd_id_herds_id_fkey" FOREIGN KEY ("herd_id") REFERENCES "herds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "herds" ADD CONSTRAINT "herds_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_contact_id_contacts_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outdoor_schedule_recurrences" ADD CONSTRAINT "outdoor_schedule_recurrences_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outdoor_schedule_recurrences" ADD CONSTRAINT "outdoor_schedule_recurrences_phiXhM6XuCtO_fkey" FOREIGN KEY ("outdoor_schedule_id") REFERENCES "outdoor_shedules"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outdoor_shedules" ADD CONSTRAINT "outdoor_shedules_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outdoor_shedules" ADD CONSTRAINT "outdoor_shedules_herd_id_herds_id_fkey" FOREIGN KEY ("herd_id") REFERENCES "herds"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_contact_id_contacts_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_sponsorship_id_sponsorships_id_fkey" FOREIGN KEY ("sponsorship_id") REFERENCES "sponsorships"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sponsorship_programs" ADD CONSTRAINT "sponsorship_programs_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_contact_id_contacts_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_animal_id_animals_id_fkey" FOREIGN KEY ("animal_id") REFERENCES "animals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sponsorships" ADD CONSTRAINT "sponsorships_ndTyUkg1JW64_fkey" FOREIGN KEY ("sponsorship_program_id") REFERENCES "sponsorship_programs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "tillage_presets" ADD CONSTRAINT "tillage_presets_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_farm_id_farms_id_fkey" FOREIGN KEY ("farm_id") REFERENCES "farms"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_drug_id_drugs_id_fkey" FOREIGN KEY ("drug_id") REFERENCES "drugs"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "treatments" ADD CONSTRAINT "treatments_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
CREATE POLICY "only farm members" ON "animal_treatments" AS PERMISSIVE FOR ALL TO "authenticated" USING ("animal_treatments"."farm_id" = farm_id()) WITH CHECK ("animal_treatments"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "animals" AS PERMISSIVE FOR ALL TO "authenticated" USING ("animals"."farm_id" = farm_id()) WITH CHECK ("animals"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "contacts" AS PERMISSIVE FOR ALL TO "authenticated" USING ("contacts"."farm_id" = farm_id()) WITH CHECK ("contacts"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_families" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_families"."farm_id" = farm_id()) WITH CHECK ("crop_families"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_protection_application_presets" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_protection_application_presets"."farm_id" = farm_id()) WITH CHECK ("crop_protection_application_presets"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "crop_rotation_yearly_recurrences" AS PERMISSIVE FOR ALL TO "authenticated" USING ("crop_rotation_yearly_recurrences"."farm_id" = farm_id()) WITH CHECK ("crop_rotation_yearly_recurrences"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "drug_treatment" AS PERMISSIVE FOR ALL TO "authenticated" USING (EXISTS (
        SELECT 1 FROM "drugs"
        WHERE "drugs"."id" = "drug_treatment"."drug_id"
        AND "drugs"."farm_id" = current_setting('request.farm_id')::uuid
      ));--> statement-breakpoint
CREATE POLICY "only farm members" ON "drugs" AS PERMISSIVE FOR ALL TO "authenticated" USING ("drugs"."farm_id" = farm_id()) WITH CHECK ("drugs"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "ear_tags" AS PERMISSIVE FOR ALL TO "authenticated" USING ("ear_tags"."farm_id" = farm_id()) WITH CHECK ("ear_tags"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "fertilizer_application_presets" AS PERMISSIVE FOR ALL TO "authenticated" USING ("fertilizer_application_presets"."farm_id" = farm_id()) WITH CHECK ("fertilizer_application_presets"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "harvest_presets" AS PERMISSIVE FOR ALL TO "authenticated" USING ("harvest_presets"."farm_id" = farm_id()) WITH CHECK ("harvest_presets"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "herd_memberships" AS PERMISSIVE FOR ALL TO "authenticated" USING ("herd_memberships"."farm_id" = farm_id()) WITH CHECK ("herd_memberships"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "herds" AS PERMISSIVE FOR ALL TO "authenticated" USING ("herds"."farm_id" = farm_id()) WITH CHECK ("herds"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "order_items" AS PERMISSIVE FOR ALL TO "authenticated" USING ("order_items"."farm_id" = farm_id()) WITH CHECK ("order_items"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "orders" AS PERMISSIVE FOR ALL TO "authenticated" USING ("orders"."farm_id" = farm_id()) WITH CHECK ("orders"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "outdoor_schedule_recurrences" AS PERMISSIVE FOR ALL TO "authenticated" USING ("outdoor_schedule_recurrences"."farm_id" = farm_id()) WITH CHECK ("outdoor_schedule_recurrences"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "outdoor_shedules" AS PERMISSIVE FOR ALL TO "authenticated" USING ("outdoor_shedules"."farm_id" = farm_id()) WITH CHECK ("outdoor_shedules"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "payments" AS PERMISSIVE FOR ALL TO "authenticated" USING ("payments"."farm_id" = farm_id()) WITH CHECK ("payments"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "products" AS PERMISSIVE FOR ALL TO "authenticated" USING ("products"."farm_id" = farm_id()) WITH CHECK ("products"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "sponsorship_programs" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sponsorship_programs"."farm_id" = farm_id()) WITH CHECK ("sponsorship_programs"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "sponsorships" AS PERMISSIVE FOR ALL TO "authenticated" USING ("sponsorships"."farm_id" = farm_id()) WITH CHECK ("sponsorships"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "tillage_presets" AS PERMISSIVE FOR ALL TO "authenticated" USING ("tillage_presets"."farm_id" = farm_id()) WITH CHECK ("tillage_presets"."farm_id" = farm_id());--> statement-breakpoint
CREATE POLICY "only farm members" ON "treatments" AS PERMISSIVE FOR ALL TO "authenticated" USING ("treatments"."farm_id" = farm_id()) WITH CHECK ("treatments"."farm_id" = farm_id());--> statement-breakpoint
ALTER POLICY "only farm members" ON "harvests" TO "authenticated" USING ("harvests"."farm_id" = farm_id()) WITH CHECK ("harvests"."farm_id" = farm_id());--> statement-breakpoint
ALTER POLICY "members of same farm can read each others profile and owners can read their own profile" ON "profiles" TO "authenticated" USING (((("profiles"."farm_id" is not null) and "profiles"."farm_id" = farm_id()) or (select auth.uid()) = "profiles"."id"));--> statement-breakpoint
DROP TYPE "forage_processing_type";