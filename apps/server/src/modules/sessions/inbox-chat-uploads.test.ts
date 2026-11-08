/**
 * POD-2148 — A CHAT UPLOAD HELD ON THE SERVER IS STAGED WHEN ITS ROW IS
 * FORWARDED, on every forward, under its own id.
 *
 * The queued row keeps the ref without a path; `forwardContractRows` stages the
 * file on the session's machine before the delivery reservation and hands the
 * daemon the staged ref. A staging failure the machine may recover from keeps
 * the row queued and unreserved; a file the server no longer holds fails the
 * row visibly and the queue moves on.
 */

import { actorUser, asSessionId, asUserId, type SessionId } from '@podium/model'
import { asDelegationRef } from '@podium/protocol'
import type {
  RuntimeAttachmentRef,
  StagedAttachmentRef,
  TurnReceipt,
} from '@podium/protocol/daemon'
import { describe, expect, it, vi } from 'vitest'
import { harnessDisplayName, harnessInterrupt } from '../../harness-manifest'
import { messageTestWriter } from '../../test-support/message-writer'
import {
  chatUploadStageAnswer,
  type InboxPrincipalReference,
  type QueuedInboxMessage,
  SessionInbox,
} from './inbox'
import type { Session } from './session'

const SID = asSessionId('session-uploads')
const ALICE = asUserId('user:alice')
const UPLOAD = '3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b'

const person = (): InboxPrincipalReference => ({
  kind: 'user',
  principalRef: ALICE,
  delegation: asDelegationRef(ALICE),
  attribution: { actor: actorUser(ALICE), onBehalfOf: ALICE },
})

const held: RuntimeAttachmentRef = {
  id: UPLOAD,
  filename: 'shot.png',
  mediaType: 'image/png',
  kind: 'image',
}

const accepted = (): TurnReceipt => ({
  outcome: 'accepted',
  turnEpoch: 1,
  deliveredAs: 'when-ready',
  provenBy: 'protocol-ack',
  at: new Date().toISOString(),
})

type StageAnswer = { ref: StagedAttachmentRef } | { retry: string } | { fail: string }

