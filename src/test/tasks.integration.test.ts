import { describe, it, expect, beforeEach } from "@jest/globals";
import { cleanDb, request } from "./helpers";
import { createUserWithFarm } from "./test-utils";

type ApiChecklistItem = {
  id: string;
  taskId: string;
  name: string;
  position: number;
  done: boolean;
  dueDate: string | null;
  createdAt: string;
};

type ApiTask = {
  id: string;
  farmId: string;
  name: string;
  description: string | null;
  labels: string[];
  status: "todo" | "done";
  pinned: boolean;
  assigneeId: string | null;
  dueDate: string | null;
  createdAt: string;
  createdBy: string | null;
  recurrence: null | object;
  checklistItems: ApiChecklistItem[];
  assignee: null | object;
};

async function createTask(jwt: string, data: Record<string, unknown>): Promise<ApiTask> {
  const res = await request("POST", "/v1/tasks", data, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiTask }).data;
}

async function getTask(jwt: string, taskId: string): Promise<ApiTask> {
  const res = await request("GET", `/v1/tasks/byId/${taskId}`, undefined, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiTask }).data;
}

async function updateTask(jwt: string, taskId: string, data: Record<string, unknown>): Promise<ApiTask> {
  const res = await request("PATCH", `/v1/tasks/byId/${taskId}`, data, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiTask }).data;
}

async function checkItem(jwt: string, taskId: string, itemId: string, done: boolean): Promise<ApiChecklistItem> {
  const res = await request("PATCH", `/v1/tasks/byId/${taskId}/checklistItems/byId/${itemId}`, { done }, jwt);
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ApiChecklistItem }).data;
}

