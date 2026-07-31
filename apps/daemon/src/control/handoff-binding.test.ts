import { asAgentIdentityId, asMachineId, asSessionId, asUserId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol'
import { describe, expect, it } from 'vitest'
import type { DaemonContext } from './context'
import { handoffHandlers } from './handoff'

const transfer = (sessionId: ReturnType<typeof asSessionId>) => ({
  transferId: 'transfer-denied',
  sessionId,
  agentKind: 'codex' as const,
  fromMachineId: asMachineId('source-machine'),
  toMachineId: asMachineId('target-machine'),
  observationGeneration: 2,
  delegation: {
    actor: asAgentIdentityId(sessionId),
    onBehalfOf: asUserId('user:alice'),
    grantedScope: { kind: 'all' as const },
    parentBindingId: null,
  },
})

function refusalContext(sent: DaemonMessage[]): DaemonContext {
  // No home, package, git, or binding service is supplied. If refusal happens
  // after materialization begins, this deliberately incomplete context explodes.
  return {
    machineId: 'target-machine',
    send: (message: DaemonMessage) => sent.push(message),
  } as unknown as DaemonContext
}

describe('handoff ADOPT host refusal', () => {
  it.each([
    ['denied', 'unauthorized', 'handoff refused'],
    ['unreachable', 'unreachable', 'handoff target unreachable'],
  ] as const)('refuses %s before package materialization with a distinct transport reason', async (machineAccess, refusal, error) => {
    const sent: DaemonMessage[] = []
    const sessionId = asSessionId(`import-${machineAccess}`)

    handoffHandlers.handoffImportRequest(refusalContext(sent), {
      type: 'handoffImportRequest',
      requestId: `request-${machineAccess}`,
      sessionId,
      repoPath: '/must-not-be-read',
      worktreeName: 'must-not-be-read',
      binding: {
        transitionId: `adopt:${machineAccess}`,
        machineAccess,
        transfer: transfer(sessionId),
      },
    })
    await Promise.resolve()

    expect(sent).toEqual([
      {
        type: 'handoffImportResult',
        requestId: `request-${machineAccess}`,
        ok: false,
        refusal,
        error,
      },
    ])
  })
})
