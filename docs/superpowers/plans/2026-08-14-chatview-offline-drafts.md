# ChatView Offline-First Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ChatView draft typing fully offline-first — never blocked, never clobbered, surviving reloads without a server — by reusing the versioned `DraftDoc` model as a shared local-first draft ledger, with rev-aware sync always on for chat and only the native-PTY inject machinery left behind the `draft-sync` experiment.

**Architecture:** Extract the server's pure `draft-doc.ts` into `@podium/model`. Add a pure client-side *draft ledger* in `client-core` that owns per-session `{text, serverRev, dirty}` state: local edits apply instantly to the store, incoming `sessionDraftChanged` frames are adopted only by rev/dirty rules (a stale replay can never overwrite newer local text), and dirty drafts are re-sent (debounced, latest-wins) on reconnect. Drafts persist to the device-local ui-state cache so a reload with no server keeps them. Server side, the versioned draft path becomes unconditional for chat frames (echoing revs to the sender so its `baseRev` stays fresh), while the daemon scrape/inject calls stay gated on the `draft-sync` feature flag. Independently, the composer auto-grow effect stops forcing a second reflow per keystroke.

**Tech Stack:** TypeScript, zod protocol (already has `draftEdit` / `sessionDraftChanged` with optional `rev`/`origin`/`editedAt` — **no protocol changes needed**), vitest (`bun run test` per package), React 18 web client.

**Spec:** This plan's analysis lives in issue POD-2045's session record; the versioned-draft conflict model is specified in `docs/superpowers/specs/2026-07-17-draft-sync-v2-design.md` (§1 doc model, §3 lease arbitration).

## Global Constraints

- Never `bunx biome` or repo-wide format; edit files with targeted changes only.
- Tests per package: `cd packages/model && bun run test`, `cd packages/client-core && bun run test`, `cd apps/server && bun run test`, `cd apps/web && bun run test` (vitest under Bun: the scripts already wrap correctly).
- The protocol is additive-only: older clients keep sending `setSessionDraft` and ignoring `rev`; older servers omit `rev`. Both must keep working.
- The native-PTY draft machinery (`handleNativeDraft`, `maybeCatchupInject`, `scheduleDraftInject`, `suppressNativeDraft`, `draftTarget`) stays behind `draftSyncEnabled()`. Chat drafts must not newly trigger PTY injection when the flag is off.
- Mobile (expo) is untouched — its drafts are local `useState` already.
- Commit after every green task; commit messages via `git commit -F <file>` if they contain backticks.

## Background facts an implementer needs (verified 2026-08-14)

- Keystroke path today: `ChatComposer` `onChange` → `setSessionDraft` action → `runtime.setSessionDraft` (`packages/client-core/src/engine/runtime.ts:1042`) which does `adoptSessionDraft` (store write) + `hub.sendSessionDraft` (fire-and-forget WS frame, dropped when disconnected, `socket-hub.ts:1128`).
- The bug: on (re)connect the server's `replayDrafts` (`apps/server/src/modules/sessions/session-state/service.ts:537`) pushes its (possibly stale) draft; `adoptSessionDraft` (`runtime.ts:956`) overwrites the local store unconditionally → typed text lost.
- `drafts` is memory-only client-side (`engine/state.ts:572`); restore-after-reload relies entirely on server replay.
- `DraftDoc`/`applyDraftEdit` (`apps/server/src/modules/sessions/draft-doc.ts`) is pure, imports only `SessionId` from `@podium/model` — safe to move.
- The wire already carries everything: `DraftEditMessage {sessionId, baseRev, text}` (`packages/protocol/src/messages/terminal.ts:213`) and `SessionDraftChangedMessage` with optional `rev/origin/editedAt` (`packages/protocol/src/messages/server.ts:56`).
- Server broadcast currently excludes the sender (`exceptClientId`), so a rev-aware sender would never learn new revs → after a >1.5s lease lapse its stale `baseRev` would be rejected. Fix: in the versioned path, broadcast to ALL clients including the sender; the client ledger treats an echo as "adopt rev, keep local text while dirty".
- Reconnect hook to reuse: `hub.on('connectionHealth', ...)` transition to `'ok'` already drains the outbox (`runtime.ts:534-538`).
- Device-local persistence seam: `uiState.get/set(key)` (`packages/client-core/src/replica/contract.ts:179`); device-local keys are whitelisted in `DEVICE_LOCAL_UI_KEYS` (`packages/model/src/user-state/layout-state.ts:174`).

