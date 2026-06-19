# Session Snooze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user snooze a session out of the sidebar's "NEEDS YOUR ATTENTION" surface — directly (until next message) or for 1h / until tomorrow-5am — with a persisted flag that never touches the agent's state.

**Architecture:** A new per-session `snoozes` SQLite table (mirrors `pins`) feeds a `snoozedUntil` field on the wire `SessionMeta` (`undefined`=not snoozed, `null`=until next message, ISO=timed). The web computes "effectively snoozed" at render time against a 60s clock tick, excludes such sessions from the top attention group, and sinks them to the bottom of each worktree's list. A snooze clears server-side on a submitted prompt (`sendText`) or when the agent transitions out of the attention phase.

**Tech Stack:** TypeScript monorepo (bun workspaces), zod protocol, `node:sqlite`, tRPC, React + Base UI/shadcn + Tailwind v4, lucide-react, vitest, biome.

## Global Constraints

- **TDD**: write the failing test first for every logic change; UI-only tasks verify by typecheck + build + the final runtime check.
- **Commands** (run from worktree root `/home/user/src/other/podium/.claude/worktrees/feat+session-snooze`): typecheck `bun run typecheck`; web tests `bunx vitest run --root apps/web`; server tests `bunx vitest run --root apps/server`; protocol tests `bunx vitest run --root packages/protocol`; build `bun run build`; format `bun run format`. **Do NOT** run the agent-bridge integration suite (leaks PTY masters).
- **Snooze field semantics (verbatim, everywhere):** `snoozedUntil` `undefined`/absent = not snoozed; `null` = snoozed until the next message; ISO 8601 string = snoozed until that time *or* the next message, whichever first.
- **"Until tomorrow" = the next 5:00am local strictly after now.** "1h" = now + 3,600,000 ms.
- **Clear triggers:** (1) a submitted prompt via `registry.sendText` (covers chat send, `resumeAndSend`, `sendTextWhenReady`); (2) the agent's phase transitions *out of* the attention set (`needs_user`/`errored`/`idle`-with-non-`done` kind) — handled in the `agentState` daemon-message handler. Timed snoozes additionally lapse by the clock (client render + lazy server cleanup in `listSnoozes`).
- **Orthogonal to agent state:** never modify `agentState`/`phase`. Snooze lives only in its own table + the `snoozedUntil` field.
- **Out of scope (do not change):** the Command-center home board (`groupSessions`/`HomeView`), repo/worktree snoozing, lapse notifications. Commit messages: conventional (`feat(snooze): …`), with the repo's Co-Authored-By / Claude-Session trailers.

---

### Task 1: Protocol — `snoozedUntil` on `SessionMeta`

**Files:**
- Modify: `packages/protocol/src/messages.ts` (inside the `SessionMeta` object, after the `agentColor` field, ~line 115)
- Test: `packages/protocol/src/messages.test.ts`

**Interfaces:**
- Produces: `SessionMeta.snoozedUntil?: string | null` on the wire schema (consumed by server `toMeta`, web `derive`/store/UI).

- [ ] **Step 1: Write the failing test**

In `packages/protocol/src/messages.test.ts`, inside the `describe('shared schemas', …)` block, add:

```ts
  it('SessionMeta carries an optional, nullable snoozedUntil', () => {
    const base = {
      sessionId: 's1',
      agentKind: 'claude-code',
      title: 't',
      cwd: '/w',
      status: 'live',
      controllerId: null,
      geometry: { cols: 80, rows: 24 },
      epoch: 0,
      clientCount: 0,
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      origin: { kind: 'spawn' },
      archived: false,
    } as const
    expect(SessionMeta.parse(base).snoozedUntil).toBeUndefined()
    expect(SessionMeta.parse({ ...base, snoozedUntil: null }).snoozedUntil).toBeNull()
    expect(SessionMeta.parse({ ...base, snoozedUntil: '2026-06-19T06:00:00.000Z' }).snoozedUntil).toBe(
      '2026-06-19T06:00:00.000Z',
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root packages/protocol messages.test.ts`
Expected: FAIL — the `snoozedUntil: null` parse returns `undefined` (field not yet in schema).

- [ ] **Step 3: Add the field**

In `packages/protocol/src/messages.ts`, after the `agentColor: z.string().optional(),` line and before the closing `})` of `SessionMeta`:

```ts
  /** Snooze state — orthogonal to agentState. `undefined`/absent = not snoozed;
   *  `null` = snoozed until the next message; an ISO string = snoozed until that
   *  time (or the next message, whichever first). Drives the sidebar's attention
   *  triage only; never changes the agent's phase. */
  snoozedUntil: z.string().nullable().optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root packages/protocol messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/messages.test.ts
git commit -m "feat(snooze): add snoozedUntil to SessionMeta wire schema"
```

---

### Task 2: Server store — `snoozes` table + CRUD

**Files:**
- Modify: `apps/server/src/store.ts` (type near `PinState`; `migrate()`; new `// ---- snoozes ----` block after the pins block ~line 153; `deleteSession` ~line 272)
- Test: `apps/server/src/store.test.ts` (new `describe('SessionStore snoozes', …)`)

