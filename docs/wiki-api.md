# Wiki API — Frontend Integration Guide

> All wiki endpoints are under `/v1/wiki`. All require a Supabase JWT.

```
Authorization: Bearer <supabase_access_token>
```

---

## Core Concepts

**Private entries** — the user's personal knowledge base. Always editable and deletable by the owner, never visible in the public wiki listing.

**Public entries** — community-owned content, created when a moderator approves a submission. Read-only for everyone except moderators (who can delete).

**Submission** is the bridge: submitting a private entry snapshots its content into a change request (`new_entry` type) and sends it directly to `under_review`. The source private entry is **never modified** and stays fully editable throughout.

**Change requests** are also used to propose edits to existing public entries (`change_request` type).

---

## Data Types

### WikiCategory

```ts
type WikiCategory = {
  id: string
  slug: string                      // e.g. "crop-care"
  createdAt: string
  translations: WikiCategoryTranslation[]
}

type WikiCategoryTranslation = {
  id: string
  categoryId: string
  locale: "de" | "en" | "it" | "fr"
  name: string
}
```

### WikiEntry

```ts
type WikiEntry = {
  id: string
  slug: string                      // e.g. "tomato-care"
  status: "draft" | "submitted" | "under_review" | "published" | "rejected"
  visibility: "private" | "public"
  createdBy: string                 // user UUID
  farmId: string | null
  categoryId: string
  category: WikiCategory
  createdAt: string
  updatedAt: string
  translations: WikiTranslation[]
  images: WikiImage[]
  tags: WikiEntryTag[]
}
```

`visibility` is the key field for frontend logic:
- `"private"` — user's own draft, editable and deletable at any time
- `"public"` — published community content, read-only for the author (change requests only)

### WikiTranslation

```ts
type WikiTranslation = {
  id: string
  entryId: string
  locale: "de" | "en" | "it" | "fr"
  title: string
  body: string        // Markdown
  updatedBy: string | null
  updatedAt: string
}
```

Entries always return all available translations. Pick the user's locale, fallback to `"en"`:

```ts
function getTranslation(entry: WikiEntry, locale: string) {
  return (
    entry.translations.find((t) => t.locale === locale) ??
    entry.translations.find((t) => t.locale === "en") ??
    entry.translations[0]
  );
}
```

### WikiImage

```ts
type WikiImage = {
  id: string
  entryId: string
  storagePath: string   // e.g. "<entryId>/<uuid>.jpg"
  altText: string | null
  uploadedBy: string | null
  createdAt: string
}
```

### WikiTag / WikiEntryTag

```ts
type WikiTag = {
  id: string
  name: string          // e.g. "Crop Care"
  slug: string          // e.g. "crop-care"
  createdBy: string | null
  createdAt: string
}

type WikiEntryTag = {
  id: string
  entryId: string
  tagId: string
  tag: WikiTag
}
```

### WikiChangeRequest

Covers both new-entry submissions and edit proposals on existing public entries.

```ts
type WikiChangeRequest = {
  id: string
  entryId: string | null    // new_entry: back-ref to source private entry (null if deleted)
                             // change_request: the public entry being modified
  type: "new_entry" | "change_request"
  status: "draft" | "under_review" | "approved" | "rejected"
  submittedBy: string

  // Snapshot fields — populated on new_entry type, null on change_request
  proposedSlug: string | null
  proposedCategoryId: string | null
  proposedFarmId: string | null

  createdAt: string
  resolvedAt: string | null

  translations: WikiChangeRequestTranslation[]
}

type WikiChangeRequestTranslation = {
  id: string
  changeRequestId: string
  locale: "de" | "en" | "it" | "fr"
  title: string
  body: string    // Markdown
}
```

### WikiChangeRequestNote

Notes are the communication thread between submitter and moderator on a change request.

```ts
type WikiChangeRequestNote = {
  id: string
  changeRequestId: string
  authorId: string
  body: string
  createdAt: string
}
```

---

## Change Request Lifecycle

