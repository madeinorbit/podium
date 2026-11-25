import { asMachineId, asSessionId } from '@podium/model'
import type { ControlMessage } from '@podium/protocol/daemon'
import { TRPCError } from '@trpc/server'
import { describe, expect, it } from 'vitest'
import type { Capability } from '../../issue-authz'
import { captureLogs } from '../../test-support/capture-logs'
import { AgentRelayGate } from './relay-gate'
import { IssueRefusal } from './service/refusal'

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

function gateFor(
  dispatch: () => Promise<unknown>,
  diagnostics?: boolean,
): {
  gate: AgentRelayGate
  sent: ControlMessage[]
} {
  const sent: ControlMessage[] = []
  const gate = new AgentRelayGate({
    dispatch,
    capabilityForSession: () => ({}) as Capability,
    toMachine: (_machine, msg) => sent.push(msg),
    ...(diagnostics === undefined ? {} : { diagnostics }),
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

/** An unexpected failure's answer (POD-7617): the generic sentence and the
 *  reference the gate's log line carries. */
const GENERIC =
  /^The server could not complete this request; the server log has the details \(reference: ([0-9a-f-]{36})\)/

/** The reference an answer names, and the one the gate logged. */
function referencesOf(
  reply: { error?: string },
  logs: ReturnType<typeof captureLogs>,
): { answered: string | undefined; logged: unknown } {
  return {
    answered: GENERIC.exec(reply.error ?? '')?.[1],
    logged: logs.at('warn').find((entry) => entry.msg === 'agent command failed')?.reference,
  }
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
        Promise.reject(
          new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 're-run with --outside-scope to confirm',
            cause: new Error('private policy context'),
          }),
        ),
      )
      await relay(gate)
      const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
      expect(reply.error).toBe('re-run with --outside-scope to confirm')
      expect(
        logs.at('warn').find((entry) => entry.msg === 'agent command failed')?.err,
      ).toMatchObject({
        cause: { message: 'private policy context' },
      })
    } finally {
      logs.restore()
    }
  })

  it('retains diagnostic causes for an internal tRPC failure', async () => {
    const { gate, sent } = gateFor(
      () =>
        Promise.reject(
          new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'command failed',
            cause: wrappedRefusal(),
          }),
        ),
      true,
    )
    await relay(gate)
    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.error).toMatch(GENERIC)
    expect(reply.error).toContain(
      ': TRPCError: command failed ← Failed query: insert into "locks" ← ' +
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

  it('tells a development agent the cause as well as the wrapper, after the reference', async () => {
    const { gate, sent } = gateFor(() => Promise.reject(wrappedRefusal()), true)

    await relay(gate)

    expect(sent).toHaveLength(1)
    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.ok).toBe(false)
    expect(reply.error).toMatch(GENERIC)
    expect(reply.error).toContain(
      ': Failed query: insert into "locks" ← ParallelNestedTransactionError: transaction 4 has an ' +
        'open nested scope (5)',
    )
  })

  it('answers a domain refusal in its own words, without a reference (POD-7617)', async () => {
    const logs = captureLogs()
    try {
      const { gate, sent } = gateFor(
        () => Promise.reject(new IssueRefusal('issues.update is outside your subtree')),
        false,
      )

      await relay(gate)

      const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
      expect(reply.error).toBe('issues.update is outside your subtree')
      const record = logs.at('warn').find((entry) => entry.msg === 'agent command failed')
      expect(record).toBeDefined()
      expect(record).not.toHaveProperty('reference')
    } finally {
      logs.restore()
    }
  })
})

describe('a relayed agent command that fails on a production server (POD-7615, POD-7617)', () => {
  it('tells the agent a reference, not the driver text, and logs the chain under it', async () => {
    const logs = captureLogs()
    try {
      const { gate, sent } = gateFor(() => Promise.reject(wrappedRefusal()), false)

      await relay(gate)

      const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
      expect(reply.error).toMatch(new RegExp(`${GENERIC.source}$`))
      expect(reply.error).not.toMatch(/Failed query|locks|nested scope/)
      const { answered, logged } = referencesOf(reply, logs)
      expect(answered).toBeDefined()
      expect(logged).toBe(answered)
      expect(
        logs.at('warn').find((entry) => entry.msg === 'agent command failed')?.err,
      ).toMatchObject({
        message: 'Failed query: insert into "locks"',
        cause: { name: 'ParallelNestedTransactionError' },
      })
    } finally {
      logs.restore()
    }
  })

  it('gives an internal tRPC failure over a cause the generic answer too', async () => {
    const { gate, sent } = gateFor(
      () =>
        Promise.reject(
          new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed query: insert into "locks"',
            cause: wrappedRefusal(),
          }),
        ),
      false,
    )

    await relay(gate)

    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.error).toMatch(new RegExp(`${GENERIC.source}$`))
  })

  it('keeps an internal error the command wrote itself, with no cause', async () => {
    const { gate, sent } = gateFor(
      () =>
        Promise.reject(
          new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'answer delivery is not wired' }),
        ),
      false,
    )

    await relay(gate)

    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.error).toBe('answer delivery is not wired')
  })

  it('keeps an expected refusal message as it was', async () => {
    const { gate, sent } = gateFor(
      () =>
        Promise.reject(
          new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 're-run with --outside-scope to confirm',
          }),
        ),
      false,
    )

    await relay(gate)

    const reply = sent[0] as Extract<ControlMessage, { type: 'agentRelayResult' }>
    expect(reply.error).toBe('re-run with --outside-scope to confirm')
  })
})
