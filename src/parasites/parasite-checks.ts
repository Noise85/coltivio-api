import { and, eq, inArray } from "drizzle-orm";
import { TFunction } from "i18next";
import createHttpError from "http-errors";
import { RlsDb, Transaction } from "../db/db";
import {
  animals,
  currentFarmId,
  farmIdColumnValue,
  farmMembers,
  parasiteCheckAnimals,
  parasiteChecks,
  parasiteFecResults,
  parasiteFecSampleAnimals,
  parasiteFecSamples,
  taskLinks,
  tasks,
} from "../db/schema";

export type ParasiteCheck = typeof parasiteChecks.$inferSelect;
type AnimalType = typeof animals.$inferSelect.type;
export type ParasiteCheckMethod = ParasiteCheck["method"];
export type ParasiteType = typeof parasiteFecResults.$inferSelect.parasiteType;
export type ParasiteResultGrade = NonNullable<typeof parasiteFecResults.$inferSelect.grade>;
// A result is either a count per gram or a grade (+/++/+++)
export type ParasiteResult = {
  parasiteType: ParasiteType;
  countPerGram: number | null;
  grade: ParasiteResultGrade | null;
};
const GRADE_ORDER: ParasiteResultGrade[] = ["negative", "low", "medium", "high"];

export type ParasiteFecSampleInput = {
  label?: string | null;
  animalIds: string[];
  results: { parasiteType: ParasiteType; countPerGram?: number | null; grade?: ParasiteResultGrade | null }[];
};

export type ParasiteCheckAnimalInput = {
  animalId: string;
  famachaScore?: number | null;
};

export type ParasiteCheckFollowUpInput = {
  dueDate: Date;
  name?: string;
  assigneeId?: string;
};

export type ParasiteCheckCreateInput = {
  date: Date;
  name?: string | null;
  method: ParasiteCheckMethod;
  animals: ParasiteCheckAnimalInput[];
  fecSamples?: ParasiteFecSampleInput[];
  labName?: string | null;
  notes?: string | null;
  previousCheckId?: string | null;
  treatmentId?: string | null;
  followUp?: ParasiteCheckFollowUpInput;
};

// animals/fecSamples: undefined = keep as-is, array = replace all
export type ParasiteCheckUpdateInput = Partial<Omit<ParasiteCheckCreateInput, "followUp">>;

export type ParasiteCheckListFilters = {
  animalId?: string;
  from?: Date;
  to?: Date;
};

export type FecParasiteSummary = {
  parasiteType: ParasiteType;
  sampleCount: number;
  minCountPerGram: number;
  avgCountPerGram: number;
  maxCountPerGram: number;
};

export type ParasiteCheckSummary = {
  animalCount: number;
  famachaAverage: number | null;
  famachaDistribution: { score: number; count: number }[];
  // Counts only; graded results are summarized separately
  fecByParasite: FecParasiteSummary[];
  gradesByParasite: {
    parasiteType: ParasiteType;
    sampleCount: number;
    highestGrade: ParasiteResultGrade;
    // Index in GRADE_ORDER (0 = negative … 3 = high), averaged per sample like the
    // counts; lies between the steps, e.g. 1.5 = between low and medium
    averageGrade: number;
  }[];
};

export type ParasiteCheckComparison = {
  previousCheckId: string;
  previousDate: Date;
  // FAMACHA averages over the animals scored in both checks, and their difference
  famachaBeforeAverage: number | null;
  famachaAfterAverage: number | null;
  famachaAverageChange: number | null;
  // Fecal egg count reduction per parasite: (1 - after/before) * 100
  fecReduction: {
    parasiteType: ParasiteType;
    beforeAvgCountPerGram: number;
    afterAvgCountPerGram: number;
    // Number of samples the after average is based on (> 1 = average of individual samples)
    afterSampleCount: number;
    reductionPercent: number | null;
  }[];
};

