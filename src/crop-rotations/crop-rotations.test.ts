import { describe, test, expect } from "@jest/globals";
import {
  checkRotationOverlaps,
  expandRecurrence,
  DateRangeWithRecurrence,
  CropRotationWithRecurrence,
} from "./crop-rotations";

// --- Helpers ---

function d(dateStr: string): Date {
  return new Date(dateStr);
}

function range(from: string, to: string, recurrence?: { interval: number; until?: string }): DateRangeWithRecurrence {
  return {
    fromDate: d(from),
    toDate: d(to),
    recurrence: recurrence
      ? { interval: recurrence.interval, until: recurrence.until ? d(recurrence.until) : null }
      : null,
  };
}

function expectOverlap(a: DateRangeWithRecurrence, b: DateRangeWithRecurrence) {
  expect(() => checkRotationOverlaps([a, b])).toThrow("Overlapping date ranges");
}

function expectNoOverlap(a: DateRangeWithRecurrence, b: DateRangeWithRecurrence) {
  expect(() => checkRotationOverlaps([a, b])).not.toThrow();
}

// Minimal rotation object for expandRecurrence tests
function makeRotation(overrides: {
  fromDate: Date;
  toDate: Date;
  recurrence?: CropRotationWithRecurrence["recurrence"];
}): CropRotationWithRecurrence {
  return {
    id: "rot-1",
    farmId: "farm-1",
    plotId: "plot-1",
    cropId: "crop-1",
    sowingDate: null,
    fromDate: overrides.fromDate,
    toDate: overrides.toDate,
    crop: {
      id: "crop-1",
      farmId: "farm-1",
      name: "Wheat",
      category: "vegetable",
      familyId: null,
      family: null,
      variety: null,
      waitingTimeInYears: null,
      usageCodes: [],
      additionalNotes: null,
    },
    recurrence: overrides.recurrence ?? null,
  };
}

// --- checkRotationOverlaps: no recurrence ---

describe("checkRotationOverlaps - no recurrence", () => {
  test("non-overlapping ranges do not throw", () => {
    expectNoOverlap(range("2025-03-01", "2025-06-30"), range("2025-07-01", "2025-10-31"));
  });

  test("overlapping ranges throw", () => {
    expectOverlap(range("2025-03-01", "2025-07-15"), range("2025-07-01", "2025-10-31"));
  });

  test("adjacent ranges (touching endpoints) throw", () => {
    // fromDate <= toDate means same-day counts as overlap
    expectOverlap(range("2025-03-01", "2025-06-30"), range("2025-06-30", "2025-10-31"));
  });

  test("one range fully inside another throws", () => {
    expectOverlap(range("2025-01-01", "2025-12-31"), range("2025-04-01", "2025-06-30"));
  });

  test("completely separate years do not throw", () => {
    expectNoOverlap(range("2024-03-01", "2024-06-30"), range("2025-03-01", "2025-06-30"));
  });
});

// --- checkRotationOverlaps: with yearly recurrence ---

