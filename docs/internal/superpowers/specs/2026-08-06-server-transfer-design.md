# Server transfer across machines

Status: implementation specification for `POD-1747` (2026-08-06)

## 1. Problem and outcome

Podium currently treats the machine running the coordinating server as a fixed
host. A user who starts all-in-one on a laptop and later pairs an always-on VPS
has to rebuild the server state by hand, and there is no safe way to make the
VPS authoritative without risking two servers writing the same instance.

This feature moves one Podium instance's coordinating state from the current
server host to an already paired machine. The target becomes the only serving
authority, the old host becomes a normal daemon pointed at the new URL, and a
failed transfer leaves the old authority usable. The operation is deliberately
an online, two-phase handoff; it is not a best-effort file copy and it is not
federation or multi-writer replication.

The first product surface is:

* Settings → Machines → `Make server` on an eligible paired machine.
* Add machine → an optional `Make this machine the server` choice. When the
  instance has only its host machine, the dialog recommends this choice and
  explains the laptop-to-VPS use case.

The first implementation supports a server-only target. The target may retain
its local daemon identity so a later follow-up can offer all-in-one promotion;
the protocol and journal must not make that future impossible. Do not pretend a
server transfer is complete until the target serving process has passed a real
health and state proof.

## 2. Terminology and invariants

* **Source** — the currently serving Podium process and its host machine.
* **Target** — a paired daemon machine that will own the serving role.
* **Portable state** — server-owned database and durable server files that define
  the instance.
* **Machine state** — a host's local identity, daemon secret, native agent
  credentials, repositories, PTYs, hooks, sockets, logs, and runtime records.
* **Transfer journal** — a durable source-side record of the current transfer;
  it is the recovery authority when a process dies during a phase.
* **Manifest digest** — SHA-256 over the canonical manifest, not over a UI
  string. Every acknowledgement names the transfer id and digest.

The following are non-negotiable:

1. There is at most one active transfer for an instance.
2. The source remains authoritative and writable until target staging and
   validation have succeeded.
3. The source is fenced before target promotion: no new writes, pairing,
   session spawn, or machine mutation can race the final snapshot.
4. A chunk is accepted only at the expected offset and only into a transfer-
   scoped staging directory. Paths supplied by a peer are never used as local
   filesystem paths.
5. A target is promoted only after every file's size and SHA-256 match the
   manifest and a candidate server can open the imported state and answer a
   proof request.
6. The final commit is idempotent. Retrying a lost acknowledgement must not
   re-import, re-run migrations, or create a second host identity.
7. Before commit, every failure aborts and removes target staging while the
   source resumes. After target promotion begins, an uncertain result is a
   fenced, operator-visible recovery state; it is never silently rolled back
   over writes that may have reached the new authority.
8. The source's old portable snapshot remains recoverable until a later,
   explicit cleanup. A successful transfer does not delete the only rollback
   copy.
9. The target's machine id and daemon secret remain target-owned. The source's
   machine id remains a row in the imported fleet state and reconnects as a
   daemon after cutover. Neither identity is overwritten by the other.
10. Server secrets, authentication state, enrollment authority, and the sync
    generation move with the instance. They are never exposed to the browser,
    logged, or copied through the generic file RPC.

## 3. State contract

### 3.1 Portable server state

The source creates a versioned transfer package from a consistent snapshot of:

* `podium.db`, captured after a WAL checkpoint using the existing SQLite backup
  discipline. The package includes the schema/migration version and sync feed
  identity/generation.
* `enrollment.ledger`, including the pairing root and append-only enrollment,
  revocation, and owner events. The ledger is outside SQLite and must travel
  with the database; it is never reconstructed from machine rows.
* Durable server-owned directories when present: `transcripts/`, `artifacts/`,
  and `uploads/`. Include only regular files under these named roots, preserve
  relative paths and modes needed by the server, and reject symlinks, path
  traversal, sockets, device files, and files outside the root.
* An explicit package format/version and source application/schema version.

The manifest is a canonical, sorted list of relative file names, byte sizes,
mode class, and SHA-256. It also contains transfer id, source instance id,
source machine id, target machine id, source sync generation, package byte
count, and a format version. The digest covers all fields except the digest
itself. A manifest with an unknown format or unsafe path is refused before any
target write.