export type ParasiteCheckDetail = ParasiteCheck & {
  // All animals of a check are of the same type
  animalType: AnimalType | null;
  treatment: { id: string; name: string; startDate: Date } | null;
  animals: { animalId: string; name: string; earTagNumber: string | null; famachaScore: number | null }[];
  fecSamples: {
    id: string;
    label: string | null;
    pooled: boolean;
    animalIds: string[];
    results: ParasiteResult[];
  }[];
  followUpTasks: { id: string; name: string; dueDate: Date | null; status: "todo" | "done" }[];
  summary: ParasiteCheckSummary;
  comparisonToPrevious: ParasiteCheckComparison | null;
  // Later checks that follow up on this one, compared against this check
  rechecks: {
    id: string;
    date: Date;
    name: string | null;
    method: ParasiteCheckMethod;
    treatment: { id: string; name: string; startDate: Date } | null;
    // Per-animal FAMACHA scores and their average, for charting the re-check
    animals: { animalId: string; famachaScore: number | null }[];
    famachaAverage: number | null;
    famachaBeforeAverage: number | null;
    famachaAfterAverage: number | null;
    famachaAverageChange: number | null;
    fecReduction: ParasiteCheckComparison["fecReduction"];
  }[];
};

export type AnimalParasiteHistory = {
  checks: { checkId: string; date: Date; method: ParasiteCheckMethod; famachaScore: number | null }[];
  fecResults: {
    checkId: string;
    sampleId: string;
    date: Date;
    pooled: boolean;
    poolSize: number;
    results: ParasiteResult[];
  }[];
  treatments: { id: string; name: string; startDate: Date; endDate: Date; drugName: string | null }[];
};

const checkWith = {
  treatment: true,
  animals: { with: { animal: { with: { earTag: true } } } },
  fecSamples: { with: { animals: true, results: true } },
} as const;

type LoadedCheck = NonNullable<Awaited<ReturnType<typeof loadCheck>>>;

function loadCheck(tx: Transaction, id: string) {
  return tx.query.parasiteChecks.findFirst({ where: { id }, with: checkWith });
}

