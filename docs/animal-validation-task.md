# Animal consistency validation — development task

Source: Sid's request in the current chat, 2026-11-08. No GitHub issue was supplied or published. Local task reference: `ANIMAL-VALIDATION` (not a GitHub ID).

Classification: bug / missing domain validation. Purpose: prevent newly contradictory animal records while keeping legacy records usable. Actors: callers with the existing selected-farm `animals` write permission; readers retain existing read access. No new membership requirement or permission is introduced.

## Confirmed scope

| Requirement | Expected behavior |
| --- | --- |
| R1 — usage | `milk` is prohibited for `pig` and `deer`; no additional species/usage restrictions. |
| R2 — parents | A supplied mother is female; father is male. Each is the offspring's species, born strictly before it, and is not the offspring itself. |
| R3 — life dates | Birth cannot be in the future. Death cannot precede birth. A non-null death reason requires a death date. |
| R4 — entry points | Apply to create, single update, both bulk update forms, legacy Excel import and preview/commit import including merge. Return a clear validation message. |
| R5 — compatibility | Existing invalid data remains readable; unrelated edits and import merges are not blocked by unchanged legacy contradictions. |
| R6 — evidence | Cover valid and invalid cases for every rule, including compatibility regressions. |

Out of scope: meaning of `registered`, ear-tag requirements, historical cleanup/backfill, schema migration, new species/usage rules, future-death prohibition, ancestry graph validation beyond the stated parent rules, unrelated refactoring, external publication.

## PO ↔ Architect refinement decisions

The root Architect reviewed and agreed these bounded interpretations; they are explicit compatibility choices derived from R2/R4/R5, rather than additional stakeholder rules:

1. **Effective state:** validate persisted values plus actual proposed changes, not a partial patch in isolation. Import merge preserves the target's stored species (`type`); the import's top-level type applies to new animals, as today.
2. **Fine-grained grandfathering:** compare actual old/new operands for each individual rule. New animals must satisfy every applicable rule. Existing records may retain an unchanged invalid rule; a changed rule's operands must satisfy that rule. Resubmitting identical values counts as unchanged, including mandatory merge fields. Fixing one contradiction must not force repair of an unrelated unchanged contradiction. Compare normalized date values, not object identity.
3. **Outgoing parent relations:** validate a mutated animal's applicable mother/father relations. Updating an existing parent's sex/species/birth does not fan out to revalidate all stored children in this task. When parent and offspring are both in the same atomic mutation set, validate their final intended state independently of input order.
4. **Dates:** normalize stored dates to UTC days and use the existing Europe/Zurich calendar day for today. Birth today is valid; equal parent/offspring birth is invalid; equal death/birth is valid. Do not add a future-death rule. Null reason is allowed without death; death without reason is allowed, preserving existing import defaults.
5. **Reference resolution:** explicit parent IDs must resolve within the selected farm. Missing/inaccessible IDs receive a generic validation error without revealing another farm's records. Preserve existing unresolved import ear-tag behavior when no relation is written. Every resolved parent relation actually written must meet R2, including parents created or merged in the same import, regardless of row order.
6. **Failure behavior:** preserve atomic rejection of mutation batches and existing import row-skip responses. Validate a rejected import animal row before persisting its animal changes or parent relation; valid rows may continue according to the existing import contract. Rows skipped for existing reasons remain skipped and receive no delayed parent mutation. Do not redesign import transactions or expose a new response shape.
7. **Client messages:** use the current error envelope/status conventions and existing localization mechanisms (`de`, `en`, `it`, `fr`). Identify the violated field/rule and animal or row/index when available. Preview remains non-persisting; commit remains authoritative because preview lacks the chosen species/merge context.

## Acceptance criteria

