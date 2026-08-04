import { describe, expect, it } from 'vitest'
import { exitedRecovery } from './index'

describe('exitedRecovery spawn errors', () => {
  it('surfaces the exact daemon diagnosis', () => {
    expect(
      exitedRecovery({
        exitCode: -1,
        spawnFailure: 'codex executable was not found',
        isShell: false,
        resumable: false,
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
      }).detail,
    ).toBe('The agent process failed to start.')
  })
})

/**
 * POD-1704. The regression these pin is a FALSE, DESTRUCTIVE claim: an exited
 * agent was told its worktree no longer existed — and offered only "Remove",
 * which deletes the session row — because the last repo scan had timed out and
 * come back with the repo present and its worktrees empty. The worktree was on
 * disk the whole time.
 *
 * The fix is not a better existence check. A worktree is a CACHE that
 * `ensureWorktree` rebuilds from the preserved branch before the spawn, so its
 * absence never makes a conversation unresumable and this function has no
 * business asking. What is asserted below is therefore the invariant, not the
 * old inputs: whatever the exit looked like, an agent that left a resume ref
 * gets `resume`.
 */
describe('exitedRecovery never withholds resume over a workspace guess', () => {
  const exits: { name: string; exitCode: number | undefined }[] = [
    { name: 'clean exit', exitCode: 0 },
    { name: 'unknown exit', exitCode: undefined },
    { name: 'crash', exitCode: 137 },
  ]

  for (const { name, exitCode } of exits) {
    it(`offers resume to a resumable agent after a ${name}`, () => {
      expect(exitedRecovery({ exitCode, isShell: false, resumable: true }).action).toBe('resume')
    })

    it(`never claims a workspace is gone after a ${name}`, () => {
      // The banner is read verbatim by the user; the retired copy asserted a
      // filesystem fact this layer cannot know.
      expect(exitedRecovery({ exitCode, isShell: false, resumable: true }).detail).not.toMatch(
        /worktree|no longer exists|can't be resumed/i,
      )
    })
  }

  it('restarts a shell rather than removing it', () => {
    expect(exitedRecovery({ exitCode: 0, isShell: true, resumable: false }).action).toBe('restart')
  })

  it('still removes an agent that left nothing to resume', () => {
    // `remove` keeps its one honest case — the reason is "no resume ref", never
    // "your directory is missing".
    expect(exitedRecovery({ exitCode: 0, isShell: false, resumable: false }).action).toBe('remove')
  })
})
