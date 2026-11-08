# Permission Model

Endpoints are protected by a layered middleware chain in `src/endpoint-factory.ts`.

## Layers

| Layer | Factory | Requirement |
|---|---|---|
| Public | `publicEndpointFactory` | None |
| Authenticated | `authenticatedEndpointFactory` | Valid Supabase JWT |
| Farm | `farmEndpointFactory` | Authenticated + `user.farmId` set |
| Feature permission (no membership) | `permissionFarmEndpoint(feature, access)` | Farm + feature access ≥ `read`/`write` |
| Feature permission + membership | `permissionMembershipEndpoint(feature, access)` | Farm + active membership (trial or paid) + feature access |
| Owner only | `ownerOnlyEndpointFactory` | Farm + `farmRole === "owner"` |

**Note:** In all `permission*` factories, farm owners bypass the per-feature access check.

---

## Feature permissions

There are 4 features. Each can be set to `none` (default), `read`, or `write` per farm member.

### `animals` — no membership required

Covers all animal and treatment-related functionality.

| Module | Endpoints |
|---|---|
| Animals | CRUD, herds, herd schedules, family tree, import, outdoor journal |
| Ear tags | CRUD |
| Treatments | CRUD |
| Drugs | CRUD |
| Reports | outdoor journal report, treatment report |

### `field_calendar` — no membership required

Covers all field and crop management functionality.

| Module | Endpoints |
|---|---|
| Plots | CRUD, split, merge |
| Plot journal | CRUD (requires membership) |
| Crops + crop families | CRUD |
| Crop rotations | CRUD, plan, batch (draft plans require membership) |
| Crop protection | applications, products, presets |
| Fertilization | applications, fertilizers, presets |
| Harvests | CRUD, presets, summary |
| Tillages | CRUD, presets |
| Reports | field calendar report (send + download) |

### `commerce` — membership required (trial or paid)

Covers all commercial and customer-facing functionality.

| Module | Endpoints |
|---|---|
| Contacts | CRUD |
| Orders | CRUD, items, confirm/fulfill/cancel, invoice download |
| Invoice settings | CRUD, logo upload |
| Products | CRUD |
| Sponsorships | CRUD, payments |
| Sponsorship programs | CRUD |

### `tasks` — membership required (trial or paid)

| Module | Endpoints |
|---|---|
| Tasks | CRUD, status, checklist |

---

## Farm-level only (no feature permission)

| Endpoint group | Notes |
|---|---|
| Farm CRUD | create, read, update, delete farm |
| Farm members | list, kick, change role |
| Farm invites | list, create, revoke all require `ownerOnly`; accept uses `authenticatedEndpointFactory` |
| Farm permissions | list; set/reset requires `ownerOnly` |
| Dashboard | stats + field events |

---

## Authenticated only (no farm required)

| Endpoint group |
|---|
| Membership management (checkout, trial, cancel, status) |
| User profile (get, update, delete) |
| Wiki (entries, change requests, moderation) |
| Forum (threads, replies, moderation) |
| Map layers (plots layer, federal farm plots) |

---

## Testphase override

Set `UNLIMITED_TRIAL=true` in `.env` to bypass all membership checks (`isActive`, `isPaidMember`, `isActiveUser`, `isPaidUser` all return `true`). Remove the var to restore normal behavior.
