# Process ownership: the platform's service manager is the authority

Status: design proposal (POD-2694). Implementation: POD-2691. Companion to the
agent-runtime architecture proposal (§9 phase 4: process supervision) and the
resource-isolation spec (`pod-2413-resource-isolation.md`).

## §1 The problem, measured

When Podium runs an agent it starts real programs on the machine — an
`opencode serve` HTTP server, a `codex app-server`, a `grok` ACP child, or a
terminal under abduco. Some of these programs deliberately outlive the Podium
daemon that started them: that is what makes agents survive a redeploy. But
nothing records *which copy of Podium* a program belongs to. Several instances
can run side by side as the same user, and on Linux they all share one systemd
user manager, so a unit name says which **session** a process serves but not
which **instance** started it.

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

The problem decomposes into three needs the incident tangled together:
**attribution** (which instance admitted this workload), **supervision**
(what authoritative boundary contains it and can terminate all of it), and
**product lifecycle** (does anything still want it, and when should it stop).
The first two make the third safe.

## §2 Decision log

Each decision below is part of the design; the motivation is part of the
decision and future changes must engage it, not just the rule.

1. **The owner of record is the platform's resident service manager, and a
   workload's native job exists before its process does.** Every durable
   launch creates a named job in the service manager first; the *manager*
   starts the payload inside it. Podium never starts a durable payload and
   registers it afterwards, and if supervision cannot be established the
   spawn degrades to a non-durable daemon child — never to an unsupervised
   durable process. *Motivation:* three orphans existed with no record
   because the record was a separate write that could be skipped; a job the
   manager creates before exec cannot be. The manager is also the one
   authority that already outlives daemon redeploys, enumerates by name,
   kills whole trees, and carries resource limits — supervision this design
   would otherwise have to rebuild.

2. **Instance identity is an immutable random UUID; the human name is a
   label.** Each state root mints an `instanceUuid` at creation. The short
   operator-chosen name keeps naming commands, paths, ports, and display.
   Two daemons are prevented from opening one state root by a lock inside
   that root; a *copied* state root (same UUID, new location) is detected by
   a per-machine singleton guard keyed by the UUID and must be explicitly
   rekeyed before it may run. *Motivation:* names are chosen by convention
   and collide by convention — two roots both called `default` are the
   measured incident; two roots with one UUID are a backup restored beside
   its original, which no name scheme can even see. Identity must be minted,
   not chosen.

3. **One incarnation, one boundary, one never-reused id.** Every spawn gets
   a fresh `workloadId`; the native job is named from
   `(instanceUuid, workloadId)`; a session is a product binding that points
   at successive incarnations, never a process identity. All destructive
   action targets an exact incarnation through its boundary. *Motivation:*
   session-derived process names are reusable, and a reused name lets a
   delayed kill for a dead incarnation hit its successor; pid-recycling and
   the prefix-match ghost-session scar demand exactness end to end.

4. **Outliving the daemon is a per-driver capability, not a rule.** A
   workload is durable only if a fresh daemon can actually *re-adopt* it:
   an HTTP server it can re-address, an abduco master it can re-attach. A
   child whose only transport is the dead daemon's own pipes is not a
   durable endpoint — it is kept alive by nothing and useful to nothing —
   so it runs as a plain daemon child, dies with the daemon, and its
   *conversation* resumes from the harness's own durable state (named
   session, rollout file) in a new process. *Motivation:* the product
   promise is conversation continuity, not preservation of Unix pids;
   granting survival to unadoptable processes is how work finished 92–160
   hours earlier was still resident.

5. **Desired state lives in the product store; the supervisor reports only
   actual state; the daemon reconciles.** Which incarnation a session wants,
   stop intents, and reference counts for shared workloads are durable
   product records. The supervisor answers "what is running" and executes
   "stop exactly this", idempotently. Reconciliation compares the two and
   retries recorded intents until verified. *Motivation:* a supervisor that
   also stores wants becomes a second product database whose disagreements
   with the first must themselves be reconciled; one desired-state store and
   one actual-state authority leave nothing to drift.

6. **A kill needs positive evidence — never absence of knowledge.** The
   daemon stops a workload on a durable, incarnation-fenced stop intent, or
   when a workload provably owned by this instance has no binding in this
   instance's own store past a persisted grace. A workload that is merely
   *unrecognized* — mid-sync, partitioned, foreign — is a reported fact.
   *Motivation:* a fresh daemon's ignorance must never read as permission;
   the parked-but-alive session is a real state the server intends to
   revive.

