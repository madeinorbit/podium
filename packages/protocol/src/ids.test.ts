import { describe, expect, it } from 'vitest'
import {
  asIssueId,
  asMachineId,
  asSessionId,
  ConversationId,
  IssueId,
  MachineId,
  MutationId,
  machineScopedKey,
  parseMachineScopedKey,
  parseResumeKey,
  RepoId,
  resumeKey,
  SessionId,
  ThreadId,
} from './ids'

describe('branded id schemas', () => {
  const schemas = { MachineId, SessionId, IssueId, RepoId, ConversationId, MutationId, ThreadId }

  it.each(Object.entries(schemas))('%s parses a non-empty string', (_name, schema) => {
    expect(schema.parse('abc-123')).toBe('abc-123')
  })

  it.each(Object.entries(schemas))('%s rejects the empty string', (_name, schema) => {
    expect(schema.safeParse('').success).toBe(false)
  })

  it.each(Object.entries(schemas))('%s rejects non-strings', (_name, schema) => {
    expect(schema.safeParse(42).success).toBe(false)
    expect(schema.safeParse(null).success).toBe(false)
  })

  it('cast helpers return the input unchanged (trusted-boundary cast)', () => {
    expect(asMachineId('m1')).toBe('m1')
    expect(asSessionId('s1')).toBe('s1')
    expect(asIssueId('podium-7')).toBe('podium-7')
  })

  it('brands are nominally distinct at the type level', () => {
    const machine = asMachineId('m1')
    // @ts-expect-error a MachineId is not a SessionId
    const _wrong: SessionId = machine
    // A branded id is still assignable to plain string.
    const _plain: string = machine
  })
})

describe('machineScopedKey', () => {
  it('matches the legacy ad-hoc machineId + "\\n" + nativeId concat for benign parts (mirror.ts:128)', () => {
    expect(machineScopedKey(asMachineId('m1'), 'native-abc')).toBe('m1\nnative-abc')
  })

  it('round-trips benign parts', () => {
    const key = machineScopedKey(asMachineId('machine-a'), 'session.jsonl')
    expect(parseMachineScopedKey(key)).toEqual({
      machineId: 'machine-a',
      nativeId: 'session.jsonl',
    })
  })

  it.each([
    ['separator inside nativeId', 'm1', 'evil\ninjected'],
    ['separator inside machineId', 'm\n1', 'native'],
    ['backslash payloads', 'm\\1', 'n\\\\n\\'],
    ['escape-then-separator', 'm\\', '\nn'],
    ['both parts hostile', 'a\n\\b', '\\\nc\n'],
    ['empty nativeId', 'm1', ''],
  ])('round-trips hostile parts: %s', (_label, machineId, nativeId) => {
    const key = machineScopedKey(asMachineId(machineId), nativeId)
    expect(parseMachineScopedKey(key)).toEqual({ machineId, nativeId })
  })

  it('distinct part tuples never collide on one key (the ad-hoc concat flaw)', () => {
    // With naive `${a}\n${b}`, ('m1', 'x\ny') and ('m1\nx', 'y') collide.
    const a = machineScopedKey(asMachineId('m1'), 'x\ny')
    const b = machineScopedKey(asMachineId('m1\nx'), 'y')
    expect(a).not.toBe(b)
  })

  it('rejects malformed keys', () => {
    expect(() => parseMachineScopedKey('no-separator')).toThrow(/malformed machine-scoped key/)
    expect(() => parseMachineScopedKey('a\nb\nc')).toThrow(/malformed machine-scoped key/)
    expect(() => parseMachineScopedKey('\nnative')).toThrow(/malformed machine-scoped key/)
  })
})

describe('resumeKey', () => {
  it('matches the legacy ad-hoc kind + ":" + value concat for benign parts (session-identity.ts)', () => {
    expect(resumeKey('claude', 'abc-123')).toBe('claude:abc-123')
  })

  it('round-trips benign parts', () => {
    expect(parseResumeKey(resumeKey('codex', 'rollout-7'))).toEqual({
      kind: 'codex',
      value: 'rollout-7',
    })
  })

  it.each([
    ['separator inside value', 'claude', 'a:b:c'],
    ['separator inside kind', 'weird:kind', 'v'],
    ['backslash payloads', 'k\\', '\\:v\\\\'],
    ['both parts hostile', ':\\', ':\\:'],
    ['empty value', 'claude', ''],
  ])('round-trips hostile parts: %s', (_label, kind, value) => {
    expect(parseResumeKey(resumeKey(kind, value))).toEqual({ kind, value })
  })

  it('distinct part tuples never collide on one key', () => {
    expect(resumeKey('a', 'b:c')).not.toBe(resumeKey('a:b', 'c'))
  })

  it('rejects malformed keys', () => {
    expect(() => parseResumeKey('no-separator-here')).toThrow(/malformed resume key/)
    expect(() => parseResumeKey('a:b:c')).toThrow(/malformed resume key/)
    expect(() => parseResumeKey(':value')).toThrow(/malformed resume key/)
  })
})
