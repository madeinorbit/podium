# Narrow Session Projection Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove avoidable full-session projections from hot server paths and time-slice volatile session publication, without changing the client sync contract.

**Architecture:** Two server-only changes. (1) Finish the candidate-first read decomposition of `SessionView` (`byIds` + one new internal fact read), migrate the remaining `listSessions()` anti-pattern call sites, and gate regressions with a source-audit test. (2) Split the volatile capture drain into version-checked, time-budgeted slices scheduled one per event-loop turn, keeping the existing synchronous full drain as a dispose/test barrier. No cache, no new feed, no protocol change.

**Tech Stack:** TypeScript, Bun, vitest (run single files as `cd apps/server && bun --bun vitest run <path>`; NEVER `bun run test` at the root — the full lane is admission-gated).

**Spec:** `docs/spec/narrow-session-projection-bridge.md` (read it first; this plan implements it section by section). Profile evidence: `docs/agents/pod-2262-server-typing-profile.md`.

## Global Constraints

- No long-lived `SessionMeta` cache, dependency graph, materialized projection, new feed, or client subscription API (spec §1).
- Reader-scoped results always pass `canReadSession` + `SessionView.wire`; fact reads never cross a wire/client boundary (spec §5.1, §5.3).
- Volatile slice budgets: `maxItems = 32`, `maxCpuMs = 8`, checked **between** candidates (spec §7.2). Constants internal, not user config.
- Scheduled publication drains exactly one slice per turn and continues via one zero-delay `setTimeout` — never recursion, never a microtask chain (spec §7.4).
- Production request/daemon/timer paths never call the full drain barrier; only dispose and tests do (spec §7.5).
- On capture failure: remove nothing from the failed slice, checkpoint nothing, schedule the existing `VOLATILE_CAPTURE_RETRY_MS` retry (spec §7.6).
- Tests assert projection **counts** and final-state equality, not wall-clock durations or cross-slice durable-change counts (spec §10.2, §7.4).
- No scripted source rewrites — use editor tools, never sed/python over source.
- Commit after every task; commit messages via `git commit -F -` (bodies pass through bash — no backticks), each with trailer `Podium-Issue: POD-2314`.

---

### Task 1: `SessionView.byIds` and facade `sessionsById`

**Files:**
- Modify: `apps/server/src/modules/sessions/view.ts` (add `byIds` after `byId`, ~line 132)
- Modify: `apps/server/src/modules/sessions/lifecycle.ts` (add `sessionsById` facade next to `sessionById`, ~line 306)
- Test: `apps/server/src/modules/sessions/view.narrow.test.ts` (extend — this file already holds the `byId`/`listForIssue` equivalence suites; follow its fixture pattern)

**Interfaces:**
- Consumes: existing `SessionView.project(candidates, principal)` (private), `ports.sessions: Map<SessionId, Session>`, `perf.record('phase', name, ms, DEPLOYMENT)`.
- Produces:
  - `SessionView.byIds(sessionIds: Iterable<SessionId>, forPrincipal?: SessionStatePrincipal): SessionMeta[]`
  - `SessionLifecycle.sessionsById(sessionIds: Iterable<SessionId>, forPrincipal?: SessionWirePrincipal): SessionMeta[]`

- [ ] **Step 1: Write the failing tests** in `view.narrow.test.ts`, alongside the existing `byId` equivalence tests and using the same corpus builder that file already uses:

```ts
describe('byIds', () => {
  it('equals list().filter over the requested id set, in source order', () => {
    // corpus: mix of visible, invisible-to-principal, absent, archived sessions
    const ids = [idB, idA, absentId, idB /* duplicate */]
    const expected = view.list(principal).filter((row) => new Set(ids).has(row.sessionId))
    expect(view.byIds(ids, principal)).toEqual(expected) // includes ordering
  })
  it('returns [] for an empty id set without projecting anything', () => {
    expect(view.byIds([], principal)).toEqual([])
  })
  it('projects at most the number of distinct resident requested ids', () => {
    // spy on the store issue lookup or wrap canReadSession via the state fixture,
    // matching how the existing byId scaling test in this file counts work
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server && bun --bun vitest run src/modules/sessions/view.narrow.test.ts`
Expected: FAIL — `view.byIds is not a function`.

- [ ] **Step 3: Implement `byIds` in `view.ts`** (spec §5.2: dedupe ids, scan the live map in its existing source order so ordering matches `list().filter`, one shared `project` pass):

```ts
/**
 * A KNOWN SET of sessions by id, without wiring the rest [POD-2314].
 * Same rows and ORDER as `list(p).filter((s) => ids.has(s.sessionId))`:
 * candidates are selected by scanning `ports.sessions` in its insertion
 * order, which is exactly the order `list()` enumerates. One shared
 * `project` pass, so visibility and memo behavior are identical.
 * Callers must not pass an unbounded id set as a disguised full list.
 */
byIds(sessionIds: Iterable<SessionId>, forPrincipal?: SessionStatePrincipal): SessionMeta[] {
  const startedAt = performance.now()
  try {
    const wanted = new Set(sessionIds)
    if (wanted.size === 0) return []
    const candidates = [...this.ports.sessions.values()].filter((session) =>
      wanted.has(session.sessionId),
    )
    return this.project(candidates, forPrincipal)
  } finally {
    perf.record('phase', 'sessionView.byIds', performance.now() - startedAt, DEPLOYMENT)
  }
}
```

