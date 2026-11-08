import { differenceInDays, addDays } from "date-fns";
import { AnimalCategory, AnimalSex, AnimalType } from "./animals";

type AnimalKeyRule = {
  minAgeDays: number;
  maxAgeDays?: number;
  sex?: AnimalSex;
  onlyMilking?: boolean;
  key: AnimalCategory;
};

export const animalKeyMapping: Record<AnimalType, AnimalKeyRule[]> = {
  cow: [
    {
      minAgeDays: 366,
      onlyMilking: true,
      sex: "female",
      key: "A1",
    },
    {
      minAgeDays: 366,
      sex: "female",
      key: "A2",
    },
    {
      minAgeDays: 365,
      sex: "female",
      key: "A3",
    },
    {
      minAgeDays: 161,
      maxAgeDays: 364,
      sex: "female",
      key: "A4",
    },
    {
      minAgeDays: 0,
      maxAgeDays: 160,
      sex: "female",
      key: "A5",
    },
    {
      minAgeDays: 730,
      sex: "male",
      key: "A6",
    },
    {
      minAgeDays: 366,
      maxAgeDays: 729,
      sex: "male",
      key: "A7",
    },
    {
      minAgeDays: 160,
      maxAgeDays: 365,
      sex: "male",
      key: "A8",
    },
  ],
  goat: [
    {
      minAgeDays: 365,
      sex: "female",
      key: "C1",
    },
    {
      minAgeDays: 365,
      sex: "male",
      key: "C2",
    },
  ],
  sheep: [
    {
      minAgeDays: 365,
      sex: "female",
      key: "D1",
    },
    {
      minAgeDays: 365,
      sex: "male",
      key: "D2",
    },
    {
      minAgeDays: 0,
      maxAgeDays: 364,
      key: "D3",
    },
  ],
  horse: [
    {
      minAgeDays: 900,
      sex: "female",
      key: "B1",
    },
    {
      minAgeDays: 900,
      sex: "male",
      key: "B2",
    },
    {
      minAgeDays: 0,
      maxAgeDays: 899,
      key: "B3",
    },
  ],
  donkey: [
    {
      minAgeDays: 900,
      sex: "female",
      key: "B1",
    },
    {
      minAgeDays: 900,
      sex: "male",
      key: "B2",
    },
    {
      minAgeDays: 0,
      maxAgeDays: 899,
      key: "B3",
    },
  ],
  deer: [],
  pig: [],
};

type CategoryAnimal = {
  type: AnimalType;
  sex: AnimalSex;
  usage: "milk" | "other";
  dateOfBirth: Date;
};

// First-match lookup against the mapping rules for a given animal at a reference date
export function mapAnimalToCategory(animal: CategoryAnimal, referenceDate: Date): AnimalCategory | null {
  const ageDays = differenceInDays(referenceDate, animal.dateOfBirth);
  const rules = animalKeyMapping[animal.type];

  for (const rule of rules) {
    if (rule.sex && rule.sex !== animal.sex) continue;
    if (rule.onlyMilking && animal.usage !== "milk") continue;
    if (ageDays < rule.minAgeDays) continue;
    if (rule.maxAgeDays !== undefined && ageDays > rule.maxAgeDays) continue;
    return rule.key;
  }
  return null;
}

// Returns category ranges for an animal within a period, splitting at age-boundary transitions
export function getAnimalCategoryTransitions(
  animal: CategoryAnimal,
  periodStart: Date,
  periodEnd: Date
): { category: AnimalCategory | null; startDate: Date; endDate: Date }[] {
  const rules = animalKeyMapping[animal.type];

  // Collect all age threshold dates that fall within the period
  const thresholdDates = new Set<number>();
  thresholdDates.add(periodStart.getTime());
  thresholdDates.add(periodEnd.getTime());

  for (const rule of rules) {
    // Each minAgeDays and maxAgeDays+1 is a potential transition point
    for (const days of [rule.minAgeDays, rule.maxAgeDays !== undefined ? rule.maxAgeDays + 1 : undefined]) {
      if (days === undefined) continue;
      const thresholdDate = addDays(animal.dateOfBirth, days);
      const t = thresholdDate.getTime();
      if (t > periodStart.getTime() && t < periodEnd.getTime()) {
        thresholdDates.add(t);
      }
    }
  }

  const sortedDates = Array.from(thresholdDates).sort((a, b) => a - b);

  // Build sub-period entries
  const rawEntries: {
    category: AnimalCategory | null;
    startDate: Date;
    endDate: Date;
  }[] = [];
  for (let i = 0; i < sortedDates.length - 1; i++) {
    const subStart = new Date(sortedDates[i]);
    const subEnd = new Date(sortedDates[i + 1]);
    const category = mapAnimalToCategory(animal, subStart);
    rawEntries.push({ category, startDate: subStart, endDate: subEnd });
  }

  // Handle single-point period edge case
  if (rawEntries.length === 0) {
    const category = mapAnimalToCategory(animal, periodStart);
    return [{ category, startDate: periodStart, endDate: periodEnd }];
  }

  // Coalesce adjacent sub-periods with the same category
  const coalesced: typeof rawEntries = [rawEntries[0]];
  for (let i = 1; i < rawEntries.length; i++) {
    const prev = coalesced[coalesced.length - 1];
    const curr = rawEntries[i];
    if (prev.category === curr.category) {
      prev.endDate = curr.endDate;
    } else {
      coalesced.push(curr);
    }
  }

  return coalesced;
}
