# Adversarial review: process ownership

> Naming note: at the time of this review, `process-ownership.md` was the
> lease-ledger design (now `process-ownership-lease-ledger.md`); the chosen
> native-supervisor design now holds the canonical filename.

Reviewed `docs/architecture/process-ownership.md` at `a49f939b0`. This review
tries to falsify the safety and completeness claims; it does not propose edits
to the spec itself.

Implementation evidence used below:

- Upstream systemd's `start_transient_scope` registers the `systemd-run`
  process and then replaces it with the payload via `execvpe`; it does not fork
  the payload as its child. A host probe that passed an explicit fd 3 through
  Node's `spawn` to `systemd-run --user --scope` reached Python's `fstat(3)` and
  exited 0. See
  <https://github.com/systemd/systemd/blob/main/src/run/run.c#L2292-L2480>.
- Vendored abduco's double fork in
  `packages/pty/vendor/abduco/abduco.c:393-513` closes its own pipes and socket,
  but does not close unrelated inherited descriptors. Both the master and the
  PTY application therefore retain a deliberately inherited lease fd.
- The current launch sites have separate `child_process.spawn` calls and
  separate `stdio` arrays: `packages/pty/src/abduco.ts:870-895`,
  `apps/daemon/src/runtime/opencode-server.ts:527-538`,
  `codex-app-server.ts:542-550`, and `grok-acp-server.ts:255-260`.
  `opencode-attach.ts:328-400` reaches the abduco path. The shared scope helper
  builds argv; it cannot arrange descriptor inheritance.

## Findings

### 1. [critical] Losing the ledger inode defeats the instance singleton

- **Spec section:** §2 decision 1; §3, paragraphs “One per-user,
  machine-wide directory” and “The instance lock.”
- **Concrete failure scenario:** daemon A holds
  `instances/default.lock`. The runtime directory is deleted and recreated
  while A remains alive, a condition §3 explicitly calls “degraded, not
  fatal.” A still locks an unlinked inode. Daemon B opens the newly created
  `instances/default.lock`, acquires it, and starts with the same instance
  name. The machine now has two live `default` owners, invalidating the premise
  used by every own-versus-foreign decision. Reconstructing process leases does
  not reconstruct A's instance-lock inode.
- **Proposed amendment:** make loss or replacement of the ledger/instance-lock
  inode a fail-closed condition for the daemon, or put the singleton lock in a
  lifetime-stable machine-local location and continuously verify its
  device/inode. Specify startup recovery and the response to deletion. Do not
  classify this condition as harmless degradation.
- **Author response:** Accepted. The daemon fails closed: it verifies the device/inode of its held instance lock every sweep; on mismatch or disappearance it alarms, stops spawning, and re-asserts before resuming. Ledger loss is downgraded from “degraded, not fatal” to a fail-closed singleton condition plus recoverable lease data.

### 2. [critical] One mutable file cannot safely be both record and lock

- **Spec section:** §3 lease steps 1–4; §3 “Supersession”; §7
  “Tombstones” and “Supersession.”
- **Concrete failure scenario:** the child holds a flock on the lease inode.
  Step 4 must add the identity triple, and later code must add supersession
  state. If either update uses the normal crash-safe temp-file-plus-rename
  pattern, the pathname now names a new, unlocked inode while the child locks
  the old unlinked inode; a sweep acquires the new file and can classify a live
  process as dead. If the implementation truncates and rewrites the locked
  inode instead, a crash or concurrent reader can observe malformed or partial
  metadata. The spec requires both crash safety and lock/path identity but
  provides no write protocol satisfying both.
- **Proposed amendment:** make a lease a directory with an immutable `hold`
  inode used only for flock and a separately replaceable, versioned metadata
  file (or an equivalent two-inode design). Define fsync/rename ordering,
  corruption handling, and which metadata transitions are legal while the
  hold inode remains locked.
- **Author response:** Accepted wholesale. A lease becomes a directory: an immutable `hold` inode used only for flock and never rewritten, plus versioned metadata replaced by fsync-then-rename. Metadata corruption is a record-health fact, never death evidence.

### 3. [critical] Lease publication races spawn against reap

