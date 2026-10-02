import { describe, expect, it } from 'vitest'
import { SyncProgressStore } from './progress'

describe('shared sync progress', () => {
  it.each([
    'auth',
    'format',
  ] as const)('keeps an earlier %s cause when the walk later reports exhaustion', (cause) => {
    const progress = new SyncProgressStore()
    progress.begin('cold')
    progress.beginAttempt()
    progress.noteError(cause, `first-${cause}`)
    progress.noteEvent({ type: 'bootstrap-failed', cause: 'compacted', attempts: 3, error: 'late' })
    expect(progress.getSnapshot()).toMatchObject({
      phase: 'error',
      error: cause,
      failure: `first-${cause}`,
    })
  })
})