function summarizeCheck(check: LoadedCheck): ParasiteCheckSummary {
  const famachaScores = check.animals.flatMap((checkAnimal) =>
    checkAnimal.famachaScore === null ? [] : [checkAnimal.famachaScore]
  );
  const famachaDistribution = [1, 2, 3, 4, 5].map((score) => ({
    score,
    count: famachaScores.filter((famachaScore) => famachaScore === score).length,
  }));

  const countPerGramByParasite = new Map<ParasiteType, number[]>();
  const gradesByParasiteType = new Map<ParasiteType, ParasiteResultGrade[]>();
  for (const sample of check.fecSamples) {
    for (const result of sample.results) {
      if (result.countPerGram !== null) {
        const values = countPerGramByParasite.get(result.parasiteType) ?? [];
        values.push(result.countPerGram);
        countPerGramByParasite.set(result.parasiteType, values);
      }
      if (result.grade !== null) {
        const grades = gradesByParasiteType.get(result.parasiteType) ?? [];
        grades.push(result.grade);
        gradesByParasiteType.set(result.parasiteType, grades);
      }
    }
  }
  const gradesByParasite = [...gradesByParasiteType.entries()].map(([parasiteType, grades]) => {
    const gradeIndexes = grades.map((grade) => GRADE_ORDER.indexOf(grade));
    return {
      parasiteType,
      sampleCount: grades.length,
      highestGrade: GRADE_ORDER[Math.max(...gradeIndexes)],
      averageGrade: average(gradeIndexes),
    };
  });
  const fecByParasite = [...countPerGramByParasite.entries()].map(([parasiteType, values]) => ({
    parasiteType,
    sampleCount: values.length,
    minCountPerGram: Math.min(...values),
    avgCountPerGram: values.reduce((sum, value) => sum + value, 0) / values.length,
    maxCountPerGram: Math.max(...values),
  }));

  return {
    animalCount: check.animals.length,
    famachaAverage:
      famachaScores.length > 0 ? famachaScores.reduce((sum, score) => sum + score, 0) / famachaScores.length : null,
    famachaDistribution,
    fecByParasite,
    gradesByParasite,
  };
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// Compares a re-check with its base check. Only like is compared with like, so a
// smaller re-check group doesn't show a reduction that isn't there:
// - FAMACHA: the animals scored in both checks
// - samples: only samples taken from exactly the same animals (one animal or the
//   same pool); without such pairs the averages are returned without a percent
function compareToPrevious(recheck: LoadedCheck, baseCheck: LoadedCheck): ParasiteCheckComparison {
  const baseScores = new Map<string, number>();
  for (const baseAnimal of baseCheck.animals) {
    if (baseAnimal.famachaScore !== null) baseScores.set(baseAnimal.animalId, baseAnimal.famachaScore);
  }
  const scorePairs = recheck.animals.flatMap((recheckAnimal) => {
    const before = baseScores.get(recheckAnimal.animalId);
    return recheckAnimal.famachaScore !== null && before !== undefined
      ? [{ before, after: recheckAnimal.famachaScore }]
      : [];
  });

  const famachaBeforeAverage = scorePairs.length > 0 ? average(scorePairs.map((pair) => pair.before)) : null;
  const famachaAfterAverage = scorePairs.length > 0 ? average(scorePairs.map((pair) => pair.after)) : null;

  const recheckParasiteTypes = [
    ...new Set(recheck.fecSamples.flatMap((sample) => sample.results.map((result) => result.parasiteType))),
  ];
  const fecReduction = recheckParasiteTypes.flatMap((parasiteType) => {
    const samplesWithType = (check: LoadedCheck) =>
      check.fecSamples.flatMap((sample) => {
        // Graded results (+/++/+++) can't be compared as numbers
        const result = sample.results.find((entry) => entry.parasiteType === parasiteType);
        return result && result.countPerGram !== null
          ? [
              {
                pooled: sample.animals.length > 1,
                animalIds: sample.animals.map((sampleAnimal) => sampleAnimal.animalId),
                countPerGram: result.countPerGram,
              },
            ]
          : [];
      });
    const afterSamples = samplesWithType(recheck);
    const beforeSamples = samplesWithType(baseCheck);
    if (afterSamples.length === 0 || beforeSamples.length === 0) return [];

    // Pair samples that were taken from exactly the same animals
    const sampleKey = (animalIds: string[]) => [...animalIds].sort().join(",");
    const beforeByAnimals = new Map(beforeSamples.map((sample) => [sampleKey(sample.animalIds), sample.countPerGram]));
    const pairs = afterSamples.flatMap((sample) => {
      const before = beforeByAnimals.get(sampleKey(sample.animalIds));
      return before !== undefined ? [{ before, after: sample.countPerGram }] : [];
    });
    const comparable = pairs.length > 0;
    const beforeValues = comparable
      ? pairs.map((pair) => pair.before)
      : beforeSamples.map((sample) => sample.countPerGram);
    const afterValues = comparable
      ? pairs.map((pair) => pair.after)
      : afterSamples.map((sample) => sample.countPerGram);

    const beforeAverage = average(beforeValues);
    const afterAverage = average(afterValues);
    return [
      {
        parasiteType,
        beforeAvgCountPerGram: beforeAverage,
        afterAvgCountPerGram: afterAverage,
        afterSampleCount: afterValues.length,
        reductionPercent: comparable && beforeAverage > 0 ? (1 - afterAverage / beforeAverage) * 100 : null,
      },
    ];
  });

  return {
    previousCheckId: baseCheck.id,
    previousDate: baseCheck.date,
    famachaBeforeAverage: famachaBeforeAverage,
    famachaAfterAverage: famachaAfterAverage,
    famachaAverageChange:
      famachaBeforeAverage !== null && famachaAfterAverage !== null ? famachaAfterAverage - famachaBeforeAverage : null,
    fecReduction,
  };
}

// Builds API responses for loaded checks, including comparison to previous checks and linked follow-up tasks
async function toDetails(tx: Transaction, checks: LoadedCheck[]): Promise<ParasiteCheckDetail[]> {
  if (checks.length === 0) return [];

  // Previous checks may be outside the requested filter, load the missing ones
  const loadedCheckIds = new Set(checks.map((check) => check.id));
  const missingPreviousIds = [
    ...new Set(checks.flatMap((check) => (check.previousCheckId ? [check.previousCheckId] : []))),
  ].filter((previousId) => !loadedCheckIds.has(previousId));
  const missingPreviousChecks =
    missingPreviousIds.length > 0
      ? await tx.query.parasiteChecks.findMany({ where: { id: { in: missingPreviousIds } }, with: checkWith })
      : [];
  const checksById = new Map([...checks, ...missingPreviousChecks].map((check) => [check.id, check]));

  const rechecks = await tx.query.parasiteChecks.findMany({
    where: { previousCheckId: { in: checks.map((check) => check.id) } },
    with: checkWith,
    orderBy: { date: "asc", createdAt: "asc" },
  });

  const followUpTaskRows = await tx
    .select({
      checkId: taskLinks.linkedId,
      id: tasks.id,
      name: tasks.name,
      dueDate: tasks.dueDate,
      status: tasks.status,
    })
    .from(taskLinks)
    .innerJoin(tasks, eq(tasks.id, taskLinks.taskId))
    .where(
      and(
        eq(taskLinks.linkType, "parasite_check"),
        inArray(
          taskLinks.linkedId,
          checks.map((check) => check.id)
        )
      )
    );

  return checks.map((check) => {
    const summary = summarizeCheck(check);
    const previousCheck = check.previousCheckId ? checksById.get(check.previousCheckId) : undefined;
    const { treatment, animals: checkAnimals, fecSamples, ...checkColumns } = check;

    return {
      ...checkColumns,
      animalType: checkAnimals[0]?.animal.type ?? null,
      treatment: treatment ? { id: treatment.id, name: treatment.name, startDate: treatment.startDate } : null,
      animals: checkAnimals.map((checkAnimal) => ({
        animalId: checkAnimal.animalId,
        name: checkAnimal.animal.name,
        earTagNumber: checkAnimal.animal.earTag?.number ?? null,
        famachaScore: checkAnimal.famachaScore,
      })),
      fecSamples: fecSamples.map((sample) => ({
        id: sample.id,
        label: sample.label,
        pooled: sample.animals.length > 1,
        animalIds: sample.animals.map((sampleAnimal) => sampleAnimal.animalId),
        results: sample.results.map((result) => ({
          parasiteType: result.parasiteType,
          countPerGram: result.countPerGram,
          grade: result.grade,
        })),
      })),
      followUpTasks: followUpTaskRows
        .filter((taskRow) => taskRow.checkId === check.id)
        .map(({ checkId: _checkId, ...taskRow }) => taskRow),
      summary,
      comparisonToPrevious: previousCheck ? compareToPrevious(check, previousCheck) : null,
      rechecks: rechecks
        .filter((recheck) => recheck.previousCheckId === check.id)
        .map((recheck) => {
          const recheckSummary = summarizeCheck(recheck);
          const comparison = compareToPrevious(recheck, check);
          return {
            id: recheck.id,
            date: recheck.date,
            name: recheck.name,
            method: recheck.method,
            treatment: recheck.treatment
              ? { id: recheck.treatment.id, name: recheck.treatment.name, startDate: recheck.treatment.startDate }
              : null,
            animals: recheck.animals.map((recheckAnimal) => ({
              animalId: recheckAnimal.animalId,
              famachaScore: recheckAnimal.famachaScore,
            })),
            famachaAverage: recheckSummary.famachaAverage,
            famachaBeforeAverage: comparison.famachaBeforeAverage,
            famachaAfterAverage: comparison.famachaAfterAverage,
            famachaAverageChange: comparison.famachaAverageChange,
            fecReduction: comparison.fecReduction,
          };
        }),
    };
  });
}

// FKs bypass RLS, so referenced ids must be checked explicitly to belong to the current farm
async function assertReferencesVisible(
  tx: Transaction,
  references: {
    treatmentId?: string | null;
    previousCheckId?: string | null;
    animalIds: string[];
  }
) {
  if (references.treatmentId) {
    const treatment = await tx.query.treatments.findFirst({ where: { id: references.treatmentId } });
    if (!treatment) throw createHttpError(404, "Treatment not found");
  }
  if (references.previousCheckId) {
    const previousCheck = await tx.query.parasiteChecks.findFirst({ where: { id: references.previousCheckId } });
    if (!previousCheck) throw createHttpError(404, "Previous check not found");
  }
  const uniqueAnimalIds = [...new Set(references.animalIds)];
  if (uniqueAnimalIds.length > 0) {
    const visibleAnimals = await tx.query.animals.findMany({
      where: { id: { in: uniqueAnimalIds } },
      columns: { id: true },
    });
    if (visibleAnimals.length !== uniqueAnimalIds.length) throw createHttpError(404, "Animal not found");
  }
}

async function replaceCheckAnimals(tx: Transaction, checkId: string, checkAnimals: ParasiteCheckAnimalInput[]) {
  await tx.delete(parasiteCheckAnimals).where(eq(parasiteCheckAnimals.checkId, checkId));
  // Dedupe by animal; a given score wins over a missing one
  const checkAnimalsById = new Map<string, ParasiteCheckAnimalInput>();
  for (const checkAnimal of checkAnimals) {
    const existing = checkAnimalsById.get(checkAnimal.animalId);
    if (existing && existing.famachaScore != null && checkAnimal.famachaScore == null) continue;
    checkAnimalsById.set(checkAnimal.animalId, checkAnimal);
  }
  if (checkAnimalsById.size === 0) return;
  await tx.insert(parasiteCheckAnimals).values(
    [...checkAnimalsById.values()].map((checkAnimal) => ({
      ...farmIdColumnValue,
      checkId,
      animalId: checkAnimal.animalId,
      famachaScore: checkAnimal.famachaScore ?? null,
    }))
  );
}

async function replaceFecSamples(tx: Transaction, checkId: string, fecSamples: ParasiteFecSampleInput[]) {
  // Sample animals and results cascade
  await tx.delete(parasiteFecSamples).where(eq(parasiteFecSamples.checkId, checkId));
  for (const sampleInput of fecSamples) {
    const [sample] = await tx
      .insert(parasiteFecSamples)
      .values({ ...farmIdColumnValue, checkId, label: sampleInput.label ?? null })
      .returning();
    await tx
      .insert(parasiteFecSampleAnimals)
      .values(
        [...new Set(sampleInput.animalIds)].map((animalId) => ({ ...farmIdColumnValue, sampleId: sample.id, animalId }))
      );
    if (sampleInput.results.length > 0) {
      await tx.insert(parasiteFecResults).values(
        sampleInput.results.map((result) => ({
          ...farmIdColumnValue,
          sampleId: sample.id,
          parasiteType: result.parasiteType,
          countPerGram: result.countPerGram ?? null,
          grade: result.grade ?? null,
        }))
      );
    }
  }
}

// Re-checks always belong to a base check (not chained) and repeat its measurement:
// same method, only animals of the base check and not before it
async function assertRecheckLinkValid(tx: Transaction, check: LoadedCheck) {
  // A base check must stay in line with its re-checks
  const ownRechecks = await tx.query.parasiteChecks.findMany({
    where: { previousCheckId: check.id },
    with: { animals: true },
  });
  if (ownRechecks.length > 0) {
    if (check.previousCheckId) {
      throw createHttpError(400, "A check with re-checks cannot become a re-check");
    }
    if (ownRechecks.some((recheck) => recheck.method !== check.method)) {
      throw createHttpError(400, "The method of a check with re-checks cannot be changed");
    }
    const checkAnimalIds = new Set(check.animals.map((checkAnimal) => checkAnimal.animalId));
    const recheckHasForeignAnimal = ownRechecks.some((recheck) =>
      recheck.animals.some((recheckAnimal) => !checkAnimalIds.has(recheckAnimal.animalId))
    );
    if (recheckHasForeignAnimal) {
      throw createHttpError(400, "Animals of a check with re-checks cannot be removed");
    }
    if (ownRechecks.some((recheck) => recheck.date < check.date)) {
      throw createHttpError(400, "A check cannot be dated after its re-checks");
    }
  }

  if (!check.previousCheckId) return;
  // Locks the base check so it cannot become a re-check or change concurrently
  const [baseCheck] = await tx
    .select()
    .from(parasiteChecks)
    .where(eq(parasiteChecks.id, check.previousCheckId))
    .for("update");
  if (!baseCheck) throw createHttpError(404, "Previous check not found");
  if (baseCheck.previousCheckId) {
    throw createHttpError(400, "A re-check can only follow up on a base check");
  }
  if (baseCheck.method !== check.method) {
    throw createHttpError(400, "A re-check must use the same method as its base check");
  }
  if (check.date < baseCheck.date) {
    throw createHttpError(400, "A re-check cannot be dated before its base check");
  }
  const baseAnimals = await tx.query.parasiteCheckAnimals.findMany({ where: { checkId: baseCheck.id } });
  const baseAnimalIds = new Set(baseAnimals.map((baseAnimal) => baseAnimal.animalId));
  if (check.animals.some((checkAnimal) => !baseAnimalIds.has(checkAnimal.animalId))) {
    throw createHttpError(400, "A re-check can only include animals of its base check");
  }
}

// Validates the final state of a check after create/update (runs inside the transaction, throwing rolls back)
function assertCheckConsistent(check: LoadedCheck, animalsChanged: boolean) {
  // Only checked when animals are set: a check whose animals were all deleted from
  // the farm stays editable (e.g. its notes)
  if (animalsChanged && check.animals.length === 0) {
    throw createHttpError(400, "A check needs at least one animal");
  }
  // Mixed animal types would make averages and charts meaningless
  if (new Set(check.animals.map((checkAnimal) => checkAnimal.animal.type)).size > 1) {
    throw createHttpError(400, "All animals of a check must be of the same animal type");
  }
  if (check.method !== "famacha" && check.animals.some((checkAnimal) => checkAnimal.famachaScore !== null)) {
    throw createHttpError(400, "FAMACHA scores are only allowed for famacha checks");
  }
  if (check.method !== "fecal_egg_count" && check.fecSamples.length > 0) {
    throw createHttpError(400, "Fecal samples are only allowed for fecal_egg_count checks");
  }
  const checkAnimalIds = new Set(check.animals.map((checkAnimal) => checkAnimal.animalId));
  const sampleHasForeignAnimal = check.fecSamples.some((sample) =>
    sample.animals.some((sampleAnimal) => !checkAnimalIds.has(sampleAnimal.animalId))
  );
  if (sampleHasForeignAnimal) {
    throw createHttpError(400, "Fecal sample animals must be part of the check");
  }
  const sampleAnimalIds = check.fecSamples.flatMap((sample) =>
    sample.animals.map((sampleAnimal) => sampleAnimal.animalId)
  );
  if (new Set(sampleAnimalIds).size !== sampleAnimalIds.length) {
    throw createHttpError(400, "An animal can only be part of one fecal sample per check");
  }
}

export function parasiteChecksApi(rlsDb: RlsDb, t: TFunction) {
  return {
    async createCheck(input: ParasiteCheckCreateInput, userId: string): Promise<ParasiteCheckDetail> {
      return rlsDb.rls(async (tx) => {
        await assertReferencesVisible(tx, {
          treatmentId: input.treatmentId,
          previousCheckId: input.previousCheckId,
          animalIds: [
            ...input.animals.map((checkAnimal) => checkAnimal.animalId),
            ...(input.fecSamples ?? []).flatMap((sample) => sample.animalIds),
          ],
        });

        const checkAnimals = input.animals;

        const [check] = await tx
          .insert(parasiteChecks)
          .values({
            ...farmIdColumnValue,
            date: input.date,
            // An empty name means no name (same as on update)
            name: input.name?.trim() || null,
            method: input.method,
            labName: input.labName ?? null,
            notes: input.notes ?? null,
            previousCheckId: input.previousCheckId ?? null,
            treatmentId: input.treatmentId ?? null,
            createdBy: userId,
          })
          .returning();

        await replaceCheckAnimals(tx, check.id, checkAnimals);
        await replaceFecSamples(tx, check.id, input.fecSamples ?? []);

        const loadedCheck = await loadCheck(tx, check.id);
        if (!loadedCheck) throw createHttpError(404, "Parasite check not found");
        assertCheckConsistent(loadedCheck, true);
        await assertRecheckLinkValid(tx, loadedCheck);

        // Optional reminder to re-check (client-side toggle)
        if (input.followUp?.assigneeId) {
          const [assigneeMembership] = await tx
            .select({ id: farmMembers.id })
            .from(farmMembers)
            .where(and(eq(farmMembers.userId, input.followUp.assigneeId), eq(farmMembers.farmId, currentFarmId)));
          if (!assigneeMembership) throw createHttpError(404, "Assignee not found");
        }
        if (input.followUp) {
          const followUpName =
            input.followUp.name ??
            (loadedCheck.name
              ? t("parasite_checks.follow_up_task_name_with_name", { name: loadedCheck.name })
              : t("parasite_checks.follow_up_task_name"));
          const [task] = await tx
            .insert(tasks)
            .values({
              ...farmIdColumnValue,
              name: followUpName,
              dueDate: input.followUp.dueDate,
              assigneeId: input.followUp.assigneeId,
              createdBy: userId,
            })
            .returning();
          await tx
            .insert(taskLinks)
            .values({ ...farmIdColumnValue, taskId: task.id, linkType: "parasite_check", linkedId: check.id });
        }

        const [detail] = await toDetails(tx, [loadedCheck]);
        return detail;
      });
    },

    async getCheck(id: string): Promise<ParasiteCheckDetail | undefined> {
      return rlsDb.rls(async (tx) => {
        const check = await loadCheck(tx, id);
        if (!check) return undefined;
        const [detail] = await toDetails(tx, [check]);
        return detail;
      });
    },

    async listChecks(filters: ParasiteCheckListFilters): Promise<ParasiteCheckDetail[]> {
      return rlsDb.rls(async (tx) => {
        let checkIdsForAnimal: string[] | undefined;
        if (filters.animalId) {
          const rows = await tx
            .select({ checkId: parasiteCheckAnimals.checkId })
            .from(parasiteCheckAnimals)
            .where(eq(parasiteCheckAnimals.animalId, filters.animalId));
          checkIdsForAnimal = rows.map((row) => row.checkId);
          if (checkIdsForAnimal.length === 0) return [];
        }

        const checks = await tx.query.parasiteChecks.findMany({
          where: {
            ...(checkIdsForAnimal ? { id: { in: checkIdsForAnimal } } : {}),
            ...(filters.from || filters.to
              ? {
                  date: {
                    ...(filters.from ? { gte: filters.from } : {}),
                    ...(filters.to ? { lte: filters.to } : {}),
                  },
                }
              : {}),
          },
          with: checkWith,
          orderBy: { date: "desc", createdAt: "desc" },
        });
        return toDetails(tx, checks);
      });
    },

    async updateCheck(id: string, input: ParasiteCheckUpdateInput): Promise<ParasiteCheckDetail> {
      return rlsDb.rls(async (tx) => {
        const existingCheck = await tx.query.parasiteChecks.findFirst({
          where: { id },
          with: { animals: true },
        });
        if (!existingCheck) throw createHttpError(404, "Parasite check not found");
        if (input.previousCheckId === id) {
          throw createHttpError(400, "A check cannot be its own previous check");
        }

        // A base check with re-checks keeps its method and animals
        const hasRechecks = await tx.query.parasiteChecks.findFirst({ where: { previousCheckId: id } });
        if (hasRechecks) {
          const methodChanged = input.method !== undefined && input.method !== existingCheck.method;
          const existingAnimalIds = new Set(existingCheck.animals.map((checkAnimal) => checkAnimal.animalId));
          const inputAnimalIds = new Set((input.animals ?? []).map((checkAnimal) => checkAnimal.animalId));
          const animalsChanged =
            input.animals !== undefined &&
            (inputAnimalIds.size !== existingAnimalIds.size ||
              [...inputAnimalIds].some((animalId) => !existingAnimalIds.has(animalId)));
          if (methodChanged || animalsChanged) {
            throw createHttpError(400, "Method and animals of a check with re-checks cannot be changed");
          }
        }

        await assertReferencesVisible(tx, {
          treatmentId: input.treatmentId,
          previousCheckId: input.previousCheckId,
          animalIds: [
            ...(input.animals ?? []).map((checkAnimal) => checkAnimal.animalId),
            ...(input.fecSamples ?? []).flatMap((sample) => sample.animalIds),
          ],
        });

        const { animals: checkAnimals, fecSamples, ...checkColumns } = input;
        await tx
          .update(parasiteChecks)
          .set({
            ...checkColumns,
            // Same as on create: an empty name means no name
            ...(checkColumns.name !== undefined ? { name: checkColumns.name?.trim() || null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(parasiteChecks.id, id));

        if (checkAnimals !== undefined) await replaceCheckAnimals(tx, id, checkAnimals);
        if (fecSamples !== undefined) await replaceFecSamples(tx, id, fecSamples);

        const loadedCheck = await loadCheck(tx, id);
        if (!loadedCheck) throw createHttpError(404, "Parasite check not found");
        assertCheckConsistent(loadedCheck, checkAnimals !== undefined);
        await assertRecheckLinkValid(tx, loadedCheck);

        const [detail] = await toDetails(tx, [loadedCheck]);
        return detail;
      });
    },

    async deleteCheck(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        // Re-checks are deleted with their base check (FK cascade); their task links too
        const rechecks = await tx.query.parasiteChecks.findMany({ where: { previousCheckId: id } });
        const deleted = await tx.delete(parasiteChecks).where(eq(parasiteChecks.id, id)).returning();
        if (deleted.length === 0) throw createHttpError(404, "Parasite check not found");
        await tx
          .delete(taskLinks)
          .where(
            and(
              eq(taskLinks.linkType, "parasite_check"),
              inArray(taskLinks.linkedId, [id, ...rechecks.map((recheck) => recheck.id)])
            )
          );
      });
    },

    async getAnimalParasiteHistory(
      animalId: string,
      range: { from?: Date; to?: Date }
    ): Promise<AnimalParasiteHistory> {
      return rlsDb.rls(async (tx) => {
        const animal = await tx.query.animals.findFirst({ where: { id: animalId }, columns: { id: true } });
        if (!animal) throw createHttpError(404, "Animal not found");

        const isInRange = (date: Date) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

        const checkRows = await tx.query.parasiteCheckAnimals.findMany({
          where: { animalId },
          with: { check: true },
        });
        const checks = checkRows
          .filter((row) => isInRange(row.check.date))
          .map((row) => ({
            checkId: row.checkId,
            date: row.check.date,
            method: row.check.method,
            famachaScore: row.famachaScore,
          }))
          .sort((a, b) => b.date.getTime() - a.date.getTime());

        const sampleRows = await tx.query.parasiteFecSampleAnimals.findMany({
          where: { animalId },
          with: { sample: { with: { check: true, animals: true, results: true } } },
        });
        const fecResults = sampleRows
          .filter((row) => isInRange(row.sample.check.date))
          .map((row) => ({
            checkId: row.sample.checkId,
            sampleId: row.sampleId,
            date: row.sample.check.date,
            pooled: row.sample.animals.length > 1,
            poolSize: row.sample.animals.length,
            results: row.sample.results.map((result) => ({
              parasiteType: result.parasiteType,
              countPerGram: result.countPerGram,
              grade: result.grade,
            })),
          }))
          .sort((a, b) => b.date.getTime() - a.date.getTime());

        // Only treatments linked to a parasite check of this animal, and only if the
        // animal was part of the treatment (selective deworming treats just some)
        const linkedTreatmentIds = new Set(
          checkRows.flatMap((row) => (row.check.treatmentId ? [row.check.treatmentId] : []))
        );
        const treatmentRows =
          linkedTreatmentIds.size > 0
            ? await tx.query.animalTreatments.findMany({
                where: { animalId, treatmentId: { in: [...linkedTreatmentIds] } },
                with: { treatment: { with: { drug: true } } },
              })
            : [];
        const treatments = treatmentRows
          .filter((row) => isInRange(row.treatment.startDate))
          .map((row) => ({
            id: row.treatment.id,
            name: row.treatment.name,
            startDate: row.treatment.startDate,
            endDate: row.treatment.endDate,
            drugName: row.treatment.drug?.name ?? null,
          }))
          .sort((a, b) => b.startDate.getTime() - a.startDate.getTime());

        return { checks, fecResults, treatments };
      });
    },
  };
}
