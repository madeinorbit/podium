# Process ownership: every agent process has an owner, and the owner can prove it

Status: studied alternative, declined (POD-2694). A unanimous three-reviewer
blind comparison chose the native-supervisor design (`process-ownership.md`);
this document is kept for the record, and its strongest mechanisms — the
held-lock liveness witness, the identity-triple discipline, the reap-claim
protocol, and the census/intent vocabulary — were carried into the chosen
design's fallback lanes. The section below is preserved as written.

Status: agreed design (POD-2694). Implementation: POD-2691. Companion to the
agent-runtime architecture proposal (§9 phase 4: process supervision) and the
resource-isolation spec (`pod-2413-resource-isolation.md`). Decided with the
operator on 2026-08-24; the decision log in §2 records what was chosen and
why. Amended twice the same day: first after an adversarial self-review
(decisions 11–12), then after an independent red-team review
(`process-ownership-review.md`, 23 findings, answered inline there) whose
accepted amendments are folded in throughout — most visibly the two-inode
lease, the publication protocol, binding generations, per-incarnation kill
boundaries, and honest verdict outcomes.

## §1 The problem, measured

When Podium runs an agent it starts real programs on the machine — an
`opencode serve` HTTP server, a `codex app-server`, a `grok` ACP child, or a
terminal under abduco. These programs deliberately outlive the Podium daemon
that started them: that is what makes agents survive a redeploy. But nothing
records *which copy of Podium* a program belongs to. Several instances can run
side by side as the same user, and on Linux they all share one systemd user
manager, so a unit name says which **session** a process serves but not which
**instance** started it.

Consequences, measured on one box: 15 orphaned agent servers holding 1.6 GB,
three with no journal entry at all; processes from work finished 92–160 hours
earlier still resident; orphans from at least three different state directories
side by side under one manager. Nobody reaps, because reaping is unsafe: a
naive sweep by one instance would have killed another instance's live agents.
The resulting memory pressure twice took the control plane down — the tools
needed to fix the problem stopped answering.

Two facts from the incident shape everything below:

- **A record written beside a process can be missed.** The binding journal is
  written on bind and cleared on kill; an orphan whose entry was never written
  is invisible to it. Three of the fifteen orphans were exactly that.
- **A record about a process can outlive or mis-name it.** A journalled pid can
  be recycled; a unit name can be squatted by leaked grandchildren. The code
  already carries the scar: `ProcessIdentity.key` is documented "EXACT. A
  prefix match here is how ghost sessions happen."

## §2 Decision log

Each decision below was settled explicitly; the motivation is part of the
decision and future changes must engage it, not just the rule.

1. **Every instance is named, and a name runs at most once per machine.**
   `default` is just the default name, with no anonymous special case. A
   booting daemon takes a machine-wide lock on its name (§3) and refuses to
   start if the name is held; it re-verifies that lock's device/inode every
   sweep and **fails closed** — alarm, stop spawning, re-assert — if the
   ledger was deleted or replaced underneath it. The name↔state-directory
   binding is already enforced by the `instance.json` marker. *Motivation:*
   the measured ambiguity came entirely from multiple unnamed instances
   sharing one unit namespace; and a recreated ledger must not let a second
   daemon acquire a name whose holder locks an unlinked inode (red-team
   finding 1).

2. **Ownership is recorded at birth, before the process exists.** The spawner
   creates the ownership record first and creates the process *from* it.
   *Motivation:* the record-written-afterwards design is how three orphans came
   to exist with no record at all. A step that can be skipped will be skipped;
   a step the process is born from cannot.

3. **The record's truth decays with the process itself.** The process tree
   holds a lock on its own record; the kernel releases it when the last
   holder dies. No heartbeats, no TTLs, no clocks — for *liveness*.
   *Motivation:* every stale-record failure in the current system (journal
   naming a dead or recycled pid) comes from records whose truth is
   maintained by code that has to remember to run.