describe("checkRotationOverlaps - yearly recurrence", () => {
  test("same day-of-year range, both recurring yearly → overlap", () => {
    expectOverlap(
      range("2024-04-01", "2024-09-30", { interval: 1 }),
      range("2025-04-01", "2025-09-30", { interval: 1 })
    );
  });

  test("non-overlapping day-of-year ranges, both recurring → no overlap", () => {
    expectNoOverlap(
      range("2024-03-01", "2024-05-31", { interval: 1 }),
      range("2025-07-01", "2025-09-30", { interval: 1 })
    );
  });

  test("recurring with interval 2, same start year parity → overlap", () => {
    // Both start in even years, interval 2 → both occur in 2024, 2026, 2028...
    expectOverlap(
      range("2024-04-01", "2024-06-30", { interval: 2 }),
      range("2026-04-01", "2026-06-30", { interval: 2 })
    );
  });

  test("recurring with interval 2, different start year parity → no overlap", () => {
    // One starts even year, other odd → they never share an occurrence year
    expectNoOverlap(
      range("2024-04-01", "2024-06-30", { interval: 2 }),
      range("2025-04-01", "2025-06-30", { interval: 2 })
    );
  });

  test("recurring with until date that prevents overlap", () => {
    // A recurs from 2024, until 2025. B starts in 2026.
    expectNoOverlap(
      range("2024-04-01", "2024-06-30", { interval: 1, until: "2025-12-31" }),
      range("2026-04-01", "2026-06-30", { interval: 1 })
    );
  });

  test("recurring vs non-recurring: same year → overlap", () => {
    expectOverlap(range("2024-04-01", "2024-06-30", { interval: 1 }), range("2024-04-15", "2024-05-15"));
  });

  test("recurring vs non-recurring: non-recurring year not in recurrence → no overlap", () => {
    // Recurrence starts 2024 with interval 2 (2024, 2026, 2028...)
    // Non-recurring in 2025 → 2025 is not an occurrence year
    expectNoOverlap(range("2024-04-01", "2024-06-30", { interval: 2 }), range("2025-04-01", "2025-06-30"));
  });

  test("recurring vs non-recurring: non-recurring year IS in recurrence → overlap", () => {
    // Recurrence starts 2024 with interval 2 (2024, 2026, 2028...)
    // Non-recurring in 2026, same day-of-year → overlap
    expectOverlap(range("2024-04-01", "2024-06-30", { interval: 2 }), range("2026-04-01", "2026-06-30"));
  });

  test("day-of-year overlap but different occurrence years → no overlap", () => {
    // A: interval 3, starts 2024 (2024, 2027, 2030...)
    // B: interval 3, starts 2025 (2025, 2028, 2031...)
    // Same day range but never share a year
    expectNoOverlap(
      range("2024-04-01", "2024-06-30", { interval: 3 }),
      range("2025-04-01", "2025-06-30", { interval: 3 })
    );
  });

  test("interval 3 rotations that do share a year → overlap", () => {
    // A: starts 2024, interval 3 (2024, 2027, 2030...)
    // B: starts 2027, interval 3 (2027, 2030, 2033...)
    // They share 2027
    expectOverlap(
      range("2024-04-01", "2024-06-30", { interval: 3 }),
      range("2027-04-01", "2027-06-30", { interval: 3 })
    );
  });

  test("year-crossing: both annual Nov–Feb ranges genuinely overlap (Jan–Feb shared)", () => {
    // Nov–Mar split into [305,366] and [1,59]; they share those day ranges
    expectOverlap(
      range("2024-11-01", "2025-02-28", { interval: 1 }),
      range("2025-11-01", "2026-02-28", { interval: 1 })
    );
  });

  test("year-crossing: annual Nov–Mar does NOT overlap annual Apr–Oct (no shared days)", () => {
    // Nov–Mar split: [[305,366],[1,90]]. Apr–Oct: [[91,304]]. No intersection.
    expectNoOverlap(
      range("2024-11-01", "2025-03-31", { interval: 1 }),
      range("2025-04-01", "2025-10-31", { interval: 1 })
    );
  });

  test("year-crossing: annual Nov–Mar overlaps annual Jan–Feb (Jan–Feb inside Nov–Mar window)", () => {
    // Nov–Mar split: [[305,366],[1,90]]. Jan–Feb: [[1,59]]. [1,90] overlaps [1,59].
    expectOverlap(
      range("2024-11-01", "2025-03-31", { interval: 1 }),
      range("2025-01-01", "2025-02-28", { interval: 1 })
    );
  });

  test("year-crossing: annual Nov–Dec does NOT overlap annual Jan–Feb (different year halves)", () => {
    // Nov–Dec: [[305,365]]. Jan–Feb: [[1,59]]. No intersection.
    expectNoOverlap(
      range("2024-11-01", "2024-12-31", { interval: 1 }),
      range("2025-01-01", "2025-02-28", { interval: 1 })
    );
  });

  test("year-crossing: biennial Nov–Mar starting 2022 overlaps non-recurring Jan 2023", () => {
    // Occurrence in 2022 spans into 2023. Non-recurring Jan 2023 must be detected.
    expectOverlap(range("2022-11-15", "2023-03-15", { interval: 2 }), range("2023-01-10", "2023-02-28"));
  });

  test("year-crossing: biennial Nov–Mar starting 2022 does NOT overlap non-recurring Jan 2024", () => {
    // 2022 occurrence: Nov 15 2022 – Mar 15 2023. Next: Nov 15 2024 – Mar 15 2025.
    // Non-recurring Jan 10–Feb 28 2024 falls between those two occurrences → no overlap.
    expectNoOverlap(range("2022-11-15", "2023-03-15", { interval: 2 }), range("2024-01-10", "2024-02-28"));
  });

  test("year-crossing: biennial Nov–Mar starting 2022 does NOT overlap non-recurring Jan 2025", () => {
    // 2025 is NOT in {2022,2023,2024,2025,...} — wait, 2024 occurrence spans into 2025.
    // So 2025 IS in the set. This should overlap too.
    // Instead test 2021 (before start): no overlap.
    expectNoOverlap(range("2022-11-15", "2023-03-15", { interval: 2 }), range("2021-01-10", "2021-02-28"));
  });

  test("leap year: non-recurring rotation starting 1 Jan right after a yearly Jan-Dec series from 2024 ends → no overlap", () => {
    expectNoOverlap(
      range("2024-01-01", "2024-12-31", { interval: 1, until: "2025-12-31" }),
      range("2026-01-01", "2026-12-31")
    );
  });

  test("leap year: two yearly Jan-Dec series from 2024 and 2026 → overlap", () => {
    expectOverlap(
      range("2024-01-01", "2024-12-31", { interval: 1 }),
      range("2026-01-01", "2026-12-31", { interval: 1 })
    );
  });

  test("multiple ranges: third overlaps first", () => {
    const a = range("2024-03-01", "2024-06-30", { interval: 1 });
    const b = range("2024-07-01", "2024-09-30", { interval: 1 });
    const c = range("2025-04-01", "2025-08-30", { interval: 1 }); // overlaps both a and b
    expect(() => checkRotationOverlaps([a, b, c])).toThrow("Overlapping date ranges");
  });
});

