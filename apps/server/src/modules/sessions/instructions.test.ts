import { asSessionId } from '@podium/model'
import { describe, expect, it, vi } from 'vitest'
import { SessionInstructionRegistry } from './instructions'

describe('SessionInstructionRegistry', () => {
  it('collects attributed contributions and commits provider side effects once', async () => {
    const registry = new SessionInstructionRegistry()
    const firstCommit = vi.fn(async () => {})
    const secondCommit = vi.fn(async () => {})
    registry.register({
      source: 'podium:issues',
      prepare: async (context) => ({
        content: `issue context for ${context.sessionId}`,
        afterSpawn: firstCommit,
      }),
    })
    registry.register({
      source: 'podium:empty',
      prepare: async () => ({ content: '   ' }),
    })
    registry.register({
      source: 'podium:workflow',
      prepare: async () => ({ content: '  follow the workflow  ', afterSpawn: secondCommit }),
    })

    const prepared = await registry.prepare({
      sessionId: asSessionId('ses-1'),
      cwd: '/worktree',
      agentKind: 'codex',
    })

    expect(prepared.instructions).toEqual([
      { source: 'podium:issues', content: 'issue context for ses-1' },
      { source: 'podium:workflow', content: 'follow the workflow' },
    ])
    expect(firstCommit).not.toHaveBeenCalled()
    expect(secondCommit).not.toHaveBeenCalled()

    await prepared.commit()
    await prepared.commit()
    expect(firstCommit).toHaveBeenCalledTimes(1)
    expect(secondCommit).toHaveBeenCalledTimes(1)
  })

  it('rejects duplicate or blank provider sources', () => {
    const registry = new SessionInstructionRegistry()
    registry.register({ source: 'podium:workflow', prepare: async () => null })
    expect(() => registry.register({ source: 'podium:workflow', prepare: async () => null })).toThrow(
      'duplicate session instruction provider',
    )
    expect(() => registry.register({ source: '  ', prepare: async () => null })).toThrow(
      'session instruction provider needs a source',
    )
  })
})
