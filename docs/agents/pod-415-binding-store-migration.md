# POD-415 binding-store migration

The daemon binding store is a bespoke, forward-only file format under the selected
instance's `runtime/session-bindings` directory. It is not drizzle-authored, and its
integer manifest version is independent of the server database's
`__drizzle_migrations` journal. Each session is written atomically to its own file so
one damaged or interrupted write cannot discard another session's binding history.

## Version lineage

- Store v1 established the manifest and per-session record directory.
- Store v2 added the durable one-shot legacy-migration receipt.
- Session records currently use record schema v1. A newer store or record version is
  refused without rewriting or deleting its bytes.

Unknown fields in a supported record are retained across read-modify-write. Store and
record versions intentionally have separate constants: changing one does not imply a
server database migration or a wire-version change.

## One-shot import

On first open, the migrator inventories the real daemon state root and imports:

- `session-observers.ts` provider identity and path pins supplied by the live cutover
  snapshot;
- `control/session.ts` durable-host labels (seeded as attempt identity), cwd and
  resume aliases;
- adapter-owned native ids, transcript/rollout paths, cwd and worktree pins;
- `daemon.json`'s machine id as the claimant-machine reference (the identity file and
  token remain in place); and
- regular and `.ack` Codex identity receipts, including
  `PodiumProcessBinding` process-ownership evidence.

Every native alias becomes an append-only observation with its own `observedAt`; no
current alias scalar is stored. The durable-host label is not a native artifact and
therefore seeds `attemptId` instead. Reopening after the completed marker never
re-runs the lift.

Legacy bindings require the Phase 1 first-admin `UserId` supplied by
`FIRST_ADMIN_USER_ID`. If binding facts exist and that value is unavailable, migration
throws before writing a binding; it never invents a user or stores a placeholder.
That assignment is migration-only. Normal spawn and reattach must carry the delegation
minted by the server-side binding transition in POD-416; the daemon must never synthesize
one from `FIRST_ADMIN_USER_ID` when a control frame arrives.

## Receipt constraint

Importing a Codex receipt records `pendingServerAck` on the observation but leaves the
legacy receipt or `.ack` claim byte-identical on disk. The old spool remains the active
delivery/deletion mechanism until POD-737 moves it onto the general store. That later
fold can preserve exact-value acknowledgement, at-least-once replay, and per-session
atomic isolation without changing the binding schema.

## Multi-user boundary

The store is an owned-compute fact scoped with its machine. It has no `instance_id`
column or per-user directory partition. Delegation history stores actor,
`onBehalfOf: UserId`, declared scope and parent binding; owner-scoped reads filter in
the store before returning rows. No capability, effective-rights, permission, role,
grant list or cached authorization decision is persisted.
