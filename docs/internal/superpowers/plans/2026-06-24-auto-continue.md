# Auto-Continue Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When enabled, the server automatically re-sends `continue` to any agent that stops on a retryable error (rate limit / 500 / overloaded), on an escalating backoff capped at 5 min, until it recovers — surfaced via a first-time opt-in popup and a Settings toggle.

**Architecture:** A single global setting `autoContinue.enabled`. A backend `AutoContinueController` (one loop per session) reuses the existing `continueSession` PTY-nudge primitive, armed by agent-state transitions and the settings switch. The first manual Continue click opens a one-time popup (frontend) that can enable the setting; either choice sets `promptDismissed` so it never re-shows.

**Tech Stack:** TypeScript, Zod (settings), Vitest (server + core: node env; web: happy-dom + `react-dom/client`), Base UI dialog/switch components, tRPC.

## Global Constraints

- Package manager is **bun** — never npm/pnpm/yarn. Run package tests from the package dir (`apps/web` needs its own `vitest.config.ts` for happy-dom; the repo-root config excludes `**/.claude/**` and runs node-env).
- Settings are one normalized JSON blob round-tripped whole over tRPC. **Every new field must have a Zod `.default()`** so old blobs parse forward (`normalizeSettings` never throws on missing keys).
- Backoff values (verbatim): base cooldown **10_000 ms**, cap **300_000 ms** (5 min); schedule `min(BASE * 2^attempt, MAX)`.
- Reuse `relay.continueSession({ sessionId })` as the only "send one nudge" primitive — it is already phase-gated (`errored`) and status-gated (`live`/`starting`); do not bypass it.
- Retryable-errored predicate: `state.phase === 'errored' && state.error?.retryable === true`.
- Copy must include a plain warning that auto-continue can keep an agent running indefinitely and consuming tokens, and that it is toggleable in Settings.

---

## Task 1: Settings schema, backoff constants, prompt-gate helper (core)

**Files:**
- Modify: `packages/core/src/settings.ts`
- Test: `packages/core/src/settings.test.ts`