4. **Identity is exact: (pid, process start time, boot id) — never a pid
   alone, never a name parsed backwards.** Labels may be lossy (grok's is:
   non-alphanumerics squashed, truncated to 48 chars) and may only ever be
   *computed from* a candidate and compared, never decoded. *Motivation:* pid
   recycling and the prefix-match ghost-session scar; grok's label is
   non-injective by construction.

5. **Kernel grouping is enforcement, not identity.** systemd scopes/slices
   carry limits, containment and verified tree-kill on Linux; they are an
   amplifier on top of the portable mechanism, never load-bearing for
   correctness. *Motivation:* macOS has no transient scopes (recorded in
   `host.ts`), and the native macOS app hosting server+daemon is a first-class
   deployment, not a degraded one. This inverts the original framing, which
   put identity in the unit name.

6. **Mechanism and meaning are separate layers in the code.** One supervision
   module owns every touch of the ledger, process tables, `/proc`, and
   `systemctl`. It exports facts and executes commands with verified outcomes;
   it contains no "when" logic. Product code decides what a viewer is or when
   to hibernate; it never reaches around the module. *Motivation:* operator
   requirement — "not intermingling logic like when to hibernate with logic of
   how to tell the process to do that."

7. **Certain cleanup is daemon hygiene; judgment belongs to the server.** The
   daemon reaps, unprompted, only a short fixed list of provably-dead or
   provably-unwanted processes of its *own* instance (§6). Everything
   ambiguous or foreign is reported as fact, never touched. There is no
   configurable policy machinery. *Motivation:* keeps it simple, and the
   incident's orphan pile was entirely the "certain" case — so hygiene clears
   it even when the control plane is down, which is exactly when it must.

8. **Hibernation stays server-decided, daemon-executed — unchanged.** Today
   the server parks archived and stale sessions and resurrects on demand; the
   daemon observes (cgroup samples, OOM counters, pressure) and executes. The
   spec codifies this boundary rather than moving it. *Motivation:* it already
   matches the mechanism/policy split; what is broken is the daemon's facts
   (incomplete inventory), not the placement of decisions.

9. **One viewer terminal per session stays.** The headless harnesses' client
   TUI (`opencode attach`, `codex resume`, `grok --resume`) is a per-session
   singleton, warm-parked on detach; browser viewers share its frames through
   the session relay. Multiplayer multiplies *connections*, which the server
   fans out — not processes. *Motivation:* checked against the code; no
   per-viewer process identity is needed, so none is designed.

10. **The binding journal is demoted, not deleted.** It keeps what only it can
    hold — credentials, native session ids, turn epochs, rollout paths — as
    driver-private rebind state. It is no longer an ownership record.
    *Motivation:* it fails as an ownership record by construction (§1) and
    succeeds at rebinding, which is what it was built for.

11. **A reap needs positive evidence of death or unwantedness — never
    absence of knowledge.** The daemon kills on a generation-fenced
    termination intent or supersession mark (§3), not on "I have no row for
    this session": a fresh daemon mid-sync, a server partition, or a pruned
    row for a parked-but-alive session all look like "unknown" and are all
    wrong to kill. *Motivation:* adversarial review; the parked-but-alive
    state is one the server's reconciler explicitly handles and intends to
    revive.

12. **A free lock is evidence, never a verdict — and lock capability is a
    measured fact, not an assumption.** Whether a family's processes retain
    the inherited lease descriptor is recorded per incarnation from a
    retention probe, not asserted from prose; a downgrade to the remaining
    witnesses happens only when the probe fails. Every reap decision
    corroborates with the remaining witnesses before acting. *Motivation:*
    the red-team review proved the original per-family prose *backwards*
    (systemd-run `--scope` execs the payload in place and preserves
    explicitly inherited descriptors; vendored abduco's double fork closes
    its own pipes but not unrelated fds, so master and PTY child retain the
    lease fd) — which is exactly why claims about descriptor fate must be
    measured, never narrated.