| AC | Given / when / then | Trace |
| --- | --- | --- |
| AC1 | Given create/import-create, when pig or deer uses `milk`, reject/skip with a usage/species message. Accept both with `other`, and retain permitted usage for other species. | R1, R4 |
| AC2 | Given an actual mother/father assignment, accept the matching sex; reject the opposite sex with a parent-role message. | R2, R4 |
| AC3 | Given an actual parent assignment, accept same species; reject different species. | R2, R4 |
| AC4 | Given an actual parent assignment, accept a strictly earlier parent birth day; reject same day or later. Reject self-parent assignments for either role. | R2, R4 |
| AC5 | Given an explicit parent ID, reject missing/inaccessible references without disclosing cross-farm details. Existing read/write permissions and selected-farm scope remain effective. | R2, R4 |
| AC6 | Given a birth date, accept today/past and reject tomorrow/future using a deterministic Europe/Zurich current-day boundary (stored dates normalized to UTC days). | R3, R4 |
| AC7 | Given birth/death dates, accept equal/later death and reject earlier death. Changing birth must consider retained death and vice versa. | R3, R4 |
| AC8 | Given non-null `deathReason`, require an effective death date. A patch adding a reason may use an existing death date. Removing death while retaining a reason is rejected; clearing both together is allowed where the existing patch schema permits null. | R3, R4 |
| AC9 | For create, single patch, per-animal update array, common-patch batch, legacy import and commit create/merge, exercise the relevant valid/invalid cases and consistent messages. Common-patch validation considers each animal's own stored species/dates. No persistence on rejected ordinary batches. | R1–R4, R6 |
| AC10 | Given legacy contradictions, reads remain successful; name/herd or another unrelated edit remains possible; identical invalid values resubmitted by merge remain allowed; fixing one rule may leave another unchanged invalid rule. A changed tuple that remains invalid is rejected. | R5 |
| AC11 | Given an import merge targeting a legacy animal, validate effective stored type and actual writes, preserve omitted/unchanged values and existing skip semantics. A skipped merge gets no parent update. A resolved invalid imported parent rejects/skips its animal row with a clear reason. | R2, R4, R5 |
| AC12 | Given parent and offspring modified/created together, validate final intended state independent of row order. Preserve the currently ignored unresolved import parent-tag behavior when no relation is written. | R2, R4 |
| AC13 | No change to `registered`/ear-tag semantics, read schemas, farm selection, feature authorization, or API response shapes. Error messages use existing language selection. | R4, R5, exclusions |

## Use cases

- Create an animal: authorized caller supplies data; all applicable rules pass before persistence; otherwise receive actionable validation feedback.
- Edit/bulk edit: load actual selected-farm records, compute actual changes, preserve unchanged legacy invalid rules, validate changed rules and effective references, retain atomic batch failure.
- Import: existing preview/parsing and matching behavior continues; authoritative legacy import/commit validates actual create/merge/parent writes, keeps row identifiers and skip reasons, and does not mutate skipped rows.

## Technical handoff boundaries (Architect owns design)

| Task | Proposed responsibility | Outcome / AC |
| --- | --- | --- |
| T1 | Backend + Architect | Shared domain validation policy and fine-grained legacy comparison; effective dates/parent lookups remain farm scoped. AC1–8, AC10 |
| T2 | Backend | Wire all three update functions and create without changing their contracts; final intended batch state. AC9, AC12–13 |
| T3 | Backend | Wire both import implementations, merge and delayed parent phase; preserve skips and stored target type. AC9–12 |
| T4 | Backend | Clear localized errors and source row/animal context within existing envelopes. AC1–9, AC11, AC13 |
| T5 | QA + implementer | Isolated unit coverage for pure rules and mocked service paths, review implementation against every AC. R6, AC1–13 |

## Verified code evidence

- `src/animals/animals.endpoint.ts:17–18`: `permissionFarmEndpoint("animals", "read"/"write")`; schema exposes species as `type`.
- `src/animals/animals.endpoint.ts:130–147`: separate input schema / partial patch; output schema at line 21 must remain permissive for legacy reads.
- `src/animals/animals.endpoint.ts:189–251`: create, single patch, per-animal array patch, common-patch batch.
- `src/animals/animals.endpoint.ts:357–441`: legacy Excel import, non-persisting preview, commit payload/skip response.
- `src/animals/animals.ts:519`, `:670`, `:701`, `:737`: direct create/update mutations currently lack these domain checks.
- `src/animals/animals.ts:280`: `todayUtcDay`; `:1189`: legacy import; `:1565` onward: commit create/merge then parent assignment. Merge does not set `type`; death fields currently overwrite only with a truthy imported death date.
- `src/db/schema.ts:984`, `:1362–1410`: species, usage and date storage; parent foreign keys and farm RLS. No schema changes proposed.
- `docs/permissions.md`: animals feature needs no membership. Per-request farm-resolution implementation remains authoritative.

## Readiness, approvals and evidence

Status: **READY_FOR_OWNER_REVIEW** after Architect development and independent QA review; not final acceptance. Functional baseline and compatibility interpretations reviewed bidirectionally with root Architect. QA independently reviewed testability and highlighted both bulk paths, row-order behavior, unchanged merge values, skipped parent pass and date boundaries; incorporated above.

Sid approved **A: isolated unit tests**, including a minimal separate infrastructure-free runner if needed. No Docker/integration tests, migrations, CI changes, external writes or branch operations are approved. Test code/execution belongs to the implementation handoff; none was written or executed during refinement. Do not invoke repository-default Jest globalSetup because it starts Docker/database/auth/server infrastructure.

Architect design and isolated test arrangement are finalized below. No material business question remains under the bounded interpretations above. Product priority is not assigned; Sid requested this task next.

Refinement evidence: static inspection **PASS** for artifact/source traceability and known entry points. Refinement itself wrote or ran no tests; implementation evidence follows below. This document is local only. Sid retains final acceptance.

## Architect development design