## File Structure

- `packages/model/src/entities/draft-doc.ts` — moved pure DraftDoc model (Task 1).
- `packages/client-core/src/drafts/draft-ledger.ts` (+ test) — pure per-session local draft arbitration (Task 2).
- `packages/client-core/src/socket-transport/socket-hub.ts` — `sendDraftEdit` (Task 3).
- `packages/client-core/src/engine/runtime.ts` — ledger wiring, guarded adopt, debounced sender, reconnect flush, persistence (Task 4).
- `apps/server/src/modules/sessions/session-state/service.ts` — versioned path unconditional for chat; native inject stays flagged; legacy draft migration (Task 5).
- `apps/web/src/features/chat/ChatComposer.tsx` — reflow fix (Task 6).

---

### Task 1: Move DraftDoc into @podium/model

**Files:**
- Create: `packages/model/src/entities/draft-doc.ts` (content of `apps/server/src/modules/sessions/draft-doc.ts`, import changed to `from '../ids'`-style local SessionId import — copy the import shape used by `packages/model/src/entities/issue.ts`)
- Create: `packages/model/src/entities/draft-doc.test.ts` (move `apps/server/src/modules/sessions/draft-doc.test.ts`, imports re-pointed)
- Delete: `apps/server/src/modules/sessions/draft-doc.ts`, `apps/server/src/modules/sessions/draft-doc.test.ts`
- Modify: `packages/model/src/index.ts` (add `export * from './entities/draft-doc'` beside the other entity exports)
- Modify: `apps/server/src/modules/sessions/session-state/service.ts` (import `applyDraftEdit`, `emptyDraftDoc`, `DraftDoc` etc. from `@podium/model` instead of `../draft-doc`; `grep -rn "draft-doc" apps/server/src` and re-point every hit)

**Interfaces:**
- Produces: `@podium/model` exports `DraftDoc`, `DraftEdit`, `ApplyResult`, `emptyDraftDoc(sessionId)`, `applyDraftEdit(doc, edit, opts?)`, `leaseHolder(doc, nowMs, leaseMs?)`, `DEFAULT_LEASE_MS`, `DEFAULT_HISTORY_LIMIT` — signatures unchanged from the server file.

- [ ] **Step 1: Move the file and test, re-point imports** (this is a pure move — no behavior change, so no new failing test; the moved test suite is the guard)
- [ ] **Step 2: Run moved tests**: `cd packages/model && bun run test -- draft-doc` — expected PASS
- [ ] **Step 3: Server still green**: `cd apps/server && bun run test -- session-state` — expected PASS (plus `git grep -n "modules/sessions/draft-doc" -- apps packages` returns nothing)
- [ ] **Step 4: Typecheck** the workspace's usual gate (turbo/tsgo per repo convention: `bun run typecheck` at root, `--u` cached form is fine)
- [ ] **Step 5: Commit** `refactor(model): move the DraftDoc conflict model into @podium/model`

---

### Task 2: The client draft ledger (pure)

**Files:**
- Create: `packages/client-core/src/drafts/draft-ledger.ts`
- Test: `packages/client-core/src/drafts/draft-ledger.test.ts`

**Interfaces:**
- Produces (consumed by Task 4):

```ts
import type { SessionId } from '@podium/model/browser'

export interface LocalDraft {
  text: string
  /** Highest server rev seen for this session (0 = none). Sent as baseRev. */
  serverRev: number
  /** True while a local edit has not been confirmed echoed by the server. */
  dirty: boolean
  /** Local wall-clock ms of the last local edit (persistence tiebreak only). */
  editedAt: number
}

export interface AdoptOutcome {
  /** Overwrite the visible store text with the incoming text? */
  acceptText: boolean
  /** Schedule a (re)send of the local text (rev advanced under a dirty local)? */
  resend: boolean
}

export interface DraftLedger {
  /** Record a local keystroke. Marks dirty, stamps editedAt. */
  localEdit(sessionId: SessionId, text: string, atMs: number): void
  /** Arbitrate an incoming sessionDraftChanged. Legacy frames have rev undefined. */
  adoptRemote(sessionId: SessionId, incoming: { text: string; rev?: number }): AdoptOutcome
  get(sessionId: SessionId): LocalDraft | undefined
  /** Sessions with dirty local text — the reconnect flush set. */
  dirtySessions(): SessionId[]
  /** Persistence: plain-object snapshot / restore. Restored non-empty texts are
   *  marked dirty so the first flush re-offers them (server dedups no-ops). */
  snapshot(): Record<string, { text: string; serverRev: number; editedAt: number }>
  restore(data: Record<string, { text: string; serverRev: number; editedAt: number }>): void
  remove(sessionId: SessionId): void
}

export function createDraftLedger(): DraftLedger
```

