// jest.mock is hoisted before imports by Jest — only the HTTP call to Expo is mocked
jest.mock("../push/expo-client", () => ({
  ...jest.requireActual<typeof import("../push/expo-client")>("../push/expo-client"),
  postToExpo: jest.fn(),
}));

import { describe, it, expect, beforeAll, beforeEach, jest } from "@jest/globals";
import i18next from "i18next";
import de from "../../resources/locales/de.json";
import en from "../../resources/locales/en.json";
import itLocale from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import { postToExpo, PushMessage } from "../push/expo-client";
import { runBreedingReminderNotifications } from "../animals/breeding-reminder-cron";
import { cleanDb, request } from "./helpers";
import { createAnimal, createFarmMember, createUserWithFarm } from "./test-utils";

const mockPostToExpo = jest.mocked(postToExpo);

type HeatResponse = { id: string; animalId: string; date: string; mated: boolean; sireId: string | null };
type CalendarEntry = HeatResponse & {
  expectedBirthDate: string | null;
  conceptionFailed: boolean;
  animal: { id: string; name: string };
  sire: { id: string; name: string } | null;
};
type GestationSetting = { animalType: string; gestationDays: number; isDefault: boolean };

async function addHeat(jwt: string, animalId: string, data: Record<string, unknown>) {
  const res = await request("POST", `/v1/animals/byId/${animalId}/heats`, data, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: HeatResponse }).data;
}

async function getCalendar(jwt: string, from: string, to: string): Promise<CalendarEntry[]> {
  const res = await request("GET", `/v1/animals/breedingCalendar?from=${from}&to=${to}`, undefined, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { result: CalendarEntry[] } }).data.result;
}

function sentMessages(): PushMessage[] {
  return mockPostToExpo.mock.calls.flatMap(([messages]) => messages);
}

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      resources: {
        de: { translation: de },
        en: { translation: en },
        it: { translation: itLocale },
        fr: { translation: fr },
      },
      fallbackLng: "de",
      preload: ["de", "en", "it", "fr"],
    });
  }
});

beforeEach(async () => {
  await cleanDb();
  mockPostToExpo.mockReset();
  mockPostToExpo.mockImplementation(async (messages) =>
    messages.map((_message, index) => ({ status: "ok", id: `ticket-${index}` }))
  );
});

