import { asIssueId, asSessionId, asUserId, type IssueProjection } from '@podium/model'
import { fixtureCommitWriter } from '@podium/sync/testing'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import { OPERATOR } from '../test-support/capabilities'
import { type IssueAttachInput, IssueAttachOrchestrator } from './issue-attach-orchestrator'

const RESULT = {
  id: asIssueId('iss_target'),
} as unknown as IssueProjection

describe('IssueAttachOrchestrator', () => {
  it('carries one transport principal through one transaction', async () => {
    const writer = { ...fixtureCommitWriter(), capture: async () => [] }
    const principal = userCommandPrincipal(asUserId('user:alice'), 'admin')
    const attachSession = vi.fn(async (_writer: unknown, _input: IssueAttachInput) => RESULT)
    const transactionCall = vi.fn()
    const transact = <T>(work: () => T): T => {
      transactionCall()
      return work()
    }
    const orchestrator = new IssueAttachOrchestrator({
      transact,
      attention: { attachSession },
    })

    expect(
      await orchestrator.execute(
        { capability: OPERATOR, principal, writer },
        { sessionId: asSessionId('session-1'), targetId: 'iss_target' },
      ),
    ).toBe(RESULT)
    expect(transactionCall).toHaveBeenCalledOnce()
    // The attach commits on the command's own writer.
    expect(attachSession).toHaveBeenCalledWith(writer, {
      sessionId: asSessionId('session-1'),
      targetId: 'iss_target',
      principal,
    })
    expect(attachSession.mock.calls[0]?.[1].principal).toBe(principal)
  })

  it('fails closed before opening a transaction when transport identity is absent', async () => {
    const transactionCall = vi.fn()
    const transact = <T>(work: () => T): T => {
      transactionCall()
      return work()
    }
    const orchestrator = new IssueAttachOrchestrator({
      transact,
      attention: { attachSession: vi.fn(async () => RESULT) },
    })

    await expect(
      orchestrator.execute(
        { capability: OPERATOR },
        { sessionId: asSessionId('session-1'), targetId: 'iss_target' },
      ),
    ).rejects.toThrow('transport-derived')
    expect(transactionCall).not.toHaveBeenCalled()
  })

  it('refuses a caller with no command writer: an attach is never a direct write', async () => {
    const attachSession = vi.fn(async () => RESULT)
    const orchestrator = new IssueAttachOrchestrator({
      transact: async (work) => await work(),
      attention: { attachSession },
    })
    await expect(
      orchestrator.execute(
        { capability: OPERATOR, principal: userCommandPrincipal(asUserId('user:alice'), 'admin') },
        { sessionId: asSessionId('session-1'), targetId: 'iss_target' },
      ),
    ).rejects.toThrow('no writer outside a command')
    expect(attachSession).not.toHaveBeenCalled()
  })
})
