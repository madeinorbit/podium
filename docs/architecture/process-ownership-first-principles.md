# Process ownership: first-principles review

Status: independent design review of `process-ownership.md` for POD-2717.

## Method and scope

I treated §1 of the subject as the problem statement and derived the requirements
and a candidate design from it plus the current process-launch code. Only after
fixing that baseline did I compare it with the proposed design. This is not a
second audit of the lease protocol; the prior review's detailed findings are
assumed resolved.

Procedural limitation: my first section-extraction command expected a heading
starting `## 2`, while the document uses `## §2`, so that command emitted later
sections into its (truncated) output. I did not consult the prior review, and I
fixed the derivation above in writing from §1 and the current code before doing
the systematic comparison, but the attempted blind boundary was not perfect.

## Independent derivation

### What problem actually needs solving

The incident is evidence of a missing **supervision authority**, not merely
missing metadata. Podium deliberately lets workloads outlive the daemon that
started them, but the next daemon has neither an authoritative inventory nor an
exclusive actor to ask. A journal can describe a process, yet description alone
does not make an owner. In the operational sense, an owner is the component that
admits the process into existence, maintains its containment boundary, answers
for its current incarnation, and is the sole route for destructive operations.

The problem statement combines three related but distinct needs:

1. **Attribution:** which Podium installation/instance admitted this workload?
2. **Supervision:** what authoritative boundary says which processes are in this
   particular workload incarnation and can terminate the whole set?
3. **Product lifecycle:** is that live workload still wanted by any session, and
   if not, when should it be stopped?

The incident requires the first two to make the third safe. It does not require
one portable representation to answer all three.

The survival premise also needs narrowing. A terminal hosted by abduco and a
socket-addressable server can usefully survive a daemon restart and be adopted.
A child whose only transport is pipes owned by that daemon cannot. Keeping such
a child resident after the pipes disappear is leakage, not durability. Each
driver should therefore declare whether an incarnation is adoptable; only an
adoptable workload belongs outside the daemon's lifetime boundary.

### Required properties

A design should provide these in order:

- **Birth completeness:** no durable workload can execute before its ownership
  and containment authority exists. Failure to establish supervision means no
  spawn, not an unscoped fallback.
- **One opaque owner identity:** a stable, randomly generated instance UUID is
  the machine identity. A human instance name and a state-directory pathname
  are mutable labels, not identity. Two copied state directories must not
  silently become one owner.
- **One incarnation, one boundary:** every spawn gets a never-reused workload
  id and an independently killable process-tree boundary. A session id is a
  product binding and may point to successive or, briefly, overlapping
  incarnations.
- **Authoritative enumeration:** after daemon restart, the daemon can ask a
  resident authority for all live workload boundaries owned by its instance.
  Discovery must not depend on a write performed after spawn.
- **Positive destructive targeting:** kill names an exact workload incarnation
  and acts through its boundary. Absence from a session table is never by
  itself permission to kill.
- **Whole-boundary verification:** a successful destructive result means the
  supervisor says the boundary is empty or gone. Platforms unable to establish
  this must declare weaker durability/reaping guarantees.
- **Crash-idempotent intent:** a requested termination remains retryable across
  a daemon crash. Product desired state and process actual state remain separate.
- **Safe co-existence:** one instance can neither collide with nor select
  another instance's workloads by a lossy label or prefix.
- **Headless recovery:** cleanup and resource containment cannot depend on the
  web control plane being healthy.

The same-user threat model makes authentication between local Podium components
useful against mistakes, not against a hostile peer: a malicious same-user
process can signal the workload directly. Exact opaque identifiers and narrow
APIs are therefore enough; a cryptographic ownership scheme would not buy a
real security boundary.

### Candidate design: native supervised workloads

Use one portable `WorkloadSupervisor` interface with **native, deliberately
different backends**, rather than a portable filesystem protocol. The native
service manager becomes the authority that exists before the process and
outlives an ordinary Podium daemon redeploy.

At instance creation, mint an immutable random `instanceUuid` in
`instance.json`. Keep the current short instance name for commands, display,
ports, and paths. Prevent two daemons from opening the same state root with a
normal lock in that root. Also acquire a native-manager singleton guard keyed
by the UUID and carrying the canonical state-root identity; a copied root with
the same UUID must refuse to boot until an explicit rekey operation. Do not make
the human name globally exclusive: `blue` in two independent state roots is not
an identity collision when their UUIDs differ.

