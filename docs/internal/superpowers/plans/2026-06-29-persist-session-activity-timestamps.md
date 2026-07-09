# Persist Session Activity Timestamps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make session activity signals (last output, last input, last resume) durable across server restarts and add a user-input signal, so hibernation can rely on them without writing the DB on the hot path.

**Architecture:** Each `Session` keeps three in-memory **epoch-ms** counters (`outputAtMs`, `inputAtMs`, `resumedAtMs`) bumped on the hot path plus an `activityDirty` flag. A single registry-wide timer flushes dirty sessions to the `sessions` table every ~12s (persisting the counters as ISO strings via `toRow`); existing `persist()` transition points flush opportunistically. On boot the counters are seeded from the persisted ISO columns. The hibernation idle-since check maxes `lastActiveAt`, input, and resume; output keeps its separate 60s quiet gate.

**Tech Stack:** TypeScript, node:sqlite (`SessionStore`), vitest.

## Global Constraints

- `lastActiveAt` is authoritative for recency ordering and MUST NOT be moved by raw input, raw output, reattach, or resume. The three new timestamps feed hibernation only — never ordering.
- Persisted/serialized form is ISO 8601 strings named `lastOutputAt` / `lastInputAt` / `lastResumedAt`. In-memory hot-path form is epoch-ms (`Date.now()`). Convert ms→ISO only at persist time.
- No DB write on the per-frame / per-keystroke path. Hot path only mutates in-memory counters + sets `activityDirty`.
- New columns are nullable; old rows read `NULL` → in-memory `0` → behave exactly as today until first live activity.
- Follow the existing additive-`ALTER` + `colNames.has(...)` migration pattern (store.ts:1162-1166). Do not bump a schema-version gate (the guards are structural).

---

### Task 1: Persist the three columns in `SessionStore`

**Files:**
- Modify: `apps/server/src/store.ts` — `SessionRow` (66-87), `CREATE TABLE sessions` (990-1007), `migrate()` column guards (~1166), `loadSessions()` (345-373), `upsertSession()` (375-425)
- Test: `apps/server/src/store.test.ts`

**Interfaces:**
- Produces: `SessionRow` gains `lastOutputAt: string | null`, `lastInputAt: string | null`, `lastResumedAt: string | null`. `loadSessions()` returns them; `upsertSession(row)` persists them.

- [ ] **Step 1: Write the failing test**

Add to `apps/server/src/store.test.ts` (build a full row; copy the field set from an existing upsert test in the file and add the three new fields):

```ts
it('round-trips the activity timestamps (output/input/resumed)', () => {
  const store = new SessionStore(':memory:')
  const base = {
    id: 's1', agentKind: 'claude-code', cwd: '/w', title: 't', name: null,
    originKind: 'spawn' as const, conversationId: null, resumeKind: null, resumeValue: null,
    status: 'live' as const, exitCode: null, durableLabel: 'podium-s1',
    createdAt: '2026-06-29T00:00:00.000Z', lastActiveAt: '2026-06-29T00:00:00.000Z',
    archived: false, workState: null, machineId: '__local__',
  }
  store.upsertSession({
    ...base,
    lastOutputAt: '2026-06-29T01:00:00.000Z',
    lastInputAt: '2026-06-29T02:00:00.000Z',
    lastResumedAt: '2026-06-29T03:00:00.000Z',
  })
  const [r] = store.loadSessions()
  expect(r.lastOutputAt).toBe('2026-06-29T01:00:00.000Z')
  expect(r.lastInputAt).toBe('2026-06-29T02:00:00.000Z')
  expect(r.lastResumedAt).toBe('2026-06-29T03:00:00.000Z')
})

it('reads null activity timestamps for a row that never had them', () => {
  const store = new SessionStore(':memory:')
  const base = {
    id: 's2', agentKind: 'shell', cwd: '/w', title: 't', name: null,
    originKind: 'spawn' as const, conversationId: null, resumeKind: null, resumeValue: null,
    status: 'live' as const, exitCode: null, durableLabel: 'podium-s2',
    createdAt: '2026-06-29T00:00:00.000Z', lastActiveAt: '2026-06-29T00:00:00.000Z',
    archived: false, workState: null, machineId: '__local__',
    lastOutputAt: null, lastInputAt: null, lastResumedAt: null,
  }
  store.upsertSession(base)
  const [r] = store.loadSessions()
  expect(r.lastOutputAt).toBeNull()
  expect(r.lastInputAt).toBeNull()
  expect(r.lastResumedAt).toBeNull()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/server && npx vitest run src/store.test.ts -t "activity timestamps"`
