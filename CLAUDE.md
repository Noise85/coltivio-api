# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Rules

- Always use `yarn` for package installation, never `npm install`.
- After adding or modifying code: run `yarn format`, `yarn lint`, and `npx tsc --noEmit`.
- Always add integration tests for new endpoints/features and ensure they pass before finishing.
- Never run `yarn db:migrate` or `yarn db:generate` — the user always handles migrations manually. Do not suggest or remind them to run these commands either.
- Always keep REST API backwards compatibility. New fields must be optional or have defaults. If a change could break existing clients, double-check and ask before proceeding.

## Commands

```bash
yarn start          # Run the API server (ts-node)
yarn test           # Run all integration tests (spins up Docker)
yarn lint           # ESLint with auto-fix
yarn format         # Prettier
npx tsc --noEmit    # Type-check without emitting

# Run specific test files (always prefer this over running all tests)
yarn test --testPathPattern=membership
yarn test --testPathPatterns="permissions|security"  # run multiple patterns

# Database
yarn db:migrate     # Apply pending Drizzle migrations
yarn db:generate    # Generate migration from schema changes
yarn db:push        # Push schema directly (dev only)
yarn db:reset       # Full local reset (Supabase + migrations + seed)
```

## Architecture

### Request lifecycle

Every request flows through `express-zod-api`. Endpoints are defined as `EndpointsFactory.build(...)` objects in `*.endpoint.ts` files, composed via middleware chains, and registered in `src/routing.ts`.

**Endpoint factories** (`src/endpoint-factory.ts`) — use the right one:
- `publicEndpointFactory` — no auth
- `authenticatedEndpointFactory` — Supabase JWT required; `ctx` gets `user`, `token`, `farmContext`, and all session APIs
- `farmEndpointFactory` — authenticated + a farm must be resolved; `ctx` also gets `farmId`/`farmRole`
- `ownerOnlyEndpointFactory` — farm + caller's role on that farm must be `owner`
- `userMembershipEndpointFactory` / `userPaidMembershipEndpointFactory` — user-scoped (no farm required)
- `adminApiKeyEndpointFactory` — static `x-admin-api-key` header, used for internal admin ops

A user can belong to multiple farms (`farm_members` join table, many-to-many with a per-farm role). Which farm a request operates on is resolved per-request in `supabaseAuthMiddleware`, never cached: the `x-farm-id` header if present (validated against `farm_members`, 403 if not a member), otherwise auto-defaulted when the user has exactly one farm, otherwise ambiguous (`farmEndpointFactory` 400s asking for the header). `profiles` no longer has `farmId`/`farmRole` columns.

### Session API

`sessionApi(db, t, locale)` in `src/api/api.ts` instantiates all domain modules (membership, wiki, etc.) and injects them into `ctx` via the auth middleware. When adding a new module, instantiate it here.

### Database

Two connection pools in `src/db/db.ts`:
- `adminDrizzle` — service role, bypasses RLS. Use for webhooks, background jobs, seeding.
- `clientDrizzle` — app role, used inside `rlsDb.rls()` transactions with JWT context set via `set_config`.

In endpoint handlers, use `db.rls(async (tx) => {...})` for user-scoped queries (RLS enforced) and `db.admin` for admin operations. The `adminOnlyDb` is a special `RlsDb` for contexts with no JWT (e.g. webhook handlers).

**Drizzle v1 relational query `where` syntax** — `.query.*` uses object filter syntax, NOT SQL expressions:
```typescript
tx.query.table.findFirst({ where: { id: someId } })                          // ✓
tx.query.animals.findMany({ where: { id: { in: ids }, dateOfDeath: { isNull: true } } }) // ✓
tx.query.table.findFirst({ where: eq(table.id, someId) })                    // ✗ wrong API
```
For complex WHERE with OR/AND, use `tx.select().from(table).where(eq(...))`.

### Schema

All tables in `src/db/schema.ts` — includes enums, relations (via `defineRelations`), and exported Zod schemas. Relations are defined at the bottom. Zod enums exported as `export const xSchema = z.enum(xEnum.enumValues)`.

RLS: all tables use `pgTable.withRLS()` with pgPolicy. Farm-scoped inserts need `farmId: ctx.farmId` (resolved from `farm_id()` SQL function via session config, itself set from the per-request farm resolution described above — `farm_id()` and the RLS policies only ever see a single farm id per request, regardless of how many farms the user belongs to).

### Module structure

Each domain has:
- `*.ts` — business logic, instantiated by `sessionApi`
- `*.endpoint.ts` — express-zod-api endpoint definitions
- `*.test.ts` or `src/test/*.integration.test.ts` — tests

### Testing

Tests are full integration tests — they start a real Postgres container + GoTrue auth container via Docker Compose (`docker-compose.test.yml`), run migrations, start the actual HTTP server, and make real HTTP requests. No mocking of DB or auth except Stripe (mocked via `jest.fn()`).

Test helpers (`src/test/helpers.ts`):
- `createTestUser(email, password)` — creates a GoTrue user and returns `{ userId, jwt, authHeader }`
- `getAdminDb()` — direct DB access for test assertions (bypasses RLS)
- `SERVER_URL` env var — set automatically by globalSetup, used to make requests

**IMPORTANT — when asked to fix failing tests:**
- NEVER run `yarn test` (all tests) — it takes many minutes and wastes a full Docker spin-up cycle.
- Ask the user which test file(s) are failing, OR infer from context (e.g. if wiki code changed, run `--testPathPatterns=wiki`).
- Only run `yarn test` (all) when the user explicitly asks to run the full suite.

### Stripe

Webhook handler at `POST /v1/webhooks/stripe` (`src/stripe/webhook.ts`). Events routed to `membership.handleWebhookEvent()`. Stripe checkout uses `price: priceId` directly (not `price_data`) so billing interval and active subscription counts reflect the configured Stripe price.

### Localization

`Accept-Language` header (first 2 chars) determines locale. Supported: `de`, `en`, `it`, `fr`. Defaults to `de`. Updated on the user profile on each request if changed.
