import { EndpointsFactory, Middleware } from "express-zod-api";
import createHttpError from "http-errors";
import { captureException } from "@sentry/node";
import { jwtDecode } from "jwt-decode";
import { z } from "zod";
import { sessionApi } from "./api/api";
import { eq } from "drizzle-orm";
import { adminDrizzle, rlsDb } from "./db/db";
import { supabase, SupabaseToken } from "./supabase/supabase";
import * as tables from "./db/schema";
import { FarmPermissionFeature } from "./db/schema";
import { sentryResultHandler } from "./sentry";
import { completeAddressChangeIfNeeded, sendVerificationEmailIfNeeded } from "./user/user-verification";

export const supabaseAuthMiddleware = new Middleware({
  security: {
    // this information is optional and used for generating documentation
    type: "header",
    name: "authorization",
  },
  input: z.object({}),
  handler: async ({ input: {}, request, logger }) => {
    const authorizationHeader = request.headers.authorization;
    if (!authorizationHeader) {
      throw createHttpError(401, "Invalid authorization header");
    }
    const [_, jwt] = authorizationHeader.split(" ");
    const {
      data: { user: authUser },
      error: supabaseAuthError,
    } = await supabase.auth.getUser(jwt);
    if (!authUser) {
      // supabase.auth.getUser rejects for several distinct reasons (expired token, wrong
      // signing key/project, malformed token, revoked session, etc). Decoding the token here
      // (without verifying it, since that's what just failed) lets us tell those apart in logs
      // without ever logging the raw JWT itself.
      let decodedToken: SupabaseToken | null = null;
      try {
        decodedToken = jwtDecode<SupabaseToken>(jwt);
      } catch (decodeError) {
        logger.error("supabaseAuthMiddleware: failed to decode JWT after auth rejection", {
          url: request.url,
          decodeError,
        });
      }
      logger.error("supabaseAuthMiddleware: supabase rejected JWT, no user found", {
        url: request.url,
        supabaseErrorMessage: supabaseAuthError?.message,
        supabaseErrorStatus: supabaseAuthError?.status,
        supabaseErrorCode: supabaseAuthError?.code,
        tokenSub: decodedToken?.sub,
        tokenIss: decodedToken?.iss,
        tokenExp: decodedToken?.exp ? new Date(decodedToken.exp * 1000).toISOString() : undefined,
        tokenIat: decodedToken?.iat ? new Date(decodedToken.iat * 1000).toISOString() : undefined,
        tokenExpired: decodedToken?.exp ? decodedToken.exp * 1000 < Date.now() : undefined,
        now: new Date().toISOString(),
      });
      throw createHttpError(401, "Invalid jwt token, no user found");
    }
    const user = await adminDrizzle.query.profiles.findFirst({
      where: { id: authUser.id },
    });
    if (!user) {
      throw createHttpError(401, "User not found");
    }
    const token = jwtDecode<SupabaseToken>(jwt);
    const SUPPORTED_LOCALES = ["de", "en", "it", "fr"] as const;
    const rawLocale = request.headers["accept-language"]?.slice(0, 2);
    const requestLocale = SUPPORTED_LOCALES.includes(rawLocale as (typeof SUPPORTED_LOCALES)[number])
      ? (rawLocale as (typeof SUPPORTED_LOCALES)[number])
      : null;
    if (requestLocale && user.locale !== requestLocale) {
      await adminDrizzle.update(tables.profiles).set({ locale: requestLocale }).where(eq(tables.profiles.id, user.id));
      user.locale = requestLocale;
    }

    // After the locale sync, so mails go out in the language of the requesting client
    if (!user.verificationHandledAt) {
      const handle = user.emailVerified ? completeAddressChangeIfNeeded : sendVerificationEmailIfNeeded;
      void handle(user.id).catch(captureException);
    }

    const farmContext = await resolveFarmContext(request.headers["x-farm-id"], user.id);

    return {
      token,
      user,
      farmContext,
      // Pass the resolved locale, the raw header (e.g. "de-CH,de;q=0.9" or "*") is not a valid Intl locale
      ...sessionApi(rlsDb(token, farmContext.farmId), request.t, requestLocale ?? user.locale),
    };
  },
});

export type FarmContext = {
  farmId: string | null;
  farmRole: "owner" | "member" | null;
  // why no farm could be resolved; null when a farm was resolved or the user simply has no farms.
  // "ambiguous": belongs to 2+ farms and didn't specify which one via the x-farm-id header.
  // "not_a_member": the header named a farm they don't belong to (typically stale client state).
  unresolved: "ambiguous" | "not_a_member" | null;
};

const uuidSchema = z.string().uuid();

// Resolves which farm a request operates on. Never trusts the header blindly — it's always
// checked against farm_members. Falls back to auto-selecting the user's only farm when the
// header is omitted, which is what keeps every existing single-farm client working unchanged.
//
// This only *reports* an unresolvable farm, it doesn't reject: rejecting here would run for every
// authenticated request and leave a client with a stale x-farm-id deadlocked — unable to call
// /v1/farms to find out which farms it does belong to. farmEndpointFactory does the rejecting,
// since it's the only layer that actually needs a farm. Note there is still no silent fallback to
// a different farm: an unresolvable header yields farmId null, so RLS sees no farm at all.
async function resolveFarmContext(farmIdHeader: string | string[] | undefined, userId: string): Promise<FarmContext> {
  const requestedFarmId = typeof farmIdHeader === "string" ? farmIdHeader : undefined;
  // A non-UUID header is a broken client rather than stale state, so it still fails loudly.
  if (requestedFarmId !== undefined && !uuidSchema.safeParse(requestedFarmId).success) {
    throw createHttpError(400, "Invalid x-farm-id header");
  }

  const memberships = await adminDrizzle.query.farmMembers.findMany({ where: { userId } });

  if (requestedFarmId) {
    const match = memberships.find((m) => m.farmId === requestedFarmId);
    if (!match) {
      return { farmId: null, farmRole: null, unresolved: "not_a_member" };
    }
    return { farmId: match.farmId, farmRole: match.role, unresolved: null };
  }

  if (memberships.length === 1) {
    return { farmId: memberships[0].farmId, farmRole: memberships[0].role, unresolved: null };
  }

  if (memberships.length > 1) {
    return { farmId: null, farmRole: null, unresolved: "ambiguous" };
  }

  return { farmId: null, farmRole: null, unresolved: null };
}

