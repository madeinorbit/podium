# Spec: supervisor-owned machine presence

Status: AGREED with Michael, 2026-08-26 (rev 4; grilled interview + adversarial review).
Implementation note: keep this work on a separate long-lived branch, apart from the normal
code line — the current updater goes to prod first; this lands only afterwards, when
confidence is established. Base design: POD-2861 artifact 1,
"Supervisor-owned machine presence design", adopted in full; this spec adds the decisions
that note left open, settled in the POD-2882 interview.

Base pinning: this spec is written against the **post-cutover updater** state (the
POD-2462 cutover). The §1 deletion list names code that exists on that base, not
necessarily on today's main. Timing: POST-CUTOVER work; must not land while ludovico is
soaking on the new updater.

## 1. Adopted base (from the POD-2861 design note)

- One authenticated machine-supervisor WebSocket (provisionally `/machine`) on the Podium
  parent owns fleet identity, running payload version, update participation
  (grants/status), and a declaration of configured services. The daemon connection narrows
  to agent execution (sessions, PTY, inventory, agent control). Two physical connections
  when agents are enabled; shared transport machinery, different lifetimes.
- Pairing enrolls the supervisor; the machine credential lives above the daemon. Daemon
  enable/disable/wipe/crash never erases enrollment.
- The machine version used by fleet convergence is the running supervisor payload version.
  The Tauri shell keeps its separate component version/updater.
- Update grants route to the supervisor; the parent runs the shared grant workflow and the
  fenced self-handover (old attachment cannot detach the successor).
- Deletions after the compatibility window: `local-participant.ts` + wiring,
  `attachUpdateParticipant`/`detachUpdateParticipant`, the update-grant special case in
  `toMachine`, the `daemons || updateParticipants` online definition, daemon ownership of
  build/version/update-delivery reporting, daemon-driven presence/last-seen writes, direct
  Desktop daemon spawning (Desktop supervises the parent instead).

## 2. Service control: server-driven with a local lockout

**Scope.** The "does this machine host agents / a server" assignment is **per-machine**.
It belongs to the machine record, not to a user or a process instance. In a future
multi-user world it is managed by the user(s) with machine-management permission; that
permission model is explicitly deferred (see §8).

**Model.** The server is the **single configuration source**: each machine has a
server-side **service assignment** saying what it should run. The only local input is a
**disable-only lockout** — one bit meaning "never run agents on this machine" — which the
server cannot override. The lockout is not a parallel config source: it only subtracts,
and the supervisor reports it truthfully ("agents refused by local policy") like any other
fact.

**Lockout mechanics and threat model.** The lockout lives in the machine's local Podium
config, writable only with local admin rights (root/owner-only file permissions). Setting
or clearing it is reported to the server on the next report, so a change is visible in the
fleet. The claim is scoped to an **honest server**: it protects against remote
misconfiguration and prevents any server-side operation from enabling agents. A
compromised update chain can ship a payload that ignores it; defending against a hostile
server (signature pinning, attestation) is out of scope and stated as such.

- **Onboarding:** enrollment mints a **default assignment (agents on, no server)**; the
  join command and ceremony are untouched. **Known v1 limitation (accepted):** there is no
  supported way in v1 to enroll a machine that never runs agents — no mint-time picker and
  no supported assignment edit; the lockout exists but is not yet a documented first-class
  control. The mint-time "server only / with agents" picker is future work. Bootstrap of
  the first/primary server machine is a local setup fact, outside this control path.
- **Server transfer (POD-1885):** the live server reassigns services through the same
  mechanism; the transfer epic decides its own choreography on top.

**Resolution — apply at restart, never live.** At parent startup the effective service set
is computed: the server assignment minus anything the local lockout forbids. The
assignment is cached in **supervisor-owned local state** (see §2a) so an unreachable
server means "run the last-known assignment"; a machine with no cache and no reachable
server runs what local setup configured (it cannot have an assignment it never fetched).
The supervisor report states what is actually running and whether the lockout applied.
Changing the assignment or the lockout mid-run does nothing live; the UI renders
assignment ≠ running as "changes on restart". There is **no drain, no live stop or start
of the daemon, and no special handling of running agent sessions**. Consequence, stated
plainly: remotely disabling agents takes effect only at the next parent restart; stopping
a misbehaving agent host *now* means restarting or killing the parent on the machine
itself.

**V1 operational scope.** What matters now is that a machine can run **server-only,
daemon-only, or both**, and that this is truthfully visible in the fleet. Editing the
assignment (UI or API) beyond the enrollment default is not required for v1.

