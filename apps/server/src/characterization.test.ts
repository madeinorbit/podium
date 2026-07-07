import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '@podium/core/sqlite'
import type { ControlMessage, MetadataChange, ServerMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import { runIssueCli } from '../../../scripts/issue-cli'
import { type Capability, OPERATOR } from './issue-authz'
import { MetadataOplog } from './oplog'
import { SessionRegistry } from './relay'
import { appRouter } from './router'
import { callerAsIssueTrpc } from './server'
import { SessionStore } from './store'

/**
 * Characterization net for the architecture redesign (store.ts / relay.ts dissolution).
 *
 * Every test here PINS CURRENT BEHAVIOR — including semantics that are known-weird
 * (marked as such inline). If a refactor changes any of these observable data
 * behaviors, a test in this file must fail. Nothing here asserts on log text or
 * rendered strings; all assertions are on wire messages, rows, and event payloads.
 */

const G = { cols: 80, rows: 24 }
const bind = (sessionId: string) =>
  ({
    type: 'bind',
    sessionId,
    cmd: 'claude',
    cwd: '/',
    agentKind: 'claude-code',
    geometry: G,
  }) as const

function sink() {
  const sent: ServerMessage[] = []
  return { send: (m: ServerMessage) => sent.push(m), sent }
}

// ---------------------------------------------------------------------------
// Contract 1 — session lifecycle roundtrip across a daemon reconnect.
// The pieces (spawn shape, buffered replay, resume cursors, reconnecting →
// bind → live) are each covered in relay.test.ts / session.test.ts; this test
// composes them into the one roundtrip a refactor is most likely to break:
// seq continuity, epoch stability, and buffer preservation THROUGH a daemon
// disconnect + reattach.
// ---------------------------------------------------------------------------

describe('characterization: session roundtrip across daemon reconnect (contract 1)', () => {
  it('server seq stays monotonic, the epoch does not bump, and the replay buffer survives a daemon disconnect + rebind', () => {
    const reg = new SessionRegistry()
    const daemon1: ControlMessage[] = []
    reg.attachDaemon('local', (m) => daemon1.push(m))
    const { sessionId } = reg.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    // Spawn control message shape — the daemon-facing half of the contract.
    expect(daemon1).toContainEqual(
      expect.objectContaining({ type: 'spawn', sessionId, agentKind: 'claude-code', cwd: '/proj' }),
    )
    reg.onDaemonMessageFrom('local', bind(sessionId))

    // A client attached from the start observes everything live.
    const witness = sink()
    const witnessId = reg.attachClient(witness.send)
    reg.onClientMessage(witnessId, { type: 'attach', sessionId })

    // Three frames before the disconnect. The daemon bridge seq (0,1,2) is
    // IGNORED: the server assigns its own monotonic seq starting at 0.
    for (const [i, data] of (['QQ==', 'Qg==', 'Qw=='] as const).entries()) {
      reg.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: i, data })
    }

    // Daemon connection drops: the session degrades to reconnecting (not exited).
    reg.detachDaemon('local')
    expect(reg.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('reconnecting')

    // A new daemon connection reattaches; bind promotes the session back to live.
    const daemon2: ControlMessage[] = []
    reg.attachDaemon('local', (m) => daemon2.push(m))
    reg.onDaemonMessageFrom('local', bind(sessionId))
    expect(reg.listSessions().find((s) => s.sessionId === sessionId)?.status).toBe('live')

    // Post-reconnect frames arrive with the bridge seq RESET to 0 (that is what a
    // fresh PTY bridge does). One frame arrives batched — agentFrameBatch unpacks
    // into per-frame server seqs exactly like single agentFrame messages.
    reg.onDaemonMessageFrom('local', { type: 'agentFrame', sessionId, seq: 0, data: 'RA==' })
    reg.onDaemonMessageFrom('local', { type: 'agentFrameBatch', sessionId, frames: ['RQ=='] })

    // The already-attached client saw ONE unbroken monotonic stream: server seqs
    // 0..4 across the reconnect (no reset to the bridge's 0), same epoch 0
    // throughout (a daemon reconnect is not a takeover).
    const live = witness.sent.filter((m) => m.type === 'outputFrame')
    expect(live.map((f) => [f.seq, f.data])).toEqual([
      [0, 'QQ=='],
      [1, 'Qg=='],
      [2, 'Qw=='],
      [3, 'RA=='],
      [4, 'RQ=='],
    ])
    expect(new Set(live.map((f) => f.epoch))).toEqual(new Set([0]))

    // A client that disconnected mid-way resumes from its cursor: sinceSeq=2 →
    // resumed:true and EXACTLY the two missed frames, in order.
    const resumer = sink()
    const resumerId = reg.attachClient(resumer.send)
    reg.onClientMessage(resumerId, { type: 'attach', sessionId, sinceSeq: 2 })
    expect(resumer.sent.find((m) => m.type === 'attached')).toMatchObject({
      sessionId,
      epoch: 0,
      resumed: true,
    })
    expect(
      resumer.sent.filter((m) => m.type === 'outputFrame').map((f) => [f.seq, f.data]),
    ).toEqual([
      [3, 'RA=='],
      [4, 'RQ=='],
    ])

    // A fresh mount (no cursor) gets the FULL buffer — pre-disconnect frames were
    // not dropped by the reconnect.
    const fresh = sink()
    const freshId = reg.attachClient(fresh.send)
    reg.onClientMessage(freshId, { type: 'attach', sessionId })
    expect(fresh.sent.find((m) => m.type === 'attached')).toMatchObject({ resumed: false })
    expect(fresh.sent.filter((m) => m.type === 'outputFrame').map((f) => f.seq)).toEqual([
      0, 1, 2, 3, 4,
    ])
    reg.dispose()
  })
})

