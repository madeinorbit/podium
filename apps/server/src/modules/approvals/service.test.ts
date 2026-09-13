import { asIssueId, asSessionId, asUserId, type SessionId } from '@podium/model'
import type { ApprovalOp, LiveServerMessage } from '@podium/protocol'
import type { ControlMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { ApprovalsRepository } from '../../store/approvals'
import { createBunStoreExecutor } from '../../store/executor'
import { openMigratedTestDatabase } from '../../test-support/migrated-database'
import { openTestStore } from '../../test-support/open-test-store'
import { APPROVAL_EXEC_DEADLINE_MS, ApprovalService } from './service'

/** The human who owns session `s1`, which is the session every request below
 *  names. Approvals are that person's to see and to decide (B1, PDM-133). */
const OWNER = asUserId('user:owner')
/** A second, unrelated human. Owns `s_stranger` and nothing else. */
const STRANGER = asUserId('user:stranger')

/** The requesting session: the one every `req()` below files against, and the one
 *  whose agent polls its own request on the normal path. */
const S1 = asSessionId('s1')
/** A SECOND session of the SAME human. Not the row's session, so only the `user`
 *  arm of the read gate can admit it. */
const S1_SIBLING = asSessionId('s1_sibling')
/** A session belonging to the OTHER human — a real second member's session, not
 *  an unowned one. The refusal below has to be for being somebody ELSE, and an
 *  unresolvable owner would produce the same refusal for a different reason
 *  (false-green catalogue shape 14). */
const S_STRANGER = asSessionId('s_stranger')

/** Who owns each session here. `sessionOwner` is the service's declared port onto
 *  the session control plane — the same one `listPending`/`approve`/`deny` are
 *  decided through — so this fixture decides who the callers ARE, and never
 *  stands in for the decision itself. An id absent from this map is a session
 *  with no resolvable owner. */
const OWNERS: Record<string, typeof OWNER | undefined> = {
  [S1]: OWNER,
  [S1_SIBLING]: OWNER,
  [S_STRANGER]: STRANGER,
}

/** The requesting agent reading the request it filed — the normal path. */
const SELF = { sessionId: S1, user: OWNER }
/** The same human, asking from a session that is not the row's. */
const OWNER_ELSEWHERE = { sessionId: S1_SIBLING, user: OWNER }
/** The other human's agent, holding a valid id it should never have had. */
const STRANGER_READER = { sessionId: S_STRANGER, user: STRANGER }

function harness(executeServerOp?: (op: ApprovalOp, sessionId: SessionId) => string | null) {
  const db = openMigratedTestDatabase()
  const sent: Array<{ machineId: string; msg: ControlMessage }> = []
  const broadcasts: LiveServerMessage[] = []
  const events: Array<{ kind: string; issueId: string | null }> = []
  const mails: string[] = []
  /** Whether the owning machine's daemon is attached — the stall deadline's one gate. */
  const daemon = { attached: true }
  /**
   * WHO MAY RUN ON WHICH MACHINE, RIGHT NOW (B5, PDM-137).
   *
   * Mutable on purpose, and the mutation IS the test: an approval waits for a
   * human indefinitely, so the interesting window is the one between filing a
   * request and answering it. `machine-access.ts` reads ownership live on every
   * call so a hand-over or a revoked grant bites at the next decision; this
   * fixture is that fact, held where a test can move it.
   */
  const fleet = { usable: new Set<string>([`${OWNER}@m1`, `${STRANGER}@m1`]) }
  /** Every question the service asked of the fleet, in order — so a test can pin
   *  WHOSE authority was checked, not merely that something was. */
  const dispatchAsks: Array<{ owner: string; machineId: string }> = []
  /** The stall deadline's clock, driven by the tests rather than the wall. */
  const clock = { ms: 1_000_000 }
  /** A service over the SAME durable store. Called twice, it models a server restart:
   *  the rows survive, every in-memory field (the stall clock) does not. */
  const build = () => {
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    return new ApprovalService({
      onDeliveryDiscarded: () => () => {},
      store: new ApprovalsRepository(stage),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: (machineId, msg) => sent.push({ machineId, msg }),
      hasDaemon: () => daemon.attached,
      nowMs: () => clock.ms,
      clients: () => [
        { send: (m: LiveServerMessage) => broadcasts.push(m), principal: { user: OWNER } },
      ],
      sessionOwner: async (sessionId) => OWNERS[sessionId],
      mayDispatchTo: async (owner, machineId) => {
        dispatchAsks.push({ owner, machineId })
        return fleet.usable.has(`${owner}@${machineId}`)
      },
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: (kind, issueId) => {
        events.push({ kind, issueId })
      },
      notifyIssue: async (_issueId, body) => {
        mails.push(body)
      },
      ...(executeServerOp ? { executeServerOp } : {}),
    })
  }
  return {
    svc: build(),
    restart: build,
    sent,
    broadcasts,
    events,
    mails,
    daemon,
    clock,
    fleet,
    dispatchAsks,
  }
}

const req = (svc: ApprovalService, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId: S1, machineId: 'm1' })

