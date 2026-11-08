import { and, defineRelations, eq, or, sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgRole,
  pgSchema,
  pgTable,
  pgView,
  real,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { authenticatedRole, authUsers } from "drizzle-orm/supabase";

import { z } from "zod";

const bytea = customType<{ data: Buffer; driverData: Buffer | string }>({
  dataType() {
    return "bytea";
  },
  fromDriver(value: Buffer | string) {
    if (Buffer.isBuffer(value)) return value;
    // pg returns bytea as \x-prefixed hex string in text protocol
    return Buffer.from((value as string).replace(/^\\x/, ""), "hex");
  },
});

const polygon = customType<{ data: string }>({
  dataType() {
    return "geometry(MultiPolygon,4326)";
  },
});
const point = customType<{ data: string }>({
  dataType() {
    return "geometry(Point,4326)";
  },
});

// Wrapped in (select ...) so Postgres caches the result per statement instead of evaluating per row
export const currentFarmId = sql`(select farm_id())`;
export const farmIdColumnValue = { farmId: currentFarmId };
const selectAuthUid = sql`(select auth.uid())`;

const _appRole = pgRole("rls_client").existing();
const _extensions = pgSchema("extensions");

export const federalFarmPlots = pgTable.withRLS(
  "federal_farm_plots",
  {
    id: integer().primaryKey(),
    federalFarmId: text("farm_id").notNull(),
    localId: text("local_id"),
    usage: integer().notNull(),
    size: integer().notNull(),
    cuttingDate: date("cut_date", { mode: "date" }),
    canton: text().notNull(),
    geometry: polygon().notNull(),
  },

  (table) => [
    index("federal_farm_plots_geometries_idx").using("gist", table.geometry),
    index("federal_farm_id_idx").using("gin", table.federalFarmId.op("gin_trgm_ops")),
    pgPolicy("authenticated users can read", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
  ]
);

export const farmRoleEnum = pgEnum("farm_role", ["owner", "member"]);

export const farmPermissionFeatureEnum = pgEnum("farm_permission_feature", [
  "animals",
  "field_calendar",
  "commerce",
  "tasks",
]);

export const membershipPaymentStatusEnum = pgEnum("membership_payment_status", [
  "pending",
  "succeeded",
  "failed",
  "refunded",
]);
export const donationStatusEnum = pgEnum("donation_status", ["pending", "succeeded", "failed", "refunded"]);

export const profiles = pgTable.withRLS(
  "profiles",
  {
    id: uuid().primaryKey().notNull(),
    email: text().notNull().unique(),
    fullName: text(),
    emailVerified: boolean().notNull().default(false),
    locale: text().notNull().default("de"),
    stripeCustomerId: text(),
    verificationHandledAt: timestamp({ mode: "date" }),
    welcomeEmailSentAt: timestamp({ mode: "date" }),
  },
  (table) => [
    foreignKey({
      columns: [table.id],
      foreignColumns: [authUsers.id],
      name: "profiles_id_fk",
    }).onDelete("cascade"),
    pgPolicy("user can insert own profile", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: eq(selectAuthUid, table.id),
    }),
    pgPolicy("user can update own profile", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: eq(selectAuthUid, table.id),
    }),
    pgPolicy("members of same farm can read each others profile and owners can read their own profile", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: or(
        sql`EXISTS (SELECT 1 FROM farm_members WHERE farm_id = ${currentFarmId} AND user_id = ${table.id})`,
        eq(selectAuthUid, table.id)
      ),
    }),
  ]
);

// View exposing only id + full_name — security_invoker=false + owned by postgres
// means it bypasses profiles RLS, allowing forum threads to show author names across farms.
// After migration, run: ALTER VIEW profile_names OWNER TO postgres; GRANT SELECT ON profile_names TO authenticated;
export const profileNamesView = pgView("profile_names", {
  id: uuid("id").notNull(),
  fullName: text("full_name"),
}).as(sql`SELECT id, full_name FROM profiles`);

export const farms = pgTable.withRLS(
  "farms",
  {
    id: uuid().primaryKey().defaultRandom(),
    federalId: text(),
    tvdId: text(),
    name: text().notNull(),
    address: text().notNull(),
    location: point(),
  },
  (table) => [
    pgPolicy("only farm members can read", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(currentFarmId, table.id),
    }),
    pgPolicy("only farm members can update", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: eq(currentFarmId, table.id),
      withCheck: eq(currentFarmId, table.id),
    }),
    pgPolicy("only farm members can delete", {
      as: "permissive",
      to: authenticatedRole,
      for: "delete",
      using: eq(currentFarmId, table.id),
    }),
  ]
);

// Many-to-many membership: a user can belong to multiple farms, with a role per farm.
// No insert/update/delete policy for authenticatedRole — all mutations go through db.admin
// from vetted server-side logic (farms.ts / farm-invites.ts). Unlike profiles.farmId/farmRole
// before it, a user can never write their own membership row directly.
export const farmMembers = pgTable.withRLS(
  "farm_members",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    role: farmRoleEnum().notNull().default("member"),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    unique("farm_members_farm_user_unique").on(table.farmId, table.userId),
    index("farm_members_user_id_idx").on(table.userId),
    pgPolicy("user can read own memberships and farm co-members", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: or(eq(table.userId, selectAuthUid), eq(table.farmId, currentFarmId)),
    }),
  ]
);

export const invoiceSettings = pgTable.withRLS(
  "invoice_settings",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    name: text().notNull().default(""),
    senderName: text().notNull().default(""),
    street: text().notNull().default(""),
    zip: text().notNull().default(""),
    city: text().notNull().default(""),
    phone: text(),
    email: text(),
    website: text(),
    iban: text(),
    bankName: text(),
    paymentTermsDays: integer().notNull().default(30),
    introText: text(),
    closingText: text(),
    logoData: bytea(),
    logoMimeType: text(), // "jpg" | "png"
    updatedAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    unique("invoice_settings_farm_name_unique").on(table.farmId, table.name),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Tracks auto-renewing Stripe Subscriptions per user (one row max per user)
export const userSubscriptions = pgTable.withRLS(
  "user_subscriptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: "cascade" }),
    stripeSubscriptionId: text().notNull().unique(),
    cancelAtPeriodEnd: boolean().notNull().default(false),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    pgPolicy("user can read own subscription", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.userId, selectAuthUid),
    }),
  ]
);

// One trial per user ever — free, no credit card required
export const userTrials = pgTable.withRLS(
  "user_trials",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .unique()
      .references(() => profiles.id, { onDelete: "cascade" }),
    endsAt: timestamp({ mode: "date" }).notNull(),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    pgPolicy("user can read own trial", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.userId, selectAuthUid),
    }),
  ]
);

// One row per payment period (subscription renewals + manual one-time payments)
// Active membership = exists a row with status='succeeded' AND periodEnd > now()
export const membershipPayments = pgTable.withRLS(
  "membership_payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => profiles.id, { onDelete: "set null" }),
    stripePaymentId: text().notNull().unique(), // PaymentIntent ID or Invoice ID
    stripeSubscriptionId: text(), // only for auto-renewing payments
    amount: integer().notNull(), // CHF cents
    currency: text().notNull().default("chf"),
    status: membershipPaymentStatusEnum().notNull().default("pending"),
    periodEnd: timestamp({ mode: "date" }).notNull(), // when this payment's coverage expires
    cardLast4: text(),
    cardBrand: text(),
    cardExpMonth: integer(),
    cardExpYear: integer(),
    paymentMethodType: text(), // Stripe PaymentMethod.type, e.g. "card", "twint"
    cancelledByUser: boolean().notNull().default(false),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    pgPolicy("user can read own payments", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.userId, selectAuthUid),
    }),
  ]
);

export const membershipExpiryNotificationTypeEnum = pgEnum("membership_expiry_notification_type", [
  "payment_failed", // auto-renewal failed, sent via webhook immediately
  "expiry_reminder", // manual expiry day 0, sent via cron
  "access_lost", // day +10, sent via cron
  "membership_ended", // day +30, sent via cron
]);

// No RLS needed — managed via db.admin only
export const membershipExpiryNotifications = pgTable(
  "membership_expiry_notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    periodEndDate: date({ mode: "date" }).notNull(), // the periodEnd of the expired payment (DATE precision)
    type: membershipExpiryNotificationTypeEnum().notNull(),
    sentAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.userId, table.type, table.periodEndDate)]
);

export const handoffTokens = pgTable.withRLS("handoff_tokens", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ mode: "date" }).notNull(),
  usedAt: timestamp({ mode: "date" }),
  createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
});

export const emailVerificationTokens = pgTable.withRLS("email_verification_tokens", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => profiles.id, { onDelete: "cascade" }),
  token: text().notNull().unique(),
  expiresAt: timestamp({ mode: "date" }).notNull(),
  usedAt: timestamp({ mode: "date" }),
  createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
});

// User-editable preferences. Kept out of profiles because profiles only grants column-level UPDATE
// on full_name (server-managed columns like email_verified must stay read-only). A missing row means defaults.
export const userSettings = pgTable.withRLS(
  "user_settings",
  {
    userId: uuid()
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    taskPushNotifications: boolean().notNull().default(false),
  },
  (table) => [
    pgPolicy("user can manage own settings", {
      as: "permissive",
      to: authenticatedRole,
      for: "all",
      using: eq(table.userId, selectAuthUid),
      withCheck: eq(table.userId, selectAuthUid),
    }),
  ]
);

// Expo push tokens, one row per device. A device that switches accounts is reassigned on register.
export const pushTokens = pgTable.withRLS(
  "push_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    token: text().notNull().unique(),
    platform: text().$type<"ios" | "android">(),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
    lastUsedAt: timestamp({ mode: "date" }),
  },
  (table) => [
    pgPolicy("user can manage own push tokens", {
      as: "permissive",
      to: authenticatedRole,
      for: "all",
      using: eq(table.userId, selectAuthUid),
      withCheck: eq(table.userId, selectAuthUid),
    }),
  ]
);