// ---------------------------------------------------------------------------
// Contract 2 — the same issue lifecycle via all three entry points must
// converge on identical rows, events, comments, and oplog state.
// ---------------------------------------------------------------------------

/** Strip per-run randomness (uuids in ids, wall-clock ISO stamps) so payloads
 *  from independent runs are comparable byte-for-byte. */
function normalize(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v)
      .replace(/(iss|cmt|msg)_[0-9a-fA-F-]{36}/g, '$1_X')
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TS'),
  )
}

interface LifecycleObservation {
  wire: unknown
  events: unknown
  comments: unknown
  oplogIssues: unknown
}

/** Everything observable after the lifecycle ran on one registry. */
function observe(reg: SessionRegistry, issueId: string): LifecycleObservation {
  reg.flushBroadcasts()
  const store = reg.sessionStore
  return {
    wire: normalize(reg.issues.get(issueId)),
    events: normalize(
      store
        .listEventsSince(0)
        .map((e) => ({ kind: e.kind, subject: e.subject, repoPath: e.repoPath, payload: e.payload })),
    ),
    comments: normalize(store.listIssueComments(issueId)),
    // Compare the FOLDED oplog state, not row counts: sync writes coalesce
    // differently than awaited ones, but the final recorded truth must match.
    oplogIssues: normalize(
      store
        .latestChangeStates()
        .filter((r) => r.entity === 'issue')
        .map((r) => ({ op: r.op, payload: r.payload == null ? null : JSON.parse(r.payload) })),
    ),
  }
}