- `animal-validation.ts` owns pure consistency rules and independent old/new operands for every rule, including each parent subrule. The assertion adapter uses existing HTTP 400 errors and localized resources. Read/output schemas remain permissive.
- Ordinary mutations load existing animals and referenced parents inside the selected-farm RLS transaction, overlay the entire intended batch, and validate before writes. No reverse-child lookup is added.
- Import commit plans stable animal IDs, effective stored merge species and actual parent assignments before writing accepted rows. Rejected rows must be excluded from animal/tag/parent writes. Parent failures caused by another rejected import row require rebuilding the projection before deciding dependent rows. Repeated merge targets must validate each actual cumulative row state, rather than using only the final duplicate target state.
- Legacy one-step import currently writes birth/usage but ignores optional death/parent columns; validation covers its actual writes without introducing new column semantics. Preview remains a non-persisting parser; authoritative consistency validation occurs at commit because preview lacks species/merge choices.
- `jest.unit.config.cjs` is separate from the package-level Jest configuration and has no infrastructure setup/teardown. The approved runner uses the installed/cached Yarn through Corepack with network disabled because the shell has no direct `yarn` executable.

## Initial development verification and handoff

| Evidence | Status | Scope |
| --- | --- | --- |
| Implementation artifact | Created | Shared validator, all actual mutation/import write paths, four locale resources, independent unit runner and two unit files |
| Domain units | PASS | 24 cases: valid/invalid rules, per-rule grandfathering, effective parent state, winter/summer Zurich boundaries, localized HTTP 400 messages |
| Service units | PASS | 20 cases: create/single/both bulk updates, import/merge, no rejected writes, final parent state, rejected-parent dependency reconsideration, duplicate merge targets and legacy import |
| Combined approved unit run | PASS | Backend implementer observed 2 suites / 44 tests, exit 0; Jest 12.869 seconds |
| Independent QA | Reviewed, approve for owner review | Final static review found no remaining actionable issue; verified closure of false dependent-row rejection and reviewed duplicate-target regressions |
| Integration / real database | NOT_EXECUTED / NOT_VERIFIED | No Docker, PostgreSQL rollback/RLS/concurrency or real HTTP serialization evidence |
| Other checks | NOT_EXECUTED | No standalone typecheck, build, lint/format, migrations or CI |
| Owner acceptance | Pending | Sid retains final acceptance |

Exact approved combined command: `COREPACK_ENABLE_NETWORK=0 corepack yarn jest --config jest.unit.config.cjs --runInBand`.

Changed task artifacts: `src/animals/animal-validation.ts`, `src/animals/animals.ts`, `src/animals/animal-validation.unit.test.ts`, `src/animals/animals-service.unit.test.ts`, `jest.unit.config.cjs`, `resources/locales/{de,en,it,fr}.json`, and this task document. Existing unrelated workspace changes remain untouched. No external writes or branch operations were performed.

The importer preserves its existing multi-phase persistence contract; unit mocks establish validation and planned-write decisions, not transactionality or concurrent-request guarantees. Preview and legacy ignored optional columns preserve their existing semantics. No historical data cleanup is included.

## Follow-on: consolidate established legacy validation

Source: Sid's follow-on request in this chat to check further inconsistencies and move well-defined existing validation into the validator. Local reference: `ANIMAL-VALIDATION-CONSOLIDATION`. This is extraction/consolidation within the existing animal-validation scope, not authorization to invent further animal rules. The root Architect reviewed the following scope directly with PO; QA independently supplied static evidence and testability concerns. Source references below describe the pre-consolidation snapshot on 2026-11-08 and may move during implementation.

### Inventory and bounded decisions

| Existing rule / behavior | Verified source | Consolidation decision |
| --- | --- | --- |
| Import requires a resolved name: trimmed name, otherwise trimmed ear-tag number; reject only when both absent. | `animals.ts:1297–1307`, preview `:1535–1536`; ordinary API `animals.endpoint.ts:131` is only `z.string()`. | Shared pure **import-mode** prerequisite helper. Preserve normalization/fallback at import boundary. Do not newly prohibit ordinary API empty names or grandfather name via animal-consistency operands. |
| Import requires sex and recognizes only values mapped by `SEX_MAP`. Missing sex and unrecognized sex receive distinct reasons. | `animals.ts:1309–1328`, preview `:1538–1544`, mapping `:21–36`. | Import parser retains raw text normalization/mapping; pure helper receives normalized sex plus enough missing/unknown context to preserve distinct issues. Reuse in both import flows; do not copy locale maps or database work into the consistency validator. |
| Import requires a parsed birth date; malformed strings already produce a DOB error. | `animals.ts:1339–1373`, preview `:1549–1565`; date parsing `:140–150`. | Shared normalized import prerequisite for missing/unusable DOB, including finite `Date` guard after parsing. Preserve accepted formats, Excel serial conversion and first-error vs preview-accumulation behavior. Do not reparse spreadsheet cells inside the helper. |
| An existing assigned ear tag conflicts with legacy import creation; commit permits assignment to the same merge target. | `animals.ts:1383–1404`, commit `:1643–1651`. | Optional shared pure contextual assignment helper taking resolved current owner and merge target. Preserve call-site guards, including commit's `earTagNumber && !earTagId` branch; keep DB lookup and assignment writes in service. Do not introduce stricter explicit-ID checks as an extraction side effect. |
| Legacy first-error reasons are English literals, while preview already uses translated `animal_import.error_*` keys. | Legacy `animals.ts:1304`, `:1314`, `:1324`, `:1349`, `:1364`, `:1374`, `:1395`; preview `:1536–1565`. | Pure helpers return established localization keys. Preserve legacy first-error English literals at its formatter; preview translates and accumulates those keys. Preserve response envelopes, skipped-row identifiers and all four supported locales. |

