# Process ownership: every agent process has an owner, and the owner can prove it

Status: agreed design (POD-2694). Implementation: POD-2691. Companion to the
agent-runtime architecture proposal (§9 phase 4: process supervision) and the
resource-isolation spec (`pod-2413-resource-isolation.md`). Decided with the
operator on 2026-08-24; the decision log in §2 records what was chosen and why.

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
   start if the name is held. The name↔state-directory binding is already
   enforced by the `instance.json` marker. *Motivation:* the measured
   ambiguity came entirely from multiple unnamed instances sharing one unit
   namespace; naming them makes every downstream mechanism unambiguous.

2. **Ownership is recorded at birth, before the process exists.** The spawner
   creates the ownership record first and creates the process *from* it.
   *Motivation:* the record-written-afterwards design is how three orphans came
   to exist with no record at all. A step that can be skipped will be skipped;
   a step the process is born from cannot.

3. **The record's truth decays with the process itself.** The process holds a
   lock on its own record; the kernel releases it at death. No heartbeats, no
   TTLs, no clocks. *Motivation:* every stale-record failure in the current
   system (journal naming a dead or recycled pid) comes from records whose
   truth is maintained by code that has to remember to run.

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
   provably-orphaned processes of its *own* instance (§6). Everything
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

## §3 The mechanism: the lease ledger

One per-user, machine-wide directory — the **ledger** — outside every
instance's state directory, holding two kinds of entries. On Linux it lives in
the user runtime directory (cleared each boot); on macOS under the user's
Application Support. Stale files surviving a reboot are harmless by
construction: their locks are free and their identity triples name an old
boot.

```
<ledger>/instances/<name>.lock        one per live instance
<ledger>/leases/<instance>/<lease>    one per live Podium-spawned process
```

**The instance lock.** A booting daemon opens and holds
`instances/<name>.lock` (flock, exclusive) for its lifetime. Held ⇒ the name
is taken ⇒ refuse to boot with a clear error. This is decision 1, implemented
by the same primitive as everything else.

**A lease** is not a note about a process; it is a thing the process holds.
Spawning any agent-side process — engine, viewer TUI, shell, build — goes
through the supervision module, which:

1. **Writes the lease file**: instance name, state directory, session id(s),
   role (`agent` | `viewer` | `shell` | `build`), driver kind, spawn time.
2. **Opens and locks it** (flock; the lock belongs to the open file
   description).
3. **Spawns the child** with that descriptor inherited, and with environment
   stamps inherited by every descendant: the existing `PODIUM_INSTANCE` and
   `PODIUM_SESSION_ID`, plus new `PODIUM_STATE_DIR` and `PODIUM_LEASE` (the
   lease path).
4. **Stamps the identity triple** (pid, start time, boot id) into the lease.

If the daemon dies between 3 and 4, the lease already exists and is held; the
process is findable by its `PODIUM_LEASE` stamp. There is no window in which a
Podium process exists unrecorded — that is the entire fix for "orphan with no
journal entry". A lease still identity-less after a short grace is treated as
dead.

**Death is detected by the kernel, not by bookkeeping.** A non-blocking lock
attempt on a lease answers liveness instantly: acquirable ⇒ the holder is dead
⇒ the lease is garbage and whatever it names is reap-work. A harness that
closes inherited descriptors merely downgrades itself from the lock witness to
the triple witness — still correct, just checked rather than instant.

**Truth is three independent witnesses, ordered by authority:**

| Witness | Answers | Defeats |
| --- | --- | --- |
| the held lock | is it alive, right now | stale records, forgotten cleanup |
| the identity triple | is this *that* process | pid recycling, name parsing |
| the env stamp | whose is this stray | missing records, untracked descendants |

On Linux a fourth sits on top: the **scope/slice**. It is the only
*inescapable* witness (survives env-scrubbing and double-forking children) and
the only carrier of memory/CPU budgets and verified whole-tree kill. Scope
unit names remain exactly as today (`podium-<session>`, `podium-oc-<id>`,
`podium-cx-<id>`, `podium-gk-<key>`, attach infix `-attach-`), remain
exact-match-only, and are an index — the authority is the ledger.

## §4 The supervision module: facts in, commands out

The module is the only code that touches the ledger, process tables, `/proc`,
and `systemctl`. Its surface is three things:

