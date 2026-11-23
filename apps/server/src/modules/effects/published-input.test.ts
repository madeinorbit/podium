import { describe, expect, it } from 'vitest'
import {
  EFFECT_PUBLISHED_INPUT,
  effectPublication,
  type PublishingEffectKind,
  publishedInputOf,
} from './published-input'

const cases: { kind: PublishingEffectKind; input: Record<string, unknown>; expected: unknown }[] = [
  {
    kind: 'session.answer',
    input: { via: 'cli', interactionId: 'interaction', text: 'private answer' },
    expected: { via: 'cli', interactionId: 'interaction' },
  },
  {
    kind: 'issue.start',
    input: {
      brief: 'long brief',
      description: 'long description',
      machineId: 'machine',
      cwd: '/repo',
    },
    expected: { machineId: 'machine', cwd: '/repo' },
  },
  {
    kind: 'file.write',
    input: { path: 'note.txt', content: 'private bytes', root: '/repo', baseHash: 'before' },
    expected: { path: 'note.txt', size: 13, root: '/repo', baseHash: 'before' },
  },
  {
    kind: 'session.handoff',
    input: { machineId: 'machine', cwd: '/private', sessionId: 'session' },
    expected: { machineId: 'machine' },
  },
  {
    kind: 'session.launch',
    input: {
      agentKind: 'codex',
      cwd: '/repo',
      title: 'Draft session',
      wake: false,
      draftIssue: { title: 'Draft issue' },
      prompt: 'private prompt',
      model: undefined,
      credentialId: 'cred_chosen',
    },
    expected: {
      agentKind: 'codex',
      cwd: '/repo',
      title: 'Draft session',
      wake: false,
      draftIssue: { title: 'Draft issue' },
      // A refused start's session is painted from this record alone (POD-7069).
      credentialId: 'cred_chosen',
    },
  },
  {
    // Its harness's own login is a choice too: null, carried as null.
    kind: 'session.launch',
    input: { agentKind: 'codex', cwd: '/repo', credentialId: null },
    expected: { agentKind: 'codex', cwd: '/repo', credentialId: null },
  },
]

describe('effect input publication policy', () => {
  it.each(cases)('preserves the $kind feed projection in server and worker', ({
    kind,
    input,
    expected,
  }) => {
    expect(publishedInputOf(kind)(input)).toEqual(expected)
    const worker = effectPublication([kind]).get(kind)
    expect(worker?.publish?.(input)).toEqual(expected)
  })

  it('keeps omitted optional fields absent and false/present fields intact', () => {
    expect(publishedInputOf('session.answer')({ via: 'cli' })).toEqual({ via: 'cli' })
    expect(
      publishedInputOf('file.write')({ path: 'empty', content: '', root: false, baseHash: '' }),
    ).toEqual({
      path: 'empty',
      size: 0,
      root: false,
    })
  })

  it('publishes only served kinds, with whole inputs for kinds without a reduction rule', () => {
    const worker = effectPublication(['session.answer', 'issue.merge'])
    expect(worker.get('file.write')).toBeUndefined()
    expect(worker.get('issue.merge')?.publish).toBeUndefined()
    expect(worker.get('issue.merge')?.kind).toBe('issue.merge')
  })

  it('keeps the fingerprinted policy serializable across compiled processes', () => {
    expect(JSON.parse(JSON.stringify(EFFECT_PUBLISHED_INPUT))).toEqual(EFFECT_PUBLISHED_INPUT)
  })
})