### Concrete inconsistencies deferred from automatic policy changes

- **Optional death date parse failures:** preview silently converts an invalid optional death string to null (`animals.ts:1568–1579`), whereas invalid DOB yields a parse error. Tightening this changes parsing acceptance; keep current behavior unless Sid chooses rejection.
- **Reason-only merge payload:** commit schema permits `deathReason` independently (`animals.endpoint.ts:423`), but effective projection and merge writes only apply death fields when imported death date is truthy (`animals.ts:1669–1673`, `:1778–1781`). Existing integration tests `animals.integration.test.ts:1940–1986` cover truthy date plus default reason, not reason-only/null semantics. No invalid reason is written when ignored. Preserve current merge behavior; owner can later choose to reject ignored input, apply reason against a retained death date, or retain ignoring. Do not change merge overwrite/null semantics during extraction.
- **Calendar overflow parsing:** `parseDateString` checks JavaScript date validity but does not verify round-tripped calendar components (`animals.ts:140–150`), so impossible calendar dates can normalize. Strict calendar/format policy needs a separate parsing decision; do not silently narrow accepted formats.
- **API/import name differences:** import requires a resolved name; API permits empty string. Preserve route-specific existing semantics rather than turning an import prerequisite into a new global business rule.

### Explicit exclusions

File readability and XLSX normalization (`import-workbook.ts:73–87`), required headers/columns (`animals.ts:121–137`), raw cell parsing/mapping/default usage, import matching and unresolved parent tags remain boundary/orchestration responsibilities. Authorization, selected-farm RLS and DB existence lookups remain service/endpoint responsibilities. Herd chronology (`animals.ts:369`), meadow access/archive (`:245–258`), outdoor-schedule overlap (`:866`, `:935`, `:1053`, `:1119`) and category overlap (`:1182`) belong to their existing separate domains. Animal category calculation is classification, not a new animal validation rule. Registered/ear-tag requiredness remains out of scope.

### Follow-on acceptance criteria and Architect handoff

| AC | Observable outcome |
| --- | --- |
| C1 | Both import flows use the same named pure helper(s) for normalized prerequisites; no duplicated logical required-name/sex/DOB decisions remain in those flows. Spreadsheet parsing, normalization and missing/unknown context remain outside the helper. |
| C2 | Missing name still falls back to ear tag, and absent fallback still fails; missing/unknown sex stay distinguishable; missing/invalid parsed DOB fails clearly. Legacy importer still stops at its first row issue; preview still accumulates issues. Valid rows preserve all existing defaults. |
| C3 | Assigned-tag decisions preserve creation conflict and same-target merge allowance, route-specific invocation guards, skipped responses and selected-farm resolution. No new ear-tag requirements or global API name constraints. |
| C4 | Existing rule-specific grandfathering and import merge semantics remain unchanged. A valid unrelated update/identical legacy merge is not newly blocked by extracted import prerequisites. Existing normalized API schema checks remain in place. |
| C5 | Extracted issues use established localization keys; legacy retains its first English literal and preview retains localized accumulation within existing transport envelopes. Shared helpers perform no database access, state mutation, spreadsheet parsing or HTTP orchestration. |
| C6 | Approved isolated units cover positive/negative helper decisions and both call sites, finite DOB handling, missing vs unknown sex, ear-tag same-target merge where extracted, response behavior and legacy compatibility. No Docker/integration run. |

Proposed technical sequence (Architect owns final design): extract explicit import-prerequisite and optional contextual tag helpers in the shared validation module; wire legacy import/preview/commit without transport or policy changes; add focused isolated regressions; independent QA review against C1–C6.

Follow-on status: **READY_FOR_OWNER_REVIEW** after extraction-only development and independent QA review. Sid's existing A isolated-unit approval applies to this animal-validation consolidation; no integration, migration, branch or external-write approval. The three parsing/merge policy questions above are deferred and do not block this bounded extraction. PO refinement performed static inspection and documentation only; no tests were written/run by PO. Implementation evidence follows.