## 2a. Joining and credentials move to the supervisor

Today the pair code is redeemed inside the daemon's connect loop and the minted machine
credential lands in daemon-owned state (`~/.podium/daemon.json`) — which is why a
server-only or agents-off machine could never join (POD-2668). In this design:

- pair-code redemption moves to the **supervisor's** connect loop;
- the minted machine credential (machineId, token, pinned `updatePubkey`) is stored in a
  **supervisor-owned state file**, which also holds the cached service assignment;
- the daemon receives the credential **from the parent** (spawn-time handoff, e.g.
  env/IPC), never from its own file. The supervisor is the **single writer** for the
  credential; rotation and re-pair update one place.

**Migration of already-enrolled machines (mandatory).** The server refuses to re-pair a
known machine and pair codes are single-use, so a new supervisor with no credential can
never get one. On first run, the parent must **import** the existing `daemon.json`
credential — machineId, token, and the `updatePubkey` pin (which the supervisor now needs
to verify update artifacts) — into its own state, then treat `daemon.json` as legacy.
Without this, every existing machine goes dark on upgrade. During the window, standalone
old daemons keep using their own copy; a machine is never in a state where both sides
rotate the credential independently (rotation is supervisor-only once a supervisor exists).

The visible ceremony — mint a code in the UI, paste one install command, single-use code —
does not change, and no service choice is carried in the join token. Desktop's own reads
of `daemon.json` (this-machine marking, hosting card) must move to the supervisor state,
and Desktop's config vocabulary gains the supervisor-only/zero-child launch shape; the
pairing-UX fixes remain on POD-2859.

## 3. Online, offline, grace — and updating

- **Online** = an authenticated supervisor socket is attached now.
- **Offline** = no supervisor attachment for longer than a short grace period (~30 s).
  The planner and UI use the same predicate. During the compatibility window the **same
  grace applies to the legacy daemon-presence fallback**, so a row never has two offline
  predicates.
- `MachineWire.online` keeps its name with the new meaning; `lastSeenAt` becomes the
  supervisor's last observed time (during the window: the last observed time of whichever
  path currently represents the machine, and the row says which path that is).
- **Updating is its own expectation window:** when the planner has issued a grant to a
  machine, that machine is *expected* to disconnect for the swap. The planner treats it as
  `updating` with its own (longer) timeout keyed to the grant, not as offline-deferral. If
  the successor never attaches within that timeout, the wave records a failed update for
  that machine; the generic offline rule applies only after the grant window closes.
- The wave planner's existing rule — defer offline machines — is otherwise unchanged.

## 4. Present but cannot-take-delivery

A connected supervisor with no usable update-delivery capability (e.g. a dev install) is
**not** offline and does **not** get the offline deferral. The wave planner targets it,
records it in the wave result as `cannot take delivery: <reason>`, and the **wave
completes**. Visible, non-blocking.

## 5. Report vocabulary: two separate fields

The supervisor hello/report keeps **two distinct fields**, not one merged token bag:

1. `deliveryCaps` — unchanged, narrow, planner-only: update-delivery mechanisms such as
   `update.delivery.feed`.
2. A **structured service report** for `server` and `agentExecution` with configured
   intent and observed state, so "off by choice" and "broken" are distinguishable:

```
agentExecution: {
  policy: "enabled" | "disabled",
  state: "starting" | "available" | "refused" | "stopped",
  reason?: string,
  observedAt: string
}
```

The `server` service uses the same shape. The server joins the declaration with its own
observation of the daemon socket: `available` requires both an enabled declaration and an
attached daemon plane. The last report is persisted for offline display; live availability
derives from live attachments.

## 6. Fleet rendering — four row states, degraded covers every service

- **Online** — all assigned services healthy; agent availability shown quietly.
- **Online · Agent hosting off** — "Disabled on this machine"; the conscious choice
  (assignment off or lockout; the row says which).
- **Online · Degraded: <service>** — **any** assigned service (server *or* agents) that is
  refused/stopped, with the durable reason and a recovery action. A crashed assigned
  server renders here, not as healthy. (This is the state POD-2852 could not see.)
- **Offline · Last seen …** — only when the supervisor connection is absent.

Agent pickers use the new execution status. Update controls use machine online/delivery
state. There is **no machine-local "can't reach server" indicator**: every client talks to
the server, so the fleet UI — which knows which machine the client is on — is where "this
machine is offline/degraded" appears. POD-2852 is covered by supervisor presence plus this
rendering.

## 7. Supervised bit, crash ownership, and the Desktop updater boundary