function harness(stage: (attachment: RuntimeAttachmentRef) => StageAnswer) {
  const rows: Array<QueuedInboxMessage & { sessionId: SessionId }> = []
  const delivered: Array<{
    turnId: string
    attachments?: readonly StagedAttachmentRef[]
    deliveryRecovery?: boolean
  }> = []
  const staged: RuntimeAttachmentRef[] = []
  const rejected: unknown[] = []
  const session = {
    sessionId: SID,
    machineId: 'machine-1',
    issueId: 'iss_1',
    archived: false,
    status: 'live',
    agentKind: 'claude-code',
    resume: { kind: 'claude-code', value: 'resume-1' },
    queuedMessageCount: 0,
    transcriptAvailable: true,
    agentState: { phase: 'idle', since: '2026-10-27T00:00:00.000Z' },
    terminal: { recordInputActivity: vi.fn(), noteInputAttribution: vi.fn() },
  } as unknown as Session
  const deps = {
    getSession: (id: SessionId) => (id === SID ? session : undefined),
    queue: {
      enqueue: async (row: QueuedInboxMessage & { sessionId: SessionId }) => {
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
      releaseDelivery: async () => {},
      delete: async (id: string) => {
        const index = rows.findIndex((row) => row.id === id)
        if (index >= 0) rows.splice(index, 1)
      },
      deleteUnreserved: async () => false,
      requestRetract: async () => {},
      clearRetract: async () => {},
    },
    daemon: { sendInput: vi.fn() },
    authorization: {
      authorizeAtDrain: async () => ({ ok: true }) as const,
      applied: vi.fn(async () => {}),
      rejected: async (input: unknown) => {
        rejected.push(input)
      },
    },
    attention: { stateChanged: vi.fn(), answered: vi.fn(), promptFailed: vi.fn(async () => {}) },
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
    prepareSend: vi.fn(async () => {}),
    ownerOf: async () => ALICE,
    resurrect: vi.fn(),
    contractCancel: vi.fn(async () => ({ ok: true as const })),
    contractDeliver: async (input: (typeof delivered)[number]) => {
      delivered.push(input)
      return accepted()
    },
    stageChatUpload: async ({
      attachment,
    }: {
      sessionId: SessionId
      attachment: RuntimeAttachmentRef
    }) => {
      staged.push(attachment)
      return stage(attachment)
    },
  }
  const inbox = new SessionInbox(deps as never)
  const queue = async (id: string, attachments?: readonly RuntimeAttachmentRef[]) =>
    await inbox.queueText({
      writer: messageTestWriter(),
      sessionId: SID,
      text: id,
      principal: person(),
      sourceMessageId: id,
      ...(attachments ? { attachments } : {}),
    })
  return { inbox, session, rows, delivered, staged, rejected, queue }
}

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

const stagedRef = (attachment: RuntimeAttachmentRef): StagedAttachmentRef => ({
  ...attachment,
  path: `/home/agent/.podium/uploads/${SID}/${attachment.id}.png`,
})

describe('chat uploads are staged at delivery (POD-2148)', () => {
  it('stages a held ref before the forward and never writes the path back onto the row', async () => {
    const h = harness((attachment) => ({ ref: stagedRef(attachment) }))
    await h.queue('msg-1', [held])
    await flush()

    expect(h.staged).toEqual([held])
    expect(h.delivered).toEqual([
      expect.objectContaining({ turnId: 'msg-1', attachments: [stagedRef(held)] }),
    ])
    expect(h.rows[0]?.attachments).toEqual([held])
  })

  it('stages again on a recovery forward, under the same id, to the same path', async () => {
    const h = harness((attachment) => ({ ref: stagedRef(attachment) }))
    await h.queue('msg-1', [held])
    await flush()
    // The daemon restarted (its uploads dir is gone): a new bind re-forwards.
    h.inbox.markSessionBound(SID)
    await h.inbox.drain(SID, { justBound: true })
    await flush()

    expect(h.staged).toEqual([held, held])
    expect(h.delivered).toHaveLength(2)
    expect(h.delivered[1]).toMatchObject({ deliveryRecovery: true, attachments: [stagedRef(held)] })
    expect(h.delivered[1]?.attachments).toEqual(h.delivered[0]?.attachments)
  })

  it('keeps the row queued and unreserved when the machine cannot stage it now', async () => {
    let answer: StageAnswer = { retry: 'not_running' }
    const h = harness((attachment) => ('ref' in answer ? { ref: stagedRef(attachment) } : answer))
    await h.queue('msg-1', [held])
    await flush()

    expect(h.delivered).toEqual([])
    expect(h.rows).toEqual([expect.objectContaining({ id: 'msg-1', attempts: 0 })])
    expect(h.rows[0]?.deliveryOwner).toBeUndefined()

    answer = { ref: stagedRef(held) }
    await h.inbox.drain(SID)
    await flush()
    expect(h.delivered).toEqual([expect.objectContaining({ turnId: 'msg-1' })])
  })

  it('fails a row whose file the server no longer holds, visibly, and delivers the next', async () => {
    const h = harness((attachment) =>
      attachment.id === UPLOAD
        ? { fail: 'shot.png is no longer stored' }
        : { ref: stagedRef(attachment) },
    )
    await h.queue('msg-1', [held])
    await h.queue('msg-2')
    await flush()
    await h.inbox.drain(SID)
    await flush()

    expect(h.rejected).toEqual([
      expect.objectContaining({
        queueId: 'msg-1',
        sourceMessageId: 'msg-1',
        reason: 'shot.png is no longer stored',
      }),
    ])
    expect(h.rows.map((row) => row.id)).toEqual(['msg-2'])
    expect(h.delivered.map((input) => input.turnId)).toEqual(['msg-2'])
  })

  it('passes an already-staged ref through without staging it', async () => {
    const h = harness(() => ({ fail: 'unexpected' }))
    await h.queue('msg-1', [stagedRef(held)])
    await flush()

    expect(h.staged).toEqual([])
    expect(h.delivered).toEqual([
      expect.objectContaining({ turnId: 'msg-1', attachments: [stagedRef(held)] }),
    ])
  })

  it('a driver that refuses files for good fails the row; a refusal it may get over retries', async () => {
    expect(
      chatUploadStageAnswer(held, { reason: 'unsupported', detail: 'no files for this agent' }),
    ).toEqual({
      fail: 'no files for this agent',
    })
    for (const reason of ['not_running', 'staging_failed', 'busy'] as const) {
      expect(chatUploadStageAnswer(held, { reason })).toEqual({ retry: reason })
    }
    expect(
      chatUploadStageAnswer(held, { ...stagedRef(held), id: 'minted-elsewhere' }),
    ).toMatchObject({
      fail: expect.stringContaining('older Podium'),
    })
    expect(chatUploadStageAnswer(held, stagedRef(held))).toEqual({ ref: stagedRef(held) })

    // And the row it fails leaves the queue moving.
    const h = harness((attachment) =>
      chatUploadStageAnswer(attachment, { reason: 'unsupported', detail: 'raw first turn' }),
    )
    await h.queue('msg-1', [held])
    await h.queue('msg-2')
    await flush()
    await h.inbox.drain(SID)
    await flush()
    expect(h.rows.map((row) => row.id)).toEqual(['msg-2'])
    expect(h.delivered.map((input) => input.turnId)).toEqual(['msg-2'])
  })
})