**Interfaces:**
- Produces: `export type SnoozeMap = Record<string, string | null>`; `SessionStore.listSnoozes(now?: number): SnoozeMap`; `SessionStore.setSnooze(sessionId: string, until: string | null): void`; `SessionStore.clearSnooze(sessionId: string): void`.

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/store.test.ts`, after the `describe('SessionStore pins', …)` block, add:

```ts
describe('SessionStore snoozes', () => {
  it('starts empty, sets until-next-message (null) and timed, overwrites, and clears', () => {
    const store = new SessionStore(':memory:')
    expect(store.listSnoozes()).toEqual({})

    store.setSnooze('s1', null)
    store.setSnooze('s2', '2999-01-01T05:00:00.000Z')
    expect(store.listSnoozes(0)).toEqual({ s1: null, s2: '2999-01-01T05:00:00.000Z' })

    // overwrite s1 with a timed value
    store.setSnooze('s1', '2999-01-01T05:00:00.000Z')
    expect(store.listSnoozes(0).s1).toBe('2999-01-01T05:00:00.000Z')

    store.clearSnooze('s1')
    expect(store.listSnoozes(0)).toEqual({ s2: '2999-01-01T05:00:00.000Z' })
    store.close()
  })

  it('lazily drops a timed snooze whose deadline has passed; keeps null forever', () => {
    const store = new SessionStore(':memory:')
    store.setSnooze('past', '2000-01-01T00:00:00.000Z')
    store.setSnooze('forever', null)
    const now = Date.parse('2026-06-19T00:00:00.000Z')
    expect(store.listSnoozes(now)).toEqual({ forever: null })
    // the expired row was deleted, not just filtered
    expect(store.listSnoozes(0)).toEqual({ forever: null })
    store.close()
  })

  it('removes a snooze when the session is deleted', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession(row({ id: 's1' }))
    store.setSnooze('s1', null)
    store.deleteSession('s1')
    expect(store.listSnoozes(0)).toEqual({})
    store.close()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run --root apps/server store.test.ts -t snoozes`
Expected: FAIL — `store.listSnoozes`/`setSnooze`/`clearSnooze` are not functions.

- [ ] **Step 3: Add the type, table, methods, and delete-scrub**

In `apps/server/src/store.ts`, after the `PinState` interface (~line 13) add:

```ts
/** sessionId → snooze deadline. `null` = until next message; ISO = timed. */
export type SnoozeMap = Record<string, string | null>
```

In `migrate()`, immediately after the `pins` `CREATE TABLE` (~line 557), add:

```ts
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS snoozes (
         session_id TEXT PRIMARY KEY,
         snoozed_until TEXT,
         created_at TEXT NOT NULL
       )`,
    )
```

After the `setPin(…)` method (end of the `// ---- pins ----` block, ~line 153), add:

```ts
  // ---- snoozes ----
  /** Active snoozes. Lazily deletes any timed snooze whose deadline has passed
   *  (the client clock also ignores lapsed ones at render time; this is just
   *  housekeeping). `null` snoozes (until-next-message) never lapse by time. */
  listSnoozes(now: number = Date.now()): SnoozeMap {
    const rows = this.db.prepare('SELECT session_id, snoozed_until FROM snoozes').all() as {
      session_id: string
      snoozed_until: string | null
    }[]
    const out: SnoozeMap = {}
    const expired: string[] = []
    for (const r of rows) {
      if (r.snoozed_until !== null && Date.parse(r.snoozed_until) <= now) {
        expired.push(r.session_id)
        continue
      }
      out[r.session_id] = r.snoozed_until
    }
    for (const id of expired) this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
    return out
  }

  /** Snooze a session. `until` = null → until next message; ISO string → timed. */
  setSnooze(sessionId: string, until: string | null): void {
    const id = sessionId.trim()
    if (!id) throw new Error('snooze session id is empty')
    this.db
      .prepare(
        `INSERT INTO snoozes (session_id, snoozed_until, created_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET snoozed_until = excluded.snoozed_until`,
      )
      .run(id, until, new Date().toISOString())
  }

  /** Un-snooze a session (no-op if not snoozed). */
  clearSnooze(sessionId: string): void {
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(sessionId.trim())
  }
```

In `deleteSession(id)` (~line 272), after the existing `DELETE FROM pins …` line add:

```ts
    this.db.prepare('DELETE FROM snoozes WHERE session_id = ?').run(id)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bunx vitest run --root apps/server store.test.ts`
Expected: PASS (the new snoozes block + all pre-existing store tests).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.test.ts
git commit -m "feat(snooze): snoozes table + CRUD with lazy expiry in SessionStore"
```

---

### Task 3: Server `Session` — `snoozedUntil` field, `clearSnooze`, `toMeta`

**Files:**
- Modify: `apps/server/src/session.ts` (field near `agentColor` ~line 99; method near `setAgentColor` ~line 424; `toMeta` ~line 506)
- Test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `Session.snoozedUntil: string | null | undefined` (public field, default `undefined`); `Session.clearSnooze(): boolean` (true iff it changed). `toMeta()` includes `snoozedUntil` iff `!== undefined`.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/session.test.ts`, add inside `describe('Session', …)`:

```ts
  it('toMeta surfaces snoozedUntil only when set; clearSnooze reports change', () => {
    const s = makeSession()
    expect('snoozedUntil' in s.toMeta()).toBe(false)
    expect(s.clearSnooze()).toBe(false)

    s.snoozedUntil = null
    expect(s.toMeta().snoozedUntil).toBeNull()

    s.snoozedUntil = '2999-01-01T05:00:00.000Z'
    expect(s.toMeta().snoozedUntil).toBe('2999-01-01T05:00:00.000Z')

    expect(s.clearSnooze()).toBe(true)
    expect('snoozedUntil' in s.toMeta()).toBe(false)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root apps/server session.test.ts -t snoozedUntil`
Expected: FAIL — `s.clearSnooze` is not a function / `snoozedUntil` missing from `toMeta`.

- [ ] **Step 3: Add the field, method, and toMeta spread**

In `apps/server/src/session.ts`, after `agentColor: string | undefined` (~line 99) add:

```ts
  /** Snooze deadline — orthogonal to agentState. undefined = not snoozed; null =
   *  until next message; ISO string = timed. Lives in its own `snoozes` table, so
   *  it is NOT part of toRow(); the registry seeds it at load and on mutation. */
  snoozedUntil: string | null | undefined = undefined
```

After `setAgentColor(…)` / the `NO_COLOR` set (~line 426) add:

```ts
  /** Un-snooze. Returns true if it actually changed (lets the caller skip a
   *  redundant broadcast). */
  clearSnooze(): boolean {
    if (this.snoozedUntil === undefined) return false
    this.snoozedUntil = undefined
    return true
  }
```

In `toMeta()` (~line 506), after the `agentColor` spread line add:

```ts
      ...(this.snoozedUntil !== undefined ? { snoozedUntil: this.snoozedUntil } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root apps/server session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "feat(snooze): Session.snoozedUntil field, clearSnooze, toMeta wiring"
```

---

### Task 4: Server registry — load, mutate, and clear-triggers

**Files:**
- Modify: `apps/server/src/relay.ts` (`loadFromStore` ~line 116; `listPins`/`setPin` block ~line 235 → add snooze methods + a static `isAttentionPhase`/`leftAttention`; `sendText` ~line 311; `agentState` handler ~line 888)
- Test: `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: `SessionStore.listSnoozes/setSnooze/clearSnooze` (Task 2); `Session.snoozedUntil`/`clearSnooze` (Task 3).
- Produces: `SessionRegistry.listSnoozes(): SnoozeMap`; `SessionRegistry.setSnooze({ sessionId, until }: { sessionId: string; until: string | null }): void`; `SessionRegistry.clearSnooze(sessionId: string): void`. (Consumed by Task 5 router.)

- [ ] **Step 1: Write the failing tests**

In `apps/server/src/relay.test.ts`, add a new describe block (uses the existing `sink`, `G`, `bind` helpers):

```ts
describe('SessionRegistry snooze', () => {
  const agentState = (sessionId: string, phase: string, extra: Record<string, unknown> = {}) =>
    ({
      type: 'agentState',
      sessionId,
      state: { phase, since: '2026-06-19T00:00:00.000Z', openTaskCount: 0, ...extra },
    }) as const

  it('set/list/clear round-trips and shows on the session meta', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))

    reg.setSnooze({ sessionId, until: null })
    expect(reg.listSnoozes()).toEqual({ [sessionId]: null })
    expect(reg.listSessions()[0]?.snoozedUntil).toBeNull()

    reg.clearSnooze(sessionId)
    expect(reg.listSnoozes()).toEqual({})
    expect('snoozedUntil' in (reg.listSessions()[0] ?? {})).toBe(false)
  })

  it('a submitted prompt (sendText) clears the snooze', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))
    reg.setSnooze({ sessionId, until: null })

    reg.sendText({ sessionId, text: 'hi' })
    expect(reg.listSnoozes()).toEqual({})
  })

  it('leaving the attention phase clears it; staying in attention keeps it', () => {
    const reg = new SessionRegistry()
    reg.attachDaemon(() => {})
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/p' })
    reg.onDaemonMessage(bind(sessionId))
    reg.onDaemonMessage(agentState(sessionId, 'needs_user', { need: { kind: 'question' } }))
    reg.setSnooze({ sessionId, until: null })

    // needs_user -> idle/question is still attention: snooze survives.
    reg.onDaemonMessage(agentState(sessionId, 'idle', { idle: { kind: 'question' } }))
    expect(reg.listSnoozes()).toEqual({ [sessionId]: null })

    // -> working leaves attention: snooze clears.
    reg.onDaemonMessage(agentState(sessionId, 'working'))
    expect(reg.listSnoozes()).toEqual({})
  })

  it('seeds snoozedUntil from the store at load', () => {
    const store = new SessionStore(':memory:')
    store.upsertSession({
      id: 's1',
      agentKind: 'claude-code',
      cwd: '/p',
      title: 't',
      name: null,
      originKind: 'spawn',
      conversationId: null,
      resumeKind: null,
      resumeValue: null,
      status: 'hibernated',
      exitCode: null,
      durableLabel: 'd',
      createdAt: '2026-06-19T00:00:00.000Z',
      lastActiveAt: '2026-06-19T00:00:00.000Z',
      archived: false,
      workState: null,
    })
    store.setSnooze('s1', null)
    const reg = new SessionRegistry(store)
    expect(reg.listSessions()[0]?.snoozedUntil).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run --root apps/server relay.test.ts -t snooze`
Expected: FAIL — `reg.setSnooze`/`listSnoozes`/`clearSnooze` not functions.

- [ ] **Step 3: Seed snooze at load**

In `apps/server/src/relay.ts` `loadFromStore()` (~line 116), capture the snooze map once at the top of the method, then set it on each session after `this.sessions.set(r.id, session)`:

```ts
  private loadFromStore(): void {
    const snoozes = this.store.listSnoozes()
    for (const r of this.store.loadSessions()) {
```

…and immediately after `this.sessions.set(r.id, session)` (~line 160):

```ts
      if (r.id in snoozes) session.snoozedUntil = snoozes[r.id]
```

- [ ] **Step 4: Add registry snooze methods + attention helpers**

In `apps/server/src/relay.ts`, after the `setPin(…)` method (~line 235) add:

```ts
  listSnoozes() {
    return this.store.listSnoozes()
  }

  setSnooze({ sessionId, until }: { sessionId: string; until: string | null }): void {
    this.store.setSnooze(sessionId, until)
    const session = this.sessions.get(sessionId)
    if (session) session.snoozedUntil = until
    this.broadcastSessions()
  }

  clearSnooze(sessionId: string): void {
    this.store.clearSnooze(sessionId)
    const session = this.sessions.get(sessionId)
    if (session) session.clearSnooze()
    this.broadcastSessions()
  }

  /** Phases that put a session in the sidebar's attention bucket — mirrors the
   *  web's attentionGroup 'needsYou' branch. Used to clear a snooze when the
   *  agent moves on. */
  private static isAttentionPhase(s: AgentRuntimeState | undefined): boolean {
    const phase = s?.phase
    if (phase === 'needs_user' || phase === 'errored') return true
    if (phase === 'idle') return !!s?.idle && s.idle.kind !== 'done'
    return false
  }
```

- [ ] **Step 5: Clear on submitted prompt**

In `sendText(…)` (~line 311), right after the guard that returns `{ ok: false }`, add:

```ts
    // A submitted message re-engages the session — drop any snooze so it returns
    // to the normal attention flow (covers chat send + resumeAndSend paths).
    if (session.snoozedUntil !== undefined) this.clearSnooze(sessionId)
```

(Place it before the `const send = …` line so the early-return guard has already run.)

- [ ] **Step 6: Clear when the agent leaves attention**

In the `case 'agentState':` handler (~line 888), after `this.notifyAttention(session, prev, msg.state)` add:

```ts
        if (
          session.snoozedUntil !== undefined &&
          SessionRegistry.isAttentionPhase(prev) &&
          !SessionRegistry.isAttentionPhase(msg.state)
        ) {
          this.clearSnooze(msg.sessionId)
        }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `bunx vitest run --root apps/server relay.test.ts`
Expected: PASS (snooze block + all pre-existing relay tests).

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(snooze): registry load/set/clear + submit & leave-attention triggers"
```

---

### Task 5: Server router — `snoozes` tRPC procedures

**Files:**
- Modify: `apps/server/src/router.ts` (after the `pins:` router, ~line 122)
- Test: `apps/server/src/router.test.ts`

**Interfaces:**
- Consumes: `registry.listSnoozes/setSnooze/clearSnooze` (Task 4).
- Produces: `appRouter.snoozes.list` (query → `SnoozeMap`), `.set` (mutation `{ sessionId, until: string|null }` → `SnoozeMap`), `.clear` (mutation `{ sessionId }` → `SnoozeMap`). The inferred `AppRouter` now exposes `trpc.snoozes.*` to the web.

- [ ] **Step 1: Write the failing test**

In `apps/server/src/router.test.ts`, add inside `describe('appRouter', …)`:

```ts
  it('snoozes.set / list / clear round-trip', async () => {
    const { call } = caller()
    const { sessionId } = await call.sessions.create({ agentKind: 'claude-code', cwd: '/p' })

    expect(await call.snoozes.list()).toEqual({})
    expect(await call.snoozes.set({ sessionId, until: null })).toEqual({ [sessionId]: null })
    expect(await call.snoozes.list()).toEqual({ [sessionId]: null })
    expect(await call.snoozes.clear({ sessionId })).toEqual({})
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run --root apps/server router.test.ts -t snoozes`
Expected: FAIL — `call.snoozes` is undefined.

- [ ] **Step 3: Add the router**

In `apps/server/src/router.ts`, after the `pins: t.router({ … }),` block (~line 122) add:

```ts
  snoozes: t.router({
    list: t.procedure.query(({ ctx }) => ctx.registry.listSnoozes()),
    // until === null => "until next message"; ISO string => timed.
    set: t.procedure
      .input(z.object({ sessionId: z.string(), until: z.string().nullable() }))
      .mutation(({ ctx, input }) => {
        ctx.registry.setSnooze(input)
        return ctx.registry.listSnoozes()
      }),
    clear: t.procedure
      .input(z.object({ sessionId: z.string() }))
      .mutation(({ ctx, input }) => {
        ctx.registry.clearSnooze(input.sessionId)
        return ctx.registry.listSnoozes()
      }),
  }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run --root apps/server router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/router.ts apps/server/src/router.test.ts
git commit -m "feat(snooze): snoozes tRPC router (list/set/clear)"
```

---

### Task 6: Web derive — pure snooze logic + attention exclusion + sink ordering

**Files:**
- Modify: `apps/web/src/derive.ts` (`isSnoozed`, `snoozeUntil1h`, `snoozeUntilTomorrow5am` new exports; `sortSessionsForSidebar` ~line 177; `sidebarSections` ~line 206 + `navWorktree` ~line 223; `partitionWorkItems` ~line 278)
- Test: `apps/web/test/derive.test.ts`

**Interfaces:**
- Consumes: `SessionMeta.snoozedUntil` (Task 1); `attentionGroup` (existing, `./home`).
- Produces:
  - `isSnoozed(s: SessionMeta, now: number): boolean`
  - `snoozeUntil1h(now: number): string`
  - `snoozeUntilTomorrow5am(now: number): string`
  - `partitionWorkItems(sessions, pinnedSessionIds, now?: number)` — snoozed attention sessions excluded from `attention`.
  - `sortSessionsForSidebar(sessions, now?: number)` — order: non-snoozed-attention → snoozed-attention → working.
  - `sidebarSections(repos, sessions, pins, now?: number)` — threads `now` into `navWorktree`/`sortSessionsForSidebar`.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/derive.test.ts`, add to the import list `isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am, sortSessionsForSidebar` and add a new describe block. (Reuse the existing `session(cwd)` factory; build attention/working/snoozed variants inline.)

```ts
const NOW = Date.parse('2026-06-19T12:00:00.000Z')
const withState = (
  s: SessionMeta,
  phase: NonNullable<SessionMeta['agentState']>['phase'],
  extra: Record<string, unknown> = {},
): SessionMeta => ({
  ...s,
  agentState: { phase, since: '2026-06-19T00:00:00.000Z', openTaskCount: 0, ...extra } as NonNullable<
    SessionMeta['agentState']
  >,
})

describe('isSnoozed', () => {
  it('undefined=never, null=always, timed=until deadline', () => {
    const s = session('/w')
    expect(isSnoozed(s, NOW)).toBe(false)
    expect(isSnoozed({ ...s, snoozedUntil: null }, NOW)).toBe(true)
    expect(isSnoozed({ ...s, snoozedUntil: '2026-06-19T13:00:00.000Z' }, NOW)).toBe(true)
    expect(isSnoozed({ ...s, snoozedUntil: '2026-06-19T11:00:00.000Z' }, NOW)).toBe(false)
  })
})

describe('snooze time helpers', () => {
  it('1h adds an hour', () => {
    expect(snoozeUntil1h(NOW)).toBe(new Date(NOW + 3_600_000).toISOString())
  })
  it('tomorrow = next 5am local strictly after now', () => {
    const out = Date.parse(snoozeUntilTomorrow5am(NOW))
    const d = new Date(out)
    expect(d.getHours()).toBe(5)
    expect(out).toBeGreaterThan(NOW)
    // strictly the *next* 5am: no more than 24h away
    expect(out - NOW).toBeLessThanOrEqual(24 * 3_600_000)
  })
})

describe('partitionWorkItems with snooze', () => {
  it('excludes an effectively-snoozed needs_user session from attention', () => {
    const needs = withState(session('/w'), 'needs_user')
    const snoozed = { ...withState(session('/w2'), 'needs_user'), snoozedUntil: null }
    const { attention } = partitionWorkItems([needs, snoozed], new Set(), NOW)
    expect(attention.map((s) => s.sessionId)).toEqual([needs.sessionId])
  })
  it('a lapsed timed snooze re-enters attention', () => {
    const lapsed = {
      ...withState(session('/w'), 'needs_user'),
      snoozedUntil: '2026-06-19T11:00:00.000Z',
    }
    const { attention } = partitionWorkItems([lapsed], new Set(), NOW)
    expect(attention).toHaveLength(1)
  })
})

describe('sortSessionsForSidebar with snooze', () => {
  it('orders non-snoozed attention, then snoozed attention, then working', () => {
    const att = withState(session('/a'), 'needs_user')
    const snoozedAtt = { ...withState(session('/b'), 'needs_user'), snoozedUntil: null }
    const working = withState(session('/c'), 'working')
    const out = sortSessionsForSidebar([working, snoozedAtt, att], NOW)
    expect(out.map((s) => s.sessionId)).toEqual([att.sessionId, snoozedAtt.sessionId, working.sessionId])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bunx vitest run --root apps/web derive.test.ts -t snooze`
Expected: FAIL — `isSnoozed`/`snoozeUntil1h`/`snoozeUntilTomorrow5am` not exported; partition/sort don't accept `now` / don't exclude snoozed.

- [ ] **Step 3: Add the pure helpers**

In `apps/web/src/derive.ts`, after the `EMPTY_PINS` export (~line 162) add:

```ts
/** Is the session snoozed *right now*? `undefined` snoozedUntil = never; `null`
 *  (until next message) = always; an ISO string = until that instant. */
export function isSnoozed(s: SessionMeta, now: number): boolean {
  if (s.snoozedUntil === undefined) return false
  if (s.snoozedUntil === null) return true
  return now < Date.parse(s.snoozedUntil)
}

/** ISO deadline one hour from `now`. */
export function snoozeUntil1h(now: number): string {
  return new Date(now + 3_600_000).toISOString()
}

/** ISO deadline at the next 5:00am local strictly after `now`. */
export function snoozeUntilTomorrow5am(now: number): string {
  const d = new Date(now)
  const target = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 5, 0, 0, 0)
  if (target.getTime() <= now) target.setDate(target.getDate() + 1)
  return target.toISOString()
}
```

- [ ] **Step 4: Thread `now` through sort/partition/sections**

Replace `sortSessionsForSidebar` (~line 177) with:

```ts
export function sortSessionsForSidebar(sessions: SessionMeta[], now: number = Date.now()): SessionMeta[] {
  // Rank 0 = needs-you/idle and not snoozed (top); 1 = attention but snoozed
  // (de-emphasised, just above working); 2 = working (bottom).
  const rank = (s: SessionMeta): number => {
    if (attentionGroup(s) === 'working') return 2
    return isSnoozed(s, now) ? 1 : 0
  }
  return [...sessions].sort((a, b) => {
    const dr = rank(a) - rank(b)
    if (dr !== 0) return dr
    return b.lastActiveAt.localeCompare(a.lastActiveAt)
  })
}
```

In `sidebarSections` (~line 206) add a `now` param and thread it into `navWorktree`:

```ts
export function sidebarSections(
  repos: GitRepositoryWire[],
  sessions: SessionMeta[],
  pins: PinState,
  now: number = Date.now(),
): SidebarSections {
```

…and in the `navWorktree` arrow inside it (~line 223), pass `now` to the sort:

```ts
  const navWorktree = (repo: RepoView, worktree: WorktreeView): WorktreeNavView => ({
    ...worktree,
    repoName: repo.name,
    sessions: sortSessionsForSidebar(
      sessionsForWorktree(sessions, worktree.path).filter(
        (session) => !pinnedPanelIds.has(session.sessionId),
      ),
      now,
    ),
  })
```

Replace the body of `partitionWorkItems` (~line 278) to add `now` and the snooze exclusion:

```ts
export function partitionWorkItems(
  sessions: SessionMeta[],
  pinnedSessionIds: Set<string>,
  now: number = Date.now(),
): WorkItemPartition {
  const attention: SessionMeta[] = []
  const working: SessionMeta[] = []
  const pinnedPanels: SessionMeta[] = []

  for (const s of sessions) {
    if (s.archived) continue
    if (pinnedSessionIds.has(s.sessionId)) {
      pinnedPanels.push(s)
      continue
    }
    const group = attentionGroup(s)
    if (group === 'working') {
      working.push(s)
    } else if (isSnoozed(s, now)) {
      // Snoozed: drop out of the top NEEDS YOUR ATTENTION group entirely. It still
      // appears (sunk) under its worktree via sortSessionsForSidebar.
      continue
    } else {
      attention.push(s)
    }
  }

  return { attention, working, pinnedPanels }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bunx vitest run --root apps/web derive.test.ts`
Expected: PASS (new snooze tests + all pre-existing derive tests — the optional `now` default keeps existing call sites valid).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/derive.ts apps/web/test/derive.test.ts
git commit -m "feat(snooze): web derive — isSnoozed, time helpers, attention exclusion + sink"
```

---

### Task 7: Web store — `setSnooze` / `clearSnooze` actions

**Files:**
- Modify: `apps/web/src/store.tsx` (`StoreState` interface ~line 94 near `setWorkState`; action defs near `setWorkState` ~line 367; return object ~line 490)

**Interfaces:**
- Consumes: `trpc.snoozes.set/clear` (Task 5); `SessionMeta.snoozedUntil` (Task 1).
- Produces: store actions `setSnooze(sessionId: string, until: string | null) => Promise<void>` and `clearSnooze(sessionId: string) => Promise<void>` (optimistic update of `sessions`, then fire-and-reconcile via the server broadcast — mirrors `setWorkState`).

- [ ] **Step 1: Add the action signatures to the StoreState interface**

In `apps/web/src/store.tsx`, after the `setWorkState: …` line in the `StoreState` interface (~line 94) add:

```ts
  /** Snooze a session out of the attention surface. `until` = null → until next
   *  message; ISO string → timed. Orthogonal to agent state. */
  setSnooze: (sessionId: string, until: string | null) => Promise<void>
  /** Un-snooze a session (return it to the normal attention flow). */
  clearSnooze: (sessionId: string) => Promise<void>
```

- [ ] **Step 2: Implement the actions**

In `apps/web/src/store.tsx`, after the `setWorkState` `useMemo` (~line 377) add:

```ts
  const setSnooze = useMemo(
    () => async (sessionId: string, until: string | null) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, snoozedUntil: until } : s)),
      )
      await trpc.snoozes.set.mutate({ sessionId, until }).catch(() => {})
    },
    [trpc],
  )
  const clearSnooze = useMemo(
    () => async (sessionId: string) => {
      setSessions((all) =>
        all.map((s) => (s.sessionId === sessionId ? { ...s, snoozedUntil: undefined } : s)),
      )
      await trpc.snoozes.clear.mutate({ sessionId }).catch(() => {})
    },
    [trpc],
  )
```

- [ ] **Step 3: Export the actions in the context value**

In the returned store object (~line 490, near `setWorkState,`) add:

```ts
    setSnooze,
    clearSnooze,
```

- [ ] **Step 4: Verify by typecheck**

Run: `bun run typecheck`
Expected: PASS — `trpc.snoozes.*` resolves from the inferred `AppRouter`; the store value matches `StoreState`.

(No unit test: these are thin optimistic-mutation wrappers reconciled by the server broadcast, exactly like `setWorkState`/`renameSession`, which are likewise covered by typecheck + runtime, not unit tests.)

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/store.tsx
git commit -m "feat(snooze): web store setSnooze/clearSnooze actions"
```

---

### Task 8: Web — `useNow` tick hook + `SnoozeControl` component

**Files:**
- Create: `apps/web/src/useNow.ts`
- Create: `apps/web/src/SnoozeControl.tsx`

**Interfaces:**
- Consumes: store `setSnooze`/`clearSnooze` (Task 7); `isSnoozed`, `snoozeUntil1h`, `snoozeUntilTomorrow5am` (Task 6); `DropdownMenu*` primitives; `useNow`.
- Produces:
  - `useNow(intervalMs: number): number` — current epoch ms, re-rendering on each interval.
  - `<SnoozeControl session={SessionMeta} className?: string iconSize?: number />` — a snooze toggle button whose direct click snoozes-until-next-message (or un-snoozes), with a hover-opened menu offering 1h / Until tomorrow / Until next message / Un-snooze. On coarse-pointer (touch) devices a tap opens the menu instead (no hover).

- [ ] **Step 1: Create the `useNow` hook**

Create `apps/web/src/useNow.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * A coarse clock that re-renders the caller every `intervalMs`. Used so timed
 * snoozes lapse on screen without a server round-trip. One tiny interval per
 * consumer — fine at minute granularity.
 */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
```

- [ ] **Step 2: Create the `SnoozeControl` component**

Create `apps/web/src/SnoozeControl.tsx`:

```tsx
import type { SessionMeta } from '@podium/protocol'
import { AlarmClock, AlarmClockOff } from 'lucide-react'
import { type JSX, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { isSnoozed, snoozeUntil1h, snoozeUntilTomorrow5am } from './derive'
import { useStore } from './store'
import { useNow } from './useNow'

const COARSE_POINTER =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(hover: none)').matches
    : false

/** Snooze toggle + hover menu. Direct click (mouse) → snooze until next message
 *  (or un-snooze). Hover → "Snooze for" menu. Touch tap → open the menu. */
export function SnoozeControl({
  session,
  className,
  iconSize = 13,
}: {
  session: SessionMeta
  className?: string
  iconSize?: number
}): JSX.Element {
  const { setSnooze, clearSnooze } = useStore()
  const now = useNow(60_000)
  const snoozed = isSnoozed(session, now)
  const [open, setOpen] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuId = useId()
  const id = session.sessionId

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = null
  }
  const openMenu = () => {
    if (COARSE_POINTER) return // touch opens via click, not hover
    cancelClose()
    setOpen(true)
  }
  const scheduleClose = () => {
    if (COARSE_POINTER) return
    cancelClose()
    closeTimer.current = setTimeout(() => setOpen(false), 140)
  }
  const choose = (fn: () => void) => {
    fn()
    cancelClose()
    setOpen(false)
  }
  const onTrigger = () => {
    if (COARSE_POINTER) {
      setOpen((o) => !o)
      return
    }
    // Mouse: the menu is already hover-open; a click does the default action.
    if (snoozed) void clearSnooze(id)
    else void setSnooze(id, null)
    setOpen(false)
  }

  const wakeLabel = snoozed
    ? session.snoozedUntil
      ? `Snoozed until ${new Date(session.snoozedUntil).toLocaleString()} — click to un-snooze`
      : 'Snoozed until next message — click to un-snooze'
    : 'Snooze'

  return (
    <div className="relative inline-flex" onMouseEnter={openMenu} onMouseLeave={scheduleClose}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-pressed={snoozed}
        title={wakeLabel}
        className={cn(
          'w-7 min-w-7 flex-none rounded-none',
          snoozed ? 'text-primary' : 'text-muted-foreground/70 hover:text-foreground',
          className,
        )}
        onClick={onTrigger}
      >
        {snoozed ? (
          <AlarmClockOff size={iconSize} aria-hidden="true" />
        ) : (
          <AlarmClock size={iconSize} aria-hidden="true" />
        )}
      </Button>
      {open && (
        <div
          id={menuId}
          role="menu"
          className="absolute right-0 top-full z-50 mt-1 min-w-[150px] rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
        >
          <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">Snooze for</div>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, snoozeUntil1h(Date.now())))}
          >
            1 hour
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, snoozeUntilTomorrow5am(Date.now())))}
          >
            Until tomorrow
          </button>
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
            onClick={() => choose(() => void setSnooze(id, null))}
          >
            Until next message
          </button>
          {snoozed && (
            <button
              type="button"
              role="menuitem"
              className="flex w-full items-center rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={() => choose(() => void clearSnooze(id))}
            >
              Un-snooze
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Verify by typecheck**

Run: `bun run typecheck`
Expected: PASS. (`AlarmClock`/`AlarmClockOff` are exported by lucide-react; `Button` `size="icon-sm"` matches the pin button usage in `Sidebar.tsx`.)

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/useNow.ts apps/web/src/SnoozeControl.tsx
git commit -m "feat(snooze): useNow tick hook + SnoozeControl (click + hover menu)"
```

---

### Task 9: Web Sidebar — wire SnoozeControl + thread `now`

**Files:**
- Modify: `apps/web/src/Sidebar.tsx` (imports; `Sidebar()` `now` + `partitionWorkItems`/`sidebarSections` calls ~lines 87/155; `PanelRow` ~line 651 between Pin and close X)
- Modify: `apps/web/src/MobileApp.tsx` (the `sidebarSections(...)` call — pass `now`)

**Interfaces:**
- Consumes: `SnoozeControl` (Task 8); `useNow` (Task 8); `partitionWorkItems`/`sidebarSections` with `now` (Task 6).

- [ ] **Step 1: Import `useNow` and `SnoozeControl` in Sidebar**

In `apps/web/src/Sidebar.tsx`, add to the existing imports:

```ts
import { SnoozeControl } from './SnoozeControl'
import { useNow } from './useNow'
```

- [ ] **Step 2: Compute `now` and pass it to partition + sections**

In `Sidebar()`, after the `useStore()` destructure (~line 87) add:

```ts
  const now = useNow(60_000)
```

Change the `sections` line (~line 87) to:

```ts
  const sections = sidebarSections(repos, sessions, pins, now)
```

Change the `workItems` line (~line 155) to:

```ts
  const workItems = partitionWorkItems(sessions, pinnedSessionIds, now)
```

- [ ] **Step 3: Render `SnoozeControl` in `PanelRow`**

In `PanelRow` (~line 651), insert the snooze control immediately before the existing Pin `<Button …><Pin …/></Button>` (so order is: snooze, pin, close):

```tsx
      <SnoozeControl session={session} />
```

(It sits inside the same `group flex … gap-1` row as the pin and close buttons, so it is permanently visible next to the pin in both the NEEDS YOUR ATTENTION rows and the worktree-list rows.)

- [ ] **Step 4: Thread `now` in MobileApp**

In `apps/web/src/MobileApp.tsx`, add `import { useNow } from './useNow'`, add `const now = useNow(60_000)` near the other hooks in the component, and change the `sidebarSections(store.repos, sessions, pins)` call to `sidebarSections(store.repos, sessions, pins, now)`.

- [ ] **Step 5: Verify by typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/Sidebar.tsx apps/web/src/MobileApp.tsx
git commit -m "feat(snooze): sidebar snooze control + now-aware attention ordering"
```

---

### Task 10: Web AgentPanel — snooze control in the full session view

**Files:**
- Modify: `apps/web/src/AgentPanel.tsx` (imports; toolbar `<div className="flex items-center gap-2.5 …">` ~line 248)

**Interfaces:**
- Consumes: `SnoozeControl` (Task 8); `useNow` (Task 8); `attentionGroup` (`./home`); `isSnoozed` (Task 6).

- [ ] **Step 1: Imports**

In `apps/web/src/AgentPanel.tsx` add:

```ts
import { isSnoozed } from './derive'
import { attentionGroup } from './home'
import { SnoozeControl } from './SnoozeControl'
import { useNow } from './useNow'
```

- [ ] **Step 2: Compute attention/snooze visibility**

Inside the component, near the other derived flags (after `const phase = …`, ~line 130) add:

```ts
  const snoozeNow = useNow(60_000)
  // Offer snooze in the full view when the session is in (or already snoozed out
  // of) the attention surface — not for actively-working or parked sessions.
  const showSnooze =
    !!session &&
    !hibernated &&
    !exited &&
    (attentionGroup(session) !== 'working' || isSnoozed(session, snoozeNow))
```

- [ ] **Step 3: Render it in the toolbar**

In the toolbar row (~line 248), immediately before the `{chatCapable && ( … Sparkles … )}` BTW button, add:

```tsx
        {showSnooze && session && <SnoozeControl session={session} iconSize={15} className="ml-auto" />}
```

(`ml-auto` pushes the action cluster to the right, matching the existing BTW/Archive layout. When `showSnooze` is true it owns the `ml-auto`; the BTW button's own `ml-auto` is harmless when both are present — the first `ml-auto` wins. If the layout looks off in the runtime check, move `ml-auto` to whichever control is first in the row.)

- [ ] **Step 4: Verify by typecheck + build**

Run: `bun run typecheck && bun run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/AgentPanel.tsx
git commit -m "feat(snooze): snooze control in the full session view toolbar"
```

---

### Task 11: Full verification + runtime check

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + build + unit tests across the stack**

Run:
```bash
bun run typecheck
bun run build
bunx vitest run --root packages/protocol
bunx vitest run --root apps/server
bunx vitest run --root apps/web
```
Expected: all green except the 4 **pre-existing** `apps/web/test/shell.structure.test.ts` failures documented in the spec (unrelated tab/new-panel-menu/conn-indicator string assertions). Confirm the sidebar-related structure test count did not increase.

- [ ] **Step 2: Lint/format**

Run: `bun run format` then `git add -A && git diff --cached --quiet || git commit -m "chore(snooze): format"`
Expected: no functional changes; commit only if formatting touched files.

- [ ] **Step 3: Runtime verification (in-browser, per project practice)**

Using the committed Playwright harness (see project memory "Podium headless browser testing"; `?e2e=1` + `__podium`): start the app, create/instrument a session into `needs_user`, then verify against the live UI:
1. The session shows in the sidebar **NEEDS YOUR ATTENTION** with a snooze icon next to the pin.
2. Clicking the snooze icon removes it from NEEDS YOUR ATTENTION and sinks it to the bottom of its worktree list; the worktree-list snooze icon shows the active (primary) state.
3. Hover opens the "Snooze for" menu (1h / Until tomorrow / Until next message / Un-snooze); pick "1h" and confirm the tooltip shows a wake time ~1h out.
4. Submitting a prompt to the session (chat send) clears the snooze (it returns to NEEDS YOUR ATTENTION when still attention-worthy).
5. The full session view toolbar shows the snooze control while the session is in the attention state and toggles the same flag.

Record the result (pass/fail + any fixes) before declaring done.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch to decide merge/PR. Do **not** auto-merge to `main` (it is the live source — see project memory); present options.

---

## Self-Review

**Spec coverage:**
- Snooze icon next to pin in NEEDS YOUR ATTENTION + worktree list (permanent) → Task 9 (`PanelRow`). ✓
- Snooze in full session view when in that state → Task 10. ✓
- Direct click = until next message; un-snooze on re-click → Task 8 (`onTrigger`). ✓
- Hover submenu 1h / Until tomorrow (5am) / Until next message → Task 8 + Task 6 time helpers. ✓
- Clears on submitted prompt OR agent leaving attention → Task 4 (sendText + agentState). ✓
- Orthogonal flag, no agent-state change; separate table + `snoozedUntil` → Tasks 1–4. ✓
- Excluded from top attention; sunk to bottom in each worktree → Task 6. ✓
- Persisted (survives redeploy); timed lapse → Task 2 (table + lazy expiry) + Task 6/8 (`useNow`). ✓

**Placeholder scan:** none — every code step is concrete.

**Type consistency:** `snoozedUntil: string | null | undefined` (Session/derive) ↔ `z.string().nullable().optional()` (protocol) ↔ `until: string | null` (store/registry/router/store-action) ↔ `SnoozeMap = Record<string, string | null>` (store/registry/router). `setSnooze`/`clearSnooze`/`listSnoozes`/`isSnoozed`/`snoozeUntil1h`/`snoozeUntilTomorrow5am`/`useNow`/`SnoozeControl` names are used identically across tasks.