13. **The kill boundary is one process-tree incarnation, never a session.**
    Each supervised spawn gets a lease with a globally unique, never-reused
    id and a per-session monotonic generation; **every** family's scope unit
    carries that generation in its name — the terminal family's durable
    abduco label stays session-constant for reattach, but its scope name is
    decoupled from it. *Motivation:* red-team finding 7 and its follow-up —
    with supersession, two incarnations of one codex session overlap in one
    per-session scope, and a scope-wide stop of the superseded one kills the
    successor (the current code already warns about exactly this shape); and
    even without overlap, a session-constant scope name is ABA-reusable, so
    a delayed reaper for a dead incarnation can stop the recycled unit now
    hosting its successor.

14. **A verdict reports what it proved, not what it hoped.** Reap outcomes
    are typed — `verified-empty` (containment enumerated and empty),
    `verified-stamped-set` (every stamped process confirmed gone),
    `incomplete` — and a platform may not claim a stronger outcome than its
    evidence supports. *Motivation:* red-team finding 16 — an env-scrubbed
    double-forked helper on macOS is invisible by the spec's own admission,
    so "process tree empty" there would be a fabricated verification.

## §3 The mechanism: the lease ledger

One per-user, machine-wide directory — the **ledger** — outside every
instance's state directory. It must live on a **local, never-synced
filesystem** (file locks on NFS or a cloud-synced directory are meaningless):
on Linux the user runtime directory; on macOS a caches/runtime-style path,
explicitly not Application Support (some setups sync it).

```
<ledger>/instances/<name>.lock          one per live instance (flock, held for life)
<ledger>/pending/<lease-id>/            leases under construction, private
<ledger>/leases/<instance>/<lease-id>/  one per live supervised process tree
    hold                                immutable inode, flock only, never rewritten
    meta.json                           versioned metadata, replaced by rename
    claim                               reap/operation claim (O_EXCL), when active
<ledger>/sessions/<instance>/<session>/ per-session transaction lock, binding
                                        edges, termination intents
```

**The instance lock.** A booting daemon opens and holds
`instances/<name>.lock` for its lifetime. Held ⇒ the name is taken ⇒ refuse
to boot with a clear error. Because a deleted-and-recreated ledger would let
a second daemon lock a *new* inode while the first holds the old unlinked
one, the daemon re-verifies the device/inode of its held lock every sweep and
fails closed on mismatch (decision 1). Ledger *lease* data, by contrast, is
recoverable: every live process still carries its stamps, and a census pass
rebuilds lost leases marked `reconstructed` — such a lease is permanently
lock-unwitnessed until its process is respawned, and says so.

**A lease is one supervised process-tree incarnation** — not one process.
Its **root** is defined per family (§4 table); launch intermediaries — the
`systemd-run` process that execs in place, the abduco create client, the
double-fork shims — are never leases of their own. Viewer, shell, and build
roots get their own lease exactly when they have an independently killable
lifetime and boundary. Each lease has a globally unique, never-reused id and
a per-session monotonic **generation**.

**Publication protocol** (red-team finding 3, adopted wholesale). The
spawner: creates the lease directory under `pending/` with `O_EXCL`; writes
`hold` and `meta.json` (fsync file, then directory); **acquires the hold lock
before publication**; publishes by atomically renaming into
`leases/<instance>/`; and only then spawns. Nobody may wait on a pathname
opened before publication, and pathname→inode identity is revalidated before
spawn. Abandoned `pending/` entries are recovered by a separate rule (older
than a grace, lock free ⇒ delete) that can never touch a published lease.

**The two-inode rule** (finding 2). `hold` exists only to be locked and is
never rewritten; all mutable state lives in `meta.json`, replaced by the
fsync-then-rename pattern, versioned, with corruption treated as a
record-health fact — never as evidence of death. This is what lets metadata
stay crash-safe while the locked inode's identity stays stable.

