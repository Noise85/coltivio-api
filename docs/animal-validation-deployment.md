# Animal validation deployment notes

Scope: animal consistency validation, shared import prerequisites and explicit `unknown` death reason. Sid authorized preparation of the migration/contract and application of the migration through the newly created disposable integration database. No development, hosted or production database was targeted, and no application deployment is performed by this task.

## Release artifacts and ordering

1. Coordinate clients that exhaustively handle `deathReason`. The accepted/emitted enum is now `died | slaughtered | unknown`; existing explicit known reasons remain valid. Publish the regenerated OpenAPI contract with the release. No warning field or response envelope is added.
2. Apply `drizzle/migrations/20261108000000_animal_death_reason_unknown/migration.sql` through the existing deployment migration mechanism **before application writes using `unknown` are enabled**. It adds the enum label idempotently without changing existing animal rows. The linked v8 snapshot follows the repository's timestamp-folder convention. The installed migrator discovers the folder automatically; no migration generation or test-only enum bootstrap is required.
3. Deploy the application only after the migration has committed. The migration itself does not insert/update animals or consume the new enum label in its transaction. No historical `died`/null values are backfilled.
4. Verify the intended release environment can create/read an `unknown` reason and accepts reason-only updates against a retained death date. Do not infer actual production success from isolated test results.

The repository's `src/index.ts` starts the API and background jobs; it **does not run migrations**. No application release/deployment migration job was found in the repository. The existing `db:migrate` script is the migration entry point, so the deployment operator must supply the intended target and sequencing explicitly. This task never invokes that command against an existing environment. `yarn compile` also uploads Sentry source maps; it was not used as a side-effect-free verification command.

## Compatibility and rollback

- Date-only edits retain an effective known reason. Missing/null effective reasons become `unknown` only when lifecycle fields are explicitly written; unrelated legacy edits do not trigger backfill.
- A newly supplied/changed reason needs an effective death date, including a stored date for partial updates and import merges. Unchanged invalid legacy rule operands retain their compatibility exception.
- Legacy one-step import still ignores optional death columns. Preview/commit agrees on `unknown` for imported death dates. Warnings for accepted unknown reasons remain documentation-only future work.
- The enum addition is additive and can remain after a code rollback. PostgreSQL enum-label removal is not a simple inverse operation; do not drop/recreate it or rewrite historical data automatically. Older code/clients that reject `unknown` cannot safely read newly written values, so rollback must retain compatible readers.
- The initial contract regeneration also refreshed harvest filters from the original workspace's separate feature branch. Those unrelated changes were excluded when transferring this work to the updated development base; this feature's OpenAPI change only adds `unknown` to death-reason enums.

## Approved integration verification scope

Only `src/test/animal-validation.integration.test.ts` is selected. Its six grouped scenarios cover HTTP business errors/no writes, parent rules and farm isolation, both bulk services, lifecycle persistence/serialization, grandfathered legacy records, and real XLSX preview/commit behavior. The registered common-patch bulk endpoint is exercised over HTTP; the per-animal-array service is exercised directly with a real selected-farm authenticated RLS context and PostgreSQL.

The first run exposed an existing routing gap: `updateAnimalsEndpoint` is exported in `animals.endpoint.ts` but is not registered in `routing.ts`; `PATCH /v1/animals` returns HTTP 405. This task does not create a new route or change the public API to accommodate a test. Whether that export should become a supported HTTP endpoint is a separate owner decision. Direct service integration covers its database behavior, not a nonexistent HTTP transport.

The existing Jest global setup starts a unique Testcontainers Compose project using `docker-compose.test.yml`: disposable Supabase PostgreSQL and GoTrue on dynamic ports, then the existing migration chain, auth proxy and API server. It does not invoke `src/index.ts` or its background crons. The test Compose file has no named persistent database volume; its SQL/config bind mounts and persistent `docker-compose.yaml` resources are not removed. Existing test helpers truncate only the newly created test database between scenarios.

The harness uses fixed `/tmp/coltivio-test-env.json`, so run it without concurrent integration sessions. Normal teardown closes DB/server/proxy and removes only this run's unique Compose project and temporary volumes. If startup fails before teardown state is registered, identify resources by the new run's project labels before any narrowly scoped cleanup; never prune or remove unrelated resources.

Use `NODE_ENV=test` with Sentry/Brevo/Stripe credentials disabled for this focused animal run. Only local GoTrue/PostgreSQL and the API are exercised; no hosted service write is part of the tests.

Execution evidence: the corrected selected run passed **six CORE integration tests**, exit 0. The existing full migration chain ran in its new disposable database; a read-only enum query returned `died`, `slaughtered`, `unknown`, and real HTTP writes/read responses exercised `unknown`. Normal teardown completed; the run-owned project's containers/network/labelled volumes were absent afterward. Exact command and first-run route-fixture correction are recorded in `docs/animal-validation-task.md`.

This proves the migration in the isolated test context, not any deployed environment. No CI/deployment automation was changed. The intended deployment operator still must apply the release migration before starting the new application version.
