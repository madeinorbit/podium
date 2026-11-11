# ADR 13 — Tenant sync feeds

Status: accepted for POD-6253's hosting foundation, 2026-11-11. Implements
section 8 of `docs/design/POD-6253-sync-log-design.md` on the coordinator branch
`issue/6253-p9-sync-log-and-bootstrap` (also attached to POD-6253), in POD-6775.
Client wire version remains **5**.

## Shared-store decision

Adopt a shared multi-tenant store as the hosted persistence target. This decision
triggers [ADR 1 D5.3](0001-authority-ownership.md#decision-d5--instance-identity-specsp-15aa-feeds-pod-645)'s
reserved-columns clause and supersedes ADR 1 Amendment 2 D18's statement that no
such decision exists. The initial implementation partitions sync infrastructure;
it does not authorize hosting multiple tenants over the existing unpartitioned
model tables. Those repositories must gain tenant isolation before that deployment.

`tenant_id` is the durable workspace partition, independent of the runtime
`InstanceId` configuration brand. One self-hosted instance is one tenant, named
`local` inside its separate database. Hosted provisioning must supply a stable,
globally distinct workspace key; runtime instance names are not globally unique.
The partition is not a synced entity or a field added to record payloads.

## Identity and authorization

PDM-107's `integrate/pdm-107-shared-sign-in` was inspected read-only: identity-core,
identity-memberships, membership-authorization-revision and carried-sign-ins SQL,
the identity schema declarations, and `apps/server/src/store/users.ts`.
Its self-hosted composition binds `LOCAL_WORKSPACE_ID = 'local'`.

The sync tenant corresponds to **workspace_id**, not account_id or member_id.
`identity_user` is an account; `identity_membership(workspace_id, member_id)`
places a person in a workspace, with role, status, membership version and
authorization version. `users` is that workspace's product member row;
invitations bind workspace and member; carried sign-ins retain member identity.
Multiple members in an instance share one feed and its change numbering.
Membership changes do not create or rotate tenant feeds.

The server chooses the tenant when constructing a repository, from trusted
workspace routing and verified membership. The current server and read worker
always bind `local`. No request parameter selects a tenant. Feed queries add a
tenant predicate, then the existing visibility policy filters records for the
member. Feed partitioning is not a substitute for membership authorization,
resource grants, or partitioning model reads. A future shared model store must
test cross-tenant authorization, including bootstrap, writes and fan-out, before
admitting multiple workspaces. The current model builders remain per-database.

## Transaction and cursor contract

- `changes` has primary key `(tenant_id, seq)`; `sync_kind` has primary key
  `(tenant_id, kind)`. Both lookup indexes on changes lead with tenant_id.
- `sync_feed` holds tenant_id, feed_id, opaque epoch, minted_at, head_seq and
  floor_seq. The floor is the oldest retained seq, or head + 1 for an empty log;
  a cursor can catch up when cursor + 1 reaches that floor.
- Inside the source write transaction, `UPDATE sync_feed SET head_seq =
  head_seq + :count WHERE tenant_id = :tenant RETURNING head_seq` reserves a
  batch. The row write lock lasts until commit. All its actions are inserted
  before commit; an aborted write rolls the counter back too. Committed numbers
  cannot overtake each other. A new tenant's row is initialized without replacing
  an existing identity. No database sequence or last-insert-rowid assigns seqs.
- SQLite serializes writers with its existing immediate transaction; Postgres
  obtains the tenant row lock through the same update. Different tenants have
  independent counters. No claim of parallel SQLite writes is made.
- Retention takes that same lock and advances floor_seq with its bounded delete
  in one transaction. Both age and row budgets apply within the tenant: 30 days
  or 500,000 rows, whichever removes more (ADR 2 Amendment 2).
- Bootstrap reads head and floor together through the repository as the first
  read fixing its database snapshot. Feed identity changes preserve both bounds.
  Epoch and kind-token wire representations stay unchanged.

## Migration and rollout

The coordinator authorized one preserving SQLite rebuild of changes and sync_kind
because their original single-column primary keys cannot admit repeated numbers
or kinds across tenants. The migration captures sqlite_sequence **before** the
old table is dropped, preserving the head even if every change was pruned.
It copies each retained action, provenance and generation to `local`, preserves
feed identity/epoch, records the oldest retained seq, and recreates the indexes.
No model row is rewritten, so no kind generation bump is required for this
migration. Future model rewrites must bump generations with a tenant-aware
`ON CONFLICT(tenant_id, kind)` target for every affected tenant.

The old singleton feed_identity table remains solely for a later schema contract
step; current reads and writes use sync_feed. There is no dual read or dual write
and no old-client capability path. Restores upgrade the staged backup before the
current repository re-mints its epoch and before the atomic replacement.

On the final rebase after PDM-107, regenerate the Drizzle snapshot DAG and bundled
manifest against both lineages. Do not edit the earlier identity migration SQL.
Keep its workspace/member/account distinction and align any hosted composition
with the same workspace key. PDM-107's users and identity schema are untouched
here. Merge the server-data generation guidance with any identity-related edits;
identity migrations sorting before the sync_kind foundation remain historical.

## Postgres portability work

The reservation is portable transactional SQL; a Postgres adapter must retain its
ambient transaction and row-lock lifetime. Schema types become BIGINT for seqs.
Before a hosted rollout, port the remaining SQLite declarations and migrations,
explicit `INDEXED BY` retention hint, runtime/restore setup, and query-plan audit.
Disable or invalidate the declared WrittenColumns hint before a second process
writes sessions; arrange catch-up from committed log rows for other serving
processes. Those deployment changes belong to the hosted implementation.

In particular, `store/checkouts.ts` applyReach uses preparedFamily sizes 1..512
and pads multi-row upserts by repeating the final row (POD-6806). Postgres rejects
an `ON CONFLICT DO UPDATE` statement that affects the same key twice. Replace
that padding with exact row counts or another deduplicated bulk shape before
porting it. Repeated values in an IN-list delete remain legal. Sync action
inserts use exact row counts and never duplicate a padded action.

Validation and interleaved write-cost measurements are recorded in the issue's
measurement report, including the 500,000-row upgrade's startup blocking time.