**Spawn wiring.** The child receives: the hold descriptor in an explicit
stdio slot, non-CLOEXEC (argv cannot carry a descriptor; each spawn call site
must wire it deliberately); environment stamps inherited by every descendant
— the existing `PODIUM_INSTANCE` and `PODIUM_SESSION_ID`, plus new
`PODIUM_STATE_DIR` and `PODIUM_LEASE` (the lease id). The parent closes its
own copy of the hold descriptor immediately after spawn returns, so a dead
child can never appear alive through the daemon's own fd (finding 4). The
root pid is then captured from an authoritative source per family: scoped
servers use the spawn's `child.pid` — `systemd-run --scope` registers the
scope and execs the payload *in place*, preserving both pid and inherited
descriptors (verified by probe; see the review file's evidence) — and verify
its cgroup membership and start identity; abduco masters are obtained from
the socket protocol and triple-verified; `cgroup.procs` is tree membership,
never root selection (finding 6). The identity triple (pid, start time, boot
id) is stamped into `meta.json`. A published lease still identity-less after
a short grace, lock free, is dead `pending`-style debris.

**Death is detected by the kernel, not by bookkeeping.** A non-blocking lock
attempt on `hold` answers liveness instantly: acquirable ⇒ every holder of
the descriptor is gone. The lock decays with the *last descendant* still
holding it — tree-liveness, the right semantics for reaping. Whether a
family actually retains the descriptor is a **measured per-incarnation
fact** (decision 12): the lease records the result of a retention probe, and
only a failed probe downgrades that incarnation to the remaining witnesses.
Current evidence, recorded not assumed: scoped spawns preserve explicit fds
(probe-verified); vendored abduco retains them in master and PTY child
(source-verified); the server binaries' own fd hygiene is unproven either
way — hence measurement.

**Truth is layered in independent witnesses, ordered by authority:**

| Witness | Answers | Defeats |
| --- | --- | --- |
| the held lock | is the tree alive, right now | stale records, forgotten cleanup |
| the identity triple | is this *that* process | pid recycling, name parsing |
| the env stamp | whose is this stray | missing records, untracked descendants |

On Linux a fourth sits on top: the **scope**. It is the only *inescapable*
witness (survives env-scrubbing and double-forking children) and the only
carrier of memory/CPU budgets and verified whole-tree kill. Per decision 13,
**all** scope units are per-incarnation: `podium-oc-<session>-g<n>` and
likewise for codex/grok and the terminal family — the abduco label stays
session-constant (reattach depends on it; abduco refuses a second master per
label) but the scope *name* is decoupled from it and read from the lease,
never derived from the label. A superseded or ABA-recycled incarnation can
therefore never be confused with its successor, and every scope stop
revalidates the lease's recorded unit and identity under the session
transaction lock before acting. Fresh names per incarnation also retire the
"unit already exists" squatted-name class that today's reclaim code works
around. The `-attach-` infix convention and the exact-match-only rule are
unchanged; names remain an index, the ledger the authority.

**Binding edges and supersession** (findings 8, 14). A session is tied to a
lease by an explicit **binding edge** record with its own generation and
state (`active` | `superseded` | `terminated`); a shared process serving N
sessions has N edges. All edge transitions, lease publications, and
adoptions for one session serialize under that session's transaction lock,
and adoption **compare-and-swaps** the binding generation after its probe —
so an adopter that probed an old incarnation while a spawner published a new
one loses the race detectably instead of silently (finding 8). Rebinding one
session of a shared process flips only that session's edge; a lease is
unwanted only when a transaction proves **zero active edges**. Superseded
incarnations are orphans by definition even while alive and answering — the
92-hour residents of §1 were exactly this shape.

**Termination intents** (finding 9). A kill writes a durable intent
**targeted at an exact lease id and generation** — never at a bare session —
with a state machine: `pending` (fsynced before the first signal) →
`executing` → `verified`, retained for audit. Failed kills retry from the
recorded state; a successor may be spawned while an old intent is pending
because the intent cannot name it. "Kill every generation of this session"
is a distinct, explicit operation. Intents double as tombstones: proof of
unwantedness that survives session-row pruning.

**Probing and the reap claim** (finding 15). Acquiring a free hold proves
death, but a reaper holding it through cleanup would make a concurrent
census read "held" as "alive". So cleanup is governed by a separate **claim**
record (`O_EXCL`, owner, phase, deadline) beside the hold: the census reads
claims and reports `reap-in-progress` instead of lying in either direction,
and two sweepers still cannot double-reap. Expired claims are recoverable.

## §4 The supervision module: facts in, commands out

The module is the only code that touches the ledger, process tables, `/proc`,
and `systemctl`. Its surface is three things:

**Census** (on demand): every lease across *all* instances plus every stray
process carrying a Podium stamp. Each record is **total, with orthogonal
dimensions** (finding 18) — record source and health; owner with attribution
confidence; identity confidence; lock observation (`held` | `free` |
`unwitnessed` | `reap-in-progress`); binding-edge states; containment
evidence (scope / socket / none); lifecycle claim — with explicit `unknown`
and `ambiguous` values, and `foreign` computed relative to the observer.
Every census carries a **coverage statement** (finding 19): which discovery
sources ran (leases, stamp scan, cgroups, sockets, process table) and which
populations each platform can and cannot see — the completeness promise is
"nothing resident-but-invisible *within stated coverage*", and blind spots
(an env-scrubbed macOS descendant; pre-lease legacy processes) are surfaced
as degraded coverage, not silently omitted.

**Verdicts** (executed with proof): `spawn`, `hibernate`, `reap`, `adopt`.
Executed means verified, and outcomes are typed by evidence (decision 14):
`verified-empty` | `verified-stamped-set` | `incomplete`, with `incomplete`
retaining the lease as a residue fact instead of deleting the trail.
Refusals carry reasons; silent partial execution is banned. Invariants no
caller can override: never touch a process owned by another instance;
identity matches exactly or not at all; a reap requires positive ownership
proof; every kill reports what it verified. A reap request against a
*foreign* process is routed to the live owner's daemon; the only exception
is a separate, explicitly named, audited break-glass operator command
requiring exact identity and generation proof and warning when the owner is
live (finding 21) — distinct in name and result type so the normal verdict
set keeps its invariant unconditionally.

**Events** (pushed): process died, kill verified, OOM kill, pressure crossed,
orphan discovered, foreign process observed, supersession, tombstone pending,
reap refused, adoption succeeded/failed. Every event names its **producer
and platform availability** (finding 20): non-child death via a process
handle — `pidfd` on Linux, `kqueue`/`EVFILT_PROC` `NOTE_EXIT` on macOS —
falling back to census delta where handles are unavailable; OOM kills from
cgroup counters on Linux and census-only elsewhere. Events carry ids keyed
by lease generation and a snapshot cursor, with a per-event delivery class
(at-least-once with replay/dedup, or best-effort census-delta), so a
restarted server can tell lost from replayed.

**Drivers plug in three harness-specific fragments** and nothing else — they
never see the ledger or systemd. All probes are **tri-state** —
`responsive` | `unresponsive` | `unknown` (timeout, error, missing
credential) — and a probe result **never authorizes a kill**; positive marks
do (decision 11, finding 10). Probes select graceful versus forced handling
and feed diagnostics.

| Driver | Lease root (per incarnation) | Probe | Graceful stop / adopt |
| --- | --- | --- | --- |
| opencode | the `opencode serve` process | credentialed health endpoint | kill child; adopt = rebind to live incarnation after exact identity + probe, CAS on binding generation |
| codex | the app-server process | socket accepts; root alive | stdin EOF then escalate; adopt = start fresh incarnation, resume from rollout; prior lease superseded in the same transaction |
| grok | the stdio child | root alive; label recomputed-and-compared | stdin end, bounded wait, kill; adopt = fresh incarnation resumes named session |
| terminal families | the abduco master | abduco socket index lists the label | abduco/scope teardown; adopt = reattach to live master (single incarnation by construction) |
| viewer TUIs | the client's abduco master | someone watching (aggregated view signal) | close attachment; reclaimed per warm-park rule |

## §5 Sweep and hygiene

**Cadence:** at daemon boot, every 15 minutes thereafter, and immediately
after every kill it performs. Boot-only is not enough — one affected host had
been up 52 days.

**The hygiene list — the only unprompted reaps, all restricted to leases of
this daemon's own instance, each requiring positive evidence (decisions 11,
12, 14):**