Every durable launch follows one seam:

1. The daemon allocates a random `workloadId`, persists the product binding or
   desired-state transition, and calls `WorkloadSupervisor.start`.
2. The backend creates a native job named from `(instanceUuid, workloadId)` and
   records display metadata such as session id, family, and generation.
3. The native manager starts the payload inside that job; Podium never starts a
   durable payload first and registers it afterward.
4. The returned handle contains the native job identity and activation identity,
   not merely a pid. The binding journal keeps credentials, native resume ids,
   and transport data, but is not the workload inventory.
5. `list(instanceUuid)` enumerates live native jobs. `stop(workloadId)` is
   idempotent and succeeds only when the native boundary is gone. Reconciliation
   compares this actual set with durable desired state and retries explicit stop
   intents.

On Linux, use transient **service** units created through systemd's manager API,
not caller-owned `--scope` processes. A service unit lets systemd create the
control group and launch the foreground payload itself. Put each unit under the
existing per-instance sessions slice, use a never-reused unit name, and treat
the unit/cgroup plus systemd activation identity as authoritative. Enumeration,
tree kill, resource limits, and empty-boundary verification all come from the
same manager.

The vendored abduco path should gain a foreground/supervised mode so its master
is the service's main process instead of escaping through a double fork. Codex
and opencode servers are already foreground-shaped. Pipe-only children such as
the current Grok ACP transport should remain daemon-owned and die with the
daemon until they acquire an adoptable transport; their harness-native resume
state provides continuity without pretending the old process remains usable.

On macOS, make launchd jobs the corresponding birth records and launch
foreground payloads under unique per-incarnation labels. The implementation
must first prove the exact descendant tracking and job-removal semantics needed
for whole-tree kill. If launchd cannot provide an equivalent boundary for a
family, that family must be reported as resumable-but-not-process-durable rather
than compensated for with heuristic process discovery. A later Windows backend
maps naturally to Job Objects.

Where no supported native manager is reachable (containers, unusual developer
shells), the honest fallback is daemon-owned execution with
`durableProcess: false`: the child dies on daemon exit and is resumed from
harness state afterward. Podium should not silently trade away authoritative
ownership merely to preserve process continuity.

This design keeps the existing policy split. The server decides hibernation and
session meaning; the daemon reconciles desired state; the supervisor backend
only reports and changes native workload facts. Shared processes are one
workload with several product bindings in the durable store. Detaching one
binding does not kill the workload; an explicit zero-reference transition emits
the idempotent stop intent.

## Comparison with the proposed design

### What the proposal gets right

The proposal correctly rejects the current binding journal as ownership truth.
Its per-incarnation ids, positive authorization for destructive action, exact
identity checks, never-touch-foreign rule, generation-fenced termination,
typed outcomes, and policy/mechanism split are all sound requirements. The
decision to unify today's scattered spawn sites is especially important: the
current code has one argv builder but independent `spawn` and `stdio` ownership
in `abduco.ts`, `opencode-server.ts`, `codex-app-server.ts`, and
`grok-acp-server.ts`.

It also understands the present failure modes accurately. Deterministic
session-named scopes are ABA-reusable; a direct pid is recyclable; a record
written after launch can be absent; and a session is not a process-tree
incarnation. Those observations should survive any redesign.

The disagreement is not about whether the lease ledger can be implemented more
carefully. It is about whether Podium should own this protocol at all.

### 1. The ledger is a second service manager

The proposal implements process admission, a job namespace, liveness leases,
crash-safe metadata publication, operation claims, process inventory,
containment correlation, stop transactions, outcome verification, and event
delivery. That is a service manager spread across a filesystem protocol and
several daemons. It then treats the actual service manager as optional
enforcement.

On Linux this hierarchy is inverted. systemd's transient-unit API exists to
create and start a unit atomically, gives the unit a unique runtime handle, and
exposes its `ControlGroup`; transient services are launched by the manager,
whereas scopes contain processes launched by another manager. The documented
distinction matches this problem exactly: a Podium workload should be a
transient service when possible, not a caller-spawned process plus a parallel
ownership record. See systemd's [control-group interface][systemd-cgroup] and
[`systemd-run` service/scope semantics][systemd-run].