- **Spec section:** §3 lease steps 1–4; §3 “Probing a lease is acquiring it.”
- **Concrete failure scenario:** the spawner creates and writes `L` in step 1
  but has not acquired its lock in step 2. A concurrent boot sweep opens and
  locks `L`, observes no identity, and removes the pathname. The spawner either
  waits, then acquires the now-unlinked inode and starts an invisible process,
  or fails after some spawn-side state has already been committed. The “short
  grace” does not close this race; it only changes its timing. The same unlink
  race exists when a waiter has already opened a dead lease that a reaper then
  deletes.
- **Proposed amendment:** define a publication protocol: globally unique,
  never-reused lease ids; create a private pending entry with `O_EXCL`; acquire
  the hold lock before making the lease visible; publish with an atomic rename;
  never wait on a pathname opened before publication; and revalidate
  pathname-to-inode identity before spawn. Define recovery of abandoned pending
  entries separately from live leases.
- **Author response:** Accepted wholesale: unique never-reused lease ids, staged creation under `pending/` with O_EXCL, hold locked before publication, publication by atomic rename, no waiting on pre-publication pathnames, inode revalidation before spawn, and separate recovery for abandoned pending entries.

### 4. [serious] Descriptor ownership and parent close are unspecified

- **Spec section:** §2 decision 3; §3 lease steps 2–4 and “Death is detected
  by the kernel.”
- **Concrete failure scenario:** after spawning and stamping, the daemon keeps
  its original open file description. The engine exits, but the daemon's copy
  keeps the flock held until the next daemon restart, so a dead process appears
  alive and is sheltered. In the opposite direction, a payload that calls
  `closefrom(3)` drops the fd immediately and appears `lock-lost` while live.
  “Direct child” and “inherits it” establish neither who must close nor who is
  guaranteed to retain the fd.
- **Proposed amendment:** specify the exact fd number, close-on-exec state,
  child acknowledgement point, and parent close point. Either put a Podium
  wrapper in every process tree that is guaranteed to retain the hold fd until
  the tree is gone, or make lock capability a measured per-incarnation fact.
  Include negative tests for premature child close and positive tests that the
  daemon's copy closes after publication.
- **Author response:** Accepted. The spec now pins: explicit stdio-slot fd, non-CLOEXEC, the parent closes its copy immediately after spawn returns, and lock capability is a measured per-incarnation fact recorded in the lease (retention probe on first sweep). Negative/positive tests are listed as implementation-contract obligations.

### 5. [serious] The family descriptor claims are reversed or unproved

- **Spec section:** §2 decision 12; §3 “Death is detected by the kernel”; §7
  “Verify descriptor passthrough.”
- **Concrete failure scenario:** an implementer follows the text and marks all
  abduco leases permanently lockless while trusting a vague future systemd
  check. In fact, `systemd-run --scope` registers itself and execs the payload
  in place, preserving explicitly inherited non-CLOEXEC fds; the host probe
  described above confirms fd 3 on this machine. Vendored abduco double-forks
  but never closes unrelated fds, so its master and PTY child also retain the
  lease fd. An exiting intermediary does not release a flock while descendants
  share the same open file description. Conversely, the server binaries
  themselves have not been proved never to close unknown fds.
- **Proposed amendment:** replace the prose assertion with a checked family
  matrix covering scoped and unscoped opencode, codex, grok, terminal masters,
  and viewer TUIs. State that Node must explicitly place the lease fd in each
  `stdio` array. Record the present systemd exec behavior and abduco source
  behavior, and downgrade only an incarnation whose launch-time retention probe
  actually fails.
- **Author response:** Accepted, with thanks — my claims were reversed and your probe settles it. The prose is replaced by a checked family matrix; systemd-run --scope exec-in-place fd preservation and abduco's fd retention are recorded as evidence; server binaries are unproven and measured per incarnation; downgrade happens only on a failed retention probe.

### 6. [serious] `cgroup.procs` is not an authoritative single pid

- **Spec section:** §3, paragraph beginning “The pid in step 4 is learned from
  an authoritative source.”
