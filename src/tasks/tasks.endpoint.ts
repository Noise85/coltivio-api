import createHttpError from "http-errors";
import { ez } from "express-zod-api";
import { z } from "zod";
import { frequencySchema, taskLinkTypeSchema, taskStatusSchema, weekdaySchema } from "../db/schema";
import { permissionFarmEndpoint } from "../endpoint-factory";

const tasksRead = permissionFarmEndpoint("tasks", "read");
const tasksWrite = permissionFarmEndpoint("tasks", "write");

// ─── Output schemas ───────────────────────────────────────────────────────────

const taskRecurrenceOutputSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  frequency: frequencySchema,
  interval: z.number(),
  byWeekday: z.array(weekdaySchema).nullable(),
  byMonthDay: z.number().nullable(),
  until: z.string().or(z.date()).nullable(),
  count: z.number().nullable(),
});

const taskLinkOutputSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  linkType: taskLinkTypeSchema,
  linkedId: z.string(),
  displayName: z.string().nullable(),
});

export const taskChecklistItemSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  name: z.string(),
  position: z.number(),
  dueDate: z.string().or(z.date()).nullable(),
  done: z.boolean(),
  createdAt: z.string().or(z.date()),
});

const taskAssigneeSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string().nullable(),
});

export const taskSchema = z.object({
  id: z.string(),
  farmId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  labels: z.array(z.string()),
  status: taskStatusSchema,
  pinned: z.boolean(),
  assigneeId: z.string().nullable(),
  dueDate: z.string().or(z.date()).nullable(),
  createdAt: z.string().or(z.date()),
  createdBy: z.string().nullable(),
  recurrence: taskRecurrenceOutputSchema.nullable(),
  checklistItems: z.array(taskChecklistItemSchema),
  assignee: taskAssigneeSchema.nullable(),
});

export const taskWithLinksSchema = taskSchema.extend({
  links: z.array(taskLinkOutputSchema),
});

// ─── Input schemas ────────────────────────────────────────────────────────────

const taskRecurrenceInputSchema = z.object({
  frequency: frequencySchema,
  interval: z.number().int().positive().default(1),
  byWeekday: z.array(weekdaySchema).optional(),
  byMonthDay: z.number().int().optional(),
  until: ez.dateIn().optional(),
  count: z.number().int().positive().optional(),
});

const taskLinkInputSchema = z.object({
  linkType: taskLinkTypeSchema,
  linkedId: z.string(),
});

const taskChecklistItemInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  done: z.boolean().optional(),
  dueDate: ez.dateIn().optional(),
});

const taskCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  labels: z.array(z.string()).default([]),
  assigneeId: z.string().optional(),
  dueDate: ez.dateIn().optional(),
  recurrence: taskRecurrenceInputSchema.optional(),
  links: z.array(taskLinkInputSchema).default([]),
  checklistItems: z.array(taskChecklistItemInputSchema).default([]),
});

const taskUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  labels: z.array(z.string()).optional(),
  // null clears the assignee / due date, undefined keeps it as-is
  assigneeId: z.string().nullable().optional(),
  dueDate: ez.dateIn().nullable().optional(),
  pinned: z.boolean().optional(),
  recurrence: taskRecurrenceInputSchema.nullable().optional(),
  links: z.array(taskLinkInputSchema).optional(),
  checklistItems: z.array(taskChecklistItemInputSchema).optional(),
});

// ─── Endpoints ────────────────────────────────────────────────────────────────

export const listTasksEndpoint = tasksRead.build({
  method: "get",
  input: z.object({
    status: taskStatusSchema.optional(),
    assigneeId: z.string().optional(),
    label: z.string().optional(),
  }),
  output: z.object({
    result: z.array(taskSchema),
    count: z.number(),
  }),
  handler: async ({ input, ctx: { tasks } }) => {
    const result = await tasks.listTasks({
      status: input.status,
      assigneeId: input.assigneeId,
      label: input.label,
    });
    return { result, count: result.length };
  },
});

export const createTaskEndpoint = tasksWrite.build({
  method: "post",
  input: taskCreateSchema,
  output: taskWithLinksSchema,
  handler: async ({ input, ctx: { tasks, user } }) => {
    return tasks.createTask(
      {
        name: input.name,
        description: input.description,
        labels: input.labels,
        assigneeId: input.assigneeId,
        dueDate: input.dueDate,
        recurrence: input.recurrence,
        links: input.links,
        checklistItems: input.checklistItems,
      },
      user.id
    );
  },
});

export const getTaskByIdEndpoint = tasksRead.build({
  method: "get",
  input: z.object({ taskId: z.string() }),
  output: taskWithLinksSchema,
  handler: async ({ input, ctx: { tasks } }) => {
    const task = await tasks.getTaskById(input.taskId);
    if (!task) {
      throw createHttpError(404, "Task not found");
    }
    return task;
  },
});

export const updateTaskEndpoint = tasksWrite.build({
  method: "patch",
  input: z.object({ taskId: z.string() }).merge(taskUpdateSchema),
  output: taskWithLinksSchema,
  handler: async ({ input: { taskId, ...rest }, ctx: { tasks } }) => {
    const task = await tasks.getTaskById(taskId);
    if (!task) {
      throw createHttpError(404, "Task not found");
    }
    return tasks.updateTask(taskId, rest);
  },
});

export const deleteTaskEndpoint = tasksWrite.build({
  method: "delete",
  input: z.object({ taskId: z.string() }),
  output: z.object({ success: z.boolean() }),
  handler: async ({ input, ctx: { tasks } }) => {
    const task = await tasks.getTaskById(input.taskId);
    if (!task) {
      throw createHttpError(404, "Task not found");
    }
    await tasks.deleteTask(input.taskId);
    return { success: true };
  },
});

export const setTaskStatusEndpoint = tasksWrite.build({
  method: "patch",
  input: z.object({
    taskId: z.string(),
    status: taskStatusSchema,
  }),
  output: z.object({
    task: taskSchema,
    nextTaskId: z.string().nullable(),
  }),
  handler: async ({ input, ctx: { tasks } }) => {
    const existing = await tasks.getTaskById(input.taskId);
    if (!existing) {
      throw createHttpError(404, "Task not found");
    }
    const { task: updated, nextTaskId } = await tasks.setTaskStatus(input.taskId, input.status);
    // Merge updated scalar fields over the enriched existing shape for the response
    return { task: { ...existing, ...updated }, nextTaskId };
  },
});

export const setChecklistItemDoneEndpoint = tasksWrite.build({
  method: "patch",
  input: z.object({
    taskId: z.string(),
    itemId: z.string(),
    done: z.boolean(),
  }),
  output: taskChecklistItemSchema,
  handler: async ({ input, ctx: { tasks } }) => {
    // Verify task exists in this farm context
    const task = await tasks.getTaskById(input.taskId);
    if (!task) {
      throw createHttpError(404, "Task not found");
    }
    const item = task.checklistItems.find((i) => i.id === input.itemId);
    if (!item) {
      throw createHttpError(404, "Checklist item not found");
    }
    return tasks.setChecklistItemDone(input.itemId, input.done);
  },
});
