/**
 * THE BIND CARRIES WHAT THE DRIVER CAN CHANGE (POD-3087).
 *
 * A client decides whether to offer a model control from `configureFields`, and
 * the daemon is the only party that can answer: it holds the live driver. If the
 * field is missing from a bind, every consumer downstream reads `undefined`,
 * which by contract means "we have not been told" — so the control is hidden on
 * a session that could take it, and nothing anywhere errors.
 *
 * The assertion is against the DRIVER's own declaration rather than a literal
 * field list, for the same reason `configure-catalog.test.ts` is: a test that
 * restated the answer would drift in lockstep with the thing it is checking.
 */

import { readFileSync } from 'node:fs'
import {
  type AgentSessionHandle,
  claudeSdkCapabilities,
  configureFieldsForDriver,
} from '@podium/agent-runtime'
import type { AgentRuntimeState, SessionId } from '@podium/model'
import type { DaemonMessage } from '@podium/protocol/daemon'
import { describe, expect, it } from 'vitest'
import { emitClaudeBinding } from './claude-sdk-driver'

type BindFrame = Extract<DaemonMessage, { type: 'bind' }>

const handleOn = (driver: string): AgentSessionHandle =>
  ({
    binding: { sessionId: 'session-bind' as SessionId, driver, workdir: '/w' },
    state: async (): Promise<AgentRuntimeState> => ({
      phase: 'idle',
      since: '2026-08-29T00:00:00.000Z',
      nativeSubagentCount: 0,
    }),
  }) as unknown as AgentSessionHandle

async function bindFrameFor(driver: string): Promise<BindFrame> {
  const sent: DaemonMessage[] = []
  await emitClaudeBinding(
    (message) => sent.push(message),
    {
      sessionId: 'session-bind' as SessionId,
      cwd: '/w',
      agentKind: 'claude-code',
      // No record and no geometry: this suite is about the capability fields,
      // and since POD-3290 a bind's grid can only come from an applied-size
      // record — there is no geometry to hand in here.
    },
    handleOn(driver),
  )
  const bind = sent.find((m): m is BindFrame => m.type === 'bind')
  expect(bind, 'the driver emitted no bind at all').toBeDefined()
  return bind as BindFrame
}

describe('bind reports driver capabilities', () => {
  it.each([
    'opencode',
    'codex',
    'grok',
    'claude-sdk',
  ] as const)('publishes attachKinds from the bound %s driver', (name) => {
    const source = readFileSync(new URL(`./${name}-driver.ts`, import.meta.url), 'utf8')
    expect(source).toContain('attachKinds: [...attachKindsForDriver(handle.binding.driver)]')
  })

  it('carries exactly what the bound driver declares', async () => {
    const bind = await bindFrameFor('claude-sdk')

    const declared = claudeSdkCapabilities().configure
    expect(declared.supported).toBe(true)
    expect(bind.configureFields).toEqual(
      declared.supported ? [...declared.value.fields] : undefined,
    )
    // …and it really is a non-empty answer, or the assertion above would hold
    // just as well for a driver that reported nothing.
    expect(bind.configureFields?.length).toBeGreaterThan(0)
  })

  it('is keyed on the BOUND driver, not on the harness or the family', async () => {
    /**
     * The same emitter, a different bound driver, a different answer. This is
     * the property that makes the field worth putting on the wire: a client
     * cannot compute it from `agentKind` (unchanged between these two calls) or
     * from the driver family (`grok-acp` is `server`, like opencode, and can
     * change no model).
     */
    const bind = await bindFrameFor('grok-acp')

    expect(bind.configureFields).toEqual([...configureFieldsForDriver('grok-acp')])
    expect(bind.configureFields).not.toContain('model')
  })

  it('reports an EMPTY set for a terminal driver rather than omitting the field', async () => {
    const bind = await bindFrameFor('claude-pty')

    /**
     * EMPTY, NOT ABSENT, and the difference is the whole contract. Absent means
     * "no daemon told us" and a client must keep its previous behaviour; empty
     * means "the daemon answered: nothing". Omitting the field here would make a
     * TUI indistinguishable from an un-upgraded daemon, and the control would be
     * hidden for the wrong reason — which is right by accident today and wrong
     * the moment anything else keys on the distinction.
     */
    expect(bind.configureFields).toEqual([])
    expect(bind.configureFields).toBeDefined()
  })
})
