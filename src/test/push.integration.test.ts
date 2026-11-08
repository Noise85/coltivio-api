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
import { runTaskDueNotifications } from "../tasks/task-due-cron";
import { tasks } from "../db/schema";
import { cleanDb, createTestUser, getAdminDb, request } from "./helpers";
import { createFarmMember, createUserWithFarm } from "./test-utils";

const mockPostToExpo = jest.mocked(postToExpo);

// 10:00 in Zurich on the due date
const NOW = new Date("2030-06-15T08:00:00Z");
const DUE_TODAY = new Date("2030-06-15");
const DUE_TOMORROW = new Date("2030-06-16");

const tokenFor = (name: string) => `ExponentPushToken[${name}]`;

async function registerToken(jwt: string, token: string) {
  const res = await request("POST", "/v1/me/push-tokens", { token, platform: "ios" }, jwt);
  expect(res.status).toBe(200);
}

async function enableTaskPush(jwt: string) {
  const res = await request("PATCH", "/v1/me", { taskPushNotifications: true }, jwt);
  expect(res.status).toBe(200);
}

async function insertTask(
  farmId: string,
  data: { name?: string; dueDate?: Date; assigneeId?: string; status?: "todo" | "done"; createdAt?: Date } = {}
) {
  const [task] = await getAdminDb()
    .insert(tasks)
    .values({
      farmId,
      name: data.name ?? "Feed animals",
      dueDate: data.dueDate ?? DUE_TODAY,
      assigneeId: data.assigneeId,
      status: data.status ?? "todo",
      createdAt: data.createdAt,
    })
    .returning();
  return task;
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

describe("Push tokens", () => {
  it("registers, re-registers and unregisters a token", async () => {
    const { jwt, userId } = await createTestUser("user@test.com", "password123");
    const db = getAdminDb();

    await registerToken(jwt, tokenFor("a"));
    await registerToken(jwt, tokenFor("a"));
    const rows = await db.query.pushTokens.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("ios");

    const res = await request(
      "DELETE",
      `/v1/me/push-tokens?token=${encodeURIComponent(tokenFor("a"))}`,
      undefined,
      jwt
    );
    expect(res.status).toBe(200);
    expect(await db.query.pushTokens.findMany({ where: { userId } })).toHaveLength(0);
  });

  it("reassigns a token when the device switches accounts", async () => {
    const first = await createTestUser("first@test.com", "password123");
    const second = await createTestUser("second@test.com", "password123");

    await registerToken(first.jwt, tokenFor("shared"));
    await registerToken(second.jwt, tokenFor("shared"));

    const row = await getAdminDb().query.pushTokens.findFirst({ where: { token: tokenFor("shared") } });
    expect(row?.userId).toBe(second.userId);
  });

  it("does not let a user unregister another user's token", async () => {
    const owner = await createTestUser("owner@test.com", "password123");
    const other = await createTestUser("other@test.com", "password123");
    await registerToken(owner.jwt, tokenFor("owner"));

    const res = await request(
      "DELETE",
      `/v1/me/push-tokens?token=${encodeURIComponent(tokenFor("owner"))}`,
      undefined,
      other.jwt
    );
    expect(res.status).toBe(200);
    expect(await getAdminDb().query.pushTokens.findFirst({ where: { token: tokenFor("owner") } })).toBeDefined();
  });

  it("rejects an invalid token", async () => {
    const { jwt } = await createTestUser("user@test.com", "password123");
    const res = await request("POST", "/v1/me/push-tokens", { token: "not-a-token" }, jwt);
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request("POST", "/v1/me/push-tokens", { token: tokenFor("a") });
    expect(res.status).toBe(401);
  });
});

describe("Profile task push toggle", () => {
  it("defaults to disabled and can be enabled", async () => {
    const { jwt } = await createTestUser("user@test.com", "password123");

    const meRes = await request("GET", "/v1/me", undefined, jwt);
    const me = (await meRes.json()) as { data: { taskPushNotifications: boolean } };
    expect(me.data.taskPushNotifications).toBe(false);

    const patchRes = await request("PATCH", "/v1/me", { taskPushNotifications: true }, jwt);
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { data: { taskPushNotifications: boolean } };
    expect(patched.data.taskPushNotifications).toBe(true);
  });
});

describe("Task due notifications", () => {
  it("notifies only the assignee of an assigned task", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    const member = await createFarmMember(owner.jwt, "member@test.com", {
      permissions: [{ feature: "tasks", access: "write" }],
    });
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await registerToken(member.jwt, tokenFor("member"));
    await enableTaskPush(member.jwt);
    await insertTask(owner.farmId, { name: "Fix fence", assigneeId: member.userId });

    await runTaskDueNotifications(NOW);

    const messages = sentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].to).toBe(tokenFor("member"));
    expect(messages[0].title).toBe("Heute fällig");
    expect(messages[0].body).toBe("Fix fence");
    expect(messages[0].data).toMatchObject({ type: "tasks_due", farmId: owner.farmId });
  });

  it("notifies the owner and members with tasks access for unassigned tasks", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    const reader = await createFarmMember(owner.jwt, "reader@test.com", {
      permissions: [{ feature: "tasks", access: "read" }],
    });
    const noAccess = await createFarmMember(owner.jwt, "noaccess@test.com", {
      permissions: [{ feature: "tasks", access: "none" }],
    });
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await registerToken(reader.jwt, tokenFor("reader"));
    await enableTaskPush(reader.jwt);
    await registerToken(noAccess.jwt, tokenFor("noaccess"));
    await enableTaskPush(noAccess.jwt);
    await insertTask(owner.farmId);

    await runTaskDueNotifications(NOW);

    const recipients = sentMessages()
      .map((message) => message.to)
      .sort();
    expect(recipients).toEqual([tokenFor("owner"), tokenFor("reader")].sort());
  });

  it("sends one digest per user and farm", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await insertTask(owner.farmId, { name: "Task A" });
    await insertTask(owner.farmId, { name: "Task B" });

    await runTaskDueNotifications(NOW);

    const messages = sentMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toBe("Task A, Task B");
  });

  it("skips users who opted out", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await request("PATCH", "/v1/me", { taskPushNotifications: false }, owner.jwt);
    await insertTask(owner.farmId);

    await runTaskDueNotifications(NOW);

    expect(mockPostToExpo).not.toHaveBeenCalled();
  });

  it("skips users who never enabled notifications", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await insertTask(owner.farmId);

    await runTaskDueNotifications(NOW);

    expect(mockPostToExpo).not.toHaveBeenCalled();
  });

  it("does not notify twice for the same task and due date", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await insertTask(owner.farmId);

    await runTaskDueNotifications(NOW);
    await runTaskDueNotifications(NOW);

    expect(sentMessages()).toHaveLength(1);
  });

  it("ignores done tasks and tasks not due today", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    await insertTask(owner.farmId, { status: "done" });
    await insertTask(owner.farmId, { dueDate: DUE_TOMORROW });

    await runTaskDueNotifications(NOW);

    expect(mockPostToExpo).not.toHaveBeenCalled();
  });

  it("skips tasks created on their due day", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    // 07:30 Zurich on the due date
    await insertTask(owner.farmId, { createdAt: new Date("2030-06-15T05:30:00Z") });

    await runTaskDueNotifications(NOW);

    expect(mockPostToExpo).not.toHaveBeenCalled();
  });

  it("notifies tasks created late the evening before their due day", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("owner"));
    await enableTaskPush(owner.jwt);
    // 23:30 Zurich the day before, already June 14 21:30 UTC
    await insertTask(owner.farmId, { createdAt: new Date("2030-06-14T21:30:00Z") });

    await runTaskDueNotifications(NOW);

    expect(sentMessages()).toHaveLength(1);
  });

  it("deletes tokens Expo reports as no longer registered", async () => {
    const owner = await createUserWithFarm({}, "owner@test.com");
    await registerToken(owner.jwt, tokenFor("stale"));
    await enableTaskPush(owner.jwt);
    await insertTask(owner.farmId);
    mockPostToExpo.mockImplementation(async (messages) =>
      messages.map((message) => ({
        status: "error",
        message: "not registered",
        details: { error: "DeviceNotRegistered", expoPushToken: message.to },
      }))
    );

    await runTaskDueNotifications(NOW);

    expect(await getAdminDb().query.pushTokens.findFirst({ where: { token: tokenFor("stale") } })).toBeUndefined();
  });
});
