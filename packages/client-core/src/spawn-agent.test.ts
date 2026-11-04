import { asIssueId, asMachineId, asSessionId } from '@podium/model'
import { describe, expect, it } from 'vitest'
import { agentAcceptsArgvPrompt, draftLaunchEffect, SESSION_LAUNCH_KIND } from './spawn-agent'

const base = {
  effectId: 'eff_00000000-0000-4000-8000-000000000001',
  sessionId: asSessionId('session-1'),
  issueId: asIssueId('issue-1'),
  agentKind: 'codex' as const,
}

/**
 * A draft-agent start is a `session.launch` effect record (POD-6408); these are
 * the guarantees `sessions.create`'s payload carried, held on the effect input.
 */
describe('spawn machine-USE placement', () => {
  it.each([
    'unauthorized',
    'unreachable',
  ] as const)('fails closed with the distinct %s reason before anything is queued', (placement) => {
    expect(() =>
      draftLaunchEffect({
        ...base,
        target: { path: '/worktree', repoPath: '/repo', machineId: asMachineId('machine-1'), placement },
      }),
    ).toThrow(expect.objectContaining({ reason: placement }))
  })

  it('carries only target and command fields, never client-authored attribution', () => {
    const create = draftLaunchEffect({
      ...base,
      target: {
        path: '/worktree',
        repoPath: '/repo',
        machineId: asMachineId('machine-1'),
        placement: 'allowed',
      },
    })

    expect(create).toEqual({
      id: base.effectId,
      kind: SESSION_LAUNCH_KIND,
      target: { kind: 'session', id: 'session-1' },
      input: {
        agentKind: 'codex',
        cwd: '/worktree',
        draftIssue: { repoPath: '/repo', issueId: 'issue-1' },
        machineId: asMachineId('machine-1'),
      },
    })
    // Per-field: a single leaked field must fail (POD-1533).
    for (const field of ['actor', 'owner', 'ownerId', 'origin', 'createdBy']) {
      expect(Object.keys(create.input), `launch input asserts attribution field '${field}'`).not.toContain(field)
    }
  })

  it('hands held uploads to the launch rather than to the prompt (POD-2148)', () => {
    const ref = { id: 'up-1', filename: 'mock.png', mediaType: 'image/png', kind: 'image' as const }
    const create = draftLaunchEffect({
      ...base,
      target: { path: '/worktree', repoPath: '/repo', placement: 'allowed' },
      firstPrompt: 'Review the mock',
      attachments: [ref],
    })
    expect(create.input).toMatchObject({ initialPrompt: 'Review the mock', attachments: [ref] })
  })
})

describe('firstPrompt delivery (POD-549)', () => {
  it.each([
    'claude-code',
    'codex',
    'grok',
    'opencode',
  ] as const)('puts firstPrompt on the launch as initialPrompt for %s', (agentKind) => {
    const create = draftLaunchEffect({
      ...base,
      agentKind,
      target: { path: '/worktree', repoPath: '/repo', placement: 'allowed' },
      firstPrompt: '  fix the bug  ',
    })
    expect(create.input).toMatchObject({ agentKind, initialPrompt: 'fix the bug' })
  })

  it('omits initialPrompt when firstPrompt is blank', () => {
    const create = draftLaunchEffect({
      ...base,
      agentKind: 'grok',
      target: { path: '/worktree', repoPath: '/repo', placement: 'allowed' },
      firstPrompt: '   ',
    })
    expect(create.input).not.toHaveProperty('initialPrompt')
  })

  it('agentAcceptsArgvPrompt reads the descriptor argvPrompt flag (POD-4475)', () => {
    // Inline wire rows (tests may name harnesses; product code may not).
    // opencode is TRUE here: the old static mirror denied it an argv prompt
    // its manifest declares — the drift this injection deletes.
    const descriptors = [
      { kind: 'claude-code', capabilities: { argvPrompt: true, effort: true, systemPrompt: true } },
      { kind: 'codex', capabilities: { argvPrompt: true, effort: true, systemPrompt: false } },
      { kind: 'grok', capabilities: { argvPrompt: true, effort: true, systemPrompt: false } },
      { kind: 'opencode', capabilities: { argvPrompt: true, effort: true, systemPrompt: false } },
      { kind: 'cursor', capabilities: { argvPrompt: false, effort: false, systemPrompt: false } },
    ] as never
    expect(agentAcceptsArgvPrompt('claude-code', descriptors)).toBe(true)
    expect(agentAcceptsArgvPrompt('codex', descriptors)).toBe(true)
    expect(agentAcceptsArgvPrompt('grok', descriptors)).toBe(true)
    expect(agentAcceptsArgvPrompt('opencode', descriptors)).toBe(true)
    expect(agentAcceptsArgvPrompt('cursor', descriptors)).toBe(false)
    expect(agentAcceptsArgvPrompt('shell', descriptors)).toBe(false)
    // Unknown harnesses and a missing report fail closed (durable outbox).
    expect(agentAcceptsArgvPrompt('future-cli', descriptors)).toBe(false)
    expect(agentAcceptsArgvPrompt('claude-code', undefined)).toBe(false)
  })
})
