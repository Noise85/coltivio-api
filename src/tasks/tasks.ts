import { and, arrayContains, eq, inArray } from "drizzle-orm";
import { TFunction } from "i18next";
import { RlsDb } from "../db/db";
import { farmIdColumnValue, taskChecklistItems, taskLinks, taskRecurrences, tasks } from "../db/schema";

export type Task = typeof tasks.$inferSelect;
export type TaskRecurrence = typeof taskRecurrences.$inferSelect;
export type TaskLink = typeof taskLinks.$inferSelect;
export type TaskChecklistItem = typeof taskChecklistItems.$inferSelect;

// Minimal assignee info included in list and detail responses
export type TaskAssignee = {
  id: string;
  email: string;
  fullName: string | null;
};

// Basic entity data resolved per link type (name is best-effort, null for types without a simple name field)
export type ResolvedTaskLink = TaskLink & {
  displayName: string | null;
};

export type TaskWithRelations = Task & {
  recurrence: TaskRecurrence | null;
  links: ResolvedTaskLink[];
  checklistItems: TaskChecklistItem[];
  assignee: TaskAssignee | null;
};

// Lightweight type used in list responses (no deep link resolution)
export type TaskListItem = Task & {
  recurrence: TaskRecurrence | null;
  checklistItems: TaskChecklistItem[];
  assignee: TaskAssignee | null;
};

export type TaskRecurrenceInput = {
  frequency: "weekly" | "monthly" | "yearly";
  interval?: number;
  byWeekday?: Array<"MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU">;
  byMonthDay?: number;
  until?: Date;
  count?: number;
};

export type TaskLinkInput = {
  linkType: typeof taskLinks.$inferInsert.linkType;
  linkedId: string;
};

export type TaskChecklistItemInput = {
  id?: string;
  name: string;
  done?: boolean;
  dueDate?: Date;
};

export type TaskCreateInput = {
  name: string;
  description?: string;
  labels?: string[];
  assigneeId?: string;
  dueDate?: Date;
  recurrence?: TaskRecurrenceInput;
  links?: TaskLinkInput[];
  checklistItems?: TaskChecklistItemInput[];
};

// recurrence: undefined = keep as-is, null = delete, value = upsert
// assigneeId/dueDate: undefined = keep as-is, null = clear
// links/checklistItems: undefined = keep as-is, array = replace all
export type TaskUpdateInput = {
  name?: string;
  description?: string;
  labels?: string[];
  assigneeId?: string | null;
  dueDate?: Date | null;
  pinned?: boolean;
  recurrence?: TaskRecurrenceInput | null;
  links?: TaskLinkInput[];
  checklistItems?: TaskChecklistItemInput[];
};

export type TaskListFilters = {
  status?: "todo" | "done";
  assigneeId?: string;
  label?: string;
};

// Resolve a display name for each link by querying the target table
async function resolveLinks(
  links: TaskLink[],
  tx: Parameters<Parameters<RlsDb["rls"]>[0]>[0],
  t: TFunction,
  locale: string
): Promise<ResolvedTaskLink[]> {
  return Promise.all(
    links.map(async (link) => {
      let displayName: string | null = null;

      switch (link.linkType) {
        case "animal": {
          const row = await tx.query.animals.findFirst({
            where: { id: link.linkedId },
            with: { earTag: true },
          });
          if (row) {
            displayName = row.earTag ? `${row.earTag.number} ${row.name}` : row.name;
          }
          break;
        }
        case "plot": {
          const row = await tx.query.plots.findFirst({
            where: { id: link.linkedId },
          });
          displayName = row?.name ?? null;
          break;
        }
        case "contact": {
          const row = await tx.query.contacts.findFirst({
            where: { id: link.linkedId },
          });
          displayName = row ? `${row.firstName} ${row.lastName}` : null;
          break;
        }
        case "order": {
          // Orders have no name — return null; client can display the date
          const row = await tx.query.orders.findFirst({
            where: { id: link.linkedId },
          });
          displayName = row ? (row.orderDate?.toISOString().slice(0, 10) ?? null) : null;
          break;
        }
        case "wiki_entry": {
          const row = await tx.query.wikiEntries.findFirst({
            where: { id: link.linkedId },
            with: { translations: true },
          });
          const translation = row?.translations.find((t) => t.locale === locale) ?? row?.translations[0];
          displayName = translation?.title ?? null;
          break;
        }
        case "treatment": {
          const row = await tx.query.treatments.findFirst({
            where: { id: link.linkedId },
          });
          displayName = row?.name ?? null;
          break;
        }
        case "herd": {
          const row = await tx.query.herds.findFirst({
            where: { id: link.linkedId },
          });
          displayName = row?.name ?? null;
          break;
        }
        case "parasite_check": {
          const row = await tx.query.parasiteChecks.findFirst({
            where: { id: link.linkedId },
          });
          if (row) {
            const methodLabel = t(`parasite_checks.methods.${row.method}`);
            const dateLabel = row.date.toISOString().slice(0, 10);
            displayName = row.name || `${methodLabel} · ${dateLabel}`;
          }
          break;
        }
      }

      return { ...link, displayName };
    })
  );
}

