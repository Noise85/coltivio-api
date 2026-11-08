import { expect } from "@jest/globals";
import merge from "lodash/merge";
import { createTestUser, getAdminDb, request } from "./helpers";
import { membershipPayments, userTrials } from "../db/schema";
import type { FarmPermissionFeature } from "../db/schema";

export type InvitePermission = { feature: FarmPermissionFeature; access: "none" | "read" | "write" };

// ---------------------------------------------------------------------------
// Common test data
// ---------------------------------------------------------------------------

const DEFAULT_FARM = {
  name: "Test Farm",
  address: "123 Farm St",
  location: { type: "Point" as const, coordinates: [8.5, 47.3] as [number, number] },
};

const DEFAULT_ANIMAL = {
  name: "Bella",
  type: "cow" as const,
  sex: "female" as const,
  dateOfBirth: "2020-01-15",
  registered: true,
  usage: "milk" as const,
};

const DEFAULT_HERD = {
  name: "Test Herd",
  animalIds: [] as string[],
};

const DEFAULT_PLOT = {
  name: "Test Plot",
  geometry: {
    type: "MultiPolygon" as const,
    coordinates: [
      [
        [
          [8.0, 47.0],
          [8.1, 47.0],
          [8.1, 47.1],
          [8.0, 47.1],
          [8.0, 47.0],
        ],
      ],
    ],
  },
  size: 10000,
};

const DEFAULT_CROP = {
  name: "Wheat",
  category: "grain" as const,
};

const DEFAULT_CROP_FAMILY = {
  name: "Legumes",
  waitingTimeInYears: 3,
};

const DEFAULT_DRUG = {
  name: "TestDrug",
  criticalAntibiotic: false,
  receivedFrom: "Vet Clinic",
  drugTreatment: [
    {
      animalType: "cow" as const,
      doseValue: 5,
      doseUnit: "ml" as const,
      dosePerUnit: "kg" as const,
      milkWaitingDays: 3,
      meatWaitingDays: 14,
      organsWaitingDays: 7,
    },
  ],
};

const DEFAULT_TREATMENT = {
  name: "Deworming",
  startDate: "2025-01-01",
  endDate: "2025-01-03",
  criticalAntibiotic: false,
  antibiogramAvailable: false,
};

const DEFAULT_FERTILIZER = {
  name: "Compost",
  type: "organic" as const,
  unit: "kg" as const,
};

const DEFAULT_CROP_PROTECTION_PRODUCT = {
  name: "Herbicide X",
  unit: "l" as const,
};

const DEFAULT_TILLAGE = {
  action: "plowing" as const,
  date: "2025-03-15",
};

