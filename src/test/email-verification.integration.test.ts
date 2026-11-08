import { describe, it, expect, beforeEach, beforeAll, afterEach, jest } from "@jest/globals";
import i18next from "i18next";
import de from "../../resources/locales/de.json";
import en from "../../resources/locales/en.json";
import itLocale from "../../resources/locales/it.json";
import fr from "../../resources/locales/fr.json";
import { eq, sql } from "drizzle-orm";
import { cleanDb, createTestUser, getAdminDb, getAdminSql, request } from "./helpers";
import { emailVerificationTokens, profiles } from "../db/schema";
import * as brevo from "../brevo/brevo";
import { adminOnlyDb, clientDrizzle } from "../db/db";
import {
  completeAddressChangeIfNeeded,
  sendVerificationEmailIfNeeded,
  verifyEmailToken,
} from "../user/user-verification";
import { usersApi } from "../user/users";

// Email helpers call getFixedT(locale), so i18next must be initialised in the worker
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

// The HTTP server runs in Jest's main process, these tests in a worker, so a spy installed here
// never sees a mail sent by an endpoint. Requests are therefore asserted on status codes and on
// what ends up in the database; mail content is asserted by calling the sender in this process.
let emailSpy: jest.SpiedFunction<typeof brevo.txEmailApi.sendTransacEmail>;
let contactSpy: jest.SpiedFunction<typeof brevo.markNewsletterContactVerified>;

beforeEach(async () => {
  await cleanDb();
  emailSpy = jest.spyOn(brevo.txEmailApi, "sendTransacEmail").mockImplementation(() => Promise.resolve());
  contactSpy = jest.spyOn(brevo, "markNewsletterContactVerified").mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  jest.restoreAllMocks();
});

let userCounter = 0;

function uniqueEmail(prefix: string) {
  userCounter += 1;
  return `${prefix}-${Date.now()}-${userCounter}@test.ch`;
}

// createTestUser confirms its users, a real signup starts unconfirmed
async function newUser() {
  const email = uniqueEmail("verify");
  const { jwt, userId } = await createTestUser(email, "123456");
  await getAdminDb()
    .update(profiles)
    .set({ emailVerified: false, verificationHandledAt: null })
    .where(eq(profiles.id, userId));
  return { jwt, userId, email };
}

const farmBody = {
  name: "Testhof",
  address: "Via Miadi 25, 6544 Braggio",
  location: { type: "Point", coordinates: [9.12, 46.3] },
};

// Creating a farm is POST /v1/farm; /v1/farms is the GET-only list of the caller's farms
async function createFarm(jwt: string, name = farmBody.name) {
  const res = await request("POST", "/v1/farm", { ...farmBody, name }, jwt);
  expect(res.status).toBe(200);
  return res;
}

async function tokensFor(userId: string) {
  return getAdminDb().select().from(emailVerificationTokens).where(eq(emailVerificationTokens.userId, userId));
}