Facade in `lifecycle.ts`, mirroring `sessionById`'s doc style:

```ts
/** The sessions of ONE KNOWN ID SET, without wiring the rest [POD-2314].
 *  Same rows and order as `listSessions(p).filter((s) => ids.has(s.sessionId))`;
 *  see {@link SessionView.byIds}. */
sessionsById(sessionIds: Iterable<SessionId>, forPrincipal?: SessionWirePrincipal): SessionMeta[] {
  return this.view.byIds(sessionIds, forPrincipal)
}
```

- [ ] **Step 4: Run the file again**

Run: `cd apps/server && bun --bun vitest run src/modules/sessions/view.narrow.test.ts`
Expected: PASS (new tests and all pre-existing equivalence suites).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/sessions/view.ts apps/server/src/modules/sessions/lifecycle.ts apps/server/src/modules/sessions/view.narrow.test.ts
git commit -F - <<'EOF'
feat: add SessionView.byIds narrow projection

Podium-Issue: POD-2314
EOF
```

---

### Task 2: `sessionRoutingFacts()` internal fact read

Message delivery's two full-set scans (`onIssuesEligibilityChanged`, `reconcileQueued` in `apps/server/src/modules/messages/service.ts:525,589`) iterate every session but read only internal routing fields. Spec §5.3/§5.4: they get a named fact read, not a `SessionMeta[]` projection.

**Files:**
- Modify: `apps/server/src/modules/sessions/lifecycle.ts` (add `sessionRoutingFacts()` next to `sessionSpawnedBy`)
- Test: `apps/server/src/modules/sessions/view.narrow.test.ts` (extend)

**Interfaces:**
- Consumes: `this.repository`'s live map via the same port `SessionView` uses (`bag.sessions` — in `lifecycle.ts` reachable as the map behind `this.view`; add a private accessor if none exists, do NOT export the map).
- Produces:

```ts
export interface SessionRoutingFacts {
  sessionId: SessionId
  issueId?: IssueId
  cwd: string
  status: SessionMeta['status']
  archived: boolean
  agentKind: SessionMeta['agentKind']
}
// on SessionLifecycle:
sessionRoutingFacts(): SessionRoutingFacts[]
```

Only these six fields — they are what `issueForSession` (issueId/cwd), `stateOf` (status), and the delivery eligibility filters read. Add nothing speculative. The DTO is not cached, not persisted, never a wire response (spec §5.3).

- [ ] **Step 1: Write the failing tests**

```ts
describe('sessionRoutingFacts', () => {
  it('returns one fact row per live session with only routing fields', () => {
    const facts = lifecycle.sessionRoutingFacts()
    expect(facts.map((f) => f.sessionId).sort()).toEqual(allLiveIds.sort())
    expect(Object.keys(facts[0]!).sort()).toEqual(
      ['agentKind', 'archived', 'cwd', 'issueId', 'sessionId', 'status'].sort(),
    )
  })
  it('performs zero wire projections', () => {
    const wireSpy = vi.spyOn(view, 'wire')
    lifecycle.sessionRoutingFacts()
    expect(wireSpy).not.toHaveBeenCalled()
  })
  it('matches the admin-scoped list on the default corpus', () => {
    // Equivalence guard for Task 4's migration: on a corpus where the default
    // principal sees everything (the production shape), the fact set and the
    // reader-scoped list agree on membership fields.
    const listed = lifecycle.listSessions()
    const facts = new Map(lifecycle.sessionRoutingFacts().map((f) => [f.sessionId, f]))
    for (const row of listed) {
      const f = facts.get(row.sessionId)!
      expect({ issueId: f.issueId, cwd: f.cwd, status: f.status }).toEqual({
        issueId: row.issueId, cwd: row.cwd, status: row.status,
      })
    }
  })
})
```

- [ ] **Step 2: Run to verify failure** — same vitest command as Task 1. Expected: FAIL, `sessionRoutingFacts is not a function`.

- [ ] **Step 3: Implement.** In `lifecycle.ts` (the class already holds the live map the view projects; reuse whatever private accessor exposes it — e.g. the field passed into `SessionViewPorts.sessions` at wiring time):

```ts
/** TRUSTED INTERNAL routing facts for every live session [POD-2314, spec §5.3].
 *  No visibility check and no wire: this is the fact-read class for supervisory
 *  code that scans every session but reads only internal fields. The result is
 *  a throwaway DTO — never cache it, never return it to a client. */
sessionRoutingFacts(): SessionRoutingFacts[] {
  return [...this.liveSessions.values()].map((s) => ({
    sessionId: s.sessionId,
    ...(s.issueId ? { issueId: s.issueId } : {}),
    cwd: s.cwd,
    status: s.status,
    archived: s.archived === true,
    agentKind: s.agentKind,
  }))
}
```

(Adjust field spellings to the actual `Session` class — check `session.ts` for `status`/`archived` accessors; `toMeta` shows the canonical mapping.)

- [ ] **Step 4: Run tests** — expected PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/sessions/lifecycle.ts apps/server/src/modules/sessions/view.narrow.test.ts
git commit -F - <<'EOF'
feat: add sessionRoutingFacts internal fact read

Podium-Issue: POD-2314
EOF
```