```
Private entry (always editable by owner)
    │
    └─ POST /byId/:entryId/submit
           │
           ▼
    [new_entry CR: under_review]  ◄──────────────────────┐
           │                                              │
           ├─ approve  ──► new public entry created       │
           │               CR status: approved            │
           │                                              │
           ├─ reject   ──► CR status: rejected (terminal) │
           │               user must submit again          │
           │                                              │
           └─ requestChanges ──► CR status: draft         │
                  │                                       │
                  │  (user edits draft CR, adds notes)    │
                  │                                       │
                  └─ PATCH /myChangeRequestDrafts/byId/:id │
                     POST  /myChangeRequestDrafts/byId/:id/submit ──┘

Public entry (community-owned)
    └─ POST /byId/:entryId/changeRequest
           │
           ▼
    [change_request CR: under_review]
           │
           ├─ approve  ──► translations merged into public entry
           ├─ reject   ──► CR status: rejected
           └─ requestChanges ──► CR status: draft (same cycle as above)
```

**Status meanings:**
- `draft` — CR returned to author for revision; author can edit and resubmit
- `under_review` — awaiting moderator action; CR is frozen (read-only for author)
- `approved` / `rejected` — terminal states

Notes can be added by **both sides at any time**, regardless of status. They are the sole communication channel (no inline `reviewNotes` field on the CR).

---

## Endpoints

### Public / Read

---

#### `GET /v1/wiki`

List all published public entries.

| Param | Type | Description |
|-------|------|-------------|
| `locale` | `"de"` \| `"en"` \| `"it"` \| `"fr"` | Optional, no effect on filtering — all translations returned. |
| `categorySlug` | `string` | Filter by category slug. |
| `tagSlug` | `string` | Filter by tag slug. |
| `search` | `string` | Text search on title and body. |

**Response:** `{ result: WikiEntry[], count: number }`

---

#### `GET /v1/wiki/bySlug/:slug`

Get a single published public entry by its human-readable slug. Use this for public wiki reader URLs (e.g. `/wiki/tomato-care`).

**Response:** `WikiEntry` · **Errors:** `404`

---

#### `GET /v1/wiki/byId/:entryId`

Get a single entry by UUID. RLS-scoped — owner can fetch their own private entry, anyone can fetch a public entry. Use this for the editor or internal navigation.

**Response:** `WikiEntry` · **Errors:** `404`

---

### User's Own Entries

---

#### `GET /v1/wiki/myEntries`

All entries belonging to the authenticated user (private drafts and public entries they created).

**Response:** `{ result: WikiEntry[], count: number }`

Use `entry.visibility` to distinguish private drafts from published contributions.

---

#### `POST /v1/wiki`

Create a new private wiki entry.

