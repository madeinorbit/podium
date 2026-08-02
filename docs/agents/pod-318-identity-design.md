# POD-318 — one machine identity: design decisions

Written by the POD-279 integrator before implementation; the correlator half runs first
(separate commits), this file governs the identity half.

## The scheme

Every machine's identity is a minted UUID persisted in an identity file owned by that
machine — no constants, no placeholders, one scheme:

- Remote daemons already do this: `apps/daemon/src/identity.ts` mints and persists to
  `~/.podium/daemon.json`. Unchanged.
- The HOST machine (where the server runs) gets the same treatment:
  `readOrCreateLocalMachineId(stateDir)` in `packages/runtime/src/local-machine.ts`
  mints a UUID once into `<stateDir>/machine.id` (0600, `wx`-flag race-safe, exactly like
  `readOrCreateDaemonSecret`). The server reads it at boot BEFORE any row is created;
  the split-mode local daemon reads the SAME file (shared host, shared state dir) and
  presents it in its ordinary `hello`. All-in-one passes it in-memory. The loopback
  bootstrap secret continues to be the local daemon's credential — pairing-equivalent
  over the state dir, same `hello` path as a remote (already true today; only the id
  changes from the `'local'` constant to the minted UUID).

Because the server knows the host id at boot, rows are NEVER created machine-less:
`LOCAL_PLACEHOLDER` (`'__local__'`) loses every role, and `LOCAL_MACHINE_ID` (`'local'`)
stops being an identity (the constant is deleted).

## What dies, by role (scout map)

- R1 SQL DEFAULT `'__local__'` on sessions/repos/conversations: migration rebuilds the
  columns with NO default; every writer already receives a machineId (verify by type).
- R2 `adoptLocalRows` + fan-out: deleted.
- R3 routing fallback (`defaultMachine()` → placeholder, `pendingByMachine` placeholder
  queue + carry-over): `defaultMachine()` returns the host id even when its daemon is
  offline; the offline queue keys by real id; carry-over logic deleted.
- R4 `relay.ts` `machine.rowsAdopted` retarget reaction: deleted, plus its entry in
  `composition/reactions.ts` (the reactions-ledger gate re-renders).
- R6 `machine-access.ts` LOCAL_SENTINELS + synthesized `sentinelRow()`: deleted — the
  real machines row always exists from boot. Do NOT introduce any new device-grade or
  admin default while doing this; the row's owner semantics are unchanged.
- R7/R8/R9 `'local'` as row id / hello identity / gateway special-case / auth realm:
  all become the injected host id. `machine-directory.ts` `verifyDaemonSecret` and
  `server.ts` maintenance auth take the id from composition, not a constant.
- R10 the `machineIdBlockedOnPOD318` brand carve-out: REMOVED — `MachineId` refuses
  `'local'`/`'__local__'` outright; brand tests flip from pinning the carve-out to
  pinning the refusal; `scripts/id-inventory-sweep.ts` / `entity-id-audit.ts` updated.

## The two hard calls

1. LEGACY DATA (existing installs have machines row `'local'` and rows with both
   sentinels): a static SQL migration cannot mint the per-install UUID. The rewrite is
   therefore a ONE-TIME boot upgrade in code: inside `ensureHostMachine(id)`, in one
   transaction — rename machines row `'local'` → id, rewrite
   sessions/repos/conversations `machine_id IN ('local','__local__')` → id. Idempotent
   by construction (matches nothing after first run). This is an UPGRADE with a
   deletion horizon, not a standing heal: register it as expiring residue in
   `docs/rearch-deletion-audit.md`'s conventions (named `migrateLegacyMachineIdentity`,
   NOT a `heal*`/`adopt*` name — those patterns are counted as boot-heal shapes by
   `scripts/rearch-audit.ts:872`), with the literal sentinels confined to this one
   function.
2. REPO ID DERIVATION STABILITY: `deriveRepoId({ machineId, path })` fallback-derived
   ids were minted under `'__local__'`. Stored ids are OPAQUE identity — they must NOT
   be rewritten (rewriting cascades into every referencing row for zero product value).
   New fallback derivations use the host id. REQUIRED PROOF: grep + a test showing
   derivation happens only at INSERT time — no code path re-derives to look up an
   existing repo. If a re-derive lookup exists, that is a blocking finding to report,
   not to paper over.

## Also in scope (found by the scout, cheap, correctness)

- `scripts/daemon.ts:28`, `scripts/host.ts:23`, `tests/e2e/serve.ts:12` import
  `'../apps/server/src/local-machine'` which DOES NOT EXIST (invisible because
  scripts/ is in no typecheck lane — POD-1122). Fix to `@podium/runtime/local-machine`
  or the new identity API.

## Test obligations

- Fresh boot: file minted once; second boot reuses; concurrent server+daemon start
  race-safe (`wx` loser re-reads).
- Upgrade boot: seeded legacy DB ('local' machines row + '__local__' rows) converges in
  one transaction; second boot is a no-op; a session live across the upgrade keeps
  working (in-memory sessions map).
- Split-mode daemon hello with the file id + bootstrap secret authenticates; a WRONG
  secret with the right id is refused.
- The brand refusal: `MachineId.parse('local')` and `('__local__')` now FAIL.
- Mutants (prove the instruments can say no): reintroduce one `'__local__'` writer —
  a gate/test must go red; skip the upgrade transaction on a legacy DB — boot must
  fail loudly, not run with mixed identities.