The package does not blindly copy `config.json`, `instance.json`, `machine.id`,
`daemon.secret`, `daemon.json`, `run/`, `logs/`, `hooks/`, native agent homes,
repository checkouts, PTYs, or process sockets. The target keeps its own
machine identity and local credentials. The target receives a validated
server-mode configuration derived from explicit transfer input:

* the new externally reachable HTTP/WS URL;
* the server port if the operator selected one supported by the target;
* the target's existing persistence choice, or an explicit supported default;
* `mode: "server"`.

The source receives a similarly explicit daemon configuration pointing at the
new URL. Writing that source config is journaled and reversible until the
target commit is certain. A stale all-in-one config must never cause a second
server to start after a successful cutover.

### 3.2 Target staging and promotion

The target daemon owns a private, transfer-id-named staging directory beneath
its state root. It validates capacity before the first chunk and writes each
file to a temporary path, flushing and renaming only after its digest matches.
The target's existing state is not overwritten during prepare or validation.

Validation opens the staged database in a candidate state root, runs the same
migration/schema checks as normal boot without mutating the live target, checks
the ledger/database identity relation, and performs a local proof query. The
target reports a proof containing the transfer id, manifest digest, imported
feed identity/generation, target machine id, and candidate build/version.

Promotion creates a durable backup of any target files that will be replaced,
atomically installs the staged portable state, merges target-owned identity
files, writes the target server config, and starts/restarts the target's
managed server role. It then probes `/health`, `/version`, and a transfer proof
endpoint/query that confirms the imported digest and target host machine id.
If any pre-promotion step fails, the target restores its previous state and
reports failure. If promotion has become externally observable, it does not
guess whether rollback is safe: it marks the journal `commit-uncertain`, keeps
the target fenced until a real server proof exists, and leaves the source
stopped/fenced rather than creating split-brain writers.

### 3.3 Journal state machine

The source journal is durable and fsync'd before each externally meaningful
transition:

```text
idle
  -> preparing
  -> staged
  -> validated
  -> source-fenced
  -> committing
  -> committed
```

Abort edges exist from `preparing`, `staged`, `validated`, and
`source-fenced` only while target promotion has not become observable. The
journal records `aborted` plus an error code and cleanup result. A crash or
lost reply in `committing` becomes `commit-uncertain`; it is not converted to
`aborted` by a timeout. A fresh source boot must inspect this journal before
opening a writable server:

* `preparing`/`staged`/`validated`: safely clean staging and resume source;
* `source-fenced`: recover the source only after proving target did not
  promote, otherwise keep it fenced;
* `committing`/`commit-uncertain`: require target proof or an explicit recovery
  action; never start a second writable server automatically;
* `committed`: start only daemon mode using the recorded target URL.

All mutating entry points check the transfer gate. Read-only status and the
transfer recovery/proof path remain available while fenced. The gate is
instance-wide, not per browser or per machine.

## 4. Wire and service shape

Use a dedicated `serverTransfer` message family. Do not overload session
handoff frames or generic file reads. The server already has authenticated,
machine-scoped daemon RPC and a broker that rejects replies from a machine other
than the requested target; the new family must use that path.

The exact schemas may evolve during implementation, but the contract must have
these operations and properties:

* `serverTransferPrepareRequest/Result` — transfer id, target id, manifest,
  package limits, and target capability/space proof. Prepare is idempotent for
  `(target, transferId, digest)` and refuses a conflicting digest.
* `serverTransferChunkRequest/Result` — transfer id, relative file id or
  manifest index, offset, bounded base64 data, expected length, and per-chunk
  acknowledgement. The target rejects gaps, overlaps, oversized chunks,
  unknown files, and writes after abort.
* `serverTransferValidateRequest/Result` — transfer id and digest; returns the
  candidate proof described above.
* `serverTransferPromoteRequest/Result` — transfer id, digest, new public URL,
  target mode, and an idempotency key; returns `prepared`, `promoted`, or
  `uncertain`, never a bare boolean.
* `serverTransferAbortRequest/Result` — transfer id, digest, and reason; it is
  idempotent and refuses to delete a committed or uncertain target.