// Calculate the next occurrence date after the given base date.
// Returns null if the next date would exceed the `until` boundary.
function calculateNextOccurrence(baseDueDate: Date | null, recurrence: TaskRecurrence): Date | null {
  const base = baseDueDate ?? new Date();
  const next = new Date(base);

  switch (recurrence.frequency) {
    case "weekly":
      next.setDate(next.getDate() + recurrence.interval * 7);
      // If specific weekdays are set, snap forward to the nearest matching one
      if (recurrence.byWeekday && recurrence.byWeekday.length > 0) {
        const dayMap: Record<string, number> = {
          SU: 0,
          MO: 1,
          TU: 2,
          WE: 3,
          TH: 4,
          FR: 5,
          SA: 6,
        };
        const targetDays = new Set(recurrence.byWeekday.map((d) => dayMap[d]));
        // Search up to 7 days forward from the advanced date
        for (let i = 0; i < 7; i++) {
          if (targetDays.has(next.getDay())) break;
          next.setDate(next.getDate() + 1);
        }
      }
      break;
    case "monthly":
      next.setMonth(next.getMonth() + recurrence.interval);
      if (recurrence.byMonthDay) {
        next.setDate(recurrence.byMonthDay);
      }
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + recurrence.interval);
      break;
  }

  if (recurrence.until && next > recurrence.until) {
    return null;
  }

  return next;
}

// Shared recurrence insert/update helper
async function upsertRecurrence(
  tx: Parameters<Parameters<RlsDb["rls"]>[0]>[0],
  taskId: string,
  input: TaskRecurrenceInput
) {
  const existing = await tx.query.taskRecurrences.findFirst({
    where: { taskId },
  });
  // Recurrence input is a full replacement: omitted optional fields are cleared, not kept
  const values = {
    frequency: input.frequency,
    interval: input.interval ?? 1,
    byWeekday: input.byWeekday ?? null,
    byMonthDay: input.byMonthDay ?? null,
    until: input.until ?? null,
    count: input.count ?? null,
  };
  if (existing) {
    await tx.update(taskRecurrences).set(values).where(eq(taskRecurrences.taskId, taskId));
  } else {
    await tx.insert(taskRecurrences).values({
      ...farmIdColumnValue,
      taskId,
      ...values,
    });
  }
}

