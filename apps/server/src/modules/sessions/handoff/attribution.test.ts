/**
 * ATTRIBUTION — the pair, and the receipt that records it (POD-1399).
 *
 * The property under test is that ONE derivation answers for both stamps: what
 * goes into the bundle manifest and what goes into the durable event are the
 * same actor and the same human, read from the transport capability. A test per
 * consumer would not catch the failure that matters — the two agreeing with each
 * other while both disagree with the caller — so every case here asserts the
 * value against the PRINCIPAL it was resolved from.
 */

import type { UserId } from '@podium/model'
import { asMachineId, asSessionId, asUserId, FIRST_ADMIN_USER_ID } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { userCommandPrincipal } from '../../../command-principal'
import { Session } from '../session'
import { exportedIdentity, recordHandoff } from './attribution'
import type { HandoffCaller } from './ports'

const SOURCE = asMachineId('m-source')
const TARGET = asMachineId('m-target')
const HUMAN: UserId = asUserId(FIRST_ADMIN_USER_ID)

const userCaller = (): HandoffCaller => {
  const principal = userCommandPrincipal(HUMAN, 'admin')
  return { capability: principal.capability, principal }
}

const agentCaller = (): HandoffCaller => {
  const base = userCommandPrincipal(HUMAN, 'admin')
  return {
    capability: base.capability,
    principal: {
      kind: 'agent',
      agentSessionId: asSessionId('agent-1'),
      onBehalfOf: HUMAN,
      capability: base.capability,
      chain: [asSessionId('agent-1')],
    },
  }
}

function makeSession(issueId?: string): Session {
  return new Session({
    sessionId: asSessionId('s1'),
    durableLabel: 'podium-s1',
    agentKind: 'claude-code',
    cwd: '/repo/wt/feature',
    title: 'feature',
    origin: { kind: 'spawn' },
    createdAt: '2026-08-02T00:00:00.000Z',
    geometry: { cols: 80, rows: 24 },
    machineId: SOURCE,
    ...(issueId ? { issueId: issueId as never } : {}),
    toDaemon: vi.fn(),
  })
}

describe('exportedIdentity: read off the capability, never off the payload', () => {
  it('a person acting directly is both the actor and the human', () => {
    const identity = exportedIdentity(userCaller())
    expect(identity.exportedBy.actor.kind).toBe('user')
    expect(identity.exportedBy.onBehalfOf).toBe(HUMAN)
    expect(identity.owner).toBe(HUMAN)
  })

  it('an agent is the ACTOR while its human is the on-behalf-of and the owner', () => {
    const identity = exportedIdentity(agentCaller())
    expect(identity.exportedBy.actor.kind).toBe('agent')
    // Ownership does not move to the agent: the bundle's owning human is the
    // delegating human, carried across unchanged (ADR 9 D5 A4).
    expect(identity.exportedBy.onBehalfOf).toBe(HUMAN)
    expect(identity.owner).toBe(HUMAN)
  })

  it('a system job cannot export a personal bundle — it has no human to own one', () => {
    expect(() =>
      exportedIdentity({
        capability: userCaller().capability,
        principal: { kind: 'system', job: 'steward' },
      }),
    ).toThrow('system principal cannot export a personal handoff bundle')
  })
})

describe('recordHandoff: the durable receipt', () => {
  const capture = () => {
    const events: { ts: string; kind: string; subject: string; payload: unknown }[] = []
    return {
      events,
      ports: { recordEvent: (event: (typeof events)[number]) => events.push(event) },
    }
  }

  it('names the machine pair, the actor and the human it acted for', () => {
    const { events, ports } = capture()
    recordHandoff(ports, makeSession(), SOURCE, TARGET, agentCaller())
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event?.kind).toBe('session.handoff')
    expect(event?.subject).toBe('s1')
    expect(event?.payload).toMatchObject({
      sessionId: 's1',
      fromMachineId: SOURCE,
      toMachineId: TARGET,
      actorKind: 'agent',
      actor: 'agent-1',
      onBehalfOf: HUMAN,
    })
  })

  it('carries the issue only when the session has one', () => {
    const withIssue = capture()
    recordHandoff(withIssue.ports, makeSession('iss-1'), SOURCE, TARGET, userCaller())
    expect(withIssue.events[0]?.payload).toMatchObject({ issueId: 'iss-1' })

    const without = capture()
    recordHandoff(without.ports, makeSession(), SOURCE, TARGET, userCaller())
    expect(without.events[0]?.payload).not.toHaveProperty('issueId')
  })

  it('the event`s human is the SAME derivation the bundle manifest is stamped from', () => {
    const { events, ports } = capture()
    const caller = agentCaller()
    recordHandoff(ports, makeSession(), SOURCE, TARGET, caller)
    const manifestIdentity = exportedIdentity(caller)
    expect((events[0]?.payload as { onBehalfOf: UserId }).onBehalfOf).toBe(
      manifestIdentity.exportedBy.onBehalfOf,
    )
  })
})
