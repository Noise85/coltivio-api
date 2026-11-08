import { describe, it, expect, afterEach, jest } from "@jest/globals";

type BrevoModule = typeof import("./brevo");
type BrevoSdk = typeof import("@getbrevo/brevo");
type AsyncMock = jest.Mock<(request: unknown) => Promise<unknown>>;

const originalEnv = { ...process.env };
const contact = { userId: "user-1", email: "neu@test.ch", firstName: "Anna", locale: "de", verified: false };
const appAttributes = { EMAIL: "neu@test.ch", VORNAME: "Anna", SPRACHE: "de", QUELLE: "app", VERIFIED: false };

const mockContacts = {
  updateContact: jest.fn() as AsyncMock,
  createContact: jest.fn() as AsyncMock,
  getContactInfo: jest.fn() as AsyncMock,
  deleteContact: jest.fn() as AsyncMock,
  removeContactFromList: jest.fn() as AsyncMock,
};
const mockSendTransacEmail = jest.fn() as AsyncMock;

jest.mock("@getbrevo/brevo", () => {
  const actual = jest.requireActual<BrevoSdk>("@getbrevo/brevo");
  return {
    ...actual,
    BrevoClient: class {
      contacts = mockContacts;
      transactionalEmails = { sendTransacEmail: mockSendTransacEmail };
    },
  };
});

// brevo.ts reads its configuration at import time. The error classes come from the same module instance
// brevo.ts sees, otherwise instanceof fails across the isolated registry.
function loadBrevo(configured = true): { brevo: BrevoModule; sdk: BrevoSdk } {
  if (configured) {
    process.env.BREVO_API_KEY = "test-key";
    process.env.BREVO_LIST_ID = "7";
  } else {
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_LIST_ID;
  }
  let loaded!: { brevo: BrevoModule; sdk: BrevoSdk };
  jest.isolateModules(() => {
    /* eslint-disable @typescript-eslint/no-require-imports */
    loaded = { brevo: require("./brevo") as BrevoModule, sdk: require("@getbrevo/brevo") as BrevoSdk };
    /* eslint-enable @typescript-eslint/no-require-imports */
  });
  for (const mock of [...Object.values(mockContacts), mockSendTransacEmail]) {
    mock.mockResolvedValue({});
  }
  return loaded;
}

function notFound(sdk: BrevoSdk) {
  return new sdk.Brevo.NotFoundError({ message: "Contact not found" });
}

// Body as Brevo returns it when the new address belongs to another contact
function duplicate(sdk: BrevoSdk) {
  return new sdk.Brevo.BadRequestError({
    code: "invalid_parameter",
    message: "Unable to update contact, email is already associated with another Contact",
    metadata: { duplicate_identifiers: ["email"] },
  });
}

afterEach(() => {
  process.env = { ...originalEnv };
  jest.resetAllMocks();
});

describe("upsertNewsletterContact", () => {
  it("puts the contact keyed by user id on the list as an app contact", async () => {
    const { brevo } = loadBrevo();
    await brevo.upsertNewsletterContact(contact);

    expect(mockContacts.updateContact).toHaveBeenCalledWith({
      identifier: "user-1",
      identifierType: "ext_id",
      attributes: appAttributes,
      listIds: [7],
    });
    expect(mockContacts.createContact).not.toHaveBeenCalled();
  });

  it("creates the contact with the user id when Brevo does not know the address", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.updateContact.mockRejectedValueOnce(notFound(sdk));

    await brevo.upsertNewsletterContact(contact);

    expect(mockContacts.createContact).toHaveBeenCalledWith({
      email: "neu@test.ch",
      ext_id: "user-1",
      attributes: appAttributes,
      listIds: [7],
      updateEnabled: true,
    });
  });

  it("moves the user id onto the contact that already owns the address", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.updateContact.mockRejectedValueOnce(duplicate(sdk));
    mockContacts.getContactInfo.mockResolvedValueOnce({ listIds: [] });

    await brevo.upsertNewsletterContact(contact);

    expect(mockContacts.deleteContact).toHaveBeenCalledWith({ identifier: "user-1", identifierType: "ext_id" });
    expect(mockContacts.updateContact).toHaveBeenLastCalledWith({
      identifier: "neu@test.ch",
      identifierType: "email_id",
      ext_id: "user-1",
      attributes: appAttributes,
      listIds: [7],
    });
  });

  it("does not move contacts on other bad requests", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.updateContact.mockRejectedValueOnce(new sdk.Brevo.BadRequestError({ code: "invalid_parameter" }));

    await brevo.upsertNewsletterContact(contact);

    expect(mockContacts.deleteContact).not.toHaveBeenCalled();
    expect(mockContacts.createContact).not.toHaveBeenCalled();
  });

  it("does nothing without Brevo configuration", async () => {
    const { brevo } = loadBrevo(false);
    await brevo.upsertNewsletterContact(contact);

    expect(mockContacts.updateContact).not.toHaveBeenCalled();
  });
});