**Census** (on demand): every lease across *all* instances plus every stray
process carrying a Podium stamp, each with owner instance, session, role,
identity triple, liveness (lock state), responsiveness (the driver's probe),
memory (per-tree via cgroup where scoped, per-process walk where not), age,
and binding state: `bound` | `record-lost` | `foreign`. Completeness is the
point: nothing may be resident-but-invisible, which is the failure that
produced the 1.6 GB pile.

**Verdicts** (executed with proof): `spawn`, `hibernate`, `reap`, `adopt`.
Executed means verified — a reap reports "process tree empty, lock free,
lease deleted", not "signal sent". Refusals carry reasons; silent partial
execution is banned. Invariants no caller can override: never touch a process
owned by another instance; identity matches exactly or not at all; a reap
requires positive ownership proof; every kill is verified. Policy mistakes
cost a respawn, never someone else's live agent.

**Events** (pushed): process died, kill verified, OOM kill, pressure crossed,
orphan discovered, foreign process observed, adoption succeeded/failed.

**Drivers plug in three harness-specific fragments** and nothing else — they
never see the ledger or systemd:

| Driver | Process plan (per session) | Responsive means | Graceful stop / adopt |
| --- | --- | --- | --- |
| opencode | one HTTP server; optional viewer TUI | credentialed health endpoint answers | kill child; adopt = rebind to live server after exact identity + probe |
| codex | one app-server on a unix socket | socket accepts; child alive in its scope | stdin EOF then escalate; adopt = start fresh, resume from rollout (never rebind) |
| grok | one stdio child | child alive; identity key recomputed-and-compared | stdin end, bounded wait, kill; adopt = fresh child resumes named session |
| terminal families | one abduco master (PTY inside the scope) | abduco socket index lists the label | abduco/scope teardown; adopt = reattach to live master |
| viewer TUIs | singleton per session, warm-parked | someone is watching (aggregated view signal) | close attachment; first to go under pressure |

A plan may declare one process shared by N sessions; the module's only rule
there is *reap requires zero live ties*.

## §5 Sweep and hygiene

**Cadence:** at daemon boot, every 15 minutes thereafter, and immediately
after every kill it performs. Boot-only is not enough — one affected host had
been up 52 days.

**The hygiene list — the only unprompted reaps, all restricted to leases of
this daemon's own instance:**

1. Lock free (holder dead): collect surviving process-tree remains, delete the
   lease.
2. Lock held, but the lease's session is terminated or unknown to this
   instance, *and* the driver's probe confirms nothing is being served, on two
   consecutive sweeps: graceful stop, escalate, verify, delete.
3. A viewer TUI whose watching connection is gone (per decision 9's signal):
   close it. Cheap to respawn, first to reclaim.

Everything else — foreign leases, stray-stamped processes matching no lease,
anything ambiguous — is census fact and event, surfaced to the server, which
owns all judgment (decisions 7 and 8). An operator command exists to reap a
reported foreign/stray process explicitly.

## §6 Platforms

**Linux:** the full stack — ledger + stamps + scopes/slices. Budgets,
containment and tree-kill exactly as the resource-isolation spec has them;
kill verification reads the cgroup empty.

**macOS (including the native app hosting server+daemon):** ledger and stamps
are the mechanism, whole and correct — witnesses 1–3, kill lists built from
stamped descendants, parking as the memory-pressure tool (no kernel budgets
exist). Honest limitation, stated rather than papered over: a descendant that
scrubs its environment and double-forks is invisible; there is no containment
to catch it. launchd jobs are a possible later strengthening (list-by-label),
not a dependency.

**Windows (later):** the portable core is unchanged; Job Objects slot in as
the enforcement backend (kill-on-close, real memory limits).

## §7 Migration notes for POD-2691

- Add `PODIUM_STATE_DIR` and `PODIUM_LEASE` to the spawn environment; the
  other stamps already exist.
- Route all spawn paths through the lease steps of §3 — they already funnel
  through one scope builder, which is where the module grows.
- Instance-name lock at daemon boot; refuse duplicates. Existing
  `instance.json` marker semantics unchanged.
- Demote the per-driver journals per decision 10; adoption keeps its exact
  per-driver semantics (§4 table) but corroborates against the lease, not the
  journal's process claim.
- Grok's label stays as a display/scope name only; identity flows from the
  lease and the recompute-and-compare rule (decision 4). The label's
  collision-in-principle between sessions is tracked separately (POD-2705);
  its fix must make the label *agree with* the ledger — derive it injectively
  from the same session id the lease records (e.g. suffix a short stable hash
  of the full id) — never introduce a second identity scheme beside the
  ledger.
- First run on an afflicted machine: the sweep reports everything stamped or
  scoped as `record-lost` (nothing has leases yet); a one-time operator pass
  reaps the backlog. Pre-lease orphans carrying no stamps at all can only be
  identified by scope-name convention — that pass is manual and documented,
  not automated, per the never-touch-ambiguity invariant.

*Deleted by this design:* the unrecorded-orphan class (records now precede
processes); pid-recycling kills (exact triples); cross-instance reap risk
(named instances, own-instance hygiene, never-touch-foreign); the control
plane's dependence on itself for cleanup (hygiene runs headless); scattered
`systemctl`/`/proc` call sites (one module).