const DEFAULT_CROP_ROTATION = {
  fromDate: "2025-03-01",
  toDate: "2025-10-31",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const TEST_GEOMETRY = DEFAULT_PLOT.geometry;

type ApiEntity = Record<string, unknown> & { id: string; farmId: string };

async function insertActiveMembership(userId: string) {
  const db = getAdminDb();
  const periodEnd = new Date();
  periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  await db.insert(membershipPayments).values({
    userId,
    stripePaymentId: `pi_test_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    stripeSubscriptionId: null,
    amount: 29000,
    currency: "chf",
    status: "succeeded",
    periodEnd,
  });
}

/**
 * Creates a user (no farm) with a paid membership — used for user-scoped
 * membership checks like the platform-wide forum.
 */
export async function createUserWithPaidMembership(email: string) {
  const { jwt, userId } = await createTestUser(email, "password123");
  await insertActiveMembership(userId);
  return { jwt, userId };
}

/**
 * Creates a user (no farm) with an active trial only — used to exercise the
 * "active but not paid" branch of user-scoped membership checks.
 */
export async function createUserWithTrial(email: string) {
  const { jwt, userId } = await createTestUser(email, "password123");
  const db = getAdminDb();
  const endsAt = new Date();
  endsAt.setDate(endsAt.getDate() + 30);
  await db.insert(userTrials).values({ userId, endsAt });
  return { jwt, userId };
}

export async function createUserWithFarm(
  data?: Record<string, unknown>,
  email = "test@test.com",
  opts: { withActiveMembership?: boolean } = {}
) {
  const { jwt, userId } = await createTestUser(email, "password123");

  const farmData = merge({}, DEFAULT_FARM, data);
  const res = await request("POST", "/v1/farm", farmData, jwt);
  const body = (await res.json()) as { data: { id: string } };
  const farmId = body.data.id;

  if (opts.withActiveMembership === true) {
    await insertActiveMembership(userId);
  }

  return { jwt, userId, farmId };
}

/**
 * Creates a second user, has the owner invite them, and accepts the invite.
 * The member gets an active membership by default (needed for write endpoints).
 */
export async function createFarmMember(
  ownerJwt: string,
  email: string,
  opts: { role?: "owner" | "member"; withActiveMembership?: boolean; permissions?: InvitePermission[] } = {}
) {
  const role = opts.role ?? "member";
  const { jwt, userId } = await createTestUser(email, "password123");

  const inviteRes = await request("POST", "/v1/farm/invites", { email, role, permissions: opts.permissions }, ownerJwt);
  expect(inviteRes.status).toBe(200);

  // Get the invite code from the DB — not returned by the API
  const db = getAdminDb();
  const invite = await db.query.farmInvites.findFirst({ where: { email } });
  expect(invite).toBeDefined();

  const acceptRes = await request("POST", "/v1/farm/invites/accept", { code: invite!.code }, jwt);
  expect(acceptRes.status).toBe(200);

  if (opts.withActiveMembership === true) {
    await insertActiveMembership(userId);
  }

  return { jwt, userId };
}

/**
 * Grants a farm member write access to a specific feature. Must be called with the owner's JWT.
 */
export async function grantMemberWriteAccess(ownerJwt: string, userId: string, feature: FarmPermissionFeature) {
  const res = await request(
    "PUT",
    `/v1/farm/members/byId/${userId}/permissions/byFeature/${feature}`,
    { access: "write" },
    ownerJwt
  );
  expect(res.status).toBe(200);
}

export async function createAnimal(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_ANIMAL, data);
  const res = await request("POST", "/v1/animals", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createHerd(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_HERD, data);
  const res = await request("POST", "/v1/animals/herds", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createPlot(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_PLOT, data);
  const res = await request("POST", "/v1/plots", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createCrop(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_CROP, data);
  const res = await request("POST", "/v1/crops", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createCropFamily(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_CROP_FAMILY, data);
  const res = await request("POST", "/v1/crops/families", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createDrug(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_DRUG, data);
  const res = await request("POST", "/v1/drugs", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createTreatment(jwt: string, animalIds: string[], data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_TREATMENT, data, { animalIds });
  const res = await request("POST", "/v1/treatments", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createFertilizer(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_FERTILIZER, data);
  const res = await request("POST", "/v1/fertilizers", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createCropProtectionProduct(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_CROP_PROTECTION_PRODUCT, data);
  const res = await request("POST", "/v1/cropProtectionProducts", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createTillage(jwt: string, plotId: string, data?: Record<string, unknown>) {
  const payload = merge(
    {},
    DEFAULT_TILLAGE,
    { plotId, geometry: DEFAULT_PLOT.geometry, size: DEFAULT_PLOT.size },
    data
  );
  const res = await request("POST", "/v1/tillages", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createCropRotation(jwt: string, plotId: string, cropId: string, data?: Record<string, unknown>) {
  const payload = merge({}, DEFAULT_CROP_ROTATION, { plotId, cropId }, data);
  const res = await request("POST", "/v1/cropRotations", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createHarvests(
  jwt: string,
  plotId: string,
  cropId: string,
  data?: {
    date?: string;
    unit?: string;
    kilosPerUnit?: number;
    numberOfUnits?: number;
    conservationMethod?: string;
  }
) {
  const res = await request(
    "POST",
    "/v1/harvests/batch",
    {
      date: data?.date ?? "2025-07-15",
      cropId,
      unit: data?.unit ?? "round_bale",
      kilosPerUnit: data?.kilosPerUnit ?? 300,
      conservationMethod: data?.conservationMethod,
      plots: [
        {
          plotId,
          geometry: DEFAULT_PLOT.geometry,
          size: DEFAULT_PLOT.size,
          numberOfUnits: data?.numberOfUnits ?? 5,
        },
      ],
    },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { result: Array<Record<string, unknown> & { id: string }>; count: number };
  };
  return body.data.result;
}

export async function createFertilizerApplication(
  jwt: string,
  plotId: string,
  fertilizerId: string,
  data?: {
    date?: string;
    unit?: string;
    amountPerUnit?: number;
    numberOfUnits?: number;
    method?: string;
  }
) {
  const res = await request(
    "POST",
    "/v1/fertilizerApplications",
    {
      date: data?.date ?? "2025-04-15",
      unit: data?.unit ?? "load",
      amountPerUnit: data?.amountPerUnit ?? 500,
      method: data?.method,
      fertilizerId,
      plots: [
        {
          plotId,
          numberOfUnits: data?.numberOfUnits ?? 3,
          geometry: DEFAULT_PLOT.geometry,
          size: DEFAULT_PLOT.size,
        },
      ],
    },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    data: { result: Array<Record<string, unknown> & { id: string }>; count: number };
  };
  return body.data.result;
}

export async function createCropProtectionApplication(
  jwt: string,
  plotId: string,
  productId: string,
  data?: {
    dateTime?: string;
    unit?: string;
    amountPerUnit?: number;
    numberOfUnits?: number;
    method?: string;
  }
) {
  const res = await request(
    "POST",
    "/v1/cropProtectionApplications",
    {
      plotId,
      dateTime: data?.dateTime ?? "2025-06-15T08:00:00Z",
      productId,
      geometry: DEFAULT_PLOT.geometry,
      size: DEFAULT_PLOT.size,
      unit: data?.unit ?? "amount_per_hectare",
      amountPerUnit: data?.amountPerUnit ?? 2.5,
      numberOfUnits: data?.numberOfUnits ?? 10,
      method: data?.method,
    },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> & { id: string } };
  return body.data;
}

export async function createContact(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, { firstName: "Hans", lastName: "Muster", labels: [] }, data);
  const res = await request("POST", "/v1/contacts", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createProduct(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, { name: "Test Product", category: "meat", unit: "kg", pricePerUnit: 50 }, data);
  const res = await request("POST", "/v1/products", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createOrder(
  jwt: string,
  contactId: string,
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>,
  data?: Record<string, unknown>
) {
  const payload = merge({}, { contactId, orderDate: "2026-03-01", items }, data);
  const res = await request("POST", "/v1/orders", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createPayment(jwt: string, _contactId: string, data?: Record<string, unknown>) {
  const { orderId, sponsorshipId, ...rest } = (data ?? {}) as Record<string, unknown>;
  const payload = merge({}, { date: "2026-03-01", amount: 100, currency: "CHF", method: "bank_transfer" }, rest);
  let url: string;
  if (orderId) {
    url = `/v1/orders/byId/${orderId}/payments`;
  } else if (sponsorshipId) {
    url = `/v1/sponsorships/byId/${sponsorshipId}/payments`;
  } else {
    throw new Error("createPayment requires either orderId or sponsorshipId");
  }
  const res = await request("POST", url, payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createSponsorshipProgram(jwt: string, data?: Record<string, unknown>) {
  const payload = merge({}, { name: "Basic Sponsorship", yearlyCost: 200 }, data);
  const res = await request("POST", "/v1/sponsorshipPrograms", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createSponsorship(
  jwt: string,
  contactId: string,
  animalId: string,
  sponsorshipProgramId: string,
  data?: Record<string, unknown>
) {
  const payload = merge({}, { contactId, animalId, sponsorshipProgramId, startDate: "2026-01-01" }, data);
  const res = await request("POST", "/v1/sponsorships", payload, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiEntity }).data;
}

export async function createOutdoorSchedule(
  jwt: string,
  herdId: string,
  data?: {
    startDate?: string;
    endDate?: string;
    type?: string;
    notes?: string;
    recurrence?: Record<string, unknown>;
  }
) {
  const res = await request(
    "POST",
    `/v1/animals/herds/byId/${herdId}/outdoorSchedules`,
    {
      startDate: data?.startDate ?? "2025-05-01",
      endDate: data?.endDate ?? "2025-09-30",
      type: data?.type ?? "pasture",
      notes: data?.notes,
      recurrence: data?.recurrence,
    },
    jwt
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown> & { id: string } };
  return body.data;
}
