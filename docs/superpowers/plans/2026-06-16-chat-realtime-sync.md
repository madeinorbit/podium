# Chat View ↔ Native Realtime Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web chat view feel live and consistent with the native PTY: no misclassified "You" bubbles, an optimistic "You" bubble + thinking indicator on send, and a best-effort mirror of the in-progress native prompt into the chat composer (cross-view / cross-device).

**Architecture:** Phase 1 is frontend-only (`apps/web`) plus a regression lock on the Claude transcript parser — all testable logic goes in pure helpers (`chat.ts`, `derive.ts`), React wiring is verified live. Phase 2 adds an ephemeral, server-broadcast per-session draft: the controlling client scrapes Claude's prompt box from the xterm buffer, publishes it over two new WS messages, and every client reflects it through the existing shared `drafts[sessionId]` store.

**Tech stack:** TypeScript monorepo (bun workspaces), React 19 + shadcn/Base-UI + Tailwind v4 (`apps/web`), tRPC + custom WS relay (`apps/server`), zod protocol (`packages/protocol`), xterm.js via `packages/terminal-client`, Claude JSONL parser in `packages/agent-bridge`. Tests: **vitest** (web suite runs under **happy-dom**; the convention is to unit-test pure helpers, not render React).

**Reference spec:** `docs/superpowers/specs/2026-06-16-chat-realtime-sync-design.md`

