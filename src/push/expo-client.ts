import { z } from "zod";

// Expo push service — https://docs.expo.dev/push-notifications/sending-notifications/
// Called via fetch directly: expo-server-sdk v7 is ESM-only and can't be required from this CommonJS build.
const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const EXPO_MAX_MESSAGES_PER_REQUEST = 100;

export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

const pushTicketSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string().optional(), expoPushToken: z.string().optional() }).optional(),
  }),
]);
const pushResponseSchema = z.object({ data: z.array(pushTicketSchema) });

export type PushTicket = z.infer<typeof pushTicketSchema>;

// Receipts have the same shape as error tickets, success receipts carry no id
const pushReceiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);
const pushReceiptsResponseSchema = z.object({ data: z.record(z.string(), pushReceiptSchema) });

export type PushReceipt = z.infer<typeof pushReceiptSchema>;

function expoHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (process.env.EXPO_ACCESS_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
  }
  return headers;
}

export function isExpoPushToken(token: string): boolean {
  return /^(ExponentPushToken|ExpoPushToken)\[.+\]$/.test(token);
}

// Sends one chunk (max EXPO_MAX_MESSAGES_PER_REQUEST) to Expo.
// Lives in its own module so tests can mock the HTTP call while push.ts still runs the token cleanup.
export async function postToExpo(messages: PushMessage[]): Promise<PushTicket[]> {
  const response = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: expoHeaders(),
    body: JSON.stringify(messages.map((message) => ({ ...message, sound: "default" }))),
  });
  if (!response.ok) {
    throw new Error(`Expo push request failed with status ${response.status}: ${await response.text()}`);
  }
  return pushResponseSchema.parse(await response.json()).data;
}

// Delivery receipts for ticket ids. A ticket only says Expo accepted the message; the receipt
// (available after a few seconds) says whether APNs/FCM accepted it, e.g. InvalidCredentials.
export async function fetchPushReceipts(ticketIds: string[]): Promise<Record<string, PushReceipt>> {
  const response = await fetch(EXPO_RECEIPTS_URL, {
    method: "POST",
    headers: expoHeaders(),
    body: JSON.stringify({ ids: ticketIds }),
  });
  if (!response.ok) {
    throw new Error(`Expo receipts request failed with status ${response.status}: ${await response.text()}`);
  }
  return pushReceiptsResponseSchema.parse(await response.json()).data;
}
