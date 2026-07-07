# Instant new-session UI (optimistic create + starting spinner)

Issue: #119
Date: 2026-07-07

## Problem

Clicking "New <Agent> in <Repo>" (unified sidebar button, the `+` new-panel menu, and
the command palette) takes multiple seconds before the session row appears. Two causes:

1. **No optimistic UI.** Every entry point `await`s `sessions.create` and only navigates /
   shows the row after the mutation resolves *and* the server's websocket broadcast round-trips
   back into the replica. The sidebar row is 100% gated on that broadcast.
2. **The agent-boot delay is invisible.** After the row appears in `status: 'starting'`, the
   abduco/claude process is still booting on the daemon. Today that reads as a static blue
   "ready" dot — no spinner — so the user has no signal that work is in progress.

The offline-first stack (TanStack DB replica + oplog broadcast + outbox) already does optimistic
apply for **edits to known entities** (`rename`, `setArchived`, `setWorkState`, `snooze`,
`resumeAndSend`). `create` was never wired in because it (a) mints *server-assigned* ids, so the
client can't cleanly pre-insert a row, and (b) spawns a real OS process, so the outbox's
offline-durability payoff doesn't apply. This work finishes that gap for the online latency-hiding
case.

## Design

Two independent parts.

### Part 1 — Instant optimistic row + instant navigation

Move id generation to the client so a create becomes "just another optimistic upsert" the existing
replica → broadcast → reconcile machinery already handles.

- **Client generates ids.** `spawnDraftAgent` mints `sessionId` and `draftIssueId` with
  `crypto.randomUUID()` up front.
- **Optimistic pre-insert via an ephemeral overlay.** The replica's `applySnapshot` is
  *full-replace* (rows absent from an incoming server snapshot are deleted), so writing the
  optimistic row directly into the replica would flicker: any unrelated metadata broadcast arriving
  before the create round-trips would wipe the not-yet-server-known row. Instead the store keeps an
  **ephemeral optimistic overlay** (React state: `Map<id, SessionMeta>` + `Map<id, IssueWire>`)
  merged on top of the base `sessions`/`issues` rows in their existing `useMemo`s. Overlay entries
  survive intervening snapshots and are **pruned when the real row (same id) appears in the base**
  (a reconcile effect), or on create error. The overlay is ephemeral (not persisted, not routed
  through the outbox): an offline create can't spawn a process, so there's nothing to durably queue.
- **Valid builders.** The overlay rows are built by pure functions — `optimisticStartingSession(…)`
  → a full `SessionMeta` (`status: 'starting'`, given `sessionId`, `issueId`, `agentKind`, `cwd`,
  `origin: {kind:'spawn'}`, default geometry, `archived:false`, …) and `optimisticDraftIssue(…)` →
  a full draft `IssueWire` mirroring the server's `issues.createDraftFor`/`create` defaults
  (`title:'Draft'`, `draft:true`, `worktreePath:null`, `stage:'backlog'`, `type:'task'`,
  `origin:'human'`, empty arrays, …). Each builder is unit-tested by asserting the protocol zod
  schema `.parse()`s its output, so a future required field can't silently produce an invalid row.
- **Navigate synchronously.** Select the issue + open the pane + switch to workspace view
  immediately, using the known ids — no `await`. The existing `pendingSelect` ref (which waited for
  the server-minted `issueId`) is removed; the id is known up front now.
- **Fire the mutation in the background.** `sessions.create` is sent (not awaited on the UI path),
  passing the client `sessionId` and draft `issueId`. When the server broadcast lands it upserts
  over the **same ids** → seamless reconciliation, no temp-id swap, no duplicate row, no flicker.
- **Rollback on failure.** If the create rejects, remove the optimistic session + issue rows and
  surface a toast. (Create is not routed through the outbox: an offline create can't spawn a
  process, so offline-replay is not meaningful here — this is online latency-hiding only.)

Server accepts the client ids (small, additive change):
- `sessions.create` input: add optional `sessionId`; extend `draftIssue` to `{ repoPath, issueId? }`.
- Thread `sessionId` through `registry.createSession` → `relay.spawn`, used instead of
  `randomUUID()`.
- Thread the draft `issueId` through `issues.createDraftFor(repoPath, agentKind, id?)`, used
  instead of minting.
- Idempotency is already covered by `withMutation(mutationId, …)`; client also sends a stable
  `mutationId`. Because ids are client-provided, a retry is naturally idempotent.

All three entry points (`SidebarUnified.spawn`, `NewPanelMenu.create`, `CommandPalette`) route
through the shared optimistic seam so every path is instant.

### Part 2 — "Starting" spinner while the agent boots

The signal that the visible-but-not-yet-live session is doing work.

- **Sidebar dot.** In `sessionDotClass` (derive.ts), add an animated class (e.g. `dot-starting`)
  when `status === 'starting' || status === 'reconnecting'` — today those collapse into the static
  blue `ready` dot. The dot stays blue (tone unchanged) but pulses/spins. This centralizes the
  indicator across the parent draft-agent dot and any nested session rows automatically. Add the
  `.dot-starting` animation to `styles.css` (sibling to `.dot-working`'s breathe).
- **Main pane.** When the selected session is `status: 'starting'` with no output yet, show a
  centered "Starting <Agent>…" spinner overlay in the pane (AgentPanel/ChatView). It clears the
  instant the server flips the session to `'live'` (`session.markLive`) and the broadcast lands.

Scope note: this covers **resume/reconnect** boots too (`'reconnecting'`), not just fresh spawns —
intentional; the same "booting, please wait" signal applies.

## Boundaries / units

- **`spawn-agent.ts`** — the one spawn seam. Owns id generation and the mutation call; takes an
  injected optimistic `{ apply, rollback }` (or a store method) so it stays testable without the
  React tree.
- **store (`store.tsx`)** — owns the replica upsert/rollback for the optimistic session + issue
  (path-matched to where `patchSession` / `applyChanges` already live). Exposes a `spawnDraftAgent`
  wrapper the components call.
- **`derive.ts`** — pure: `status → dot class`. Unit-testable in isolation.
- **server (`router.ts`, `relay.ts`, `issues.ts`)** — accept + thread client-provided ids. No
  behavior change when ids are omitted (CLI/programmatic callers unaffected).

## Testing (TDD)

- **derive unit:** `sessionDotClass` returns the animated class for `'starting'`/`'reconnecting'`,
  not for `'live'`/`'hibernated'`.
- **store unit:** optimistic create inserts session+issue into the replica *before* the mutation
  resolves (deferred-promise trpc mock); a broadcast carrying the same ids reconciles with no
  duplicate rows; a rejected create rolls both rows back.
- **server unit:** `sessions.create` with a client `sessionId` + draft `issueId` uses those exact
  ids (does not mint); omitting them preserves today's minting; same `mutationId` is idempotent.
- **integration:** clicking "New Claude" with a never-resolving `create` mock still shows the row +
  navigates synchronously.
- **runtime (Playwright, per repo practice):** real click on the live UI — row appears within a
  frame with a spinner, then the spinner clears when the agent goes live.

## Out of scope

- Offline/queued create (no outbox path — see rationale above).
- Changing the create's server-side spawn timing or the daemon boot path.
