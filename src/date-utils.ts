export const INFINITE_DATE = new Date("4999-12-31T00:00:00Z");
export function ensureDateRange(from?: Date, to?: Date) {
  return {
    from: from ?? new Date(2020, 0, 1),
    to: to ?? INFINITE_DATE,
  };
}

export function isInfiniteDate(date: Date) {
  return date.getTime() === INFINITE_DATE.getTime();
}

type DateRange = {
  fromDate: Date;
  toDate: Date;
};

export function hasOverlappingRanges(ranges: DateRange[]): boolean {
  if (ranges.length < 2) return false;

  // Sort by start date
  const sorted = [...ranges].sort((a, b) => a.fromDate.getTime() - b.fromDate.getTime());

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const current = sorted[i];

    // Overlap if current starts before previous ends
    if (current.fromDate.getTime() < prev.toDate.getTime()) {
      return true;
    }
  }

  return false;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Adds whole days to a UTC-midnight date (as stored for date columns). Unlike date-fns addDays it ignores the
// server's local timezone, so DST changes can't shift the result off midnight onto a neighbouring day.
export function addUtcDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}