describe("markNewsletterContactVerified", () => {
  const verifiedAttributes = { EMAIL: "neu@test.ch", QUELLE: "app", VERIFIED: true };

  it("leaves contacts alone when the user never consented", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.getContactInfo.mockRejectedValueOnce(notFound(sdk));

    await brevo.markNewsletterContactVerified({ userId: "user-1", email: "neu@test.ch" });

    expect(mockContacts.updateContact).not.toHaveBeenCalled();
  });

  it("sets the confirmed address, QUELLE and VERIFIED without touching the list", async () => {
    const { brevo } = loadBrevo();
    await brevo.markNewsletterContactVerified({ userId: "user-1", email: "neu@test.ch" });

    expect(mockContacts.updateContact).toHaveBeenCalledWith({
      identifier: "user-1",
      identifierType: "ext_id",
      attributes: verifiedAttributes,
    });
  });

  it("keeps the list membership when moving onto the contact that owns the new address", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.updateContact.mockRejectedValueOnce(duplicate(sdk));
    mockContacts.getContactInfo.mockResolvedValueOnce({ listIds: [7] }).mockResolvedValueOnce({ listIds: [7] });

    await brevo.markNewsletterContactVerified({ userId: "user-1", email: "neu@test.ch" });

    expect(mockContacts.deleteContact).toHaveBeenCalledWith({ identifier: "user-1", identifierType: "ext_id" });
    expect(mockContacts.updateContact).toHaveBeenLastCalledWith({
      identifier: "neu@test.ch",
      identifierType: "email_id",
      ext_id: "user-1",
      attributes: verifiedAttributes,
      listIds: [7],
    });
  });
});

describe("removeNewsletterContact", () => {
  it("unlinks the contact by user id and the address itself from the list", async () => {
    const { brevo } = loadBrevo();
    await brevo.removeNewsletterContact({ userId: "user-1", email: "neu@test.ch" });

    expect(mockContacts.updateContact).toHaveBeenCalledWith({
      identifier: "user-1",
      identifierType: "ext_id",
      unlinkListIds: [7],
    });
    expect(mockContacts.removeContactFromList).toHaveBeenCalledWith({ listId: 7, body: { emails: ["neu@test.ch"] } });
  });
});

describe("deleteNewsletterContact", () => {
  it("deletes the contact keyed by user id and accepts a missing one", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.deleteContact.mockRejectedValueOnce(notFound(sdk));

    await expect(brevo.deleteNewsletterContact("user-1")).resolves.toBeUndefined();
    expect(mockContacts.deleteContact).toHaveBeenCalledWith({ identifier: "user-1", identifierType: "ext_id" });
  });

  it("rethrows other failures", async () => {
    const { brevo, sdk } = loadBrevo();
    mockContacts.deleteContact.mockRejectedValueOnce(new sdk.Brevo.BadRequestError({ code: "invalid_parameter" }));

    await expect(brevo.deleteNewsletterContact("user-1")).rejects.toBeInstanceOf(sdk.Brevo.BadRequestError);
  });
});

describe("txEmailApi", () => {
  const email = {
    sender: { email: "noreply@app.coltivio.ch", name: "Coltivio" },
    to: [{ email: "neu@test.ch" }],
    subject: "Report",
    attachment: [{ content: "YmFzZTY0", name: "report.xlsx" }],
  };

  it("passes the mail including attachments to Brevo", async () => {
    const { brevo } = loadBrevo();
    await brevo.txEmailApi.sendTransacEmail(email);

    expect(mockSendTransacEmail).toHaveBeenCalledWith(email);
  });

  it("rethrows send failures", async () => {
    const { brevo } = loadBrevo();
    mockSendTransacEmail.mockRejectedValueOnce(new Error("Brevo down"));

    await expect(brevo.txEmailApi.sendTransacEmail(email)).rejects.toThrow("Brevo down");
  });
});