```json
{
  "id": "optional-pre-generated-uuid",
  "slug": "tomato-care",
  "categoryId": "category-uuid",
  "farmId": "optional-farm-uuid",
  "translations": [
    { "locale": "en", "title": "Tomato Care", "body": "## Introduction\n..." }
  ],
  "tagIds": ["tag-uuid-1"]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `slug` | yes | `^[a-z0-9-]+$`. Must be globally unique. |
| `categoryId` | yes | UUID from `GET /v1/wiki/categories`. |
| `translations` | yes | At least one. Empty-title translations are ignored. |
| `id` | no | Pre-generate to upload images before the entry exists. |
| `farmId` | no | Associates entry with a specific farm. |
| `tagIds` | no | Array of existing tag UUIDs. |

**Response:** `WikiEntry`

---

#### `PATCH /v1/wiki/byId/:entryId`

Update a private entry. Only the owner can edit; only `private` entries are editable.

Translations are **upserted per locale** — supply only what you want to create or overwrite. Omitted locales are unchanged. Tags are **replaced** if `tagIds` is provided; omit to leave unchanged.

```json
{
  "slug": "new-slug",
  "categoryId": "category-uuid",
  "translations": [
    { "locale": "de", "title": "Tomatenpflege", "body": "## Einleitung\n..." }
  ],
  "tagIds": ["tag-uuid-1"]
}
```

**Response:** `WikiEntry` · **Errors:** `403` not owner · `400` not private · `404`

---

#### `DELETE /v1/wiki/byId/:entryId`

- **Private entries**: owner can delete at any time, even with a pending submission.
- **Public entries**: moderator only.

**Response:** `{}` · **Errors:** `403` · `404`

---

#### `POST /v1/wiki/byId/:entryId/submit`

Submit a private entry for moderator review. Snapshots the current slug, category, and translations into a `new_entry` change request with status `under_review`. The source private entry is **not modified**.

**Response:** `WikiChangeRequest` · **Errors:** `403` not owner · `400` not private or no translations · `404`

---

#### `POST /v1/wiki/byId/:entryId/changeRequest`

Propose edits to an existing **public** entry. Creates a `change_request` CR with status `under_review`. The public entry is untouched until approved.

```json
{
  "translations": [
    { "locale": "en", "title": "Updated Title", "body": "Updated body..." }
  ]
}
```

At least one translation required.

**Response:** `WikiChangeRequest` · **Errors:** `400` not public · `404`

---

### Draft Change Requests (submitter, status = `draft`)

These endpoints are for change requests that have been sent back for revision (`requestChanges`). CRs in `under_review` or terminal states are read-only.

---

#### `PATCH /v1/wiki/myChangeRequestDrafts/byId/:changeRequestId`

Edit a draft change request. All fields optional.

```json
{
  "translations": [
    { "locale": "en", "title": "Revised Title", "body": "Revised body..." }
  ],
  "proposedSlug": "new-slug",
  "proposedCategoryId": "category-uuid",
  "proposedFarmId": "farm-uuid"
}
```

**Response:** `WikiChangeRequest`

---

#### `POST /v1/wiki/myChangeRequestDrafts/byId/:changeRequestId/submit`

Resubmit a draft change request for review. Moves status from `draft` → `under_review`.

**Response:** `WikiChangeRequest`

---

### My Change Requests

---

#### `GET /v1/wiki/myChangeRequests`

All change requests submitted by the authenticated user (all types, all statuses).

**Response:** `{ result: WikiChangeRequest[], count: number }`

Use `status` to show the current state:
- `draft` — returned for revision, user can edit and resubmit
- `under_review` — waiting for moderator decision
- `approved` — accepted
- `rejected` — declined (terminal; submit a new one to try again)

Check the notes thread (`GET notes`) for moderator feedback.

---

### Change Request Notes

Notes are available on both the submitter-facing (`myChangeRequestDrafts`) and moderator-facing (`changeRequests`) paths. Both sides can read and write notes at any time.

---

#### `GET /v1/wiki/myChangeRequestDrafts/byId/:changeRequestId/notes`
#### `GET /v1/wiki/changeRequests/byId/:changeRequestId/notes`

Get all notes for a change request, ordered oldest first.

**Response:** `{ result: WikiChangeRequestNote[], count: number }`

---

#### `POST /v1/wiki/myChangeRequestDrafts/byId/:changeRequestId/notes`
#### `POST /v1/wiki/changeRequests/byId/:changeRequestId/notes`

Add a note to a change request.

```json
{ "body": "The German translation is missing a section on watering frequency." }
```

**Response:** `WikiChangeRequestNote`

---

### Images

Images go directly to Supabase Storage via a signed URL. The API only issues the URL and records the result.

Images can be uploaded **before** the entry exists by pre-generating the entry UUID client-side. Orphaned images are cleaned up by a background cron job.

```
1. (Optional) Generate UUID client-side: const id = crypto.randomUUID()

2. POST /v1/wiki/images/signedUrl  { entryId, filename }
   → { signedUrl, path }

3. PUT <signedUrl>  — binary upload directly to Supabase, no auth header needed

4. POST /v1/wiki/images  { entryId, storagePath: path }
   → { id, publicUrl }