1. **Confirmed dead, then cleaned:** root death is proved first — hold free
   *and* the identity triple matches nothing alive. Then cleanup is a
   separate step (finding 12): attribute the incarnation's containment to
   this lease exactly, take the claim, terminate residual members, verify to
   the platform's honest outcome type, then delete. A non-empty scope does
   not block the reap — it *is* the reap; unattributable or shared
   containment returns ambiguity instead of acting.
2. **Provably unwanted:** the lease carries a generation-fenced termination
   intent or all its binding edges are superseded/terminated —
   **independent of lock state** (finding 11) — and identity is confirmed by
   the witnesses this incarnation actually has. Graceful stop, escalate,
   verify, delete. Arms only after the daemon holds a complete session-table
   snapshot epoch with a completion watermark (a partial or delta exchange
   does not count), and its grace runs on a **first-observed timestamp
   persisted in the lease** (finding 13) — a restarting daemon neither
   resets nor skips it. A session merely *unknown* is a census fact, never a
   kill.
3. **Viewer TUIs** follow the existing warm-park rule, unchanged: an
   unwatched client is *kept* for fast reattach and reclaimed under memory
   pressure or past an age backstop, unwatched first, newest last.

Everything else — foreign leases, stray-stamped processes matching no lease,
lock-unwitnessed-but-alive, session-unknown, anything ambiguous — is census
fact and event, surfaced to the server, which owns all judgment (decisions 7
and 8). (The "no clocks" claim of §3 is scoped to *liveness*: hygiene
legitimately uses persisted wall-clock grace before acting on facts; it never
uses time to decide whether something is alive.)