7. **Typed outcomes: a verdict reports what it proved.** Stop results are
   `verified-empty` (the boundary enumerated and empty), `job-removed`
   (the manager discarded the job; members not individually proven), or
   `incomplete` — and a platform may not claim a stronger outcome than its
   boundary supports. *Motivation:* a "verified" that outruns the evidence
   is how residue survives while the books say clean.

8. **Mechanism and meaning are separate layers in the code.** One
   supervision module owns every touch of the service manager, process
   tables, and stamps. It exports facts and executes commands with verified
   outcomes; it contains no "when" logic. Product code decides what a viewer
   is or when to hibernate; it never reaches around the module.
   *Motivation:* operator requirement — "not intermingling logic like when
   to hibernate with logic of how to tell the process to do that."

9. **Certain cleanup is daemon hygiene; judgment belongs to the server.**
   The daemon acts unprompted only on the provably-dead and the
   provably-unwanted within its own instance (§5); everything ambiguous or
   foreign is surfaced, never touched. No configurable policy machinery.
   *Motivation:* the incident's orphan pile was entirely the certain case,
   and it must be clearable while the control plane is down — which is
   exactly when it happened.

10. **Hibernation stays server-decided, daemon-executed — unchanged.** The
    server parks archived and stale sessions and resurrects on demand; the
    daemon observes and executes. *Motivation:* the boundary already
    matches decision 8; what is broken is the daemon's inventory, not the
    placement of decisions.

11. **One viewer terminal per session stays.** The headless harnesses'
    client TUI is a per-session singleton, warm-parked on detach and
    reclaimed under memory pressure or an age backstop; browser viewers
    share its frames through the session relay. Multiplayer multiplies
    connections, which the server fans out — not processes. *Motivation:*
    checked against the code; no per-viewer process identity is needed, so
    none is designed.

12. **The binding journal is demoted, not deleted.** It keeps what only it
    can hold — credentials, native session ids, turn epochs, rollout paths —
    as driver-private rebind state. The workload inventory is the service
    manager's. *Motivation:* the journal fails as an inventory by
    construction (§1) and succeeds at rebinding, which is what it was built
    for.