export const donations = pgTable.withRLS(
  "donations",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid().references(() => profiles.id, { onDelete: "set null" }), // null = anonymous
    email: text().notNull(),
    stripePaymentId: text().notNull().unique(),
    amount: integer().notNull(), // CHF cents
    currency: text().notNull().default("chf"),
    status: donationStatusEnum().notNull().default("pending"),
    paymentMethodType: text(), // Stripe PaymentMethod.type, e.g. "card", "twint"
    cardLast4: text(),
    cardBrand: text(),
    createdAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [
    pgPolicy("user can read own donations", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.userId, selectAuthUid),
    }),
  ]
);

export const userRoleEnum = pgEnum("user_role", ["ADMIN", "USER", "CONTRACTOR"]);

export const parcels = pgTable.withRLS(
  "parcels",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    communalId: text().notNull(),
    gisId: integer(),
    geometry: polygon(),
    size: integer().notNull(),
  },

  (table) => [
    index("parcel_geometries_idx").using("gist", table.geometry),
    index("parcel_gisid_idx").on(table.gisId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);
export const cropRotations = pgTable.withRLS(
  "crop_rotations",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    cropId: uuid()
      .notNull()
      .references(() => crops.id),
    sowingDate: date({ mode: "date" }),
    fromDate: date({ mode: "date" }).notNull(),
    toDate: date({ mode: "date" }).notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const frequency = pgEnum("frequency", ["weekly", "monthly", "yearly"]);

export const taskStatus = pgEnum("task_status", ["todo", "done"]);

export const taskLinkType = pgEnum("task_link_type", [
  "animal",
  "plot",
  "contact",
  "order",
  "wiki_entry",
  "treatment",
  "herd",
  "parasite_check",
]);

export const weekday = pgEnum("weekday", ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]);

export const cropRotationYearlyRecurrences = pgTable.withRLS(
  "crop_rotation_yearly_recurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    cropRotationId: uuid("crop_rotation_id")
      .references(() => cropRotations.id, { onDelete: "cascade" })
      .notNull(),

    interval: integer("interval").default(1).notNull(),
    until: date({ mode: "date" }),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropRotationDraftPlans = pgTable.withRLS(
  "crop_rotation_draft_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    name: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdateFn(() => new Date()),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropRotationDraftPlanPlots = pgTable.withRLS(
  "crop_rotation_draft_plan_plots",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    draftPlanId: uuid()
      .notNull()
      .references(() => cropRotationDraftPlans.id, { onDelete: "cascade" }),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropRotationDraftPlanEntries = pgTable.withRLS(
  "crop_rotation_draft_plan_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    draftPlanPlotId: uuid()
      .notNull()
      .references(() => cropRotationDraftPlanPlots.id, { onDelete: "cascade" }),
    cropId: uuid()
      .notNull()
      .references(() => crops.id),
    sowingDate: date({ mode: "date" }),
    fromDate: date({ mode: "date" }).notNull(),
    toDate: date({ mode: "date" }).notNull(),
    recurrenceInterval: integer(),
    recurrenceUntil: date({ mode: "date" }),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const tillageReason = pgEnum("tillage_reason", [
  "weed_control",
  // "pest_control",
  "soil_loosening",
  "other",
]);

export const tillageAction = pgEnum("tillage_action", [
  // soil preparation
  "plowing",
  "tilling",
  "harrowing",
  "rolling",
  "rotavating",
  // weed control,
  "weed_harrowing", // striegel
  "hoeing",
  "flame_weeding",
  "custom",
]);

export const tillagePresets = pgTable.withRLS(
  "tillage_presets",
  {
    id: uuid().defaultRandom().primaryKey(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    reason: tillageReason(),
    action: tillageAction().notNull(),
    customAction: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const tillages = pgTable.withRLS(
  "tillages",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    reason: tillageReason(),
    action: tillageAction().notNull(),
    customAction: text(),
    date: date({ mode: "date" }).notNull(),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropProtectionUnit = pgEnum("crop_protection_unit", ["ml", "l", "g", "kg"]);

export const cropProtectionProducts = pgTable.withRLS(
  "crop_protection_products",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    unit: cropProtectionUnit().notNull(),
    description: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropProtectionApplicationMethod = pgEnum("crop_protection_application_method", [
  "spraying",
  "misting",
  "broadcasting",
  "injecting",
  "other",
]);

export const cropProtectionApplicationUnit = pgEnum("crop_protection_application_unit", [
  "load",
  "bag",
  "total_amount",
  "amount_per_hectare",
  "other",
]);

export const cropProtectionApplicationPresets = pgTable.withRLS(
  "crop_protection_application_presets",
  {
    id: uuid().defaultRandom().primaryKey(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    method: cropProtectionApplicationMethod(),
    unit: cropProtectionApplicationUnit().notNull(),
    customUnit: text(),
    amountPerUnit: real().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const cropProtectionApplications = pgTable.withRLS(
  "crop_protection_applications",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    dateTime: timestamp().notNull(),
    productId: uuid()
      .notNull()
      .references(() => cropProtectionProducts.id),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    method: cropProtectionApplicationMethod(),
    unit: cropProtectionApplicationUnit().notNull(),
    amountPerUnit: real().notNull(),
    numberOfUnits: real().notNull(),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const plots = pgTable.withRLS(
  "plots",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    localId: text(), // parcel number
    usage: integer(),
    cuttingDate: date({ mode: "date" }),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    additionalNotes: text(),
    // Archived plots are hidden from the plot list but keep their history (crop rotations, field calendar)
    archivedAt: timestamp({ withTimezone: true }),
  },

  (table) => [
    index("plot_geometries_idx").using("gist", table.geometry),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Overlay elements of the cantonal data (trees, Ackerschonstreifen, codes 921 to 928, 950, 951). They lie on top of
// real plots and are kept apart so they never show up as Schläge. external_id dedupes re-imports.
export const plotOverlays = pgTable.withRLS(
  "plot_overlays",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    localId: text(),
    usage: integer().notNull(),
    usageName: text(),
    size: integer().notNull(),
    geometry: polygon().notNull(),
    externalId: text().notNull(),
    source: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },

  (table) => [
    index("plot_overlays_geometries_idx").using("gist", table.geometry),
    unique("plot_overlays_farm_external_id_unique").on(table.farmId, table.externalId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const conservationMethod = pgEnum("conservation_method", ["dried", "silage", "haylage", "other", "none"]);

export const cropCategory = pgEnum("crop_category", ["grass", "grain", "vegetable", "fruit", "other"]);

export const cropFamilies = pgTable.withRLS(
  "crop_families",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    waitingTimeInYears: integer().notNull().default(0),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const crops = pgTable.withRLS(
  "crops",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    category: cropCategory().notNull(),
    familyId: uuid().references(() => cropFamilies.id, {
      onDelete: "set null",
    }),
    variety: text(),
    waitingTimeInYears: integer(),
    usageCodes: integer().array().notNull().default([]),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const harvestUnits = pgEnum("harvest_unit", [
  "load",
  "square_bale",
  "round_bale",
  "crate",
  "total_amount",
  "other",
]);

export const harvestPresets = pgTable.withRLS(
  "harvest_presets",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    unit: harvestUnits().notNull(),
    kilosPerUnit: real().notNull(),
    conservationMethod: conservationMethod(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const harvests = pgTable.withRLS(
  "harvests",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    date: date({ mode: "date" }).notNull(),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    cropId: uuid()
      .notNull()
      .references(() => crops.id),
    conservationMethod: conservationMethod(),
    unit: harvestUnits().notNull(),
    kilosPerUnit: real().notNull(),
    numberOfUnits: real().notNull(),
    harvestCount: integer(),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const fertilizerUnit = pgEnum("fertilizer_unit", ["l", "kg", "dt", "t"]);

export const animalSex = pgEnum("animal_sex", ["male", "female"]);

export const animalType = pgEnum("animal_type", ["goat", "sheep", "cow", "horse", "donkey", "pig", "deer"]);

export const deathReason = pgEnum("death_reason", ["died", "slaughtered"]);

export const productCategory = pgEnum("product_category", ["meat", "vegetables", "dairy", "eggs", "other"]);

export const productUnit = pgEnum("product_unit", ["kg", "g", "piece", "bunch", "liter"]);

export const orderStatus = pgEnum("order_status", ["pending", "confirmed", "fulfilled", "cancelled"]);

export const preferredCommunication = pgEnum("preferred_communication", ["email", "phone", "whatsapp"]);

export const contacts = pgTable.withRLS(
  "contacts",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    firstName: text().notNull(),
    lastName: text().notNull(),
    street: text(),
    city: text(),
    zip: text(),
    phone: text(),
    email: text(),
    preferredCommunication: preferredCommunication(),
    labels: text().array().notNull().default([]),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const products = pgTable.withRLS(
  "products",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    category: productCategory().notNull(),
    unit: productUnit().notNull(),
    pricePerUnit: real().notNull(),
    description: text(),
    active: boolean().notNull().default(true),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const orders = pgTable.withRLS(
  "orders",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, {
        onDelete: "cascade",
      }),
    status: orderStatus().notNull().default("pending"),
    orderDate: date({ mode: "date" }).notNull(),
    shippingDate: date({ mode: "date" }),
    notes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const orderItems = pgTable.withRLS(
  "order_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, {
        onDelete: "cascade",
      }),
    productId: uuid()
      .notNull()
      .references(() => products.id, {
        onDelete: "restrict",
      }),
    quantity: real().notNull(),
    unitPrice: real().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const paymentMethod = pgEnum("payment_method", ["cash", "bank_transfer", "twint", "card", "other"]);

export const sponsorshipPrograms = pgTable.withRLS(
  "sponsorship_programs",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    description: text(),
    yearlyCost: real().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const sponsorships = pgTable.withRLS(
  "sponsorships",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, {
        onDelete: "cascade",
      }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, {
        onDelete: "cascade",
      }),
    sponsorshipProgramId: uuid()
      .notNull()
      .references(() => sponsorshipPrograms.id, {
        onDelete: "restrict",
      }),
    startDate: date({ mode: "date" }).notNull(),
    endDate: date({ mode: "date" }),
    notes: text(),
    preferredCommunication: preferredCommunication(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const payments = pgTable.withRLS(
  "payments",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, {
        onDelete: "cascade",
      }),
    sponsorshipId: uuid().references(() => sponsorships.id, {
      onDelete: "set null",
    }),
    orderId: uuid().references(() => orders.id, {
      onDelete: "set null",
    }),
    date: date({ mode: "date" }).notNull(),
    amount: real().notNull(),
    currency: text().notNull().default("CHF"),
    method: paymentMethod().notNull(),
    notes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const fertilizerType = pgEnum("fertilizer_type", ["mineral", "organic"]);
export const fertilizationMethod = pgEnum("fertilization_method", ["spray", "spread", "other"]);

export const fertilizers = pgTable.withRLS(
  "fertilizers",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    description: text(),
    type: fertilizerType().notNull(),
    unit: fertilizerUnit().notNull(),
    // nitrogenPerUnit: real(),
    // phosphorusPerUnit: real(),
    // potassiumPerUnit: real(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const fertilizerApplicationUnit = pgEnum("fertilizer_application_unit", [
  "load",
  "bag",
  "total_amount",
  "amount_per_hectare",
  "other",
]);

export const fertilizerApplicationPresets = pgTable.withRLS(
  "fertilizer_application_presets",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    fertilizerId: uuid()
      .notNull()
      .references(() => fertilizers.id, {
        onDelete: "cascade",
      }),
    unit: fertilizerApplicationUnit().notNull(),
    method: fertilizationMethod(),
    amountPerUnit: real().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const fertilizerApplications = pgTable.withRLS(
  "fertilizer_applications",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    date: date({ mode: "date" }).notNull(),
    method: fertilizationMethod(),
    unit: fertilizerApplicationUnit().notNull(),
    amountPerUnit: real().notNull(),
    numberOfUnits: real().notNull(),
    fertilizerId: uuid()
      .references(() => fertilizers.id)
      .notNull(),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    additionalNotes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const earTags = pgTable.withRLS(
  "ear_tags",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    number: text().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const animalCategory = pgEnum("animal_category", [
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "A7",
  "A8",
  "A9",
  "B1",
  "B2",
  "B3",
  "C1",
  "C2",
  "D1",
  "D2",
  "D3",
  "E1",
  "E2",
  "E3",
  "E4",
  "F1",
  "F2",
]);

export const animalUsage = pgEnum("animal_usage", ["milk", "other"]);

export const animals = pgTable.withRLS(
  "animals",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    type: animalType().notNull(),
    usage: animalUsage().notNull(),
    sex: animalSex().notNull(),
    dateOfBirth: date({ mode: "date" }).notNull(),
    registered: boolean().notNull().default(false),
    earTagId: uuid().references(() => earTags.id, { onDelete: "restrict" }),
    motherId: uuid(),
    fatherId: uuid(),
    dateOfDeath: date({ mode: "date" }),
    deathReason: deathReason(),
    herdId: uuid().references(() => herds.id, { onDelete: "set null" }),
  },
  (table) => [
    foreignKey({
      columns: [table.motherId],
      foreignColumns: [table.id],
      name: "animals_mother_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.fatherId],
      foreignColumns: [table.id],
      name: "animals_father_fk",
    }).onDelete("set null"),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const herds = pgTable.withRLS(
  "herds",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const herdMemberships = pgTable.withRLS(
  "herd_memberships",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
    herdId: uuid()
      .notNull()
      .references(() => herds.id, { onDelete: "cascade" }),
    fromDate: date({ mode: "date" }).notNull(),
    toDate: date({ mode: "date" }), // null = still active
  },
  (table) => [
    index("herd_memberships_animal_id_idx").on(table.animalId),
    index("herd_memberships_herd_id_idx").on(table.herdId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const customOutdoorJournalCategories = pgTable.withRLS(
  "custom_outdoor_journal_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
    startDate: date({ mode: "date" }).notNull(),
    endDate: date({ mode: "date" }),
    category: animalCategory().notNull(),
  },
  (table) => [
    index("custom_outdoor_journal_categories_animal_id_idx").on(table.animalId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const meadows = pgTable.withRLS(
  "meadows",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    geometry: polygon().notNull(),
    size: integer().notNull(),
    additionalNotes: text(),
    // Archived meadows are hidden from the meadow list but keep their history in schedules and reports
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("meadow_geometries_idx").using("gist", table.geometry),
    // Target of composite FKs that guarantee referencing rows belong to the same farm
    unique("meadows_id_farm_id_unique").on(table.id, table.farmId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const outdoorScheduleType = pgEnum("outdoor_schedule_type", ["pasture", "exercise_yard"]);

export const outdoorSchedules = pgTable.withRLS(
  "outdoor_shedules",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    herdId: uuid()
      .notNull()
      .references(() => herds.id, { onDelete: "cascade" }),
    meadowId: uuid(),
    startDate: date({ mode: "date" }).notNull(),
    endDate: date({ mode: "date" }),
    type: outdoorScheduleType().notNull(),
    notes: text(),
  },
  (table) => [
    // Composite FK including farmId: FK checks bypass RLS, so this keeps a schedule from referencing another farm's
    // meadow. Deleting a meadow deletes its schedules (archive the meadow to keep its history).
    foreignKey({
      columns: [table.meadowId, table.farmId],
      foreignColumns: [meadows.id, meadows.farmId],
      name: "outdoor_schedules_meadow_farm_fk",
    }).onDelete("cascade"),
    index("outdoor_schedules_meadow_id_idx").on(table.meadowId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const outdoorScheduleRecurrences = pgTable.withRLS(
  "outdoor_schedule_recurrences",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    outdoorScheduleId: uuid("outdoor_schedule_id")
      .references(() => outdoorSchedules.id, { onDelete: "cascade" })
      .notNull(),

    frequency: frequency("frequency").notNull(),
    interval: integer("interval").default(1).notNull(),

    byWeekday: weekday("by_weekday").array(),
    byMonthDay: integer("by_month_day"),

    until: date("until"),
    count: integer("count"),
  },

  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const drugs = pgTable.withRLS(
  "drugs",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    name: text().notNull(),
    isAntibiotic: boolean().notNull().default(false),
    criticalAntibiotic: boolean().notNull(),
    receivedFrom: text().notNull(),
    notes: text(),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);
export const drugDoseUnit = pgEnum("drug_dose_unit", [
  "tablet",
  "capsule",
  "patch",
  "dose",
  "mg",
  "mcg",
  "g",
  "ml",
  "drop",
]);

export const drugDosePerUnit = pgEnum("dose_per_unit", ["kg", "animal", "day", "total_amount"]);

export const drugTreatment = pgTable.withRLS(
  "drug_treatment",
  {
    id: uuid().primaryKey().defaultRandom(),
    drugId: uuid()
      .notNull()
      .references(() => drugs.id, { onDelete: "cascade" }),
    animalType: animalType().notNull(),
    doseUnit: drugDoseUnit().notNull(),
    doseValue: real().notNull(),
    dosePerUnit: drugDosePerUnit().notNull(),
    milkWaitingDays: integer().notNull(),
    meatWaitingDays: integer().notNull(),
    organsWaitingDays: integer().notNull(),
  },
  (table) => [
    index("drug_treatment_drug_id_idx").on(table.drugId),
    unique("drug_treatment_drug_animal_unique").on(table.drugId, table.animalType),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`(SELECT current_setting('request.farm_id')::uuid) IN (SELECT farm_id FROM ${drugs} WHERE id = ${table.drugId})`,
    }),
  ]
);

export const treatments = pgTable.withRLS(
  "treatments",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, {
        onDelete: "cascade",
      }),
    drugId: uuid().references(() => drugs.id, { onDelete: "restrict" }),
    startDate: date({ mode: "date" }).notNull(),
    endDate: date({ mode: "date" }).notNull(),
    name: text().notNull(),
    notes: text(),
    drugDoseUnit: drugDoseUnit(),
    drugDoseValue: real(),
    drugDosePerUnit: drugDosePerUnit(),
    drugReceivedFrom: text(),
    isAntibiotic: boolean().notNull().default(false),
    criticalAntibiotic: boolean().notNull(),
    antibiogramAvailable: boolean().notNull(),
    milkUsableDate: date("milk_usable_date", { mode: "date" }),
    meatUsableDate: date("meat_usable_date", { mode: "date" }),
    organsUsableDate: date("organs_usable_date", { mode: "date" }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
  },
  (table) => [
    index("treatments_drug_id_idx").on(table.drugId),
    index("treatments_date_idx").on(table.startDate),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const animalTreatments = pgTable.withRLS(
  "animal_treatments",
  {
    id: uuid().primaryKey().defaultRandom(),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
    treatmentId: uuid()
      .notNull()
      .references(() => treatments.id, { onDelete: "cascade" }),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("animal_treatments_animal_id_idx").on(table.animalId),
    index("animal_treatments_treatment_id_idx").on(table.treatmentId),
    unique("animal_treatments_unique").on(table.animalId, table.treatmentId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Parasite control (worm monitoring): FAMACHA eyelid checks and lab fecal egg counts

export const parasiteCheckMethod = pgEnum("parasite_check_method", ["famacha", "fecal_egg_count"]);

export const parasiteType = pgEnum("parasite_type", [
  "strongyles",
  // Blood-sucking abomasal worm (part of the strongyles), only when the lab reports it separately
  "haemonchus",
  "nematodirus",
  "trichuris",
  "capillaria",
  "strongyloides",
  "moniezia",
  "coccidia",
  "liver_fluke",
  "small_liver_fluke",
  "lungworm",
  "other",
]);

export const parasiteChecks = pgTable.withRLS(
  "parasite_checks",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    date: date({ mode: "date" }).notNull(),
    // Optional own name; clients fall back to method and date
    name: text(),
    method: parasiteCheckMethod().notNull(),
    labName: text(),
    notes: text(),
    // Set when this check is a re-check of an earlier one (e.g. 2 weeks after treatment)
    previousCheckId: uuid(),
    // Action taken based on this check
    treatmentId: uuid().references(() => treatments.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    // Re-checks are deleted together with their base check
    foreignKey({ columns: [table.previousCheckId], foreignColumns: [table.id] }).onDelete("cascade"),
    index("parasite_checks_date_idx").on(table.date),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const parasiteCheckAnimals = pgTable.withRLS(
  "parasite_check_animals",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    checkId: uuid()
      .notNull()
      .references(() => parasiteChecks.id, { onDelete: "cascade" }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
    // FAMACHA score 1 (red, healthy) - 5 (white, severely anaemic); only for famacha checks
    famachaScore: integer(),
  },
  (table) => [
    unique("parasite_check_animals_unique").on(table.checkId, table.animalId),
    check("parasite_check_animals_famacha_score_range", sql`${table.famachaScore} between 1 and 5`),
    index("parasite_check_animals_animal_id_idx").on(table.animalId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const parasiteFecSamples = pgTable.withRLS(
  "parasite_fec_samples",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    checkId: uuid()
      .notNull()
      .references(() => parasiteChecks.id, { onDelete: "cascade" }),
    label: text(),
  },
  (table) => [
    index("parasite_fec_samples_check_id_idx").on(table.checkId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// One animal = individual sample, several animals = pooled sample
export const parasiteFecSampleAnimals = pgTable.withRLS(
  "parasite_fec_sample_animals",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    sampleId: uuid()
      .notNull()
      .references(() => parasiteFecSamples.id, { onDelete: "cascade" }),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("parasite_fec_sample_animals_unique").on(table.sampleId, table.animalId),
    index("parasite_fec_sample_animals_animal_id_idx").on(table.animalId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Labs report some parasites only semi-quantitatively (e.g. coccidia +/++/+++,
// tapeworm eggs detected or not)
export const parasiteResultGrade = pgEnum("parasite_result_grade", ["negative", "low", "medium", "high"]);

export const parasiteFecResults = pgTable.withRLS(
  "parasite_fec_results",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    sampleId: uuid()
      .notNull()
      .references(() => parasiteFecSamples.id, { onDelete: "cascade" }),
    parasiteType: parasiteType().notNull(),
    // Either a count: eggs, oocysts (coccidia) or larvae (lungworms) per gram of feces
    countPerGram: real(),
    // ... or a grade when the lab only reports + / ++ / +++
    grade: parasiteResultGrade(),
  },
  (table) => [
    unique("parasite_fec_results_unique").on(table.sampleId, table.parasiteType),
    check("parasite_fec_results_count_non_negative", sql`${table.countPerGram} >= 0`),
    check("parasite_fec_results_count_or_grade", sql`num_nonnulls(${table.countPerGram}, ${table.grade}) = 1`),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Wiki knowledgebase tables

export const wikiEntryStatus = pgEnum("wiki_entry_status", [
  "draft",
  "submitted",
  "under_review",
  "published",
  "rejected",
]);

export const wikiVisibility = pgEnum("wiki_visibility", ["private", "public"]);

export const wikiChangeRequestType = pgEnum("wiki_change_request_type", ["new_entry", "change_request"]);

export const wikiChangeRequestStatus = pgEnum("wiki_change_request_status", [
  "draft", // editable by submitter; moderator cannot act on it yet
  "under_review", // frozen; moderator is reviewing
  "approved",
  "rejected",
  "changes_requested", // moderator asked for revisions; submitter must update and resubmit
]);

export const wikiLocale = pgEnum("wiki_locale", ["de", "en", "it", "fr"]);

export const forumThreadTypeEnum = pgEnum("forum_thread_type", [
  "question",
  "feature_request",
  "bug_report",
  "general",
]);

export const forumThreadStatusEnum = pgEnum("forum_thread_status", ["open", "closed"]);

// Categories are admin-managed and dynamically created (not an enum).
// Defined before wiki_entries because wiki_entries holds a FK to this table.
export const wikiCategories = pgTable.withRLS(
  "wiki_categories",
  {
    id: uuid().primaryKey().defaultRandom(),
    slug: text().notNull().unique(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  () => [
    pgPolicy("authenticated users can read wiki categories", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
    // INSERT / UPDATE / DELETE handled exclusively via adminDrizzle (API key protected)
  ]
);

export const wikiCategoryTranslations = pgTable.withRLS(
  "wiki_category_translations",
  {
    id: uuid().primaryKey().defaultRandom(),
    categoryId: uuid()
      .notNull()
      .references(() => wikiCategories.id, { onDelete: "cascade" }),
    locale: wikiLocale().notNull(),
    name: text().notNull(),
  },
  (table) => [
    unique("wiki_category_translations_unique").on(table.categoryId, table.locale),
    index("wiki_category_translations_category_id_idx").on(table.categoryId),
    pgPolicy("authenticated users can read wiki category translations", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
  ]
);

export const wikiEntries = pgTable.withRLS(
  "wiki_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    status: wikiEntryStatus().notNull().default("draft"),
    visibility: wikiVisibility().notNull().default("private"),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    categoryId: uuid()
      .notNull()
      .references(() => wikiCategories.id, { onDelete: "restrict" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("wiki_entries_status_visibility_idx").on(table.status, table.visibility),
    // Can read: published public entries, or entries belonging to the current farm session
    pgPolicy("authenticated users can read wiki entries", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`(${table.status} = 'published'::wiki_entry_status AND ${table.visibility} = 'public'::wiki_visibility) OR ${table.farmId} = (SELECT current_setting('request.farm_id', TRUE)::uuid)`,
    }),
    // Farm members can create entries attributed to themselves within their current farm
    pgPolicy("farm members can create wiki entries", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: sql`${table.createdBy} = (SELECT auth.uid()) AND ${table.farmId} = (SELECT current_setting('request.farm_id', TRUE)::uuid)`,
    }),
    // Farm members can update private entries belonging to their farm
    pgPolicy("farm members can update private wiki entries", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: sql`${table.farmId} = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND ${table.visibility} = 'private'::wiki_visibility`,
      withCheck: sql`${table.farmId} = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND ${table.visibility} = 'private'::wiki_visibility`,
    }),
    // Farm members can delete private entries belonging to their farm
    pgPolicy("farm members can delete private wiki entries", {
      as: "permissive",
      to: authenticatedRole,
      for: "delete",
      using: sql`${table.farmId} = (SELECT current_setting('request.farm_id', TRUE)::uuid) AND ${table.visibility} = 'private'::wiki_visibility`,
    }),
  ]
);

export const wikiTags = pgTable.withRLS(
  "wiki_tags",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull().unique(),
    slug: text().notNull().unique(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
  },
  () => [
    pgPolicy("authenticated users can read wiki tags", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
    pgPolicy("authenticated users can create wiki tags", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: sql`true`,
    }),
  ]
);

export const wikiEntryTags = pgTable.withRLS(
  "wiki_entry_tags",
  {
    id: uuid().primaryKey().defaultRandom(),
    entryId: uuid()
      .notNull()
      .references(() => wikiEntries.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => wikiTags.id, { onDelete: "cascade" }),
  },
  (table) => [
    unique("wiki_entry_tags_unique").on(table.entryId, table.tagId),
    pgPolicy("follow entry access for entry tags", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`
        EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      `,
      withCheck: sql`EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))`,
    }),
  ]
);

export const wikiEntryTranslations = pgTable.withRLS(
  "wiki_entry_translations",
  {
    id: uuid().primaryKey().defaultRandom(),
    entryId: uuid()
      .notNull()
      .references(() => wikiEntries.id, { onDelete: "cascade" }),
    locale: wikiLocale().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
    updatedBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    unique("wiki_entry_translations_entry_locale_unique").on(table.entryId, table.locale),
    index("wiki_entry_translations_entry_id_idx").on(table.entryId),
    pgPolicy("follow entry access for translations", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`
        EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      `,
      withCheck: sql`EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))`,
    }),
  ]
);

export const wikiEntryImages = pgTable.withRLS(
  "wiki_entry_images",
  {
    id: uuid().primaryKey().defaultRandom(),
    // No FK to wikiEntries — images may be uploaded before the entry is created
    // (pre-generated UUID flow). Orphaned images are cleaned up by a cron job.
    entryId: uuid().notNull(),
    storagePath: text().notNull(),
    altText: text(),
    uploadedBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("wiki_entry_images_entry_id_idx").on(table.entryId),
    pgPolicy("follow entry access for images", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`
        EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.status = 'published'::wiki_entry_status AND we.visibility = 'public'::wiki_visibility)
        OR EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))
      `,
      withCheck: sql`EXISTS (SELECT 1 FROM ${wikiEntries} we WHERE we.id = ${table.entryId} AND we.farm_id = (SELECT current_setting('request.farm_id', TRUE)::uuid))`,
    }),
  ]
);

export const wikiChangeRequests = pgTable.withRLS(
  "wiki_change_requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    // For new_entry: optional back-reference to the source private entry (null if deleted).
    // For change_request: references the public entry being modified.
    entryId: uuid().references(() => wikiEntries.id, { onDelete: "set null" }),
    type: wikiChangeRequestType().notNull(),
    status: wikiChangeRequestStatus().notNull().default("draft"),
    submittedBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    // Snapshot fields for new_entry type — the proposed public entry content
    proposedCategoryId: uuid().references(() => wikiCategories.id, {
      onDelete: "set null",
    }),
    proposedFarmId: uuid().references(() => farms.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    resolvedAt: timestamp(),
  },
  (table) => [
    index("wiki_change_requests_entry_id_idx").on(table.entryId),
    index("wiki_change_requests_status_idx").on(table.status),
    pgPolicy("submitter can read own change requests", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.submittedBy, selectAuthUid),
    }),
    pgPolicy("authenticated can create change requests", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: eq(table.submittedBy, selectAuthUid),
    }),
    // Submitter can update their own draft CRs (edit content + resubmit).
    // Moderator actions (approve/reject/requestChanges) are performed via admin role.
    pgPolicy("submitter can update own draft change requests", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: and(
        eq(table.submittedBy, selectAuthUid),
        or(
          eq(table.status, sql`'draft'::wiki_change_request_status`),
          eq(table.status, sql`'changes_requested'::wiki_change_request_status`)
        )
      ),
      withCheck: eq(table.submittedBy, selectAuthUid),
    }),
  ]
);

export const wikiChangeRequestTranslations = pgTable.withRLS(
  "wiki_change_request_translations",
  {
    id: uuid().primaryKey().defaultRandom(),
    changeRequestId: uuid()
      .notNull()
      .references(() => wikiChangeRequests.id, { onDelete: "cascade" }),
    locale: wikiLocale().notNull(),
    title: text().notNull(),
    body: text().notNull().default(""),
  },
  (table) => [
    unique("wiki_cr_translations_unique").on(table.changeRequestId, table.locale),
    index("wiki_cr_translations_cr_id_idx").on(table.changeRequestId),
    pgPolicy("follow change request access for cr translations", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`(SELECT auth.uid()) IN (SELECT submitted_by FROM ${wikiChangeRequests} WHERE id = ${table.changeRequestId})`,
      withCheck: sql`(SELECT auth.uid()) IN (SELECT submitted_by FROM ${wikiChangeRequests} WHERE id = ${table.changeRequestId})`,
    }),
  ]
);

// Notes thread on a change request — used for communication between submitter and moderators
export const wikiChangeRequestNotes = pgTable.withRLS(
  "wiki_change_request_notes",
  {
    id: uuid().primaryKey().defaultRandom(),
    changeRequestId: uuid()
      .notNull()
      .references(() => wikiChangeRequests.id, { onDelete: "cascade" }),
    authorId: uuid().references(() => profiles.id, { onDelete: "set null" }),
    body: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("wiki_cr_notes_cr_id_idx").on(table.changeRequestId),
    // Submitter can read and write notes on their own CRs.
    // Moderators read/write via db.admin (bypasses RLS).
    pgPolicy("submitter can read and write notes on own change requests", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`(SELECT auth.uid()) IN (SELECT submitted_by FROM ${wikiChangeRequests} WHERE id = ${table.changeRequestId})`,
      withCheck: sql`(SELECT auth.uid()) IN (SELECT submitted_by FROM ${wikiChangeRequests} WHERE id = ${table.changeRequestId}) AND ${table.authorId} = (SELECT auth.uid())`,
    }),
  ]
);

export const wikiModerators = pgTable.withRLS(
  "wiki_moderators",
  {
    userId: uuid()
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    grantedBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    grantedAt: timestamp().notNull().defaultNow(),
  },
  () => [
    pgPolicy("authenticated users can read wiki moderators", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
    // INSERT/UPDATE/DELETE managed by service role only
  ]
);

// Platform-wide forum threads (not farm-scoped); any authenticated user can read and write
export const forumThreads = pgTable.withRLS(
  "forum_threads",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    body: text().notNull().default(""),
    type: forumThreadTypeEnum().notNull().default("general"),
    status: forumThreadStatusEnum().notNull().default("open"),
    isPinned: boolean("is_pinned").notNull().default(false),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("forum_threads_status_idx").on(table.status),
    index("forum_threads_type_idx").on(table.type),
    pgPolicy("authenticated users can read forum threads", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
    pgPolicy("authenticated users can create forum threads", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: eq(table.createdBy, selectAuthUid),
    }),
    pgPolicy("creator can update own forum threads", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: eq(table.createdBy, selectAuthUid),
      withCheck: eq(table.createdBy, selectAuthUid),
    }),
    pgPolicy("creator can delete own forum threads", {
      as: "permissive",
      to: authenticatedRole,
      for: "delete",
      using: eq(table.createdBy, selectAuthUid),
    }),
  ]
);

export const forumReplies = pgTable.withRLS(
  "forum_replies",
  {
    id: uuid().primaryKey().defaultRandom(),
    threadId: uuid()
      .notNull()
      .references(() => forumThreads.id, { onDelete: "cascade" }),
    body: text().notNull(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("forum_replies_thread_id_idx").on(table.threadId),
    pgPolicy("authenticated users can read forum replies", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
    pgPolicy("authenticated users can create forum replies", {
      as: "permissive",
      to: authenticatedRole,
      for: "insert",
      withCheck: eq(table.createdBy, selectAuthUid),
    }),
    pgPolicy("creator can update own forum replies", {
      as: "permissive",
      to: authenticatedRole,
      for: "update",
      using: eq(table.createdBy, selectAuthUid),
      withCheck: eq(table.createdBy, selectAuthUid),
    }),
    pgPolicy("creator can delete own forum replies", {
      as: "permissive",
      to: authenticatedRole,
      for: "delete",
      using: eq(table.createdBy, selectAuthUid),
    }),
  ]
);

// Moderator permission table — admin-managed, authenticated users can read (to check own status)
export const forumModerators = pgTable.withRLS(
  "forum_moderators",
  {
    userId: uuid()
      .primaryKey()
      .references(() => profiles.id, { onDelete: "cascade" }),
    grantedBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    grantedAt: timestamp().notNull().defaultNow(),
  },
  () => [
    pgPolicy("authenticated users can read forum moderators", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: sql`true`,
    }),
  ]
);

// Per-thread email subscriptions (GitHub-issues model). A row is written when a user creates a thread
// or replies; subscribed=false is an explicit mute that later replies must not override.
export const forumThreadSubscriptions = pgTable.withRLS(
  "forum_thread_subscriptions",
  {
    id: uuid().primaryKey().defaultRandom(),
    threadId: uuid()
      .notNull()
      .references(() => forumThreads.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    subscribed: boolean().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    unique("forum_thread_subscriptions_thread_user_unique").on(table.threadId, table.userId),
    pgPolicy("user can manage own forum thread subscriptions", {
      as: "permissive",
      to: authenticatedRole,
      for: "all",
      using: eq(table.userId, selectAuthUid),
      withCheck: eq(table.userId, selectAuthUid),
    }),
  ]
);

export const tasks = pgTable.withRLS(
  "tasks",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    labels: text().array().notNull().default([]),
    status: taskStatus().notNull().default("todo"),
    pinned: boolean().notNull().default(false),
    assigneeId: uuid().references(() => profiles.id, { onDelete: "set null" }),
    dueDate: date({ mode: "date" }),
    createdAt: timestamp().notNull().defaultNow(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// RLS enabled without policies: denies all access via PostgREST, only db.admin (task due cron) can read/write.
// Dedup log so each user is notified once per task due date.
export const taskDueNotifications = pgTable.withRLS(
  "task_due_notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    dueDate: date({ mode: "date" }).notNull(),
    sentAt: timestamp({ mode: "date" }).defaultNow().notNull(),
  },
  (table) => [unique().on(table.taskId, table.userId, table.dueDate)]
);

export const taskRecurrences = pgTable.withRLS(
  "task_recurrences",
  {
    id: uuid().defaultRandom().primaryKey(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    frequency: frequency("frequency").notNull(),
    interval: integer("interval").default(1).notNull(),
    byWeekday: weekday("by_weekday").array(),
    byMonthDay: integer("by_month_day"),
    until: date("until", { mode: "date" }),
    count: integer("count"),
  },
  (table) => [
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const taskLinks = pgTable.withRLS(
  "task_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    linkType: taskLinkType().notNull(),
    linkedId: uuid().notNull(),
  },
  (table) => [
    unique("task_links_unique").on(table.taskId, table.linkType, table.linkedId),
    index("task_links_task_id_idx").on(table.taskId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const taskChecklistItems = pgTable.withRLS(
  "task_checklist_items",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    taskId: uuid()
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text().notNull(),
    position: integer().notNull().default(0),
    dueDate: date({ mode: "date" }),
    done: boolean().notNull().default(false),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("task_checklist_items_task_id_idx").on(table.taskId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const farmInvites = pgTable.withRLS(
  "farm_invites",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    email: text().notNull(),
    code: text().notNull().unique(),
    role: farmRoleEnum().notNull().default("member"),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    expiresAt: timestamp().notNull(),
    usedAt: timestamp(),
  },
  (table) => [
    index("farm_invites_code_idx").on(table.code),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

// Stores the initial feature permissions to be applied when a farm invite is accepted.
// Features not listed default to "none". Rows are deleted via cascade when the invite is deleted.
export const farmInvitePermissions = pgTable.withRLS(
  "farm_invite_permissions",
  {
    id: uuid().primaryKey().defaultRandom(),
    inviteId: uuid()
      .notNull()
      .references(() => farmInvites.id, { onDelete: "cascade" }),
    feature: farmPermissionFeatureEnum().notNull(),
    access: text().$type<"none" | "read" | "write">().notNull().default("none"),
  },
  (table) => [
    unique("farm_invite_permissions_invite_feature_unique").on(table.inviteId, table.feature),
    pgPolicy("only farm members via invite", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`${table.inviteId} IN (SELECT id FROM farm_invites WHERE farm_id = farm_id())`,
      withCheck: sql`${table.inviteId} IN (SELECT id FROM farm_invites WHERE farm_id = farm_id())`,
    }),
  ]
);

export const farmMemberPermissions = pgTable.withRLS(
  "farm_member_permissions",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    feature: farmPermissionFeatureEnum().notNull(),
    // "none" = no access; "read" = read-only; "write" = full access
    access: text().$type<"none" | "read" | "write">().notNull().default("none"),
  },
  (table) => [
    unique("farm_member_permissions_farm_user_feature_unique").on(table.farmId, table.userId, table.feature),
    pgPolicy("farm members can read permissions", {
      as: "permissive",
      to: authenticatedRole,
      for: "select",
      using: eq(table.farmId, currentFarmId),
    }),
    // Write ops (insert/update/delete) are enforced in the app layer (owner only)
    pgPolicy("farm members can manage permissions", {
      as: "permissive",
      to: authenticatedRole,
      for: "all",
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const plotJournalEntries = pgTable.withRLS(
  "plot_journal_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    plotId: uuid()
      .notNull()
      .references(() => plots.id, { onDelete: "cascade" }),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    title: text().notNull(),
    date: date({ mode: "date" }).notNull(),
    content: text(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("plot_journal_entries_plot_id_idx").on(table.plotId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const plotJournalImages = pgTable.withRLS(
  "plot_journal_images",
  {
    id: uuid().primaryKey().defaultRandom(),
    // No FK to plotJournalEntries — pre-upload flow, same rationale as animalJournalImages
    journalEntryId: uuid().notNull(),
    storagePath: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("plot_journal_images_entry_id_idx").on(table.journalEntryId),
    pgPolicy("only farm members via journal entry", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`EXISTS (
        SELECT 1 FROM ${plotJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
      withCheck: sql`EXISTS (
        SELECT 1 FROM ${plotJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
    }),
  ]
);

export const animalJournalEntries = pgTable.withRLS(
  "animal_journal_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    animalId: uuid()
      .notNull()
      .references(() => animals.id, { onDelete: "cascade" }),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    title: text().notNull(),
    date: date({ mode: "date" }).notNull(),
    content: text(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("animal_journal_entries_animal_id_idx").on(table.animalId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const animalJournalImages = pgTable.withRLS(
  "animal_journal_images",
  {
    id: uuid().primaryKey().defaultRandom(),
    // No FK to animalJournalEntries — images may be uploaded before the entry is created
    // (pre-generated UUID flow). Orphaned images can be cleaned up by a cron job.
    journalEntryId: uuid().notNull(),
    storagePath: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("animal_journal_images_entry_id_idx").on(table.journalEntryId),
    pgPolicy("only farm members via journal entry", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`EXISTS (
        SELECT 1 FROM ${animalJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
      withCheck: sql`EXISTS (
        SELECT 1 FROM ${animalJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
    }),
  ]
);

export const farmJournalEntries = pgTable.withRLS(
  "farm_journal_entries",
  {
    id: uuid().primaryKey().defaultRandom(),
    farmId: uuid()
      .notNull()
      .references(() => farms.id, { onDelete: "cascade" }),
    title: text().notNull(),
    date: date({ mode: "date" }).notNull(),
    content: text(),
    createdBy: uuid().references(() => profiles.id, { onDelete: "set null" }),
    createdAt: timestamp().notNull().defaultNow(),
    updatedAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("farm_journal_entries_farm_id_idx").on(table.farmId),
    pgPolicy("only farm members", {
      as: "permissive",
      to: authenticatedRole,
      using: eq(table.farmId, currentFarmId),
      withCheck: eq(table.farmId, currentFarmId),
    }),
  ]
);

export const farmJournalImages = pgTable.withRLS(
  "farm_journal_images",
  {
    id: uuid().primaryKey().defaultRandom(),
    // No FK to farmJournalEntries — pre-upload flow, same rationale as animalJournalImages
    journalEntryId: uuid().notNull(),
    storagePath: text().notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (table) => [
    index("farm_journal_images_entry_id_idx").on(table.journalEntryId),
    pgPolicy("only farm members via journal entry", {
      as: "permissive",
      to: authenticatedRole,
      using: sql`EXISTS (
        SELECT 1 FROM ${farmJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
      withCheck: sql`EXISTS (
        SELECT 1 FROM ${farmJournalEntries} e
        WHERE e.id = ${table.journalEntryId}
        AND e.farm_id = (SELECT farm_id())
      )`,
    }),
  ]
);

// Schema object for defineRelations (contains all tables)
const tables = {
  federalFarmPlots,
  profiles,
  farms,
  farmMembers,
  parcels,
  cropRotations,
  cropRotationRecurrences: cropRotationYearlyRecurrences,
  cropRotationDraftPlans,
  cropRotationDraftPlanPlots,
  cropRotationDraftPlanEntries,
  tillagePresets,
  tillages,
  cropProtectionProducts,
  cropProtectionApplicationPresets,
  cropProtectionApplications,
  plots,
  cropFamilies,
  crops,
  harvestPresets,
  harvests,
  fertilizers,
  fertilizerApplicationPresets,
  fertilizerApplications,
  contacts,
  products,
  orders,
  orderItems,
  sponsorshipPrograms,
  sponsorships,
  payments,
  earTags,
  animals,
  drugs,
  drugTreatment,
  treatments,
  animalTreatments,
  herds,
  parasiteChecks,
  parasiteCheckAnimals,
  parasiteFecSamples,
  parasiteFecSampleAnimals,
  parasiteFecResults,
  herdMemberships,
  customOutdoorJournalCategories,
  outdoorSchedules,
  outdoorScheduleRecurrences,
  meadows,
  wikiCategories,
  wikiCategoryTranslations,
  wikiEntries,
  wikiTags,
  wikiEntryTags,
  wikiEntryTranslations,
  wikiEntryImages,
  wikiChangeRequests,
  wikiChangeRequestTranslations,
  wikiChangeRequestNotes,
  wikiModerators,
  forumThreads,
  forumReplies,
  forumModerators,
  tasks,
  taskRecurrences,
  taskLinks,
  taskChecklistItems,
  farmInvites,
  farmInvitePermissions,
  farmMemberPermissions,
  plotJournalEntries,
  plotJournalImages,
  animalJournalEntries,
  animalJournalImages,
  farmJournalEntries,
  farmJournalImages,
  userSubscriptions,
  userTrials,
  membershipPayments,
  membershipExpiryNotifications,
  donations,
  handoffTokens,
  pushTokens,
  taskDueNotifications,
  userSettings,
  emailVerificationTokens,
  invoiceSettings,
};

// Define all relations using the new Drizzle v1 API
export const relations = defineRelations(tables, (r) => ({
  profiles: {
    memberships: r.many.farmMembers(),
    handoffTokens: r.many.handoffTokens(),
    emailVerificationTokens: r.many.emailVerificationTokens(),
    pushTokens: r.many.pushTokens(),
    settings: r.one.userSettings({
      from: r.profiles.id,
      to: r.userSettings.userId,
    }),
  },
  pushTokens: {
    user: r.one.profiles({
      from: r.pushTokens.userId,
      to: r.profiles.id,
    }),
  },
  handoffTokens: {
    user: r.one.profiles({
      from: r.handoffTokens.userId,
      to: r.profiles.id,
    }),
  },
  emailVerificationTokens: {
    user: r.one.profiles({
      from: r.emailVerificationTokens.userId,
      to: r.profiles.id,
    }),
  },
  farms: {
    members: r.many.farmMembers(),
    parcels: r.many.parcels(),
    plots: r.many.plots(),
    harvests: r.many.harvests(),
    fertilizerApplications: r.many.fertilizerApplications(),
    invites: r.many.farmInvites(),
    journalEntries: r.many.farmJournalEntries(),
  },
  farmMembers: {
    farm: r.one.farms({
      from: r.farmMembers.farmId,
      to: r.farms.id,
      optional: false,
    }),
    user: r.one.profiles({
      from: r.farmMembers.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  userSubscriptions: {
    user: r.one.profiles({
      from: r.userSubscriptions.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  userTrials: {
    user: r.one.profiles({
      from: r.userTrials.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  membershipPayments: {
    user: r.one.profiles({
      from: r.membershipPayments.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  donations: {
    user: r.one.profiles({
      from: r.donations.userId,
      to: r.profiles.id,
    }),
  },
  farmInvites: {
    farm: r.one.farms({
      from: r.farmInvites.farmId,
      to: r.farms.id,
      optional: false,
    }),
    creator: r.one.profiles({
      from: r.farmInvites.createdBy,
      to: r.profiles.id,
      alias: "creator",
    }),
    permissions: r.many.farmInvitePermissions(),
  },
  farmInvitePermissions: {
    invite: r.one.farmInvites({
      from: r.farmInvitePermissions.inviteId,
      to: r.farmInvites.id,
      optional: false,
    }),
  },
  farmMemberPermissions: {
    farm: r.one.farms({
      from: r.farmMemberPermissions.farmId,
      to: r.farms.id,
      optional: false,
    }),
    user: r.one.profiles({
      from: r.farmMemberPermissions.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  parcels: {
    farm: r.one.farms({
      from: r.parcels.farmId,
      to: r.farms.id,
      optional: false,
    }),
  },
  crops: {
    family: r.one.cropFamilies({
      from: r.crops.familyId,
      to: r.cropFamilies.id,
    }),
  },
  cropRotations: {
    farm: r.one.farms({
      from: r.cropRotations.farmId,
      to: r.farms.id,
      optional: false,
    }),
    plot: r.one.plots({
      from: r.cropRotations.plotId,
      to: r.plots.id,
      optional: false,
    }),
    crop: r.one.crops({
      from: r.cropRotations.cropId,
      to: r.crops.id,
      optional: false,
    }),
    recurrence: r.one.cropRotationRecurrences({
      from: r.cropRotations.id,
      to: r.cropRotationRecurrences.cropRotationId,
    }),
  },
  cropRotationRecurrences: {
    cropRotation: r.one.cropRotations({
      from: r.cropRotationRecurrences.cropRotationId,
      to: r.cropRotations.id,
      optional: false,
    }),
  },
  cropRotationDraftPlans: {
    plots: r.many.cropRotationDraftPlanPlots(),
  },
  cropRotationDraftPlanPlots: {
    draftPlan: r.one.cropRotationDraftPlans({
      from: r.cropRotationDraftPlanPlots.draftPlanId,
      to: r.cropRotationDraftPlans.id,
      optional: false,
    }),
    plot: r.one.plots({
      from: r.cropRotationDraftPlanPlots.plotId,
      to: r.plots.id,
      optional: false,
    }),
    entries: r.many.cropRotationDraftPlanEntries(),
  },
  cropRotationDraftPlanEntries: {
    draftPlanPlot: r.one.cropRotationDraftPlanPlots({
      from: r.cropRotationDraftPlanEntries.draftPlanPlotId,
      to: r.cropRotationDraftPlanPlots.id,
      optional: false,
    }),
    crop: r.one.crops({
      from: r.cropRotationDraftPlanEntries.cropId,
      to: r.crops.id,
      optional: false,
    }),
  },
  tillagePresets: {
    farm: r.one.farms({
      from: r.tillagePresets.farmId,
      to: r.farms.id,
      optional: false,
    }),
  },
  tillages: {
    plot: r.one.plots({
      from: r.tillages.plotId,
      to: r.plots.id,
      optional: false,
    }),
  },
  cropProtectionApplicationPresets: {
    farm: r.one.farms({
      from: r.cropProtectionApplicationPresets.farmId,
      to: r.farms.id,
      optional: false,
    }),
  },
  cropProtectionApplications: {
    plot: r.one.plots({
      from: r.cropProtectionApplications.plotId,
      to: r.plots.id,
      optional: false,
    }),
    product: r.one.cropProtectionProducts({
      from: r.cropProtectionApplications.productId,
      to: r.cropProtectionProducts.id,
      optional: false,
    }),
  },
  plots: {
    farm: r.one.farms({
      from: r.plots.farmId,
      to: r.farms.id,
      optional: false,
    }),
    cropRotations: r.many.cropRotations(),
    harvests: r.many.harvests(),
    tillages: r.many.tillages(),
    cropProtectionApplications: r.many.cropProtectionApplications(),
    fertilizerApplications: r.many.fertilizerApplications(),
    journalEntries: r.many.plotJournalEntries(),
  },
  harvestPresets: {
    farm: r.one.farms({
      from: r.harvestPresets.farmId,
      to: r.farms.id,
      optional: false,
    }),
  },
  harvests: {
    farm: r.one.farms({
      from: r.harvests.farmId,
      to: r.farms.id,
      optional: false,
    }),
    plot: r.one.plots({
      from: r.harvests.plotId,
      to: r.plots.id,
      optional: false,
    }),
    crop: r.one.crops({
      from: r.harvests.cropId,
      to: r.crops.id,
      optional: false,
    }),
  },
  fertilizers: {
    farm: r.one.farms({
      from: r.fertilizers.farmId,
      to: r.farms.id,
      optional: false,
    }),
    fertilizerApplications: r.many.fertilizerApplications(),
    fertilizerApplicationPresets: r.many.fertilizerApplicationPresets(),
  },
  fertilizerApplicationPresets: {
    farm: r.one.farms({
      from: r.fertilizerApplicationPresets.farmId,
      to: r.farms.id,
      optional: false,
    }),
    fertilizer: r.one.fertilizers({
      from: r.fertilizerApplicationPresets.fertilizerId,
      to: r.fertilizers.id,
      optional: false,
    }),
  },
  fertilizerApplications: {
    fertilizer: r.one.fertilizers({
      from: r.fertilizerApplications.fertilizerId,
      to: r.fertilizers.id,
      optional: false,
    }),
    farm: r.one.farms({
      from: r.fertilizerApplications.farmId,
      to: r.farms.id,
      optional: false,
    }),
    plot: r.one.plots({
      from: r.fertilizerApplications.plotId,
      to: r.plots.id,
      optional: false,
    }),
  },
  contacts: {
    farm: r.one.farms({
      from: r.contacts.farmId,
      to: r.farms.id,
      optional: false,
    }),
    payments: r.many.payments(),
    sponsorships: r.many.sponsorships(),
    orders: r.many.orders(),
  },
  products: {
    farm: r.one.farms({
      from: r.products.farmId,
      to: r.farms.id,
      optional: false,
    }),
    orderItems: r.many.orderItems(),
  },
  orders: {
    farm: r.one.farms({
      from: r.orders.farmId,
      to: r.farms.id,
      optional: false,
    }),
    contact: r.one.contacts({
      from: r.orders.contactId,
      to: r.contacts.id,
      optional: false,
    }),
    items: r.many.orderItems(),
    payments: r.many.payments(),
  },
  orderItems: {
    farm: r.one.farms({
      from: r.orderItems.farmId,
      to: r.farms.id,
      optional: false,
    }),
    order: r.one.orders({
      from: r.orderItems.orderId,
      to: r.orders.id,
      optional: false,
    }),
    product: r.one.products({
      from: r.orderItems.productId,
      to: r.products.id,
      optional: false,
    }),
  },
  sponsorshipPrograms: {
    farm: r.one.farms({
      from: r.sponsorshipPrograms.farmId,
      to: r.farms.id,
      optional: false,
    }),
    sponsorships: r.many.sponsorships(),
  },
  sponsorships: {
    farm: r.one.farms({
      from: r.sponsorships.farmId,
      to: r.farms.id,
      optional: false,
    }),
    contact: r.one.contacts({
      from: r.sponsorships.contactId,
      to: r.contacts.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.sponsorships.animalId,
      to: r.animals.id,
      optional: false,
    }),
    sponsorshipProgram: r.one.sponsorshipPrograms({
      from: r.sponsorships.sponsorshipProgramId,
      to: r.sponsorshipPrograms.id,
      optional: false,
    }),
    payments: r.many.payments(),
  },
  payments: {
    farm: r.one.farms({
      from: r.payments.farmId,
      to: r.farms.id,
      optional: false,
    }),
    contact: r.one.contacts({
      from: r.payments.contactId,
      to: r.contacts.id,
      optional: false,
    }),
    sponsorship: r.one.sponsorships({
      from: r.payments.sponsorshipId,
      to: r.sponsorships.id,
    }), // optional - sponsorshipId can be null
    order: r.one.orders({
      from: r.payments.orderId,
      to: r.orders.id,
    }), // optional - orderId can be null
  },
  earTags: {
    farm: r.one.farms({
      from: r.earTags.farmId,
      to: r.farms.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.earTags.id,
      to: r.animals.earTagId,
    }), // optional - may not be assigned to any animal
  },
  animals: {
    farm: r.one.farms({
      from: r.animals.farmId,
      to: r.farms.id,
      optional: false,
    }),
    earTag: r.one.earTags({
      from: r.animals.earTagId,
      to: r.earTags.id,
    }), // optional - earTagId can be null
    mother: r.one.animals({
      from: r.animals.motherId,
      to: r.animals.id,
      alias: "mother",
    }), // optional - motherId can be null
    father: r.one.animals({
      from: r.animals.fatherId,
      to: r.animals.id,
      alias: "father",
    }), // optional - fatherId can be null
    childrenAsMother: r.many.animals({
      from: r.animals.id,
      to: r.animals.motherId,
      alias: "childrenAsMother",
    }),
    childrenAsFather: r.many.animals({
      from: r.animals.id,
      to: r.animals.fatherId,
      alias: "childrenAsFather",
    }),
    sponsorships: r.many.sponsorships(),
    animalTreatments: r.many.animalTreatments(),
    herd: r.one.herds({
      from: r.animals.herdId,
      to: r.herds.id,
    }),
    herdMemberships: r.many.herdMemberships(),
    customOutdoorJournalCategories: r.many.customOutdoorJournalCategories(),
    journalEntries: r.many.animalJournalEntries(),
  },
  customOutdoorJournalCategories: {
    farm: r.one.farms({
      from: r.customOutdoorJournalCategories.farmId,
      to: r.farms.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.customOutdoorJournalCategories.animalId,
      to: r.animals.id,
      optional: false,
    }),
  },
  herds: {
    farm: r.one.farms({
      from: r.herds.farmId,
      to: r.farms.id,
      optional: false,
    }),
    animals: r.many.animals(),
    herdMemberships: r.many.herdMemberships(),
    outdoorSchedules: r.many.outdoorSchedules(),
  },
  herdMemberships: {
    farm: r.one.farms({
      from: r.herdMemberships.farmId,
      to: r.farms.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.herdMemberships.animalId,
      to: r.animals.id,
      optional: false,
    }),
    herd: r.one.herds({
      from: r.herdMemberships.herdId,
      to: r.herds.id,
      optional: false,
    }),
  },
  outdoorSchedules: {
    farm: r.one.farms({
      from: r.outdoorSchedules.farmId,
      to: r.farms.id,
      optional: false,
    }),
    herd: r.one.herds({
      from: r.outdoorSchedules.herdId,
      to: r.herds.id,
      optional: false,
    }),
    meadow: r.one.meadows({
      from: r.outdoorSchedules.meadowId,
      to: r.meadows.id,
    }),
    recurrence: r.one.outdoorScheduleRecurrences(),
  },
  meadows: {
    farm: r.one.farms({
      from: r.meadows.farmId,
      to: r.farms.id,
      optional: false,
    }),
    outdoorSchedules: r.many.outdoorSchedules(),
  },
  outdoorScheduleRecurrences: {
    outdoorSchedule: r.one.outdoorSchedules({
      from: r.outdoorScheduleRecurrences.outdoorScheduleId,
      to: r.outdoorSchedules.id,
      optional: false,
    }),
  },
  drugs: {
    farm: r.one.farms({
      from: r.drugs.farmId,
      to: r.farms.id,
      optional: false,
    }),
    drugTreatment: r.many.drugTreatment(),
  },
  drugTreatment: {
    drug: r.one.drugs({
      from: r.drugTreatment.drugId,
      to: r.drugs.id,
      optional: false,
    }),
  },
  treatments: {
    farm: r.one.farms({
      from: r.treatments.farmId,
      to: r.farms.id,
      optional: false,
    }),
    drug: r.one.drugs({
      from: r.treatments.drugId,
      to: r.drugs.id,
    }),
    createdByProfile: r.one.profiles({
      from: r.treatments.createdBy,
      to: r.profiles.id,
    }), // optional - createdBy can be null
    animalTreatments: r.many.animalTreatments(),
  },
  animalTreatments: {
    animal: r.one.animals({
      from: r.animalTreatments.animalId,
      to: r.animals.id,
      optional: false,
    }),
    treatment: r.one.treatments({
      from: r.animalTreatments.treatmentId,
      to: r.treatments.id,
      optional: false,
    }),
  },
  parasiteChecks: {
    farm: r.one.farms({
      from: r.parasiteChecks.farmId,
      to: r.farms.id,
      optional: false,
    }),
    treatment: r.one.treatments({
      from: r.parasiteChecks.treatmentId,
      to: r.treatments.id,
    }),
    previousCheck: r.one.parasiteChecks({
      from: r.parasiteChecks.previousCheckId,
      to: r.parasiteChecks.id,
      alias: "previous_check",
    }),
    recheck: r.many.parasiteChecks({
      alias: "previous_check",
    }),
    animals: r.many.parasiteCheckAnimals(),
    fecSamples: r.many.parasiteFecSamples(),
  },
  parasiteCheckAnimals: {
    check: r.one.parasiteChecks({
      from: r.parasiteCheckAnimals.checkId,
      to: r.parasiteChecks.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.parasiteCheckAnimals.animalId,
      to: r.animals.id,
      optional: false,
    }),
  },
  parasiteFecSamples: {
    check: r.one.parasiteChecks({
      from: r.parasiteFecSamples.checkId,
      to: r.parasiteChecks.id,
      optional: false,
    }),
    animals: r.many.parasiteFecSampleAnimals(),
    results: r.many.parasiteFecResults(),
  },
  parasiteFecSampleAnimals: {
    sample: r.one.parasiteFecSamples({
      from: r.parasiteFecSampleAnimals.sampleId,
      to: r.parasiteFecSamples.id,
      optional: false,
    }),
    animal: r.one.animals({
      from: r.parasiteFecSampleAnimals.animalId,
      to: r.animals.id,
      optional: false,
    }),
  },
  parasiteFecResults: {
    sample: r.one.parasiteFecSamples({
      from: r.parasiteFecResults.sampleId,
      to: r.parasiteFecSamples.id,
      optional: false,
    }),
  },
  wikiCategories: {
    translations: r.many.wikiCategoryTranslations(),
    entries: r.many.wikiEntries(),
  },
  wikiCategoryTranslations: {
    category: r.one.wikiCategories({
      from: r.wikiCategoryTranslations.categoryId,
      to: r.wikiCategories.id,
      optional: false,
    }),
  },
  wikiEntries: {
    creator: r.one.profiles({
      from: r.wikiEntries.createdBy,
      to: r.profiles.id,
      optional: false,
    }),
    farm: r.one.farms({
      from: r.wikiEntries.farmId,
      to: r.farms.id,
    }),
    category: r.one.wikiCategories({
      from: r.wikiEntries.categoryId,
      to: r.wikiCategories.id,
      optional: false,
    }),
    translations: r.many.wikiEntryTranslations(),
    images: r.many.wikiEntryImages(),
    tags: r.many.wikiEntryTags(),
    changeRequests: r.many.wikiChangeRequests(),
  },
  wikiTags: {
    creator: r.one.profiles({
      from: r.wikiTags.createdBy,
      to: r.profiles.id,
    }),
    entries: r.many.wikiEntryTags(),
  },
  wikiEntryTags: {
    entry: r.one.wikiEntries({
      from: r.wikiEntryTags.entryId,
      to: r.wikiEntries.id,
      optional: false,
    }),
    tag: r.one.wikiTags({
      from: r.wikiEntryTags.tagId,
      to: r.wikiTags.id,
      optional: false,
    }),
  },
  wikiEntryTranslations: {
    entry: r.one.wikiEntries({
      from: r.wikiEntryTranslations.entryId,
      to: r.wikiEntries.id,
      optional: false,
    }),
  },
  wikiEntryImages: {
    entry: r.one.wikiEntries({
      from: r.wikiEntryImages.entryId,
      to: r.wikiEntries.id,
      optional: false,
    }),
  },
  wikiChangeRequests: {
    entry: r.one.wikiEntries({
      from: r.wikiChangeRequests.entryId,
      to: r.wikiEntries.id,
      optional: true,
    }),
    submitter: r.one.profiles({
      from: r.wikiChangeRequests.submittedBy,
      to: r.profiles.id,
      optional: false,
    }),
    translations: r.many.wikiChangeRequestTranslations(),
    notes: r.many.wikiChangeRequestNotes(),
  },
  wikiChangeRequestTranslations: {
    changeRequest: r.one.wikiChangeRequests({
      from: r.wikiChangeRequestTranslations.changeRequestId,
      to: r.wikiChangeRequests.id,
      optional: false,
    }),
  },
  wikiChangeRequestNotes: {
    changeRequest: r.one.wikiChangeRequests({
      from: r.wikiChangeRequestNotes.changeRequestId,
      to: r.wikiChangeRequests.id,
      optional: false,
    }),
    author: r.one.profiles({
      from: r.wikiChangeRequestNotes.authorId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  wikiModerators: {
    user: r.one.profiles({
      from: r.wikiModerators.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  forumThreads: {
    creator: r.one.profiles({
      from: r.forumThreads.createdBy,
      to: r.profiles.id,
      optional: false,
    }),
    replies: r.many.forumReplies(),
  },
  forumReplies: {
    thread: r.one.forumThreads({
      from: r.forumReplies.threadId,
      to: r.forumThreads.id,
      optional: false,
    }),
    creator: r.one.profiles({
      from: r.forumReplies.createdBy,
      to: r.profiles.id,
      optional: false,
    }),
  },
  forumModerators: {
    user: r.one.profiles({
      from: r.forumModerators.userId,
      to: r.profiles.id,
      optional: false,
    }),
  },
  tasks: {
    farm: r.one.farms({
      from: r.tasks.farmId,
      to: r.farms.id,
      optional: false,
    }),
    assignee: r.one.profiles({
      from: r.tasks.assigneeId,
      to: r.profiles.id,
    }),
    createdByProfile: r.one.profiles({
      from: r.tasks.createdBy,
      to: r.profiles.id,
    }),
    recurrence: r.one.taskRecurrences(),
    links: r.many.taskLinks(),
    checklistItems: r.many.taskChecklistItems(),
  },
  taskRecurrences: {
    task: r.one.tasks({
      from: r.taskRecurrences.taskId,
      to: r.tasks.id,
      optional: false,
    }),
  },
  taskLinks: {
    task: r.one.tasks({
      from: r.taskLinks.taskId,
      to: r.tasks.id,
      optional: false,
    }),
  },
  taskChecklistItems: {
    task: r.one.tasks({
      from: r.taskChecklistItems.taskId,
      to: r.tasks.id,
      optional: false,
    }),
  },
  plotJournalEntries: {
    plot: r.one.plots({
      from: r.plotJournalEntries.plotId,
      to: r.plots.id,
      optional: false,
    }),
    farm: r.one.farms({
      from: r.plotJournalEntries.farmId,
      to: r.farms.id,
      optional: false,
    }),
    images: r.many.plotJournalImages(),
  },
  plotJournalImages: {
    journalEntry: r.one.plotJournalEntries({
      from: r.plotJournalImages.journalEntryId,
      to: r.plotJournalEntries.id,
      optional: false,
    }),
  },
  animalJournalEntries: {
    animal: r.one.animals({
      from: r.animalJournalEntries.animalId,
      to: r.animals.id,
      optional: false,
    }),
    farm: r.one.farms({
      from: r.animalJournalEntries.farmId,
      to: r.farms.id,
      optional: false,
    }),
    images: r.many.animalJournalImages(),
  },
  animalJournalImages: {
    journalEntry: r.one.animalJournalEntries({
      from: r.animalJournalImages.journalEntryId,
      to: r.animalJournalEntries.id,
      optional: false,
    }),
  },
  farmJournalEntries: {
    farm: r.one.farms({
      from: r.farmJournalEntries.farmId,
      to: r.farms.id,
      optional: false,
    }),
    images: r.many.farmJournalImages(),
  },
  farmJournalImages: {
    journalEntry: r.one.farmJournalEntries({
      from: r.farmJournalImages.journalEntryId,
      to: r.farmJournalEntries.id,
      optional: false,
    }),
  },
}));

export const idSchema = z.object({ id: z.string() });
export const multiPolygonSchema = z.object({
  type: z.literal("MultiPolygon"),
  coordinates: z.array(z.array(z.array(z.array(z.number())))),
});

export const pointSchema = z.object({
  type: z.literal("Point"),
  coordinates: z.tuple([z.number(), z.number()]),
});

export const cropCategorySchema = z.enum(cropCategory.enumValues);
export const cropProtectionApplicationUnitSchema = z.enum(cropProtectionApplicationUnit.enumValues);
export const cropProtectionApplicationMethodSchema = z.enum(cropProtectionApplicationMethod.enumValues);
export const tillageActionSchema = z.enum(tillageAction.enumValues);
export const tillageReasonSchema = z.enum(tillageReason.enumValues);

export const cropProtectionUnitSchema = z.enum(cropProtectionUnit.enumValues);

export const harvestUnitsSchema = z.enum(harvestUnits.enumValues);
export const conservationMethodEnumSchema = z.enum(conservationMethod.enumValues);

export const fertilizerApplicationUnitSchema = z.enum(fertilizerApplicationUnit.enumValues);
export const fertilizerUnitSchema = z.enum(fertilizerUnit.enumValues);
export const fertilizerTypeSchema = z.enum(fertilizerType.enumValues);
export const fertilizationMethodSchema = z.enum(fertilizationMethod.enumValues);

export const animalTypeSchema = z.enum(animalType.enumValues);
export const animalUsageSchema = z.enum(animalUsage.enumValues);
export const animalCateogrySchema = z.enum(animalCategory.enumValues);
export const animalSexSchema = z.enum(animalSex.enumValues);
export const deathReasonSchema = z.enum(deathReason.enumValues);
export const drugDoseUnitSchema = z.enum(drugDoseUnit.enumValues);
export const drugDosePerUnitSchema = z.enum(drugDosePerUnit.enumValues);
export const outdoorScheduleTypeSchema = z.enum(outdoorScheduleType.enumValues);
export const parasiteCheckMethodSchema = z.enum(parasiteCheckMethod.enumValues);
export const parasiteTypeSchema = z.enum(parasiteType.enumValues);
export const parasiteResultGradeSchema = z.enum(parasiteResultGrade.enumValues);

export const preferredCommunicationSchema = z.enum(preferredCommunication.enumValues);

export const frequencySchema = z.enum(frequency.enumValues);
export const weekdaySchema = z.enum(weekday.enumValues);

export const paymentMethodSchema = z.enum(paymentMethod.enumValues);

export const productCategorySchema = z.enum(productCategory.enumValues);
export const productUnitSchema = z.enum(productUnit.enumValues);
export const orderStatusSchema = z.enum(orderStatus.enumValues);

export const farmPermissionFeatureSchema = z.enum(farmPermissionFeatureEnum.enumValues);
export type FarmPermissionFeature = z.infer<typeof farmPermissionFeatureSchema>;

export const wikiCategorySchema = z.object({
  id: z.string(),
  slug: z.string(),
  createdAt: z.string().or(z.date()),
  translations: z.array(
    z.object({
      id: z.string(),
      categoryId: z.string(),
      locale: z.enum(["de", "en", "it", "fr"]),
      name: z.string(),
    })
  ),
});

export const wikiEntryStatusSchema = z.enum(wikiEntryStatus.enumValues);
export const wikiVisibilitySchema = z.enum(wikiVisibility.enumValues);
export const wikiChangeRequestTypeSchema = z.enum(wikiChangeRequestType.enumValues);
export const wikiChangeRequestStatusSchema = z.enum(wikiChangeRequestStatus.enumValues);
export const wikiLocaleSchema = z.enum(wikiLocale.enumValues);

export const taskStatusSchema = z.enum(taskStatus.enumValues);
export const taskLinkTypeSchema = z.enum(taskLinkType.enumValues);

export const membershipPaymentStatusSchema = z.enum(membershipPaymentStatusEnum.enumValues);
export const donationStatusSchema = z.enum(donationStatusEnum.enumValues);

export const forumThreadTypeSchema = z.enum(forumThreadTypeEnum.enumValues);
export const forumThreadStatusSchema = z.enum(forumThreadStatusEnum.enumValues);
