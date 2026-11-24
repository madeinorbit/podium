import { describe, expect, it } from 'vitest'
import { SyncProgressStore } from './progress'

describe('shared sync progress', () => {
  it('announces a reconnect before hello without starting another HTTP attempt', () => {
    const progress = new SyncProgressStore()
    progress.begin('live')
    progress.noteEvent({ type: 'posture', previous: 'live', posture: 'stale' })
    progress.noteReconnecting()
    expect(progress.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      hasInstalled: true,
      blocking: false,
      attempt: 0,
    })
    progress.beginAttempt()
    expect(progress.getSnapshot()).toMatchObject({ phase: 'updating', attempt: 1 })
  })

  it.each([
    'auth',
    'format',
  ] as const)('keeps an earlier %s cause when the walk later reports exhaustion', (cause) => {
    const progress = new SyncProgressStore()
    progress.begin('cold')
    progress.beginAttempt()
    progress.noteError(cause, `first-${cause}`)
    progress.noteReconnecting()
    progress.noteDisconnected()
    progress.noteEvent({ type: 'bootstrap-failed', cause: 'compacted', attempts: 3, error: 'late' })
    expect(progress.getSnapshot()).toMatchObject({
      phase: 'error',
      error: cause,
      failure: `first-${cause}`,
    })
  })
})
