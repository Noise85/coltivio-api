import {
  addYears,
  addMonths,
  addWeeks,
  addDays,
  differenceInMilliseconds,
  getDay,
  setDay,
  isBefore,
  isAfter,
  max,
  min,
} from "date-fns";
import {
  AnimalCategory,
  Animal,
  CustomOutdoorJournalCategory,
  HerdMembership,
  OutdoorScheduleWithRecurrence,
  OutdoorScheduleType,
  AnimalType,
  Herd,
} from "./animals";
import { getAnimalCategoryTransitions } from "./animal-key-mapping";

export type OutdoorJournalEntry = {
  category: AnimalCategory;
  startDate: Date;
  endDate: Date;
  animalCount: number;
};

export type OutdoorJournalResult = {
  entries: OutdoorJournalEntry[];
  uncategorizedAnimals: Animal[];
};

type DateRange = { startDate: Date; endDate: Date };

const WEEKDAY_INDEX: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const MAX_ITERATIONS = 10_000;

// Expands a single outdoor schedule (with optional recurrence) into concrete date ranges
export function expandOutdoorSchedule(
  schedule: OutdoorScheduleWithRecurrence,
  queryFrom: Date,
  queryTo: Date
): DateRange[] {
  const recurrence = schedule.recurrence;

  // No recurrence: return single range if it overlaps query window
  if (!recurrence) {
    const start = schedule.startDate;
    const end = schedule.endDate ?? queryTo;
    if (isAfter(start, queryTo) || isBefore(end, queryFrom)) return [];
    return [{ startDate: max([start, queryFrom]), endDate: min([end, queryTo]) }];
  }

  const durationMs = differenceInMilliseconds(schedule.endDate ?? schedule.startDate, schedule.startDate);
  const interval = recurrence.interval;
  const until = recurrence.until ? new Date(recurrence.until) : null;
  const maxCount = recurrence.count ?? Infinity;
  const ranges: DateRange[] = [];
  let iterations = 0;
  let occurrenceCount = 0;

  if (recurrence.frequency === "yearly") {
    let current = schedule.startDate;
    const originalEnd = schedule.endDate ?? schedule.startDate;
    while (iterations++ < MAX_ITERATIONS) {
      if (until && isAfter(current, until)) break;
      if (isAfter(current, queryTo)) break;
      if (occurrenceCount >= maxCount) break;

      const occEnd = addYears(originalEnd, interval * occurrenceCount);
      occurrenceCount++;

      // Check overlap with query range
      if (!isAfter(queryFrom, occEnd) && !isAfter(current, queryTo)) {
        ranges.push({
          startDate: max([current, queryFrom]),
          endDate: min([occEnd, queryTo]),
        });
      }

      current = addYears(schedule.startDate, interval * occurrenceCount);
    }
  } else if (recurrence.frequency === "monthly") {
    let current = schedule.startDate;
    let step = 0;
    while (iterations++ < MAX_ITERATIONS) {
      let occStart = current;
      // Override day-of-month if byMonthDay is set
      if (recurrence.byMonthDay !== null && recurrence.byMonthDay !== undefined) {
        occStart = new Date(occStart);
        occStart.setDate(recurrence.byMonthDay);
      }

      if (until && isAfter(occStart, until)) break;
      if (isAfter(occStart, queryTo)) break;
      if (occurrenceCount >= maxCount) break;

      const occEnd = new Date(occStart.getTime() + durationMs);
      occurrenceCount++;

      if (!isAfter(queryFrom, occEnd) && !isAfter(occStart, queryTo)) {
        ranges.push({
          startDate: max([occStart, queryFrom]),
          endDate: min([occEnd, queryTo]),
        });
      }

      step++;
      current = addMonths(schedule.startDate, interval * step);
    }
  } else if (recurrence.frequency === "weekly") {
    let weekStart = schedule.startDate;
    let step = 0;
    while (iterations++ < MAX_ITERATIONS) {
      if (until && isAfter(weekStart, until)) break;
      if (isAfter(weekStart, queryTo)) break;
      if (occurrenceCount >= maxCount) break;

      const weekdays = recurrence.byWeekday && recurrence.byWeekday.length > 0 ? recurrence.byWeekday : null;

      if (weekdays) {
        // For each specified weekday, create an occurrence in this week
        for (const wd of weekdays) {
          if (occurrenceCount >= maxCount) break;
          const dayIndex = WEEKDAY_INDEX[wd];
          const occStart = setDay(weekStart, dayIndex, {
            weekStartsOn: getDay(weekStart) as 0 | 1 | 2 | 3 | 4 | 5 | 6,
          });
          const occEnd = new Date(occStart.getTime() + durationMs);

          if (until && isAfter(occStart, until)) continue;
          if (isBefore(occStart, schedule.startDate)) continue;

          occurrenceCount++;
          if (!isAfter(queryFrom, occEnd) && !isAfter(occStart, queryTo)) {
            ranges.push({
              startDate: max([occStart, queryFrom]),
              endDate: min([occEnd, queryTo]),
            });
          }
        }
      } else {
        // Use original weekday
        const occEnd = new Date(weekStart.getTime() + durationMs);
        occurrenceCount++;

        if (!isAfter(queryFrom, occEnd) && !isAfter(weekStart, queryTo)) {
          ranges.push({
            startDate: max([weekStart, queryFrom]),
            endDate: min([occEnd, queryTo]),
          });
        }
      }

      step++;
      weekStart = addWeeks(schedule.startDate, interval * step);
    }
  }

  return ranges;
}