- **Concrete failure scenario:** by the time step 4 reads `cgroup.procs`, a
  terminal scope contains the abduco master and the PTY application, and a
  server may already have children. The file is a set, not a distinguished
  leader, so it cannot answer which pid receives the lease's singular identity
  triple. Picking the first line is scheduler-dependent. This also conflates
  “lease root,” “fd holder,” and “process to signal.”
- **Proposed amendment:** define one root per family. For scoped direct servers,
  capture `child.pid` from the `systemd-run` spawn (the exec-in-place behavior
  preserves that pid), open a race-resistant process handle where available,
  and verify its cgroup membership and start identity. For abduco, obtain the
  master pid from the socket protocol and verify the triple. Treat
  `cgroup.procs` as tree membership, never root selection.
- **Author response:** Accepted. Root selection per family: scoped servers capture child.pid from the spawn (exec-in-place preserves it) and verify cgroup membership plus start identity; abduco masters are obtained from the socket protocol and triple-verified; cgroup.procs is tree membership only.

### 7. [critical] A per-session scope cannot safely reap one superseded incarnation

- **Spec section:** §3 “Supersession” and Linux scope paragraph; §4 “Verdicts”;
  §7 statement that unit names remain as today.
- **Concrete failure scenario:** lease L1 and replacement lease L2 serve the
  same codex session. Both map to `podium-cx-<session>.scope`; current
  `codex-app-server.ts:415-434` explicitly warns that overlapping children
  share one unit and that stopping it kills the serving sibling. Hygiene reaps
  superseded L1 using the advertised verified whole-tree scope kill. systemd
  empties the session scope, killing L2 as well. Exact pid triples do not rescue
  a cgroup-wide stop.
- **Proposed amendment:** give each process-tree incarnation a scope name that
  includes the opaque lease id/generation, while keeping session identity in
  metadata for lookup, or prohibit overlap and require verified retirement of
  L1 before L2 can be published. Every reap target and verification must be
  generation-scoped; a per-session unit cannot be the kill boundary once
  supersession exists.
- **Author response:** Accepted — this was the worst miss; the code comment you cite was in my own dossier. Server-family scope names gain the lease generation (`podium-cx-<session>-g<n>`), making the incarnation the kill boundary. Terminals are exempt with a stated no-overlap invariant: abduco itself refuses a second master per label, and the durable label must stay session-constant for reattach.
- **Reviewer follow-up (post-6f100d9b9):** the terminal exemption is contested.
  Abduco's single-master invariant prevents simultaneous masters, not
  scope-name ABA: L1 dies, its session-constant scope is collected, L2 starts
  under the same unit name, and a delayed L1 reaper stops the reused unit —
  killing L2. The abduco label must stay session-constant for reattach, but
  the systemd scope name need not.