**Interfaces:**
- Consumes: nothing (leaf).
- Produces (all re-exported via `packages/core/src/index.ts`'s `export * from './settings.js'`):
  - `PodiumSettings.autoContinue: { enabled: boolean; promptDismissed: boolean }`
  - `AUTO_CONTINUE_BASE_DELAY_MS: 10_000`, `AUTO_CONTINUE_MAX_DELAY_MS: 300_000`
  - `shouldPromptAutoContinue(settings: PodiumSettings): boolean`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/src/settings.test.ts`. Update the existing import line at the top of the file to:

```ts
import {
  AgentChoice,
  AUTO_CONTINUE_BASE_DELAY_MS,
  AUTO_CONTINUE_MAX_DELAY_MS,
  HarnessAgent,
  normalizeSettings,
  shouldPromptAutoContinue,
} from './settings'
```

Then append these blocks:

```ts
describe('normalizeSettings — autoContinue', () => {
  it('defaults autoContinue to disabled and not-yet-prompted', () => {
    expect(normalizeSettings({}).autoContinue).toEqual({ enabled: false, promptDismissed: false })
  })

  it('fills autoContinue defaults for old blobs without the key', () => {
    const s = normalizeSettings({ sessionDefaults: { agent: 'grok' } })
    expect(s.autoContinue).toEqual({ enabled: false, promptDismissed: false })
  })

  it('keeps explicit autoContinue values', () => {
    const s = normalizeSettings({ autoContinue: { enabled: true, promptDismissed: true } })
    expect(s.autoContinue).toEqual({ enabled: true, promptDismissed: true })
  })
})

describe('auto-continue backoff constants', () => {
  it('escalates from 10s and caps at 5 minutes', () => {
    expect(AUTO_CONTINUE_BASE_DELAY_MS).toBe(10_000)
    expect(AUTO_CONTINUE_MAX_DELAY_MS).toBe(300_000)
  })
})

describe('shouldPromptAutoContinue', () => {
  it('prompts only when disabled and not previously dismissed', () => {
    expect(shouldPromptAutoContinue(normalizeSettings({}))).toBe(true)
    expect(
      shouldPromptAutoContinue(
        normalizeSettings({ autoContinue: { enabled: true, promptDismissed: false } }),
      ),
    ).toBe(false)
    expect(
      shouldPromptAutoContinue(
        normalizeSettings({ autoContinue: { enabled: false, promptDismissed: true } }),
      ),
    ).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/core && bun run test`
Expected: FAIL — `AUTO_CONTINUE_BASE_DELAY_MS`/`shouldPromptAutoContinue` are not exported; `autoContinue` is undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/settings.ts`, add the constants just after the `import { z } from 'zod'` line and the file's top doc comment (before `HarnessAgent`):

```ts
/** Auto-continue backoff: first cooldown after a `continue` nudge, doubling each
 *  consecutive retry, capped. `min(BASE * 2^attempt, MAX)`. */
export const AUTO_CONTINUE_BASE_DELAY_MS = 10_000
export const AUTO_CONTINUE_MAX_DELAY_MS = 300_000
```

Inside the `PodiumSettings = z.object({ ... })` definition, add this field (e.g. right after the `issues: …` block, before the closing `})`):

```ts
  /** When enabled, the server re-sends `continue` to any session stopped on a
   *  retryable error, on an escalating backoff up to 5 min. `promptDismissed`
   *  suppresses the one-time opt-in popup once the user has answered it. */
  autoContinue: z
    .object({
      enabled: z.boolean().default(false),
      promptDismissed: z.boolean().default(false),
    })
    .default({}),
```

At the bottom of the file (after `normalizeSettings`), add:

```ts
/** The first manual Continue click offers to enable auto-continue — but only once
 *  (until answered), and never when it's already on. */
export function shouldPromptAutoContinue(settings: PodiumSettings): boolean {
  return !settings.autoContinue.enabled && !settings.autoContinue.promptDismissed
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/core && bun run test`
Expected: PASS (all core tests, including the new blocks).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/settings.ts packages/core/src/settings.test.ts
git commit -m "feat(core): autoContinue setting, backoff constants, prompt-gate helper"
```

---

## Task 2: AutoContinueController (backend retry loop)

**Files:**
- Create: `apps/server/src/auto-continue.ts`
- Test: `apps/server/src/auto-continue.test.ts`

**Interfaces:**
- Consumes: `AUTO_CONTINUE_BASE_DELAY_MS`, `AUTO_CONTINUE_MAX_DELAY_MS` from `@podium/core`; `AgentRuntimeState` from `@podium/protocol`.
- Produces:
  - `interface AutoContinueDeps { isEnabled(): boolean; sendContinue(sessionId: string): void; getSession(sessionId: string): { live: boolean; state: AgentRuntimeState | undefined } | undefined }`
  - `class AutoContinueController` with methods:
    - `constructor(deps: AutoContinueDeps)`
    - `onStateChange(sessionId: string, next: AgentRuntimeState): void`
    - `onSettingsChanged(enabled: boolean, retryableErroredLiveIds: string[]): void`
    - `onSessionGone(sessionId: string): void`
    - `isActive(sessionId: string): boolean`

- [ ] **Step 1: Write the failing tests**

Create `apps/server/src/auto-continue.test.ts`:

```ts
import type { AgentRuntimeState } from '@podium/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoContinueController, type AutoContinueDeps } from './auto-continue'

const errored = (retryable = true): AgentRuntimeState => ({
  phase: 'errored',
  since: '2026-06-24T00:00:00Z',
  openTaskCount: 0,
  error: { class: 'server_error', retryable },
})
const working = (): AgentRuntimeState => ({
  phase: 'working',
  since: '2026-06-24T00:00:00Z',
  openTaskCount: 0,
})

function harness(initial: { live?: boolean; state?: AgentRuntimeState; enabled?: boolean } = {}) {
  const sessionId = 's1'
  const sent: string[] = []
  let live = initial.live ?? true
  let state = initial.state
  let enabled = initial.enabled ?? true
  const deps: AutoContinueDeps = {
    isEnabled: () => enabled,
    sendContinue: (id) => sent.push(id),
    getSession: (id) => (id === sessionId ? { live, state } : undefined),
  }
  return {
    c: new AutoContinueController(deps),
    sent,
    sessionId,
    setState: (s: AgentRuntimeState | undefined) => {
      state = s
    },
    setLive: (v: boolean) => {
      live = v
    },
    setEnabled: (v: boolean) => {
      enabled = v
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('AutoContinueController', () => {
  it('sends one continue immediately on a fresh retryable error', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    expect(h.sent).toEqual(['s1'])
  })

  it('escalates the cooldown 10s -> 20s -> 40s while still errored', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(h.sent.length).toBe(2)
    vi.advanceTimersByTime(20_000)
    expect(h.sent.length).toBe(3)
    vi.advanceTimersByTime(40_000)
    expect(h.sent.length).toBe(4)
  })

  it('caps the cooldown at 5 minutes', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    // sends at t = 0, 10s, 30s, 70s, 150s, 310s (gaps 10,20,40,80,160 then capped 300)
    vi.advanceTimersByTime(310_000)
    expect(h.sent.length).toBe(6)
    vi.advanceTimersByTime(299_000)
    expect(h.sent.length).toBe(6) // an uncapped 6th gap would be 320s; cap makes it 300s
    vi.advanceTimersByTime(1_000)
    expect(h.sent.length).toBe(7)
  })

  it('resets the backoff after the agent recovers, then re-errors', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    vi.advanceTimersByTime(10_000)
    expect(h.sent.length).toBe(2)
    h.setState(working())
    h.c.onStateChange(h.sessionId, working())
    expect(h.c.isActive(h.sessionId)).toBe(false)
    h.setState(errored())
    h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(3) // immediate nudge again
    vi.advanceTimersByTime(10_000)
    expect(h.sent.length).toBe(4) // gap reset to 10s, not 40s
  })

  it('stops nudging once disabled (checked on the next tick)', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    h.setEnabled(false)
    vi.advanceTimersByTime(10_000)
    expect(h.sent.length).toBe(1)
    expect(h.c.isActive(h.sessionId)).toBe(false)
  })

  it('onSettingsChanged(false) cancels running loops immediately', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    expect(h.c.isActive(h.sessionId)).toBe(true)
    h.c.onSettingsChanged(false, [])
    expect(h.c.isActive(h.sessionId)).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(h.sent.length).toBe(1)
  })

  it('onSettingsChanged(true, ids) arms already-errored sessions', () => {
    const h = harness({ state: errored() })
    h.c.onSettingsChanged(true, [h.sessionId])
    expect(h.sent).toEqual(['s1'])
  })

  it('never arms on a non-retryable error', () => {
    const h = harness({ state: errored(false) })
    h.c.onStateChange(h.sessionId, errored(false))
    expect(h.c.isActive(h.sessionId)).toBe(false)
    expect(h.sent).toEqual([])
  })

  it('never sends into a non-live session', () => {
    const h = harness({ state: errored(), live: false })
    h.c.onStateChange(h.sessionId, errored())
    expect(h.sent).toEqual([])
    expect(h.c.isActive(h.sessionId)).toBe(false)
  })

  it('keeps a single loop per session (no duplicate nudges)', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    h.c.onStateChange(h.sessionId, errored())
    expect(h.sent.length).toBe(1)
  })

  it('onSessionGone cancels the loop', () => {
    const h = harness({ state: errored() })
    h.c.onStateChange(h.sessionId, errored())
    h.c.onSessionGone(h.sessionId)
    expect(h.c.isActive(h.sessionId)).toBe(false)
    vi.advanceTimersByTime(60_000)
    expect(h.sent.length).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && bun run test auto-continue`
Expected: FAIL — `./auto-continue` module does not exist.

- [ ] **Step 3: Implement**

Create `apps/server/src/auto-continue.ts`:

```ts
import { AUTO_CONTINUE_BASE_DELAY_MS, AUTO_CONTINUE_MAX_DELAY_MS } from '@podium/core'
import type { AgentRuntimeState } from '@podium/protocol'

/** Everything the controller needs from the relay, injected so the loop is
 *  unit-testable with spies + fake timers and carries no relay knowledge. */
export interface AutoContinueDeps {
  /** The global master switch, read fresh on every decision. */
  isEnabled: () => boolean
  /** Type one `continue⏎` into the session (relay.continueSession, phase-gated). */
  sendContinue: (sessionId: string) => void
  /** Liveness + latest agent state, or undefined if the session is gone. */
  getSession: (
    sessionId: string,
  ) => { live: boolean; state: AgentRuntimeState | undefined } | undefined
}

/** A retryable-errored agent is one stopped on an error a blind retry might clear. */
function isRetryableErrored(s: AgentRuntimeState | undefined): boolean {
  return s?.phase === 'errored' && s.error?.retryable === true
}

/**
 * Backend auto-continue. When the master switch is on, every live session that
 * enters a retryable-errored state gets `continue` typed into it on an escalating
 * backoff (10s → 20s → … → 5 min cap) until it recovers. One loop per session;
 * the loop resets its backoff the moment the agent leaves the errored phase.
 */
export class AutoContinueController {
  /** sessionId → live loop. `attempt` drives backoff; `timer` is the pending tick. */
  private readonly loops = new Map<
    string,
    { attempt: number; timer: ReturnType<typeof setTimeout> | undefined }
  >()

  constructor(private readonly deps: AutoContinueDeps) {}

  /** Backoff for the Nth (0-based) wait after a submit, capped at 5 min. */
  private delayMs(attempt: number): number {
    return Math.min(AUTO_CONTINUE_BASE_DELAY_MS * 2 ** attempt, AUTO_CONTINUE_MAX_DELAY_MS)
  }

  /** Relay calls this on every agent-state transition. Arms on a retryable error,
   *  stops (resetting backoff) the instant the agent is no longer in one. */
  onStateChange(sessionId: string, next: AgentRuntimeState): void {
    if (this.deps.isEnabled() && isRetryableErrored(next)) this.arm(sessionId)
    else this.stop(sessionId)
  }

  /** Master switch flipped. On enable, arm any already-errored live sessions; on
   *  disable, cancel every running loop. */
  onSettingsChanged(enabled: boolean, retryableErroredLiveIds: string[]): void {
    if (!enabled) {
      this.stopAll()
      return
    }
    for (const id of retryableErroredLiveIds) this.arm(id)
  }

  /** Session hibernated/exited/killed — drop its loop promptly. */
  onSessionGone(sessionId: string): void {
    this.stop(sessionId)
  }

  /** True while a loop is active for the session (introspection/test helper). */
  isActive(sessionId: string): boolean {
    return this.loops.has(sessionId)
  }

  private arm(sessionId: string): void {
    if (this.loops.has(sessionId)) return // one loop per session
    this.loops.set(sessionId, { attempt: 0, timer: undefined })
    this.tick(sessionId)
  }

  /** Send one nudge if still warranted, then schedule the next with backoff. */
  private tick(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    const snap = this.deps.getSession(sessionId)
    if (!this.deps.isEnabled() || !snap || !snap.live || !isRetryableErrored(snap.state)) {
      this.stop(sessionId)
      return
    }
    this.deps.sendContinue(sessionId)
    const ms = this.delayMs(loop.attempt)
    loop.attempt += 1
    loop.timer = setTimeout(() => this.tick(sessionId), ms)
  }

  private stop(sessionId: string): void {
    const loop = this.loops.get(sessionId)
    if (!loop) return
    if (loop.timer) clearTimeout(loop.timer)
    this.loops.delete(sessionId)
  }

  private stopAll(): void {
    for (const id of [...this.loops.keys()]) this.stop(id)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test auto-continue`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/auto-continue.ts apps/server/src/auto-continue.test.ts
git commit -m "feat(server): AutoContinueController — per-session retry loop with capped backoff"
```

---

## Task 3: Wire the controller into the relay

**Files:**
- Modify: `apps/server/src/relay.ts`
- Test: `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: `AutoContinueController` (Task 2); existing `this.continueSession`, `this.sessions`, `this.store`, the `case 'agentState'` daemon handler, `setSettings`, `hibernateSession`, `killSession`, and the `sessionExit` daemon handler.
- Produces: auto-continue behavior driven by real agent-state messages + the settings switch. No new public API.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/relay.test.ts`. Add at the top of the file, next to the other imports:

```ts
import type { AgentRuntimeState } from '@podium/protocol'
```

Then append this describe block (the helpers `bind`, and `new SessionRegistry()` already exist in the file):

```ts
describe('SessionRegistry — auto-continue', () => {
  const erroredState: AgentRuntimeState = {
    phase: 'errored',
    since: '2026-06-24T00:00:00Z',
    openTaskCount: 0,
    error: { class: 'server_error', retryable: true },
  }
  const continueInput = expect.objectContaining({
    type: 'input',
    data: Buffer.from('continue\r').toString('base64'),
  })

  function enableAutoContinue(reg: SessionRegistry) {
    const s = reg.getSettings()
    reg.setSettings({ ...s, autoContinue: { enabled: true, promptDismissed: false } })
  }

  it('does NOT auto-send continue when the setting is off', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    reg.onDaemonMessage(bind('s1'))
    reg.onDaemonMessage({ type: 'agentState', sessionId: 's1', state: erroredState })
    expect(daemon).not.toContainEqual(continueInput)
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })

  it('auto-sends continue when an enabled session hits a retryable error', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    enableAutoContinue(reg)
    reg.onDaemonMessage(bind('s1'))
    reg.onDaemonMessage({ type: 'agentState', sessionId: 's1', state: erroredState })
    expect(daemon).toContainEqual(continueInput)
    // Cancel the live loop so no real backoff timer dangles past the test.
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })

  it('arms already-errored sessions when the setting is switched on', () => {
    const reg = new SessionRegistry()
    const daemon: ControlMessage[] = []
    reg.attachDaemon((m) => daemon.push(m))
    reg.onDaemonMessage(bind('s1'))
    reg.onDaemonMessage({ type: 'agentState', sessionId: 's1', state: erroredState })
    expect(daemon).not.toContainEqual(continueInput) // off → silent so far
    enableAutoContinue(reg)
    expect(daemon).toContainEqual(continueInput) // flipping on arms the errored session
    reg.setSettings({ ...reg.getSettings(), autoContinue: { enabled: false, promptDismissed: false } })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && bun run test relay`
Expected: FAIL — no continue input is produced (controller not wired).

- [ ] **Step 3: Implement the wiring**

In `apps/server/src/relay.ts`:

1. Add the import next to `import { IssueService } from './issues'` (line ~32):

```ts
import { AutoContinueController } from './auto-continue'
```

2. Add a field declaration next to `readonly issues: IssueService` (line ~95):

```ts
  /** Backend auto-continue loop; constructed in the constructor (see below). */
  private autoContinue!: AutoContinueController
```

3. In the constructor, after the `this.issues = new IssueService({ … })` block, construct the controller:

```ts
    this.autoContinue = new AutoContinueController({
      isEnabled: () => this.store.getSettings().autoContinue.enabled,
      sendContinue: (sessionId) => {
        this.continueSession({ sessionId })
      },
      getSession: (sessionId) => {
        const s = this.sessions.get(sessionId)
        if (!s) return undefined
        return { live: s.status === 'live' || s.status === 'starting', state: s.agentState }
      },
    })
```

4. In the `case 'agentState':` handler, immediately after `session.setAgentState(msg.state)` (line ~1169), add:

```ts
        this.autoContinue.onStateChange(msg.sessionId, msg.state)
```

5. Replace the existing `setSettings` method (lines ~361-364) with an arm/disarm-aware version:

```ts
  setSettings(settings: PodiumSettings): PodiumSettings {
    const wasEnabled = this.store.getSettings().autoContinue.enabled
    this.store.setSettings(settings)
    const nowEnabled = settings.autoContinue.enabled
    if (nowEnabled !== wasEnabled) {
      const ids = nowEnabled
        ? [...this.sessions.values()]
            .filter(
              (s) =>
                (s.status === 'live' || s.status === 'starting') &&
                s.agentState?.phase === 'errored' &&
                s.agentState.error?.retryable === true,
            )
            .map((s) => s.sessionId)
        : []
      this.autoContinue.onSettingsChanged(nowEnabled, ids)
    }
    return settings
  }
```

6. Add lifecycle cancellation. In `hibernateSession`, right after `session.status = 'hibernated'` (line ~634):

```ts
    this.autoContinue.onSessionGone(sessionId)
```

In `killSession` (line ~743), after it looks up the session, add `this.autoContinue.onSessionGone(input.sessionId)` (place it alongside the existing teardown; it is a no-op if no loop is active). In the `case 'sessionExit':` daemon handler (the `this.sessions.get(msg.sessionId)?.onExit(msg.code)` line ~1131), add immediately after:

```ts
        this.autoContinue.onSessionGone(msg.sessionId)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/server && bun run test relay`
Expected: PASS (existing relay tests + the 3 new auto-continue wiring tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/server && bun run typecheck`
Expected: no errors.

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(server): drive auto-continue from agent-state transitions and the settings switch"
```

---

## Task 4: Settings toggle in the Sessions tab (web)

**Files:**
- Modify: `apps/web/src/SettingsView.tsx`
- Test: `apps/web/test/settings.structure.test.ts`

**Interfaces:**
- Consumes: `settings.autoContinue` (Task 1); existing `patch()`, `Section`, `Row`, `Switch` in `SettingsView.tsx`.
- Produces: a user-visible toggle bound to `autoContinue.enabled`.

- [ ] **Step 1: Write the failing test**

Append to `apps/web/test/settings.structure.test.ts`:

```ts
describe('auto-continue setting', () => {
  it('exposes an auto-continue toggle with a token-cost warning', () => {
    const src = read('SettingsView.tsx')
    expect(src).toContain('Auto-continue on errors')
    expect(src).toContain('autoContinue')
    expect(src).toContain('enabled: checked')
    // The plain warning the spec requires.
    expect(src).toContain('indefinitely')
    expect(src).toContain('tokens')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test:unit settings.structure`
Expected: FAIL — strings not present.

- [ ] **Step 3: Implement**

In `apps/web/src/SettingsView.tsx`, inside the `{tab === 'sessions' && ( … )}` block, add a new `Section` immediately after the closing `</Section>` of the "New sessions" section (around line 219):

```tsx
              <Section
                title="Auto-continue on errors"
                hint="When an agent stops on a retryable error (rate limit, server error), keep re-sending “continue” on an increasing delay (up to 5 min) until it recovers. Heads up: this can keep an agent running indefinitely and consuming tokens."
              >
                <Row label="Enabled">
                  <Switch
                    checked={settings.autoContinue.enabled}
                    onCheckedChange={(checked) =>
                      patch({ autoContinue: { ...settings.autoContinue, enabled: checked } })
                    }
                  />
                </Row>
              </Section>
```

(Note: `Switch` uses `onCheckedChange` here per the existing hibernation toggle at line ~273 — match that call shape exactly.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test:unit settings.structure`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

```bash
git add apps/web/src/SettingsView.tsx apps/web/test/settings.structure.test.ts
git commit -m "feat(web): auto-continue toggle in Settings -> New sessions"
```

---

## Task 5: First-time opt-in popup + store wiring (web)

**Files:**
- Create: `apps/web/src/AutoContinueDialog.tsx`
- Modify: `apps/web/src/store.tsx`
- Modify: `apps/web/src/AppShell.tsx`
- Test: `apps/web/test/auto-continue.structure.test.ts`

**Interfaces:**
- Consumes: `shouldPromptAutoContinue`, `PodiumSettings` (Task 1); existing store `trpc`, `continueSession`; Base UI `Dialog*`, `Button`.
- Produces: store state `autoContinuePromptSessionId: string | null` + `closeAutoContinuePrompt(): void`; component `AutoContinueDialog`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auto-continue.structure.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL('../src/' + rel, import.meta.url)), 'utf8')

describe('auto-continue popup', () => {
  it('store gates the popup on shouldPromptAutoContinue after a manual continue', () => {
    const src = read('store.tsx')
    expect(src).toContain('shouldPromptAutoContinue')
    expect(src).toContain('autoContinuePromptSessionId')
    expect(src).toContain('closeAutoContinuePrompt')
  })

  it('dialog warns about runaway token cost and offers enable / not now', () => {
    const src = read('AutoContinueDialog.tsx')
    expect(src).toContain('Enable auto-continue')
    expect(src).toContain('Not now')
    expect(src).toContain('indefinitely')
    expect(src).toContain('tokens')
    expect(src).toContain('promptDismissed: true')
  })

  it('AppShell mounts the dialog', () => {
    const src = read('AppShell.tsx')
    expect(src).toContain('<AutoContinueDialog')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web && bun run test:unit auto-continue.structure`
Expected: FAIL — `AutoContinueDialog.tsx` missing; store strings absent.

- [ ] **Step 3a: Create the dialog**

Create `apps/web/src/AutoContinueDialog.tsx`:

```tsx
import type { JSX } from 'react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useStore } from './store'

/**
 * One-time opt-in shown the first time the user clicks Continue on an errored
 * agent. Either choice records `promptDismissed: true` so it never re-appears;
 * "Enable" also flips the global `autoContinue.enabled` switch on.
 */
export function AutoContinueDialog(): JSX.Element | null {
  const { trpc, autoContinuePromptSessionId, closeAutoContinuePrompt } = useStore()
  const [busy, setBusy] = useState(false)
  const open = autoContinuePromptSessionId !== null

  const finish = async (enable: boolean) => {
    setBusy(true)
    try {
      const current = await trpc.settings.get.query()
      await trpc.settings.set.mutate({
        ...current,
        autoContinue: {
          enabled: enable ? true : current.autoContinue.enabled,
          promptDismissed: true,
        },
      })
    } catch {
      // Best-effort: a failed write just means the popup may show again later.
    }
    setBusy(false)
    closeAutoContinuePrompt()
  }

  if (!open) return null
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) void finish(false)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Auto-continue when agents error?</DialogTitle>
          <DialogDescription>
            Podium just re-sent “continue”. Want it to do that automatically whenever an
            agent stops on a retryable error (rate limit, server error)? It retries on an
            increasing delay — up to 5 minutes between tries — until the agent recovers.
          </DialogDescription>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          Heads up: this can keep an agent running indefinitely and consuming tokens with no
          one watching. You can turn it off anytime in Settings → New sessions.
        </p>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void finish(false)}>
            Not now
          </Button>
          <Button disabled={busy} onClick={() => void finish(true)}>
            Enable auto-continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3b: Wire the store**

In `apps/web/src/store.tsx`:

1. Extend the import on line 1 to pull the helper from core:

```ts
import { type Sidebar as SidebarSettings, shouldPromptAutoContinue } from '@podium/core'
```

2. In the `Store` interface (near the existing `continueSession` declaration ~line 96), add:

```ts
  /** Session whose first manual Continue should raise the auto-continue popup,
   *  or null when the popup is closed. */
  autoContinuePromptSessionId: string | null
  closeAutoContinuePrompt: () => void
```

3. In the provider body (near the other `useState` hooks, e.g. after `settingsTab` ~line 219), add:

```ts
  const [autoContinuePromptSessionId, setAutoContinuePromptSessionId] = useState<string | null>(null)
```

4. Replace the existing `continueSession` memo (lines ~321-326) with:

```ts
  const continueSession = useMemo(
    () => async (sessionId: string) => {
      await trpc.sessions.continue.mutate({ sessionId }).catch(() => {})
      // After the manual nudge, offer to make it automatic — once, and only when
      // it isn't already on / hasn't already been answered.
      try {
        const settings = await trpc.settings.get.query()
        if (shouldPromptAutoContinue(settings)) setAutoContinuePromptSessionId(sessionId)
      } catch {
        // Non-fatal: the nudge already happened; just skip the offer.
      }
    },
    [trpc],
  )
  const closeAutoContinuePrompt = useMemo(
    () => () => setAutoContinuePromptSessionId(null),
    [],
  )
```

5. In the store `value` object that gets provided (near where `continueSession` and `sidebarSettings` are listed ~lines 594-606), add both new members:

```ts
    autoContinuePromptSessionId,
    closeAutoContinuePrompt,
```

- [ ] **Step 3c: Mount in AppShell**

In `apps/web/src/AppShell.tsx`:

1. Add the import next to the other view imports (~line 7):

```ts
import { AutoContinueDialog } from './AutoContinueDialog'
```

2. In `AppBody`, replace the final `if (isMobile) … return …` tail (lines ~93-116) so the dialog is always mounted alongside whichever shell renders:

```tsx
  return (
    <>
      {isMobile ? (
        <MobileApp />
      ) : (
        <div className="desktop-shell">
          <Sidebar />
          {view === 'home' ? (
            <HomeView />
          ) : view === 'settings' ? (
            <SettingsView />
          ) : view === 'usage' ? (
            <UsageView />
          ) : view === 'issues' ? (
            <IssuesView />
          ) : (
            <Workspace />
          )}
          {/* The superagent / BTW thread is a collapsible right dock, so you can watch
              an agent and orchestrate it side by side instead of a full-screen swap. */}
          {superOpen && (
            <aside className="flex w-[400px] max-w-[40vw] min-w-[320px] flex-none flex-col border-l border-border bg-card">
              <SuperagentView onClose={() => setSuperOpen(false)} />
            </aside>
          )}
        </div>
      )}
      <AutoContinueDialog />
    </>
  )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web && bun run test:unit auto-continue.structure`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

Run: `cd apps/web && bun run typecheck`
Expected: no errors.

```bash
git add apps/web/src/AutoContinueDialog.tsx apps/web/src/store.tsx apps/web/src/AppShell.tsx apps/web/test/auto-continue.structure.test.ts
git commit -m "feat(web): one-time auto-continue opt-in popup wired through the store"
```

---

## Task 6: Full verification + manual e2e

**Files:**
- Create (test-only helper, not committed to app): `scripts/fault-proxy.mjs`
- No app files modified.

**Interfaces:**
- Consumes: everything above.
- Produces: a green suite and a documented manual smoke test.

- [ ] **Step 1: Run every affected suite**

```bash
cd packages/core && bun run test
cd ../../apps/server && bun run test
cd ../web && bun run test:unit
```

Expected: core + server fully green; web shows only the 4 **pre-existing** `shell.structure.test.ts` failures (sortable tabs / new-panel menu / sidebar work panels / connection indicator) — confirm the count is still exactly 4 and that none are in `settings.structure` or `auto-continue.structure`.

- [ ] **Step 2: Typecheck the whole repo**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 3: Write the fault-injecting proxy**

Create `scripts/fault-proxy.mjs` — a tiny passthrough to Anthropic that returns HTTP 500 for the first N requests, then proxies normally. This deterministically drives a Claude Code session into the retryable `server_error` state.

```js
// Usage: ANTHROPIC_API_BASE=https://api.anthropic.com FAIL_FIRST=3 node scripts/fault-proxy.mjs 8788
import http from 'node:http'
import https from 'node:https'

const port = Number(process.argv[2] ?? 8788)
const upstream = process.env.ANTHROPIC_API_BASE ?? 'https://api.anthropic.com'
let failsLeft = Number(process.env.FAIL_FIRST ?? 3)

http
  .createServer((req, res) => {
    if (failsLeft > 0) {
      failsLeft--
      console.log(`[fault-proxy] injecting 500 (${failsLeft} left) for ${req.url}`)
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'injected' } }))
      return
    }
    const target = new URL(req.url, upstream)
    const proxyReq = https.request(
      target,
      { method: req.method, headers: { ...req.headers, host: target.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers)
        up.pipe(res)
      },
    )
    proxyReq.on('error', () => {
      res.writeHead(502).end()
    })
    req.pipe(proxyReq)
  })
  .listen(port, () => console.log(`[fault-proxy] :${port} → ${upstream}, failing first ${failsLeft}`))
```

- [ ] **Step 4: Manual smoke test (documented, run by a human)**

1. Start the proxy: `FAIL_FIRST=4 node scripts/fault-proxy.mjs 8788`.
2. Launch a Claude Code session through Podium with `ANTHROPIC_BASE_URL=http://localhost:8788` in its environment (so its API calls hit the proxy).
3. Send it any prompt → the first calls 500 → the session shows the red **Continue** button (phase `errored`, class `server_error`, retryable).
4. Click **Continue** once → confirm the agent gets nudged AND the opt-in popup appears.
5. Click **Enable auto-continue** → confirm: popup never returns, Settings → New sessions shows the toggle ON, and the backend keeps re-sending `continue` on escalating delays until `FAIL_FIRST` is exhausted and the agent recovers.
6. Toggle the setting OFF in Settings → confirm a freshly-errored session is no longer auto-nudged.
7. Cross-check against the `agentinsight` proxy DB on this machine that the injected error envelope matches real upstream 500/529s (classes `server_error` / `overloaded`).

- [ ] **Step 5: Commit the helper + invoke finishing-a-development-branch**

```bash
git add scripts/fault-proxy.mjs
git commit -m "test(auto-continue): fault-injecting Anthropic proxy for manual e2e"
```

Then use the `superpowers:finishing-a-development-branch` skill to present integration options.
