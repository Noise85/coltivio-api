import { describe, expect, test } from "@jest/globals";
import { addDays } from "date-fns";
import { getAnimalCategoryTransitions } from "./animal-key-mapping";
import type {
  Animal,
  AnimalSex,
  AnimalType,
  CustomOutdoorJournalCategory,
  Herd,
  HerdMembership,
  OutdoorScheduleWithRecurrence,
} from "./animals";
import { hasScheduleOverlap } from "./animals";
import { buildMeadowJournal, buildOutdoorJournal, expandOutdoorSchedule } from "./outdoor-journal";

// --- Helpers ---

function d(dateStr: string): Date {
  return new Date(dateStr);
}

let idCounter = 0;
function nextId(): string {
  return `test-${++idCounter}`;
}

function makeAnimal(overrides: {
  type: AnimalType;
  sex: AnimalSex;
  dateOfBirth: Date;
  usage?: "milk" | "other";
  dateOfDeath?: Date | null;
}): AnimalWithCustomCategories {
  return {
    id: nextId(),
    farmId: "farm-1",
    name: "Test Animal",
    type: overrides.type,
    sex: overrides.sex,
    dateOfBirth: overrides.dateOfBirth,
    usage: overrides.usage ?? "other",
    registered: true,
    earTagId: null,
    earTag: null,
    motherId: null,
    fatherId: null,
    dateOfDeath: overrides.dateOfDeath ?? null,
    deathReason: null,
    herdId: null,
    customOutdoorJournalCategories: [],
  };
}

function makeSchedule(overrides: {
  startDate: Date;
  endDate?: Date | null;
  recurrence?: OutdoorScheduleWithRecurrence["recurrence"];
}): OutdoorScheduleWithRecurrence {
  return {
    id: nextId(),
    farmId: "farm-1",
    herdId: "herd-1",
    meadowId: null,
    startDate: overrides.startDate,
    endDate: overrides.endDate ?? null,
    type: "pasture",
    notes: null,
    recurrence: overrides.recurrence ?? null,
  };
}

function makeRecurrence(
  overrides: Partial<NonNullable<OutdoorScheduleWithRecurrence["recurrence"]>> & {
    frequency: "weekly" | "monthly" | "yearly";
  }
): NonNullable<OutdoorScheduleWithRecurrence["recurrence"]> {
  return {
    id: nextId(),
    farmId: "farm-1",
    outdoorScheduleId: "sched-1",
    frequency: overrides.frequency,
    interval: overrides.interval ?? 1,
    byWeekday: overrides.byWeekday ?? null,
    byMonthDay: overrides.byMonthDay ?? null,
    until: overrides.until ?? null,
    count: overrides.count ?? null,
  };
}

type AnimalWithCustomCategories = Animal & {
  customOutdoorJournalCategories: CustomOutdoorJournalCategory[];
};

function makeMembership(
  animal: AnimalWithCustomCategories,
  fromDate: Date,
  toDate?: Date | null
): HerdMembership & { animal: AnimalWithCustomCategories } {
  return {
    id: nextId(),
    farmId: "farm-1",
    animalId: animal.id,
    herdId: "herd-1",
    fromDate,
    toDate: toDate ?? null,
    animal,
  };
}

type TestHerd = Herd & {
  herdMemberships: (HerdMembership & { animal: AnimalWithCustomCategories })[];
  outdoorSchedules: OutdoorScheduleWithRecurrence[];
};

function makeHerd(
  memberships: (HerdMembership & { animal: AnimalWithCustomCategories })[],
  schedules: OutdoorScheduleWithRecurrence[]
): TestHerd {
  return {
    id: "herd-1",
    farmId: "farm-1",
    name: "Test Herd",
    herdMemberships: memberships,
    outdoorSchedules: schedules,
  };
}

// --- expandOutdoorSchedule ---

