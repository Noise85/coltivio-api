import { captureException } from "@sentry/node";
import { Brevo, BrevoClient, BrevoError } from "@getbrevo/brevo";

const API_KEY = process.env.BREVO_API_KEY;
// Being on this list is the newsletter consent
const LIST_ID = process.env.BREVO_LIST_ID ? Number(process.env.BREVO_LIST_ID) : undefined;

const client = API_KEY ? new BrevoClient({ apiKey: API_KEY }) : undefined;

export const txEmailApi = {
  async sendTransacEmail(email: Brevo.SendTransacEmailRequest): Promise<void> {
    if (!client) {
      console.log("[brevo] BREVO_API_KEY not set, skipping email:", JSON.stringify(email, null, 2));
      return;
    }
    await client.transactionalEmails.sendTransacEmail(email);
  },
};

export type NewsletterContact = {
  userId: string;
  email: string;
  firstName: string | null;
  locale: string;
  verified: boolean;
};

type Contacts = BrevoClient["contacts"];
type Attributes = Record<string, string | boolean>;

function contactsClient(action: string, detail: string): Contacts | undefined {
  if (!client || LIST_ID === undefined) {
    console.log(`[brevo] ${action} skipped (no API key or BREVO_LIST_ID):`, detail);
    return undefined;
  }
  return client.contacts;
}

function report(action: string, error: unknown): void {
  console.error(`[brevo] failed to ${action}`, error);
  captureException(error);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Brevo.NotFoundError;
}

// Brevo refuses to give a contact an address that already belongs to another contact. The code is a generic
// invalid_parameter, only the metadata names the conflicting identifier.
function isDuplicate(error: unknown): boolean {
  if (!(error instanceof BrevoError) || error.statusCode !== 400) return false;
  const body = error.body as { metadata?: { duplicate_identifiers?: string[] } } | undefined;
  return body?.metadata?.duplicate_identifiers?.includes("email") ?? false;
}

// QUELLE=app marks a contact that belongs to an app account, wherever it first signed up
function appAttributes(contact: NewsletterContact): Attributes {
  return {
    EMAIL: contact.email,
    VORNAME: contact.firstName ?? "",
    SPRACHE: contact.locale,
    QUELLE: "app",
    VERIFIED: contact.verified,
  };
}

// Deleting and re-attaching instead of forceMerge, whose surviving contact depends on last_modified
async function moveUserToExistingContact(
  contacts: Contacts,
  userId: string,
  email: string,
  attributes: Attributes,
  addToList: boolean
): Promise<void> {
  const previous = await contacts.getContactInfo({ identifier: userId, identifierType: "ext_id" });
  const wasOnList = previous.listIds?.includes(LIST_ID!) ?? false;
  await contacts.deleteContact({ identifier: userId, identifierType: "ext_id" });
  await contacts.updateContact({
    identifier: email,
    identifierType: "email_id",
    ext_id: userId,
    attributes,
    listIds: addToList || wasOnList ? [LIST_ID!] : undefined,
  });
}

export async function upsertNewsletterContact(contact: NewsletterContact): Promise<void> {
  const contacts = contactsClient("contact sync", contact.email);
  if (!contacts) return;

  const attributes = appAttributes(contact);
  try {
    // For an unknown user id Brevo attaches the id to a contact that already owns the address
    await contacts.updateContact({
      identifier: contact.userId,
      identifierType: "ext_id",
      attributes,
      listIds: [LIST_ID!],
    });
  } catch (error) {
    try {
      if (isNotFound(error)) {
        await contacts.createContact({
          email: contact.email,
          ext_id: contact.userId,
          attributes,
          listIds: [LIST_ID!],
          updateEnabled: true,
        });
      } else if (isDuplicate(error)) {
        await moveUserToExistingContact(contacts, contact.userId, contact.email, attributes, true);
      } else {
        report("upsert contact", error);
      }
    } catch (fallbackError) {
      report("upsert contact", fallbackError);
    }
  }
}

export async function markNewsletterContactVerified(contact: { userId: string; email: string }): Promise<void> {
  const contacts = contactsClient("contact verification", contact.email);
  if (!contacts) return;

  // Without this lookup, updating by an unknown user id would take over any contact owning the address,
  // including landing page subscribers who never consented in the app
  try {
    await contacts.getContactInfo({ identifier: contact.userId, identifierType: "ext_id" });
  } catch (error) {
    if (!isNotFound(error)) report("look up contact", error);
    return;
  }

  const attributes: Attributes = { EMAIL: contact.email, QUELLE: "app", VERIFIED: true };
  try {
    await contacts.updateContact({ identifier: contact.userId, identifierType: "ext_id", attributes });
  } catch (error) {
    if (!isDuplicate(error)) {
      report("mark contact verified", error);
      return;
    }
    try {
      await moveUserToExistingContact(contacts, contact.userId, contact.email, attributes, false);
    } catch (moveError) {
      report("move contact", moveError);
    }
  }
}

export async function removeNewsletterContact(contact: { userId: string; email: string }): Promise<void> {
  const contacts = contactsClient("contact removal", contact.email);
  if (!contacts) return;

  try {
    await contacts.updateContact({ identifier: contact.userId, identifierType: "ext_id", unlinkListIds: [LIST_ID!] });
  } catch (error) {
    if (!isNotFound(error)) report("unlink contact", error);
  }

  try {
    await contacts.removeContactFromList({ listId: LIST_ID!, body: { emails: [contact.email] } });
  } catch {
    // Addresses subscribed through the landing page carry no user id; not being on the list is fine
  }
}

// Throws so an account deletion aborts before any data is gone, instead of leaving a contact behind
export async function deleteNewsletterContact(userId: string): Promise<void> {
  if (!client) {
    console.log("[brevo] contact deletion skipped (no API key):", userId);
    return;
  }

  try {
    await client.contacts.deleteContact({ identifier: userId, identifierType: "ext_id" });
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}
