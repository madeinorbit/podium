import type { SessionId, UserId } from '@podium/model'
import type { CommandPrincipal } from '../../command-principal'

export type DurableOperationActor =
  | { kind: 'user'; userId: UserId }
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'system'; job: string }

export function encodeOperationActor(principal: CommandPrincipal): string {
  switch (principal.kind) {
    case 'user':
      return principal.user
    case 'agent':
      return `session:${principal.agentSessionId}`
    case 'system':
      return `system:${principal.job}`
  }
}

export function decodeOperationActor(value: string): DurableOperationActor | undefined {
  if (value.startsWith('user:') && value.length > 'user:'.length) {
    return { kind: 'user', userId: value as UserId }
  }
  if (value.startsWith('session:') && value.length > 'session:'.length) {
    return { kind: 'session', sessionId: value.slice('session:'.length) as SessionId }
  }
  if (value.startsWith('system:') && value.length > 'system:'.length) {
    return { kind: 'system', job: value.slice('system:'.length) }
  }
  return undefined
}