export function tasksApi(rlsDb: RlsDb, t: TFunction, locale: string) {
  return {
    async listTasks(filters: TaskListFilters): Promise<TaskListItem[]> {
      return rlsDb.rls(async (tx) => {
        // Use select().from() for SQL conditions (arrayContains), then fetch full data relationally
        const conditions = [
          filters.status ? eq(tasks.status, filters.status) : undefined,
          filters.assigneeId ? eq(tasks.assigneeId, filters.assigneeId) : undefined,
          filters.label ? arrayContains(tasks.labels, [filters.label]) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);

        let matchingIds: string[] | undefined;
        if (conditions.length > 0) {
          const filtered = await tx
            .select({ id: tasks.id })
            .from(tasks)
            .where(conditions.length === 1 ? conditions[0] : and(...conditions));
          matchingIds = filtered.map((r) => r.id);
          if (matchingIds.length === 0) return [];
        }

        const rows = await tx.query.tasks.findMany({
          where: matchingIds ? { id: { in: matchingIds } } : undefined,
          with: {
            recurrence: true,
            checklistItems: { orderBy: (fields, { asc }) => asc(fields.position) },
            assignee: true,
          },
        });

        const mapped = rows.map((row) => ({
          ...row,

          assignee: row.assignee
            ? { id: row.assignee.id, email: row.assignee.email, fullName: row.assignee.fullName }
            : null,
        }));
        // Pinned tasks always appear first
        mapped.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
        return mapped;
      });
    },

    async getTaskById(id: string): Promise<TaskWithRelations | undefined> {
      return rlsDb.rls(async (tx) => {
        const row = await tx.query.tasks.findFirst({
          where: { id },
          with: {
            recurrence: true,
            links: true,
            checklistItems: { orderBy: (fields, { asc }) => asc(fields.position) },
            assignee: true,
          },
        });

        if (!row) return undefined;

        const resolvedLinks = await resolveLinks(row.links, tx, t, locale);

        return {
          ...row,

          links: resolvedLinks,
          assignee: row.assignee
            ? { id: row.assignee.id, email: row.assignee.email, fullName: row.assignee.fullName }
            : null,
        };
      });
    },

    async createTask(input: TaskCreateInput, createdBy: string): Promise<TaskWithRelations> {
      return rlsDb.rls(async (tx) => {
        const [task] = await tx
          .insert(tasks)
          .values({
            ...farmIdColumnValue,
            name: input.name,
            description: input.description,
            labels: input.labels ?? [],
            assigneeId: input.assigneeId,
            dueDate: input.dueDate,
            createdBy,
          })
          .returning();

        if (input.recurrence) {
          await upsertRecurrence(tx, task.id, input.recurrence);
        }

        if (input.links && input.links.length > 0) {
          await tx.insert(taskLinks).values(
            input.links.map((link) => ({
              ...farmIdColumnValue,
              taskId: task.id,
              linkType: link.linkType,
              linkedId: link.linkedId,
            }))
          );
        }

        if (input.checklistItems && input.checklistItems.length > 0) {
          await tx.insert(taskChecklistItems).values(
            input.checklistItems.map((item, index) => ({
              ...farmIdColumnValue,
              taskId: task.id,
              name: item.name,
              position: index,
              dueDate: item.dueDate,
            }))
          );
        }

        const created = await tx.query.tasks.findFirst({
          where: { id: task.id },
          with: {
            recurrence: true,
            links: true,
            checklistItems: { orderBy: (fields, { asc }) => asc(fields.position) },
            assignee: true,
          },
        });
        const resolvedLinks = await resolveLinks(created!.links, tx, t, locale);
        return {
          ...created!,

          links: resolvedLinks,
          assignee: created!.assignee
            ? { id: created!.assignee.id, email: created!.assignee.email, fullName: created!.assignee.fullName }
            : null,
        };
      });
    },

    async updateTask(id: string, input: TaskUpdateInput): Promise<TaskWithRelations> {
      return rlsDb.rls(async (tx) => {
        const updateFields: Partial<typeof tasks.$inferInsert> = {};
        if (input.name !== undefined) updateFields.name = input.name;
        if (input.description !== undefined) updateFields.description = input.description;
        if (input.labels !== undefined) updateFields.labels = input.labels;
        if (input.assigneeId !== undefined) updateFields.assigneeId = input.assigneeId;
        if (input.dueDate !== undefined) updateFields.dueDate = input.dueDate;
        if (input.pinned !== undefined) updateFields.pinned = input.pinned;

        if (Object.keys(updateFields).length > 0) {
          await tx.update(tasks).set(updateFields).where(eq(tasks.id, id));
        }

        if (input.recurrence === null) {
          await tx.delete(taskRecurrences).where(eq(taskRecurrences.taskId, id));
        } else if (input.recurrence !== undefined) {
          await upsertRecurrence(tx, id, input.recurrence);
        }

        if (input.links !== undefined) {
          await tx.delete(taskLinks).where(eq(taskLinks.taskId, id));
          if (input.links.length > 0) {
            await tx.insert(taskLinks).values(
              input.links.map((link) => ({
                ...farmIdColumnValue,
                taskId: id,
                linkType: link.linkType,
                linkedId: link.linkedId,
              }))
            );
          }
        }

        if (input.checklistItems !== undefined) {
          const existing = await tx.query.taskChecklistItems.findMany({ where: { taskId: id } });
          const incomingIds = new Set(input.checklistItems.filter((i) => i.id).map((i) => i.id!));

          // Delete items that were removed from the list
          const toDelete = existing.filter((e) => !incomingIds.has(e.id)).map((e) => e.id);
          if (toDelete.length > 0) {
            await tx
              .delete(taskChecklistItems)
              .where(and(eq(taskChecklistItems.taskId, id), inArray(taskChecklistItems.id, toDelete)));
          }

          for (const [index, item] of input.checklistItems.entries()) {
            if (item.id) {
              // Update existing item — preserve done unless explicitly provided
              await tx
                .update(taskChecklistItems)
                .set({
                  name: item.name,
                  position: index,
                  dueDate: item.dueDate,
                  ...(item.done !== undefined ? { done: item.done } : {}),
                })
                .where(eq(taskChecklistItems.id, item.id));
            } else {
              // Insert new item
              await tx.insert(taskChecklistItems).values({
                ...farmIdColumnValue,
                taskId: id,
                name: item.name,
                position: index,
                dueDate: item.dueDate,
                done: item.done ?? false,
              });
            }
          }
        }

        const updated = await tx.query.tasks.findFirst({
          where: { id },
          with: {
            recurrence: true,
            links: true,
            checklistItems: { orderBy: (fields, { asc }) => asc(fields.position) },
            assignee: true,
          },
        });
        const resolvedLinks = await resolveLinks(updated!.links, tx, t, locale);
        return {
          ...updated!,

          links: resolvedLinks,
          assignee: updated!.assignee
            ? { id: updated!.assignee.id, email: updated!.assignee.email, fullName: updated!.assignee.fullName }
            : null,
        };
      });
    },

    async deleteTask(id: string): Promise<void> {
      return rlsDb.rls(async (tx) => {
        await tx.delete(tasks).where(eq(tasks.id, id));
      });
    },

    async setTaskStatus(id: string, status: "todo" | "done"): Promise<{ task: Task; nextTaskId: string | null }> {
      return rlsDb.rls(async (tx) => {
        const [task] = await tx.update(tasks).set({ status }).where(eq(tasks.id, id)).returning();

        // Only spawn next occurrence when marking done and a recurrence exists
        if (status !== "done") {
          return { task, nextTaskId: null };
        }

        const recurrence = await tx.query.taskRecurrences.findFirst({
          where: { taskId: id },
        });
        if (!recurrence) {
          return { task, nextTaskId: null };
        }

        const nextDueDate = calculateNextOccurrence(task.dueDate, recurrence);
        if (!nextDueDate) {
          // Past the `until` boundary — no more occurrences
          return { task, nextTaskId: null };
        }

        // Fetch links and checklist items to copy to the new task
        const existingLinks = await tx.query.taskLinks.findMany({
          where: { taskId: id },
        });
        const existingChecklistItems = await tx.query.taskChecklistItems.findMany({
          where: { taskId: id },
        });

        const [nextTask] = await tx
          .insert(tasks)
          .values({
            ...farmIdColumnValue,
            name: task.name,
            description: task.description,
            labels: task.labels,
            assigneeId: task.assigneeId,
            dueDate: nextDueDate,
            createdBy: task.createdBy,
          })
          .returning();

        await tx.insert(taskRecurrences).values({
          ...farmIdColumnValue,
          taskId: nextTask.id,
          frequency: recurrence.frequency,
          interval: recurrence.interval,
          byWeekday: recurrence.byWeekday,
          byMonthDay: recurrence.byMonthDay,
          until: recurrence.until,
          count: recurrence.count,
        });

        if (existingLinks.length > 0) {
          await tx.insert(taskLinks).values(
            existingLinks.map((link) => ({
              ...farmIdColumnValue,
              taskId: nextTask.id,
              linkType: link.linkType,
              linkedId: link.linkedId,
            }))
          );
        }

        if (existingChecklistItems.length > 0) {
          await tx.insert(taskChecklistItems).values(
            existingChecklistItems.map((item) => ({
              ...farmIdColumnValue,
              taskId: nextTask.id,
              name: item.name,
              position: item.position,
              dueDate: item.dueDate,
              // done resets to false (default)
            }))
          );
        }

        return { task, nextTaskId: nextTask.id };
      });
    },

    async setChecklistItemDone(itemId: string, done: boolean): Promise<TaskChecklistItem> {
      return rlsDb.rls(async (tx) => {
        const [updated] = await tx
          .update(taskChecklistItems)
          .set({ done })
          .where(eq(taskChecklistItems.id, itemId))
          .returning();
        return updated;
      });
    },
  };
}