* `serverTransferStatus` — a read-only proof/recovery response suitable for
  source recovery and the UI.

Every request carries `requestId`; every result carries it back. Errors have a
stable machine-readable code plus safe human detail. No secret or raw archive
path crosses the wire. The protocol package must update the discriminated
unions, message-class/plane inventory, daemon-frame routing, golden fixtures,
and the generic RPC settlement table together.

## 5. Server orchestration

Add a dedicated service beneath the server modules layer. It owns the journal,
portable snapshot, transfer lock, source fencing, and target RPC sequence. The
existing session-handoff coordinator is a reference for preflight, apply-time
reauthorization, and rollback ordering, but it must not be copied as if a
server transfer were a session transfer.

The public command should be `machines.transferServer` because the target is a
machine row and the action is exposed in the Machines tab. Its input contains:

```ts
{
  targetMachineId: string
  publicUrl: string
  // Optional target port only when the target explicitly supports it.
  port?: number
  confirmation: string // a server-transfer confirmation token, not a boolean
}
```

The caller identity comes from the authenticated principal, never the payload.
The command is online-only, never queued, and admin/instance-owner grade: it
moves all users, auth state, server secrets, machine records, and enrollment
authority. The target must be visible, usable for this operation, online, and
not the current host. Reauthorize source and target at each apply phase.

Preflight must check: target capability/version, target reachability, valid
HTTP(S) URL and derived WS URL, free disk with margin for source package plus
target backup, no active transfer, healthy SQLite state, no unsupported schema
or migration, and a recoverable source snapshot location. It must fail before
fencing or changing either machine.

The sequence is:

1. Authenticate/authorize and acquire the instance transfer lock.
2. Preflight source and target.
3. Quiesce writes and create the source manifest/package.
4. Target prepare, stream, checksum, and validate.
5. Fence source writes and take a final consistency check. If anything fails
   here, abort target staging and release the source gate.
6. Ask target to promote and prove health. Persist `committing` before this
   call. A positive proof is the only path to `committed`.
7. Atomically record the source daemon config and stop source server/janitor.
8. Wait for source daemon to reconnect to target, then record `committed` and
   return success. If source shutdown/reconfiguration is uncertain, do not
   report success; keep the old server fenced and show recovery status.

The service must expose pure helpers for journal transitions, manifest
canonicalization, safe relative-path validation, and failure classification so
the dangerous order is unit-tested without a live browser.

## 6. UI and setup behavior

### Settings → Machines

Eligible remote rows show `Make server`; the current host and offline,
unreachable, revoked, or unsupported rows do not show an actionable control.
The dialog names source and target, explains what moves and what remains local,
requires the new public URL, and requires an explicit confirmation phrase/token.
It shows phase progress (`Preparing`, `Copying`, `Validating`, `Switching`,
`Connected`) and keeps an uncertain result distinct from an ordinary failure.
The UI polls/refetches machine state and transfer status rather than assuming a
mutation's return means the new server is serving. A failure dialog gives the
safe next action; it must not suggest retrying when status is uncertain.

### Add machine

Keep the existing pairing flow. Add an optional post-pair action. When there is
only one machine row, show a recommendation such as:

> If this is an always-on VPS, make it the server. Your current machine will
> keep its agent sessions but stop hosting the shared Podium state.

The choice must not trigger before the target has actually paired and passed
the capability/online checks. The flow then opens the same transfer confirmation
and URL step as Settings. Pairing code generation remains safe if the user
cancels the transfer; it does not implicitly fence the source.

The UI uses the typed tRPC contract and server-returned machine/transfer state.
It does not infer ownership, capability, or source/target identity from labels.

## 7. Failure and recovery behavior

The user-visible outcomes are:

* `aborted` — no target promotion; source resumes; target staging is cleaned or
  cleanup is explicitly reported.
* `committed` — target proves imported state and serves; source is daemon mode
  and reconnects, or the UI reports source reconnection still pending without
  claiming the entire operation failed.
* `commit-uncertain` — one or more acknowledgements were lost after fencing or
  promotion could have started. Source never resumes as a server. The UI offers
  `Check target` and an operator recovery path; it never starts both sides.