Expected: FAIL — `SessionRow` has no `lastOutputAt` (TS error) and/or loaded values are `undefined`.

- [ ] **Step 3: Add the three fields to `SessionRow`**

In `store.ts`, after `lastActiveAt: string` (81):

```ts
  lastActiveAt: string
  /** Last PTY output frame (ISO); null = none recorded. Hibernation signal only — not recency. */
  lastOutputAt: string | null
  /** Last controller input — any keys/mouse/paste (ISO); null = none. Hibernation signal only. */
  lastInputAt: string | null
  /** Last resume/resurrect (ISO); null = never. Hibernation signal only. */
  lastResumedAt: string | null
```

- [ ] **Step 4: Add columns to `CREATE TABLE sessions`**

In the `CREATE TABLE IF NOT EXISTS sessions` block, after `work_state TEXT` (1006):

```sql
         work_state TEXT,
         last_output_at TEXT,
         last_input_at TEXT,
         last_resumed_at TEXT
```

- [ ] **Step 5: Add the in-place migration for pre-existing DBs**

In `migrate()`, after the `work_state` guard (store.ts:1166):

```ts
  if (!colNames.has('work_state')) this.db.exec('ALTER TABLE sessions ADD COLUMN work_state TEXT')
  // v6 -> activity timestamps: durable hibernation signals. Nullable adds; old rows read
  // NULL and behave as today until first live activity. Structural guard, no version gate.
  if (!colNames.has('last_output_at'))
    this.db.exec('ALTER TABLE sessions ADD COLUMN last_output_at TEXT')
  if (!colNames.has('last_input_at'))
    this.db.exec('ALTER TABLE sessions ADD COLUMN last_input_at TEXT')
  if (!colNames.has('last_resumed_at'))
    this.db.exec('ALTER TABLE sessions ADD COLUMN last_resumed_at TEXT')
```

- [ ] **Step 6: Read the columns in `loadSessions()`**

Add the three columns to the `SELECT` list (store.ts:348-350) and the row map (after `machineId`, 371):

```sql
                archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at
```

```ts
      machineId: (r.machine_id as string | null) ?? '__local__',
      lastOutputAt: (r.last_output_at as string | null) ?? null,
      lastInputAt: (r.last_input_at as string | null) ?? null,
      lastResumedAt: (r.last_resumed_at as string | null) ?? null,
```

- [ ] **Step 7: Write the columns in `upsertSession()`**

Add to the INSERT column list, the `VALUES` placeholders (add three `?`), the `ON CONFLICT DO UPDATE SET` clause, and the `.run(...)` args:

```sql
            archived, work_state, machine_id, last_output_at, last_input_at, last_resumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```sql
           machine_id = excluded.machine_id,
           last_output_at = excluded.last_output_at,
           last_input_at = excluded.last_input_at,
           last_resumed_at = excluded.last_resumed_at`,
```

