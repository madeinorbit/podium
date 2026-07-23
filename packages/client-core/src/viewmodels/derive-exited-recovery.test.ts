import { describe, expect, it } from 'vitest'
import { exitedRecovery } from './derive'

describe('exitedRecovery spawn errors', () => {
  it('surfaces the exact daemon diagnosis', () => {
    expect(
      exitedRecovery({
        exitCode: -1,
        spawnFailure: 'codex executable was not found',
        isShell: false,
        resumable: false,
        worktreeMissing: false,
      }),
    ).toEqual({
      detail: 'The agent process failed to start: codex executable was not found',
      action: 'remove',
    })
  })

  it('keeps the generic fallback for older rows', () => {
    expect(
      exitedRecovery({
        exitCode: -1,
        isShell: false,
        resumable: false,
        worktreeMissing: false,
      }).detail,
    ).toBe('The agent process failed to start.')
  })
})