type AnimalWithCustomCategories = Animal & {
  customOutdoorJournalCategories: CustomOutdoorJournalCategory[];
};

type HerdWithMembershipsAndSchedules = Herd & {
  herdMemberships: (HerdMembership & {
    animal: AnimalWithCustomCategories;
  })[];
  outdoorSchedules: OutdoorScheduleWithRecurrence[];
};

// Subtracts covered ranges from a period, returning the uncovered sub-periods.
// Assumes `covered` is sorted by startDate and already clamped to `period`.
function subtractDateRanges(period: DateRange, covered: DateRange[]): DateRange[] {
  if (covered.length === 0) return [period];

  const uncovered: DateRange[] = [];
  let cursor = period.startDate;

  for (const c of covered) {
    // Gap before this covered range
    if (isBefore(cursor, c.startDate)) {
      uncovered.push({
        startDate: cursor,
        endDate: addDays(c.startDate, -1),
      });
    }
    // Advance cursor past this covered range
    const dayAfter = addDays(c.endDate, 1);
    if (isAfter(dayAfter, cursor)) {
      cursor = dayAfter;
    }
  }

  // Remaining gap after last covered range
  if (!isAfter(cursor, period.endDate)) {
    uncovered.push({ startDate: cursor, endDate: period.endDate });
  }

  return uncovered;
}