### Consolidation implementation and evidence

- Shared pure `validateImportAnimalPrerequisites` now owns the ordered resolved-name, missing/unknown mapped sex and usable finite parsed DOB decisions. Legacy import and preview reuse it, retaining parsing, accepted formats, locale maps, default usage and name/ear-tag fallback at their boundary.
- Shared pure `hasAssignedEarTagConflict` now owns the already-resolved owner-vs-merge-target decision. Legacy and commit retain their existing lookup/control flow, including the explicit `earTagId` bypass branch.
- Legacy still reports its first issue using the original English literal and source row; preview still accumulates translated errors. Unusable parsed DOB is reported as invalid and returned as null in preview so its error result remains serializable. Ordinary API empty-name behavior and all earlier per-rule legacy exceptions remain unchanged.
- Test-first evidence: Backend observed 31 service cases before wiring, 29 passing compatibility checks and two expected failing unusable-DOB cases. After wiring, the final combined command below passed 2 suites / **67 tests** (36 domain, 31 mocked service), exit 0; Jest 19.626 seconds. Domain units were also observed passing independently by Architect. Source tests cover C1–C6, including preserved errors, row metadata, fallback/defaults, tag conflict guards and existing API behavior.
- Independent QA statically reviewed final helpers/call sites and C1–C6 and approved for owner review, with no remaining actionable finding. QA did not execute tests. Unit results are from the implementing agents' observed command output.

Exact approved command remains: `COREPACK_ENABLE_NETWORK=0 corepack yarn jest --config jest.unit.config.cjs --runInBand`.

Consolidation changed only `src/animals/animal-validation.ts`, `src/animals/animals.ts`, their two unit files, and this task document. No locale/schema/endpoint/runner changes were needed for this follow-on. No Docker, integration, standalone typecheck, build, lint/format, migrations, branch operations, CI or external writes were executed. Real HTTP, database RLS/rollback and concurrency remain **NOT_VERIFIED**; owner acceptance remains pending.

Deferred inconsistencies remain: optional death-date parse rejection, calendar-overflow parsing policy, API/import name semantics, and reason-only/null merge overwrite semantics. The reason-only merge behavior is unchanged pending Sid's explicit decision; this consolidation does not silently select a new policy.

## New owner clarification: death reason, unknown value and warnings

Source: Sid subsequently stated: "if a death reason is given, dateof death should also be given. if a dateofdeath is given but no reason, this should at least give a warning ... date of death with no reason should translate to unknown reason."

This clarification supersedes the earlier assumption that missing imported reason may default to `died`, and reopens the deferred reason-only merge policy. It is a new behavior/contract refinement, separate from the completed extraction. No implementation is authorized by this document beyond Sid's actual decisions, and no migration is executed or generated by agents.

### Confirmed intent and verified impact

- A non-null supplied reason requires a death date. Sid approved effective-state validation: a retained stored death date suffices for a patch or merge. Unchanged invalid rule operands remain grandfathered; changed/new invalid reasons are rejected.
- An accepted death date with unspecified reason must represent **unknown**, rather than inventing the known reason `died`. The desired non-blocking caller-visible warning is documented for future work only. No warning transport is implemented now, and an accepted row is not reported as an import skip/error.
- **Pre-change evidence:** `src/db/schema.ts:986` defined only `died` and `slaughtered`; the implementation now adds `unknown` to the declaration (manual database migration still pending). The column is nullable (`:1383`) and input/output schemas already allow null in ordinary create/single update/import (`animals.endpoint.ts:37`, `:141`, `:390`, `:423`). Common-patch batch allows omission but not explicit null (`:241`).
- **Pre-change evidence:** `parseImportPreview` inferred `died` from any date (`animals.ts:1568`). Commit projection/create/merge also default `row.deathReason ?? "died"` when death date is truthy (`:1629`, `:1718`, `:1738`). The implementation now replaces those defaults consistently with `unknown`, retaining an effective known reason on date-only edits. Existing integration expectations (`animals.integration.test.ts:1940–1986`) explicitly assert the old inferred value and need updated specifications, not blind preservation.
- Shared current consistency validation checks effective stored date/reason (`animal-validation.ts:100–102`); payload-presence semantics are not represented by that check. Before this policy change, a reason-only merge was ignored by the truthy-date overlay; the implementation now applies the actual reason patch against the stored date. Under the new clarification a date-less invalid supplied reason must receive validation feedback instead of being silently ignored.
- The shared success handler emits `{ data: output }` with no warning channel (`src/sentry.ts:15–18`, `:46`). Current animal mutation/import output schemas have no warning field. Logging a warning would not provide the caller feedback requested by Sid.
- Legacy one-step Excel import currently ignores optional death columns; preview/commit consumes them. Do not silently make legacy import start writing previously ignored death data. The new rule applies to every actual death-date/reason write; extending legacy column support is a separate scope decision.

### Owner decisions and remaining clarification