The current scope approach was a pragmatic way to keep a double-forking abduco
master alive. Generalizing that workaround is less conventional than changing
the vendored program to remain foreground and letting the service manager
supervise it normally.

macOS also has a resident launch authority. Apple's launchd guidance says that
launchd should establish the execution environment and that managed programs
should not `setsid` or perform traditional daemonization. Its public plist
contract gives every job a unique label and, unless explicitly disabled, kills
remaining members of the job's process group when the job dies. That is not as
strong as a cgroup, so it needs a platform proof before being promised as one;
it is nevertheless a better starting authority than `/proc`-like discovery
after launch. See Apple's [launchd job guidance][launchd-guide] and published
[`launchd.plist` contract][launchd-plist].

### 2. The portable core is not authoritative where it matters

The held descriptor is ingenious but cannot carry the stated semantics for an
arbitrary future process tree. A root or descendant may close it during a later
exec, and an irrelevant long-lived descendant may retain it after the useful
workload is gone. A launch-time retention probe can measure the process that
exists then; it cannot prove the descriptor behavior of every program that
will be execed later. Thus the lock can become free while an unstamped process
still lives, or remain held by residue after the root is unusable.

The spec recognizes this by downgrading the lock to one witness and requiring
identity, environment, process scans, sockets, and cgroups to corroborate it.
That concession undermines the reason to make the lock ledger the portable
authority. On Linux, the cgroup is the only inescapable witness and the only
whole-tree kill boundary. On macOS, the spec admits that an env-scrubbed,
double-forked descendant can be invisible and that a reap cannot verify an
empty tree. The common mechanism therefore produces common code, not a common
guarantee.

The concluding claim that the unrecorded-orphan class is deleted is too strong
for the stated macOS model. The initial root cannot launch without a lease, but
an escaped descendant can later shed both the descriptor and stamps and become
unrecorded by every available source. Honest coverage reporting describes that
gap; it does not close it.

### 3. Process truth and product truth are being co-located

Binding edges, supersession transactions, termination intents, audit retention,
complete server-snapshot epochs, grace timestamps, event ids, cursors, and
delivery classes are not process ownership. They are product desired state and
distributed command delivery. Podium already has durable session state, binding
journals, a server/daemon protocol, and reconcilers. Putting a second binding
graph and command log under the machine runtime ledger creates two stores whose
disagreement must itself be reconciled.

A process supervisor needs only actual workload facts and exact idempotent
operations. The durable product store should say which workload incarnation is
wanted and retain a stop intent; the daemon should reconcile desired and actual
sets. A shared workload's reference count is product state. It need not be a
cross-file transaction protocol in the process inventory.

The proposal's need for both “zero active binding edges” and a complete
session-table snapshot is evidence of this duplication. If the edges are
authoritative, the snapshot should be unnecessary. If the product store is
authoritative, the edges should be a projection rather than a second source of
truth.

### 4. A human instance name is the wrong ownership key

The proposal makes a short operator-chosen name globally unique and protects it
with a machine-wide lock whose inode must be revalidated forever. This turns a
label collision into a daemon outage and makes ledger deletion a fail-closed
spawn outage, while live workloads continue on unlinked inodes.

An immutable random instance UUID is simpler and stronger. It distinguishes two
independent state roots both called `blue`, survives a display rename, and
cannot collide through operator convention. A lock inside a state root prevents
two daemons from concurrently opening the same installation; a native singleton
guard keyed by UUID detects a copied root and requires it to rekey before
running on the same machine. Current human names can remain in every user-facing
surface without becoming process identity.

This also removes a risky shared protocol surface. Under the proposal every
instance version scans and partly interprets one per-user ledger. Over years,
mixed-version coexistence and a buggy cleanup migration are more likely to harm
another instance than two daemons selecting exact native jobs under disjoint
UUID prefixes.

### 5. Survival is assigned to processes that cannot be adopted

The driver table says Codex and Grok adoption starts a fresh incarnation and
supersedes the old one. Grok's transport is the old daemon's stdio. Once that
daemon is gone, the process is not a useful durable endpoint; its harness state
is the durable artifact. Keeping it outside the daemon's lifetime manufactures
the supersession race and orphan that the ledger must later solve.

