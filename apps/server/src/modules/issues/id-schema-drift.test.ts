import {
  IssueId as ModelIssueId,
  type IssueId as ModelIssueIdType,
  MachineId as ModelMachineId,
  type MachineId as ModelMachineIdType,
  RepoId as ModelRepoId,
  type RepoId as ModelRepoIdType,
  SessionId as ModelSessionId,
  type SessionId as ModelSessionIdType,
} from '@podium/model'
import {
  IssueId as ProtocolIssueId,
  type IssueId as ProtocolIssueIdType,
  MachineId as ProtocolMachineId,
  type MachineId as ProtocolMachineIdType,
  RepoId as ProtocolRepoId,
  type RepoId as ProtocolRepoIdType,
  SessionId as ProtocolSessionId,
  type SessionId as ProtocolSessionIdType,
} from '@podium/protocol'
import { describe, expect, it } from 'vitest'

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

// MachineId's model and protocol brand tags remain mutually assignable [spec:SP-3fe2].
const machineIdBrandsMatch = true satisfies MutuallyAssignable<
  ModelMachineIdType,
  ProtocolMachineIdType
>
// SessionId's model and protocol brand tags remain mutually assignable [spec:SP-3fe2].
const sessionIdBrandsMatch = true satisfies MutuallyAssignable<
  ModelSessionIdType,
  ProtocolSessionIdType
>
// IssueId's model and protocol brand tags remain mutually assignable [spec:SP-3fe2].
const issueIdBrandsMatch = true satisfies MutuallyAssignable<ModelIssueIdType, ProtocolIssueIdType>
// RepoId's model and protocol brand tags remain mutually assignable [spec:SP-3fe2].
const repoIdBrandsMatch = true satisfies MutuallyAssignable<ModelRepoIdType, ProtocolRepoIdType>

describe('model ↔ protocol branded id drift [spec:SP-3fe2]', () => {
  it('keeps every brand tag mutually assignable', () => {
    // MachineId's brand tag is identical across model and protocol.
    expect(machineIdBrandsMatch).toBe(true)
    // SessionId's brand tag is identical across model and protocol.
    expect(sessionIdBrandsMatch).toBe(true)
    // IssueId's brand tag is identical across model and protocol.
    expect(issueIdBrandsMatch).toBe(true)
    // RepoId's brand tag is identical across model and protocol.
    expect(repoIdBrandsMatch).toBe(true)
  })

  describe.each([
    ['MachineId', ModelMachineId, ProtocolMachineId],
    ['SessionId', ModelSessionId, ProtocolSessionId],
    ['IssueId', ModelIssueId, ProtocolIssueId],
    ['RepoId', ModelRepoId, ProtocolRepoId],
  ] as const)('%s schema', (name, modelSchema, protocolSchema) => {
    it('accepts and rejects the same inputs with the same parse output', () => {
      const validId = `${name}-1`
      // The model and protocol schemas both accept this ID's same valid string.
      expect([
        modelSchema.safeParse(validId).success,
        protocolSchema.safeParse(validId).success,
      ]).toEqual([true, true])
      // The model and protocol schemas both reject this ID's empty string.
      expect([modelSchema.safeParse('').success, protocolSchema.safeParse('').success]).toEqual([
        false,
        false,
      ])
      // The model and protocol schemas parse this ID to the same wire value.
      expect(modelSchema.parse(validId)).toBe(protocolSchema.parse(validId))
    })
  })
})