| Decision | Options / consequence |
| --- | --- |
| Unknown representation — confirmed | Sid selected explicit enum value **`unknown`**. Extend the schema/API enum proposal; Sid owns manual DB migration and deployment sequencing. Do not reuse null or `died` as the new unknown value, and do not backfill historical data automatically. |
| Reason-only updates — confirmed | Sid approved **effective date**: accept a changed/new reason when the retained stored date exists, reject it when no effective date exists. Apply consistently to single/bulk patch and commit merge; unchanged invalid legacy tuples remain grandfathered. |
| Warning response — confirmed deferred | Sid requested **documentation only** for the warning requirement. Do not add response fields, change output envelopes or implement a warning transport. Record the requirement for a future owner-approved client contract. |

Deferred design note only: an optional warnings collection with stable code, localized message and animal/row context was considered. No exact warning field/schema/location is approved. Keep persisted columns other than the explicit enum proposal, success/error envelopes, read schemas and global result handler unchanged; do not implement this earlier interface proposal.

Approved effective-state example: the animal already stores `{ "dateOfDeath": "2026-10-20", "deathReason": "unknown" }`. The caller later learns more and sends `PATCH { "deathReason": "died" }`. Under the recommended effective-date rule this succeeds because the record already has a death date. Under the same-payload rule it fails until the caller sends both `{ "dateOfDeath": "2026-10-20", "deathReason": "died" }`. Either option rejects a reason for an animal with no death date; neither invents a date. Sid approved the recommended effective-date behavior after reviewing this example.

Confirmed effective-state interpretation: when a date-only edit retains an existing known reason, keep that known reason rather than resetting it to unknown; warn only if the effective accepted reason is unknown. An unrelated edit of an unchanged legacy date/unknown reason should not trigger required correction or backfill. No automatic conversion of historical `died` data is justified: original explicit reasons cannot be distinguished from inferred import defaults.

### Confirmed acceptance criteria for development handoff

| AC | Expected behavior |
| --- | --- |
| D1 | Non-null supplied reason without the required date (effective or same-payload, as selected) yields a clear validation error/row skip before mutation; reason-only merge is no longer silently ignored when invalid. |
| D2 | After Sid's enum migration/deployment prerequisites, a valid newly supplied death date with missing/null reason stores explicit `unknown`, never defaults to `died`, and remains a successful mutation. Explicit valid reasons remain unchanged; known retained reasons are not reset by date-only edits. |
| D3 | Preview and authoritative import commit agree on explicit unknown reason; accepted date-with-unknown-reason rows remain successful, not `parseErrors`/`skipped`. Warning requirement is documented only; no warning transport is introduced. No new legacy-import column writes without separate approval. |
| D4 | Create, single update, both bulk paths and import create/merge apply the selected presence/effective-state rule consistently. Existing per-rule grandfathering protects unrelated edits and unchanged legacy records. |
| D5 | Document the future caller-visible, non-blocking warning requirement without changing current API warning fields, output envelopes or result handler. No new warning response is claimed implemented. |
| D6 | Approved isolated units cover valid known reason, missing required date, explicit unknown, preview/commit agreement, ordinary/bulk/merge payload distinctions, no invalid writes and unchanged legacy behavior. Verify no warning response contract expansion. No migration/integration execution. |

### Swiss reporting assessment and semantic boundaries