13. **Labels are display; identity is exact.** Harness labels may be lossy
    (grok's squashes punctuation and truncates) and are only ever *computed
    from* a candidate and compared, never parsed backwards. Workload
    identity is the native job name plus the manager's activation identity
    (invocation id where the platform mints one; pid + start time + boot
    identity otherwise). *Motivation:* the ghost-session scar; lossy names
    cannot carry identity and must not be asked to.

## §3 The mechanism: native supervised workloads

One portable interface, deliberately *different* native backends:

```
WorkloadSupervisor
  start(spec)   -> handle   create the native job, manager launches payload
  list()        -> handles  enumerate this instance's live jobs
  stop(id)      -> outcome  idempotent; typed by what was verified
  watch()       -> events   job/process exits, OOM, as the platform reports them
  capabilities()            what this backend can actually promise
```

**Admission.** The daemon allocates `workloadId`, records the product binding
(or desired-state transition) durably, then calls `start`. The backend creates
the job named from `(instanceUuid, workloadId)` with metadata (session id,
family, role, generation) and the manager launches the payload inside it. The
returned handle carries the native job identity and activation identity — not
merely a pid. Every payload also receives environment stamps inherited by its
descendants (`PODIUM_INSTANCE`, `PODIUM_SESSION_ID`, `PODIUM_STATE_DIR`,
`PODIUM_WORKLOAD`): these are diagnostics and stray-attribution aids, never
the authority.

**Linux backend: systemd transient *services*.** A transient service — not a
scope — because the distinction is exactly this problem: a service is created
and launched *by the manager* atomically, with a unique runtime handle, its
control group, journal-captured logs, and the instance's slice and resource
budgets applied at birth; a scope merely wraps a process someone else already
started and registered afterwards. Unit names are
`podium-<uuid8>-<workloadId>.service` under the instance's sessions slice;
enumeration is by computed exact names and slice membership, never prefix
guessing; the invocation id is the activation identity; `stop` is the
manager's own tree-kill with the cgroup read back empty (`verified-empty`).
Two instances cannot collide: their names differ in the UUID segment and
their slices are disjoint.

**The terminal family** runs abduco *foreground*: the vendored program gains
a mode where the master does not daemonize, so it is the service's main
process, supervised like everything else, while the attach path (the
session-constant abduco label and socket) is unchanged. Where **no usable
systemd user manager exists** (containers, unusual shells), the terminal
family falls back to the abduco socket directory — already per-instance —
as its registry: enumerable, reattachable, honestly reported as having no
containment and no `verified-empty`. Other families degrade to non-durable
daemon children there (decision 1).

**macOS backend: launchd jobs**, one per incarnation, uniquely labelled from
`(instanceUuid, workloadId)`, launching foreground payloads in the user
domain (the native app hosting server+daemon uses its sanctioned service
registration path). What launchd can actually promise — which descendants
its job teardown terminates, how it behaves across `setsid`, what the modern
approval flow demands — is **measured by a platform spike before it is
promised** (§7); the backend's `capabilities()` reports what the spike
proved. A family for which no defensible boundary exists on macOS is
declared *resumable but not process-durable* there: the process dies with
the daemon and the conversation resumes from harness state. Honesty about
the boundary beats heuristic process discovery after the fact.

**Windows (later):** Job Objects — kill-on-close, real memory limits,
`verified-empty` restored.

**Adoption.** After a daemon restart, `list()` is the inventory: the daemon
asks the manager for its instance's jobs and reconciles them against the
product store. Adoptable families rebind (opencode re-addresses its server
with journal credentials after exact identity checks; terminals re-attach
the master); everything else was a daemon child and is simply gone, its
sessions resumed on demand. Discovery never depends on a write performed
after spawn, because there is none.

## §4 The supervision module: facts in, commands out

The module is the only code that touches the service manager, process
tables, and stamps. Its surface:

**Census** (on demand): the manager's job list for every Podium instance
UUID present on the machine, joined with this instance's product bindings,
plus any stray process carrying Podium stamps but belonging to no job. Each
record: owner UUID (and whether that is *this* instance), workload id,
session binding state (`bound` | `unwanted` | `unknown`), activation
identity, memory (per-boundary where the platform has one, per-process walk
where not), age, probe result, and a **coverage statement** naming which
discovery sources ran on this platform and what each cannot see. The
completeness promise is scoped to that statement; blind spots are reported
as degraded coverage, not silently omitted.

**Verdicts** (executed with proof): `spawn`, `hibernate`, `reap`, `adopt` —
outcomes typed per decision 7, refusals carrying reasons, silent partial
execution banned. Invariants no caller can override: never touch a job
owned by another instance's UUID (a foreign reap request is routed to the
live owner; break-glass is a separate, explicitly named, audited operator
command with its own result type); identity matches exactly or not at all;
a reap requires positive evidence; every kill reports what it verified.

**Events** (pushed): job exited, stop verified, OOM kill (cgroup counters on
Linux; census-only elsewhere), pressure crossed, orphan discovered, foreign
job observed, adoption succeeded/failed — each sourced from the manager's
own notification where the platform has one, from census deltas where it
does not, and keyed by workload id so a restarted consumer can dedupe.

**Drivers plug in three fragments** and nothing else — they never see the
manager. All probes are tri-state (`responsive` | `unresponsive` |
`unknown`) and select graceful versus forced handling; they never authorize
a kill (decision 6 does).

| Driver | Durable? | Workload root | Probe | Stop / resume |
| --- | --- | --- | --- | --- |
| opencode | yes — re-addressable HTTP | `opencode serve` | credentialed health endpoint | manager stop; adopt = rebind after exact identity + probe |
| codex | no — socket transport, but lifetime was daemon-coupled by design | app-server as daemon child | socket accepts | dies with daemon; resume = fresh child from rollout file |
| grok | no — pipe transport | stdio child of daemon | child alive | dies with daemon; resume = fresh child loads named session |
| terminal families | yes — re-attachable master | abduco master (foreground) | abduco socket index | manager stop (or socket-registry teardown); adopt = reattach |
| viewer TUIs | yes (warm-park) | client's abduco master | watched signal | closed per warm-park rule |

A shared workload (one process, N sessions) is one job with N product
bindings; its reference count is product state, and only an explicit
zero-reference transition emits the stop intent.

## §5 Reconciliation and hygiene

**Cadence:** at daemon boot, every 15 minutes, immediately after every stop
the daemon performs, and on manager notifications where the platform
delivers them. Boot-only is not enough — one affected host had been up 52
days.

