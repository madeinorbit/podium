import type { UserId } from '@podium/model'

/** Identity carried to every personal-memory read. */
export type MemoryReader =
  | { kind: 'user'; id: UserId }
  | { kind: 'agent'; id: string; onBehalfOf: UserId }
  | { kind: 'system'; id: string }

export const humanForMemoryReader = (reader: MemoryReader): UserId | undefined =>
  reader.kind === 'user' ? reader.id : reader.kind === 'agent' ? reader.onBehalfOf : undefined
