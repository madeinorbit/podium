import { asMachineId, asSessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { captureLogs } from '../../test-support/capture-logs'
import { AgentRelayGate } from './relay-gate'

/**
 * What the server KNOWS about a failed agent command [POD-3805, POD-3802 §2].
 *
 * The gate caught every failure, replied `{ ok: false, error: err.message }`,
 * and logged nothing at all — so a whole day of failing `podium lock` calls left
 * no server-side trace, and the one line the agent did see was Drizzle's
 * `Failed query: …` wrapper with the executor's refusal dropped from `.cause`.
 */

const machineId = asMachineId('m1')
const sessionId = asSessionId('s1')

function gateFor(dispatch: () => Promise<unknown>): {
  gate: AgentRelayGate
  sent: ControlMessage[]
} {
  const sent: ControlMessage[] = []
  const gate = new AgentRelayGate({
    dispatch,
    capabilityForSession: () => ({}) as Capability,
    toMachine: (_machine, msg) => sent.push(msg),
  })
  return { gate, sent }
}

async function relay(gate: AgentRelayGate): Promise<void> {
  await gate.run(machineId, {
    type: 'agentRelayRequest',
    requestId: 'r1',
    sessionId,
    router: 'issues',
    proc: 'update',
    input: {},
  })
}

/** The POD-3802 error: the wrapper an operator saw, over the cause nobody did. */
function wrappedRefusal(): Error {
  const refusal = new Error('transaction 4 has an open nested scope (5)')
  refusal.name = 'ParallelNestedTransactionError'
  return new Error('Failed query: insert into "locks"', { cause: refusal })
}

describe('a relayed agent command that fails', () => {
  it('preserves an expected refusal message while logging its diagnostic cause', async () => {
    const logs = captureLogs()
    try {
      const { gate, sent } = gateFor(() =>
        Promise.reject(new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 're-run with --outside-scope to confirm',
          cause: new Error('private policy context'),
        })),
      )
      await relay(gate)
      const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
      expect(reply.error).toBe('re-run with --outside-scope to confirm')
      expect(logs.at('warn').find((entry) => entry.msg === 'agent command failed')?.err).toMatchObject({
        cause: { message: 'private policy context' },
      })
    } finally {
      logs.restore()
    }
  })

  it('retains diagnostic causes for an internal tRPC failure', async () => {
    const { gate, sent } = gateFor(() =>
      Promise.reject(new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'command failed',
        cause: wrappedRefusal(),
      })),
    )
    await relay(gate)
    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.error).toBe(
      'TRPCError: command failed ← Failed query: insert into "locks" ← ' +
      'ParallelNestedTransactionError: transaction 4 has an open nested scope (5)',
    )
  })

  it('leaves a server log line naming the command, the session and the whole error', async () => {
    const logs = captureLogs()
    try {
      const { gate } = gateFor(() => Promise.reject(wrappedRefusal()))

      await relay(gate)

      const record = logs.at('warn').find((entry) => entry.msg === 'agent command failed')
      expect(record, 'a failed agent command must not be invisible on the server').toBeDefined()
      expect(record?.router).toBe('issues')
      expect(record?.proc).toBe('update')
      expect(record?.sessionId).toBe(sessionId)
      // The logger serializes `err.cause` recursively; handing it an `err` is
      // the whole fix. A `String(error)` here would stop at the wrapper.
      expect(record?.err).toMatchObject({
        message: 'Failed query: insert into "locks"',
        cause: { name: 'ParallelNestedTransactionError' },
      })
    } finally {
      logs.restore()
    }
  })

  it('tells the agent the cause as well as the wrapper', async () => {
    const { gate, sent } = gateFor(() => Promise.reject(wrappedRefusal()))

    await relay(gate)

    expect(sent).toHaveLength(1)
    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.ok).toBe(false)
    expect(reply.error).toBe(
      'Failed query: insert into "locks" ← ParallelNestedTransactionError: transaction 4 has an ' +
        'open nested scope (5)',
    )
  })

  it('still reads as one sentence when the failure has no cause', async () => {
    const logs = captureLogs()
    try {
      const { gate, sent } = gateFor(() =>
        Promise.reject(new Error('issues.update is outside your subtree')),
      )

      await relay(gate)

      const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
      expect(reply.error).toBe('issues.update is outside your subtree')
      expect(logs.at('warn').some((entry) => entry.msg === 'agent command failed')).toBe(true)
    } finally {
      logs.restore()
    }
  })
})