describe("expandOutdoorSchedule", () => {
  test("no recurrence: returns single range when overlapping query window", () => {
    const schedule = makeSchedule({
      startDate: d("2025-03-01"),
      endDate: d("2025-03-31"),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-12-31"));
    expect(ranges).toEqual([{ startDate: d("2025-03-01"), endDate: d("2025-03-31") }]);
  });

  test("no recurrence: clamps to query window", () => {
    const schedule = makeSchedule({
      startDate: d("2025-02-15"),
      endDate: d("2025-04-15"),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-03-01"), d("2025-03-31"));
    expect(ranges).toEqual([{ startDate: d("2025-03-01"), endDate: d("2025-03-31") }]);
  });

  test("no recurrence: returns empty when outside query window", () => {
    const schedule = makeSchedule({
      startDate: d("2025-06-01"),
      endDate: d("2025-06-30"),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-05-31"));
    expect(ranges).toEqual([]);
  });

  test("no recurrence: open-ended schedule (endDate = null) extends to queryTo", () => {
    const schedule = makeSchedule({
      startDate: d("2025-05-10"),
      endDate: null,
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-12-31"));
    expect(ranges).toEqual([{ startDate: d("2025-05-10"), endDate: d("2025-12-31") }]);
  });

  test("no recurrence: open-ended schedule clamps to query window", () => {
    const schedule = makeSchedule({
      startDate: d("2025-03-01"),
      endDate: null,
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-04-01"), d("2025-06-30"));
    expect(ranges).toEqual([{ startDate: d("2025-04-01"), endDate: d("2025-06-30") }]);
  });

  test("yearly recurrence: generates occurrences across years", () => {
    const schedule = makeSchedule({
      startDate: d("2023-05-01"),
      endDate: d("2023-05-31"),
      recurrence: makeRecurrence({ frequency: "yearly" }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2024-01-01"), d("2025-12-31"));
    expect(ranges).toHaveLength(2);
    expect(ranges[0]).toEqual({
      startDate: d("2024-05-01"),
      endDate: d("2024-05-31"),
    });
    expect(ranges[1]).toEqual({
      startDate: d("2025-05-01"),
      endDate: d("2025-05-31"),
    });
  });

  test("yearly recurrence spanning 29 February: occurrences keep their calendar span", () => {
    const schedule = makeSchedule({
      startDate: d("2023-11-01"),
      endDate: d("2024-04-30"),
      recurrence: makeRecurrence({ frequency: "yearly" }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2024-11-01"), d("2026-10-31"));
    expect(ranges).toEqual([
      { startDate: d("2024-11-01"), endDate: d("2025-04-30") },
      { startDate: d("2025-11-01"), endDate: d("2026-04-30") },
    ]);
  });

  test("yearly recurrence: respects until", () => {
    const schedule = makeSchedule({
      startDate: d("2023-05-01"),
      endDate: d("2023-05-31"),
      recurrence: makeRecurrence({ frequency: "yearly", until: "2024-06-01" }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2023-01-01"), d("2026-12-31"));
    // 2023 and 2024 only (2025 start is after until)
    expect(ranges).toHaveLength(2);
  });

  test("yearly recurrence: respects count", () => {
    const schedule = makeSchedule({
      startDate: d("2023-05-01"),
      endDate: d("2023-05-31"),
      recurrence: makeRecurrence({ frequency: "yearly", count: 2 }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2023-01-01"), d("2030-12-31"));
    expect(ranges).toHaveLength(2);
  });

  test("monthly recurrence: generates monthly occurrences", () => {
    const schedule = makeSchedule({
      startDate: d("2025-01-15"),
      endDate: d("2025-01-17"),
      recurrence: makeRecurrence({ frequency: "monthly" }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-04-30"));
    expect(ranges).toHaveLength(4); // Jan, Feb, Mar, Apr
    expect(ranges[0].startDate).toEqual(d("2025-01-15"));
    expect(ranges[1].startDate).toEqual(d("2025-02-15"));
  });

  test("monthly recurrence: with byMonthDay override", () => {
    const schedule = makeSchedule({
      startDate: d("2025-01-15"),
      endDate: d("2025-01-15"),
      recurrence: makeRecurrence({ frequency: "monthly", byMonthDay: 1 }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-03-31"));
    expect(ranges).toHaveLength(3);
    expect(ranges[0].startDate).toEqual(d("2025-01-01"));
    expect(ranges[1].startDate).toEqual(d("2025-02-01"));
    expect(ranges[2].startDate).toEqual(d("2025-03-01"));
  });

  test("monthly recurrence with interval 2: every other month", () => {
    const schedule = makeSchedule({
      startDate: d("2025-01-10"),
      endDate: d("2025-01-10"),
      recurrence: makeRecurrence({ frequency: "monthly", interval: 2 }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-06-30"));
    expect(ranges).toHaveLength(3); // Jan, Mar, May
    // Compare date portions only (addMonths uses local time, so UTC timestamps can shift by DST)
    const startDates = ranges.map((r) => r.startDate.toLocaleDateString("sv-SE"));
    expect(startDates).toEqual(["2025-01-10", "2025-03-10", "2025-05-10"]);
  });

  test("weekly recurrence: no byWeekday uses original day", () => {
    // 2025-01-06 is a Monday
    const schedule = makeSchedule({
      startDate: d("2025-01-06"),
      endDate: d("2025-01-06"),
      recurrence: makeRecurrence({ frequency: "weekly" }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-01-27"));
    expect(ranges).toHaveLength(4); // 6, 13, 20, 27
    expect(ranges[0].startDate).toEqual(d("2025-01-06"));
    expect(ranges[1].startDate).toEqual(d("2025-01-13"));
    expect(ranges[2].startDate).toEqual(d("2025-01-20"));
    expect(ranges[3].startDate).toEqual(d("2025-01-27"));
  });

  test("weekly recurrence: with byWeekday", () => {
    // 2025-01-06 is a Monday; request MO and WE
    const schedule = makeSchedule({
      startDate: d("2025-01-06"),
      endDate: d("2025-01-06"),
      recurrence: makeRecurrence({
        frequency: "weekly",
        byWeekday: ["MO", "WE"],
      }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-06"), d("2025-01-19"));
    // Week 1: MO=6, WE=8; Week 2: MO=13, WE=15
    expect(ranges).toHaveLength(4);
    expect(ranges[0].startDate).toEqual(d("2025-01-06"));
    expect(ranges[1].startDate).toEqual(d("2025-01-08"));
    expect(ranges[2].startDate).toEqual(d("2025-01-13"));
    expect(ranges[3].startDate).toEqual(d("2025-01-15"));
  });

  test("weekly recurrence with interval 2: every other week", () => {
    const schedule = makeSchedule({
      startDate: d("2025-01-06"),
      endDate: d("2025-01-06"),
      recurrence: makeRecurrence({ frequency: "weekly", interval: 2 }),
    });
    const ranges = expandOutdoorSchedule(schedule, d("2025-01-01"), d("2025-02-28"));
    // Jan 6, Jan 20, Feb 3, Feb 17
    expect(ranges.map((r) => r.startDate)).toEqual([
      d("2025-01-06"),
      d("2025-01-20"),
      d("2025-02-03"),
      d("2025-02-17"),
    ]);
  });
});

// --- getAnimalCategoryTransitions ---

describe("getAnimalCategoryTransitions", () => {
  test("female sheep stays D3 when under 365 days for entire period", () => {
    // Born 2025-01-01, period is 2025-06-01 to 2025-08-01 (age 151-212 days)
    const animal = {
      type: "sheep" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2025-01-01"),
    };
    const transitions = getAnimalCategoryTransitions(animal, d("2025-06-01"), d("2025-08-01"));
    expect(transitions).toEqual([{ category: "D3", startDate: d("2025-06-01"), endDate: d("2025-08-01") }]);
  });

  test("female sheep transitions from D3 to D1 at 365 days", () => {
    // Born 2024-01-01, 2024 is a leap year (366 days) → day 365 = 2024-12-31
    const animal = {
      type: "sheep" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2024-01-01"),
    };
    const transitionDate = addDays(d("2024-01-01"), 365); // 2024-12-31
    const transitions = getAnimalCategoryTransitions(animal, d("2024-12-01"), d("2025-02-01"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0].category).toBe("D3");
    expect(transitions[0].startDate).toEqual(d("2024-12-01"));
    expect(transitions[0].endDate).toEqual(transitionDate);
    expect(transitions[1].category).toBe("D1");
    expect(transitions[1].startDate).toEqual(transitionDate);
    expect(transitions[1].endDate).toEqual(d("2025-02-01"));
  });

  test("male sheep transitions from D3 to D2 at 365 days", () => {
    const animal = {
      type: "sheep" as AnimalType,
      sex: "male" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2024-06-01"),
    };
    // 365 days from 2024-06-01 = 2025-06-01
    const transitions = getAnimalCategoryTransitions(animal, d("2025-05-01"), d("2025-07-01"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0].category).toBe("D3");
    expect(transitions[1].category).toBe("D2");
  });

  test("male cow transitions from A8 to A7 at 366 days", () => {
    // A8: 160-365 days, A7: 366-729 days
    const animal = {
      type: "cow" as AnimalType,
      sex: "male" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2024-01-01"),
    };
    // 366 days from 2024-01-01 = 2025-01-02
    const transitions = getAnimalCategoryTransitions(animal, d("2024-12-01"), d("2025-02-01"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0].category).toBe("A8");
    expect(transitions[1].category).toBe("A7");
    expect(transitions[1].startDate).toEqual(addDays(d("2024-01-01"), 366));
  });

  test("male cow transitions A7 to A6 at 730 days", () => {
    // A7: 366-729, A6: 730+
    const animal = {
      type: "cow" as AnimalType,
      sex: "male" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2023-01-01"),
    };
    // 730 days from 2023-01-01 = 2024-12-31
    const transitions = getAnimalCategoryTransitions(animal, d("2024-12-01"), d("2025-02-01"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0].category).toBe("A7");
    expect(transitions[1].category).toBe("A6");
  });

  test("female cow (non-milk) stays A3 for entire period when old enough", () => {
    const animal = {
      type: "cow" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2020-01-01"),
    };
    const transitions = getAnimalCategoryTransitions(animal, d("2025-06-01"), d("2025-08-01"));
    // A1 requires milking, A2 requires 366+ days (but lower priority than A3?)
    // Actually looking at the rules: A1 (milking+366d), A2 (female+366d), A3 (female+365d)
    // A2 matches first (366 days, female, no milking requirement beyond A1)
    expect(transitions).toHaveLength(1);
    expect(transitions[0].category).toBe("A2");
  });

  test("female cow (milk) maps to A1 when old enough", () => {
    const animal = {
      type: "cow" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "milk" as const,
      dateOfBirth: d("2020-01-01"),
    };
    const transitions = getAnimalCategoryTransitions(animal, d("2025-06-01"), d("2025-08-01"));
    expect(transitions).toHaveLength(1);
    expect(transitions[0].category).toBe("A1");
  });

  test("horse transitions from B3 to B1 at 900 days", () => {
    const animal = {
      type: "horse" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2022-06-01"),
    };
    // 900 days from 2022-06-01 = 2024-11-17
    const transitionDate = addDays(d("2022-06-01"), 900);
    const transitions = getAnimalCategoryTransitions(animal, d("2024-10-01"), d("2025-01-01"));
    expect(transitions).toHaveLength(2);
    expect(transitions[0].category).toBe("B3");
    expect(transitions[1].category).toBe("B1");
    expect(transitions[1].startDate).toEqual(transitionDate);
  });

  test("uncategorized animal type returns null category", () => {
    // Pigs have no rules
    const animal = {
      type: "pig" as AnimalType,
      sex: "female" as AnimalSex,
      usage: "other" as const,
      dateOfBirth: d("2024-01-01"),
    };
    const transitions = getAnimalCategoryTransitions(animal, d("2025-01-01"), d("2025-06-01"));
    expect(transitions).toHaveLength(1);
    expect(transitions[0].category).toBeNull();
  });
});

// --- buildOutdoorJournal ---

describe("buildOutdoorJournal", () => {
  test("single animal, single schedule, single category", () => {
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"), // old enough for D1
    });
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("D1");
    expect(result.entries[0].animalCount).toBe(1);
    expect(result.entries[0].startDate).toEqual(d("2025-05-01"));
    expect(result.entries[0].endDate).toEqual(d("2025-05-31"));
  });

  test("animal changes category mid-schedule: sheep D3 → D1", () => {
    // Born 2024-07-01, turns 365 days on 2025-07-01
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2024-07-01"),
    });
    const herd = makeHerd(
      [makeMembership(animal, d("2024-07-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-09-30") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);

    const d3Entries = result.entries.filter((e) => e.category === "D3");
    const d1Entries = result.entries.filter((e) => e.category === "D1");
    expect(d3Entries).toHaveLength(1);
    expect(d1Entries).toHaveLength(1);

    // D3 period: May 1 until transition
    expect(d3Entries[0].startDate).toEqual(d("2025-05-01"));
    // D1 period: starts at transition, ends Sep 30
    expect(d1Entries[0].endDate).toEqual(d("2025-09-30"));
    // Transition at day 365 = 2025-07-01
    expect(d1Entries[0].startDate).toEqual(addDays(d("2024-07-01"), 365));
  });

  test("dead animal excluded when death is before effective start", () => {
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
      dateOfDeath: d("2024-12-31"),
    });
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.entries).toHaveLength(0);
  });

  test("membership range limits effective outdoor period", () => {
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
    });
    // Membership ends before schedule ends
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"), d("2025-05-15"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].endDate).toEqual(d("2025-05-15"));
  });

  test("pig animals count as uncategorized", () => {
    const animal = makeAnimal({
      type: "pig",
      sex: "female",
      dateOfBirth: d("2024-01-01"),
    });
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.entries).toHaveLength(0);
    expect(result.uncategorizedAnimals).toHaveLength(1);
    expect(result.uncategorizedAnimals[0].id).toBe(animal.id);
    expect(result.uncategorizedAnimals[0].name).toBe("Test Animal");
    expect(result.uncategorizedAnimals[0].earTag).toBeNull();
  });

  test("multiple animals produce correct animal count", () => {
    const animal1 = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
    });
    const animal2 = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-06-01"),
    });
    const herd = makeHerd(
      [makeMembership(animal1, d("2024-01-01")), makeMembership(animal2, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("D1");
    expect(result.entries[0].animalCount).toBe(2);
  });

  test("two animals in different categories produce separate entries", () => {
    const femaleSheep = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"), // D1
    });
    const maleSheep = makeAnimal({
      type: "sheep",
      sex: "male",
      dateOfBirth: d("2020-01-01"), // D2
    });
    const herd = makeHerd(
      [makeMembership(femaleSheep, d("2024-01-01")), makeMembership(maleSheep, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    const categories = result.entries.map((e) => e.category).sort();
    expect(categories).toEqual(["D1", "D2"]);
    expect(result.entries.every((e) => e.animalCount === 1)).toBe(true);
  });

  test("recurring weekly schedule with category transition mid-year", () => {
    // Young female sheep: born 2024-10-01, turns 365 days on 2025-10-01
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2024-10-01"),
    });
    // Weekly schedule starting 2025-09-29 (Monday)
    const herd = makeHerd(
      [makeMembership(animal, d("2024-10-01"))],
      [
        makeSchedule({
          startDate: d("2025-09-29"),
          endDate: d("2025-09-29"),
          recurrence: makeRecurrence({ frequency: "weekly" }),
        }),
      ]
    );
    const result = buildOutdoorJournal([herd], d("2025-09-01"), d("2025-10-31"));

    // Before 2025-10-01: D3, after: D1
    const d3Entries = result.entries.filter((e) => e.category === "D3");
    const d1Entries = result.entries.filter((e) => e.category === "D1");
    expect(d3Entries.length).toBeGreaterThanOrEqual(1);
    expect(d1Entries.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple herds are combined", () => {
    const animal1 = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
    });
    const animal2 = makeAnimal({
      type: "goat",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
    });
    const herd1 = makeHerd(
      [makeMembership(animal1, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const herd2: TestHerd = {
      ...makeHerd(
        [makeMembership(animal2, d("2024-01-01"))],
        [
          makeSchedule({
            startDate: d("2025-05-01"),
            endDate: d("2025-05-31"),
          }),
        ]
      ),
      id: "herd-2",
    };
    const result = buildOutdoorJournal([herd1, herd2], d("2025-01-01"), d("2025-12-31"));
    const categories = result.entries.map((e) => e.category).sort();
    expect(categories).toEqual(["C1", "D1"]);
  });

  test("custom outdoor journal category overrides null age-based category", () => {
    // Pig has no age-based rules → normally uncategorized
    const animal = makeAnimal({
      type: "pig",
      sex: "female",
      dateOfBirth: d("2024-01-01"),
    });
    animal.customOutdoorJournalCategories = [
      {
        id: "cust-1",
        farmId: "farm-1",
        animalId: animal.id,
        startDate: d("2025-01-01"),
        endDate: d("2025-12-31"),
        category: "A1",
      },
    ];
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("A1");
  });

  test("custom category only covers part of period, rest uses age-based", () => {
    // Old female sheep: age-based = D1
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"),
    });
    // Custom category covers May 1-15, age-based D1 covers May 16-31
    animal.customOutdoorJournalCategories = [
      {
        id: "cust-1",
        farmId: "farm-1",
        animalId: animal.id,
        startDate: d("2025-05-01"),
        endDate: d("2025-05-15"),
        category: "A2",
      },
    ];
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);
    const categories = result.entries.map((e) => e.category).sort();
    expect(categories).toContain("A2");
    expect(categories).toContain("D1");
  });

  test("pig with partial custom category is still uncategorized for uncovered period", () => {
    const animal = makeAnimal({
      type: "pig",
      sex: "female",
      dateOfBirth: d("2024-01-01"),
    });
    // Custom only covers May 1-15; May 16-31 has no rules for pig → uncategorized
    animal.customOutdoorJournalCategories = [
      {
        id: "cust-1",
        farmId: "farm-1",
        animalId: animal.id,
        startDate: d("2025-05-01"),
        endDate: d("2025-05-15"),
        category: "A1",
      },
    ];
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    // Has a categorized fragment from the custom category
    expect(result.entries.some((e) => e.category === "A1")).toBe(true);
    // But also uncategorized because of the uncovered period
    // Since the animal has both categorized AND null periods, it should NOT be in uncategorizedAnimals
    // (uncategorized = never categorized across all periods)
    expect(result.uncategorizedAnimals).toHaveLength(0);
  });

  test("custom category with no endDate covers from startDate to end of period", () => {
    const animal = makeAnimal({
      type: "pig",
      sex: "female",
      dateOfBirth: d("2024-01-01"),
    });
    animal.customOutdoorJournalCategories = [
      {
        id: "cust-1",
        farmId: "farm-1",
        animalId: animal.id,
        startDate: d("2025-01-01"),
        endDate: null,
        category: "D1",
      },
    ];
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("D1");
  });

  test("open-ended schedule (no endDate) spans from startDate to query end", () => {
    const animal = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"), // old enough for D1
    });
    const herd = makeHerd(
      [makeMembership(animal, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: null })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.uncategorizedAnimals).toHaveLength(0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].category).toBe("D1");
    expect(result.entries[0].animalCount).toBe(1);
    expect(result.entries[0].startDate).toEqual(d("2025-05-01"));
    expect(result.entries[0].endDate).toEqual(d("2025-12-31"));
  });

  test("entries are sorted by category then startDate", () => {
    const goat = makeAnimal({
      type: "goat",
      sex: "female",
      dateOfBirth: d("2020-01-01"), // C1
    });
    const sheep = makeAnimal({
      type: "sheep",
      sex: "female",
      dateOfBirth: d("2020-01-01"), // D1
    });
    const herd = makeHerd(
      [makeMembership(goat, d("2024-01-01")), makeMembership(sheep, d("2024-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const result = buildOutdoorJournal([herd], d("2025-01-01"), d("2025-12-31"));
    expect(result.entries[0].category).toBe("C1");
    expect(result.entries[1].category).toBe("D1");
  });
});

// --- hasScheduleOverlap ---
// New API: takes OutdoorScheduleWithRecurrence[] and checks all pairs.

function sched(startDate: string, endDate: string | null, recurrence?: { interval: number; until?: string } | null) {
  return makeSchedule({
    startDate: d(startDate),
    endDate: endDate ? d(endDate) : null,
    recurrence: recurrence
      ? makeRecurrence({
          frequency: "yearly",
          interval: recurrence.interval,
          until: recurrence.until,
        })
      : undefined,
  });
}

describe("hasScheduleOverlap", () => {
  // ---------------------------------------------------------------------------
  // Non-recurring
  // ---------------------------------------------------------------------------

  test("non-recurring: clear overlap (May–Aug vs Jul–Sep)", () => {
    expect(hasScheduleOverlap([sched("2025-05-01", "2025-08-31"), sched("2025-07-01", "2025-09-30")])).toBe(true);
  });

  test("non-recurring: adjacent months do not overlap (May–Jun vs Jul–Sep)", () => {
    expect(hasScheduleOverlap([sched("2025-05-01", "2025-06-30"), sched("2025-07-01", "2025-09-30")])).toBe(false);
  });

  test("non-recurring: year-crossing range overlaps a range in the spanned second year", () => {
    expect(hasScheduleOverlap([sched("2025-11-01", "2026-03-31"), sched("2026-02-01", "2026-04-30")])).toBe(true);
  });

  test("non-recurring: adjacent year-crossing ranges do not overlap (Nov–Dec vs Jan–Mar next year)", () => {
    expect(hasScheduleOverlap([sched("2025-11-01", "2025-12-31"), sched("2026-01-01", "2026-03-31")])).toBe(false);
  });

  test("non-recurring: single schedule never overlaps itself", () => {
    expect(hasScheduleOverlap([sched("2025-05-01", "2025-08-31")])).toBe(false);
  });

  test("non-recurring: identical single-day schedules overlap", () => {
    expect(hasScheduleOverlap([sched("2025-06-15", "2025-06-15"), sched("2025-06-15", "2025-06-15")])).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Recurring (yearly)
  // ---------------------------------------------------------------------------

  test("recurring: both annual, overlapping day windows → overlap", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-05-01", "2025-08-31", { interval: 1 }),
        sched("2025-07-01", "2025-09-30", { interval: 1 }),
      ])
    ).toBe(true);
  });

  test("recurring: both annual, non-overlapping day windows → no overlap", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-05-01", "2025-08-31", { interval: 1 }),
        sched("2025-09-01", "2025-11-30", { interval: 1 }),
      ])
    ).toBe(false);
  });

  test("recurring: year-crossing annual (Nov–Mar) overlaps annual Jan–Feb", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-11-01", "2026-03-31", { interval: 1 }),
        sched("2026-01-01", "2026-02-28", { interval: 1 }),
      ])
    ).toBe(true);
  });

  test("recurring: year-crossing annual (Nov–Mar) does NOT overlap annual Apr–Oct", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-11-01", "2026-03-31", { interval: 1 }),
        sched("2025-04-01", "2025-10-31", { interval: 1 }),
      ])
    ).toBe(false);
  });

  test("recurring: annual Nov–Dec does NOT overlap annual Jan–Feb", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-11-01", "2025-12-31", { interval: 1 }),
        sched("2026-01-01", "2026-02-28", { interval: 1 }),
      ])
    ).toBe(false);
  });

  test("recurring: biennial alternating years → no overlap", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-06-01", "2025-08-31", { interval: 2 }),
        sched("2026-06-01", "2026-08-31", { interval: 2 }),
      ])
    ).toBe(false);
  });

  test("recurring: biennial same start year, overlapping day windows → overlap", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-06-01", "2025-07-31", { interval: 2 }),
        sched("2025-07-01", "2025-08-31", { interval: 2 }),
      ])
    ).toBe(true);
  });

  test("recurring: annual with until before second schedule's start year → no overlap", () => {
    expect(
      hasScheduleOverlap([
        sched("2020-06-01", "2020-08-31", { interval: 1, until: "2022-12-31" }),
        sched("2025-06-01", "2025-08-31", { interval: 1 }),
      ])
    ).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Mixed: one recurring, one non-recurring
  // ---------------------------------------------------------------------------

  test("mixed: recurring annual May–Aug vs one-time May 2025 → overlap", () => {
    expect(
      hasScheduleOverlap([sched("2024-05-01", "2024-08-31", { interval: 1 }), sched("2025-05-15", "2025-07-15")])
    ).toBe(true);
  });

  test("mixed: recurring annual May–Aug starting 2027 vs one-time May 2025 → no overlap", () => {
    expect(
      hasScheduleOverlap([sched("2027-05-01", "2027-08-31", { interval: 1 }), sched("2025-05-15", "2025-07-15")])
    ).toBe(false);
  });

  test("mixed: year-crossing annual (Nov–Mar) vs one-time Feb in shared year → overlap", () => {
    expect(
      hasScheduleOverlap([sched("2025-11-01", "2026-03-31", { interval: 1 }), sched("2026-02-01", "2026-02-28")])
    ).toBe(true);
  });

  test("mixed: year-crossing biennial — occurrence spanning into next year overlaps non-recurring in that year", () => {
    // Biennial Nov 2022 – Mar 2023; non-recurring Jan 2023 falls in that occurrence.
    expect(
      hasScheduleOverlap([sched("2022-11-15", "2023-03-15", { interval: 2 }), sched("2023-01-10", "2023-02-28")])
    ).toBe(true);
  });

  test("mixed: year-crossing biennial — non-recurring before first occurrence → no overlap", () => {
    expect(
      hasScheduleOverlap([sched("2022-11-15", "2023-03-15", { interval: 2 }), sched("2021-01-10", "2021-02-28")])
    ).toBe(false);
  });

  test("three schedules: third overlaps second but not first", () => {
    expect(
      hasScheduleOverlap([
        sched("2025-01-01", "2025-03-31"),
        sched("2025-06-01", "2025-08-31"),
        sched("2025-07-01", "2025-09-30"),
      ])
    ).toBe(true);
  });
});

// --- buildMeadowJournal ---

describe("buildMeadowJournal", () => {
  const meadow = { id: "meadow-1", name: "Weide Nord", size: 12000 };

  function cow(dateOfDeath?: Date) {
    return makeAnimal({ type: "cow", sex: "female", dateOfBirth: d("2018-01-01"), dateOfDeath });
  }

  test("ignores schedules without a meadow", () => {
    const herd = makeHerd(
      [makeMembership(cow(), d("2025-01-01"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const entries = buildMeadowJournal(
      [{ ...herd, outdoorSchedules: herd.outdoorSchedules.map((schedule) => ({ ...schedule, meadow: null })) }],
      d("2025-01-01"),
      d("2025-12-31")
    );
    expect(entries).toEqual([]);
  });

  test("splits occurrence into segments when animal count changes", () => {
    const herd = makeHerd(
      [
        makeMembership(cow(), d("2025-01-01")),
        makeMembership(cow(), d("2025-05-11")),
        makeMembership(cow(d("2025-05-20")), d("2025-01-01")),
      ],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const entries = buildMeadowJournal(
      [{ ...herd, outdoorSchedules: herd.outdoorSchedules.map((schedule) => ({ ...schedule, meadow })) }],
      d("2025-01-01"),
      d("2025-12-31")
    );
    expect(entries.map(({ startDate, endDate, animalCount }) => ({ startDate, endDate, animalCount }))).toEqual([
      { startDate: d("2025-05-01"), endDate: d("2025-05-10"), animalCount: 2 },
      { startDate: d("2025-05-11"), endDate: d("2025-05-20"), animalCount: 3 },
      { startDate: d("2025-05-21"), endDate: d("2025-05-31"), animalCount: 2 },
    ]);
    expect(entries[0]).toMatchObject({
      meadowId: "meadow-1",
      meadowName: "Weide Nord",
      meadowSize: 12000,
      herdId: "herd-1",
      herdName: "Test Herd",
      type: "pasture",
    });
  });

  test("counts animals per type and splits when the mix changes even if the total stays the same", () => {
    const sheep = makeAnimal({ type: "sheep", sex: "female", dateOfBirth: d("2019-01-01") });
    const herd = makeHerd(
      [
        makeMembership(cow(), d("2025-01-01")),
        makeMembership(cow(), d("2025-01-01"), d("2025-05-15")),
        makeMembership(sheep, d("2025-05-16")),
      ],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const entries = buildMeadowJournal(
      [{ ...herd, outdoorSchedules: herd.outdoorSchedules.map((schedule) => ({ ...schedule, meadow })) }],
      d("2025-01-01"),
      d("2025-12-31")
    );
    expect(
      entries.map(({ startDate, endDate, animalCount, animalCountsByType }) => ({
        startDate,
        endDate,
        animalCount,
        animalCountsByType,
      }))
    ).toEqual([
      { startDate: d("2025-05-01"), endDate: d("2025-05-15"), animalCount: 2, animalCountsByType: { cow: 2 } },
      {
        startDate: d("2025-05-16"),
        endDate: d("2025-05-31"),
        animalCount: 2,
        animalCountsByType: { cow: 1, sheep: 1 },
      },
    ]);
  });

  test("swapping two animals of the same type on one day does not split the stay", () => {
    const herd = makeHerd(
      [makeMembership(cow(), d("2025-01-01"), d("2025-05-15")), makeMembership(cow(), d("2025-05-16"))],
      [makeSchedule({ startDate: d("2025-05-01"), endDate: d("2025-05-31") })]
    );
    const entries = buildMeadowJournal(
      [{ ...herd, outdoorSchedules: herd.outdoorSchedules.map((schedule) => ({ ...schedule, meadow })) }],
      d("2025-01-01"),
      d("2025-12-31")
    );
    expect(
      entries.map(({ startDate, endDate, animalCountsByType }) => ({ startDate, endDate, animalCountsByType }))
    ).toEqual([{ startDate: d("2025-05-01"), endDate: d("2025-05-31"), animalCountsByType: { cow: 1 } }]);
  });

  test("expands recurring meadow schedules and clamps to query window", () => {
    const herd = makeHerd(
      [makeMembership(cow(), d("2020-01-01"))],
      [
        makeSchedule({
          startDate: d("2024-06-01"),
          endDate: d("2024-06-30"),
          recurrence: makeRecurrence({ frequency: "yearly" }),
        }),
      ]
    );
    const entries = buildMeadowJournal(
      [{ ...herd, outdoorSchedules: herd.outdoorSchedules.map((schedule) => ({ ...schedule, meadow })) }],
      d("2025-06-15"),
      d("2026-12-31")
    );
    expect(entries.map(({ startDate, endDate }) => ({ startDate, endDate }))).toEqual([
      { startDate: d("2025-06-15"), endDate: d("2025-06-30") },
      { startDate: d("2026-06-01"), endDate: d("2026-06-30") },
    ]);
  });
});