**The hygiene list — the only unprompted stops, all restricted to jobs
owned by this instance's UUID, each requiring positive evidence:**

1. **Recorded intent:** a durable stop intent names this workload id —
   execute it (graceful per driver, escalate, verify to the platform's
   outcome type), retrying across daemon crashes until verified, then
   retire the intent.
2. **Provably unwanted:** a job owned by this UUID whose product store —
   this instance's own, at a complete snapshot — shows no active binding,
   past a grace period persisted with the job's metadata. The parked
   session is *bound* (its row exists and intends revival) and is never
   touched by this rule; the terminated-and-pruned session left a stop
   intent (rule 1). What remains here is the true orphan: admitted, then
   forgotten by everything.
3. **Viewer TUIs** per the warm-park rule: kept while parked, reclaimed
   under memory pressure or age backstop, unwatched first, newest last.

Foreign-UUID jobs, stray-stamped processes, and anything `unknown` are
census facts for the server (decisions 6 and 9).

## §6 Platforms and trust

**Linux with systemd:** full guarantees — atomic admission, enumeration,
budgets, tree-kill, `verified-empty`. **Linux without systemd:** terminals
keep durability through the abduco socket registry (no containment,
declared); other families non-durable. **macOS:** whatever the launchd
spike proves, declared per family; parking is the memory-pressure tool (no
kernel budgets). **Windows:** later, via Job Objects.

**Trust domain, stated once:** everything here is same-user and advisory.
A same-user process could remove another instance's jobs or scrub its own
stamps; nothing platform-level prevents it. The never-touch-foreign
invariant is code discipline enforced in one module — acceptable because
every instance runs the same supervision code, and a hostile same-user
process could kill the processes directly anyway.

## §7 Implementation contract for POD-2691

Obligations the implementation plan must pin, in writing, before code:

- **Two gating platform spikes, first.** (1) Linux: start a foreground
  payload plus descendant as a transient user service under the instance
  slice; crash the daemon; enumerate the exact unit and invocation id; stop
  it; prove the cgroup empty; repeat across a user-manager re-exec.
  (2) macOS: bootstrap a uniquely labelled foreground launchd job plus
  child; crash the hosting app/daemon; enumerate by exact label; remove the
  job; measure which descendants are actually terminated, including one
  that forks, calls `setsid`, or scrubs its environment; exercise the
  approval flow the native app requires. The macOS capability table ships
  from these measurements, not from documentation.
- **Unify the spawn boundary.** Every launch site (`abduco.ts`, the three
  server drivers, the viewer-attach path, every fallback) today owns its
  own `spawn` call; the module's first deliverable is the one
  `WorkloadSupervisor.start` seam they all call.
- **abduco foreground mode** in the vendored program, with attach and
  socket behavior preserved, plus the socket-registry fallback backend.
- **Instance UUID migration:** mint into existing `instance.json` roots on
  first boot; the per-machine singleton guard; the explicit rekey command
  for copied roots; UUID segment in unit/job names.
- **Driver durability declarations** and the changed restart semantics for
  daemon-coupled families (codex, grok): daemon shutdown ends them
  gracefully; resume paths exercised from harness state.
- **Desired-state additions** in the product store: workload ids on
  bindings, idempotent stop intents with retry-until-verified, shared
  workload reference counts.
- **Interface contract:** typed census with coverage, verdict outcomes and
  refusals, event sources and dedupe keys per platform.
- **Grok's label** stays display-only; identity flows from the job name
  and activation identity (decision 13). Its collision-in-principle is
  tracked separately (POD-2705); any fix derives the label injectively from
  the same session id the job metadata records.
- **Migration and coexistence:** legacy scope-named processes from before
  this design are imported by a one-time, conservative, documented operator
  pass — never automated; behavior while old and new daemons coexist;
  instance rename leaves UUIDs (and therefore ownership) untouched by
  construction.
- **Acceptance tests** for the named races (admission vs crash, stop-intent
  retry vs resume, copied-root rekey, manager restart) on both platforms.

*Deleted by this design:* the unrecorded-orphan class (the job precedes the
process); pid-recycling kills (exact ids + activation identity);
cross-instance reap risk (UUID-disjoint names and slices, never-touch-
foreign); name-collision outages (names are labels, identity is minted);
survival for processes nothing can re-adopt (per-driver durability); a
second desired-state store inside the machine runtime (one product store,
one actual-state authority); scattered spawn sites (one seam).