Fault injection must cover source crash, target daemon disconnect, chunk
checksum mismatch, short write, full disk preflight, invalid URL, target
candidate boot failure, target promotion failure before rename, target health
failure after rename, source config write failure, and lost replies at every
phase. Assertions must include both state roots and process/port liveness.

## 8. Testing strategy

### Unit and package lanes

* Protocol schema tests for valid/invalid frames, bounds, digest and refusal
  vocabulary; golden fixtures and plane/frame inventory stay exhaustive.
* Manifest/package tests for deterministic ordering, symlink/path/device
  refusal, WAL checkpoint, free-space margin, digest mismatch, short write,
  cleanup, and target-owned identity preservation.
* Journal state-machine tests prove legal transitions, idempotent retries,
  crash recovery, fencing, and the distinction between abort and uncertain.
* Server command/auth tests prove admin/owner gating, target visibility and
  reauthorization, online-only delivery, confirmation, URL validation, and no
  source mutation during failed preflight.
* Runtime/CLI tests prove target promotion writes server mode, source writes
  daemon mode, managed detached/systemd roles are reconciled, and stale
  all-in-one state cannot relaunch a second server.

Run the normal cached gates for substantive code: `bun run typecheck` and
`bun run test`. Do not use a forced cache miss without documenting and filing a
cache-key gap.

### Real two-machine acceptance

Extend the existing isolated two-daemon harness pattern with two independent
state roots and two real server/daemon process stacks. The acceptance scenario
must:

1. boot source all-in-one and target daemon with different instance state dirs;
2. pair target and create sentinel DB rows, an enrollment event, a transcript,
   an artifact, and a server secret;
3. trigger transfer through the command surface;
4. observe target health/proof and source daemon reconnection;
5. assert the sentinel state and digest exist only on the target server;
6. kill/inject failures before commit and assert source remains writable and
   target state remains unchanged;
7. inject a lost commit reply and assert `commit-uncertain` prevents source
   restart as a server.

This lane must use separate concurrent runtimes, not two clients routed to one
server. Run `bun run test:multi-instance` for the repository's independent
instance contract. Add a dedicated transfer integration lane when the process
fixture is ready, and run the browser lane for the actual Settings click.

For Linux-specific promotion and supervisor behavior, provide an opt-in Docker
driver that starts two fresh Linux containers (source and target), mounts only
their own state volumes, connects them on a private network, and injects
failures by stopping one named process or severing the transfer link. The driver
must be additive and skip clearly when Docker is unavailable; it is evidence for
process/filesystem behavior, not a substitute for the normal two-runtime and
browser acceptance lanes. Never use the live development state directory as a
container volume.

### Runtime UI verification

After implementation, drive the real Settings → Machines flow with the
Playwright guidance in `docs/agents/driving-podium.md`: click `Make server`,
enter the URL, observe the progress/result, and verify the machine row/status
changes in the DOM. For the add-machine option, exercise the first-machine
recommendation and verify cancelling leaves the source server usable. A mocked
mutation test alone is not completion evidence.

## 9. Delivery chunks and ownership

The parent issue is the coordinator/integration issue. Child work must stay in
isolated branches and commit only its owned files:

1. **Server transfer wire and target staging** — protocol schemas, daemon
   handlers, server RPC settlement/routing, bounded chunk staging, manifest
   verification, and focused wire tests.
2. **Server transfer coordinator** — source snapshot/journal/fence/commit
   service, command contract/authz/handler, server composition, and failure
   state tests. This consumes the wire contract but does not edit web UI.
3. **Target promotion and lifecycle** — runtime config promotion, CLI detached
   and systemd reconciliation, target/source restart proof, and isolated
   process fixtures. This owns lifecycle files, not the server command contract.
4. **Machines UI and add-machine recommendation** — Settings action, transfer
   dialog/status, first-machine recommendation, typed client tests, and browser
   coverage. This owns web/setup presentation, not transfer internals.

The coordinator reviews every child diff for the invariants above, resolves
contract mismatches, integrates under the shared-branch merge lock, runs the
full gates and real runtime checks, and does not accept a child claim of
success without target proof and failure-path evidence.