---

### Task 3: Migrate messages-module point lookups

Every `listSessions().find/.some` inside the messages module becomes `sessionById`. The deps interface `MessageDeliveryDeps.sessions` already declares optional `sessionById` (`apps/server/src/modules/messages/service.ts:182`) — the pattern (optional narrow port, full-list fallback so unwired fixtures stay correct-but-slow) is established; extend it to the sibling components.

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts` — sites at lines ~437 (`queueDeliveryTarget` session resolve), ~490 (`mayDrainIssueMail` coordinator check), ~670 (`targetSession` resolve), ~934 (`resolvePrincipal` parent lookup); plus the wiring at ~392/411 that passes only `listSessions` into mailbox/render.
- Modify: `apps/server/src/modules/messages/mailbox.ts` — deps (~line 80) + `replyTarget` (~line 107).
- Modify: `apps/server/src/modules/messages/render.ts` — deps (~line 140) + `crossMachineNote` (~line 223).
- Modify: `apps/server/src/modules/messages/gate.ts` — deps (~line 44) + the `resolvePrincipal` site (~line 233).
- Modify: `apps/server/src/modules/messages/handlers/context.ts` — `isKnownSession` (~line 257).
- Test: existing messages tests must stay green; add narrow-port assertions to the module's existing service test file (locate via `ls apps/server/src/modules/messages/*.test.ts`).

**Interfaces:**
- Consumes: `sessionById(id: SessionId): SessionMeta | undefined` (facade, Task 0 — already exists), wired as `(sessionId) => bag.view.byId(sessionId)` exactly like `apps/server/src/modules/sessions/session-wiring.ts:524` already does.
- Produces: each component's deps gains `sessionById?(sessionId: SessionId): SessionMeta | undefined` with the documented fallback.

- [ ] **Step 1: Write the failing test.** In the messages service test file, build the service with a deps stub whose `listSessions` throws and whose `sessionById` returns a fixture session; assert the migrated paths resolve through `sessionById`:

```ts
it('point lookups use sessionById, never the full list', () => {
  const deps = fixtureDeps({
    sessions: {
      listSessions: () => { throw new Error('full list on a point path') },
      sessionById: (id) => (id === fixtureSession.sessionId ? fixtureSession : undefined),
      listSessionsForIssue: () => [fixtureSession],
      /* ...sendText etc. unchanged from the existing fixture */
    },
  })
  // exercise: send to a session recipient; replyTarget on an agent row;
  // renderFor with a cross-machine receiver. None may throw.
})
```

- [ ] **Step 2: Run to verify it fails** (the throwing `listSessions` fires on today's code).

Run: `cd apps/server && bun --bun vitest run src/modules/messages/<service test file>`

- [ ] **Step 3: Migrate each site.** The uniform shape, shown for `mailbox.ts` `replyTarget`:

```ts
// deps gains:
sessionById?(sessionId: SessionId): SessionMeta | undefined
// site: listSessions().some((s) => s.sessionId === original.fromSession) becomes
const fromId = asSessionId(original.fromSession)
const known = this.deps.sessionById
  ? this.deps.sessionById(fromId) !== undefined
  : this.deps.listSessions().some((s) => s.sessionId === original.fromSession)
```

Apply the same optional-port-with-fallback shape at every listed site:
- `service.ts:437` and `:670`: `sessions.sessionById?.(id) ?? sessions.listSessions().find(...)` — note `sessionById` is already declared on `MessageDeliveryDeps`; just use it.
- `service.ts:490` `mayDrainIssueMail`: replace the `.some(...)` scan with `const coordinator = sessions.sessionById?.(asSessionId(coordinatorId)) ...` then `coordinator !== undefined && coordinator.agentKind !== 'shell' && coordinator.status !== 'exited'` (fallback: today's `.some`).
- `service.ts:934` and `gate.ts:233` (`resolvePrincipal` parent lookup): the callback only needs one session's `spawnedBy` — pass `parentSessionOf: (sessionId) => spawnedByParentSessionId(deps.sessionById?.(sessionId)?.spawnedBy ?? deps.listSessions().find((s) => s.sessionId === sessionId)?.spawnedBy)` and delete the up-front `const sessions = this.deps.listSessions()`.
- `render.ts` `crossMachineNote`: two `sessionById` point lookups (sender, receiver) instead of one full list.
- `handlers/context.ts:257` `isKnownSession`: `(ref) => this.deps.sessionById?.(asSessionId(ref)) !== undefined` with the `.some` fallback.
- Wire the real port at every construction site in `service.ts` (~392/411): add `sessionById: (id) => deps.sessions.sessionById?.(id) ?? deps.sessions.listSessions().find((s) => s.sessionId === id)` — and in `session-wiring.ts` confirm the bag already passes `sessionById: (sessionId) => bag.view.byId(sessionId)` into `MessageDeliveryDeps` (line 524); add it where missing.

- [ ] **Step 4: Run the messages test files** — all green, including the new throwing-list test.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/messages
git commit -F - <<'EOF'
perf: point session lookups in messages via sessionById

Podium-Issue: POD-2314
EOF
```

