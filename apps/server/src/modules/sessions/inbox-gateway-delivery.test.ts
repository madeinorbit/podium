/**
 * POD-4427 — THE SERVER NEVER TYPES AT A HARNESS.
 *
 * Every send, interrupt, answer and initial prompt for an agent session goes
 * through the runtime gateway (the `contractDeliver` / `contractAnswer` /
 * `contractInterrupt` deps, wired to `SessionRuntimeGateway` in production).
 * The legacy delivery machine — typing bytes into the PTY, polling readiness,
 * polling the transcript, retrying with backoff — is deleted. These tests pin
 * the surviving boundary:
 *
 *   - the guard: for a harness session, sendText/answer/interruptTurn never
 *     call `daemon.sendInput` and reach the gateway exactly once;
 *   - migration: rows the previous release left behind (queued messages with a
 *     spent attempt budget, pending native-menu answers) drain once through
 *     the gateway, and rows with no daemon bound stay queued until the bind.
 *
 * The fixture carries the legacy-only supplements (`bumpAttempts`,
 * `resetAttempts`, the harness capability deps) so this file also runs
 * against the base commit — where every test below FAILS on the legacy typing
 * path (shown red before the deletion; see VERIFY-4427.md).
 */

import {
  actorAgent,
  asAgentIdentityId,
  asMutationId,
  asSessionId,
  asUserId,
  type SessionId,
} from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import type { TurnReceipt } from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import {
  harnessComposerReadiness,
  harnessDisplayName,
  harnessInterrupt,
  harnessNeedsSubmitVerification,
  harnessUsesRawFirstTurn,
} from '../../harness-manifest'
import { testClientPrincipal } from '../../test-support/client-principal'
import type { ClientConn } from '../../gateway/client-registry'
import {
  type InboxPrincipalReference,
  type QueuedInboxMessage,
  SessionInbox,
} from './inbox'
import type { Session } from './session'

const SID = asSessionId('session-target')
const ALICE = asUserId('user:alice')
const AGENT = asSessionId('session-agent')

const agentPrincipal = (): InboxPrincipalReference => ({
  kind: 'agent',
  principalRef: AGENT,
  delegation: asDelegationRef(AGENT),
  attribution: {
    actor: actorAgent(asAgentIdentityId(AGENT)),
    onBehalfOf: ALICE,
  },
})

const acceptedReceipt = (): TurnReceipt => ({
  outcome: 'accepted',
  turnEpoch: 1,
  deliveredAs: 'when-ready',
  provenBy: 'protocol-ack',
  at: new Date().toISOString(),
})

