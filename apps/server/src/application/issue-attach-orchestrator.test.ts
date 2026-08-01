import { asIssueId, asSessionId, asUserId, type IssueWire } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../command-principal'
import { OPERATOR } from '../issue-authz'
import { IssueAttachOrchestrator, type IssueAttachInput } from './issue-attach-orchestrator'

const RESULT = {
  id: asIssueId('iss_target'),
} as unknown as IssueWire

describe('IssueAttachOrchestrator', () => {
  it('carries one transport principal through one transaction', () => {
    const principal = userCommandPrincipal(asUserId('user:alice'), 'admin')
    const attachSession = vi.fn((_input: IssueAttachInput) => RESULT)
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
      orchestrator.execute(
        { capability: OPERATOR, principal },
        { sessionId: asSessionId('session-1'), targetId: 'iss_target' },
      ),
    ).toBe(RESULT)
    expect(transactionCall).toHaveBeenCalledOnce()
    expect(attachSession).toHaveBeenCalledWith({
      sessionId: asSessionId('session-1'),
      targetId: 'iss_target',
      principal,
    })
    expect(attachSession.mock.calls[0]?.[0].principal).toBe(principal)
  })

  it('fails closed before opening a transaction when transport identity is absent', () => {
    const transactionCall = vi.fn()
    const transact = <T>(work: () => T): T => {
      transactionCall()
      return work()
    }
    const orchestrator = new IssueAttachOrchestrator({
      transact,
      attention: { attachSession: vi.fn(() => RESULT) },
    })

    expect(() =>
      orchestrator.execute(
        { capability: OPERATOR },
        { sessionId: asSessionId('session-1'), targetId: 'iss_target' },
      ),
    ).toThrow('transport-derived')
    expect(transactionCall).not.toHaveBeenCalled()
  })
})