## §6 Platforms

**Linux:** the full stack — ledger + stamps + per-incarnation scopes/slices.
Budgets, containment and tree-kill exactly as the resource-isolation spec has
them; kill verification enumerates the incarnation's cgroup and may report
`verified-empty`.

**macOS (including the native app hosting server+daemon):** ledger and
stamps are the mechanism; the platform sources are named, not aspirational
(finding 17): boot identity from `kern.boottime`; process start time from
`proc_pidinfo`/`PROC_PIDTBSDINFO`; same-user environment via
`KERN_PROCARGS2`; enumeration via `libproc`; a defined refusal state when an
API is denied. Kill verification reports `verified-stamped-set` at best —
never `verified-empty` — and an env-scrubbed double-forked descendant is a
stated blind spot carried in every census's coverage statement, with the
lease retained as a residue fact rather than deleted (decision 14). The
terminal family is the weakest corner and says so: the master's pid comes
from the abduco socket protocol, is triple-captured, and is revalidated
immediately before every signal. Parking is the memory-pressure tool (no
kernel budgets exist). Per-incarnation launchd jobs are a possible later
strengthening (list-by-label, containment-ish), not a dependency.

**Windows (later):** the portable core is unchanged; Job Objects slot in as
the enforcement backend (kill-on-close, real memory limits) and would restore
`verified-empty`. One honest caveat for then: reading another process's
environment is hard on Windows, so the stray-attribution witness weakens
there; Job Objects' containment compensates.

**Trust domain, stated once:** the ledger is same-user advisory. Any
same-user process *could* delete a foreign lease or scrub its own stamps;
nothing filesystem-level prevents it. The never-touch-foreign invariant is
code discipline enforced in one module — acceptable because every instance
runs the same supervision code, and a hostile same-user process could kill
the processes directly anyway.

## §7 Implementation contract for POD-2691