Sid requested a Swiss-law check. Root Architect retrieved the official IdTVD-V version effective 1 January 2026 and assessed [Article 17 / Annex 1](https://www.fedlex.admin.ch/eli/cc/2021/751/de), particularly cattle section 1(f) and sheep/goats section 2(f). Those death-event reports list identification, death date and reporting data rather than an underlying death-cause field; slaughter is a separate reporting event (for example sheep/goats section 2(e)). This supports the limited inference that an internal `unknown` reason value is not itself inconsistent with those listed death-report fields. It does **not** certify overall TVD compliance or replace required reporting/event categorization.

The existing enum `died`/`slaughtered` distinguishes event categories rather than providing a medical cause taxonomy. Therefore an internal `unknown` must not imply that the animal's death itself is unconfirmed, invent a death date, select a TVD slaughter/death event automatically or mark a missing animal dead. The [Glarus 2026 government report](https://www.landsgemeinde.gl.ch/assembly/2026-05-03/ticker) was assessed by Architect as context that losses/missing animals cannot automatically establish wolf causation or presumed death. This is contextual evidence, not a statutory rule permitting automated death entry.

Separately, the [BLV guidance on animal-disease control](https://www.blv.admin.ch/de/bekaempfung-von-tierseuchen) states that suspected animal disease must be reported promptly to a veterinarian. An internal unknown value does not replace that obligation. No disease-reporting workflow, statutory submission or automatic missing-to-dead transition is included in this task.

Status: **READY_FOR_OWNER_REVIEW** after Sid approved the effective-date recommendation, implementation, isolated unit verification and independent static QA. Explicit `unknown`, retained known reasons and documentation-only warnings are confirmed. Schema migration/deployment remains Sid-controlled. PO refinement performed static inspection and documentation only; implementation/test evidence is recorded separately below.


### Death-policy technical decisions and deployment prerequisite

- The pure shared death-field resolver returns only actual defined lifecycle patch fields. A non-null death-date write with no effective reason becomes explicit `unknown`; a date-only edit retains any existing known reason. Explicit `deathReason: null` with an effective death date also becomes `unknown`, including an identical lifecycle resubmission. Unrelated fields never trigger normalization/backfill.
- Supplied reason-only updates use the effective stored date and are now applied by import merge. A newly introduced/changed reason without an effective date fails validation. Identical pre-existing invalid reason/date operands retain the established legacy exception. No date is invented and no missing animal is marked dead.
- Existing ordinary patch null clearing remains available under its schemas. Import merge retains its existing null/omitted date non-clearing semantics; only actual reason writes and the approved unknown default change. Legacy one-step import still ignores its optional death columns.
- `src/db/schema.ts` declares the new PostgreSQL enum label and derives `deathReasonSchema` from it, so source animal input/output schemas accept `unknown`. This is a declaration proposal, **not an applied database migration**. Sid must manually add `unknown` to the database `death_reason` enum before deploying application writes that can emit it. No historical backfill is included.
- Enum expansion can affect clients with exhaustive two-value handling. Coordinate client support and source/generated contract publication with deployment. Generated `openapi.json` was not regenerated, and no generation script was run under this task. No warning field or global success/error envelope change is included.
- Caller-visible warnings for accepted unknown reasons remain a documented future requirement only, not an implemented feature. Unknown identifies the internal unknown death category/cause; it does not select a TVD event or establish death without a date.

### Death-policy unit verification before integration rollout preparation

| Evidence | Status | Scope |
| --- | --- | --- |
| Schema and implementation artifacts | Created | Explicit `unknown` enum declaration, pure lifecycle resolver, actual ordinary/import lifecycle writes and preview defaults |
| Domain units | PASS | 46 cases including source enum acceptance, unknown normalization, retained known reasons, explicit null, undefined/unrelated edits and date clearing |
| Service units | PASS | 48 cases including create, single/both bulk updates, reason-only merge with/without stored date, mixed-target batch atomic prevalidation, null/date opt-in, invalid legacy grandfathering and repeated-target import lifecycle |
| Combined isolated units | PASS | Backend observed 2 suites / **94 tests**, exit 0; Jest 35.933 seconds |
| Independent QA | Reviewed, approve for owner review | Final scoped static review found no actionable findings; no tests run by QA |
| Existing integration expectations | Updated, NOT_EXECUTED | Only two inferred-default import create/merge titles/assertions changed from `died` to `unknown`; explicit known-reason fixtures retained |
| Database migration / real DB behavior | NOT_EXECUTED / NOT_VERIFIED | Enum declaration alone does not change PostgreSQL; Sid's manual migration is a deployment prerequisite |
| Other executable checks | NOT_EXECUTED | No Docker, integration, standalone typecheck, build, lint/format, CI or generated OpenAPI script |
| Owner acceptance / rollout | Pending | Coordinate enum migration and client support before deployment |

Exact approved command: `COREPACK_ENABLE_NETWORK=0 corepack yarn jest --config jest.unit.config.cjs --runInBand`.

The Backend observed nine intended policy failures among 42 service cases before wiring, then the complete green run after implementation and additional boundary tests. Unit mocks verify validation and persistence intent; they do not establish real HTTP serialization, RLS, rollback or concurrent database behavior.

This death-policy increment changes `src/db/schema.ts`, `src/animals/animal-validation.ts`, `src/animals/animals.ts`, their two isolated unit files, two existing expectations in `src/test/animals.integration.test.ts`, and this document. No warning transport, endpoint response fields, historical data backfill, migration file, generated contract, external write or branch operation is included.


## Authorized CORE integration and deployment preparation

Sid selected **A — CORE integration**, then explicitly authorized preparation and execution of the needed migration and necessary release preparation. This supersedes the earlier no-migration/no-generation scope for these specific artifacts. Execution stayed within a fresh disposable integration database; no development, hosted or production database and no actual application deployment was targeted.

### Added release artifacts

- `drizzle/migrations/20261108000000_animal_death_reason_unknown/migration.sql`: additive `ALTER TYPE public.death_reason ADD VALUE IF NOT EXISTS 'unknown'`, with no data backfill or use of the new label inside its migration transaction.
- Linked v8 `snapshot.json`: new ID/previous snapshot chain, identical prior schema except the enum label.
- Regenerated `openapi.json` through the existing code-first script. Twenty-five death-reason enum locations now include `unknown`. The initial generation also refreshed harvest filters from the original workspace's separate feature branch; those unrelated changes were excluded when transferring this work to the updated development base. No warning response field/envelope was added.
- `docs/animal-validation-deployment.md`: DB-before-application ordering, clients/rollback compatibility, no backfill, explicit migration requirement because startup does not run it, and scoped test resource lifecycle.
- `src/test/animal-validation.integration.test.ts`: six focused CORE scenarios using real HTTP/GoTrue/PostgreSQL and real XLSX data, without mocks or a test-only enum bootstrap.

### Observed runtime evidence

| Evidence | Status | Scope / provenance |
| --- | --- | --- |
| Real full migration chain | PASS | Existing global setup applied all migrations, including the new enum migration, only to each fresh run-owned test DB |
| New enum installed | PASS | Architect read-only SQL query in the successful run DB returned `died`, `slaughtered`, `unknown`; HTTP create/read also persisted/serialized `unknown` |
| First CORE attempt | FAIL, diagnosed | Five tests passed; per-animal-array request hit HTTP 405 because its existing export has no registered route, not because validator rejected valid data |
| Corrected selected CORE run | PASS | One selected suite, six grouped tests; exit 0; Jest 23.15 seconds / Yarn 61.71 seconds including setup/teardown |
| Actual covered boundaries | Observed for scoped cases | HTTP clear errors/no rejected writes, farm-isolated parent lookups, common bulk validation rejection/per-target lifecycle values, unknown persistence/serialization, legacy reads/patch/merge and real XLSX flow |
| Per-animal-array service integration | PASS, service transport only | Real decoded test GoTrue JWT subject and selected-farm production RLS context; no mocked DB or admin write under test |
| Independent QA | Reviewed, approve for owner review | Reviewed migration/snapshot/spec, CORE scenarios and corrected real-RLS service wiring; no tests executed by QA |
| Scoped cleanup | PASS | Normal teardown completed; successful project's containers/network/labelled volumes absent in post-run filters; first attempt's containers also absent |
| Deployment / production DB | NOT_EXECUTED / NOT_VERIFIED | No deployment automation, CI, branch operation, hosted write or existing-environment migration was performed |

Successful selected command (output captured locally for bounded diagnostics):

```sh
NODE_ENV=test SENTRY_DSN= BREVO_API_KEY= BREVO_LIST_ID= STRIPE_SECRET_KEY= COREPACK_ENABLE_NETWORK=0 corepack yarn test --runTestsByPath src/test/animal-validation.integration.test.ts
```

Generation command used `NODE_ENV=test`, disabled Sentry, dummy loopback-only database/Supabase settings and cached Corepack Yarn, then the existing `generate:api-types` script. It completed with exit 0 and did not start the server or execute database queries. The normal compile script was not used because it uploads Sentry maps.

The successful run owned project `testcontainers-f83e2e7d2a18`; the first run owned `testcontainers-499145aa425a`. No unrelated or persistent resources were removed, no prune/reset/push or migration-generation command was run, and external mail/payment credentials were disabled for the selected run. The usual test harness applied the actual migration chain; no separate enum bootstrap concealed migration problems.

### Limits and remaining release actions

- The per-animal `updateAnimalsEndpoint` export is not registered in `routing.ts`; `PATCH /v1/animals` is not a supported route. Tests were corrected to exercise that service with real RLS while common bulk remains HTTP. Whether to expose that export is a separate owner follow-up; no public route was added in this task.
- Bulk evidence proves validation rejection leaves rows unchanged. It does not claim rollback after an induced database error midway through writes, arbitrary concurrency safety or full API-suite coverage.
- The real target deployment still needs the existing migration mechanism to apply this migration before new application writes. Startup runs the server/jobs, not migrations; no repository release-migration automation was added. Coordinate exhaustive clients and rollback-compatible readers for the added enum.
- Warnings remain documentation-only. Optional death-date parsing, calendar overflow and global API/import name policy remain deferred. The earlier reason-only merge question is resolved by the implemented effective-state rule.

Final status: **READY_FOR_OWNER_REVIEW** with the selected integration scope passing and release artifacts prepared. No further broad test/CI run or actual deployment is claimed.


## Feature-branch transfer verification

The animal work was selectively stashed and transferred onto the updated Noise85 development branch (`develoment`, merge commit `30646b0`), whose tree matches `main` at `88f5791`. The separate harvest feature commit and unrelated workspace changes are excluded. The stash applied without conflicts. Exactly 17 task files were staged; the OpenAPI delta is limited to 25 death-reason enum expansions.

After transfer, `COREPACK_ENABLE_NETWORK=0 corepack yarn jest --config jest.unit.config.cjs --runInBand` passed 2 suites / 94 tests (exit 0). Staged whitespace checks passed and no unmerged entries remain. The six-scenario integration result above was obtained before transfer; it was not rerun for this branch operation. The original stash is retained as a recovery copy.