---

### Task 4: Migrate delivery's full-set scans to routing facts

**Files:**
- Modify: `apps/server/src/modules/messages/service.ts` — `onIssuesEligibilityChanged` (~line 525) and `reconcileQueued` (~line 589); `MessageDeliveryDeps.sessions` gains `sessionRoutingFacts?(): SessionRoutingFacts[]`.
- Modify: `apps/server/src/modules/sessions/session-wiring.ts` — wire `sessionRoutingFacts: () => bag.sessionRoutingFacts()` (or via lifecycle facade) into the delivery deps.
- Test: messages service test file (extend Task 3's suite).

**Interfaces:**
- Consumes: `SessionLifecycle.sessionRoutingFacts(): SessionRoutingFacts[]` (Task 2).
- Produces: nothing new downstream; behavior-preserving migration.

- [ ] **Step 1: Check what the two loops actually read.** Open both call sites and `issueForSession`/`stateOf`. They must consume only `SessionRoutingFacts` fields. If `issueForSession` or the `preferThisIdleSession` branch reads a field outside the DTO, extend `SessionRoutingFacts` in Task 2's files (with a test-field update) rather than widening to `SessionMeta` — but do not add fields no caller reads.

- [ ] **Step 2: Write the failing test:** same throwing-`listSessions` fixture as Task 3, now also supplying `sessionRoutingFacts`; exercise `onIssuesEligibilityChanged(['issue-1'])` and `reconcileQueued()` and assert no throw plus the same queued delivery targets as a control service built with a working `listSessions` and no facts port.

- [ ] **Step 3: Migrate.** In both loops, `const sessions = this.deps.sessions.sessionRoutingFacts?.() ?? this.deps.sessions.listSessions()` — the loop bodies read only shared fields, so one spelling serves both; TypeScript will enforce the intersection. Keep `issueForSession`'s parameter typed as the minimal `Pick<...>`-style shape both satisfy.

- [ ] **Step 4: Run the messages tests** — green, and the control-equivalence assertion passes.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/messages apps/server/src/modules/sessions/session-wiring.ts
git commit -F - <<'EOF'
perf: delivery membership scans read routing facts

Podium-Issue: POD-2314
EOF
```

---

### Task 5: Migrate remaining audited hot call sites

**Files:**
- Modify: `apps/server/src/modules/issues/relay-dispatch.ts` (~line 116, `sessionTitlePrime`)
- Modify: `apps/server/src/modules/sessions/command-plane.ts` (~line 229)
- Modify: `apps/server/src/modules/messaging/service.ts` (~lines 375, 385)
- Modify: `apps/server/src/modules/sessions/session-wiring.ts` (~line 599, mail-nudge selection)
- Test: each module's existing test file; run after each edit.

**Interfaces:**
- Consumes: `sessionById`, `listSessionsForIssue` facade methods (both pre-existing).
- Produces: nothing new.

- [ ] **Step 1: `relay-dispatch.ts` `sessionTitlePrime`:** replace `const all = sessionsSvc.listSessions(); const actor = all.find(...)` with `const actor = sessionsSvc.sessionById(actorSessionId)`; early-return checks unchanged; then fetch siblings with `sessionsSvc.listSessionsForIssue(actor.worktreePath ?? null, issueId)` — confirm against the function body which path/issue pair the sibling filter used and keep that exact predicate (the file already uses `sessionsSvc.sessionById` at line 487, so the facade is in scope).

- [ ] **Step 2: `command-plane.ts:229`:** `const row = this.sessions.sessionById?.(resolved.session.sessionId) ?? this.sessions.listSessions().find(...)` — match how `this.sessions` is typed there; add the optional narrow method to that deps type with the standard fallback comment.

- [ ] **Step 3: `messaging/service.ts`:** both `pickIssueSession(issue, this.deps.sessions?.listSessions() ?? [])` sites become `pickIssueSession(issue, this.deps.sessions?.listSessionsForIssue?.(issue.worktreePath ?? null, issue.id) ?? this.deps.sessions?.listSessions() ?? [])`. `pickIssueSession` filters by membership internally either way (same predicate before vs after, POD-1639 pattern — see the precedent comment at `messages/service.ts:589` area).

- [ ] **Step 4: `session-wiring.ts:599` nudge:** replace `sessionsForIssue(worktreePath ?? null, bag.listSessions())` with `bag.view.listForIssue(worktreePath ?? null, undefined)` — `isIssueMember` with `issueId: undefined` is the identical predicate `sessionsForIssue` applied post-hoc.

- [ ] **Step 5: Run the touched modules' tests:**

Run: `cd apps/server && bun --bun vitest run src/modules/issues src/modules/sessions/command-plane.test.ts src/modules/messaging 2>/dev/null` (adjust to actual test file paths; run whatever exists for each touched file). Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/modules/issues/relay-dispatch.ts apps/server/src/modules/sessions/command-plane.ts apps/server/src/modules/messaging/service.ts apps/server/src/modules/sessions/session-wiring.ts
git commit -F - <<'EOF'
perf: migrate relay, command, messaging, nudge session reads

Podium-Issue: POD-2314
EOF
```

---

### Task 6: Source audit with full-list allowlist

Spec §5.5. Follow the repo's audit-test doctrine (`apps/server/src/session-cutover.audit.test.ts` header): every absence check plants the pattern and proves it is FOUND before its "no" is believed.

**Files:**
- Create: `apps/server/src/session-projection.audit.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — reads source text with `node:fs` + a recursive walk of `apps/server/src`.
- Produces: the allowlist (inline in the test file), which later tasks and future editors extend deliberately.

- [ ] **Step 1: Write the audit test:**

```ts
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname)
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return name === 'node_modules' ? [] : walk(p)
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : []
  })