Process durability should be a driver capability, not a universal spawn rule.
An addressable server or abduco master may be adoptable. A pipe-only child should
die with the daemon and resume into a new process. The product promise is
conversation continuity, not preservation of every Unix pid.

### 6. The long-term failure mode is protocol erosion

If this ships, I would bet on failures at these boundaries:

- A harness release or descendant closes inherited descriptors after the
  launch probe passed, making the central liveness witness change meaning in
  production.
- One spawn variant, helper, or future driver bypasses the explicit stdio slot.
  The proposal makes this reviewable through a unified seam, but the native
  manager makes bypass structurally impossible for durable workloads.
- Ledger format and recovery behavior diverge across simultaneously installed
  Podium versions. The per-user shared directory makes version skew a runtime
  coordination problem.
- Cache/runtime cleanup, ENOSPC, or operator cleanup deletes part of the ledger.
  The designed reaction is a fail-closed daemon plus reconstructed,
  permanently weaker records—a safe but operationally painful state likely to
  invite unsafe repair shortcuts during the next incident.
- Product bindings and ledger edges disagree after a partial sync. More epochs,
  grace states, and claims are then added to repair the reconciliation, growing
  a bespoke database without database tooling.
- macOS process-environment visibility changes or a harness daemonizes
  differently, quietly reducing census coverage precisely on the platform for
  which the portable core was selected.

These are not missing edge-case rules. They follow from choosing an inherited
capability and a shared crash-consistent filesystem protocol as the supervisor.

## Honest design comparison

| Dimension | Proposed lease ledger | Native supervised workloads |
| --- | --- | --- |
| Birth authority | Podium publishes files, then a spawn seam launches and wires an fd | Native manager creates the job and launches the payload |
| Linux identity and kill | Ledger is authority; cgroup is corroborating enforcement | Unit activation and cgroup are authority |
| macOS | Lease, env stamps, libproc census; known invisible descendants | launchd job/process group where proven; otherwise explicitly non-durable and resumable |
| Instance identity | Human name + machine-wide inode lock | Immutable UUID + state-root singleton lock |
| Product bindings | Duplicated as ledger edges and reconciled with server snapshots | One durable desired-state store; supervisor reports only actual state |
| Non-adoptable drivers | Process survives, then is superseded/reaped | Process dies with daemon and resumes from harness state |
| Crash protocol | Custom publication, two inodes, claims, transaction locks, tombstones | Native actual-state manager + existing durable product command/state path |
| Portability | One complex mechanism with unequal guarantees | One narrow interface with native backends and explicit capability differences |
| Operator tooling | Podium-specific census and repair | Native status, logs, job listing, and stop semantics |
| Main implementation risk | Filesystem concurrency, descriptor drift, version skew | Platform integration and proving launchd semantics |

The alternative is not free. It requires:

- a systemd transient-service backend, preferably through the manager API;
- a macOS launchd proof and backend, including modern app packaging/approval
  behavior and exact process-group termination tests;
- a foreground mode in vendored abduco, with attach behavior preserved;
- an explicit `durableProcess`/`adoptableProcess` driver capability and changed
  restart semantics for pipe-only drivers;
- an opaque UUID migration for `instance.json` and native unit labels, plus an
  explicit rekey path for copied state roots;
- exact workload ids and idempotent stop intents in the existing durable
  desired-state path; and
- a one-time, conservative diagnostic/import path for legacy scopes and
  untracked processes.

Those costs are substantial platform work, and native managers have different
interfaces. They are still less conceptual and operational surface than owning
a new service manager, transactional file store, and cross-platform process
census indefinitely. They also spend complexity where guarantees differ rather
than hiding the difference behind a portable lease.

## Recommended decision and validation

Do not begin the lease-ledger implementation as specified. First run two narrow
platform spikes through the proposed `WorkloadSupervisor` interface:

1. On Linux, start a foreground payload and descendant as a transient user
   service under the existing instance slice; crash the daemon; enumerate the
   exact unit and activation; stop it; prove the cgroup empty; and repeat across
   a user-manager re-exec.
2. On macOS, bootstrap a uniquely labelled foreground launchd job and child;
   crash the app/daemon; enumerate by exact label; remove the job; and measure
   which descendants launchd actually terminates. Repeat for a child that forks,
   calls `setsid`, or scrubs its environment.