describe('characterization: issue lifecycle equivalence across entry points (contract 2)', () => {
  const registries: SessionRegistry[] = []
  const freshRegistry = () => {
    const reg = new SessionRegistry()
    registries.push(reg)
    // A delta-cap client so the broadcast pipeline runs the full oplog path in
    // all three runs identically.
    const c = sink()
    const id = reg.attachClient(c.send)
    reg.onClientMessage(id, {
      type: 'hello',
      clientId: '',
      viewport: { cols: 80, rows: 24, dpr: 1 },
      caps: ['metadataDelta'],
    })
    return reg
  }
  const operatorCaller = (reg: SessionRegistry) =>
    appRouter.createCaller({
      registry: reg,
      repos: {} as never,
      superagent: {} as never,
      capability: OPERATOR,
    })

  it('create → claim → comment → close yields identical rows, events, comments, and folded oplog via IssueService, the CLI command registry, and the tRPC router', async () => {
    try {
      // (a) IssueService direct.
      const regA = freshRegistry()
      const a = regA.issues.create({
        repoPath: '/repo',
        title: 'Lifecycle',
        description: 'characterize me',
        startNow: false,
      })
      regA.issues.claim(a.id, 'agent:test')
      regA.issues.addComment(a.id, 'agent:test', 'progress note')
      regA.issues.close(a.id, 'done')

      // (b) the ISSUE_COMMANDS registry — the CLI/MCP path — over an in-process
      // caller adapted to the IssueTrpc client shape.
      const regB = freshRegistry()
      const cli = callerAsIssueTrpc(operatorCaller(regB))
      const created = await runIssueCli(
        ['create', '--repoPath', '/repo', '--title', 'Lifecycle', '--description', 'characterize me'],
        cli,
      )
      const seq = /created #(\d+)/.exec(created)?.[1]
      if (!seq) throw new Error(`no seq in: ${created}`)
      await runIssueCli(['claim', seq, '--assignee', 'agent:test'], cli)
      await runIssueCli(['comment', seq, '--body', 'progress note', '--author', 'agent:test'], cli)
      await runIssueCli(['close', seq, '--reason', 'done'], cli)
      const bId = regB.issues.resolveRef(seq)

      // (c) the tRPC router directly.
      const regC = freshRegistry()
      const trpc = operatorCaller(regC)
      const c = await trpc.issues.create({
        repoPath: '/repo',
        title: 'Lifecycle',
        description: 'characterize me',
        startNow: false,
      })
      await trpc.issues.claim({ id: c.id, assignee: 'agent:test' })
      await trpc.issues.addComment({ id: c.id, author: 'agent:test', body: 'progress note' })
      await trpc.issues.close({ id: c.id, reason: 'done' })

      const obsA = observe(regA, a.id)
      const obsB = observe(regB, bId)
      const obsC = observe(regC, c.id)

      // Sanity: the run actually did the whole lifecycle (guards against three
      // identically-empty observations passing vacuously).
      expect(obsA.wire).toMatchObject({
        stage: 'done',
        closedReason: 'done',
        assignee: 'agent:test',
      })
      expect((obsA.events as { kind: string }[]).map((e) => e.kind)).toEqual([
        'issue.created',
        'issue.stage_changed',
        'issue.closed',
      ])
      expect(obsA.comments).toHaveLength(1)
      expect(obsA.comments).toMatchObject([{ author: 'agent:test', body: 'progress note' }])
      expect(obsA.oplogIssues).toHaveLength(1)

      // The actual contract: all three entry points converge byte-for-byte
      // (modulo uuids/timestamps).
      expect(obsB).toEqual(obsA)
      expect(obsC).toEqual(obsA)
    } finally {
      for (const r of registries.splice(0)) r.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract 2 (cont.) — the closedReason/stage bimodality AS IT BEHAVES TODAY.
// "Closed" is a DERIVED predicate: stage === 'done' || closedReason != null.
// These tests characterize the weird corners of that bimodality; they are NOT
// an endorsement — a redesign that fixes them must consciously update these.
// ---------------------------------------------------------------------------

describe('characterization: closedReason/stage bimodality (contract 2, known-weird)', () => {
  it('a bare closedReason patch closes the issue WITHOUT moving its stage', () => {
    const reg = new SessionRegistry()
    try {
      const w = reg.issues.create({ repoPath: '/r', title: 'bimodal', startNow: false })
      const patched = reg.issues.update(w.id, { closedReason: 'wontfix' })
      // KNOWN-WEIRD: the issue now counts as closed everywhere (stats, filters,
      // ready/blocked derivation) while its stage still says 'backlog'.
      expect(patched.stage).toBe('backlog')
      expect(patched.closedReason).toBe('wontfix')
      expect(reg.issues.search({ repoPath: '/r', status: 'closed' }).map((i) => i.id)).toEqual([
        w.id,
      ])
      expect(reg.issues.search({ repoPath: '/r', status: 'open' })).toEqual([])
      expect(reg.issues.stats('/r')).toMatchObject({ total: 1, closed: 1, open: 0 })
      // The close EVENT fires off the derived flip, with the patched reason.
      const closed = reg.sessionStore.listEventsSince(0).filter((e) => e.kind === 'issue.closed')
      expect(closed).toHaveLength(1)
      expect(closed[0]?.payload).toMatchObject({ seq: w.seq, reason: 'wontfix' })
    } finally {
      reg.dispose()
    }
  })

  it('reopening via a stage patch leaves closedReason set — the issue STAYS closed', () => {
    const reg = new SessionRegistry()
    try {
      const w = reg.issues.create({ repoPath: '/r', title: 'reopen me', startNow: false })
      reg.issues.close(w.id) // stage done + closedReason 'done'
      // The obvious "reopen": drag the card back to in_progress.
      const reopened = reg.issues.update(w.id, { stage: 'in_progress' })
      expect(reopened.stage).toBe('in_progress')
      // KNOWN-WEIRD: closedReason survives the stage move, so the derived
      // closed-predicate still holds — the "reopened" issue is invisible to
      // open/ready filters and still counts as closed in stats.
      expect(reopened.closedReason).toBe('done')
      expect(reg.issues.search({ repoPath: '/r', status: 'open' })).toEqual([])
      expect(reg.issues.stats('/r')).toMatchObject({ closed: 1, open: 0 })
      // A true reopen requires explicitly clearing the reason too.
      const cleared = reg.issues.update(w.id, { closedReason: null })
      expect(cleared.closedReason).toBeUndefined()
      expect(reg.issues.search({ repoPath: '/r', status: 'open' }).map((i) => i.id)).toEqual([w.id])
    } finally {
      reg.dispose()
    }
  })

  it('re-closing after a stage-only "reopen" emits NO second issue.closed event', () => {
    const reg = new SessionRegistry()
    try {
      const w = reg.issues.create({ repoPath: '/r', title: 'silent re-close', startNow: false })
      reg.issues.close(w.id)
      reg.issues.update(w.id, { stage: 'in_progress' }) // stage-only reopen, reason stays
      reg.issues.update(w.id, { stage: 'done' }) // drag back to done
      // KNOWN-WEIRD: issue.closed fires on the DERIVED false→true flip only.
      // Because closedReason never cleared, the predicate never flipped false,
      // so the second close is event-silent (watchers miss it).
      const closed = reg.sessionStore.listEventsSince(0).filter((e) => e.kind === 'issue.closed')
      expect(closed).toHaveLength(1)
      // The stage churn IS visible as stage_changed (done→in_progress only;
      // transitions INTO done never emit stage_changed).
      const stages = reg.sessionStore
        .listEventsSince(0)
        .filter((e) => e.kind === 'issue.stage_changed')
        .map((e) => e.payload)
      expect(stages).toEqual([{ seq: w.seq, from: 'done', to: 'in_progress' }])
    } finally {
      reg.dispose()
    }
  })
})

// ---------------------------------------------------------------------------
// Contract 3 — oplog cursor replay: the client-healing composition.
// (Monotonic seq, exact deltas, and the compaction signal are pinned in
// oplog.test.ts / store.changes.test.ts; this composes them into the actual
// consumer behavior: a lagging client healing to the exact live state.)
// ---------------------------------------------------------------------------

describe('characterization: oplog delta client heals to identical state (contract 3)', () => {
  /** A minimal delta consumer: fold changes into an id→value map. */
  const apply = (state: Map<string, unknown>, changes: MetadataChange[]): number => {
    let cursor = 0
    for (const c of changes) {
      if (c.op === 'upsert') state.set(c.id, (c as { value: unknown }).value)
      else state.delete(c.id)
      cursor = c.seq
    }
    return cursor
  }

  it('a client that missed N deltas reconstructs the exact live state from changesSince(cursor)', () => {
    const store = new SessionStore(':memory:')
    const oplog = new MetadataOplog(store)
    const liveState = new Map<string, unknown>()
    const lagState = new Map<string, unknown>()

    // Round 1 — both clients see it.
    let changes = oplog.record('issue', [
      { id: 'a', value: { id: 'a', title: 'a1' } },
      { id: 'b', value: { id: 'b', title: 'b1' } },
    ])
    apply(liveState, changes)
    const lagCursor = apply(lagState, changes)

    // Rounds 2-3 happen while the lagging client is offline: an edit, a removal,
    // and a brand-new entity.
    apply(liveState, oplog.record('issue', [{ id: 'a', value: { id: 'a', title: 'a2' } }]))
    changes = oplog.record('issue', [
      { id: 'a', value: { id: 'a', title: 'a3' } },
      { id: 'c', value: { id: 'c', title: 'c1' } },
    ])
    apply(liveState, changes)

    // Heal: exactly the missed range, and folding it reproduces the live state.
    const missed = oplog.changesSince(lagCursor)
    expect(missed).not.toBeNull()
    const healedCursor = apply(lagState, missed as MetadataChange[])
    expect(lagState).toEqual(liveState)
    expect(healedCursor).toBe(oplog.cursor())

    // Compaction past the client's cursor forces the full-resync signal (null),
    // never a silent partial delta.
    store.pruneChanges({ keepRows: 1, maxAgeMs: 60_000, now: Date.now() })
    expect(oplog.changesSince(lagCursor)).toBeNull()
    store.close()
  })
})

// ---------------------------------------------------------------------------
// Contract 5 — DB compatibility: reopening a database created by the CURRENT
// schema code with the same code is a no-op. This is the safety net for the
// Phase 1 migration conversion: after it, this same test must still pass on a
// db created by the pre-migration code path.
// ---------------------------------------------------------------------------

describe('characterization: same-version DB reopen is a no-op (contract 5)', () => {
  const schemaOf = (file: string): unknown[] => {
    const db = openDatabase(file)
    const rows = db
      .prepare(
        "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all()
    db.close()
    return rows
  }

  it('close + reopen preserves the full schema and every row across all table families', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'podium-char-db-')), 'podium.db')

    // Populate one row in each family through the real write paths.
    const store1 = new SessionStore(file)
    const reg1 = new SessionRegistry(store1)
    reg1.attachDaemon('local', () => {})
    const { sessionId } = reg1.createSession({ agentKind: 'claude-code', cwd: '/proj' })
    const issue = reg1.issues.create({ repoPath: '/repo', title: 'survive', startNow: false })
    reg1.issues.addComment(issue.id, 'agent:test', 'durable note')
    reg1.issues.close(issue.id, 'done')
    reg1.withMutation('mut-char-1', 'issues.close', () => ({ ok: true }))
    store1.enqueueMessage({ id: 'qm-char-1', sessionId, text: 'queued', queuedAt: 1000 })
    reg1.flushBroadcasts() // oplog `changes` rows

    // Capture the observable truth, then shut down cleanly.
    const before = {
      sessionIds: store1.loadSessions().map((s) => s.id),
      issue: store1.getIssue(issue.id),
      comments: store1.listIssueComments(issue.id),
      events: store1.listEventsSince(0),
      changes: store1.changesSince(0),
      maxChangeSeq: store1.maxChangeSeq(),
      applied: store1.getAppliedMutation('mut-char-1'),
      queued: store1.listQueuedMessages(sessionId),
    }
    expect(before.sessionIds).toContain(sessionId)
    expect(before.issue).not.toBeNull()
    expect(before.changes.length).toBeGreaterThan(0)
    reg1.dispose()
    store1.close()

    const schemaBefore = schemaOf(file)
    expect(schemaBefore.length).toBeGreaterThan(10) // the schema actually exists

    // Reopen with the SAME code: the constructor migration pass must not fire any
    // destructive ALTER twice, drop data, or reshape the schema.
    const store2 = new SessionStore(file)
    const after = {
      sessionIds: store2.loadSessions().map((s) => s.id),
      issue: store2.getIssue(issue.id),
      comments: store2.listIssueComments(issue.id),
      events: store2.listEventsSince(0),
      changes: store2.changesSince(0),
      maxChangeSeq: store2.maxChangeSeq(),
      applied: store2.getAppliedMutation('mut-char-1'),
      queued: store2.listQueuedMessages(sessionId),
    }
    expect(after).toEqual(before)

    // The oplog seq keeps counting from where it was — a reset here would corrupt
    // every client cursor.
    const next = store2.appendChanges(
      [{ entity: 'issue', entityId: issue.id, op: 'upsert', payload: '{}' }],
      2000,
    )
    expect(next).toEqual([before.maxChangeSeq + 1])
    store2.close()

    expect(schemaOf(file)).toEqual(schemaBefore)
  })
})

// ---------------------------------------------------------------------------
// Contract 6 — authz failure MODES by tRPC error code. router.issues.test.ts
// pins the message text; these pin the CODE split (FORBIDDEN = hard role
// denial vs PRECONDITION_FAILED = scope violation, overridable) and that the
// mailClaim in-proc duplicate of the middleware check behaves identically.
// ---------------------------------------------------------------------------

describe('characterization: authz error codes + mailClaim/middleware parity (contract 6)', () => {
  const outcome = (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => 'OK',
      (e) => (e as { code?: string }).code ?? `no-code:${(e as Error).message}`,
    )

  it('scope violations are PRECONDITION_FAILED, role denials are FORBIDDEN, operator passes — identically via the middleware and the in-proc mailClaim check', async () => {
    const reg = new SessionRegistry()
    try {
      const op = appRouter.createCaller({
        registry: reg,
        repos: {} as never,
        superagent: {} as never,
        capability: OPERATOR,
      })
      const caller = (capability: Capability, overrideScope = false) =>
        appRouter.createCaller({
          registry: reg,
          repos: {} as never,
          superagent: {} as never,
          capability,
          overrideScope,
        })
      const A = await op.issues.create({ repoPath: '/r', title: 'mine', startNow: false })
      const B = await op.issues.create({ repoPath: '/r', title: 'theirs', startNow: false })
      const mailA = await op.issues.mailSend({ id: A.id, body: 'for A' })
      const mailB = await op.issues.mailSend({ id: B.id, body: 'for B' })

      const worker = caller({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } })
      const viewer = caller({ role: 'viewer', scope: { kind: 'all' } })

      // Middleware path (issues.update / issues.delete).
      expect(await outcome(worker.issues.update({ id: A.id, patch: { notes: 'in' } }))).toBe('OK')
      expect(await outcome(worker.issues.update({ id: B.id, patch: { notes: 'out' } }))).toBe(
        'PRECONDITION_FAILED',
      )
      expect(await outcome(viewer.issues.update({ id: A.id, patch: { notes: 'x' } }))).toBe(
        'FORBIDDEN',
      )
      expect(await outcome(worker.issues.delete({ id: A.id }))).toBe('FORBIDDEN') // manage beats scope
      expect(await outcome(op.issues.update({ id: B.id, patch: { notes: 'op' } }))).toBe('OK')

      // mailClaim path — the scope check duplicated INSIDE the proc (the guard
      // cannot resolve message→issue). Same codes for the same failure modes.
      expect(await outcome(viewer.issues.mailClaim({ messageId: mailA.id }))).toBe('FORBIDDEN')
      expect(await outcome(worker.issues.mailClaim({ messageId: mailB.id }))).toBe(
        'PRECONDITION_FAILED',
      )
      expect(await outcome(worker.issues.mailClaim({ messageId: mailA.id }))).toBe('OK')

      // The override lever unlocks exactly the PRECONDITION_FAILED cases, on both
      // paths — and never the FORBIDDEN ones.
      const overridden = caller({ role: 'worker', scope: { kind: 'subtree', rootId: A.id } }, true)
      expect(await outcome(overridden.issues.update({ id: B.id, patch: { notes: 'o' } }))).toBe(
        'OK',
      )
      expect(await outcome(overridden.issues.mailClaim({ messageId: mailB.id }))).toBe('OK')
      const overriddenViewer = caller({ role: 'viewer', scope: { kind: 'all' } }, true)
      expect(await outcome(overriddenViewer.issues.update({ id: A.id, patch: { notes: 'x' } }))).toBe(
        'FORBIDDEN',
      )
    } finally {
      reg.dispose()
    }
  })
})