5. Embed in markdown: ![alt](publicUrl)
```

---

#### `POST /v1/wiki/images/signedUrl`

```json
{ "entryId": "entry-uuid", "filename": "photo.jpg" }
```

**Response:** `{ signedUrl: string, path: string }`

The signed URL is single-use and short-lived.

---

#### `POST /v1/wiki/images`

Register an uploaded image and get its permanent public URL.

```json
{ "entryId": "entry-uuid", "storagePath": "<entryId>/<uuid>.jpg" }
```

**Response:** `{ id: string, publicUrl: string }`

**Errors:** `400` if `storagePath` is not scoped to `entryId`, or entry belongs to another user.

---

#### `DELETE /v1/wiki/images/byId/:imageId`

Remove an image record. Storage cleanup is handled by cron.

**Response:** `{}`

---

### Categories

Moderator-managed. Fetch once on app load and cache.

---

#### `GET /v1/wiki/categories`

**Response:** `{ result: WikiCategory[], count: number }`

---

### Tags

Global (not farm-scoped). Anyone can create them.

---

#### `GET /v1/wiki/tags`

**Response:** `{ result: WikiTag[], count: number }`

---

#### `POST /v1/wiki/tags`

Get or create a tag by slug (idempotent).

```json
{ "name": "Crop Care", "slug": "crop-care" }
```

**Response:** `WikiTag`

---

## Moderation Endpoints

All require the caller to be a registered wiki moderator. Returns `403` otherwise.

---

#### `GET /v1/wiki/reviewQueue`

All change requests with status `under_review`, ordered oldest first.

- `change_request` type: `entry` is the current public entry — diff `changeRequest.translations` vs `entry.translations`.
- `new_entry` type: `entry` is the source private entry for context (may be `null` if deleted). Proposed content is in `changeRequest.translations` + `proposedSlug` + `proposedCategoryId`.

**Response:** `{ result: (WikiChangeRequest & { entry: WikiEntry | null })[], count: number }`

---

#### `GET /v1/wiki/changeRequests/byId/:changeRequestId`

Get a single change request with entry context.

**Response:** `WikiChangeRequest & { entry: WikiEntry | null }`

---

#### `POST /v1/wiki/changeRequests/byId/:changeRequestId/approve`

Approve a change request.

- `new_entry`: creates a new public `WikiEntry` from the snapshot (`proposedSlug`, `proposedCategoryId`, `proposedFarmId`, `translations`). Images and tags are copied from the source private entry if it still exists.
- `change_request`: merges proposed translations into the existing public entry (upsert per locale).

CR status → `approved`.

**Response:** `{}`

---

#### `POST /v1/wiki/changeRequests/byId/:changeRequestId/reject`

Reject a change request. Terminal — the submitter must start a new submission to try again. Add a note explaining the reason before or after rejecting.

CR status → `rejected`.

**Response:** `{}`

---

#### `POST /v1/wiki/changeRequests/byId/:changeRequestId/requestChanges`

Return the CR to the author for revision. CR status → `draft`. The author can then edit the draft and resubmit. Use notes to communicate what needs changing.

**Response:** `{}`

---

#### `POST /v1/wiki/admin/moderators`

Grant wiki moderator rights. Idempotent.

```json
{ "userId": "user-uuid" }
```

**Response:** `{}`

---

#### `DELETE /v1/wiki/admin/moderators`

Revoke wiki moderator rights.

```json
{ "userId": "user-uuid" }
```

**Response:** `{}`

---

#### `POST /v1/wiki/admin/categories`

Create a new category.

```json
{
  "slug": "pest-identification",
  "translations": [
    { "locale": "en", "name": "Pest Identification" },
    { "locale": "de", "name": "Schädlingsidentifikation" },
    { "locale": "it", "name": "Identificazione dei parassiti" },
    { "locale": "fr", "name": "Identification des nuisibles" }
  ]
}
```

**Response:** `WikiCategory`

---

#### `DELETE /v1/wiki/admin/categories/byId/:categoryId`

Delete a category. Fails with a DB constraint error if entries still reference it.

**Response:** `{}`

---

## Error Reference

| Status | Meaning |
|--------|---------|
| `400` | Invalid input or business rule violation. |
| `401` | Missing or invalid JWT. |
| `403` | Not authorized (not owner / not moderator). |
| `404` | Not found or not visible to the requester. |
| `500` | Server error. |

```json
{ "status": "error", "error": { "message": "Only private entries can be submitted" } }
```