describe("Tasks", () => {
  beforeEach(cleanDb);

  it("creates a task and retrieves it", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const task = await createTask(jwt, { name: "My Task", checklistItems: [] });
    expect(task.name).toBe("My Task");
    expect(task.status).toBe("todo");
    expect(task.pinned).toBe(false);
  });

  it("preserves checklist item done state when updating other items", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    // Create task with 3 checklist items
    const task = await createTask(jwt, {
      name: "Task with checklist",
      checklistItems: [{ name: "Item A" }, { name: "Item B" }, { name: "Item C" }],
    });

    expect(task.checklistItems).toHaveLength(3);
    const [itemA, itemB, itemC] = task.checklistItems;

    // Check item B
    await checkItem(jwt, task.id, itemB.id, true);

    // Update the task — send back all items with their IDs, renaming item C
    const updated = await updateTask(jwt, task.id, {
      checklistItems: [
        { id: itemA.id, name: "Item A" },
        { id: itemB.id, name: "Item B" }, // was checked — should stay checked
        { id: itemC.id, name: "Item C renamed" },
      ],
    });

    expect(updated.checklistItems).toHaveLength(3);
    expect(updated.checklistItems[0].name).toBe("Item A");
    expect(updated.checklistItems[0].done).toBe(false);
    expect(updated.checklistItems[1].name).toBe("Item B");
    expect(updated.checklistItems[1].done).toBe(true); // must still be checked
    expect(updated.checklistItems[2].name).toBe("Item C renamed");
    expect(updated.checklistItems[2].done).toBe(false);
  });

  it("adds a new checklist item without resetting existing done states", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const task = await createTask(jwt, {
      name: "Task",
      checklistItems: [{ name: "First" }, { name: "Second" }],
    });

    const [first, second] = task.checklistItems;
    await checkItem(jwt, task.id, first.id, true);

    // Add a new item without touching existing ones
    const updated = await updateTask(jwt, task.id, {
      checklistItems: [
        { id: first.id, name: "First" },
        { id: second.id, name: "Second" },
        { name: "Third (new)" }, // no id = new item
      ],
    });

    expect(updated.checklistItems).toHaveLength(3);
    expect(updated.checklistItems[0].done).toBe(true); // still checked
    expect(updated.checklistItems[1].done).toBe(false);
    expect(updated.checklistItems[2].name).toBe("Third (new)");
    expect(updated.checklistItems[2].done).toBe(false);
  });

  it("removes a checklist item when omitted from update", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const task = await createTask(jwt, {
      name: "Task",
      checklistItems: [{ name: "Keep" }, { name: "Remove" }],
    });

    const [keep] = task.checklistItems;

    const updated = await updateTask(jwt, task.id, {
      checklistItems: [{ id: keep.id, name: "Keep" }],
    });

    expect(updated.checklistItems).toHaveLength(1);
    expect(updated.checklistItems[0].name).toBe("Keep");
  });

  it("returns checklist items in stable position order regardless of done state", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const task = await createTask(jwt, {
      name: "Order test",
      checklistItems: [{ name: "First" }, { name: "Second" }, { name: "Third" }],
    });

    const [first, second, third] = task.checklistItems;

    // Check the middle item
    await checkItem(jwt, task.id, second.id, true);

    // Fetch again and verify order is stable
    const fetched = await getTask(jwt, task.id);
    expect(fetched.checklistItems.map((i) => i.name)).toEqual(["First", "Second", "Third"]);
    expect(fetched.checklistItems[1].done).toBe(true);

    // Uncheck it
    await checkItem(jwt, task.id, second.id, false);
    const fetched2 = await getTask(jwt, task.id);
    expect(fetched2.checklistItems.map((i) => i.name)).toEqual(["First", "Second", "Third"]);
  });

  it("pins a task", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const task = await createTask(jwt, { name: "Pinnable" });

    const updated = await updateTask(jwt, task.id, { pinned: true });
    expect(updated.pinned).toBe(true);

    const updated2 = await updateTask(jwt, task.id, { pinned: false });
    expect(updated2.pinned).toBe(false);
  });

  it("returns pinned tasks first in list", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });

    const t1 = await createTask(jwt, { name: "Normal" });
    const t2 = await createTask(jwt, { name: "Pinned" });
    await updateTask(jwt, t2.id, { pinned: true });

    const res = await request("GET", "/v1/tasks", undefined, jwt);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { result: ApiTask[] } };
    expect(body.data.result[0].id).toBe(t2.id);
    expect(body.data.result[1].id).toBe(t1.id);
  });

  it("clears assignee and due date with null and keeps them when omitted", async () => {
    const { jwt, userId } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const task = await createTask(jwt, {
      name: "Assigned task",
      assigneeId: userId,
      dueDate: "2030-06-15",
      checklistItems: [],
    });
    expect(task.assigneeId).toBe(userId);
    expect(task.dueDate).not.toBeNull();

    const renamed = await updateTask(jwt, task.id, { name: "Renamed" });
    expect(renamed.assigneeId).toBe(userId);
    expect(renamed.dueDate).not.toBeNull();

    const cleared = await updateTask(jwt, task.id, { assigneeId: null, dueDate: null });
    expect(cleared.assigneeId).toBeNull();
    expect(cleared.dueDate).toBeNull();
  });

  it("clears a recurrence with null and keeps it when omitted", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const task = await createTask(jwt, {
      name: "Recurring task",
      dueDate: "2030-06-15",
      recurrence: { frequency: "weekly", interval: 1 },
      checklistItems: [],
    });
    expect(task.recurrence).not.toBeNull();

    const renamed = await updateTask(jwt, task.id, { name: "Renamed" });
    expect(renamed.recurrence).not.toBeNull();

    const cleared = await updateTask(jwt, task.id, { recurrence: null });
    expect(cleared.recurrence).toBeNull();
  });

  it("clears omitted recurrence fields when the recurrence is replaced", async () => {
    const { jwt } = await createUserWithFarm({}, "test@test.com", { withActiveMembership: true });
    const task = await createTask(jwt, {
      name: "Recurring task",
      dueDate: "2030-06-15",
      recurrence: { frequency: "weekly", interval: 1, until: "2030-12-31", count: 5 },
      checklistItems: [],
    });
    expect(task.recurrence).toMatchObject({ count: 5 });

    const updated = await updateTask(jwt, task.id, { recurrence: { frequency: "monthly", interval: 2 } });
    expect(updated.recurrence).toMatchObject({ frequency: "monthly", interval: 2, until: null, count: null });
  });
});
