import { asSessionId, asUserId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import {
  type AgentCommandPrincipal,
  systemPrincipal,
  userCommandPrincipal,
} from '../../command-principal'
import { decodeOperationActor, encodeOperationActor } from './actor'

describe('durable operation actors', () => {
  it('round-trips human, agent-session, and system identities without rights', () => {
    const user = userCommandPrincipal(asUserId('user:alice'), 'admin')
    const agent: AgentCommandPrincipal = {
      kind: 'agent',
      agentSessionId: asSessionId('agent-1'),
      onBehalfOf: asUserId('user:alice'),
      capability: user.capability,
      chain: [],
    }

    expect(decodeOperationActor(encodeOperationActor(user))).toEqual({
      kind: 'user',
      userId: asUserId('user:alice'),
    })
    expect(decodeOperationActor(encodeOperationActor(agent))).toEqual({
      kind: 'session',
      sessionId: asSessionId('agent-1'),
    })
    expect(decodeOperationActor(encodeOperationActor(systemPrincipal('boot-reconcile')))).toEqual({
      kind: 'system',
      job: 'boot-reconcile',
    })
  })

  it('refuses malformed durable actor strings', () => {
    expect(decodeOperationActor('')).toBeUndefined()
    expect(decodeOperationActor('user:')).toBeUndefined()
    expect(decodeOperationActor('admin:alice')).toBeUndefined()
  })
})