/** The same filing, from a named session — the second human's agent, or the same
 *  human's second session. `machineId` is stamped by the relay from the daemon
 *  socket in production (`relay-gate.ts`), never by the payload, so both of these
 *  legitimately name one machine. */
const reqFrom = (svc: ApprovalService, sessionId: SessionId, op: unknown = { kind: 'update' }) =>
  svc.request({ op, sessionId, machineId: 'm1' })

describe('ApprovalService', () => {
  it('request files a pending row, logs, and broadcasts', async () => {
    const { svc, broadcasts, events } = harness()
    const r = await req(svc)
    expect(r.status).toBe('pending')
    expect(r.message).toContain('awaiting the operator')
    expect(events).toEqual([{ kind: 'issue.approval_requested', issueId: 'iss_1' }])
    expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    expect(await svc.listPending(OWNER)).toHaveLength(1)
    expect((await svc.listPending(OWNER))[0]).toMatchObject({
      machineName: 'ludovico',
      issueSeq: 410,
      op: { kind: 'update' },
    })
  })

  it('an identical pending op on the same machine is deduped, not stacked', async () => {
    const { svc } = harness()
    const a = await req(svc)
    const b = await req(svc)
    expect(b.id).toBe(a.id)
    expect(await svc.listPending(OWNER)).toHaveLength(1)
  })

  it('rejects an op outside the closed catalog', async () => {
    const { svc } = harness()
    await expect(req(svc, { kind: 'rm-rf' })).rejects.toThrow()
    await expect(req(svc, { kind: 'set-server' })).rejects.toThrow() // missing target
  })

  it('approve → executing + exec request to the owning daemon; result lands', async () => {
    const { svc, sent, events } = harness()
    const { id } = await req(svc)
    const w = await svc.approve(id, OWNER)
    expect(w.status).toBe('executing')
    expect(sent).toEqual([
      {
        machineId: 'm1',
        msg: { type: 'approvalExecRequest', requestId: id, op: { kind: 'update' } },
      },
    ])
    await svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: true,
      exitCode: 0,
      output: 'ok',
    })
    expect((await svc.get({ id }, SELF)).status).toBe('succeeded')
    expect(events.map((e) => e.kind)).toEqual([
      'issue.approval_requested',
      'issue.approval_approved',
      'issue.approval_succeeded',
    ])
  })

  it('deny is terminal, mails the requesting issue, and double-decisions throw', async () => {
    const { svc, sent, mails } = harness()
    const { id } = await req(svc)
    expect((await svc.deny(id, OWNER)).status).toBe('denied')
    expect(mails).toEqual([expect.stringContaining('denied by the operator')])
    await expect(svc.approve(id, OWNER)).rejects.toThrow(/not pending/)
    expect(sent).toHaveLength(0)
  })
  it('executes server-owned workflow approvals without forwarding them to a daemon', async () => {
    const executed: Array<{ op: ApprovalOp; sessionId: SessionId }> = []
    const { svc, sent, events } = harness((op, sessionId) => {
      executed.push({ op, sessionId })
      return 'published workflow revision wfr_1'
    })
    const { id } = await req(svc, { kind: 'workflow-publish', revisionId: 'wfr_1' })
    const result = await svc.approve(id, OWNER)
    expect(result).toMatchObject({
      status: 'succeeded',
      resultText: 'published workflow revision wfr_1',
    })
    expect(executed).toEqual([
      { op: { kind: 'workflow-publish', revisionId: 'wfr_1' }, sessionId: asSessionId('s1') },
    ])
    expect(sent).toEqual([])
    expect(events.at(-1)?.kind).toBe('issue.approval_succeeded')
  })

  it('no mail when the requesting CLI is still blocked on the decision (it reports itself)', async () => {
    const { svc, mails } = harness()
    const { id } = await req(svc)
    await svc.getFromAgent({ id }, SELF) // the blocked CLI polling — marks a live waiter
    await svc.deny(id, OWNER)
    expect(mails).toEqual([]) // the command prints "denied" itself; no duplicate push
  })

  /**
   * THE READ ASKS WHO IS KNOCKING (PDM-278).
   *
   * `get`/`getFromAgent` resolved a caller-supplied id straight out of the store
   * and returned the row's machine, session, issue and operation to anybody who
   * reached them, while B1 had already gated the other three doors onto the same
   * rows. These four are the witnesses for the rule, and the fixture is built so
   * that each one can only pass for its own reason: `OWNERS` gives `s_stranger` a
   * REAL SECOND HUMAN rather than leaving it unowned, so the refusal below is for
   * being someone else and not for having no resolvable owner — two situations
   * that produce the same answer through different code (false-green shape 14).
   */
  it('the requesting agent reads the request it filed, even with no resolvable owner', async () => {
    const { svc } = harness()
    const { id } = await req(svc)
    // `user: undefined` is the honest shape for a session whose owner the control
    // plane cannot resolve: `capabilityForSession` carries no `onBehalfOf` then.
    // The self-session arm has to stand on its own, or the normal path — an
    // agent's CLI blocking on its own approval — breaks for those sessions.
    const w = await svc.getFromAgent({ id }, { sessionId: S1 })
    expect(w).toMatchObject({ id, sessionId: S1, status: 'pending' })
  })

  it("a second session of the same human reads it — the owner's, not the row's", async () => {
    const { svc } = harness()
    const { id } = await req(svc)
    expect(await svc.get({ id }, OWNER_ELSEWHERE)).toMatchObject({ id, status: 'pending' })
  })

  it("another human's agent is refused a valid id, in the words an unknown id gets", async () => {
    const { svc } = harness()
    const { id } = await req(svc)

    // The two refusals must be INDISTINGUISHABLE. Answering anything else here
    // confirms that an approval with this id exists and names a session the
    // caller cannot see — the existence oracle ADR 3 Amendment 1 D20.2 rules out,
    // and the rule `assertMayDecide` already applies to approve/deny.
    const refused = await svc.get({ id }, STRANGER_READER).catch((e: Error) => e)
    const unknown = await svc.get({ id: 'apr_nope' }, SELF).catch((e: Error) => e)
    expect((refused as Error).message).toBe(`unknown approval request: ${id}`)
    expect((unknown as Error).message).toBe('unknown approval request: apr_nope')

    // And the owner still gets it, so the refusal is about WHO asked and not
    // about the row having become unreadable.
    expect(await svc.get({ id }, SELF)).toMatchObject({ id })
  })

  it("a stranger's poll cannot swallow the mail the owner's agent waits for", async () => {
    const { svc, mails } = harness()
    const { id } = await req(svc)

    // `getFromAgent` is not a pure read: it marks the caller a LIVE WAITER, and
    // `notify` skips the mail push for a row someone is blocked on because that
    // command prints the outcome itself. Ungated, that let a stranger suppress
    // delivery of a decision on somebody else's run — the read was a write to
    // another human's notification path, which is worse than the disclosure.
    await expect(svc.getFromAgent({ id }, STRANGER_READER)).rejects.toThrow(
      `unknown approval request: ${id}`,
    )
    await svc.deny(id, OWNER)
    expect(mails).toEqual([expect.stringContaining('denied by the operator')])
  })

  it('failed execution records the output and mails the outcome', async () => {
    const { svc, mails } = harness()
    const { id } = await req(svc)
    await svc.approve(id, OWNER)
    await svc.onExecResult({
      type: 'approvalExecResult',
      requestId: id,
      ok: false,
      exitCode: 1,
      output: 'signature verification failed',
    })
    const w = await svc.get({ id }, SELF)
    expect(w.status).toBe('failed')
    expect(w.resultText).toContain('signature')
    expect(mails.at(-1)).toContain('FAILED')
  })

  /**
   * POD-2223 — the stall deadline.
   *
   * A daemon older than the release that widened `ApprovalChannelTarget` fails
   * `ControlMessage.parse` on `{ kind: 'channel', target: 'dev' }` and, before this,
   * answered nothing at all — verified by running the pre-widening protocol (98f65d411^)
   * against the frame the current server sends. The row then sat `executing` forever:
   * `listPending` is `status = 'pending'` only, so it left the operator's popup at the
   * moment of approval; `notify` only fires on a transition, so the mail fallback never
   * ran; and the agent's CLI gave up after ten minutes saying the outcome would be
   * reported, which was false.
   *
   * The daemon now answers such a frame — but that arm ships in the same release as the
   * value that needs it, so ON MERGE DAY every daemon in the fleet is one without it.
   * This deadline is what covers that fleet.
   */
  describe('stalled executions (POD-2223)', () => {
    const t0 = 1_000_000
    /** Approve a channel op and hand it to the daemon, returning its row id. */
    const approveChannelDev = async (svc: ApprovalService) => {
      const { id } = await req(svc, { kind: 'channel', target: 'dev' })
      await svc.approve(id, OWNER)
      return id
    }

    it('fails a row whose connected daemon never answered, saying what to do about it', async () => {
      const { svc, mails, broadcasts, events } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0) // first sight starts the clock

      expect((await svc.get({ id }, SELF)).status).toBe('executing')
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)

      const w = await svc.get({ id }, SELF)
      expect(w.status).toBe('failed')
      // The three things an operator can act on: which machine, the likely cause, and
      // that the outcome is UNKNOWN rather than known-not-to-have-happened.
      expect(w.resultText).toContain('ludovico')
      expect(w.resultText).toMatch(/predates this operation/i)
      expect(w.resultText).toMatch(/may or may not have run/i)
      expect(mails.at(-1)).toContain('FAILED')
      expect(events.at(-1)?.kind).toBe('issue.approval_failed')
      // The operator's clients learn about it too — the row is gone from `pending`, so
      // the broadcast is what re-settles their view.
      expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    })

    it('leaves a row alone until the deadline actually passes', async () => {
      const { svc } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS - 1)
      expect((await svc.get({ id }, SELF)).status).toBe('executing')
    })

    it('never fails a row on first sight, so a server restart is not a mass failure', async () => {
      const { svc, restart } = harness()
      const id = await approveChannelDev(svc)
      // The clock lives in memory, so a restarted server meets rows that are old but
      // UNOBSERVED. Its first sweep, however late, must start their clocks rather than
      // fail every one of them at once.
      const afterRestart = restart()
      await afterRestart.sweepStalledExecutions(t0 + 60 * 60_000)
      expect((await afterRestart.get({ id }, SELF)).status).toBe('executing')
      // And then hold to the same deadline from there.
      await afterRestart.sweepStalledExecutions(t0 + 60 * 60_000 + APPROVAL_EXEC_DEADLINE_MS)
      expect((await afterRestart.get({ id }, SELF)).status).toBe('failed')
    })

    it('does not fail a row parked for an absent daemon, and restarts its clock on attach', async () => {
      const { svc, daemon } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)

      // `toMachine` QUEUES for an offline machine: the frame is parked, not lost, so no
      // amount of waiting here is a stall.
      daemon.attached = false
      await svc.sweepStalledExecutions(t0 + 24 * 60 * 60_000)
      expect((await svc.get({ id }, SELF)).status).toBe('executing')

      // Back on the wire a day later — the clock restarts from here, so the daemon gets
      // its full deadline to answer a frame it has only just received.
      daemon.attached = true
      const back = t0 + 24 * 60 * 60_000 + 60_000
      await svc.sweepStalledExecutions(back)
      expect((await svc.get({ id }, SELF)).status).toBe('executing')
      await svc.sweepStalledExecutions(back + APPROVAL_EXEC_DEADLINE_MS)
      expect((await svc.get({ id }, SELF)).status).toBe('failed')
    })

    it('exempts stop, whose daemon kills itself before it can report', async () => {
      const { svc } = harness()
      const { id } = await req(svc, { kind: 'stop' })
      await svc.approve(id, OWNER)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + 10 * APPROVAL_EXEC_DEADLINE_MS)
      // Still `executing`, which the service's own doc calls honest for this op.
      expect((await svc.get({ id }, SELF)).status).toBe('executing')
    })

    it('lets a late result correct a row the deadline had already failed', async () => {
      const { svc, mails } = harness()
      const id = await approveChannelDev(svc)
      await svc.sweepStalledExecutions(t0)
      await svc.sweepStalledExecutions(t0 + APPROVAL_EXEC_DEADLINE_MS)
      expect((await svc.get({ id }, SELF)).status).toBe('failed')

      // The machine answers anyway. Being told "it failed" about an op that ran is worse
      // than being told nothing, so the record moves to what actually happened.
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'channel set to dev',
      })
      const w = await svc.get({ id }, SELF)
      expect(w.status).toBe('succeeded')
      expect(w.resultText).toBe('channel set to dev')
      expect(mails.at(-1)).toMatch(/LATE/)
    })

    it('does not re-open a row that reached a terminal state on its own', async () => {
      const { svc } = harness()
      const id = await approveChannelDev(svc)
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: false,
        exitCode: 1,
        output: 'no such channel',
      })
      expect((await svc.get({ id }, SELF)).status).toBe('failed')
      // A stray duplicate result must not move a settled row.
      await svc.onExecResult({
        type: 'approvalExecResult',
        requestId: id,
        ok: true,
        exitCode: 0,
        output: 'surprise',
      })
      expect((await svc.get({ id }, SELF)).resultText).toBe('no such channel')
    })
  })
})