// Main orchestration: expand schedules, compute category ranges, merge with sweep-line
export function buildOutdoorJournal(
  herds: HerdWithMembershipsAndSchedules[],
  queryFrom: Date,
  queryTo: Date
): OutdoorJournalResult {
  // Collect all category fragments across all herds
  const fragments: {
    category: AnimalCategory;
    startDate: Date;
    endDate: Date;
  }[] = [];
  // Track animals that have null category in some period vs animals that have a valid category in any period
  const animalIdsWithNullCategory = new Set<string>();
  const categorizedAnimalIds = new Set<string>();
  const uncategorizedAnimalMap = new Map<string, Animal>();

  for (const herd of herds) {
    // Expand all outdoor schedules for this herd
    const occurrences: DateRange[] = [];
    for (const schedule of herd.outdoorSchedules) {
      occurrences.push(...expandOutdoorSchedule(schedule, queryFrom, queryTo));
    }

    // For each occurrence, intersect with each membership period
    for (const occ of occurrences) {
      for (const membership of herd.herdMemberships) {
        const animal = membership.animal;

        // Compute effective period: intersection of membership range and occurrence range
        const memberTo = membership.toDate ?? occ.endDate;
        const effectiveStart = max([membership.fromDate, occ.startDate]);
        const effectiveEnd = min([memberTo, occ.endDate]);

        // Skip if no overlap
        if (isAfter(effectiveStart, effectiveEnd)) continue;

        // Skip dead animals (died before effective start)
        if (animal.dateOfDeath && isBefore(animal.dateOfDeath, effectiveStart)) continue;

        // Find custom outdoor journal categories that overlap the effective period
        const customCats = (animal.customOutdoorJournalCategories ?? [])
          .filter((c) => {
            const cEnd = c.endDate ?? effectiveEnd;
            return !isAfter(c.startDate, effectiveEnd) && !isBefore(cEnd, effectiveStart);
          })
          .map((c) => ({
            category: c.category,
            startDate: max([c.startDate, effectiveStart]),
            endDate: min([c.endDate ?? effectiveEnd, effectiveEnd]),
          }))
          .sort((a, b) => a.startDate.getTime() - b.startDate.getTime());

        // Add custom category fragments directly
        for (const c of customCats) {
          categorizedAnimalIds.add(animal.id);
          fragments.push({
            category: c.category,
            startDate: c.startDate,
            endDate: c.endDate,
          });
        }

        // Compute uncovered sub-periods (parts of effective period not covered by custom categories)
        const uncovered = subtractDateRanges({ startDate: effectiveStart, endDate: effectiveEnd }, customCats);

        // For uncovered periods, use age-based transitions
        for (const period of uncovered) {
          const transitions = getAnimalCategoryTransitions(animal, period.startDate, period.endDate);
          for (const t of transitions) {
            if (t.category === null) {
              animalIdsWithNullCategory.add(animal.id);
              uncategorizedAnimalMap.set(animal.id, animal);
            } else {
              categorizedAnimalIds.add(animal.id);
              fragments.push({
                category: t.category,
                startDate: t.startDate,
                endDate: t.endDate,
              });
            }
          }
        }
      }
    }
  }

  // Merge fragments by category using sweep-line
  const byCategory = new Map<AnimalCategory, { category: AnimalCategory; startDate: Date; endDate: Date }[]>();
  for (const f of fragments) {
    let list = byCategory.get(f.category);
    if (!list) {
      list = [];
      byCategory.set(f.category, list);
    }
    list.push(f);
  }

  const entries: OutdoorJournalEntry[] = [];

  for (const [category, categoryFragments] of byCategory) {
    // Build sweep events: +1 at start, -1 at end+1day
    const events: { date: number; delta: number }[] = [];
    for (const f of categoryFragments) {
      events.push({ date: f.startDate.getTime(), delta: 1 });
      events.push({ date: addDays(f.endDate, 1).getTime(), delta: -1 });
    }

    // Sort: by date, then +delta before -delta (so opens before closes on same date)
    events.sort((a, b) => a.date - b.date || b.delta - a.delta);

    let runningCount = 0;
    let segmentStart: number | null = null;
    let currentCount = 0;

    for (const event of events) {
      if (runningCount > 0 && segmentStart !== null && event.date !== segmentStart) {
        // Close current segment if count changes at a new date
        if (currentCount !== runningCount + event.delta || event.date !== segmentStart) {
          entries.push({
            category,
            startDate: new Date(segmentStart),
            // endDate is the day before this event
            endDate: addDays(new Date(event.date), -1),
            animalCount: runningCount,
          });
          segmentStart = null;
        }
      }

      runningCount += event.delta;

      if (runningCount > 0 && segmentStart === null) {
        segmentStart = event.date;
        currentCount = runningCount;
      } else if (runningCount > 0 && segmentStart !== null && runningCount !== currentCount) {
        // Count changed, start new segment
        segmentStart = event.date;
        currentCount = runningCount;
      } else if (runningCount === 0) {
        segmentStart = null;
        currentCount = 0;
      }
    }
  }

  // Sort by category then startDate
  entries.sort((a, b) => {
    const catCmp = a.category.localeCompare(b.category);
    if (catCmp !== 0) return catCmp;
    return a.startDate.getTime() - b.startDate.getTime();
  });

  // Uncategorized = animals that had null category but never had a valid category
  const uncategorizedAnimals = [...animalIdsWithNullCategory]
    .filter((id) => !categorizedAnimalIds.has(id))
    .map((id) => uncategorizedAnimalMap.get(id)!);

  return {
    entries,
    uncategorizedAnimals,
  };
}