const sentryEndpointFactory = new EndpointsFactory(sentryResultHandler);

export const publicEndpointFactory = sentryEndpointFactory.addMiddleware(
  new Middleware({
    input: z.object({}),
    handler: async ({ input: {}, request, logger: _logger }) => {
      const preferredLanguage = request.headers["accept-language"] ?? "de";
      return { preferredLanguage };
    },
  })
);

export const authenticatedEndpointFactory = publicEndpointFactory.addMiddleware(supabaseAuthMiddleware);

// Resolves the caller's user id from an Authorization header without requiring one. Any failure
// to resolve a user (missing/malformed/expired token) falls back to anonymous (null) rather than
// throwing, so callers of this never need to reject a request over it.
export async function resolveOptionalUserId(authorizationHeader: string | undefined): Promise<string | null> {
  const jwt = authorizationHeader?.split(" ")[1];
  if (!jwt) return null;
  try {
    const {
      data: { user: authUser },
    } = await supabase.auth.getUser(jwt);
    return authUser?.id ?? null;
  } catch {
    return null;
  }
}

// For endpoints that must work for both logged-in and anonymous callers (e.g. donations).
export const optionalUserEndpointFactory = publicEndpointFactory.addMiddleware(
  new Middleware({
    security: {
      type: "header",
      name: "authorization",
    },
    input: z.object({}),
    handler: async ({ request }) => ({ userId: await resolveOptionalUserId(request.headers.authorization) }),
  })
);

export const farmEndpointFactory = authenticatedEndpointFactory.addMiddleware(
  new Middleware({
    input: z.object({}),
    handler: async ({ input: {}, request: _request, logger: _logger, ctx }) => {
      if (ctx.farmContext.unresolved === "not_a_member") {
        throw createHttpError(403, "You are not a member of the specified farm");
      }
      if (ctx.farmContext.unresolved === "ambiguous") {
        throw createHttpError(400, "You belong to multiple farms; specify the X-Farm-Id header");
      }
      if (!ctx.farmContext.farmId) {
        throw createHttpError(400, "User has no farm");
      }
      return { farmId: ctx.farmContext.farmId, farmRole: ctx.farmContext.farmRole };
    },
  })
);

// Factories for endpoints that require membership but NOT a farm (e.g. the platform-wide forum).
// Membership is checked per-user rather than per-farm.
export const userMembershipEndpointFactory = authenticatedEndpointFactory.addMiddleware(
  new Middleware({
    input: z.object({}),
    handler: async ({ ctx }) => {
      const active = await ctx.membership.isActiveUser(ctx.user.id);
      if (!active) throw createHttpError(403, "Active membership required");
      return {};
    },
  })
);

export const userPaidMembershipEndpointFactory = authenticatedEndpointFactory.addMiddleware(
  new Middleware({
    input: z.object({}),
    handler: async ({ ctx }) => {
      const paid = await ctx.membership.isPaidUser(ctx.user.id);
      if (!paid) throw createHttpError(403, "Paid membership required");
      return {};
    },
  })
);

// Factory for endpoints that are exclusively for farm owners (not members).
export const ownerOnlyEndpointFactory = farmEndpointFactory.addMiddleware(
  new Middleware({
    input: z.object({}),
    handler: async ({ ctx }) => {
      if (ctx.farmRole !== "owner") {
        throw createHttpError(403, "Only farm owners can perform this action");
      }
      return {};
    },
  })
);

// Returns a factory that requires farm membership (no subscription needed) + feature permission.
// Use for core agricultural features (animals, plots, crops, etc.) that all farm members can access.
// Owners bypass the permission check; "none" blocks all access; "write" required for mutations.
export function permissionFarmEndpoint(feature: FarmPermissionFeature, access: "read" | "write") {
  return farmEndpointFactory.addMiddleware(
    new Middleware({
      input: z.object({}),
      handler: async ({ ctx }) => {
        if (ctx.farmRole === "owner") return {};
        const userAccess = await ctx.farmPermissions.getFeatureAccess(ctx.user.id, ctx.farmId, feature);
        if (userAccess === "none") throw createHttpError(403, `Access denied for: ${feature}`);
        if (access === "write" && userAccess !== "write")
          throw createHttpError(403, `Write access required for: ${feature}`);
        return {};
      },
    })
  );
}

// Factory for internal admin endpoints protected by a static API key (from env ADMIN_API_KEY).
// Used for operations that don't go through Supabase auth (e.g. promoting wiki moderators).
export const adminApiKeyEndpointFactory = sentryEndpointFactory.addMiddleware(
  new Middleware({
    security: {
      type: "header",
      name: "x-admin-api-key",
    },
    input: z.object({}),
    handler: async ({ request }) => {
      const expectedKey = process.env.ADMIN_API_KEY;
      if (!expectedKey) {
        throw createHttpError(500, "ADMIN_API_KEY env var not configured");
      }
      const providedKey = request.headers["x-admin-api-key"];
      if (providedKey !== expectedKey) {
        throw createHttpError(401, "Invalid admin API key");
      }
      return { adminDrizzle };
    },
  })
);
