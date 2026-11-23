# ADR 12: One home for every write

| Field | Value |
|---|---|
| **Status** | Accepted 2026-11-04 (D1 on 2026-11-03). Committed by plan Task 1 as `docs/adr/0012-one-home-per-write.md` |
| **Date** | 2026-11-03 |
| **Issue** | POD-6241 (stuck optimistic write; nulldisk folder) |
| **Builds on** | ADR 1 (per-row conflict rules), ADR 2 D8 (provenance on the envelope) and D10 (one transaction), ADR 3 (contracts, delivery classes, outbox states), ADR 9 (principals) |
| **Evidence** | Issue artifacts `sync-receipt-findings.md`, `write-confirmation-plan.md`, `linear-comparison.md`, `command-census.md`, `effects-research.md` |

## Context

**The defect.** A layout write that the server had already applied stayed in a Mac client's
outbox. It was replayed over every collapse, so the nulldisk folder kept reopening. The cause:
nothing retires an applied write by data. Each feature guesses with its own rules:

- the layout controller holds the write and refetches;
- the pool uses `coveredBy`, a moved-past check and a 60 s timer.

**What the census found** (dev/mw `2934831ff6`):

- **219 commands; 178 of them write.** Synced data is written through about 180 routes. Only 26
  are queued by the outbox. About 150 are plain requests, from the apps, the CLI, MCP and the
  daemon relay.
- **22 command registries plus the session command plane**, each its own wrapper. Only three
  deduplicate retries. `layout.set`, `layout.clear` and `settings.updatePersonal` don't. Layout
  writes its row and its change-log entry in two transactions.
- **Contracts are declarations only.** Nothing ties an "outbox" or "offline-eligible"
  declaration to behaviour. 44 non-outbox commands are declared offline-eligible and never
  queued. `pins.set`, `tabs.setOrder` and `settings.updatePersonal` go through the outbox, but
  their data is not synced: the app refetches it after every write.
- **Provenance is dropped** at eight places between the Authority and the client decoder.
  Command replies carry no position in the change log.
- **The "effect with a status" idea exists three times, built separately:**
  - chat delivery status on `message` records;
  - the Operations engine (POD-2097), used only for software update and server move;
  - automation runs.

  Agent lifecycle commands (create, stop, kill, hibernate, resume) record no intent at all. They
  act inside the request.

**Prior art** (details in `effects-research.md`). Linear, Zero, Convex, the transactional
outbox, Kubernetes controllers, Google AIP-151, Stripe and Temporal agree on one shape:

- the client only writes data;
- effects run after commit, triggered by the committed record;
- executors are safe to run twice, keyed by the record's id;
- progress and results come back as data;
- there is one standard outward shape for operations.

Linear covers data edits only. Podium also drives processes on machines, so it needs the effect
half as well.

## Terms

- **Synced data:** records copied to every device's local replica through the feed (the entity
  kinds in `MetadataEntityKind` and the client replica's kind map).
- **Write:** anything that changes server state.
- **Effect:** a change outside the database: a process, a terminal, a file, git, a cloud machine.
- **Executor:** the code that carries out an effect: a server worker, the daemon, or the
  Operations engine.

## Decisions

### D1. Where each kind of data lives (decided here; replaces POD-5802's open question)