describe("Animal heats", () => {
  it("creates, lists, updates and deletes heats with an optional sire", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { name: "Zicklein", type: "goat", usage: "other" });
    const buck = await createAnimal(jwt, { name: "Bock", type: "goat", sex: "male", usage: "other" });

    const heat = await addHeat(jwt, goat.id, { date: "2025-10-01" });
    expect(heat.mated).toBe(false);
    await addHeat(jwt, goat.id, { date: "2025-10-22", mated: true, sireId: buck.id });

    const listRes = await request("GET", `/v1/animals/byId/${goat.id}/heats`, undefined, jwt);
    const list = ((await listRes.json()) as { data: { result: HeatResponse[] } }).data.result;
    // Newest first
    expect(list.map((entry) => entry.date.slice(0, 10))).toEqual(["2025-10-22", "2025-10-01"]);
    expect(list[0].sireId).toBe(buck.id);

    const patchRes = await request(
      "PATCH",
      `/v1/animals/heats/byId/${heat.id}`,
      { mated: true, sireName: "Nachbar" },
      jwt
    );
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { data: HeatResponse }).data.mated).toBe(true);

    const deleteRes = await request("DELETE", `/v1/animals/heats/byId/${heat.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(200);
    const afterDelete = await request("GET", `/v1/animals/byId/${goat.id}/heats`, undefined, jwt);
    expect(((await afterDelete.json()) as { data: { result: HeatResponse[] } }).data.result).toHaveLength(1);
  });

  it("rejects heats for an animal or sire of another farm", async () => {
    const { jwt: otherJwt } = await createUserWithFarm({}, "other@test.com");
    const otherGoat = await createAnimal(otherJwt, { type: "goat", usage: "other" });
    const otherBuck = await createAnimal(otherJwt, { type: "goat", sex: "male", usage: "other" });
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", usage: "other" });

    const foreignAnimalRes = await request(
      "POST",
      `/v1/animals/byId/${otherGoat.id}/heats`,
      { date: "2025-10-01" },
      jwt
    );
    expect(foreignAnimalRes.status).toBe(404);
    const foreignSireRes = await request(
      "POST",
      `/v1/animals/byId/${goat.id}/heats`,
      { date: "2025-10-01", mated: true, sireId: otherBuck.id },
      jwt
    );
    expect(foreignSireRes.status).toBe(404);
  });

  it("returns 404 when patching or deleting a heat of another farm or a missing one", async () => {
    const { jwt: otherJwt } = await createUserWithFarm({}, "other@test.com");
    const otherGoat = await createAnimal(otherJwt, { type: "goat", usage: "other" });
    const otherHeat = await addHeat(otherJwt, otherGoat.id, { date: "2025-10-01" });
    const { jwt } = await createUserWithFarm();

    const patchRes = await request("PATCH", `/v1/animals/heats/byId/${otherHeat.id}`, { mated: true }, jwt);
    expect(patchRes.status).toBe(404);
    const deleteRes = await request("DELETE", `/v1/animals/heats/byId/${otherHeat.id}`, undefined, jwt);
    expect(deleteRes.status).toBe(404);
    const missingRes = await request(
      "DELETE",
      "/v1/animals/heats/byId/00000000-0000-0000-0000-000000000000",
      undefined,
      jwt
    );
    expect(missingRes.status).toBe(404);

    const listRes = await request("GET", `/v1/animals/byId/${otherGoat.id}/heats`, undefined, otherJwt);
    const list = ((await listRes.json()) as { data: { result: HeatResponse[] } }).data.result;
    expect(list).toHaveLength(1);
    expect(list[0].mated).toBe(false);
  });

  it("rejects the animal itself or a female as sire", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", sex: "female", usage: "other" });
    const otherDoe = await createAnimal(jwt, { type: "goat", sex: "female", usage: "other" });

    const selfRes = await request(
      "POST",
      `/v1/animals/byId/${goat.id}/heats`,
      { date: "2025-10-01", mated: true, sireId: goat.id },
      jwt
    );
    expect(selfRes.status).toBe(400);
    expect(((await selfRes.json()) as { code: string }).code).toBe("invalid_sire");

    const femaleRes = await request(
      "POST",
      `/v1/animals/byId/${goat.id}/heats`,
      { date: "2025-10-01", mated: true, sireId: otherDoe.id },
      jwt
    );
    expect(femaleRes.status).toBe(400);

    const heat = await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true });
    const patchRes = await request("PATCH", `/v1/animals/heats/byId/${heat.id}`, { sireId: goat.id }, jwt);
    expect(patchRes.status).toBe(400);
    expect(((await patchRes.json()) as { code: string }).code).toBe("invalid_sire");
  });

  it("requires animals write access to add heats", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm();
    const goat = await createAnimal(ownerJwt, { type: "goat", usage: "other" });
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "reader@test.com", {
      permissions: [{ feature: "animals", access: "read" }],
    });
    const res = await request("POST", `/v1/animals/byId/${goat.id}/heats`, { date: "2025-10-01" }, memberJwt);
    expect(res.status).toBe(403);
  });
});

describe("Breeding calendar", () => {
  it("computes expected birth dates from gestation defaults and farm overrides", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { name: "Zicklein", type: "goat", usage: "other" });
    const buck = await createAnimal(jwt, { name: "Bock", type: "goat", sex: "male", usage: "other" });
    await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true, sireId: buck.id });
    // Unmated heats are listed without a birth date
    await addHeat(jwt, goat.id, { date: "2025-09-10" });

    const calendar = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    const mated = calendar.find((entry) => entry.mated);
    // 2025-10-01 + 150 days
    expect(mated?.expectedBirthDate?.slice(0, 10)).toBe("2026-02-28");
    expect(mated?.animal.name).toBe("Zicklein");
    expect(mated?.sire?.name).toBe("Bock");
    expect(calendar.find((entry) => !entry.mated)?.expectedBirthDate).toBeNull();

    const putRes = await request(
      "PUT",
      "/v1/animals/breedingCalendar/gestationSettings",
      { settings: [{ animalType: "goat", gestationDays: 145 }] },
      jwt
    );
    expect(putRes.status).toBe(200);
    const settings = ((await putRes.json()) as { data: { result: GestationSetting[] } }).data.result;
    expect(settings.find((setting) => setting.animalType === "goat")).toEqual({
      animalType: "goat",
      gestationDays: 145,
      isDefault: false,
    });
    expect(settings.find((setting) => setting.animalType === "cow")).toEqual({
      animalType: "cow",
      gestationDays: 283,
      isDefault: true,
    });

    const updatedCalendar = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    expect(updatedCalendar.find((entry) => entry.mated)?.expectedBirthDate?.slice(0, 10)).toBe("2026-02-23");

    // Births in range are included even when the heat itself is before the range
    const birthOnlyRange = await getCalendar(jwt, "2026-02-01", "2026-03-31");
    expect(birthOnlyRange).toHaveLength(1);
    expect(birthOnlyRange[0].mated).toBe(true);

    // null resets to the default
    const resetRes = await request(
      "PUT",
      "/v1/animals/breedingCalendar/gestationSettings",
      { settings: [{ animalType: "goat", gestationDays: null }] },
      jwt
    );
    const resetSettings = ((await resetRes.json()) as { data: { result: GestationSetting[] } }).data.result;
    expect(resetSettings.find((setting) => setting.animalType === "goat")?.isDefault).toBe(true);
  });

  it("includes births on the last day of the range", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", usage: "other" });
    // 2025-10-01 + 150 days = 2026-02-28, the range ends on that day
    await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true });
    const calendar = await getCalendar(jwt, "2026-02-01", "2026-02-28");
    expect(calendar).toHaveLength(1);
    expect(calendar[0].expectedBirthDate?.slice(0, 10)).toBe("2026-02-28");
  });

  it("finds births of long gestations configured above the default", async () => {
    const { jwt } = await createUserWithFarm();
    const donkey = await createAnimal(jwt, { type: "donkey", usage: "other" });
    await request(
      "PUT",
      "/v1/animals/breedingCalendar/gestationSettings",
      { settings: [{ animalType: "donkey", gestationDays: 450 }] },
      jwt
    );
    // 2025-01-01 + 450 days = 2026-03-27
    await addHeat(jwt, donkey.id, { date: "2025-01-01", mated: true });
    const calendar = await getCalendar(jwt, "2026-03-01", "2026-03-31");
    expect(calendar).toHaveLength(1);
    expect(calendar[0].expectedBirthDate?.slice(0, 10)).toBe("2026-03-27");
  });

  it("treats a mating followed by another heat two weeks or more later as not conceived", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", usage: "other" });
    const firstMating = await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true });
    // The same heat logged again the next day doesn't make the mating fail
    await addHeat(jwt, goat.id, { date: "2025-10-02" });
    const afterRepeatedHeat = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    expect(afterRepeatedHeat.find((entry) => entry.id === firstMating.id)?.conceptionFailed).toBe(false);
    // Bockig again three weeks later and mated again: the first mating didn't work
    const secondMating = await addHeat(jwt, goat.id, { date: "2025-10-22", mated: true });

    const calendar = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    const first = calendar.find((entry) => entry.id === firstMating.id);
    const second = calendar.find((entry) => entry.id === secondMating.id);
    expect(first?.conceptionFailed).toBe(true);
    expect(first?.expectedBirthDate).toBeNull();
    expect(second?.conceptionFailed).toBe(false);
    // 2025-10-22 + 150 days
    expect(second?.expectedBirthDate?.slice(0, 10)).toBe("2026-03-21");

    const listRes = await request("GET", `/v1/animals/byId/${goat.id}/heats`, undefined, jwt);
    const heats = (
      (await listRes.json()) as {
        data: { result: { id: string; conceptionFailed: boolean; expectedBirthDate: string | null }[] };
      }
    ).data.result;
    expect(heats.find((heat) => heat.id === firstMating.id)?.conceptionFailed).toBe(true);
    expect(heats.find((heat) => heat.id === secondMating.id)?.expectedBirthDate?.slice(0, 10)).toBe("2026-03-21");
  });

  it("marks a mating as failed when only an unmated heat follows three weeks later", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", usage: "other" });
    const mating = await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true });
    await addHeat(jwt, goat.id, { date: "2025-10-22" });
    const calendar = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    const entry = calendar.find((calendarEntry) => calendarEntry.id === mating.id);
    expect(entry?.conceptionFailed).toBe(true);
    expect(entry?.expectedBirthDate).toBeNull();
  });

  it("counts two matings in the same heat as one, the last one carries the expected birth", async () => {
    const { jwt } = await createUserWithFarm();
    const cow = await createAnimal(jwt, { type: "cow" });
    // Inseminated twice in one heat
    const firstInsemination = await addHeat(jwt, cow.id, { date: "2025-10-01", mated: true });
    const secondInsemination = await addHeat(jwt, cow.id, { date: "2025-10-02", mated: true });
    const calendar = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    const first = calendar.find((entry) => entry.id === firstInsemination.id);
    const second = calendar.find((entry) => entry.id === secondInsemination.id);
    expect(first).toMatchObject({ conceptionFailed: false, expectedBirthDate: null });
    expect(second?.conceptionFailed).toBe(false);
    // 2025-10-02 + 283 days
    expect(second?.expectedBirthDate?.slice(0, 10)).toBe("2026-07-12");

    // Back in heat three weeks later: both matings of the first heat failed
    await addHeat(jwt, cow.id, { date: "2025-10-23" });
    const afterRepeatHeat = await getCalendar(jwt, "2025-09-01", "2026-12-31");
    expect(afterRepeatHeat.find((entry) => entry.id === firstInsemination.id)?.conceptionFailed).toBe(true);
    expect(afterRepeatHeat.find((entry) => entry.id === secondInsemination.id)).toMatchObject({
      conceptionFailed: true,
      expectedBirthDate: null,
    });
  });

  it("excludes dead animals", async () => {
    const { jwt } = await createUserWithFarm();
    const goat = await createAnimal(jwt, { type: "goat", usage: "other" });
    await addHeat(jwt, goat.id, { date: "2025-10-01", mated: true });
    await request("PATCH", `/v1/animals/byId/${goat.id}`, { dateOfDeath: "2025-11-01", deathReason: "died" }, jwt);
    expect(await getCalendar(jwt, "2025-09-01", "2026-12-31")).toHaveLength(0);
  });

  it("only lets owners change gestation settings", async () => {
    const { jwt: ownerJwt } = await createUserWithFarm();
    const { jwt: memberJwt } = await createFarmMember(ownerJwt, "writer@test.com", {
      permissions: [{ feature: "animals", access: "write" }],
    });
    const getRes = await request("GET", "/v1/animals/breedingCalendar/gestationSettings", undefined, memberJwt);
    expect(getRes.status).toBe(200);
    const putRes = await request(
      "PUT",
      "/v1/animals/breedingCalendar/gestationSettings",
      { settings: [{ animalType: "goat", gestationDays: 145 }] },
      memberJwt
    );
    expect(putRes.status).toBe(403);
  });
});

describe("Breeding reminder push", () => {
  // 10:00 in Zurich
  const NOW = new Date("2026-02-21T09:00:00Z");

  async function setupGoatDueOn2026_02_28() {
    const owner = await createUserWithFarm();
    const goat = await createAnimal(owner.jwt, { name: "Zicklein", type: "goat", usage: "other" });
    // 2025-10-01 + 150 days = 2026-02-28
    await addHeat(owner.jwt, goat.id, { date: "2025-10-01", mated: true });
    const tokenRes = await request(
      "POST",
      "/v1/me/push-tokens",
      { token: "ExponentPushToken[owner]", platform: "ios" },
      owner.jwt
    );
    expect(tokenRes.status).toBe(200);
    return { owner, goat };
  }

  it("stores reminder offsets on the user settings", async () => {
    const { jwt } = await createUserWithFarm();
    const patchRes = await request(
      "PATCH",
      "/v1/me",
      { breedingReminderDaysBefore1: 7, breedingReminderDaysBefore2: 0 },
      jwt
    );
    expect(patchRes.status).toBe(200);
    const meRes = await request("GET", "/v1/me", undefined, jwt);
    const me = (
      (await meRes.json()) as {
        data: { breedingReminderDaysBefore1: number | null; breedingReminderDaysBefore2: number | null };
      }
    ).data;
    expect(me.breedingReminderDaysBefore1).toBe(7);
    expect(me.breedingReminderDaysBefore2).toBe(0);

    const clearRes = await request("PATCH", "/v1/me", { breedingReminderDaysBefore2: null }, jwt);
    const cleared = ((await clearRes.json()) as { data: { breedingReminderDaysBefore2: number | null } }).data;
    expect(cleared.breedingReminderDaysBefore2).toBeNull();
  });

  it("sends a reminder at the configured offset once", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);

    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0]).toMatchObject({
      to: "ExponentPushToken[owner]",
      title: "Geburt erwartet",
      body: "In 7 Tagen: Zicklein",
      data: { type: "breeding_due", farmId: owner.farmId },
    });

    // Rerun on the same day does not notify twice
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(1);
  });

  it("does not notify without opt-in or on other days", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(0);

    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 0 }, owner.jwt);
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(0);

    await runBreedingReminderNotifications(new Date("2026-02-28T09:00:00Z"));
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].body).toBe("Heute: Zicklein");
  });

  it("does not remind for a mating that was followed by another mating", async () => {
    const { owner, goat } = await setupGoatDueOn2026_02_28();
    await addHeat(owner.jwt, goat.id, { date: "2025-10-22", mated: true });
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(0);
  });

  it("does not remind for a mating that was followed by an unmated heat", async () => {
    const { owner, goat } = await setupGoatDueOn2026_02_28();
    await addHeat(owner.jwt, goat.id, { date: "2025-10-22" });
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(0);
  });

  it("sends one reminder for two matings in the same heat", async () => {
    const { owner, goat } = await setupGoatDueOn2026_02_28();
    // Mated again the next day: the expected birth moves to 2026-03-01, 8 days after NOW
    await addHeat(owner.jwt, goat.id, { date: "2025-10-02", mated: true });
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 8 }, owner.jwt);
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].body).toBe("In 8 Tagen: Zicklein");
  });

  it("catches up a missed reminder within a few days, once", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);

    // The cron didn't run on 2026-02-21, two days later the reminder still goes out with the actual days left
    const twoDaysLate = new Date("2026-02-23T09:00:00Z");
    await runBreedingReminderNotifications(twoDaysLate);
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].body).toBe("In 5 Tagen: Zicklein");
    await runBreedingReminderNotifications(new Date("2026-02-24T09:00:00Z"));
    expect(sentMessages()).toHaveLength(1);
  });

  it("does not catch up reminders older than the window", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);
    await runBreedingReminderNotifications(new Date("2026-02-26T09:00:00Z"));
    expect(sentMessages()).toHaveLength(0);
  });

  it("sends one message when two offsets are caught up on the same day", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7, breedingReminderDaysBefore2: 5 }, owner.jwt);
    await runBreedingReminderNotifications(new Date("2026-02-23T09:00:00Z"));
    expect(sentMessages()).toHaveLength(1);
    expect(sentMessages()[0].body).toBe("In 5 Tagen: Zicklein");
  });

  it("retries a reminder on the next run when the push failed", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, owner.jwt);
    mockPostToExpo.mockRejectedValueOnce(new Error("Expo unavailable"));
    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(1);

    await runBreedingReminderNotifications(new Date("2026-02-22T09:00:00Z"));
    expect(sentMessages()).toHaveLength(2);
    expect(sentMessages()[1].body).toBe("In 6 Tagen: Zicklein");
    await runBreedingReminderNotifications(new Date("2026-02-23T09:00:00Z"));
    expect(sentMessages()).toHaveLength(2);
  });

  it("skips members without animals access", async () => {
    const { owner } = await setupGoatDueOn2026_02_28();
    const member = await createFarmMember(owner.jwt, "noaccess@test.com", {
      permissions: [{ feature: "animals", access: "none" }],
    });
    await request("PATCH", "/v1/me", { breedingReminderDaysBefore1: 7 }, member.jwt);
    await request("POST", "/v1/me/push-tokens", { token: "ExponentPushToken[member]", platform: "ios" }, member.jwt);

    await runBreedingReminderNotifications(NOW);
    expect(sentMessages()).toHaveLength(0);
  });
});