This section is deliberately a list of *obligations on the implementation
plan*, not the plan itself: POD-2691 must pin each item below, in writing,
before code — the red-team review (finding 23) established that two
reasonable implementers would otherwise make incompatible safety choices.

- **Unify the spawn boundary first.** `systemdScopeArgv` is an argv builder,
  not a spawn seam: every launch site (`abduco.ts` `execCreate`, the three
  server `spawn` calls, `opencode-attach`, every unscoped fallback) owns its
  own `child_process.spawn` and `stdio` array today. The module's first
  deliverable is one supervised-spawn API those sites call, because the hold
  descriptor must ride an explicit stdio slot per site and argv cannot carry
  it.
- **Storage contract:** exact Linux and macOS ledger roots, permissions,
  no-follow rules, lease-id generation, `meta.json` schema and versioning,
  the binding-edge and termination-intent layouts under `sessions/`, and
  crash recovery for every step of the §3 publication and update protocols.
- **Descriptor contract:** the fd number and CLOEXEC state per family, the
  parent close point, the retention probe, and tests in both directions —
  premature child close must read as `unwitnessed`, never as death; parent
  retention must be impossible by construction.
- **Identity contract:** per-family root selection exactly as §3/§4 state;
  the Darwin API set of §6 with permission-denied outcomes; revalidation
  immediately before every signal.
- **Concurrency contract:** the per-session transaction lock ordering across
  spawn, adopt (CAS on binding generation), supersede, tombstone, census,
  and reap; the claim protocol and its expiry.
- **Sync contract:** what constitutes a complete session-table snapshot
  epoch and its completion watermark; which hygiene inputs demand the
  current epoch; persisted grace semantics.
- **Interface contract:** the typed census record with coverage, verdict
  inputs and idempotency keys, typed outcomes and refusals, the event table
  with producers, generations, cursors, and delivery classes.
- **Tombstone lifecycle:** retention, retirement, failed-kill retry,
  successor-spawn policy while an intent is pending.
- **Environment stamps:** add `PODIUM_STATE_DIR` and `PODIUM_LEASE`; the
  other stamps already exist.
- **Scope naming:** per-incarnation units for every family; the terminal
  family passes its session-constant abduco label separately from the scope
  name, and the scope name is recorded in the lease rather than derived via
  `scopeUnitName(label)`. Scope stops revalidate lease unit + identity under
  the session transaction lock. The squatted-name reclaim
  (`reclaimStaleScope`) becomes unnecessary for new spawns and is retired
  with the migration. Update the memory-attribution substring contract
  (`opencode-attach.ts` documents it) for the new names.
- **Journal demotion** per decision 10; adoption keeps its per-driver
  semantics (§4 table) but corroborates against the lease, never the
  journal's process claim. Supersession replaces today's per-driver
  `reclaimIfLast`-style care with one rule.
- **Grok's label** stays display/scope-name only; identity flows from the
  lease (decision 4). Its collision-in-principle is tracked separately
  (POD-2705); the fix must make the label *agree with* the ledger — derived
  injectively from the same session id the lease records — never a second
  identity scheme.
- **Migration and coexistence:** behavior while pre-lease processes and old
  daemons coexist with new ones; instance rename / state-dir moves orphan
  old leases into strays (expected, documented); first run on an afflicted
  machine reports everything as `record-lost`/stray, and the backlog is
  cleared by a one-time documented operator pass — never automated, per the
  never-touch-ambiguity invariant.
- **Acceptance tests** for the named races (publication vs sweep, adopt vs
  supersede, kill vs resume, ledger deletion, claim expiry) on both
  platforms.

*Deleted by this design:* the unrecorded-orphan class (records now precede
processes); pid-recycling kills (exact triples); cross-instance reap risk
(named instances, own-instance hygiene, never-touch-foreign);
session-as-kill-boundary (per-incarnation generations); unverifiable
"verified" claims (typed outcomes); the control plane's dependence on itself
for cleanup (hygiene runs headless); scattered `systemctl`/`/proc` call
sites (one module).