function harness(
  options: {
    status?: string
    phase?: string
    agentKind?: 'claude-code' | 'shell'
    /** Switch the fake gateway between receipts mid-test (migration (c)). */
    deliver?: (input: { turnId: string; deliveryRecovery: boolean }) => TurnReceipt
  } = {},
) {
  const rows: Array<QueuedInboxMessage & { sessionId: SessionId; queuedAt: number }> = []
  const sent: unknown[] = []
  const contractSends: unknown[] = []
  const contractAnswers: unknown[] = []
  const contractInterrupts: SessionId[] = []
  const promptFailed: unknown[] = []
  const rejected: unknown[] = []
  const applied: unknown[] = []
  let draft: string | undefined
  const session = {
    sessionId: SID,
    machineId: 'machine-1',
    archived: false,
    status: options.status ?? 'live',
    agentKind: options.agentKind ?? 'claude-code',
    resume: { kind: 'claude-code', value: 'resume-1' },
    hasBoundDriver: false,
    driverId: undefined,
    queuedMessageCount: 0,
    transcriptAvailable: false,
    agentState: {
      phase: options.phase ?? 'idle',
      since: '2026-08-15T00:00:00.000Z',
    },
    terminal: {
      controllerId: 'client-1',
      lastOutputAtMs: 0,
      transcriptItems: () => [],
      recordInputActivity: vi.fn(),
      noteInputAttribution: vi.fn(),
    },
  } as unknown as Session
  const deliver = (input: { turnId: string; deliveryRecovery: boolean }) =>
    options.deliver ? options.deliver(input) : acceptedReceipt()
  const deps = {
    getSession: (id: SessionId) => (id === SID ? session : undefined),
    queue: {
      enqueue: async (row: {
        id: string
        sessionId: SessionId
        text: string
        inputOrigin: QueuedInboxMessage['inputOrigin']
        queuedAt: number
        principal: InboxPrincipalReference
        sourceMessageId: string | null
      }) => {
        if (rows.some((existing) => existing.id === row.id)) return false
        rows.push({ ...row, attempts: 0 })
        return true
      },
      list: async (id: SessionId) => rows.filter((row) => row.sessionId === id),
      reserveDelivery: async (id: string) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) {
          row.attempts = Math.max(row.attempts, 1)
          row.deliveryOwner = 'daemon'
        }
      },
      releaseDelivery: async (id: string, attempts: number) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row?.deliveryOwner === 'daemon') {
          row.attempts = attempts
          row.deliveryOwner = null
        }
      },
      // Legacy-only supplements: ignored by the gateway-only inbox, required
      // to run this file against the base commit for the red demonstration.
      bumpAttempts: async (id: string) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) row.attempts += 1
      },
      resetAttempts: async (id: string) => {
        const row = rows.find((candidate) => candidate.id === id)
        if (row) row.attempts = 0
      },
      delete: async (id: string) => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      },
      sessionsWithPending: async () => [...new Set(rows.map((row) => row.sessionId))],
    },
    daemon: { sendInput: (_machineId: unknown, message: unknown) => sent.push(message) },
    authorization: {
      authorizeAtDrain: async () => ({ ok: true }) as const,
      applied: async (input: unknown) => {
        applied.push(input)
      },
      rejected: async (input: unknown) => {
        rejected.push(input)
      },
    },
    attention: {
      stateChanged: vi.fn(),
      answered: vi.fn(),
      promptFailed: async (input: unknown) => {
        promptFailed.push(input)
      },
    },
    now: () => Date.now(),
    persist: vi.fn(async () => {}),
    write: vi.fn(async (target: Session, mutate: (draft: never) => void) => {
      mutate(target as never)
    }),
    draft: (target: Session) => ({ ...target }) as never,
    persistDraft: vi.fn(async () => {}),
    broadcast: vi.fn(),
    harnessInterrupt,
    harnessName: harnessDisplayName,
    // Legacy-only supplements: see the queue comment above.
    needsSubmitVerification: harnessNeedsSubmitVerification,
    usesRawFirstTurn: harnessUsesRawFirstTurn,
    composerReadiness: harnessComposerReadiness,
    prepareSend: vi.fn(async () => {}),
    ownerOf: async () => ALICE,
    setSessionDraft: vi.fn(async ({ text }: { sessionId: SessionId; text: string }) => {
      draft = text || undefined
    }),
    draftText: () => draft,
    resurrect: vi.fn(),
    contractAnswer: async (input: unknown) => {
      contractAnswers.push(input)
      return { ok: true }
    },
    contractCancel: vi.fn(async () => ({ ok: true as const })),
    contractDeliver: async (input: { turnId: string; deliveryRecovery: boolean }) => {
      contractSends.push(input)
      return deliver(input)
    },
    contractInterrupt: async (sessionId: SessionId) => {
      contractInterrupts.push(sessionId)
      return { ok: true as const }
    },
  }
  const inbox = new SessionInbox(deps)
  return {
    inbox,
    session,
    rows,
    sent,
    contractSends,
    contractAnswers,
    contractInterrupts,
    promptFailed,
    rejected,
    applied,
    getDraft: () => draft,
  }
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe('the server never types at a harness (POD-4427)', () => {
  it('sendText queues through the gateway without touching PTY bytes', async () => {
    const h = harness()

    expect(
      await h.inbox.sendText({ sessionId: SID, text: 'hello agent', principal: agentPrincipal() }),
    ).toEqual({ ok: true, queued: true })

    await flush()
    // The daemon gateway saw ZERO raw input frames...
    expect(h.sent).toEqual([])
    // ...and the gateway send exactly once.
    expect(h.contractSends).toHaveLength(1)
    expect(h.contractSends[0]).toMatchObject({ sessionId: SID, text: 'hello agent' })
    expect(h.rows).toHaveLength(1)
  })

  it('answerAskUserQuestion answers through the gateway without touching PTY bytes', async () => {
    const h = harness()

    expect(
      await h.inbox.answerAskUserQuestion({
        sessionId: SID,
        interactionId: 'ixn_menu',
        choices: [{ optionIndices: [2] }],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true })

    expect(h.sent).toEqual([])
    expect(h.contractAnswers).toHaveLength(1)
    expect(h.contractAnswers[0]).toMatchObject({ sessionId: SID, interactionId: 'ixn_menu' })
  })

  it('interruptTurn interrupts through the gateway without touching PTY bytes', async () => {
    const h = harness({ phase: 'working' })

    expect(await h.inbox.interruptTurn({ sessionId: SID, principal: agentPrincipal() })).toEqual({
      ok: true,
      requested: 'protocol',
    })

    expect(h.sent).toEqual([])
    expect(h.contractInterrupts).toEqual([SID])
  })

  it('a controller keystroke still reaches the PTY (the raw transport shells keep)', async () => {
    const h = harness()
    const principal = testClientPrincipal('browser-1')
    const client = { id: 'client-1' } as ClientConn
    const handleInputBytes = vi.fn()
    ;(h.session.terminal as unknown as { handleInputBytes: unknown }).handleInputBytes =
      handleInputBytes

    await h.inbox.handleControllerInput(
      principal,
      client,
      SID,
      Buffer.from('x').toString('base64'),
    )

    expect(handleInputBytes).toHaveBeenCalledOnce()
    expect(h.contractSends).toEqual([])
  })
})

describe('previous-release rows drain once through the gateway (POD-4427 migration)', () => {
  it('(a) a queued row with a spent attempt budget forwards exactly once and never retries', async () => {
    const h = harness()
    // Left by the old loop: typed three times, never confirmed.
    h.rows.push({
      id: 'old-row',
      sessionId: SID,
      queuedAt: 1,
      text: 'already typed three times',
      attempts: 3,
      inputOrigin: 'controller',
      principal: agentPrincipal(),
      sourceMessageId: null,
    })
    h.session.queuedMessageCount = 1

    await h.inbox.drain(SID)
    await flush()

    expect(h.sent).toEqual([])
    expect(h.contractSends).toHaveLength(1)
    expect(h.contractSends[0]).toMatchObject({ turnId: 'old-row', deliveryRecovery: true })
    // The budget is evidence of a possible prior write, not a retry schedule:
    // untouched, and no second forward on re-arm.
    expect(h.rows[0]).toMatchObject({ attempts: 3 })
    await h.inbox.drain(SID)
    await flush()
    expect(h.contractSends).toHaveLength(1)
    expect(h.rows).toHaveLength(1)
  })

  it('an UNVERIFIED row the 60 s sweep re-forwards goes out as recovery, never as a fresh send (POD-4616)', async () => {
    // The layers page: an `unverified` durable row re-forwarded by the sweep
    // is CONFIRMED on the daemon, never retyped. (a) above covers a row the
    // previous release left with a spent budget; this is the current
    // release's own row — first forwarded fresh, its receipt unverified.
    // The daemon half (recovery → settle failed, nothing typed) is pinned in
    // apps/daemon/src/session/layer-claims.test.ts.
    let receipt: TurnReceipt = {
      outcome: 'unverified',
      deliveredAs: 'when-ready',
      verificationWindowMs: 0,
      at: new Date().toISOString(),
    }
    const h = harness({ deliver: () => receipt })

    expect(
      await h.inbox.queueText({
        sessionId: SID,
        text: 'typed once, never confirmed',
        mutationId: asMutationId('unverified-row'),
        sourceMessageId: 'msg_unverified',
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true, queued: true })
    await flush()

    expect(h.contractSends).toEqual([
      expect.objectContaining({ turnId: 'unverified-row', deliveryRecovery: false }),
    ])
    expect(h.rows).toEqual([expect.objectContaining({ id: 'unverified-row', deliveryOwner: 'daemon' })])
    expect(h.promptFailed).toHaveLength(1)

    // The sweep tick (relay.ts, QUEUED_INPUT_SWEEP_MS). Whatever the daemon
    // answers now, what it was ASKED is to confirm, not to type.
    receipt = acceptedReceipt()
    await h.inbox.sweepQueuedInputs()
    await flush()

    expect(h.contractSends).toHaveLength(2)
    expect(h.contractSends[1]).toMatchObject({ turnId: 'unverified-row', deliveryRecovery: true })
    expect(h.sent).toEqual([])
  })

  it('(b) a pending native-menu answer goes via gateway.answer, never keystrokes', async () => {
    const h = harness()

    expect(
      await h.inbox.answerAskUserQuestion({
        sessionId: SID,
        interactionId: 'ixn_native_menu',
        choices: [
          { optionIndices: [2, 3], multiSelect: true },
          { freeText: 'custom', otherIndex: 4, previewLayout: true },
        ],
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true })

    expect(h.sent).toEqual([])
    expect(h.contractAnswers).toHaveLength(1)
    expect(h.contractAnswers[0]).toMatchObject({
      sessionId: SID,
      interactionId: 'ixn_native_menu',
    })
  })

  it('(c) rows with no daemon bound stay queued and drain on bind', async () => {
    let bound = false
    const recoveryFailures: string[] = []
    const h = harness({
      // The fake models the daemon's two arms honestly (delivery-queue.ts): a
      // RECOVERY forward is confirm-or-fail and never types, so it settles
      // `failed`; only a fresh forward is typed. A fake that accepted
      // regardless of the flag is what hid POD-4622.
      deliver: (input) => {
        if (!bound) return { outcome: 'refused', refusal: { reason: 'not_running', detail: 'no machine' } }
        if (input.deliveryRecovery) recoveryFailures.push(input.turnId)
        return acceptedReceipt()
      },
    })

    expect(
      await h.inbox.queueText({
        sessionId: SID,
        text: 'waiting for a driver',
        mutationId: asMutationId('unbound-row'),
        sourceMessageId: 'msg_unbound',
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true, queued: true })
    await flush()

    // One attempt at the gateway, refused: the row stays, visibly queued, with
    // a single failure notice — and nothing typed.
    expect(h.sent).toEqual([])
    expect(h.contractSends).toHaveLength(1)
    expect(h.rows).toHaveLength(1)
    expect(h.applied).toEqual([])
    expect(h.promptFailed).toHaveLength(1)
    // `not_running` proves nothing was typed, so the refusal leaves no
    // custody behind: the row is exactly as fresh as before the forward.
    expect(h.rows[0]).toMatchObject({ attempts: 0 })
    expect(h.rows[0]?.deliveryOwner ?? null).toBeNull()

    // The bind drains it — as a FRESH send, not a recovery the daemon fails.
    bound = true
    h.inbox.markSessionBound(SID)
    await h.inbox.drain(SID, { justBound: true })
    await flush()

    expect(h.sent).toEqual([])
    expect(h.contractSends).toHaveLength(2)
    expect(h.contractSends[1]).toMatchObject({ turnId: 'unbound-row', deliveryRecovery: false })
    expect(recoveryFailures).toEqual([])
    await h.inbox.deliveryOutcome(SID, { rowId: 'unbound-row', outcome: 'delivered' })
    expect(h.rows).toEqual([])
    expect(h.applied).toEqual([{ sourceMessageId: 'msg_unbound', sessionId: SID }])
  })

  it('a refusal releases only the reservation THIS forward took: an earlier custody stays recovery (POD-4622)', async () => {
    // The row was already forwarded once (reserved, maybe typed, never
    // confirmed). A later `not_running` proves the SECOND attempt typed
    // nothing — it says nothing about the first, so the row stays recovery.
    let bound = false
    const h = harness({
      deliver: () => bound
        ? acceptedReceipt()
        : { outcome: 'refused', refusal: { reason: 'not_running', detail: 'session is not behind the runtime contract' } },
    })
    h.rows.push({
      id: 'held-row',
      sessionId: SID,
      queuedAt: 1,
      text: 'forwarded before, never confirmed',
      attempts: 1,
      deliveryOwner: 'daemon',
      inputOrigin: 'controller',
      principal: agentPrincipal(),
      sourceMessageId: null,
    })
    h.session.queuedMessageCount = 1

    await h.inbox.drain(SID)
    await flush()
    expect(h.contractSends).toEqual([expect.objectContaining({ turnId: 'held-row', deliveryRecovery: true })])
    expect(h.rows[0]).toMatchObject({ attempts: 1, deliveryOwner: 'daemon' })

    bound = true
    h.inbox.markSessionBound(SID)
    await h.inbox.drain(SID, { justBound: true })
    await flush()
    expect(h.contractSends).toHaveLength(2)
    expect(h.contractSends[1]).toMatchObject({ turnId: 'held-row', deliveryRecovery: true })
  })

  it('a refusal reason not audited as pre-write keeps the reservation (POD-4622)', async () => {
    // Only reasons whose every producer on this path answers BEFORE any write
    // release custody. Anything else keeps confirm-or-fail: a lost message is
    // visible and retryable, a duplicate turn is not undoable.
    let bound = false
    const h = harness({
      deliver: () => bound ? acceptedReceipt() : { outcome: 'refused', refusal: { reason: 'busy' } },
    })
    expect(
      await h.inbox.queueText({
        sessionId: SID,
        text: 'refused busy',
        mutationId: asMutationId('busy-row'),
        sourceMessageId: 'msg_busy',
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true, queued: true })
    await flush()
    expect(h.rows[0]).toMatchObject({ attempts: 1, deliveryOwner: 'daemon' })

    bound = true
    h.inbox.markSessionBound(SID)
    await h.inbox.drain(SID, { justBound: true })
    await flush()
    expect(h.contractSends[1]).toMatchObject({ turnId: 'busy-row', deliveryRecovery: true })
  })

  it('shell rows settle onto the raw transport in FIFO order', async () => {
    const shell = harness({ agentKind: 'shell' })

    expect(
      await shell.inbox.sendText({ sessionId: SID, text: 'first', principal: agentPrincipal() }),
    ).toEqual({ ok: true })
    expect(
      await shell.inbox.sendText({ sessionId: SID, text: 'second', principal: agentPrincipal() }),
    ).toEqual({ ok: true })

    const texts = shell.sent.map((entry) =>
      Buffer.from((entry as { bytes: Uint8Array }).bytes).toString(),
    )
    expect(texts.filter((text) => text !== '\r')).toHaveLength(2)
    expect(shell.contractSends).toEqual([])
    expect(shell.rows).toEqual([])
  })

  it('a shell send is raw transport even while the shell is busy — never queued behind readiness', async () => {
    // The deleted loop queued a computing shell's send and typed it later
    // behind readiness waits. A shell has no harness to be ready: bytes go
    // out, both frames, synchronously — the same as a controller keystroke.
    const shell = harness({ agentKind: 'shell', phase: 'working' })

    expect(
      await shell.inbox.sendText({ sessionId: SID, text: 'busy shell', principal: agentPrincipal() }),
    ).toEqual({ ok: true })

    expect(shell.sent).toHaveLength(2)
    expect(shell.rows).toEqual([])
  })

  it('a queued shell row settles on send with no transcript wait', async () => {
    // The deleted loop held every shell row for a transcript turn that shells
    // never reliably produce. Bytes onto the watched PTY are the delivery.
    const shell = harness({ agentKind: 'shell' })

    expect(
      await shell.inbox.queueText({
        sessionId: SID,
        text: 'shell row',
        mutationId: asMutationId('shell-settle'),
        sourceMessageId: 'msg_shell_settle',
        principal: agentPrincipal(),
      }),
    ).toEqual({ ok: true, queued: true })

    expect(shell.sent).toHaveLength(2)
    expect(shell.rows).toEqual([])
    expect(shell.applied).toEqual([{ sourceMessageId: 'msg_shell_settle', sessionId: SID }])
  })
})