- Arbitration rules (`adoptRemote`), exactly:
  1. No local entry, or local not dirty → `{acceptText: incoming.text !== local?.text, resend: false}`; update `serverRev` to `incoming.rev ?? serverRev`.
  2. Local dirty, `incoming.text === local.text` → converged: clear dirty, adopt rev → `{acceptText: false, resend: false}`.
  3. Local dirty, texts differ, `incoming.rev` defined and `> serverRev` → adopt rev only, keep local text, `{acceptText: false, resend: true}` (this covers both the sender's own echo racing a newer keystroke and a genuine remote edit losing LWW to our still-typing local — the resend makes ours the next rev; superseded remote text goes to server history).
  4. Local dirty, `incoming.rev` undefined (legacy server) → `{acceptText: false, resend: true}` — a dirty local always wins locally.

- [ ] **Step 1: Write failing tests** covering: fresh adopt accepts; dirty local rejects stale replay (the POD-2045 bug: `localEdit('abc')` then `adoptRemote({text: 'a', rev: 3})` → `acceptText === false`, `resend === true`, `get().serverRev === 3`); echo convergence clears dirty; legacy (rev-less) frame never clobbers dirty; `restore` marks non-empty dirty; `remove` forgets; `dirtySessions` lists exactly dirty ids.
- [ ] **Step 2: Run** `cd packages/client-core && bun run test -- draft-ledger` — expected FAIL (module not found)
- [ ] **Step 3: Implement** `createDraftLedger` per the rules above (a `Map<SessionId, LocalDraft>`; no timers, no I/O — pure state machine)
- [ ] **Step 4: Run** the same tests — expected PASS
- [ ] **Step 5: Commit** `feat(client-core): rev-aware local draft ledger`

---

### Task 3: Hub sends versioned draft edits

**Files:**
- Modify: `packages/client-core/src/socket-transport/socket-hub.ts` (beside `sendSessionDraft`, `socket-hub.ts:1126`)
- Test: extend the existing socket-hub test file (`grep -rl "sendSessionDraft" packages/client-core/src --include="*.test.ts"`; if none exercises sends, add `socket-hub.draft.test.ts` using the file's existing fake-socket pattern)

**Interfaces:**
- Produces: `hub.sendDraftEdit(sessionId: SessionId, baseRev: number, text: string): boolean` — sends `{type: 'draftEdit', sessionId, baseRev, text}` when connected; returns whether the frame was actually sent (false while disconnected) so the runtime keeps the draft dirty and retries on reconnect. `sendSessionDraft` stays (other callers, back-compat) but the runtime stops using it.

- [ ] **Step 1: Write failing test**: connected hub → `sendDraftEdit` emits the exact frame and returns true; disconnected hub → no frame, returns false.
- [ ] **Step 2: Run** — expected FAIL (method missing)
- [ ] **Step 3: Implement**:

```ts
/** Versioned draft edit (Draft Sync v2 wire). Returns false when not connected —
 *  the caller keeps the draft dirty and re-flushes on reconnect. */
sendDraftEdit(sessionId: SessionId, baseRev: number, text: string): boolean {
  if (!this.connectedFlag) return false
  this.sendRaw({ type: 'draftEdit', sessionId, baseRev, text })
  return true
}
```

- [ ] **Step 4: Run** — expected PASS
- [ ] **Step 5: Commit** `feat(client-core): hub carries versioned draftEdit frames`

---### Task 4: Runtime — local-first drafts with guarded adopt, debounced sync, persistence

**Files:**
- Modify: `packages/client-core/src/engine/runtime.ts` (`adoptSessionDraft:956`, `setSessionDraft` wiring `:1042`, hub subscription `:505`, connectionHealth block `:534`, `start()` hydration)
- Modify: `packages/model/src/user-state/layout-state.ts:174` (add `'podium.drafts.v1'` to `DEVICE_LOCAL_UI_KEYS` with a doc comment `/** Per-session composer drafts — offline-first local copy. */`)
- Modify: `packages/client-core/src/ui-state.ts` if the routing table there requires listing the key (mirror how `podium.recentFiles` is registered; `grep -n "recentFiles" packages/client-core/src/ui-state.ts`)
- Test: `packages/client-core/src/engine/runtime.test.ts` (follow its existing harness for constructing a runtime with a fake hub)

**Interfaces:**
- Consumes: `createDraftLedger()` (Task 2), `hub.sendDraftEdit` (Task 3).
- Produces: unchanged public action `setSessionDraft(sessionId, text)`; new private behavior only.

Runtime changes, concretely:

```ts
// fields
private readonly draftLedger = createDraftLedger()
private readonly draftSendTimers = new Map<SessionId, ReturnType<typeof setTimeout>>()
private draftPersistTimer: ReturnType<typeof setTimeout> | null = null
private static readonly DRAFT_SEND_DEBOUNCE_MS = 250
private static readonly DRAFT_PERSIST_DEBOUNCE_MS = 500
private static readonly DRAFTS_UI_KEY = 'podium.drafts.v1'

// action seam (replaces the body at :1042)
setSessionDraft: (sessionId, text) => {
  this.draftLedger.localEdit(sessionId, text, Date.now())
  this.applyDraftToStore(sessionId, text)          // extracted store write, below
  this.scheduleDraftSend(sessionId, text === '')   // empty = clear: flush NOW
  this.scheduleDraftPersist()
},

// incoming frames (replaces the unconditional adopt at :505/:956)
this.hub.on('sessionDraft', (sessionId, text, meta) => {
  const outcome = this.draftLedger.adoptRemote(sessionId, { text, ...(meta?.rev !== undefined ? { rev: meta.rev } : {}) })
  if (outcome.acceptText) this.applyDraftToStore(sessionId, text)
  if (outcome.resend) this.scheduleDraftSend(sessionId, false)
})

private applyDraftToStore(sessionId: SessionId, text: string): void {
  const d = this.state.drafts
  if (d[sessionId] === text) return
  this.apply({ drafts: { ...d, [sessionId]: text } })
}

private scheduleDraftSend(sessionId: SessionId, immediate: boolean): void {
  const fire = (): void => {
    this.draftSendTimers.delete(sessionId)
    const local = this.draftLedger.get(sessionId)
    if (!local?.dirty) return
    // Sent or not, the draft stays dirty until the server's echo converges it —
    // a frame lost to a dying socket is re-flushed on the next health 'ok'.
    this.hub.sendDraftEdit(sessionId, local.serverRev, local.text)
  }
  const existing = this.draftSendTimers.get(sessionId)
  if (existing) clearTimeout(existing)
  if (immediate) return fire()
  this.draftSendTimers.set(sessionId, setTimeout(fire, EngineRuntime.DRAFT_SEND_DEBOUNCE_MS))
}

// reconnect flush — extend the existing connectionHealth subscription (:534)
if (h.status === 'ok' && prevHealth !== 'ok') {
  this.outbox.notifyConnected()
  for (const sessionId of this.draftLedger.dirtySessions()) this.scheduleDraftSend(sessionId, true)
}

// persistence
private scheduleDraftPersist(): void {
  if (this.draftPersistTimer) return
  this.draftPersistTimer = setTimeout(() => {
    this.draftPersistTimer = null
    const snap = this.draftLedger.snapshot()
    this.ui.set(EngineRuntime.DRAFTS_UI_KEY,
      Object.keys(snap).length === 0 ? null : JSON.stringify(snap))
  }, EngineRuntime.DRAFT_PERSIST_DEBOUNCE_MS)
}

// hydration — in start(), before hub.connect(), beside routerUi.hydrate():
const storedDrafts = this.ui.get(EngineRuntime.DRAFTS_UI_KEY)
if (storedDrafts) {
  try {
    const parsed = JSON.parse(storedDrafts) as Record<string, { text: string; serverRev: number; editedAt: number }>
    this.draftLedger.restore(parsed)
    const drafts = { ...this.state.drafts }
    for (const [sid, d] of Object.entries(parsed)) if (d.text) drafts[sid] = d.text
    this.apply({ drafts })
  } catch { /* a poisoned blob is a cold start, not a crash */ }
}
```

Also: the hub's `'sessionDraft'` emit (`socket-hub.ts:1599`) currently forwards only `(sessionId, text)` — extend the emit and the event type to pass `{rev, origin, editedAt}` through as an optional third argument (the zod message already parses them). Session removal (wherever runtime reacts to a session leaving the replica — `grep -n "removeSession\|drafts" runtime.ts`) calls `draftLedger.remove` + persist.

- [ ] **Step 1: Write failing runtime tests**:
  - *Clobber regression (the bug):* type `'hello world'` via the action; simulate hub emitting a stale replay `('hello', rev 1)`; assert store draft is still `'hello world'` and a `draftEdit` with `baseRev 1` is (debounce-)sent.
  - *Echo convergence:* after the send, emit `('hello world', rev 2)`; assert no store change and the ledger entry is clean.
  - *Reconnect flush:* type while hub disconnected (sendDraftEdit returns false); flip connectionHealth to ok; assert a `draftEdit` frame with the full text goes out.
  - *Hydration:* construct a runtime whose uiState already holds `podium.drafts.v1`; assert the store's draft is populated before any hub traffic.
  - *Clear is immediate:* setting `''` sends without waiting out the debounce.
- [ ] **Step 2: Run** `cd packages/client-core && bun run test -- runtime` — expected FAIL
- [ ] **Step 3: Implement** as above (plus the `DEVICE_LOCAL_UI_KEYS` / ui-state routing entry)
- [ ] **Step 4: Run** — expected PASS, plus the full package suite `bun run test`
- [ ] **Step 5: Commit** `feat(client-core): offline-first drafts — guarded adopt, debounced rev sync, local persistence`

---

### Task 5: Server — versioned chat drafts always on; native inject stays flagged

**Files:**
- Modify: `apps/server/src/modules/sessions/session-state/service.ts` (`setDraft:470`, `handleDraftEdit:503`, `applyVersionedEdit:577`, `replayDrafts:537`, `loadFromStore:177`)
- Test: `apps/server/src/modules/sessions/session-state/` existing service tests (`grep -rl "setDraft\|replayDrafts" apps/server/src/modules/sessions --include="*.test.ts"`)

**Interfaces:**
- Consumes: `applyDraftEdit`/`emptyDraftDoc` now from `@podium/model` (Task 1).
- Produces: every `sessionDraftChanged` broadcast now carries `rev/origin/editedAt` (via the existing `draftWire`), reaches ALL clients including the sender, and replay always serves the versioned doc.

Changes, concretely:

1. `setDraft` (legacy `setSessionDraft` frames): delete the `draftSyncEnabled_` branch — always route through `applyVersionedEdit(sessionId, {baseRev: current.rev, text, origin: fromClientId ?? 'seed'}, fromClientId)`. Delete the now-dead legacy body (the `this.drafts` map write, `persistLegacyDraft` call from here).
2. `handleDraftEdit`: delete the flag branch — always `applyVersionedEdit(input.sessionId, {baseRev: input.baseRev, ...}, fromClientId)`.
3. `applyVersionedEdit`: broadcast **without** `exceptClientId` (the sender needs the echo to learn the rev — Task 4's ledger makes the echo safe); keep rejection delivery to the sender as-is; gate the native tail: `if (this.draftSyncEnabled_) { if (doc.origin === 'native') this.cancelDraftInject(sessionId); else this.scheduleDraftInject(sessionId) }`.
4. `replayDrafts`: keep only the versioned lane (serve `draftWire(doc)` for every non-empty doc).
5. `loadFromStore` migration: after loading `draftDocs`, for each legacy `drafts` entry with no doc, seed one: `this.draftDocs.set(sessionId, {sessionId, text, rev: 1, origin: 'seed', editedAt: this.draftTimes.get(sessionId) ?? new Date(0).toISOString(), history: []})` — so pre-migration drafts survive and get revs. Keep `persistLegacyDraft` writes inside the versioned path? No — replace with `persistDraftDoc` only, but keep `writeLegacyDraft` called once on transition to empty so old rows clear (check what `store.sessions.setDraft` persistence the DRAFT sidebar tag reads; `draftUpdatedAt` handling is already present in `applyVersionedEdit` and stays).
6. `handleNativeDraft`, `maybeCatchupInject`, `suppressNativeDraft` keep their existing `draftSyncEnabled_` guards untouched.

- [ ] **Step 1: Write failing tests**: legacy `setSessionDraft` frame with the flag OFF produces a broadcast carrying `rev: 1` that reaches the sender too; `replayDrafts` with flag OFF serves rev-stamped frames; flag OFF + chat edit → no `draftTarget` scheduled; flag ON + chat edit → inject scheduled (existing behavior); legacy stored draft (no doc) appears in replay after `loadFromStore` with `rev: 1`.
- [ ] **Step 2: Run** `cd apps/server && bun run test -- session-state` — expected FAIL
- [ ] **Step 3: Implement** items 1–6
- [ ] **Step 4: Run** — expected PASS; then the sessions module suite
- [ ] **Step 5: Commit** `feat(server): versioned draft docs always on for chat; native inject stays behind draft-sync`

---

### Task 6: Composer auto-grow without the double forced reflow

**Files:**
- Modify: `apps/web/src/features/chat/ChatComposer.tsx:198-221`
- Test: `apps/web/src/features/chat/ChatComposer.test.tsx` (jsdom can't measure layout — assert call-count behavior via spies on `getComputedStyle`, which is the measurable proxy)

**Interfaces:** none — internal effect only.

Replace the effect body: cache the one-line metrics once per mount (they derive from font/padding, which don't change), skip all writes when the computed target equals the last applied target, and only run the transition-pinning `offsetHeight` read when the height actually changes:

```tsx
const growCache = useRef<{ oneLine: number; lastTarget: number } | null>(null)
// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the draft changes
useEffect(() => {
  if (compact) return
  const ta = taRef.current
  if (!ta) return
  if (!growCache.current) {
    const cs = getComputedStyle(ta)
    growCache.current = {
      oneLine:
        Number.parseFloat(cs.lineHeight) +
        Number.parseFloat(cs.paddingTop) +
        Number.parseFloat(cs.paddingBottom),
      lastTarget: -1,
    }
  }
  const cache = growCache.current
  const prev = ta.style.height
  ta.style.height = 'auto'
  const target = ta.value ? Math.min(ta.scrollHeight, 176) : cache.oneLine
  if (target === cache.lastTarget) {
    // Same height as last keystroke — restore and stop: no transition to pin,
    // no second forced layout.
    ta.style.height = prev || `${target}px`
    return
  }
  cache.lastTarget = target
  ta.style.height = prev || `${target}px`
  void ta.offsetHeight // pin the transition start to the old height
  ta.style.height = `${target}px`
}, [draft, compact])
```

(Note: `scrollHeight` after `height:auto` is still one forced layout — that read is what auto-grow *is*. What this removes is the `getComputedStyle` parse and the `offsetHeight` reflow on the ~95% of keystrokes where the height doesn't change.)

- [ ] **Step 1: Write failing test**: render non-compact composer, spy `window.getComputedStyle`; drive three `onDraftChange` value updates; assert `getComputedStyle` was called at most once (currently: once per change).
- [ ] **Step 2: Run** `cd apps/web && bun run test -- ChatComposer` — expected FAIL
- [ ] **Step 3: Implement** as above
- [ ] **Step 4: Run** — expected PASS; sanity-check the grow/shrink animation manually in the running app if one is available
- [ ] **Step 5: Commit** `perf(web): composer auto-grow measures once and reflows only on height change`

---

### Task 7: Full-suite verification and wrap-up

- [ ] **Step 1:** Run all four package suites (model, client-core, server, web) and the repo typecheck gate.
- [ ] **Step 2:** Manual smoke (if a dev stack is available, memory: use the isolated podium stack, never the live main checkout): type in ChatView, kill the server process mid-typing, keep typing, reload the tab → draft intact; restart the server → draft syncs, DRAFT tag appears; second browser shows it.
- [ ] **Step 3:** Commit any test fixups; move the issue to review with an offer naming merge/send-back actions.

## Self-review notes

- Spec coverage: clobber bug (Tasks 2+4), offline persistence (Task 4), dropped-frame resend (Tasks 3+4), draft-doc reuse + chat-only versioning with native inject still flagged (Tasks 1+5), reflow perf (Task 6). Wire-format: no changes, verified additive fields exist.
- The sender-echo design change (Task 5 item 3) is load-bearing for Task 4's convergence rule; both tests assert it from their own side.
- Type consistency: `sendDraftEdit(sessionId, baseRev, text): boolean` (Task 3) matches Task 4's usage; ledger API names match between Tasks 2 and 4.