```ts
        row.machineId ?? '__local__',
        row.lastOutputAt ?? null,
        row.lastInputAt ?? null,
        row.lastResumedAt ?? null,
      )
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/store.test.ts`
Expected: PASS (all store tests, including the two new ones).

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/store.ts apps/server/src/store.test.ts
git commit -m "feat(store): persist session activity timestamps (output/input/resumed)"
```

---

### Task 2: `Session` activity counters, input signal, dirty flag, seeding, serialization

**Files:**
- Modify: `apps/server/src/session.ts` — `SessionInit` (40-63), class fields (~146), `lastOutputMs` getter (~200), constructor (175-194), `handleInput` (363-375), `onFrame` (467-478), `toRow` (594-614)
- Test: `apps/server/src/session.test.ts`

**Interfaces:**
- Consumes: `SessionRow` activity fields (Task 1).
- Produces on `Session`:
  - `markResumed(): void` — sets `resumedAtMs = Date.now()`, `activityDirty = true`.
  - `get lastOutputAtMs(): number` / `get lastInputAtMs(): number` / `get lastResumedAtMs(): number` — epoch ms (0 = never).
  - `get activityDirty(): boolean` / `clearActivityDirty(): void`.
  - `handleInput` and `onFrame` bump their counters + set `activityDirty`.
  - `toRow()` emits `lastOutputAt`/`lastInputAt`/`lastResumedAt` as ISO (null when 0).
  - `SessionInit` gains optional `lastOutputAt`/`lastInputAt`/`lastResumedAt` (`string | null`); constructor seeds counters via `Date.parse` (0 if absent/null).
- Note: this renames the existing `lastOutputMs` getter → `lastOutputAtMs`. Its only consumer is `maybeAutoHibernate` (relay.ts), updated in Task 4.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/session.test.ts` (reuse the file's existing `Session` construction helper / `SessionInit` shape; the minimal init below lists the required fields):

```ts
const initBase = {
  sessionId: 's', agentKind: 'claude-code' as const, cwd: '/w', title: 't',
  origin: { kind: 'spawn' as const }, createdAt: '2026-06-29T00:00:00.000Z',
  geometry: { cols: 80, rows: 24, dpr: 1 }, toDaemon: () => {},
}

it('handleInput from the controller bumps lastInputAt and marks dirty', () => {
  const s = new Session({ ...initBase })
  // First attach makes this client the controller (see attachClient).
  s.attachClient({ id: 'c', send: () => {}, viewport: { cols: 80, rows: 24, dpr: 1 },
    attached: new Set(), transcriptSubs: new Set(), visible: true,
    viewVisible: new Set(), focused: null, viewModes: {} })
  expect(s.lastInputAtMs).toBe(0)
  s.handleInput('c', Buffer.from('x').toString('base64'))
  expect(s.lastInputAtMs).toBeGreaterThan(0)
  expect(s.activityDirty).toBe(true)
})

it('markResumed bumps lastResumedAt and marks dirty without touching lastActiveAt', () => {
  const s = new Session({ ...initBase, lastActiveAt: '2026-06-01T00:00:00.000Z' })
  s.markResumed()
  expect(s.lastResumedAtMs).toBeGreaterThan(0)
  expect(s.activityDirty).toBe(true)
  expect(s.lastActiveAt).toBe('2026-06-01T00:00:00.000Z') // recency untouched
})

it('toRow serializes the counters as ISO (null when never set)', () => {
  const s = new Session({ ...initBase })
  expect(s.toRow().lastOutputAt).toBeNull()
  s.markResumed()
  const iso = s.toRow().lastResumedAt
  expect(iso).not.toBeNull()
  expect(Number.isNaN(Date.parse(iso as string))).toBe(false)
})

it('seeds counters from SessionInit ISO values', () => {
  const s = new Session({ ...initBase, lastInputAt: '2026-06-29T02:00:00.000Z' })
  expect(s.lastInputAtMs).toBe(Date.parse('2026-06-29T02:00:00.000Z'))
  expect(s.clearActivityDirty).toBeTypeOf('function')
  s.clearActivityDirty()
  expect(s.activityDirty).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/session.test.ts -t "lastInputAt|markResumed|toRow serializes|seeds counters"`
Expected: FAIL — `lastInputAtMs` / `markResumed` / `activityDirty` undefined.

- [ ] **Step 3: Add fields, getters, and `markResumed`**

In `session.ts`, after `private outputAtMs = 0` (146):

```ts
  private outputAtMs = 0
  private inputAtMs = 0
  private resumedAtMs = 0
  // Set when any of the three counters above advances; the registry's periodic
  // flush persists dirty sessions and clears this. Keeps the hot path off the DB.
  private activityDirty = false
```

Rename the existing `lastOutputMs` getter to `lastOutputAtMs` and add the siblings + dirty accessors (near the existing getter, ~200):

```ts
  /** Epoch ms of the last PTY output frame (0 = none). */
  get lastOutputAtMs(): number {
    return this.outputAtMs
  }
  /** Epoch ms of the last controller input — any keys/mouse/paste (0 = none). */
  get lastInputAtMs(): number {
    return this.inputAtMs
  }
  /** Epoch ms of the last resume/resurrect (0 = never). */
  get lastResumedAtMs(): number {
    return this.resumedAtMs
  }
  get activityDirty(): boolean {
    return this.activityDirty_
  }
```

Note: a getter and private field cannot share the name `activityDirty`. Name the field `private activityDirty_ = false` in the block above (replace `private activityDirty = false` with `private activityDirty_ = false`) and add:

```ts
  clearActivityDirty(): void {
    this.activityDirty_ = false
  }

  /**
   * Mark the session as just resumed/resurrected. Resets the hibernation idle
   * timer (the eligibility check maxes this with lastActiveAt) WITHOUT touching
   * lastActiveAt, which is authoritative for recency ordering.
   */
  markResumed(): void {
    this.resumedAtMs = Date.now()
    this.activityDirty_ = true
  }
```

- [ ] **Step 4: Bump counters on the hot paths**

In `handleInput` (363), inside the `clientId === this.controllerId` branch, before `this.toDaemon(...)`:

```ts
      this.inputAtMs = Date.now()
      this.activityDirty_ = true
```

In `onFrame` (467), replace `this.outputAtMs = Date.now()` (471) with:

```ts
    this.outputAtMs = Date.now()
    this.activityDirty_ = true
```

- [ ] **Step 5: Seed from `SessionInit` and serialize in `toRow`**

Add to `SessionInit` (after `lastActiveAt?: string`, 54):

```ts
  lastActiveAt?: string
  lastOutputAt?: string | null
  lastInputAt?: string | null
  lastResumedAt?: string | null
```

In the constructor, after `this.lastActiveAt = init.lastActiveAt ?? init.createdAt` (187):

```ts
    this.outputAtMs = init.lastOutputAt ? Date.parse(init.lastOutputAt) : 0
    this.inputAtMs = init.lastInputAt ? Date.parse(init.lastInputAt) : 0
    this.resumedAtMs = init.lastResumedAt ? Date.parse(init.lastResumedAt) : 0
```

Add a private helper (near the bottom of the class) and use it in `toRow`:

```ts
  private static msToIso(ms: number): string | null {
    return ms > 0 ? new Date(ms).toISOString() : null
  }
```

In `toRow()` (594-614), after `lastActiveAt: this.lastActiveAt,` (611):

```ts
      lastActiveAt: this.lastActiveAt,
      lastOutputAt: Session.msToIso(this.outputAtMs),
      lastInputAt: Session.msToIso(this.inputAtMs),
      lastResumedAt: Session.msToIso(this.resumedAtMs),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/session.test.ts`
Expected: PASS (all session tests).

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/session.ts apps/server/src/session.test.ts
git commit -m "feat(session): in-memory activity counters + input signal + ISO serialization"
```

---

### Task 3: Registry flush sweep, boot seeding, resume wiring

**Files:**
- Modify: `apps/server/src/relay.ts` — constructor (~356), `loadFromStore()` session rehydration (`new Session({...})` 432-452), `resurrectSession()` (1117-1146), `resumeSession()` live branch (823-829)
- Test: `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: `Session.activityDirty` / `clearActivityDirty()` / `markResumed()` / `toRow()` (Task 2); `SessionRow` activity fields (Task 1).
- Produces on `SessionRegistry`: `flushActivity(): void` (persist + clear every dirty session); a `setInterval` started in the constructor (`.unref()`ed) calling it; `dispose()` clears the interval.

- [ ] **Step 1: Write the failing tests**

Add to `apps/server/src/relay.test.ts` (the `liveSession` / `bind` helpers already exist in the hibernation describe block; place these in that block):

```ts
it('does not write the DB on every output frame — coalesces to the flush', () => {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  const daemon: ControlMessage[] = []
  reg.attachDaemon('local', (m) => daemon.push(m))
  const sessionId = liveSession(reg, daemon)
  const spy = vi.spyOn(store, 'upsertSession')
  for (let i = 0; i < 50; i++) {
    reg.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: i, data: 'eA==' })
  }
  const duringFrames = spy.mock.calls.length
  reg.flushActivity()
  expect(spy.mock.calls.length - duringFrames).toBeLessThanOrEqual(1) // one write at flush
  expect(duringFrames).toBe(0) // zero writes during the 50 frames
})

it('seeds activity counters from the DB on a fresh registry (survives restart)', () => {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  const daemon: ControlMessage[] = []
  reg.attachDaemon('local', (m) => daemon.push(m))
  const sessionId = liveSession(reg, daemon)
  reg.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: 0, data: 'eA==' })
  reg.flushActivity()
  // New registry on the SAME store — simulates a restart.
  const reg2 = new SessionRegistry(store)
  // biome-ignore lint/suspicious/noExplicitAny: inspect the rehydrated session
  const seeded = (reg2 as any).sessions.get(sessionId)
  expect(seeded.lastOutputAtMs).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/relay.test.ts -t "every output frame|seeds activity"`
Expected: FAIL — `reg.flushActivity` is not a function.

- [ ] **Step 3: Add the flush method + timer + dispose**

In `relay.ts`, after `persist()` (399-401):

```ts
  /** Persist every session whose activity counters advanced since the last flush.
   *  Keeps the per-frame / per-keystroke path off the DB — the timer below calls
   *  this on a coarse interval, so a busy session writes at most once per tick. */
  flushActivity(): void {
    for (const s of this.sessions.values()) {
      if (s.activityDirty) {
        this.persist(s)
        s.clearActivityDirty()
      }
    }
  }
```

Add a field and start the timer in the constructor (after the store/autoContinue wiring, ~365). Use `.unref()` so it never holds the process open, and 12s to match the spec:

```ts
  private readonly activityFlushTimer = setInterval(() => this.flushActivity(), 12_000)
```

Immediately after the field initializer runs is fine, but ensure `.unref()`; if the field form can't call `.unref()`, set it in the constructor body instead:

```ts
    this.activityFlushTimer.unref?.()
```

Add a dispose method (near other lifecycle methods):

```ts
  dispose(): void {
    clearInterval(this.activityFlushTimer)
  }
```

- [ ] **Step 4: Seed counters when rehydrating sessions on boot**

In `loadFromStore()`, in the `new Session({...})` call (432-452), after `lastActiveAt: r.lastActiveAt,` (452):

```ts
        lastActiveAt: r.lastActiveAt,
        lastOutputAt: r.lastOutputAt,
        lastInputAt: r.lastInputAt,
        lastResumedAt: r.lastResumedAt,
```

- [ ] **Step 5: Wire resume to reset the timer**

In `resurrectSession()`, after `session.exitCode = undefined` (1133), before `this.persist(session)`:

```ts
    // Waking a session resets its hibernation idle timer — otherwise a stale
    // lastActiveAt makes it immediately eligible to be parked again.
    session.markResumed()
```

In `resumeSession()`, replace the existing live-branch return (823-829):

```ts
    const existing = this.findLiveByResume(input.resume)
    if (existing) {
      if (existing.status === 'hibernated' || existing.status === 'exited') {
        this.resurrectSession({ sessionId: existing.sessionId })
      } else {
        // Reopening a still-live but long-idle session also resets its hibernation
        // timer — the user is back on it even with no new message. (resurrectSession
        // already stamps this for the parked case above.)
        this.sessions.get(existing.sessionId)?.markResumed()
      }
      return { sessionId: existing.sessionId }
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/server && npx vitest run src/relay.test.ts -t "every output frame|seeds activity"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(relay): periodic activity flush, boot seeding, resume resets idle timer"
```

---

### Task 4: Hibernation honors input + resume (and survives restart)

**Files:**
- Modify: `apps/server/src/relay.ts` — `maybeAutoHibernate()` candidate filter (1169-1181)
- Test: `apps/server/src/relay.test.ts`

**Interfaces:**
- Consumes: `Session.lastOutputAtMs` / `lastInputAtMs` / `lastResumedAtMs` (Task 2); `flushActivity()` + seeding (Task 3).

- [ ] **Step 1: Write the failing tests**

Add to the hibernation describe block in `apps/server/src/relay.test.ts`:

```ts
it('does not re-hibernate a session that was just resurrected (resume resets the idle timer)', () => {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  const daemon: ControlMessage[] = []
  reg.attachDaemon('local', (m) => daemon.push(m))
  store.setSettings({ ...store.getSettings(), hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 } })
  const sessionId = liveSession(reg, daemon)
  reg.onDaemonMessageFrom('local', {
    type: 'agentState', sessionId,
    state: { phase: 'idle', since: '2026-06-12T00:00:00.000Z', openTaskCount: 0, idle: { kind: 'done' } },
  })
  // biome-ignore lint/suspicious/noExplicitAny: reach into the private map on purpose
  const internal = (reg as any).sessions.get(sessionId)
  internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()
  reg.hibernateSession({ sessionId })
  reg.resurrectSession({ sessionId })
  reg.onDaemonMessageFrom('local', bind(sessionId)) // respawn binds → live
  reg.onDaemonMessageFrom('local', {
    type: 'hostMetrics', hostname: 'box', sampledAt: new Date().toISOString(),
    memory: { totalBytes: 100, availableBytes: 10, swapTotalBytes: 0, swapFreeBytes: 0 },
  })
  expect(reg.listSessions()[0]?.status).toBe('live')
})

it('keeps a session awake when the user typed recently, even with no agent activity', () => {
  const store = new SessionStore(':memory:')
  const reg = new SessionRegistry(store)
  const daemon: ControlMessage[] = []
  reg.attachDaemon('local', (m) => daemon.push(m))
  store.setSettings({ ...store.getSettings(), hibernation: { enabled: true, memoryPct: 80, idleMinutes: 1 } })
  const sessionId = liveSession(reg, daemon)
  reg.onDaemonMessageFrom('local', {
    type: 'agentState', sessionId,
    state: { phase: 'idle', since: '2026-06-12T00:00:00.000Z', openTaskCount: 0, idle: { kind: 'done' } },
  })
  // biome-ignore lint/suspicious/noExplicitAny: reach into the private map on purpose
  const internal = (reg as any).sessions.get(sessionId)
  internal.lastActiveAt = new Date(Date.now() - 3_600_000).toISOString()
  // Controller types just now — recent input must veto hibernation.
  const c = sink()
  const idC = reg.attachClient(c.send)
  reg.onClientMessage(idC, { type: 'attach', sessionId })
  reg.onClientMessage(idC, { type: 'input', sessionId, data: 'eA==' })
  reg.onDaemonMessageFrom('local', {
    type: 'hostMetrics', hostname: 'box', sampledAt: new Date().toISOString(),
    memory: { totalBytes: 100, availableBytes: 10, swapTotalBytes: 0, swapFreeBytes: 0 },
  })
  expect(reg.listSessions()[0]?.status).toBe('live')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/server && npx vitest run src/relay.test.ts -t "just resurrected|user typed recently"`
Expected: FAIL — both sessions hibernate (idle-since still only reads `lastActiveAt`), and/or the old `lastOutputMs` reference no longer compiles after Task 2's rename.

- [ ] **Step 3: Update the candidate filter**

In `maybeAutoHibernate()`, replace the two activity conditions (1179-1180):

```ts
          // "Idle since" is the latest of genuine agent activity (lastActiveAt),
          // the last resume, and the last user input — any of them resets the idle
          // timer WITHOUT restamping lastActiveAt (which owns recency ordering).
          Math.max(
            Date.parse(s.lastActiveAt),
            s.lastResumedAtMs,
            s.lastInputAtMs,
          ) <= idleCutoff &&
          // A running TUI repaints, so recent output means work is still going.
          now - s.lastOutputAtMs >= OUTPUT_QUIET_MS,
```

- [ ] **Step 4: Run the full server suite to verify pass + no regressions**

Run: `cd apps/server && npx vitest run`
Expected: PASS — all suites. (Confirms the `lastOutputMs`→`lastOutputAtMs` rename has no other consumers; if a failure points elsewhere, grep `lastOutputMs` and update.)

- [ ] **Step 5: Typecheck and format**

Run: `cd apps/server && npx tsc --noEmit -p . && cd ../.. && npx biome check --write apps/server/src/relay.ts apps/server/src/session.ts apps/server/src/store.ts apps/server/src/relay.test.ts apps/server/src/session.test.ts apps/server/src/store.test.ts`
Expected: tsc clean; biome formats with no remaining errors.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/relay.ts apps/server/src/relay.test.ts
git commit -m "feat(relay): hibernation idle-since honors last input and last resume"
```

---

## Self-Review

**Spec coverage:**
- Three timestamps (output/input/resumed) → Tasks 1 (persist), 2 (in-memory + serialize), 3 (seed/flush). ✓
- `lastInputAt` = any input, single field → Task 2 Step 4 (bump in `handleInput`, undifferentiated). ✓
- In-memory live truth + lazy flush (periodic sweep + transition flush + seed-on-load) → Task 3 (flushActivity timer; `persist()` transition points already write `toRow`; Step 4 seeding). ✓
- No hot-path DB write → Task 3 Step 1 test asserts 0 writes across 50 frames. ✓
- ISO storage matching `lastActiveAt`; cheap epoch-ms hot path → Task 2 (`msToIso`, counters stay ms). ✓
- Hibernation idle-since includes input + resume; output keeps 60s gate → Task 4 Step 3. ✓
- `lastActiveAt`/recency untouched → Task 2 test "without touching lastActiveAt"; no task writes `lastActiveAt` from the new paths. ✓
- Additive migration, nullable, no version-gate → Task 1 Steps 4-5. ✓
- Resume-across-restart fix → Task 3 (markResumed persisted) + Task 4 test. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code. ✓

**Type consistency:** `lastOutputAt`/`lastInputAt`/`lastResumedAt` (ISO `string | null`) used identically in `SessionRow` (T1), `SessionInit`/`toRow` (T2), and `loadFromStore` seeding (T3). Epoch-ms getters `lastOutputAtMs`/`lastInputAtMs`/`lastResumedAtMs` defined in T2, consumed in T4. `markResumed`/`flushActivity`/`activityDirty`/`clearActivityDirty` consistent across T2/T3. The `activityDirty` getter vs `activityDirty_` field collision is called out explicitly in T2 Step 3. ✓
