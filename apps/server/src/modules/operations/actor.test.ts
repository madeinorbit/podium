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

  it.each(['mem_000000000000000000000000001', 'user:alice'])('round-trips persisted member identity %s', (id) => {
    const userId = asUserId(id)
    const encoded = encodeOperationActor(userCommandPrincipal(userId, 'admin'))
    expect(encoded).toBe(id)
    expect(decodeOperationActor(encoded)).toEqual({ kind: 'user', userId })
  })

  it('refuses malformed durable actor strings', () => {
    expect(decodeOperationActor('')).toBeUndefined()
    expect(decodeOperationActor('mem_')).toBeUndefined()
    expect(decodeOperationActor('user:')).toBeUndefined()
    expect(decodeOperationActor('admin:alice')).toBeUndefined()
  })
})