/**
 * The outcome mail is the same shape as the lock bug (POD-3802): a dep wired at
 * the composition root to `IssueService.sendMail`, which opens its own store
 * transaction. `ApprovalService.notify` has always awaited it, so the whole
 * defect was the single `void` at that wiring — which is why the dep is now
 * typed `Promise<void>`, making a discarded promise there a type error rather
 * than a runtime span break [POD-3806].
 *
 * This pins the half a type cannot: that `notify` still AWAITS, so the mail is a
 * properly nested savepoint of the deciding span and not a parallel one. The
 * service is built over the SAME store the span is opened on, as production
 * builds it, and the mail is production-shaped — it opens a real transaction.
 */
describe('ApprovalService under the async store (POD-3806)', () => {
  it('the outcome mail does not break the span the decision runs in', async () => {
    const store = await openTestStore(':memory:')
    const mails: string[] = []
    const svc = new ApprovalService({
      onDeliveryDiscarded: () => () => {},
      store: store.approvals,
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      clients: () => [],
      sessionOwner: async () => OWNER,
      // Not this test's subject: the owner may always run on the machine here.
      mayDispatchTo: async () => true,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async (_issueId, body) => {
        mails.push(body)
        await store.transact(async () => {
          await store.issues.getIssue(asIssueId('iss_mail'))
        })
      },
    })
    const filed = await req(svc)

    await store.transact(async () => {
      await svc.deny(filed.id, OWNER)
      // The statement the lock bug died on: same span, after the mail.
      await store.issues.getIssue(asIssueId('iss_after'))
    })

    expect(mails).toEqual([
      `approval ${filed.id} ("update podium (self-update from the configured channel)"): denied by the operator`,
    ])
  })
})