**Five homes** (POD-5620's, as written in `docs/agents/frontend-data.md`):

| Home | Holds | Saved on a person's device | Written by |
|---|---|---|---|
| **Synced records** (the pool) | Lasting state with an id that lists, badges, sorting or logic need for every item | yes | spec fields by people and agents (D2); status fields by the server or daemon only (the Authority) |
| **LiveStore** | Conditions: readings of the present that go stale with time (online, load, quota, presence) | never | the server or daemon, pushed to subscribers |
| **Live streams** | Ordered real-time logs and edits while someone watches: transcript, reply preview, terminal, draft keystrokes | bounded history where useful (POD-5801) | the daemon or the editing device |
| **Request answers** | One-off answers for one screen | no | nobody (read-only) |
| **UiStore** | This device's screen state | this device only | the device |

**Outside the homes:**

- **Server-internal data is never sent:** heartbeats, classifier bookkeeping, dedup receipts.
- **Secrets never reach a person's device or synced data.** The app learns only whether a secret
  is set (`secretPresence`). A secret may go to the daemon of a machine that needs it (an agent's
  API key, a git token), over the daemon's authenticated channel and only to machines the owner
  allows. It is never written back into records or logs.

**Spec and status on one record (Kubernetes).** Each field of a synced record has one kind of
writer:

- **Spec:** written by people and agents. Examples: a machine's name, owner and grants; a
  session's desired state (D5).
- **Status:** observed by the server or daemon. Examples: installed tools, a checkout's branch,
  a session's process status.

Status fields sync like any other field, but clients never write them. To change the outside
world, a client issues an effect (D5), and the status follows. A record can be all status:
`issueGitState` is a "server-maintained git observation (ADR 4 D7.4)", and a checkout record
would be too.

**What separates a synced record from a LiveStore value.** It is not "only the latest reading
counts": synced records also hold only the current state. The deciding question is whether the
value is **lasting state** or a **condition**:

- **Lasting state** changes because something happened, and stays until something else happens:
  a session exited, an issue closed, a branch checked out, an agent waiting for an answer. A copy
  read later is right as of when it was saved, and sync replays whatever changed it since.
- **A condition** is a reading of the present that can change by itself at any moment: online or
  offline, load, quota left, ping, who is watching, "reconnecting". Its value goes stale with
  time even when nothing is recorded. A saved copy is untrustworthy exactly when you cannot
  refresh it (offline, or at startup), and honest code shows "unknown" until a fresh reading
  arrives.

Conditions always go in the LiveStore, however widely they are needed. When many screens need
one, it is kept subscribed for the whole time the app is open: the set is small (a handful of
machines, one quota per account) and costs nothing in the sync log. The same reasoning made
Kubernetes move node heartbeats into separate Lease objects, and makes Slack's presence a
subscription that ends with the connection.

Lasting state is a synced record when lists, badges, sorting or logic need it for every item, and
a request answer when only one open screen needs it.

**The check: would a saved copy still be right when read offline tomorrow?**

- **"Session exited": yes.** It stays exited until something happens, and sync replays anything
  that did. If it were live-only, the sidebar could not show it offline, and an agent that exited
  while your phone slept would look alive. So it is synced.
- **"Machine online": no.** By tomorrow it means nothing, so it is a condition. The LiveStore
  holds `{ online, since }` per machine for the whole session, and starts as unknown.
- **A machine's full process list** is a condition needed by one screen at most. It is never
  synced.

**Examples:**

| Data | Changes | Needed by | Home |
|---|---|---|---|
| Session process status (starting, live, exited) | a few times per session | every session row, attention, whether a message can be delivered | synced status (as today) |
| Agent state (working, waiting for you, idle) | per turn | sidebar badges, "needs you" for all sessions | synced status: lasting until the turn moves on |
| A machine's full process list | every second | a diagnostics screen at most | not synced; LiveStore while that screen is open |
| Machine online or offline, with since when | on connect or disconnect | spawn picker, session rows, everywhere | LiveStore, subscribed all the time; unknown until the first reading |
| Machine CPU and memory | every second | the machine panel's gauge | LiveStore |
| A checkout's branch, head commit, ahead or behind, dirty flag | per commit or checkout | every worktree row, merge readiness | synced status (a checkout record, like `issueGitState`) |
| Changed-file list, diff, file contents | constantly while an agent edits | the diff screen | request answer, refetched on `checkout.changed` while open |
| Quota, including "used up until 15:00" | per agent request | the header, always | LiveStore, subscribed all the time |
| A session's "reconnecting" | when its machine's connection drops | the session row | derived on the device from the machine's LiveStore connection; moves out of the synced `status` |

Podium never keeps a machine's process list in sync. The only processes it records are its own
(agent sessions, shells), as one status field on records it already has. For git it keeps a
handful of facts per checkout, never file lists, diffs or history.

**Refreshing an open request answer** (POD-6645; ADR 7 Amendment 2 D19/D26): its
view model declares the signal that makes it refetch. Checkout answers subscribe to
`checkout.changed`, a value with an empty payload whose shared `(epoch, seq)` is the
version. Cost answers follow related session turn ends and issue-stage changes in the
pool. Where no producer can signal, the declared fallback is focus or visibility.
Request answers never poll. Memory breakdown and reclaim readings use the demand-bound
`machine.processes` value topic instead of repeated requests.

**Placement order** (the first yes decides):

1. **A secret?** It never goes to a person's device or into synced data; a daemon may receive it
   as above.
2. **Meaningful on this device only?** UiStore. VS Code Settings Sync keeps `machine`-scoped
   settings local in the same way.
3. **Content whose truth lives outside our database** (files, diffs, file lists, process lists,
   transcripts)? A request answer or a live stream. Only the facts that lists and logic need
   become status fields on a record.
4. **An ordered log or a stream of edits?** A live stream while watched, with a bounded history;
   older parts come by request.
5. **A condition: a reading that goes stale with time** (online, load, quota, presence, ping)?
   LiveStore, kept subscribed for as long as any screen needs it, which can be the whole time
   the app is open.
6. **A one-off answer for one screen?** Request answer.
7. **Otherwise:** a synced record, as a spec field or a status field.

**Four boundary rules.**

1. **Transitions in, heartbeats out.**
   - Precedent: Kubernetes moved node heartbeats out of the Node object into Lease objects
     (KEP-589). Node status is now written "when there is a meaningful change", or rarely.
   - Podium has the same problem: session rows are 63% of the change log, about 1.9 KB each,
     "mostly heartbeats and state changes" (POD-6253), and conversations need the "81MB/day
     churn fix".
   - For sessions:
     - `stateObservedAt` and `stateConfidence` become server-internal;
     - `lastActiveAt` changes only on real transitions;
     - `contextUsagePercent` is written at turn end;
     - the draft fields follow the drafts rule below.
2. **Status fields have one writer**, the server or daemon. Clients act through effects.
3. **Synced does not mean loaded at startup.**
   - Linear loads comments and issue history only when an issue opens.
   - Zero syncs "the union of all active queries' results", preloads what startup needs, and
     keeps unused results warm for a time-to-live.
   - On-demand loading is POD-6253's and POD-5910's job, not a reason to keep data out of sync.
4. **Live values and streams are subscriptions.** They are sent only while a screen needs them,
   re-subscribed after a reconnect, and never written by clients (POD-5798, POD-5800).
   - Precedent: Slack sends presence only for users you subscribe to, and the subscription ends
     with the connection.

**Drafts: what Google Docs teaches.** Google Docs keeps two layers apart:

- **The live layer.** A document is "stored as a series of chronological changes". Every change
  goes to the server in order, and each editor keeps "a local version of the document" while its
  change is in transit.
- **The coarse layer.** Saved versions are computed by "playing forward the history of changes",
  and the history users browse groups many edits together.

For a chat draft this means:

- **Keystrokes travel on the live stream** to the devices that have that composer open, and to
  the agent's terminal composer through the daemon (Draft Sync v2). This already exists:
  `sendDraftEdit` and `sessionDraftChanged`.
- **The synced session record holds a checkpoint:** "has a draft", the text, and when it was
  last edited. It is written when typing pauses (about 2 s), on blur and on send, so a device
  that was away sees the draft and its DRAFT tag. It is never one change-log row per keystroke.
  Today `draftUpdatedAt` sits on the session record; whether every keystroke rewrites the session
  row is not yet verified, and if it does, that is part of the 63%.
- **Order: edits name the revision they were typed against** (`baseRev`, as today), the server
  decides the order, and a dirty local draft keeps winning on its own device (the draft ledger's
  rule).
- **Merging is only needed if two people type into the same draft at once.** That is the case
  Google Docs' operational transformation solves. A chat draft has one typist at a time, so
  whole-text replace with a revision check is enough. Adopt a text merge only if co-writing a
  prompt becomes real.

**Podium's data, placed.** ★ marks data that moves or changes. **Edge** marks a borderline case,
with the reason it lands where it does.

*Synced records: spec fields (people and agents write them)*

- Issues, dependencies, labels, per-user issue state (read, tucked).
- Per-user session state (read, snooze).
- Session spec: name, archived, issue link, desired state ★ (D5).
- Issue subscriptions ★.
- Layout (its two extra paths removed) ★.
- Read positions ★ (into the device replica).
- Pins ★, tab orders ★, personal settings ★.
- Agent profiles ★, workflow definitions ★, automations.
- Non-secret instance settings and feature flags ★.
- Machine spec: name, owner, grants, assignment, update channel ★.
- Repo config: path, prefix, default parent branch ★.
- Superagent threads and conversation titles ★.
- Ship orders and lanes.
- Effect records, the intent part: merge, scan, clone, interrupt, update, server move ★ (D5).
- Chat draft checkpoint ★. **Edge:** typing changes it constantly, which looks like a condition.
  But a draft stays until you type more or send; it never goes stale by itself. So the text at
  each pause is lasting state, and the keystrokes are a stream.

*Synced records: status fields (only the server or daemon writes them)*

- Session lifecycle: starting, live, hibernated, exited, exit code.
- Agent state: working, waiting for you, idle. **Edge:** it flips every turn. It is still lasting
  state: "waiting for you" holds until someone answers, and it drives "needs you" on every
  device, including a phone that was asleep. Synced, state changes only.
- Context usage. **Edge:** it is a reading, but it only changes when a turn ends and then holds
  until the next turn. Written at turn end. A mid-turn value would be a LiveStore condition.
- Last active time. **Edge:** a recency signal used for sorting. It is set only on real events
  (agent state change, human input), never on activity ticks.
- Conversation summaries (last message time, message count). **Edge:** they change with every
  message, and today they are hidden from change detection, so devices see them stale. Lasting
  state, written at turn end only.
- Chat message delivery status.
- Pending interactions.
- Approvals ★, as effect records (D5 E2) with a human `decision` field: an agent's request for a management operation that outlives its session. Amended 2026-11-08 (POD-5620 design 1.8): the earlier "fold into pending interactions" did not fit, because a pending interaction is a harness prompt inside one session.
- Automation runs, workflow runs ★.
- Effect record status and stage ★.
- Issue git state.
- Recent issue events. **Edge:** the history grows forever. The recent window is synced; older
  events come by request until the sync system can load collections on demand.
- Checkout per machine and path ★: branch, head, ahead or behind, dirty flag. **Edge:** the dirty
  flag flips while an agent edits, but it holds until someone commits or discards, so it is
  lasting. The list of changed files behind it is a request answer.
- Machine tools: installed harnesses and versions, and which ones are logged out ★. **Edge:**
  observed, not set by people, but a logged-out harness stays logged out until someone logs in.
  Lasting.

*LiveStore (conditions: never saved, unknown until the first reading)*

- Connection status, ping, clock skew.
- Machine online or offline, with since when ★. **Edge:** it is needed everywhere, but a saved
  "online" means nothing tomorrow. Kept subscribed the whole time the app is open.
- Session "reconnecting" ★, derived from its machine's connection.
- Machine load and host metrics.
- Quota and usage, including "used up until 15:00" ★ (pushed, not polled). **Edge:** "used up"
  sounds like lasting state, but it ends by itself at 15:00, so it is a condition.
- Presence (who is watching).
- A machine's process list, only while a diagnostics screen shows it.

*Live streams*

- Transcript (with its history in its own 10 MB device database), live reply preview, headless
  activity.
- Terminal bytes (never stored).
- Draft keystrokes ★.

*Request answers (fetched when a screen asks)*

- Files: tree, contents, search.
- Git details: changed files, logs, diffs.
- Repo browse and GitHub lists.
- All search: issues, conversations, specs.
- Specs ★. **Edge:** they are shown in the UI and can change while you look, but they are files in
  the repository, so git is the truth. Syncing them would create a second copy. They are fetched
  on open; if a live list is ever needed, sync a small record per spec (path, title), never the
  content.
- History older than the window: issue events, comments, transcript pages.
- Cost, usage, quota and concurrency history.
- Logs, update proposals, machine catalog, memory breakdown.
- Reference resolution, delivery receipts.
- Lock status. **Edge:** agents' advisory leases expire by themselves, which makes them a
  condition. No screen lists them, so a request is enough.

*UiStore (this device only, saved on it)*

- Open view, selected issue and worktree, workspaces, panes and split, file tabs, dock, recent
  files, settings tab.
- Not saved, held in view models: focus, command palette, attached session, transcript reveal.

*Server-internal (never sent)*

- Daemon heartbeats ★, classifier bookkeeping ★ (`stateObservedAt`, `stateConfidence`), dedup
  receipts, outbox internals.

*Secrets*

- Passwords, login tokens, API keys, git tokens and Telegram binding codes never go to a person's
  device or into synced data. Apps see only whether a secret is set. A machine's daemon may
  receive what that machine needs.


### D2. One sync write path

Every write to synced data from outside the server enters through **one entry point**. It takes
the envelope the client outbox already builds (`OutboxEnvelope`:
`{ mutationId, command, version, input, expectedRevision?, confirmed? }`). The steps run in a
fixed order:

1. The principal comes from the transport (ADR 3 D7).
2. The contract is looked up by name and version, and a **coarse permission check** runs: may
   this principal use this command at all, over this transport (role floor, exposure)? This
   happens before parsing, so a refused caller learns nothing from validation errors (ADR 3
   `errorConsistency`).
3. The input is parsed with the contract's schema.
4. A **target permission check** runs live on the specific record the input names: owner, grant
   or delegation (ADR 3 D8/D16). It must come after parsing, because the target comes from the
   input.
5. The write is deduplicated by `mutationId`. This runs after both permission checks, so a
   replay is still refused after a revoked grant.
6. The provenance scope opens. Every change row written carries `mutationId` and `causationId`.
7. The handler runs in **one unit of work**: its data writes, the change-log append and the
   dedup receipt commit together (ADR 2 D10). Effects are never performed here (see D5).
8. The reply is `{ outcome, result, receipt: { feedId, epoch, seq } }`, where `seq` is the
   change-log head after the commit.

Every transport is a thin adapter to this one entry: tRPC for the apps, the CLI, MCP and the
daemon relay. Families supply only a contract, a target resolver and a handler. A handler never
sees the request, so it cannot skip a step.

**Server-originated writes** go to the Authority directly under a system principal (ADR 3 D21).
These are daemon reports (an agent's state, transcripts) and server jobs (automations,
maintenance). They have no outbox and no receipt, but use the same change log and provenance.
Their `causationId` is the report or job that caused them.

### D3. Generic synced edits

Each synced record type declares, once:

- its fields;
- who may write each field;
- its conflict rule (ADR 1: single-writer, field-LWW or exp-rev);
- any fields the server fills in (labels, see D4).

Clients get three operations and no others for plain data:

- `create(kind, id, fields)`
- `edit(ref, patch, expectedRevision?)`
- `remove(ref)`

On the device, the patch itself is what's shown at once; there is no per-command display code.
The server applies the patch through D2, under the field permissions and the conflict rule. A
"claim" (first one wins) is an edit with a precondition, such as "claimed by nobody, at
revision N".

Most of today's 26 outbox commands are plain edits: layout, pins, tab order, personal settings,
read marks, rename, archive, work state, snooze, tuck, labels, defer and undefer, and the issue
field updates.

### D4. Ids are minted on the device; human numbers are server labels

**Identity.** A record's id is its kind's prefix plus a random UUID, minted on the device. The
id is also the create's idempotency key. The server checks three things:

- **Shape:** reject anything else, including strings that look like human refs.
- **Collision:** a create never overwrites an existing id. A replay with the same input succeeds
  through D2's dedup. The same id with different input is refused.
- **Permission:** the caller may create under that parent.

**Labels.** Human numbers such as the 6241 in POD-6241 are labels, filled in by the server inside
the same write (`nextIssueSeq` already does this). They are never identity (ADR 2 D8). The
device shows the label once the write is confirmed.

Today `issues.create` accepts a device id and refuses to overwrite an existing row. But
`IssueIdField` is a plain `z.string()`, so the shape check is missing.

### D5. Effects: three shapes, the lightest by default

**E1. Desired state on the record. This is the default for lifecycle.** When the effect is "make
this thing be in state X", the record carries both halves.

- **Session:**
  - **Desired (new):** `desired: running | hibernated | stopped`, plus `force` for kill.
  - **Observed (already there):** `status` (starting, live, hibernated, exited; "reconnecting"
    becomes a condition derived from the machine's connection, see D1),
    `agentState` and `stoppedAt`.
- **Commands collapse into create and edit:**
  - `sessions.create` becomes a create with `desired: running` and a device-minted id;
  - stop, kill, hibernate, resume and resurrect become edits of `desired`;
  - for cloud machines, stop and wake become edits.
- **The controller reconciles by level, not by event.** On every committed change, and again on
  reconnect, it compares desired with observed, acts, and reports the observed state.
  - For sessions, the controller runs on the server and acts through the daemon channel. The
    daemon stays the only judge of agent state, as today.
  - A replay does nothing new.
  - A stale edit loses to a newer one through `expectedRevision`, so a late "stop" cannot
    override a later "start".
  - The UI shows "stopping…" whenever desired and observed differ.
- **Example: stopping an agent.**
  1. You press Stop. The device edits session S: `desired: stopped`, at revision 7. The edit is
     queued, and the UI shows "Stopping…" at once.
  2. The edit commits. The session controller sees desired ≠ observed and tells S's daemon to
     stop the process.
  3. The daemon reports `status: exited`, and every device shows Stopped.
  4. If your laptop was offline and the edit arrives an hour late, it is still checked against
     revision 7. Had you restarted the agent from your phone in the meantime (revision 8), the
     stale stop is refused.
  5. If the daemon is offline, nothing is lost. The controller reconciles when it reconnects.

**E2. Effect status on the record, for one-shot effects.** When the effect happens once, it uses
a standard field group:

```
effect: {
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired' | 'unknown'
  error?: { code, message }
  deadline?: timestamp        // pending past this → expired, never executed
  attempts: number
  startedAt?, finishedAt?: timestamp
  stage?: string              // kind-specific progress, e.g. chat's 'typing'
}
```

- `unknown` is a real outcome for an effect, not an error case. It means the executor lost track
  after the effect may have happened. Chat already has it. The UI offers a check or a retry; the
  system never retries silently.
- **Where the status lives:**
  - On a natural record when there is one. The chat `message` record conforms: `stored` maps to
    pending; dispatched, reached-machine, typing, typed and accepted map to running with that
    stage; `confirmed` maps to succeeded.
  - Otherwise, on a small generic **effect record** `{ id, kind, target, input, effect }`. That
    covers merge and integrate, file write, folder and machine scans, cloning a repo, and
    interrupt.
- **The trigger is generic, and there is only one.**
  - Fast path: when a record with `effect.status = pending` commits, the post-commit hook
    dispatches it to the executor registered for its kind.
  - Recovery path: at startup, and on a slow sweep, pending records are dispatched again. This
    is the transactional-outbox guarantee: dispatched if and only if committed, at least once.
- **Executor rules:**
  - Claim the record by moving it to `running`.
  - Be idempotent by record id.
  - Write status back through the Authority as a system principal, with
    `causationId` = record id.
- **Cancel is an edit** (`cancelRequested: true`). The executor honours it if it hasn't started,
  or at its own safe points.
- **Example: merging an issue's branch.**
  1. You press Merge. The device creates effect record E, with an id minted on the device:
     `kind: merge`, target issue X, `status: pending`, deadline 10 minutes. The issue shows
     "Merge pending" at once.
  2. E commits, and the trigger hands it to the merge executor, which sets `running` with
     stage "rebasing".
  3. The executor runs git, keyed by E's id: if it finds the merge for E already done, it
     reports success.
  4. It writes `succeeded` with the commit SHA, or `failed` with the reason. Every device sees
     the result.
  5. If the server crashes mid-merge, the recovery sweep finds E still `running`. The executor
     checks reality (is the branch merged?) and finishes the job, or reports `unknown`.
  6. If E waits past its deadline (the server was down for an hour), it expires and never runs.

**E3. The Operations engine, only for long multi-step workflows.** Use it for software update,
server move, and probably cloud machine provisioning: work with steps and deadlines that must
survive restarts and handoffs.

- The engine keeps all of its machinery: steps, deadlines, re-adoption after restart, exclusion
  groups, operator actions mid-run, sealed handoff.
- Its only change is outward. The intent to run is an E2 effect record created through D2, the
  engine is that kind's executor, and it publishes the same `effect` status group on the feed.
- The UI therefore has one way to show anything in progress.

### D6. Delivery is a property of the command, not a separate path

Each contract declares how the client sends it:

- **`queued`:** stored in the outbox, survives offline and reloads, shown at once, with an
  optional `maxAge` (chat sends: minutes).
- **`immediate`:** sent now; the UI shows the record as pending until its status arrives.

Both go through D2. "Online-only" no longer means a different server path. The CLI and agents
that need an outcome wait for the record's final status. They never wait for a request that does
the work inline.

### D7. Confirmation is shared by every D2 write

This is the work already planned on POD-6241:

- provenance on every change row and wire-v2 row;
- the receipt on every reply;
- the outbox retiring an entry when the replica's cursor reaches its receipt, or a frame carries
  its id, inside the replica's own commit.

The device's optimistic layer clears exactly when its outbox entry retires. That holds for edit
patches, pending creates and pending effect records alike.

### D8. Non-synced commands keep a minimal, separate path

About 25 commands have no synced effect:

- sign-in, accounts, setup;
- secrets and the Telegram setup;
- logs, telemetry, performance reports, model refresh.

Prescribed for them:

- **The same contract declaration:** input, permission, redaction, transports.
- **The same front door:** principal, permission and input checks.
- **A plain online handler:** never queued, never stored on the device, and no dedup ledger that
  stores results (results may hold secrets).
- **No access to the Authority**, so it cannot write synced data, even by accident.

Nothing more is prescribed. These commands are few, and each is a special security or
diagnostics flow.

### D9. The rules hold by construction, not by audit

- **Handlers are registered, not routed.** Feature modules export
  `{ contract, target, handle }`; they cannot build client-facing write routes. The tRPC, CLI,
  MCP and relay adapters are generated from the registrations.
- **The handler's context decides what it can touch:**
  - a synced handler gets a `SyncWriteContext`, bound to the D2 unit of work;
  - a plain handler gets a `PlainContext` without the Authority;
  - server-originated writers get a `SystemWriteContext` from the same Authority.
- **Synced repositories accept writes only through a `SyncWriteContext`.** The change-log append
  is part of the context, not a separate call. This retires the two-transaction pattern, such as
  layout's `setMany` followed by `capture`.
- **Contract fields become behaviour.** `exposure` decides which adapters may call a command, and
  `delivery` decides whether a client may queue it.
- Once the structure holds, the per-family audit scripts and the router-mutation census can be
  deleted.

### D10. What does not change

Wire v2 framing, feed scoping and the replica ladder (ADR 2), conflict arbitration (ADR 1), the
contract fields (ADR 3 D1–D6), principals and delegation (ADR 9).

## Consequences

**Gains:**

- **One answer to "is my write done?"** for every write: the receipt plus the record's status.
- **No per-feature optimism, dedup, refetch or hold logic.** The layout controller's holds, the
  pool's `coveredBy`/TTL rules, spawn placeholders and the three refetch helpers disappear.
- **Agent lifecycle becomes data.** Queued, instant, replay-safe and visible on every device.
- **Fixed by construction:** the dedup gap (three commands), layout's two-transaction write, and
  the dedup receipt being recorded after the body.

**Costs:**

- A long migration across about 180 routes and two client paint layers.
- Synced repositories change signature.
- Effect records need retention rules (O5).

**Risk:** handlers that do non-database work today cannot keep doing it inside the D2
transaction. Chat sends and anything that stops sessions talk to daemons. Each must move that
work into an E1 or E2 executor before it moves onto D2. That list is checked first in each
migration stage.

## Migration order

**Who carries out D1's data moves.** Existing issues do, not this plan:

- POD-5802: machines, checkouts, pins, tab order, settings and the other new synced kinds.
- POD-5798 and POD-5800: the LiveStore conditions and the one subscribe path.
- POD-6253: heartbeats out of the change log.

The stages below cover D2–D9.

Every stage ships on its own and leaves the system consistent.

1. **Confirmation foundations** (POD-6241 phase 1, mostly unchanged): provenance in the change
   log, provenance on wire v2, outbox confirmation, replica coverage. *Change:* Task 2 becomes
   the D2 entry point, with the receipt in the reply instead of a response header.
2. **The 26 outbox commands onto D2.** Then client confirmation (Task 6, now simpler) and the
   removal of the layout and pool heuristics (Tasks 7 and 8). This fixes the nulldisk class, the
   dedup gap and layout's split write.
3. **Generic edits (D3).** Convert the outbox commands that are plain edits. Make pins, tab order
   and personal settings synced kinds. Delete the per-command display code. Add the D4 id shape
   check.
4. **Session lifecycle as desired state (E1).** The `desired` field and the reconciler;
   create, stop, kill, hibernate and resume become creates and edits.
5. **Effect status and the generic trigger (E2).** The chat record conforms. Merge and integrate,
   file write, scans, clone and interrupt move onto effect records.
6. **The Operations engine publishes the standard shape (E3).** Update and server move start from
   effect records.
7. **The remaining synced writes onto D2**, one family at a time. Old routes become thin adapters,
   then go.
8. **Non-sync path (D8) and structural enforcement (D9).** Context types, then delete the audits.

## Open questions

- **O1. Grey-zone kinds:** decided in D1's placement table. Specs are request answers
  (repository files). Agent profiles, workflows and the non-secret instance settings are synced
  spec fields. Machines and checkouts carry synced status fields.
- **O2. Interrupt: E2, scoped to the turn it targets.** One-shot does not mean instant. It means
  the action names the one moment it is for.
  - Desired "idle" would be wrong: arriving late, it would also stop the next turn you started.
  - The effect record names the turn it was pressed for. Its status stays `running`
    ("Interrupting…") until the agent reports that turn ended, and then it is `succeeded`.
  - If the turn had already ended when the record is processed, it succeeds at once.
  - If the agent keeps going past the deadline, it is `failed`. The UI then offers Kill, which
    is E1 (`desired: stopped`, `force`).
- **O3. Handoff and answering an agent's question** (`sessions.handoff`,
  `answerAskUserQuestion`). Recommendation: handoff is E3 (it has two apply points minutes
  apart); an answer is E2.
- **O4. Effect records:** one generic kind, or a kind per effect family? Recommendation: one
  generic kind, with kind-specific input and stage; chat keeps its own record because the
  message is content.
- **O5. Retention:** prune finished effect records after the feed's retention window, but keep
  `unknown` and `failed` records until someone dismisses them.
- **O6. Where controllers run:** the server dispatches to daemons for session effects (the
  daemon stays the only judge of agent state). Cloud machine effects run on the server.