async function profileFor(userId: string) {
  const profile = await getAdminDb().query.profiles.findFirst({ where: { id: userId } });
  return profile!;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The middleware works without awaiting it, so its effects show up a moment later
async function waitFor(check: () => Promise<boolean>, what: string) {
  for (let i = 0; i < 60; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function waitForTokens(userId: string, count: number) {
  await waitFor(async () => (await tokensFor(userId)).length >= count, `${count} verification token(s)`);
  return tokensFor(userId);
}

async function getMe(jwt: string) {
  const res = await request("GET", "/v1/me", undefined, jwt);
  expect(res.status).toBe(200);
}

async function mailedUser() {
  const user = await newUser();
  await getMe(user.jwt);
  const [token] = await waitForTokens(user.userId, 1);
  return { ...user, token };
}

// Through auth.users, so the update_profile trigger runs as in production
async function changeAddress(userId: string, email: string) {
  await getAdminSql()`update auth.users set email = ${email} where id = ${userId}`;
}

describe("Verification email trigger", () => {
  it("sends on the first authenticated request, before any farm exists", async () => {
    const { jwt, userId } = await newUser();

    await getMe(jwt);
    await waitForTokens(userId, 1);

    const profile = await profileFor(userId);
    expect(profile.verificationHandledAt).not.toBeNull();
    expect(profile.emailVerified).toBe(false);
  });

  it("mints a single token for parallel first requests", async () => {
    const { jwt, userId } = await newUser();

    await Promise.all(Array.from({ length: 5 }, () => getMe(jwt)));
    await waitForTokens(userId, 1);
    await sleep(1000);

    expect(await tokensFor(userId)).toHaveLength(1);
  });

  // The bug this feature started from: deleting a farm and creating a new one re-sent the mail
  it("does not send again on later requests or when farms are created", async () => {
    const { jwt, userId, token } = await mailedUser();

    await createFarm(jwt, "Erster Hof");
    await createFarm(jwt, "Zweiter Hof");
    await sleep(1000);

    const tokens = await tokensFor(userId);
    expect(tokens).toHaveLength(1);
    expect(tokens[0].token).toBe(token.token);
  });

  it("does not send for a confirmed account", async () => {
    const { jwt, userId } = await createTestUser(uniqueEmail("confirmed"), "123456");

    await getMe(jwt);
    await sleep(1000);

    expect(await tokensFor(userId)).toHaveLength(0);
  });

  it("keeps a changed address verified and finishes the change without a new token", async () => {
    const { jwt, userId, token } = await mailedUser();
    await request("POST", "/v1/auth/verify-email", { token: token.token });

    await changeAddress(userId, uniqueEmail("changed"));
    const changed = await profileFor(userId);
    expect(changed.emailVerified).toBe(true);
    expect(changed.verificationHandledAt).toBeNull();

    await getMe(jwt);
    await waitFor(async () => (await profileFor(userId)).verificationHandledAt !== null, "the address change");
    expect(await tokensFor(userId)).toHaveLength(1);
  });
});

describe("Verification email content", () => {
  it("addresses the user, carries the token and is idempotent", async () => {
    const { userId, email } = await newUser();

    await sendVerificationEmailIfNeeded(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    const sent = emailSpy.mock.calls[0][0];
    expect(sent.subject).toBe("Bestätige deine E-Mail-Adresse");
    expect(sent.to![0].email).toBe(email);

    const [token] = await tokensFor(userId);
    expect(sent.htmlContent).toContain(token.token);
    expect(sent.htmlContent).toContain("/auth/verify?token=");

    await sendVerificationEmailIfNeeded(userId);
    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(await tokensFor(userId)).toHaveLength(1);
  });
});

describe("Verification token exchange", () => {
  it("confirms the address", async () => {
    const { userId, token } = await mailedUser();

    const res = await request("POST", "/v1/auth/verify-email", { token: token.token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { verified: boolean } };
    expect(body.data.verified).toBe(true);

    const profile = await profileFor(userId);
    expect(profile.emailVerified).toBe(true);
    expect(profile.welcomeEmailSentAt).not.toBeNull();
  });

  it("answers a repeated click on a confirmed address without a second welcome mail", async () => {
    const { userId, token } = await mailedUser();

    await request("POST", "/v1/auth/verify-email", { token: token.token });
    const sentAt = (await profileFor(userId)).welcomeEmailSentAt;

    const res = await request("POST", "/v1/auth/verify-email", { token: token.token });
    expect(res.status).toBe(200);
    expect((await profileFor(userId)).welcomeEmailSentAt).toEqual(sentAt);
  });

  it("sends one welcome mail when the same token is exchanged twice at the same time", async () => {
    const { userId } = await newUser();
    await sendVerificationEmailIfNeeded(userId);
    const [token] = await tokensFor(userId);
    emailSpy.mockClear();

    const results = await Promise.all([verifyEmailToken(token.token), verifyEmailToken(token.token)]);

    expect(results).toEqual([{ verified: true }, { verified: true }]);
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it("still answers verified for a used token after an address change", async () => {
    const { userId, token } = await mailedUser();
    await request("POST", "/v1/auth/verify-email", { token: token.token });

    await changeAddress(userId, uniqueEmail("changed"));

    const res = await request("POST", "/v1/auth/verify-email", { token: token.token });
    expect(res.status).toBe(200);
  });

  it("rejects an expired token", async () => {
    const { token } = await mailedUser();

    await getAdminDb()
      .update(emailVerificationTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(emailVerificationTokens.id, token.id));

    const res = await request("POST", "/v1/auth/verify-email", { token: token.token });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown token", async () => {
    const res = await request("POST", "/v1/auth/verify-email", { token: "does-not-exist" });
    expect(res.status).toBe(400);
  });
});

describe("Welcome mail", () => {
  it("is sent once, after verification, and marks the Brevo contact verified", async () => {
    const { userId, email } = await newUser();
    await sendVerificationEmailIfNeeded(userId);
    const [token] = await tokensFor(userId);
    emailSpy.mockClear();

    await verifyEmailToken(token.token);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    const welcome = emailSpy.mock.calls[0][0];
    expect(welcome.subject).toBe("Willkommen bei Coltivio");
    expect(welcome.to![0].email).toBe(email);
    expect(welcome.htmlContent).toContain("Mitglied werden");
    expect(contactSpy).toHaveBeenCalledWith({ userId, email });
  });

  it("accepts the newsletter consent of an unconfirmed account", async () => {
    const { jwt } = await newUser();

    const res = await request("PATCH", "/v1/me", { newsletterConsent: true }, jwt);
    expect(res.status).toBe(200);
  });

  it("moves the Brevo contact to a changed address without a second welcome mail", async () => {
    const { userId, email } = await newUser();
    await sendVerificationEmailIfNeeded(userId);
    const [token] = await tokensFor(userId);
    await verifyEmailToken(token.token);

    const newEmail = uniqueEmail("moved");
    await changeAddress(userId, newEmail);
    emailSpy.mockClear();
    await completeAddressChangeIfNeeded(userId);
    await completeAddressChangeIfNeeded(userId);

    expect(contactSpy).toHaveBeenCalledTimes(2);
    expect(contactSpy.mock.calls[0][0]).toEqual({ userId, email });
    expect(contactSpy.mock.calls[1][0]).toEqual({ userId, email: newEmail });
    expect(emailSpy).not.toHaveBeenCalled();
  });

  it("is sent when an unconfirmed account completes an address change", async () => {
    const { userId } = await newUser();
    await sendVerificationEmailIfNeeded(userId);

    await changeAddress(userId, uniqueEmail("changed"));
    emailSpy.mockClear();
    await completeAddressChangeIfNeeded(userId);

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy.mock.calls[0][0].subject).toBe("Willkommen bei Coltivio");
    expect(await tokensFor(userId)).toHaveLength(0);
  });
});

describe("Newsletter consent", () => {
  it("puts an unconfirmed account on the Brevo list with VERIFIED false", async () => {
    const { userId, email } = await newUser();
    const upsertSpy = jest.spyOn(brevo, "upsertNewsletterContact").mockImplementation(() => Promise.resolve());

    await usersApi(adminOnlyDb).setNewsletterConsent(userId, true);

    expect(upsertSpy).toHaveBeenCalledWith(expect.objectContaining({ userId, email, verified: false }));
  });

  it("takes the contact off the list when consent is withdrawn", async () => {
    const { userId, email } = await newUser();
    const removeSpy = jest.spyOn(brevo, "removeNewsletterContact").mockImplementation(() => Promise.resolve());

    await usersApi(adminOnlyDb).setNewsletterConsent(userId, false);

    expect(removeSpy).toHaveBeenCalledWith({ userId, email });
  });
});

describe("Resend verification email", () => {
  it("keeps earlier tokens valid until the address is confirmed, then removes them", async () => {
    const { jwt, userId, token: first } = await mailedUser();

    // Step around the five minute cooldown
    await getAdminDb()
      .update(emailVerificationTokens)
      .set({ createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(emailVerificationTokens.id, first.id));

    const res = await request("POST", "/v1/me/verification-email", {}, jwt);
    expect(res.status).toBe(200);
    const tokens = await tokensFor(userId);
    expect(tokens).toHaveLength(2);
    const second = tokens.find((row) => row.token !== first.token)!;

    const earlier = await request("POST", "/v1/auth/verify-email", { token: first.token });
    expect(earlier.status).toBe(200);

    const removed = await request("POST", "/v1/auth/verify-email", { token: second.token });
    expect(removed.status).toBe(400);
  });

  it("rate limits repeated resends", async () => {
    const { jwt } = await mailedUser();

    const res = await request("POST", "/v1/me/verification-email", {}, jwt);
    expect(res.status).toBe(429);
  });

  it("refuses to resend once the address is verified", async () => {
    const { jwt, token } = await mailedUser();
    await request("POST", "/v1/auth/verify-email", { token: token.token });

    const res = await request("POST", "/v1/me/verification-email", {}, jwt);
    expect(res.status).toBe(409);
  });
});

describe("emailVerified cannot be set by the client", () => {
  // Old app versions still send it after an address change and must keep getting a 200
  it("ignores emailVerified in PATCH /v1/me", async () => {
    const { jwt, userId } = await newUser();

    const res = await request("PATCH", "/v1/me", { emailVerified: true, fullName: "Test Bauer" }, jwt);
    expect(res.status).toBe(200);

    const profile = await profileFor(userId);
    expect(profile.emailVerified).toBe(false);
    expect(profile.fullName).toBe("Test Bauer");
  });

  it("denies a direct column update through the authenticated role", async () => {
    const { userId } = await newUser();

    await expect(
      clientDrizzle.transaction(async (tx) => {
        await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, TRUE)`);
        await tx.execute(sql`set local role authenticated`);
        await tx.execute(sql`update profiles set email_verified = true where id = ${userId}::uuid`);
      })
    ).rejects.toThrow();

    expect((await profileFor(userId)).emailVerified).toBe(false);
  });
});