**Already landed on main (do not redo):** `2635481 fix(agent-bridge): skip isMeta records` implements the core of spec §1.1 (drops Claude's `isMeta` synthetic/injected turns). Task 1 only *locks* that behavior and guards against over-filtering.

---

## File Structure

**Phase 1**
- `packages/agent-bridge/src/transcript/claude.test.ts` — *modify* — regression fixtures (Task 1).
- `apps/web/src/chat.ts` — *modify* — add pure `PendingItem` + `reconcilePending` (Task 2).
- `apps/web/test/chat.test.ts` — *modify* — tests for reconciliation (Task 2).
- `apps/web/src/derive.ts` — *modify* — add pure `chatActivity` (Task 4).
- `apps/web/test/derive.test.ts` — *create or modify* — tests for `chatActivity` (Task 4).
- `apps/web/src/ChatView.tsx` — *modify* — wire pending bubble (Task 3) + thinking indicator (Task 5).

**Phase 2**
- `packages/protocol/src/messages.ts` — *modify* — two new messages + union membership (Task 6).
- `packages/protocol/test/*` (wherever protocol tests live) — *modify* — parse tests (Task 6).
- `apps/server/src/relay.ts` — *modify* — `draftBySession` + handler + broadcast + welcome seed (Task 7).
- `apps/server/src/relay.test.ts` — *modify* — broadcast tests (Task 7).
- `apps/server/src/router.ts` or relay client-message switch — *modify* — dispatch `setSessionDraft` (Task 7).
- `packages/terminal-client/src/prompt-extract.ts` — *create* — pure `extractClaudePromptDraft` (Task 8).
- `packages/terminal-client/src/prompt-extract.test.ts` — *create* — extractor tests (Task 8).
- `packages/terminal-client/src/connection.ts` (SocketHub) — *modify* — `clientId`, `sendSessionDraft`, `onSessionDraft` (Task 9).
- `packages/terminal-client/src/session-mount.ts` — *modify* — `onFrame` option (Task 9).
- `apps/web/src/store.tsx` — *modify* — wire draft send/receive (Task 10).
- `apps/web/src/AgentPanel.tsx` — *modify* — controller-gated frame sampler that publishes the extracted draft (Task 11).

---

## Phase 1 — Clean wins

### Task 1: Regression-lock Claude classification

Spec §1.1. The `isMeta` skip already shipped (`2635481`). Add fixtures that (a) confirm an `isMeta` record is dropped and (b) guard against over-filtering a real user message that merely has an appended `<system-reminder>` block (the harness appends these to genuine prompts — they must stay `user`).

**Files:**
- Test: `packages/agent-bridge/src/transcript/claude.test.ts`

- [ ] **Step 1: Add the failing/guard tests**

```ts
import { describe, expect, it } from 'vitest'
import { claudeRecordToItems } from './claude.js'

describe('claudeRecordToItems — injected vs real user turns', () => {
  it('drops isMeta synthetic turns (skill/command expansions, SessionStart context)', () => {
    const rec = {
      type: 'user',
      isMeta: true,
      uuid: 'm1',
      message: { role: 'user', content: 'Base directory for this skill: …\n<full skill body>' },
    }
    expect(claudeRecordToItems(rec)).toEqual([])
  })

  it('keeps a genuine user prompt that has an appended <system-reminder> as role "user"', () => {
    const rec = {
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: 'fix the chat view\n<system-reminder>As you answer…</system-reminder>',
      },
    }
    const items = claudeRecordToItems(rec)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ role: 'user' })
    expect(items[0].text).toContain('fix the chat view')
  })
})
```

- [ ] **Step 2: Run and confirm behavior**

Run: `cd packages/agent-bridge && bun run vitest run src/transcript/claude.test.ts`
Expected: PASS (both — `2635481` already makes the first pass; the second documents the deliberate non-filtering of real prompts). If the second FAILS, someone added content-sniffing — revert that, it over-filters real prompts.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-bridge/src/transcript/claude.test.ts
git commit -m "test(agent-bridge): lock Claude isMeta-drop + don't over-filter real prompts"
```

---

### Task 2: Pure pending-bubble reconciliation helper

Spec §1.2. The optimistic "You" bubble and its reconciliation are the only non-trivial logic — extract them as pure functions so they're unit-tested without rendering.

**Files:**
- Modify: `apps/web/src/chat.ts`
- Test: `apps/web/test/chat.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/chat.test.ts`:

```ts
import { type PendingItem, reconcilePending } from '../src/chat'

const pend = (text: string, id = text): PendingItem => ({ id, text, at: 0, state: 'sending' })

describe('reconcilePending', () => {
  it('drops a pending entry once a matching new user text appears', () => {
    const out = reconcilePending([pend('run the tests')], ['run the tests'])
    expect(out).toEqual([])
  })

  it('keeps pending entries with no matching new user text', () => {
    const out = reconcilePending([pend('hello')], ['something else'])
    expect(out).toEqual([pend('hello')])
  })

  it('consumes one real occurrence per pending (FIFO) for duplicate texts', () => {
    const out = reconcilePending([pend('ok', 'a'), pend('ok', 'b')], ['ok'])
    expect(out).toEqual([pend('ok', 'b')]) // only the oldest is reconciled
  })

  it('matches on trimmed text', () => {
    expect(reconcilePending([pend('hi')], ['  hi  '])).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bun run vitest run test/chat.test.ts`
Expected: FAIL — `reconcilePending`/`PendingItem` not exported.

- [ ] **Step 3: Implement the helper**

Append to `apps/web/src/chat.ts`:

```ts
/** An optimistic "You" bubble shown immediately on send, before the transcript
 *  tail echoes the real user turn back. `at` = creation time (ms), used to drop
 *  the "sending" affordance after a timeout. */
export interface PendingItem {
  id: string
  text: string
  at: number
  state: 'sending' | 'failed'
}

/**
 * Remove pending bubbles that the real transcript has now caught up with.
 * `newUserTexts` are the trimmed texts of user blocks that appeared *this* render
 * (caller diffs by block id). Each new occurrence consumes the oldest pending
 * entry with equal trimmed text (FIFO), so duplicate prompts reconcile one-by-one.
 */
export function reconcilePending(pending: PendingItem[], newUserTexts: string[]): PendingItem[] {
  if (pending.length === 0) return pending
  const remaining = [...newUserTexts.map((t) => t.trim())]
  return pending.filter((p) => {
    const i = remaining.indexOf(p.text.trim())
    if (i === -1) return true
    remaining.splice(i, 1) // consume one real occurrence
    return false
  })
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && bun run vitest run test/chat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/chat.ts apps/web/test/chat.test.ts
git commit -m "feat(web): pure pending-bubble reconciliation helper for chat"
```

---

### Task 3: Wire the optimistic "You" bubble into ChatView

Spec §1.2. Append a pending bubble on send; reconcile via Task 2 as real user blocks arrive; survive a slow tail; mark failed on send error.

**Files:**
- Modify: `apps/web/src/ChatView.tsx`

- [ ] **Step 1: Add pending state + a monotonic id + reconciliation effect**

In `ChatView`, after the existing `const [atBottom, setAtBottom] = useState(true)` line, add:

```tsx
  const [pending, setPending] = useState<PendingItem[]>([])
  const pendingSeq = useRef(0)
  // Block ids seen on the previous render — lets us detect *newly arrived* user
  // blocks so a freshly-echoed prompt reconciles its optimistic bubble.
  const seenUserIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    const prev = seenUserIds.current
    const next = new Set<string>()
    const newUserTexts: string[] = []
    for (const b of blocks) {
      if (b.item.role !== 'user') continue
      next.add(b.item.id)
      if (!prev.has(b.item.id)) newUserTexts.push(b.item.text)
    }
    seenUserIds.current = next
    if (newUserTexts.length > 0) {
      setPending((p) => (p.length === 0 ? p : reconcilePending(p, newUserTexts)))
    }
  }, [blocks])

  // Drop the "sending" affordance after a grace period even if no echo arrived
  // (slow tail / uninstrumented) — the prompt was still sent; keep the bubble.
  useEffect(() => {
    if (!pending.some((p) => p.state === 'sending')) return
    const now = Date.now()
    const t = setTimeout(() => {
      setPending((p) =>
        p.map((x) => (x.state === 'sending' && now - x.at >= 0 ? { ...x, state: 'failed' } : x)),
      )
    }, 30_000)
    return () => clearTimeout(t)
  }, [pending])
```

Add the imports at the top — extend the existing `'./chat'` import to include `PendingItem` and `reconcilePending`:

```tsx
import {
  blockMatches,
  type ChatBlock,
  minimapSegments,
  pairToolResults,
  type PendingItem,
  reconcilePending,
  searchBlocks,
} from './chat'
```

- [ ] **Step 2: Append the bubble in `send()`**

Replace the existing `send` function body with:

```tsx
  const send = async () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    pinnedToBottom.current = true
    setAtBottom(true)
    const id = `pending-${++pendingSeq.current}`
    setPending((p) => [...p, { id, text, at: Date.now(), state: 'sending' }])
    try {
      await trpc.sessions.sendText.mutate({ sessionId, text })
    } catch {
      setPending((p) => p.map((x) => (x.id === id ? { ...x, state: 'failed' } : x)))
    }
  }
```

- [ ] **Step 3: Render pending bubbles after the real blocks**

Immediately after the `{blocks.map(...)}` block (just before `</div>` that closes the scroller `<div className="flex min-w-0 flex-1 …">`), add:

```tsx
          {pending.map((p) => (
            <div
              key={p.id}
              className={cn(
                'mx-auto w-full max-w-[760px] rounded-[10px] border border-border bg-secondary px-3.5 py-2.5',
                p.state === 'failed' && 'border-destructive/60',
              )}
            >
              <div className="mb-[3px] flex items-center gap-1.5 text-[10px] uppercase tracking-[0.07em] text-muted-foreground/70">
                You
                {p.state === 'sending' && <span className="normal-case tracking-normal opacity-70">· sending…</span>}
                {p.state === 'failed' && <span className="normal-case tracking-normal text-destructive">· not delivered</span>}
              </div>
              <div className="whitespace-pre-wrap break-words text-sm leading-[1.45] text-foreground">
                {p.text}
              </div>
            </div>
          ))}
```

- [ ] **Step 4: Verify build + types**

Run: `cd apps/web && bun run build`
Expected: build succeeds, no TS errors. (No unit test — React wiring is verified live in Task 12.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ChatView.tsx
git commit -m "feat(web): optimistic You bubble on chat send (reconciled by tail echo)"
```

---

### Task 4: Pure chat-activity (thinking indicator) helper

Spec §1.3. Map session runtime state to a bottom-of-chat activity row. Co-locate with `agentBadge` in `derive.ts` (same input type, reuses it).

**Files:**
- Modify: `apps/web/src/derive.ts`
- Test: `apps/web/test/derive.test.ts` (create if absent)

- [ ] **Step 1: Write the failing tests**

Create/append `apps/web/test/derive.test.ts`:

```ts
import type { SessionMeta } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { chatActivity } from '../src/derive'

const base = (over: Partial<SessionMeta>): SessionMeta =>
  ({
    sessionId: 's', agentKind: 'claude-code', title: 't', cwd: '/', status: 'live',
    controllerId: null, geometry: { cols: 80, rows: 24 }, epoch: 0, clientCount: 1,
    createdAt: '', lastActiveAt: '', origin: { kind: 'spawn' }, archived: false,
    ...over,
  }) as SessionMeta

describe('chatActivity', () => {
  it('shows Working… while the agent phase is working', () => {
    const a = chatActivity(base({ agentState: { phase: 'working', since: '', openTaskCount: 0 } }), false)
    expect(a).toEqual({ label: 'Working…', tone: 'working' })
  })

  it('shows Compacting… while compacting', () => {
    const a = chatActivity(base({ agentState: { phase: 'compacting', since: '', openTaskCount: 0 } }), false)
    expect(a).toEqual({ label: 'Compacting…', tone: 'working' })
  })

  it('surfaces attention states (needs answer / plan ready)', () => {
    const a = chatActivity(
      base({ agentState: { phase: 'needs_user', since: '', openTaskCount: 0, need: { kind: 'question' } } }),
      false,
    )
    expect(a).toEqual({ label: 'needs answer', tone: 'attention' })
  })

  it('falls back to PTY busy for uninstrumented kinds', () => {
    const a = chatActivity(base({ agentKind: 'shell', busy: true }), false)
    expect(a).toEqual({ label: 'Working…', tone: 'working' })
  })

  it('shows Sending… optimistically right after submit, before any signal', () => {
    const a = chatActivity(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } }), true)
    expect(a).toEqual({ label: 'Sending…', tone: 'working' })
  })

  it('shows nothing when idle and not just-sent', () => {
    expect(chatActivity(base({ agentState: { phase: 'idle', since: '', openTaskCount: 0 } }), false)).toBeNull()
    expect(chatActivity(undefined, false)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/web && bun run vitest run test/derive.test.ts`
Expected: FAIL — `chatActivity` not exported.

- [ ] **Step 3: Implement the helper**

Append to `apps/web/src/derive.ts` (it already imports `SessionMeta` and defines `agentBadge`/`AgentBadge`):

```ts
export interface ChatActivity {
  label: string
  tone: AgentBadge['tone']
}

/**
 * The activity row shown pinned to the bottom of the chat view, or null for
 * nothing. Reuses `agentBadge` for instrumented agents; falls back to the PTY
 * `busy` signal for uninstrumented kinds; and shows an optimistic "Sending…"
 * immediately after a submit (`justSent`) before the first `working` event lands.
 */
export function chatActivity(meta: SessionMeta | undefined, justSent: boolean): ChatActivity | null {
  if (!meta) return null
  const badge = agentBadge(meta)
  if (badge?.tone === 'working') {
    return { label: badge.label === 'compacting' ? 'Compacting…' : 'Working…', tone: 'working' }
  }
  if (badge?.tone === 'attention') return { label: badge.label, tone: 'attention' }
  if (!meta.agentState && meta.busy) return { label: 'Working…', tone: 'working' }
  if (justSent) return { label: 'Sending…', tone: 'working' }
  return null
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/web && bun run vitest run test/derive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/derive.ts apps/web/test/derive.test.ts
git commit -m "feat(web): chatActivity helper for chat thinking indicator"
```

---

### Task 5: Wire the thinking indicator into ChatView

Spec §1.3. Render the activity row at the bottom of the scroller; show it optimistically right after send; clear the optimistic flag once a real signal lands.

**Files:**
- Modify: `apps/web/src/ChatView.tsx`

- [ ] **Step 1: Add `justSent` state and clear-on-signal effect**

After the `pending` state added in Task 3, add:

```tsx
  const [justSent, setJustSent] = useState(false)
  const activity = chatActivity(session, justSent)
  // Clear the optimistic flag once the agent actually reports working (the badge
  // keeps the row visible) or after a short ceiling so it never sticks.
  useEffect(() => {
    if (!justSent) return
    if (session?.agentState?.phase === 'working' || session?.agentState?.phase === 'compacting') {
      setJustSent(false)
      return
    }
    const t = setTimeout(() => setJustSent(false), 8_000)
    return () => clearTimeout(t)
  }, [justSent, session?.agentState?.phase])
```

Add `chatActivity` to the `'./derive'` import (create the import line if ChatView doesn't already import from derive):

```tsx
import { chatActivity } from './derive'
```

- [ ] **Step 2: Set the flag in `send()`**

In the `send()` body from Task 3, add `setJustSent(true)` right after the `setPending(...)` append line:

```tsx
    setPending((p) => [...p, { id, text, at: Date.now(), state: 'sending' }])
    setJustSent(true)
```

- [ ] **Step 3: Render the activity row**

Immediately after the `{pending.map(...)}` block (still inside the scroller div), add:

```tsx
          {activity && (
            <div
              role="status"
              aria-live="polite"
              className={cn(
                'mx-auto flex w-full max-w-[760px] items-center gap-2 text-xs',
                activity.tone === 'attention' ? 'text-amber-500' : 'text-muted-foreground',
              )}
            >
              <span className="inline-flex gap-0.5">
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.2s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.1s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-current" />
              </span>
              {activity.label}
            </div>
          )}
```

- [ ] **Step 4: Verify build**

Run: `cd apps/web && bun run build`
Expected: build succeeds, no TS errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ChatView.tsx
git commit -m "feat(web): live thinking indicator in chat view (agentState/busy + optimistic)"
```

---

## Phase 2 — Native → chat prompt mirror (best-effort)

> Protocol changes here require deploying **web + backend together** (stale schemas drop new message types). See spec §Rollout.

### Task 6: Protocol — session-draft messages

Spec §2.2. Mirror the `sessionAgentStateChanged` pattern: one client→server setter, one server→client broadcast.

**Files:**
- Modify: `packages/protocol/src/messages.ts`
- Test: protocol test file (search `messages.test` / `protocol` test dir; create a focused test if none).

- [ ] **Step 1: Add the message schemas**

Near `SessionAgentStateChangedMessage` (≈ line 347), add:

```ts
// The in-progress composer/native-prompt text for a session. Ephemeral (never
// persisted): the controlling client publishes its scraped native prompt, and a
// chat composer edit publishes its draft, so every view/device converges.
export const SetSessionDraftMessage = z.object({
  type: z.literal('setSessionDraft'),
  sessionId: z.string(),
  text: z.string(),
})
export type SetSessionDraftMessage = z.infer<typeof SetSessionDraftMessage>

export const SessionDraftChangedMessage = z.object({
  type: z.literal('sessionDraftChanged'),
  sessionId: z.string(),
  text: z.string(),
})
export type SessionDraftChangedMessage = z.infer<typeof SessionDraftChangedMessage>
```

- [ ] **Step 2: Add to the unions**

In the `ClientMessage` discriminated union (≈ line 271) add `SetSessionDraftMessage,`. In the `ServerMessage` discriminated union (≈ line 390) add `SessionDraftChangedMessage,`.

- [ ] **Step 3: Write the parse test**

Add to the protocol test suite:

```ts
import { ClientMessage, ServerMessage } from '../src/messages'

it('parses setSessionDraft (client) and sessionDraftChanged (server)', () => {
  expect(ClientMessage.parse({ type: 'setSessionDraft', sessionId: 's', text: 'hi' })).toMatchObject({
    type: 'setSessionDraft', text: 'hi',
  })
  expect(ServerMessage.parse({ type: 'sessionDraftChanged', sessionId: 's', text: 'hi' })).toMatchObject({
    type: 'sessionDraftChanged', text: 'hi',
  })
})
```

- [ ] **Step 4: Run + build protocol**

Run: `cd packages/protocol && bun run vitest run && bun run build`
Expected: PASS + build emits updated `dist` (other packages import the built protocol).

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/test
git commit -m "feat(protocol): setSessionDraft + sessionDraftChanged messages"
```

---

### Task 7: Relay — store, dispatch, broadcast, and seed the draft

Spec §2.2. Keep an ephemeral per-session draft; on `setSessionDraft` store it and broadcast `sessionDraftChanged` to **other** clients; replay current drafts to a newly connected client.

**Files:**
- Modify: `apps/server/src/relay.ts`
- Modify: the relay's client-message dispatch (search `case 'detach'` / `case 'presence'` in `relay.ts`)
- Test: `apps/server/src/relay.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/relay.test.ts` (follow the existing harness in that file for constructing a registry + fake clients; mirror how `sessionAgentStateChanged`/`broadcastSessions` tests capture per-client sends):

```ts
describe('session draft sync', () => {
  it('stores a draft and broadcasts it to OTHER clients only', () => {
    const reg = makeRegistry() // existing test helper in this file
    const a = reg.addFakeClient() // capture-sends helper used by other tests
    const b = reg.addFakeClient()
    reg.setSessionDraft({ sessionId: 'sess', text: 'half typed' }, a.id)
    expect(a.sent).not.toContainEqual(
      expect.objectContaining({ type: 'sessionDraftChanged', sessionId: 'sess' }),
    )
    expect(b.sent).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'half typed' })
  })

  it('replays stored drafts to a freshly connected client', () => {
    const reg = makeRegistry()
    const a = reg.addFakeClient()
    reg.setSessionDraft({ sessionId: 'sess', text: 'wip' }, a.id)
    const c = reg.connectClient() // whatever the file uses to run the welcome handshake
    expect(c.sent).toContainEqual({ type: 'sessionDraftChanged', sessionId: 'sess', text: 'wip' })
  })
})
```

> Note: match the exact test helpers already in `relay.test.ts` (the names above are illustrative). The behavioral assertions are what matter: broadcast-to-others, and replay-on-connect.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && bun run vitest run src/relay.test.ts`
Expected: FAIL — `setSessionDraft` not defined.

- [ ] **Step 3: Implement on the registry**

In `relay.ts`, add a field near the other per-registry maps:

```ts
  /** Ephemeral in-progress composer/prompt text per session. Never persisted. */
  private draftBySession = new Map<string, string>()
```

Add the method (place near `sendText`):

```ts
  setSessionDraft({ sessionId, text }: { sessionId: string; text: string }, fromClientId?: string): void {
    if (text) this.draftBySession.set(sessionId, text)
    else this.draftBySession.delete(sessionId)
    for (const c of this.clients.values()) {
      if (c.id === fromClientId) continue
      c.send({ type: 'sessionDraftChanged', sessionId, text })
    }
  }
```

Drop the session's draft when it is removed/killed (find where `draftBySession`-adjacent maps are cleaned on session removal and add `this.draftBySession.delete(sessionId)`).

- [ ] **Step 4: Dispatch the inbound message + seed on connect**

In the client-message handler switch (where `'input'`/`'presence'`/`'detach'` are handled), add:

```ts
      case 'setSessionDraft':
        this.setSessionDraft(msg, client.id)
        break
```

In the welcome handshake (the block that does `send({ type: 'welcome', clientId: id })` then `send({ type: 'sessionsChanged', … })`, ≈ line 637) add after the sessions send:

```ts
    for (const [sessionId, text] of this.draftBySession) {
      send({ type: 'sessionDraftChanged', sessionId, text })
    }
```

- [ ] **Step 5: Run to verify pass + typecheck**

Run: `cd apps/server && bun run vitest run src/relay.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): ephemeral per-session draft sync (broadcast + replay on connect)"
```

---

### Task 8: Pure Claude prompt-box extractor

Spec §2.1. Pure function over the rendered screen lines. Returns the in-progress prompt text, `''` for an empty/placeholder box, or `null` when no clean box is present (menu/overlay/non-Claude) — never clobber on ambiguity.

**Files:**
- Create: `packages/terminal-client/src/prompt-extract.ts`
- Test: `packages/terminal-client/src/prompt-extract.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest'
import { extractClaudePromptDraft } from './prompt-extract'

const box = (...inner: string[]): string[] => [
  'some transcript output above',
  '╭────────────────────────────╮',
  ...inner.map((s) => `│ ${s.padEnd(26)} │`),
  '╰────────────────────────────╯',
  '  ? for shortcuts',
]

describe('extractClaudePromptDraft', () => {
  it('extracts single-line in-progress text after the caret', () => {
    expect(extractClaudePromptDraft(box('> fix the chat view'))).toBe('fix the chat view')
  })

  it('joins wrapped continuation lines', () => {
    expect(extractClaudePromptDraft(box('> first line', '  second line'))).toBe('first line\nsecond line')
  })

  it('returns empty string for an empty prompt box', () => {
    expect(extractClaudePromptDraft(box('>'))).toBe('')
  })

  it('treats known placeholder text as empty', () => {
    expect(extractClaudePromptDraft(box('> Try "edit <file>" or ask a question'))).toBe('')
  })

  it('returns null when there is no prompt box (no clobber)', () => {
    expect(extractClaudePromptDraft(['just output', 'no box here'])).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/terminal-client && bun run vitest run src/prompt-extract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the extractor**

```ts
/**
 * Best-effort extraction of Claude Code's in-progress prompt text from the
 * rendered terminal screen (one string per visible row, top→bottom). The prompt
 * is a rounded box near the bottom:
 *
 *   ╭───────────────────╮
 *   │ > the typed text  │
 *   ╰───────────────────╯
 *
 * Returns the text (continuation lines joined by \n), '' for an empty/placeholder
 * box, or null when no clean box is present (slash/autocomplete overlay, a
 * non-Claude TUI) — callers must NOT overwrite the shared draft on null.
 */
const PLACEHOLDER_PREFIXES = ['Try "', '? for shortcuts', '/ for commands']

export function extractClaudePromptDraft(lines: string[]): string | null {
  let bottom = -1
  let top = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim()
    if (bottom === -1) {
      if (t.startsWith('╰')) bottom = i
      continue
    }
    if (t.startsWith('╭')) {
      top = i
      break
    }
    // A non-border, non-content row inside the box = an overlay/menu replaced it.
    if (!t.startsWith('│') && t !== '') return null
  }
  if (top === -1 || bottom === -1 || bottom - top < 2) return null

  const parts: string[] = []
  for (let k = top + 1; k < bottom; k++) {
    const s = lines[k]
    const li = s.indexOf('│')
    const ri = s.lastIndexOf('│')
    if (li === -1 || ri === li) return null
    let content = s.slice(li + 1, ri)
    if (k === top + 1) content = content.replace(/^\s*>\s?/, '')
    parts.push(content.replace(/\s+$/, ''))
  }
  const text = parts.join('\n').replace(/\s+$/, '')
  const trimmed = text.trim()
  if (trimmed === '') return ''
  if (PLACEHOLDER_PREFIXES.some((p) => trimmed.startsWith(p))) return ''
  return text
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/terminal-client && bun run vitest run src/prompt-extract.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/terminal-client/src/prompt-extract.ts packages/terminal-client/src/prompt-extract.test.ts
git commit -m "feat(terminal-client): pure Claude prompt-box draft extractor"
```

---

### Task 9: terminal-client plumbing — clientId, draft send/receive, frame hook

Spec §2.1/§2.2. Capture the server-assigned `clientId` (for controller gating), add draft send/subscribe to `SocketHub`, and expose a per-frame callback from `mountSession` for the sampler.

**Files:**
- Modify: `packages/terminal-client/src/connection.ts` (SocketHub)
- Modify: `packages/terminal-client/src/session-mount.ts`

- [ ] **Step 1: Capture clientId + add draft API to SocketHub**

In `connection.ts`, where the hub handles the `welcome` message (search `'welcome'` / `clientId`), store it:

```ts
  clientId: string | null = null
```
and in the welcome handler: `this.clientId = msg.clientId`.

Add a draft-observer set + methods (mirror how `subscribeTranscript`/transcript observers are structured):

```ts
  private draftObservers = new Set<(sessionId: string, text: string) => void>()

  /** Publish this client's in-progress draft for a session to the server. */
  sendSessionDraft(sessionId: string, text: string): void {
    this._sendInput({ type: 'setSessionDraft', sessionId, text } as never)
  }

  /** Subscribe to draft changes broadcast by other clients. Returns an unsubscribe. */
  onSessionDraft(cb: (sessionId: string, text: string) => void): () => void {
    this.draftObservers.add(cb)
    return () => this.draftObservers.delete(cb)
  }
```

> `_sendInput` is the existing low-level WS send used by `sendInput` (connection.ts:600). If it is typed strictly to PTY input messages, add a sibling `_send(msg: ClientMessage)` or widen the type so `setSessionDraft` is accepted — match whatever `_sendInput` already does to encode/queue.

In the server-message handler (where `sessionAgentStateChanged`/`sessionsChanged` cases live), add:

```ts
      case 'sessionDraftChanged':
        for (const cb of this.draftObservers) cb(msg.sessionId, msg.text)
        break
```

- [ ] **Step 2: Add a per-frame hook to mountSession**

In `session-mount.ts`, extend `MountSessionOptions` with `onFrame?: () => void` and call it wherever frames are written to the view (the connection's `onFrame`/output handling that `mountSession` already wires). Add the option to the options interface and invoke `opts.onFrame?.()` after the view consumes a frame.

- [ ] **Step 3: Build + typecheck**

Run: `cd packages/terminal-client && bun run build && bun run typecheck`
Expected: succeeds. (Behavioral coverage for this plumbing is the live test in Task 12; the pure extractor is already covered.)

- [ ] **Step 4: Commit**

```bash
git add packages/terminal-client/src/connection.ts packages/terminal-client/src/session-mount.ts
git commit -m "feat(terminal-client): clientId capture + session-draft send/subscribe + onFrame hook"
```

---

### Task 10: Web store — wire draft send + receive

Spec §2.2. The composer already binds to `drafts[sessionId]`. Make local edits publish, and remote changes update the store (without re-publishing — no loop).

**Files:**
- Modify: `apps/web/src/store.tsx`

- [ ] **Step 1: Subscribe to remote draft changes**

In `StoreProvider`, add an effect near the other `hub.subscribe*` wiring:

```tsx
  useEffect(
    () =>
      hub.onSessionDraft((sessionId, text) =>
        setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text })),
      ),
    [hub],
  )
```

- [ ] **Step 2: Publish local edits**

Change `setSessionDraft` (≈ line 264) to also send over the hub:

```tsx
  const setSessionDraft = useMemo(
    () => (sessionId: string, text: string) => {
      setDrafts((d) => (d[sessionId] === text ? d : { ...d, [sessionId]: text }))
      hub.sendSessionDraft(sessionId, text)
    },
    [hub],
  )
```

> The remote-change effect in Step 1 calls `setDrafts` directly (not `setSessionDraft`), so an inbound draft never re-broadcasts. The relay also never echoes to the sender (Task 7). Together this prevents any feedback loop.

- [ ] **Step 3: Build + typecheck**

Run: `cd apps/web && bun run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/store.tsx
git commit -m "feat(web): sync chat draft across clients via the relay"
```

---

### Task 11: AgentPanel — controller-gated native prompt sampler

Spec §2.1/§2.3. While a native Claude terminal is mounted **and this client controls it**, sample the prompt box on each frame (debounced) and publish non-null changes as the session draft.

**Files:**
- Modify: `apps/web/src/AgentPanel.tsx`

- [ ] **Step 1: Add the sampler wiring to the native-mount effect**

Add imports:

```tsx
import { extractClaudePromptDraft } from '@podium/terminal-client'
```
(Export `extractClaudePromptDraft` from the terminal-client package index if not already — add to `packages/terminal-client/src/index.ts`.)

Pull `setSessionDraft` from the store: extend the existing `const { hub, sessions, archiveSession } = useStore()` to `const { hub, sessions, archiveSession, setSessionDraft } = useStore()`.

In the `mountSession` effect (the one gated on `effectiveMode !== 'native'`), compute controller gating and pass an `onFrame` that debounce-samples:

```tsx
    const isClaude = session?.agentKind === 'claude-code'
    const sample = () => {
      if (!isClaude) return
      const view = mountedRef.current?.view
      if (!view) return
      if (session?.controllerId !== hub.clientId) return // only the controller publishes
      const draft = extractClaudePromptDraft(view.screenText().split('\n'))
      if (draft === null) return // overlay/menu — don't clobber
      setSessionDraft(sessionId, draft)
    }
    let sampleTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleSample = () => {
      if (sampleTimer) return
      sampleTimer = setTimeout(() => {
        sampleTimer = null
        sample()
      }, 150)
    }
```

Pass `onFrame: scheduleSample` into the `mountSession(...)` options object, and clear the timer in the effect cleanup:

```tsx
    return () => {
      if (sampleTimer) clearTimeout(sampleTimer)
      offScroll()
      mounted.dispose()
      mountedRef.current = null
    }
```

> `setSessionDraft` dedups (store) and `sample` only runs on frames, so a steady screen publishes nothing. The 150 ms debounce coalesces burst redraws. Controller gating (`session.controllerId === hub.clientId`) ensures passive viewers don't publish a stale screen.

Add `session?.controllerId` and `session?.agentKind` to the effect's dependency array (so gating re-evaluates when control changes) alongside the existing deps.

- [ ] **Step 2: Build + typecheck**

Run: `cd apps/web && bun run build`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/AgentPanel.tsx packages/terminal-client/src/index.ts
git commit -m "feat(web): mirror native Claude prompt into the shared chat draft (controller-gated)"
```

---

### Task 12: Live verification

No headless browser here (memory: /browse Chromium SIGTRAPs); use the committed Playwright relay harness (`?e2e=1` exposes `__podium`) or manual on the dev host (`https://podium-host.example.com:55555`). Deploy web + backend together (protocol changed).

- [ ] **Step 1: Full suite + build**

Run from repo root: `bun run test` (or per-package `bun run vitest run`) and `bun run build`.
Expected: all green.

- [ ] **Step 2: Phase 1 — chat send UX**

In a live Claude session's chat view: type a prompt, submit. Confirm:
- the message instantly appears as a "You" bubble with "· sending…";
- a "Working…" indicator (bouncing dots) shows;
- when the real turn echoes, the bubble de-dupes (no doubled "You");
- on an idle/needs-answer stop, the indicator reflects it / clears.

- [ ] **Step 3: Phase 1 — no misclassified bubbles**

Scroll a skill-heavy / `/btw` Claude session. Confirm no skill-body/command-expansion/SessionStart blocks render as "You".

- [ ] **Step 4: Phase 2 — native → chat mirror**

Split-pane a session: native in A (take control), chat in B. Type into native (don't submit). Within ~150 ms the chat composer in B reflects the text. Open the same session's chat on a second device — it reflects too. Open a slash menu in native → the chat composer holds its last value (no clobber).

- [ ] **Step 5: Capture real prompt snapshots to harden the extractor**

From a real native session, capture `view.screenText()` for empty/single/multi-line/slash-menu states; add any that the extractor mishandles as fixtures in `prompt-extract.test.ts` and tighten `PLACEHOLDER_PREFIXES`. Commit.

```bash
git add packages/terminal-client/src/prompt-extract.test.ts packages/terminal-client/src/prompt-extract.ts
git commit -m "test(terminal-client): real-capture fixtures for Claude prompt extractor"
```

---

## Self-review notes

- **Spec coverage:** §1.1 → Task 1 (locks the already-landed fix). §1.2 → Tasks 2–3. §1.3 → Tasks 4–5. §2.1 → Tasks 8, 11. §2.2 → Tasks 6, 7, 9, 10. §2.3 (conflict/echo) → covered by Task 7 (no echo to sender), Task 10 (inbound updates don't re-publish), Task 11 (null = no clobber, controller-gated). Initial-sync seeding → Task 7 Step 4.
- **Non-goals respected:** chat→native stays send-only (no per-keystroke injection — Task 11 only reads native; Tasks 3/10 only publish drafts, never inject). Non-Claude extraction returns null (Task 8) and the sampler early-returns for non-Claude (Task 11).
- **Type consistency:** `PendingItem`/`reconcilePending` (chat.ts) used identically in Task 3; `ChatActivity`/`chatActivity` (derive.ts) used in Task 5; `SetSessionDraftMessage`/`SessionDraftChangedMessage` consistent across Tasks 6/7/9; `sendSessionDraft`/`onSessionDraft`/`clientId` consistent across Tasks 9/10/11.
- **Deploy coupling:** Phase 2 touches the protocol — web + backend must ship together (called out in Task 12).