/**
 * APPROVALS TARGET THE ACTUAL RUN OWNER (B1, PDM-133).
 *
 * An approval names a session, a machine, an issue and a management operation,
 * and deciding one EXECUTES that operation on somebody's running agent. Before
 * B1 the queue was instance-wide and the decision took an id and nothing else:
 * `listPending()` returned every row to whoever asked, `broadcast()` pushed the
 * same payload to every connected client, and `approve(id)` / `deny(id)` ran for
 * any caller that reached /trpc.
 */
describe('an approval belongs to the human whose run it is about', () => {
  it('does not list another human\'s pending approvals', async () => {
    const { svc } = harness()
    await req(svc)

    // NON-VACUITY: the row exists and the owner can see it. Without this the
    // assertion below passes on an empty store.
    expect(await svc.listPending(OWNER)).toHaveLength(1)
    expect(await svc.listPending(STRANGER)).toEqual([])
  })

  it('refuses approve and deny from a human who does not own the run', async () => {
    const { svc, sent, events } = harness()
    const filed = await req(svc)
    const before = { sent: sent.length, events: events.length }

    // The SAME message an unknown id gets — refusing differently would confirm
    // the approval exists and name a session the caller cannot see.
    await expect(svc.approve(filed.id, STRANGER)).rejects.toThrow(
      `unknown approval request: ${filed.id}`,
    )
    await expect(svc.deny(filed.id, STRANGER)).rejects.toThrow(
      `unknown approval request: ${filed.id}`,
    )

    // AND NOTHING HAPPENED: the refusal refused, it did not act. A thrown error
    // after the daemon frame went out would be the worst of both.
    expect(sent).toHaveLength(before.sent)
    expect(events).toHaveLength(before.events)
    expect(await svc.listPending(OWNER)).toHaveLength(1)

    // THE INSTRUMENT CAN SAY YES: the owner decides the very same row.
    const denied = await svc.deny(filed.id, OWNER)
    expect(denied.status).toBe('denied')
  })

  it('broadcasts each client only its own queue', async () => {
    const db = openMigratedTestDatabase()
    const stage = createBunStoreExecutor({ database: db }).queries
    if (!stage) throw new Error('the test database is not bun-backed')
    const toOwner: LiveServerMessage[] = []
    const toStranger: LiveServerMessage[] = []
    const svc = new ApprovalService({
      onDeliveryDiscarded: () => () => {},
      store: new ApprovalsRepository(stage),
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      clients: () => [
        { send: (m: LiveServerMessage) => toOwner.push(m), principal: { user: OWNER } },
        { send: (m: LiveServerMessage) => toStranger.push(m), principal: { user: STRANGER } },
      ],
      sessionOwner: async () => OWNER,
      // Not this test's subject: the owner may always run on the machine here.
      mayDispatchTo: async () => true,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => ({ seq: 410, title: 'Approval broker' }),
      machineName: () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async () => {},
    })

    await req(svc)

    // Both clients were pushed to — so this is not "the stranger got nothing
    // because nothing was broadcast".
    expect(toOwner.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    expect(toStranger.at(-1)).toMatchObject({ type: 'approvalsChanged' })
    // ...but only the owner's payload carries the row.
    expect((toOwner.at(-1) as { pending: unknown[] }).pending).toHaveLength(1)
    expect((toStranger.at(-1) as { pending: unknown[] }).pending).toEqual([])
  })
})

/**
 * B5 · PDM-137 — AUTHORIZE EXECUTION AT DISPATCH, USING THE ORIGINAL HUMAN.
 *
 * An approval is the longest-lived queued effect this server has: it waits for a
 * human, indefinitely, and then hands a management operation to a daemon. That
 * makes it the one place where "the rights that accepted this request" and "the
 * rights at the moment it runs" are most likely to be different facts.
 *
 * Two properties are witnessed here, and each is proved in BOTH directions —
 * a refusal a broken build would not produce, and the matching success on the
 * unbroken one, because a refusal test that passes when nothing can ever run is
 * worth nothing (false-green catalogue shapes 4 and 33).
 */
describe('ApprovalService · dispatch-time machine authority (B5, PDM-137)', () => {
  it('a machine revoked while the approval waited refuses, and reaches no daemon', async () => {
    const { svc, sent, fleet } = harness()
    const filed = await req(svc)
    expect(filed.status).toBe('pending')

    // The window this whole mechanism is about: the operator took days, and in
    // the meantime that machine stopped being theirs to run on.
    fleet.usable.delete(`${OWNER}@m1`)

    await expect(svc.approve(filed.id, OWNER)).rejects.toThrow(/no longer yours to run on/)
    // NOTHING CROSSED THE WIRE. The refusal has to be checked here and not only
    // by the thrown message: `toMachine` queues for an absent daemon, so a frame
    // sent and parked looks identical to one never sent from the caller's side.
    expect(sent).toEqual([])
    // ...and no state moved, so the operator can still deny it.
    expect(await svc.listPending(OWNER)).toHaveLength(1)
    expect((await svc.listPending(OWNER))[0]).toMatchObject({ id: filed.id, status: 'pending' })
  })

  it('the same approval, with the machine still theirs, does dispatch', async () => {
    // THE OTHER DIRECTION. Without this the refusal above passes on a build where
    // approve() can never dispatch at all, which is a different defect wearing
    // the same green.
    const { svc, sent } = harness()
    const filed = await req(svc)
    const wire = await svc.approve(filed.id, OWNER)
    expect(wire.status).toBe('executing')
    expect(sent).toEqual([
      { machineId: 'm1', msg: { type: 'approvalExecRequest', requestId: filed.id, op: { kind: 'update' } } },
    ])
  })

  it('asks about the RUN OWNER, not the human doing the approving', async () => {
    /**
     * THE PROPERTY PIN (false-green catalogue shape 19).
     *
     * `mayDecide` forces decider and run owner equal today, so no input to the
     * public API can make them diverge — pointing the decider at a stranger only
     * produces an `unknown approval request` from the gate above, and would
     * prove nothing about which identity reached the fleet (shape 33: the naive
     * plant moves both values together).
     *
     * So the question the service actually ASKED is pinned instead. If a later
     * change re-points the dispatch check at `actor`, this still passes today and
     * starts failing the moment the two can differ — which is exactly when it
     * matters, and is loud where reading `actor` would be silent.
     */
    const { svc, dispatchAsks } = harness()
    const filed = await req(svc)
    dispatchAsks.length = 0
    await svc.approve(filed.id, OWNER)
    expect(dispatchAsks).toEqual([{ owner: OWNER, machineId: 'm1' }])
  })

  it('an agent cannot even file against a machine that is not its human\'s', async () => {
    // The enqueue half. It narrows nothing the dispatch check does not already
    // cover; it keeps the operator's queue free of undecidable rows.
    const { svc, fleet } = harness()
    fleet.usable.delete(`${OWNER}@m1`)
    await expect(req(svc)).rejects.toThrow(/not yours to run on/)
    expect(await svc.listPending(OWNER)).toEqual([])
  })

  it('a session with no resolvable owner still files, and still cannot execute', async () => {
    /**
     * PDM-278's path, kept working. An agent whose human cannot be resolved polls
     * the request it filed itself through `mayRead`'s session arm; refusing to
     * file it would break that for no authorization gain, because the row is
     * inert — no human passes `mayDecide`, so nothing can approve it.
     */
    const { svc } = harness()
    const ORPHAN = asSessionId('s_orphan') // absent from OWNERS
    const filed = await reqFrom(svc, ORPHAN)
    expect(filed.status).toBe('pending')
    expect(await svc.listPending(OWNER)).toEqual([])
    expect(await svc.listPending(STRANGER)).toEqual([])
    await expect(svc.approve(filed.id, OWNER)).rejects.toThrow(/unknown approval request/)
  })
})

describe('ApprovalService · idempotency is bound to the principal (B5, PDM-137)', () => {
  it('two humans filing the same op on one machine get two rows, not one', async () => {
    /**
     * THE DEFECT: the dedup keyed on `machineId + op` across every pending row on
     * the instance, so the second human was handed the FIRST human's row id and
     * the words "already requested" — a reference to a decision only somebody
     * else could make, on a row they are not even allowed to read.
     */
    const { svc } = harness()
    const mine = await reqFrom(svc, S1)
    const theirs = await reqFrom(svc, S_STRANGER)

    expect(theirs.id).not.toBe(mine.id)
    expect(theirs.message).toContain('awaiting the operator')

    const ownerQueue = await svc.listPending(OWNER)
    const strangerQueue = await svc.listPending(STRANGER)
    expect(ownerQueue.map((r) => r.id)).toEqual([mine.id])
    expect(strangerQueue.map((r) => r.id)).toEqual([theirs.id])
  })

  it('but ONE human retrying still dedups, across a respawn onto a new session', async () => {
    /**
     * THE OTHER DIRECTION, and it is the one that says the fix did not simply
     * delete the dedup. The anti-stacking purpose is per HUMAN, not per session:
     * an agent that respawned keeps the same operator and must not stack a second
     * popup on them.
     */
    const { svc } = harness()
    const first = await reqFrom(svc, S1)
    const retry = await reqFrom(svc, S1_SIBLING)
    expect(retry.id).toBe(first.id)
    expect(retry.message).toContain('already requested')
    expect(await svc.listPending(OWNER)).toHaveLength(1)
  })

  it('a different op from the same human is not deduped either', async () => {
    // Pins that the dedup still discriminates on the OP — otherwise the test
    // above would pass over a dedup that collapses everything one human files.
    const { svc } = harness()
    const a = await reqFrom(svc, S1, { kind: 'update' })
    const b = await reqFrom(svc, S1, { kind: 'stop' })
    expect(b.id).not.toBe(a.id)
    expect(await svc.listPending(OWNER)).toHaveLength(2)
  })
})

/**
 * PDM-401 — A REFUSED DISPATCH HAS TO SETTLE.
 *
 * `MachinesService` parks an exec frame for a machine whose daemon is away, and
 * since PDM-401 it REFUSES that frame at flush if the machine changed hands in
 * the meantime. A refusal nothing records is indistinguishable from a loss: the
 * effect does not happen and no reader can tell the server decided it, on
 * purpose. These pin the settlement, and — sharply — pin that it does NOT reuse
 * the stall sweep's explanation, which for this cause is false in its one
 * actionable clause.
 */
describe('an exec frame the queue refused', () => {
  const discardable = async (svc: ApprovalService) => {
    const { id } = await req(svc, { kind: 'channel', target: 'dev' })
    await svc.approve(id, OWNER)
    return id
  }

  it('settles the row as refused, naming the machine and bounding the claim', async () => {
    const { svc, mails, broadcasts, events } = harness()
    const id = await discardable(svc)
    expect((await svc.get({ id }, SELF)).status).toBe('executing')

    await svc.onExecDiscarded(id)

    const w = await svc.get({ id }, SELF)
    expect(w.status).toBe('failed')
    expect(w.resultText).toContain('ludovico')
    expect(w.resultText).toMatch(/access configuration changed/i)
    expect(w.resultText).toMatch(/could not confirm/i)
    // BOUNDED TO THIS DISPATCH, not to global non-execution — what the server
    // knows is that it declined to send this frame.
    expect(w.resultText).toMatch(/this dispatch was not delivered/i)
    expect(mails.at(-1)).toContain('REFUSED')
    expect(events.at(-1)?.kind).toBe('issue.approval_failed')
    expect(broadcasts.at(-1)).toMatchObject({ type: 'approvalsChanged' })
  })

  it('never claims the caller lost access, because a refusal does not prove that', async () => {
    // PDM-414. The queue refuses on an ACCESS-CONFIGURATION CHANGE, which also
    // fires on a grant ADDITION or an edit to a different grantee. Saying the
    // machine "changed hands", that the operation is "no longer yours", or
    // "ask again from a machine you own" would each be FALSE in those cases and
    // would send the reader to look for a loss that never happened.
    const { svc } = harness()
    const id = await discardable(svc)

    await svc.onExecDiscarded(id)

    const w = await svc.get({ id }, SELF)
    expect(w.resultText).not.toMatch(/changed hands/i)
    expect(w.resultText).not.toMatch(/no longer yours/i)
    expect(w.resultText).not.toMatch(/machine you (currently )?own/i)
    expect(w.resultText).not.toMatch(/did NOT run/i)
  })

  it('does NOT blame the daemon’s version, which is the stall sweep’s cause and not this one', async () => {
    // THE WHOLE POINT OF A SEPARATE SETTLEMENT. The stall text says the machine's
    // podium "predates this operation ... check its version, update it" and that
    // the op "may or may not have run". For a frame the server refused to send,
    // every one of those is wrong: the version is fine, and the op certainly did
    // not run. Left to the sweep, the operator inspects a healthy version and is
    // told the outcome is unknown when the server knows exactly what happened.
    const { svc } = await Promise.resolve(harness())
    const id = await discardable(svc)

    await svc.onExecDiscarded(id)

    const w = await svc.get({ id }, SELF)
    expect(w.resultText).not.toMatch(/predates this operation/i)
    expect(w.resultText).not.toMatch(/check its version/i)
    expect(w.resultText).not.toMatch(/may or may not have run/i)
  })

  it('is idempotent, and a row that already settled is left exactly as it was', async () => {
    const { svc } = harness()
    const id = await discardable(svc)

    await svc.onExecDiscarded(id)
    const first = await svc.get({ id }, SELF)
    await svc.onExecDiscarded(id)
    const second = await svc.get({ id }, SELF)

    expect(second.status).toBe('failed')
    expect(second.resultText).toBe(first.resultText)
  })

  it('takes the row out of the stall sweep’s reach, so it cannot be re-explained later', async () => {
    // The sweep reads `listExecuting`. A settled row is no longer in it, so the
    // deadline can never overwrite this reason with the version one.
    const { svc } = harness()
    const id = await discardable(svc)
    await svc.onExecDiscarded(id)

    await svc.sweepStalledExecutions(1_000_000)
    await svc.sweepStalledExecutions(1_000_000 + APPROVAL_EXEC_DEADLINE_MS)

    const w = await svc.get({ id }, SELF)
    expect(w.status).toBe('failed')
    expect(w.resultText).toMatch(/access configuration changed/i)
  })

  it('absorbs a settlement failure instead of leaking a rejected promise', async () => {
    // THE SINK IS SYNCHRONOUS AND THE SETTLEMENT IS NOT (PDM-414). MachinesService
    // wraps each sink call in try/catch so a listener cannot break the flush, but
    // that catch returns before this promise settles and cannot see its rejection.
    // Voided without a catch, a store failure becomes an unhandled rejection: the
    // discard silently does not settle, nothing fails and nothing logs.
    let sink: ((d: { kind: 'control' | 'input'; message?: ControlMessage }) => void) | undefined
    const svc = new ApprovalService({
      store: {
        get: async () => {
          throw new Error('the store is unavailable')
        },
      },
      onDeliveryDiscarded: (registered: (d: { kind: 'control' | 'input'; message?: ControlMessage }) => void) => {
        sink = registered
        return () => {}
      },
      now: () => '2026-07-13T00:00:00.000Z',
      toMachine: () => {},
      clients: () => [],
      sessionOwner: async () => OWNER,
      mayDispatchTo: async () => true,
      sessionIssueId: () => asIssueId('iss_1'),
      issueInfo: () => null,
      machineName: async () => 'ludovico',
      logEvent: () => {},
      notifyIssue: async () => {},
    } as unknown as ConstructorParameters<typeof ApprovalService>[0])

    expect(sink).toBeTypeOf('function')
    // The synchronous half must not throw into the flush...
    expect(() =>
      sink?.({
        kind: 'control',
        message: { type: 'approvalExecRequest', requestId: 'r1', op: { kind: 'update' } } as ControlMessage,
      }),
    ).not.toThrow()
    // ...and the asynchronous half must RESOLVE rather than reject, which is what
    // keeps a failed settlement out of the unhandled-rejection channel.
    await expect(svc.settleDiscarded('r1')).resolves.toBeUndefined()
  })

  it('does nothing for an unknown request id', async () => {
    const { svc, broadcasts } = harness()
    const before = broadcasts.length
    await svc.onExecDiscarded('no-such-request')
    expect(broadcasts).toHaveLength(before)
  })
})