- **Author response 2:** Accepted in full; the exemption is withdrawn. The
  scope unit name and the abduco label were never required to coincide —
  `scopeUnitName(label)` deriving one from the other is an implementation
  habit, not a constraint. Terminal scopes are now per-incarnation like every
  other family (`podium-<session>-g<n>.scope`), read from the lease rather
  than derived from the label, while `abduco -n` keeps the session-constant
  durable label. Every scope stop additionally revalidates the lease's
  recorded unit + identity under the session transaction lock before acting.
  Side benefit, now noted in the spec: fresh unit names per incarnation
  retire the "unit already exists"/squatted-name reclaim class
  (`reclaimStaleScope`'s reason to exist) instead of working around it.

### 8. [critical] Supersession and adoption have no serialization point

- **Spec section:** §3 “Supersession”; §4 `adopt` verdict; §7
  “Supersession.”
- **Concrete failure scenario:** adopter A reads and health-probes L1. Spawner B
  publishes L2 and marks L1 superseded. A then commits its already-probed L1 as
  the adopted bound process. Depending on last writer, the ledger now says L1
  is both bound and superseded, or silently clears the supersession while L2 is
  live. A concurrent hygiene pass can kill whichever incarnation a user has
  just been given. “At bind time” does not define a linearization point across
  files and async probes.
- **Proposed amendment:** add a per-session transaction lock and monotonic
  binding generation. Adoption must compare-and-swap the generation after its
  probe; spawn publishes L2 and supersedes prior binding edges in the same
  transaction. Define idempotent pending/bound/superseded transitions and which
  operation wins each race.
- **Author response:** Accepted. Per-session transaction lock in the ledger plus a monotonic binding generation; adoption compare-and-swaps the generation after its probe; spawn publishes the new lease and flips binding edges in the same transaction. Transition table added.

### 9. [critical] Tombstones are not fenced to the process they intend to kill

- **Spec section:** §3 “Supersession” final sentence; §5 hygiene item 2; §7
  “Tombstones.”
- **Concrete failure scenario:** a kill writes a session tombstone, then signal
  delivery or verification fails. The user resumes the same session and L2 is
  published. On the next sweep the still-durable session tombstone authorizes a
  kill of L2, even though the intent targeted L1. The ledger layout lists only
  instance locks and leases, so the tombstone's location, schema, lifecycle,
  and relationship to later leases do not constrain this outcome. A verified
  kill followed by failed tombstone cleanup has the same stale-intent problem.
- **Proposed amendment:** make termination intent a state machine targeted at
  exact lease ids/binding generations: pending, executing, verified, and
  retained audit result. Specify fsync-before-signal, retry after partial kill,
  and the rule for spawning a successor while an older intent is pending.
  Session-wide “kill all generations” must be a distinct explicit operation.
- **Author response:** Accepted. Termination intent becomes a per-lease-generation state machine (pending → executing → verified, retained for audit), fsync-before-signal, defined retry, and successor-spawn policy. Session-wide kill is a distinct explicit operation.

### 10. [serious] Negative responsiveness is both an orphan shelter and an unsafe proof

- **Spec section:** §4 driver table; §5 hygiene item 2.
- **Concrete failure scenario:** a superseded opencode server continues to
  answer its credentialed health endpoint, or a superseded codex app-server's
  child remains alive. The §4 definitions therefore call it responsive, so
  hygiene never reaps the known-unwanted process. In the opposite direction, a
  live current server stalls or its credential is temporarily unavailable at
  the decision instant; a boolean false can be read as “nothing is being
  served” and authorize a live kill. The contract has no `false` versus
  timeout/error/unknown distinction.
- **Proposed amendment:** exact generation-fenced tombstone or supersession is
  the positive proof of unwantedness; responsiveness should select graceful
  handling or report diagnostics, not authorize the kill. Make every driver
  probe tri-state (`responsive`, `unresponsive`, `unknown`) with timeout and
  credential rules. Never collapse probe failure into a negative fact.
- **Author response:** Accepted. All probes are tri-state (responsive / unresponsive / unknown) with timeout and credential rules; probe results select graceful handling and feed diagnostics but never authorize a kill — only generation-fenced supersession or tombstones do.

### 11. [serious] Known-unwanted `lock-lost` processes can never enter hygiene

- **Spec section:** §3 promise that a family without a lock witness remains
  fully correct; §5 hygiene items 1–2 and the “Everything else” paragraph.
- **Concrete failure scenario:** under the spec's own abduco model, a live
  superseded terminal has a free lock and a live socket. Item 1 classifies it
  `lock-lost`; item 2 requires “lock held”; the final paragraph sends all
  `lock-lost` cases to server judgment. It is therefore never an unprompted
  reap despite positive supersession. The same permanent shelter applies to a
  direct server that closes unknown fds.
- **Proposed amendment:** make unwantedness independent of current lock state.
  For each family, combine exact generation, positive tombstone/supersession,
  and its remaining identity/liveness witnesses. Reserve `lock-lost` as an
  observation dimension, not an exclusion from otherwise-proved cleanup.
- **Author response:** Accepted. Unwantedness is now independent of lock state: hygiene item 2 requires the positive mark plus exact identity via whatever witnesses the family has, with lock state recorded as observation only.

### 12. [serious] “Confirmed dead” requires the residual tree to be absent before collecting it

- **Spec section:** §5 hygiene item 1.
- **Concrete failure scenario:** the recorded root is dead and the lock is free,
  but a helper that closed unknown fds remains in the exact owned Linux scope.
  Because the scope is non-empty, item 1 refuses to act forever. Yet its next
  sentence says to “collect surviving remains,” which can only be necessary
  when such remains exist. This is the leaked-Xvfb/grandchild shape the current
  scope reclaim code discusses.
- **Proposed amendment:** split root death from tree cleanup. After proving the
  root identity is gone and the incarnation-specific scope belongs to this
  lease, claim the reap, terminate residual members, and only then require and
  report an empty scope before deleting metadata. If the scope is shared or
  cannot be attributed exactly, return ambiguity instead.
- **Author response:** Accepted. Item 1 splits root death from tree cleanup: prove the root dead by triple, attribute the incarnation scope to this lease, claim the reap, terminate residual members, verify empty, then delete. Unattributable or shared containment returns ambiguity.

### 13. [serious] The sync arm and 30-minute grace are not durable or defined

- **Spec section:** §5 hygiene item 2.
- **Concrete failure scenario:** a daemon restarts every 20 minutes. If “first
  observation” is in memory, the 30-minute grace restarts each time and a
  superseded orphan survives forever. Conversely, if a partial/delta
  session-table exchange counts as “one successful sync,” a reconnecting
  daemon can arm cleanup before it has received the live row that contradicts
  an old local fact.
- **Proposed amendment:** persist the first-observed timestamp or derive grace
  from the durable generation-fenced mark. Define a successful sync as an
  authoritative full-snapshot epoch with a completion watermark, state how
  disconnect invalidates it, and specify which hygiene inputs require the
  current epoch. Persist enough state that restarts neither reset nor skip the
  safety delay.
- **Author response:** Accepted. First-observed timestamps persist in lease metadata; a successful sync is a full-snapshot epoch with a completion watermark; hygiene inputs name the epoch they require; restarts neither reset nor skip the grace.

### 14. [serious] Shared-process “ties” have no representation or transition rule

- **Spec section:** §3 lease step 1 and “Supersession”; §4 final paragraph,
  “A plan may declare one process shared by N sessions.”
- **Concrete failure scenario:** lease L serves sessions A and B. A binds a new
  lease. The rule “marks every prior lease of that session superseded” marks L
  and hygiene kills the process still serving B. The later “zero live ties”
  rule cannot be implemented because the lease schema has a list of session ids
  but no per-tie binding generation, state, or atomic update protocol.
- **Proposed amendment:** model session-to-lease binding edges explicitly, each
  with generation and active/superseded/terminated state. Rebinding A changes
  only A's edge. A lease becomes unwanted only when a transaction proves zero
  active edges, after which the process-tree generation can be reaped.
- **Author response:** Accepted. Session-to-lease binding edges are explicit records with per-edge generation and state; rebinding one session flips one edge; a lease is unwanted only when a transaction proves zero active edges.

### 15. [serious] Using the liveness lock as the reap mutex makes concurrent census lie

- **Spec section:** §3 “Probing a lease is acquiring it”; §4 census liveness.
- **Concrete failure scenario:** sweeper A acquires a free dead lease and holds
  it through cleanup. Concurrent census B sees the lock held and, per §3, errs
  toward “alive.” B can publish an alive census or suppress a death event after
  A has already proved death. The same false held observation occurs while A is
  checking a live `lock-lost` process. A flock has no way to tell “held by the
  process tree” from “held by a reaper.” Double-reap exclusion is achieved at
  the cost of corrupting the fact the census is meant to report.
- **Proposed amendment:** separate the process hold from an operation/reap
  claim, or add a claim record whose owner and phase are visible while the hold
  inode remains free. Define snapshot ordering so a census reports
  `reap-in-progress` rather than alive and cannot publish a pre-cleanup result
  after the reap completes.
- **Author response:** Accepted. The reap claim is separated from the hold: a claim record (O_EXCL, owner, phase, deadline) sits beside the hold inode; census reports `reap-in-progress` from the claim and never publishes a pre-cleanup snapshot as current. Hold acquisition remains the death proof; the claim governs cleanup and census truth.

### 16. [critical] macOS cannot return the spec's verified whole-tree result

- **Spec section:** §4 “Verdicts”; §6 macOS paragraphs.
- **Concrete failure scenario:** an unscoped opencode server launches a helper
  that double-forks, closes the lease fd, and scrubs its environment. The spec
  explicitly admits that helper is invisible. Killing the stamped leader and
  scanning stamped descendants then finds nothing, so the verdict reports
  “process tree empty, lock free, lease deleted” while the helper remains. This
  contradicts both “ledger and stamps are the mechanism, whole and correct” and
  “every kill is verified.” It can also destroy the last record that would have
  led an operator to the residue.
- **Proposed amendment:** either add a containment primitive on macOS (for
  example a per-incarnation launchd job or a guaranteed process-group wrapper)
  that makes whole-tree enumeration and kill verifiable, or weaken the portable
  outcome type to `verified-stamped-set`/`incomplete` and retain the lease as an
  ambiguity fact. Do not use “whole,” “tree empty,” or “verified” beyond the
  evidence the platform can supply.
- **Author response:** Accepted. Verdict outcomes are typed by what was proved: `verified-empty` (containment enumerated and empty) vs `verified-stamped-set` vs `incomplete`; macOS reaps report the stamped set and retain the lease as a residue/ambiguity fact instead of claiming a verified whole tree. “Whole and correct” language removed; per-incarnation launchd jobs noted as optional strengthening.

### 17. [serious] macOS exact identity and discovery are aspirations, not a mechanism

- **Spec section:** §2 decision 4; §3 pid/source and reconstruction paragraphs;
  §6 macOS terminal paragraph.
- **Concrete failure scenario:** an implementer has no specified source for a
  macOS boot id, process start time, or cross-process environment census. For a
  terminal, the filesystem socket index proves a label exists but not which pid
  to stamp; the path can disappear and be recreated by a new master between
  lookup and signal. “Discovered via its socket, carefully” leaves the exact
  TOCTOU the triple is supposed to eliminate.
- **Proposed amendment:** name and define the Darwin APIs and permissions for
  boot-session identity, process birth time, environment inspection, memory,
  and process observation. For abduco, connect to the socket protocol to obtain
  the master pid, capture its start identity, and revalidate both immediately
  before signalling. Specify the refusal state when any API is unavailable or
  denied.
- **Author response:** Accepted. Darwin sources are named: kern.boottime (boot identity), proc_pidinfo/PROC_PIDTBSDINFO start time, KERN_PROCARGS2 same-user environment, libproc enumeration, with a defined refusal state when an API is denied. Abduco master pid comes from the socket protocol with revalidation immediately before signalling.

### 18. [serious] The census state is not total and sometimes has no owner

- **Spec section:** §4 “Census.”
- **Concrete failure scenario:** after ledger reconstruction, a process can be
  simultaneously `reconstructed`, `lock-lost`, `superseded`, and `foreign`
  relative to the caller; the single `binding state` union cannot represent it.
  A legacy scope-only process has a session-shaped label but no instance stamp,
  so the required “owner instance” does not exist. A corrupt lease or a process
  with only some stamps creates more owner-unknown states. `foreign` is also a
  relation to the observing instance, not intrinsic binding state.
- **Proposed amendment:** define a total record with orthogonal dimensions:
  record source/health, owner plus attribution confidence, process identity
  confidence, lock observation, binding-edge state, scope/socket evidence, and
  lifecycle claim. Permit explicit `unknown` and `ambiguous` values. Add a truth
  table for every source combination, including corrupt and partial records.
- **Author response:** Accepted. The census record becomes orthogonal dimensions (record source/health, owner + attribution confidence, identity confidence, lock observation, binding-edge state, containment evidence, lifecycle claim) with explicit unknown/ambiguous values; `foreign` is computed relative to the observer, not stored as intrinsic state.

### 19. [serious] Census completeness exceeds every stated discovery source

- **Spec section:** §3 ledger-loss reconstruction; §4 “Completeness is the
  point”; §6 macOS limitation; §7 first-run migration.
- **Concrete failure scenario:** deleting the ledger leaves a child holding a
  lock on an unlinked inode. Recreating the pathname cannot make that child hold
  the new inode, so a “reconstructed” lease has permanently lost witness 1. A
  pre-lease process with neither stamps nor an instance-bearing scope is omitted
  by the normal census and visible only to the manual convention pass. On macOS
  an env-scrubbed descendant is omitted entirely. Nevertheless §4 promises
  that nothing can be resident-but-invisible.
- **Proposed amendment:** publish a discovery-source matrix and an explicit
  coverage field on every census: leases, readable environment stamps,
  cgroups/scopes, sockets, and platform process tables. State which populations
  are complete on each platform and surface blind spots as degraded coverage.
  A reconstructed lease must remain lock-unwitnessed until respawn; it cannot
  claim restoration of the old lock.
- **Author response:** Accepted. A discovery-source/coverage matrix is added and every census carries a coverage field; a reconstructed lease is permanently lock-unwitnessed until respawn; the completeness claim is scoped to “nothing resident-but-invisible *within stated coverage*” with blind spots surfaced as degraded coverage.

### 20. [serious] Several promised events have no producer or delivery contract

- **Spec section:** §4 “Events”; §5 cadence.
- **Concrete failure scenario:** an adopted opencode server is not a child of
  the new daemon. Releasing a flock produces no notification, so no component
  can push “process died” until a later census notices it, if at all. macOS has
  no cgroup OOM counter from which to produce “OOM kill.” `lock-lost`, record
  reconstruction, tombstone pending, supersession, reap refusal, and partial
  verification are census/verdict states with no listed event. After a daemon
  restart, the server also cannot know whether an event was lost or replayed
  because ids, ordering, deduplication, and snapshot relation are absent.
- **Proposed amendment:** for every event, name its observer and platform
  availability (child wait, pid/process watcher, cgroup counter, census delta,
  or command result). Define event ids, incarnation/generation, ordering,
  at-least-once versus best-effort delivery, replay/deduplication, and the
  snapshot cursor. Add events for every lifecycle transition and failed or
  incomplete command, or explicitly make them census-only facts.
- **Author response:** Accepted. Each event names its producer and platform availability — non-child death via pidfd (Linux) / kqueue EVFILT_PROC NOTE_EXIT (macOS), OOM via cgroup counters (Linux only, census-only fact elsewhere) — plus event ids keyed by lease generation, a snapshot cursor, and per-event delivery class (at-least-once vs census-delta). Missing lifecycle events added or explicitly made census-only.

### 21. [serious] The foreign-reap command contradicts a non-overridable invariant

- **Spec section:** §4 “Verdicts”; §5 final paragraph.
- **Concrete failure scenario:** §4 says “never touch a process owned by another
  instance” is an invariant no caller can override. §5 then offers an operator
  command to reap a reported foreign process explicitly. The implementation
  must either refuse the advertised command or add an override that disproves
  the advertised invariant. If the foreign owner is currently live, an
  unaudited override can kill exactly the other instance's agent this design is
  intended to protect.
- **Proposed amendment:** choose one contract. Prefer routing a reap request to
  the live owner. If break-glass foreign kill is required, define it as a
  separate authenticated, audited command with exact identity/generation proof,
  explicit active-owner warning, and a result type distinct from normal
  invariant-preserving `reap`.
- **Author response:** Accepted. The normal path routes a foreign reap request to the live owner's daemon. Break-glass is a separate, explicitly named, audited operator command requiring exact identity and generation proof, warning when the owner is live, with a distinct result type. The invariant stands for the normal verdict set.

### 22. [serious] Lease cardinality does not match the process topology

- **Spec section:** §3 “Spawning any agent-side process” and one lease “per
  live Podium-spawned process”; §4 driver process plans.
- **Concrete failure scenario:** `spawnAbducoAgent` starts `systemd-run`, an
  abduco create process, a double-forked master, the PTY application, and a
  transient attach client. The text alternates between one record per process
  and one record whose lock means tree-liveness. An implementer following the
  former creates several leases for one scope and cannot tell which one a
  session binds or supersedes; following the latter violates the promised
  inventory and leaves member roles undefined. Shells and builds compound the
  ambiguity when they are descendants of an agent versus independent roots.
- **Proposed amendment:** define the lease unit as exactly one supervised
  process-tree incarnation, name its root and optional member observations, and
  state which transient launch intermediaries are not separate leases. Give
  independent viewer, shell, and build roots their own lease only when they have
  an independently killable lifetime and boundary.
- **Author response:** Accepted. The lease unit is defined as one supervised process-tree incarnation with a named root; launch intermediaries (systemd-run pre-exec, the abduco create client, double-fork shims) are explicitly not leases; viewer, shell, and build roots get their own lease exactly when they have an independently killable lifetime and boundary.

### 23. [serious] §7 is not sufficient to implement POD-2691 independently

- **Spec section:** §7 in full, especially “they already funnel through one
  scope builder.”
- **Concrete failure scenario:** an implementer adds environment variables and
  edits `systemdScopeArgv`, but no lease fd reaches a child: argv cannot carry an
  fd, `execCreate` overwrites `stdio`, each server has its own `stdio` array, the
  unscoped fallbacks bypass systemd, and the viewer path reaches abduco through
  another module. Even after fixing those call sites, the implementer must
  invent safety-critical storage, race, platform, and wire contracts not stated
  in the document. Two reasonable implementations will make incompatible
  choices about when a process is safe to kill.
- **Proposed amendment:** turn §7 into an implementation contract that, at
  minimum, specifies all of the following:

  1. the owning package/module and typed APIs, and the complete spawn/reap/adopt
     call-site inventory for agents, viewer TUIs, terminals, shells, and builds;
  2. exact Linux and macOS storage roots, directory/file permissions,
     symlink/no-follow rules, lease-id generation, schemas, schema versioning,
     and the missing tombstone layout;
  3. the separate lock/metadata representation, atomic publication and update
     protocol, fsync boundaries, corruption policy, and crash recovery for
     every step before and after spawn, bind, kill, and delete;
  4. explicit fd wiring for `abduco.ts`'s `execCreate`, each of the three server
     `spawn` calls, `opencode-attach`, every unscoped fallback, the fd number and
     CLOEXEC setting, retention verification, and the daemon parent-close point;
  5. platform-specific boot id, process start identity, race-resistant process
     handle, environment scan, socket-master discovery, memory, and tree
     enumeration algorithms, including permission-denied outcomes;
  6. the root-selection rule, per-incarnation scope naming or the no-overlap
     invariant, process-group semantics without scopes, and exact kill targets;
  7. per-session generations and transaction/lock ordering for concurrent
     spawn, adoption, supersession, tombstoning, census, and reap, including
     shared-session binding edges;
  8. the authoritative session-sync epoch, persisted grace semantics, and the
     distinction among probe negative, timeout, error, and unavailable secret;
  9. complete census types and source/coverage semantics, plus verdict inputs,
     idempotency keys, refusals, partial outcomes, retry rules, and verified
     postconditions;
  10. event wire types, producers, generation/cursor ordering, delivery and
      replay rules, and which events are unsupported on each platform;
  11. tombstone retention/retirement, failed-kill retry, successor-spawn policy,
      instance rename, ledger deletion/corruption, and first-run/backfill
      operator UX; and
  12. acceptance tests for the named races and each supported platform, plus
      compatibility/rollback behavior while old and new daemons or pre-lease
      processes coexist.

  The current “one scope builder” statement should be removed or replaced by an
  exact refactor plan: `systemdScopeArgv` is only a shared argv builder, not the
  spawn or descriptor boundary.
- **Author response:** Partially accepted — by design of scope. Everything design-level in your list (storage roots and layout, publication/update protocol, generations and transactions, root selection, scope naming, probe semantics, typed census/verdict/event contracts) is folded into the spec via findings 1–22. The call-site inventory, typed APIs, per-call-site fd wiring, acceptance-test matrix, and rollout/compat plan are implementation planning; §7 is rewritten as a binding list of obligations POD-2691's plan must pin before code, incorporating your twelve points, and the “one scope builder” claim is corrected: systemdScopeArgv is an argv builder only, and unifying the actual spawn boundary is named as the first implementation step.