export type MeadowJournalEntry = {
  meadowId: string;
  meadowName: string;
  meadowSize: number;
  herdId: string;
  herdName: string;
  type: OutdoorScheduleType;
  startDate: Date;
  endDate: Date;
  animalCount: number;
  animalCountsByType: Partial<Record<AnimalType, number>>;
};

type MeadowSummary = { id: string; name: string; size: number };

type HerdForMeadowJournal = Herd & {
  herdMemberships: (HerdMembership & { animal: Pick<Animal, "dateOfDeath" | "type"> })[];
  outdoorSchedules: (OutdoorScheduleWithRecurrence & { meadow: MeadowSummary | null })[];
};

// Lists which herd was on which meadow and for how long. Each occurrence of a meadow-linked schedule is split into
// segments with a constant number of animals per animal type (memberships starting/ending or animals dying change it).
export function buildMeadowJournal(
  herds: HerdForMeadowJournal[],
  queryFrom: Date,
  queryTo: Date
): MeadowJournalEntry[] {
  const entries: MeadowJournalEntry[] = [];

  for (const herd of herds) {
    for (const schedule of herd.outdoorSchedules) {
      const meadow = schedule.meadow;
      if (!meadow) continue;

      for (const occurrence of expandOutdoorSchedule(schedule, queryFrom, queryTo)) {
        // Per animal type: +1 on the first day an animal is present, -1 on the day after its last day
        const deltaByDate = new Map<number, Map<AnimalType, number>>();
        const addDelta = (date: number, animalType: AnimalType, delta: number) => {
          const deltasOnDate = deltaByDate.get(date) ?? new Map<AnimalType, number>();
          deltasOnDate.set(animalType, (deltasOnDate.get(animalType) ?? 0) + delta);
          deltaByDate.set(date, deltasOnDate);
        };
        for (const membership of herd.herdMemberships) {
          const presentEndCandidates = [membership.toDate ?? occurrence.endDate, occurrence.endDate];
          if (membership.animal.dateOfDeath) presentEndCandidates.push(membership.animal.dateOfDeath);
          const presentStart = max([membership.fromDate, occurrence.startDate]);
          const presentEnd = min(presentEndCandidates);
          if (isAfter(presentStart, presentEnd)) continue;

          addDelta(presentStart.getTime(), membership.animal.type, 1);
          addDelta(addDays(presentEnd, 1).getTime(), membership.animal.type, -1);
        }

        const sortedDates = [...deltaByDate.keys()].sort((a, b) => a - b);
        const runningCountsByType = new Map<AnimalType, number>();
        let runningCount = 0;
        let segmentStart: number | null = null;
        for (const date of sortedDates) {
          const deltasOnDate = [...(deltaByDate.get(date) ?? new Map<AnimalType, number>())].filter(
            ([, delta]) => delta !== 0
          );
          // Same-day arrivals and departures of the same type cancel out and don't split the segment
          if (deltasOnDate.length === 0) continue;
          if (runningCount > 0 && segmentStart !== null) {
            const animalCountsByType: Partial<Record<AnimalType, number>> = {};
            for (const [animalType, count] of runningCountsByType) {
              if (count > 0) animalCountsByType[animalType] = count;
            }
            entries.push({
              meadowId: meadow.id,
              meadowName: meadow.name,
              meadowSize: meadow.size,
              herdId: herd.id,
              herdName: herd.name,
              type: schedule.type,
              startDate: new Date(segmentStart),
              endDate: addDays(new Date(date), -1),
              animalCount: runningCount,
              animalCountsByType,
            });
          }
          for (const [animalType, delta] of deltasOnDate) {
            runningCountsByType.set(animalType, (runningCountsByType.get(animalType) ?? 0) + delta);
            runningCount += delta;
          }
          segmentStart = runningCount > 0 ? date : null;
        }
      }
    }
  }

  entries.sort(
    (a, b) =>
      a.meadowName.localeCompare(b.meadowName) ||
      a.startDate.getTime() - b.startDate.getTime() ||
      a.herdName.localeCompare(b.herdName)
  );
  return entries;
}
