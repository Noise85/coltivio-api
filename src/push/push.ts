import { inArray } from "drizzle-orm";
import { captureException } from "@sentry/node";
import { adminDrizzle } from "../db/db";
import { pushTokens } from "../db/schema";
import { EXPO_MAX_MESSAGES_PER_REQUEST, PushMessage, PushTicket, postToExpo } from "./expo-client";

// Returns one ticket per message, in the same order as the messages
export async function sendPushMessages(messages: PushMessage[]): Promise<PushTicket[]> {
  const unregisteredTokens: string[] = [];
  const allTickets: PushTicket[] = [];

  for (let offset = 0; offset < messages.length; offset += EXPO_MAX_MESSAGES_PER_REQUEST) {
    const chunk = messages.slice(offset, offset + EXPO_MAX_MESSAGES_PER_REQUEST);
    try {
      const tickets = await postToExpo(chunk);
      allTickets.push(...tickets);
      // Tickets are returned in the same order as the messages
      tickets.forEach((ticket, index) => {
        if (ticket.status === "ok") return;
        if (ticket.details?.error === "DeviceNotRegistered") {
          unregisteredTokens.push(ticket.details.expoPushToken ?? chunk[index].to);
          return;
        }
        console.error(`[push] Expo push ticket error for ${chunk[index].to}:`, ticket.message, ticket.details);
        captureException(new Error(`Expo push ticket error: ${ticket.message}`));
      });
    } catch (err) {
      // One failing chunk shouldn't prevent the remaining chunks from being sent
      captureException(err);
      console.error("[push] Failed to send push chunk:", err);
      const message = err instanceof Error ? err.message : String(err);
      allTickets.push(...chunk.map((): PushTicket => ({ status: "error", message })));
    }
  }

  if (unregisteredTokens.length > 0) {
    await adminDrizzle.delete(pushTokens).where(inArray(pushTokens.token, unregisteredTokens));
  }
  return allTickets;
}
