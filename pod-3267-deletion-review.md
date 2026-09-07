# Transitional instrument deletion

Base: `55d896328`. Work stays on this issue branch; the coordinator lands it on the epic integration branch.

## Deletion census

- Removed `packages/runtime/src/sqlite/transaction.ts`, its public export, and `SqlTransactionScope`.
- Removed the unused synchronous Drizzle type, builder, wrapper and factory from `sync-drizzle.ts`. The active asynchronous store and transaction ports remain.
- Removed the flip codemod, its keep-sync derivation/data, its fixed-point checker, both test files and both package commands.
- The executor legacy field was already deleted by `9f0d5c33e`; removed its residual comments and obsolete harness type exclusion.
- The freeze lock `freeze:pod-3221-flip` is free. This change neither acquires nor releases another session's lease.
- Production DECISION markers: zero. The coordinator resolved POD-3528 and authorized replacing its marker with the rule 57 reference; behavior is unchanged.
- Low-level `SqlDatabase`, `SqlStatement` and related driver types are still used by the Bun driver, migrations and fixtures, so they are retained.

## Assertion accounting

The coordinator confirmed this rule 50 split in mail `msg_6caf1a05-f170-4833-b8a4-f74c46db7795`.

| Assertions | Disposition |
|---|---|
| 37 expect calls in 21 codemod/idempotence tests | Removed with the codemod and its metadata |
| 7 expect calls in 2 synchronous-helper tests | Removed: thenable rejection and manual-COMMIT misuse belong to the retired contract |
| 4 expect calls in 2 transaction caller tests | Transferred verbatim to `apps/server/src/store/executor/executor.test.ts`; only setup and awaits changed |

The transferred checks preserve the callback return, committed rows, original error and rolled-back rows. Existing assertions elsewhere were not edited.

## Validation

`PODIUM_TEST_WORKERS=1` throughout. Commands run sequentially; no full suite or browser lane.

- `bun run typecheck -- --filter=@podium/runtime --filter=@podium/server`: green, 12/12 tasks.
- `bun run lint:boundaries`: exit 1, byte-identical output on candidate and clean base. 81 entries / 80 distinct diagnostic lines; zero added, zero removed. Existing baseline issue: POD-3314.
- `bun run test`: typecheck stopped the lean gate at four mobile errors; 25/26 tasks succeeded. The four cheap boot/configuration test files did not run, so this is not a lean gate green.