const FORBIDDEN = [
  /listSessions\(\)\s*\n?\s*\.\s*find\(/,
  /listSessions\(\)\.find\(/,
  /listSessions\(\)\s*\n?\s*\.\s*some\(/,
  /listSessions\(\)\.some\(/,
  /sessionsForIssue\([^)]*listSessions\(\)/,
]

/** Files where the FULL reader-visible world is the intended output, or where
 *  the full list is the documented fallback behind a wired narrow port.
 *  Every entry says WHY (spec §5.5). */
const FULL_LIST_ALLOWLIST: Record<string, string> = {
  'modules/issue-session-lifecycle.ts':
    'delete/restore issue: prepareSoftDelete/prepareRestore consume the remaining full world; rare operator action, not a hot path',
  'modules/issues/service/core.ts':
    'attention snapshot pass intentionally spans all sessions; narrow port with fallback already at sessionsFor',
  'modules/issues/service/attention.ts':
    'reap/auto-archive passes scan every issue against every session on a timer cadence',
  'steward.ts': 'subscription dispatch is supervisory batch cadence',
  'modules/superagent/service.ts': 'concierge full-fleet summaries are full-world output',
  'modules/superagent/tools.ts': 'list-all tool output is full-world by contract',
  'server.ts': 'client bootstrap serves the full reader-visible world',
  // fallback arms behind wired narrow ports (correct-but-slow fixture path):
  'modules/messages/service.ts': 'fallback arms only; narrow ports wired in production',
  'modules/messages/mailbox.ts': 'fallback arm only',
  'modules/messages/render.ts': 'fallback arm only',
  'modules/messages/gate.ts': 'fallback arm only',
  'modules/messages/handlers/context.ts': 'fallback arm only',
  'modules/messaging/service.ts': 'fallback arm only',
  'modules/sessions/command-plane.ts': 'fallback arm only',
}

describe('session projection source audit [POD-2314, spec §5.5]', () => {
  it('the scanner can find a planted anti-pattern', () => {
    const planted = 'x.listSessions().find((s) => s)'
    expect(FORBIDDEN.some((re) => re.test(planted))).toBe(true)
  })
  it('no production file spells a full-list point lookup', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1)
      if (rel in FULL_LIST_ALLOWLIST) continue
      const text = readFileSync(file, 'utf8')
      if (FORBIDDEN.some((re) => re.test(text))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
  it('every allowlist entry still exists and still uses the full list', () => {
    for (const rel of Object.keys(FULL_LIST_ALLOWLIST)) {
      const text = readFileSync(join(SRC, rel), 'utf8')
      expect(text.includes('listSessions'), `${rel} no longer needs its allowlist entry`).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run it.** Expected: the offenders assertion FAILS if Tasks 3–5 missed a site (fix the site or, with written justification, allowlist it), then PASSES. The planted-pattern check must pass from the start.

Run: `cd apps/server && bun --bun vitest run src/session-projection.audit.test.ts`

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/session-projection.audit.test.ts
git commit -F - <<'EOF'
test: source audit bans full-list session point lookups

Podium-Issue: POD-2314
EOF
```

---

### Task 7: Sliced volatile capture drain in `SessionRepository`

Spec §7.2–§7.3, §7.6. `flushVolatileSessionCaptures()` (`repository.ts:179`) keeps barrier semantics; a new `drainVolatileCaptureSlice(budget)` drains a bounded prefix. Both share one per-entry capture body so behavior cannot fork.

**Files:**
- Modify: `apps/server/src/modules/sessions/repository.ts`
- Test: create `apps/server/src/modules/sessions/repository.volatile-slice.test.ts` (fixture pattern: copy the ports stub from whichever existing test constructs `SessionRepository` — search `new SessionRepository(` under `src/modules/sessions`).

**Interfaces:**
- Consumes: existing private state `pendingVolatileSessions`, `capturedSessionStates`, `captureSessionSpecs`, `SessionRepository.VOLATILE_CAPTURE_RETRY_MS`, `this.view.wire`.
- Produces:

```ts
interface VolatileSliceBudget { maxItems: number; maxCpuMs: number }
interface VolatileSliceResult { changes: MetadataChange[]; remaining: number }
static readonly VOLATILE_SLICE_MAX_ITEMS = 32
static readonly VOLATILE_SLICE_MAX_CPU_MS = 8
drainVolatileCaptureSlice(budget?: VolatileSliceBudget): VolatileSliceResult
// flushVolatileSessionCaptures(): MetadataChange[]  — unchanged signature, now the barrier
```

- [ ] **Step 1: Write the failing tests** with `vi.useFakeTimers()` and an injectable clock for the CPU budget (pass `now?: () => number` inside the budget for tests, defaulting to `performance.now`):

```ts
it('drains at most maxItems per slice and reports the remainder', () => {
  markDirty(40 /* sessions */)
  const r1 = repo.drainVolatileCaptureSlice()
  expect(r1.changes.length).toBeLessThanOrEqual(32)
  expect(r1.remaining).toBe(8)
  expect(repo.drainVolatileCaptureSlice().remaining).toBe(0)
})
it('elapsed budget stops a slice between candidates, never inside one', () => {
  // fake clock advances 5ms per candidate; maxCpuMs 8 → exactly 2 candidates
})
it('a mutation between slices keeps the session pending and publishes the newest value', () => {
  markDirty(40); repo.drainVolatileCaptureSlice()
  mutateSession(idInRemainder); // bumps version via markVolatileSessionDirty
  const r2 = repo.drainVolatileCaptureSlice()
  expect(capturedValueFor(idInRemainder)).toEqual(newestValue)
})
it('same-slice A-B-A churn dedups to no durable change', () => { /* existing behavior */ })
it('capture failure removes nothing from the failed slice and schedules retry', () => {
  ledger.failNext()
  expect(() => repo.drainVolatileCaptureSlice()).toThrow()
  expect(repo.hasPendingVolatile()).toBe(true)
  // retry timer scheduled at VOLATILE_CAPTURE_RETRY_MS; next attempt is the same slice
})
it('a vanished session clears its pending entry after a successful no-op slice', () => { ... })
it('flushVolatileSessionCaptures drains EVERYTHING regardless of backlog size', () => {
  markDirty(100)
  repo.flushVolatileSessionCaptures()
  expect(repo.hasPendingVolatile()).toBe(false)
})
```

- [ ] **Step 2: Run to verify failure.** `cd apps/server && bun --bun vitest run src/modules/sessions/repository.volatile-slice.test.ts` — FAIL, method missing.

- [ ] **Step 3: Implement.** Extract the per-entry body from today's `flushVolatileSessionCaptures` and give both entry points one shared core:

```ts
/** Drain a bounded prefix of pendingVolatileSessions [POD-2314, spec §7.3].
 *  Budget is checked BETWEEN candidates; a started candidate always finishes.
 *  issueRelevant is computed over this slice's entries. Version equality
 *  decides removal, so a mutation landing between slices stays pending. */
drainVolatileCaptureSlice(budget?: VolatileSliceBudget): VolatileSliceResult {
  const maxItems = budget?.maxItems ?? SessionRepository.VOLATILE_SLICE_MAX_ITEMS
  const maxCpuMs = budget?.maxCpuMs ?? SessionRepository.VOLATILE_SLICE_MAX_CPU_MS
  const startedAt = performance.now()
  const slice: [SessionId, PendingVolatileState][] = []
  for (const entry of this.pendingVolatileSessions) {
    if (slice.length >= maxItems) break
    if (slice.length > 0 && performance.now() - startedAt >= maxCpuMs) break
    slice.push(entry)
  }
  const changes = this.captureVolatileEntries(slice)
  return { changes, remaining: this.pendingVolatileSessions.size }
}
```

`captureVolatileEntries(pending)` is the extracted body of lines 183–214 verbatim (spec/wire/capture/checkpoint/version-checked delete, catch → `scheduleVolatileSessionCapture(VOLATILE_CAPTURE_RETRY_MS)` + rethrow), with `issueRelevant` computed over the passed entries. `flushVolatileSessionCaptures()` becomes: clear timer, loop `captureVolatileEntries([...this.pendingVolatileSessions])` — i.e. one whole-map call, preserving today's exact barrier behavior including whole-batch dedup. Name the pending-entry type (`PendingVolatileState`) instead of repeating the inline object type. Insertion-order iteration of the Map is the deterministic progress order (spec §7.4).

- [ ] **Step 4: Run the new test file AND the existing repository/broadcast tests** (`bun --bun vitest run src/modules/sessions/repository*.test.ts src/modules/sessions/broadcast-issue-skip.test.ts`). Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/modules/sessions/repository.ts apps/server/src/modules/sessions/repository.volatile-slice.test.ts
git commit -F - <<'EOF'
feat: version-checked sliced volatile capture drain

Podium-Issue: POD-2314
EOF
```

---

### Task 8: Schedule slices; barrier only at dispose/tests

Spec §7.4–§7.5. Today the zero-delay timer (`repository.ts:160-171`) fires `ports.flushBroadcasts()`, whose chain (`SessionBroadcastCoordinator.flush` → `flushVolatileCaptures` → full drain) is the barrier. Scheduled publication must instead drain ONE slice, flush deltas, and re-arm one zero-delay timer while work remains.

**Files:**
- Modify: `apps/server/src/modules/sessions/repository.ts` (`scheduleVolatileSessionCapture` callback)
- Modify: `apps/server/src/modules/sessions/publication/broadcast.ts` (`SessionBroadcastCoordinator`: ports gain `drainVolatileSlice(): { remaining: number }`; `run()` uses it; `flush()` keeps `flushVolatileCaptures`)
- Modify: `apps/server/src/modules/sessions/session-wiring.ts` (~line 120: wire the new port)
- Test: create `apps/server/src/modules/sessions/publication/broadcast.slice.test.ts`

**Interfaces:**
- Consumes: `drainVolatileCaptureSlice` (Task 7), `funnel.flushDeltas()`.
- Produces: `SessionBroadcastPorts` gains `drainVolatileSlice(): { remaining: number }`; rollback env flag `PODIUM_UNSLICED_VOLATILE=1` restores the full-drain callback (spec §9 step 2 — read once at wiring time in `session-wiring.ts`, no live toggling).

- [ ] **Step 1: Write the failing tests** with fake timers:

```ts
it('regular publication drains one slice per turn and re-arms a zero-delay timer', () => {
  markDirty(80)
  coordinator.broadcast()
  vi.advanceTimersByTime(0) // first timer turn
  expect(drainCalls).toBe(1)
  expect(pendingRemaining()).toBe(48)
  vi.advanceTimersByTime(0)
  expect(drainCalls).toBe(2) // continuation timer, not recursion
})
it('deltas flush after every slice, preserving Authority order across slices', () => { ... })
it('flush() still drains everything synchronously (dispose/test barrier)', () => {
  markDirty(80); coordinator.flush(); expect(pendingRemaining()).toBe(0)
})
it('no production code path reaches the barrier: the timer callback never calls flushVolatileCaptures', () => {
  // spy wiring: barrier spy stays at 0 while timers fire
})
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.**
  - `broadcast.ts` `run()`: replace `this.ports.flushVolatileCaptures()` with `const { remaining } = this.ports.drainVolatileSlice(); this.ports.flushDeltas(); if (remaining > 0) this.ports.scheduleVolatileCapture()` — `scheduleVolatileCapture` already exists on the ports and self-dedupes via the repository timer guard; that timer IS the one-zero-delay-continuation the spec requires. `flush()` unchanged (barrier).
  - `repository.ts` `scheduleVolatileSessionCapture` callback: keep calling `this.ports.flushBroadcasts()` — but `flushBroadcasts` maps to `broadcasts.flush()` today, which is now barrier-only. Add a repository port `runScheduledBroadcast(): void` wired to `bag.broadcasts.broadcast()` and call THAT from the timer, so timer turns route through `broadcast()` → `run()` → one slice. Verify with the Task 8 tests that `dispose()` (`lifecycle.ts:252` → `flushBroadcasts`) still reaches the barrier.
  - `session-wiring.ts`: wire `drainVolatileSlice: () => { const r = bag.repository.drainVolatileCaptureSlice(); return { remaining: r.remaining } }`; under `process.env.PODIUM_UNSLICED_VOLATILE === '1'` wire `drainVolatileSlice` to `{ bag.repository.flushVolatileSessionCaptures(); return { remaining: 0 } }` and note the flag in the code comment as the POD-2314 rollback path.
  - Also handle `SessionBroadcastCoordinator.broadcast()`'s first branch (`hasPendingVolatile` → `scheduleVolatileCapture`): unchanged — it already defers to the timer.

- [ ] **Step 4: Run** the new test file plus every existing test that exercises broadcast/flush (`bun --bun vitest run src/modules/sessions`). Many existing tests rely on `flushBroadcasts()` barrier semantics in fixtures — they must stay green untouched; a test that starts failing because it implicitly depended on scheduled-path full drains gets a `flushBroadcasts()` call added, which is the sanctioned test barrier.

- [ ] **Step 5: Add slice instrumentation** (spec §8) inside the pieces this task and Task 7 built:
  - in `drainVolatileCaptureSlice`: `perf.record('phase', 'volatileCapture.slice', ms, DEPLOYMENT)` plus a `log.debug` with `{ candidates, captured, remaining }`;
  - in the catch path of `captureVolatileEntries`: `perf.record('phase', 'volatileCapture.retry', ...)` and log `{ sliceSize, pendingCount, oldestPendingAgeMs }` — record an `enqueuedAt = now()` on each pending entry when first marked dirty to make the age computable;
  - in `flushVolatileSessionCaptures`: `perf.record('phase', 'volatileCapture.barrier', ...)`.

- [ ] **Step 6: Run the full sessions module tests once more, then commit**

```bash
git add apps/server/src/modules/sessions
git commit -F - <<'EOF'
feat: schedule volatile capture as one slice per turn

Regular publication drains a bounded slice and re-arms a zero-delay
timer; flushBroadcasts() remains the dispose/test barrier. Rollback:
PODIUM_UNSLICED_VOLATILE=1.

Podium-Issue: POD-2314
EOF
```

---

### Task 9: Caller labels for surviving full-list reads

Spec §8: any remaining `sessionView.list` hot path must be attributable via a closed label vocabulary at the narrow ports, not free strings at call sites.

**Files:**
- Modify: `apps/server/src/modules/sessions/view.ts` (`list` gains an optional caller), `apps/server/src/modules/sessions/lifecycle.ts` (facade threads it through)
- Modify: each allowlisted full-list call site from Task 6 to pass its label
- Test: `apps/server/src/modules/sessions/view.narrow.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
export type SessionListCaller =
  | 'bootstrap' | 'listAllTool' | 'issueDeleteRestore' | 'attentionPass'
  | 'steward' | 'superagent' | 'fixtureFallback' | 'unlabeled'
// view.ts:
list(forPrincipal?: SessionStatePrincipal, caller: SessionListCaller = 'unlabeled'): SessionMeta[]
```

- [ ] **Step 1: Write the failing test:** spy on `perf.record` and assert `view.list(p, 'bootstrap')` records phase `sessionView.list.bootstrap` and bare `view.list(p)` records `sessionView.list.unlabeled` (keep also recording the aggregate `sessionView.list` phase so POD-2262 comparisons stay apples-to-apples).

- [ ] **Step 2: Implement:** in `list()`'s `finally`, record both `'sessionView.list'` and `` `sessionView.list.${caller}` ``. Thread `caller` through the `listSessions` facade. Update the allowlisted call sites (server.ts bootstrap, superagent tools/service, steward, attention passes, issue delete/restore) to pass their label. The union type caps cardinality — adding a label is a deliberate type edit.

- [ ] **Step 3: Run** `view.narrow.test.ts` + typecheck the server package only: `bun run typecheck --filter @podium/server --concurrency=1` (NEVER the root typecheck — it OOMs sessions). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src
git commit -F - <<'EOF'
feat: closed caller labels on full session list reads

Podium-Issue: POD-2314
EOF
```

---

### Task 10: Full verification pass and re-profile handoff

**Files:** none created; this task runs gates and records results.

- [ ] **Step 1: Scaling assertions** (spec §10.2) — confirm `view.narrow.test.ts` now covers: by-id ≤1 visibility+wire; by-ids ≤ distinct resident ids; issue-scoped = member count; fact reads = 0 wire calls. Add any missing one as a test in that file before proceeding.

- [ ] **Step 2: Run the touched-module test set:**

```bash
cd apps/server && bun --bun vitest run \
  src/modules/sessions src/modules/messages src/modules/messaging \
  src/modules/issues src/session-projection.audit.test.ts
```

Expected: PASS. Then scoped typecheck: `bun run typecheck --filter @podium/server --concurrency=1`.

- [ ] **Step 3: Green is scoped to what you ran** — record in the commit message and issue state exactly which suites ran and at which SHA. Do NOT run the root test lane or root typecheck from this worktree.

- [ ] **Step 4: Re-profile is a live-deployment step (spec §9 step 3), not runnable from this worktree.** Record in the issue (`podium issue deferred`): repeat the POD-2262 live typing workload at ≥2,000 sessions after this lands and the server restarts (the web dist and server only pick up code at restart), and check the §10.4 gates: no `sessionView.list` on hot paths (the per-caller labels prove attribution), `volatileCapture.slice` p99 < 16 ms, no slice > 50 ms, typing-input p99 < 50 ms, no >100 ms stall attributed to projection/publication, final client state equal to unsliced control. Remove `PODIUM_UNSLICED_VOLATILE` support only after one stable workload window.

- [ ] **Step 5: Final commit and stage**

```bash
git add -A && git commit -F - <<'EOF'
test: complete bridge scaling and gate coverage

Podium-Issue: POD-2314
EOF
```

Move the issue to review and post an offer naming merge/send-back actions.

---

## Self-review notes (already applied)

- Spec §5.1 "Required API" ↔ tasks: `sessionById`/`listSessionsForIssue` pre-exist; `sessionsById` = Task 1; fact reads = Task 2 (named `sessionRoutingFacts` rather than the spec's illustrative `sessionFactsForIssue`, because the audited full-set callers scan all sessions, not one issue — spec §5.3 says add only facts the migrated callers need); intentional full list + allowlist = Task 6 + Task 9 labels.
- Spec §5.4 audited targets ↔ tasks: messages point lookups (Task 3), delivery membership (Task 4), issue lifecycle/nudge/messaging/relay/command (Task 5; issue delete/restore deliberately allowlisted as rare full-world consumers, recorded in Task 6's allowlist).
- Spec §7 ↔ Tasks 7–8; §7.6 retry lives in the shared `captureVolatileEntries`; the cross-slice A→B→A note (§7.4) is honored by Task 7's tests asserting final state, not durable counts.
- §8 ↔ Task 8 step 5 + Task 9. §10.1–10.3 ↔ Tasks 1, 2, 7, 8. §10.4 ↔ Task 10 (deferred live gate).
- Type consistency: `drainVolatileCaptureSlice` returns `{ changes, remaining }` everywhere; coordinator port narrows to `{ remaining }`; `SessionRoutingFacts` fields match Task 2 and Task 4 consumers.
