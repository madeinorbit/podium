import { describe, expect, it, vi } from 'vitest'
import { SessionInstructionRegistry } from './instructions'

describe('SessionInstructionRegistry', () => {
  it('collects attributed contributions and commits provider side effects once', () => {
    const registry = new SessionInstructionRegistry()
    const firstCommit = vi.fn()
    const secondCommit = vi.fn()
    registry.register({
      source: 'podium:issues',
      prepare: (context) => ({
        content: `issue context for ${context.sessionId}`,
        afterSpawn: firstCommit,
      }),
    })
    registry.register({
      source: 'podium:empty',
      prepare: () => ({ content: '   ' }),
    })
    registry.register({
      source: 'podium:workflow',
      prepare: () => ({ content: '  follow the workflow  ', afterSpawn: secondCommit }),
    })

    const prepared = registry.prepare({
      sessionId: 'ses-1',
      cwd: '/worktree',
      agentKind: 'codex',
    })

    expect(prepared.instructions).toEqual([
      { source: 'podium:issues', content: 'issue context for ses-1' },
      { source: 'podium:workflow', content: 'follow the workflow' },
    ])
    expect(firstCommit).not.toHaveBeenCalled()
    expect(secondCommit).not.toHaveBeenCalled()

    prepared.commit()
    prepared.commit()
    expect(firstCommit).toHaveBeenCalledTimes(1)
    expect(secondCommit).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate or blank provider sources', () => {
    const registry = new SessionInstructionRegistry()
    registry.register({ source: 'podium:workflow', prepare: () => null })
    expect(() => registry.register({ source: 'podium:workflow', prepare: () => null })).toThrow(
      'duplicate session instruction provider',
    )
    expect(() => registry.register({ source: '  ', prepare: () => null })).toThrow(
      'session instruction provider needs a source',
    )
  })
})