If launchd cannot provide a defensible boundary, make affected drivers
resumable but not process-durable on macOS. Only if product requirements reject
that explicit degradation should Podium revisit a supplementary per-workload
shim or lease—and then the lease should aid discovery, not replace the native
supervisor on Linux.

Retain from the current proposal the unified spawn seam, per-incarnation ids,
positive kill authorization, typed outcomes, exact matching, journal demotion,
and mechanism/policy split. Replace the global name lock, inherited-fd
authority, cross-instance ledger census, filesystem binding graph, and universal
process-survival premise.

[launchd-guide]: https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
[launchd-plist]: https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5
[systemd-cgroup]: https://systemd.io/CONTROL_GROUP_INTERFACE/
[systemd-run]: https://github.com/systemd/systemd/blob/main/man/systemd-run.xml

## Verdict

The proposed design is impressively defensive, but its complexity is a symptom
of choosing a portable lease ledger to perform a native supervisor's job. Make
native per-incarnation jobs the birth, inventory, containment, and kill
authority; keep product desired state in one durable store; identify instances
by opaque UUID; and decline process durability for workloads or platforms that
cannot be authoritatively supervised. The cost is real platform-specific
implementation and an abduco foreground change, but the resulting system is
simpler to operate, stronger on Linux, more honest on macOS, and less likely to
accrete a private service manager over years.

**BETTER ALTERNATIVE EXISTS.**

---

## Author assessment (POD-2694)

Substantially agreed. Point by point:

**Conceded in full:**

1. **Transient services over scopes on Linux.** The scope-plus-ledger shape
   generalized a workaround for abduco's double fork; a manager-launched
   service gets birth-registration atomicity, enumeration, tree-kill, and
   verified-empty from one authority with no descriptor tricks. Feasibility
   checks out per family without D-Bus fd-passing: opencode needs no stdio
   (journald takes the logs); codex's stdin-EOF boundary is replaced by
   `systemctl stop` and its socket remains the transport; grok — see below;
   abduco gains a foreground mode.
2. **Instance UUID over name lock.** A name is a label; the copied-state-root
   case breaks the name-lock design, and the machine-wide inode-revalidated
   lock turned label collisions into outages. Podium already mints per-root
   UUIDs (`machine.id`), so this is cheap and strictly better.
3. **Desired/actual split.** The binding edges, snapshot epochs, and intent
   store were product state migrating into the process inventory — the
   reviewer's "if the edges are authoritative the snapshot is unnecessary"
   is the decisive observation. Supervisor reports actual; product store
   holds desired; the daemon reconciles. Termination intents live in the
   product store.
4. **Per-driver durability capability.** The sharpest finding. Codex's adopt
   already starts fresh (survival buys nothing), and grok's transport is the
   dead daemon's stdio (survival is a liability). Only opencode (rebindable
   HTTP) and terminals (reattachable master) genuinely benefit from
   outliving the daemon. Universal survival manufactured the supersession
   problem the ledger then had to solve.

**Two amendments I ask for before adoption:**

a. **No-systemd Linux must not regress terminal durability.** Today an
   abduco master survives daemon death on hosts without a usable systemd
   user manager (containers, odd shells); the proposed fallback
   (`durableProcess: false`) would take that away. The abduco socket
   directory is already a resident per-instance authority for exactly this
   family — keep it as the terminal family's supervisor backend where no
   native manager exists, with the honest capability report (enumerable,
   reattachable, no containment, no verified-empty).
b. **The launchd spike is the linchpin and must gate the macOS promises.**
   launchd's process-group kill does not survive a descendant's `setsid`,
   so macOS may land at "enumerable + reattachable, containment weak" —
   acceptable if declared, but the spec must not promise more until the
   spike's measurements exist. The spike also needs the modern
   app-approval/packaging reality (SMAppService) checked, since the native
   app is a first-class host.

**What survives from the lease ledger:** birth-time environment stamps
(diagnostics and stray attribution, no longer authority), per-incarnation
never-reused ids, positive kill authorization, typed outcomes, exact
matching, journal demotion, the unified spawn seam, and the
mechanism/policy split — the reviewer's own retain list, which I confirm.

**Disposition:** recommending to the operator that the spec be revised to
the native-supervisor architecture with amendments (a) and (b), the two
platform spikes listed as gating obligations for POD-2691. The operator
decides.