The stored server-side machine `supervised` updater-policy flag is **deleted**. Who
restarts the parent after a crash (Desktop shell, systemd, nothing) is a purely local
runtime fact; the supervisor may mention it in its report as display-only information.

The flag is load-bearing today: it excludes Desktop-shell-owned installs from payload
waves so the wave updater and the Tauri updater never race over one signed bundle. That
exclusion **must survive the deletion**, re-expressed through the report: a Desktop-shell
install kind does not advertise payload `deliveryCaps`, so the planner sees
`cannot-take-delivery (managed by Desktop updater)` (§4) instead of consulting a stored
bit. No server decision depends on crash ownership; wave exclusion depends on install
kind/delivery caps.

## 8. Deferred / out of scope

- **Permission model for the assignment**: deferred; the operation is privileged
  (machine-owning users), v1 ships single-user with no new permission machinery.
- **Editing the assignment, mint-time service picker, lockout as documented first-class
  control**: future work (see §2 known limitation).
- **Pairing-ceremony UX** (spent codes, visible refusal, stale records): stays on
  POD-2859.
- **Live actuation / drain** on policy change: explicitly rejected.
- **Hostile-server defenses** for the lockout (signing/attestation): out of scope.
- **Chronic-degradation escalation** (age shown on degraded rows, repeated wave-skip
  nagging): noted as desirable, deferred.

## 9. Compatibility window

Fixed **3 months** from the release that ships supervisor presence. During the window:

- the legacy fallback stays: a daemon socket counts as presence and can receive grants —
  but **only while no supervisor is attached** for that machine;
- while a supervisor is attached, **legacy daemon writes of version, deliveryCaps, build
  and lastSeen are suppressed** — otherwise an old daemon's reconnect would silently
  revert the row the planner reads (one row, one writer);
- a grant is **single-path for its whole lifetime**, keyed by grantId: issued on one path,
  its status/verdict is accepted from either socket of the same machine but it is never
  re-issued on the other path; a supervisor attach is not a re-issue trigger;
- a machine that downgrades to a pre-supervisor build rides the legacy path (its row notes
  the legacy source). After the window closes, such a machine simply renders **Offline**;
  its enrollment persists, and recovery is a payload reinstall, not a re-pair.

**Migration path for running systems.** The same window covers live fleets, in order:

1. **Server first.** The server ships understanding both presence paths (supervisor
   preferred, legacy daemon fallback) before any machine changes. Nothing on machines
   breaks when it lands.
2. **Machines via normal update waves.** A payload update turns each running install into
   the parent-supervised shape: on first start the new parent imports the `daemon.json`
   credential (§2a), attaches the supervisor socket, and launches the daemon as its child
   per the effective assignment. A running old daemon is replaced by the update's normal
   restart — no extra ceremony, no re-pair, no fleet gap beyond the ordinary update
   restart (covered by the `updating` window, §3).
3. **Server-only machines** (today's local-participant case, POD-2668) get the same
   payload update; their parent attaches supervisor-only and they become first-class
   fleet members.
4. Machines that stay powered off past the 3-month window rejoin by installing a current
   payload; enrollment persists (§9 downgrade rule), so recovery is reinstall, not
   re-pair.

After 3 months the legacy path and the §1 deletion list are removed.

## 10. Acceptance

Multi-instance lane with independent runtimes:

1. All four topologies (server-only, daemon-only, all-in-one, supervisor-only) enroll,
   appear online, and take updates — server-only pairing end-to-end proves the POD-2668
   fix.
2. Kill/refuse the daemon under a connected supervisor → **Online · Degraded: agents**,
   still takes an update.
3. Kill the assigned server service → **Online · Degraded: server**.
4. Disable agents deliberately (assignment/lockout) → same update eligibility with
   choice-specific copy; set the lockout, restart, verify "refused by local policy" and
   that the server assignment cannot override it; clear it, verify the change is reported.
5. Disconnect the supervisor → unchanged offline deferral after the grace.
6. Grant an update → machine passes through `updating` without flapping offline; abort
   path resumes the old parent within the grant window.
7. Upgrade an enrolled legacy machine → credential (incl. `updatePubkey`) imported from
   `daemon.json`, no re-pair, no duplicate row; while supervisor attached, old-daemon
   reconnect does not revert version/caps.
8. Dev install with no delivery caps → wave completes with `cannot take delivery` flagged.

Because this changes identity, endpoints, ownership and lifecycle, the implementation
requires the multi-instance lane in addition to focused protocol/store tests.