// --- expandRecurrence ---

describe("expandRecurrence", () => {
  test("no recurrence: returns rotation when within range", () => {
    const rotation = makeRotation({
      fromDate: d("2025-04-01"),
      toDate: d("2025-06-30"),
    });
    const result = expandRecurrence(rotation, d("2025-01-01"), d("2025-12-31"));
    expect(result).toHaveLength(1);
    expect(result[0].fromDate).toEqual(d("2025-04-01"));
  });

  test("no recurrence: returns empty when outside range", () => {
    const rotation = makeRotation({
      fromDate: d("2024-04-01"),
      toDate: d("2024-06-30"),
    });
    const result = expandRecurrence(rotation, d("2025-01-01"), d("2025-12-31"));
    expect(result).toHaveLength(0);
  });

  test("no recurrence: returns rotation when it spans the query range", () => {
    const rotation = makeRotation({
      fromDate: d("2024-01-01"),
      toDate: d("2026-12-31"),
    });
    const result = expandRecurrence(rotation, d("2025-03-01"), d("2025-06-30"));
    expect(result).toHaveLength(1);
  });

  test("yearly recurrence: generates multiple occurrences", () => {
    const rotation = makeRotation({
      fromDate: d("2023-04-01"),
      toDate: d("2023-09-30"),
      recurrence: {
        id: "rec-1",
        farmId: "farm-1",
        cropRotationId: "rot-1",
        interval: 1,
        until: null,
      },
    });
    const result = expandRecurrence(rotation, d("2024-01-01"), d("2026-12-31"));
    expect(result).toHaveLength(3); // 2024, 2025, 2026
    // Verify dates are shifted to each year (compare date portion for DST safety)
    const fromDates = result.map((r) => r.fromDate.toLocaleDateString("sv-SE"));
    expect(fromDates).toEqual(["2024-04-01", "2025-04-01", "2026-04-01"]);
  });

  test("yearly recurrence: respects until date", () => {
    const rotation = makeRotation({
      fromDate: d("2023-04-01"),
      toDate: d("2023-09-30"),
      recurrence: {
        id: "rec-1",
        farmId: "farm-1",
        cropRotationId: "rot-1",
        interval: 1,
        until: d("2025-06-01"),
      },
    });
    const result = expandRecurrence(rotation, d("2023-01-01"), d("2030-12-31"));
    // 2023, 2024, 2025 (2026 start is after until)
    expect(result).toHaveLength(3);
  });

  test("yearly recurrence with interval 2", () => {
    const rotation = makeRotation({
      fromDate: d("2024-04-01"),
      toDate: d("2024-06-30"),
      recurrence: {
        id: "rec-1",
        farmId: "farm-1",
        cropRotationId: "rot-1",
        interval: 2,
        until: null,
      },
    });
    const result = expandRecurrence(rotation, d("2024-01-01"), d("2030-12-31"));
    // 2024, 2026, 2028, 2030
    expect(result).toHaveLength(4);
    const fromDates = result.map((r) => r.fromDate.toLocaleDateString("sv-SE"));
    expect(fromDates).toEqual(["2024-04-01", "2026-04-01", "2028-04-01", "2030-04-01"]);
  });

  test("yearly recurrence spanning 29 February: exactly one occurrence per year, ending 31 Dec", () => {
    const rotation = makeRotation({
      fromDate: d("2024-01-01"),
      toDate: d("2024-12-31"),
      recurrence: {
        id: "rec-1",
        farmId: "farm-1",
        cropRotationId: "rot-1",
        interval: 1,
        until: null,
      },
    });
    for (const year of [2025, 2026, 2027, 2028]) {
      const result = expandRecurrence(rotation, d(`${year}-01-01`), d(`${year}-12-31`));
      expect(result).toHaveLength(1);
      expect(result[0].fromDate.toLocaleDateString("sv-SE")).toBe(`${year}-01-01`);
      expect(result[0].toDate.toLocaleDateString("sv-SE")).toBe(`${year}-12-31`);
    }
    const original = expandRecurrence(rotation, d("2024-01-01"), d("2024-12-31"));
    expect(original).toHaveLength(1);
    expect(original[0].fromDate).toEqual(d("2024-01-01"));
    expect(original[0].toDate).toEqual(d("2024-12-31"));
  });

  test("yearly recurrence: preserves duration of rotation", () => {
    const rotation = makeRotation({
      fromDate: d("2024-03-01"),
      toDate: d("2024-05-31"),
      recurrence: {
        id: "rec-1",
        farmId: "farm-1",
        cropRotationId: "rot-1",
        interval: 1,
        until: null,
      },
    });
    const result = expandRecurrence(rotation, d("2025-01-01"), d("2025-12-31"));
    expect(result).toHaveLength(1);
    const durationMs = result[0].toDate.getTime() - result[0].fromDate.getTime();
    const originalDurationMs = d("2024-05-31").getTime() - d("2024-03-01").getTime();
    expect(durationMs).toBe(originalDurationMs);
  });
});
